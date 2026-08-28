//! Pure Host ingress identity derivation and premise validation.
//!
//! This module owns the canonical identity of the durable Host ingress seam
//! without any storage: for an [`HostIngressPremise`] it derives the ingress
//! key (the (owner, source, external event) idempotency namespace) and the
//! operation digest, and it builds the reducer `Ingress` command the storage
//! seam commits the premise as.
//!
//! Identity rules (the spec the durable seam enforces):
//!
//! - The **ingress key** is a domain-separated SHA-256 over the owner, the
//!   source Extension/Module/instance, and the external event identity. A
//!   different owner or source is a different key, so cross-owner or
//!   cross-source reuses can never collide.
//! - The **operation digest** is the SHA-256 of the canonical JSON of a
//!   structured record binding the owner, source (with generation), external
//!   event identity, lifecycle kind, edit/delete relation, the *ordered*
//!   target-Page list, the content digest, and the revision. The target-Page
//!   list participates ordered with duplicates collapsed: any change to the
//!   ordered list — including reordering — changes the digest, while a list
//!   that differs only in duplicate entries is canonically equivalent and
//!   yields the same digest.
//! - A premise MUST carry the references identity exactly for `edit`/`delete`
//!   kinds, at least one target Page, a positive revision, and a content
//!   payload whose canonical bytes stay within the seam ceiling. Any
//!   violation rejects the premise before storage is touched.

use dolly_canonical_json::{Sha256Digest, canonicalize};
use dolly_core_domain::{
    BlockId, HostIngressKey, HostIngressKind, HostIngressPremise, PageId,
    MAX_HOST_INGRESS_ID_TEXT_BYTES, MAX_HOST_INGRESS_OWNER_BYTES,
    MAX_HOST_INGRESS_PAYLOAD_JCS_BYTES, MAX_HOST_INGRESS_REVISION,
    MAX_HOST_INGRESS_TARGET_PAGES,
};
use serde::Serialize;

use crate::command::{CoreCommand, IngressCommand};

/// Domain-separation prefix for the ingress-key derivation.
const INGRESS_KEY_PREFIX: &[u8] = b"dolly.host-ingress\0key\0";

/// A rejected premise, named by the failing rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostIngressPremiseError {
    /// The owner principal text is empty, oversized, or malformed.
    InvalidOwner(String),
    /// An external event identity (or its edit/delete reference) is empty,
    /// oversized, or malformed.
    InvalidExternalId(String),
    /// The lifecycle kind and its edit/delete reference disagree.
    InvalidRelation(String),
    /// The target-Page list is empty, oversized, or malformed.
    InvalidTargetPages(String),
    /// The revision fence is outside 1..=MAX_HOST_INGRESS_REVISION.
    InvalidRevision(i64),
    /// The canonical payload exceeds MAX_HOST_INGRESS_PAYLOAD_JCS_BYTES.
    PayloadTooLarge(usize),
}

impl std::fmt::Display for HostIngressPremiseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HostIngressPremiseError::InvalidOwner(message) => write!(f, "{message}"),
            HostIngressPremiseError::InvalidExternalId(message) => write!(f, "{message}"),
            HostIngressPremiseError::InvalidRelation(message) => write!(f, "{message}"),
            HostIngressPremiseError::InvalidTargetPages(message) => write!(f, "{message}"),
            HostIngressPremiseError::InvalidRevision(value) => {
                write!(f, "premise revision must be in 1..={MAX_HOST_INGRESS_REVISION}, got {value}")
            }
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
    /// the ordered target Pages.
    pub operation_digest: String,
    /// The canonical ordered target Pages (duplicates collapsed).
    pub canonical_target_page_ids: Vec<String>,
    /// SHA-256 of the canonical content payload bytes.
    pub payload_digest: String,
}

/// Collapse duplicate target Pages preserving first-occurrence order. Two
/// premises whose lists collapse to the same ordered list are canonically
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

/// Validate one already authenticated premise and derive its canonical
/// identity. Rejects the premise before any storage is touched.
pub fn derive_ingress_identity(
    premise: &HostIngressPremise,
) -> Result<IngressIdentity, HostIngressPremiseError> {
    validate_text(&premise.owner, MAX_HOST_INGRESS_OWNER_BYTES, "owner")
        .map_err(HostIngressPremiseError::InvalidOwner)?;
    validate_text(
        &premise.external_event_id,
        MAX_HOST_INGRESS_ID_TEXT_BYTES,
        "external_event_id",
    )
    .map_err(HostIngressPremiseError::InvalidExternalId)?;
    match (&premise.kind, &premise.references_external_event_id) {
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
    if premise.target_page_ids.is_empty() {
        return Err(HostIngressPremiseError::InvalidTargetPages(
            "premise must name at least one target Page".into(),
        ));
    }
    if premise.target_page_ids.len() > MAX_HOST_INGRESS_TARGET_PAGES {
        return Err(HostIngressPremiseError::InvalidTargetPages(format!(
            "premise names {} target Pages, ceiling is {MAX_HOST_INGRESS_TARGET_PAGES}",
            premise.target_page_ids.len()
        )));
    }
    if !(1..=MAX_HOST_INGRESS_REVISION).contains(&premise.revision) {
        return Err(HostIngressPremiseError::InvalidRevision(premise.revision));
    }
    let (payload_jcs, payload_digest) = canonicalize(&premise.payload)
        .map_err(|_| {
            HostIngressPremiseError::InvalidExternalId(
                "premise payload is not canonical JSON".into(),
            )
        })?;
    let payload_bytes = payload_jcs.as_bytes().len();
    if payload_bytes > MAX_HOST_INGRESS_PAYLOAD_JCS_BYTES {
        return Err(HostIngressPremiseError::PayloadTooLarge(payload_bytes));
    }
    let key = derive_ingress_key(premise);
    let operation_digest = derive_operation_digest(premise, &payload_digest)?;
    Ok(IngressIdentity {
        key,
        operation_digest,
        canonical_target_page_ids: canonical_target_page_ids(&premise.target_page_ids),
        payload_digest: payload_digest.to_canonical_string(),
    })
}

/// Derive the ingress key: a domain-separated SHA-256 over owner, source
/// Extension/Module/instance, and the external event identity.
pub fn derive_ingress_key(premise: &HostIngressPremise) -> HostIngressKey {
    let mut input = Vec::with_capacity(
        INGRESS_KEY_PREFIX.len()
            + premise.owner.len()
            + premise.source.extension_id.as_str().len()
            + premise.source.module_id.as_str().len()
            + premise.source.instance_id.as_str().len()
            + premise.external_event_id.len()
            + 5,
    );
    input.extend_from_slice(INGRESS_KEY_PREFIX);
    input.extend_from_slice(premise.owner.as_bytes());
    input.push(0);
    input.extend_from_slice(premise.source.extension_id.as_str().as_bytes());
    input.push(0);
    input.extend_from_slice(premise.source.module_id.as_str().as_bytes());
    input.push(0);
    input.extend_from_slice(premise.source.instance_id.as_str().as_bytes());
    input.push(0);
    input.extend_from_slice(premise.external_event_id.as_bytes());
    input.push(0);
    let digest = Sha256Digest::compute(&input).to_canonical_string();
    HostIngressKey::from_text(digest).expect("derived digest is a canonical sha256: text")
}

/// Derive the operation digest: SHA-256 of the canonical JSON record binding
/// every premise field and the ordered target-Page list.
fn derive_operation_digest(
    premise: &HostIngressPremise,
    payload_digest: &Sha256Digest,
) -> Result<String, HostIngressPremiseError> {
    let identity = OperationIdentity {
        schema: "dolly.host-ingress/operation/v1",
        owner: &premise.owner,
        source: SourceIdentity {
            extension_id: premise.source.extension_id.as_str(),
            module_id: premise.source.module_id.as_str(),
            instance_id: premise.source.instance_id.as_str(),
            generation: premise.source.generation.value(),
        },
        external_event_id: &premise.external_event_id,
        kind: premise.kind.as_str(),
        references_external_event_id: premise.references_external_event_id.as_deref(),
        target_page_ids: &canonical_target_page_ids(&premise.target_page_ids),
        payload_digest: &payload_digest.to_canonical_string(),
        revision: premise.revision,
    };
    canonicalize(&identity)
        .map(|(_, digest)| digest.to_canonical_string())
        .map_err(|_| {
            HostIngressPremiseError::InvalidOwner(
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
}

#[derive(Serialize)]
struct SourceIdentity<'a> {
    extension_id: &'a str,
    module_id: &'a str,
    instance_id: &'a str,
    generation: u64,
}

/// Build the reducer `Ingress` command the storage seam commits the premise
/// as. The `block_id` is a store-minted identity, never caller-supplied; the
/// command identity is deterministic from the ingress key so a replay under
/// the same key reuses the same Core operation.
pub fn build_ingress_command(
    identity: &IngressIdentity,
    block_id: &BlockId,
    premise: &HostIngressPremise,
) -> CoreCommand {
    let block = serde_json::to_value(&premise.payload)
        .expect("a canonical payload always serializes to a JSON value");
    let runtime_source = format!(
        "{}#{}#{}",
        premise.source.extension_id,
        premise.source.module_id,
        premise.source.instance_id
    );
    CoreCommand::Ingress(IngressCommand {
        command_id: format!("host-ingress-{}", identity.key),
        runtime_source,
        ingress_key: identity.key.to_string(),
        operation_digest: identity.operation_digest.clone(),
        block_id: block_id.to_string(),
        block,
        pages: identity.canonical_target_page_ids.clone(),
    })
}

fn validate_text(value: &str, max_bytes: usize, name: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("ingress premise {name} must not be empty"));
    }
    if value.len() > max_bytes {
        return Err(format!(
            "ingress premise {name} exceeds {max_bytes} bytes"
        ));
    }
    if value.chars().any(|character| character.is_control()) {
        return Err(format!(
            "ingress premise {name} must not contain control characters"
        ));
    }
    Ok(())
}
