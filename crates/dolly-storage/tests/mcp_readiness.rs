use dolly_storage::mcp_readiness::{
    MCP_TRANSPORT_READINESS_SCHEMA, McpHandshakeObservation, McpTransportProbe,
    McpTransportReadiness,
};

struct NoopProbe;

impl McpTransportProbe for NoopProbe {
    fn observe(
        &mut self,
        _binding: &dolly_storage::mcp_readiness::McpTransportBinding,
    ) -> Result<McpHandshakeObservation, dolly_storage::mcp_readiness::McpTransportProbeError> {
        unreachable!("RED seam test does not execute the transport")
    }
}

#[test]
fn readiness_seam_is_private_and_versioned() {
    assert_eq!(
        MCP_TRANSPORT_READINESS_SCHEMA,
        "dolly.mcp-transport-readiness/v1"
    );
    let _probe = NoopProbe;
    let _: Option<McpTransportReadiness> = None;
}
