use dolly_canonical_json::{CanonicalJsonValue, Sha256Digest, canonicalize};
use dolly_storage::Database;
use dolly_storage::host_authority::{
    ConfigRevisionMapping, HostAuthorityError, HostAuthorityRevision, InstallDisposition,
    InstalledComponentOrigin, LinuxServiceCandidate, ModuleActivationPremises,
    PermissionPolicyBackendBinding, PermissionPolicyDefinition, PermissionPolicySelection,
    PolicyDefinitionOrigin, ResolvedConfiguration, RuntimeAuthorityIdentity,
    install_host_authority_revision, load_current_authority,
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
fn revision_for(path: &std::path::Path) -> HostAuthorityRevision {
    let mut input = revision();
    let instance_id = format!(
        "instance-{}",
        path.parent()
            .and_then(std::path::Path::file_name)
            .expect("temp directory name")
            .to_string_lossy()
            .replace('.', "d")
            .to_ascii_lowercase()
    );
    input.identity.instance_id = instance_id.clone();
    input.mapping.instance_id = instance_id.clone();
    if let Some(premise) = input.premise.as_mut() {
        premise.instance_id = instance_id;
        let value = serde_json::to_value(&*premise).unwrap();
        premise.premises_digest = digest(&without(&value, "premises_digest"));
    }
    input
}
fn bootstrap(path: &std::path::Path, input: HostAuthorityRevision) -> Database {
    Database::open_for_migration(path)
        .unwrap()
        .install_host_authority_revision(input)
        .unwrap()
}

#[test]
fn durable_premise_survives_reopen() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("runtime.sqlite3");
    let input = revision_for(&path);
    let expected_digest = input.premise.as_ref().unwrap().premises_digest.clone();
    let db = bootstrap(&path, input.clone());
    let current = load_current_authority(db.connection()).unwrap().unwrap();
    assert_eq!(current.mapping.config_revision, 1);
    assert_eq!(current.premise.unwrap().premises_digest, expected_digest);
    drop(db);
    let reopened = Database::open(&path).unwrap();
    let loaded = load_current_authority(reopened.connection())
        .unwrap()
        .unwrap();
    assert_eq!(loaded.mapping.config_digest, input.mapping.config_digest);
}

#[test]
fn changed_bytes_at_same_revision_are_rejected_without_mutation() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("runtime.sqlite3");
    let input = revision_for(&path);
    let mut db = bootstrap(&path, input.clone());
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
    let input = revision_for(&path);
    let mut db = bootstrap(&path, input.clone());
    assert!(matches!(
        install_host_authority_revision(&mut db, input.clone()).unwrap(),
        InstallDisposition::Reused { config_revision: 1 }
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
    let mut db = bootstrap(&path, revision_for(&path));
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
    let db = bootstrap(&path, input);
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
    let first = revision_for(&path);
    let mut db = bootstrap(&path, first.clone());
    let prior = load_current_authority(db.connection()).unwrap().unwrap();

    let mut incoming = revision_for(&path);
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
    let state: (i64, String) = db
        .connection()
        .query_row(
            "SELECT current_config_revision, current_config_digest
             FROM runtime_authority_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(state.0, prior.mapping.config_revision);
    assert_eq!(state.1, prior.mapping.config_digest.to_string());
    assert!(matches!(
        load_current_authority(db.connection()),
        Err(HostAuthorityError::RevisionConflict { .. })
    ));
}

#[test]
fn closed_validator_grammar_rejects_cross_language_cases_before_writes() {
    fn rejects(input: HostAuthorityRevision) {
        let directory = tempdir().unwrap();
        let path = directory.path().join("runtime.sqlite3");
        let mut db = bootstrap(&path, revision());
        let error = install_host_authority_revision(&mut db, input);
        assert!(
            matches!(
                error,
                Err(HostAuthorityError::Malformed(_))
                    | Err(HostAuthorityError::DigestMismatch(_))
            ),
            "unexpected grammar error: {error:?}"
        );
    }

    let mut uppercase_uuid = revision();
    uppercase_uuid.mapping.daemon_installation_id = uppercase_uuid
        .mapping
        .daemon_installation_id
        .to_ascii_uppercase();
    rejects(uppercase_uuid);

    let mut digit_first_instance = revision();
    digit_first_instance.mapping.instance_id = "1instance".into();
    rejects(digit_first_instance);

    let mut uppercase_component = revision();
    uppercase_component
        .premise
        .as_mut()
        .unwrap()
        .service_candidate
        .origin
        .component_id = "Org.dolly.host-runtime".into();
    rejects(uppercase_component);

    let mut short_unit = revision();
    short_unit
        .mapping
        .canonical_config
        .service_candidate
        .as_mut()
        .unwrap()
        .unit_name = "a.servic".into();
    rejects(short_unit);
}
