//! Shared G4-C receiver test harness: a real Runtime connection (Core engine,
//! Host connection, capability grants, durable Host ingress slice) plus a
//! durable module-scoped Channel store, and fault-injecting wrappers for the
//! accepted seams.

#![allow(dead_code)]

use std::str::FromStr;

use dolly_channel::{
    AuthenticatedChannelEvent, ChannelEventContent, ChannelLedger, ChannelStore, ChannelStoreOwner,
    EventKind, SqliteChannelStore, VirtualClock, ids,
};
use dolly_core_domain::{
    HostIngressError, HostIngressErrorCode, HostIngressStatus, HostIngressStatusRequest,
    HostIngressSubmitOutcome, HostIngressSubmitRequest, Timestamp,
};
use dolly_core_reducer::{
    CoreCommand, EnvironmentInput, InstallConfigCommand, InstallGraphCommand, TransitionOutcome,
};
use dolly_storage::{
    HostCapabilityGrant, HostConnectionAuthority, HostIngress, SqliteCoreStore,
    host_ingress::create_host_ingress_schema,
};
use rusqlite::Connection;
use serde_json::{Value, json};

pub const EXTENSION_ID: &str = "org.dolly.channel";
pub const MODULE_ID: &str = "receiver";
pub const MODULE_OTHER: &str = "receiver-b";
pub const WORKER_EPOCH: &str = "0198ab31-6c44-7e8a-b2bb-000000000110";
pub const CONNECTION_ID: &str = "g4-flow-connection";
pub const CHANNEL_NOW: &str = "2026-08-28T00:00:00.000000Z";

pub fn digest(value: &Value) -> String {
    dolly_canonical_json::canonicalize(value)
        .unwrap()
        .1
        .to_canonical_string()
}

pub fn input() -> EnvironmentInput {
    EnvironmentInput {
        now: CHANNEL_NOW.into(),
        ..Default::default()
    }
}

pub fn descriptor(module_id: &str) -> Value {
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

pub fn descriptor_digest(module_id: &str) -> String {
    digest(&descriptor(module_id))
}

/// The installed graph. `receiver_input_pages` lets a test declare input-only
/// (opposite-direction) pages for the receiving module.
pub fn graph(module_ids: &[&str], receiver_input_pages: &[&str]) -> Value {
    graph_with_outputs(module_ids, receiver_input_pages, &["page-a", "page-b"])
}

/// The installed graph with explicit output pages for the receiver module, so
/// a test can declare an input-only (opposite-direction) target Page.
pub fn graph_with_outputs(
    module_ids: &[&str],
    receiver_input_pages: &[&str],
    receiver_outputs: &[&str],
) -> Value {
    let mut output_pages = serde_json::Map::new();
    for module_id in module_ids {
        let pages: Vec<String> = if *module_id == MODULE_ID {
            receiver_outputs.iter().map(|s| s.to_string()).collect()
        } else {
            vec!["page-a".to_string(), "page-b".to_string()]
        };
        output_pages.insert((*module_id).to_owned(), json!(pages));
    }
    let mut descriptors = serde_json::Map::new();
    for module_id in module_ids {
        descriptors.insert(
            (*module_id).to_owned(),
            json!({
                "module_id": module_id,
                "descriptor_revision": 1,
                "source_descriptor_digest": descriptor_digest(module_id),
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

pub fn configured(store: &mut SqliteCoreStore<'_>, mark: &str, revision: i64) {
    let effective_config = json!({
        "execution_timeout_ms": 120000,
        "lease_grace_ms": 30000,
        "fencing_grace_ms": 5000,
        "extension_connection_id": CONNECTION_ID,
        "worker_epoch": WORKER_EPOCH,
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

pub fn install_graph(store: &mut SqliteCoreStore<'_>, mark: &str, revision: i64, body: &Value) {
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

#[allow(clippy::too_many_arguments)]
pub fn install_grant(
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
            &descriptor_digest(module_id),
            1,
            &digest(&json!({"manifest": 1})),
            graph_revision,
            graph_digest,
            methods,
        )
        .unwrap();
}

/// A runtime-side harness: one authoritative Runtime connection with the Core
/// engine, a configured Host connection, an installed graph, capability
/// grants for the Channel extension, and the durable Host ingress schema.
pub struct RuntimeHarness {
    pub connection: Connection,
    pub authority: HostConnectionAuthority,
    pub grant: HostCapabilityGrant,
    pub grant_other: HostCapabilityGrant,
    /// Graph digest installed in Core and pinned by every grant.
    pub graph_digest: String,
}

impl RuntimeHarness {
    pub fn new(mark: &str) -> Self {
        Self::new_with_inputs(mark, &[])
    }

    /// Build a harness whose installed graph declares `receiver_input_pages`
    /// as input-only (opposite-direction) pages of the receiving module.
    pub fn new_with_inputs(mark: &str, receiver_input_pages: &[&str]) -> Self {
        let body = graph(&[MODULE_ID, MODULE_OTHER], receiver_input_pages);
        let graph_digest = digest(&body);
        let mut connection = Connection::open_in_memory().unwrap();
        let authority = {
            let mut store = SqliteCoreStore::new(&mut connection).unwrap();
            configured(&mut store, mark, 1);
            install_graph(&mut store, mark, 1, &body);
            let authority = store.bootstrap_host_connection().unwrap();
            install_grant(
                &mut store,
                &authority,
                MODULE_ID,
                1,
                1,
                &graph_digest,
                &["host.ingress.submit"],
            );
            install_grant(
                &mut store,
                &authority,
                MODULE_OTHER,
                1,
                1,
                &graph_digest,
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
        let grant_other = SqliteCoreStore::new(&mut connection)
            .unwrap()
            .current_host_capability_grant(&authority, EXTENSION_ID, MODULE_OTHER)
            .unwrap()
            .unwrap();
        Self {
            connection,
            authority,
            grant,
            grant_other,
            graph_digest,
        }
    }

    /// Build a harness whose graph declares `receiver_outputs` as the receiver
    /// module's output pages and `receiver_input_pages` as its input pages
    /// (for opposite-direction target rejection tests).
    pub fn new_with_outputs(
        mark: &str,
        receiver_outputs: &[&str],
        receiver_input_pages: &[&str],
    ) -> Self {
        let body = graph_with_outputs(
            &[MODULE_ID, MODULE_OTHER],
            receiver_input_pages,
            receiver_outputs,
        );
        let graph_digest = digest(&body);
        let mut connection = Connection::open_in_memory().unwrap();
        let authority = {
            let mut store = SqliteCoreStore::new(&mut connection).unwrap();
            configured(&mut store, mark, 1);
            install_graph(&mut store, mark, 1, &body);
            let authority = store.bootstrap_host_connection().unwrap();
            install_grant(
                &mut store,
                &authority,
                MODULE_ID,
                1,
                1,
                &graph_digest,
                &["host.ingress.submit"],
            );
            install_grant(
                &mut store,
                &authority,
                MODULE_OTHER,
                1,
                1,
                &graph_digest,
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
        let grant_other = SqliteCoreStore::new(&mut connection)
            .unwrap()
            .current_host_capability_grant(&authority, EXTENSION_ID, MODULE_OTHER)
            .unwrap()
            .unwrap();
        Self {
            connection,
            authority,
            grant,
            grant_other,
            graph_digest,
        }
    }

    pub fn revoke_grant(&mut self, authority: &HostConnectionAuthority, module_id: &str) {
        let mut store = SqliteCoreStore::new(&mut self.connection).unwrap();
        store
            .revoke_host_capability_grant(authority, EXTENSION_ID, module_id)
            .unwrap();
    }

    /// A mutable Core store over the harness connection for snapshot reads.
    pub fn core_store(&mut self) -> SqliteCoreStore<'_> {
        SqliteCoreStore::new(&mut self.connection).unwrap()
    }

    pub fn mapping_count(&self) -> i64 {
        self.connection
            .query_row("SELECT COUNT(*) FROM host_ingress_mappings", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    /// Genuine `host.ingress.submit` operations that reached Core (a
    /// status-first reconcile never adds one; an idempotent replay reuses the
    /// stored mapping without one).
    pub fn operation_count(&self) -> i64 {
        self.connection
            .query_row(
                "SELECT COUNT(*) FROM core_operations WHERE command_id LIKE 'host-ingress-%'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    }
}

pub fn store_owner(
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
) -> ChannelStoreOwner {
    ChannelStoreOwner {
        extension_id: grant.extension_id().to_string(),
        module_id: grant.module_id().to_string(),
        account: ids::channel_account(
            authority.extension_connection_id(),
            grant.extension_id(),
            grant.module_id(),
            authority.worker_epoch().as_str(),
        ),
    }
}

pub fn channel_config() -> dolly_channel::ChannelConfig {
    dolly_channel::ChannelConfigBuilder::new("web", "account-a", MODULE_ID, 1)
        .target_pages(&["page-a"])
        .build()
}

pub fn channel_clock() -> VirtualClock {
    VirtualClock::at(Timestamp::from_str(CHANNEL_NOW).unwrap_or_else(|_| panic!("timestamp")))
}

/// A sealed, already-authenticated event under the given authority/grant.
pub fn sealed_event(
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
    conversation: &str,
    message_id: &str,
    text: &str,
) -> AuthenticatedChannelEvent {
    AuthenticatedChannelEvent::new(
        authority,
        grant,
        content_event(conversation, message_id, text),
    )
    .expect("sealed event")
}

fn content_event(conversation: &str, message_id: &str, text: &str) -> ChannelEventContent {
    ChannelEventContent {
        channel_id: "web-primary".to_string(),
        transport: "web".to_string(),
        external_conversation_id: conversation.to_string(),
        external_message_id: message_id.to_string(),
        sender_class: "user".to_string(),
        sender_id: "sender-1".to_string(),
        text: text.to_string(),
        received_at: Timestamp::from_str(CHANNEL_NOW).unwrap_or_else(|_| panic!("timestamp")),
        event_kind: EventKind::Message,
        references_external_message_id: None,
    }
}

/// A sealed edit event under the given authority/grant.
pub fn sealed_edit_event(
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
    message_id: &str,
    references: &str,
    text: &str,
) -> AuthenticatedChannelEvent {
    let mut content = content_event("conv-1", message_id, text);
    content.event_kind = EventKind::Edit;
    content.references_external_message_id = Some(references.to_string());
    AuthenticatedChannelEvent::new(authority, grant, content).expect("sealed edit event")
}

/// Fault-injecting `HostIngress` wrapper over a real store: drops submit or
/// status responses, or commits durably and then loses the response, exactly
/// like the accepted `MemCoreIngress` double but over the real durable slice.
pub struct FaultyHostIngress<H: HostIngress> {
    inner: H,
    /// Remaining submits whose response is lost BEFORE reaching the store.
    pub fail_submits: u64,
    /// Remaining submits that COMMIT durably but whose response is lost.
    pub commit_then_drop_submits: u64,
    /// Remaining statuses whose response is lost.
    pub fail_statuses: u64,
    pub submit_calls: u64,
    pub status_calls: u64,
}

impl<H: HostIngress> FaultyHostIngress<H> {
    pub fn new(inner: H) -> Self {
        Self {
            inner,
            fail_submits: 0,
            commit_then_drop_submits: 0,
            fail_statuses: 0,
            submit_calls: 0,
            status_calls: 0,
        }
    }
}

impl<H: HostIngress> HostIngress for FaultyHostIngress<H> {
    fn submit(
        &mut self,
        authority: &HostConnectionAuthority,
        grant: &HostCapabilityGrant,
        request: &HostIngressSubmitRequest,
    ) -> Result<HostIngressSubmitOutcome, HostIngressError> {
        self.submit_calls += 1;
        if self.fail_submits > 0 {
            self.fail_submits -= 1;
            return Err(HostIngressError::new(
                HostIngressErrorCode::Busy,
                "injected lost submit",
            ));
        }
        if self.commit_then_drop_submits > 0 {
            self.commit_then_drop_submits -= 1;
            // The submit commits durably inside the store; only the response
            // is lost, so the durable outcome is UNKNOWN to the caller.
            match self.inner.submit(authority, grant, request) {
                Ok(HostIngressSubmitOutcome::Committed { .. }) => Err(HostIngressError::new(
                    HostIngressErrorCode::Busy,
                    "injected lost submit response after commit",
                )),
                outcome => outcome,
            }
        } else {
            self.inner.submit(authority, grant, request)
        }
    }

    fn status(
        &mut self,
        authority: &HostConnectionAuthority,
        grant: &HostCapabilityGrant,
        request: &HostIngressStatusRequest,
    ) -> Result<HostIngressStatus, HostIngressError> {
        self.status_calls += 1;
        if self.fail_statuses > 0 {
            self.fail_statuses -= 1;
            return Err(HostIngressError::new(
                HostIngressErrorCode::Busy,
                "injected lost status",
            ));
        }
        self.inner.status(authority, grant, request)
    }
}

/// A `ChannelLedgerStore` + `ChannelIntentStore` over a real
/// `SqliteChannelStore` with injectable persistence failures, used to force a
/// post-Host-commit / pre-final-save crash window.
pub struct FailpointChannelStore<'connection> {
    inner: SqliteChannelStore<'connection>,
    /// Remaining Channel ledger-document saves to fail.
    pub fail_doc_saves: u64,
    /// Remaining prepared-intent writes to fail.
    pub fail_prepared_writes: u64,
}

impl<'connection> FailpointChannelStore<'connection> {
    pub fn new(inner: SqliteChannelStore<'connection>) -> Self {
        Self {
            inner,
            fail_doc_saves: 0,
            fail_prepared_writes: 0,
        }
    }
}

impl ChannelStore for FailpointChannelStore<'_> {
    fn load(&mut self) -> Result<ChannelLedger, dolly_channel::ChannelError> {
        self.inner.load()
    }

    fn save(&mut self, ledger: &ChannelLedger) -> Result<(), dolly_channel::ChannelError> {
        if self.fail_doc_saves > 0 {
            self.fail_doc_saves -= 1;
            return Err(dolly_channel::ChannelError::new(
                "CHANNEL_INTERNAL",
                false,
                dolly_channel::ChannelOutcome::NotApplied,
                "injected ledger-document save failure",
            ));
        }
        self.inner.save(ledger)
    }

    fn find_intent(
        &mut self,
        intent_key: &str,
    ) -> Result<Option<dolly_channel::ChannelIntent>, dolly_channel::ChannelError> {
        self.inner.find_intent(intent_key)
    }

    fn write_prepared(
        &mut self,
        intent: &dolly_channel::ChannelIntent,
    ) -> Result<(), dolly_channel::ChannelError> {
        if self.fail_prepared_writes > 0 {
            self.fail_prepared_writes -= 1;
            return Err(dolly_channel::ChannelError::new(
                "CHANNEL_INTERNAL",
                false,
                dolly_channel::ChannelOutcome::NotApplied,
                "injected prepared-intent write failure",
            ));
        }
        self.inner.write_prepared(intent)
    }

    fn settle_accepted(
        &mut self,
        intent_key: &str,
        block_id: &str,
    ) -> Result<(), dolly_channel::ChannelError> {
        self.inner.settle_accepted(intent_key, block_id)
    }

    fn mark_rejected(
        &mut self,
        intent_key: &str,
        code: &str,
    ) -> Result<(), dolly_channel::ChannelError> {
        self.inner.mark_rejected(intent_key, code)
    }
    fn list_pending(
        &mut self,
    ) -> Result<Vec<dolly_channel::ChannelIntent>, dolly_channel::ChannelError> {
        self.inner.list_pending()
    }
}
