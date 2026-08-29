//! `org.dolly.channel` v1 — text ingress and outbound effect ledger.
//!
//! This crate is the production module for the built-in Channel package. It
//! owns the account-scoped inbound ledger (transport event -> Block draft ->
//! durable Core ingress premise), the outbound effect ledger for
//! `org.dolly.channel.send` (prepared/dispatched/confirmed/partial/failed/
//! unknown), and the frozen semantic result validator. The decision pipeline
//! performs no transport, network, or storage I/O: those enter through the
//! injected [`CoreIngress`], [`ChannelTransport`], and storage-agnostic
//! [`ChannelLedger`] boundaries, so every decision is deterministic and
//! testable offline. The G4-C durable backing ([`InboundReceiver`],
//! [`SqliteChannelStore`]) is the shipping-runtime layer that binds that
//! pipeline to the accepted `HostIngress` / storage seams.
//!
//! The Channel never appends directly to a Page, never mints a Block or Asset
//! ID, never exposes management privileges to conversation users, and never
//! lets a send re-enter Dolly as an inbound user message (echoed outbound IDs
//! are suppressed by the inbound ledger).

pub mod clock;

pub mod config;
pub mod error;
pub(crate) mod host_adapter;
pub mod ids;
pub mod ingress;
pub(crate) mod intent;
pub mod ledger;
pub mod outbound;
#[cfg(feature = "test-support")]
pub mod outbound_committed;
#[cfg(feature = "test-support")]
pub mod outbound_consumer;
#[cfg(feature = "test-support")]
pub mod outbound_queue;
pub(crate) mod principal;
pub mod projection;
pub mod rate_limit;
pub mod receiver;
pub mod result_validator;
pub(crate) mod store;
pub mod transport;

pub use clock::{
    Clock, FixedClock, VirtualClock, timestamp_diff_micros, timestamp_from_total_micros,
    timestamp_plus_seconds, timestamp_total_micros,
};
pub use config::{ChannelConfig, ChannelConfigBuilder, EXTENSION_ID, SEND_ACTION_NAME};
pub use error::{ChannelDeliveryOutcome, ChannelError, ChannelOutcome};
pub use ingress::{
    CoreIngress, CoreIngressError, InboundEvent, IngressCommit, IngressOutcome,
    IngressStatusResult, IngressSubmitReceipt, IngressSubmitRequest, parse_event, process_event,
    reconcile_inbound,
};
pub use ledger::PieceOutcome;
pub use ledger::{
    ChannelLedger, EventKind, InboundEntry, InboundState, OutboundEntry, OutboundPiece,
    OutboundState,
};
pub use ledger::{ledger_from_json_string, ledger_to_json_string};

/// The raw outbound dispatch surface is the accepted crate contract that the
/// G4 conformance probes drive directly (they pre-authorize the session and
/// extract the committed Action from the real Core snapshot). It is NOT a
/// production entry point: the shipping runtime has no committed-Action
/// consumer loop, and no caller can feed an unverified `SendAction` into the
/// real transport path without the sealed authority/grant and a committed
/// Block from the authoritative journal.
pub use outbound::{
    PieceObservation, SendAction, SendDispatchResult, dispatch_send, observe_outbound,
    parse_send_action, recover_outbound,
};

/// Committed-Action outbound consumer, verification boundary, and bounded
/// queue. Test/conformance-only: these are the seam-D implementation pieces
/// the integrator wires into the runtime loop. Enabled only by the
/// non-default `test-support` feature.
#[cfg(feature = "test-support")]
pub use outbound_committed::{CommittedSendAction, committed_send_from_block};
#[cfg(feature = "test-support")]
pub use outbound_consumer::{
    CommittedActionSource, ConsumerOutcome, OutboundConsumer, SnapshotCommittedActionSource,
};
#[cfg(feature = "test-support")]
pub use outbound_queue::{BoundedPendingQueue, PendingQueueSlot};

pub use transport::{
    ChannelTransport, ScriptedTransport, TransportPiece, TransportPieceOutcome,
    TransportSendRequest, TransportSendResult, TransportStatusRequest, TransportStatusResult,
};
pub use principal::ChannelPrincipal;
pub use projection::{
    AttemptProjection, InboundProjection, LedgerSnapshotProjection, OutboundProjection,
};
pub use rate_limit::{OutboundAdmission, TokenBucket};
pub use receiver::{AuthenticatedChannelEvent, ChannelEventContent, InboundReceiver};
pub use result_validator::{
    RESULT_VALIDATOR_ID, RESULT_VALIDATOR_REVISION, SEND_RESULT_SCHEMA_ID, SEND_RESULT_SCHEMA_TAG,
    result_contract_matches, semantic_validate_send_result, validate_send_result,
};


/// Test/conformance surface only: exposes the crate-private store, intent
/// record and receiver test constructor so real-SQLite/Core failpoint tests
/// can observe and inject the production state machine. Enabled only by the
/// non-default `test-support` feature; a caller without the sealed Host
/// authority and capability grant cannot open a store, so no real Host
/// authority is exposed.
#[cfg(feature = "test-support")]
pub use crate::intent::{ChannelIntent, IntentState};
#[cfg(feature = "test-support")]
pub use crate::store::{
    DurableOutboundRecord, OutboundPreparedOutcome, SqliteChannelStore, create_channel_store_schema,
};

