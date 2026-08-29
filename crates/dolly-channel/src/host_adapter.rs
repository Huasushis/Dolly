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
//! 3. an accepted intent is replayed only after `status` re-verifies the same
//!    authority/grant is still current;
//! 4. the same key with a different operation digest (changed order/content/
//!    relation of pages or authority fences) conflicts before any Core effect;
//! 5. after a Host decision, a failure to atomically write the terminal Channel
//!    outcome is reported as retryable [`CoreIngressError::Unavailable`] (the
//!    durable row stays `prepared`), never a terminal rejection.

use std::str::FromStr;

use dolly_canonical_json::{CanonicalJsonValue, Sha256Digest};
use dolly_core_domain::{
    HostIngressError, HostIngressKind, HostIngressStatus, HostIngressStatusRequest,
    HostIngressSubmitOutcome, HostIngressSubmitRequest, PageId,
};
use dolly_storage::{HostCapabilityGrant, HostConnectionAuthority, HostIngress};

use crate::error::{ChannelError, ChannelOutcome, codes};
use crate::ingress::{
    CHANNEL_METADATA_NAMESPACE, CoreIngress, CoreIngressError, IngressCommit,
    IngressStatusResult, IngressSubmitReceipt, IngressSubmitRequest,
};
use crate::intent::{CHANNEL_INTENT_RECORD_SCHEMA, ChannelIntent, IntentState};
use crate::ledger::EventKind;
use crate::principal::ChannelPrincipal;
use crate::store::SqliteChannelStore;

const INTENT_CONFLICT_CODE: &str = "STORAGE_IDEMPOTENCY_CONFLICT";

/// The transport-sourced facts extracted from a Channel block draft's
/// `org.dolly.channel` metadata, preserved in the durable intent for the
/// lossless ChannelLedger projection.
pub(crate) struct ChannelDraftFacts {
    pub external_event_id: String,
    pub kind: HostIngressKind,
    pub references_external_event_id: Option<String>,
    pub channel_id: String,
    pub transport: String,
    pub external_conversation_id: String,
    pub sender_class: String,
    pub received_at: String,
}

/// Extract the external event identity, lifecycle kind, edit/delete relation,
/// and the real transport content facts from a Channel block draft's
/// `org.dolly.channel` metadata.
pub(crate) fn channel_facts_from_draft(
    draft: &CanonicalJsonValue,
) -> Result<ChannelDraftFacts, CoreIngressError> {
    let invalid = |_field: &str| CoreIngressError::Rejected { code: "CORE_INVALID_JSON".to_string() };
    let CanonicalJsonValue::Object(root) = draft else { return Err(invalid("draft")); };
    let Some(CanonicalJsonValue::Object(metadata)) = root.get("metadata") else { return Err(invalid("metadata")); };
    let Some(CanonicalJsonValue::Object(channel)) = metadata.get(CHANNEL_METADATA_NAMESPACE) else { return Err(invalid("channel metadata")); };
    let channel_text = |field: &str| match channel.get(field) {
        Some(CanonicalJsonValue::String(value)) if !value.is_empty() => Ok(value.clone()),
        _ => Err(invalid(field)),
    };
    let external_event_id = channel_text("external_message_id")?;
    let kind = match channel_text("event_kind")?.as_str() {
        "message" => HostIngressKind::Message,
        "edit" => HostIngressKind::Edit,
        "delete" => HostIngressKind::Delete,
        _ => return Err(invalid("event_kind")),
    };
    let references_external_event_id = match channel.get("references_external_message_id") {
        Some(CanonicalJsonValue::String(value)) if !value.is_empty() => Some(value.clone()),
        _ => None,
    };
    Ok(ChannelDraftFacts {
        external_event_id,
        kind,
        references_external_event_id,
        channel_id: channel_text("channel_id")?,
        transport: channel_text("transport")?,
        external_conversation_id: channel_text("external_conversation_id")?,
        sender_class: channel_text("sender_class")?,
        received_at: channel_text("received_at")?,
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
/// sealed principal, preserving the real transport content facts.
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
    let intent_key = crate::ids::inbound_ingress_key(principal.account(), &facts.external_event_id);
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
        channel_id: facts.channel_id.clone(),
        transport: facts.transport.clone(),
        external_conversation_id: facts.external_conversation_id.clone(),
        sender_class: facts.sender_class.clone(),
        received_at: facts.received_at.clone(),
        kind: event_kind,
        references_external_event_id: facts.references_external_event_id.clone(),
        target_page_ids: request.target_page_ids.clone(),
        payload_digest,
        request_jcs,
        block_id: None,
        rejected_code: None,
    })
}

fn commit_from_mapping(mapping: &dolly_core_domain::HostIngressMapping) -> IngressCommit {
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

    /// Ask `host.ingress.status` for one external event.
    pub(crate) fn status_for_event(
        &mut self,
        external_event_id: &str,
    ) -> Result<IngressStatusResult, CoreIngressError> {
        let request = HostIngressStatusRequest { external_event_id: external_event_id.to_string() };
        match self.core.status(self.authority, self.grant, &request) {
            Ok(HostIngressStatus::Committed(mapping)) => Ok(IngressStatusResult::Committed { commit: commit_from_mapping(&mapping) }),
            Ok(HostIngressStatus::Absent) => Ok(IngressStatusResult::Absent),
            Err(error) => Err(Self::map_host_error(&error)),
        }
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
                    // Status-first revalidation with current authority.
                    match self.status_for_event(&facts.external_event_id) {
                        Ok(IngressStatusResult::Committed { commit }) => {
                            return Ok(IngressSubmitReceipt::Committed { idempotent: true, commit });
                        }
                        Ok(IngressStatusResult::Absent) => return Err(rejected("CHANNEL_INTENT_INCONSISTENT")),
                        Err(e) => return Err(e),
                    }
                }
                IntentState::Prepared => {
                    match self.status_for_event(&facts.external_event_id) {
                        Ok(IngressStatusResult::Committed { commit }) => {
                            self.commit_outcome(&intent_key, Some(&commit.block_id), None)?;
                            return Ok(IngressSubmitReceipt::Committed { idempotent: true, commit });
                        }
                        Ok(IngressStatusResult::Absent) => {} // replay the byte-identical request
                        Err(e) => return Err(e),
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
                // Initial persistence failure: no Host/Core effect runs.
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
                let commit = commit_from_mapping(&mapping);
                // 3. Atomically commit the terminal outcome. If this fails the
                //    row stays Prepared and the outcome is retryable.
                self.commit_outcome(&intent_key, Some(&commit.block_id), None)?;
                Ok(IngressSubmitReceipt::Committed { idempotent, commit })
            }
            Ok(HostIngressSubmitOutcome::Conflict { .. }) => Err(rejected(INTENT_CONFLICT_CODE)),
            Err(error) => {
                let mapped = Self::map_host_error(&error);
                if let CoreIngressError::Rejected { code } = &mapped {
                    // Record the durable rejection; on Channel-DB failure the
                    // outcome stays uncertain (retryable), never terminal.
                    if self.commit_outcome(&intent_key, None, Some(code)).is_err() {
                        return Err(CoreIngressError::Unavailable);
                    }
                }
                Err(mapped)
            }
        }
    }

    fn status(&mut self, _operation_id: &str, _module_id: &str, idempotency_key: &str, _deadline: &str) -> Result<IngressStatusResult, CoreIngressError> {
        // Look up the external event id from the durable intent (no cache).
        let intent = self.store.find_intent(idempotency_key).map_err(|e| rejected(&e.code))?;
        let Some(intent) = intent else {
            return Err(CoreIngressError::UnknownOutcome);
        };
        self.status_for_event(&intent.external_event_id)
    }
}
