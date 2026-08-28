//! Closed Channel error model.
//!
//! Every Channel failure carries the common error-envelope shape mandated by
//! the Channel specification: `code`, `retryable`, top-level `outcome`
//! (`not_applied | applied | unknown`), a message, and bounded `details`. A
//! Channel-specific `delivery_outcome` inside `details` additionally
//! distinguishes `not_sent | sent | partial | unknown` for outbound paths.

use serde::Serialize;

/// The top-level outcome of a Channel operation, matching the common Core
/// error envelope (`error.schema.json`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelOutcome {
    /// The operation was not applied; nothing durable changed.
    NotApplied,
    /// The operation was applied, possibly only partially.
    Applied,
    /// The durable effect is not known (response or confirmation lost).
    Unknown,
}

impl ChannelOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            ChannelOutcome::NotApplied => "not_applied",
            ChannelOutcome::Applied => "applied",
            ChannelOutcome::Unknown => "unknown",
        }
    }
}

/// A Channel-specific `details.delivery_outcome` value for outbound sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelDeliveryOutcome {
    /// Nothing was handed to the transport.
    NotSent,
    /// The whole send was confirmed by the transport.
    Sent,
    /// At least one piece was confirmed and at least one other piece failed
    /// or remains unknown.
    Partial,
    /// The send outcome is unknown (timeout or lost confirmation).
    Unknown,
}

impl ChannelDeliveryOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            ChannelDeliveryOutcome::NotSent => "not_sent",
            ChannelDeliveryOutcome::Sent => "sent",
            ChannelDeliveryOutcome::Partial => "partial",
            ChannelDeliveryOutcome::Unknown => "unknown",
        }
    }
}

/// Normative Channel error codes. Codes must match `^[A-Z][A-Z0-9_]+$` because
/// they are embedded in the common error envelope.
pub mod codes {
    pub const AUTHENTICATION_FAILED: &str = "CHANNEL_AUTHENTICATION_FAILED";
    pub const AUTHORIZATION_FAILED: &str = "CHANNEL_AUTHORIZATION_FAILED";
    pub const MALFORMED_EVENT: &str = "CHANNEL_MALFORMED_EVENT";
    pub const UNSUPPORTED_MODALITY: &str = "CHANNEL_UNSUPPORTED_MODALITY";
    pub const ASSET_IMPORT_FAILED: &str = "CHANNEL_ASSET_IMPORT_FAILED";
    pub const RATE_LIMITED: &str = "CHANNEL_RATE_LIMITED";
    pub const TRANSPORT_TIMEOUT: &str = "CHANNEL_TRANSPORT_TIMEOUT";
    pub const TRANSPORT_REJECTED: &str = "CHANNEL_TRANSPORT_REJECTED";
    pub const SESSION_MISSING: &str = "CHANNEL_SESSION_MISSING";
    pub const OPERATION_CONFLICT: &str = "CHANNEL_OPERATION_CONFLICT";
    pub const PARTIAL_DELIVERY: &str = "CHANNEL_PARTIAL_DELIVERY";
    pub const LEDGER_FULL: &str = "CHANNEL_LEDGER_FULL";
    pub const RESULT_CONTRACT_MISMATCH: &str = "CHANNEL_RESULT_CONTRACT_MISMATCH";
    pub const STALE_EVENT: &str = "CHANNEL_STALE_EVENT";
    pub const INGRESS_DISABLED: &str = "CHANNEL_INGRESS_DISABLED";
    pub const INTERNAL: &str = "CHANNEL_INTERNAL";
}

/// The common Channel error envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelError {
    pub code: String,
    pub retryable: bool,
    pub outcome: ChannelOutcome,
    pub message: String,
    /// Bounded structured details. Outbound sends always carry
    /// `details.delivery_outcome`.
    pub details: Vec<(String, serde_json::Value)>,
}

impl ChannelError {
    pub fn new(
        code: impl Into<String>,
        retryable: bool,
        outcome: ChannelOutcome,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            retryable,
            outcome,
            message: message.into(),
            details: Vec::new(),
        }
    }

    pub fn with_delivery(mut self, delivery_outcome: ChannelDeliveryOutcome) -> Self {
        self.details.push((
            "delivery_outcome".to_string(),
            serde_json::Value::String(delivery_outcome.as_str().to_string()),
        ));
        self
    }

    /// Render the common error envelope as a JSON object (`error.schema.json`
    /// shape), with `details` as an object.
    pub fn to_json_object(&self) -> serde_json::Map<String, serde_json::Value> {
        let mut map = serde_json::Map::new();
        map.insert(
            "code".into(),
            serde_json::Value::String(self.code.clone()),
        );
        map.insert("retryable".into(), serde_json::Value::Bool(self.retryable));
        map.insert(
            "outcome".into(),
            serde_json::Value::String(self.outcome.as_str().to_string()),
        );
        map.insert(
            "message".into(),
            serde_json::Value::String(self.message.clone()),
        );
        let mut details = serde_json::Map::new();
        for (k, v) in &self.details {
            details.insert(k.clone(), v.clone());
        }
        map.insert("details".into(), serde_json::Value::Object(details));
        map
    }
}

impl std::fmt::Display for ChannelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} (outcome={}, retryable={}): {}",
            self.code,
            self.outcome.as_str(),
            self.retryable,
            self.message
        )
    }
}

impl std::error::Error for ChannelError {}
