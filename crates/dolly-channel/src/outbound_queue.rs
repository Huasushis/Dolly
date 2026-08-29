//! Durable outbound admission notification and identity gate.
//!
//! Admission correctness lives in SQLite. This process-wide registry returns
//! one shared `Arc` for an exact store-owner digest, account, configuration
//! revision, and limits digest. The gate owns only a condition variable:
//! notification is an optimization after durable state changes, never
//! authority or queue state.

use std::collections::BTreeMap;
use std::sync::{Arc, Condvar, LazyLock, Mutex, Weak};

use dolly_storage::{HostCapabilityGrant, HostConnectionAuthority};

use crate::clock::Clock;
use crate::config::{ChannelConfig, OutboundLimits};
use crate::error::{ChannelDeliveryOutcome, ChannelError, ChannelOutcome, codes};
use crate::principal::ChannelPrincipal;
use crate::store::{OutboundAdmissionOutcome, SqliteChannelStore};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct GateIdentity {
    store_owner_digest: String,
    account: String,
    config_revision: i64,
    limits_digest: String,
}

static GATES: LazyLock<Mutex<BTreeMap<GateIdentity, Weak<OutboundQueueGate>>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

fn limits_digest(limits: OutboundLimits) -> String {
    dolly_canonical_json::canonicalize(&limits)
        .expect("validated outbound limits serialize as canonical JSON")
        .1
        .to_canonical_string()
}

/// Shared notification gate for one exact durable store/config identity.
///
/// Construct it only through [`OutboundQueueGate::register`]. Repeated
/// registration of the same identity returns the same live `Arc`; consumers
/// reject an `Arc` whose complete identity does not match their opened store.
pub struct OutboundQueueGate {
    identity: GateIdentity,
    limits: OutboundLimits,
    changed: Condvar,
    notification_generation: Mutex<u64>,
}

impl OutboundQueueGate {
    /// Registration-owned factory. It opens and verifies the D-owned Channel
    /// store binding, then returns the one shared gate for its full identity.
    pub fn register(
        config: &ChannelConfig,
        module_connection: &mut rusqlite::Connection,
        authority: &HostConnectionAuthority,
        grant: &HostCapabilityGrant,
    ) -> Result<Arc<Self>, ChannelError> {
        let principal = ChannelPrincipal::from_authority_grant(authority, grant)?;
        if config.extension_id != principal.extension_id()
            || config.module_id != principal.module_id()
        {
            return Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "outbound gate config does not match the granted Channel module",
            ));
        }
        let store = SqliteChannelStore::new(module_connection, &principal, config.revision)?;
        let identity = GateIdentity {
            store_owner_digest: store.owner_digest()?.to_string(),
            account: principal.account().to_string(),
            config_revision: config.revision,
            limits_digest: limits_digest(config.outbound_limits),
        };
        drop(store);
        let mut gates = GATES.lock().unwrap_or_else(|poison| poison.into_inner());
        gates.retain(|_, gate| gate.strong_count() > 0);
        if let Some(existing) = gates.get(&identity).and_then(Weak::upgrade) {
            return Ok(existing);
        }
        let gate = Arc::new(Self {
            identity: identity.clone(),
            limits: config.outbound_limits,
            changed: Condvar::new(),
            notification_generation: Mutex::new(0),
        });
        gates.insert(identity, Arc::downgrade(&gate));
        Ok(gate)
    }

    pub(crate) fn verify_identity(
        &self,
        store: &SqliteChannelStore<'_>,
        account: &str,
        config_revision: i64,
        limits: OutboundLimits,
    ) -> Result<(), ChannelError> {
        let expected = GateIdentity {
            store_owner_digest: store.owner_digest()?.to_string(),
            account: account.to_string(),
            config_revision,
            limits_digest: limits_digest(limits),
        };
        if self.identity != expected || self.limits != limits {
            return Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "injected outbound gate identity does not match the opened store/config",
            ));
        }
        Ok(())
    }

    /// Block only on the condition variable; every decision and transition is
    /// re-read from SQLite. The durable transaction reads the injected clock
    /// after acquiring its write lock, so lock delay cannot produce a late
    /// grant.
    pub(crate) fn admit(
        &self,
        store: &mut SqliteChannelStore<'_>,
        session_id: &str,
        action_key: &str,
        piece_count: u64,
        deadline_micros: i64,
        clock: &dyn Clock,
    ) -> Result<(), ChannelError> {
        loop {
            let observed_generation = *self
                .notification_generation
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            match store.admit_to_queue(
                action_key,
                session_id,
                piece_count,
                deadline_micros,
                self.limits,
                clock,
            )? {
                OutboundAdmissionOutcome::Granted => {
                    self.wake_all();
                    return Ok(());
                }
                OutboundAdmissionOutcome::Waiting {
                    now_micros,
                    wake_at_micros,
                } => {
                    let remaining = wake_at_micros.saturating_sub(now_micros);
                    if remaining == 0 {
                        continue;
                    }
                    let generation = self
                        .notification_generation
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner());
                    if *generation == observed_generation {
                        let _ = self
                            .changed
                            .wait_timeout(
                                generation,
                                std::time::Duration::from_micros(remaining as u64),
                            )
                            .unwrap_or_else(|poison| poison.into_inner());
                    }
                }
                OutboundAdmissionOutcome::Expired => {
                    return Err(Self::backpressure(
                        session_id,
                        "caller deadline expired while waiting for durable admission",
                    ));
                }
                OutboundAdmissionOutcome::Cancelled => {
                    return Err(Self::backpressure(
                        session_id,
                        "durable admission was cancelled",
                    ));
                }
                OutboundAdmissionOutcome::Saturated => {
                    return Err(Self::backpressure(
                        session_id,
                        "combined durable Waiting+Queued+Dispatched bound is full",
                    ));
                }
            }
        }
    }

    fn backpressure(session_id: &str, reason: &str) -> ChannelError {
        ChannelError::new(
            codes::RATE_LIMITED,
            true,
            ChannelOutcome::NotApplied,
            format!("outbound queue backpressure for session {session_id}: {reason}"),
        )
        .with_delivery(ChannelDeliveryOutcome::NotSent)
    }

    pub(crate) fn cancel(
        &self,
        store: &mut SqliteChannelStore<'_>,
        action_key: &str,
        clock: &dyn Clock,
    ) -> Result<bool, ChannelError> {
        let cancelled = store.cancel_admission(action_key, clock)?;
        if cancelled {
            self.wake_all();
        }
        Ok(cancelled)
    }

    pub(crate) fn wake_all(&self) {
        let mut generation = self
            .notification_generation
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *generation = generation.wrapping_add(1);
        self.changed.notify_all();
    }

    #[cfg(feature = "test-support")]
    pub fn notification_generation(&self) -> u64 {
        *self
            .notification_generation
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
}
