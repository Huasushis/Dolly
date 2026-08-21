//! Frozen MCP protocol-version boundary for the v1 Tool Broker.
//!
//! Only the explicit `2025-06-18` revision is a valid v1 server contract.
//! Unknown, newer (`2026-07-28`), and older revisions all fail closed:
//! there is no silent negotiation, no fall-forward, and no downgrade path.

/// The only MCP protocol revision the v1 Tool Broker accepts.
pub const MCP_PROTOCOL_VERSION_2025_06_18: &str = "2025-06-18";

/// Stable dictionary reason published on a rejected config transaction.
pub const UNSUPPORTED_PROTOCOL_VERSION: &str = "unsupported_protocol_version";

/// Tool-configuration error code for the rejected candidate (spec §8:
/// candidate registry/version failures use `TOOL_CONFIG_INVALID`).
pub const TOOL_CONFIG_INVALID: &str = "TOOL_CONFIG_INVALID";

/// A candidate server contract with a protocol revision outside the frozen
/// boundary. Carries the offending candidate value for diagnostics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsupportedProtocolVersion {
    /// The candidate protocol version that was rejected.
    pub candidate: String,
}

impl std::fmt::Display for UnsupportedProtocolVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{candidate} is outside the frozen boundary; only {frozen} is accepted",
            candidate = self.candidate,
            frozen = MCP_PROTOCOL_VERSION_2025_06_18
        )
    }
}

impl std::error::Error for UnsupportedProtocolVersion {}

/// Accept exactly the supported revision. Any other value (older, newer, or
/// unknown) is rejected before any server generation can be started.
pub fn check_protocol_version(candidate: &str) -> Result<(), UnsupportedProtocolVersion> {
    if candidate == MCP_PROTOCOL_VERSION_2025_06_18 {
        Ok(())
    } else {
        Err(UnsupportedProtocolVersion {
            candidate: candidate.to_owned(),
        })
    }
}
