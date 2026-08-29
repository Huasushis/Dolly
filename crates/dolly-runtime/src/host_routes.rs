//! G4 Host method route registration — the shared wiring the integrator
//! binds the accepted Asset Host façade and the durable Channel inbound
//! receiver to one activated Extension Module.
//!
//! Direction is preserved end to end: an already Host-authorized request
//! (`host.asset.import`/`host.asset.status` capability held by a current,
//! unrevoked Host grant, or an authenticated Channel transport event sealed
//! under `host.ingress.submit`) becomes a durable ImportRecord/AVAILABLE
//! AssetRef or a durable Core ingress premise that a downstream consumer may
//! reference. Registration never mints a capability from free input, never
//! derives import authority from a Core Block, and never echoes or crosses
//! Extensions: every identity fact comes from the opaque sealed
//! [`HostConnectionAuthority`] and [`HostCapabilityGrant`], and every call
//! re-verifies the current durable authority/grant so rotation, revocation,
//! or replacement refuses before any effect.
//!
//! These routes are the seam the production daemon and the G4 conformance
//! routes both drive; the accepted Asset/Channel surfaces are used unchanged.

use dolly_asset::config::ResolvedAssetConfig;
use dolly_asset::facade::AssetHostFacade;
use dolly_asset::record::{ImportRequest, StatusResult};
use dolly_asset::service::AssetCapability;
use dolly_channel::config::{ChannelConfig, EXTENSION_ID};
use dolly_channel::receiver::{AuthenticatedChannelEvent, ChannelEventContent, InboundReceiver};
use dolly_channel::clock::Clock;
use dolly_storage::{
    HostCapabilityGrant, HostConnectionAuthority, SqliteCoreStore, SqliteHostIngressStore,
    StorageError,
};
use rusqlite::Connection;
use thiserror::Error;

/// A failure on a G4 Host method route. Every variant fails closed before any
/// Asset import, Host ingress submit, or Core effect.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum HostRouteError {
    #[error("HOST_ROUTE_CAPABILITY_DENIED: {detail}")]
    CapabilityDenied { detail: String },
    #[error("HOST_ROUTE_STALE_OR_REVOKED: {detail}")]
    StaleOrRevoked { detail: String },
    #[error("HOST_ROUTE_REJECTED: {code} {message}")]
    Rejected { code: String, message: String },
    #[error("HOST_ROUTE_TRANSACTION_REJECTED: {code}")]
    TransactionRejected { code: String },
    #[error(transparent)]
    Storage(#[from] StorageError),
}

fn capability_denied(detail: impl Into<String>) -> HostRouteError {
    HostRouteError::CapabilityDenied {
        detail: detail.into(),
    }
}

fn stale_or_revoked(detail: impl Into<String>) -> HostRouteError {
    HostRouteError::StaleOrRevoked {
        detail: detail.into(),
    }
}

/// The grant must belong to this authority's incarnation before any route
/// binds or uses it.
fn require_current(
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
) -> Result<(), HostRouteError> {
    if grant.extension_connection_id() != authority.extension_connection_id()
        || grant.worker_epoch() != authority.worker_epoch().as_str()
    {
        return Err(capability_denied(
            "the capability grant does not belong to the given Host authority",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// A — host.asset.import / host.asset.status through the accepted
// AssetHostFacade for one activated module.
// ---------------------------------------------------------------------------

/// The registered `host.asset.import` / `host.asset.status` route for one
/// activated Extension Module. The [`AssetCapability`] is derived inside from
/// sealed grant facts — module from the grant, instance from the authority
/// worker epoch, security domain from the authority extension connection
/// identity — so no caller can choose or mint a capability, and no Core Block
/// ever derives import authority.
pub struct AssetHostRoute<'runtime> {
    facade: AssetHostFacade,
    capability: AssetCapability,
    runtime: &'runtime mut Connection,
    extension_id: String,
    module_id: String,
    connection_id: String,
    worker_epoch: String,
    extension_generation: i64,
    grant_revision: i64,
    grant_digest: String,
    graph_revision: i64,
    graph_digest: String,
}

impl<'runtime> AssetHostRoute<'runtime> {
    /// Bind the Asset Host route to one activated module under the sealed
    /// current authority and grant. The grant must authorize
    /// `host.asset.import` and `host.asset.status`; the caller supplies only
    /// the fully resolved, validated Asset configuration (content root and
    /// bounds) for the module.
    pub fn for_activated_module(
        runtime: &'runtime mut Connection,
        config: ResolvedAssetConfig,
        authority: &HostConnectionAuthority,
        grant: &HostCapabilityGrant,
    ) -> Result<Self, HostRouteError> {
        require_current(authority, grant)?;
        if !grant.allows("host.asset.import") || !grant.allows("host.asset.status") {
            return Err(capability_denied(
                "the grant does not authorize host.asset.import/host.asset.status",
            ));
        }
        config.validate().map_err(|detail| {
            capability_denied(format!("asset config invalid: {detail}"))
        })?;
        let facade = AssetHostFacade::open(config).map_err(|error| {
            let envelope = error.to_envelope();
            HostRouteError::Rejected {
                code: envelope.code,
                message: envelope.message,
            }
        })?;
        let connection_id = authority.extension_connection_id().to_owned();
        let worker_epoch = authority.worker_epoch().to_string();
        let module_id = grant.module_id().to_owned();
        // The Asset wire contract names instances by a stable local
        // identifier (never a UUID); derive one deterministically from the
        // sealed worker epoch so no caller can choose or forge it.
        let instance_id = format!("i{worker_epoch}");
        if instance_id.parse::<dolly_core_domain::InstanceId>().is_err() {
            return Err(capability_denied(
                "sealed worker epoch cannot form a stable instance identifier",
            ));
        }
        let capability =
            facade.issue_capability(connection_id.clone(), instance_id, module_id.clone());
        Ok(Self {
            facade,
            capability,
            runtime,
            extension_id: grant.extension_id().to_owned(),
            module_id,
            connection_id,
            worker_epoch,
            extension_generation: grant.extension_generation(),
            grant_revision: grant.grant_revision(),
            grant_digest: grant.grant_digest().to_owned(),
            graph_revision: grant.graph_revision(),
            graph_digest: grant.graph_digest().to_owned(),
        })
    }

    /// Re-verify the durable current Host authority and capability grant
    /// against every fact this route was registered under. Rotation,
    /// revocation, or a replacement grant refuses here before any Asset
    /// effect, so a stale or revoked route can never import or disclose.
    pub fn revalidate(&mut self) -> Result<(), HostRouteError> {
        let store = SqliteCoreStore::new(self.runtime)?;
        let authority = store.authenticated_host_connection()?;
        let grant = store
            .current_host_capability_grant(&authority, &self.extension_id, &self.module_id)?
            .ok_or_else(|| stale_or_revoked("the capability grant is revoked or absent"))?;
        if grant.extension_connection_id() != self.connection_id
            || grant.worker_epoch() != self.worker_epoch
            || grant.extension_generation() != self.extension_generation
            || grant.grant_revision() != self.grant_revision
            || grant.grant_digest() != self.grant_digest
            || grant.graph_revision() != self.graph_revision
            || grant.graph_digest() != self.graph_digest
        {
            return Err(stale_or_revoked(
                "the current authority/grant no longer matches the registered route",
            ));
        }
        Ok(())
    }

    /// The granted module this route serves.
    pub fn module_id(&self) -> &str {
        &self.module_id
    }

    /// The granted instance (worker epoch) this route serves.
    pub fn instance_id(&self) -> &str {
        self.capability.instance_id()
    }

    /// Run (or replay) one `host.asset.import` under the bound capability.
    /// The request must name the granted module and instance; anything else
    /// is refused before the façade. Re-validates the current grant first.
    pub fn import(&mut self, request: &ImportRequest) -> Result<StatusResult, HostRouteError> {
        self.revalidate()?;
        if request.module_id != self.module_id || request.instance_id != self.instance_id() {
            return Err(capability_denied(
                "import request module/instance does not match the granted route",
            ));
        }
        self.facade.import(&self.capability, request).map_err(|envelope| {
            HostRouteError::Rejected {
                code: envelope.code,
                message: envelope.message,
            }
        })
    }

    /// Read one `host.asset.status` under the bound capability. Unknown and
    /// cross-owner ImportIds resolve to the closed authoritative `absent`
    /// status through the façade. Re-validates the current grant first.
    pub fn status(
        &mut self,
        request: &dolly_asset::facade::AssetStatusRequest,
    ) -> Result<StatusResult, HostRouteError> {
        self.revalidate()?;
        self.facade.status(&self.capability, request).map_err(|envelope| {
            HostRouteError::Rejected {
                code: envelope.code,
                message: envelope.message,
            }
        })
    }
}

// ---------------------------------------------------------------------------
// C — durable Channel inbound route (`org.dolly.channel`) over the sealed
// Host authority + `host.ingress.submit` grant: one runtime DB plus a
// module-scoped Channel store, events fed through the accepted
// InboundReceiver, status-first reconcile on activation/restart.
// ---------------------------------------------------------------------------

/// The authoritative `dolly.channel-store/v1` schema (owner singleton,
/// intent table, echo-marker table).
///
/// The accepted `dolly-channel` surface declares that production registration
/// owns schema installation; this is that installation. `SqliteChannelStore`
/// gate-verifies every table and column on open (normalized SQL compare), so
/// any drift from the accepted crate's authoritative schema fails closed
/// rather than being silently accepted.
const CHANNEL_STORE_SCHEMA_SQL: &str = r#"
CREATE TABLE channel_store_owner (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    schema_discriminator TEXT NOT NULL
        CHECK (schema_discriminator = 'dolly.channel-store/v1'),
    owner_jcs TEXT NOT NULL,
    owner_digest TEXT NOT NULL
);
CREATE TABLE channel_intent (
    intent_key TEXT PRIMARY KEY NOT NULL,
    record_digest TEXT NOT NULL,
    canonical_jcs BLOB NOT NULL
);
CREATE TABLE channel_echo (
    echo_key TEXT PRIMARY KEY NOT NULL,
    record_digest TEXT NOT NULL,
    canonical_jcs BLOB NOT NULL
)
"#;

/// Install the module-scoped Channel store schema on a fresh connection.
/// Idempotent per the `CREATE TABLE` semantics; a later
/// [`SqliteChannelStore`] open gate-verifies the exact schema.
pub fn install_channel_store_schema(connection: &mut Connection) -> Result<(), HostRouteError> {
    connection
        .execute_batch(CHANNEL_STORE_SCHEMA_SQL)
        .map_err(|error| HostRouteError::TransactionRejected {
            code: format!("channel store schema install failed: {error}"),
        })?;
    Ok(())
}

/// Seal one authenticated Channel transport event under the sealed current
/// authority and `host.ingress.submit` grant. Fails closed unless the grant
/// is current and authorizes `host.ingress.submit`; the accepted
/// [`AuthenticatedChannelEvent`] binds every authority/lifecycle fence.
pub fn authenticated_channel_event(
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
    config_revision: i64,
    event: ChannelEventContent,
) -> Result<AuthenticatedChannelEvent, HostRouteError> {
    require_current(authority, grant)?;
    if !grant.allows("host.ingress.submit") {
        return Err(capability_denied(
            "the grant does not authorize host.ingress.submit",
        ));
    }
    AuthenticatedChannelEvent::new(authority, grant, config_revision, event).map_err(
        |error| HostRouteError::Rejected {
            code: error.code,
            message: error.message,
        },
    )
}

/// Open the durable Channel inbound route for one activated
/// `org.dolly.channel` module under the sealed current authority and grant:
/// verifies the grant authorizes `host.ingress.submit`, binds the accepted
/// [`InboundReceiver`] over the real durable Host ingress slice and one
/// module-scoped Channel store connection, and derives the Channel principal
/// from the sealed authority/grant.
pub fn open_channel_inbound_route<'connection, 'principal>(
    runtime_connection: &'connection mut Connection,
    module_store_connection: &'connection mut Connection,
    config: ChannelConfig,
    clock: Box<dyn Clock>,
    authority: &'principal HostConnectionAuthority,
    grant: &'principal HostCapabilityGrant,
) -> Result<
    InboundReceiver<'connection, 'principal, SqliteHostIngressStore<'connection>>,
    HostRouteError,
> {
    require_current(authority, grant)?;
    if !grant.allows("host.ingress.submit") {
        return Err(capability_denied(
            "the grant does not authorize host.ingress.submit",
        ));
    }
    if grant.extension_id() != EXTENSION_ID {
        return Err(capability_denied(
            "the granted extension is not the built-in Channel extension",
        ));
    }
    let host = SqliteHostIngressStore::new(runtime_connection)?;
    InboundReceiver::new(config, clock, module_store_connection, host, authority, grant)
        .map_err(|error| HostRouteError::Rejected {
            code: error.code,
            message: error.message,
        })
}

/// Run status-first reconciliation on an activated `org.dolly.channel` module
/// (activation/restart hook). Reopens every durable `prepared` intent through
/// the accepted receiver, calling Host `status` first with the current sealed
/// authority; only an authoritative absent permits a byte-identical resubmit.
/// Returns the number of intents left unresolved.
pub fn reconcile_channel_inbound_route<'connection, 'principal>(
    runtime_connection: &'connection mut Connection,
    module_store_connection: &'connection mut Connection,
    config: ChannelConfig,
    clock: Box<dyn Clock>,
    authority: &'principal HostConnectionAuthority,
    grant: &'principal HostCapabilityGrant,
) -> Result<usize, HostRouteError> {
    let mut receiver = open_channel_inbound_route(
        runtime_connection,
        module_store_connection,
        config,
        clock,
        authority,
        grant,
    )?;
    receiver.reconcile().map_err(|error| HostRouteError::Rejected {
        code: error.code,
        message: error.message,
    })
}
