//! Channel inbound -> sealed Host ingress adapter (seam B wiring).
//!
//! This module implements the accepted dolly-channel [`CoreIngress`] seam
//! (`host.ingress.submit` / `host.ingress.status`) over the accepted durable
//! [`HostIngress`] seam of `dolly-storage`, with the durable prepared intent
//! as the ordering authority:
//!
//! 1. a `prepared` [`ChannelIntent`] row is durably persisted in the
//!    module-scoped store BEFORE any `HostIngress::submit` or Core effect;
//!    if that initial persistence fails, no Host/Core effect runs;
//! 2. a pending intent is reconciled `status`-first using the stored
//!    deterministic identity and the CURRENT sealed authority/grant — only an
//!    authoritative `absent` permits a byte-identical replay submit;
//! 3. an accepted intent is replayed only after `status` re-verifies that the
//!    same authority/grant is still current (never a cached success under a
//!    stale or revoked authority);
//! 4. the same key with a different operation digest (changed order/content/
//!    relation of pages) conflicts before any Core effect.
//!
//! The adapter forwards only event content plus the opaque current Host
//! authority and capability grant; owner, source Extension/Module/instance,
//! generation, revision, and graph revision are derived inside the storage
//! transaction (and mirrored into the durable intent), so no identity, fence,
//! or target-direction claim passes from the Channel caller into durable
//! state.

use std::collections::BTreeMap;
use std::str::FromStr;

use dolly_canonical_json::{CanonicalJsonValue, Sha256Digest};
use dolly_core_domain::{
    HostIngressError, HostIngressKind, HostIngressStatus, HostIngressStatusRequest,
    HostIngressSubmitOutcome, HostIngressSubmitRequest, PageId,
};
use dolly_storage::{HostCapabilityGrant, HostConnectionAuthority, HostIngress};

use crate::error::{ChannelError, ChannelOutcome, codes};
use crate::ingress::{
    CHANNEL_METADATA_NAMESPACE, CoreIngress, CoreIngressError, IngressCommit, IngressStatusResult,
    IngressSubmitReceipt, IngressSubmitRequest,
};
use crate::intent::{CHANNEL_INTENT_RECORD_SCHEMA, ChannelIntent, IntentState};
use crate::ledger::{ChannelLedger, EventKind};
use crate::principal::ChannelPrincipal;
use crate::store::ChannelStore;

/// The stable wire code for an intent-conflict (same key, different digest).
pub const INTENT_CONFLICT_CODE: &str = "STORAGE_IDEMPOTENCY_CONFLICT";
/// The stable wire code for an intent state inconsistent with durable Host
/// truth (for example a ledger claiming accepted while `status` is absent).
pub const INTENT_INCONSISTENT_CODE: &str = "CHANNEL_INTENT_INCONSISTENT";

/// Extract the external event identity, lifecycle kind, and edit/delete
/// relation from a Channel block draft's `org.dolly.channel` metadata. A
/// draft without the exact channel metadata is rejected before any durable
/// call (fail closed).
pub(crate) fn channel_identity_from_draft(
    draft: &CanonicalJsonValue,
) -> Result<(String, HostIngressKind, Option<String>), CoreIngressError> {
    let invalid = |_field: &str| CoreIngressError::Rejected {
        code: "CORE_INVALID_JSON".to_string(),
    };
    let CanonicalJsonValue::Object(root) = draft else {
        return Err(invalid("draft"));
    };
    let Some(CanonicalJsonValue::Object(metadata)) = root.get("metadata") else {
        return Err(invalid("metadata"));
    };
    let Some(CanonicalJsonValue::Object(channel)) = metadata.get(CHANNEL_METADATA_NAMESPACE) else {
        return Err(invalid("channel metadata"));
    };
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
    Ok((external_event_id, kind, references_external_event_id))
}

/// The Channel-local operation digest of one intent, binding the principal
/// fences, the lifecycle kind and edit/delete relation, the ordered target
/// Pages, the config revision, and the canonical content payload digest.
pub(crate) fn channel_intent_digest(
    principal: &ChannelPrincipal,
    config_revision: i64,
    external_event_id: &str,
    kind: EventKind,
    references_external_event_id: Option<&str>,
    target_page_ids: &[String],
    payload_digest: &str,
) -> String {
    use dolly_canonical_json::canonicalize;
    let mut identity = serde_json::Map::new();
    identity.insert(
        "schema".into(),
        serde_json::json!("dolly.channel-intent/operation/v1"),
    );
    identity.insert("account".into(), serde_json::json!(principal.account()));
    identity.insert(
        "extension_id".into(),
        serde_json::json!(principal.extension_id()),
    );
    identity.insert("module_id".into(), serde_json::json!(principal.module_id()));
    identity.insert(
        "instance_id".into(),
        serde_json::json!(principal.instance_id()),
    );
    identity.insert(
        "generation".into(),
        serde_json::json!(principal.generation()),
    );
    identity.insert("revision".into(), serde_json::json!(principal.revision()));
    identity.insert(
        "graph_revision".into(),
        serde_json::json!(principal.graph_revision()),
    );
    identity.insert("config_revision".into(), serde_json::json!(config_revision));
    identity.insert(
        "external_event_id".into(),
        serde_json::json!(external_event_id),
    );
    identity.insert("kind".into(), serde_json::json!(kind.as_str()));
    if let Some(references) = references_external_event_id {
        identity.insert(
            "references_external_event_id".into(),
            serde_json::json!(references),
        );
    }
    identity.insert(
        "target_page_ids".into(),
        serde_json::Value::Array(
            target_page_ids
                .iter()
                .map(|page| serde_json::json!(page))
                .collect(),
        ),
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

fn rejected(code: &str, _message: &str) -> CoreIngressError {
    CoreIngressError::Rejected {
        code: code.to_string(),
    }
}

/// A `prepared` durable intent record for one submission, computed from the
/// submitted request and the sealed principal.
pub(crate) fn prepare_intent(
    principal: &ChannelPrincipal,
    config_revision: i64,
    request: &IngressSubmitRequest,
    external_event_id: &str,
    kind: EventKind,
    references_external_event_id: Option<&str>,
) -> Result<ChannelIntent, ChannelError> {
    let request_jcs = request.draft_canonical_bytes()?;
    let request_jcs = String::from_utf8(request_jcs).map_err(|_| {
        ChannelError::new(
            codes::INTERNAL,
            false,
            ChannelOutcome::NotApplied,
            "draft is not UTF-8",
        )
    })?;
    let payload_digest = payload_digest_of(&request_jcs);
    let digest = channel_intent_digest(
        principal,
        config_revision,
        external_event_id,
        kind,
        references_external_event_id,
        &request.target_page_ids,
        &payload_digest,
    );
    Ok(ChannelIntent {
        schema: CHANNEL_INTENT_RECORD_SCHEMA.to_string(),
        intent_key: request.idempotency_key.clone(),
        digest,
        state: IntentState::Prepared,
        owner: principal.owner().to_string(),
        extension_id: principal.extension_id().to_string(),
        module_id: principal.module_id().to_string(),
        instance_id: principal.instance_id().to_string(),
        generation: principal.generation() as i64,
        revision: principal.revision(),
        graph_revision: principal.graph_revision(),
        config_revision,
        account: principal.account().to_string(),
        external_event_id: external_event_id.to_string(),
        kind,
        references_external_event_id: references_external_event_id.map(str::to_owned),
        target_page_ids: request.target_page_ids.clone(),
        payload_digest,
        request_jcs,
        block_id: None,
        rejected_code: None,
    })
}

/// The generic sealed Host ingress premise through the accepted
/// `HostIngress::submit` / `HostIngress::status` interface.
pub struct HostIngressCoreAdapter<'seam, 'principal, H: HostIngress + ?Sized> {
    core: &'seam mut H,
    authority: &'principal HostConnectionAuthority,
    grant: &'principal HostCapabilityGrant,
    intents: &'seam mut dyn ChannelStore,
    config_revision: i64,
    /// Channel ingress key (the `idempotency_key` of the Channel request) ->
    /// external event identity, for the `CoreIngress::status` translation
    /// (which carries only the key). Seeded from the ledger and intents.
    known_events: BTreeMap<String, String>,
}

impl<'seam, 'principal, H: HostIngress + ?Sized> HostIngressCoreAdapter<'seam, 'principal, H> {
    /// Bind the adapter to one `HostIngress` implementation, the module-scoped
    /// intent store, and the opaque current Host authority and capability
    /// grant.
    pub fn new(
        core: &'seam mut H,
        authority: &'principal HostConnectionAuthority,
        grant: &'principal HostCapabilityGrant,
        intents: &'seam mut dyn ChannelStore,
        config_revision: i64,
    ) -> Self {
        Self {
            core,
            authority,
            grant,
            intents,
            config_revision,
            known_events: BTreeMap::new(),
        }
    }

    /// Seed the key->event translation from durable Channel ledger rows so a
    /// restarted receiver can reconcile with the same deterministic identity.
    pub fn seed_from_ledger(&mut self, ledger: &ChannelLedger) {
        for entry in ledger.inbound.values() {
            self.known_events
                .insert(entry.ingress_key.clone(), entry.external_message_id.clone());
        }
    }

    /// Seed the key->event translation from durable intent rows.
    pub fn seed_from_intents(&mut self, intents: &[ChannelIntent]) {
        for intent in intents {
            self.known_events
                .insert(intent.intent_key.clone(), intent.external_event_id.clone());
        }
    }

    /// Durably settle one intent to its committed outcome (delegates to the
    /// module-scoped intent store).
    pub fn settle_accepted(
        &mut self,
        intent_key: &str,
        block_id: &str,
    ) -> Result<(), ChannelError> {
        self.intents.settle_accepted(intent_key, block_id)
    }

    /// Ask `host.ingress.status` with the current sealed authority/grant for
    /// one external event and map the result. Status re-verifies inside the
    /// storage transaction that the authority is current, the grant is live
    /// and authorizes `host.ingress.submit`, and every record verifies.
    pub fn status_for_event(
        &mut self,
        external_event_id: &str,
    ) -> Result<IngressStatusResult, CoreIngressError> {
        let request = HostIngressStatusRequest {
            external_event_id: external_event_id.to_string(),
        };
        match self.core.status(self.authority, self.grant, &request) {
            Ok(HostIngressStatus::Committed(mapping)) => {
                let commit = commit_from_mapping(&mapping);
                Ok(IngressStatusResult::Committed { commit })
            }
            Ok(HostIngressStatus::Absent) => Ok(IngressStatusResult::Absent),
            Err(error) => Err(Self::map_host_error(&error)),
        }
    }

    fn map_host_error(error: &HostIngressError) -> CoreIngressError {
        use dolly_core_domain::HostIngressErrorCode;
        match error.code() {
            // Busy is transient: the submission was not acknowledged, so the
            // intent stays prepared and is reconciled via status.
            HostIngressErrorCode::Busy => CoreIngressError::Unavailable,
            code => CoreIngressError::Rejected {
                code: code.code().to_string(),
            },
        }
    }

    /// The status-first replay of an intent whose outcome is already known
    /// (`accepted`) or whose submit response was lost (`prepared`).
    fn reconcile_existing_intent(
        &mut self,
        intent: &ChannelIntent,
        external_event_id: &str,
    ) -> Result<IngressSubmitReceipt, CoreIngressError> {
        match self.status_for_event(external_event_id) {
            Ok(IngressStatusResult::Committed { commit }) => {
                if intent.state != IntentState::Accepted {
                    // Settle the durable intent to the committed outcome.
                    let _ = self
                        .intents
                        .settle_accepted(&intent.intent_key, &commit.block_id);
                }
                Ok(IngressSubmitReceipt::Committed {
                    idempotent: true,
                    commit,
                })
            }
            Ok(IngressStatusResult::Absent) => {
                // The Channel ledger/intent claims an outcome the Host slice
                // never committed: fail closed, never fabricate success.
                Err(rejected(
                    INTENT_INCONSISTENT_CODE,
                    "intent claims an outcome absent from the Host slice",
                ))
            }
            Err(error) => Err(error),
        }
    }
}

impl<H: HostIngress + ?Sized> CoreIngress for HostIngressCoreAdapter<'_, '_, H> {
    fn submit(
        &mut self,
        request: &IngressSubmitRequest,
    ) -> Result<IngressSubmitReceipt, CoreIngressError> {
        let (external_event_id, kind, references_external_event_id) =
            channel_identity_from_draft(&request.draft)?;
        let principal = ChannelPrincipal::from_authority_grant(self.authority, self.grant)
            .map_err(|error| {
                rejected(
                    &error.code,
                    "the sealed authority/grant do not form a valid Channel principal",
                )
            })?;
        let event_kind = match kind {
            HostIngressKind::Message => EventKind::Message,
            HostIngressKind::Edit => EventKind::Edit,
            HostIngressKind::Delete => EventKind::Delete,
        };
        let target_page_ids = request
            .target_page_ids
            .iter()
            .map(|page| {
                PageId::from_str(page).map_err(|_| CoreIngressError::Rejected {
                    code: "HOST_INGRESS_PREMISE_INVALID".to_string(),
                })
            })
            .collect::<Result<Vec<PageId>, CoreIngressError>>()?;

        let intent_key = request.idempotency_key.clone();
        self.known_events
            .insert(intent_key.clone(), external_event_id.clone());

        // 1. Durable pre-effect state must exist for this key BEFORE any Host
        //    submit or status: a newly seen key is persisted as `prepared`.
        let existing = self
            .intents
            .find_intent(&intent_key)
            .map_err(|error| rejected(&error.code, "channel intent read failed"))?;
        if let Some(intent) = existing {
            // Same key + a different digest (changed order/content/relation
            // or fence) conflicts before Core and changes nothing.
            let prepared = prepare_intent(
                &principal,
                self.config_revision,
                request,
                &external_event_id,
                event_kind,
                references_external_event_id.as_deref(),
            )
            .map_err(|error| rejected(&error.code, "channel intent derivation failed"))?;
            if intent.digest != prepared.digest {
                return Err(rejected(
                    INTENT_CONFLICT_CODE,
                    "the same intent key already carries a different operation digest",
                ));
            }
            match intent.state {
                // Known outcome: status-first replay with current-authority
                // revalidation (never a cached success under stale authority).
                IntentState::Accepted => {
                    return self.reconcile_existing_intent(&intent, &external_event_id);
                }
                // A prior submit response was lost, or the effect never
                // reached the Host slice: status decides before resending.
                IntentState::Prepared => match self.status_for_event(&external_event_id) {
                    Ok(IngressStatusResult::Committed { .. }) => {
                        return self.reconcile_existing_intent(&intent, &external_event_id);
                    }
                    Ok(IngressStatusResult::Absent) => {}
                    Err(error) => return Err(error),
                },
                IntentState::Rejected => {
                    let code = intent
                        .rejected_code
                        .clone()
                        .unwrap_or_else(|| codes::INTERNAL.to_string());
                    return Err(rejected(&code, "channel intent was already rejected"));
                }
            }
        } else {
            let intent = prepare_intent(
                &principal,
                self.config_revision,
                request,
                &external_event_id,
                event_kind,
                references_external_event_id.as_deref(),
            )
            .map_err(|error| rejected(&error.code, "channel intent derivation failed"))?;
            if let Err(persist_error) = self.intents.write_prepared(&intent) {
                // Initial persistence failure: no Host submit, no Core effect.
                return Err(rejected(
                    &persist_error.code,
                    "durable prepared intent could not be persisted",
                ));
            }
        }

        // 2. Only now may the Host submit run (the durable intent already
        //    exists for the key).
        let premise = HostIngressSubmitRequest {
            external_event_id,
            kind,
            references_external_event_id,
            target_page_ids,
            payload: request.draft.clone(),
        };
        match self.core.submit(self.authority, self.grant, &premise) {
            Ok(HostIngressSubmitOutcome::Committed {
                mapping,
                idempotent,
            }) => {
                let commit = commit_from_mapping(&mapping);
                // Record the terminal outcome on the prepared intent.
                let _ = self.intents.settle_accepted(&intent_key, &commit.block_id);
                Ok(IngressSubmitReceipt::Committed { idempotent, commit })
            }
            Ok(HostIngressSubmitOutcome::Conflict { .. }) => Err(rejected(
                INTENT_CONFLICT_CODE,
                "the Host slice reports an idempotency conflict",
            )),
            Err(error) => {
                let mapped = Self::map_host_error(&error);
                if let CoreIngressError::Rejected { code } = &mapped {
                    let _ = self.intents.mark_rejected(&intent_key, code);
                }
                // UnknownOutcome/Unavailable leave the intent `prepared` for
                // status-first reconciliation.
                Err(mapped)
            }
        }
    }

    fn status(
        &mut self,
        _operation_id: &str,
        _module_id: &str,
        idempotency_key: &str,
        _deadline: &str,
    ) -> Result<IngressStatusResult, CoreIngressError> {
        // Only a known (durably recorded) external event identity may be
        // queried; an unknown key must never read as authoritative `absent`.
        let Some(external_event_id) = self.known_events.get(idempotency_key).cloned() else {
            return Err(CoreIngressError::UnknownOutcome);
        };
        self.status_for_event(&external_event_id)
    }
}

fn commit_from_mapping(mapping: &dolly_core_domain::HostIngressMapping) -> IngressCommit {
    let deliveries = mapping
        .deliveries
        .iter()
        .enumerate()
        .map(|(index, delivery)| {
            (
                delivery.page_id.clone(),
                index as i64 + 1,
                delivery.commit_seq,
            )
        })
        .collect();
    IngressCommit {
        ingress_id: mapping.ingress_id.clone(),
        block_id: mapping.block_id.clone(),
        graph_revision: mapping.graph_revision,
        deliveries,
    }
}
