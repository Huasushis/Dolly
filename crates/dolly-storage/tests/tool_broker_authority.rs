use dolly_canonical_json::{CanonicalJsonValue, Sha256Digest};
use dolly_core_domain::{ExtensionGeneration, WorkerEpoch};
use dolly_storage::host_authority::InstalledComponentOrigin;
use dolly_storage::tool_broker_authority::{
    TOOL_REGISTRY_RECORD_SCHEMA, ToolBrokerAuthorityCode, ToolRegistryRecord,
};

fn digest(byte: u8) -> Sha256Digest {
    format!("sha256:{:064x}", byte as u128).parse().unwrap()
}

fn record() -> ToolRegistryRecord {
    ToolRegistryRecord {
        schema: TOOL_REGISTRY_RECORD_SCHEMA.to_owned(),
        registry_revision: 1,
        config_revision: 7,
        config_digest: digest(1),
        tool_broker_config: CanonicalJsonValue::Object(Default::default()),
        tool_broker_config_digest: digest(2),
        premises_digest: digest(3),
        service_candidate_digest: digest(4),
        service_candidate_origin: InstalledComponentOrigin {
            schema: "dolly.installed-component-origin/v1".into(),
            kind: "installed_product_component".into(),
            component_id: "org.dolly.host-runtime".into(),
            component_revision: 1,
            component_digest: digest(5),
        },
        extension_alias: "org.dolly.tools".parse().unwrap(),
        controller_generation: ExtensionGeneration::new(1).unwrap(),
        worker_epoch: "0198ab31-6c44-7e8a-b2bb-000000000001"
            .parse::<WorkerEpoch>()
            .unwrap(),
        extension_generation: ExtensionGeneration::new(1).unwrap(),
        runtime_binding_digest: digest(6),
        mcp_readiness_digest: digest(7),
        server_id: "tools".into(),
        server_digest: digest(8),
        server_adapter: "mcp".into(),
        server_protocol_version: "2025-06-18".into(),
        server_transport_kind: "stdio".into(),
        server_endpoint_digest: digest(9),
        server_transport_digest: digest(10),
        tool_server_generation: 1,
    }
}

#[test]
fn canonical_record_is_immutable_and_versioned() {
    let record = record();
    let (bytes, digest) = record.canonical_bytes_and_digest().unwrap();
    assert_eq!(record.schema, TOOL_REGISTRY_RECORD_SCHEMA);
    assert_eq!(record.verify_canonical(bytes.as_ref(), &digest), Ok(()));
    let mut changed = record.clone();
    changed.server_id = "other".into();
    assert_ne!(changed.canonical_bytes_and_digest().unwrap().1, digest);
}

#[test]
fn malformed_binding_and_stale_readiness_are_refused() {
    let record = record();
    assert_eq!(
        record
            .validate_identity(
                8,
                &digest(1),
                &digest(3),
                &digest(6),
                &digest(7),
                &digest(4),
                &record.service_candidate_origin,
                &record.extension_alias,
                1,
                1,
                "0198ab31-6c44-7e8a-b2bb-000000000001",
                "tools",
                &digest(8),
                "mcp",
                "2025-06-18",
                "stdio",
                &digest(9),
                &digest(10),
            )
            .unwrap_err()
            .code,
        ToolBrokerAuthorityCode::RegistryBindingMismatch
    );
    assert_eq!(
        record
            .validate_identity(
                7,
                &digest(1),
                &digest(3),
                &digest(6),
                &digest(99),
                &digest(4),
                &record.service_candidate_origin,
                &record.extension_alias,
                1,
                1,
                "0198ab31-6c44-7e8a-b2bb-000000000001",
                "tools",
                &digest(8),
                "mcp",
                "2025-06-18",
                "stdio",
                &digest(9),
                &digest(10),
            )
            .unwrap_err()
            .code,
        ToolBrokerAuthorityCode::ReadinessStale
    );
}

#[test]
fn full_identity_gate_covers_server_and_origin() {
    let mut record = record();
    record.service_candidate_digest = digest(44);
    let mut origin = record.service_candidate_origin.clone();
    origin.component_revision += 1;
    record.service_candidate_origin = origin.clone();
    assert_eq!(
        record
            .validate_identity(
                7,
                &digest(1),
                &digest(3),
                &digest(6),
                &digest(7),
                &digest(44),
                &origin,
                &record.extension_alias,
                1,
                1,
                "0198ab31-6c44-7e8a-b2bb-000000000001",
                "tools",
                &digest(8),
                "mcp",
                "2025-06-18",
                "stdio",
                &digest(9),
                &digest(10),
            )
            .unwrap(),
        ()
    );
    let mut changed = record.clone();
    changed.server_digest = digest(45);
    assert_eq!(
        changed
            .validate_identity(
                7,
                &digest(1),
                &digest(3),
                &digest(6),
                &digest(7),
                &digest(44),
                &origin,
                &record.extension_alias,
                1,
                1,
                "0198ab31-6c44-7e8a-b2bb-000000000001",
                "tools",
                &digest(8),
                "mcp",
                "2025-06-18",
                "stdio",
                &digest(9),
                &digest(10),
            )
            .unwrap_err()
            .code,
        ToolBrokerAuthorityCode::RegistryBindingMismatch
    );
}

#[test]
fn duplicate_generation_is_distinct_from_immutable_replay() {
    let record = record();
    assert_eq!(record.validate_generation(1), Ok(()));
    assert_eq!(
        record.validate_generation(2).unwrap_err().code,
        ToolBrokerAuthorityCode::DuplicateGeneration
    );
}
