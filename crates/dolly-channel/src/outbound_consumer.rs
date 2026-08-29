//! Committed targeted-Action outbound consumer (seam D).
//!
//! Direction is invariant: committed targeted `org.dolly.channel.send`
//! Action (read ONLY through the authoritative Core operation/journal via
//! [`CommittedActionSource`]) -> durable `Prepared` outbound record in the
//! single module-scoped Channel DB -> bounded caller-deadline queue ->
//! transport -> durable exact result/echo marker (atomically, in the same
//! Channel DB transaction).
//!
//! The consumer never accepts an Action, Block, or transport authority from
//! a caller: it consumes committed Blocks through the typed
//! [`CommittedActionSource`] seam only, re-verifies the sealed principal on
//! every pass, and the durable record's authority-bound operation digest
//! makes a same key with different target/content/config conflict before
//! enqueue. A Prepared row that never recorded a dispatch attempt is the
//! only row that may be (re-)dispatched by [`OutboundConsumer::consume`];
//! every Dispatched/terminal row is owned by status-first recovery
//! ([`OutboundConsumer::reconcile`]) and is never blind-resent.

use std::collections::BTreeMap;

use dolly_storage::{HostCapabilityGrant, HostConnectionAuthority, SqliteCoreStore};
use serde_json::Value;

use crate::clock::Clock;
use crate::config::ChannelConfig;
use crate::error::{ChannelError, ChannelOutcome, codes};
use crate::ledger::{ChannelLedger, OutboundEntry, OutboundState};
use crate::outbound::{
    SendDispatchResult, build_prepared_entry, recover_outbound, transport_and_settle,
};
use crate::outbound_committed::{CommittedSendAction, committed_send_from_block};
use crate::outbound_queue::{BoundedPendingQueue, PendingQueueSlot};
use crate::principal::ChannelPrincipal;
use crate::store::{DurableOutboundRecord, OutboundPreparedOutcome, SqliteChannelStore};

/// The typed shared registration seam for the sole integrator: the ONLY
/// source of committed Blocks for the outbound consumer. No transport,
/// inbound premise, or echo object can mint or reverse an Action through any
/// other path.
pub trait CommittedActionSource {
    /// The authoritative committed Blocks of the current Core operation/
    /// journal snapshot, each `(block_id, block)`.
    fn committed_blocks(&mut self) -> Result<Vec<(String, Value)>, ChannelError>;
}

/// Real-Core implementation of [`CommittedActionSource`]: reads the verified
/// durable Core snapshot (journal-reconciled state + operation ledger), so a
/// caller can never inject an uncommitted or caller-shaped Block.
pub struct SnapshotCommittedActionSource<'connection> {
    store: SqliteCoreStore<'connection>,
}

impl<'connection> SnapshotCommittedActionSource<'connection> {
    /// Open a core snapshot reader over the authoritative Runtime DB.
    pub fn new(
        connection: &'connection mut rusqlite::Connection,
    ) -> Result<Self, ChannelError> {
        let store = SqliteCoreStore::new(connection).map_err(|error| {
            ChannelError::new(
                codes::INTERNAL,
                false,
                ChannelOutcome::NotApplied,
                format!("core snapshot store unavailable: {error}"),
            )
        })?;
        Ok(Self { store })
    }
}

impl CommittedActionSource for SnapshotCommittedActionSource<'_> {
    fn committed_blocks(&mut self) -> Result<Vec<(String, Value)>, ChannelError> {
        let snapshot = self.store.snapshot().map_err(|error| {
            ChannelError::new(
                codes::INTERNAL,
                false,
                ChannelOutcome::NotApplied,
                format!("authoritative core snapshot unavailable: {error}"),
            )
        })?;
        Ok(snapshot.blocks.into_iter().collect())
    }
}

/// The closed outcome of processing one committed Action.
#[derive(Debug, Clone, PartialEq)]
pub enum ConsumerOutcome {
    /// A terminal, frozen `ActionResult` canonical bytes are durable.
    Terminal {
        action_id: String,
        state: OutboundState,
        result_jcs: String,
    },
    /// The send is pending (dispatch marker durable, outcome still unknown);
    /// it MUST NOT be treated as success and is never blind-resent.
    Pending { action_id: String },
    /// Rejected deterministically (authority, conflict, validation, rate or
    /// queue backpressure) with zero transport effect and zero leaked slot.
    Rejected {
        action_id: String,
        error: ChannelError,
    },
}

/// The durable committed targeted-Action outbound consumer over one
/// module-scoped Channel DB, one authoritative committed-Action source, one
/// transport, and one shared bounded caller-deadline queue.
pub struct OutboundConsumer<'connection, 'principal, S: CommittedActionSource> {
    config: ChannelConfig,
    clock: Box<dyn Clock>,
    store: SqliteChannelStore<'connection>,
    source: S,
    transport: Box<dyn crate::transport::ChannelTransport>,
    queue: std::sync::Arc<BoundedPendingQueue>,
    authority: &'principal HostConnectionAuthority,
    grant: &'principal HostCapabilityGrant,
    principal: ChannelPrincipal,
    /// Granted queue slots held across passes for dispatched-but-unsettled
    /// sends (the in-flight pending bound); released when a send reaches a
    /// terminal outcome, dropped on worker teardown.
    pending_slots: BTreeMap<String, PendingQueueSlot>,
}

impl<'connection, 'principal, S: CommittedActionSource>
    OutboundConsumer<'connection, 'principal, S>
{
    /// Bind the consumer to the opaque current Host authority and capability
    /// grant, open the module-scoped store under the same principal, and
    /// build the bounded queue from the configured outbound limits. Every
    /// durable effect re-verifies the full principal against the store.
    pub fn new(
        config: ChannelConfig,
        clock: Box<dyn Clock>,
        connection: &'connection mut rusqlite::Connection,
        source: S,
        transport: Box<dyn crate::transport::ChannelTransport>,
        authority: &'principal HostConnectionAuthority,
        grant: &'principal HostCapabilityGrant,
    ) -> Result<Self, ChannelError> {
        let principal = ChannelPrincipal::from_authority_grant(authority, grant)?;
        if config.extension_id != principal.extension_id() {
            return Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "channel config Extension does not match the granted Channel Extension",
            ));
        }
        if config.module_id != principal.module_id() {
            return Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "channel config Module does not match the granted Module",
            ));
        }
        let mut config = config;
        config.transport_account = principal.account().to_string();
        let store = SqliteChannelStore::new(connection, &principal, config.revision)?;
        let queue = std::sync::Arc::new(BoundedPendingQueue::new(
            config.outbound_limits.max_pending_per_session,
            config.outbound_limits.max_pending_total,
        ));
        Ok(Self {
            config,
            clock,
            store,
            source,
            transport,
            queue,
            authority,
            grant,
            principal,
            pending_slots: BTreeMap::new(),
        })
    }

    /// Test-support only: build over a pre-opened store so failpoints can be
    /// injected while enforcing store/principal equality.
    #[cfg(feature = "test-support")]
    pub fn new_with_store(
        config: ChannelConfig,
        clock: Box<dyn Clock>,
        store: SqliteChannelStore<'connection>,
        source: S,
        transport: Box<dyn crate::transport::ChannelTransport>,
        authority: &'principal HostConnectionAuthority,
        grant: &'principal HostCapabilityGrant,
    ) -> Result<Self, ChannelError> {
        let principal = ChannelPrincipal::from_authority_grant(authority, grant)?;
        if config.extension_id != principal.extension_id() {
            return Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "channel config Extension does not match the granted Channel Extension",
            ));
        }
        if config.module_id != principal.module_id() {
            return Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "channel config Module does not match the granted Module",
            ));
        }
        let mut config = config;
        config.transport_account = principal.account().to_string();
        store.verify_owner_against(&principal, config.revision)?;
        let queue = std::sync::Arc::new(BoundedPendingQueue::new(
            config.outbound_limits.max_pending_per_session,
            config.outbound_limits.max_pending_total,
        ));
        Ok(Self {
            config,
            clock,
            store,
            source,
            transport,
            queue,
            authority,
            grant,
            principal,
            pending_slots: BTreeMap::new(),
        })
    }

    /// The shared bounded queue (worker sharing seam).
    pub fn queue(&self) -> std::sync::Arc<BoundedPendingQueue> {
        std::sync::Arc::clone(&self.queue)
    }

    /// The current in-memory Channel ledger projection (sessions + durable
    /// outbound rows + echo markers), rebuilt from the single durable source
    /// of truth.
    pub fn ledger(&mut self) -> Result<ChannelLedger, ChannelError> {
        self.store.project_ledger()
    }

    /// One consume pass: re-verify the current sealed authority, read the
    /// authoritative committed Blocks, and for every targeted channel send
    /// Action persist the durable `Prepared` record, admit to the bounded
    /// queue under the caller deadline, dispatch, and atomically commit the
    /// durable result + echo markers. Returns one outcome per processed
    /// Action.
    pub fn consume(&mut self, caller_deadline: &str) -> Result<Vec<ConsumerOutcome>, ChannelError> {
        let current_principal = ChannelPrincipal::from_authority_grant(self.authority, self.grant)?;
        if current_principal != self.principal {
            return Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "the current authority/grant fences changed since the outbound consumer opened",
            ));
        }
        let blocks = self.source.committed_blocks()?;
        let mut ledger = self.store.project_ledger()?;
        let mut outcomes = Vec::new();
        for (block_id, block) in blocks {
            if !block_has_send_action(&block) {
                continue;
            }
            outcomes.push(self.process_committed(&mut ledger, &block_id, &block, caller_deadline)?);
        }
        Ok(outcomes)
    }

    /// Status-first restart/lost-response recovery of the durable outbound
    /// ledger: never re-dispatches a row that may have reached the
    /// transport, never reports false success. Stale Dispatched rows are
    /// reconciled to the frozen `unknown`/`partial` result (atomically with
    /// their echo markers) and their queue slots released. Returns the number
    /// of durable rows still unresolved.
    pub fn reconcile(&mut self) -> Result<usize, ChannelError> {
        let mut ledger = self.store.project_ledger()?;
        let recovered = recover_outbound(&self.config, &*self.clock, &mut ledger);
        for action_id in recovered {
            let settled = ledger
                .outbound_entry(&action_id)
                .filter(|e| e.state.is_terminal())
                .cloned();
            if let Some(entry) = settled {
                let mut record = self
                    .store
                    .find_outbound(&action_id)?
                    .expect("recovered durable row");
                record.entry = entry;
                self.store.commit_outbound_terminal(&record)?;
                self.pending_slots.remove(&action_id);
            }
        }
        // Remainder: Prepared rows never dispatched (owned by consume) plus
        // Dispatched rows still inside the unknown window.
        Ok(self.store.list_pending_outbound()?.len())
    }

    /// Build the durable `Prepared` record for one verified committed Action.
    fn build_prepared_record(
        &self,
        committed: &CommittedSendAction,
        idempotency_supported: bool,
    ) -> DurableOutboundRecord {
        let entry = build_prepared_entry(
            &self.config,
            &*self.clock,
            &committed.action,
            &committed.session_id,
            committed.pieces.clone(),
            idempotency_supported,
        );
        DurableOutboundRecord {
            schema: crate::store::OUTBOUND_RECORD_SCHEMA.to_string(),
            version: 1,
            outbound_key: committed.action.action_id.clone(),
            digest: committed.operation_digest.clone(),
            action_jcs: committed.action_jcs.clone(),
            target_module_id: committed.action.target_module_id.clone(),
            owner: self.principal.owner().to_string(),
            extension_id: self.principal.extension_id().to_string(),
            module_id: self.principal.module_id().to_string(),
            instance_id: self.principal.instance_id().to_string(),
            generation: self.principal.generation() as i64,
            revision: self.principal.revision(),
            graph_revision: self.principal.graph_revision(),
            graph_digest: self.principal.graph_digest().to_string(),
            config_revision: self.config.revision,
            account: self.principal.account().to_string(),
            entry,
        }
    }

    /// The durable record for the settled terminal entry (same authority and
    /// committed Action bytes as the original).
    fn build_terminal_record(
        &self,
        committed: &CommittedSendAction,
        entry: &OutboundEntry,
    ) -> DurableOutboundRecord {
        let mut record = self.build_prepared_record(committed, entry.idempotency_supported);
        record.entry = entry.clone();
        record
    }

    fn process_committed(
        &mut self,
        ledger: &mut ChannelLedger,
        block_id: &str,
        block: &Value,
        caller_deadline: &str,
    ) -> Result<ConsumerOutcome, ChannelError> {
        let fallback_action_id = block_first_action_id(block).unwrap_or_default();
        let committed =
            match committed_send_from_block(block_id, block, &self.principal, &self.config, ledger)
            {
                Ok(committed) => committed,
                Err(error) => {
                    return Ok(ConsumerOutcome::Rejected {
                        action_id: fallback_action_id,
                        error,
                    })
                }
            };
        // 1. Durable Prepared/idempotency state before any admission or
        //    transport: same key+digest replays the stored result with zero
        //    re-dispatch; same key + different target/content/config
        //    conflicts before enqueue.
        let idempotency_supported = self.transport.idempotency_supported();
        let prepared = self.build_prepared_record(&committed, idempotency_supported);
        match self.store.write_prepared_outbound(&prepared) {
            Ok(OutboundPreparedOutcome::ReplayTerminal { state, result_jcs }) => {
                return Ok(ConsumerOutcome::Terminal {
                    action_id: committed.action.action_id.clone(),
                    state,
                    result_jcs,
                });
            }
            Ok(OutboundPreparedOutcome::Prepared | OutboundPreparedOutcome::PreparedExisting) => {}
            Err(error) if error.code == codes::OPERATION_CONFLICT => {
                return Ok(ConsumerOutcome::Rejected {
                    action_id: committed.action.action_id.clone(),
                    error,
                });
            }
            Err(error) => return Err(error),
        }

        // 2. Dispatch decision from the surviving durable row: ONLY a row
        //    that never recorded a dispatch attempt may reach the transport
        //    (a Prepared row that was never dispatched was never sent).
        let durable = self
            .store
            .find_outbound(&committed.action.action_id)?
            .expect("durable outbound row");
        let never_dispatched = durable.entry.state == OutboundState::Prepared
            && !durable.entry.attempts.iter().any(|a| a.kind == "dispatch");
        if !never_dispatched {
            return Ok(ConsumerOutcome::Pending {
                action_id: committed.action.action_id.clone(),
            });
        }

        // 3. Bounded queue admission (fair, caller deadline, no leak).
        let session_key = format!("{}\u{0}{}", self.principal.account(), committed.session_id);
        let slot = match self.queue.admit(&*self.clock, &session_key, caller_deadline) {
            Ok(slot) => slot,
            Err(error) => {
                return Ok(ConsumerOutcome::Rejected {
                    action_id: committed.action.action_id.clone(),
                    error,
                })
            }
        };

        // 4. Ensure the in-memory ledger row exists as Prepared.
        if ledger.outbound_entry(&committed.action.action_id).is_none() {
            let entry = build_prepared_entry(
                &self.config,
                &*self.clock,
                &committed.action,
                &committed.session_id,
                committed.pieces.clone(),
                idempotency_supported,
            );
            if ledger
                .insert_outbound(entry, self.config.ledger_bounds.outbound_max_entries)
                .is_err()
            {
                drop(slot);
                return Err(ChannelError::new(
                    codes::LEDGER_FULL,
                    false,
                    ChannelOutcome::NotApplied,
                    "outbound ledger is at capacity",
                ));
            }
        }

        let now = self.clock.now().as_str().to_string();
        // 5. Durable dispatched marker BEFORE transport initiation for
        //    transports without idempotency-key support (atomic claim).
        if !idempotency_supported
            && !self
                .store
                .mark_outbound_dispatched(&committed.action.action_id, &now, true)?
        {
            drop(slot);
            return Ok(ConsumerOutcome::Pending {
                action_id: committed.action.action_id.clone(),
            });
        }

        // 6. Transport + settle.
        let result = transport_and_settle(
            &self.config,
            ledger,
            &mut *self.transport,
            &committed.action.action_id,
            &now,
            idempotency_supported,
        );
        match result {
            SendDispatchResult::Terminal { state, result } => {
                // 7. Durable terminal result + echo markers ATOMICALLY. For
                //    idempotent transports a durable dispatched marker after
                //    send is redundant here: the terminal commit supersedes
                //    the Prepared row, and a crash between the send and this
                //    commit leaves `Prepared` so restart re-dispatches under
                //    the same idempotency key (provider de-duplicates).
                let entry = ledger
                    .outbound_entry(&committed.action.action_id)
                    .cloned()
                    .expect("settled outbound row");
                let record = self.build_terminal_record(&committed, &entry);
                if let Err(error) = self.store.commit_outbound_terminal(&record) {
                    drop(slot);
                    return Err(error);
                }
                drop(slot);
                let result_jcs = dolly_canonical_json::canonicalize(&result)
                    .map(|(bytes, _)| String::from_utf8(bytes.as_bytes().to_vec()))
                    .unwrap_or(Ok("canonicalize-failed".to_string()))
                    .unwrap_or_else(|_| "canonicalize-failed".to_string());
                Ok(ConsumerOutcome::Terminal {
                    action_id: committed.action.action_id.clone(),
                    state,
                    result_jcs,
                })
            }
            SendDispatchResult::DispatchedPending => {
                // 7'. The transport response was lost; the durable dispatched
                //     marker is recorded (idempotent transports) and the slot
                //     is held so the pending bound is honored until recovery.
                if idempotency_supported {
                    let _ = self
                        .store
                        .mark_outbound_dispatched(&committed.action.action_id, &now, false);
                }
                self.pending_slots
                    .insert(committed.action.action_id.clone(), slot);
                Ok(ConsumerOutcome::Pending {
                    action_id: committed.action.action_id.clone(),
                })
            }
            SendDispatchResult::Rejected(error) => {
                drop(slot);
                Err(ChannelError::new(
                    error.code,
                    error.retryable,
                    error.outcome,
                    format!("outbound dispatch failed internally: {}", error.message),
                ))
            }
        }
    }
}

/// Cheap filter: does this committed block carry any `org.dolly.channel.send`
/// Action at all? Blocks without one are not Channel outbound work.
fn block_has_send_action(block: &Value) -> bool {
    block
        .get("body")
        .and_then(Value::as_object)
        .and_then(|body| body.get("actions"))
        .and_then(Value::as_array)
        .is_some_and(|actions| {
            actions.iter().any(|action| {
                action
                    .get("name")
                    .and_then(Value::as_str)
                    == Some(crate::config::SEND_ACTION_NAME)
            })
        })
}

/// The first channel-send Action id in a block, for diagnostics on reject.
fn block_first_action_id(block: &Value) -> Option<String> {
    block
        .get("body")
        .and_then(Value::as_object)
        .and_then(|body| body.get("actions"))
        .and_then(Value::as_array)
        .and_then(|actions| {
            actions.iter().find_map(|action| {
                (action.get("name").and_then(Value::as_str) == Some(crate::config::SEND_ACTION_NAME))
                    .then(|| action.get("action_id").and_then(Value::as_str).map(str::to_owned))
                    .flatten()
            })
        })
}
