//! Frozen neighbor Descriptor projection wrappers for `BuildManifest`.
//!
//! Implements the frozen neighbor-snapshot rules of dolly-spec
//! `06-module-descriptor.md` (`REQ-DESC-002`, `INV-DESC-001`, `INV-DESC-003`):
//! for the receiving Module, every input-Page producer contributes an
//! `input_producer` relationship and its `emits` contract, and every Module
//! subscribed to an output Page contributes `output_consumer` plus its
//! `accepts` contract and the Actions the receiver is authorized to target.
//! Neighbors are deduplicated by Module ID among the fully-frozen graph; a
//! dual-role neighbor keeps both relationship labels and both authorized field
//! sets; entries are ordered by `(module_id, descriptor_revision)`.
//!
//! The projected `emits`, `accepts`, and `actions` groups are the exact
//! schema-valid source values (a Contract for `emits`/`accepts`, an array of
//! ActionContract for `actions`), never token-injected containers. Each entry's
//! `source_descriptor_digest` is recomputed from the canonical source Descriptor
//! bytes at projection time, and the projection fails closed when the frozen
//! digest of the graph snapshot does not match, when a relationship-bearing
//! neighbor Descriptor is missing, or when the source Descriptor is malformed.
//!
//! Producer authority: Runtime (graph snapshot only — no live Extension
//! queries, no clock, no storage). Consumer: Activation manifest
//! `neighbor_descriptors`. Direction: frozen graph -> projection (one-way);
//! the projection is derived text and is never a durable or live record.

use dolly_canonical_json::canonicalize;
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

/// Canonical relationship label naming a neighbor that outputs to at least one
/// frozen input Page of the receiving Module.
pub const INPUT_PRODUCER: &str = "input_producer";
/// Canonical relationship label naming a neighbor that subscribes to at least
/// one frozen output Page of the receiving Module.
pub const OUTPUT_CONSUMER: &str = "output_consumer";

/// Why a neighbor projection could not be built.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NeighborError {
    /// A relationship-bearing neighbor has no frozen Descriptor in the graph
    /// snapshot. Projection fails closed rather than silently omitting it.
    MissingDescriptor { module_id: String },
    /// The graph snapshot's frozen `source_descriptor_digest` does not match
    /// the canonical digest of the source Descriptor bytes. Projection fails
    /// closed rather than projecting bytes bound by an unverifiable digest.
    DigestMismatch {
        module_id: String,
        claimed: String,
        computed: String,
    },
    /// The source Descriptor lacks a field the frozen relationships require,
    /// or that field has the wrong shape.
    InvalidDescriptor { module_id: String, detail: String },
}

impl std::fmt::Display for NeighborError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingDescriptor { module_id } => {
                write!(
                    f,
                    "neighbor {module_id} has a frozen relationship but no source Descriptor"
                )
            }
            Self::DigestMismatch {
                module_id,
                claimed,
                computed,
            } => write!(
                f,
                "neighbor {module_id} source Descriptor digest mismatch: claimed {claimed}, computed {computed}"
            ),
            Self::InvalidDescriptor { module_id, detail } => {
                write!(f, "neighbor {module_id} source Descriptor invalid: {detail}")
            }
        }
    }
}

impl std::error::Error for NeighborError {}

/// A frozen source Descriptor bound by the graph snapshot: the complete
/// canonical `value` and the `source_descriptor_digest` that binds its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrozenDescriptor {
    pub module_id: String,
    pub descriptor_revision: i64,
    pub source_descriptor_digest: String,
    pub value: Value,
}

/// The frozen graph, authorization, and Descriptor inputs for `BuildManifest`
/// neighbor projection. All values come from the single immutable graph
/// snapshot; no live or mutable source is consulted.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NeighborGraph {
    /// Module whose Activation manifest is being built.
    pub receiving_module: String,
    /// Module ID to the input Page IDs it consumes.
    pub input_pages: BTreeMap<String, Vec<String>>,
    /// Module ID to the output Page IDs it produces into.
    pub output_pages: BTreeMap<String, Vec<String>>,
    /// Page ID to the Module IDs subscribed to that Page.
    pub subscriptions: BTreeMap<String, Vec<String>>,
    /// Neighbor Module ID to its frozen source Descriptor.
    pub descriptors: BTreeMap<String, FrozenDescriptor>,
    /// Namespaces the receiving Module is authorized to see in neighbor
    /// metadata; all other metadata is filtered out of the projection.
    pub authorized_metadata_namespaces: Vec<String>,
    /// Names of the Actions the receiving Module is authorized to target.
    /// Only source Actions with one of these names are projected; all others
    /// are excluded. An empty set projects no Actions.
    pub authorized_action_names: Vec<String>,
}

/// A closed neighbor Descriptor projection wrapper
/// (`dolly.activation-manifest/v1` `neighbor_descriptors` item). It is not a
/// `dolly.module-descriptor/v1` record and never reuses the source
/// Descriptor's identity (no `schema` member anywhere on the wrapper).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NeighborDescriptor {
    pub module_id: String,
    pub descriptor_revision: i64,
    pub source_descriptor_digest: String,
    pub relationships: Vec<String>,
    pub projection: Value,
}

/// Recompute the canonical digest of the source Descriptor `value` and compare
/// it with the frozen digest from the graph snapshot.
fn verify_descriptor_digest(frozen: &FrozenDescriptor) -> Result<String, NeighborError> {
    let (_, computed) =
        canonicalize(&frozen.value).map_err(|error| NeighborError::InvalidDescriptor {
            module_id: frozen.module_id.clone(),
            detail: format!("cannot canonicalize source bytes: {error}"),
        })?;
    let computed = computed.to_canonical_string();
    if computed != frozen.source_descriptor_digest {
        return Err(NeighborError::DigestMismatch {
            module_id: frozen.module_id.clone(),
            claimed: frozen.source_descriptor_digest.clone(),
            computed,
        });
    }
    Ok(computed)
}

/// Filter the Descriptor metadata to the namespaces the receiving Module is
/// authorized to see. The rebuild keeps the frozen namespace order of the
/// graph snapshot, not the source map's key order.
fn authorized_metadata(source: &Value, namespaces: &[String]) -> Value {
    let Some(map) = source.as_object() else {
        return json!({});
    };
    let mut filtered = Map::new();
    for namespace in namespaces {
        if let Some(value) = map.get(namespace) {
            filtered.insert(namespace.clone(), value.clone());
        }
    }
    Value::Object(filtered)
}

/// The exact source `emits`/`accepts` Contract. Fail-closed when the source
/// field is absent or not an object.
fn require_contract(source: &Value, field: &str, module_id: &str) -> Result<Value, NeighborError> {
    let value = source.get(field);
    match value {
        Some(Value::Object(_)) => Ok(value.expect("matched object").clone()),
        Some(_) => Err(NeighborError::InvalidDescriptor {
            module_id: module_id.to_string(),
            detail: format!("{field} must be a Contract object"),
        }),
        None => Err(NeighborError::InvalidDescriptor {
            module_id: module_id.to_string(),
            detail: format!("{field} is required"),
        }),
    }
}

/// The exact source `actions` array filtered to the ActionContracts the
/// receiving Module is authorized to target, preserving source order. Fails
/// closed when the source Actions are not an array.
fn require_authorized_actions(
    source: &Value,
    module_id: &str,
    authorized: &[String],
) -> Result<Value, NeighborError> {
    let value = source.get("actions");
    let Some(actions) = value else {
        return Err(NeighborError::InvalidDescriptor {
            module_id: module_id.to_string(),
            detail: "actions is required".to_string(),
        });
    };
    let Some(list) = actions.as_array() else {
        return Err(NeighborError::InvalidDescriptor {
            module_id: module_id.to_string(),
            detail: "actions must be an array of ActionContract".to_string(),
        });
    };
    Ok(Value::Array(
        list.iter()
            .filter(|action| {
                action
                    .get("name")
                    .and_then(|n| n.as_str())
                    .is_some_and(|name| authorized.iter().any(|candidate| candidate == name))
            })
            .cloned()
            .collect(),
    ))
}

/// Build the ordered `neighbor_descriptors` array for a frozen `BuildManifest`
/// graph snapshot.
///
/// Deterministic and side-effect free. Fails closed on any relationship-bearing
/// neighbor whose Descriptor is missing, digest-mismatched, or malformed — it
/// never silently omits a neighbor, a relationship, or an authorized Action.
pub fn build_neighbor_descriptors(
    graph: &NeighborGraph,
) -> Result<Vec<NeighborDescriptor>, NeighborError> {
    let mut relationship_by_module: BTreeMap<String, Relationship> = BTreeMap::new();
    let receiving_input_pages = graph
        .input_pages
        .get(&graph.receiving_module)
        .map_or_else(Vec::new, Clone::clone);
    let receiving_output_pages = graph
        .output_pages
        .get(&graph.receiving_module)
        .map_or_else(Vec::new, Clone::clone);

    // input_producer: every Module — including the receiver itself on a real
    // self-delivery path — that outputs to a frozen input Page of the receiver.
    for (module_id, pages) in &graph.output_pages {
        if pages
            .iter()
            .any(|page| receiving_input_pages.iter().any(|input| input == page))
        {
            relationship_by_module
                .entry(module_id.clone())
                .or_default()
                .input_producer = true;
        }
    }
    // output_consumer: every Module — including the receiver itself on a real
    // self-delivery path — subscribed to a frozen output Page of the receiver.
    for (page_id, subscribers) in &graph.subscriptions {
        if !receiving_output_pages.contains(page_id) {
            continue;
        }
        for module_id in subscribers {
            relationship_by_module
                .entry(module_id.clone())
                .or_default()
                .output_consumer = true;
        }
    }

    let mut results: Vec<NeighborDescriptor> = Vec::new();
    for (module_id, relationship) in relationship_by_module {
        let Some(frozen) = graph.descriptors.get(&module_id) else {
            return Err(NeighborError::MissingDescriptor {
                module_id: module_id.clone(),
            });
        };
        let mut labels = Vec::new();
        if relationship.input_producer {
            labels.push(INPUT_PRODUCER.to_string());
        }
        if relationship.output_consumer {
            labels.push(OUTPUT_CONSUMER.to_string());
        }
        if labels.is_empty() {
            continue;
        }
        let verified_digest = verify_descriptor_digest(frozen)?;
        let source = &frozen.value;
        if !source.is_object() {
            return Err(NeighborError::InvalidDescriptor {
                module_id: module_id.clone(),
                detail: "source Descriptor value must be an object".to_string(),
            });
        }
        let Some(display_name) = source.get("display_name") else {
            return Err(NeighborError::InvalidDescriptor {
                module_id: module_id.clone(),
                detail: "display_name is required".to_string(),
            });
        };
        let Some(trust) = source.get("trust") else {
            return Err(NeighborError::InvalidDescriptor {
                module_id: module_id.clone(),
                detail: "trust is required".to_string(),
            });
        };
        let mut projection = Map::new();
        projection.insert("display_name".into(), display_name.clone());
        projection.insert("trust".into(), trust.clone());
        projection.insert(
            "metadata".into(),
            authorized_metadata(&source["metadata"], &graph.authorized_metadata_namespaces),
        );
        if relationship.input_producer {
            projection.insert(
                "emits".into(),
                require_contract(source, "emits", &module_id)?,
            );
        }
        if relationship.output_consumer {
            projection.insert(
                "accepts".into(),
                require_contract(source, "accepts", &module_id)?,
            );
            projection.insert(
                "actions".into(),
                require_authorized_actions(source, &module_id, &graph.authorized_action_names)?,
            );
        }
        results.push(NeighborDescriptor {
            module_id: module_id.clone(),
            descriptor_revision: frozen.descriptor_revision,
            source_descriptor_digest: verified_digest,
            relationships: labels,
            projection: Value::Object(projection),
        });
    }
    results.sort_by(|left, right| {
        left.module_id
            .cmp(&right.module_id)
            .then(left.descriptor_revision.cmp(&right.descriptor_revision))
    });
    Ok(results)
}

#[derive(Default)]
struct Relationship {
    input_producer: bool,
    output_consumer: bool,
}
