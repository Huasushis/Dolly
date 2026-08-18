use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use dolly_core_reducer::neighbors::{FrozenDescriptor, NeighborGraph, build_neighbor_descriptors};
use dolly_core_reducer::{BuildManifestCommand, CoreCommand, empty_core_snapshot, reduce};
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

/// Build the `NeighborGraph` exactly as the imported TST-DESC-001 vector does:
/// the `neighbor-is-both-input-producer-and-output-consumer` fixture with the
/// vector's explicit initial overrides applied.
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
                value: descriptor.clone(),
            },
        )]),
        authorized_metadata_namespaces: vector["initial"]["authorized_metadata_namespaces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_string())
            .collect(),
    }
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

/// Run the imported-vector stimulus (BuildManifest carrying the built
/// projection) through the reference reducer; the scenario observed by the
/// vector is the activated manifest.
fn build_scenario_projection(vector: &Value) -> (Value, dolly_core_reducer::Transition) {
    let graph = graph_from_vector(vector);
    let neighbors = build_neighbor_descriptors(&graph)
        .into_iter()
        .map(|entry| serde_json::to_value(&entry).expect("NeighborDescriptor is a JSON object"))
        .collect::<Vec<_>>();
    let manifest = json!({
        "schema": "dolly.activation-manifest/v1",
        "activation_id":"r","module_id":graph.receiving_module,"reason":"input",
        "created_at":null,"graph_revision":1,"config_revision":1,
        "descriptor_revision":9,"effective_config":{},"effective_config_digest":null,
        "effective_config_schema_digest":null,"input_items":[],"cursor_spans":[],
        "lossy_gaps":[],"output_page_ids":[],"neighbor_descriptors":Value::Array(neighbors),
        "required_frame_bytes":1,"required_frame_nesting_depth":1,"deadline":null,
        "manifest_digest": null,
    });
    let result = reduce(
        &empty_core_snapshot(),
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

fn subset_contains(actual: &Value, required: &Value) -> bool {
    match actual {
        Value::Array(array) => array.iter().any(|member| subset(member, required)),
        Value::String(text) => required
            .as_str()
            .is_some_and(|needle| text.contains(needle)),
        _ => false,
    }
}
fn subset(actual: &Value, required: &Value) -> bool {
    match required {
        Value::Object(map) => map.iter().all(|(key, value)| {
            actual
                .get(key)
                .is_some_and(|candidate| subset(candidate, value))
        }),
        Value::Array(items) => actual.as_array().is_some_and(|array| {
            array.len() == items.len() && array.iter().zip(items).all(|(a, b)| subset(a, b))
        }),
        _ => actual == required,
    }
}

/// The language-neutral expected projection: canonical-JCS of this exact
/// literal is the language-neutral expected vector a later TypeScript
/// implementation MUST reproduce byte-for-byte.
const EXPECTED_NEIGHBOR_PROJECTION: &str = r#"{"analyst":{"display_name":"Analyst","trust":"trusted","metadata":{"org.dolly.llm":{"role":"analyst"}},"emits":["contract",{"summary":"Analysis","part_kinds":["text"],"action_names":[]}],"accepts":["contract",{"summary":"Review work","part_kinds":["text"],"action_names":["org.dolly.llm.review"]}],"actions":["authorized-contracts",{"name":"org.dolly.llm.review","arguments_schema":{"uri":"schemas/channel-send.schema.json","schema_digest":"sha256:64fbd12a17d44adb095ff1886020231fabbbb1b29d15c6a5f6d099a1d2e750aa","semantic_validator":null},"result_schema":{"uri":"schemas/channel-send-result.schema.json","schema_digest":"sha256:14edf90d6ac5a7082fafdd3bcfb5de311ebb92640e04235b98d247c19222b239","semantic_validator":{"id":"org.dolly.validator.channel-send-result","revision":1}},"description":"Review a draft","side_effect_class":"read_only"}]}}"#;

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
    assert_eq!(
        entry["source_descriptor_digest"],
        "sha256:dcdb688583af0951e2b3ab7f79cd0129bf74bd0a157aab1886898871cbd4d6ba"
    );
    assert_eq!(
        entry["relationships"],
        json!(["input_producer", "output_consumer"])
    );
    let projection = &entry["projection"];
    assert!(subset_contains(&projection["emits"], &json!("contract")));
    assert!(subset_contains(&projection["accepts"], &json!("contract")));
    assert!(subset_contains(
        &projection["actions"],
        &json!("authorized-contracts")
    ));

    // Exact frozen wrapper semantics (INV-DESC-001/003): the projection is a
    // closed view, not a ModuleDescriptor.
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
    // The wrapper is not the source Descriptor: no top-level identity reuse.
    assert!(entry.get("schema").is_none());

    // Language-neutral expected vector: canonical JCS of the literal above.
    let expected = serde_json::from_str::<Value>(EXPECTED_NEIGHBOR_PROJECTION).unwrap();
    assert_eq!(
        projection, &expected["analyst"],
        "projection digest must be frozen"
    );

    // Deterministic frozen projection (INV-DESC-003): retry builds byte-identical bytes.
    let rebuilt = build_scenario_projection(&vector).0;
    assert_eq!(scenario, rebuilt);
}

#[test]
fn tst_desc_001_projection_is_deterministic_and_sorted() {
    let vector = read(spec_root().join("test-vectors/core/TST-DESC-001-neighbor-projection.json"));
    let graph = graph_from_vector(&vector);
    let first = build_neighbor_descriptors(&graph);
    let second = build_neighbor_descriptors(&graph);
    assert_eq!(first, second);

    // Ordering: by (module_id, descriptor_revision).
    let neighbor = &first[0];
    assert_eq!(neighbor.module_id, "analyst");
    assert_eq!(
        neighbor.relationships,
        vec!["input_producer".to_string(), "output_consumer".to_string()]
    );
}
