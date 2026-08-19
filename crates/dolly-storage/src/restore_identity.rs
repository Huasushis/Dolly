//! Pure restore-identity modes planner (imported vector `TST-REC-001`,
//! requirements `REQ-REC-004`, `INV-XCAP-005`, `REQ-XCAP-003`).
//!
//! Terms, defined in plain language at first use:
//!
//! - A "restore identity mode" is the declared identity authority of a restore
//!   or clone, chosen by an explicit operation. The mode binds how a restored
//!   Module's storage scope and external authority are carried into the target
//!   system. There are exactly three modes:
//!   - `replace_same_identity` — disaster recovery or in-place replacement. It
//!     preserves daemon, instance, Module, and storage-scope identity, uses
//!     fresh Worker/process/capability fences, increments every active writer
//!     generation, and requires source-retirement or backend-fence proof before
//!     external or shared state is writable.
//!   - `isolated_snapshot_clone` — a research/test replica with a fresh daemon
//!     and secret/capability domain and private mutable stores. It may retain
//!     copied scope values only for byte-faithful opaque state; all external
//!     effects, account sessions, remote databases, and provider state are
//!     disabled.
//!   - `portable_fork` — a new live identity. Every enabled stateful Module
//!     receives a fresh target scope through an explicit
//!     `clone_to_fresh_scope` migration; a Module that cannot remap its opaque
//!     state remains disabled with the source bytes retained.
//! - A "storage scope ID" is the stable, never-reused per-Module namespace
//!   (`storage_scope_id`) that binds every Module-state handle; the wire format
//!   is the canonical UuidV7 (`REQ-XCAP-003`).
//! - A "writer generation" is the per-scope monotonic fence integer recorded in
//!   backup metadata (`last_writer_generation`); restore issues the next
//!   generation so a stale writer cannot win (`INV-XCAP-005` handoff is
//!   durable, monotonically fenced, and never wraps).
//! - "External authority" is the source's external effects, account sessions,
//!   remote databases, and provider state; each mode decides whether it stays
//!   writable.
//! - A "remapped scope" is the fresh target scope a portable fork allocates
//!   for a Module moved by `clone_to_fresh_scope`; it must differ from the
//!   source scope and be never-used.
//! - "Opaque Module state" is state no supported migration can port, so a
//!   portable fork leaves it `disabled` with the source bytes retained for
//!   later recovery.
//!
//! This module is a pure, deterministic planner: it never writes state, opens
//! stores, or touches the network. It validates every input premise fail-closed
//! and consumes each premise only in the direction its own sentence authorizes —
//! the upstream restore authority (scope, writer generation, source identity)
//! never merges with downstream Extension premises, and a one-direction mode
//! never gains the opposite-direction premise. The planner's output, audit
//! events, and errors never mutate or become authority over the backup
//! identity.

use serde::{Deserialize, Serialize};

/// Safest convertible JSON integer ceiling for a writer generation, shared
/// with the spec's `Seq`/`Revision` safe-JSON-integer ceiling
/// (`9007199254740991`, `2^53 - 1`). Generations above this cannot be
/// incremented deterministically, so they fence the scope (`INV-XCAP-005`).
pub const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

/// One restore-identity mode, exactly as requested by an explicit operation.
///
/// The variant set is closed: only these three modes exist, and no default or
/// extra mode may appear in a plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreIdentityMode {
    ReplaceSameIdentity,
    IsolatedSnapshotClone,
    PortableFork,
}

impl RestoreIdentityMode {
    /// Resolves a requested mode by its wire name, refusing a name outside the
    /// closed mode set as `RESTORE_IDENTITY_MODES_INVALID`.
    pub fn try_from_name(name: &str) -> Result<Self, RestoreIdentityPlannerError> {
        match name {
            "replace_same_identity" => Ok(Self::ReplaceSameIdentity),
            "isolated_snapshot_clone" => Ok(Self::IsolatedSnapshotClone),
            "portable_fork" => Ok(Self::PortableFork),
            _ => Err(RestoreIdentityPlannerError::modes_invalid(format!(
                "unknown restore identity mode: {name}"
            ))),
        }
    }

    /// The wire name, matching the vector and the TypeScript reference.
    pub fn wire_name(self) -> &'static str {
        match self {
            Self::ReplaceSameIdentity => "replace_same_identity",
            Self::IsolatedSnapshotClone => "isolated_snapshot_clone",
            Self::PortableFork => "portable_fork",
        }
    }
}

/// The stable public error codes of the restore-identity modes planner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum RestoreIdentityPlannerErrorCode {
    /// The backup identity/input is invalid (non-empty identity fields,
    /// canonical UuidV7 storage scope, positive safe-JSON writer generation,
    /// convertible generation ceiling, fresh remapped-scope derivation).
    #[error("RESTORE_BACKUP_INVALID")]
    RestoreBackupInvalid,
    /// The requested mode set/combination or output constraint is invalid
    /// (empty, duplicated, or unknown mode requests).
    #[error("RESTORE_IDENTITY_MODES_INVALID")]
    RestoreIdentityModesInvalid,
}

/// A typed planner failure: a stable `code` plus a human-readable message.
///
/// Backup `RESTORE_BACKUP_INVALID` failures take precedence over mode
/// `RESTORE_IDENTITY_MODES_INVALID` failures, and mode validation runs before
/// the fresh writer-generation ceiling check — the same ordering as the
/// accepted TypeScript reference — so two simultaneous invalidities never
/// reorder the public error code.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}: {message}")]
pub struct RestoreIdentityPlannerError {
    /// The stable public error code.
    pub code: RestoreIdentityPlannerErrorCode,
    /// Specific premise that failed (not part of the stable wire contract).
    message: String,
}

impl RestoreIdentityPlannerError {
    fn backup_invalid(message: impl Into<String>) -> Self {
        Self {
            code: RestoreIdentityPlannerErrorCode::RestoreBackupInvalid,
            message: message.into(),
        }
    }

    fn modes_invalid(message: impl Into<String>) -> Self {
        Self {
            code: RestoreIdentityPlannerErrorCode::RestoreIdentityModesInvalid,
            message: message.into(),
        }
    }

    /// The stable public error code.
    pub fn code(&self) -> RestoreIdentityPlannerErrorCode {
        self.code
    }
}

impl RestoreIdentityPlannerErrorCode {
    /// The normative code string from the vector/TS reference.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RestoreBackupInvalid => "RESTORE_BACKUP_INVALID",
            Self::RestoreIdentityModesInvalid => "RESTORE_IDENTITY_MODES_INVALID",
        }
    }
}

/// One backup manifest Module entry: the source-owned restore-identity input
/// pair (`source_daemon_installation_id`, `source_instance_id`) with the
/// Module's stored scope and generation. The planner reads these as premises
/// of the upstream side only; it never attaches them to downstream Extensions.
///
/// The entry is closed input: unknown fields are rejected (`serde`
/// `deny_unknown_fields`) rather than silently widened. `last_writer_generation`
/// is a non-negative integer at the wire shape; its positive-safe range and
/// the ceiled fresh generation are validated by the planner (see
/// [`evaluate_restore_identity_modes`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestoreIdentityBackupEntry {
    /// The source daemon installation ID (upstream premise only).
    pub source_daemon_installation_id: String,
    /// The source instance ID (upstream premise only).
    pub source_instance_id: String,
    /// The Module ID whose scope is being restored.
    pub module_id: String,
    /// The host-assigned storage scope ID (canonical UuidV7 wire form).
    pub storage_scope_id: String,
    /// The per-scope monotonic writer generation recorded in the backup.
    pub last_writer_generation: u64,
    /// The source's external-state reference/clone policy.
    pub external_state: String,
}

impl RestoreIdentityBackupEntry {
    /// Builds the entry from a JSON value, mapping every malformed-input
    /// failure to the public `RESTORE_BACKUP_INVALID` code instead of leaking
    /// a generic serde error. The entry is closed: unknown fields are refused.
    pub fn try_from_value(value: &serde_json::Value) -> Result<Self, RestoreIdentityPlannerError> {
        serde_json::from_value(value.clone()).map_err(|error| {
            RestoreIdentityPlannerError::backup_invalid(format!(
                "RESTORE_BACKUP_INVALID: invalid backup entry JSON: {error}"
            ))
        })
    }

    /// Builds the entry from a JSON document string, mapping every
    /// malformed-input failure to `RESTORE_BACKUP_INVALID`.
    pub fn try_from_json_str(input: &str) -> Result<Self, RestoreIdentityPlannerError> {
        serde_json::from_str(input).map_err(|error| {
            RestoreIdentityPlannerError::backup_invalid(format!(
                "RESTORE_BACKUP_INVALID: invalid backup entry JSON: {error}"
            ))
        })
    }
}

/// `replace_same_identity` result: preserved scope, next writer generation,
/// external writes gated behind a fence proof.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReplaceSameIdentityPlan {
    pub storage_scope_id: String,
    pub writer_generation: u64,
    pub external_write_before_fence: bool,
}

/// `isolated_snapshot_clone` result: fresh private stores, no external
/// authority crosses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IsolatedSnapshotClonePlan {
    pub external_effects_enabled: bool,
    pub mutable_store_shared_with_source: bool,
}

/// A marked refusal to reuse the source scope (`STATE_CLONE_REMAP_REQUIRED`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ReusedSourceScope {
    pub error: &'static str,
}

/// The opaque Module's recorded disposition under a portable fork.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct UnsupportedOpaqueModule {
    pub state: &'static str,
}

/// `portable_fork` result: fresh remapped scope, opaque Modules disabled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PortableForkPlan {
    pub reused_source_scope: ReusedSourceScope,
    pub remapped_scope: String,
    pub unsupported_opaque_module: UnsupportedOpaqueModule,
}

/// One planned audit emission the executor performs when the plan is applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct RestoreIdentityAuditEvent {
    pub kind: &'static str,
    pub event: &'static str,
}

/// The full language-neutral output document of one
/// `evaluate_restore_identity_modes` command. Sections appear only for the
/// requested modes; `emitted` always begins with the plan-verification audit
/// and appends the portable remap audit when the fork mode is requested.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RestoreIdentityModesPlan {
    pub outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replace: Option<ReplaceSameIdentityPlan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isolated_clone: Option<IsolatedSnapshotClonePlan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portable_fork: Option<PortableForkPlan>,
    pub emitted: Vec<RestoreIdentityAuditEvent>,
}

/// Evaluates the requested restore-identity modes against a validated backup
/// entry and returns the exactly-one-mode-transform plan, or fails closed.
///
/// Validation order (matching the accepted TypeScript reference):
/// 1. backup identity premises — non-empty identity fields, canonical UuidV7
///    storage scope, positive safe-JSON writer generation — as
///    `RESTORE_BACKUP_INVALID`;
/// 2. the requested mode set — non-empty, no duplicate, no unknown mode — as
///    `RESTORE_IDENTITY_MODES_INVALID`;
/// 3. the fresh writer generation (`last + 1`) ceiling — as
///    `RESTORE_BACKUP_INVALID` on exhaustion.
///
/// Each requested mode receives only its required premise direction and
/// cardinality; the plan is deterministic and never mutates the input.
pub fn evaluate_restore_identity_modes(
    backup: &RestoreIdentityBackupEntry,
    cases: &[RestoreIdentityMode],
) -> Result<RestoreIdentityModesPlan, RestoreIdentityPlannerError> {
    // 1. Backup identity premises (RESTORE_BACKUP_INVALID), in TS order.
    assert_non_empty(
        &backup.source_daemon_installation_id,
        "source_daemon_installation_id",
    )?;
    assert_non_empty(&backup.source_instance_id, "source_instance_id")?;
    assert_non_empty(&backup.module_id, "module_id")?;
    assert_storage_scope_id(&backup.storage_scope_id, "storage_scope_id")?;
    assert_positive_safe_integer(backup.last_writer_generation, "last_writer_generation")?;
    assert_non_empty(&backup.external_state, "external_state")?;

    // 2. Requested mode set (RESTORE_IDENTITY_MODES_INVALID).
    if cases.is_empty() {
        return Err(RestoreIdentityPlannerError::modes_invalid(
            "at least one restore identity mode must be requested",
        ));
    }
    let mut requested = std::collections::BTreeSet::new();
    for &mode in cases {
        let wire_name = mode.wire_name();
        if !requested.insert(mode) {
            return Err(RestoreIdentityPlannerError::modes_invalid(format!(
                "restore identity mode requested more than once: {wire_name}"
            )));
        }
    }

    // 3. Fresh writer generation ceiling (RESTORE_BACKUP_INVALID).
    let writer_generation = backup.last_writer_generation + 1;
    if writer_generation > MAX_SAFE_JSON_INTEGER {
        return Err(RestoreIdentityPlannerError::backup_invalid(
            "a fresh writer generation would exceed the safe integer range",
        ));
    }

    // Build the exactly-one-transform plan with the fixed audit order.
    let mut emitted = vec![RestoreIdentityAuditEvent {
        kind: "audit",
        event: "restore_identity_plan_verified",
    }];
    let replace = requested
        .contains(&RestoreIdentityMode::ReplaceSameIdentity)
        .then(|| ReplaceSameIdentityPlan {
            storage_scope_id: backup.storage_scope_id.clone(),
            writer_generation,
            external_write_before_fence: false,
        });
    let isolated_clone = requested
        .contains(&RestoreIdentityMode::IsolatedSnapshotClone)
        .then(|| IsolatedSnapshotClonePlan {
            external_effects_enabled: false,
            mutable_store_shared_with_source: false,
        });
    let portable_fork = if requested.contains(&RestoreIdentityMode::PortableFork) {
        emitted.push(RestoreIdentityAuditEvent {
            kind: "audit",
            event: "portable_scope_remap_recorded",
        });
        Some(PortableForkPlan {
            reused_source_scope: ReusedSourceScope {
                error: "STATE_CLONE_REMAP_REQUIRED",
            },
            remapped_scope: remapped_scope(&backup.storage_scope_id)?,
            unsupported_opaque_module: UnsupportedOpaqueModule { state: "disabled" },
        })
    } else {
        None
    };

    Ok(RestoreIdentityModesPlan {
        outcome: "identity_mode_controls_scope_and_external_authority",
        replace,
        isolated_clone,
        portable_fork,
        emitted,
    })
}

/// The canonical UuidV7 wire form (`common.schema.json` `UuidV7`): a storage
/// scope ID is exactly this shape — 8 hex, `-`, 4 hex, `-`, version digit `7`
/// followed by 3 hex, `-`, variant nibble `[89ab]` followed by 3 hex, `-`, 12
/// hex. The variant nibble carries the RFC 4122 `10` variant bits, so only
/// `8`, `9`, `a`, or `b` are accepted at position 19.
fn is_storage_scope_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    let is_hex = |b: u8| matches!(b, b'0'..=b'9' | b'a'..=b'f');
    for (index, byte) in bytes.iter().enumerate() {
        match index {
            0..=7 | 9..=12 | 15..=17 | 20..=22 | 24..=35 => {
                if !is_hex(*byte) {
                    return false;
                }
            }
            14 => {
                if *byte != b'7' {
                    return false;
                }
            }
            19 => {
                if !matches!(byte, b'8' | b'9' | b'a' | b'b') {
                    return false;
                }
            }
            8 | 13 | 18 | 23 => {
                if *byte != b'-' {
                    return false;
                }
            }
            _ => return false,
        }
    }
    true
}

/// Offset of the trailing 12-hex monotonic slot inside a storage scope ID.
const SCOPE_TAIL_INDEX: usize = 24;

/// Derives the fresh "remapped scope" a portable fork assigns: the source
/// scope with its trailing 12-hex slot incremented by one. Failing closed on
/// slot exhaustion keeps the derivation free of reuse and wrap, matching
/// `REQ-XCAP-003` (never-reused) and the vector's expected
/// `0198ab31-6c44-7e8a-b2bb-000000000463`.
fn remapped_scope(source_scope: &str) -> Result<String, RestoreIdentityPlannerError> {
    let tail = &source_scope[SCOPE_TAIL_INDEX..];
    let slot =
        u64::from_str_radix(tail, 16).expect("storage scope was validated as canonical UuidV7 hex");
    let candidate = slot + 1;
    const MAX_TAIL: u64 = 0xffff_ffff_ffff;
    if candidate > MAX_TAIL {
        return Err(RestoreIdentityPlannerError::backup_invalid(
            "source storage scope cannot yield a fresh remapped scope",
        ));
    }
    let prefix = &source_scope[..SCOPE_TAIL_INDEX];
    Ok(format!("{prefix}{candidate:012x}"))
}

/// A non-empty string backup identity premise.
fn assert_non_empty(value: &str, label: &str) -> Result<(), RestoreIdentityPlannerError> {
    if value.is_empty() {
        return Err(RestoreIdentityPlannerError::backup_invalid(format!(
            "{label} must be a non-empty string"
        )));
    }
    Ok(())
}

/// A canonical UuidV7 storage scope ID.
fn assert_storage_scope_id(value: &str, label: &str) -> Result<(), RestoreIdentityPlannerError> {
    if !is_storage_scope_id(value) {
        return Err(RestoreIdentityPlannerError::backup_invalid(format!(
            "{label} must be a canonical UuidV7 storage scope ID"
        )));
    }
    Ok(())
}

/// A positive safe-JSON writer generation (`1..=MAX_SAFE_JSON_INTEGER`).
fn assert_positive_safe_integer(
    value: u64,
    label: &str,
) -> Result<(), RestoreIdentityPlannerError> {
    if value < 1 {
        return Err(RestoreIdentityPlannerError::backup_invalid(format!(
            "{label} must be a positive safe integer"
        )));
    }
    if value > MAX_SAFE_JSON_INTEGER {
        return Err(RestoreIdentityPlannerError::backup_invalid(format!(
            "{label} must be a positive safe integer"
        )));
    }
    Ok(())
}
