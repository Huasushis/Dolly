//! Durable Host ingress submit/status seam types.
//!
//! This module defines the generic, transport-agnostic data of the boundary
//! through which an already authenticated inbound event reaches Core:
//! [`HostIngressSubmitRequest`] carries only the event content a caller may
//! supply, and the committed [`HostIngressMapping`] is the durable authority
//! returned by `status`. The seam never authenticates a transport and never
//! accepts an authority claim from a caller: owner, source Extension/Module/
//! instance, generation, revision, and graph revision are derived inside the
//! storage transaction from the opaque current Host authority and capability
//! grant, which have no public constructor, clone, or deserializer.
//!
//! Terminology (plain-language definitions):
//!
//! - *ingress key* — the idempotency namespace for one (owner, source,
//!   external event) triple; reusing an external event id in another owner or
//!   source can never collide, and `status` only ever derives the key of the
//!   calling principal.
//! - *operation digest* — the canonical identity of one submission: it binds
//!   the authority-bound generation/revision/graph revision, the ordered
//!   target Pages, the content digest, the edit/delete relation, and the
//!   lifecycle kind. Two submissions with the same key and the same digest
//!   are the same operation; the same key with a different digest is an
//!   idempotency conflict that changes nothing.
//! - *mapping* — the durable record binding one ingress key to the Core
//!   effect committed for it (minted identities, Block, deliveries).

use serde::{Deserialize, Serialize};

use crate::identifiers::PageId;

/// The physical schema version of the durable Host ingress slice.
pub const HOST_INGRESS_SCHEMA_VERSION: i64 = 1;

/// The closed record discriminator of one committed ingress mapping.
pub const HOST_INGRESS_RECORD_SCHEMA: &str = "dolly.host-ingress-mapping/v1";

/// The closed record discriminator of one persisted authenticated premise.
pub const HOST_INGRESS_PREMISE_RECORD_SCHEMA: &str = "dolly.host-ingress-premise/v1";

/// The capability-grant method every ingress submit MUST be authorized for.
pub const HOST_INGRESS_SUBMIT_METHOD: &str = "host.ingress.submit";

/// Upper bound (bytes) for an external event identity or its edit/delete
/// reference.
pub const MAX_HOST_INGRESS_ID_TEXT_BYTES: usize = 512;

/// Upper bound (bytes) for authority-bound principal text passed into the
/// pure identity derivation (the store never lets a caller choose any of
/// these values).
pub const MAX_HOST_INGRESS_PRINCIPAL_TEXT_BYTES: usize = 256;

/// Upper bound for the ordered target-Page list of one request.
pub const MAX_HOST_INGRESS_TARGET_PAGES: usize = 64;

/// Upper bound (bytes) for the canonicalized content payload of one request.
/// Enforced before any durable mutation so a premise can never grow the
/// durable slice without bound.
pub const MAX_HOST_INGRESS_PAYLOAD_JCS_BYTES: usize = 512 * 1024;

/// Upper bound for the positive incarnation/generation fences stored with a
/// premise.
pub const MAX_HOST_INGRESS_REVISION: i64 = 9_007_199_254_740_991;

/// The lifecycle kind of one inbound event.
///
/// `message` creates a new event, `edit` and `delete` change an earlier event
/// and MUST name it through `references_external_event_id`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostIngressKind {
    Message,
    Edit,
    Delete,
}

impl HostIngressKind {
    /// The canonical wire spelling used in the operation identity and the
    /// durable mapping.
    pub fn as_str(self) -> &'static str {
        match self {
            HostIngressKind::Message => "message",
            HostIngressKind::Edit => "edit",
            HostIngressKind::Delete => "delete",
        }
    }
}

/// The caller-supplied event content of one `host.ingress.submit` call.
///
/// This is the ONLY part of a premise the caller may choose. Owner, source
/// Extension/Module/instance, generation, revision, and graph revision are
/// never fields of this request: the storage transaction derives them from
/// the opaque current Host authority and capability grant, so a caller cannot
/// copy arbitrary identity, fence, or authority values into durable state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostIngressSubmitRequest {
    /// The transport-assigned identity of the external message or event.
    pub external_event_id: String,
    /// Lifecycle kind of the event.
    pub kind: HostIngressKind,
    /// For `edit`/`delete` events, the external event identity this event
    /// changes; MUST be present exactly for those kinds, and the transaction
    /// MUST find the referenced event already committed by the same
    /// principal.
    pub references_external_event_id: Option<String>,
    /// The ordered target Pages the committed Block is delivered to. Order is
    /// part of the operation identity; the transaction validates every page
    /// against the installed graph's producer direction for the module.
    pub target_page_ids: Vec<PageId>,
    /// The exact content payload (a canonical JSON document) committed as a
    /// Core Block.
    pub payload: dolly_canonical_json::CanonicalJsonValue,
}

/// The caller-supplied lookup of one `host.ingress.status` call.
///
/// Status derives the ingress key from the calling principal's opaque
/// authority/grant plus this external event identity, so it can never
/// disclose another owner, source, or payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostIngressStatusRequest {
    /// The external event identity whose mapping is looked up.
    pub external_event_id: String,
}

/// The opaque ingress key: the canonical idempotency namespace of one
/// (owner, source, external event) triple.
///
/// The key text is a `sha256:` digest so it can be stored, compared, and
/// indexed without ambiguity; it carries no readable identity and never
/// leaks the owner or source backward.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HostIngressKey(String);

impl HostIngressKey {
    /// Build a key from its canonical `sha256:` text, rejecting any other
    /// spelling.
    pub fn from_text(text: String) -> Result<Self, String> {
        if is_sha256_digest_text(&text) {
            Ok(Self(text))
        } else {
            Err("ingress key must be a sha256: digest".into())
        }
    }

    /// The canonical `sha256:` text of the key.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for HostIngressKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::str::FromStr for HostIngressKey {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::from_text(s.to_owned())
    }
}

/// One delivery produced by a committed ingress mapping.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IngressDelivery {
    /// The target Page the committed Block was delivered to.
    pub page_id: String,
    /// The instance-global commit sequence of that delivery.
    pub commit_seq: i64,
}

/// The closed, committed mapping record returned by the seam and stored as
/// its single authoritative canonical bytes.
///
/// Every identity field is either authority-bound (derived inside the
/// storage transaction from the opaque current Host grant/authority) or
/// event content the caller supplied; the record itself is output only and
/// never accepted as input.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostIngressMapping {
    /// The closed record discriminator; MUST equal
    /// [`HOST_INGRESS_RECORD_SCHEMA`].
    pub schema: String,
    /// The ingress key the mapping was committed under.
    pub ingress_key: String,
    /// The operation digest of the submitted premise.
    pub operation_digest: String,
    /// The authenticated principal (Host connection identity) — authority-bound.
    pub owner: String,
    /// The granted Extension identity — authority-bound.
    pub extension_id: String,
    /// The granted Module identity — authority-bound.
    pub module_id: String,
    /// The granted instance identity (Host worker epoch) — authority-bound.
    pub instance_id: String,
    /// The current grant's Extension generation — authority-bound.
    pub generation: i64,
    /// The current Host incarnation revision — authority-bound.
    pub revision: i64,
    /// The current grant's graph revision — authority-bound.
    pub graph_revision: i64,
    /// The external event identity (event content).
    pub external_event_id: String,
    /// Lifecycle kind (`message`, `edit`, `delete`) (event content).
    pub kind: String,
    /// The referenced original event for `edit`/`delete`, when present
    /// (event content).
    pub references_external_event_id: Option<String>,
    /// The canonical ordered target Pages (duplicates collapsed) (event
    /// content).
    pub target_page_ids: Vec<String>,
    /// The exact content payload committed as the Core Block (event content).
    pub payload: dolly_canonical_json::CanonicalJsonValue,
    /// Digest of the canonical payload bytes.
    pub payload_digest: String,
    /// The freshly allocated Core ingress identity.
    pub ingress_id: String,
    /// The freshly allocated Core Block identity.
    pub block_id: String,
    /// The exact per-Page deliveries produced by the Core effect.
    pub deliveries: Vec<IngressDelivery>,
    /// The Core reducer command identity the effect ran as.
    pub command_id: String,
}

/// The result of one `host.ingress.status` call.
#[derive(Debug, Clone, PartialEq)]
pub enum HostIngressStatus {
    /// Authoritative absence: only this state permits replaying a
    /// byte-identical submission. Absence is cross-checked against the Core
    /// operation/effect ledger, so a deleted or lost mapping can never masquerade
    /// as `absent`.
    Absent,
    /// A committed mapping exists for the key. The mapping is boxed so the
    /// seam never copies a multi-hundred-kilobyte record on the stack.
    Committed(Box<HostIngressMapping>),
}

/// The outcome of one `host.ingress.submit` call.
#[derive(Debug, Clone, PartialEq)]
pub enum HostIngressSubmitOutcome {
    /// The premise was committed; `idempotent` distinguishes a replay of a
    /// prior mapping from a first commit. Either way the returned mapping is
    /// the durable authority for the key.
    Committed {
        mapping: Box<HostIngressMapping>,
        idempotent: bool,
    },
    /// The same ingress key was already committed under a different operation
    /// digest. Nothing was mutated; reconcile through `status` and do not
    /// resubmit blindly.
    Conflict {
        key: HostIngressKey,
        stored_digest: String,
        submitted_digest: String,
    },
}

/// Typed failure codes of the durable Host ingress seam.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostIngressErrorCode {
    /// The durable mapping or its Core effect failed verification.
    Corrupt,
    /// The durable Host ingress schema is missing or stale.
    MigrationRequired,
    /// Storage was busy; the call is retryable.
    Busy,
    /// Durable capacity was exhausted.
    Full,
    /// The submitted event content failed structural validation.
    PremiseInvalid,
    /// The content payload exceeded the canonical byte ceiling.
    PremiseTooLarge,
    /// The principal is not authorized: no current grant for the module, the
    /// grant does not allow `host.ingress.submit`, or the passed authority is
    /// not the current Host authority.
    NotAuthorized,
    /// The caller's grant value (revision/digest) is no longer current.
    Stale,
    /// Core state was not ready (no installed graph revision, or the reducer
    /// refused the effect).
    NotReady,
    /// A target Page is not an authorized graph output of the module
    /// (direction violation).
    TargetNotAuthorized,
    /// An `edit`/`delete` references an event the same principal never
    /// committed.
    ReferencedEventMissing,
}

impl HostIngressErrorCode {
    /// The stable wire code spelling.
    pub fn code(self) -> &'static str {
        match self {
            HostIngressErrorCode::Corrupt => "HOST_INGRESS_CORRUPT",
            HostIngressErrorCode::MigrationRequired => "HOST_INGRESS_MIGRATION_REQUIRED",
            HostIngressErrorCode::Busy => "HOST_INGRESS_BUSY",
            HostIngressErrorCode::Full => "HOST_INGRESS_FULL",
            HostIngressErrorCode::PremiseInvalid => "HOST_INGRESS_PREMISE_INVALID",
            HostIngressErrorCode::PremiseTooLarge => "HOST_INGRESS_PREMISE_TOO_LARGE",
            HostIngressErrorCode::NotAuthorized => "HOST_INGRESS_NOT_AUTHORIZED",
            HostIngressErrorCode::Stale => "HOST_INGRESS_STALE",
            HostIngressErrorCode::NotReady => "HOST_INGRESS_NOT_READY",
            HostIngressErrorCode::TargetNotAuthorized => "HOST_INGRESS_TARGET_NOT_AUTHORIZED",
            HostIngressErrorCode::ReferencedEventMissing => "HOST_INGRESS_REFERENCED_EVENT_MISSING",
        }
    }
}

/// A typed failure with a stable code and a plain diagnostic message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostIngressError {
    code: HostIngressErrorCode,
    message: String,
}

impl HostIngressError {
    /// Create a typed failure.
    pub fn new(code: HostIngressErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// The stable failure code.
    pub fn code(&self) -> HostIngressErrorCode {
        self.code
    }

    /// A plain diagnostic message (never secret material).
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for HostIngressError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.code(), self.message)
    }
}

pub(crate) fn is_sha256_digest_text(text: &str) -> bool {
    let Some(hex) = text.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
