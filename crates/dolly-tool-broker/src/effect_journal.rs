//! Durable external-effect journal record and recovery evidence
//! (ADR 0009 capability effect-intent seam, v2).
//!
//! Definitions (first authoritative use, per repository instructions):
//! - **Claim** — the exact durable identity of one authorized attempt to
//!   apply an external effect, minted by the sole Rust Worker. A new attempt
//!   requires a new Claim; reuse of an existing Claim never re-dispatches.
//! - **External effect** — a client-observable change the Runtime Worker
//!   applies outside the authoritative database. v2 admits exactly the closed
//!   [`EffectClass`] set below: an MCP tools/call frame or the versioned
//!   initialize/initialized startup handshake.
//! - **Effect journal** — the record set here plus its SQLite storage slice:
//!   the durable premise the Worker (producer) writes before any external
//!   effect, and that recovery (consumer) reads only. An
//!   [`ExternalEffectJournalRecord`] in state `INTENDED` may be settled
//!   `APPLIED` or `NOT_APPLIED` only by deterministic provider-specific
//!   evidence whose identity matches the same Claim and generation;
//!   everything else settles `UNKNOWN_OUTCOME` and never redispatches.
//!
//! The producer → explicit durable versioned premise → consumer direction is
//! preserved: the Worker writes the premise, recovery reads it. No downstream
//! ACK, response, cache, readiness, process exit, or stale authority mints or
//! repairs authority. The closed record serialization IS the store's
//! `record_jcs`; a missing, wrong, or unknown member is corruption.

use dolly_canonical_json::{CanonicalBytes, Sha256Digest, canonicalize};
use serde::{Deserialize, Serialize};

use crate::dispatch::ToolCallLedgerRecord;
use crate::result::ToolErrorCode;

/// The wire discriminator of the durable external-effect journal record.
pub const EFFECT_JOURNAL_RECORD_SCHEMA: &str = "dolly.external-effect-journal/v2";
/// The wire discriminator of the embedded Claim record.
pub const CLAIM_RECORD_SCHEMA: &str = "dolly.claim/v2";
/// Schema version of the journal record format. Recovery fails closed on any
/// version mismatch (a later journal schema upgrade must keep this constant).
pub const EFFECT_JOURNAL_SCHEMA_VERSION: u64 = 2;

/// The external-effect classes the journal records (v2 closed set). Every
/// journal row binds its exact effect class.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EffectClass {
    /// Writing one JSON-RPC `tools/call` frame to the installed MCP
    /// server's stdio.
    McpToolsCall,
    /// The versioned MCP startup initialize/initialized child-I/O lifecycle.
    /// This is a non-effect premise: it is journaled so startup never performs
    /// unrecorded child I/O and recovery can only settle it, never replay it.
    #[serde(rename = "MCP_INITIALIZE_HANDSHAKE_V1")]
    McpInitializeHandshake,
}

impl EffectClass {
    /// The wire spelling used by the SQLite `effect_class` column and the
    /// vector assertions.
    pub fn wire_name(self) -> &'static str {
        match self {
            EffectClass::McpToolsCall => "MCP_TOOLS_CALL",
            EffectClass::McpInitializeHandshake => "MCP_INITIALIZE_HANDSHAKE_V1",
        }
    }

    /// Parse a wire spelling back into a closed value.
    pub fn from_wire(spelling: &str) -> Option<Self> {
        match spelling {
            "MCP_TOOLS_CALL" => Some(EffectClass::McpToolsCall),
            "MCP_INITIALIZE_HANDSHAKE_V1" => Some(EffectClass::McpInitializeHandshake),
            _ => None,
        }
    }
}

/// Durable external-effect journal states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EffectJournalState {
    /// The effect intent is durably recorded; outcome unknown.
    Intended,
    /// Settled by identity-matching deterministic provider evidence: the raw
    /// external effect was applied.
    Applied,
    /// Settled by identity-matching deterministic provider evidence: the raw
    /// external effect provably was not applied
    /// (`TOOL_DISPATCH_NOT_APPLIED`).
    NotApplied,
    /// Ambiguous: the effect may have applied. Terminal; never redispatches.
    UnknownOutcome,
}

impl EffectJournalState {
    /// The wire spelling used by the SQLite `state` column and assertions.
    pub fn wire_name(self) -> &'static str {
        match self {
            EffectJournalState::Intended => "INTENDED",
            EffectJournalState::Applied => "APPLIED",
            EffectJournalState::NotApplied => "NOT_APPLIED",
            EffectJournalState::UnknownOutcome => "UNKNOWN_OUTCOME",
        }
    }

    /// The journal revision mandated for this state: 1 for `INTENDED`, 2 for
    /// every settled state (the schema CHECK's authority).
    pub fn default_journal_revision(self) -> u64 {
        match self {
            EffectJournalState::Intended => 1,
            EffectJournalState::Applied
            | EffectJournalState::NotApplied
            | EffectJournalState::UnknownOutcome => 2,
        }
    }

    /// Parse a wire spelling back into a closed state; unknown is `None`.
    pub fn from_wire(spelling: &str) -> Option<Self> {
        Some(match spelling {
            "INTENDED" => EffectJournalState::Intended,
            "APPLIED" => EffectJournalState::Applied,
            "NOT_APPLIED" => EffectJournalState::NotApplied,
            "UNKNOWN_OUTCOME" => EffectJournalState::UnknownOutcome,
            _ => return None,
        })
    }

    /// Whether this state is terminal (settled) and immutable.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            EffectJournalState::Applied
                | EffectJournalState::NotApplied
                | EffectJournalState::UnknownOutcome
        )
    }
}

/// Closed wire tag of the Claim record; equality by the fixed string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ClaimRecordSchemaTag;

impl Serialize for ClaimRecordSchemaTag {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(CLAIM_RECORD_SCHEMA)
    }
}

impl<'de> Deserialize<'de> for ClaimRecordSchemaTag {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value == CLAIM_RECORD_SCHEMA {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(format!(
                "expected {CLAIM_RECORD_SCHEMA:?}, got {value:?}"
            )))
        }
    }
}

/// Exact durable identity of one authorized attempt to apply an external
/// effect. It composes the operation identity with the attempt's authority
/// context so different attempts always differ while the same attempt
/// re-resolves identically.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Claim {
    /// Wire discriminator: fixed `dolly.claim/v2`.
    pub schema: ClaimRecordSchemaTag,
    /// The Host instance identity.
    pub instance_id: String,
    /// The Worker extension alias (Module identity) owning this attempt.
    pub module_id: String,
    /// The original tool operation identity.
    pub operation_id: String,
    /// Digest of the complete frozen operation binding.
    pub operation_digest: Sha256Digest,
    /// Deterministic token of the exact attempt.
    pub claim_token: Sha256Digest,
}

/// Deterministically derive the token of the attempt from its full context
/// (operation identity + operation digest + crash-safe authority/package/
/// policy/effect context).
///
/// A new attempt under a changed context yields a new Claim; resetting
/// nothing and re-deriving the same context reproduces the same Claim, which
/// re-dispatch must reject (new attempt requires a new Claim).
#[allow(clippy::too_many_arguments)]
pub fn derive_claim_token(
    instance_id: &str,
    module_id: &str,
    operation_id: &str,
    operation_digest: &Sha256Digest,
    controller_generation: u64,
    extension_generation: u64,
    worker_epoch: &str,
    package_digest: &Sha256Digest,
    policy_premise_digest: &Sha256Digest,
    effect_class: EffectClass,
) -> Sha256Digest {
    let context = serde_json::json!({
        "schema": CLAIM_RECORD_SCHEMA,
        "instance_id": instance_id,
        "module_id": module_id,
        "operation_id": operation_id,
        "operation_digest": operation_digest,
        "controller_generation": controller_generation,
        "extension_generation": extension_generation,
        "worker_epoch": worker_epoch,
        "package_digest": package_digest,
        "policy_premise_digest": policy_premise_digest,
        "effect_class": effect_class,
    });
    let (bytes, _) = canonicalize(&context).expect("claim context is canonicalizable");
    Sha256Digest::compute(bytes.as_ref())
}
/// A row stores only identities and digests; it never stores arguments,
/// response payloads, or credentials. The intent digest is the digest of the
/// item the Worker intends to apply (v2: the exact request frame bytes or the
/// versioned handshake evidence); the evidence digest (present only on
/// `APPLIED`/`NOT_APPLIED`) is the digest of the deterministic
/// provider-specific evidence that settled the row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalEffectJournalRecord {
    /// Version discriminator: the fixed record schema tag.
    pub schema: EffectJournalRecordSchemaTag,
    /// The transition revision (1 for `INTENDED` ... 2 for settled).
    pub journal_revision: u64,
    /// The durable journal state.
    pub state: EffectJournalState,
    /// The exact Claim this record is bound to.
    pub claim: Claim,
    /// The Runtime Authority / controller generation bound at intent time
    /// (never resolved again).
    pub controller_generation: u64,
    /// The process generation (extension generation) bound at intent time.
    pub extension_generation: u64,
    /// The Worker epoch bound at intent time (completes the exact
    /// process-generation identity).
    pub worker_epoch: String,
    /// Installed package premise (digest of the installed package).
    pub package_digest: Sha256Digest,
    /// Installed policy premise (digest of the admitted policy document).
    pub policy_premise_digest: Sha256Digest,
    /// Operation identity: digest of the closed operation binding.
    pub operation_digest: Sha256Digest,
    /// The exact effect class.
    pub effect_class: EffectClass,
    /// Digest of the intended external effect.
    pub intent_digest: Sha256Digest,
    /// Digest of the deterministic provider-specific evidence that settled
    /// the row; present exactly on `APPLIED`/`NOT_APPLIED`.
    pub evidence_digest: Option<Sha256Digest>,
}

/// Closed wire tag of the effect journal record; fixed by the schema tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct EffectJournalRecordSchemaTag;

impl Serialize for EffectJournalRecordSchemaTag {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(EFFECT_JOURNAL_RECORD_SCHEMA)
    }
}

impl<'de> Deserialize<'de> for EffectJournalRecordSchemaTag {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value == EFFECT_JOURNAL_RECORD_SCHEMA {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(format!(
                "expected {EFFECT_JOURNAL_RECORD_SCHEMA:?}, got {value:?}"
            )))
        }
    }
}

/// The failure detail produced by [`ExternalEffectJournalRecord::verify`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectJournalRecordError(pub String);

impl std::fmt::Display for EffectJournalRecordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl ExternalEffectJournalRecord {
    /// The canonical JCS bytes of this record plus their digest
    /// (`record_jcs` / `record_digest` of the storage table).
    pub fn canonical_bytes_and_digest(
        &self,
    ) -> Result<(CanonicalBytes, Sha256Digest), EffectJournalRecordError> {
        canonicalize(self)
            .map_err(|e| EffectJournalRecordError(format!("record is not canonicalizable: {e}")))
    }

    /// The context digest the stored `claim_token` must equal.
    pub fn recompute_claim_token(&self) -> Sha256Digest {
        derive_claim_token(
            &self.claim.instance_id,
            &self.claim.module_id,
            &self.claim.operation_id,
            &self.operation_digest,
            self.controller_generation,
            self.extension_generation,
            &self.worker_epoch,
            &self.package_digest,
            &self.policy_premise_digest,
            self.effect_class,
        )
    }

    /// Validate the record against the closed state-machine constraints plus
    /// the exact claim token and operation binding. Any invalid combination is
    /// corruption, never a reinterpretation.
    pub fn verify(&self) -> Result<(), EffectJournalRecordError> {
        if self.journal_revision == 0 {
            return Err(EffectJournalRecordError(
                "journal_revision must be >= 1".into(),
            ));
        }
        if self.claim.operation_digest != self.operation_digest {
            return Err(EffectJournalRecordError(
                "Claim operation_digest does not match the journal operation_digest".into(),
            ));
        }
        if self.recompute_claim_token() != self.claim.claim_token {
            return Err(EffectJournalRecordError(
                "claim_token does not match the frozen record context".into(),
            ));
        }
        match self.state {
            EffectJournalState::Intended => {
                if self.journal_revision != 1 || self.evidence_digest.is_some() {
                    return Err(EffectJournalRecordError(
                        "INTENDED requires journal_revision 1 and null evidence".into(),
                    ));
                }
            }
            EffectJournalState::Applied | EffectJournalState::NotApplied => {
                if self.journal_revision != 2 || self.evidence_digest.is_none() {
                    return Err(EffectJournalRecordError(
                        "APPLIED/NOT_APPLIED require journal_revision 2 and evidence".into(),
                    ));
                }
            }
            EffectJournalState::UnknownOutcome => {
                if self.journal_revision != 2 || self.evidence_digest.is_some() {
                    return Err(EffectJournalRecordError(
                        "UNKNOWN_OUTCOME requires journal_revision 2 and null evidence".into(),
                    ));
                }
            }
        }
        Ok(())
    }
}

/// The deterministic settlement for one pending `INTENDED` journal row.
///
/// Every variant is terminal for the decision: none re-dispatches,
/// re-authorizes, or repeats the same identity. A repeat is a separately
/// minted fresh Claim outside this record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EffectSettlement {
    /// Deterministic provider evidence proved the external effect applied
    /// (authoritative ledger terminal `SUCCEEDED`).
    Applied { evidence_digest: Sha256Digest },
    /// Deterministic provider evidence proved the external effect did NOT
    /// apply (authoritative ledger terminal `FAILED` +
    /// `TOOL_DISPATCH_NOT_APPLIED`).
    NotApplied { evidence_digest: Sha256Digest },
    /// Ambiguous or evidence absent: outcome unknown. Never re-dispatched.
    UnknownOutcome,
}

/// Recover one pending `INTENDED` journal row to its terminal settlement.
///
/// `ledger` is the authoritative Tool-call ledger record of the exact same
/// operation — the only deterministic provider-specific evidence admitted by
/// v2. The operation identity must match the exact Claim, and the recorded
/// `intent_digest` must equal the ledger's dispatched `outbound_digest`;
/// absence, ACK, response, cache, readiness, process exit, or stale authority
/// never settles `APPLIED`/`NOT_APPLIED`.
pub fn recover_effect_journal(
    record: &ExternalEffectJournalRecord,
    ledger: Option<&ToolCallLedgerRecord>,
) -> EffectSettlement {
    if record.state != EffectJournalState::Intended
        || record.effect_class != EffectClass::McpToolsCall
    {
        return EffectSettlement::UnknownOutcome;
    }
    let Some(ledger) = ledger else {
        return EffectSettlement::UnknownOutcome;
    };
    let binding = &ledger.operation_binding;
    // Evidence identity must match the same Claim and generation: operation
    // identity must match exactly (instance/module/operation and digest), and
    // the retained package and exact outbound payload must be the same frozen
    // premise. A terminal ledger row from another Claim is not evidence.
    if binding.instance_id != record.claim.instance_id
        || binding.module_id != record.claim.module_id
        || binding.operation_id != record.claim.operation_id
        || ledger.operation_digest != record.operation_digest
        || binding.recompute_package_digest().as_ref() != Some(&record.package_digest)
        || binding.recompute_outbound_digest().as_ref() != Some(&record.intent_digest)
    {
        return EffectSettlement::UnknownOutcome;
    }
    let terminal_evidence_digest = || -> Option<Sha256Digest> {
        ledger
            .terminal_result_digest
            .clone()
            .or_else(|| ledger.recompute_terminal_result_digest())
    };
    match ledger.state {
        crate::dispatch::LedgerState::Succeeded => {
            // The exact effect identity must match the dispatched outbound
            // digest before APPLIED may be settled.
            if ledger.outbound_digest.as_ref() != Some(&record.intent_digest) {
                return EffectSettlement::UnknownOutcome;
            }
            match terminal_evidence_digest() {
                Some(evidence_digest) => EffectSettlement::Applied { evidence_digest },
                None => EffectSettlement::UnknownOutcome,
            }
        }
        crate::dispatch::LedgerState::Failed => {
            // `TOOL_DISPATCH_NOT_APPLIED` is zero-byte proof: the exact effect
            // did not happen. The exact frozen outbound payload was still
            // reconstructed above, even though the ledger stores no outbound
            // digest for this pre-dispatch failure.
            let not_applied = ledger
                .terminal_result
                .as_ref()
                .and_then(|result| result.error.as_ref())
                .map(|error| error.code == ToolErrorCode::DispatchNotApplied)
                .unwrap_or(false);
            if not_applied {
                match terminal_evidence_digest() {
                    Some(evidence_digest) => EffectSettlement::NotApplied { evidence_digest },
                    None => EffectSettlement::UnknownOutcome,
                }
            } else {
                // A failure with any other code leaves effect-application
                // ambiguous (the tool may have partially or fully run).
                EffectSettlement::UnknownOutcome
            }
        }
        _ => EffectSettlement::UnknownOutcome,
    }
}
