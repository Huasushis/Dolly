use dolly_canonical_json::{CanonicalJsonValue, Sha256Digest, canonicalize};
use dolly_storage::Database;
use dolly_storage::host_authority::{
    ConfigRevisionMapping, HostAuthorityRevision, InstalledComponentOrigin, LinuxServiceCandidate,
    ModuleActivationPremises, ResolvedConfiguration, RuntimeAuthorityIdentity,
    create_host_authority_schema,
};
use dolly_storage::linux_host_verification::{
    LinuxHostVerificationCode, verify_current_linux_host,
};
use rusqlite::Connection;
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};

fn digest(value: &Value) -> Sha256Digest {
    canonicalize(value).unwrap().1
}

fn without(value: &Value, field: &str) -> Value {
    let mut object = value.as_object().unwrap().clone();
    object.remove(field);
    Value::Object(object)
}

fn authority_with_instance(
    instance_id: &str,
) -> dolly_storage::host_authority::CurrentAuthoritySnapshot {
    let origin = InstalledComponentOrigin {
        schema: "dolly.installed-component-origin/v1".into(),
        kind: "installed_product_component".into(),
        component_id: "org.dolly.host-runtime".into(),
        component_revision: 1,
        component_digest: digest(&json!({"component": "host-runtime"})),
    };
    let mut candidate_record = json!({
        "schema": "dolly.linux-service-candidate/v1",
        "origin": serde_json::to_value(&origin).unwrap(),
        "unit_name": "dollyd@main.service",
        "mode": "user",
        "candidate_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    });
    candidate_record["candidate_digest"] =
        json!(digest(&without(&candidate_record, "candidate_digest")).to_string());
    let candidate: LinuxServiceCandidate = serde_json::from_value(candidate_record).unwrap();
    let config = ResolvedConfiguration {
        runtime_config: CanonicalJsonValue::try_from(json!({"modules": ["installed"]})).unwrap(),
        permission_policy_selections: Vec::new(),
        service_candidate: Some(candidate.clone()),
    };
    let config_digest = canonicalize(&config).unwrap().1;
    let mut premise_record = json!({
        "schema": "dolly.module-activation-premises/v1",
        "daemon_installation_id": "0198ab31-6c44-7e8a-b2bb-000000000001",
        "instance_id": instance_id,
        "config_revision": 1,
        "config_digest": config_digest,
        "permission_policy_definitions": [],
        "permission_policy_backend_bindings": [],
        "service_candidate": serde_json::to_value(&candidate).unwrap(),
        "premises_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    });
    premise_record["premises_digest"] =
        json!(digest(&without(&premise_record, "premises_digest")).to_string());
    let premise: ModuleActivationPremises = serde_json::from_value(premise_record).unwrap();
    dolly_storage::host_authority::CurrentAuthoritySnapshot {
        mapping: ConfigRevisionMapping {
            schema: "dolly.config-revision-mapping/v1".into(),
            daemon_installation_id: premise.daemon_installation_id.clone(),
            instance_id: premise.instance_id.clone(),
            config_revision: 1,
            config_digest,
            canonical_config: config,
        },
        premise: Some(premise),
        controller_generation_id: "test-controller-generation".into(),
    }
}

fn durable_database() -> (TempDir, Database) {
    let directory = tempdir().unwrap();
    let suffix = directory
        .path()
        .file_name()
        .expect("temp directory name")
        .to_string_lossy()
        .replace('.', "d")
        .to_ascii_lowercase();
    let instance_id = format!("instance-{suffix}");
    let path = directory.path().join("runtime.sqlite3");
    let snapshot = authority_with_instance(&instance_id);
    let db = Database::open_for_migration(&path)
        .unwrap()
        .install_host_authority_revision(HostAuthorityRevision {
            identity: RuntimeAuthorityIdentity {
                daemon_installation_id: snapshot.mapping.daemon_installation_id.clone(),
                instance_id: snapshot.mapping.instance_id.clone(),
            },
            mapping: snapshot.mapping,
            premise: snapshot.premise,
        })
        .unwrap();
    (directory, db)
}

#[test]
fn production_entrypoint_requires_authoritative_sqlite_connection() {
    let connection = Connection::open_in_memory().unwrap();
    create_host_authority_schema(&connection).unwrap();
    let error = verify_current_linux_host(&connection).unwrap_err();
    assert_eq!(error.code, LinuxHostVerificationCode::PremiseMissing);
}

#[cfg(target_os = "linux")]
#[test]
fn production_linux_seam_uses_persisted_candidate_and_fails_closed_when_absent() {
    let (_directory, db) = durable_database();
    let error = verify_current_linux_host(db.connection()).unwrap_err();
    assert!(matches!(
        error.code,
        LinuxHostVerificationCode::UnitMissing
            | LinuxHostVerificationCode::ObservationUnavailable
            | LinuxHostVerificationCode::CgroupPathMismatch
    ));
}
