use dolly_canonical_json::{canonicalize, Sha256Digest};
use dolly_core_domain::{ModuleId, ModuleStorageScopeId, Timestamp};
use dolly_core_reducer::{
    CoreCommand, EnvironmentInput, InstallConfigCommand, InstallGraphCommand, TransitionOutcome,
};
use dolly_observability::{
    BackupError, BoundedLogBuffer, LogError, LogLevel, LogLimits, LogPushOutcome, ModuleBackup,
    ModuleRestoreRequest, ModuleStateProjection, PayloadAuthorization, ReplayError, ReplayLimits,
    ReplayMode, ReplayRecorder, StructuredLogEvent,
};
use dolly_storage::{HostConnectionAuthority, SqliteCoreStore};
use rusqlite::Connection;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::str::FromStr;

fn module_id() -> ModuleId {
    ModuleId::from_string("memory-main".to_owned()).unwrap()
}

fn scope_id() -> ModuleStorageScopeId {
    ModuleStorageScopeId::from_uuid_v7("0198ab31-6c44-7e8a-b2bb-000000000154".parse().unwrap())
}

fn storage_module_id() -> ModuleId {
    ModuleId::from_string("timer".to_owned()).unwrap()
}

fn digest(value: &Value) -> String {
    canonicalize(value).unwrap().1.to_canonical_string()
}

fn storage_input() -> EnvironmentInput {
    EnvironmentInput {
        now: "2026-08-28T12:00:00.000000Z".into(),
        ..Default::default()
    }
}

fn storage_descriptor() -> Value {
    json!({
        "schema": "dolly.module-descriptor/v1",
        "module_id": "timer",
        "descriptor_revision": 1,
        "display_name": "timer",
        "accepts": {"summary": "input", "part_kinds": ["text"], "action_names": []},
        "emits": {"summary": "output", "part_kinds": ["text"]},
        "actions": [],
        "activation_replay_contract": {
            "mode": "fenced_replay",
            "evidence": "pure_compute",
            "ledger": null
        },
        "trust": "trusted",
        "metadata": {}
    })
}

fn storage_graph() -> Value {
    let descriptor = storage_descriptor();
    json!({
        "receiving_module": "timer",
        "input_pages": {},
        "output_pages": {},
        "subscriptions": {},
        "descriptors": {
            "timer": {
                "module_id": "timer",
                "descriptor_revision": 1,
                "source_descriptor_digest": digest(&descriptor),
                "value": descriptor
            }
        },
        "authorized_metadata_namespaces": [],
        "authorized_action_names": []
    })
}

fn storage_setup() -> (Connection, HostConnectionAuthority) {
    let mut connection = Connection::open_in_memory().unwrap();
    let mut store = SqliteCoreStore::new(&mut connection).unwrap();
    let config = json!({
        "execution_timeout_ms": 120000,
        "lease_grace_ms": 30000,
        "fencing_grace_ms": 5000,
        "extension_connection_id": "g3-backup-extension",
        "worker_epoch": "0198ab31-6c44-7e8a-b2bb-000000000110",
        "worker_epoch_fence": 17
    });
    let config_transition = store
        .transact(
            &CoreCommand::InstallConfig(InstallConfigCommand {
                command_id: "g3-backup-config".into(),
                revision: 1,
                digest: digest(&config),
                effective_config: config,
            }),
            &storage_input(),
        )
        .unwrap();
    assert_eq!(config_transition.outcome, TransitionOutcome::Committed);
    let graph = storage_graph();
    let graph_transition = store
        .transact(
            &CoreCommand::InstallGraph(InstallGraphCommand {
                command_id: "g3-backup-graph".into(),
                revision: 1,
                digest: digest(&graph),
                graph,
            }),
            &storage_input(),
        )
        .unwrap();
    assert_eq!(graph_transition.outcome, TransitionOutcome::Committed);
    let authority = store.bootstrap_host_connection().unwrap();
    drop(store);
    (connection, authority)
}

fn storage_projection() -> (Connection, HostConnectionAuthority, ModuleStateProjection) {
    let (mut connection, authority) = storage_setup();
    let mut store = SqliteCoreStore::new(&mut connection).unwrap();
    store
        .admit_module(&authority, &storage_module_id())
        .unwrap();
    let projection = store
        .issue_module_state_projection(&authority, &storage_module_id())
        .unwrap();
    drop(store);
    (connection, authority, projection)
}

fn timestamp(value: &str) -> Timestamp {
    Timestamp::from_str(value).unwrap()
}

fn log_event(level: LogLevel, sequence: u64, message: &str) -> StructuredLogEvent {
    let mut fields = BTreeMap::new();
    fields.insert("message".to_owned(), Value::String(message.to_owned()));
    if level == LogLevel::Error {
        fields.insert("error_code".to_owned(), json!("TEST_ERROR"));
        fields.insert("phase".to_owned(), json!("testing"));
        fields.insert("retryable".to_owned(), json!(false));
        fields.insert("outcome".to_owned(), json!("failed"));
    }
    StructuredLogEvent::new(
        "test.event",
        1,
        level,
        timestamp("2026-08-28T12:00:00.000000Z"),
        sequence,
        "test-producer",
        fields,
    )
    .unwrap()
}

#[test]
fn logs_redact_secrets_drop_host_authority_and_stay_structured() {
    let mut fields = BTreeMap::new();
    fields.insert("api_key".to_owned(), json!("plain-secret"));
    fields.insert("reservation_id".to_owned(), json!("host-reservation"));
    fields.insert("message".to_owned(), json!("safe"));
    let event = StructuredLogEvent::new(
        "request.finished",
        1,
        LogLevel::Info,
        timestamp("2026-08-28T12:00:00.000000Z"),
        1,
        "test-producer",
        fields,
    )
    .unwrap();

    assert_eq!(event.fields()["api_key"], json!("[REDACTED]"));
    assert!(!event.fields().contains_key("reservation_id"));
    let bytes = event.canonical_bytes().unwrap();
    let text = std::str::from_utf8(bytes.as_bytes()).unwrap();
    assert!(!text.contains("plain-secret"));
    assert!(!text.contains("host-reservation"));
    assert!(text.contains("request.finished"));
}

#[test]
fn bounded_logs_evict_in_specified_priority_order_and_account_loss() {
    let limits = LogLimits::new(3, 4096, 4096).unwrap();
    let mut buffer = BoundedLogBuffer::new(limits);
    buffer.push(log_event(LogLevel::Trace, 1, "trace")).unwrap();
    buffer.push(log_event(LogLevel::Debug, 2, "debug")).unwrap();
    buffer.push(log_event(LogLevel::Info, 3, "info")).unwrap();
    buffer.push(log_event(LogLevel::Warn, 4, "warn")).unwrap();

    let messages: Vec<_> = buffer
        .entries()
        .map(|event| event.fields()["message"].as_str().unwrap())
        .collect();
    assert_eq!(messages, ["debug", "info", "warn"]);
    assert_eq!(buffer.dropped_events(), 1);

    let error = log_event(LogLevel::Error, 5, "error");
    assert_eq!(
        buffer.push(error).unwrap(),
        LogPushOutcome::Stored { truncated: false }
    );
    let levels: Vec<_> = buffer.entries().map(StructuredLogEvent::severity).collect();
    assert_eq!(levels, [LogLevel::Info, LogLevel::Warn, LogLevel::Error]);
    assert_eq!(buffer.dropped_events(), 2);
}

#[test]
fn payload_logs_require_authorization_and_are_deterministically_truncated() {
    let event = {
        let mut fields = BTreeMap::new();
        fields.insert("payload".to_owned(), json!("abcdefghij".repeat(200)));
        StructuredLogEvent::new(
            "payload.capture",
            1,
            LogLevel::Payload,
            timestamp("2026-08-28T12:00:00.000000Z"),
            1,
            "test-producer",
            fields,
        )
        .unwrap()
    };
    let limits = LogLimits::new(4, 256, 1024).unwrap();
    let mut disabled = BoundedLogBuffer::new(limits);
    assert_eq!(disabled.push(event.clone()), Err(LogError::PayloadDisabled));

    let authorization = PayloadAuthorization::new(
        "incident-123",
        timestamp("2026-12-31T23:59:59.000000Z"),
        256,
        60,
        true,
    )
    .unwrap();
    let mut buffer = BoundedLogBuffer::with_payload_authorization(limits, authorization).unwrap();
    assert_eq!(
        buffer.push(event).unwrap(),
        LogPushOutcome::Stored { truncated: true }
    );
    let stored = buffer.entries().next().unwrap();
    assert!(stored.is_truncated());
    assert!(stored.canonical_bytes().unwrap().as_bytes().len() <= 256);
}

#[test]
fn log_sequences_are_monotonic_per_producer() {
    let mut buffer = BoundedLogBuffer::new(LogLimits::default());
    buffer.push(log_event(LogLevel::Info, 2, "second")).unwrap();
    assert!(matches!(
        buffer.push(log_event(LogLevel::Info, 1, "first")),
        Err(LogError::SequenceRegression { .. })
    ));
}

fn replay_with_input(input: Value) -> (String, Vec<u8>) {
    let mut recorder = ReplayRecorder::new(
        module_id(),
        scope_id(),
        ReplayMode::Simulation,
        ReplayLimits::default(),
    )
    .unwrap();
    recorder.append(input, Some(json!({"answer": 42}))).unwrap();
    let evidence = recorder.finish().unwrap();
    let digest = evidence.digest().to_string();
    let bytes = evidence.canonical_bytes().unwrap().into_vec();
    (digest, bytes)
}

#[test]
fn replay_digest_is_canonical_ordered_and_non_authoritative() {
    let mut first = Map::new();
    first.insert("b".to_owned(), json!(2));
    first.insert("a".to_owned(), json!(1));
    let mut second = Map::new();
    second.insert("a".to_owned(), json!(1));
    second.insert("b".to_owned(), json!(2));

    let (first_digest, first_bytes) = replay_with_input(Value::Object(first));
    let (second_digest, second_bytes) = replay_with_input(Value::Object(second));
    assert_eq!(first_digest, second_digest);
    assert_eq!(first_bytes, second_bytes);

    let evidence = ReplayRecorder::simulation(module_id(), scope_id())
        .finish()
        .unwrap();
    assert!(!evidence.is_authoritative());
    let recovered = dolly_observability::ReplayEvidence::recover_from_bytes(&first_bytes).unwrap();
    assert_eq!(recovered.digest().to_string(), first_digest);
    assert_eq!(recovered.records()[0].sequence(), 1);
}

#[test]
fn replay_rejects_out_of_order_and_forbidden_data_without_partial_append() {
    let limits = ReplayLimits::new(4, 4096, 4096).unwrap();
    let mut recorder =
        ReplayRecorder::new(module_id(), scope_id(), ReplayMode::Verification, limits).unwrap();
    assert_eq!(
        recorder.append_ordered(2, json!({"input": true}), None),
        Err(ReplayError::Ordering {
            expected: 1,
            actual: 2
        })
    );
    assert_eq!(recorder.len(), 0);
    assert!(matches!(
        recorder.append(json!({"capability_grant": "opaque"}), None),
        Err(ReplayError::ForbiddenData { .. })
    ));
    assert_eq!(recorder.len(), 0);
    assert!(matches!(
        ReplayRecorder::new(module_id(), scope_id(), ReplayMode::LiveReplay, limits),
        Err(ReplayError::LiveReplayNotSupported)
    ));
}

#[test]
fn replay_recovery_rejects_truncated_evidence() {
    let mut recorder = ReplayRecorder::simulation(module_id(), scope_id());
    recorder.append(json!({"input": "complete"}), None).unwrap();
    let bytes = recorder
        .finish()
        .unwrap()
        .canonical_bytes()
        .unwrap()
        .into_vec();
    assert!(matches!(
        dolly_observability::ReplayEvidence::recover_from_bytes(&bytes[..bytes.len() - 1]),
        Err(ReplayError::Corrupt(_))
    ));
}

#[test]
fn module_backup_is_canonical_scope_bound_and_restores_storage_state() {
    let (_connection, _authority, projection) = storage_projection();
    let backup = ModuleBackup::capture(&projection).unwrap();
    let bytes = backup.canonical_bytes().unwrap().into_vec();
    let recovered = ModuleBackup::recover_from_bytes(&bytes).unwrap();
    assert_eq!(recovered, backup);

    let request = ModuleRestoreRequest::new(
        storage_module_id(),
        projection.storage_scope_id().clone(),
        projection.revision(),
        backup.backup_digest().clone(),
    )
    .unwrap();
    let restored = backup.restore(&request).unwrap();
    assert_eq!(restored.state_bytes(), backup.state_bytes());
    assert_eq!(restored.module_id(), backup.module_id());
    assert_eq!(restored.storage_scope_id(), backup.storage_scope_id());
    assert_eq!(restored.revision(), projection.revision());
    assert_eq!(
        restored.durable_commit_seq(),
        projection.durable_commit_seq()
    );
}
#[test]
fn module_backup_rejects_cross_module_restore_and_validates_revision_and_digest() {
    let (mut connection, authority, projection) = storage_projection();
    let mut store = SqliteCoreStore::new(&mut connection).unwrap();
    let wrong_module = ModuleId::from_string("other-module".to_owned()).unwrap();
    assert_eq!(
        store.admit_module(&authority, &wrong_module),
        Err(dolly_storage::StorageError::IdempotencyConflict)
    );
    assert_eq!(
        store.issue_module_state_projection(&authority, &wrong_module),
        Err(dolly_storage::StorageError::IdempotencyConflict)
    );
    drop(store);
    let backup = ModuleBackup::capture(&projection).unwrap();
    let request = ModuleRestoreRequest::new(
        wrong_module,
        projection.storage_scope_id().clone(),
        projection.revision(),
        backup.backup_digest().clone(),
    )
    .unwrap();
    assert_eq!(backup.restore(&request), Err(BackupError::IdentityMismatch));

    let wrong_scope =
        ModuleStorageScopeId::from_uuid_v7("0198ab31-6c44-7e8a-b2bb-000000000155".parse().unwrap());
    let request = ModuleRestoreRequest::new(
        storage_module_id(),
        wrong_scope,
        projection.revision(),
        backup.backup_digest().clone(),
    )
    .unwrap();
    assert_eq!(backup.restore(&request), Err(BackupError::IdentityMismatch));

    let request = ModuleRestoreRequest::new(
        storage_module_id(),
        projection.storage_scope_id().clone(),
        projection.revision() + 1,
        backup.backup_digest().clone(),
    )
    .unwrap();
    assert!(matches!(
        backup.restore(&request),
        Err(BackupError::RevisionMismatch { .. })
    ));

    let request = ModuleRestoreRequest::new(
        storage_module_id(),
        projection.storage_scope_id().clone(),
        projection.revision(),
        Sha256Digest::compute(b"different"),
    )
    .unwrap();
    assert_eq!(
        backup.restore(&request),
        Err(BackupError::DigestMismatch("backup digest"))
    );
}

#[test]
fn module_projection_rejects_stale_host_owner() {
    let (mut connection, authority) = storage_setup();
    let module = storage_module_id();
    let mut store = SqliteCoreStore::new(&mut connection).unwrap();
    let original_scope = store.admit_module(&authority, &module).unwrap();
    let original_projection = store
        .issue_module_state_projection(&authority, &module)
        .unwrap();

    let config = json!({
        "execution_timeout_ms": 120000,
        "lease_grace_ms": 30000,
        "fencing_grace_ms": 5000,
        "extension_connection_id": "g3-backup-extension-rotated",
        "worker_epoch": "0198ab31-6c44-7e8a-b2bb-000000000110",
        "worker_epoch_fence": 17
    });
    let transition = store
        .transact(
            &CoreCommand::InstallConfig(InstallConfigCommand {
                command_id: "g3-backup-config-rotation".into(),
                revision: 2,
                digest: digest(&config),
                effective_config: config,
            }),
            &storage_input(),
        )
        .unwrap();
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
    let rotated = store.rotate_host_connection(&authority).unwrap();
    assert_ne!(rotated, authority);

    assert_eq!(
        store.issue_module_state_projection(&authority, &module),
        Err(dolly_storage::StorageError::IdempotencyConflict)
    );
    assert_eq!(
        store.issue_module_state_projection(&rotated, &module),
        Err(dolly_storage::StorageError::IdempotencyConflict)
    );

    assert_eq!(
        store.admit_module(&rotated, &module).unwrap(),
        original_scope
    );
    let current = store
        .issue_module_state_projection(&rotated, &module)
        .unwrap();
    assert_eq!(current.storage_scope_id(), &original_scope);
    assert!(current.revision() > original_projection.revision());
}

#[test]
fn module_backup_public_api_rejects_untyped_secret_and_truncation() {
    let (_connection, _authority, projection) = storage_projection();
    let backup = ModuleBackup::capture(&projection).unwrap();

    let untyped_state = json!({
        "durable_commit_seq": 1,
        "note": "g3-secret"
    });
    let untyped_document = json!({
        "schema": "dolly.module-backup/v1",
        "module_id": "memory-main",
        "storage_scope_id": "0198ab31-6c44-7e8a-b2bb-000000000154",
        "revision": 1,
        "state": untyped_state,
        "state_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        "backup_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    });
    let untyped_bytes = dolly_canonical_json::canonicalize(&untyped_document)
        .unwrap()
        .0
        .into_vec();
    assert!(matches!(
        ModuleBackup::recover_from_bytes(&untyped_bytes),
        Err(BackupError::Corrupt(_))
    ));

    let bytes = backup.canonical_bytes().unwrap().into_vec();
    assert!(matches!(
        ModuleBackup::recover_from_bytes(&bytes[..bytes.len() - 1]),
        Err(BackupError::Corrupt(_))
    ));
}
