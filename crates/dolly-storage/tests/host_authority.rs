use dolly_canonical_json::{CanonicalJsonValue, Sha256Digest, canonicalize};
use dolly_storage::Database;
use dolly_storage::host_authority::{
    ConfigRevisionMapping, HostAuthorityError, HostAuthorityRevision, InstallDisposition,
    InstalledComponentOrigin, LinuxServiceCandidate, ModuleActivationPremises,
    PermissionPolicyBackendBinding, PermissionPolicyDefinition, PermissionPolicySelection,
    PolicyDefinitionOrigin, ResolvedConfiguration, RuntimeAuthorityIdentity,
    create_host_authority_schema, install_host_authority_revision, load_current_authority,
};
use rusqlite::params;
use serde_json::{Value, json};
use tempfile::tempdir;

fn digest(value: &Value) -> Sha256Digest {
    canonicalize(value).unwrap().1
}
fn without(value: &Value, field: &str) -> Value {
    let mut object = value.as_object().unwrap().clone();
    object.remove(field);
    Value::Object(object)
}
fn origin() -> InstalledComponentOrigin {
    InstalledComponentOrigin {
        schema: "dolly.installed-component-origin/v1".into(),
        kind: "installed_product_component".into(),
        component_id: "org.dolly.host-runtime".into(),
        component_revision: 1,
        component_digest: digest(&json!({"component": "host-runtime"})),
    }
}
fn policy_origin() -> PolicyDefinitionOrigin {
    PolicyDefinitionOrigin {
        schema: "dolly.policy-definition-origin/v1".into(),
        kind: "operator_approved_policy".into(),
        source_id: "org.dolly.policy.default".into(),
        source_revision: 1,
        source_digest: digest(&json!({"policy": "default"})),
    }
}
fn definition() -> PermissionPolicyDefinition {
    let mut record = json!({
        "schema": "dolly.permission-policy-definition/v1",
        "policy_id": "default-tools",
        "policy_revision": 1,
        "definition_schema_uri": "dolly://schemas/host-permission-policy/v1",
        "definition_schema_digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        "definition": {"tools": {"invoke": true}},
        "origin": serde_json::to_value(policy_origin()).unwrap(),
        "definition_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    });
    let computed = digest(&without(&record, "definition_digest")).to_string();
    record
        .as_object_mut()
        .unwrap()
        .insert("definition_digest".into(), Value::String(computed));
    serde_json::from_value(record).unwrap()
}
fn binding(definition: &PermissionPolicyDefinition) -> PermissionPolicyBackendBinding {
    let mut record = json!({
        "schema": "dolly.permission-policy-backend-binding/v1",
        "binding_id": "host-policy-backend",
        "binding_revision": 1,
        "binding_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        "policy_id": definition.policy_id,
        "policy_revision": definition.policy_revision,
        "policy_definition_digest": definition.definition_digest,
        "origin": serde_json::to_value(origin()).unwrap()
    });
    let computed = digest(&without(&record, "binding_digest")).to_string();
    record
        .as_object_mut()
        .unwrap()
        .insert("binding_digest".into(), Value::String(computed));
    serde_json::from_value(record).unwrap()
}
fn candidate() -> LinuxServiceCandidate {
    let mut record = json!({
        "schema": "dolly.linux-service-candidate/v1",
        "origin": serde_json::to_value(origin()).unwrap(),
        "unit_name": "dollyd.service",
        "mode": "user",
        "candidate_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    });
    let computed = digest(&without(&record, "candidate_digest")).to_string();
    record
        .as_object_mut()
        .unwrap()
        .insert("candidate_digest".into(), Value::String(computed));
    serde_json::from_value(record).unwrap()
}
fn revision() -> HostAuthorityRevision {
    let definition = definition();
    let binding = binding(&definition);
    let service_candidate = candidate();
    let config = ResolvedConfiguration {
        runtime_config: CanonicalJsonValue::try_from(json!({"modules": []})).unwrap(),
        permission_policy_selections: vec![PermissionPolicySelection {
            policy_id: definition.policy_id.clone(),
            policy_revision: definition.policy_revision,
            policy_definition_digest: definition.definition_digest.clone(),
            binding_id: binding.binding_id.clone(),
            binding_revision: binding.binding_revision,
            binding_digest: binding.binding_digest.clone(),
        }],
        service_candidate: Some(service_candidate.clone()),
    };
    let config_digest = canonicalize(&config).unwrap().1;
    let premise_without_digest = json!({
        "schema": "dolly.module-activation-premises/v1",
        "daemon_installation_id": "0198ab31-6c44-7e8a-b2bb-000000000001",
        "instance_id": "instance-one", "config_revision": 1, "config_digest": config_digest,
        "permission_policy_definitions": [serde_json::to_value(&definition).unwrap()],
        "permission_policy_backend_bindings": [serde_json::to_value(&binding).unwrap()],
        "service_candidate": serde_json::to_value(&service_candidate).unwrap()
    });
    let premise = ModuleActivationPremises {
        schema: "dolly.module-activation-premises/v1".into(),
        daemon_installation_id: "0198ab31-6c44-7e8a-b2bb-000000000001".into(),
        instance_id: "instance-one".into(),
        config_revision: 1,
        config_digest: config_digest.clone(),
        permission_policy_definitions: vec![definition],
        permission_policy_backend_bindings: vec![binding],
        service_candidate,
        premises_digest: digest(&premise_without_digest),
    };
    HostAuthorityRevision {
        identity: RuntimeAuthorityIdentity {
            daemon_installation_id: premise.daemon_installation_id.clone(),
            instance_id: premise.instance_id.clone(),
        },
        mapping: ConfigRevisionMapping {
            schema: "dolly.config-revision-mapping/v1".into(),
            daemon_installation_id: premise.daemon_installation_id.clone(),
            instance_id: premise.instance_id.clone(),
            config_revision: 1,
            config_digest,
            canonical_config: config,
        },
        premise: Some(premise),
    }
}

#[test]
fn durable_premise_survives_reopen() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("runtime.sqlite3");
    let mut db = Database::open(&path).unwrap();
    create_host_authority_schema(db.connection_mut()).unwrap();
    let input = revision();
    let expected_digest = input.premise.as_ref().unwrap().premises_digest.clone();
    install_host_authority_revision(&mut db, input.clone()).unwrap();
    let current = load_current_authority(db.connection()).unwrap().unwrap();
    assert_eq!(current.mapping.config_revision, 1);
    assert_eq!(current.premise.unwrap().premises_digest, expected_digest);
    drop(db);
    let mut reopened = Database::open(&path).unwrap();
    create_host_authority_schema(reopened.connection_mut()).unwrap();
    let loaded = load_current_authority(reopened.connection())
        .unwrap()
        .unwrap();
    assert_eq!(loaded.mapping.config_digest, input.mapping.config_digest);
}

#[test]
fn changed_bytes_at_same_revision_are_rejected_without_mutation() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("runtime.sqlite3");
    let mut db = Database::open(&path).unwrap();
    create_host_authority_schema(db.connection_mut()).unwrap();
    let input = revision();
    install_host_authority_revision(&mut db, input.clone()).unwrap();
    let mut conflicting = input;
    conflicting.mapping.canonical_config.runtime_config =
        CanonicalJsonValue::try_from(json!({"modules": ["changed"]})).unwrap();
    let error = install_host_authority_revision(&mut db, conflicting).unwrap_err();
    assert!(matches!(error, HostAuthorityError::DigestMismatch(_)));
    assert_eq!(
        load_current_authority(db.connection())
            .unwrap()
            .unwrap()
            .mapping
            .config_revision,
        1
    );
}

#[test]
fn equal_current_revision_is_reused_without_new_authority_rows() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("runtime.sqlite3");
    let mut db = Database::open(&path).unwrap();
    create_host_authority_schema(db.connection_mut()).unwrap();
    let input = revision();
    assert!(matches!(
        install_host_authority_revision(&mut db, input.clone()).unwrap(),
        InstallDisposition::Committed { config_revision: 1 }
    ));
    assert!(matches!(
        install_host_authority_revision(&mut db, input).unwrap(),
        InstallDisposition::Reused { config_revision: 1 }
    ));
}

#[test]
fn canonical_projection_tampering_is_rejected_on_read() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("runtime.sqlite3");
    let mut db = Database::open(&path).unwrap();
    create_host_authority_schema(db.connection_mut()).unwrap();
    install_host_authority_revision(&mut db, revision()).unwrap();
    db.connection_mut()
        .execute(
            "UPDATE permission_policy_definitions SET record_jcs = ?1 WHERE policy_id = 'default-tools'",
            [b"{}".as_slice()],
        )
        .unwrap();
    assert!(load_current_authority(db.connection()).is_err());
}

#[test]
fn configuration_without_host_prerequisites_has_no_premise() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("runtime.sqlite3");
    let mut db = Database::open(&path).unwrap();
    create_host_authority_schema(db.connection_mut()).unwrap();
    let config = ResolvedConfiguration {
        runtime_config: CanonicalJsonValue::try_from(json!({"modules": []})).unwrap(),
        permission_policy_selections: Vec::new(),
        service_candidate: None,
    };
    let config_digest = canonicalize(&config).unwrap().1;
    let identity = RuntimeAuthorityIdentity {
        daemon_installation_id: "0198ab31-6c44-7e8a-b2bb-000000000002".into(),
        instance_id: "instance-two".into(),
    };
    let input = HostAuthorityRevision {
        identity: identity.clone(),
        mapping: ConfigRevisionMapping {
            schema: "dolly.config-revision-mapping/v1".into(),
            daemon_installation_id: identity.daemon_installation_id.clone(),
            instance_id: identity.instance_id.clone(),
            config_revision: 1,
            config_digest,
            canonical_config: config,
        },
        premise: None,
    };
    install_host_authority_revision(&mut db, input).unwrap();
    assert!(
        load_current_authority(db.connection())
            .unwrap()
            .unwrap()
            .premise
            .is_none()
    );
}

#[test]
fn orphan_next_revision_mapping_identity_is_rejected_before_pointer_publish() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("runtime.sqlite3");
    let mut db = Database::open(&path).unwrap();
    create_host_authority_schema(db.connection_mut()).unwrap();
    let first = revision();
    install_host_authority_revision(&mut db, first.clone()).unwrap();
    let prior = load_current_authority(db.connection()).unwrap().unwrap();

    let mut incoming = revision();
    incoming.mapping.config_revision = 2;
    let premise = incoming.premise.as_mut().unwrap();
    premise.config_revision = 2;
    let premise_value = serde_json::to_value(&*premise).unwrap();
    premise.premises_digest = digest(&without(&premise_value, "premises_digest"));
    let config_bytes = canonicalize(&incoming.mapping.canonical_config)
        .unwrap()
        .0
        .as_ref()
        .to_vec();
    db.connection_mut()
        .execute(
            "INSERT INTO config_revision_mappings (
                config_revision, daemon_installation_id, instance_id,
                config_digest, canonical_bytes
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                2_i64,
                "0198ab31-6c44-7e8a-b2bb-000000000003",
                "wrong-instance",
                incoming.mapping.config_digest.to_string(),
                config_bytes,
            ],
        )
        .unwrap();

    let error = install_host_authority_revision(&mut db, incoming).unwrap_err();
    assert!(matches!(error, HostAuthorityError::RevisionConflict { .. }));
    let after = load_current_authority(db.connection()).unwrap().unwrap();
    assert_eq!(after.mapping.config_revision, prior.mapping.config_revision);
    assert_eq!(after.mapping.config_digest, prior.mapping.config_digest);
    assert_eq!(after.premise, prior.premise);
}
