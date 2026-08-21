//! ToolResult / ToolError model per `tool-result.schema.json` and §8.
//!
//! The crate documents the exhaustive `ToolError` code set and constructs
//! schema-valid results for the pure-core denial and status paths.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Exhaustive Tool error code set (spec §8 table).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ToolErrorCode {
    ServerUnavailable,
    ServerQuarantined,
    Unknown,
    CapabilityDenied,
    StaleLease,
    StaleConfigRevision,
    ConfirmationRequired,
    ConfirmationExpired,
    InputInvalid,
    RequestLimit,
    IdempotencyConflict,
    DispatchNotApplied,
    UpstreamNotApplied,
    UpstreamFailed,
    OutputInvalid,
    ResponseLimit,
    ExternalOutcomeUnknown,
    ConfigInvalid,
}

impl ToolErrorCode {
    /// The wire spelling (`TOOL_UNKNOWN`, …).
    pub fn as_str(self) -> &'static str {
        match self {
            ToolErrorCode::ServerUnavailable => "TOOL_SERVER_UNAVAILABLE",
            ToolErrorCode::ServerQuarantined => "TOOL_SERVER_QUARANTINED",
            ToolErrorCode::Unknown => "TOOL_UNKNOWN",
            ToolErrorCode::CapabilityDenied => "TOOL_CAPABILITY_DENIED",
            ToolErrorCode::StaleLease => "TOOL_STALE_LEASE",
            ToolErrorCode::StaleConfigRevision => "TOOL_STALE_CONFIG_REVISION",
            ToolErrorCode::ConfirmationRequired => "TOOL_CONFIRMATION_REQUIRED",
            ToolErrorCode::ConfirmationExpired => "TOOL_CONFIRMATION_EXPIRED",
            ToolErrorCode::InputInvalid => "TOOL_INPUT_INVALID",
            ToolErrorCode::RequestLimit => "TOOL_REQUEST_LIMIT",
            ToolErrorCode::IdempotencyConflict => "TOOL_IDEMPOTENCY_CONFLICT",
            ToolErrorCode::DispatchNotApplied => "TOOL_DISPATCH_NOT_APPLIED",
            ToolErrorCode::UpstreamNotApplied => "TOOL_UPSTREAM_NOT_APPLIED",
            ToolErrorCode::UpstreamFailed => "TOOL_UPSTREAM_FAILED",
            ToolErrorCode::OutputInvalid => "TOOL_OUTPUT_INVALID",
            ToolErrorCode::ResponseLimit => "TOOL_RESPONSE_LIMIT",
            ToolErrorCode::ExternalOutcomeUnknown => "TOOL_EXTERNAL_OUTCOME_UNKNOWN",
            ToolErrorCode::ConfigInvalid => "TOOL_CONFIG_INVALID",
        }
    }

    /// Parse a wire spelling back into a code.
    pub fn from_wire(spelling: &str) -> Option<Self> {
        Some(match spelling {
            "TOOL_SERVER_UNAVAILABLE" => Self::ServerUnavailable,
            "TOOL_SERVER_QUARANTINED" => Self::ServerQuarantined,
            "TOOL_UNKNOWN" => Self::Unknown,
            "TOOL_CAPABILITY_DENIED" => Self::CapabilityDenied,
            "TOOL_STALE_LEASE" => Self::StaleLease,
            "TOOL_STALE_CONFIG_REVISION" => Self::StaleConfigRevision,
            "TOOL_CONFIRMATION_REQUIRED" => Self::ConfirmationRequired,
            "TOOL_CONFIRMATION_EXPIRED" => Self::ConfirmationExpired,
            "TOOL_INPUT_INVALID" => Self::InputInvalid,
            "TOOL_REQUEST_LIMIT" => Self::RequestLimit,
            "TOOL_IDEMPOTENCY_CONFLICT" => Self::IdempotencyConflict,
            "TOOL_DISPATCH_NOT_APPLIED" => Self::DispatchNotApplied,
            "TOOL_UPSTREAM_NOT_APPLIED" => Self::UpstreamNotApplied,
            "TOOL_UPSTREAM_FAILED" => Self::UpstreamFailed,
            "TOOL_OUTPUT_INVALID" => Self::OutputInvalid,
            "TOOL_RESPONSE_LIMIT" => Self::ResponseLimit,
            "TOOL_EXTERNAL_OUTCOME_UNKNOWN" => Self::ExternalOutcomeUnknown,
            "TOOL_CONFIG_INVALID" => Self::ConfigInvalid,
            _ => return None,
        })
    }
}

impl Serialize for ToolErrorCode {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ToolErrorCode {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let spelling = String::deserialize(deserializer)?;
        Self::from_wire(&spelling).ok_or_else(|| {
            serde::de::Error::custom(format!("unknown tool error code {spelling:?}"))
        })
    }
}

/// Error outcome classification (spec §8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorOutcome {
    NotApplied,
    Applied,
    Unknown,
}

/// Ledger status of an operation (section 6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Absent,
    Authorized,
    Dispatched,
    Succeeded,
    Failed,
    Unknown,
    Denied,
}

/// One `ToolError` envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolError {
    pub code: ToolErrorCode,
    pub retryable: bool,
    pub outcome: ErrorOutcome,
    pub message: String,
    #[serde(default)]
    pub details: Map<String, Value>,
}

/// `ToolResult` as defined by `tool-result.schema.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolResult {
    pub operation_id: String,
    pub status: ToolStatus,
    pub output: Value,
    pub error: Option<ToolError>,
    pub server_request_id: Option<String>,
}

impl ToolResult {
    /// A pre-resolution `denied` result: no outlet, no row, `not_applied`.
    pub fn denied(
        operation_id: impl Into<String>,
        code: ToolErrorCode,
        message: impl Into<String>,
    ) -> Self {
        Self {
            operation_id: operation_id.into(),
            status: ToolStatus::Denied,
            output: Value::Null,
            error: Some(ToolError {
                code,
                retryable: false,
                outcome: ErrorOutcome::NotApplied,
                message: message.into(),
                details: Map::new(),
            }),
            server_request_id: None,
        }
    }

    /// An `absent` status result (REQ-TOOL-004 module-scoped lookup miss).
    pub fn absent(operation_id: impl Into<String>) -> Self {
        Self {
            operation_id: operation_id.into(),
            status: ToolStatus::Absent,
            output: Value::Null,
            error: None,
            server_request_id: None,
        }
    }
}
