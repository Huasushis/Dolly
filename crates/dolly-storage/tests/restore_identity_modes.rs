//! TST-REC-001 restore-identity modes planner integration tests.
//!
//! The authoritative input is the imported vector `TST-REC-001` in
//! `dolly-spec/test-vectors/core/` (kind `crash_recovery`, covers
//! `REQ-REC-004` and `INV-XCAP-005`). The vector command
//! `evaluate_restore_identity_modes` runs the planner over the three
//! identity-mode cases and asserts the resulting scope and external-authority
//! plan. This test executes the imported vector and pins the full
//! language-neutral output document byte-for-byte (RFC 8785 canonical JSON,
//! via the `dolly-canonical-json` crate), so the Rust planner and the accepted
//! TypeScript reference `restore-identity-planner.ts` must produce the exact
//! same document.
//!
//! The failure side of the contract is also pinned here: every invalid backup
//! premise is `RESTORE_BACKUP_INVALID`, every invalid requested mode set is
//! `RESTORE_IDENTITY_MODES_INVALID`, backup-premise validation runs before
//! mode validation, and mode validation runs before the fresh writer
//! generation ceiling check — so two simultaneous invalidities cannot reorder
//! the public error.

use std::fs;
use std::path::{Path, PathBuf};

use dolly_canonical_json::canonicalize;
use dolly_storage::{
    MAX_SAFE_JSON_INTEGER, RestoreIdentityBackupEntry, RestoreIdentityMode,
    RestoreIdentityPlannerError, RestoreIdentityPlannerErrorCode, evaluate_restore_identity_modes,
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

fn read_vector() -> Value {
    let bytes =
        fs::read(spec_root().join("test-vectors/core/TST-REC-001-restore-clone-scope.json"))
            .expect("authoritative vector present");
    serde_json::from_slice(&bytes).expect("vector parses")
}

fn valid_backup() -> RestoreIdentityBackupEntry {
    RestoreIdentityBackupEntry {
        source_daemon_installation_id: "0198ab31-6c44-7e8a-b2bb-000000000461".into(),
        source_instance_id: "main".into(),
        module_id: "memory-main".into(),
        storage_scope_id: "0198ab31-6c44-7e8a-b2bb-000000000462".into(),
        last_writer_generation: 4,
        external_state: "remote-database".into(),
    }
}

fn modes(names: &[&str]) -> Vec<RestoreIdentityMode> {
    names
        .iter()
        .map(|name| RestoreIdentityMode::try_from_name(name).expect("known restore-identity mode"))
        .collect()
}

/// Canonical RFC 8785 spelling of an object, from the planner's own JCS path.
fn canonical<T: serde::Serialize>(value: &T) -> String {
    canonicalize(value)
        .expect("value is JCS-canonicalizable")
        .0
        .to_string()
}

fn code<T: std::fmt::Debug>(
    result: Result<T, RestoreIdentityPlannerError>,
) -> RestoreIdentityPlannerErrorCode {
    result.expect_err("planner must fail closed").code()
}

fn entry_from(value: &Value) -> Result<RestoreIdentityBackupEntry, RestoreIdentityPlannerError> {
    RestoreIdentityBackupEntry::try_from_value(value)
}

/// The full language-neutral output document of the planner for the imported
/// `TST-REC-001` vector, pinned exactly as the accepted TypeScript reference
/// pins it (`VECTOR_OUTPUT`).
fn vector_output_json() -> Value {
    json!({
        "outcome": "identity_mode_controls_scope_and_external_authority",
        "replace": {
            "storage_scope_id": "0198ab31-6c44-7e8a-b2bb-000000000462",
            "writer_generation": 5,
            "external_write_before_fence": false,
        },
        "isolated_clone": {
            "external_effects_enabled": false,
            "mutable_store_shared_with_source": false,
        },
        "portable_fork": {
            "reused_source_scope": { "error": "STATE_CLONE_REMAP_REQUIRED" },
            "remapped_scope": "0198ab31-6c44-7e8a-b2bb-000000000463",
            "unsupported_opaque_module": { "state": "disabled" },
        },
        "emitted": [
            { "kind": "audit", "event": "restore_identity_plan_verified" },
            { "kind": "audit", "event": "portable_scope_remap_recorded" },
        ],
    })
}

fn assert_planner_error<T: std::fmt::Debug>(
    result: Result<T, RestoreIdentityPlannerError>,
    expected: RestoreIdentityPlannerErrorCode,
    label: &str,
) {
    let actual = code(result);
    assert_eq!(
        actual, expected,
        "{label}: expected {expected:?}, got {actual:?}"
    );
}

// ---------------------------------------------------------------------------
// R1 + authoritative vector output and subset behavior
// ---------------------------------------------------------------------------

/// The planner reproduces the imported vector output as the exact
/// language-neutral document: every asserted path holds, the emitted audit
/// events match, and the canonical bytes equal the pinned reference document.
#[test]
fn reproduces_imported_vector_output() {
    let vector = read_vector();
    assert_eq!(vector["test_id"], "TST-REC-001");
    assert!(vector["expected"]["crash_label"].is_null());
    assert_eq!(
        vector["expected"]["outcome"],
        "identity_mode_controls_scope_and_external_authority"
    );

    let backup = entry_from(&vector["initial"]["backup"])
        .expect("vector backup entry is valid by construction");
    let case_names: Vec<&str> = vector["stimulus"]["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    let plan = evaluate_restore_identity_modes(&backup, &modes(&case_names))
        .expect("full vector case set is valid");

    // Full document byte parity with the pinned reference document.
    let plan_value = serde_json::to_value(&plan).unwrap();
    assert_eq!(
        canonical(&plan_value),
        canonical(&vector_output_json()),
        "plan document must byte-match the pinned VECTOR_OUTPUT"
    );

    // Every vector assertion path holds verbatim on the produced document.
    for assertion in vector["expected"]["assertions"].as_array().unwrap() {
        let path = assertion["path"].as_str().unwrap();
        assert_eq!(
            &assertion["value"],
            plan_value
                .pointer(path)
                .expect("assertion path present in plan"),
            "vector assertion path {path}"
        );
    }

    // Vector named audit events, in order, with the fixed audit shape.
    let emitted: Vec<Value> = plan_value["emitted"].as_array().unwrap().clone();
    let required = vector["expected"]["emitted"].as_array().unwrap();
    assert_eq!(emitted.len(), required.len(), "emitted length");
    for (actual, expected) in emitted.iter().zip(required) {
        assert_eq!(actual, expected, "emitted event");
    }
}

/// A requested subset keeps the closed output shape: only the requested
/// section appears, no extra/default mode appears, and the output is
/// deterministic across repeated evaluation without mutating the input.
#[test]
fn evaluates_requested_subset_and_stays_deterministic() {
    let backup = valid_backup();
    let before = &backup;
    let first = evaluate_restore_identity_modes(before, &modes(&["replace_same_identity"]))
        .expect("replace-only subset is valid");
    let second = evaluate_restore_identity_modes(before, &modes(&["replace_same_identity"]))
        .expect("repeat evaluation is valid");
    assert_eq!(first, second, "output is deterministic");
    assert_eq!(backup, *before, "input is not mutated by evaluation");

    let value = serde_json::to_value(&first).unwrap();
    assert_eq!(
        value,
        json!({
            "outcome": "identity_mode_controls_scope_and_external_authority",
            "replace": {
                "storage_scope_id": "0198ab31-6c44-7e8a-b2bb-000000000462",
                "writer_generation": 5,
                "external_write_before_fence": false,
            },
            "emitted": [
                { "kind": "audit", "event": "restore_identity_plan_verified" },
            ],
        }),
        "closed subset output shape"
    );
    let plan = value.as_object().unwrap();
    assert_eq!(plan.len(), 3, "no unused/empty section may be emitted");
    assert!(
        !plan.contains_key("isolated_clone") && !plan.contains_key("portable_fork"),
        "unrequested modes must not appear"
    );
}

// ---------------------------------------------------------------------------
// Each of the three valid mode transformations
// ---------------------------------------------------------------------------

/// `replace_same_identity` preserves the exact storage scope, issues the next
/// writer generation, and gates external writes behind source fencing.
#[test]
fn replace_mode_preserves_scope_and_increments_writer_generation() {
    let backup = valid_backup();
    let plan = evaluate_restore_identity_modes(&backup, &modes(&["replace_same_identity"]))
        .expect("valid");
    let value = serde_json::to_value(&plan).unwrap();
    assert_eq!(
        value["replace"]["storage_scope_id"],
        "0198ab31-6c44-7e8a-b2bb-000000000462"
    );
    assert_eq!(value["replace"]["writer_generation"], 5);
    assert_eq!(value["replace"]["external_write_before_fence"], false);
    assert_eq!(value["emitted"].as_array().unwrap().len(), 1);
}

/// `isolated_snapshot_clone` keeps the clone effect-free: no external effects
/// and no mutable store shared with the source.
#[test]
fn isolated_clone_mode_disables_external_authority() {
    let backup = valid_backup();
    let plan = evaluate_restore_identity_modes(&backup, &modes(&["isolated_snapshot_clone"]))
        .expect("valid");
    let value = serde_json::to_value(&plan).unwrap();
    assert_eq!(value["isolated_clone"]["external_effects_enabled"], false);
    assert_eq!(
        value["isolated_clone"]["mutable_store_shared_with_source"],
        false
    );
    assert_eq!(value["emitted"].as_array().unwrap().len(), 1);
}

/// `portable_fork` remaps to a fresh never-used scope, refuses reuse of the
/// source scope, leaves the opaque Module disabled, and appends the remap
/// audit event.
#[test]
fn portable_fork_mode_remaps_scope_and_disables_opaque_module() {
    let backup = valid_backup();
    let plan = evaluate_restore_identity_modes(&backup, &modes(&["portable_fork"])).expect("valid");
    let value = serde_json::to_value(&plan).unwrap();
    assert_eq!(
        value["portable_fork"]["reused_source_scope"]["error"], "STATE_CLONE_REMAP_REQUIRED",
        "the source scope is never reused"
    );
    assert_eq!(
        value["portable_fork"]["remapped_scope"],
        "0198ab31-6c44-7e8a-b2bb-000000000463"
    );
    assert_eq!(
        value["portable_fork"]["unsupported_opaque_module"]["state"],
        "disabled"
    );
    let emitted = value["emitted"].as_array().unwrap();
    assert_eq!(emitted.len(), 2, "fork appends the portable remap audit");
    assert_eq!(emitted[0]["event"], "restore_identity_plan_verified");
    assert_eq!(emitted[1]["event"], "portable_scope_remap_recorded");
}

// ---------------------------------------------------------------------------
// Invalid backup premises: RESTORE_BACKUP_INVALID
// ---------------------------------------------------------------------------

/// Malformed, non-canonical, wrong-version, and wrong-variant storage scope
/// IDs are all refused: only the exact canonical UuidV7 shape is accepted.
#[test]
fn fails_closed_on_malformed_storage_scope() {
    for (scope, label) in [
        ("", "empty scope"),
        ("not-a-scope", "opaque string"),
        ("0198ab31-6c44-7e8a-b2bb-00000000046Z", "non-hex tail"),
        (
            "0198ab31-6c44-6e8a-b2bb-000000000462",
            "wrong UUID version digit",
        ),
        (
            "0198ab31-6c44-7e8a-c2bb-000000000462",
            "wrong UUID variant nibble",
        ),
        ("0198ab31-6c44-7e8a-b2bb-0000000000", "wrong length"),
        ("0198ab31-6c44-7e8a-B2bb-000000000462", "uppercase hex"),
    ] {
        let mut backup = valid_backup();
        backup.storage_scope_id = scope.into();
        assert_planner_error(
            evaluate_restore_identity_modes(&backup, &modes(&["replace_same_identity"])),
            RestoreIdentityPlannerErrorCode::RestoreBackupInvalid,
            label,
        );
    }
}

/// Empty daemon/instance/module identifiers and an empty external state are
/// backup premises and fail as RESTORE_BACKUP_INVALID.
#[test]
fn fails_closed_on_empty_backup_identity_fields() {
    for (field, value) in [
        ("source_daemon_installation_id", ""),
        ("source_instance_id", ""),
        ("module_id", ""),
        ("external_state", ""),
    ] {
        let mut backup = valid_backup();
        match field {
            "source_daemon_installation_id" => backup.source_daemon_installation_id = value.into(),
            "source_instance_id" => backup.source_instance_id = value.into(),
            "module_id" => backup.module_id = value.into(),
            "external_state" => backup.external_state = value.into(),
            _ => unreachable!(),
        }
        assert_planner_error(
            evaluate_restore_identity_modes(&backup, &modes(&["replace_same_identity"])),
            RestoreIdentityPlannerErrorCode::RestoreBackupInvalid,
            field,
        );
    }
}

/// Zero, negative, fractional, non-safe, and beyond-safe writer generations
/// are RESTORE_BACKUP_INVALID — the JSON path must return the typed planner
/// error, never a generic serde failure.
#[test]
fn fails_closed_on_invalid_writer_generation() {
    let base = json!({
        "source_daemon_installation_id": "0198ab31-6c44-7e8a-b2bb-000000000461",
        "source_instance_id": "main",
        "module_id": "memory-main",
        "storage_scope_id": "0198ab31-6c44-7e8a-b2bb-000000000462",
        "last_writer_generation": 4,
        "external_state": "remote-database",
    });
    for (generation, label) in [
        (json!(0), "zero generation"),
        (json!(-1), "negative generation"),
        (json!(1.5), "fractional generation"),
        (json!(9007199254740993u64), "beyond safe integer"),
    ] {
        let mut raw = base.clone();
        raw["last_writer_generation"] = generation;
        assert_planner_error(
            entry_from(&raw).and_then(|backup| {
                evaluate_restore_identity_modes(&backup, &modes(&["replace_same_identity"]))
            }),
            RestoreIdentityPlannerErrorCode::RestoreBackupInvalid,
            label,
        );
    }
    // 0 is a typed field value too: directly refused by the planner.
    let mut zero = valid_backup();
    zero.last_writer_generation = 0;
    assert_planner_error(
        evaluate_restore_identity_modes(&zero, &modes(&["isolated_snapshot_clone"])),
        RestoreIdentityPlannerErrorCode::RestoreBackupInvalid,
        "zero typed generation",
    );
}

/// A fresh writer generation at the safe-integer ceiling fails closed
/// (RESTORE_BACKUP_INVALID) after mode validation confirms the request set.
#[test]
fn fails_closed_when_fresh_generation_exceeds_safe_range() {
    let mut backup = valid_backup();
    backup.last_writer_generation = MAX_SAFE_JSON_INTEGER;
    assert_planner_error(
        evaluate_restore_identity_modes(&backup, &modes(&["replace_same_identity"])),
        RestoreIdentityPlannerErrorCode::RestoreBackupInvalid,
        "generation exhaustion at replace",
    );
    // The ceiling check is unconditional: even a mode that does not carry a
    // writer generation cannot proceed past an exhausted generation.
    assert_planner_error(
        evaluate_restore_identity_modes(&backup, &modes(&["isolated_snapshot_clone"])),
        RestoreIdentityPlannerErrorCode::RestoreBackupInvalid,
        "generation exhaustion without replace",
    );
}

// ---------------------------------------------------------------------------
// Portable-fork remap arithmetic: never wrap, never truncate, fail on
// exhaustion
// ---------------------------------------------------------------------------

/// The remapped tail is the source tail + 1 (12-hex, no wrap or truncation).
#[test]
fn portable_fork_tail_arithmetic_does_not_wrap_or_truncate() {
    let mut backup = valid_backup();
    // Carry propagates within the 12-hex slot and keeps the fixed width.
    backup.storage_scope_id = "0198ab31-6c44-7e8a-b2bb-0000000000ff".into();
    let plan = evaluate_restore_identity_modes(&backup, &modes(&["portable_fork"])).unwrap();
    let value = serde_json::to_value(&plan).unwrap();
    assert_eq!(
        value["portable_fork"]["remapped_scope"],
        "0198ab31-6c44-7e8a-b2bb-000000000100"
    );

    // A high slot advances by one without shortening the leading padding.
    backup.storage_scope_id = "0198ab31-6c44-7e8a-b2bb-fffffffffff0".into();
    let plan = evaluate_restore_identity_modes(&backup, &modes(&["portable_fork"])).unwrap();
    let value = serde_json::to_value(&plan).unwrap();
    assert_eq!(
        value["portable_fork"]["remapped_scope"],
        "0198ab31-6c44-7e8a-b2bb-fffffffffff1"
    );
    assert_eq!(
        value["portable_fork"]["remapped_scope"]
            .as_str()
            .unwrap()
            .len(),
        36,
        "remapped scope keeps the canonical UuidV7 width"
    );
}

/// Source scope tail exhaustion (all `f`) yields RESTORE_BACKUP_INVALID: a
/// fresh never-reused scope cannot be derived, so the plan fails closed.
#[test]
fn fails_closed_on_portable_fork_tail_exhaustion() {
    let mut backup = valid_backup();
    backup.storage_scope_id = "0198ab31-6c44-7e8a-b2bb-ffffffffffff".into();
    assert_planner_error(
        evaluate_restore_identity_modes(&backup, &modes(&["portable_fork"])),
        RestoreIdentityPlannerErrorCode::RestoreBackupInvalid,
        "portable fork tail exhaustion",
    );
}

// ---------------------------------------------------------------------------
// Invalid requested mode sets: RESTORE_IDENTITY_MODES_INVALID
// ---------------------------------------------------------------------------

/// Empty, duplicated, and unknown mode requests are RESTORE_IDENTITY_MODES_INVALID.
#[test]
fn fails_closed_on_invalid_mode_requests() {
    let backup = valid_backup();
    assert_planner_error(
        evaluate_restore_identity_modes(&backup, &[]),
        RestoreIdentityPlannerErrorCode::RestoreIdentityModesInvalid,
        "empty mode list",
    );
    assert_planner_error(
        evaluate_restore_identity_modes(&backup, &modes(&["portable_fork", "portable_fork"])),
        RestoreIdentityPlannerErrorCode::RestoreIdentityModesInvalid,
        "duplicated mode",
    );
    assert_planner_error(
        RestoreIdentityMode::try_from_name("time_travel_fork").map(|_| unreachable!()),
        RestoreIdentityPlannerErrorCode::RestoreIdentityModesInvalid,
        "unknown mode name",
    );
}

/// Two simultaneous invalidities cannot reorder the public error: a malformed
/// backup premise always wins over an invalid mode set (RESTORE_BACKUP_INVALID),
/// and mode validation runs before the writer-generation ceiling check
/// (RESTORE_IDENTITY_MODES_INVALID outranks exhaustion when both apply).
#[test]
fn error_precedence_between_backup_and_modes_is_stable() {
    // Backup premise invalid + invalid mode set -> BACKUP_INVALID wins.
    let mut bad_backup = valid_backup();
    bad_backup.module_id = "".into();
    assert_planner_error(
        evaluate_restore_identity_modes(&bad_backup, &[]),
        RestoreIdentityPlannerErrorCode::RestoreBackupInvalid,
        "empty module id + empty modes",
    );

    // Generation at ceiling (a valid backup premise value) + valid mode
    // set -> the ceiling check fires after modes and yields BACKUP_INVALID.
    let mut high = valid_backup();
    high.last_writer_generation = MAX_SAFE_JSON_INTEGER;
    assert_planner_error(
        evaluate_restore_identity_modes(&high, &modes(&["portable_fork"])),
        RestoreIdentityPlannerErrorCode::RestoreBackupInvalid,
        "ceiling generation + valid modes",
    );

    // Generation at ceiling + empty mode set -> MODES_INVALID still wins
    // because mode validation precedes the generation ceiling check.
    assert_planner_error(
        evaluate_restore_identity_modes(&high, &[]),
        RestoreIdentityPlannerErrorCode::RestoreIdentityModesInvalid,
        "ceiling generation + empty modes",
    );
}

// ---------------------------------------------------------------------------
// Closed serde inputs: unknown fields are rejected, not silently widened
// ---------------------------------------------------------------------------

/// An unknown field on the closed backup entry is refused as
/// RESTORE_BACKUP_INVALID rather than ignored.
#[test]
fn rejects_unknown_backup_fields() {
    let mut raw = json!({
        "source_daemon_installation_id": "0198ab31-6c44-7e8a-b2bb-000000000461",
        "source_instance_id": "main",
        "module_id": "memory-main",
        "storage_scope_id": "0198ab31-6c44-7e8a-b2bb-000000000462",
        "last_writer_generation": 4,
        "external_state": "remote-database",
    });
    let known = entry_from(&raw).expect("the six known fields parse");
    evaluate_restore_identity_modes(&known, &modes(&["replace_same_identity"]))
        .expect("baseline backup with only known fields is valid");

    raw["intruder_field"] = json!(true);
    assert_planner_error(
        entry_from(&raw),
        RestoreIdentityPlannerErrorCode::RestoreBackupInvalid,
        "unknown backup field is rejected",
    );
}
