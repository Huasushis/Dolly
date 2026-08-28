//! Durable Host ingress submit/status seam types.
//!
//! This module defines the generic, transport-agnostic boundary through which
//! an already authenticated inbound event reaches Core: [`HostIngressPremise`]
//! is the durable fact submitted through [`HostIngress::submit`], and
//! [`HostIngress::status`] reconciles a lost response against the committed
//! [`HostIngressMapping`] without resubmitting.
//!
//! The seam never authenticates a transport. Upstream (the Extension/module
//! authority) has already proven the source before a premise is constructed;
//! what this module owns is the canonical identity ([`HostIngressKey`] plus
//! the operation digest) that makes the boundary idempotent, and the closed
//! committed mapping record.
//!
//! Terminology (plain-language definitions):
//!
//! - *premise* — the authenticated source facts and content of one inbound
//!   event, established upstream before submission.
//! - *mapping* — the durable record binding one ingress key to the Core
//!   effect committed for it (Block, deliveries, minted identities).
//! - *ingress key* — the idempotency namespace for one (owner, source,
//!   external event) triple; reusing an external event id in another owner or
//!   source can never collide.
//! - *operation digest* — the canonical identity of one submission: it binds
//!   the key fields, the ordered target Pages, the content digest, the
//!   edit/delete relation, lifecycle, generation, and revision. Two
//!   submissions with the same key and the same digest are the same
//!   operation; the same key with a different digest is an idempotency
//!   conflict that changes nothing.

use serde::{Deserialize, Serialize};

use crate::identifiers::{ExtensionId, InstanceId, ModuleId, PageId};
use crate::numbers::ExtensionGeneration;

/// The physical schema version of the durable Host ingress slice.
pub const HOST_INGRESS_SCHEMA_VERSION: i64 = 1;

/// The closed record discriminator for one committed ingress mapping.
pub const HOST_INGRESS_RECORD_SCHEMA: &str = "dolly.host-ingress-mapping/v1";

/// Upper bound (bytes) for the authenticated owner principal text.
pub const MAX_HOST_INGRESS_OWNER_BYTES: usize = 256;

/// Upper bound (bytes) for an external event identity or its edit/delete
/// reference.
pub const MAX_HOST_INGRESS_ID_TEXT_BYTES: usize = 512;

/// Upper bound for the ordered target-Page list of one premise.
pub const MAX_HOST_INGRESS_TARGET_PAGES: usize = 64;

/// Upper bound (bytes) for the canonicalized content payload of one premise.
/// Enforced before any durable mutation so a premise can never grow the
/// durable slice without bound.
pub const MAX_HOST_INGRESS_PAYLOAD_JCS_BYTES: usize = 512 * 1024;

/// Upper bound for the premise revision fence.
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

/// The authenticated source of one inbound event.
///
/// All three identities plus the generation fence are bound into the ingress
/// key and the operation digest, so one Extension/Module/instance can never
/// observe or collide with another source's mapping.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostIngressSource {
    /// The owning Extension identity (reverse-DNS, at least three labels).
    pub extension_id: ExtensionId,
    /// The claiming Module identity inside that Extension.
    pub module_id: ModuleId,
    /// The Module installation instance identity.
    pub instance_id: InstanceId,
    /// The authenticated Extension generation fence of the source.
    pub generation: ExtensionGeneration,
}

/// One already authenticated inbound premise submitted through the durable
/// Host ingress seam.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostIngressPremise {
    /// The authenticated owner principal of the event (for example the
    /// transport account). Part of the ingress key, never itself verified
    /// here.
    pub owner: String,
    /// The authenticated source Extension/Module/instance and generation.
    pub source: HostIngressSource,
    /// The transport-assigned identity of the external message or event.
    pub external_event_id: String,
    /// Lifecycle kind of the event.
    pub kind: HostIngressKind,
    /// For `edit`/`delete` events, the external event identity this event
    /// changes; MUST be present exactly for those kinds.
    pub references_external_event_id: Option<String>,
    /// The ordered target Pages the committed Block is delivered to. Order is
    /// part of the operation identity.
    pub target_page_ids: Vec<PageId>,
    /// The exact content payload (a canonical JSON document) committed as a
    /// Core Block.
    pub payload: dolly_canonical_json::CanonicalJsonValue,
    /// The positive revision fence of this premise (for example an edit
    /// counter). Part of the operation identity.
    pub revision: i64,
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostIngressMapping {
    /// The closed record discriminator; MUST equal
    /// [`HOST_INGRESS_RECORD_SCHEMA`].
    pub schema: String,
    /// The ingress key the mapping was committed under.
    pub ingress_key: String,
    /// The operation digest of the submitted premise.
    pub operation_digest: String,
    /// The authenticated owner principal of the event.
    pub owner: String,
    /// The authenticated source identities and generation fence.
    pub extension_id: String,
    pub module_id: String,
    pub instance_id: String,
    pub generation: i64,
    /// The external event identity.
    pub external_event_id: String,
    /// Lifecycle kind (`message`, `edit`, `delete`).
    pub kind: String,
    /// The referenced original event for `edit`/`delete`, when present.
    pub references_external_event_id: Option<String>,
    /// The canonical ordered target Pages (duplicates collapsed).
    pub target_page_ids: Vec<String>,
    /// The exact content payload committed as the Core Block.
    pub payload: dolly_canonical_json::CanonicalJsonValue,
    /// Digest of the canonical payload bytes.
    pub payload_digest: String,
    /// The premise revision fence.
    pub revision: i64,
    /// The store-minted Core ingress identity.
    pub ingress_id: String,
    /// The store-minted Core Block identity.
    pub block_id: String,
    /// The graph revision the effect committed against.
    pub graph_revision: i64,
    /// The exact per-Page deliveries produced by the Core effect.
    pub deliveries: Vec<IngressDelivery>,
    /// The Core reducer command identity the effect ran as.
    pub command_id: String,
}

/// The result of one [`HostIngress::status`] call.
#[derive(Debug, Clone, PartialEq)]
pub enum HostIngressStatus {
    /// Authoritative absence: only this state permits replaying a
    /// byte-identical submission.
    Absent,
    /// A committed mapping exists for the key. The mapping is boxed so the
    /// seam never copies a multi-hundred-kilobyte record on the stack.
    Committed(Box<HostIngressMapping>),
}

/// The outcome of one [`HostIngress::submit`] call.
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
    /// The durable mapping failed verification (corrupt bytes or columns).
    Corrupt,
    /// The durable Host ingress schema is missing or stale.
    MigrationRequired,
    /// Storage was busy; the call is retryable.
    Busy,
    /// Durable capacity was exhausted.
    Full,
    /// The submitted premise failed structural validation.
    PremiseInvalid,
    /// The content payload exceeded the canonical byte ceiling.
    PremiseTooLarge,
    /// Core state was not ready to accept an effect (for example no graph
    /// installed, or recovery required).
    NotReady,
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
            HostIngressErrorCode::NotReady => "HOST_INGRESS_NOT_READY",
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

/// The minimal stable generic submit/status interface of the durable Host
/// ingress seam, consumed by the later Channel inbound lane.
///
/// Implementations run inside the one authoritative Runtime database and
/// guarantee: a submit either commits the exact premise/mapping and its Core
/// effect atomically, replays it idempotently, or rejects it with zero
/// additional mutation; a status read is the only reconciliation authority
/// for a lost submit response.
pub trait HostIngress {
    /// Durably submit one already authenticated premise and commit its Core
    /// effect. A prior mapping under the same key with the same operation
    /// digest is returned unchanged (idempotent); a prior mapping under a
    /// different digest is rejected as a conflict without mutation.
    fn submit(
        &mut self,
        premise: &HostIngressPremise,
    ) -> Result<HostIngressSubmitOutcome, HostIngressError>;

    /// Return the committed mapping for a key, or authoritative absence.
    fn status(&mut self, key: &HostIngressKey)
        -> Result<HostIngressStatus, HostIngressError>;
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
