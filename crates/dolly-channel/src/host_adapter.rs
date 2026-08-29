//! Channel inbound -> sealed Host ingress adapter (seam B wiring).
//!
//! This module implements the accepted dolly-channel [`CoreIngress`] seam
//! (`host.ingress.submit` / `host.ingress.status`) over the accepted durable
//! [`HostIngress`] seam of `dolly-storage`. It is the shipping-runtime bridge
//! that turns one already-authenticated Channel submission into the generic
//! sealed Host ingress premise: the adapter only forwards event content (the
//! block draft, the external event identity, the lifecycle kind, the
//! edit/delete relation, the ordered target Pages) plus the opaque current
//! Host authority and capability grant. Owner, source Extension/Module/
//! instance, generation, revision, and graph revision are derived and
//! re-verified inside the storage transaction, so no identity, fence, or
//! target-direction claim ever passes from the Channel caller into durable
//! state.
//!
//! Reach-Core-exactly-once: re-submitting the same (key, digest) returns the
//! prior mapping with no new Core mutation, a different digest under the same
//! key is a conflict before Core, and a lost response is reconciled through
//! `status` (only an authoritative `absent` permits replay).
//!
//! [`CoreIngress::status`] carries only the account-and-message-derived
//! idempotency key, not the external event identity, while
//! [`HostIngress::status`] derives its key from the external event identity of
//! the calling principal. The adapter therefore keeps a bounded translation
//! table (Channel ingress key -> external event identity) seeded from the
//! durable Channel ledger rows and extended on every submit; a status for a
//! key it cannot translate fails as `UnknownOutcome` instead of ever
//! answering `Absent` or `Committed` for an identity it cannot name.

use std::collections::BTreeMap;
use std::str::FromStr;

use dolly_canonical_json::CanonicalJsonValue;
use dolly_core_domain::{
    HostIngressError, HostIngressKind, HostIngressStatus, HostIngressStatusRequest,
    HostIngressSubmitOutcome, HostIngressSubmitRequest, PageId,
};
use dolly_storage::{HostCapabilityGrant, HostConnectionAuthority, HostIngress};

use crate::ingress::{
    CHANNEL_METADATA_NAMESPACE, CoreIngress, CoreIngressError, IngressCommit, IngressStatusResult,
    IngressSubmitReceipt, IngressSubmitRequest,
};
use crate::ledger::ChannelLedger;

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
    // Relation consistency (edit/delete MUST name a reference, message MUST
    // NOT) is enforced by the Host ingress premise validator.
    Ok((external_event_id, kind, references_external_event_id))
}

/// The generic sealed Host ingress premise through the accepted
/// `HostIngress::submit` / `HostIngress::status` interface.
pub struct HostIngressCoreAdapter<'host, 'principal, H: HostIngress + ?Sized> {
    core: &'host mut H,
    authority: &'principal HostConnectionAuthority,
    grant: &'principal HostCapabilityGrant,
    /// Channel ingress key (the `idempotency_key` of the Channel request) ->
    /// external event identity, for the status translation described above.
    known_events: BTreeMap<String, String>,
}

impl<'host, 'principal, H: HostIngress + ?Sized> HostIngressCoreAdapter<'host, 'principal, H> {
    /// Bind the adapter to one `HostIngress` implementation and the opaque
    /// current Host authority and capability grant. The grant must authorize
    /// `host.ingress.submit` and remain current; the storage transaction
    /// re-verifies both on every call.
    pub fn new(
        core: &'host mut H,
        authority: &'principal HostConnectionAuthority,
        grant: &'principal HostCapabilityGrant,
    ) -> Self {
        Self {
            core,
            authority,
            grant,
            known_events: BTreeMap::new(),
        }
    }

    /// Seed the status translation table from durable Channel ledger rows:
    /// every inbound row already records its stable ingress key and its
    /// external message identity, so a restarted receiver can reconcile
    /// `submitted` rows without ever re-deriving identity from scratch.
    pub fn seed_from_ledger(&mut self, ledger: &ChannelLedger) {
        for entry in ledger.inbound.values() {
            self.known_events
                .insert(entry.ingress_key.clone(), entry.external_message_id.clone());
        }
    }

    fn map_host_error(error: &HostIngressError) -> CoreIngressError {
        use dolly_core_domain::HostIngressErrorCode;
        match error.code() {
            // Busy is transient: the submission was not acknowledged, so the
            // Channel marks the row `submitted` and reconciles via status.
            HostIngressErrorCode::Busy => CoreIngressError::Unavailable,
            code => CoreIngressError::Rejected {
                code: code.code().to_string(),
            },
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
        let target_page_ids = request
            .target_page_ids
            .iter()
            .map(|page| {
                PageId::from_str(page).map_err(|_| CoreIngressError::Rejected {
                    code: "HOST_INGRESS_PREMISE_INVALID".to_string(),
                })
            })
            .collect::<Result<Vec<PageId>, CoreIngressError>>()?;
        let premise = HostIngressSubmitRequest {
            external_event_id,
            kind,
            references_external_event_id,
            target_page_ids,
            payload: request.draft.clone(),
        };
        self.known_events.insert(
            request.idempotency_key.clone(),
            premise.external_event_id.clone(),
        );
        match self.core.submit(self.authority, self.grant, &premise) {
            Ok(HostIngressSubmitOutcome::Committed {
                mapping,
                idempotent,
            }) => {
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
                let commit = IngressCommit {
                    ingress_id: mapping.ingress_id.clone(),
                    block_id: mapping.block_id.clone(),
                    graph_revision: mapping.graph_revision,
                    deliveries,
                };
                Ok(IngressSubmitReceipt::Committed { idempotent, commit })
            }
            Ok(HostIngressSubmitOutcome::Conflict { .. }) => Err(CoreIngressError::Rejected {
                code: "STORAGE_IDEMPOTENCY_CONFLICT".to_string(),
            }),
            Err(error) => Err(Self::map_host_error(&error)),
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
        let request = HostIngressStatusRequest { external_event_id };
        match self.core.status(self.authority, self.grant, &request) {
            Ok(HostIngressStatus::Committed(mapping)) => {
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
                let commit = IngressCommit {
                    ingress_id: mapping.ingress_id.clone(),
                    block_id: mapping.block_id.clone(),
                    graph_revision: mapping.graph_revision,
                    deliveries,
                };
                Ok(IngressStatusResult::Committed { commit })
            }
            Ok(HostIngressStatus::Absent) => Ok(IngressStatusResult::Absent),
            Err(error) => Err(Self::map_host_error(&error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn draft(
        external_message_id: &str,
        event_kind: &str,
        references: Option<&str>,
    ) -> CanonicalJsonValue {
        let mut metadata = serde_json::Map::new();
        metadata.insert("channel_id".into(), json!("web-primary"));
        metadata.insert("transport".into(), json!("web"));
        metadata.insert("session_id".into(), json!("session-main"));
        metadata.insert("external_conversation_id".into(), json!("conv-1"));
        metadata.insert("external_message_id".into(), json!(external_message_id));
        metadata.insert("sender_class".into(), json!("user"));
        metadata.insert("received_at".into(), json!("2026-08-28T00:00:00.000000Z"));
        metadata.insert("event_kind".into(), json!(event_kind));
        if let Some(references) = references {
            metadata.insert("references_external_message_id".into(), json!(references));
        }
        let draft = json!({
            "schema": "dolly.block-draft/v1",
            "parts": [{"kind": "text", "text": "hello", "format": "plain"}],
            "actions": [],
            "metadata": { CHANNEL_METADATA_NAMESPACE: serde_json::Value::Object(metadata) }
        });
        CanonicalJsonValue::try_from(draft).unwrap()
    }

    #[test]
    fn identity_extraction_round_trips_message_edit_delete() {
        let (id, kind, references) =
            channel_identity_from_draft(&draft("msg-1", "message", None)).unwrap();
        assert_eq!(id, "msg-1");
        assert_eq!(kind, HostIngressKind::Message);
        assert_eq!(references, None);

        let (_, kind, references) =
            channel_identity_from_draft(&draft("msg-2", "edit", Some("msg-1"))).unwrap();
        assert_eq!(kind, HostIngressKind::Edit);
        assert_eq!(references.as_deref(), Some("msg-1"));

        let (_, kind, _) =
            channel_identity_from_draft(&draft("msg-3", "delete", Some("msg-1"))).unwrap();
        assert_eq!(kind, HostIngressKind::Delete);
    }

    #[test]
    fn malformed_draft_fails_closed() {
        let bad = CanonicalJsonValue::try_from(json!({"schema": "other"})).unwrap();
        assert!(channel_identity_from_draft(&bad).is_err());
        let no_channel =
            CanonicalJsonValue::try_from(json!({"schema": "dolly.block-draft/v1", "metadata": {}}))
                .unwrap();
        assert!(channel_identity_from_draft(&no_channel).is_err());
    }
}
