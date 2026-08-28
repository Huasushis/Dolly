use dolly_canonical_json::canonicalize;
use dolly_core_reducer::{
    CoreCommand, EnvironmentInput, InstallConfigCommand, InstallGraphCommand,
    TransitionOutcome,
};
use dolly_storage::{HostConnectionAuthority, SqliteCoreStore, StorageError};
use rusqlite::Connection;
use serde_json::{Value, json};
use tempfile::tempdir;

const WORKER_EPOCH: &str = "0198ab31-6c44-7e8a-b2bb-000000000110";

fn input() -> EnvironmentInput {
    EnvironmentInput {
        now: "2026-08-27T00:00:00.000000Z".into(),
        ..Default::default()
    }
}

fn digest(value: &Value) -> String {
    canonicalize(value).unwrap().1.to_canonical_string()
}

fn descriptor() -> Value {
    json!({
        "schema": "dolly.module-descriptor/v1",
        "module_id": "timer",
        "descriptor_revision": 1,
        "display_name": "timer",
        "accepts": {"summary":"input", "part_kinds":["text"], "action_names":[]},
        "emits": {"summary":"output", "part_kinds":["text"], "action_names":[]},
        "actions": [],
        "activation_replay_contract": {"mode":"fenced_replay", "evidence":"pure_compute", "ledger":null},
        "trust": "trusted",
        "metadata": {"org.example.extension":{"capabilities":["host.block.get"]}}
    })
}

fn graph() -> Value {
    let source = descriptor();
    json!({
        "receiving_module": "timer",
        "input_pages": {},
        "output_pages": {},
        "subscriptions": {},
        "descriptors": {
            "timer": {
                "module_id": "timer",
                "descriptor_revision": 1,
                "source_descriptor_digest": digest(&source),
                "value": source
            }
        },
        "authorized_metadata_namespaces": ["org.example.extension"],
        "authorized_action_names": []
    })
}

fn setup(store: &mut SqliteCoreStore<'_>) -> HostConnectionAuthority {
    let config = json!({
        "execution_timeout_ms": 120000,
        "lease_grace_ms": 30000,
        "fencing_grace_ms": 5000,
        "extension_connection_id": "g2-extension-connection",
        "worker_epoch": WORKER_EPOCH,
        "worker_epoch_fence": 17
    });
    let config_transition = store
        .transact(
            &CoreCommand::InstallConfig(InstallConfigCommand {
                command_id: "grant-config".into(),
                revision: 1,
                digest: digest(&config),
                effective_config: config,
            }),
            &input(),
        )
        .unwrap();
    assert_eq!(config_transition.outcome, TransitionOutcome::Committed);
    let graph = graph();
    let graph_transition = store
        .transact(
            &CoreCommand::InstallGraph(InstallGraphCommand {
                command_id: "grant-graph".into(),
                revision: 1,
                digest: digest(&graph),
                graph,
            }),
            &input(),
        )
        .unwrap();
    assert_eq!(graph_transition.outcome, TransitionOutcome::Committed);
    store.bootstrap_host_connection().unwrap()
}

fn install_grant(
    store: &mut SqliteCoreStore<'_>,
    authority: &HostConnectionAuthority,
    extension_generation: i64,
    methods: &[&str],
) {
    store
        .install_host_capability_grant(
            authority,
            "org.example.extension",
            "timer",
            extension_generation,
            1,
            &digest(&descriptor()),
            1,
            &digest(&json!({"manifest": 1})),
            1,
            &digest(&graph()),
            methods,
        )
        .unwrap();
}

#[test]
fn host_grant_is_durable_sealed_monotonic_and_revocable() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("grant.sqlite3");
    let mut connection = Connection::open(&path).unwrap();
    let mut store = SqliteCoreStore::new(&mut connection).unwrap();
    let authority = setup(&mut store);

    install_grant(&mut store, &authority, 1, &["host.block.get"]);
    let first = store
        .current_host_capability_grant("org.example.extension", "timer")
        .unwrap()
        .unwrap();
    assert_eq!(first.grant_revision(), 1);
    assert!(first.allows("host.block.get"));
    assert!(!first.allows("host.model.invoke"));
    assert!(!first.grant_digest().is_empty());

    install_grant(
        &mut store,
        &authority,
        1,
        &["host.block.get", "host.page.read"],
    );
    let updated = store
        .current_host_capability_grant("org.example.extension", "timer")
        .unwrap()
        .unwrap();
    assert_eq!(updated.grant_revision(), 2);
    assert_ne!(updated.grant_digest(), first.grant_digest());
    assert!(updated.allows("host.page.read"));

    let config_b = json!({
        "extension_connection_id": "g2-extension-connection-b",
        "worker_epoch": "0198ab31-6c44-7e8a-b2bb-000000000111",
        "worker_epoch_fence": 18
    });
    let config_b_transition = store
        .transact(
            &CoreCommand::InstallConfig(InstallConfigCommand {
                command_id: "grant-config-b".into(),
                revision: 2,
                digest: digest(&config_b),
                effective_config: config_b,
            }),
            &input(),
        )
        .unwrap();
    assert_eq!(config_b_transition.outcome, TransitionOutcome::Committed);
    let rotated_authority = store.rotate_host_connection(&authority).unwrap();
    assert_eq!(rotated_authority.incarnation_revision(), 2);
    assert_eq!(
        store
            .install_host_capability_grant(
                &authority,
                "org.example.extension",
                "timer",
                1,
                1,
                &digest(&descriptor()),
                1,
                &digest(&json!({"manifest": 1})),
                1,
                &digest(&graph()),
                &["host.block.get"],
            )
            .unwrap_err(),
        StorageError::IdempotencyConflict
    );

    store
        .revoke_host_capability_grant(
            &rotated_authority,
            "org.example.extension",
            "timer",
        )
        .unwrap();
    assert!(store
        .current_host_capability_grant("org.example.extension", "timer")
        .unwrap()
        .is_none());
    drop(store);
    drop(connection);

    let mut reopened_connection = Connection::open(&path).unwrap();
    let reopened_store = SqliteCoreStore::new(&mut reopened_connection).unwrap();
    assert!(reopened_store
        .current_host_capability_grant("org.example.extension", "timer")
        .unwrap()
        .is_none());
}
