//! RED/GREEN conformance tests for the effective-config normalizer and its
//! member-ceiling gate (TST-CONFIG-003 / TST-CONFIG-004, REQ-CFG-003/004/005).
//!
//! The control-plane configuration spec (docs/spec/control-plane/01) defines:
//! `effective_config(m)` is one deterministic **shallow** overlay — begin with
//! every top-level member of `e.config`, then for each top-level member of
//! `m.config` replace or insert that member in its entirety. No recursive merge,
//! no array concatenation, `null` is an ordinary replacement value. The result
//! is emitted in JCS form and hashed. Every Extension/Module source object and
//! the resolved object each carry a 1,024-member ceiling; an over-limit
//! resolved overlay MUST be rejected before the configuration revision commits
//! (REQ-CFG-005). The overlay is one-way and never mutates its inputs.

use std::{
    fs,
    path::{Path, PathBuf},
};

use dolly_canonical_json::canonicalize;
use dolly_core_reducer::{
    CoreCommand, EffectiveConfigError, EnvironmentInput, ErrorOutcome, InstallConfigCommand,
    MAX_EFFECTIVE_CONFIG_PROPERTIES, TransitionOutcome, empty_core_snapshot,
    normalize_effective_config, reduce,
};
use serde_json::{Map, Value, json};

fn spec_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("dolly-spec")
}
fn read_vector(name: &str) -> Value {
    serde_json::from_slice(
        &fs::read(
            spec_root()
                .join("test-vectors/config")
                .join(format!("{name}.json")),
        )
        .unwrap(),
    )
    .unwrap()
}
fn digest(value: &Value) -> String {
    canonicalize(value).unwrap().1.to_canonical_string()
}
fn object_member_map(count: usize, prefix: &str) -> Value {
    let mut map = Map::new();
    for index in 0..count {
        map.insert(format!("{prefix}-{:04}", index), json!(index as i64));
    }
    Value::Object(map)
}

/// `module_config` empty → the Extension object is inherited unchanged
/// (defaults-only overlay).
#[test]
fn defaults_only_overlay_inherits_every_extension_member() {
    let extension = json!({"a": 1, "b": {"deep": true}, "c": [1, 2], "n": "base"});
    let module = json!({});
    let resolved = normalize_effective_config(&extension, &module).unwrap();
    assert_eq!(resolved.effective_config, extension);
    assert_eq!(resolved.effective_config_digest, digest(&extension));
}

/// Scalar, object, and list members are replaced in their entirety — no
/// recursive merge, no array concatenation — and `null` is an ordinary value.
#[test]
fn overlay_replaces_each_category_and_null_is_ordinary() {
    let extension = json!({
        "scalar": 1,
        "object": {"deep": true},
        "array": [1, 2],
        "nullable": "base",
        "inherited": "stays",
    });
    let module = json!({
        "scalar": "two",
        "object": {"flat": true},
        "array": ["three"],
        "nullable": null,
        "added": 9,
    });
    let resolved = normalize_effective_config(&extension, &module).unwrap();
    let effective = resolved.effective_config.as_object().unwrap();
    assert_eq!(effective["scalar"], json!("two"));
    // Entire-object replacement, not a deep union: "deep" is gone.
    assert_eq!(effective["object"], json!({"flat": true}));
    // Array replacement, not concatenation: exactly one element.
    assert_eq!(effective["array"], json!(["three"]));
    // null is an ordinary value present in the result, not a delete.
    assert_eq!(effective["nullable"], Value::Null);
    assert!(effective.contains_key("nullable"));
    // present only in the extension layer.
    assert_eq!(effective["inherited"], json!("stays"));
    assert_eq!(effective["added"], json!(9));
}

/// Key insertion order in both inputs must not change the result or digest.
#[test]
fn overlay_digest_is_order_independent() {
    let first = normalize_effective_config(&json!({"a": 1, "b": 2}), &json!({"c": 3})).unwrap();
    let reversed = normalize_effective_config(&json!({"b": 2, "a": 1}), &json!({"c": 3})).unwrap();
    assert_eq!(first.effective_config, reversed.effective_config);
    assert_eq!(
        first.effective_config_digest,
        reversed.effective_config_digest
    );
    // The digest equals sha256 of the JCS form of the sorted object.
    assert_eq!(
        first.effective_config_digest,
        digest(&json!({"a":1,"b":2,"c":3}))
    );
}

/// Exact 1,024-member Extension object with one overridden member is accepted;
/// a disjoint member raises the resolved total to 1,025 and is rejected.
#[test]
fn ceiling_exact_1024_accepted_and_1025_rejected() {
    let extension_1024 = object_member_map(MAX_EFFECTIVE_CONFIG_PROPERTIES, "key");
    // Overrides an existing key: resolved total stays 1,024.
    let module_override = json!({"key-0000": "module override"});
    let resolved = normalize_effective_config(&extension_1024, &module_override).unwrap();
    assert_eq!(
        resolved.effective_config.as_object().unwrap().len(),
        MAX_EFFECTIVE_CONFIG_PROPERTIES
    );
    // Disjoint module-only member: resolved total 1,025 → reject.
    let module_disjoint = json!({"module-only-key": true});
    assert_eq!(
        normalize_effective_config(&extension_1024, &module_disjoint),
        Err(EffectiveConfigError::EffectiveConfigMaxProperties)
    );
    // The per-source input ceilings are independent of the resolved ceiling:
    // a one-member extension with a one-member module resolves to two members.
    let extension_small = json!({"extension-only-key": true});
    let resolved = normalize_effective_config(&extension_small, &module_disjoint).unwrap();
    assert_eq!(resolved.effective_config.as_object().unwrap().len(), 2);
}

/// Spec-referenced TST-CONFIG-003 vector: overlay + pinned digest.
#[test]
fn tst_config_003_effective_config_overlay_vector() {
    let vector = read_vector("TST-CONFIG-003-effective-config-overlay");
    assert_eq!(vector["schema"], "dolly.test-vector/v1");
    assert_eq!(vector["test_id"], "TST-CONFIG-003");
    assert_eq!(vector["kind"], "config");
    assert_eq!(vector["stimulus"]["command"], "NormalizeEffectiveConfig");
    assert_eq!(vector["expected"]["outcome"], "effective_config_resolved");

    let extension_config = &vector["initial"]["extension_config"];
    let module_config = &vector["initial"]["module_config"];
    let module_schema_bundle_digest = vector["initial"]["module_schema_bundle_digest"]
        .as_str()
        .unwrap();

    // Overlay MUST NOT mutate either source object.
    let extension_before = digest(extension_config);
    let module_before = digest(module_config);

    let resolved = normalize_effective_config(extension_config, module_config).unwrap();

    assert_eq!(digest(extension_config), extension_before);
    assert_eq!(digest(module_config), module_before);

    let expected_effective = vector["expected"]["assertions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["path"] == "/effective_config")
        .unwrap()["value"]
        .clone();
    assert_eq!(resolved.effective_config, expected_effective);
    // Replaced member, not deep-merged: `/effective_config/cache/shared` present
    // only in the Extension layer and therefore absent.
    let effective_object = resolved.effective_config.as_object().unwrap();
    assert_eq!(
        effective_object["cache"],
        json!({"module": true}),
        "module cache replaces extension cache, no deep merge"
    );
    assert!(
        !effective_object["cache"]
            .as_object()
            .unwrap()
            .contains_key("shared")
    );
    // Replacement, not concatenation: tags are exactly `["module"]`.
    assert_eq!(effective_object["tags"], json!(["module"]));
    // null is ordinary, present, not a delete.
    assert_eq!(effective_object["nullable"], Value::Null);
    assert!(effective_object.contains_key("nullable"));
    // inherited only from the Extension layer.
    assert_eq!(effective_object["inherited"], json!(1));

    let expected_digest = vector["expected"]["assertions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["path"] == "/effective_config_digest")
        .unwrap()["value"]
        .as_str()
        .unwrap();
    assert_eq!(resolved.effective_config_digest, expected_digest);
    // Pinned vector digest re-verified against our recomputation.
    assert_eq!(
        resolved.effective_config_digest,
        "sha256:75d72a950e3a0e5a7ad5150b6a52bfc4f2bc83c001c23dd7d44045b13149d223"
    );
    assert_eq!(
        resolved.effective_config_digest,
        digest(&expected_effective)
    );

    // The schema-bundle digest is carried as-is (REQ-CFG-004 input); it is not
    // part of the effective object digest.
    let expected_schema_digest = vector["expected"]["assertions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["path"] == "/effective_config_schema_digest")
        .unwrap()["value"]
        .as_str()
        .unwrap();
    assert_eq!(module_schema_bundle_digest, expected_schema_digest);
    assert_ne!(resolved.effective_config_digest, expected_schema_digest);

    // Authority: active control-plane revision 7; a successful InstallConfig
    // admission of the normalized object advances revision by exactly one.
    let mut state = empty_core_snapshot();
    state.config = json!({"revision": 7});
    let before = state.config.clone();
    let transition = reduce(
        &state,
        &CoreCommand::InstallConfig(InstallConfigCommand {
            command_id: "config-003".into(),
            revision: 8,
            effective_config: resolved.effective_config.clone(),
            digest: resolved.effective_config_digest.clone(),
        }),
        &EnvironmentInput::default(),
    );
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
    assert_eq!(transition.state.config["revision"], json!(8), "revision +1");
    assert_eq!(
        transition.state.config["digest"],
        json!(resolved.effective_config_digest)
    );
    assert_eq!(
        transition.state.config["effective_config"],
        expected_effective
    );
    assert!(
        transition
            .events
            .iter()
            .any(|event| event.event == "ConfigInstalled")
    );
    // Prior revision is unchanged after the successful commit (8 > 7).
    assert_ne!(before, transition.state.config);
}

/// Consumer admission of an over-limit effective object rejects before any
/// revision commit or consumer side effect (REQ-CFG-005, TST-CONFIG-004).
#[test]
fn tst_config_004_ceiling_rejected_before_revision_commit() {
    let vector = read_vector("TST-CONFIG-004-effective-config-property-ceiling");
    assert_eq!(vector["schema"], "dolly.test-vector/v1");
    assert_eq!(vector["test_id"], "TST-CONFIG-004");
    assert_eq!(
        vector["expected"]["outcome"],
        "candidate_rejected_before_revision_commit"
    );

    // Overlay oracle: 1,024 extension members plus one disjoint module member.
    let extension_1024 = object_member_map(1024, "key");
    let module_disjoint = json!({"module-only-key": true});
    assert_eq!(
        normalize_effective_config(&extension_1024, &module_disjoint),
        Err(EffectiveConfigError::EffectiveConfigMaxProperties),
        "1,025-member resolved overlay must fail the normalizer"
    );

    // Consumer side: an honest effective object with 1,025 top-level members.
    let mut over_limit = object_member_map(1024, "key");
    over_limit
        .as_object_mut()
        .unwrap()
        .insert("module-only-key".into(), json!(true));
    assert_eq!(over_limit.as_object().unwrap().len(), 1025);
    let honest_digest = digest(&over_limit);

    let mut state = empty_core_snapshot();
    state.config = json!({"revision": 7});
    let prior = state.config.clone();
    let transition = reduce(
        &state,
        &CoreCommand::InstallConfig(InstallConfigCommand {
            command_id: "config-004".into(),
            revision: 8,
            effective_config: over_limit,
            digest: honest_digest,
        }),
        &EnvironmentInput::default(),
    );
    // Rejected before revision commit: active config unchanged.
    assert_eq!(transition.outcome, TransitionOutcome::RolledBack);
    assert_eq!(transition.state.config, prior);
    assert_eq!(transition.state.config["revision"], json!(7));
    // No consumer side effect: no instantiate/manifest/commit artifact.
    assert!(transition.state.manifests.is_empty());
    assert!(transition.state.activations.is_empty());
    assert!(
        !transition
            .events
            .iter()
            .any(|event| event.event == "ConfigInstalled")
    );
    // The dedicated rejection event with the spec reason is emitted.
    assert!(transition.events.iter().any(|event| {
        event.event == "ConfigurationCandidateRejected"
            && event.details.as_ref().is_some_and(|details| {
                details.get("reason") == Some(&json!("effective_config_max_properties"))
            })
    }));
    let error = transition.error.as_ref().unwrap();
    assert!(!error.retryable);
    assert!(matches!(error.outcome, ErrorOutcome::NotApplied));

    // At exactly 1,024 members the same consumer admits and commits +1.
    let mut exact = object_member_map(1024, "key");
    exact
        .as_object_mut()
        .unwrap()
        .insert("key-0000".into(), json!("override"));
    let exact_digest = digest(&exact);
    let transition = reduce(
        &empty_core_snapshot(),
        &CoreCommand::InstallConfig(InstallConfigCommand {
            command_id: "config-004-exact".into(),
            revision: 1,
            effective_config: exact,
            digest: exact_digest,
        }),
        &EnvironmentInput::default(),
    );
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
    assert_eq!(transition.state.config["revision"], json!(1));
}

/// Malformed non-object inputs fail closed; no object is ever required.
#[test]
fn non_object_sources_fail_closed() {
    let extension = json!({"a": 1});
    let module = json!({"b": 2});
    assert_eq!(
        normalize_effective_config(&json!([1, 2, 3]), &module),
        Err(EffectiveConfigError::ExtensionConfigNotObject)
    );
    assert_eq!(
        normalize_effective_config(&extension, &json!("scalar")),
        Err(EffectiveConfigError::ModuleConfigNotObject)
    );
    assert_eq!(
        normalize_effective_config(&Value::Null, &Value::Null),
        Err(EffectiveConfigError::ExtensionConfigNotObject)
    );
}

/// The overlay is one-way and instance-scoped by its inputs alone: neither a
/// cross-instance/alias scope selector nor a reverse merge exists in the API.
/// Re-running with the same inputs yields byte-identical results.
#[test]
fn overlay_is_stateless_and_deterministic() {
    let extension = json!({"role": "writer", "mode": "strict"});
    let module = json!({"role": "reader"});
    let first = normalize_effective_config(&extension, &module).unwrap();
    let second = normalize_effective_config(&extension, &module).unwrap();
    assert_eq!(first, second);
    // Reverse direction would require a third argument; the API takes exactly
    // the two authorities and cannot express a symmetric/recursive union.
    assert_eq!(
        first.effective_config,
        json!({"role": "reader", "mode": "strict"})
    );
    let digest_once = digest(&first.effective_config);
    assert_eq!(second.effective_config_digest, digest_once);
    // Calling with `module` swapped for `extension` is a different overlay, not
    // an error: order is authoritative and non-commutative.
    let swapped_inputs = json!({"role": "writer", "mode": "strict"});
    assert_eq!(
        normalize_effective_config(&module, &extension)
            .unwrap()
            .effective_config,
        swapped_inputs
    );
    // Digest is bound to the effective object (stale-digest rejection is a
    // consumer concern: InstallConfig uses verified_digest).
    assert_eq!(
        first.effective_config_digest,
        digest(&first.effective_config)
    );
}

/// Stale/shifted digests and stale revisions are rejected by the InstallConfig
/// consumer before any commit or member-count consequence.
#[test]
fn consumer_rejects_stale_revision_and_digest() {
    let config = json!({"member": 1});
    let honest = digest(&config);
    let state = {
        let mut snapshot = empty_core_snapshot();
        snapshot.config = json!({"revision": 7});
        snapshot
    };
    // Replay of an already-committed revision (stale): non-increasing revision.
    let replay = reduce(
        &state,
        &CoreCommand::InstallConfig(InstallConfigCommand {
            command_id: "replay".into(),
            revision: 7,
            effective_config: config.clone(),
            digest: honest.clone(),
        }),
        &EnvironmentInput::default(),
    );
    assert_eq!(
        replay.error.as_ref().unwrap().code,
        "CONFIG_REVISION_CONFLICT"
    );
    assert_eq!(replay.state.config["revision"], json!(7), "revision bound");

    // Claimed digest does not match the effective object bytes.
    let shifted = reduce(
        &state,
        &CoreCommand::InstallConfig(InstallConfigCommand {
            command_id: "shifted".into(),
            revision: 8,
            effective_config: config.clone(),
            digest: digest(&json!({"member": 2})),
        }),
        &EnvironmentInput::default(),
    );
    assert_eq!(
        shifted.error.as_ref().unwrap().code,
        "CONFIG_DIGEST_MISMATCH"
    );
    assert_eq!(shifted.state.config["revision"], json!(7));
}
