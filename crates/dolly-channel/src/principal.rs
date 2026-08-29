//! Channel principal: the authority-bound identity of one inbound event.
//!
//! The Channel never accepts an identity claim from a transport event or a
//! free configuration. Every authoritative fact of an inbound premise —
//! owner (Host connection identity), granted Extension, granted Module, the
//! worker epoch (instance), and the complete lifecycle fences (Extension
//! generation, Host incarnation revision, graph revision) — is derived here
//! from the opaque current [`HostConnectionAuthority`] and
//! [`HostCapabilityGrant`], the same sealed types the durable Host ingress
//! seam re-verifies inside its own transaction. The deterministic
//! [`ChannelPrincipal::account`] is the Channel-local deduplication namespace
//! of that principal, so no caller can forge an account, and
//! [`InboundReceiver`] refuses any event whose bound account does not match
//! the current principal's account before any replay or acknowledgement.

use dolly_storage::{HostCapabilityGrant, HostConnectionAuthority};

use crate::config::EXTENSION_ID;
use crate::error::{ChannelError, ChannelOutcome, codes};
use crate::ids::channel_account;

/// The exact authority/lifecycle ceiling the rust-Core reducer binds.
const MAX_CHANNEL_REVISION: i64 = 9_007_199_254_740_991;

/// The sealed-principal identity of the Channel inbound path.
///
/// Fields are authority-bound: the only constructor takes the opaque current
/// Host authority and capability grant held by the upstream registration
/// adapter, so a caller can neither choose nor forge any of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelPrincipal {
    owner: String,
    extension_id: String,
    module_id: String,
    instance_id: String,
    generation: u64,
    revision: i64,
    graph_revision: i64,
    account: String,
}

impl ChannelPrincipal {
    /// Derive the principal from the opaque current Host authority and
    /// capability grant, and fail closed when the grant does not belong to
    /// the given authority's incarnation or when any fence is out of range.
    pub fn from_authority_grant(
        authority: &HostConnectionAuthority,
        grant: &HostCapabilityGrant,
    ) -> Result<Self, ChannelError> {
        let invalid = |message: &str| {
            ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                message,
            )
        };
        // The grant and the authority must name the same incarnation.
        if grant.extension_connection_id() != authority.extension_connection_id()
            || grant.worker_epoch() != authority.worker_epoch().as_str()
        {
            return Err(invalid(
                "the capability grant does not belong to the given Host authority",
            ));
        }
        let extension_id = grant.extension_id().to_owned();
        if extension_id != EXTENSION_ID {
            return Err(invalid(&format!(
                "granted extension {extension_id} is not the built-in Channel extension {EXTENSION_ID}"
            )));
        }
        let module_id = grant.module_id().to_owned();
        if module_id.is_empty() {
            return Err(invalid("granted module identity is empty"));
        }
        let owner = authority.extension_connection_id().to_owned();
        let instance_id = authority.worker_epoch().to_string();
        let generation = grant.extension_generation();
        let revision = authority.incarnation_revision();
        let graph_revision = grant.graph_revision();
        for (value, name) in [
            (&owner, "owner"),
            (&extension_id, "extension"),
            (&module_id, "module"),
            (&instance_id, "instance"),
        ] {
            if value.is_empty()
                || value.len() > 256
                || value.chars().any(|character| character.is_control())
            {
                return Err(invalid(&format!(
                    "authenticated principal {name} is malformed"
                )));
            }
        }
        if !(1..=MAX_CHANNEL_REVISION).contains(&generation)
            || !(1..=MAX_CHANNEL_REVISION).contains(&revision)
            || !(1..=MAX_CHANNEL_REVISION).contains(&graph_revision)
        {
            return Err(invalid("authenticated principal fences are out of range"));
        }
        let account = channel_account(&owner, &extension_id, &module_id, &instance_id);
        Ok(Self {
            owner,
            extension_id,
            module_id,
            instance_id,
            generation: generation as u64,
            revision,
            graph_revision,
            account,
        })
    }

    /// The authority-bound owner (Host connection identity).
    pub fn owner(&self) -> &str {
        &self.owner
    }

    /// The granted Extension identity (must equal `org.dolly.channel`).
    pub fn extension_id(&self) -> &str {
        &self.extension_id
    }

    /// The granted Module identity.
    pub fn module_id(&self) -> &str {
        &self.module_id
    }

    /// The granted instance identity (Host worker epoch).
    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    /// The granted Extension generation fence.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// The current Host incarnation revision fence.
    pub fn revision(&self) -> i64 {
        self.revision
    }

    /// The granted graph revision fence.
    pub fn graph_revision(&self) -> i64 {
        self.graph_revision
    }

    /// The deterministic Channel account of this principal: the root of the
    /// Channel deduplication namespace, a pure function of the sealed
    /// authority and grant.
    pub fn account(&self) -> &str {
        &self.account
    }
}
