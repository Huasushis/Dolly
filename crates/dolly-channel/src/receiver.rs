//! Durable Channel inbound receiver (G4-C wiring).
//!
//! The receiver is the shipping-runtime entry point for one already
//! authenticated Channel event. Direction is preserved end to end:
//!
//! ```text
//! authenticated transport event
//!   -> durable Channel ingress ledger  (member of [`ChannelLedger`])
//!   -> sealed B Host ingress premise   ([`HostIngress`] via [`HostIngressCoreAdapter`])
//!   -> Core exactly once               (idempotent reducer ingress)
//! ```
//!
//! Every call runs the accepted [`process_event`] / [`reconcile_inbound`]
//! pipeline with zero change, backed by the durable [`ChannelLedgerStore`].
//! The ledger document is persisted before the outcome is acknowledged: a
//! crash or lost response anywhere after the ledger mutation leaves the
//! durable Channel row plus the durable Host ingress premise, and restart
//! reconciliation reads `status` first (never a blind resend, never a false
//! success). A persistence failure is reported as `SubmissionPending` so the
//! caller MUST reconcile from durable state instead of believing an
//! undocumented result.
//!
//! The receiver never mints Block/Ingress/Asset identity and never touches
//! Pages or cursors; the sealed authority, grant, graph direction, and
//! edit/delete relation fences are re-verified inside the Host ingress
//! storage transaction on every submit and status.

use crate::clock::Clock;
use crate::config::ChannelConfig;
use crate::error::ChannelError;
use crate::host_adapter::HostIngressCoreAdapter;
use crate::ingress::{InboundEvent, IngressOutcome, process_event, reconcile_inbound};
use crate::ledger::ChannelLedger;
use crate::store::ChannelLedgerStore;
use dolly_storage::{HostCapabilityGrant, HostConnectionAuthority, HostIngress};

/// The durable Channel inbound facade over one module-scoped ledger store and
/// one `HostIngress` implementation.
///
/// The sealed `authority` and `grant` come from the integrator (the Host
/// connection that owns the Channel module activation); the adapter and the
/// storage transaction re-verify them on every call. The receiver is the
/// registration seam for the shipping runtime: it owns no lifecycle, process,
/// or transport by itself.
pub struct InboundReceiver<'principal, S: ChannelLedgerStore, H: HostIngress> {
    config: ChannelConfig,
    clock: Box<dyn Clock>,
    ledger: ChannelLedger,
    ledger_store: S,
    host: H,
    authority: &'principal HostConnectionAuthority,
    grant: &'principal HostCapabilityGrant,
}

impl<'principal, S: ChannelLedgerStore, H: HostIngress> InboundReceiver<'principal, S, H> {
    /// Load the durable ledger from the module-scoped store (an empty ledger
    /// on first use) and bind the receiver to the opaque current Host
    /// authority and capability grant.
    pub fn new(
        config: ChannelConfig,
        clock: Box<dyn Clock>,
        mut ledger_store: S,
        host: H,
        authority: &'principal HostConnectionAuthority,
        grant: &'principal HostCapabilityGrant,
    ) -> Result<Self, ChannelError> {
        let ledger = ledger_store.load()?;
        Ok(Self {
            config,
            clock,
            ledger,
            ledger_store,
            host,
            authority,
            grant,
        })
    }

    /// The current in-memory Channel ledger (mirrors the durable document
    /// after every acknowledged call).
    pub fn ledger(&self) -> &ChannelLedger {
        &self.ledger
    }

    /// Process one authenticated event through the accepted pipeline and make
    /// the resulting ledger durable before acknowledging the outcome.
    ///
    /// A failure to persist never fabricates success: it is reported as
    /// `SubmissionPending` so the caller reconciles from durable state.
    pub fn ingest_event(&mut self, event: &InboundEvent) -> IngressOutcome {
        let Self {
            config,
            clock,
            ledger,
            ledger_store,
            host,
            authority,
            grant,
        } = self;
        let mut adapter = HostIngressCoreAdapter::new(host, authority, grant);
        adapter.seed_from_ledger(ledger);
        let outcome = process_event(config, &**clock, ledger, &mut adapter, event);
        if ledger_store.save(ledger).is_err() {
            return IngressOutcome::SubmissionPending;
        }
        outcome
    }

    /// Reconcile every inbound row whose submit outcome was lost through
    /// status first, using the durable Channel ledger and the durable Host
    /// ingress state. Returns the number of rows left unresolved, or an error
    /// when the reconciled ledger could not be persisted.
    pub fn reconcile(&mut self) -> Result<usize, ChannelError> {
        let Self {
            config,
            clock,
            ledger,
            ledger_store,
            host,
            authority,
            grant,
        } = self;
        let mut adapter = HostIngressCoreAdapter::new(host, authority, grant);
        adapter.seed_from_ledger(ledger);
        let remaining = reconcile_inbound(config, &**clock, ledger, &mut adapter);
        ledger_store.save(ledger)?;
        Ok(remaining)
    }
}
