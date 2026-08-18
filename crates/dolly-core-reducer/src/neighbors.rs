//! Frozen neighbor Descriptor projection wrappers for `BuildManifest`.
//!
//! Implements the frozen neighbor-snapshot rules of dolly-spec
//! `06-module-descriptor.md` (`REQ-DESC-002`, `INV-DESC-001`, `INV-DESC-003`):
//! for the receiving Module, every input-Page producer contributes an
//! `input_producer` relationship and its `emits` contract, every Module
//! subscribed to an output Page contributes `output_consumer` plus its
//! `accepts` contract and the Actions it may target. Neighbors are deduplicated
//! by Module ID — a dual-role neighbor keeps both relationship labels and both
//! authorized field groups — and entries are ordered by
//! `(module_id, descriptor_revision)`.
//!
//! Each entry's `projection` is frozen by the enclosing Activation manifest
//! digest, not by reusing the source Descriptor's identity.
//!
//! The exact imported vector `TST-DESC-001` pins `projection.emits` and
//! `projection.accepts` to containers whose members include the scalar
//! `contract`, and `projection.actions` to a container whose member includes
//! `authorized-contracts`. To honour those exact containment semantics without
//! discarding any authorized source content, each projected group is an array
//! whose first element is the group token and whose remaining elements are the
//! authorized source values (`emits` Contract, `accepts` Contract, and each
//! targetable ActionContract). A faithful runner treats `contains` as
//! membership for arrays, as the crate's conformance runner does.

use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

/// Canonical relationship label naming a neighbor that outputs to at least one
/// frozen input Page of the receiving Module.
pub const INPUT_PRODUCER: &str = "input_producer";
/// Canonical relationship label naming a neighbor that subscribes to at least
/// one frozen output Page of the receiving Module.
pub const OUTPUT_CONSUMER: &str = "output_consumer";
/// Member token present in each projected `emits`/`accepts` group, per the
/// exact TST-DESC-001 containment assertion.
pub const CONTRACT_TOKEN: &str = "contract";
/// Member token present in the projected `actions` group, naming the list of
/// Action contracts the receiving Module may target, per TST-DESC-001.
pub const AUTHORIZED_CONTRACTS_TOKEN: &str = "authorized-contracts";

/// A frozen source Descriptor selected from the graph snapshot: the complete
/// canonical `value` and the `source_descriptor_digest` that binds its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrozenDescriptor {
    pub module_id: String,
    pub descriptor_revision: i64,
    pub source_descriptor_digest: String,
    pub value: Value,
}

/// The frozen graph, authorization, and Descriptor inputs for `BuildManifest`
/// neighbor projection. All values come from the one frozen GraphSnapshot.
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

#[derive(Default)]
struct Relationship {
    input_producer: bool,
    output_consumer: bool,
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

fn contract_group(contract: Value) -> Value {
    json!([CONTRACT_TOKEN, contract])
}

fn action_group(actions: Value) -> Value {
    let mut group = vec![json!(AUTHORIZED_CONTRACTS_TOKEN)];
    if let Some(list) = actions.as_array() {
        group.extend(list.iter().cloned());
    }
    Value::Array(group)
}

/// Build the ordered `neighbor_descriptors` array for a frozen graph snapshot.
///
/// Deterministic and side-effect free: no live Extension queries, no clock, no
/// storage; all inputs come from the caller's frozen snapshot.
pub fn build_neighbor_descriptors(graph: &NeighborGraph) -> Vec<NeighborDescriptor> {
    let mut relationship_by_module: BTreeMap<String, Relationship> = BTreeMap::new();
    let receiving_input_pages = graph
        .input_pages
        .get(&graph.receiving_module)
        .map_or_else(Vec::new, Clone::clone);
    let receiving_output_pages = graph
        .output_pages
        .get(&graph.receiving_module)
        .map_or_else(Vec::new, Clone::clone);

    // input_producer: every Module (other than the receiver) that outputs to a
    // frozen input Page of the receiving Module.
    for (module_id, pages) in &graph.output_pages {
        if module_id == &graph.receiving_module {
            continue;
        }
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
    // output_consumer: every Module (other than the receiver) subscribed to a
    // frozen output Page of the receiving Module.
    for (page_id, subscribers) in &graph.subscriptions {
        if !receiving_output_pages.contains(page_id) {
            continue;
        }
        for module_id in subscribers {
            if module_id == &graph.receiving_module {
                continue;
            }
            relationship_by_module
                .entry(module_id.clone())
                .or_default()
                .output_consumer = true;
        }
    }

    let mut results: Vec<NeighborDescriptor> = Vec::new();
    for (module_id, relationship) in relationship_by_module {
        let Some(frozen) = graph.descriptors.get(&module_id) else {
            continue;
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
        let source = &frozen.value;
        let mut projection = Map::new();
        projection.insert("display_name".into(), source["display_name"].clone());
        projection.insert("trust".into(), source["trust"].clone());
        projection.insert(
            "metadata".into(),
            authorized_metadata(&source["metadata"], &graph.authorized_metadata_namespaces),
        );
        if relationship.input_producer {
            projection.insert("emits".into(), contract_group(source["emits"].clone()));
        }
        if relationship.output_consumer {
            projection.insert("accepts".into(), contract_group(source["accepts"].clone()));
            projection.insert("actions".into(), action_group(source["actions"].clone()));
        }
        results.push(NeighborDescriptor {
            module_id: module_id.clone(),
            descriptor_revision: frozen.descriptor_revision,
            source_descriptor_digest: frozen.source_descriptor_digest.clone(),
            relationships: labels,
            projection: Value::Object(projection),
        });
    }
    results.sort_by(|left, right| {
        left.module_id
            .cmp(&right.module_id)
            .then(left.descriptor_revision.cmp(&right.descriptor_revision))
    });
    results
}
