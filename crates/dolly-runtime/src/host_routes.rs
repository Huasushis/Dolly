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
);
CREATE TABLE channel_outbound (
    outbound_key TEXT PRIMARY KEY NOT NULL,
    record_digest TEXT NOT NULL,
    canonical_jcs BLOB NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared','queued','dispatched','confirmed','partial','failed','unknown')),
    session_id TEXT NOT NULL,
    queued_seq INTEGER
);
CREATE TABLE channel_outbound_admission (
    ticket INTEGER PRIMARY KEY AUTOINCREMENT,
    outbound_key TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    deadline_micros INTEGER NOT NULL,
    piece_count INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('waiting','cancelled','expired','granted'))
);
CREATE TABLE channel_outbound_rate (
    session_id TEXT PRIMARY KEY NOT NULL,
    tokens INTEGER NOT NULL,
    last_refill_micros INTEGER NOT NULL
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

// ---------------------------------------------------------------------------
// D — committed targeted-Action outbound route (seam D): one identity-bound
// OutboundQueueGate + per-session limiter owned by the registration and
// injected into the sealed OutboundConsumer, with a bounded status-first
// consumer/recovery loop over an injected status-capable transport.
// ---------------------------------------------------------------------------

use dolly_channel::outbound_consumer::{ConsumerOutcome, OutboundConsumer};
use dolly_channel::outbound_queue::OutboundQueueGate;
use dolly_channel::transport::ChannelTransport;

/// The result of one bounded runtime consumer/recovery pass.
#[derive(Debug, Clone, PartialEq)]
pub struct ChannelOutboundRunReport {
    /// The number of Actions admitted and dispatched to the transport.
    pub transported: usize,
    /// Deterministic rejections (authority, conflict, validation, rate or
    /// queue backpressure) with no transport effect and no leaked slot.
    pub rejected: usize,
    /// The rejection error codes observed this pass.
    pub rejected_codes: Vec<String>,
    /// Outcomes still awaiting a terminal transport observation.
    pub pending: usize,
    /// The number of Actions left unresolved (pending/unknown) after
    /// status-first reconcile; zero means the pass drained cleanly.
    pub remaining: usize,
    /// Terminal outcomes produced this pass (frozen ActionResult envelopes).
    pub terminal: Vec<ConsumerOutcome>,
}

fn channel_error(code: String, message: String) -> HostRouteError {
    HostRouteError::Rejected { code, message }
}

/// The registered outbound route for one activated `org.dolly.channel` module.
///
/// Registration owns EXACTLY ONE identity-bound [`OutboundQueueGate`] plus its
/// per-session limiters for the store/account/config identity
/// (`OutboundQueueGate::register` returns the same live `Arc` for repeated
/// registration of the same identity, so no consumer-created gate ever
/// exists). Every consumer opened by this route receives that gate, the
/// injected status-capable transport, and the sealed current Host authority
/// and grant; the runtime consumer/recovery loop is bounded and fail-closed —
/// it selects committed targeted Actions from the journal-verified Core
/// snapshot only, never from caller blocks, never retained upstream premises,
/// and never blind-resends.
pub struct ChannelOutboundRoute<'principal> {
    config: ChannelConfig,
    gate: std::sync::Arc<OutboundQueueGate>,
    authority: &'principal HostConnectionAuthority,
    grant: &'principal HostCapabilityGrant,
}

impl<'principal> ChannelOutboundRoute<'principal> {
    /// Register (or reuse) the one identity-bound outbound gate for the
    /// Channel store/account/config identity under the sealed current
    /// authority and grant. The module-scoped store connection must already
    /// carry the synchronized `dolly.channel-store/v1` schema.
    pub fn register(
        config: ChannelConfig,
        module_connection: &mut Connection,
        authority: &'principal HostConnectionAuthority,
        grant: &'principal HostCapabilityGrant,
    ) -> Result<Self, HostRouteError> {
        require_current(authority, grant)?;
        if grant.extension_id() != EXTENSION_ID {
            return Err(capability_denied(
                "the granted extension is not the built-in Channel extension",
            ));
        }
        let gate = OutboundQueueGate::register(&config, module_connection, authority, grant)
            .map_err(|error| channel_error(error.code, error.message))?;
        Ok(Self {
            config,
            gate,
            authority,
            grant,
        })
    }

    /// The single shared gate for this store identity (registered above).
    pub fn gate(&self) -> std::sync::Arc<OutboundQueueGate> {
        std::sync::Arc::clone(&self.gate)
    }

    /// Open the sealed [`OutboundConsumer`] injecting exactly this gate and
    /// the supplied status-capable transport. The consumer re-verifies the
    /// gate identity and the fresh current grant on every consume pass.
    pub fn open<'store, 'core>(
        &self,
        module_connection: &'store mut Connection,
        runtime_connection: &'core mut Connection,
        clock: Box<dyn Clock>,
        transport: Box<dyn ChannelTransport>,
    ) -> Result<OutboundConsumer<'store, 'core, 'principal>, HostRouteError> {
        OutboundConsumer::new(
            self.config.clone(),
            clock,
            module_connection,
            runtime_connection,
            self.gate.clone(),
            transport,
            self.authority,
            self.grant,
        )
        .map_err(|error| channel_error(error.code, error.message))
    }

    /// One bounded consumer pass: admit and dispatch every committed targeted
    /// Action up to the caller deadline, then settle `Dispatched` rows
    /// status-first through the transport. Fail-closed on error (no partial
    /// acknowledgement).
    pub fn consume_once<'store, 'core>(
        &self,
        module_connection: &'store mut Connection,
        runtime_connection: &'core mut Connection,
        clock: Box<dyn Clock>,
        transport: Box<dyn ChannelTransport>,
        caller_deadline: &str,
    ) -> Result<ChannelOutboundRunReport, HostRouteError> {
        let mut consumer = self.open(
            module_connection,
            runtime_connection,
            clock,
            transport,
        )?;
        let outcomes = consumer
            .consume(caller_deadline)
            .map_err(|error| channel_error(error.code, error.message))?;
        let terminal: Vec<ConsumerOutcome> = outcomes
            .iter()
            .filter(|outcome| matches!(outcome, ConsumerOutcome::Terminal { .. }))
            .cloned()
            .collect();
        let outcomes_other: Vec<ConsumerOutcome> = outcomes
            .into_iter()
            .filter(|outcome| !matches!(outcome, ConsumerOutcome::Terminal { .. }))
            .collect();
        let transported = terminal.len();
        let rejected = outcomes_other
            .iter()
            .filter(|outcome| matches!(outcome, ConsumerOutcome::Rejected { .. }))
            .count();
        let rejected_codes: Vec<String> = outcomes_other
            .iter()
            .filter_map(|outcome| match outcome {
                ConsumerOutcome::Rejected { error, .. } => Some(error.code.clone()),
                _ => None,
            })
            .collect();
        let pending = outcomes_other
            .iter()
            .filter(|outcome| matches!(outcome, ConsumerOutcome::Pending { .. }))
            .count();
        let remaining = consumer
            .reconcile()
            .map_err(|error| channel_error(error.code, error.message))?;
        Ok(ChannelOutboundRunReport {
            transported,
            rejected,
            rejected_codes,
            pending,
            remaining,
            terminal,
        })
    }

    /// The bounded runtime consumer/recovery loop: drain until no committed
    /// targeted Action remains or `max_passes` is reached (a caller deadline
    /// bounds each pass, so a stuck transport cannot hold the loop forever),
    /// then a final status-first reconcile. Every durable decision is the
    /// accepted store's; errors abort the loop fail-closed.
    pub fn run_loop<'store, 'core>(
        &self,
        module_connection: &'store mut Connection,
        runtime_connection: &'core mut Connection,
        clock: Box<dyn Clock>,
        transport: Box<dyn ChannelTransport>,
        caller_deadline: &str,
        max_passes: usize,
    ) -> Result<ChannelOutboundRunReport, HostRouteError> {
        let mut consumer = self.open(
            module_connection,
            runtime_connection,
            clock,
            transport,
        )?;
        let mut transported = 0usize;
        let mut rejected = 0usize;
        let mut pending = 0usize;
        let mut rejected_codes = Vec::new();
        let mut remaining = 0usize;
        let mut terminal = Vec::new();
        for _ in 0..max_passes {
            let outcomes = consumer
                .consume(caller_deadline)
                .map_err(|error| channel_error(error.code, error.message))?;
            if outcomes.is_empty() {
                break;
            }
            for outcome in outcomes {
                match outcome {
                    ConsumerOutcome::Terminal { .. } => {
                        transported += 1;
                        terminal.push(outcome);
                    }
                    ConsumerOutcome::Rejected { error, .. } => {
                        rejected += 1;
                        rejected_codes.push(error.code.clone());
                    }
                    ConsumerOutcome::Pending { .. } => pending += 1,
                }
            }
        }
        remaining = consumer
            .reconcile()
            .map_err(|error| channel_error(error.code, error.message))?;
        Ok(ChannelOutboundRunReport {
            transported,
            rejected,
            rejected_codes,
            pending,
            remaining,
            terminal,
        })
    }
}
