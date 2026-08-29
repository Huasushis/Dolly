//! Shared G4-C receiver test harness: a real Runtime connection (Core engine,
//! Host connection, capability grants, durable Host ingress slice) plus a
//! durable module-scoped Channel store, and fault-injecting wrappers for the
//! accepted seams.

#![allow(dead_code)]

use std::str::FromStr;

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
use dolly_channel::{
    AuthenticatedChannelEvent, ChannelEventContent, ChannelLedger, EventKind, VirtualClock, ids,
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
    dolly_canonical_json::canonicalize(value).unwrap().1.to_canonical_string()
}

pub fn input() -> EnvironmentInput {
    EnvironmentInput { now: CHANNEL_NOW.into(), ..Default::default() }
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

pub fn graph(module_ids: &[&str], receiver_input_pages: &[&str]) -> Value {
    graph_with_outputs(module_ids, receiver_input_pages, &["page-a", "page-b"])
}

pub fn graph_with_outputs(module_ids: &[&str], receiver_input_pages: &[&str], receiver_outputs: &[&str]) -> Value {
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
        descriptors.insert((*module_id).to_owned(), json!({
            "module_id": module_id, "descriptor_revision": 1,
            "source_descriptor_digest": descriptor_digest(module_id),
            "owner_extension_id": EXTENSION_ID, "value": descriptor(module_id)
        }));
    }
    json!({"receiving_module": "receiver", "input_pages": {"receiver": receiver_input_pages},
        "output_pages": output_pages, "subscriptions": {}, "descriptors": descriptors,
        "authorized_metadata_namespaces": [], "authorized_action_names": []})
}

pub fn configured(store: &mut SqliteCoreStore<'_>, mark: &str, revision: i64) {
    let effective_config = json!({"execution_timeout_ms": 120000, "lease_grace_ms": 30000,
        "fencing_grace_ms": 5000, "extension_connection_id": CONNECTION_ID,
        "worker_epoch": WORKER_EPOCH, "worker_epoch_fence": 17});
    let t = store.transact(&CoreCommand::InstallConfig(InstallConfigCommand {
        command_id: format!("{mark}-config"), revision, digest: digest(&effective_config),
        effective_config}), &input()).unwrap();
    assert_eq!(t.outcome, TransitionOutcome::Committed);
}

pub fn install_graph(store: &mut SqliteCoreStore<'_>, mark: &str, revision: i64, body: &Value) {
    let t = store.transact(&CoreCommand::InstallGraph(InstallGraphCommand {
        command_id: format!("{mark}-graph-{revision}"), revision, digest: digest(body),
        graph: body.clone()}), &input()).unwrap();
    assert_eq!(t.outcome, TransitionOutcome::Committed);
}

#[allow(clippy::too_many_arguments)]
pub fn install_grant(store: &mut SqliteCoreStore<'_>, authority: &HostConnectionAuthority,
    module_id: &str, extension_generation: i64, graph_revision: i64, graph_digest: &str, methods: &[&str]) {
    store.install_host_capability_grant(authority, EXTENSION_ID, module_id, extension_generation,
        1, &descriptor_digest(module_id), 1, &digest(&json!({"manifest": 1})),
        graph_revision, graph_digest, methods).unwrap();
}

pub struct RuntimeHarness {
    pub connection: Connection,
    pub authority: HostConnectionAuthority,
    pub grant: HostCapabilityGrant,
    pub grant_other: HostCapabilityGrant,
    pub graph_digest: String,
}

impl RuntimeHarness {
    pub fn new(mark: &str) -> Self { Self::new_with_inputs(mark, &[]) }

    pub fn new_with_inputs(mark: &str, receiver_input_pages: &[&str]) -> Self {
        let body = graph(&[MODULE_ID, MODULE_OTHER], receiver_input_pages);
        Self::build(mark, &body)
    }

    pub fn new_with_outputs(mark: &str, receiver_outputs: &[&str], receiver_input_pages: &[&str]) -> Self {
        let body = graph_with_outputs(&[MODULE_ID, MODULE_OTHER], receiver_input_pages, receiver_outputs);
        Self::build(mark, &body)
    }

    fn build(mark: &str, body: &Value) -> Self {
        let graph_digest = digest(body);
        let mut connection = Connection::open_in_memory().unwrap();
        let authority = {
            let mut store = SqliteCoreStore::new(&mut connection).unwrap();
            configured(&mut store, mark, 1);
            install_graph(&mut store, mark, 1, body);
            let authority = store.bootstrap_host_connection().unwrap();
            install_grant(&mut store, &authority, MODULE_ID, 1, 1, &graph_digest, &["host.ingress.submit"]);
            install_grant(&mut store, &authority, MODULE_OTHER, 1, 1, &graph_digest, &["host.ingress.submit"]);
            authority
        };
        create_host_ingress_schema(&mut connection).unwrap();
        let grant = SqliteCoreStore::new(&mut connection).unwrap()
            .current_host_capability_grant(&authority, EXTENSION_ID, MODULE_ID).unwrap().unwrap();
        let grant_other = SqliteCoreStore::new(&mut connection).unwrap()
            .current_host_capability_grant(&authority, EXTENSION_ID, MODULE_OTHER).unwrap().unwrap();
        Self { connection, authority, grant, grant_other, graph_digest }
    }

    pub fn revoke_grant(&mut self, authority: &HostConnectionAuthority, module_id: &str) {
        SqliteCoreStore::new(&mut self.connection).unwrap()
            .revoke_host_capability_grant(authority, EXTENSION_ID, module_id).unwrap();
    }

    pub fn mapping_count(&self) -> i64 {
        self.connection.query_row("SELECT COUNT(*) FROM host_ingress_mappings", [], |r| r.get(0)).unwrap()
    }

    pub fn operation_count(&self) -> i64 {
        self.connection.query_row("SELECT COUNT(*) FROM core_operations WHERE command_id LIKE 'host-ingress-%'", [], |r| r.get(0)).unwrap()
    }

    pub fn core_store(&mut self) -> SqliteCoreStore<'_> {
        SqliteCoreStore::new(&mut self.connection).unwrap()
    }
}

pub fn channel_config() -> dolly_channel::ChannelConfig {
    dolly_channel::ChannelConfigBuilder::new("web", "account-a", MODULE_ID, 1)
        .target_pages(&["page-a"]).build()
}

pub fn channel_clock() -> VirtualClock {
    VirtualClock::at(Timestamp::from_str(CHANNEL_NOW).unwrap())
}

pub fn sealed_event(authority: &HostConnectionAuthority, grant: &HostCapabilityGrant,
    conversation: &str, message_id: &str, text: &str) -> AuthenticatedChannelEvent {
    AuthenticatedChannelEvent::new(authority, grant, content_event(conversation, message_id, text)).unwrap()
}

pub fn sealed_edit_event(authority: &HostConnectionAuthority, grant: &HostCapabilityGrant,
    message_id: &str, references: &str, text: &str) -> AuthenticatedChannelEvent {
    let mut content = content_event("conv-1", message_id, text);
    content.event_kind = EventKind::Edit;
    content.references_external_message_id = Some(references.to_string());
    AuthenticatedChannelEvent::new(authority, grant, content).unwrap()
}

fn content_event(conversation: &str, message_id: &str, text: &str) -> ChannelEventContent {
    ChannelEventContent {
        channel_id: "web-primary".to_string(), transport: "web".to_string(),
        external_conversation_id: conversation.to_string(), external_message_id: message_id.to_string(),
        sender_class: "user".to_string(), sender_id: "sender-1".to_string(), text: text.to_string(),
        received_at: Timestamp::from_str(CHANNEL_NOW).unwrap(), event_kind: EventKind::Message,
        references_external_message_id: None,
    }
}

pub fn account(authority: &HostConnectionAuthority, grant: &HostCapabilityGrant) -> String {
    ids::channel_account(authority.extension_connection_id(), grant.extension_id(),
        grant.module_id(), authority.worker_epoch().as_str())
}

pub struct FaultyHostIngress<H: HostIngress> {
    inner: H,
    pub fail_submits: u64,
    pub commit_then_drop_submits: u64,
    pub fail_statuses: u64,
    pub submit_calls: u64,
    pub status_calls: u64,
}

impl<H: HostIngress> FaultyHostIngress<H> {
    pub fn new(inner: H) -> Self {
        Self { inner, fail_submits: 0, commit_then_drop_submits: 0, fail_statuses: 0, submit_calls: 0, status_calls: 0 }
    }
}

impl<H: HostIngress> HostIngress for FaultyHostIngress<H> {
    fn submit(&mut self, authority: &HostConnectionAuthority, grant: &HostCapabilityGrant,
        request: &HostIngressSubmitRequest) -> Result<HostIngressSubmitOutcome, HostIngressError> {
        self.submit_calls += 1;
        if self.fail_submits > 0 { self.fail_submits -= 1; return Err(HostIngressError::new(HostIngressErrorCode::Busy, "injected lost submit")); }
        if self.commit_then_drop_submits > 0 {
            self.commit_then_drop_submits -= 1;
            match self.inner.submit(authority, grant, request) {
                Ok(HostIngressSubmitOutcome::Committed { .. }) => Err(HostIngressError::new(HostIngressErrorCode::Busy, "injected lost submit response after commit")),
                o => o,
            }
        } else { self.inner.submit(authority, grant, request) }
    }
    fn status(&mut self, authority: &HostConnectionAuthority, grant: &HostCapabilityGrant,
        request: &HostIngressStatusRequest) -> Result<HostIngressStatus, HostIngressError> {
        self.status_calls += 1;
        if self.fail_statuses > 0 { self.fail_statuses -= 1; return Err(HostIngressError::new(HostIngressErrorCode::Busy, "injected lost status")); }
        self.inner.status(authority, grant, request)
    }
}
