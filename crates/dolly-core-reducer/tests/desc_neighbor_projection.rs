//! RED/GREEN conformance tests for the corrected frozen neighbor Descriptor
//! projection (TST-DESC-001 schema-conformant `equals` groups).
//!
//! The token-injection design is gone: every projected `emits`/`accepts` value
//! is the exact schema-valid source Contract and every projected `actions`
//! value is the exact source ActionContract array filtered by the receiving
//! Module's explicit authorization input. The vector's pinned digest must equal
//! the recomputed canonical digest of the source Descriptor, and a missing or
//! digest-mismatched neighbor Descriptor fails closed instead of being silently
//! omitted.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use dolly_canonical_json::canonicalize;
use dolly_core_reducer::neighbors::{
    FrozenDescriptor, NeighborError, NeighborGraph, build_neighbor_descriptors,
};
use dolly_core_reducer::{
    BuildManifestCommand, CoreCommand, INPUT_PRODUCER, OUTPUT_CONSUMER, empty_core_snapshot, reduce,
};
use serde_json::{Value, json};

fn spec_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("dolly-spec")
}
fn read(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

/// The repository-vendored dolly-spec fixture byte-identical to the imported
/// spec import.
fn fixture(name: &str) -> Value {
    let envelope = read(
        spec_root()
            .join("test-vectors/fixtures")
            .join(format!("{name}.json")),
    );
    assert_eq!(envelope["schema"], "dolly.test-fixture/v1");
    envelope["value"].clone()
}

fn map_str_vec(value: &Value) -> BTreeMap<String, Vec<String>> {
    value
        .as_object()
        .unwrap()
        .iter()
        .map(|(key, pages)| {
            (
                key.clone(),
                pages
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|page| page.as_str().unwrap().to_string())
                    .collect(),
            )
        })
        .collect()
}

/// Names of every Action the neighbor's source Descriptor declares.
fn source_action_names(source_descriptor: &Value) -> Vec<String> {
    source_descriptor["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|action| action["name"].as_str().unwrap().to_string())
        .collect()
}

/// Build the `NeighborGraph` exactly as the imported TST-DESC-001 vector does:
/// the `neighbor-is-both-input-producer-and-output-consumer` fixture with the
/// vector's explicit initial overrides applied. The receiver is authorized to
/// target every Action the neighbor source descriptor declares.
fn graph_from_vector(vector: &Value) -> NeighborGraph {
    let mut value = fixture("neighbor-is-both-input-producer-and-output-consumer");
    let map = value.as_object_mut().unwrap();
    for (key, override_value) in vector["initial"].as_object().unwrap() {
        if key != "fixture" {
            map.insert(key.clone(), override_value.clone());
        }
    }
    let receiving = value["receiving_module"].as_str().unwrap();
    let neighbor = value["neighbor_module"].as_str().unwrap();
    let descriptor = &value["source_descriptor"];
    NeighborGraph {
        receiving_module: receiving.to_string(),
        input_pages: map_str_vec(&value["input_pages"]),
        output_pages: map_str_vec(&value["output_pages"]),
        subscriptions: map_str_vec(&value["subscriptions"]),
        descriptors: BTreeMap::from([(
            neighbor.to_string(),
            FrozenDescriptor {
                module_id: neighbor.to_string(),
                descriptor_revision: vector["initial"]["source_descriptor_revision"]
                    .as_i64()
                    .unwrap(),
                source_descriptor_digest: vector["initial"]["source_descriptor_digest"]
                    .as_str()
                    .unwrap()
                    .to_string(),
                owner_extension_id: "org.dolly.test".into(),
                value: descriptor.clone(),
            },
        )]),
        authorized_metadata_namespaces: vector["initial"]["authorized_metadata_namespaces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_string())
            .collect(),
        authorized_action_names: source_action_names(descriptor),
    }
}

fn graph_snapshot_value(graph: &NeighborGraph) -> Value {
    let descriptors = graph
        .descriptors
        .iter()
        .map(|(module_id, descriptor)| {
            (
                module_id.clone(),
                json!({
                    "module_id": descriptor.module_id,
                    "descriptor_revision": descriptor.descriptor_revision,
                    "source_descriptor_digest": descriptor.source_descriptor_digest,
                    "value": descriptor.value,
                }),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    json!({
        "receiving_module": graph.receiving_module,
        "input_pages": &graph.input_pages,
        "output_pages": &graph.output_pages,
        "subscriptions": &graph.subscriptions,
        "descriptors": descriptors,
        "authorized_metadata_namespaces": &graph.authorized_metadata_namespaces,
        "authorized_action_names": &graph.authorized_action_names,
    })
}

fn state_with_graph(graph: &NeighborGraph) -> dolly_core_reducer::CoreSnapshot {
    let graph_value = graph_snapshot_value(graph);
    let (_, digest) = canonicalize(&graph_value).expect("graph snapshot canonicalizes");
    let mut state = empty_core_snapshot();
    state.graph = json!({
        "revision": 1,
        "graph": graph_value,
        "digest": digest.to_canonical_string(),
    });
    state
}

/// Build JSON neighbor wrappers from the frozen projection builder.
fn build_neighbors_json(graph: &NeighborGraph) -> Value {
    let neighbors = build_neighbor_descriptors(graph).expect("valid graph builds");
    Value::Array(
        neighbors
            .into_iter()
            .map(|entry| serde_json::to_value(&entry).expect("NeighborDescriptor is a JSON object"))
            .collect(),
    )
}

/// Run the imported-vector stimulus (BuildManifest carrying the built
/// projection) through the reference reducer; the scenario observed by the
/// vector is the activated manifest.
fn build_scenario_projection(vector: &Value) -> (Value, dolly_core_reducer::Transition) {
    let graph = graph_from_vector(vector);
    let neighbors = build_neighbors_json(&graph);
    let manifest = json!({
        "schema": "dolly.activation-manifest/v1",
        "activation_id":"r","module_id":graph.receiving_module,"reason":"input",
        "created_at":null,"graph_revision":1,"config_revision":1,
        "descriptor_revision":9,"effective_config":{},"effective_config_digest":null,
        "effective_config_schema_digest":null,"input_items":[],"cursor_spans":[],
        "lossy_gaps":[],"output_page_ids":[],"neighbor_descriptors":neighbors,
        "required_frame_bytes":1,"required_frame_nesting_depth":1,"deadline":null,
        "manifest_digest": null,
    });
    let state = state_with_graph(&graph);
    let result = reduce(
        &state,
        &CoreCommand::BuildManifest(BuildManifestCommand {
            command_id: "build".into(),
            activation_id: "r".into(),
            manifest,
            expected_graph_revision: Some(1),
            expected_descriptor_revision: Some(9),
        }),
        &dolly_core_reducer::EnvironmentInput {
            now: "2026-08-10T22:00:00.000000Z".into(),
            graph_revision: Some(1),
            descriptor_revision: Some(9),
            ..Default::default()
        },
    );
    (json!({"manifest": result.state.manifests["r"]}), result)
}

#[test]
fn tst_desc_001_neighbor_projection_vector() {
    let vector = read(spec_root().join("test-vectors/core/TST-DESC-001-neighbor-projection.json"));
    assert_eq!(vector["schema"], "dolly.test-vector/v1");
    assert_eq!(vector["test_id"], "TST-DESC-001");
    assert_eq!(vector["kind"], "core_transition");
    assert_eq!(
        vector["covers"],
        json!(["REQ-DESC-002", "INV-DESC-001", "INV-DESC-003"])
    );

    let fixture_value = fixture("neighbor-is-both-input-producer-and-output-consumer");
    let source = &fixture_value["source_descriptor"];
    let (scenario, transition) = build_scenario_projection(&vector);
    assert!(
        transition.error.is_none(),
        "BuildManifest must accept the projection: {:?}",
        transition.error
    );
    assert_eq!(scenario["manifest"]["activation_id"], "r");

    let neighbors = &scenario["manifest"]["neighbor_descriptors"];
    assert_eq!(neighbors.as_array().unwrap().len(), 1);
    let entry = &neighbors[0];
    assert_eq!(entry["module_id"], "analyst");
    assert_eq!(entry["descriptor_revision"], 9);

    // The digest is recomputed from the canonical source Descriptor at
    // projection time and must equal the frozen snapshot's pinned digest.
    let recomputed = canonicalize(source).unwrap().1.to_canonical_string();
    assert_eq!(
        entry["source_descriptor_digest"],
        vector["initial"]["source_descriptor_digest"]
    );
    assert_eq!(entry["source_descriptor_digest"], recomputed);
    assert_eq!(
        entry["relationships"],
        json!(["input_producer", "output_consumer"])
    );

    // The corrected vector asserts schema-valid groups with exact equality,
    // not containment of injected scalar tokens.
    let projection = &entry["projection"];
    for group in ["emits", "accepts", "actions"] {
        let asserted = &vector["expected"]["assertions"];
        let expected = asserted
            .as_array()
            .unwrap()
            .iter()
            .find(|assertion| {
                assertion["path"] == format!("/manifest/neighbor_descriptors/0/projection/{group}")
            })
            .expect("assertion exists")["value"]
            .clone();
        assert_eq!(entry["projection"][group], expected);
    }
    assert!(
        projection.get("schema").is_none(),
        "projection must not expose schema"
    );
    assert!(
        projection.get("unauthorized_metadata").is_none(),
        "projection must not expose unauthorized_metadata"
    );
    // The only authorized metadata namespace organically stays.
    assert_eq!(
        projection["metadata"],
        json!({"org.dolly.llm":{"role":"analyst"}})
    );
    assert!(projection.get("org.example.private").is_none());
    assert!(
        entry.get("schema").is_none(),
        "wrapper must not be a ModuleDescriptor"
    );

    // The projection is exactly the source descriptor's own authorized
    // groups — the same shape the corrected (schema-conformant) vector asserts.
    let expected = json!({
        "display_name": source["display_name"],
        "trust": source["trust"],
        "metadata": json!({"org.dolly.llm":{"role":"analyst"}}),
        "emits": source["emits"],
        "accepts": source["accepts"],
        "actions": source["actions"],
    });
    assert_eq!(
        projection, &expected,
        "projection must equal the source groups"
    );

    // Deterministic frozen projection (INV-DESC-003): retry builds byte-identical bytes.
    let rebuilt = build_scenario_projection(&vector).0;
    assert_eq!(scenario, rebuilt);
}

#[test]
fn tst_desc_001_projection_is_deterministic_and_sorted() {
    let vector = read(spec_root().join("test-vectors/core/TST-DESC-001-neighbor-projection.json"));
    let graph = graph_from_vector(&vector);
    let first = build_neighbor_descriptors(&graph).unwrap();
    let second = build_neighbor_descriptors(&graph).unwrap();
    assert_eq!(first, second);

    let neighbor = &first[0];
    assert_eq!(neighbor.module_id, "analyst");
    assert_eq!(
        neighbor.relationships,
        vec!["input_producer".to_string(), "output_consumer".to_string()]
    );
    // No token/raw scalar leftover from the token-injection design.
    let serialized = serde_json::to_value(neighbor).unwrap();
    assert!(
        !serialized.to_string().contains("\"contract\"")
            && !serialized.to_string().contains("authorized-contracts"),
        "projection must not retain injected token strings"
    );
}

#[test]
fn produced_manifest_validates_against_activation_manifest_schema() {
    let vector = read(spec_root().join("test-vectors/core/TST-DESC-001-neighbor-projection.json"));
    let graph = graph_from_vector(&vector);
    let neighbors = build_neighbors_json(&graph);

    // A fully schema-valid activation manifest carrying the produced
    // neighbor_descriptors array must pass the embedded golden schema.
    //
    // Note: dolly-schema embeds a catalog byte-identical to the checked-in
    // schemas (verified by the catalog test), validating the produced wrapper
    // against the exact authoritative golden, not a re-derivation.
    let manifest = json!({
        "schema": "dolly.activation-manifest/v1",
        "activation_id": "0198ab31-6c44-7e8a-b2bb-000000000004",
        "module_id": "reviewer",
        "reason": "input",
        "created_at": "2026-08-10T22:00:00.000000Z",
        "graph_revision": 1,
        "config_revision": 1,
        "descriptor_revision": 9,
        "effective_config": {},
        "effective_config_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "effective_config_schema_digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "input_items": [],
        "cursor_spans": [],
        "lossy_gaps": [],
        "output_page_ids": [],
        "neighbor_descriptors": neighbors,
        "required_frame_bytes": 1,
        "required_frame_nesting_depth": 1,
        "deadline": "2026-08-10T22:00:00.000000Z",
        "manifest_digest": canonicalize(&json!({})).unwrap().1.to_canonical_string(),
    });
    let catalog = dolly_schema::embedded_schema_catalog().expect("embedded catalog loads");
    let value = dolly_canonical_json::CanonicalJsonValue::try_from(manifest).unwrap();
    catalog
        .validate(
            dolly_schema::ACTIVATION_MANIFEST_SCHEMA_ID,
            &value,
            dolly_canonical_json::MAX_SEMANTIC_JSON_NESTING_DEPTH,
        )
        .map_err(|issues| panic!("produced manifest violates golden schema: {issues}"))
        .unwrap();
}

#[test]
fn source_descriptor_digest_mismatch_rejected() {
    let vector = read(spec_root().join("test-vectors/core/TST-DESC-001-neighbor-projection.json"));
    let mut graph = graph_from_vector(&vector);
    let neighbor = graph.descriptors.keys().next().unwrap().clone();
    graph
        .descriptors
        .get_mut(&neighbor)
        .unwrap()
        .source_descriptor_digest =
        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".to_string();

    let error = build_neighbor_descriptors(&graph).unwrap_err();
    assert!(
        matches!(error, NeighborError::DigestMismatch { ref module_id, .. } if module_id == &neighbor),
        "expected DigestMismatch, got {error:?}"
    );
}

#[test]
fn unauthorized_action_is_excluded() {
    let vector = read(spec_root().join("test-vectors/core/TST-DESC-001-neighbor-projection.json"));
    let mut graph = graph_from_vector(&vector);
    let neighbor = graph.descriptors.keys().next().unwrap().clone();
    {
        let descriptor = graph.descriptors.get_mut(&neighbor).unwrap();
        // Two actions, only one authorized.
        let extra = serde_json::from_str::<Value>(r#"{
            "name": "org.dolly.llm.analyze",
            "arguments_schema": {"uri":"schemas/channel-send.schema.json","schema_digest":"sha256:64fbd12a17d44adb095ff1886020231fabbbb1b29d15c6a5f6d099a1d2e750aa","semantic_validator":null},
            "result_schema": {"uri":"schemas/channel-send-result.schema.json","schema_digest":"sha256:14edf90d6ac5a7082fafdd3bcfb5de311ebb92640e04235b98d247c19222b239","semantic_validator":{"id":"org.dolly.validator.channel-send-result","revision":1}},
            "description":"dummy",
            "side_effect_class":"read_only"
        }"#).unwrap();
        let mut updated = descriptor.value["actions"].as_array().unwrap().clone();
        updated.push(extra);
        descriptor.value["actions"] = Value::Array(updated);
        // digest must now match modified value
        let (_, digest) = canonicalize(&descriptor.value).unwrap();
        descriptor.source_descriptor_digest = digest.to_string();
    }
    graph.authorized_action_names = vec!["org.dolly.llm.review".to_string()];

    let entry = &build_neighbor_descriptors(&graph).unwrap()[0];
    let actions = &entry.projection["actions"];
    assert_eq!(actions.as_array().unwrap().len(), 1);
    assert_eq!(actions[0]["name"], "org.dolly.llm.review");
    // accepts still projects the full source contract.
    assert_eq!(
        entry.projection["accepts"],
        json!({"summary":"Review work","part_kinds":["text"],"action_names":["org.dolly.llm.review"]})
    );
    // The unauthorized action name is not unioned in.
    assert!(
        !actions.to_string().contains("org.dolly.llm.analyze"),
        "unauthorized Action must not be projected"
    );
}

#[test]
fn self_loop_relationship_is_preserved() {
    let vector = read(spec_root().join("test-vectors/core/TST-DESC-001-neighbor-projection.json"));
    let mut graph = graph_from_vector(&vector);
    let receiving = graph.receiving_module.clone();
    // A real self-delivery path: the receiving module outputs directly to one
    // of its own input pages.
    graph
        .output_pages
        .entry(receiving.clone())
        .or_default()
        .push("shared-in".to_string());
    graph.descriptors.insert(
        receiving.clone(),
        FrozenDescriptor {
            module_id: receiving.clone(),
            descriptor_revision: vector["initial"]["source_descriptor_revision"]
                .as_i64()
                .unwrap(),
            source_descriptor_digest: vector["initial"]["source_descriptor_digest"]
                .as_str()
                .unwrap()
                .to_string(),
            owner_extension_id: "org.dolly.test".into(),
            value:
                fixture("neighbor-is-both-input-producer-and-output-consumer")["source_descriptor"]
                    .clone(),
        },
    );

    let descriptors = build_neighbor_descriptors(&graph).unwrap();
    let self_entry = descriptors
        .iter()
        .find(|entry| entry.module_id == receiving)
        .expect("self-loop neighbor present");
    // REQ-DESC-002: M is included only with the real self-delivery path's
    // relationship label (input_producer here).
    assert_eq!(self_entry.relationships, vec![INPUT_PRODUCER]);
    assert!(self_entry.projection.get("emits").is_some());
    assert!(self_entry.projection.get("accepts").is_none());
    assert!(self_entry.projection.get("actions").is_none());
    // The pre-existing analyst neighbor is unchanged.
    assert!(descriptors.iter().any(|entry| entry.module_id == "analyst"));
}

#[test]
fn missing_neighbor_descriptor_fails_closed() {
    let vector = read(spec_root().join("test-vectors/core/TST-DESC-001-neighbor-projection.json"));
    let mut graph = graph_from_vector(&vector);
    // A relationship-bearing neighbor with no frozen descriptor.
    graph
        .subscriptions
        .entry("extra-out".to_string())
        .or_default()
        .push("missing-neighbor".to_string());
    graph
        .output_pages
        .entry(graph.receiving_module.clone())
        .or_default()
        .push("extra-out".to_string());
    // The old behavior silently omitted this neighbor; the corrected builder
    // must fail closed instead.
    let error = build_neighbor_descriptors(&graph).unwrap_err();
    assert!(
        matches!(error, NeighborError::MissingDescriptor { ref module_id } if module_id == "missing-neighbor"),
        "expected MissingDescriptor, got {error:?}"
    );
}

#[test]
fn single_direction_projection_and_dual_order() {
    let vector = read(spec_root().join("test-vectors/core/TST-DESC-001-neighbor-projection.json"));
    let mut graph = graph_from_vector(&vector);

    // A pure input producer: outputs to a frozen input page of the receiver.
    // A pure output consumer: subscribes to an extra output page of the receiver.
    graph
        .output_pages
        .insert("producer-module".to_string(), vec!["shared-in".to_string()]);
    graph.subscriptions.insert(
        "extra-page".to_string(),
        vec!["consumer-module".to_string()],
    );
    graph
        .output_pages
        .entry(graph.receiving_module.clone())
        .or_default()
        .push("extra-page".to_string());

    let base =
        fixture("neighbor-is-both-input-producer-and-output-consumer")["source_descriptor"].clone();
    for module_id in ["consumer-module", "producer-module"] {
        let mut value = base.clone();
        value["module_id"] = json!(module_id);
        let (_, digest) = canonicalize(&value).unwrap();
        graph.descriptors.insert(
            module_id.to_string(),
            FrozenDescriptor {
                module_id: module_id.to_string(),
                descriptor_revision: vector["initial"]["source_descriptor_revision"]
                    .as_i64()
                    .unwrap(),
                source_descriptor_digest: digest.to_string(),
                owner_extension_id: "org.dolly.test".into(),
                value,
            },
        );
    }

    let descriptors = build_neighbor_descriptors(&graph).unwrap();
    // Canonical (module_id, descriptor_revision) ordering.
    let ids: Vec<_> = descriptors
        .iter()
        .map(|entry| entry.module_id.as_str())
        .collect();
    assert_eq!(ids, ["analyst", "consumer-module", "producer-module"]);

    let producer = descriptors
        .iter()
        .find(|entry| entry.module_id == "producer-module")
        .unwrap();
    assert_eq!(producer.relationships, vec![INPUT_PRODUCER]);
    assert!(producer.projection.get("emits").is_some());
    assert!(producer.projection.get("accepts").is_none());
    assert!(producer.projection.get("actions").is_none());

    let consumer = descriptors
        .iter()
        .find(|entry| entry.module_id == "consumer-module")
        .unwrap();
    assert_eq!(consumer.relationships, vec![OUTPUT_CONSUMER]);
    assert!(consumer.projection.get("accepts").is_some());
    assert!(consumer.projection.get("actions").is_some());
    assert!(consumer.projection.get("emits").is_none());

    // The dual-role analyst keeps both field groups once, in the canonical
    // relationship order, without unioning any unauthorized capability.
    let analyst = descriptors
        .iter()
        .find(|entry| entry.module_id == "analyst")
        .unwrap();
    assert_eq!(analyst.relationships, vec![INPUT_PRODUCER, OUTPUT_CONSUMER]);
    assert!(analyst.projection.get("emits").is_some());
    assert!(analyst.projection.get("accepts").is_some());
    assert!(analyst.projection.get("actions").is_some());
    assert_eq!(
        analyst.projection["actions"].as_array().unwrap().len(),
        1,
        "only the authorized Action is projected"
    );
    assert!(
        !analyst.projection["actions"]
            .to_string()
            .contains("org.dolly.llm.analyze")
    );
}

/// Recursively assert that neither the wrapper nor the projection is or
/// contains a ModuleDescriptor-like object carrying a `schema` member: the
/// closed wrapper never aliases a source Descriptor identity.
fn assert_no_schema_member(value: &Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                assert_ne!(
                    key.as_str(),
                    "schema",
                    "neither the wrapper nor the projection may expose a schema member"
                );
                assert_no_schema_member(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                assert_no_schema_member(item);
            }
        }
        _ => {}
    }
}

#[test]
fn reversed_or_unrelated_neighbors_are_not_projected() {
    let vector = read(spec_root().join("test-vectors/core/TST-DESC-001-neighbor-projection.json"));
    let mut graph = graph_from_vector(&vector);
    let base =
        fixture("neighbor-is-both-input-producer-and-output-consumer")["source_descriptor"].clone();

    // (a) "wrong neighbor": a frozen descriptor exists for a module that has
    // no frozen edge to the receiver — it must not be projected.
    // (b) "reversal": `reverse-consumer` subscribes to `shared-in`, which is a
    // receiving INPUT page, not an output page — direction must not invert.
    // (c) `reverse-producer` outputs `shared-out`, a receiving OUTPUT page —
    // producing the receiver's output page is not producing its input page.
    graph
        .subscriptions
        .entry("shared-in".to_string())
        .or_default()
        .push("reverse-consumer".to_string());
    graph
        .output_pages
        .entry("reverse-producer".to_string())
        .or_default()
        .push("shared-out".to_string());

    for module_id in ["reverse-consumer", "reverse-producer", "unrelated-module"] {
        let mut value = base.clone();
        value["module_id"] = json!(module_id);

        let (_, digest) = canonicalize(&value).unwrap();
        graph.descriptors.insert(
            module_id.to_string(),
            FrozenDescriptor {
                module_id: module_id.to_string(),
                descriptor_revision: vector["initial"]["source_descriptor_revision"]
                    .as_i64()
                    .unwrap(),
                source_descriptor_digest: digest.to_string(),
                owner_extension_id: "org.dolly.test".into(),
                value,
            },
        );
    }

    let descriptors = build_neighbor_descriptors(&graph).unwrap();
    let ids: Vec<_> = descriptors
        .iter()
        .map(|entry| entry.module_id.as_str())
        .collect();
    assert_eq!(
        ids,
        ["analyst"],
        "only the real-direction neighbor is projected; misdirected or unrelated modules stay out"
    );
}

#[test]
fn wrapper_and_projection_never_alias_a_module_descriptor() {
    let path = spec_root().join("test-vectors/core/TST-DESC-001-neighbor-projection.json");
    let vector = read(path);
    let graph = graph_from_vector(&vector);
    let neighbors = build_neighbor_descriptors(&graph).unwrap();
    for entry in &neighbors {
        let serialized = serde_json::to_value(entry).unwrap();
        assert_no_schema_member(&serialized);
        // Projection and wrapper are not the ModuleDescriptor itself, so the
        // wrapper must not carry the source's `module_id` non-nested as identity.
        assert_eq!(entry.module_id, "analyst");
    }
}
#[test]
fn build_manifest_binds_neighbors_to_authoritative_graph() {
    let vector = read(spec_root().join("test-vectors/core/TST-DESC-001-neighbor-projection.json"));
    let graph = graph_from_vector(&vector);
    let authoritative = build_neighbors_json(&graph);
    let state = state_with_graph(&graph);
    let manifest = |neighbors: Value| {
        json!({
            "module_id": "reviewer",
            "graph_revision": 1,
            "neighbor_descriptors": neighbors,
        })
    };
    let input = dolly_core_reducer::EnvironmentInput {
        now: "2026-08-10T22:00:00.000000Z".into(),
        graph_revision: Some(1),
        descriptor_revision: Some(9),
        ..Default::default()
    };
    let legitimate = reduce(
        &state,
        &CoreCommand::BuildManifest(BuildManifestCommand {
            command_id: "legitimate".into(),
            activation_id: "legitimate".into(),
            manifest: manifest(authoritative.clone()),
            expected_graph_revision: Some(1),
            expected_descriptor_revision: Some(9),
        }),
        &input,
    );
    assert_eq!(legitimate.outcome, dolly_core_reducer::TransitionOutcome::Committed);
    assert!(legitimate.error.is_none());

    let mut forged_identity = authoritative.clone();
    forged_identity[0]["module_id"] = json!("invented-neighbor");
    let mut forged_digest = authoritative.clone();
    forged_digest[0]["source_descriptor_digest"] =
        json!("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    let mut forged_revision = authoritative.clone();
    forged_revision[0]["descriptor_revision"] = json!(10);
    let mut forged_direction = authoritative.clone();
    forged_direction[0]["relationships"] = json!(["output_consumer"]);
    forged_direction[0]["projection"]
        .as_object_mut()
        .unwrap()
        .remove("emits");
    let mut forged_projection = authoritative.clone();
    forged_projection[0]["projection"]["display_name"] = json!("Invented");
    for (label, neighbors) in [
        ("identity", forged_identity),
        ("digest", forged_digest),
        ("revision", forged_revision),
        ("direction", forged_direction),
        ("projection", forged_projection),
    ] {
        let transition = reduce(
            &state,
            &CoreCommand::BuildManifest(BuildManifestCommand {
                command_id: format!("forged-{label}"),
                activation_id: format!("forged-{label}"),
                manifest: manifest(neighbors),
                expected_graph_revision: Some(1),
                expected_descriptor_revision: Some(9),
            }),
            &input,
        );
        assert_eq!(
            transition.outcome,
            dolly_core_reducer::TransitionOutcome::RolledBack,
            "{label} neighbor must roll back"
        );
        assert_eq!(transition.state, state, "{label} forgery mutated state");
        assert!(transition.events.is_empty(), "{label} forgery emitted an event");
    }
}
