//! Frozen neighbor Descriptor projection tests (corrected TST-DESC-001 contract).
//!
//! Premise (descriptor/neighbor edges):
//! - E2 Runtime -> durable verified Descriptor revision (authority: Runtime;
//!   identity `module_id` + immutable `descriptor_revision`; digest sha256 over
//!   canonical JCS bytes).
//! - E3 GraphSnapshot -> neighbor projection wrapper (authority: frozen graph;
//!   source = pinned verified Descriptor bytes; consumer = Activation Manifest
//!   `neighbor_descriptors`).
//! - Direction strictly graph -> projection. Reversal, authority substitution,
//!   symmetric-union widening, fan-in/out aliasing, stale digest, and replay
//!   leakage are all denied; the projection is derived text, never a live or
//!   durable record.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use dolly_canonical_json::canonicalize;
use dolly_core_reducer::{
    INPUT_PRODUCER, OUTPUT_CONSUMER, FrozenDescriptor, NeighborDescriptor, NeighborError,
    NeighborGraph, build_neighbor_descriptors,
};
use serde_json::{Value, json};

fn digest(value: &Value) -> String {
    canonicalize(value).unwrap().1.to_canonical_string()
}
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
fn fixture(name: &str) -> Value {
    let envelope =
        read(spec_root().join("test-vectors/fixtures").join(format!("{name}.json")));
    assert_eq!(envelope["schema"], "dolly.test-fixture/v1");
    envelope["value"].clone()
}

type StrVecMap = BTreeMap<String, Vec<String>>;
fn from_str_vec_map(v: &Value) -> StrVecMap {
    v.as_object()
        .unwrap()
        .iter()
        .map(|(k, arr)| {
            (
                k.clone(),
                arr.as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_str().unwrap().to_string())
                    .collect(),
            )
        })
        .collect()
}

fn freeze(source: &Value) -> FrozenDescriptor {
    FrozenDescriptor {
        module_id: source["module_id"].as_str().unwrap().to_string(),
        descriptor_revision: source["descriptor_revision"].as_i64().unwrap(),
        source_descriptor_digest: digest(source),
        value: source.clone(),
    }
}

fn graph_from_fixture(name: &str) -> NeighborGraph {
    let v = fixture(name);
    let source = v["source_descriptor"].clone();
    NeighborGraph {
        receiving_module: v["receiving_module"].as_str().unwrap().to_string(),
        input_pages: from_str_vec_map(&v["input_pages"]),
        output_pages: from_str_vec_map(&v["output_pages"]),
        subscriptions: from_str_vec_map(&v["subscriptions"]),
        descriptors: BTreeMap::from([(source["module_id"].as_str().unwrap().to_string(), freeze(&source))]),
        authorized_metadata_namespaces: v["authorized_metadata_namespaces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_str().unwrap().to_string())
            .collect(),
        authorized_action_names: source["actions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["name"].as_str().unwrap().to_string())
            .collect(),
    }
}

fn find_neighbor<'a>(
    list: &'a [NeighborDescriptor],
    id: &str,
) -> Option<&'a NeighborDescriptor> {
    list.iter().find(|d| d.module_id == id)
}

#[test]
fn tst_desc_001_dual_relationship_projection_matches_vector() {
    let g = graph_from_fixture("neighbor-is-both-input-producer-and-output-consumer");
    let out = build_neighbor_descriptors(&g).expect("projection must succeed");

    // Producer authority is Runtime; a neighbor manifests once per
    // (module_id, revision), never once per relationship (fan-in/out aliasing
    // denied).
    assert_eq!(out.len(), 1, "exactly one wrapper");
    let nd = find_neighbor(&out, "analyst").expect("analyst present");
    assert_eq!(nd.descriptor_revision, 9);
    assert_eq!(
        nd.source_descriptor_digest,
        "sha256:dcdb688583af0951e2b3ab7f79cd0129bf74bd0a157aab1886898871cbd4d6ba",
        "vector-pinned digest must be reproduced by canonicalization"
    );
    // Dual-role neighbor keeps both labels, in canonical order.
    assert_eq!(nd.relationships, vec![INPUT_PRODUCER, OUTPUT_CONSUMER]);

    let p = &nd.projection;
    // emits == exact source emits Contract (input-producer direction).
    assert_eq!(
        p["emits"],
        json!({"summary":"Analysis","part_kinds":["text"],"action_names":[]})
    );
    // accepts == exact source accepts Contract (output-consumer direction).
    assert_eq!(
        p["accepts"],
        json!({"summary":"Review work","part_kinds":["text"],"action_names":["org.dolly.llm.review"]})
    );
    // Authorized Actions pass through wholesale; the projection holds the same
    // ActionContract objects as the frozen source byte set.
    let action = json!({
        "name": "org.dolly.llm.review",
        "arguments_schema": {
            "uri": "schemas/channel-send.schema.json",
            "schema_digest": "sha256:64fbd12a17d44adb095ff1886020231fabbbb1b29d15c6a5f6d099a1d2e750aa",
            "semantic_validator": null
        },
        "result_schema": {
            "uri": "schemas/channel-send-result.schema.json",
            "schema_digest": "sha256:14edf90d6ac5a7082fafdd3bcfb5de311ebb92640e04235b98d247c19222b239",
            "semantic_validator": { "id": "org.dolly.validator.channel-send-result", "revision": 1 }
        },
        "description": "Review a draft",
        "side_effect_class": "read_only"
    });
    assert_eq!(p["actions"], Value::Array(vec![action.clone()]));
    assert_eq!(
        p["actions"][0]["result_schema"]["schema_digest"],
        "sha256:14edf90d6ac5a7082fafdd3bcfb5de311ebb92640e04235b98d247c19222b239"
    );
}

#[test]
fn projection_contains_display_name_trust_metadata_and_never_schema() {
    let g = graph_from_fixture("neighbor-is-both-input-producer-and-output-consumer");
    let neighbors = build_neighbor_descriptors(&g).unwrap();
    let nd = find_neighbor(&neighbors, "analyst").unwrap();
    let p = &nd.projection;

    assert_eq!(p["display_name"], "Analyst");
    assert_eq!(p["trust"], "trusted");
    // Only authorized namespaces are projected; the secret stays behind.
    assert_eq!(p["metadata"], json!({"org.dolly.llm":{"role":"analyst"}}));

    // The wrapper and its projection are NOT a module descriptor.
    assert!(p.get("schema").is_none(), "projection must not carry descriptor schema");
    for key in [
        "activation_replay_contract",
        "module_id",
        "descriptor_revision",
        "unauthorized_metadata",
    ] {
        assert!(p.get(key).is_none(), "projection must not contain {key}");
    }
}

fn graph_with(output_pages: Value, subscriptions: Value) -> NeighborGraph {
    let v = fixture("neighbor-is-both-input-producer-and-output-consumer");
    let source = v["source_descriptor"].clone();
    NeighborGraph {
        receiving_module: "reviewer".to_string(),
        input_pages: from_str_vec_map(&v["input_pages"]),
        output_pages: from_str_vec_map(&output_pages),
        subscriptions: from_str_vec_map(&subscriptions),
        descriptors: BTreeMap::from([(source["module_id"].as_str().unwrap().to_string(), freeze(&source))]),
        authorized_metadata_namespaces: vec!["org.dolly.llm".to_string()],
        authorized_action_names: vec!["org.dolly.llm.review".to_string()],
    }
}

#[test]
fn single_direction_neighbor_projects_only_its_direction_fields() {
    // Reviewer produces only to out-only, which analyst subscribes to; analyst
    // no longer outputs to shared-in -> solely an output consumer, and
    // one-direction widening to union is denied (no `emits`).
    let g = graph_with(
        json!({"reviewer":["out-only"]}),
        json!({"out-only":["analyst"]}),
    );
    let out = build_neighbor_descriptors(&g).unwrap();
    assert_eq!(out.len(), 1);
    let nd = find_neighbor(&out, "analyst").unwrap();
    assert_eq!(nd.relationships, vec![OUTPUT_CONSUMER]);
    assert!(nd.projection.get("emits").is_none(), "consumer-only must not gain emits");
    assert!(nd.projection.get("accepts").is_some());
    assert!(nd.projection.get("actions").is_some());
}

#[test]
fn reversed_direction_relationship_is_not_projected() {
    // Analyst produces to shared-out, but the receiving module reviewer neither
    // reads shared-out as its input nor writes anywhere analyst consumes; the
    // edge is reversed relative to reviewer and must NOT project.
    let g = graph_with(
        json!({"analyst":["shared-out"]}),
        json!({"shared-out":["reviewer"]}),
    );
    let out = build_neighbor_descriptors(&g).unwrap();
    assert!(find_neighbor(&out, "analyst").is_none(), "reversal denied");
}

#[test]
fn stale_digest_fails_closed() {
    let mut g = graph_from_fixture("neighbor-is-both-input-producer-and-output-consumer");
    let stale = format!("sha256:{}", "0".repeat(64));
    g.descriptors.get_mut("analyst").unwrap().source_descriptor_digest = stale.clone();
    let err = build_neighbor_descriptors(&g).err().expect("stale digest rejected");
    match err {
        NeighborError::DigestMismatch { module_id, claimed, .. } => {
            assert_eq!(module_id, "analyst");
            assert_eq!(claimed, stale);
        }
        other => panic!("expected DigestMismatch, got {other:?}"),
    }
}

#[test]
fn missing_descriptor_fails_closed() {
    let mut g = graph_from_fixture("neighbor-is-both-input-producer-and-output-consumer");
    g.descriptors.remove("analyst");
    match build_neighbor_descriptors(&g) {
        Err(NeighborError::MissingDescriptor { module_id }) => assert_eq!(module_id, "analyst"),
        other => panic!("expected MissingDescriptor, got {other:?}"),
    }
}

#[test]
fn full_graph_snapshot_with_self_loop_receives_identical_projection() {
    // Recovery/replay leakage is denied: rebuilding the same frozen snapshot
    // must produce byte-identical output every time.
    let g = graph_from_fixture("neighbor-is-both-input-producer-and-output-consumer");
    let a = build_neighbor_descriptors(&g).unwrap();
    let b = build_neighbor_descriptors(&g).unwrap();
    assert_eq!(a, b, "deterministic, replay-safe");
}
