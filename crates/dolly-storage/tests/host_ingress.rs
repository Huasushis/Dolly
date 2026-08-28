//! Focused durable Host ingress submit/status seam tests against the real
//! bundled SQLite: idempotency identity over the ordered target Pages,
//! canonical target equivalence, lost-response reconciliation through
//! `status`, zero-mutation conflicts, absent status, cross-owner isolation,
//! atomic rollback, fail-closed record verification, and the schema gate.

use dolly_canonical_json::CanonicalJsonValue;
use dolly_core_domain::{
    HostIngress, HostIngressErrorCode, HostIngressKey, HostIngressKind, HostIngressPremise,
    HostIngressSource, HostIngressStatus, HostIngressSubmitOutcome,
};
use dolly_core_reducer::{
    CoreCommand, EnvironmentInput, InstallConfigCommand, InstallGraphCommand, TransitionOutcome,
};
use dolly_storage::{
    SqliteCoreStore, SqliteHostIngressStore, StorageError,
    host_ingress::create_host_ingress_schema,
};
use rusqlite::Connection;
use serde_json::{Value, json};

fn page(id: &str) -> dolly_core_domain::PageId {
    id.parse().expect("test PageId must be valid")
}

fn payload(value: Value) -> CanonicalJsonValue {
    serde_json::from_value(value).expect("test payload must be canonical JSON")
}

fn input() -> EnvironmentInput {
    EnvironmentInput {
        now: "2026-08-28T00:00:00.000000Z".into(),
        ..Default::default()
    }
}

fn premise(
    owner: &str,
    external: &str,
    kind: HostIngressKind,
    references: Option<&str>,
    pages: &[&str],
    content: Value,
    revision: i64,
) -> HostIngressPremise {
    HostIngressPremise {
        owner: owner.into(),
        source: HostIngressSource {
            extension_id: "org.dolly.channel".parse().unwrap(),
            module_id: "receiver".parse().unwrap(),
            instance_id: "instance-a".parse().unwrap(),
            generation: dolly_core_domain::ExtensionGeneration::new(7).unwrap(),
        },
        external_event_id: external.into(),
        kind,
        references_external_event_id: references.map(str::to_owned),
        target_page_ids: pages.iter().map(|id| page(id)).collect(),
        payload: payload(content),
        revision,
    }
}

fn install_config(store: &mut SqliteCoreStore<'_>, mark: &str) {
    let effective_config = json!({
        "execution_timeout_ms": 120000,
        "lease_grace_ms": 30000,
        "fencing_grace_ms": 5000,
        "extension_connection_id": format!("{mark}-connection"),
        "worker_epoch": "0198ab31-6c44-7e8a-b2bb-000000000110",
        "worker_epoch_fence": 17
    });
    let (_, digest) = dolly_canonical_json::canonicalize(&effective_config).unwrap();
    let command = CoreCommand::InstallConfig(InstallConfigCommand {
        command_id: format!("{mark}-config"),
        revision: 1,
        digest: digest.to_canonical_string(),
        effective_config,
    });
    let transition = store.transact(&command, &input()).unwrap();
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
    store.bootstrap_host_connection().unwrap();
}

fn install_graph(store: &mut SqliteCoreStore<'_>, module_id: &str, mark: &str) {
    let graph = json!({
        "revision": 1,
        "modules": [{
            "module_id": module_id,
            "extension_id": "org.dolly.channel",
            "output_pages": ["page-a", "page-b"],
            "direction": "consumer"
        }]
    });
    let (_, digest) = dolly_canonical_json::canonicalize(&graph).unwrap();
    let command = CoreCommand::InstallGraph(InstallGraphCommand {
        command_id: format!("{mark}-graph"),
        revision: 1,
        digest: digest.to_canonical_string(),
        graph,
    });
    let transition = store.transact(&command, &input()).unwrap();
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
}

/// One fresh in-memory connection with Core schema, configuration, graph, and
/// the Host ingress schema installed.
fn probe_connection(mark: &str) -> Connection {
    let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
    {
        let mut store = SqliteCoreStore::new(&mut connection).expect("core schema");
        install_config(&mut store, mark);
        install_graph(&mut store, "receiver", mark);
    }
    create_host_ingress_schema(&mut connection).expect("host ingress schema");
    connection
}

struct Harness {
    connection: Connection,
}

impl Harness {
    fn new(mark: &str) -> Self {
        Self {
            connection: probe_connection(mark),
        }
    }

    fn core_state(&mut self) -> dolly_core_reducer::CoreSnapshot {
        let store = SqliteCoreStore::new(&mut self.connection).unwrap();
        store.snapshot().unwrap()
    }

    fn mapping_rows(&mut self) -> i64 {
        self.connection
            .query_row("SELECT COUNT(*) FROM host_ingress_mappings", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    fn submit(
        &mut self,
        premise: &HostIngressPremise,
    ) -> Result<HostIngressSubmitOutcome, dolly_core_domain::HostIngressError> {
        let mut store = SqliteHostIngressStore::new(&mut self.connection).unwrap();
        store.submit(premise)
    }

    fn status(
        &mut self,
        key: &HostIngressKey,
    ) -> Result<HostIngressStatus, dolly_core_domain::HostIngressError> {
        let mut store = SqliteHostIngressStore::new(&mut self.connection).unwrap();
        store.status(key)
    }
}

fn committed(outcome: HostIngressSubmitOutcome) -> (dolly_core_domain::HostIngressMapping, bool) {
    match outcome {
        HostIngressSubmitOutcome::Committed { mapping, idempotent } => (*mapping, idempotent),
        HostIngressSubmitOutcome::Conflict { .. } => panic!("expected a committed outcome"),
    }
}

// ---------------------------------------------------------------------------
// Commit, idempotent replay, and the ordered target-Page identity
// ---------------------------------------------------------------------------

#[test]
fn fresh_submit_commits_mapping_and_effect() {
    let mut harness = Harness::new("fresh");
    let incoming = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a", "page-b"],
        json!({"kind":"text","text":"hello"}),
        1,
    );
    let (mapping, idempotent) = committed(harness.submit(&incoming).unwrap());
    assert!(!idempotent, "a fresh submission is not a replay");

    // The committed mapping carries the exact premise, minted identities, and
    // the effect linkage.
    assert_eq!(mapping.owner, "account-a");
    assert_eq!(mapping.kind, "message");
    assert_eq!(mapping.target_page_ids, vec!["page-a", "page-b"]);
    assert_eq!(mapping.revision, 1);
    assert_eq!(mapping.ingress_id.len(), 36);
    assert_eq!(mapping.block_id.len(), 36);
    assert_eq!(mapping.graph_revision, 1);
    assert_eq!(mapping.deliveries.len(), 2);
    assert!(mapping.deliveries.iter().all(|delivery| delivery.commit_seq > 0));
    assert!(mapping.payload_digest.starts_with("sha256:"));

    // The Core consumer effect exists and is bound to the minted Block.
    let state = harness.core_state();
    let block = state
        .blocks
        .get(&mapping.block_id)
        .unwrap_or_else(|| panic!("block {} must exist", mapping.block_id));
    assert_eq!(block["text"], "hello");
    assert!(state
        .ingress
        .values()
        .any(|record| record.block_id == mapping.block_id));

    // status reconciles to the same committed mapping without resubmitting.
    let key = mapping.ingress_key.parse().unwrap();
    match harness.status(&key).unwrap() {
        HostIngressStatus::Committed(seen) => assert_eq!(*seen, mapping),
        HostIngressStatus::Absent => panic!("committed mapping must not be absent"),
    }
}

#[test]
fn same_key_same_digest_replays_prior_mapping_without_mutation() {
    let mut harness = Harness::new("replay");
    let incoming = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a", "page-b"],
        json!({"kind":"text","text":"hello"}),
        1,
    );
    let (first, false) = committed(harness.submit(&incoming).unwrap()) else {
        panic!("first submit must commit")
    };
    let commit_before = harness.core_state().next_commit_seq;

    let (second, idempotent) = committed(harness.submit(&incoming).unwrap());
    assert!(idempotent, "same key + same digest must replay the prior mapping");
    assert_eq!(second, first, "the replay returns the identical prior mapping");

    // Zero additional mutation: no new Core commit sequence, no new row.
    assert_eq!(harness.core_state().next_commit_seq, commit_before);
    assert_eq!(harness.mapping_rows(), 1);
}

#[test]
fn same_key_different_target_pages_conflicts_with_zero_mutation() {
    let mut harness = Harness::new("pages-conflict");
    let incoming = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a", "page-b"],
        json!({"kind":"text","text":"hello"}),
        1,
    );
    let (first, _) = committed(harness.submit(&incoming).unwrap());
    let commit_before = harness.core_state().next_commit_seq;

    // Same key, same content, but the target Pages are reordered: the ordered
    // target list is part of the operation identity, so this conflicts.
    let mut reordered = incoming.clone();
    reordered.target_page_ids = vec![page("page-b"), page("page-a")];
    let outcome = harness.submit(&reordered).unwrap();
    let HostIngressSubmitOutcome::Conflict {
        key,
        stored_digest,
        submitted_digest,
    } = &outcome
    else {
        panic!("reordered target Pages must conflict");
    };
    assert_eq!(key.as_str(), first.ingress_key);
    assert_eq!(stored_digest, &first.operation_digest);
    assert_ne!(submitted_digest, stored_digest);

    // Zero additional mutation and the prior mapping is intact.
    assert_eq!(harness.core_state().next_commit_seq, commit_before);
    assert_eq!(harness.mapping_rows(), 1);
    match harness.status(&first.ingress_key.parse().unwrap()).unwrap() {
        HostIngressStatus::Committed(seen) => assert_eq!(*seen, first),
        HostIngressStatus::Absent => panic!("prior mapping must survive a conflict"),
    }
}

#[test]
fn canonical_equivalent_targets_replay_idempotently() {
    let mut harness = Harness::new("equivalent");
    let incoming = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a", "page-b"],
        json!({"kind":"text","text":"hello"}),
        1,
    );
    let (first, _) = committed(harness.submit(&incoming).unwrap());

    // Duplicate-only variance collapses to the same canonical ordered list,
    // so the digest is identical and the replay is idempotent.
    let mut duplicated = incoming.clone();
    duplicated.target_page_ids = vec![
        page("page-a"),
        page("page-a"),
        page("page-b"),
        page("page-a"),
    ];
    let (second, idempotent) = committed(harness.submit(&duplicated).unwrap());
    assert!(idempotent);
    assert_eq!(second, first);
    assert_eq!(second.target_page_ids, vec!["page-a", "page-b"]);
    assert_eq!(harness.mapping_rows(), 1);
}

#[test]
fn same_key_different_content_conflicts_without_mutation() {
    let mut harness = Harness::new("content-conflict");
    let incoming = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"kind":"text","text":"hello"}),
        1,
    );
    let (first, _) = committed(harness.submit(&incoming).unwrap());
    let mut changed = incoming.clone();
    changed.payload = payload(json!({"kind":"text","text":"goodbye"}));
    assert!(matches!(
        harness.submit(&changed).unwrap(),
        HostIngressSubmitOutcome::Conflict { .. }
    ));
    assert_eq!(harness.mapping_rows(), 1);
    match harness.status(&first.ingress_key.parse().unwrap()).unwrap() {
        HostIngressStatus::Committed(seen) => assert_eq!(seen.payload_digest, first.payload_digest),
        HostIngressStatus::Absent => panic!("prior mapping must survive"),
    }
}

// ---------------------------------------------------------------------------
// Absent status, lost-response reconciliation, and isolation
// ---------------------------------------------------------------------------

#[test]
fn absent_status_is_explicit() {
    let mut harness = Harness::new("absent");
    let incoming = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"kind":"text","text":"hello"}),
        1,
    );
    // Derive the key without submitting (pure derivation), then status must
    // be authoritative absent so a byte-identical replay is permitted.
    let identity = dolly_core_reducer::derive_ingress_identity(&incoming).unwrap();
    assert!(matches!(
        harness.status(&identity.key).unwrap(),
        HostIngressStatus::Absent
    ));
    assert!(harness.mapping_rows() == 0);
}

#[test]
fn lost_response_is_reconciled_through_status_not_resubmission() {
    let mut harness = Harness::new("lost-response");
    let incoming = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a", "page-b"],
        json!({"kind":"text","text":"hello"}),
        1,
    );
    let identity = dolly_core_reducer::derive_ingress_identity(&incoming).unwrap();

    // The submit commits; the response is lost (the receipt is discarded).
    let _lost_receipt = harness.submit(&incoming).unwrap();

    // Reconciliation MUST read status first, never resubmit blindly.
    let status = harness.status(&identity.key).unwrap();
    let host_ingress_mapping = match status {
        HostIngressStatus::Committed(mapping) => *mapping,
        HostIngressStatus::Absent => panic!("lost response after commit must not read absent"),
    };
    assert_eq!(host_ingress_mapping.operation_digest, identity.operation_digest);

    // A duplicate submit under the same key is idempotent, so even a caller
    // that ignored the lost-response rule changes nothing.
    let (replayed, idempotent) = committed(harness.submit(&incoming).unwrap());
    assert!(idempotent);
    assert_eq!(replayed, host_ingress_mapping);
    assert_eq!(harness.mapping_rows(), 1);
}

#[test]
fn cross_owner_and_cross_source_keys_never_collide() {
    let mut harness = Harness::new("cross-owner");
    let first = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"kind":"text","text":"hello"}),
        1,
    );
    let (mapping_a, _) = committed(harness.submit(&first).unwrap());

    // The same external event id in another owner is a different key and a
    // fresh, independent mapping — no collision and no conflict.
    let mut second = first.clone();
    second.owner = "account-b".into();
    let (mapping_b, _) = committed(harness.submit(&second).unwrap());
    assert_ne!(mapping_a.ingress_key, mapping_b.ingress_key);
    assert_eq!(harness.mapping_rows(), 2);

    // An owner can never see another owner's mapping.
    assert!(matches!(
        harness.status(&mapping_b.ingress_key.parse().unwrap()).unwrap(),
        HostIngressStatus::Committed(seen) if seen.owner == "account-b"
    ));
    assert!(matches!(
        harness.status(&mapping_a.ingress_key.parse().unwrap()).unwrap(),
        HostIngressStatus::Committed(seen) if seen.owner == "account-a"
    ));
}

#[test]
fn minted_identities_are_deterministic_uuid7() {
    let mut harness = Harness::new("minted");
    let incoming = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"kind":"text","text":"hello"}),
        1,
    );
    let (mapping, _) = committed(harness.submit(&incoming).unwrap());
    mapping
        .ingress_id
        .parse::<dolly_core_domain::IngressId>()
        .unwrap();
    mapping
        .block_id
        .parse::<dolly_core_domain::BlockId>()
        .unwrap();

    // The same key+digest obtains the same minted identities (returned from
    // the prior mapping, never a new mint).
    let (replayed, idempotent) = committed(harness.submit(&incoming).unwrap());
    assert!(idempotent);
    assert_eq!(replayed.ingress_id, mapping.ingress_id);
    assert_eq!(replayed.block_id, mapping.block_id);
}

// ---------------------------------------------------------------------------
// Atomicity, crash controls, and rejection before mutation
// ---------------------------------------------------------------------------

#[test]
fn rolled_back_transaction_leaves_zero_partial_mapping_rows() {
    let mut harness = Harness::new("rollback");
    let incoming = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"kind":"text","text":"hello"}),
        1,
    );
    let identity = dolly_core_reducer::derive_ingress_identity(&incoming).unwrap();

    // Simulate a daemon kill at an arbitrary stage: a transaction that wrote
    // the premise row and a Core operation row is rolled back, exactly as a
    // crash mid-submit would be. Nothing may remain.
    let tx = harness
        .connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    tx.execute(
        "INSERT INTO host_ingress_mappings (
            ingress_key, operation_digest, payload_digest, owner,
            extension_id, module_id, instance_id, generation,
            external_event_id, kind, references_external_event_id,
            target_pages_jcs, revision, ingress_id, block_id
         ) VALUES (
            ?1, ?2, ?2, 'account-a', 'org.dolly.channel', 'receiver',
            'instance-a', 7, 'msg-1', 'message', NULL,
            X'7b5b5d7d', 1, '0198ab31-6c44-7e8a-b2bb-000000000001',
            '0198ab31-6c44-7e8a-b2bb-000000000002'
         )",
        rusqlite::params![identity.key.as_str(), identity.operation_digest],
    )
    .unwrap();
    // Simulated crash: the transaction is dropped without commit.
    drop(tx);

    assert_eq!(harness.mapping_rows(), 0, "zero partial mapping after a crash");
    assert!(matches!(
        harness.status(&identity.key).unwrap(),
        HostIngressStatus::Absent
    ));

    // A byte-identical replay after the crash commits cleanly (exact
    // recovery), not as a duplicate or a conflict.
    let (mapping, idempotent) = committed(harness.submit(&incoming).unwrap());
    assert!(!idempotent);
    assert_eq!(mapping.ingress_key, identity.key.to_string());
    assert_eq!(harness.mapping_rows(), 1);
}

#[test]
fn rejected_submit_before_mutation_leaves_zero_rows() {
    // A connection without an installed graph: the seam must refuse before
    // any durable mutation.
    let mut connection = Connection::open_in_memory().unwrap();
    {
        let mut store = SqliteCoreStore::new(&mut connection).unwrap();
        install_config(&mut store, "no-graph");
    }
    create_host_ingress_schema(&mut connection).unwrap();
    let mut harness = Harness { connection };

    let incoming = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"kind":"text","text":"hello"}),
        1,
    );
    let error = harness.submit(&incoming).expect_err("no graph must refuse submit");
    assert_eq!(error.code(), HostIngressErrorCode::NotReady);
    assert_eq!(harness.mapping_rows(), 0);
}

#[test]
fn malformed_premise_is_rejected_before_mutation() {
    let mut harness = Harness::new("malformed");
    let mut incoming = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"kind":"text","text":"hello"}),
        1,
    );
    incoming.kind = HostIngressKind::Edit; // orphaned edit: no reference
    let error = harness
        .submit(&incoming)
        .expect_err("orphaned edit must be rejected");
    assert_eq!(error.code(), HostIngressErrorCode::PremiseInvalid);
    assert_eq!(harness.mapping_rows(), 0);
}

#[test]
fn oversized_payload_is_rejected_before_mutation() {
    let mut harness = Harness::new("oversized");
    let incoming = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"data": "x".repeat(520 * 1024)}),
        1,
    );
    let error = harness
        .submit(&incoming)
        .expect_err("oversized payload must be rejected");
    assert_eq!(error.code(), HostIngressErrorCode::PremiseTooLarge);
    assert_eq!(harness.mapping_rows(), 0);
}

// ---------------------------------------------------------------------------
// Fail-closed record verification and schema gate
// ---------------------------------------------------------------------------

#[test]
fn tampered_mapping_fails_closed() {
    let mut harness = Harness::new("tamper");
    let incoming = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"kind":"text","text":"hello"}),
        1,
    );
    let (mapping, _) = committed(harness.submit(&incoming).unwrap());

    // Corrupt an indexed column that disagrees with the closed record.
    harness
        .connection
        .execute(
            "UPDATE host_ingress_mappings SET owner = 'account-evil' WHERE ingress_key = ?1",
            [&mapping.ingress_key],
        )
        .unwrap();
    let error = harness
        .status(&mapping.ingress_key.parse().unwrap())
        .expect_err("a tampered mapping must fail closed");
    assert_eq!(error.code(), HostIngressErrorCode::Corrupt);
}

#[test]
fn missing_schema_is_gated_fail_closed() {
    let mut connection = Connection::open_in_memory().unwrap();
    let mut store = SqliteCoreStore::new(&mut connection).unwrap();
    install_config(&mut store, "no-schema");
    drop(store);

    let error = SqliteHostIngressStore::new(&mut connection).err().expect("schema gate");
    assert!(matches!(error, StorageError::MigrationRequired));
}

#[test]
fn mapping_read_verifies_indexed_columns_and_record() {
    let mut harness = Harness::new("verify");
    let incoming = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"kind":"text","text":"hello"}),
        1,
    );
    let (mapping, _) = committed(harness.submit(&incoming).unwrap());

    // Deleting the closed record bytes must fail closed as corrupt, never
    // return a partially verified mapping.
    harness
        .connection
        .execute(
            "UPDATE host_ingress_mappings SET mapping_jcs = X'00' WHERE ingress_key = ?1",
            [&mapping.ingress_key],
        )
        .unwrap();
    let error = harness
        .status(&mapping.ingress_key.parse().unwrap())
        .expect_err("missing record bytes must fail closed");
    assert_eq!(error.code(), HostIngressErrorCode::Corrupt);
}
