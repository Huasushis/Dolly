//! Focused durable Host ingress submit/status seam tests against the real
//! bundled SQLite: sealed opaque principal authority/grant validation (submit
//! AND status require the method, one-transaction status), grant-pinned graph
//! digest/revision and exact/opposite target direction, lifecycle reference,
//! real RFC-9562 UUIDv7 allocation with no-remint replay, the shared
//! fail-closed verification (operation/transition/ingress/block/delivery
//! links; deletion/tamper never reads as false Absent/Committed), idempotent
//! replay/conflict over the ordered target Pages, and real rollback/recovery.

use dolly_canonical_json::{CanonicalJsonValue, ParseLimits, canonicalize, deserialize_core_json};
use dolly_core_domain::{
    HostIngressErrorCode, HostIngressKind, HostIngressStatus, HostIngressStatusRequest,
    HostIngressSubmitOutcome, HostIngressSubmitRequest, PageId,
};
use dolly_core_reducer::{
    CoreCommand, EnvironmentInput, InstallConfigCommand, InstallGraphCommand,
    RecoveryVerification, RecoverCommand, TransitionOutcome,
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

/// The installed graph body. `receiver_input_pages` lets a test declare the
/// module's consumer (input) pages to exercise opposite-direction rejection.
fn graph(module_ids: &[&str], receiver_input_pages: &[&str]) -> Value {
    let mut output_pages = serde_json::Map::new();
    for module_id in module_ids {
        output_pages.insert((*module_id).to_owned(), json!(["page-a", "page-b"]));
    }
    let mut descriptors = serde_json::Map::new();
    for module_id in module_ids {
        descriptors.insert(
            (*module_id).to_owned(),
            json!({
                "module_id": module_id,
                "descriptor_revision": 1,
                "source_descriptor_digest": digest(&descriptor(module_id)),
                "owner_extension_id": EXTENSION_ID,
                "value": descriptor(module_id)
            }),
        );
    }
    json!({
        "receiving_module": "receiver",
        "input_pages": {"receiver": receiver_input_pages},
        "output_pages": output_pages,
        "subscriptions": {},
        "descriptors": descriptors,
        "authorized_metadata_namespaces": [],
        "authorized_action_names": []
    })
}

#[allow(clippy::too_many_arguments)]
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

fn install_graph(store: &mut SqliteCoreStore<'_>, mark: &str, revision: i64, body: &Value) {
    let transition = store
        .transact(
            &CoreCommand::InstallGraph(InstallGraphCommand {
                command_id: format!("{mark}-graph-{revision}"),
                revision,
                digest: digest(body),
                graph: body.clone(),
            }),
            &input(),
        )
        .unwrap();
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
}

fn install_grant(
    store: &mut SqliteCoreStore<'_>,
    authority: &HostConnectionAuthority,
    module_id: &str,
    extension_generation: i64,
    graph_revision: i64,
    graph_digest: &str,
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
            graph_revision,
            graph_digest,
            methods,
        )
        .unwrap();
}

struct Harness {
    connection: Connection,
    authority: HostConnectionAuthority,
    grant: dolly_storage::HostCapabilityGrant,
    grant_b: dolly_storage::HostCapabilityGrant,
}

impl Harness {
    fn new(mark: &str) -> Self {
        Self::new_with_inputs(mark, &[])
    }

    /// Build a harness whose installed graph lists `receiver_input_pages` as
    /// the module's input (consumer-direction) pages.
    fn new_with_inputs(mark: &str, receiver_input_pages: &[&str]) -> Self {
        let body = graph(&[MODULE_ID, MODULE_B_ID], receiver_input_pages);
        let mut connection = Connection::open_in_memory().unwrap();
        let authority = {
            let mut store = SqliteCoreStore::new(&mut connection).unwrap();
            configured(&mut store, mark, 1, "g4-ingress-connection", WORKER_EPOCH);
            install_graph(&mut store, mark, 1, &body);
            let authority = store.bootstrap_host_connection().unwrap();
            install_grant(
                &mut store,
                &authority,
                MODULE_ID,
                1,
                1,
                &digest(&body),
                &["host.ingress.submit"],
            );
            install_grant(
                &mut store,
                &authority,
                MODULE_B_ID,
                1,
                1,
                &digest(&body),
                &["host.ingress.submit"],
            );
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

    fn load_current_grant(
        &mut self,
        module_id: &str,
    ) -> dolly_storage::HostCapabilityGrant {
        SqliteCoreStore::new(&mut self.connection)
            .unwrap()
            .current_host_capability_grant(&self.authority, EXTENSION_ID, module_id)
            .unwrap()
            .unwrap()
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

fn committed(outcome: HostIngressSubmitOutcome) -> (dolly_core_domain::HostIngressMapping, bool) {
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
    let (mapping, idempotent) = committed(submit(
        &mut harness.connection,
        &harness.authority,
        &harness.grant,
        &request("msg-1", HostIngressKind::Message, None, &["page-a", "page-b"], json!({"kind":"text","text":"hello"})),
    )
    .unwrap());
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

    let state = core_state(&mut harness.connection);
    assert!(state.blocks.contains_key(&mapping.block_id));
    assert!(state
        .ingress
        .values()
        .any(|record| record.block_id == mapping.block_id));

    match status(&mut harness.connection, &harness.authority, &harness.grant, "msg-1").unwrap() {
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
fn no_remint_replay_returns_the_stored_identity_pair() {
    let mut harness = Harness::new("no-remint");
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let (first, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());
    let state_after_first = core_state(&mut harness.connection).next_commit_seq;
    let (replayed, idempotent) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());
    assert!(idempotent);
    // The stored identities return unchanged and no new Core allocation
    // happened (no new block/delivery/journal state).
    assert_eq!(replayed.ingress_id, first.ingress_id);
    assert_eq!(replayed.block_id, first.block_id);
    assert_eq!(core_state(&mut harness.connection).next_commit_seq, state_after_first);
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
    match submit(&mut harness.connection, &harness.authority, &harness.grant, &reordered).unwrap() {
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
// Principal authority/grant validation (submit and status), transactional
// scope
// ---------------------------------------------------------------------------

#[test]
fn stale_grant_is_rejected_before_mutation() {
    let mut harness = Harness::new("stale-grant");
    let incoming1 = request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let (first, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming1).unwrap());
    assert_eq!(first.generation, 1);

    {
        let body = graph(&[MODULE_ID, MODULE_B_ID], &[]);
        let mut store = SqliteCoreStore::new(&mut harness.connection).unwrap();
        install_grant(&mut store, &harness.authority, MODULE_ID, 2, 1, &digest(&body), &["host.ingress.submit"]);
    }
    let error = submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming1)
        .expect_err("a stale grant must be rejected");
    assert_eq!(error.code(), HostIngressErrorCode::Stale);
    assert_eq!(mapping_rows(&mut harness.connection), 1, "stale submit must mutate nothing");

    let grant2 = harness.load_current_grant(MODULE_ID);
    let incoming2 = request("msg-2", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hi"}));
    let (mapping2, _) = committed(submit(&mut harness.connection, &harness.authority, &grant2, &incoming2).unwrap());
    assert_eq!(mapping2.generation, 2);
}

#[test]
fn revoked_grant_is_rejected_for_submit_and_status_before_mutation() {
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
    let error = status(&mut harness.connection, &harness.authority, &harness.grant, "msg-1")
        .expect_err("status must refuse a revoked grant inside its transaction");
    assert_eq!(error.code(), HostIngressErrorCode::NotAuthorized);
    assert_eq!(mapping_rows(&mut harness.connection), 1);
}

#[test]
fn status_requires_the_submit_method_like_submit() {
    let mut harness = Harness::new("status-no-method");
    let incoming = request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());

    {
        let body = graph(&[MODULE_ID, MODULE_B_ID], &[]);
        let mut store = SqliteCoreStore::new(&mut harness.connection).unwrap();
        install_grant(&mut store, &harness.authority, MODULE_ID, 1, 1, &digest(&body), &["host.block.get"]);
    }
    let no_method = harness.load_current_grant(MODULE_ID);

    let error = status(&mut harness.connection, &harness.authority, &no_method, "msg-1")
        .expect_err("status must require the host.ingress.submit method");
    assert_eq!(error.code(), HostIngressErrorCode::NotAuthorized);
}

#[test]
fn rotated_authority_is_rejected_and_never_discloses() {
    let mut harness = Harness::new("rotated");
    let incoming = request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());

    let rotated = {
        let mut store = SqliteCoreStore::new(&mut harness.connection).unwrap();
        configured(&mut store, "rotated-v2", 2, "g4-ingress-connection-2", OTHER_WORKER_EPOCH);
        store.rotate_host_connection(&harness.authority).unwrap()
    };
    assert_ne!(rotated, harness.authority);

    let error = submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming)
        .expect_err("a rotated authority must be rejected");
    assert_eq!(error.code(), HostIngressErrorCode::NotAuthorized);
    assert_eq!(mapping_rows(&mut harness.connection), 1);

    // The new principal cannot read the old principal's mapping in its own
    // single transaction; never another owner's payload.
    let error = status(&mut harness.connection, &rotated, &harness.grant, "msg-1")
        .expect_err("the new principal must not disclose the old principal's payload");
    assert_eq!(error.code(), HostIngressErrorCode::NotAuthorized);
}

#[test]
fn cross_module_sources_never_disclose_each_other() {
    let mut harness = Harness::new("cross-source");
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let (mapping_a, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());

    let incoming_b = request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let (mapping_b, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant_b, &incoming_b).unwrap());
    assert_ne!(mapping_a.ingress_key, mapping_b.ingress_key);
    assert_eq!(mapping_rows(&mut harness.connection), 2);

    match status(&mut harness.connection, &harness.authority, &harness.grant_b, "msg-1").unwrap() {
        HostIngressStatus::Committed(seen) => {
            assert_eq!(seen.module_id, MODULE_B_ID);
            // Module B sees only its own identity namespace and Block, never
            // module A's mapping or effect.
            assert_ne!(seen.ingress_key, mapping_a.ingress_key);
            assert_ne!(seen.block_id, mapping_a.block_id);
            assert_ne!(seen.command_id, mapping_a.command_id);
        }
        HostIngressStatus::Absent => panic!("module B committed the same external id"),
    }
}

// ---------------------------------------------------------------------------
// Grant-pinned graph validation: digest/revision, admission, exact/opposite
// targets
// ---------------------------------------------------------------------------

#[test]
fn graph_digest_mismatch_with_grant_is_rejected() {
    let mut harness = Harness::new("graph-digest");
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));

    // The installed graph revision matches the grant's, but the grant pins a
    // digest of a different graph: the submit is refused before mutation.
    {
        let mut store = SqliteCoreStore::new(&mut harness.connection).unwrap();
        install_grant(
            &mut store,
            &harness.authority,
            MODULE_ID,
            1,
            1,
            &digest(&json!({"other": 1})),
            &["host.ingress.submit"],
        );
    }
    let wrong_digest_grant = harness.load_current_grant(MODULE_ID);
    let error = submit(&mut harness.connection, &harness.authority, &wrong_digest_grant, &incoming)
        .expect_err("a grant pinning a different graph digest must be refused");
    assert_eq!(error.code(), HostIngressErrorCode::Stale);
    assert_eq!(mapping_rows(&mut harness.connection), 0);
}

#[test]
fn graph_revision_mismatch_with_grant_is_rejected() {
    let mut harness = Harness::new("graph-revision");
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let body_v2 = graph(&[MODULE_ID, MODULE_B_ID], &[]);
    {
        let mut store = SqliteCoreStore::new(&mut harness.connection).unwrap();
        install_graph(&mut store, "graph-v2", 2, &body_v2);
    }
    let error = submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming)
        .expect_err("a grant pinning the old graph revision must be refused");
    assert_eq!(error.code(), HostIngressErrorCode::Stale);
    assert_eq!(mapping_rows(&mut harness.connection), 0);
}

#[test]
fn module_not_admitted_in_pinned_graph_is_rejected() {
    let mut harness = Harness::new("not-admitted");
    // Graph revision 2 drops the receiver from descriptors while keeping it
    // as an output producer; a grant pinning revision 2 must refuse.
    let body_v2 = graph(&[MODULE_B_ID], &[]);
    {
        let mut store = SqliteCoreStore::new(&mut harness.connection).unwrap();
        install_graph(&mut store, "graph-no-receiver", 2, &body_v2);
        install_grant(
            &mut store,
            &harness.authority,
            MODULE_ID,
            1,
            2,
            &digest(&body_v2),
            &["host.ingress.submit"],
        );
    }
    let grant_v2 = harness.load_current_grant(MODULE_ID);
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let error = submit(&mut harness.connection, &harness.authority, &grant_v2, &incoming)
        .expect_err("a module not admitted in the pinned graph must be refused");
    assert_eq!(error.code(), HostIngressErrorCode::TargetNotAuthorized);
    assert_eq!(mapping_rows(&mut harness.connection), 0);
}

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
fn opposite_input_target_page_is_rejected() {
    // The module is a graph producer of page-a AND declares page-a as one of
    // its input (consumer) pages: ingress to that page is opposite-direction
    // and must be rejected even though it is an output page.
    let mut harness = Harness::new_with_inputs("opposite", &["page-a"]);
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let error = submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming)
        .expect_err("an input (opposite) target Page must be rejected");
    assert_eq!(error.code(), HostIngressErrorCode::TargetNotAuthorized);
    assert_eq!(mapping_rows(&mut harness.connection), 0);
}

// ---------------------------------------------------------------------------
// Non-lexical first-occurrence target order (end-to-end)
// ---------------------------------------------------------------------------

#[test]
fn non_lexical_target_order_commits_reconciles_replays_and_conflicts() {
    let mut harness = Harness::new("nonlexical");
    // page-b before page-a is valid: first-occurrence order is the contract,
    // never a lexicographic re-sort.
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-b", "page-a", "page-b"], json!({"kind":"text","text":"hello"}));
    let (mapping, idempotent) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());
    assert!(!idempotent);
    assert_eq!(
        mapping.target_page_ids,
        vec!["page-b".to_string(), "page-a".to_string()],
        "duplicates collapse in first-occurrence order without reordering"
    );
    assert_eq!(mapping.deliveries.len(), 2);
    assert_eq!(mapping.deliveries[0].page_id, "page-b");
    assert_eq!(mapping.deliveries[1].page_id, "page-a");

    // status and replay reconcile the identical mapping.
    match status(&mut harness.connection, &harness.authority, &harness.grant, "msg-1").unwrap() {
        HostIngressStatus::Committed(seen) => {
            assert_eq!(seen.target_page_ids, mapping.target_page_ids);
            assert_eq!(seen.deliveries, mapping.deliveries);
        }
        HostIngressStatus::Absent => panic!("nonlexical commit must reconcile"),
    }
    let (replayed, idempotent) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());
    assert!(idempotent);
    assert_eq!(replayed, mapping);
    assert_ne!(replayed.ingress_id, String::new());

    // Reordering targets remains a digest conflict as specified.
    let reordered =
        request("msg-1", HostIngressKind::Message, None, &["page-a", "page-b"], json!({"kind":"text","text":"hello"}));
    assert!(matches!(
        submit(&mut harness.connection, &harness.authority, &harness.grant, &reordered).unwrap(),
        HostIngressSubmitOutcome::Conflict { .. }
    ));
    assert_eq!(mapping_rows(&mut harness.connection), 1);
}

// ---------------------------------------------------------------------------
// Cross-Extension descriptor binding and identity-link tamper
// ---------------------------------------------------------------------------

#[test]
fn live_grant_under_another_extension_cannot_reuse_module_outputs_even_with_identical_descriptor() {
    let body = graph(&[MODULE_ID, MODULE_B_ID], &[]);
    let mut harness = Harness::new("cross-extension");
    // A second Extension holds a live grant for the SAME module id and pins
    // the byte-IDENTICAL descriptor digest and graph as the owning
    // Extension. It must still be rejected: graph admission names the
    // authoritative Extension owner, and the grant's Extension is not it.
    {
        let mut store = SqliteCoreStore::new(&mut harness.connection).unwrap();
        store
            .install_host_capability_grant(
                &harness.authority,
                "org.dolly.different-extension",
                MODULE_ID,
                1,
                1,
                &digest(&descriptor(MODULE_ID)),
                1,
                &digest(&json!({"manifest": 1})),
                1,
                &digest(&body),
                &["host.ingress.submit"],
            )
            .unwrap();
    }
    let other_grant = SqliteCoreStore::new(&mut harness.connection)
        .unwrap()
        .current_host_capability_grant(&harness.authority, "org.dolly.different-extension", MODULE_ID)
        .unwrap()
        .unwrap();
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let error = submit(&mut harness.connection, &harness.authority, &other_grant, &incoming)
        .expect_err("a grant under another Extension must not reuse this Module's outputs");
    assert_eq!(error.code(), HostIngressErrorCode::NotAuthorized);
    assert_eq!(mapping_rows(&mut harness.connection), 0);

    // The owning Extension's grant still works.
    let (mapping, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());
    assert_eq!(mapping.extension_id, EXTENSION_ID);

    // Anti-spoof: a graph that names an Extension owner with NO Host grant
    // for the module's descriptor in that graph is rejected even by the
    // otherwise-owning Extension, because the owner is derived from the
    // Host-owned grant context, never from the graph input.
    let mut spoofed_body = body.clone();
    spoofed_body["descriptors"][MODULE_ID]["owner_extension_id"] = json!("org.dolly.mystery-extension");
    {
        let mut store = SqliteCoreStore::new(&mut harness.connection).unwrap();
        install_graph(&mut store, "spoofed-graph", 2, &spoofed_body);
        install_grant(
            &mut store,
            &harness.authority,
            MODULE_ID,
            1,
            2,
            &digest(&spoofed_body),
            &["host.ingress.submit"],
        );
    }
    let grant_v2 = harness.load_current_grant(MODULE_ID);
    // A fresh external event id keeps the submission on the commit path so
    // graph admission is actually reached (a replayed key would conflict
    // first by design).
    let fresh = request("msg-spoof", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"spoof"}));
    let error = submit(&mut harness.connection, &harness.authority, &grant_v2, &fresh)
        .expect_err("a graph naming a non-granted Extension owner must be rejected");
    assert_eq!(error.code(), HostIngressErrorCode::NotAuthorized);
}

#[test]
fn substituted_consistent_command_identity_is_rejected() {
    let mut harness = Harness::new("substituted");
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let (mapping, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());

    // A self-consistent substitution: swap BOTH the mapping command id and
    // the Core operation command id to a different minted id string. The
    // mapping's ingress id no longer matches, so the chain must fail closed
    // (never Committed, never Absent).
    let forged = format!("host-ingress-{}-0198ab31-6c44-7e8a-b2bb-00000000dead", mapping.ingress_key);
    harness
        .connection
        .execute(
            "UPDATE host_ingress_mappings SET command_id = ?1 WHERE ingress_key = ?2",
            rusqlite::params![&forged, &mapping.ingress_key],
        )
        .unwrap();
    harness
        .connection
        .execute(
            "UPDATE core_operations SET command_id = ?1 WHERE command_id = ?2",
            rusqlite::params![&forged, &mapping.command_id],
        )
        .unwrap();
    let error = status(&mut harness.connection, &harness.authority, &harness.grant, "msg-1")
        .expect_err("a substituted command identity must fail closed");
    assert_eq!(error.code(), HostIngressErrorCode::Corrupt);
}

#[test]
fn fully_canonical_self_consistent_substitution_reaches_the_immutable_effect_link() {
    let mut harness = Harness::new("canonical-substitution");
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let (mapping, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());

    // Reconstruct the exact committed command and read the real stored
    // transition so the forged records are canonically self-consistent:
    // matching request digest, transition digest, state hash/projection, the
    // single IngressCommitted event, reply, outcome, error, and safety stop.
    fn command_for(
        ingress_key: &str,
        operation_digest: &str,
        block_id: &str,
        pages: &[String],
        payload: &CanonicalJsonValue,
        command_id: &str,
    ) -> dolly_core_reducer::CoreCommand {
        dolly_core_reducer::CoreCommand::Ingress(dolly_core_reducer::IngressCommand {
            command_id: command_id.to_owned(),
            runtime_source: "org.dolly.channel#receiver#0198ab31-6c44-7e8a-b2bb-000000000110".into(),
            ingress_key: ingress_key.to_owned(),
            operation_digest: operation_digest.to_owned(),
            block_id: block_id.to_owned(),
            block: serde_json::to_value(payload).expect("payload serializes"),
            pages: pages.to_vec(),
        })
    }
    let input = dolly_core_reducer::EnvironmentInput {
        now: "2026-08-28T00:00:00.000000Z".into(),
        ..Default::default()
    };
    let real_transition_jcs: Vec<u8> = harness
        .connection
        .query_row(
            "SELECT transition_jcs FROM core_operations WHERE command_id = ?1",
            [&mapping.command_id],
            |row| row.get(0),
        )
        .unwrap();
    let transition_value: serde_json::Value = deserialize_core_json(
        &real_transition_jcs,
        ParseLimits::semantic(64).unwrap(),
    )
    .unwrap();
    let real_transition: dolly_core_reducer::Transition =
        serde_json::from_value(transition_value).unwrap();

    // Forge new minted identities and a new command/event, keeping every
    // digest-protected anchor (snapshot state, block, ingress record)
    // identical so the forged records are canonically self-consistent.
    let forged_ingress_id = "0198ab31-6c44-7e8a-b2bb-00000000abcd";
    let forged_command_id = format!("host-ingress-{}-{forged_ingress_id}", mapping.ingress_key);
    let forged_command = command_for(
        &mapping.ingress_key,
        &mapping.operation_digest,
        &mapping.block_id,
        &mapping.target_page_ids,
        &mapping.payload,
        &forged_command_id,
    );
    let forged_request_digest = canonicalize(&json!({
        "command": serde_json::to_value(&forged_command).unwrap(),
        "input": serde_json::to_value(&input).unwrap(),
    }))
    .unwrap()
    .1
    .to_canonical_string();

    let mut forged_transition = real_transition.clone();
    forged_transition.events[0].command_id = forged_command_id.clone();
    let (forged_transition_jcs, forged_transition_digest) = {
        let value = serde_json::to_value(&forged_transition).unwrap();
        let (bytes, digest) = canonicalize(&value).unwrap();
        (bytes.into_vec(), digest.to_canonical_string())
    };

    let mut forged_mapping = mapping.clone();
    forged_mapping.ingress_id = forged_ingress_id.into();
    forged_mapping.command_id = forged_command_id.clone();
    let (forged_mapping_jcs, forged_mapping_digest) = {
        let value = serde_json::to_value(&forged_mapping).unwrap();
        let (bytes, digest) = canonicalize(&value).unwrap();
        (bytes.into_vec(), digest.to_canonical_string())
    };

    // Rewrite the mutable rows consistently: canonical mapping bytes/digest,
    // indexed ingress/command ids, operation request/transition digests and
    // transition bytes, and the transition event command id.
    harness
        .connection
        .execute(
            "UPDATE host_ingress_mappings
             SET ingress_id = ?2, command_id = ?3, mapping_jcs = ?4, mapping_digest = ?5
             WHERE ingress_key = ?1",
            rusqlite::params![
                &mapping.ingress_key,
                forged_ingress_id,
                &forged_command_id,
                &forged_mapping_jcs,
                &forged_mapping_digest,
            ],
        )
        .unwrap();
    harness
        .connection
        .execute(
            "UPDATE core_operations
             SET command_id = ?2, request_digest = ?3, transition_digest = ?4, transition_jcs = ?5
             WHERE command_id = ?1",
            rusqlite::params![
                &mapping.command_id,
                &forged_command_id,
                &forged_request_digest,
                &forged_transition_digest,
                &forged_transition_jcs,
            ],
        )
        .unwrap();

    // Every mutable row is now internally consistent; the ONLY immutable
    // anchors left are the journal entry and the hash-protected Core state.
    // The forged event has no journal entry, so the verifier must fail at the
    // effect-link stage with Corrupt — never Absent, never Committed.
    let error = status(&mut harness.connection, &harness.authority, &harness.grant, "msg-1")
        .expect_err("a fully self-consistent substitution must corrupt at the immutable effect link");
    assert_eq!(error.code(), HostIngressErrorCode::Corrupt);

    // The authoritative journal entry (immutable via the hash-protected Core
    // state) still records the REAL command id, never the forged one.
    let journal_contains_real: i64 = harness
        .connection
        .query_row(
            "SELECT COUNT(*) FROM core_journal WHERE command_id = ?1",
            [&mapping.command_id],
            |row| row.get(0),
        )
        .unwrap();
    let journal_contains_forged: i64 = harness
        .connection
        .query_row(
            "SELECT COUNT(*) FROM core_journal WHERE event_digest = ?1",
            [&forged_mapping_digest],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(journal_contains_real, 1, "journal keeps the real command id");
    assert_eq!(journal_contains_forged, 0, "the forged event has no journal entry");
}

// ---------------------------------------------------------------------------
// Lifecycle reference validation
// ---------------------------------------------------------------------------

#[test]
fn edit_and_delete_reference_a_committed_event_by_the_same_principal() {
    let mut harness = Harness::new("lifecycle");
    let msg =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &msg).unwrap());

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
// Real RFC-9562 UUIDv7 allocation
// ---------------------------------------------------------------------------

#[test]
fn minted_identities_are_real_uuidv7_and_replay_surfaces_the_stored_pair() {
    let mut harness = Harness::new("uuid");
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let (first, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());

    for bytes in [first.ingress_id.as_bytes(), first.block_id.as_bytes()] {
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

    let second_request =
        request("msg-2", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"bye"}));
    let (second, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &second_request).unwrap());
    assert_ne!(first.ingress_id, second.ingress_id);
    assert_ne!(first.block_id, second.block_id);

    let (replayed, idempotent) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());
    assert!(idempotent);
    assert_eq!(replayed.ingress_id, first.ingress_id);
    assert_eq!(replayed.block_id, first.block_id);
}

// ---------------------------------------------------------------------------
// Absence, cross-verification, and fail-closed tamper/loss detection
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
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
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
fn deleted_mapping_rows_plus_lost_operation_never_read_as_absent_while_effect_remains() {
    let mut harness = Harness::new("dual-delete");
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let (mapping, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());

    // Delete BOTH the mapping row and its Core operation row; the reducer
    // ingress record and Block remain in Core state, so this must fail closed
    // as corrupt, never read as Absent.
    harness
        .connection
        .execute("DELETE FROM host_ingress_mappings WHERE ingress_key = ?1", [&mapping.ingress_key])
        .unwrap();
    harness
        .connection
        .execute("DELETE FROM core_operations WHERE command_id = ?1", [&mapping.command_id])
        .unwrap();
    let error = status(&mut harness.connection, &harness.authority, &harness.grant, "msg-1")
        .expect_err("a surviving effect with deleted mapping+operation must fail closed");
    assert_eq!(error.code(), HostIngressErrorCode::Corrupt);
}

#[test]
fn deleted_mapping_row_with_live_operation_never_reads_as_absent() {
    let mut harness = Harness::new("deleted-mapping");
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let (mapping, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());
    harness
        .connection
        .execute("DELETE FROM host_ingress_mappings WHERE ingress_key = ?1", [&mapping.ingress_key])
        .unwrap();

    let error = status(&mut harness.connection, &harness.authority, &harness.grant, "msg-1")
        .expect_err("a deleted mapping with a live Core operation must fail closed");
    assert_eq!(error.code(), HostIngressErrorCode::Corrupt);
}

#[test]
fn replay_after_effect_loss_fails_closed_instead_of_committed() {
    let mut harness = Harness::new("replay-after-loss");
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let (mapping, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());
    harness
        .connection
        .execute("DELETE FROM core_operations WHERE command_id = ?1", [&mapping.command_id])
        .unwrap();

    // A same-key/same-digest replay must NOT return the mapping as committed:
    // the shared verification fails closed.
    let error = submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming)
        .expect_err("replay after effect loss must fail closed");
    assert_eq!(error.code(), HostIngressErrorCode::Corrupt);
}

#[test]
fn tampered_transition_fails_closed() {
    let mut harness = Harness::new("tamper-transition");
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    let (mapping, _) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());
    harness
        .connection
        .execute(
            "UPDATE core_operations SET transition_jcs = X'7b7d' WHERE command_id = ?1",
            [&mapping.command_id],
        )
        .unwrap();
    let error = status(&mut harness.connection, &harness.authority, &harness.grant, "msg-1")
        .expect_err("a tampered transition must fail closed");
    assert_eq!(error.code(), HostIngressErrorCode::Corrupt);
}

#[test]
fn tampered_premise_bytes_fail_closed() {
    let mut harness = Harness::new("tamper-premise");
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
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
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
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
// Real rollback and exact recovery
// ---------------------------------------------------------------------------

/// Drive the reducer into the committed RecoveryRequired instance mode, then
/// verify a real submit is rolled back at the Core effect stage and recovery
/// restores a clean replay.
#[test]
fn real_core_refusal_rolls_back_the_submit_and_recovery_commits_exactly() {
    let mut harness = Harness::new("real-rollback");
    let incoming =
        request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"hello"}));
    committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming).unwrap());

    // Enter RecoveryRequired durably through the accepted Recover command
    // with a failed ordered verification (real reducer state transition).
    let recovered_page_seq = core_state(&mut harness.connection).next_page_seq;
    let refused_recovery = {
        let mut store = SqliteCoreStore::new(&mut harness.connection).unwrap();
        store
            .transact(
                &CoreCommand::Recover(RecoverCommand {
                    command_id: "recover-refusal".into(),
                    persisted_next_page_seq: recovered_page_seq,
                }),
                &EnvironmentInput {
                    now: "2026-08-28T00:00:00.000000Z".into(),
                    recovery_verification: Some(RecoveryVerification {
                        ordered_checks_complete: true,
                        invariants_valid: false,
                        persisted_values_valid: false,
                        process_fences_valid: false,
                        staged_results_valid: false,
                        failure_reason: Some("test-injected refusal".into()),
                    }),
                    ..Default::default()
                },
            )
            .unwrap()
    };
    assert_eq!(refused_recovery.outcome, TransitionOutcome::Committed);
    assert_eq!(
        core_state(&mut harness.connection).mode,
        dolly_core_reducer::InstanceMode::RecoveryRequired
    );

    // A real submit now reaches the reducer inside its transaction, the
    // reducer refuses (RECOVERY_REQUIRED) after the premise row was inserted,
    // and the whole transaction rolls back: zero partial rows, no new effect,
    // and the status for the new event is authoritative Absent.
    let incoming2 =
        request("msg-2", HostIngressKind::Message, None, &["page-a"], json!({"kind":"text","text":"after-crash"}));
    let error = submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming2)
        .expect_err("core refusal must surface as NotReady");
    assert_eq!(error.code(), HostIngressErrorCode::NotReady);
    assert_eq!(mapping_rows(&mut harness.connection), 1, "zero partial mapping after rollback");
    assert!(matches!(
        status(&mut harness.connection, &harness.authority, &harness.grant, "msg-2").unwrap(),
        HostIngressStatus::Absent
    ));

    // Recover (valid verification), then the byte-identical replay commits
    // exactly once as a fresh commit — no duplicate, no conflict.
    let recovered_page_seq = core_state(&mut harness.connection).next_page_seq;
    {
        let mut store = SqliteCoreStore::new(&mut harness.connection).unwrap();
        let recovered = store
            .transact(
                &CoreCommand::Recover(RecoverCommand {
                    command_id: "recover-ok".into(),
                    persisted_next_page_seq: recovered_page_seq,
                }),
                &EnvironmentInput {
                    now: "2026-08-28T00:00:00.000000Z".into(),
                    recovery_verification: Some(RecoveryVerification {
                        ordered_checks_complete: true,
                        invariants_valid: true,
                        persisted_values_valid: true,
                        process_fences_valid: true,
                        staged_results_valid: true,
                        failure_reason: None,
                    }),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(recovered.outcome, TransitionOutcome::Committed);
    }
    let (mapping, idempotent) = committed(submit(&mut harness.connection, &harness.authority, &harness.grant, &incoming2).unwrap());
    assert!(!idempotent, "after recovery the replay is a fresh commit");
    assert_eq!(mapping_rows(&mut harness.connection), 2);
    match status(&mut harness.connection, &harness.authority, &harness.grant, "msg-2").unwrap() {
        HostIngressStatus::Committed(seen) => assert_eq!(seen.ingress_key, mapping.ingress_key),
        HostIngressStatus::Absent => panic!("replayed commit must be visible"),
    }
}
