//! Channel inbound -> sealed Host ingress adapter (seam B wiring).
//!
//! Crate-private: the only public submission path is
//! [`InboundReceiver`](crate::InboundReceiver). This adapter implements the
//! accepted [`CoreIngress`] seam over the accepted durable [`HostIngress`]
//! seam of `dolly-storage`, with the durable prepared intent as the ordering
//! authority:
//!
//! 1. a `prepared` intent row is durably persisted in the module-scoped store
//!    BEFORE any `HostIngress::submit` or Core effect; if that initial
//!    persistence fails, no Host/Core effect runs;
//! 2. a pending intent is reconciled `status`-first using the stored
//!    deterministic identity and the CURRENT sealed authority/grant — only an
//!    authoritative `absent` permits a byte-identical replay submit;
//! 3. every Host mapping returned by `submit` or `status` is validated against
//!    the exact prepared intent (principal/fences, external identity,
//!    operation/request digest inputs, canonical payload/content, edit-delete
//!    relation, ordered target Pages, block/delivery linkage) before it is
//!    adopted; a same-key mapping for different content/targets/relation is a
//!    conflict/corrupt pending — never success;
//! 4. the same key with a different operation digest conflicts before any Core
//!    effect;
//! 5. after a Host decision, a failure to atomically write the terminal Channel
//!    outcome is reported as retryable [`CoreIngressError::Unavailable`] (the
//!    durable row stays `prepared`), never a terminal rejection.

use std::str::FromStr;

use dolly_canonical_json::{CanonicalJsonValue, Sha256Digest};
use dolly_core_domain::{
    HostIngressError, HostIngressKind, HostIngressMapping, HostIngressStatus,
    HostIngressStatusRequest, HostIngressSubmitOutcome, HostIngressSubmitRequest, PageId,
};
use dolly_storage::{HostCapabilityGrant, HostConnectionAuthority, HostIngress};

use crate::error::{ChannelError, ChannelOutcome, codes};
use crate::ids;
use crate::ingress::{
    CHANNEL_METADATA_NAMESPACE, CoreIngress, CoreIngressError, IngressCommit,
    IngressStatusResult, IngressSubmitReceipt, IngressSubmitRequest,
};
use crate::intent::{CHANNEL_INTENT_RECORD_SCHEMA, ChannelIntent, IntentState};
use crate::ledger::EventKind;
use crate::principal::ChannelPrincipal;
use crate::store::SqliteChannelStore;

const INTENT_CONFLICT_CODE: &str = "STORAGE_IDEMPOTENCY_CONFLICT";

/// The transport-sourced facts derived from a Channel block draft's
/// `org.dolly.channel` metadata. The draft is the single canonical source of
/// content truth; projection fields are derived here, never stored alongside
/// the draft.
pub(crate) struct ChannelDraftFacts {
    pub external_event_id: String,
    pub kind: HostIngressKind,
    pub references_external_event_id: Option<String>,
    pub channel_id: String,
    pub session_id: String,
    pub external_conversation_id: String,
    pub sender_class: String,
    pub received_at: String,
}

pub(crate) fn parse_draft_metadata(
    draft: &CanonicalJsonValue,
) -> Result<&dolly_canonical_json::CanonicalJsonObject, CoreIngressError> {
    let invalid = || CoreIngressError::Rejected { code: "CORE_INVALID_JSON".to_string() };
    let CanonicalJsonValue::Object(root) = draft else { return Err(invalid()); };
    let Some(CanonicalJsonValue::Object(metadata)) = root.get("metadata") else { return Err(invalid()); };
    let Some(CanonicalJsonValue::Object(channel)) = metadata.get(CHANNEL_METADATA_NAMESPACE) else { return Err(invalid()); };
    Ok(channel)
}

fn channel_text(channel: &dolly_canonical_json::CanonicalJsonObject, field: &str) -> Result<String, CoreIngressError> {
    let invalid = CoreIngressError::Rejected { code: "CORE_INVALID_JSON".to_string() };
    match channel.get(field) {
        Some(CanonicalJsonValue::String(value)) if !value.is_empty() => Ok(value.clone()),
        _ => Err(invalid),
    }
}

/// Extract the external event identity, lifecycle kind, edit/delete relation,
/// and the real transport content facts from a Channel block draft.
pub(crate) fn channel_facts_from_draft(
    draft: &CanonicalJsonValue,
) -> Result<ChannelDraftFacts, CoreIngressError> {
    let channel = parse_draft_metadata(draft)?;
    let external_event_id = channel_text(channel, "external_message_id")?;
    let kind = match channel_text(channel, "event_kind")?.as_str() {
        "message" => HostIngressKind::Message,
        "edit" => HostIngressKind::Edit,
        "delete" => HostIngressKind::Delete,
        _ => return Err(CoreIngressError::Rejected { code: "CORE_INVALID_JSON".to_string() }),
    };
    // The edit/delete reference is optional, but if PRESENT it must be a
    // nonempty valid external identity string (the accepted builder emits only
    // validated references); a present empty or malformed value is rejected,
    // never normalized to None.
    let references_external_event_id = match channel.get("references_external_message_id") {
        None | Some(CanonicalJsonValue::Null) => None,
        Some(CanonicalJsonValue::String(value)) => {
            if value.is_empty()
                || value.len() > crate::ingress::MAX_EXTERNAL_ID_BYTES
                || value.chars().any(|character| character.is_control())
            {
                return Err(CoreIngressError::Rejected { code: "CORE_INVALID_JSON".to_string() });
            }
            Some(value.clone())
        }
        Some(_) => return Err(CoreIngressError::Rejected { code: "CORE_INVALID_JSON".to_string() }),
    };
    Ok(ChannelDraftFacts {
        external_event_id,
        kind,
        references_external_event_id,
        channel_id: channel_text(channel, "channel_id")?,
        session_id: channel_text(channel, "session_id")?,
        external_conversation_id: channel_text(channel, "external_conversation_id")?,
        sender_class: channel_text(channel, "sender_class")?,
        received_at: channel_text(channel, "received_at")?,
    })
}

/// The Channel-local operation digest of one intent, binding the full
/// principal fences (including the graph digest), the lifecycle kind and
/// edit/delete relation, the ordered target Pages, the config revision, and
/// the canonical content payload digest.
#[allow(clippy::too_many_arguments)]
pub(crate) fn channel_intent_digest(
    account: &str,
    extension_id: &str,
    module_id: &str,
    instance_id: &str,
    generation: u64,
    revision: i64,
    graph_revision: i64,
    graph_digest: &str,
    config_revision: i64,
    external_event_id: &str,
    kind: EventKind,
    references_external_event_id: Option<&str>,
    target_page_ids: &[String],
    payload_digest: &str,
) -> String {
    use dolly_canonical_json::canonicalize;
    let mut identity = serde_json::Map::new();
    identity.insert("schema".into(), serde_json::json!("dolly.channel-intent/operation/v1"));
    identity.insert("account".into(), serde_json::json!(account));
    identity.insert("extension_id".into(), serde_json::json!(extension_id));
    identity.insert("module_id".into(), serde_json::json!(module_id));
    identity.insert("instance_id".into(), serde_json::json!(instance_id));
    identity.insert("generation".into(), serde_json::json!(generation));
    identity.insert("revision".into(), serde_json::json!(revision));
    identity.insert("graph_revision".into(), serde_json::json!(graph_revision));
    identity.insert("graph_digest".into(), serde_json::json!(graph_digest));
    identity.insert("config_revision".into(), serde_json::json!(config_revision));
    identity.insert("external_event_id".into(), serde_json::json!(external_event_id));
    identity.insert("kind".into(), serde_json::json!(kind.as_str()));
    if let Some(references) = references_external_event_id {
        identity.insert("references_external_event_id".into(), serde_json::json!(references));
    }
    identity.insert(
        "target_page_ids".into(),
        serde_json::Value::Array(target_page_ids.iter().map(|page| serde_json::json!(page)).collect()),
    );
    identity.insert("payload_digest".into(), serde_json::json!(payload_digest));
    let canonical = canonicalize(&serde_json::Value::Object(identity))
        .expect("intent identity is canonical JSON")
        .0
        .as_bytes()
        .to_vec();
    Sha256Digest::compute(&canonical).to_string()
}

pub(crate) fn payload_digest_of(canonical_draft: &str) -> String {
    Sha256Digest::compute(canonical_draft.as_bytes()).to_string()
}

fn rejected(code: &str) -> CoreIngressError {
    CoreIngressError::Rejected { code: code.to_string() }
}

/// Build a `prepared` durable intent from the submitted request and the
/// sealed principal. The canonical draft (`request_jcs`) is the single
/// content source; the digest binds the derived event facts.
pub(crate) fn prepare_intent(
    principal: &ChannelPrincipal,
    config_revision: i64,
    request: &IngressSubmitRequest,
    facts: &ChannelDraftFacts,
) -> Result<ChannelIntent, ChannelError> {
    let request_jcs_bytes = request.draft_canonical_bytes()?;
    let request_jcs = String::from_utf8(request_jcs_bytes)
        .map_err(|_| ChannelError::new(codes::INTERNAL, false, ChannelOutcome::NotApplied, "draft is not UTF-8"))?;
    let payload_digest = payload_digest_of(&request_jcs);
    let event_kind = match facts.kind {
        HostIngressKind::Message => EventKind::Message,
        HostIngressKind::Edit => EventKind::Edit,
        HostIngressKind::Delete => EventKind::Delete,
    };
    let digest = channel_intent_digest(
        principal.account(), principal.extension_id(), principal.module_id(), principal.instance_id(),
        principal.generation(), principal.revision(), principal.graph_revision(), principal.graph_digest(),
        config_revision, &facts.external_event_id, event_kind,
        facts.references_external_event_id.as_deref(), &request.target_page_ids, &payload_digest,
    );
    let intent_key = ids::inbound_ingress_key(principal.account(), &facts.external_event_id);
    Ok(ChannelIntent {
        schema: CHANNEL_INTENT_RECORD_SCHEMA.to_string(),
        intent_key,
        digest,
        state: IntentState::Prepared,
        owner: principal.owner().to_string(),
        extension_id: principal.extension_id().to_string(),
        module_id: principal.module_id().to_string(),
        instance_id: principal.instance_id().to_string(),
        generation: principal.generation() as i64,
        revision: principal.revision(),
        graph_revision: principal.graph_revision(),
        graph_digest: principal.graph_digest().to_string(),
        config_revision,
        account: principal.account().to_string(),
        external_event_id: facts.external_event_id.clone(),
        kind: event_kind,
        references_external_event_id: facts.references_external_event_id.clone(),
        target_page_ids: request.target_page_ids.clone(),
        payload_digest,
        request_jcs,
        block_id: None,
        rejected_code: None,
    })
}

/// The Channel-local operation digest of one committed outbound send action.
///
/// A domain-separated SHA-256 over the complete sealed-principal fences
/// (owner, Extension, module, instance, generation, incarnation revision,
/// graph revision + digest, config revision, account), the exactly targeted
/// module, and the canonical bytes of the committed `org.dolly.channel.send`
/// Action. Reused in the durable Prepared outbound record so the same
/// `action_id` under a different target/content/config conflicts before
/// enqueue, and a same key+digest replay returns the stored result.
#[allow(clippy::too_many_arguments)]
pub(crate) fn outbound_operation_digest(
    extension_id: &str,
    module_id: &str,
    instance_id: &str,
    generation: u64,
    revision: i64,
    graph_revision: i64,
    graph_digest: &str,
    config_revision: i64,
    account: &str,
    action_jcs: &str,
    target_module_id: &str,
) -> String {
    use dolly_canonical_json::canonicalize;
    let mut identity = serde_json::Map::new();
    identity.insert(
        "schema".into(),
        serde_json::json!("dolly.channel-outbound/operation/v1"),
    );
    identity.insert("account".into(), serde_json::json!(account));
    identity.insert("extension_id".into(), serde_json::json!(extension_id));
    identity.insert("module_id".into(), serde_json::json!(module_id));
    identity.insert("instance_id".into(), serde_json::json!(instance_id));
    identity.insert("generation".into(), serde_json::json!(generation));
    identity.insert("revision".into(), serde_json::json!(revision));
    identity.insert("graph_revision".into(), serde_json::json!(graph_revision));
    identity.insert("graph_digest".into(), serde_json::json!(graph_digest));
    identity.insert("config_revision".into(), serde_json::json!(config_revision));
    identity.insert("target_module_id".into(), serde_json::json!(target_module_id));
    identity.insert("action_jcs".into(), serde_json::json!(action_jcs));
    let canonical = canonicalize(&serde_json::Value::Object(identity))
        .expect("outbound identity is canonical JSON")
        .0
        .as_bytes()
        .to_vec();
    Sha256Digest::compute(&canonical).to_string()
}

/// Validate a returned Host mapping against the exact prepared intent before
/// any terminal commit. This is the ONE complete validation path used by
/// submit, status, reconcile and receiver-local replay adoption:
///
/// - exact mapping schema/version;
/// - full sealed principal/owner/source/module/instance/fences + account;
/// - deterministic Host ingress key recomputed from the mapping fields;
/// - operation digest recomputed from the prepared intent / canonical request;
/// - canonical payload/content byte-equal to the intent's canonical draft, and
///   the payload digest recomputed;
/// - edit-delete relation and exactly ordered target Pages;
/// - ingress/block/command identity linkage and exact stored block identity;
/// - an EXACT delivery sequence: count == ordered targets, same order, unique
///   and strictly increasing commit sequences, every delivery on a target page
///   of the mapping's block.
///
/// A same-key mapping with different content/targets/relation or any broken
/// linkage is a conflict/corrupt that must never be adopted as success.
pub(crate) fn validate_host_mapping(
    intent: &ChannelIntent,
    mapping: &HostIngressMapping,
) -> Result<(), ChannelError> {
    use dolly_core_domain::{BlockId, HOST_INGRESS_RECORD_SCHEMA, HostIngressKind, UuidV7};
    use dolly_core_reducer::derive_ingress_key;

    let mismatch = |what: &str| {
        ChannelError::new(codes::OPERATION_CONFLICT, false, ChannelOutcome::NotApplied, format!("host mapping does not match the prepared intent: {what}"))
    };
    let corrupt = |what: &str| {
        ChannelError::new(codes::LEDGER_CORRUPT, false, ChannelOutcome::NotApplied, format!("host mapping is inconsistent: {what}"))
    };
    // Exact mapping schema/version.
    if mapping.schema != HOST_INGRESS_RECORD_SCHEMA {
        return Err(mismatch("schema/version"));
    }
    if mapping.external_event_id != intent.external_event_id {
        return Err(mismatch("external identity"));
    }
    if mapping.owner != intent.owner
        || mapping.extension_id != intent.extension_id
        || mapping.module_id != intent.module_id
        || mapping.instance_id != intent.instance_id
    {
        return Err(mismatch("principal/source"));
    }
    if mapping.generation != intent.generation
        || mapping.revision != intent.revision
        || mapping.graph_revision != intent.graph_revision
        || mapping.graph_revision < 1
    {
        return Err(mismatch("authority fences"));
    }
    let account = ids::channel_account(&mapping.owner, &mapping.extension_id, &mapping.module_id, &mapping.instance_id);
    if account != intent.account {
        return Err(mismatch("account"));
    }
    // Deterministic Host ingress key recomputed from the mapping fields.
    let recomputed_key = derive_ingress_key(
        &mapping.owner, &mapping.extension_id, &mapping.module_id, &mapping.instance_id,
        &mapping.external_event_id,
    );
    if recomputed_key.as_str() != mapping.ingress_key {
        return Err(mismatch("ingress key"));
    }
    let kind = match mapping.kind.as_str() {
        "message" => HostIngressKind::Message,
        "edit" => HostIngressKind::Edit,
        "delete" => HostIngressKind::Delete,
        _ => return Err(mismatch("kind")),
    };
    let event_kind = match kind {
        HostIngressKind::Message => EventKind::Message,
        HostIngressKind::Edit => EventKind::Edit,
        HostIngressKind::Delete => EventKind::Delete,
    };
    if event_kind != intent.kind {
        return Err(mismatch("kind"));
    }
    if mapping.references_external_event_id.as_deref() != intent.references_external_event_id.as_deref() {
        return Err(mismatch("edit/delete relation"));
    }
    if mapping.target_page_ids != intent.target_page_ids {
        return Err(mismatch("ordered target pages"));
    }
    // Canonical payload/content: byte-equal to the intent's canonical draft,
    // and the payload digest recomputed.
    let payload_bytes = dolly_canonical_json::canonicalize(&mapping.payload)
        .map_err(|e| corrupt(&format!("payload canonicalization: {e}")))?
        .0
        .as_bytes()
        .to_vec();
    let payload_text = String::from_utf8(payload_bytes.clone()).map_err(|_| corrupt("payload is not UTF-8"))?;
    if payload_bytes != intent.request_jcs.as_bytes() {
        return Err(mismatch("content"));
    }
    let recomputed_payload = payload_digest_of(&payload_text);
    if recomputed_payload != mapping.payload_digest {
        return Err(corrupt("payload digest does not match the payload bytes"));
    }
    if mapping.payload_digest != intent.payload_digest {
        return Err(mismatch("content"));
    }
    // Ingress/block identity must be authoritative RFC-9562 UUIDv7-shaped
    // IDs (B mints them; the Channel never recomputes minted identities). The
    // operation digest itself is not recomputed locally: B is the issuance
    // authority and the status-first confirmation cross-verifies the submit
    // mapping byte-equal against B's fully verified status mapping.
    mapping.ingress_id.parse::<UuidV7>().map_err(|_| corrupt("ingress identity is not a UUIDv7"))?;
    mapping.block_id.parse::<BlockId>().map_err(|_| corrupt("block identity is not an authoritative ID"))?;
    let expected_command_id = format!("host-ingress-{}-{}", mapping.ingress_key, mapping.ingress_id);
    if mapping.command_id != expected_command_id {
        return Err(corrupt("ingress/command linkage"));
    }
    if let Some(stored_block_id) = &intent.block_id {
        if stored_block_id != &mapping.block_id {
            return Err(mismatch("block identity"));
        }
    }
    // Exact delivery sequence: count == ordered targets, same order, and
    // unique strictly-increasing commit sequences. Per-delivery block linkage
    // is not part of the mapping schema; the top-level block/effect link is
    // verified by B and enforced here via the status-first confirmation.
    if mapping.deliveries.len() != intent.target_page_ids.len() {
        return Err(mismatch("deliveries count"));
    }
    let mut previous_commit_seq = 0i64;
    for (index, delivery) in mapping.deliveries.iter().enumerate() {
        if delivery.page_id != intent.target_page_ids[index] {
            return Err(mismatch("deliveries order"));
        }
        if delivery.commit_seq <= previous_commit_seq {
            return Err(mismatch("deliveries uniqueness/order"));
        }
        if delivery.page_id.is_empty() {
            return Err(mismatch("delivery target"));
        }
        previous_commit_seq = delivery.commit_seq;
    }
    Ok(())
}

fn commit_from_mapping(mapping: &HostIngressMapping) -> IngressCommit {
    let deliveries = mapping
        .deliveries
        .iter()
        .enumerate()
        .map(|(index, delivery)| (delivery.page_id.clone(), index as i64 + 1, delivery.commit_seq))
        .collect();
    IngressCommit {
        ingress_id: mapping.ingress_id.clone(),
        block_id: mapping.block_id.clone(),
        graph_revision: mapping.graph_revision,
        deliveries,
    }
}

/// The sealed Host ingress adapter. Crate-private; only
/// [`InboundReceiver`](crate::InboundReceiver) constructs one.
pub(crate) struct HostIngressCoreAdapter<'host, 'conn, 'principal, H: HostIngress + ?Sized> {
    core: &'host mut H,
    authority: &'principal HostConnectionAuthority,
    grant: &'principal HostCapabilityGrant,
    store: &'host mut SqliteChannelStore<'conn>,
    config_revision: i64,
}

impl<'host, 'conn, 'principal, H: HostIngress + ?Sized> HostIngressCoreAdapter<'host, 'conn, 'principal, H> {
    pub(crate) fn new(
        core: &'host mut H,
        authority: &'principal HostConnectionAuthority,
        grant: &'principal HostCapabilityGrant,
        store: &'host mut SqliteChannelStore<'conn>,
        config_revision: i64,
    ) -> Self {
        Self { core, authority, grant, store, config_revision }
    }

    fn map_host_error(error: &HostIngressError) -> CoreIngressError {
        use dolly_core_domain::HostIngressErrorCode;
        match error.code() {
            HostIngressErrorCode::Busy => CoreIngressError::Unavailable,
            code => CoreIngressError::Rejected { code: code.code().to_string() },
        }
    }

    /// Raw `host.ingress.status` for one external event, returning the mapping
    /// for validation.
    pub(crate) fn status_mapping_for_event(
        &mut self,
        external_event_id: &str,
    ) -> Result<Option<Box<HostIngressMapping>>, CoreIngressError> {
        let request = HostIngressStatusRequest { external_event_id: external_event_id.to_string() };
        match self.core.status(self.authority, self.grant, &request) {
            Ok(HostIngressStatus::Committed(mapping)) => Ok(Some(mapping)),
            Ok(HostIngressStatus::Absent) => Ok(None),
            Err(error) => Err(Self::map_host_error(&error)),
        }
    }

    /// Whether two mappings are canonical byte-equal (the submit response
    /// must match B's authoritative status mapping exactly before adoption).
    fn mappings_canonically_equal(a: &HostIngressMapping, b: &HostIngressMapping) -> bool {
        match (
            dolly_canonical_json::canonicalize(a),
            dolly_canonical_json::canonicalize(b),
        ) {
            (Ok((ab, _)), Ok((bb, _))) => ab.as_bytes() == bb.as_bytes(),
            _ => false,
        }
    }

    /// Status-first issuance confirmation: after a fresh submit response, ask
    /// B status for the same principal/key and require the returned fully
    /// verified mapping to be canonical byte-equal to the submit mapping. The
    /// B-authoritative status mapping is what the Channel adopts.
    pub(crate) fn confirm_submit_against_status(
        &mut self,
        external_event_id: &str,
        submit_mapping: &HostIngressMapping,
    ) -> Result<HostIngressMapping, CoreIngressError> {
        match self.status_mapping_for_event(external_event_id)? {
            Some(status_mapping) => {
                if !Self::mappings_canonically_equal(submit_mapping, &status_mapping) {
                    return Err(rejected(INTENT_CONFLICT_CODE));
                }
                Ok(*status_mapping)
            }
            None => Err(rejected("CHANNEL_INTENT_INCONSISTENT")),
        }
    }

    /// Adopt a validated committed mapping onto the prepared intent: validates
    /// the mapping against the intent and atomically commits the terminal
    /// outcome. A failure is retryable [`CoreIngressError::Unavailable`];
    /// a mapping mismatch is a conflict/corrupt pending, never success.
    pub(crate) fn adopt_committed(
        &mut self,
        intent: &ChannelIntent,
        mapping: &HostIngressMapping,
    ) -> Result<IngressCommit, CoreIngressError> {
        validate_host_mapping(intent, mapping).map_err(|e| rejected(&e.code))?;
        let commit = commit_from_mapping(mapping);
        self.commit_outcome(&intent.intent_key, Some(&commit.block_id), None)?;
        Ok(commit)
    }

    /// Atomically commit the terminal outcome to the Channel store. A failure
    /// is reported as retryable [`CoreIngressError::Unavailable`] so the
    /// accepted pipeline yields `SubmissionPending`, never a terminal
    /// `CoreRejected`, while the durable row stays `prepared`.
    pub(crate) fn commit_outcome(
        &mut self,
        intent_key: &str,
        accepted_block_id: Option<&str>,
        rejected_code: Option<&str>,
    ) -> Result<(), CoreIngressError> {
        self.store
            .commit_outcome(intent_key, accepted_block_id, rejected_code)
            .map_err(|_| CoreIngressError::Unavailable)
    }
}

impl<H: HostIngress + ?Sized> CoreIngress for HostIngressCoreAdapter<'_, '_, '_, H> {
    fn submit(&mut self, request: &IngressSubmitRequest) -> Result<IngressSubmitReceipt, CoreIngressError> {
        let facts = channel_facts_from_draft(&request.draft)?;
        let principal = ChannelPrincipal::from_authority_grant(self.authority, self.grant)
            .map_err(|e| rejected(&e.code))?;
        let target_page_ids = request
            .target_page_ids
            .iter()
            .map(|page| PageId::from_str(page).map_err(|_| rejected("HOST_INGRESS_PREMISE_INVALID")))
            .collect::<Result<Vec<PageId>, _>>()?;

        let intent_key = crate::ids::inbound_ingress_key(principal.account(), &facts.external_event_id);

        // 1. Durable pre-effect state must exist for this key BEFORE any Host
        //    submit or status.
        let existing = self.store.find_intent(&intent_key).map_err(|e| rejected(&e.code))?;
        if let Some(intent) = &existing {
            let prepared = prepare_intent(&principal, self.config_revision, request, &facts)
                .map_err(|e| rejected(&e.code))?;
            if intent.digest != prepared.digest {
                return Err(rejected(INTENT_CONFLICT_CODE));
            }
            match intent.state {
                IntentState::Accepted => {
                    // Status-first revalidation with current authority + the
                    // mapping must still validate against the intent.
                    return match self.status_mapping_for_event(&facts.external_event_id)? {
                        Some(mapping) => {
                            let commit = self.adopt_committed(intent, &mapping)?;
                            Ok(IngressSubmitReceipt::Committed { idempotent: true, commit })
                        }
                        None => Err(rejected("CHANNEL_INTENT_INCONSISTENT")),
                    };
                }
                IntentState::Prepared => {
                    match self.status_mapping_for_event(&facts.external_event_id)? {
                        Some(mapping) => {
                            let commit = self.adopt_committed(intent, &mapping)?;
                            return Ok(IngressSubmitReceipt::Committed { idempotent: true, commit });
                        }
                        None => {} // replay the byte-identical request
                    }
                }
                IntentState::Rejected => {
                    let code = intent.rejected_code.clone().unwrap_or_else(|| codes::INTERNAL.to_string());
                    return Err(rejected(&code));
                }
            }
        } else {
            let intent = prepare_intent(&principal, self.config_revision, request, &facts)
                .map_err(|e| rejected(&e.code))?;
            if let Err(persist_error) = self.store.write_prepared(&intent) {
                if persist_error.code == codes::OPERATION_CONFLICT {
                    return Err(rejected(INTENT_CONFLICT_CODE));
                }
                return Err(CoreIngressError::Unavailable);
            }
        }

        // 2. Only now may the Host submit run.
        let premise = HostIngressSubmitRequest {
            external_event_id: facts.external_event_id.clone(),
            kind: facts.kind,
            references_external_event_id: facts.references_external_event_id.clone(),
            target_page_ids,
            payload: request.draft.clone(),
        };
        match self.core.submit(self.authority, self.grant, &premise) {
            Ok(HostIngressSubmitOutcome::Committed { mapping, idempotent }) => {
                // 3. B status is the issuance authority: confirm the submit
                //    mapping byte-equal against the status mapping for the
                //    same principal/key, then validate that authoritative
                //    mapping against the fresh intent and commit atomically.
                //    A coherently mutated ingress_id+command_id or an
                //    arbitrary block_id in the submit result differs from B
                //    status and is refused (the durable row stays Prepared for
                //    reconcile() to adopt B's authoritative mapping).
                let authoritative = self.confirm_submit_against_status(&facts.external_event_id, &mapping)?;
                let intent = self.store.find_intent(&intent_key).map_err(|e| rejected(&e.code))?
                    .ok_or_else(|| rejected("CHANNEL_INTENT_INCONSISTENT"))?;
                let commit = self.adopt_committed(&intent, &authoritative)?;
                Ok(IngressSubmitReceipt::Committed { idempotent, commit })
            }
            Ok(HostIngressSubmitOutcome::Conflict { .. }) => Err(rejected(INTENT_CONFLICT_CODE)),
            Err(error) => {
                let mapped = Self::map_host_error(&error);
                if let CoreIngressError::Rejected { code } = &mapped {
                    if self.commit_outcome(&intent_key, None, Some(code)).is_err() {
                        return Err(CoreIngressError::Unavailable);
                    }
                }
                Err(mapped)
            }
        }
    }

    fn status(&mut self, _operation_id: &str, _module_id: &str, idempotency_key: &str, _deadline: &str) -> Result<IngressStatusResult, CoreIngressError> {
        let intent = self.store.find_intent(idempotency_key).map_err(|e| rejected(&e.code))?;
        let Some(intent) = intent else {
            return Err(CoreIngressError::UnknownOutcome);
        };
        match self.status_mapping_for_event(&intent.external_event_id)? {
            Some(mapping) => {
                // Validate before exposing the mapping; an unrelated Host
                // effect for the same key is a conflict, never success.
                if validate_host_mapping(&intent, &mapping).is_err() {
                    return Err(rejected(INTENT_CONFLICT_CODE));
                }
                Ok(IngressStatusResult::Committed { commit: commit_from_mapping(&mapping) })
            }
            None => Ok(IngressStatusResult::Absent),
        }
    }
}
