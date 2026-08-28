use dolly_canonical_json::{canonicalize, Sha256Digest};
use dolly_core_domain::{ModuleId, ModuleStorageScopeId, Timestamp};
use dolly_core_reducer::{
    CoreCommand, EnvironmentInput, InstallConfigCommand, InstallGraphCommand, TransitionOutcome,
};
use dolly_observability::{
    BackupError, BoundedLogBuffer, HostLogContext, HostLogEvent, HostReplayEvent, LogError,
    LogLevel, LogLimits, LogPushOutcome, ModuleBackup, ModuleRestoreRequest, ModuleStateProjection,
    ReplayError, ReplayLimits, ReplayMode, ReplayRecorder, StructuredLogEvent,
};
use dolly_storage::{HostConnectionAuthority, SqliteCoreStore};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::str::FromStr;

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

fn log_event(context: &HostLogContext, event: HostLogEvent, sequence: u64) -> StructuredLogEvent {
    StructuredLogEvent::new(
        context,
        event,
        timestamp("2026-08-28T12:00:00.000000Z"),
        sequence,
    )
    .unwrap()
}

fn allowed_host_callback_event(context: &HostLogContext, sequence: u64) -> StructuredLogEvent {
    let actual_secret_bytes = b"g3-secret";
    let actual_secret = std::str::from_utf8(actual_secret_bytes).unwrap();
    assert_eq!(actual_secret, "g3-secret");
    log_event(context, HostLogEvent::RequestAccepted, sequence)
}

#[test]
fn logs_use_fixed_host_catalog_and_export_no_callback_secret() {
    let (_connection, _authority, projection) = storage_projection();
    let context = HostLogContext::from_storage_projection(&projection);
    let event = allowed_host_callback_event(&context, 1);
    assert_eq!(event.event(), HostLogEvent::RequestAccepted);
    assert_eq!(event.context().module_id(), projection.module_id());
    assert_eq!(
        event.context().storage_scope_id(),
        projection.storage_scope_id()
    );

    let bytes = event.canonical_bytes().unwrap();
    assert!(!bytes
        .as_bytes()
        .windows(b"g3-secret".len())
        .any(|window| { window == b"g3-secret" }));
    let mut buffer = BoundedLogBuffer::new(LogLimits::default());
    buffer.push(event).unwrap();
    let exported = buffer.drain();
    let exported_bytes = exported[0].canonical_bytes().unwrap();
    assert!(!exported_bytes
        .as_bytes()
        .windows(b"g3-secret".len())
        .any(|window| window == b"g3-secret"));

    let untyped_document = json!({
        "event_name": "request.finished",
        "schema_version": 1,
        "severity": "info",
        "event_time": "2026-08-28T12:00:00.000000Z",
        "sequence": 1,
        "module_id": projection.module_id(),
        "storage_scope_id": projection.storage_scope_id(),
        "revision": projection.revision(),
        "event": "request-accepted",
        "fields": {"note": "g3-secret"},
        "truncated": false
    });
    let untyped_bytes = canonicalize(&untyped_document).unwrap().0.into_vec();
    assert!(matches!(
        StructuredLogEvent::recover_from_bytes(&untyped_bytes),
        Err(LogError::InvalidEvent(_))
    ));
}

#[test]
fn bounded_logs_evict_in_fixed_catalog_priority_order_and_account_loss() {
    let (_connection, _authority, projection) = storage_projection();
    let context = HostLogContext::from_storage_projection(&projection);
    let limits = LogLimits::new(3, 4096, 4096).unwrap();
    let mut buffer = BoundedLogBuffer::new(limits);
    buffer
        .push(log_event(&context, HostLogEvent::TraceCheckpoint, 1))
        .unwrap();
    buffer
        .push(log_event(&context, HostLogEvent::Diagnostic, 2))
        .unwrap();
    buffer
        .push(log_event(&context, HostLogEvent::RequestAccepted, 3))
        .unwrap();
    buffer
        .push(log_event(&context, HostLogEvent::RequestRejected, 4))
        .unwrap();

    let events: Vec<_> = buffer.entries().map(StructuredLogEvent::event).collect();
    assert_eq!(
        events,
        [
            HostLogEvent::Diagnostic,
            HostLogEvent::RequestAccepted,
            HostLogEvent::RequestRejected
        ]
    );
    assert_eq!(buffer.dropped_events(), 1);

    let error = log_event(&context, HostLogEvent::Error, 5);
    assert_eq!(
        buffer.push(error).unwrap(),
        LogPushOutcome::Stored { truncated: false }
    );
    let events: Vec<_> = buffer.entries().map(StructuredLogEvent::event).collect();
    assert_eq!(
        events,
        [
            HostLogEvent::RequestAccepted,
            HostLogEvent::RequestRejected,
            HostLogEvent::Error
        ]
    );
    assert_eq!(buffer.dropped_events(), 2);
}

#[test]
fn fixed_events_obey_event_bounds_without_payload_or_truncation() {
    let (_connection, _authority, projection) = storage_projection();
    let context = HostLogContext::from_storage_projection(&projection);
    let event = log_event(&context, HostLogEvent::RequestAccepted, 1);
    let too_small = LogLimits::new(4, 1, 1024).unwrap();
    let mut buffer = BoundedLogBuffer::new(too_small);
    assert!(matches!(
        buffer.push(event.clone()),
        Err(LogError::EventTooLarge { .. })
    ));

    let limits = LogLimits::new(4, 4096, 4096).unwrap();
    let mut buffer = BoundedLogBuffer::new(limits);
    assert_eq!(
        buffer.push(event).unwrap(),
        LogPushOutcome::Stored { truncated: false }
    );
    let stored = buffer.entries().next().unwrap();
    assert!(!stored.is_truncated());
    assert!(stored.canonical_bytes().unwrap().as_bytes().len() <= 4096);
    assert_eq!(buffer.drain().len(), 1);
}

#[test]
fn log_sequences_are_monotonic_per_host_context() {
    let (_connection, _authority, projection) = storage_projection();
    let context = HostLogContext::from_storage_projection(&projection);
    let mut buffer = BoundedLogBuffer::new(LogLimits::default());
    buffer
        .push(log_event(&context, HostLogEvent::RequestAccepted, 2))
        .unwrap();
    assert!(matches!(
        buffer.push(log_event(&context, HostLogEvent::RequestAccepted, 1)),
        Err(LogError::SequenceRegression { .. })
    ));
}

fn replay_with_event(
    projection: &ModuleStateProjection,
    event: HostReplayEvent,
) -> (String, Vec<u8>) {
    let mut recorder =
        ReplayRecorder::new(projection, ReplayMode::Simulation, ReplayLimits::default()).unwrap();
    recorder.append(event).unwrap();
    let evidence = recorder.finish().unwrap();
    let digest = evidence.digest().to_string();
    let bytes = evidence.canonical_bytes().unwrap().into_vec();
    (digest, bytes)
}

fn allowed_host_callback_replay_event() -> HostReplayEvent {
    let actual_secret_bytes = b"g3-secret";
    let actual_secret = std::str::from_utf8(actual_secret_bytes).unwrap();
    assert_eq!(actual_secret, "g3-secret");
    HostReplayEvent::InputAccepted {
        input_digest: Sha256Digest::compute(b"safe-input"),
    }
}

fn assert_secret_free(bytes: &[u8]) {
    assert!(!bytes
        .windows(b"g3-secret".len())
        .any(|window| window == b"g3-secret"));
}

#[test]
fn replay_uses_fixed_host_events_and_exports_no_callback_secret() {
    let (_connection, _authority, projection) = storage_projection();
    let event = allowed_host_callback_replay_event();
    let mut recorder = ReplayRecorder::simulation(&projection);
    assert_eq!(recorder.append(event.clone()).unwrap(), 1);
    let evidence = recorder.finish().unwrap();

    assert_eq!(evidence.module_id(), projection.module_id());
    assert_eq!(evidence.storage_scope_id(), projection.storage_scope_id());
    assert_eq!(evidence.revision(), projection.revision());
    assert_eq!(
        evidence.durable_commit_seq(),
        projection.durable_commit_seq()
    );
    let bytes = evidence.canonical_bytes().unwrap().into_vec();
    assert_secret_free(&bytes);
    assert_secret_free(format!("{evidence:?}").as_bytes());

    let recovered =
        dolly_observability::ReplayEvidence::recover_from_bytes(&bytes, &projection).unwrap();
    assert_eq!(recovered.records()[0].event(), &event);
    assert_secret_free(&recovered.canonical_bytes().unwrap().into_vec());
    assert_secret_free(format!("{recovered:?}").as_bytes());

    let safe_digest = Sha256Digest::compute(b"safe").to_canonical_string();
    let untyped_document = json!({
        "schema": "dolly.replay-evidence/v1",
        "non_authoritative": true,
        "mode": "simulation",
        "module_id": projection.module_id(),
        "storage_scope_id": projection.storage_scope_id(),
        "revision": projection.revision(),
        "durable_commit_seq": projection.durable_commit_seq(),
        "records": [{
            "sequence": 1,
            "event": {
                "kind": "input_accepted",
                "input_digest": safe_digest,
                "note": "g3-secret"
            }
        }],
        "evidence_digest": safe_digest
    });
    let untyped_bytes = canonicalize(&untyped_document).unwrap().0.into_vec();
    let error =
        dolly_observability::ReplayEvidence::recover_from_bytes(&untyped_bytes, &projection)
            .unwrap_err();
    assert!(!error.to_string().contains("g3-secret"));
    assert!(!format!("{error:?}").contains("g3-secret"));
}

#[test]
fn replay_recovery_rejects_a_different_storage_projection() {
    let (_first_connection, _first_authority, first_projection) = storage_projection();
    let (_second_connection, _second_authority, second_projection) = storage_projection();
    let mut recorder = ReplayRecorder::simulation(&first_projection);
    recorder
        .append(HostReplayEvent::InputAccepted {
            input_digest: Sha256Digest::compute(b"safe-input"),
        })
        .unwrap();
    let bytes = recorder
        .finish()
        .unwrap()
        .canonical_bytes()
        .unwrap()
        .into_vec();

    assert!(matches!(
        dolly_observability::ReplayEvidence::recover_from_bytes(&bytes, &second_projection),
        Err(ReplayError::IdentityMismatch)
    ));
}

#[test]
fn replay_digest_is_canonical_ordered_and_non_authoritative() {
    let (_connection, _authority, projection) = storage_projection();
    let event = HostReplayEvent::Succeeded {
        input_digest: Sha256Digest::compute(b"input"),
        result_digest: Sha256Digest::compute(b"result"),
    };
    let (first_digest, first_bytes) = replay_with_event(&projection, event.clone());
    let (second_digest, second_bytes) = replay_with_event(&projection, event.clone());
    assert_eq!(first_digest, second_digest);
    assert_eq!(first_bytes, second_bytes);

    let evidence = ReplayRecorder::simulation(&projection).finish().unwrap();
    assert!(!evidence.is_authoritative());
    let recovered =
        dolly_observability::ReplayEvidence::recover_from_bytes(&first_bytes, &projection).unwrap();
    assert_eq!(recovered.digest().to_string(), first_digest);
    assert_eq!(recovered.records()[0].sequence(), 1);
    assert_eq!(recovered.records()[0].event(), &event);
}

#[test]
fn replay_preserves_order_and_bounds_without_raw_append_path() {
    let (_connection, _authority, projection) = storage_projection();
    let limits = ReplayLimits::new(1, 4096, 4096).unwrap();
    let event = HostReplayEvent::InputAccepted {
        input_digest: Sha256Digest::compute(b"safe-input"),
    };
    let mut recorder = ReplayRecorder::new(&projection, ReplayMode::Verification, limits).unwrap();
    assert_eq!(
        recorder.append_ordered(2, event.clone()),
        Err(ReplayError::Ordering {
            expected: 1,
            actual: 2
        })
    );
    assert_eq!(recorder.len(), 0);
    assert_eq!(recorder.append(event.clone()).unwrap(), 1);
    assert_eq!(
        recorder.append(event.clone()),
        Err(ReplayError::RecordLimit { limit: 1 })
    );
    assert_eq!(recorder.len(), 1);

    let mut small_record = ReplayRecorder::new(
        &projection,
        ReplayMode::Simulation,
        ReplayLimits::new(1, 1, 4096).unwrap(),
    )
    .unwrap();
    assert!(matches!(
        small_record.append(event.clone()),
        Err(ReplayError::RecordTooLarge { .. })
    ));
    assert_eq!(small_record.len(), 0);

    let mut small_total = ReplayRecorder::new(
        &projection,
        ReplayMode::Simulation,
        ReplayLimits::new(1, 4096, 1).unwrap(),
    )
    .unwrap();
    assert!(matches!(
        small_total.append(event),
        Err(ReplayError::TotalLimit { .. })
    ));
    assert_eq!(small_total.len(), 0);
    assert!(matches!(
        ReplayRecorder::new(&projection, ReplayMode::LiveReplay, limits),
        Err(ReplayError::LiveReplayNotSupported)
    ));
}

#[test]
fn replay_recovery_rejects_truncated_evidence() {
    let (_connection, _authority, projection) = storage_projection();
    let mut recorder = ReplayRecorder::simulation(&projection);
    recorder
        .append(HostReplayEvent::InputAccepted {
            input_digest: Sha256Digest::compute(b"safe-input"),
        })
        .unwrap();
    let bytes = recorder
        .finish()
        .unwrap()
        .canonical_bytes()
        .unwrap()
        .into_vec();
    assert!(matches!(
        dolly_observability::ReplayEvidence::recover_from_bytes(
            &bytes[..bytes.len() - 1],
            &projection
        ),
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
