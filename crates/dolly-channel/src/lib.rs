//! `org.dolly.channel` v1 — text ingress and outbound effect ledger.
//!
//! This crate is the production module for the built-in Channel package. It
//! owns the account-scoped inbound ledger (transport event -> Block draft ->
//! durable Core ingress premise), the outbound effect ledger for
//! `org.dolly.channel.send` (prepared/dispatched/confirmed/partial/failed/
//! unknown), and the frozen semantic result validator. It performs no
//! transport, network, or storage I/O: those enter through the injected
//! [`CoreIngress`], [`ChannelTransport`], and storage-agnostic
//! [`ChannelLedger`] boundaries, so every decision is deterministic and
//! testable offline.
//!
//! The Channel never appends directly to a Page, never mints a Block or Asset
//! ID, never exposes management privileges to conversation users, and never
//! lets a send re-enter Dolly as an inbound user message (echoed outbound IDs
//! are suppressed by the inbound ledger).

pub mod clock;

pub mod config;
pub mod error;
pub mod ids;
pub mod ingress;
pub mod ledger;
pub mod outbound;
pub mod projection;
pub mod rate_limit;
pub mod result_validator;
pub mod transport;

pub use clock::{Clock, FixedClock, VirtualClock, timestamp_diff_micros, timestamp_from_total_micros, timestamp_plus_seconds, timestamp_total_micros};
pub use config::{ChannelConfig, ChannelConfigBuilder, EXTENSION_ID, SEND_ACTION_NAME};
pub use ledger::{ledger_from_json_string, ledger_to_json_string};
pub use error::{ChannelDeliveryOutcome, ChannelError, ChannelOutcome};
pub use ingress::{
    CoreIngress, CoreIngressError, IngressCommit, IngressOutcome, IngressStatusResult,
    IngressSubmitReceipt, IngressSubmitRequest, InboundEvent, parse_event, process_event,
    reconcile_inbound,
};
pub use ledger::{ChannelLedger, EventKind, InboundEntry, InboundState, OutboundEntry, OutboundPiece, OutboundState};
pub use outbound::{
    PieceObservation, SendAction, SendDispatchResult, dispatch_send, observe_outbound,
    parse_send_action, recover_outbound,
};
pub use rate_limit::{OutboundAdmission, TokenBucket};
pub use ledger::PieceOutcome;
pub use projection::{AttemptProjection, InboundProjection, LedgerSnapshotProjection, OutboundProjection};
pub use result_validator::{
    RESULT_VALIDATOR_ID, RESULT_VALIDATOR_REVISION, SEND_RESULT_SCHEMA_ID, SEND_RESULT_SCHEMA_TAG,
    result_contract_matches, semantic_validate_send_result, validate_send_result,
};
pub use transport::{ChannelTransport, ScriptedTransport, TransportPiece, TransportPieceOutcome, TransportSendRequest, TransportSendResult};
