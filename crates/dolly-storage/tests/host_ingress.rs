//! Focused durable Host ingress submit/status seam tests against the real
//! bundled SQLite: opaque principal authority/grant validation, stale/revoked
//! grant, graph producer direction, lifecycle reference, real UUIDv7
//! allocation, cross-principal isolation, idempotent replay/conflict over the
//! ordered target Pages, atomic rollback/recovery, and fail-closed
//! cross-verification of mapping, Core operation, and effect.

use dolly_canonical_json::CanonicalJsonValue;
use dolly_core_domain::{
    HostIngressErrorCode, HostIngressKind, HostIngressStatus, HostIngressStatusRequest,
    HostIngressSubmitOutcome, HostIngressSubmitRequest, PageId,
};
use dolly_core_reducer::{
    CoreCommand, EnvironmentInput, InstallConfigCommand, InstallGraphCommand, TransitionOutcome,
};
use dolly_storage::{
    HostConnectionAuthority, HostIngress, SqliteCoreStore, SqliteHostIngressStore, StorageError,
    host_ingress::create_host_ingress_schema,
};
use rusqlite::Connection;
use serde_json::{Value, json};

const EXTENSION_ID: &str = "org.dolly.channel";
const MODULE_ID: &str = "receiver";
const MODULE_B_ID: &str = "receiver-b";
const WORKER_EPOCH: &str = "0198ab31-6c44-7e8a-b2bb-000000000110";
const OTHER_WORKER_EPOCH: &str = "0198ab31-6c44-7e8a-b2bb-000000000111";

fn digest(value: &Value) -> String {
    dolly_canonical_json::canonicalize(value)
        .unwrap()
        .1
        .to_canonical_string()
}

fn input() -> EnvironmentInput {
    EnvironmentInput {
        now: "2026-08-28T00:00:00.000000Z".into(),
        ..Default::default()
    }
}

fn page(id: &str) -> PageId {
    id.parse().unwrap()
}

fn payload(value: Value) -> CanonicalJsonValue {
    serde_json::from_value(value).unwrap()
}

fn request(
    external: &str,
    kind: HostIngressKind,
    references: Option<&str>,
    pages: &[&str],
    content: Value,
) -> HostIngressSubmitRequest {
    HostIngressSubmitRequest {
        external_event_id: external.into(),
        kind,
        references_external_event_id: references.map(str::to_owned),
        target_page_ids: pages.iter().map(|id| page(id)).collect(),
        payload: payload(content),
    }
}

fn descriptor(module_id: &str) -> Value {
    json!({
        "schema": "dolly.module-descriptor/v1",
        "module_id": module_id,
        "descriptor_revision": 1,
        "display_name": module_id,
        "accepts": {"summary":"input","part_kinds":["text"],"action_names":[]},
        "emits": {"summary":"output","part_kinds":["text"],"action_names":[]},
        "actions": [],
        "activation_replay_contract": {"mode":"fenced_replay","evidence":"pure_compute","ledger":null},
        "trust": "trusted",
        "metadata": {}
    })
}

fn graph(module_ids: &[&str]) -> Value {
    let mut output_pages = serde_json::Map::new();
    for module_id in module_ids {
        output_pages.insert(
            (*module_id).to_owned(),
            json!(["page-a", "page-b"]),
        );
    }
    let mut descriptors = serde_json::Map::new();
    for module_id in module_ids {
        descriptors.insert(
            (*module_id).to_owned(),
            json!({
                "module_id": module_id,
                "descriptor_revision": 1,
                "source_descriptor_digest": digest(&descriptor(module_id)),
                "value": descriptor(module_id)
            }),
        );
    }
    json!({
        "receiving_module": "receiver",
        "input_pages": {},
        "output_pages": output_pages,
        "subscriptions": {},
        "descriptors": descriptors,
        "authorized_metadata_namespaces": [],
        "authorized_action_names": []
    })
}

fn configured(
    store: &mut SqliteCoreStore<'_>,
    mark: &str,
    revision: i64,
    connection_id: &str,
    epoch: &str,
) {
    let effective_config = json!({
        "execution_timeout_ms": 120000,
        "lease_grace_ms": 30000,
        "fencing_grace_ms": 5000,
        "extension_connection_id": connection_id,
        "worker_epoch": epoch,
        "worker_epoch_fence": 17
    });
    let transition = store
        .transact(
            &CoreCommand::InstallConfig(InstallConfigCommand {
                command_id: format!("{mark}-config"),
                revision,
                digest: digest(&effective_config),
                effective_config,
            }),
            &input(),
        )
        .unwrap();
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
}

fn install_base(store: &mut SqliteCoreStore<'_>, mark: &str) -> HostConnectionAuthority {
    configured(store, mark, 1, "g4-ingress-connection", WORKER_EPOCH);
    let graph = graph(&[MODULE_ID, MODULE_B_ID]);
    let transition = store
        .transact(
            &CoreCommand::InstallGraph(InstallGraphCommand {
                command_id: format!("{mark}-graph"),
                revision: 1,
                digest: digest(&graph),
                graph,
            }),
            &input(),
        )
        .unwrap();
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
    store.bootstrap_host_connection().unwrap()
}

struct Harness {
    connection: Connection,
    authority: HostConnectionAuthority,
    grant: dolly_storage::HostCapabilityGrant,
    grant_b: dolly_storage::HostCapabilityGrant,
}

impl Harness {
    fn new(mark: &str) -> Self {
        let mut connection = Connection::open_in_memory().unwrap();
        let authority = {
            let mut store = SqliteCoreStore::new(&mut connection).unwrap();
            let authority = install_base(&mut store, mark);
            install_grant(&mut store, &authority, MODULE_ID, 1, &["host.ingress.submit"]);
            install_grant(&mut store, &authority, MODULE_B_ID, 1, &["host.ingress.submit"]);
            authority
        };
        create_host_ingress_schema(&mut connection).unwrap();
        let grant = SqliteCoreStore::new(&mut connection)
            .unwrap()
            .current_host_capability_grant(&authority, EXTENSION_ID, MODULE_ID)
            .unwrap()
            .unwrap();
        let grant_b = SqliteCoreStore::new(&mut connection)
            .unwrap()
            .current_host_capability_grant(&authority, EXTENSION_ID, MODULE_B_ID)
            .unwrap()
            .unwrap();
        Self {
            connection,
            authority,
            grant,
            grant_b,
        }
    }

}

fn submit(
    connection: &mut Connection,
    authority: &HostConnectionAuthority,
    grant: &dolly_storage::HostCapabilityGrant,
    incoming: &HostIngressSubmitRequest,
) -> Result<HostIngressSubmitOutcome, dolly_core_domain::HostIngressError> {
    let mut store = SqliteHostIngressStore::new(connection).unwrap();
    store.submit(authority, grant, incoming)
}

fn status(
    connection: &mut Connection,
    authority: &HostConnectionAuthority,
    grant: &dolly_storage::HostCapabilityGrant,
    external: &str,
) -> Result<HostIngressStatus, dolly_core_domain::HostIngressError> {
    let mut store = SqliteHostIngressStore::new(connection).unwrap();
    store.status(
        authority,
        grant,
        &HostIngressStatusRequest {
            external_event_id: external.into(),
        },
    )
}

fn mapping_rows(connection: &mut Connection) -> i64 {
    connection
        .query_row("SELECT COUNT(*) FROM host_ingress_mappings", [], |row| {
            row.get(0)
        })
        .unwrap()
}

fn core_state(connection: &mut Connection) -> dolly_core_reducer::CoreSnapshot {
    let store = SqliteCoreStore::new(connection).unwrap();
    store.snapshot().unwrap()
}

fn install_grant(
    store: &mut SqliteCoreStore<'_>,
    authority: &HostConnectionAuthority,
    module_id: &str,
    extension_generation: i64,
    methods: &[&str],
) {
    store
        .install_host_capability_grant(
            authority,
            EXTENSION_ID,
            module_id,
            extension_generation,
            1,
            &digest(&descriptor(module_id)),
            1,
            &digest(&json!({"manifest": 1})),
            1,
            &digest(&graph(&[module_id])),
            methods,
        )
        .unwrap();
}

fn committed(
    outcome: HostIngressSubmitOutcome,
) -> (dolly_core_domain::HostIngressMapping, bool) {
    match outcome {
        HostIngressSubmitOutcome::Committed { mapping, idempotent } => (*mapping, idempotent),
        HostIngressSubmitOutcome::Conflict { .. } => panic!("expected a committed outcome"),
    }
}

// ---------------------------------------------------------------------------
// Fresh commit, idempotent replay, ordered target-Page conflict
// ---------------------------------------------------------------------------

#[test]
fn fresh_submit_commits_mapping_and_effect() {
    let mut harness = Harness::new("fresh");
    let (mapping, idempotent) = committed(submit(&mut harness.connection, 
        &harness.authority,
        &harness.grant,
        &request("msg-1", HostIngressKind::Message, None, &["page-a", "page-b"], json!({"kind":"text","text":"hello"})),
    ).unwrap());
    assert!(!idempotent);

    // Authority-bound identity comes from the opaque grant/authority.
    assert_eq!(mapping.owner, "g4-ingress-connection");
    assert_eq!(mapping.extension_id, EXTENSION_ID);
    assert_eq!(mapping.module_id, MODULE_ID);
    assert_eq!(mapping.instance_id, WORKER_EPOCH);
    assert_eq!(mapping.generation, 1);
    assert!(mapping.revision >= 1);
    assert_eq!(mapping.graph_revision, 1);
    assert_eq!(mapping.kind, "message");
    assert_eq!(mapping.target_page_ids, vec!["page-a", "page-b"]);
    assert_eq!(mapping.deliveries.len(), 2);

    // The Core effect exists and is bound to the minted Block.
    let state = core_state(&mut harness.connection);
    let block = state.blocks.get(&mapping.block_id).unwrap();
    assert_eq!(block["text"], "hello");

    // status reconciles to the identical committed mapping.
    match status(&mut harness.connection, &harness.authority, &harness.grant, "msg-1")
        .unwrap()
    {
        HostIngressStatus::Committed(seen) => assert_eq!(*seen, mapping),
        HostIngressStatus::Absent => panic!("committed mapping must not be absent"),
    }
}

#[test]
fn same_key_same_digest_replays_prior_mapping_without_mutation() {
    let mut harness = Harness::new("replay");
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a", "page-b"], json!({"kind":"text","text":"hello"}));
    let (first, false) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap()) else {
        panic!("first submit must commit")
    };
    let commit_before = core_state(&mut harness.connection).next_commit_seq;
    let (second, idempotent) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());
    assert!(idempotent);
    assert_eq!(second, first);
    assert_eq!(core_state(&mut harness.connection).next_commit_seq, commit_before);
    assert_eq!(mapping_rows(&mut harness.connection), 1);
}

#[test]
fn same_key_different_target_pages_conflicts_with_zero_mutation() {
    let mut harness = Harness::new("pages-conflict");
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a", "page-b"], json!({"kind":"text","text":"hello"}));
    let (first, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());
    let commit_before = core_state(&mut harness.connection).next_commit_seq;

    let reordered =
        request("msg-1", HostIngressKind::Message, None, &["page-b", "page-a"], json!({"kind":"text","text":"hello"}));
    match submit(&mut harness.connection, &harness.authority, &harness.grant, &reordered)
        .unwrap()
    {
        HostIngressSubmitOutcome::Conflict { key, .. } => assert_eq!(key.as_str(), first.ingress_key),
        _ => panic!("reordered target Pages must conflict"),
    }
    assert_eq!(core_state(&mut harness.connection).next_commit_seq, commit_before);
    assert_eq!(mapping_rows(&mut harness.connection), 1);
    match status(&mut harness.connection, &harness.authority, &harness.grant, "msg-1").unwrap() {
        HostIngressStatus::Committed(seen) => assert_eq!(*seen, first),
        HostIngressStatus::Absent => panic!("prior mapping must survive a conflict"),
    }
}

#[test]
fn canonical_equivalent_targets_replay_idempotently() {
    let mut harness = Harness::new("equivalent");
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a", "page-b"], json!({"kind":"text","text":"hello"}));
    let (first, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());
    let duplicated =
        request("msg-1", HostIngressKind::Message, None, &["page-a", "page-a", "page-b"], json!({"kind":"text","text":"hello"}));
    let (second, idempotent) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &duplicated).unwrap());
    assert!(idempotent);
    assert_eq!(second, first);
    assert_eq!(mapping_rows(&mut harness.connection), 1);
}

#[test]
fn changed_content_same_key_conflicts_without_mutation() {
    let mut harness = Harness::new("content-conflict");
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let (first, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());
    let changed =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"goodbye"}));
    assert!(matches!(
        submit(&mut harness.connection, &harness.authority, &harness.grant, &changed).unwrap(),
        HostIngressSubmitOutcome::Conflict { .. }
    ));
    assert_eq!(mapping_rows(&mut harness.connection), 1);
    match status(&mut harness.connection, &harness.authority, &harness.grant, "msg-1").unwrap() {
        HostIngressStatus::Committed(seen) => assert_eq!(seen.payload_digest, first.payload_digest),
        HostIngressStatus::Absent => panic!("prior mapping must survive"),
    }
}

// ---------------------------------------------------------------------------
// Principal authority/grant validation
// ---------------------------------------------------------------------------

#[test]
fn stale_grant_is_rejected_before_mutation() {
    let mut harness = Harness::new("stale-grant");
    let incoming1 = request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let (first, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming1).unwrap());
    assert_eq!(first.generation, 1);

    // Rotate the grant generation with the same host connection: the old
    // grant value is stale and can neither submit nor derive a replay.
    {
        let mut store = SqliteCoreStore::new(&mut harness.connection).unwrap();
        install_grant(&mut store, &harness.authority, MODULE_ID, 2, &["host.ingress.submit"]);
    }
    let error = submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming1)
        .expect_err("a stale grant must be rejected");
    assert_eq!(error.code(), HostIngressErrorCode::Stale);
    assert_eq!(mapping_rows(&mut harness.connection), 1, "stale submit must mutate nothing");

    // The current grant is still accepted and commits under the same key.
    let grant2 = SqliteCoreStore::new(&mut harness.connection)
        .unwrap()
        .current_host_capability_grant(&harness.authority, EXTENSION_ID, MODULE_ID)
        .unwrap()
        .unwrap();
    let incoming2 = request("msg-2", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hi"}));
    let (mapping2, _) = committed(submit(&mut harness.connection, &harness.authority, &grant2, &incoming2).unwrap());
    assert_eq!(mapping2.generation, 2);
}

#[test]
fn revoked_grant_is_rejected_before_mutation() {
    let mut harness = Harness::new("revoked");
    let incoming = request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());

    SqliteCoreStore::new(&mut harness.connection)
        .unwrap()
        .revoke_host_capability_grant(&harness.authority, EXTENSION_ID, MODULE_ID)
        .unwrap();

    let error = submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming)
        .expect_err("a revoked grant must be refused");
    assert_eq!(error.code(), HostIngressErrorCode::NotAuthorized);
    assert_eq!(mapping_rows(&mut harness.connection), 1);
}

#[test]
fn grant_without_submit_method_is_refused() {
    let mut harness = Harness::new("no-method");
    {
        let mut store = SqliteCoreStore::new(&mut harness.connection).unwrap();
        install_grant(&mut store, &harness.authority, MODULE_ID, 1, &["host.block.get"]);
    }
    let grant_no_method = SqliteCoreStore::new(&mut harness.connection)
        .unwrap()
        .current_host_capability_grant(&harness.authority, EXTENSION_ID, MODULE_ID)
        .unwrap()
        .unwrap();
    let incoming = request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let error = submit(&mut harness.connection, &harness.authority, &grant_no_method, &incoming)
        .expect_err("grant missing the submit method must be refused");
    assert_eq!(error.code(), HostIngressErrorCode::NotAuthorized);
    assert_eq!(mapping_rows(&mut harness.connection), 0);
}

#[test]
fn rotated_authority_is_rejected_and_never_discloses() {
    let mut harness = Harness::new("rotated");
    let incoming = request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let (first, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());

    // Rotate the Host connection to a new owner/instance.
    let rotated = {
        let mut store = SqliteCoreStore::new(&mut harness.connection).unwrap();
        configured(&mut store, "rotated-v2", 2, "g4-ingress-connection-2", OTHER_WORKER_EPOCH);
        store.rotate_host_connection(&harness.authority).unwrap()
    };
    assert_ne!(rotated, harness.authority);

    // A submit with the old authority cannot construct durable authority.
    let error = submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming)
        .expect_err("a rotated authority must be rejected");
    assert_eq!(error.code(), HostIngressErrorCode::NotAuthorized);
    assert_eq!(mapping_rows(&mut harness.connection), 1);

    // The new principal cannot read the old principal's mapping; never
    // another owner's payload.
    let error = status(&mut harness.connection, &rotated, &harness.grant, "msg-1")
        .expect_err("the new principal must not disclose the old principal's payload");
    assert_eq!(error.code(), HostIngressErrorCode::NotAuthorized);
}

#[test]
fn cross_module_sources_never_disclose_each_other() {
    let mut harness = Harness::new("cross-source");
    let incoming = request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let (mapping_a, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());

    // The same external id under a different source module is a different
    // key: no conflict, an independent mapping, and no disclosure.
    let mut incoming_b = incoming.clone();
    incoming_b.kind = HostIngressKind::Message;
    incoming_b.references_external_event_id = None;
    let (mapping_b, _) = committed(
        submit(&mut harness.connection, &harness.authority, &harness.grant_b, &incoming_b).unwrap(),
    );
    assert_ne!(mapping_a.ingress_key, mapping_b.ingress_key);
    assert_eq!(mapping_rows(&mut harness.connection), 2);

    // Module B reading the SAME external id sees only its own mapping.
    match status(&mut harness.connection, &harness.authority, &harness.grant_b, "msg-1").unwrap() {
        HostIngressStatus::Committed(seen) => {
            assert_eq!(seen.module_id, MODULE_B_ID);
            assert_eq!(seen.payload_digest, mapping_a.payload_digest);
        }
        HostIngressStatus::Absent => panic!("module B committed the same external id"),
    }
}

// ---------------------------------------------------------------------------
// Graph direction and lifecycle reference validation
// ---------------------------------------------------------------------------

#[test]
fn target_page_outside_module_graph_direction_is_rejected() {
    let mut harness = Harness::new("direction");
    let incoming = request(
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a", "page-foreign"],
        json!({"kind":"text","text":"hello"}),
    );
    let error = submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming)
        .expect_err("a page outside the module's graph output must be rejected");
    assert_eq!(error.code(), HostIngressErrorCode::TargetNotAuthorized);
    assert_eq!(mapping_rows(&mut harness.connection), 0);
}

#[test]
fn graph_revision_mismatch_with_grant_is_rejected() {
    let mut harness = Harness::new("graph-mismatch");
    let incoming = request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));

    // Install a graph revision 2 while the grant pins revision 1.
    let graph2 = graph(&[MODULE_ID, MODULE_B_ID]);
    let transition = {
        let mut store = SqliteCoreStore::new(&mut harness.connection).unwrap();
        store
            .transact(
                &CoreCommand::InstallGraph(InstallGraphCommand {
                    command_id: "graph2".into(),
                    revision: 2,
                    digest: digest(&graph2),
                    graph: graph2,
                }),
                &input(),
            )
            .unwrap()
    };
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
    let error = submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming)
        .expect_err("a grant pinning the old graph revision must be refused");
    assert_eq!(error.code(), HostIngressErrorCode::Stale);
    assert_eq!(mapping_rows(&mut harness.connection), 0);
}

#[test]
fn edit_and_delete_reference_a_committed_event_by_the_same_principal() {
    let mut harness = Harness::new("lifecycle");
    let msg =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &msg).unwrap());

    // An edit referencing the committed original commits and binds the
    // relation into its identity.
    let edit = request(
        "edit-1",
        HostIngressKind::Edit,
        Some("msg-1"),
        &["page-a"],
        json!({"kind":"text","text":"hello edited"}),
    );
    let (mapping_edit, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &edit).unwrap());
    assert_eq!(mapping_edit.kind, "edit");
    assert_eq!(mapping_edit.references_external_event_id.as_deref(), Some("msg-1"));

    // A delete referencing the original commits; the mapping exists for the
    // delete key too.
    let delete = request(
        "del-1",
        HostIngressKind::Delete,
        Some("msg-1"),
        &["page-a"],
        json!({"kind":"text","text":"byebye"}),
    );
    let (mapping_delete, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &delete).unwrap());
    assert_eq!(mapping_delete.kind, "delete");
    assert_eq!(mapping_rows(&mut harness.connection), 3);
}

#[test]
fn edit_referencing_an_uncommitted_event_is_rejected() {
    let mut harness = Harness::new("missing-ref");
    let incoming = request(
        "edit-1",
        HostIngressKind::Edit,
        Some("never-committed"),
        &["page-a"],
        json!({"kind":"text","text":"hello edited"}),
    );
    let error = submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming)
        .expect_err("an edit referencing an uncommitted event must be rejected");
    assert_eq!(error.code(), HostIngressErrorCode::ReferencedEventMissing);
    assert_eq!(mapping_rows(&mut harness.connection), 0);
}

#[test]
fn message_with_reference_is_rejected_before_mutation() {
    let mut harness = Harness::new("message-ref");
    let incoming = request(
        "msg-1",
        HostIngressKind::Message,
        Some("msg-0"),
        &["page-a"],
        json!({"kind":"text","text":"hello"}),
    );
    let error = submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming)
        .expect_err("a message must not carry a reference");
    assert_eq!(error.code(), HostIngressErrorCode::PremiseInvalid);
    assert_eq!(mapping_rows(&mut harness.connection), 0);
}

#[test]
fn oversized_payload_is_rejected_before_mutation() {
    let mut harness = Harness::new("oversized");
    let incoming = request(
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"data": "x".repeat(520 * 1024)}),
    );
    let error = submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming)
        .expect_err("oversized payload must be rejected");
    assert_eq!(error.code(), HostIngressErrorCode::PremiseTooLarge);
    assert_eq!(mapping_rows(&mut harness.connection), 0);
}

// ---------------------------------------------------------------------------
// Real UUIDv7 allocation
// ---------------------------------------------------------------------------

#[test]
fn minted_identities_are_real_uuidv7_and_replay_surfaces_the_stored_pair() {
    let mut harness = Harness::new("uuid");
    let incoming = request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let (first, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());

    let ingress_bytes = first.ingress_id.as_bytes();
    let block_bytes = first.block_id.as_bytes();
    for bytes in [ingress_bytes, block_bytes] {
        assert_eq!(bytes.len(), 36);
        assert!(bytes.iter().all(|b| b.is_ascii_hexdigit() || *b == b'-'));
        assert_eq!(bytes[8], b'-');
        assert_eq!(bytes[13], b'-');
        assert_eq!(bytes[18], b'-');
        assert_eq!(bytes[23], b'-');
        assert_eq!(bytes[14], b'7', "version nibble must be RFC-9562 v7");
        assert!(matches!(bytes[19], b'8' | b'9' | b'a' | b'b'), "variant nibble must be RFC-9562");
    }
    first.ingress_id.parse::<dolly_core_domain::IngressId>().unwrap();
    first.block_id.parse::<dolly_core_domain::BlockId>().unwrap();

    // A second commit allocates a fresh, distinct identity pair.
    let second_request =
        request("msg-2", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"bye"}));
    let (second, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &second_request).unwrap());
    assert_ne!(first.ingress_id, second.ingress_id);
    assert_ne!(first.block_id, second.block_id);

    // An idempotent replay returns the stored pair, never a fresh mint.
    let (replayed, idempotent) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());
    assert!(idempotent);
    assert_eq!(replayed.ingress_id, first.ingress_id);
    assert_eq!(replayed.block_id, first.block_id);
}

// ---------------------------------------------------------------------------
// Absence, cross-verification, and fail-closed tamper detection
// ---------------------------------------------------------------------------

#[test]
fn absent_status_is_explicit() {
    let mut harness = Harness::new("absent");
    assert!(matches!(
        status(&mut harness.connection, &harness.authority, &harness.grant, "never-submitted").unwrap(),
        HostIngressStatus::Absent
    ));
    assert_eq!(mapping_rows(&mut harness.connection), 0);
}

#[test]
fn lost_response_is_reconciled_through_status_not_resubmission() {
    let mut harness = Harness::new("lost-response");
    let incoming = request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let _lost_receipt = submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap();

    let mapping = match status(&mut harness.connection, &harness.authority, &harness.grant, "msg-1").unwrap() {
        HostIngressStatus::Committed(mapping) => *mapping,
        HostIngressStatus::Absent => panic!("lost response after commit must not read absent"),
    };
    assert_eq!(mapping.external_event_id, "msg-1");
    let (replayed, idempotent) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());
    assert!(idempotent);
    assert_eq!(replayed, mapping);
    assert_eq!(mapping_rows(&mut harness.connection), 1);
}

#[test]
fn deleted_mapping_row_never_reads_as_absent() {
    let mut harness = Harness::new("deleted-mapping");
    let incoming = request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let (mapping, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());
    harness
        .connection
        .execute("DELETE FROM host_ingress_mappings WHERE ingress_key = ?1", [&mapping.ingress_key])
        .unwrap();

    // The Core operation still exists, so absence must not be reported.
    let error = status(&mut harness.connection, &harness.authority, &harness.grant, "msg-1")
        .expect_err("a deleted mapping with a live Core operation must fail closed");
    assert_eq!(error.code(), HostIngressErrorCode::Corrupt);
}

#[test]
fn lost_core_operation_never_reads_as_committed() {
    let mut harness = Harness::new("lost-operation");
    let incoming = request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let (mapping, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());
    harness
        .connection
        .execute("DELETE FROM core_operations WHERE command_id = ?1", [&mapping.command_id])
        .unwrap();

    let error = status(&mut harness.connection, &harness.authority, &harness.grant, "msg-1")
        .expect_err("a mapping whose Core operation is lost must fail closed");
    assert_eq!(error.code(), HostIngressErrorCode::Corrupt);
}

#[test]
fn tampered_premise_bytes_fail_closed() {
    let mut harness = Harness::new("tamper-premise");
    let incoming = request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let (mapping, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());
    harness
        .connection
        .execute(
            "UPDATE host_ingress_mappings SET premise_jcs = X'00' WHERE ingress_key = ?1",
            [&mapping.ingress_key],
        )
        .unwrap();
    let error = status(&mut harness.connection, &harness.authority, &harness.grant, "msg-1")
        .expect_err("tampered premise bytes must fail closed");
    assert_eq!(error.code(), HostIngressErrorCode::Corrupt);
}

#[test]
fn tampered_mapping_columns_fail_closed() {
    let mut harness = Harness::new("tamper-columns");
    let incoming = request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let (mapping, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());
    harness
        .connection
        .execute(
            "UPDATE host_ingress_mappings SET owner = 'account-evil' WHERE ingress_key = ?1",
            [&mapping.ingress_key],
        )
        .unwrap();
    let error = status(&mut harness.connection, &harness.authority, &harness.grant, "msg-1")
        .expect_err("tampered columns must fail closed");
    assert_eq!(error.code(), HostIngressErrorCode::Corrupt);
}

#[test]
fn recovery_index_is_part_of_the_schema_gate() {
    let mut harness = Harness::new("index-gate");
    harness
        .connection
        .execute("DROP INDEX host_ingress_mappings_recovery", [])
        .unwrap();
    let error = SqliteHostIngressStore::new(&mut harness.connection).err().unwrap();
    assert!(matches!(error, StorageError::Corrupt));
}

#[test]
fn missing_schema_is_gated_fail_closed() {
    let mut connection = Connection::open_in_memory().unwrap();
    {
        let mut store = SqliteCoreStore::new(&mut connection).unwrap();
        store.bootstrap_host_connection().ok();
    }
    let error = SqliteHostIngressStore::new(&mut connection).err().unwrap();
    assert!(matches!(error, StorageError::MigrationRequired));
}

// ---------------------------------------------------------------------------
// Atomic rollback and exact recovery
// ---------------------------------------------------------------------------

#[test]
fn rolled_back_transaction_leaves_zero_partial_mapping_rows() {
    let mut harness = Harness::new("rollback");
    let incoming = request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let identity = {
        let facts = dolly_core_reducer::IngressAuthorityFacts {
            owner: "g4-ingress-connection".into(),
            extension_id: EXTENSION_ID.into(),
            module_id: MODULE_ID.into(),
            instance_id: WORKER_EPOCH.into(),
            generation: 1,
            revision: 1,
            graph_revision: 1,
        };
        dolly_core_reducer::derive_ingress_identity(&facts, &incoming).unwrap()
    };

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
            revision, graph_revision, external_event_id, kind,
            references_external_event_id, target_pages_jcs,
            premise_jcs, premise_digest, ingress_id, block_id
         ) VALUES (
            ?1, ?2, ?2, 'g4-ingress-connection', 'org.dolly.channel', 'receiver',
            '0198ab31-6c44-7e8a-b2bb-000000000110', 1, 1, 1, 'msg-1', 'message', NULL,
            X'7b5b5d7d', X'7b7d', ?2, '0198ab31-6c44-7e8a-b2bb-000000000001',
            '0198ab31-6c44-7e8a-b2bb-000000000002'
         )",
        rusqlite::params![identity.key.as_str(), identity.operation_digest],
    )
    .unwrap();
    drop(tx);

    assert_eq!(mapping_rows(&mut harness.connection), 0, "zero partial mapping after a crash");
    assert!(matches!(
        status(&mut harness.connection, &harness.authority, &harness.grant, "msg-1").unwrap(),
        HostIngressStatus::Absent
    ));

    // A byte-identical replay after the crash commits cleanly (exact
    // recovery), not as a duplicate or a conflict.
    let (mapping, idempotent) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());
    assert!(!idempotent, "after a crash the replay is a fresh commit");
    assert_eq!(mapping_rows(&mut harness.connection), 1);
    match status(&mut harness.connection, &harness.authority, &harness.grant, "msg-1").unwrap() {
        HostIngressStatus::Committed(seen) => assert_eq!(seen.ingress_key, mapping.ingress_key),
        HostIngressStatus::Absent => panic!("replayed commit must be visible"),
    }
}
