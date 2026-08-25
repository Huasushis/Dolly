// Full premise/history migration fixtures: a designated pre-bridge TypeScript
// v1 authority carrying real premise, historical mapping, and selection rows
// must migrate explicitly; ordinary open must refuse v1; and any mismatch
// (tampered canonical bytes) must roll the migration back without mutating
// the database.
#![cfg(unix)]

use dolly_canonical_json::canonicalize;
use dolly_storage::{
    Database, StorageError,
    host_authority::{RuntimeAuthorityIdentity, load_current_authority},
};
use rusqlite::Connection;
use std::path::PathBuf;

const DAEMON: &str = "0198ab31-6c44-7e8a-b2bb-000000000001";

struct MappingRow {
    revision: i64,
    digest: String,
    canonical_bytes: Vec<u8>,
}

struct PremiseRow {
    policy_id: String,
    definition_digest: String,
    binding_id: String,
    binding_digest: String,
    config_revision: i64,
    config_digest: String,
    service_origin_component_id: String,
    service_origin_component_revision: i64,
    service_origin_component_digest: String,
    service_origin_record_jcs: Vec<u8>,
    service_candidate_digest: String,
    service_candidate_record_jcs: Vec<u8>,
    definition_record_jcs: Vec<u8>,
    binding_record_jcs: Vec<u8>,
    service_unit_name: String,
    premises_digest: String,
    record_jcs: Vec<u8>,
}

struct FullPremiseHistoryFixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
    identity: RuntimeAuthorityIdentity,
    mappings: Vec<MappingRow>,
    premises: Vec<PremiseRow>,
    selection_count: usize,
    poisoned: bool,
}

fn identity_for(path: &std::path::Path) -> RuntimeAuthorityIdentity {
    let name = path
        .parent()
        .and_then(std::path::Path::file_name)
        .expect("temp directory name")
        .to_string_lossy()
        .replace('.', "d")
        .to_ascii_lowercase();
    RuntimeAuthorityIdentity {
        daemon_installation_id: DAEMON.to_string(),
        instance_id: format!("instance-{name}"),
    }
}

fn resolved_config(revision: i64, policy_id: &str) -> (dolly_canonical_json::CanonicalBytes, String) {
    let config = serde_json::json!({
        "runtime_config": {"modules": [{"name": format!("module-{revision}")}]},
        "permission_policy_selections": [{
            "policy_id": policy_id,
            "policy_revision": 1,
            "policy_definition_digest": format!("sha256:{}", "a".repeat(64)),
            "binding_id": format!("binding-{policy_id}"),
            "binding_revision": 1,
            "binding_digest": format!("sha256:{}", "b".repeat(64)),
        }],
        "service_candidate": null,
    });
    let (bytes, digest) = canonicalize(&config).unwrap();
    (bytes, digest.to_string())
}

struct PremiseRecords {
    service_candidate: serde_json::Value,
    policy_id: String,
    definition_digest: String,
    binding_id: String,
    binding_digest: String,
    premises_digest: String,
    record_jcs: Vec<u8>,
    origin_component_id: String,
    origin_component_digest: String,
    origin_record_jcs: Vec<u8>,
    candidate_digest: String,
    candidate_record_jcs: Vec<u8>,
    definition_record_jcs: Vec<u8>,
    binding_record_jcs: Vec<u8>,
    unit_name: String,
}

fn premise_records(
    revision: i64,
    instance_id: &str,
    config_digest: &str,
) -> PremiseRecords {
    let unit_name = format!("dolly-module-{revision}.service");
    let origin_component_id = format!("org.dolly.module-{revision}");
    // Origin with self-digest.
    let mut origin = serde_json::json!({
        "schema": "dolly.installed-component-origin/v1",
        "kind": "installed_product_component",
        "component_id": origin_component_id,
        "component_revision": 1,
        "component_digest": "",
    });
    origin.as_object_mut().unwrap().remove("component_digest");
    let (origin_bytes, origin_digest) = canonicalize(&origin).unwrap();
    let origin_component_digest = origin_digest.to_string();
    origin
        .as_object_mut()
        .unwrap()
        .insert("component_digest".into(), serde_json::json!(origin_component_digest));
    let origin_record_jcs = canonicalize(&origin).unwrap().0.into_vec();
    // Candidate referencing that origin, with self-digest.
    let mut candidate = serde_json::json!({
        "schema": "dolly.linux-service-candidate/v1",
        "origin": serde_json::to_value(&origin).unwrap(),
        "unit_name": unit_name,
        "mode": "user",
        "candidate_digest": "",
    });
    candidate.as_object_mut().unwrap().remove("candidate_digest");
    let (_, candidate_digest) = canonicalize(&candidate).unwrap();
    let candidate_digest_text = candidate_digest.to_string();
    candidate
        .as_object_mut()
        .unwrap()
        .insert("candidate_digest".into(), serde_json::json!(candidate_digest_text));
    let candidate_record_jcs = canonicalize(&candidate).unwrap().0.into_vec();
    // The v1 premise record embeds the candidate and self-digests.
    // One definition and one binding, self-digested to match the config's
    // selection projection.
    let mut definition = serde_json::json!({
        "schema": "dolly.permission-policy-definition/v1",
        "policy_id": format!("policy-{revision}"),
        "policy_revision": 1,
        "definition_schema_uri": "dolly://schemas/host-permission-policy/v1",
        "definition_schema_digest": format!("sha256:{}", "f".repeat(64)),
        "definition": {"tools": {"invoke": true}},
        "origin": {
            "schema": "dolly.policy-definition-origin/v1",
            "kind": "operator_approved_policy",
            "source_id": "org.dolly.policy.default",
            "source_revision": 1,
            "source_digest": format!("sha256:{}", "0".repeat(64)),
        },
        "definition_digest": "",
    });
    definition.as_object_mut().unwrap().remove("definition_digest");
    let (_, definition_digest) = canonicalize(&definition).unwrap();
    let definition_digest_text = definition_digest.to_string();
    definition
        .as_object_mut()
        .unwrap()
        .insert("definition_digest".into(), serde_json::json!(definition_digest_text));
    let mut binding = serde_json::json!({
        "schema": "dolly.permission-policy-backend-binding/v1",
        "binding_id": format!("binding-{revision}"),
        "binding_revision": 1,
        "binding_digest": "",
        "policy_id": format!("policy-{revision}"),
        "policy_revision": 1,
        "policy_definition_digest": definition_digest_text,
        "origin": serde_json::to_value(&origin).unwrap(),
    });
    binding.as_object_mut().unwrap().remove("binding_digest");
    let (_, binding_digest) = canonicalize(&binding).unwrap();
    let binding_digest_text = binding_digest.to_string();
    binding
        .as_object_mut()
        .unwrap()
        .insert("binding_digest".into(), serde_json::json!(binding_digest_text));
    let selection_projection = serde_json::json!([{
        "policy_id": format!("policy-{revision}"),
        "policy_revision": 1,
        "policy_definition_digest": definition_digest_text,
        "binding_id": format!("binding-{revision}"),
        "binding_revision": 1,
        "binding_digest": binding_digest_text,
    }]);
    let mut premise = serde_json::json!({
        "schema": "dolly.module-activation-premises/v1",
        "daemon_installation_id": DAEMON,
        "instance_id": instance_id,
        "config_revision": revision,
        "config_digest": config_digest,
        "permission_policy_definitions": [definition],
        "permission_policy_backend_bindings": [binding],
        "service_candidate": serde_json::to_value(&candidate).unwrap(),
        "premises_digest": "",
    });
    premise.as_object_mut().unwrap().remove("premises_digest");
    let (_, premises_digest) = canonicalize(&premise).unwrap();
    let premises_digest_text = premises_digest.to_string();
    premise
        .as_object_mut()
        .unwrap()
        .insert("premises_digest".into(), serde_json::json!(premises_digest_text));
    let record_jcs = canonicalize(&premise).unwrap().0.into_vec();
    let definition_record_jcs = canonicalize(&definition).unwrap().0.into_vec();
    let binding_record_jcs = canonicalize(&binding).unwrap().0.into_vec();
    PremiseRecords {
        service_candidate: serde_json::to_value(&candidate).unwrap(),
        premises_digest: premises_digest_text,
        record_jcs,
        origin_component_id,
        origin_component_digest,
        origin_record_jcs,
        candidate_digest: candidate_digest_text,
        candidate_record_jcs,
        definition_record_jcs,
        binding_record_jcs,
        policy_id: format!("policy-{revision}"),
        definition_digest: definition_digest_text.clone(),
        binding_id: format!("binding-{revision}"),
        binding_digest: binding_digest_text,
        unit_name: format!("dolly-module-{revision}.service"),
    }
}

fn build_fixture(poisoned: bool) -> FullPremiseHistoryFixture {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("v1-authority.sqlite");
    let identity = identity_for(&path);

    let mut mappings = Vec::new();
    let mut premises = Vec::new();
    let mut selection_count = 0usize;
    for revision in [1i64, 2] {
        // The v1 config selects one policy; its premise binds the same policy.
        // Selections are derived from the premise's definition/binding pair so
        // both projections agree byte-for-byte; build them after records.
        let selection: serde_json::Value = serde_json::json!(null);
        let probe = premise_records(revision, &identity.instance_id, "sha256:pending");
        let config = serde_json::json!({
            "runtime_config": {"modules": [{"name": format!("module-{revision}")}]},
            "permission_policy_selections": [{
                "policy_id": probe.policy_id.clone(),
                "policy_revision": 1,
                "policy_definition_digest": probe.definition_digest.clone(),
                "binding_id": probe.binding_id.clone(),
                "binding_revision": 1,
                "binding_digest": probe.binding_digest.clone(),
            }],
            "service_candidate": probe.service_candidate.clone(),
        });
        let (canonical_bytes, digest) = {
            let (bytes, digest) = dolly_canonical_json::canonicalize(&config).unwrap();
            (bytes.into_vec(), digest.to_string())
        };
        let digest_text = digest.to_string();
        let records = premise_records(revision, &identity.instance_id, &digest_text);
        let mut stored_record_jcs = records.record_jcs;
        if poisoned && revision == 1 {
            let last = stored_record_jcs.len() - 1;
            stored_record_jcs[last] ^= 0xff;
        }
        premises.push(PremiseRow {
            policy_id: records.policy_id.clone(),
            definition_digest: records.definition_digest.clone(),
            binding_id: records.binding_id.clone(),
            binding_digest: records.binding_digest.clone(),
            config_revision: revision,
            config_digest: digest_text.clone(),
            service_origin_component_id: records.origin_component_id.clone(),
            service_origin_component_revision: 1,
            service_origin_component_digest: records.origin_component_digest.clone(),
            service_origin_record_jcs: records.origin_record_jcs.clone(),
            service_candidate_digest: records.candidate_digest.clone(),
            service_candidate_record_jcs: records.candidate_record_jcs.clone(),
            definition_record_jcs: records.definition_record_jcs.clone(),
            binding_record_jcs: records.binding_record_jcs.clone(),
            service_unit_name: records.unit_name.clone(),
            premises_digest: records.premises_digest.clone(),
            record_jcs: stored_record_jcs,
        });
        mappings.push(MappingRow {
            revision,
            digest: digest_text.clone(),
            canonical_bytes,
        });
    }

    FullPremiseHistoryFixture {
        _dir: dir,
        path,
        identity,
        mappings,
        premises,
        selection_count,
        poisoned,
    }
}

fn full_premise_history_fixture() -> FullPremiseHistoryFixture {
    let fixture = build_fixture(false);
    write_fixture(&fixture);
    fixture
}

fn write_full_premise_history_fixture(fixture: &FullPremiseHistoryFixture, _poisoned: bool) {
    write_fixture(fixture);
}

fn write_fixture(fixture: &FullPremiseHistoryFixture) {
    let connection = Connection::open(&fixture.path).unwrap();
    connection.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
    connection.execute_batch(
        r#"
        CREATE TABLE core_meta (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            authority_schema_version INTEGER NOT NULL CHECK (authority_schema_version = 1),
            daemon_installation_id TEXT NOT NULL,
            instance_id TEXT NOT NULL
        );
        CREATE TABLE config_revision_mappings (
            config_revision INTEGER PRIMARY KEY,
            config_digest TEXT NOT NULL,
            canonical_bytes BLOB NOT NULL,
            UNIQUE (config_revision, config_digest)
        );
        CREATE TABLE installed_component_origins (
            component_id TEXT NOT NULL,
            component_revision INTEGER NOT NULL CHECK (component_revision BETWEEN 1 AND 9007199254740991),
            component_digest TEXT NOT NULL,
            record_jcs BLOB NOT NULL,
            PRIMARY KEY (component_id, component_revision),
            UNIQUE (component_id, component_revision, component_digest)
        );
        CREATE TABLE permission_policy_definitions (
            policy_id TEXT NOT NULL,
            policy_revision INTEGER NOT NULL CHECK (policy_revision BETWEEN 1 AND 9007199254740991),
            definition_digest TEXT NOT NULL,
            record_jcs BLOB NOT NULL,
            PRIMARY KEY (policy_id, policy_revision),
            UNIQUE (policy_id, policy_revision, definition_digest)
        );
        CREATE TABLE permission_policy_backend_bindings (
            binding_id TEXT NOT NULL,
            binding_revision INTEGER NOT NULL CHECK (binding_revision BETWEEN 1 AND 9007199254740991),
            binding_digest TEXT NOT NULL,
            policy_id TEXT NOT NULL,
            policy_revision INTEGER NOT NULL,
            policy_definition_digest TEXT NOT NULL,
            origin_component_id TEXT NOT NULL,
            origin_component_revision INTEGER NOT NULL,
            origin_component_digest TEXT NOT NULL,
            record_jcs BLOB NOT NULL,
            PRIMARY KEY (binding_id, binding_revision),
            UNIQUE (binding_id, binding_revision, binding_digest, policy_id, policy_revision, policy_definition_digest),
            FOREIGN KEY (policy_id, policy_revision, policy_definition_digest)
              REFERENCES permission_policy_definitions(policy_id, policy_revision, definition_digest),
            FOREIGN KEY (origin_component_id, origin_component_revision, origin_component_digest)
              REFERENCES installed_component_origins(component_id, component_revision, component_digest)
        );
        CREATE TABLE linux_service_candidates (
            origin_component_id TEXT NOT NULL,
            origin_component_revision INTEGER NOT NULL CHECK (origin_component_revision BETWEEN 1 AND 9007199254740991),
            origin_component_digest TEXT NOT NULL,
            unit_name TEXT NOT NULL,
            mode TEXT NOT NULL CHECK (mode = 'user'),
            candidate_digest TEXT NOT NULL,
            record_jcs BLOB NOT NULL,
            PRIMARY KEY (origin_component_id, origin_component_revision, unit_name, mode),
            UNIQUE (origin_component_id, origin_component_revision, unit_name, mode, candidate_digest),
            FOREIGN KEY (origin_component_id, origin_component_revision, origin_component_digest)
              REFERENCES installed_component_origins(component_id, component_revision, component_digest)
        );
        CREATE TABLE module_activation_premises (
            config_revision INTEGER PRIMARY KEY CHECK (config_revision BETWEEN 1 AND 9007199254740991),
            config_digest TEXT NOT NULL,
            service_origin_component_id TEXT NOT NULL,
            service_origin_component_revision INTEGER NOT NULL,
            service_unit_name TEXT NOT NULL,
            service_mode TEXT NOT NULL,
            service_candidate_digest TEXT NOT NULL,
            premises_digest TEXT NOT NULL,
            record_jcs BLOB NOT NULL,
            UNIQUE (config_revision, config_digest),
            FOREIGN KEY (config_revision, config_digest)
              REFERENCES config_revision_mappings(config_revision, config_digest),
            FOREIGN KEY (service_origin_component_id, service_origin_component_revision,
                         service_unit_name, service_mode, service_candidate_digest)
              REFERENCES linux_service_candidates(origin_component_id, origin_component_revision,
                                                  unit_name, mode, candidate_digest)
        );
        CREATE TABLE module_activation_premise_policy_selections (
            config_revision INTEGER NOT NULL CHECK (config_revision BETWEEN 1 AND 9007199254740991),
            policy_id TEXT NOT NULL,
            policy_revision INTEGER NOT NULL,
            policy_definition_digest TEXT NOT NULL,
            binding_id TEXT NOT NULL,
            binding_revision INTEGER NOT NULL,
            binding_digest TEXT NOT NULL,
            PRIMARY KEY (config_revision, policy_id, policy_revision),
            UNIQUE (config_revision, binding_id, binding_revision, binding_digest),
            FOREIGN KEY (config_revision) REFERENCES module_activation_premises(config_revision) DEFERRABLE INITIALLY DEFERRED,
            FOREIGN KEY (policy_id, policy_revision, policy_definition_digest)
              REFERENCES permission_policy_definitions(policy_id, policy_revision, definition_digest),
            FOREIGN KEY (binding_id, binding_revision, binding_digest, policy_id, policy_revision, policy_definition_digest)
              REFERENCES permission_policy_backend_bindings(binding_id, binding_revision, binding_digest,
                                                            policy_id, policy_revision, policy_definition_digest)
        );
        CREATE TABLE runtime_authority_state (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            authority_schema_version INTEGER NOT NULL CHECK (authority_schema_version = 1),
            daemon_installation_id TEXT NOT NULL,
            instance_id TEXT NOT NULL,
            current_config_revision INTEGER NOT NULL CHECK (current_config_revision BETWEEN 1 AND 9007199254740991),
            current_config_digest TEXT NOT NULL,
            record_jcs BLOB NOT NULL,
            FOREIGN KEY (current_config_revision, current_config_digest)
              REFERENCES config_revision_mappings(config_revision, config_digest)
        );
        "#,
    )
    .unwrap();

    connection
        .execute(
            "INSERT INTO core_meta VALUES (1, 1, ?1, ?2)",
            rusqlite::params![
                fixture.identity.daemon_installation_id,
                fixture.identity.instance_id
            ],
        )
        .unwrap();

    let latest = fixture.mappings.last().unwrap();
    let state_record = serde_json::json!({
        "schema": "dolly.runtime-authority-state/v1",
        "authority_schema_version": 1,
        "daemon_installation_id": fixture.identity.daemon_installation_id,
        "instance_id": fixture.identity.instance_id,
        "current_config_revision": latest.revision,
        "current_config_digest": latest.digest,
    });
    let state_bytes = canonicalize(&state_record).unwrap().0.to_string().into_bytes();

    for premise in &fixture.premises {
        connection
            .execute(
                "INSERT INTO permission_policy_definitions VALUES (?1, 1, ?2, ?3)",
                rusqlite::params![
                    premise.policy_id,
                    premise.definition_digest,
                    premise.definition_record_jcs
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO permission_policy_backend_bindings VALUES (?1, 1, ?2, ?3, 1, ?4, ?5, 1, ?6, ?7)",
                rusqlite::params![
                    premise.binding_id,
                    premise.binding_digest,
                    premise.policy_id,
                    premise.definition_digest,
                    premise.service_origin_component_id,
                    premise.service_origin_component_digest,
                    premise.binding_record_jcs
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO installed_component_origins VALUES (?1, 1, ?2, ?3)",
                rusqlite::params![
                    premise.service_origin_component_id,
                    premise.service_origin_component_digest,
                    premise.service_origin_record_jcs
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO linux_service_candidates VALUES (?1, 1, ?2, ?3, 'user', ?4, ?5)",
                rusqlite::params![
                    premise.service_origin_component_id,
                    premise.service_origin_component_digest,
                    premise.service_unit_name,
                    premise.service_candidate_digest,
                    premise.service_candidate_record_jcs
                ],
            )
            .unwrap();
    }
    for premise in &fixture.premises {
        connection
            .execute(
                "INSERT INTO module_activation_premise_policy_selections VALUES (?1, ?2, 1, ?3, ?4, 1, ?5)",
                rusqlite::params![
                    premise.config_revision,
                    premise.policy_id,
                    premise.definition_digest,
                    premise.binding_id,
                    premise.binding_digest
                ],
            )
            .unwrap();
    }
    for mapping in &fixture.mappings {
        connection
            .execute(
                "INSERT INTO config_revision_mappings VALUES (?1, ?2, ?3)",
                rusqlite::params![mapping.revision, mapping.digest, mapping.canonical_bytes],
            )
            .unwrap();
    }
    for premise in &fixture.premises {
        connection
            .execute(
                "INSERT INTO module_activation_premises VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![
                    premise.config_revision,
                    premise.config_digest,
                    premise.service_origin_component_id,
                    premise.service_origin_component_revision,
                    premise.service_unit_name,
                    "user",
                    premise.service_candidate_digest,
                    premise.premises_digest,
                    premise.record_jcs
                ],
            )
            .unwrap();
    }
    connection
        .execute(
            "INSERT INTO runtime_authority_state VALUES (1, 1, ?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                fixture.identity.daemon_installation_id,
                fixture.identity.instance_id,
                latest.revision,
                latest.digest,
                state_bytes
            ],
        )
        .unwrap();
    connection.execute_batch("PRAGMA user_version = 1;").unwrap();
    drop(connection);
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn full_premise_history_v1_migrates_and_preserves_every_row() {
    let fixture = full_premise_history_fixture();
    let path = &fixture.path;

    assert!(matches!(
        Database::open(path),
        Err(StorageError::MigrationRequired)
    ));

    let migrated = Database::open_for_migration(path)
        .expect("offline handle")
        .migrate_v1_authority()
        .expect("full premise/history v1 migrates");
    let connection = migrated.connection();

    let mut statement = connection
        .prepare(
            "SELECT config_revision, daemon_installation_id, instance_id,
                    config_digest, hex(canonical_bytes)
             FROM config_revision_mappings ORDER BY config_revision",
        )
        .unwrap();
    let mappings: Vec<(i64, String, String, String, String)> = statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    drop(statement);
    assert_eq!(mappings.len(), 2, "both history rows survive");
    for (revision, daemon, instance, digest, canonical_hex) in &mappings {
        assert_eq!(daemon, &fixture.identity.daemon_installation_id);
        assert_eq!(instance, &fixture.identity.instance_id);
        let expected = fixture.mappings.iter().find(|m| m.revision == *revision).unwrap();
        assert_eq!(digest, &expected.digest);
        assert_eq!(
            canonical_hex.to_ascii_lowercase(),
            hex_lower(&expected.canonical_bytes),
            "mapping revision {revision} canonical bytes preserved"
        );
    }

    let mut statement = connection
        .prepare(
            "SELECT config_revision, premises_digest, upper(hex(record_jcs))
             FROM module_activation_premises ORDER BY config_revision",
        )
        .unwrap();
    let premises: Vec<(i64, String, String)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    drop(statement);
    assert_eq!(premises.len(), 2, "both premise rows survive");
    for premise in &premises {
        let expected = fixture
            .premises
            .iter()
            .find(|p| p.config_revision == premise.0)
            .unwrap();
        assert_eq!(&premise.1, &expected.premises_digest, "premises digest");
        assert_eq!(
            &premise.2.to_ascii_lowercase(),
            &hex_lower(&expected.record_jcs),
            "premise record_jcs preserved"
        );
    }

    let (state_daemon, state_instance): (String, String) = connection
        .query_row(
            "SELECT daemon_installation_id, instance_id
             FROM runtime_authority_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(state_daemon, fixture.identity.daemon_installation_id);
    assert_eq!(state_instance, fixture.identity.instance_id);

    assert!(
        load_current_authority(connection).expect("verified load").is_some()
    );
    drop(migrated);

    Database::open(path).expect("ordinary open after explicit migration");
}

#[test]
fn tampered_premise_bytes_roll_the_migration_back() {
    let fixture = build_fixture(true);
    write_fixture(&fixture);
    let path = fixture.path.clone();

    assert!(matches!(
        Database::open(&path),
        Err(StorageError::MigrationRequired)
    ));
    let error = Database::open_for_migration(&path)
        .expect("offline handle")
        .migrate_v1_authority()
        .expect_err("tampered premise rolls the migration back");
    assert!(
        matches!(
            error,
            StorageError::Corrupt | StorageError::MigrationRequired
        ),
        "rollback error was {error:?}"
    );

    assert!(matches!(
        Database::open(&path),
        Err(StorageError::MigrationRequired)
    ));
    let unchanged = Connection::open(&path).unwrap();
    let columns: Vec<String> = unchanged
        .prepare("PRAGMA table_info(config_revision_mappings)")
        .unwrap()
        .query_map([], |row| row.get(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        columns,
        vec![
            "config_revision".to_string(),
            "config_digest".to_string(),
            "canonical_bytes".to_string(),
        ],
        "v1 mapping table untouched after rollback"
    );
}
