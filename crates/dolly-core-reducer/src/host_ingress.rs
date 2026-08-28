//! Pure Host ingress identity derivation and request validation.
//!
//! This module owns the canonical identity of the durable Host ingress seam
//! without any storage: for the authority-bound facts (derived by the storage
//! transaction from the opaque current Host grant/authority) and a caller's
//! [`HostIngressSubmitRequest`] it derives the ingress key and the operation
//! digest, and it builds the reducer `Ingress` command the storage seam
//! commits the premise as.
//!
//! A caller never supplies owner, source, generation, revision, or graph
//! revision: the storage transaction fills these from the opaque grant and
//! authority values it re-verifies inside the same transaction, so arbitrary
//! identity/fence values cannot be copied into durable state.
//!
//! Identity rules (the spec the durable seam enforces):
//!
//! - The **ingress key** is a domain-separated SHA-256 over the owner, the
//!   source Extension/Module/instance, and an external event identity. A
//!   different owner or source is a different key, so cross-owner or
//!   cross-source reuses can never collide, and `status` can only ever look
//!   up the calling principal's own key.
//! - The **operation digest** is the SHA-256 of the canonical JSON of a
//!   structured record binding the owner, source (with generation), the
//!   incarnation/graph revision fences, the external event identity, the
//!   lifecycle kind, the edit/delete relation, the *ordered* target-Page
//!   list, and the content digest. The target-Page list participates ordered
//!   with duplicates collapsed: any change to the ordered list — including
//!   reordering — changes the digest, while a list that differs only in
//!   duplicate entries is canonically equivalent and yields the same digest.
//! - An `edit`/`delete` request MUST name the original event, which the
//!   storage transaction requires to already be committed by the same
//!   principal. A `message` request MUST NOT name one.
//! - A request MUST name at least one target Page within the ceiling, and
//!   its payload's canonical bytes must stay within the seam ceiling. Any
//!   violation rejects the request before storage is touched.

use dolly_canonical_json::{Sha256Digest, canonicalize};
use dolly_core_domain::{
    BlockId, HostIngressKey, HostIngressKind, HostIngressSubmitRequest, PageId,
    MAX_HOST_INGRESS_ID_TEXT_BYTES, MAX_HOST_INGRESS_PAYLOAD_JCS_BYTES,
    MAX_HOST_INGRESS_PRINCIPAL_TEXT_BYTES, MAX_HOST_INGRESS_REVISION,
    MAX_HOST_INGRESS_TARGET_PAGES,
};
use serde::Serialize;

use crate::command::{CoreCommand, IngressCommand};

/// Domain-separation prefix for the ingress-key derivation.
const INGRESS_KEY_PREFIX: &[u8] = b"dolly.host-ingress\0key\0";

/// The derivation input is deliberately primitive. Ownership, source,
/// generation, revision, and graph revision live inside the storage
/// transaction, derived from the opaque current Host authority and capability
/// grant; no seam API accepts them from a caller, so a caller cannot forge an
/// authority claim into durable state — these parameters only ever produce a
/// digest.

/// A rejected request, named by the failing rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostIngressPremiseError {
    /// An external event identity (or its edit/delete reference) is empty,
    /// oversized, or malformed.
    InvalidExternalId(String),
    /// The lifecycle kind and its edit/delete reference disagree.
    InvalidRelation(String),
    /// The target-Page list is empty, oversized, or malformed.
    InvalidTargetPages(String),
    /// The canonical payload exceeds MAX_HOST_INGRESS_PAYLOAD_JCS_BYTES.
    PayloadTooLarge(usize),
}

impl std::fmt::Display for HostIngressPremiseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HostIngressPremiseError::InvalidExternalId(message) => write!(f, "{message}"),
            HostIngressPremiseError::InvalidRelation(message) => write!(f, "{message}"),
            HostIngressPremiseError::InvalidTargetPages(message) => write!(f, "{message}"),
            HostIngressPremiseError::PayloadTooLarge(bytes) => write!(
                f,
                "premise payload is {bytes} canonical bytes, ceiling is {MAX_HOST_INGRESS_PAYLOAD_JCS_BYTES}"
            ),
        }
    }
}

/// The derived canonical identity of one premise.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IngressIdentity {
    /// The idempotency namespace of the (owner, source, external event).
    pub key: HostIngressKey,
    /// The canonical operation identity binding every premise field including
    /// the ordered target Pages and the authority fences.
    pub operation_digest: String,
    /// The canonical ordered target Pages (duplicates collapsed).
    pub canonical_target_page_ids: Vec<String>,
    /// SHA-256 of the canonical content payload bytes.
    pub payload_digest: String,
}

/// Collapse duplicate target Pages preserving first-occurrence order. Two
/// requests whose lists collapse to the same ordered list are canonically
/// equivalent and share one operation digest.
pub fn canonical_target_page_ids(pages: &[PageId]) -> Vec<String> {
    let mut out = Vec::with_capacity(pages.len());
    for page in pages {
        let page = page.to_string();
        if !out.iter().any(|existing| existing == &page) {
            out.push(page);
        }
    }
    out
}

/// Validate the caller-supplied event content of one submit. Rejects the
/// request before any storage is touched.
pub fn validate_ingress_request(
    request: &HostIngressSubmitRequest,
) -> Result<(), HostIngressPremiseError> {
    validate_text(
        &request.external_event_id,
        MAX_HOST_INGRESS_ID_TEXT_BYTES,
        "external_event_id",
    )
    .map_err(HostIngressPremiseError::InvalidExternalId)?;
    match (&request.kind, &request.references_external_event_id) {
        (HostIngressKind::Edit, Some(reference)) | (HostIngressKind::Delete, Some(reference)) => {
            validate_text(
                reference,
                MAX_HOST_INGRESS_ID_TEXT_BYTES,
                "references_external_event_id",
            )
            .map_err(HostIngressPremiseError::InvalidExternalId)?;
        }
        (HostIngressKind::Edit, None) | (HostIngressKind::Delete, None) => {
            return Err(HostIngressPremiseError::InvalidRelation(
                "edit/delete premises must name references_external_event_id".into(),
            ));
        }
        (HostIngressKind::Message, Some(_)) => {
            return Err(HostIngressPremiseError::InvalidRelation(
                "message premises must not name references_external_event_id".into(),
            ));
        }
        (HostIngressKind::Message, None) => {}
    }
    if request.target_page_ids.is_empty() {
        return Err(HostIngressPremiseError::InvalidTargetPages(
            "premise must name at least one target Page".into(),
        ));
    }
    if request.target_page_ids.len() > MAX_HOST_INGRESS_TARGET_PAGES {
        return Err(HostIngressPremiseError::InvalidTargetPages(format!(
            "premise names {} target Pages, ceiling is {MAX_HOST_INGRESS_TARGET_PAGES}",
            request.target_page_ids.len()
        )));
    }
    let (payload_jcs, _) = canonicalize(&request.payload)
        .map_err(|_| {
            HostIngressPremiseError::InvalidExternalId(
                "premise payload is not canonical JSON".into(),
            )
        })?;
    let payload_bytes = payload_jcs.as_bytes().len();
    if payload_bytes > MAX_HOST_INGRESS_PAYLOAD_JCS_BYTES {
        return Err(HostIngressPremiseError::PayloadTooLarge(payload_bytes));
    }
    Ok(())
}

/// Derive the canonical identity of one premise from the store-sealed
/// principal primitives and the caller's event content. The primitives are
/// handed in by the storage transaction only (never by a seam caller).
pub fn derive_ingress_identity(
    owner: &str,
    extension_id: &str,
    module_id: &str,
    instance_id: &str,
    generation: u64,
    revision: i64,
    graph_revision: i64,
    request: &HostIngressSubmitRequest,
) -> Result<IngressIdentity, HostIngressPremiseError> {
    validate_ingress_request(request)?;
    validate_principal(owner, extension_id, module_id, instance_id, generation, revision, graph_revision)?;
    let (_, payload_digest) = canonicalize(&request.payload).map_err(|_| {
        HostIngressPremiseError::InvalidExternalId("premise payload is not canonical JSON".into())
    })?;
    let operation_digest =
        derive_operation_digest(owner, extension_id, module_id, instance_id, generation, revision,
            graph_revision, request, &payload_digest)?;
    Ok(IngressIdentity {
        key: derive_ingress_key(owner, extension_id, module_id, instance_id, &request.external_event_id),
        operation_digest,
        canonical_target_page_ids: canonical_target_page_ids(&request.target_page_ids),
        payload_digest: payload_digest.to_canonical_string(),
    })
}

/// Derive the ingress key of one external event identity under the given
/// principal identities. Used both by submit (own external id) and by status
/// and the referenced-event check (any external id of the same principal).
pub fn derive_ingress_key(
    owner: &str,
    extension_id: &str,
    module_id: &str,
    instance_id: &str,
    external_event_id: &str,
) -> HostIngressKey {
    let mut input = Vec::with_capacity(
        INGRESS_KEY_PREFIX.len()
            + owner.len()
            + extension_id.len()
            + module_id.len()
            + instance_id.len()
            + external_event_id.len()
            + 5,
    );
    input.extend_from_slice(INGRESS_KEY_PREFIX);
    input.extend_from_slice(owner.as_bytes());
    input.push(0);
    input.extend_from_slice(extension_id.as_bytes());
    input.push(0);
    input.extend_from_slice(module_id.as_bytes());
    input.push(0);
    input.extend_from_slice(instance_id.as_bytes());
    input.push(0);
    input.extend_from_slice(external_event_id.as_bytes());
    input.push(0);
    let digest = Sha256Digest::compute(&input).to_canonical_string();
    HostIngressKey::from_text(digest).expect("derived digest is a canonical sha256: text")
}

/// Derive the operation digest: SHA-256 of the canonical JSON record binding
/// every authority fence and the ordered target-Page list.
fn derive_operation_digest(
    owner: &str,
    extension_id: &str,
    module_id: &str,
    instance_id: &str,
    generation: u64,
    revision: i64,
    graph_revision: i64,
    request: &HostIngressSubmitRequest,
    payload_digest: &Sha256Digest,
) -> Result<String, HostIngressPremiseError> {
    let identity = OperationIdentity {
        schema: "dolly.host-ingress/operation/v1",
        owner,
        source: SourceIdentity {
            extension_id,
            module_id,
            instance_id,
            generation,
        },
        external_event_id: &request.external_event_id,
        kind: request.kind.as_str(),
        references_external_event_id: request.references_external_event_id.as_deref(),
        target_page_ids: &canonical_target_page_ids(&request.target_page_ids),
        payload_digest: &payload_digest.to_canonical_string(),
        revision,
        graph_revision,
    };
    canonicalize(&identity)
        .map(|(_, digest)| digest.to_canonical_string())
        .map_err(|_| {
            HostIngressPremiseError::InvalidExternalId(
                "premise identity failed canonicalization".into(),
            )
        })
}

/// The canonical JSON record the operation digest is computed over.
#[derive(Serialize)]
struct OperationIdentity<'a> {
    schema: &'static str,
    owner: &'a str,
    source: SourceIdentity<'a>,
    external_event_id: &'a str,
    kind: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    references_external_event_id: Option<&'a str>,
    target_page_ids: &'a [String],
    payload_digest: &'a str,
    revision: i64,
    graph_revision: i64,
}

#[derive(Serialize)]
struct SourceIdentity<'a> {
    extension_id: &'a str,
    module_id: &'a str,
    instance_id: &'a str,
    generation: u64,
}

/// Build the reducer `Ingress` command the storage seam commits the premise
/// as. The `block_id` is a freshly allocated identity, never caller-supplied;
/// the command identity is deterministic from the ingress key so a replay
/// under the same key reuses the same Core operation.
pub fn build_ingress_command(
    identity: &IngressIdentity,
    block_id: &BlockId,
    runtime_source: &str,
    request: &HostIngressSubmitRequest,
) -> CoreCommand {
    let block = serde_json::to_value(&request.payload)
        .expect("a canonical payload always serializes to a JSON value");
    CoreCommand::Ingress(IngressCommand {
        command_id: format!("host-ingress-{}", identity.key),
        runtime_source: runtime_source.to_owned(),
        ingress_key: identity.key.to_string(),
        operation_digest: identity.operation_digest.clone(),
        block_id: block_id.to_string(),
        block,
        pages: identity.canonical_target_page_ids.clone(),
    })
}

fn validate_principal(
    owner: &str,
    extension_id: &str,
    module_id: &str,
    instance_id: &str,
    generation: u64,
    revision: i64,
    graph_revision: i64,
) -> Result<(), HostIngressPremiseError> {
    for (value, name) in [
        (owner, "owner"),
        (extension_id, "extension_id"),
        (module_id, "module_id"),
        (instance_id, "instance_id"),
    ] {
        validate_text(value, MAX_HOST_INGRESS_PRINCIPAL_TEXT_BYTES, name)
            .map_err(HostIngressPremiseError::InvalidExternalId)?;
    }
    if generation == 0 || generation > MAX_HOST_INGRESS_REVISION as u64 {
        return Err(HostIngressPremiseError::InvalidExternalId(
            "principal generation is out of the positive fence range".into(),
        ));
    }
    if !(1..=MAX_HOST_INGRESS_REVISION).contains(&revision) {
        return Err(HostIngressPremiseError::InvalidExternalId(
            "principal revision is out of the positive fence range".into(),
        ));
    }
    if !(1..=MAX_HOST_INGRESS_REVISION).contains(&graph_revision) {
        return Err(HostIngressPremiseError::InvalidExternalId(
            "principal graph revision is out of the positive fence range".into(),
        ));
    }
    Ok(())
}

fn validate_text(value: &str, max_bytes: usize, name: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("ingress premise {name} must not be empty"));
    }
    if value.len() > max_bytes {
        return Err(format!("ingress premise {name} exceeds {max_bytes} bytes"));
    }
    if value.chars().any(|character| character.is_control()) {
        return Err(format!(
            "ingress premise {name} must not contain control characters"
        ));
    }
    Ok(())
}
