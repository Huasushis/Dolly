//! Durable Tool-call ledger record and dispatch-boundary recovery
//! (spec §5/§6, REQ-TOOL-002/005/006, TST-TOOL-001/002/006/009–013).
//!
//! The durable form of a Tool-call row is the exact closed
//! [`dolly.tool-call-ledger/v1`] record: it embeds the complete closed
//! [`dolly.tool-operation-binding/v1`] binding and the state machine
//! transitions of spec §6. Serializing these bytes IS the store's
//! `record_jcs`; reopening is fail-closed (wrong/missing schema tag, unknown
//! member, or inconsistent state/field combination is corruption, not an
//! upgrade).
//!
//! `recover_operation(record, facts)` is a pure recovery decision: it
//! performs no I/O and reads no current registry, so no downstream
//! ACK/result/error/absence can ever become upstream redispatch authority.
//! The decision table is the spec §6 one exactly.

use dolly_canonical_json::{CanonicalBytes, CanonicalJsonObject, Sha256Digest, canonicalize};
use serde::{Deserialize, Serialize};

use crate::registry::{IdempotencyPolicy, SideEffectClass};
use crate::result::ToolErrorCode;
use crate::result::ToolResult;

/// The wire discriminator of the durable Tool-call ledger record. Every
/// serialized `ToolCallLedgerRecord` MUST carry this exact value in its
/// `schema` member; reopening is fail-closed, so a missing, wrong, or unknown
/// value is a ledger corruption, not an upgrade.
pub const TOOL_CALL_LEDGER_RECORD_SCHEMA: &str = "dolly.tool-call-ledger/v1";

/// The wire discriminator of the closed operation binding embedded in every
/// ledger record (spec §5).
pub use crate::invoke::OPERATION_BINDING_SCHEMA as TOOL_OPERATION_BINDING_SCHEMA;

/// Durable Tool-call ledger states (spec §6). The `AUTHORIZED` state is the
/// zero-eligible-byte boundary; `DISPATCHED` is the durable send-possible
/// boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum LedgerState {
    Authorized,
    Dispatched,
    Succeeded,
    Failed,
    Unknown,
}

impl LedgerState {
    /// The uppercase wire spelling used by the SQLite `state` column and the
    /// vector of `assertions` in the test vectors.
    pub fn wire_name(self) -> &'static str {
        match self {
            LedgerState::Authorized => "AUTHORIZED",
            LedgerState::Dispatched => "DISPATCHED",
            LedgerState::Succeeded => "SUCCEEDED",
            LedgerState::Failed => "FAILED",
            LedgerState::Unknown => "UNKNOWN",
        }
    }

    /// The schema-mandated `ledger_revision` for this state under the normal
    /// forward machine (TST-TOOL-006's `FAILED` may also record revision 2 —
    /// see `ToolCallLedgerRecord::verify_field_combination`).
    pub fn default_ledger_revision(self) -> u64 {
        match self {
            LedgerState::Authorized => 1,
            LedgerState::Dispatched => 2,
            LedgerState::Succeeded | LedgerState::Unknown => 3,
            LedgerState::Failed => 3,
        }
    }

    /// Parse the SQLite `state` column wire spelling (UPPERCASE enum value).
    pub fn from_wire(spelling: &str) -> Option<Self> {
        Some(match spelling {
            "AUTHORIZED" => LedgerState::Authorized,
            "DISPATCHED" => LedgerState::Dispatched,
            "SUCCEEDED" => LedgerState::Succeeded,
            "FAILED" => LedgerState::Failed,
            "UNKNOWN" => LedgerState::Unknown,
            _ => return None,
        })
    }

    /// Whether this state is terminal (spec §6: terminal rows are immutable).
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            LedgerState::Succeeded | LedgerState::Failed | LedgerState::Unknown
        )
    }
}

/// The event published when a dispatched fact cannot be resolved.
pub const EVENT_TOOL_OUTCOME_UNKNOWN: &str = "ToolOutcomeUnknown";
/// The event published when zero-byte non-application is authoritatively
/// proved (TST-TOOL-006).
pub const EVENT_TOOL_DISPATCH_PROVED_NOT_APPLIED: &str = "ToolDispatchProvedNotApplied";
/// The event published after a successful `AUTHORIZED -> DISPATCHED`
/// compare-and-set commits (TST-TOOL-009) — never before commit.
pub const EVENT_TOOL_OPERATION_DISPATCHED: &str = "ToolOperationDispatched";

/// The confirmation decision of the frozen binding
/// (spec §5: `not_required` or a consumed single-use approval ID).
///
/// Serialization is the exact wire form: `"not_required"` or a UuidV7
/// approval ID. A malformed value fails deserialization (closed world).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfirmationDecision {
    /// No confirmation required for this tool.
    NotRequired,
    /// The single-use approval ID bound to this operation digest.
    Approved(String),
}

impl Serialize for ConfirmationDecision {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            ConfirmationDecision::NotRequired => serializer.serialize_str("not_required"),
            ConfirmationDecision::Approved(id) => serializer.serialize_str(id),
        }
    }
}

impl<'de> Deserialize<'de> for ConfirmationDecision {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value == "not_required" {
            return Ok(ConfirmationDecision::NotRequired);
        }
        if is_uuid_v7(&value) {
            return Ok(ConfirmationDecision::Approved(value));
        }
        Err(serde::de::Error::custom(format!(
            "confirmation_decision must be \"not_required\" or a UuidV7, got {value:?}"
        )))
    }
}

/// Strict UuidV7 wire check: 8-4-4-4-12 lowercase hex with version digit `7`
/// and variant in `[89ab]` (common.schema.json `UuidV7`).
pub(crate) fn is_uuid_v7(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36
        || bytes[8] != b'-'
        || bytes[13] != b'-'
        || bytes[18] != b'-'
        || bytes[23] != b'-'
    {
        return false;
    }
    let hex_at = |i: usize| matches!(bytes[i], b'0'..=b'9' | b'a'..=b'f');
    for i in (0..8)
        .chain(9..13)
        .chain(14..18)
        .chain(19..23)
        .chain(24..36)
    {
        if !hex_at(i) {
            return false;
        }
    }
    bytes[14] == b'7' && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

/// The closed operation binding frozen at acceptance (spec §5
/// `dolly.tool-operation-binding/v1`). Every accepted call stores one of
/// these; it is the complete identity the Host persists atomically with
/// `AUTHORIZED` and never resolves again after acceptance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolOperationBinding {
    /// Version discriminator: fixed `dolly.tool-operation-binding/v1`.
    pub schema: ToolOperationBindingSchemaTag,
    /// The Host-owned instance identity.
    pub instance_id: String,
    /// The authenticated Module owning this operation (REQ-TOOL-004 scope).
    pub module_id: String,
    /// The original invoke operation identity, unchanged across the lifecycle.
    pub operation_id: String,
    /// The caller's transaction grouping identity.
    pub tool_transaction_id: String,
    /// The Activation that authorized this call.
    pub activation_id: String,
    /// The activation lease generation the call was authorized under.
    pub activation_lease_generation: u64,
    /// The configuration revision that resolved this call.
    pub config_revision: u64,
    /// The tool server ID owning the selected tool.
    pub tool_server_id: String,
    /// The Dolly tool alias (stable configuration key).
    pub tool_name: String,
    /// Digest of the frozen input-schema document for the selected tool.
    pub tool_schema_digest: Sha256Digest,
    /// The caller-supplied arguments (the exact objects sent upstream).
    pub arguments: serde_json::Value,
    /// The tool's side-effect class (closed set).
    pub side_effect_class: SideEffectClass,
    /// The tool's closed idempotency policy.
    pub idempotency: IdempotencyPolicy,
    /// The accepted idempotency key, or null for policies without one.
    pub idempotency_key: Option<String>,
    /// The authorized dispatch deadline for this operation.
    pub authorized_deadline: String,
    /// Pre-resolution identity digest (REQ-TOOL-005).
    pub request_digest: Sha256Digest,
    /// The exactly selected, retained server generation.
    pub tool_server_generation: u64,
    /// The Host-assigned outbound request identity.
    pub server_request_id: String,
    /// The exact closed Server object from the retained registry revision.
    pub server_contract: CanonicalJsonObject,
    /// The confirmation decision (single-use approval ID when consumed).
    pub confirmation_decision: ConfirmationDecision,
}

impl ToolOperationBinding {
    /// The operation digest of this binding: `sha256(JCS(complete binding))`
    /// (spec §5). Recomputable at any time purely from the binding, which is
    /// what storage uses to verify every loaded row.
    pub fn operation_digest(&self) -> Sha256Digest {
        let (_, digest) = canonicalize(self).expect("closed binding is canonicalizable");
        digest
    }

    /// The idempotency argument pointer, or null for policy `none`
    /// (the stored `idempotency_argument_pointer` projection).
    pub fn idempotency_argument_pointer(&self) -> Option<&str> {
        match &self.idempotency {
            IdempotencyPolicy::ArgumentKey { argument_pointer } => Some(argument_pointer),
            IdempotencyPolicy::None => None,
        }
    }

    /// The consumed approval ID, or null when not required
    /// (the stored `confirmation_id` projection).
    pub fn confirmation_id(&self) -> Option<&str> {
        match &self.confirmation_decision {
            ConfirmationDecision::NotRequired => None,
            ConfirmationDecision::Approved(id) => Some(id),
        }
    }

    /// The exact outbound application payload for the built-in v1 MCP
    /// adapter (spec §5): the JCS encoding of the `tools/call` request built
    /// from the frozen binding. `None` if the retained server contract does
    /// not contain the tool entry (that is a corrupt binding).
    pub fn recompute_outbound_payload(&self) -> Option<CanonicalBytes> {
        let tools = match self.server_contract.get("tools")? {
            dolly_canonical_json::CanonicalJsonValue::Object(tools) => tools,
            _ => return None,
        };
        let tool_value = match tools.get(&self.tool_name)? {
            dolly_canonical_json::CanonicalJsonValue::Object(tool) => tool,
            _ => return None,
        };
        let upstream_name = match tool_value.get("upstream_name")? {
            dolly_canonical_json::CanonicalJsonValue::String(s) => s,
            _ => return None,
        };
        let arguments =
            dolly_canonical_json::CanonicalJsonValue::try_from(self.arguments.clone()).ok()?;
        let params = dolly_canonical_json::CanonicalJsonObject::try_from_iter(vec![
            (
                "name".to_owned(),
                dolly_canonical_json::CanonicalJsonValue::String(upstream_name.to_owned()),
            ),
            ("arguments".to_owned(), arguments),
        ])
        .expect("unique params keys");
        let payload = dolly_canonical_json::CanonicalJsonValue::Object(
            dolly_canonical_json::CanonicalJsonObject::try_from_iter(vec![
                (
                    "jsonrpc".to_owned(),
                    dolly_canonical_json::CanonicalJsonValue::String("2.0".to_owned()),
                ),
                (
                    "id".to_owned(),
                    dolly_canonical_json::CanonicalJsonValue::String(
                        self.server_request_id.clone(),
                    ),
                ),
                (
                    "method".to_owned(),
                    dolly_canonical_json::CanonicalJsonValue::String("tools/call".to_owned()),
                ),
                (
                    "params".to_owned(),
                    dolly_canonical_json::CanonicalJsonValue::Object(params),
                ),
            ])
            .expect("unique payload keys"),
        );
        let (bytes, _) = canonicalize(&payload).ok()?;
        Some(bytes)
    }

    /// The outbound digest (`sha256(payload)`) for the built-in adapter.
    pub fn recompute_outbound_digest(&self) -> Option<Sha256Digest> {
        self.recompute_outbound_payload()
            .map(|bytes| Sha256Digest::compute(bytes.as_ref()))
    }
    /// The installed package digest retained in the frozen server contract.
    pub fn recompute_package_digest(&self) -> Option<Sha256Digest> {
        let transport = match self.server_contract.get("transport")? {
            dolly_canonical_json::CanonicalJsonValue::Object(value) => value,
            _ => return None,
        };
        let package = match transport.get("package_digest")? {
            dolly_canonical_json::CanonicalJsonValue::String(value) => value,
            _ => return None,
        };
        package.parse().ok()
    }
}
/// Copy of the operation-binding wire tag; equality is by the fixed string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ToolOperationBindingSchemaTag;

impl Serialize for ToolOperationBindingSchemaTag {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(TOOL_OPERATION_BINDING_SCHEMA)
    }
}

impl<'de> Deserialize<'de> for ToolOperationBindingSchemaTag {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value == TOOL_OPERATION_BINDING_SCHEMA {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(format!(
                "expected {TOOL_OPERATION_BINDING_SCHEMA:?}, got {value:?}"
            )))
        }
    }
}

/// The durable Tool-call ledger row: the exact closed
/// `dolly.tool-call-ledger/v1` record. Serializing these bytes IS the
/// store's `record_jcs`; `record_digest` (the SHA-256 of those bytes) is
/// stored outside the document by the storage layer. The representation is
/// closed and explicitly versioned; any unknown member fails deserialization
/// rather than being silently dropped. Purely a snapshot: no method mutates
/// the row or re-dispatches.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCallLedgerRecord {
    /// Version discriminator: fixed `dolly.tool-call-ledger/v1`.
    pub schema: ToolCallLedgerRecordSchemaTag,
    /// The transition revision (1 for AUTHORIZED ... 3 for terminal).
    pub ledger_revision: u64,
    /// The durable ledger state.
    pub state: LedgerState,
    /// The complete closed operation binding frozen at acceptance.
    pub operation_binding: ToolOperationBinding,
    /// Digest of the complete binding (`sha256(JCS(binding))`, spec §5).
    pub operation_digest: Sha256Digest,
    /// Digest of the exact outbound application payload, present only once
    /// the dispatch boundary may be crossed.
    pub outbound_digest: Option<Sha256Digest>,
    /// The recorded terminal result, if any (SUCCEEDED/FAILED/UNKNOWN).
    pub terminal_result: Option<ToolResult>,
    /// `sha256(JCS(terminal_result))`, present exactly when a result is.
    pub terminal_result_digest: Option<Sha256Digest>,
}

/// Copies of the ledger record wire tag; equality is by the fixed string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ToolCallLedgerRecordSchemaTag;

impl Serialize for ToolCallLedgerRecordSchemaTag {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(TOOL_CALL_LEDGER_RECORD_SCHEMA)
    }
}

impl<'de> Deserialize<'de> for ToolCallLedgerRecordSchemaTag {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value == TOOL_CALL_LEDGER_RECORD_SCHEMA {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(format!(
                "expected {TOOL_CALL_LEDGER_RECORD_SCHEMA:?}, got {value:?}"
            )))
        }
    }
}

/// The failure detail produced by `ToolCallLedgerRecord::verify`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerRecordError(pub String);

impl std::fmt::Display for LedgerRecordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl ToolCallLedgerRecord {
    /// The canonical JCS bytes of this record plus their SHA-256
    /// (`record_jcs` / `record_digest` of the storage table).
    pub fn canonical_bytes_and_digest(
        &self,
    ) -> Result<(CanonicalBytes, Sha256Digest), LedgerRecordError> {
        canonicalize(self)
            .map_err(|e| LedgerRecordError(format!("record is not canonicalizable: {e}")))
    }

    /// The operation-digest recomputed from the embedded binding.
    pub fn recompute_operation_digest(&self) -> Sha256Digest {
        self.operation_binding.operation_digest()
    }

    /// The outbound digest recomputed from the embedded binding (None when
    /// the retained server contract is corrupt).
    pub fn recompute_outbound_digest(&self) -> Option<Sha256Digest> {
        self.operation_binding.recompute_outbound_digest()
    }

    /// The terminal-result digest recomputed from the embedded result.
    pub fn recompute_terminal_result_digest(&self) -> Option<Sha256Digest> {
        self.terminal_result.as_ref().map(|result| {
            canonicalize(result)
                .expect("terminal result is canonicalizable")
                .1
        })
    }

    /// Is this row terminal and immutable?
    pub fn is_terminal(&self) -> bool {
        self.state.is_terminal()
    }

    /// Validate the closed record against the schema's per-state `allOf`
    /// constraints plus internal digest consistency. Used by storage on every
    /// load so an impossible state/field combination is `STORAGE_CORRUPT`,
    /// never a reinterpreted row.
    pub fn verify_field_combination(&self) -> Result<(), LedgerRecordError> {
        if self.ledger_revision == 0 {
            return Err(LedgerRecordError("ledger_revision must be >= 1".into()));
        }
        // Internal digest consistency (spec §6/§11 INV-STORAGE-002).
        if self.operation_binding.operation_digest() != self.operation_digest {
            return Err(LedgerRecordError(
                "operation_digest does not equal sha256(JCS(operation_binding))".into(),
            ));
        }
        let recomputed_outbound = self.recompute_outbound_digest();
        let recomputed_terminal = self.recompute_terminal_result_digest();
        if self.outbound_digest.is_some() && recomputed_outbound.is_none() {
            return Err(LedgerRecordError(
                "outbound_digest present but the binding cannot reconstruct the payload".into(),
            ));
        }
        if let Some(stored) = &self.outbound_digest {
            if recomputed_outbound.as_ref() != Some(stored) {
                return Err(LedgerRecordError(
                    "outbound_digest does not equal sha256(adapter payload)".into(),
                ));
            }
        }
        match (&self.terminal_result, &self.terminal_result_digest) {
            (None, None) => {}
            (Some(result), Some(digest)) => {
                if recomputed_terminal.as_ref() != Some(digest) {
                    return Err(LedgerRecordError(
                        "terminal_result_digest does not equal sha256(JCS(terminal_result))".into(),
                    ));
                }
                let result_status = &result.status;
                let ok = match self.state {
                    LedgerState::Succeeded => {
                        *result_status == crate::result::ToolStatus::Succeeded
                    }
                    LedgerState::Failed => *result_status == crate::result::ToolStatus::Failed,
                    LedgerState::Unknown => *result_status == crate::result::ToolStatus::Unknown,
                    _ => false,
                };
                if !ok {
                    return Err(LedgerRecordError(format!(
                        "terminal_result status {:?} is inconsistent with state {}",
                        result_status,
                        self.state.wire_name()
                    )));
                }
            }
            _ => {
                return Err(LedgerRecordError(
                    "terminal_result and terminal_result_digest must be both present or both absent"
                        .into(),
                ));
            }
        }
        self.verify_state_constraints()
    }

    /// The schema `allOf` field constraints per state (the SQLite CHECK's
    /// authority).
    fn verify_state_constraints(&self) -> Result<(), LedgerRecordError> {
        let outbound = self.outbound_digest.is_some();
        let terminal = self.terminal_result_digest.is_some();
        let not_applied = self.terminal_result.as_ref().map(|r| {
            r.error
                .as_ref()
                .map(|e| e.code == ToolErrorCode::DispatchNotApplied)
                .unwrap_or(false)
        });
        match self.state {
            LedgerState::Authorized => {
                if self.ledger_revision != 1
                    || outbound
                    || terminal
                    || self.terminal_result.is_some()
                {
                    return Err(LedgerRecordError(
                        "AUTHORIZED requires ledger_revision 1, null outbound, and no terminal result"
                            .into(),
                    ));
                }
            }
            LedgerState::Dispatched => {
                if self.ledger_revision != 2 || !outbound || terminal {
                    return Err(LedgerRecordError(
                        "DISPATCHED requires ledger_revision 2, an outbound_digest, and no terminal result"
                            .into(),
                    ));
                }
            }
            LedgerState::Succeeded => {
                if self.ledger_revision != 3 || !outbound || !terminal {
                    return Err(LedgerRecordError(
                        "SUCCEEDED requires ledger_revision 3, an outbound_digest, and a succeeded terminal result"
                            .into(),
                    ));
                }
            }
            LedgerState::Failed => {
                let not_applied = not_applied.unwrap_or(false);
                let expected_revision = if not_applied { 2 } else { 3 };
                let expected_outbound = !not_applied;
                if self.ledger_revision != expected_revision
                    || outbound != expected_outbound
                    || !terminal
                {
                    return Err(LedgerRecordError(format!(
                        "FAILED({not_applied}) requires ledger_revision {expected_revision}, outbound={expected_outbound}, and a failed terminal result"
                    )));
                }
            }
            LedgerState::Unknown => {
                if self.ledger_revision != 3 || !outbound || !terminal {
                    return Err(LedgerRecordError(
                        "UNKNOWN requires ledger_revision 3, an outbound_digest, and an unknown terminal result"
                            .into(),
                    ));
                }
            }
        }
        Ok(())
    }
}

/// The verified facts a pure recovery decision reads from outside the closed
/// record (spec §6): the record's exact-generation availability, whether its
/// stored deadline has expired, and whether the exclusive send gate
/// establishes zero-byte proof. No other fact is consulted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecoveryFacts {
    /// Whether the exclusive transport gate proves zero bytes were eligible
    /// or sent (INV-STORAGE-017 zero-byte proof).
    pub zero_bytes_proved: bool,
    /// Whether the record's frozen generation is still `Ready` for the
    /// retained revision.
    pub exact_generation_ready: bool,
    /// Whether the record's authorized deadline has expired.
    pub deadline_expired: bool,
}

/// The recovery decision for a durable Tool-call row.
///
/// Every variant is terminal for the *decision*: none re-dispatches,
/// re-resolves, or re-authorizes the same identity. Re-authorization after
/// `not_applied` is a separately authorized fresh operation outside this
/// crate's boundary. `ProposeDispatch` is the only proposal that may later
/// cross the durable boundary, and only through the caller's successful
/// compare-and-set before any send permit (REQ-TOOL-006 / INV-STORAGE-017).
#[derive(Debug, Clone, PartialEq)]
pub enum DispatchDisposition {
    /// The row already records a terminal result; replay it verbatim.
    AlreadyTerminal { result: ToolResult },
    /// Propose `AUTHORIZED -> DISPATCHED` with the recomputed outbound
    /// digest. `allow_send_permit` is true only under authoritative zero-byte
    /// proof **and** a Ready exact generation **and** a live deadline; a send
    /// permit may be issued only after the caller's CAS commits.
    ProposeDispatch {
        outbound_digest: Sha256Digest,
        allow_send_permit: bool,
    },
    /// Authoritative zero-byte non-application: FAILED /
    /// TOOL_DISPATCH_NOT_APPLIED. The row identity and digests are kept.
    ProvedNotApplied { result: ToolResult },
    /// The durable dispatch boundary may have been crossed (DISPATCHED, or an
    /// AUTHORIZED row without zero-byte proof): UNKNOWN /
    /// TOOL_EXTERNAL_OUTCOME_UNKNOWN. Never relabeled failed.
    Unknown { result: ToolResult },
}

impl DispatchDisposition {
    /// Spec §6/REQ-TOOL-002: recovery never automatically redispatches the
    /// original operation, so this is always `0` for every disposition.
    pub fn automatic_redispatch_count(&self) -> u64 {
        0
    }

    /// REQ-TOOL-006 / TST-TOOL-006: a proved non-application never lets a
    /// replacement generation dispatch under this identity.
    pub fn automatic_replacement_generation_dispatch_count(&self) -> u64 {
        0
    }

    /// The emitted event name, if the disposition publishes one
    /// (TST-TOOL-001/002/010 emit `ToolOutcomeUnknown`; TST-TOOL-006 emits
    /// `ToolDispatchProvedNotApplied`; TST-TOOL-009 emits
    /// `ToolOperationDispatched` after a successful CAS — the pure decision
    /// reports the event only when a permit-eligible dispatch is proposed;
    /// AlreadyTerminal replays and emits nothing new).
    pub fn emitted_event(&self) -> Option<&'static str> {
        match self {
            DispatchDisposition::AlreadyTerminal { .. } => None,
            DispatchDisposition::ProposeDispatch {
                allow_send_permit: true,
                ..
            } => Some(EVENT_TOOL_OPERATION_DISPATCHED),
            DispatchDisposition::ProposeDispatch {
                allow_send_permit: false,
                ..
            } => None,
            DispatchDisposition::ProvedNotApplied { .. } => {
                Some(EVENT_TOOL_DISPATCH_PROVED_NOT_APPLIED)
            }
            DispatchDisposition::Unknown { .. } => Some(EVENT_TOOL_OUTCOME_UNKNOWN),
        }
    }

    /// The terminal result carried by the disposition.
    pub fn into_result(self) -> ToolResult {
        match self {
            DispatchDisposition::AlreadyTerminal { result }
            | DispatchDisposition::ProvedNotApplied { result }
            | DispatchDisposition::Unknown { result } => result,
            DispatchDisposition::ProposeDispatch { .. } => {
                panic!("ProposeDispatch carries no terminal result; CAS first")
            }
        }
    }
}

/// Recover a durable Tool-call row to its terminal disposition (spec §6).
///
/// The row is the closed ledger record; `facts` is the only outside input
/// (exact-generation availability, deadline state, zero-byte proof). This
/// function never consults a downstream result, error, ACK, or absence, and
/// has no backend/transport seam, so no downstream fact can become upstream
/// redispatch authority.
///
/// Decision table (exact spec §6):
///   - terminal row (result present)     → AlreadyTerminal (verbatim replay);
///   - `DISPATCHED`                      → Unknown (durable marker crossed, no
///                                          proof of non-application);
///   - `AUTHORIZED` + proof + Ready gen
///     + live deadline                   → ProposeDispatch with one send permit
///                                          after successful CAS (TST-TOOL-009);
///   - `AUTHORIZED` + proof + unusable
///     generation/deadline/resource      → ProvedNotApplied (TST-TOOL-006);
///   - `AUTHORIZED` without proof        → ProposeDispatch with no permit, then
///                                          UNKNOWN (ambiguity; the caller CASes
///                                          DISPATCHED without releasing a
///                                          permit, reruns this decision on the
///                                          new row and terminalizes UNKNOWN).
pub fn recover_operation(
    record: &ToolCallLedgerRecord,
    facts: &RecoveryFacts,
) -> DispatchDisposition {
    if let Some(result) = &record.terminal_result {
        return DispatchDisposition::AlreadyTerminal {
            result: result.clone(),
        };
    }
    match record.state {
        LedgerState::Dispatched => DispatchDisposition::Unknown {
            result: ToolResult::unknown_outcome(record.operation_binding.operation_id.clone()),
        },
        LedgerState::Authorized => {
            let outbound_digest = record
                .recompute_outbound_digest()
                .unwrap_or_else(|| Sha256Digest::compute(&[]));
            if facts.zero_bytes_proved {
                if facts.exact_generation_ready && !facts.deadline_expired {
                    DispatchDisposition::ProposeDispatch {
                        outbound_digest,
                        allow_send_permit: true,
                    }
                } else {
                    DispatchDisposition::ProvedNotApplied {
                        result: ToolResult::failed(
                            record.operation_binding.operation_id.clone(),
                            ToolErrorCode::DispatchNotApplied,
                            "durable zero-byte proof: no request byte was eligible or sent before the dispatch boundary",
                        ),
                    }
                }
            } else {
                DispatchDisposition::ProposeDispatch {
                    outbound_digest,
                    allow_send_permit: false,
                }
            }
        }
        // Terminal markers without a recorded result are inconsistent with a
        // closed record; recover conservatively to UNKNOWN rather than invent
        // a failed/not_applied fact that could read as authority.
        LedgerState::Succeeded | LedgerState::Failed | LedgerState::Unknown => {
            DispatchDisposition::Unknown {
                result: ToolResult::unknown_outcome(record.operation_binding.operation_id.clone()),
            }
        }
    }
}
