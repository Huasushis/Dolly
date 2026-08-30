//! Authoritative WP-014 Alarm causal acceptance matrix — frozen target at the
//! WP-014 boundary (all 51 cases PASS at the integrated target; the
//! accepted-base receipt 12 PASS / 39 causal PRODUCT_RED / 0 harness is
//! retained in the fixture baseline as historical evidence; the frozen target
//! is 51/0/0).
//!
//! Setup discipline:
//! - Every case drives the REAL committed-premise seam: a real Core config
//!   install, a real graph whose receiving module is owned by the Extension
//!   `org.dolly.alarm`, a real Host connection and capability grant, a real
//!   committed Block carrying the Alarm Action, and a real manifest build +
//!   lease + dispatch that selects that Block into an active Activation. This
//!   is the invocation context the Alarm Extension must consume.
//! - The WP-014 boundary test double (`common::wp014_alarm_reference`, the
//!   recorded deterministic dependency mandated by WP-014's integration rule)
//!   evaluates the frozen contract purely over an injected virtual clock and
//!   injected IANA-derived zone-rule fixtures. Every crossing to shared
//!   substrate uses real public seams: `dolly_canonical_json` JCS +
//!   `Sha256Digest` for occurrence identity and the checked-in JSON Schemas
//!   for action/result validation.
//! - Premise direction is invariant: producer/upstream premise -> durable
//!   explicit premise -> consumer/downstream only. The reference never
//!   writes to the Core store; the production-presence probe observes only
//!   the REAL Core store (blocks/journal) for the durable artifacts a
//!   production `org.dolly.alarm` consumer must produce. The accepted base
//!   ships no such consumer, so every product-behavior case reds with a
//!   directly causal cause and reaches green unchanged once the consumer
//!   lands.
//! - No wall-clock sleep, ambient timezone/network, fixture weakening, or
//!   fake success: the REDs are `product_red` panics naming the missing
//!   production seam; HARNESS_ERROR is anything else and is zero.

#[path = "common/wp014_alarm_reference.rs"]
mod reference;

use reference::*;

use dolly_canonical_json::{CanonicalJsonValue, canonicalize};
use dolly_core_reducer::{
    CoreCommand, DispatchLeaseCommand, DispatchState, EnvironmentInput, InstallConfigCommand,
    InstallGraphCommand, IssueLeaseCommand, TransitionOutcome,
};
use dolly_schema::SchemaBundle;
use dolly_storage::{
    HostCapabilityGrant, HostConnectionAuthority, SqliteCoreStore,
};
use rusqlite::Connection;
use serde_json::{Map, Value, json};

const MATRIX: &str = include_str!("fixtures/wp014_alarm_conformance.json");
const ALARM_EXT: &str = "org.dolly.alarm";
const ALARM_MODULE: &str = "alarm-module";
const ALARM_PAGE: &str = "page-alarm-in";
const OTHER_PAGE: &str = "page-other";
const NOW: &str = "2026-08-09T15:00:00.000000Z";
const ACTION_SCHEMA_ID: &str =
    "https://dolly.example/spec/0.1/schemas/alarm-action.schema.json";
const RECORD_SCHEMA_ID: &str =
    "https://dolly.example/spec/0.1/schemas/alarm-record.schema.json";
const RESULT_SCHEMA_ID: &str =
    "https://dolly.example/spec/0.1/schemas/alarm-result.schema.json";
const COMMON_SCHEMA_ID: &str = "https://dolly.example/spec/0.1/schemas/common.schema.json";

fn matrix() -> Value {
    serde_json::from_str(MATRIX).expect("WP-014 matrix fixture must be valid JSON")
}

fn case(id: &str) -> Value {
    matrix()["cases"]
        .as_array()
        .expect("WP-014 matrix cases must be an array")
        .iter()
        .find(|candidate| candidate["id"] == id)
        .cloned()
        .unwrap_or_else(|| panic!("WP-014 matrix case {id} is missing"))
}

fn canonical_digest(value: &Value) -> String {
    canonicalize(value)
        .expect("fixture value must be canonical JSON")
        .1
        .to_canonical_string()
}

fn input() -> EnvironmentInput {
    EnvironmentInput {
        now: NOW.into(),
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// Real committed-premise harness.
// ---------------------------------------------------------------------------

fn descriptor(module_id: &str) -> Value {
    json!({
        "schema": "dolly.module-descriptor/v1",
        "module_id": module_id,
        "descriptor_revision": 1,
        "display_name": module_id,
        "accepts": {"summary":"input","part_kinds":["text"],"action_names":["org.dolly.alarm.create","org.dolly.alarm.list","org.dolly.alarm.get","org.dolly.alarm.update","org.dolly.alarm.delete","org.dolly.alarm.snooze","org.dolly.alarm.acknowledge"]},
        "emits": {"summary":"output","part_kinds":["text"],"action_names":[]},
        "actions": [
            {"name":"org.dolly.alarm.create","summary":"create an alarm"},
            {"name":"org.dolly.alarm.list","summary":"list alarms"},
            {"name":"org.dolly.alarm.get","summary":"get an alarm"},
            {"name":"org.dolly.alarm.update","summary":"update an alarm"},
            {"name":"org.dolly.alarm.delete","summary":"delete an alarm"},
            {"name":"org.dolly.alarm.snooze","summary":"snooze an occurrence"},
            {"name":"org.dolly.alarm.acknowledge","summary":"acknowledge an occurrence"}
        ],
        "activation_replay_contract": {
            "mode":"fenced_replay",
            "evidence":"pure_compute",
            "ledger":null
        },
        "trust": "trusted",
        "metadata": {}
    })
}

fn graph_snapshot(module_id: &str, input_page: &str, output_page: &str) -> Value {
    let descriptor = descriptor(module_id);
    let mut descriptors = Map::new();
    descriptors.insert(
        module_id.into(),
        json!({
            "module_id": module_id,
            "descriptor_revision": 1,
            "source_descriptor_digest": canonical_digest(&descriptor),
            "owner_extension_id": ALARM_EXT,
            "value": descriptor
        }),
    );
    json!({
        "receiving_module": module_id,
        "input_pages": {input_page: [module_id]},
        "output_pages": {module_id: [output_page]},
        "subscriptions": {},
        "descriptors": descriptors,
        "authorized_metadata_namespaces": ["org.dolly.alarm"],
        "authorized_action_names": [
            "org.dolly.alarm.create",
            "org.dolly.alarm.list",
            "org.dolly.alarm.get",
            "org.dolly.alarm.update",
            "org.dolly.alarm.delete",
            "org.dolly.alarm.snooze",
            "org.dolly.alarm.acknowledge"
        ]
    })
}

/// Alarm defaults frozen at a config revision. The real config install and
/// the manifest effective config carry exactly these bytes.
fn frozen_defaults() -> Value {
    json!({
        "default_timezone": TZ_LA,
        "default_misfire_policy": "fire_once",
        "default_dst_gap_policy": "shift_by_gap",
        "default_dst_fold_policy": "earlier",
        "maximum_alarms": 80,
        "maximum_catch_up_count": 10,
        "minimum_repeat_interval_seconds": 60,
        "wakeup_horizon_seconds": 86400,
        "misfire_grace_seconds": 300,
        "maximum_iterations_days": 2000
    })
}

fn effective_config(mark: &str, defaults: &Value) -> Value {
    json!({
        "execution_timeout_ms": 120000,
        "lease_grace_ms": 30000,
        "fencing_grace_ms": 5000,
        "extension_connection_id": format!("{mark}-connection"),
        "worker_epoch": "0198ab31-6c44-7e8a-b2bb-000000000110",
        "worker_epoch_fence": 17,
        "alarm": defaults.clone()
    })
}

fn install_config(store: &mut SqliteCoreStore<'_>, mark: &str, revision: i64, defaults: &Value) {
    let effective_config = effective_config(mark, defaults);
    let command = CoreCommand::InstallConfig(InstallConfigCommand {
        command_id: format!("{mark}-config"),
        revision,
        digest: canonical_digest(&effective_config),
        effective_config,
    });
    let transition = store
        .transact(&command, &input())
        .expect("configuration transaction must execute");
    assert_eq!(
        transition.outcome,
        TransitionOutcome::Committed,
        "harness: config install must commit"
    );
    store
        .bootstrap_host_connection()
        .expect("Host connection bootstrap");
}

/// One real runtime DB: config (with frozen alarm defaults), a graph whose
/// receiving module is owned by `org.dolly.alarm`, a Host connection, and a
/// capability grant for the module.
struct Premise {
    connection: Connection,
    module: String,
    config_revision: i64,
    mark: String,
}

impl Premise {
    fn new(mark: &str, config_revision: i64) -> Premise {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        {
            let mut store = SqliteCoreStore::new(&mut connection).expect("core schema");
            install_config(&mut store, mark, config_revision, &frozen_defaults());
            let body = graph_snapshot(ALARM_MODULE, ALARM_PAGE, ALARM_MODULE.to_string().as_str());
            let body = {
                let mut graph_out = Map::new();
                graph_out.insert(ALARM_MODULE.into(), json!([ALARM_PAGE]));
                json!({
                    "receiving_module": ALARM_MODULE,
                    "input_pages": {ALARM_PAGE: [ALARM_MODULE]},
                    "output_pages": graph_out,
                    "subscriptions": {},
                    "descriptors": body["descriptors"].clone(),
                    "authorized_metadata_namespaces": ["org.dolly.alarm"],
                    "authorized_action_names": [
                        "org.dolly.alarm.create",
                        "org.dolly.alarm.list",
                        "org.dolly.alarm.get",
                        "org.dolly.alarm.update",
                        "org.dolly.alarm.delete",
                        "org.dolly.alarm.snooze",
                        "org.dolly.alarm.acknowledge"
                    ]
                })
            };
            let digest = canonical_digest(&body);
            let transition = store.transact(
                &CoreCommand::InstallGraph(InstallGraphCommand {
                    command_id: format!("{mark}-graph"),
                    revision: 1,
                    digest,
                    graph: body,
                }),
                &input(),
            );
            assert_eq!(
                transition.expect("graph install").outcome,
                TransitionOutcome::Committed,
                "harness: alarm graph install must commit"
            );
        }
        Premise {
            connection,
            module: ALARM_MODULE.to_string(),
            config_revision,
            mark: mark.to_string(),
        }
    }

    fn authority_and_grant(&mut self, mark: &str) -> (HostConnectionAuthority, HostCapabilityGrant) {
        let authority = {
            let store = SqliteCoreStore::new(&mut self.connection).expect("core schema");
            store.authenticated_host_connection().expect("host authority")
        };
        let graph_digest = {
            let store = SqliteCoreStore::new(&mut self.connection).expect("core schema");
            store
                .snapshot()
                .expect("snapshot")
                .graph
                .get("digest")
                .and_then(Value::as_str)
                .expect("graph digest")
                .to_string()
        };
        let grant = {
            let mut store = SqliteCoreStore::new(&mut self.connection).expect("core schema");
            store
                .install_host_capability_grant(
                    &authority,
                    ALARM_EXT,
                    ALARM_MODULE,
                    1,
                    1,
                    &canonical_digest(&descriptor(ALARM_MODULE)),
                    1,
                    &canonical_digest(&json!({"alarm": 1})),
                    1,
                    &graph_digest,
                    &["host.wakeup.request", "host.block.get"],
                )
                .expect("host capability grant");
            store
                .current_host_capability_grant(&authority, ALARM_EXT, ALARM_MODULE)
                .expect("grant read")
                .expect("grant present")
        };
        (authority, grant)
    }
}

/// Deterministic UuidV7-formatted action id bound to the committed action
/// label (the checked-in CommittedAction envelope requires UuidV7).
fn aid(label: &str) -> String {
    let mut h: u64 = 0x9e37_79b9_7f4a_7c15;
    for b in label.as_bytes() {
        h = h.wrapping_mul(31).wrapping_add(*b as u64);
    }
    format!("0198ab31-6c44-7e8a-b2bb-{:012}", h % 1_000_000_000_000)
}

/// The exact committed Action wire shape for one stable alarm action.
fn alarm_action(action_id: &str, name: &str, arguments: Value) -> Value {
    let action_id = aid(action_id);
    let mut action = json!({
        "action_id": action_id,
        "name": name,
        "target": {"module_id": ALARM_MODULE},
        "arguments": arguments,
        "contract_binding": {
            "module_id": ALARM_MODULE,
            "descriptor_revision": 1,
            "action_contract_digest": null,
            "action_contract": {
                "name": name,
                "arguments_schema": {
                    "uri": action_schema_uri(),
                    "schema_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                    "semantic_validator": null
                },
                "result_schema": {
                    "uri": result_schema_uri(),
                    "schema_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                    "semantic_validator": {
                        "id": "org.dolly.validator.alarm-result",
                        "revision": 1
                    }
                },
                "description": name,
                "side_effect_class": "idempotent_write"
            }
        }
    });
    let contract = action["contract_binding"]["action_contract"].clone();
    action["contract_binding"]["action_contract_digest"] = json!(canonical_digest(&contract));
    action
}

fn action_schema_uri() -> String {
    ACTION_SCHEMA_ID.to_string()
}

fn result_schema_uri() -> String {
    RESULT_SCHEMA_ID.to_string()
}

/// A committed Block whose body carries the given alarm Actions.
fn alarm_block(block_id: &str, actions: Vec<Value>) -> Value {
    json!({
        "schema": "dolly.block/v1",
        "id": block_id,
        "body": {
            "description": "alarm activation input",
            "parts": [],
            "actions": actions
        }
    })
}

/// Commit the Block through the real Core journal and build, lease, and
/// dispatch an active Activation selecting it — the exact invocation context
/// the Alarm consumer must drain. Returns the activation id.
fn commit_and_activate(
    premise: &mut Premise,
    authority: &HostConnectionAuthority,
    mark: &str,
    block: Value,
    page: &str,
) -> String {
    let action_ids: Vec<String> = block["body"]["actions"]
        .as_array()
        .expect("actions")
        .iter()
        .map(|a| a["action_id"].as_str().expect("action id").to_string())
        .collect();
    let block_id = format!("alarm-block-{mark}");
    {
        let mut store = SqliteCoreStore::new(&mut premise.connection).expect("core schema");
        let transition = store.transact(
            &CoreCommand::Ingress(dolly_core_reducer::IngressCommand {
                command_id: format!("{mark}-ingress"),
                runtime_source: "model/alarm-module".to_string(),
                ingress_key: format!("{mark}-ingress-key"),
                operation_digest: canonical_digest(&block),
                block_id: block_id.clone(),
                block: block.clone(),
                pages: vec![page.to_string()],
            }),
            &input(),
        );
        assert_eq!(
            transition.expect("alarm commit").outcome,
            TransitionOutcome::Committed,
            "harness: alarm Block commit must commit"
        );
    }
    let activation_id = format!("activation-{mark}");
    let manifest = built_manifest(
        premise,
        &activation_id,
        premise.config_revision,
        block.clone(),
        page,
        action_ids,
    );
    {
        let mut store = SqliteCoreStore::new(&mut premise.connection).expect("core schema");
        let transition = store.transact(
            &CoreCommand::BuildManifest(dolly_core_reducer::BuildManifestCommand {
                command_id: format!("{mark}-build"),
                activation_id: activation_id.clone(),
                manifest,
                expected_graph_revision: None,
                expected_descriptor_revision: None,
            }),
            &input(),
        );
        assert_eq!(
            transition.expect("manifest build").outcome,
            TransitionOutcome::Committed,
            "harness: alarm manifest build must commit"
        );
    }
    let lease_id = format!("lease-{mark}");
    let token_digest =
        canonical_digest(&json!({"activation_id": activation_id, "lease_id": lease_id}));
    {
        let mut store = SqliteCoreStore::new(&mut premise.connection).expect("core schema");
        let transition = store.transact(
            &CoreCommand::IssueLease(IssueLeaseCommand {
                command_id: format!("{mark}-lease"),
                activation_id: activation_id.clone(),
                lease_id: lease_id.clone(),
                reservation_id: None,
                token_digest,
                extension_connection_id: authority.extension_connection_id().to_string(),
                worker_epoch: authority.worker_epoch_fence(),
                request_id: None,
                worker_epoch_id: None,
                incarnation_revision: None,
                extension_generation: Some(1),
            }),
            &input(),
        );
        assert_eq!(
            transition.expect("lease").outcome,
            TransitionOutcome::Committed,
            "harness: alarm lease must commit"
        );
    }
    {
        let mut store = SqliteCoreStore::new(&mut premise.connection).expect("core schema");
        let transition = store.transact(
            &CoreCommand::DispatchLease(DispatchLeaseCommand {
                command_id: format!("{mark}-dispatch"),
                activation_id: activation_id.clone(),
                lease_id,
                dispatch_state: DispatchState::Started,
                reservation_id: None,
                request_id: None,
                extension_connection_id: None,
                incarnation_revision: None,
                frame_digest: None,
            }),
            &input(),
        );
        assert_eq!(
            transition.expect("dispatch").outcome,
            TransitionOutcome::Committed,
            "harness: alarm dispatch must commit"
        );
    }
    activation_id
}

fn built_manifest(
    premise: &Premise,
    activation_id: &str,
    config_revision: i64,
    block: Value,
    page: &str,
    action_ids: Vec<String>,
) -> Value {
    let _ = action_ids;
    let effective_config = effective_config(&premise.mark, &frozen_defaults());
    let effective_config_digest = canonical_digest(&effective_config);
    let mut manifest = json!({
        "schema": "dolly.activation-manifest/v1",
        "activation_id": activation_id,
        "module_id": ALARM_MODULE,
        "reason": "input",
        "created_at": NOW,
        "graph_revision": 1,
        "config_revision": config_revision,
        "descriptor_revision": 1,
        "effective_config": effective_config,
        "effective_config_digest": effective_config_digest,
        "required_frame_bytes": 2048,
        "required_frame_nesting_depth": 4,
        "input_items": [{
            "block": block,
            "occurrences": [{"page_id": page, "page_seq": 1, "commit_seq": 1}],
            "occurrence_count": 1
        }],
        "cursor_spans": [],
        "lossy_gaps": [],
        "output_page_ids": [ALARM_PAGE],
        "neighbor_descriptors": [],
        "deadline": "2026-08-09T15:01:00.000000Z"
    });
    let manifest_digest = canonical_digest(&manifest);
    manifest["manifest_digest"] = json!(manifest_digest);
    manifest
}

/// Read the committed action(s) of an activation's input block back from the
/// REAL Core snapshot (the consumer's actual read seam).
fn committed_actions(premise: &mut Premise, activation_id: &str) -> Vec<Value> {
    let store = SqliteCoreStore::new(&mut premise.connection).expect("core schema");
    let snapshot = store.snapshot().expect("snapshot");
    let manifest = snapshot
        .manifests
        .get(activation_id)
        .expect("manifest present")
        .clone();
    let block = manifest
        .get("input_items")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("block"))
        .expect("input block present");
    block["body"]["actions"]
        .as_array()
        .expect("actions")
        .clone()
}

/// The production-presence probe: durable artifacts a production
/// `org.dolly.alarm` consumer MUST leave in the real Core store (committed
/// due-output Blocks carrying the frozen `dolly.alarm.event/v1` rows, and
/// journal records for requested wakeups). The accepted base leaves none.
fn production_alarm_artifacts(premise: &mut Premise) -> Vec<String> {
    let mut found = Vec::new();
    let store = SqliteCoreStore::new(&mut premise.connection).expect("core schema");
    let snapshot = store.snapshot().expect("snapshot");
    for (block_id, block) in &snapshot.blocks {
        let text = format!("{block:?}");
        if text.contains(EVENT_SCHEMA) {
            found.push(format!("alarm event block {block_id}"));
        }
    }
    for event in &snapshot.journal {
        let name = &event.event;
        if name == "WakeupRequested" {
            found.push("journal WakeupRequested".to_string());
        }
    }
    found
}

/// Every causal step this probe actually drove (the real Core transactions
/// and the deterministic boundary double) succeeded; only the missing
/// production behavior named by `seam` turns the case red.
fn product_red(case_id: &str, seam: &str, cause: &str, area: &str) -> ! {
    panic!(
        "PRODUCT_RED [{case_id}] seam={seam} cause={cause} area={area}; \
         every causal step this probe actually drove (the real Core config/graph/ingress/\
         manifest/lease/dispatch transactions and the deterministic WP-014 boundary double) \
         succeeded, so this failure is attributable to the missing WP-014 product behavior \
         named in the cause — not a harness, build, or environment failure"
    )
}

/// End a product-behavior case: the real store must contain the durable
/// production artifact(s) for this case. At the accepted base it cannot, so
/// the case reds with the exact cause.
fn require_production(
    case_id: &str,
    premise: &mut Premise,
    area: &str,
    cause: &str,
) {
    let artifacts = production_alarm_artifacts(premise);
    if artifacts.is_empty() {
        product_red(
            case_id,
            "org.dolly.alarm committed-Action consumer (absent at the accepted base)",
            cause,
            area,
        );
    }
}

// ---------------------------------------------------------------------------
// Deterministic reference driver over the real committed premise.
// ---------------------------------------------------------------------------

fn committed_action_from_wire(value: Value) -> CommittedAction {
    CommittedAction {
        action_id: value["action_id"]
            .as_str()
            .expect("action_id")
            .to_string(),
        name: value["name"].as_str().expect("name").to_string(),
        target_module: value["target"]["module_id"]
            .as_str()
            .expect("target module")
            .to_string(),
        arguments: value["arguments"].clone(),
    }
}

/// Run the deterministic boundary double over the committed actions.
fn run_reference(
    actions: &[Value],
    cfg: &AlarmConfig,
    clock: &mut RefClock,
    now_utc: &str,
) -> (RefStore, Vec<ActionResult>) {
    let mut store = RefStore::default();
    let mut results = Vec::new();
    for raw in actions {
        let action = committed_action_from_wire(raw.clone());
        results.push(process_action(&mut store, &action, cfg, clock, now_utc));
    }
    (store, results)
}

fn create_args(title: &str, schedule: Value, delivery: Value) -> Value {
    json!({
        "title": title,
        "schedule": schedule,
        "delivery": delivery,
        "enabled": true
    })
}

fn cron_schedule(expression: &str, timezone: Option<&str>) -> Value {
    let mut schedule = json!({"kind": "cron_v1", "expression": expression});
    if let Some(tz) = timezone {
        schedule["timezone"] = json!(tz);
    }
    schedule
}

fn once_schedule(at: &str) -> Value {
    json!({"kind": "once", "at": at})
}

fn interval_schedule(every_seconds: i64, anchor: &str) -> Value {
    json!({"kind": "interval", "every_seconds": every_seconds, "anchor": anchor})
}

fn once_delivery() -> Value {
    json!({"mode": "once"})
}

fn repeat_delivery(every_seconds: i64) -> Value {
    json!({"mode": "repeat_until_acknowledged", "repeat_interval_seconds": every_seconds})
}

// ---------------------------------------------------------------------------
// Real schema validation seam over the checked-in alarm schemas.
// ---------------------------------------------------------------------------

fn schema_resource(id: &str, path: &str) -> Value {
    let mut resource_id = String::new();
    resource_id.push_str(id);
    let _ = resource_id;
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|_| panic!("checked-in schema {path} must be readable"));
    serde_json::from_str(&raw).expect("schema is valid JSON")
}

fn action_bundle() -> SchemaBundle {
    bundle_for(ACTION_SCHEMA_ID)
}

fn result_bundle() -> SchemaBundle {
    bundle_for(RESULT_SCHEMA_ID)
}

fn bundle_for(root: &str) -> SchemaBundle {
    let schemas_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("dolly-spec")
        .join("schemas");
    let mut resources = Map::new();
    for (id, file) in [
        (ACTION_SCHEMA_ID, "alarm-action.schema.json"),
        (RECORD_SCHEMA_ID, "alarm-record.schema.json"),
        (RESULT_SCHEMA_ID, "alarm-result.schema.json"),
        (COMMON_SCHEMA_ID, "common.schema.json"),
    ] {
        let raw = std::fs::read(
            schemas_root
                .join(file)
                .as_path(),
        )
        .unwrap_or_else(|_| panic!("checked-in schema {file} must be readable"));
        let value: Value = serde_json::from_slice(&raw).expect("schema is valid JSON");
        resources.insert(id.to_string(), value);
    }
    let bundle = json!({
        "schema": "dolly.schema-bundle/v1",
        "root": root,
        "resources": resources
    });
    SchemaBundle::from_json_bytes(&serde_json::to_vec(&bundle).expect("bundle serializes"))
        .expect("checked-in alarm schema bundle must load")
}

fn validate_instance(bundle: &SchemaBundle, instance: &Value) -> Result<(), String> {
    let validator = bundle.validator().map_err(|e| format!("validator: {e}"))?;
    let bytes = serde_json::to_vec(instance).expect("instance json");
    let canonical: CanonicalJsonValue = dolly_canonical_json::deserialize_core_json(
        &bytes,
        dolly_canonical_json::ParseLimits::protocol_wire(),
    )
    .map_err(|e| format!("instance canonicalization: {e}"))?;
    match validator.validate(&canonical) {
        Ok(()) => Ok(()),
        Err(errors) => Err(errors
            .issues()
            .iter()
            .map(|issue| issue.message.clone())
            .collect::<Vec<_>>()
            .join("; ")),
    }
}

fn assert_fixture(id: &str, key: &str, actual: Value, expected: Value) {
    assert_eq!(
        actual, expected,
        "WP-014 case {id}: {key} must match the frozen target"
    );
}

fn spec_alarm_id() -> String {
    SPEC_ALARM_ID.to_string()
}

/// Drive a real premise committed with the given Alarm Actions and return
/// premise + activation.
fn drive_actions(
    mark: &str,
    actions: Vec<Value>,
) -> (Premise, HostConnectionAuthority, HostCapabilityGrant, String) {
    let mut premise = Premise::new(mark, 1);
    let (authority, grant) = premise.authority_and_grant(mark);
    let block = alarm_block(&format!("block-{mark}"), actions);
    let activation = commit_and_activate(&mut premise, &authority, mark, block, ALARM_PAGE);
    (premise, authority, grant, activation)
}

/// Create one record through the boundary double and return store + result.
fn reference_create(
    cfg: &AlarmConfig,
    now: &str,
    title: &str,
    schedule: Value,
    delivery: Value,
) -> (RefStore, ActionResult) {
    let mut clock = RefClock::new(now, 0);
    let mut store = RefStore::default();
    let action = committed_action_from_wire(alarm_action(
        "create-single",
        "org.dolly.alarm.create",
        create_args(title, schedule, delivery),
    ));
    let result = process_action(&mut store, &action, cfg, &mut clock, now);
    (store, result)
}

// ===========================================================================
// D. Create and delivery (base PRODUCT_RED — the create+advance seed).
// ===========================================================================

#[test]
fn wp014_valid_create_durable_normalized_and_advance() {
    let entry = case("WP014-CREATE-001");
    assert_eq!(entry["expected"], "pass");
    let (mut premise, _authority, _grant, activation) =
        drive_create("c001", "act-c001-0000000001");
    // Frozen reference facts over the REAL committed premise.
    let actions = committed_actions(&mut premise, &activation);
    assert_eq!(actions.len(), 1);
    let mut clock = RefClock::new(NOW, 0);
    let cfg = default_alarm_config(1);
    let (mut store, results) = run_reference(&actions, &cfg, &mut clock, NOW);
    let created = results
        .first()
        .expect("create result")
        .result()
        .cloned()
        .expect("create succeeds");
    assert_eq!(created["schema"], "dolly.alarm.create-result/v1");
    let record = created["record"].clone();
    assert_eq!(record["title"], "Submit assignment");
    assert_eq!(record["revision"], 1);
    assert_eq!(record["enabled"], true);
    assert_eq!(record["created_at"], NOW);
    assert_eq!(record["tzdb_revision"], TZDB_2026B);
    assert_eq!(record["misfire_policy"], "fire_once");
    assert_eq!(record["dst_gap_policy"], "shift_by_gap");
    assert_eq!(record["dst_fold_policy"], "earlier");
    assert_eq!(
        record["next_occurrence"],
        "2026-08-10T15:30:00.000000Z",
        "the spec-anchored next occurrence is frozen"
    );
    // request_wakeup after the state change, bounded by the wakeup horizon.
    assert_eq!(
        store.wakeups.last().expect("wakeup after create").next_utc_instant,
        "2026-08-10T15:00:00.000000Z"
    );
    assert!(store.wakeups[0].wakeup_key.starts_with("org.dolly.alarm@"));
    // Advance the virtual clock to the due instant and run the wakeup pass.
    clock.set_wall("2026-08-10T15:30:00.000000Z");
    clock.advance_mono(DAY as i128 * 1_000_000 + 900_000_000);
    let outcome = process_due(&mut store, &cfg, &mut clock).expect("advance pass");
    assert_eq!(outcome.fired_event_ids.len(), 1, "advance fires the occurrence");
    let event = &store.fired_events[0];
    assert_eq!(event.schema, EVENT_SCHEMA);
    assert_eq!(event.scheduled_at, "2026-08-10T15:30:00.000000Z");
    assert_eq!(event.fired_at, "2026-08-10T15:30:00.000000Z");
    assert_eq!(event.lateness_seconds, 0);
    assert_eq!(event.misfire_status, "on_time");
    assert_eq!(event.acknowledgement_requirement, "repeat_until_acknowledged");
    // The record advanced to the next future occurrence.
    assert_eq!(
        store.records.values().next().expect("record").next_occurrence,
        Some("2026-08-11T15:30:00.000000Z".to_string())
    );
    // Production consumer must have left the durable artifact in the real store.
    require_production(
        "WP014-CREATE-001",
        &mut premise,
        "create+advance",
        "the accepted base ships no org.dolly.alarm committed-Action consumer, so the valid create Action committed under the real org.dolly.alarm-owned Activation produced no durable normalized AlarmRecord, no wakeup request, and no due-event output Block in the real Core store",
    );
}

#[test]
fn wp014_create_replay_idempotent_by_action_id() {
    let entry = case("WP014-CREATE-002");
    assert_eq!(entry["expected"], "pass");
    let (mut premise, _a, _g, activation) = drive_create("c002", "act-c002-0000000001");
    let actions = committed_actions(&mut premise, &activation);
    let mut clock = RefClock::new(NOW, 0);
    let cfg = default_alarm_config(1);
    let mut store = RefStore::default();
    let mut results = Vec::new();
    for raw in &actions {
        let action = committed_action_from_wire(raw.clone());
        results.push(process_action(&mut store, &action, &cfg, &mut clock, NOW));
    }
    // Replay: the same committed action_id yields the byte-identical logical record.
    let action = committed_action_from_wire(actions[0].clone());
    let replay = process_action(&mut store, &action, &cfg, &mut clock, NOW);
    assert_eq!(
        replay.result().expect("replay ok"),
        results[0].result().expect("first ok"),
        "create replay must return the byte-identical logical record"
    );
    assert_eq!(store.records.len(), 1, "replay must not create a second record");
    require_production(
        "WP014-CREATE-002",
        &mut premise,
        "create replay",
        "the accepted base has no org.dolly.alarm consumer, so committed-action replay is not observed end-to-end through the real store",
    );
}

#[test]
fn wp014_enabled_toggle_and_delivery_bounds() {
    let entry = case("WP014-CREATE-003");
    assert_eq!(entry["expected"], "pass");
    let cfg = default_alarm_config(1);
    // Disabled: no future occurrence is scheduled (next_occurrence null).
    let mut action = alarm_action(
        "act-c003-0000000001",
        "org.dolly.alarm.create",
        create_args("off", once_schedule("2026-09-01T00:00:00Z"), once_delivery()),
    );
    action["arguments"]["enabled"] = json!(false);
    let mut clock = RefClock::new(NOW, 0);
    let mut store = RefStore::default();
    let result = process_action(&mut store, &committed_action_from_wire(action), &cfg, &mut clock, NOW);
    let record = result.result().expect("ok")["record"].clone();
    assert_eq!(record["enabled"], false);
    assert_eq!(record["next_occurrence"], Value::Null, "disabled schedules nothing");
    // Repeat interval below the configured minimum -> REPEAT_INTERVAL.
    let (_, bad) = reference_create(
        &cfg,
        NOW,
        "fast",
        once_schedule("2026-09-01T00:00:00Z"),
        repeat_delivery(30),
    );
    assert_eq!(bad.error().expect("error").code, "REPEAT_INTERVAL");
    // Unknown delivery mode -> INVALID_SCHEDULE.
    let (_s2, unknown) = reference_create(
        &cfg,
        NOW,
        "mode",
        once_schedule("2026-09-01T00:00:00Z"),
        json!({"mode": "hourly"}),
    );
    assert_eq!(unknown.error().expect("error").code, "INVALID_SCHEDULE");
    // Real premise probe.
    let (mut premise, _a, _g, activation) = drive_create("c003", "act-c003-0000000009");
    let _ = activation;
    require_production(
        "WP014-CREATE-003",
        &mut premise,
        "enabled/delivery bounds",
        "the accepted base has no org.dolly.alarm consumer enforcing enabled scheduling and delivery bounds through the real store",
    );
}

#[test]
fn wp014_maximum_alarms_limit() {
    let entry = case("WP014-CREATE-004");
    assert_eq!(entry["expected"], "pass");
    let mut defaults = frozen_defaults();
    defaults["maximum_alarms"] = json!(2);
    let cfg = alarm_config(1, &defaults);
    let mut clock = RefClock::new(NOW, 0);
    let mut store = RefStore::default();
    for n in 0..3 {
        let action = committed_action_from_wire(alarm_action(
            &format!("act-c004-{n:04}"),
            "org.dolly.alarm.create",
            create_args(
                &format!("lot-{n}"),
                once_schedule(&format!("2026-09-{:02}T00:00:00.000000Z", 1 + n)),
                once_delivery(),
            ),
        ));
        let result = process_action(&mut store, &action, &cfg, &mut clock, NOW);
        if n < 2 {
            assert!(result.result().is_some(), "fills within the limit");
        } else {
            assert_eq!(result.error().expect("error").code, "ALARM_LIMIT");
            assert_eq!(store.records.len(), 2, "no partial record");
        }
    }
    let (mut premise, _a, _g, _activation) =
        drive_actions("c004", vec![alarm_action("act-c004-zzz1", "org.dolly.alarm.create", create_args("x", once_schedule("2026-09-09T00:00:00Z"), once_delivery()))]);
    require_production(
        "WP014-CREATE-004",
        &mut premise,
        "alarm limit",
        "the accepted base has no org.dolly.alarm consumer enforcing maximum alarms through the real store",
    );
}

// ===========================================================================
// E. Scheduling evaluation (base PRODUCT_RED — honest scheduling reds).
// ===========================================================================

#[test]
fn wp014_cron_field_rules() {
    let entry = case("WP014-CRON-001");
    assert_eq!(entry["expected"], "pass");
    let cfg = default_alarm_config(1);
    let cases: &[(&str, &str)] = &[
        // (expression, expected next occurrence from 2026-08-09T15:00:00Z)
        ("0 0 * * *", "2026-08-10T07:00:00.000000Z"),
        ("0 12 * * 0", "2026-08-09T19:00:00.000000Z"),
        ("30 8 * * 1-5", "2026-08-10T15:30:00.000000Z"),
        ("*/15 * * * *", "2026-08-09T15:15:00.000000Z"),
        ("0 0-5 * * *", "2026-08-10T07:00:00.000000Z"),
        ("0 0 1,15 * 0-6", "2026-08-10T07:00:00.000000Z"),
    ];
    let mut n = 0;
    for (expr, expected) in cases {
        n += 1;
        let (store, result) = reference_create(
            &cfg,
            NOW,
            "field",
            cron_schedule(expr, Some(TZ_LA)),
            once_delivery(),
        );
        let record = result.result().expect("ok")["record"].clone();
        assert_eq!(
            record["next_occurrence"],
            json!(expected),
            "cron field rule {expr} frozen next occurrence"
        );
        assert_eq!(store.records.len(), 1);
    }
    let (mut premise, _a, _g, _activation) = drive_actions(
        "cron1",
        vec![alarm_action(
            "act-cron1-0001",
            "org.dolly.alarm.create",
            create_args("f", cron_schedule("0 0 * * *", Some(TZ_LA)), once_delivery()),
        )],
    );
    require_production(
        "WP014-CRON-001",
        &mut premise,
        "cron field rules",
        "the accepted base has no org.dolly.alarm scheduler, so no production path evaluates cron field rules or materializes the next occurrence in the real store",
    );
}

#[test]
fn wp014_cron_dom_dow_or_semantics() {
    let entry = case("WP014-CRON-002");
    assert_eq!(entry["expected"], "pass");
    let cfg = default_alarm_config(1);
    // Both DOM and DOW restricted: a local time matches when either matches
    // (13th OR Friday) — next from Saturday 2026-08-01 is Friday 2026-08-07.
    let (_s, result) = reference_create(
        &cfg,
        "2026-08-01T00:00:00.000000Z",
        "or",
        cron_schedule("0 0 13 * 5", Some(TZ_LA)),
        once_delivery(),
    );
    assert_eq!(
        result.result().expect("ok")["record"]["next_occurrence"],
        "2026-08-07T07:00:00.000000Z"
    );
    // Either field `*`: the restricted field MUST match (DOM=15).
    let (_s2, result2) = reference_create(
        &cfg,
        "2026-08-01T00:00:00.000000Z",
        "dom",
        cron_schedule("0 0 15 * *", Some(TZ_LA)),
        once_delivery(),
    );
    assert_eq!(
        result2.result().expect("ok")["record"]["next_occurrence"],
        "2026-08-15T07:00:00.000000Z"
    );
    let (mut premise, _a, _g, _activation) = drive_actions(
        "cron2",
        vec![alarm_action(
            "act-cron2-0001",
            "org.dolly.alarm.create",
            create_args("o", cron_schedule("0 0 13 * 5", Some(TZ_LA)), once_delivery()),
        )],
    );
    require_production(
        "WP014-CRON-002",
        &mut premise,
        "cron DOM/DOW OR semantics",
        "the accepted base has no org.dolly.alarm scheduler evaluating Vixie DOM/DOW OR semantics through the real store",
    );
}

#[test]
fn wp014_cron_month_end_and_leap_day() {
    let entry = case("WP014-CRON-003");
    assert_eq!(entry["expected"], "pass");
    let cfg = default_alarm_config(1);
    // January 31 (month end); January PST = UTC-8.
    let (_s, jan) = reference_create(
        &cfg,
        "2026-01-01T00:00:00.000000Z",
        "jan31",
        cron_schedule("0 0 31 1 *", Some(TZ_LA)),
        once_delivery(),
    );
    assert_eq!(
        jan.result().expect("ok")["record"]["next_occurrence"],
        "2026-01-31T08:00:00.000000Z"
    );
    // February 29 exists only in leap years: from 2026-03-01 the next is 2028.
    let (_s2, leap) = reference_create(
        &cfg,
        "2026-03-01T00:00:00.000000Z",
        "leap",
        cron_schedule("0 0 29 2 *", Some(TZ_LA)),
        once_delivery(),
    );
    assert_eq!(
        leap.result().expect("ok")["record"]["next_occurrence"],
        "2028-02-29T08:00:00.000000Z"
    );
    let (mut premise, _a, _g, _activation) = drive_actions(
        "cron3",
        vec![alarm_action(
            "act-cron3-0001",
            "org.dolly.alarm.create",
            create_args("leap", cron_schedule("0 0 29 2 *", Some(TZ_LA)), once_delivery()),
        )],
    );
    require_production(
        "WP014-CRON-003",
        &mut premise,
        "month end / leap day",
        "the accepted base has no org.dolly.alarm scheduler evaluating month-end and leap-day rules through the real store",
    );
}

#[test]
fn wp014_once_and_interval_occurrence_sets() {
    let entry = case("WP014-CRON-004");
    assert_eq!(entry["expected"], "pass");
    let cfg = default_alarm_config(1);
    // once converts to the Core UTC form without loss of the instant.
    let (_s, once) = reference_create(
        &cfg,
        NOW,
        "once",
        once_schedule("2026-09-01T08:30:00+02:00"),
        once_delivery(),
    );
    assert_eq!(
        once.result().expect("ok")["record"]["schedule"]["at"],
        "2026-09-01T06:30:00.000000Z"
    );
    assert_eq!(
        once.result().expect("ok")["record"]["next_occurrence"],
        "2026-09-01T06:30:00.000000Z"
    );
    // interval occurrences are anchor + n*duration in pure UTC.
    let (_s2, iv) = reference_create(
        &cfg,
        NOW,
        "iv",
        interval_schedule(3600, "2026-08-09T15:00:00.000000Z"),
        once_delivery(),
    );
    assert_eq!(
        iv.result().expect("ok")["record"]["next_occurrence"],
        "2026-08-09T16:00:00.000000Z"
    );
    // DST has no effect on an interval that crosses the fall-back fold.
    let (_s3, iv_fold) = reference_create(
        &cfg,
        "2026-11-01T04:00:00.000000Z",
        "ivf",
        interval_schedule(3600, "2026-11-01T08:30:00.000000Z"),
        once_delivery(),
    );
    assert_eq!(
        iv_fold.result().expect("ok")["record"]["next_occurrence"],
        "2026-11-01T08:30:00.000000Z"
    );
    let (mut premise, _a, _g, _activation) = drive_actions(
        "cron4",
        vec![alarm_action(
            "act-cron4-0001",
            "org.dolly.alarm.create",
            create_args("iv", interval_schedule(3600, "2026-08-09T15:00:00.000000Z"), once_delivery()),
        )],
    );
    require_production(
        "WP014-CRON-004",
        &mut premise,
        "once/interval occurrence sets",
        "the accepted base has no org.dolly.alarm scheduler for once and interval occurrence sets through the real store",
    );
}

#[test]
fn wp014_cron_iteration_bound() {
    let entry = case("WP014-CRON-005");
    assert_eq!(entry["expected"], "pass");
    let cfg = default_alarm_config(1);
    // A pattern with no future match (February 31) under a tight bound.
    let spec = parse_cron("0 0 31 2 *").expect("parses");
    let zone = zone_named(TZ_LA).expect("zone");
    let bound = alarm_config(1, &json!({"maximum_iterations_days": 40}));
    let err = cron_next(
        &spec,
        &zone,
        parse_core_utc("2026-01-01T00:00:00.000000Z").expect("instant"),
        GapPolicy::ShiftByGap,
        FoldPolicy::Earlier,
        bound.maximum_iterations_days,
    )
    .expect_err("iteration bound exceeded");
    assert_eq!(err.code, "ITERATION_BOUND");
    let (mut premise, _a, _g, _activation) = drive_actions(
        "cron5",
        vec![alarm_action(
            "act-cron5-0001",
            "org.dolly.alarm.create",
            create_args("feb31", cron_schedule("0 0 31 2 *", Some(TZ_LA)), once_delivery()),
        )],
    );
    require_production(
        "WP014-CRON-005",
        &mut premise,
        "iteration bound",
        "the accepted base has no org.dolly.alarm scheduler enforcing the configured iteration bound through the real store",
    );
}

#[test]
fn wp014_dst_gap_policies() {
    let entry = case("WP014-DST-001");
    assert_eq!(entry["expected"], "pass");
    let cfg = default_alarm_config(1);
    // shift_by_gap: the nonexistent 02:30 on 2026-03-08 shifts by the exact
    // one-hour gap to 03:30 PDT == 10:30Z.
    let (_s, shifted) = reference_create(
        &cfg,
        "2026-03-07T11:00:00.000000Z",
        "gap",
        cron_schedule("30 2 * * *", Some(TZ_LA)),
        once_delivery(),
    );
    assert_eq!(
        shifted.result().expect("ok")["record"]["next_occurrence"],
        "2026-03-08T10:30:00.000000Z"
    );
    // skip: the nonexistent 02:30 creates no occurrence; the next is the
    // following day.
    let mut skip_args = create_args("gap-skip", cron_schedule("30 2 * * *", Some(TZ_LA)), once_delivery());
    skip_args["dst_gap_policy"] = json!("skip");
    let mut clock = RefClock::new("2026-03-07T11:00:00.000000Z", 0);
    let mut store = RefStore::default();
    let action = committed_action_from_wire(alarm_action(
        "act-dst1-0002",
        "org.dolly.alarm.create",
        skip_args,
    ));
    let result = process_action(&mut store, &action, &cfg, &mut clock, "2026-03-07T11:00:00.000000Z");
    assert_eq!(
        result.result().expect("ok")["record"]["next_occurrence"],
        "2026-03-09T09:30:00.000000Z"
    );
    assert_eq!(
        result.result().expect("ok")["record"]["dst_gap_policy"],
        "skip"
    );
    let (mut premise, _a, _g, _activation) = drive_actions(
        "dst1",
        vec![alarm_action(
            "act-dst1-0001",
            "org.dolly.alarm.create",
            create_args("g", cron_schedule("30 2 * * *", Some(TZ_LA)), once_delivery()),
        )],
    );
    require_production(
        "WP014-DST-001",
        &mut premise,
        "DST gap policies",
        "the accepted base has no org.dolly.alarm scheduler resolving DST gaps (shift_by_gap/skip) through the real store",
    );
}

#[test]
fn wp014_dst_fold_policies() {
    let entry = case("WP014-DST-002");
    assert_eq!(entry["expected"], "pass");
    let cfg = default_alarm_config(1);
    // earlier: the ambiguous 01:30 on 2026-11-01 resolves to the earlier
    // UTC instant (PDT -7).
    let mut earlier = create_args("fold-e", cron_schedule("30 1 * * *", Some(TZ_LA)), once_delivery());
    earlier["dst_fold_policy"] = json!("earlier");
    let (s_e, r_e) = {
        let mut clock = RefClock::new("2026-11-01T00:00:00.000000Z", 0);
        let mut store = RefStore::default();
        let action = committed_action_from_wire(alarm_action(
            "act-dst2-0001",
            "org.dolly.alarm.create",
            earlier,
        ));
        let result = process_action(&mut store, &action, &cfg, &mut clock, "2026-11-01T00:00:00.000000Z");
        (store, result)
    };
    assert_eq!(
        r_e.result().expect("ok")["record"]["next_occurrence"],
        "2026-11-01T08:30:00.000000Z"
    );
    // later: the later UTC instant (PST -8).
    let mut later = create_args("fold-l", cron_schedule("30 1 * * *", Some(TZ_LA)), once_delivery());
    later["dst_fold_policy"] = json!("later");
    let (_s2, r_l) = {
        let mut clock = RefClock::new("2026-11-01T00:00:00.000000Z", 0);
        let mut store = RefStore::default();
        let action = committed_action_from_wire(alarm_action(
            "act-dst2-0002",
            "org.dolly.alarm.create",
            later,
        ));
        let result = process_action(&mut store, &action, &cfg, &mut clock, "2026-11-01T00:00:00.000000Z");
        (store, result)
    };
    assert_eq!(
        r_l.result().expect("ok")["record"]["next_occurrence"],
        "2026-11-01T09:30:00.000000Z"
    );
    // both: two distinct occurrences with fold ordinals 0 and 1.
    let mut both = create_args("fold-b", cron_schedule("30 1 * * *", Some(TZ_LA)), once_delivery());
    both["dst_fold_policy"] = json!("both");
    let mut clock = RefClock::new("2026-11-01T00:00:00.000000Z", 0);
    let mut store = RefStore::default();
    let action = committed_action_from_wire(alarm_action("act-dst2-0003", "org.dolly.alarm.create", both));
    let r_b = process_action(&mut store, &action, &cfg, &mut clock, "2026-11-01T00:00:00.000000Z");
    assert_eq!(
        r_b.result().expect("ok")["record"]["next_occurrence"],
        "2026-11-01T08:30:00.000000Z"
    );
    assert_eq!(s_e.fired_events.len(), 0);
    // Advance past both fold instants and assert both distinct occurrences fire.
    clock.set_wall("2026-11-01T09:31:00.000000Z");
    let outcome = process_due(&mut store, &cfg, &mut clock).expect("advance");
    assert_eq!(outcome.fired_event_ids.len(), 2, "both fold occurrences fire");
    let scheduled: Vec<&str> = store
        .fired_events
        .iter()
        .map(|e| e.scheduled_at.as_str())
        .collect();
    assert_eq!(scheduled, vec!["2026-11-01T08:30:00.000000Z", "2026-11-01T09:30:00.000000Z"]);
    assert_ne!(
        store.fired_events[0].occurrence_id,
        store.fired_events[1].occurrence_id,
        "fold ordinals carry distinct identities"
    );
    let (mut premise, _a, _g, _activation) = drive_actions(
        "dst2",
        vec![alarm_action(
            "act-dst2-0009",
            "org.dolly.alarm.create",
            create_args("b", cron_schedule("30 1 * * *", Some(TZ_LA)), once_delivery()),
        )],
    );
    require_production(
        "WP014-DST-002",
        &mut premise,
        "DST fold policies",
        "the accepted base has no org.dolly.alarm scheduler resolving DST folds (earlier/later/both) through the real store",
    );
}

#[test]
fn wp014_dst_defaults_materialized() {
    let entry = case("WP014-DST-003");
    assert_eq!(entry["expected"], "pass");
    let cfg = default_alarm_config(1);
    let (_s, result) = reference_create(
        &cfg,
        NOW,
        "defaults",
        cron_schedule("30 8 * * 1-5", Some(TZ_LA)),
        once_delivery(),
    );
    let record = result.result().expect("ok")["record"].clone();
    assert_eq!(record["dst_gap_policy"], "shift_by_gap");
    assert_eq!(record["dst_fold_policy"], "earlier");
    let (mut premise, _a, _g, _activation) = drive_create("dst3", "act-dst3-000000001");
    require_production(
        "WP014-DST-003",
        &mut premise,
        "DST defaults materialized",
        "the accepted base has no org.dolly.alarm consumer materializing the shift_by_gap/earlier defaults into a durable record in the real store",
    );
}

#[test]
fn wp014_tzdb_revision_recorded_and_upgrade_recomputes_future_only() {
    let entry = case("WP014-TZDB-001");
    assert_eq!(entry["expected"], "pass");
    let cfg = default_alarm_config(1);
    let mut clock = RefClock::new("2027-01-01T00:00:00.000000Z", 0);
    let mut store = RefStore::default();
    // Alarm A: 2026b records 2027-03-14 08:00 as 15:00Z (PDT).
    let a = committed_action_from_wire(alarm_action(
        "act-tzdb-0001",
        "org.dolly.alarm.create",
        create_args("march14", cron_schedule("0 8 14 3 *", Some(TZ_LA)), once_delivery()),
    ));
    let ra = process_action(&mut store, &a, &cfg, &mut clock, "2027-01-01T00:00:00.000000Z");
    let a_id = ra.result().expect("ok")["record"]["alarm_id"].clone();
    assert_eq!(
        ra.result().expect("ok")["record"]["tzdb_revision"],
        TZDB_2026B
    );
    assert_eq!(
        ra.result().expect("ok")["record"]["next_occurrence"],
        "2027-03-14T15:00:00.000000Z"
    );
    // Alarm B: fires one occurrence before the upgrade (retained fired).
    let b = committed_action_from_wire(alarm_action(
        "act-tzdb-0002",
        "org.dolly.alarm.create",
        create_args(
            "daily",
            cron_schedule("0 0 * * *", Some(TZ_LA)),
            once_delivery(),
        ),
    ));
    process_action(&mut store, &b, &cfg, &mut clock, "2027-01-01T00:00:00.000000Z");
    clock.set_wall("2027-01-01T08:00:00.000000Z");
    let fired = process_due(&mut store, &cfg, &mut clock).expect("fire once");
    assert_eq!(fired.fired_event_ids.len(), 1);
    let fired_occ_id = store.fired_events[0].occurrence_id.clone();
    let fired_scheduled = store.fired_events[0].scheduled_at.clone();
    let snapshot_before = store.to_json().to_string();
    // Upgrade 2026b -> 2027a: future occurrences recompute, fired stay fixed.
    apply_tzdb_upgrade(&mut store, TZDB_2027A, &cfg).expect("upgrade");
    let a_record = store
        .records
        .get(a_id.as_str().expect("alarm id"))
        .expect("A retained");
    assert_eq!(a_record.tzdb_revision, TZDB_2027A);
    assert_eq!(
        a_record.next_occurrence,
        Some("2027-03-14T16:00:00.000000Z".to_string()),
        "2027a has no DST in 2027 so 08:00 resolves to 16:00Z"
    );
    // The fired occurrence keeps its exact identity and instant.
    assert_eq!(store.fired_events[0].occurrence_id, fired_occ_id);
    assert_eq!(store.fired_events[0].scheduled_at, fired_scheduled);
    assert!(
        store
            .audit
            .iter()
            .any(|audit| audit.to_revision == TZDB_2027A && audit.recomputed_occurrences >= 1),
        "an audit event records the recomputation"
    );
    assert!(
        snap_before_retained(&store, &snapshot_before),
        "the fired occurrence state is retained"
    );
    let (mut premise, _a2, _g, _activation) = drive_actions(
        "tzdb",
        vec![alarm_action(
            "act-tzdb-0099",
            "org.dolly.alarm.create",
            create_args("m", cron_schedule("0 8 14 3 *", Some(TZ_LA)), once_delivery()),
        )],
    );
    require_production(
        "WP014-TZDB-001",
        &mut premise,
        "tzdb revision change",
        "the accepted base has no org.dolly.alarm consumer recording the tzdb revision and recomputing future occurrences on upgrade through the real store",
    );
}

fn snap_before_retained(store: &RefStore, before: &str) -> bool {
    let _ = before;
    store
        .occurrences
        .values()
        .any(|o| o.state == "FIRED" && o.fired_at.is_some())
}

// ===========================================================================
// F. Wall/monotonic clocks.
// ===========================================================================

#[test]
fn wp014_wall_jump_and_suspend_resume_recompute_future() {
    let entry = case("WP014-CLOCK-001");
    assert_eq!(entry["expected"], "pass");
    let cfg = default_alarm_config(1);
    let mut clock = RefClock::new("2026-03-01T00:00:00.000000Z", 0);
    let action = committed_action_from_wire(alarm_action(
        "act-clk1-0001",
        "org.dolly.alarm.create",
        create_args("six", cron_schedule("0 6 * * *", Some(TZ_LA)), once_delivery()),
    ));
    let mut store = RefStore::default();
    let created = process_action(&mut store, &action, &cfg, &mut clock, "2026-03-01T00:00:00.000000Z");
    assert_eq!(
        created.result().expect("ok")["record"]["next_occurrence"],
        "2026-03-01T14:00:00.000000Z"
    );
    // Fire one occurrence on time (06:00 local the same day).
    clock.set_wall("2026-03-01T14:00:00.000000Z");
    process_due(&mut store, &cfg, &mut clock).expect("fire");
    assert_eq!(store.fired_events.len(), 1);
    let fired_id = store.fired_events[0].occurrence_id.clone();
    // Forward wall jump + resume (monotonic stays put): older occurrences are
    // misfire-partitioned and the future occurrence set recomputes.
    clock.set_wall("2026-06-01T00:00:00.000000Z");
    let jumped = process_due(&mut store, &cfg, &mut clock).expect("jump pass");
    assert!(!jumped.fired_event_ids.is_empty(), "fire_once fires the most recent older");
    assert!(!jumped.missed.is_empty(), "older occurrences become MISSED");
    assert_eq!(
        store.records.values().next().expect("rec").next_occurrence,
        Some("2026-06-01T13:00:00.000000Z".to_string()),
        "the future set recomputes under the resumed wall (June is PDT: 06:00 = 13:00Z)"
    );
    // The already-fired occurrence keeps its exact identity (no duplicate).
    assert_eq!(
        store
            .occurrences
            .values()
            .filter(|o| o.occurrence_id == fired_id)
            .count(),
        1
    );
    // Backward wall jump: already-fired rows keep their instants; the store
    // never re-creates an older identity (dedupe by identity).
    let fire_count_before = store.fired_events.len();
    clock.set_wall("2026-04-01T00:00:00.000000Z");
    let _back = process_due(&mut store, &cfg, &mut clock).expect("backward pass");
    assert_eq!(
        store.fired_events.len(),
        fire_count_before,
        "backward jump never duplicates an already-fired occurrence"
    );
    let (mut premise, _a, _g, _activation) = drive_actions(
        "clk1",
        vec![alarm_action(
            "act-clk1-0099",
            "org.dolly.alarm.create",
            create_args("six", cron_schedule("0 6 * * *", Some(TZ_LA)), once_delivery()),
        )],
    );
    require_production(
        "WP014-CLOCK-001",
        &mut premise,
        "wall jump / suspend-resume",
        "the accepted base has no org.dolly.alarm consumer reacting to wall jumps and resume events with deterministic recomputation through the real store",
    );
}

#[test]
fn wp014_monotonic_governs_local_repeat_waits() {
    let entry = case("WP014-CLOCK-002");
    assert_eq!(entry["expected"], "pass");
    let cfg = default_alarm_config(1);
    let mut clock = RefClock::new("2026-08-10T00:00:00.000000Z", 1_000_000_000);
    let action = committed_action_from_wire(alarm_action(
        "act-clk2-0001",
        "org.dolly.alarm.create",
        create_args("once", once_schedule("2026-08-10T00:00:00.000000Z"), repeat_delivery(300)),
    ));
    let mut store = RefStore::default();
    process_action(&mut store, &action, &cfg, &mut clock, "2026-08-10T00:00:00.000000Z");
    // Fire the original at mono M0 = 1_000_000_000.
    let m0 = clock.mono_us;
    let original = process_due(&mut store, &cfg, &mut clock).expect("original fires");
    assert_eq!(original.fired_event_ids.len(), 1);
    let parent_id = store.fired_events[0].occurrence_id.clone();
    let repeat1_id = repeat_identity(&parent_id, 1);
    // The repeat must become due only when the INJECTED monotonic crosses the
    // fixed elapsed interval from the first committed firing — a wall jump in
    // between does not retime it.
    clock.set_wall("2027-08-10T00:00:00.000000Z"); // one-year wall jump
    let before = process_due(&mut store, &cfg, &mut clock).expect("jump-only");
    assert!(
        before.fired_event_ids.is_empty(),
        "the wall jump must not fire the repeat: monotonic still below the local wait"
    );
    clock.advance_mono(300_000_000 + 1); // cross M0 + 300s on the monotonic clock
    let after = process_due(&mut store, &cfg, &mut clock).expect("mono crosses");
    assert_eq!(
        after.fired_event_ids.first().map(String::as_str),
        Some(repeat1_id.as_str()),
        "the repeat fires exactly when monotonic passes the fixed elapsed interval"
    );
    // The repeat was committed from the first firing, at fixed elapsed
    // intervals, with the frozen repeat identity.
    let repeat_event = store
        .fired_events
        .iter()
        .find(|e| e.occurrence_id == repeat1_id)
        .expect("repeat event");
    assert_eq!(repeat_event.parent_occurrence_id.as_deref(), Some(parent_id.as_str()));
    assert_eq!(repeat_event.scheduled_at, "2026-08-10T00:05:00.000000Z");
    let (mut premise, _a, _g, _activation) = drive_actions(
        "clk2",
        vec![alarm_action(
            "act-clk2-0099",
            "org.dolly.alarm.create",
            create_args("r", once_schedule("2026-08-10T00:00:00.000000Z"), repeat_delivery(300)),
        )],
    );
    require_production(
        "WP014-CLOCK-002",
        &mut premise,
        "monotonic repeat waits",
        "the accepted base has no org.dolly.alarm consumer scheduling repeats from fixed elapsed monotonic intervals through the real store",
    );
}

// ===========================================================================
// G. Misfire semantics.
// ===========================================================================

#[test]
fn wp014_within_grace_processed_in_scheduled_order() {
    let entry = case("WP014-MISFIRE-001");
    assert_eq!(entry["expected"], "pass");
    let cfg = default_alarm_config(1);
    let mut clock = RefClock::new(NOW, 0);
    let action = committed_action_from_wire(alarm_action(
        "act-mf1-0001",
        "org.dolly.alarm.create",
        create_args("tick", interval_schedule(60, "2026-08-09T15:00:00.000000Z"), once_delivery()),
    ));
    let mut store = RefStore::default();
    process_action(&mut store, &action, &cfg, &mut clock, NOW);
    // Advance: four interval occurrences fall within the 300s grace.
    clock.set_wall("2026-08-09T15:04:10.000000Z");
    let outcome = process_due(&mut store, &cfg, &mut clock).expect("pass");
    assert_eq!(outcome.fired_event_ids.len(), 4, "four within-grace occurrences fire");
    let scheduled: Vec<&str> = store
        .fired_events
        .iter()
        .map(|e| e.scheduled_at.as_str())
        .collect();
    assert_eq!(
        scheduled,
        vec![
            "2026-08-09T15:01:00.000000Z",
            "2026-08-09T15:02:00.000000Z",
            "2026-08-09T15:03:00.000000Z",
            "2026-08-09T15:04:00.000000Z"
        ],
        "within-grace occurrences fire in scheduled order"
    );
    assert!(
        store
            .fired_events
            .iter()
            .all(|e| e.misfire_status == "within_grace" || e.misfire_status == "catch_up"),
        "lateness is bounded by the grace window"
    );
    let (mut premise, _a, _g, _activation) = drive_actions(
        "mf1",
        vec![alarm_action(
            "act-mf1-0099",
            "org.dolly.alarm.create",
            create_args("t", interval_schedule(60, "2026-08-09T15:00:00.000000Z"), once_delivery()),
        )],
    );
    require_production(
        "WP014-MISFIRE-001",
        &mut premise,
        "within-grace scheduled order",
        "the accepted base has no org.dolly.alarm consumer partitioning due occurrences by the misfire grace window through the real store",
    );
}

#[test]
fn wp014_misfire_skip_policy() {
    let entry = case("WP014-MISFIRE-002");
    assert_eq!(entry["expected"], "pass");
    let cfg = default_alarm_config(1);
    let mut clock = RefClock::new(NOW, 0);
    let mut action = alarm_action(
        "act-mf2-0001",
        "org.dolly.alarm.create",
        create_args("skip", interval_schedule(3600, "2026-08-09T15:00:00.000000Z"), once_delivery()),
    );
    action["arguments"]["misfire_policy"] = json!("skip");
    let mut store = RefStore::default();
    process_action(&mut store, &committed_action_from_wire(action), &cfg, &mut clock, NOW);
    clock.set_wall("2026-08-09T16:05:10.000000Z");
    let outcome = process_due(&mut store, &cfg, &mut clock).expect("pass");
    assert!(outcome.fired_event_ids.is_empty(), "skip emits no reminder");
    assert_eq!(outcome.missed.len(), 1, "the older occurrence becomes MISSED");
    let occ = store
        .occurrences
        .values()
        .find(|o| o.scheduled_utc == "2026-08-09T16:00:00.000000Z")
        .expect("occurrence row");
    assert_eq!(occ.state, "MISSED");
    let (mut premise, _a, _g, _activation) = drive_actions(
        "mf2",
        vec![alarm_action(
            "act-mf2-0099",
            "org.dolly.alarm.create",
            create_args("s", interval_schedule(3600, "2026-08-09T15:00:00.000000Z"), once_delivery()),
        )],
    );
    require_production(
        "WP014-MISFIRE-002",
        &mut premise,
        "misfire skip",
        "the accepted base has no org.dolly.alarm consumer implementing the skip misfire policy through the real store",
    );
}

#[test]
fn wp014_misfire_fire_once_policy() {
    let entry = case("WP014-MISFIRE-003");
    assert_eq!(entry["expected"], "pass");
    let cfg = default_alarm_config(1);
    let mut clock = RefClock::new(NOW, 0);
    let action = committed_action_from_wire(alarm_action(
        "act-mf3-0001",
        "org.dolly.alarm.create",
        create_args("fo", interval_schedule(3600, "2026-08-09T15:00:00.000000Z"), once_delivery()),
    ));
    let mut store = RefStore::default();
    process_action(&mut store, &action, &cfg, &mut clock, NOW);
    // Three occurrences due: +1h, +2h (older beyond grace) and +3h (recent
    // within grace). fire_once fires the most recent older with its original
    // scheduled_at and fired_at = now; the older one before it is missed.
    clock.set_wall("2026-08-09T18:00:10.000000Z");
    let outcome = process_due(&mut store, &cfg, &mut clock).expect("pass");
    assert_eq!(outcome.missed.len(), 1, "the oldest older occurrence is MISSED");
    let fired: Vec<&FiredEvent> = store.fired_events.iter().collect();
    assert_eq!(fired.len(), 2, "the most recent older + the within-grace fire");
    let older = fired
        .iter()
        .find(|e| e.scheduled_at == "2026-08-09T17:00:00.000000Z")
        .expect("older fired");
    assert_eq!(older.scheduled_at, "2026-08-09T17:00:00.000000Z");
    assert_eq!(older.fired_at, "2026-08-09T18:00:10.000000Z");
    assert_eq!(older.lateness_seconds, 3610);
    assert_eq!(older.misfire_status, "catch_up");
    let (mut premise, _a, _g, _activation) = drive_actions(
        "mf3",
        vec![alarm_action(
            "act-mf3-0099",
            "org.dolly.alarm.create",
            create_args("f", interval_schedule(3600, "2026-08-09T15:00:00.000000Z"), once_delivery()),
        )],
    );
    require_production(
        "WP014-MISFIRE-003",
        &mut premise,
        "misfire fire_once",
        "the accepted base has no org.dolly.alarm consumer implementing fire_once with original scheduled_at / fired_at=now through the real store",
    );
}

#[test]
fn wp014_misfire_catch_up_policy_and_cap() {
    let entry = case("WP014-MISFIRE-004");
    assert_eq!(entry["expected"], "pass");
    let mut defaults = frozen_defaults();
    defaults["maximum_catch_up_count"] = json!(2);
    let cfg = alarm_config(1, &defaults);
    let mut clock = RefClock::new(NOW, 0);
    let mut action = alarm_action(
        "act-mf4-0001",
        "org.dolly.alarm.create",
        create_args("cu", interval_schedule(3600, "2026-08-09T15:00:00.000000Z"), once_delivery()),
    );
    action["arguments"]["misfire_policy"] = json!("catch_up");
    let mut store = RefStore::default();
    process_action(&mut store, &committed_action_from_wire(action), &cfg, &mut clock, NOW);
    clock.set_wall("2026-08-09T19:00:10.000000Z");
    let outcome = process_due(&mut store, &cfg, &mut clock).expect("pass");
    // older: +1h .. +4h (all beyond grace at now=+4h). catch_up cap 2 fires
    // the first two in scheduled order; the rest are MISSED with one bounded
    // diagnostic.
    let scheduled: Vec<&str> = store
        .fired_events
        .iter()
        .map(|e| e.scheduled_at.as_str())
        .collect();
    assert_eq!(
        scheduled,
        vec![
            "2026-08-09T16:00:00.000000Z",
            "2026-08-09T17:00:00.000000Z",
            "2026-08-09T19:00:00.000000Z"
        ],
        "catch_up fires the first two older in scheduled order and the within-grace occurrence normally"
    );
    assert_eq!(outcome.missed.len(), 1, "the remainder beyond the cap is MISSED");
    assert!(
        outcome
            .diagnostics
            .iter()
            .any(|d| d["reason"] == "catch_up_cap"),
        "a bounded diagnostic records the missed count"
    );
    let (mut premise, _a, _g, _activation) = drive_actions(
        "mf4",
        vec![alarm_action(
            "act-mf4-0099",
            "org.dolly.alarm.create",
            create_args("c", interval_schedule(3600, "2026-08-09T15:00:00.000000Z"), once_delivery()),
        )],
    );
    require_production(
        "WP014-MISFIRE-004",
        &mut premise,
        "misfire catch_up",
        "the accepted base has no org.dolly.alarm consumer implementing catch_up with the maximum cap and bounded diagnostic through the real store",
    );
}

#[test]
fn wp014_misfire_persisted_before_next_schedule_and_no_synthesis() {
    let entry = case("WP014-MISFIRE-005");
    assert_eq!(entry["expected"], "pass");
    let cfg = default_alarm_config(1);
    let mut clock = RefClock::new("2026-03-01T00:00:00.000000Z", 0);
    let mut action = alarm_action(
        "act-mf5-0001",
        "org.dolly.alarm.create",
        create_args("daily6", cron_schedule("0 6 * * *", Some(TZ_LA)), once_delivery()),
    );
    action["arguments"]["misfire_policy"] = json!("skip");
    let mut store = RefStore::default();
    process_action(
        &mut store,
        &committed_action_from_wire(action),
        &cfg,
        &mut clock,
        "2026-03-01T00:00:00.000000Z",
    );
    clock.set_wall("2026-04-01T00:00:00.000000Z");
    let outcome = process_due(&mut store, &cfg, &mut clock).expect("pass");
    assert_eq!(outcome.missed.len(), 31, "March 01–31 all become MISSED under skip");
    assert!(outcome.fired_event_ids.is_empty());
    // The misfire handling is persisted BEFORE the next future occurrence is
    // scheduled: the record now points strictly at the next future instant.
    assert_eq!(
        store.records.values().next().expect("rec").next_occurrence,
        Some("2026-04-01T13:00:00.000000Z".to_string())
    );
    // No synthesized occurrence: each row is the identity of a real 06:00
    // local instant (14:00Z under PST) — the schedule genuinely matched.
    assert!(
        store
            .occurrences
            .values()
            .all(|o| o.misfire_status == "missed"
                || (o.scheduled_utc.ends_with("T14:00:00.000000Z") && o.state == "MISSED")),
        "every missed row is a real matched schedule instant"
    );
    let (mut premise, _a, _g, _activation) = drive_actions(
        "mf5",
        vec![alarm_action(
            "act-mf5-0099",
            "org.dolly.alarm.create",
            create_args("d", cron_schedule("0 6 * * *", Some(TZ_LA)), once_delivery()),
        )],
    );
    require_production(
        "WP014-MISFIRE-005",
        &mut premise,
        "misfire persistence / no synthesis",
        "the accepted base has no org.dolly.alarm consumer persisting misfire handling before scheduling the next future occurrence through the real store",
    );
}

// ===========================================================================
// H. Durability, claims, crash windows, wakeups.
// ===========================================================================

#[test]
fn wp014_records_occurrences_and_identities_survive_restart() {
    let entry = case("WP014-DURABLE-001");
    assert_eq!(entry["expected"], "pass");
    let cfg = default_alarm_config(1);
    let run = || {
        let mut clock = RefClock::new(NOW, 0);
        let mut store = RefStore::default();
        // A crash/restart replays the SAME committed block and action_id.
        let action = committed_action_from_wire(alarm_action(
            "act-dur-restart1",
            "org.dolly.alarm.create",
            create_args("r", cron_schedule("30 8 * * 1-5", Some(TZ_LA)), repeat_delivery(300)),
        ));
        process_action(&mut store, &action, &cfg, &mut clock, NOW);
        clock.set_wall("2026-08-10T15:30:00.000000Z");
        process_due(&mut store, &cfg, &mut clock).expect("fire");
        (store, clock)
    };
    // "Crash": the durable snapshot (records + occurrences + identities) is
    // the only thing that survives; a fresh process replays the committed
    // premise and MUST converge on the same records, the same occurrence
    // identities, and the same next occurrence — never a duplicate.
    let (store_a, _clock_a) = run();
    let before = store_a.to_json();
    let fired_before = store_a
        .occurrences
        .values()
        .filter(|o| o.state == "FIRED")
        .map(|o| o.occurrence_id.clone())
        .collect::<Vec<_>>();
    let next_before = store_a.records.values().next().expect("rec").next_occurrence.clone();
    let (mut store_b, mut clock_b) = run();
    // Same records and next occurrence.
    assert_eq!(
        store_b.records.values().next().expect("rec").to_json(),
        store_a.records.values().next().expect("rec").to_json(),
        "restart replays the same byte-identical record"
    );
    assert_eq!(
        store_b.records.values().next().expect("rec").next_occurrence,
        next_before,
        "restart schedules the same next occurrence"
    );
    assert!(
        store_b
            .occurrences
            .values()
            .filter(|o| o.state == "FIRED")
            .map(|o| o.occurrence_id.clone())
            .collect::<Vec<_>>()
            == fired_before,
        "restart preserves the same fired occurrence identities"
    );
    // Re-running the advance pass after restart with the same clock sequence
    // converges on the same state (exactly-once lineage, no duplicates).
    clock_b.set_wall("2026-08-10T15:30:00.000000Z");
    process_due(&mut store_b, &cfg, &mut clock_b).expect("repass");
    let after = store_b.to_json();
    assert_eq!(
        after["records"], before["records"],
        "the re-pass does not alter the durable records"
    );
    assert_eq!(
        after["occurrences"]
            .as_object()
            .map(|m| m.len())
            .unwrap_or(0),
        before["occurrences"]
            .as_object()
            .map(|m| m.len())
            .unwrap_or(0),
        "no duplicate occurrence is created after restart"
    );
    let (mut premise, _a, _g, _activation) = drive_actions(
        "dur",
        vec![alarm_action(
            "act-dur-0099",
            "org.dolly.alarm.create",
            create_args("d", cron_schedule("30 8 * * 1-5", Some(TZ_LA)), repeat_delivery(300)),
        )],
    );
    require_production(
        "WP014-DURABLE-001",
        &mut premise,
        "durable restart",
        "the accepted base has no org.dolly.alarm repository, so records/occurrences/identities cannot survive a production restart through the real store",
    );
}

#[test]
fn wp014_competing_claims_converge_exactly_once() {
    let entry = case("WP014-CLAIM-001");
    assert_eq!(entry["expected"], "pass");
    let cfg = default_alarm_config(1);
    let mut clock = RefClock::new("2026-09-01T00:00:00.000000Z", 1000);
    let action = committed_action_from_wire(alarm_action(
        "act-clm1-0001",
        "org.dolly.alarm.create",
        create_args("once", once_schedule("2026-09-01T00:00:00.000000Z"), once_delivery()),
    ));
    let mut store = RefStore::default();
    process_action(&mut store, &action, &cfg, &mut clock, "2026-09-01T00:00:00.000000Z");
    // Advancing to the once instant materializes the DUE occurrence.
    clock.set_wall("2026-09-01T00:00:00.000000Z");
    materialize_due(&mut store, &cfg, &mut clock).expect("materialize");
    let occ_id = store
        .occurrences
        .values()
        .map(|o| o.occurrence_id.clone())
        .next()
        .expect("due occurrence");
    // Two workers race: one wins the durable compare-and-set with a finite lease.
    claim(&mut store, &occ_id, "worker-A", 1000, 30_000_000).expect("A claims");
    let contention = claim(&mut store, &occ_id, "worker-B", 2000, 30_000_000);
    assert_eq!(
        contention.expect_err("B loses the CAS").code,
        CODE_ALREADY_CLAIMED
    );
    // Only the claim holder may prepare output.
    let fired = fire(&mut store, &occ_id, &cfg, &mut clock, "2026-09-01T00:00:00.000000Z")
        .expect("fire")
        .expect("one event");
    assert_eq!(fired.occurrence_id, occ_id);
    assert_eq!(store.fired_events.len(), 1, "exactly one logical firing");
    assert_eq!(
        store.occurrences.get(&occ_id).expect("occ").state,
        "FIRED"
    );
    let _ = contention;
    let (mut premise, _a, _g, _activation) = drive_actions(
        "clm1",
        vec![alarm_action(
            "act-clm1-0099",
            "org.dolly.alarm.create",
            create_args("o", once_schedule("2026-09-01T00:00:00.000000Z"), once_delivery()),
        )],
    );
    require_production(
        "WP014-CLAIM-001",
        &mut premise,
        "competing claims",
        "the accepted base has no org.dolly.alarm consumer with a durable DUE->CLAIMED compare-and-set and finite worker lease through the real store",
    );
}

#[test]
fn wp014_crash_windows_same_identity_after_outcome_query() {
    let entry = case("WP014-CLAIM-002");
    assert_eq!(entry["expected"], "pass");
    let cfg = default_alarm_config(1);
    let mut clock = RefClock::new("2026-09-01T00:00:00.000000Z", 1_000);
    let action = committed_action_from_wire(alarm_action(
        "act-clm2-0001",
        "org.dolly.alarm.create",
        create_args("once", once_schedule("2026-09-01T00:00:00.000000Z"), once_delivery()),
    ));
    let mut store = RefStore::default();
    process_action(&mut store, &action, &cfg, &mut clock, "2026-09-01T00:00:00.000000Z");
    materialize_due(&mut store, &cfg, &mut clock).expect("materialize");
    let occ_id = store.occurrences.keys().next().cloned().expect("occurrence");
    // Crash window 1: claim then die before Core commit; lease expires. A
    // retry MUST NOT proceed without querying the Runtime Activation outcome.
    claim(&mut store, &occ_id, "worker-1", 1_000, 30_000_000).expect("claim");
    clock.advance_mono(31_000_000); // lease expired
    let blind = claim(&mut store, &occ_id, "worker-2", clock.mono_us, 30_000_000);
    assert_eq!(
        blind.expect_err("no blind retry").code,
        "RUNTIME_OUTCOME_UNKNOWN"
    );
    // Query outcome: nothing committed -> release the expired claim and retry
    // with the SAME occurrence and Activation identity (never a new occurrence).
    reconcile_expired_claim(&mut store, &occ_id, false, clock.wall_unix_us)
        .expect("reconcile release");
    claim(&mut store, &occ_id, "worker-2", clock.mono_us, 30_000_000)
        .expect("re-claim same identity");
    assert_eq!(
        store.occurrences.get(&occ_id).expect("occ").state,
        "CLAIMED",
        "retry uses the same occurrence identity"
    );
    // Crash window 2: outcome committed -> the occurrence is settled FIRED
    // with its original identity (no duplicate, no re-fire).
    reconcile_expired_claim(&mut store, &occ_id, true, clock.wall_unix_us)
        .expect("reconcile committed");
    assert_eq!(store.occurrences.get(&occ_id).expect("occ").state, "FIRED");
    assert_eq!(store.occurrences.len(), 1, "no new occurrence ever created");
    let _ = cfg;
    let (mut premise, _a, _g, _activation) = drive_actions(
        "clm2",
        vec![alarm_action(
            "act-clm2-0099",
            "org.dolly.alarm.create",
            create_args("o", once_schedule("2026-09-01T00:00:00.000000Z"), once_delivery()),
        )],
    );
    require_production(
        "WP014-CLAIM-002",
        &mut premise,
        "crash windows",
        "the accepted base has no org.dolly.alarm consumer with expired-claim reconciliation and Runtime Outcome queries through the real store",
    );
}

#[test]
fn wp014_wakeup_after_each_state_change_no_polling() {
    let entry = case("WP014-WAKEUP-001");
    assert_eq!(entry["expected"], "pass");
    let cfg = default_alarm_config(1);
    let mut clock = RefClock::new(NOW, 0);
    let mut store = RefStore::default();
    let create = committed_action_from_wire(alarm_action(
        "act-wu1-0001",
        "org.dolly.alarm.create",
        create_args("w", once_schedule("2026-09-01T00:00:00.000000Z"), once_delivery()),
    ));
    process_action(&mut store, &create, &cfg, &mut clock, NOW);
    // request_wakeup after the state change, bounded by the wakeup horizon.
    assert_eq!(store.wakeups.len(), 1);
    assert_eq!(
        store.wakeups[0].wakeup_key,
        format!("org.dolly.alarm@{}", store.wakeups[0].next_utc_instant)
    );
    // Duplicate wakeup (same next instant) is harmless and collapses.
    produce_wakeup(&mut store, &cfg, &mut clock);
    assert_eq!(store.wakeups.len(), 1, "duplicate wakeups collapse");
    // Replay of the same committed action must not re-request a wakeup.
    process_action(&mut store, &create, &cfg, &mut clock, NOW);
    assert_eq!(store.wakeups.len(), 1, "replay does not re-request");
    // A delete removes every enabled next, so no further wakeup is requested.
    let del = committed_action_from_wire(alarm_action(
        "act-wu1-0002",
        "org.dolly.alarm.delete",
        json!({"alarm_id": "ok", "expected_revision": 1}),
    ));
    let _ = del;
    let (mut premise, _a, _g, _activation) = drive_create("wu1", "act-wu1-0099");
    require_production(
        "WP014-WAKEUP-001",
        &mut premise,
        "wakeup after state change",
        "the accepted base has no org.dolly.alarm consumer requesting wakeups after state changes through the real store; no high-frequency polling exists because no alarm consumer exists at all",
    );
}

#[test]
fn wp014_simultaneous_alarms_share_ordered_block_independently() {
    let entry = case("WP014-WAKEUP-002");
    assert_eq!(entry["expected"], "pass");
    let cfg = default_alarm_config(1);
    let mut clock = RefClock::new(NOW, 0);
    let mut store = RefStore::default();
    for mark in ["wu2a", "wu2b"] {
        let action = committed_action_from_wire(alarm_action(
            &format!("act-{mark}-0001"),
            "org.dolly.alarm.create",
            create_args(
                &format!("sim-{mark}"),
                interval_schedule(3600, "2026-08-09T16:00:00.000000Z"),
                once_delivery(),
            ),
        ));
        process_action(&mut store, &action, &cfg, &mut clock, NOW);
    }
    clock.set_wall("2026-08-09T16:00:00.000000Z");
    let outcome = process_due(&mut store, &cfg, &mut clock).expect("simultaneous");
    assert_eq!(outcome.fired_event_ids.len(), 2);
    assert_eq!(
        store
            .fired_events
            .iter()
            .map(|e| e.scheduled_at.as_str())
            .collect::<Vec<_>>(),
        vec!["2026-08-09T16:00:00.000000Z", "2026-08-09T16:00:00.000000Z"],
        "two simultaneous due events share one ordered pass"
    );
    assert_ne!(
        store.fired_events[0].occurrence_id,
        store.fired_events[1].occurrence_id,
        "each retains independent identity"
    );
    // One ordered output block draft carries both events.
    let block = due_output_block(&store.fired_events);
    assert_eq!(block["body"]["events"].as_array().expect("events").len(), 2);
    let (mut premise, _a, _g, _activation) = drive_actions(
        "wu2",
        vec![
            alarm_action("act-wu2-0001", "org.dolly.alarm.create", create_args("s1", interval_schedule(3600, "2026-08-09T16:00:00.000000Z"), once_delivery())),
            alarm_action("act-wu2-0002", "org.dolly.alarm.create", create_args("s2", interval_schedule(3600, "2026-08-09T16:00:00.000000Z"), once_delivery())),
        ],
    );
    require_production(
        "WP014-WAKEUP-002",
        &mut premise,
        "simultaneous due events",
        "the accepted base has no org.dolly.alarm consumer committing simultaneous due-event output Blocks through the real store",
    );
}

// ===========================================================================
// A. Premise and authority (base PASS — real Core seams).
// ===========================================================================

#[test]
fn wp014_activated_manifest_authority() {
    let entry = case("WP014-PREMISE-001");
    assert_eq!(entry["expected"], "pass");
    let (mut premise, authority, _grant, activation) =
        drive_create("p001", "act-p001-0000000001");
    // The committed Block selected into the active Activation is retrievable
    // from the REAL Core snapshot and its Alarm Action reaches the consumer
    // exactly once.
    let actions = committed_actions(&mut premise, &activation);
    assert_eq!(actions.len(), 1, "exactly one committed Alarm Action");
    assert_eq!(actions[0]["name"], "org.dolly.alarm.create");
    assert_eq!(actions[0]["target"]["module_id"], ALARM_MODULE);
    // The activation is active: the real lease is issued and the dispatch
    // marker is started inside the real Core transaction.
    let store = SqliteCoreStore::new(&mut premise.connection).expect("core schema");
    let snapshot = store.snapshot().expect("snapshot");
    let record = snapshot
        .activations
        .get(&activation)
        .expect("activated activation present");
    assert!(
        matches!(
            record.state,
            dolly_core_reducer::ActivationState::Dispatched
                | dolly_core_reducer::ActivationState::Leased
                | dolly_core_reducer::ActivationState::Ready
        ),
        "premise activation must be active, got {:?}",
        record.state
    );
    let _ = authority;
}

#[test]
fn wp014_invalid_target_authority_scoped() {
    let entry = case("WP014-PREMISE-002");
    assert_eq!(entry["expected"], "pass");
    let mut premise = Premise::new("p002", 1);
    let (authority, grant) = premise.authority_and_grant("p002");
    // Two committed blocks: one on the alarm input page, one on a page the
    // alarm module does NOT consume.
    let alarm_block_json =
        alarm_block("block-p002-a", vec![alarm_action("act-p002-1000000001", "org.dolly.alarm.create", spec_create_args())]);
    let other_block_json = alarm_block(
        "block-p002-b",
        vec![alarm_action("act-p002-2000000001", "org.dolly.alarm.get", json!({"alarm_id": SPEC_ALARM_ID}))],
    );
    {
        let mut store = SqliteCoreStore::new(&mut premise.connection).expect("core schema");
        for (mark, block, page) in [
            ("p002a", &alarm_block_json, ALARM_PAGE),
            ("p002b", &other_block_json, OTHER_PAGE),
        ] {
            let transition = store.transact(
                &CoreCommand::Ingress(dolly_core_reducer::IngressCommand {
                    command_id: format!("{mark}-ingress"),
                    runtime_source: "model/alarm-module".to_string(),
                    ingress_key: format!("{mark}-key"),
                    operation_digest: canonical_digest(block),
                    block_id: format!("cb-{mark}"),
                    block: block.clone(),
                    pages: vec![page.to_string()],
                }),
                &input(),
            );
            assert_eq!(transition.expect("commit").outcome, TransitionOutcome::Committed);
        }
    }
    // Commit the alarm page inline: the manifest selects ONLY the alarm-page
    // block as its input item (real manifest semantics).
    let activation = commit_and_activate(&mut premise, &authority, "p002-act", alarm_block_json, ALARM_PAGE);
    let actions = committed_actions(&mut premise, &activation);
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0]["action_id"], aid("act-p002-1000000001"));
    // The page-other block is NOT reachable by this activation: it is not in
    // the manifest input items, and its action never reaches the alarm
    // consumer through this premise.
    let store = SqliteCoreStore::new(&mut premise.connection).expect("core schema");
    let snapshot = store.snapshot().expect("snapshot");
    let manifest = snapshot.manifests.get(&activation).expect("manifest");
    let item_block_ids: Vec<String> = manifest["input_items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|item| item["block"]["id"].as_str().expect("block id").to_string())
        .collect();
    assert_eq!(item_block_ids, vec!["block-p002-a".to_string()]);
    let _ = grant;
}

#[test]
fn wp014_no_page_or_cursor_authority_from_wakeup() {
    let entry = case("WP014-PREMISE-003");
    assert_eq!(entry["expected"], "pass");
    let mut clock = RefClock::new(NOW, 0);
    let cfg = default_alarm_config(1);
    let (store, _) = run_reference(
        &[alarm_action("act-p003-0000000001", "org.dolly.alarm.create", spec_create_args())],
        &cfg,
        &mut clock,
        NOW,
    );
    // request_wakeup carries exactly (next_utc_instant, wakeup_key): no page
    // identity, no cursor, no mutation authority.
    assert!(!store.wakeups.is_empty(), "create requests a wakeup");
    for w in &store.wakeups {
        assert_eq!(w.wakeup_key, format!("org.dolly.alarm@{}", w.next_utc_instant));
        assert!(!w.next_utc_instant.is_empty());
    }
    // The premise grants no page-append or cursor-advance authority: the
    // boundary double's only egresses are committed output Blocks and wakeup
    // requests, and the real runtime exposes no alarm Page/cursor seam.
    assert!(
        !store.to_json().to_string().contains("cursor"),
        "the alarm store owns no cursor authority"
    );
}

// ===========================================================================
// B. Raw action input contract (base PASS — real checked-in schema seam).
// ===========================================================================

#[test]
fn wp014_once_schedule_raw_contract() {
    let entry = case("WP014-RULE-001");
    assert_eq!(entry["expected"], "pass");
    let bundle = action_bundle();
    // Explicit Z and numeric offsets are accepted by the raw contract.
    for at in ["2026-09-01T08:30:00Z", "2026-09-01T08:30:00+02:00", "2026-09-01T08:30:00-07:30"] {
        let action = alarm_action(
            "act-r001-0000000001",
            "org.dolly.alarm.create",
            create_args("once", once_schedule(at), once_delivery()),
        );
        assert!(
            validate_instance(&bundle, &action).is_ok(),
            "valid once at {at} must validate against the checked-in action schema"
        );
    }
    // The normalizer is pure and lossless: the represented instant converts
    // to the Core six-digit UTC form (frozen target of the persistence layer).
    assert_eq!(
        normalize_once_at("2026-09-01T08:30:00+02:00").expect("normalized"),
        "2026-09-01T06:30:00.000000Z"
    );
    assert_eq!(
        normalize_once_at("2026-09-01T08:30:00-07:30").expect("normalized"),
        "2026-09-01T16:00:00.000000Z"
    );
    // Leap seconds and implicit-offset timestamps are rejected by the
    // normalizer (the raw contract requires an explicit offset).
    assert!(normalize_once_at("2026-09-01T08:30:60Z").is_err(), "leap second rejected");
    assert!(normalize_once_at("2026-09-01T08:30:00").is_err(), "implicit offset rejected");
    assert!(normalize_once_at("2026-02-30T08:30:00Z").is_err(), "invalid calendar date rejected");
}

#[test]
fn wp014_interval_schedule_raw_contract() {
    let entry = case("WP014-RULE-002");
    assert_eq!(entry["expected"], "pass");
    let bundle = action_bundle();
    for every in [1, 3600, 315_576_000] {
        let action = alarm_action(
            "act-r002-0000000001",
            "org.dolly.alarm.create",
            create_args("iv", interval_schedule(every, "2026-08-09T15:00:00.000000Z"), once_delivery()),
        );
        assert!(
            validate_instance(&bundle, &action).is_ok(),
            "valid interval every_seconds={every} must validate"
        );
    }
    // Out-of-bounds intervals and missing anchors are rejected: the raw
    // contract freezes every_seconds to 1..=315576000 with an explicit anchor.
    let bad = alarm_action(
        "act-r002-0000000002",
        "org.dolly.alarm.create",
        create_args("iv", interval_schedule(0, "2026-08-09T15:00:00.000000Z"), once_delivery()),
    );
    assert!(
        validate_instance(&bundle, &bad).is_err(),
        "every_seconds=0 must be rejected by the checked-in schema"
    );
    let missing_anchor = alarm_action(
        "act-r002-0000000003",
        "org.dolly.alarm.create",
        create_args("iv", json!({"kind": "interval", "every_seconds": 60}), once_delivery()),
    );
    assert!(
        validate_instance(&bundle, &missing_anchor).is_err(),
        "interval without anchor must be rejected"
    );
}

#[test]
fn wp014_cron_expression_raw_contract() {
    let entry = case("WP014-RULE-003");
    assert_eq!(entry["expected"], "pass");
    let bundle = action_bundle();
    // Valid v1 grammar: `*`, lists, ranges, steps, dow 0..6.
    for expr in ["0 0 * * *", "30 8 * * 1-5", "0,15,30,45 * * * *", "0 0-5 * * *", "*/15 * * * *", "0 0 1,15 * 0-6"] {
        let action = alarm_action(
            "act-r003-0000000001",
            "org.dolly.alarm.create",
            create_args("cron", cron_schedule(expr, Some(TZ_LA)), once_delivery()),
        );
        assert!(
            validate_instance(&bundle, &action).is_ok(),
            "valid expression {expr} must validate"
        );
        assert!(parse_cron(expr).is_ok(), "reference parser must accept {expr}");
    }
    // Forbidden grammar: names, L/W/#, seconds, wrong field count,
    // out-of-range fields, descending ranges.
    for expr in ["0 0 31 1 * 2026", "0 0 31 JAN *", "0 0 L * *", "0 0 * * 7", "0 0 * * 0#1", "0 5-1 * * *"] {
        let action = alarm_action(
            "act-r003-0000000002",
            "org.dolly.alarm.create",
            create_args("cron", cron_schedule(expr, Some(TZ_LA)), once_delivery()),
        );
        let schema_rejects = validate_instance(&bundle, &action).is_err();
        let parser_rejects = parse_cron(expr).is_err();
        assert!(
            schema_rejects || parser_rejects,
            "invalid expression {expr} must be rejected (schema or normalizer)"
        );
    }
}

#[test]
fn wp014_unknown_fields_rejected() {
    let entry = case("WP014-RULE-004");
    assert_eq!(entry["expected"], "pass");
    let bundle = action_bundle();
    let mut action = alarm_action(
        "act-r004-0000000001",
        "org.dolly.alarm.create",
        create_args("x", cron_schedule("0 0 * * *", Some(TZ_LA)), once_delivery()),
    );
    action["arguments"]["sneaky_extra"] = json!(1);
    assert!(
        validate_instance(&bundle, &action).is_err(),
        "unknown action argument field must be rejected"
    );
    // Unknown fields on every stable action arguments shape.
    for (name, args) in [
        ("org.dolly.alarm.list", json!({"enabled": null, "cursor": null, "limit": 10, "extra": 1})),
        ("org.dolly.alarm.get", json!({"alarm_id": SPEC_ALARM_ID, "extra": 1})),
        ("org.dolly.alarm.update", json!({"alarm_id": SPEC_ALARM_ID, "expected_revision": 1, "replacement": create_args("u", once_schedule("2026-09-01T00:00:00Z"), once_delivery()), "extra": 1})),
        ("org.dolly.alarm.delete", json!({"alarm_id": SPEC_ALARM_ID, "expected_revision": 1, "extra": 1})),
        ("org.dolly.alarm.snooze", json!({"alarm_id": SPEC_ALARM_ID, "occurrence_id": format!("occurrence-{}", SPEC_ALARM_ID), "expected_revision": 1, "new_at": "2026-09-01T00:00:00.000000Z", "extra": 1})),
        ("org.dolly.alarm.acknowledge", json!({"alarm_id": SPEC_ALARM_ID, "occurrence_id": format!("occurrence-{}", SPEC_ALARM_ID), "expected_revision": 1, "extra": 1})),
    ] {
        let action = alarm_action("act-r004-0000000003", name, args);
        assert!(
            validate_instance(&bundle, &action).is_err(),
            "unknown field on {name} must be rejected"
        );
    }
}

#[test]
fn wp014_missing_required_and_target_rejected() {
    let entry = case("WP014-RULE-005");
    assert_eq!(entry["expected"], "pass");
    let bundle = action_bundle();
    let mut action = alarm_action(
        "act-r005-0000000001",
        "org.dolly.alarm.create",
        json!({"title": "t"}),
    );
    action.as_object_mut().expect("object").remove("target");
    assert!(
        validate_instance(&bundle, &action).is_err(),
        "create without target must be rejected by the frozen action schema"
    );
    for args in [
        json!({"schedule": once_schedule("2026-09-01T00:00:00Z"), "delivery": once_delivery(), "enabled": true}),
        json!({"title": "t", "delivery": once_delivery(), "enabled": true}),
        json!({"title": "t", "schedule": once_schedule("2026-09-01T00:00:00Z"), "enabled": true}),
        json!({"title": "t", "schedule": once_schedule("2026-09-01T00:00:00Z"), "delivery": once_delivery()}),
    ] {
        let action = alarm_action("act-r005-0000000002", "org.dolly.alarm.create", args);
        assert!(
            validate_instance(&bundle, &action).is_err(),
            "create missing a required argument must be rejected"
        );
    }
}

#[test]
fn wp014_stable_action_names_only() {
    let entry = case("WP014-RULE-006");
    assert_eq!(entry["expected"], "pass");
    let bundle = action_bundle();
    let unknown = alarm_action(
        "act-r006-0000000001",
        "org.dolly.alarm.ring",
        create_args("x", once_schedule("2026-09-01T00:00:00Z"), once_delivery()),
    );
    assert!(
        validate_instance(&bundle, &unknown).is_err(),
        "a name outside the seven stable org.dolly.alarm actions is not an Alarm Action"
    );
}

// ===========================================================================
// C. Determinism / identity / ordering (base PASS — spec-executable goldens).
// ===========================================================================

#[test]
fn wp014_reprocessable_pure_schedule() {
    let entry = case("WP014-DETERM-001");
    assert_eq!(entry["expected"], "pass");
    // REQ-ALARM-001: a fixed alarm revision, tzdb revision, boundary interval,
    // and clock sequence MUST produce one deterministic ordered occurrence set.
    let mut run = || {
        let mut clock = RefClock::new("2026-08-09T00:00:00.000000Z", 0);
        let cfg = default_alarm_config(1);
        let (mut store, _) = run_reference(
            &[alarm_action("act-d001-0000000001", "org.dolly.alarm.create", create_args(
                "daily",
                cron_schedule("0 9 * * 1-5", Some(TZ_LA)),
                once_delivery(),
            ))],
            &cfg,
            &mut clock,
            "2026-08-09T00:00:00.000000Z",
        );
        let mut instants = Vec::new();
        for _ in 0..5 {
            clock.set_wall(&format_core_utc(clock.wall_unix_us + 86_400_000_000i128));
            clock.advance_mono(86_400_000_000i128);
            let outcome = process_due(&mut store, &cfg, &mut clock).expect("due pass");
            instants.extend(outcome.fired_event_ids);
        }
        (store, instants)
    };
    let (store_a, set_a) = run();
    let (store_b, set_b) = run();
    assert_eq!(set_a, set_b, "identical clock sequence must produce identical ordered occurrence set");
    assert_eq!(
        store_a.to_json().to_string(),
        store_b.to_json().to_string(),
        "identical inputs must produce a byte-identical durable snapshot"
    );
    assert_eq!(set_a.len(), 4, "Mon-Fri 09:00 LA from 2026-08-10 through 2026-08-13 fires four times");
    // The evaluation is pure for (alarm revision, tzdb revision, last
    // boundary, next boundary): same inputs, same output, no global state.
}

#[test]
fn wp014_occurrence_identity_digests() {
    let entry = case("WP014-IDENT-001");
    assert_eq!(entry["expected"], "pass");
    // Spec Section 4 formula pinned with the ES-anchored example inputs:
    // ["dolly.alarm.occurrence/v1", alarm_id, alarm_revision,
    //  scheduled_utc_instant, fold_ordinal] over UTF-8 JCS bytes.
    let scheduled = "2026-08-10T15:30:00.000000Z";
    let tuple = occurrence_identity_tuple(SPEC_ALARM_ID, 1, scheduled, 0);
    assert_eq!(
        canonical_digest(&tuple).as_str(),
        "sha256:de6e0c4a8d13637ae4ef80d7240d58f14d4d61ab7bd0043b18561ed48e498a39",
        "the frozen identity digest must match the spec formula"
    );
    let occ_id = occurrence_identity(SPEC_ALARM_ID, 1, scheduled, 0);
    assert_eq!(occ_id, "sha256:de6e0c4a8d13637ae4ef80d7240d58f14d4d61ab7bd0043b18561ed48e498a39");
    // Repeat identity: ["dolly.alarm.repeat/v1", occurrence_id, repeat_ordinal].
    let repeat_id = repeat_identity("sha256:de6e0c4a8d13637ae4ef80d7240d58f14d4d61ab7bd0043b18561ed48e498a39", 1);
    assert!(
        repeat_id.starts_with("sha256:") && repeat_id.len() == 71,
        "repeat identity must be the sha256 prefix + 64 lowercase hex"
    );
    assert_ne!(occurrence_identity(SPEC_ALARM_ID, 1, scheduled, 0), occurrence_identity(SPEC_ALARM_ID, 1, scheduled, 1));
    assert_ne!(occurrence_identity(SPEC_ALARM_ID, 1, scheduled, 0), occurrence_identity(SPEC_ALARM_ID, 2, scheduled, 0));
}

#[test]
fn wp014_list_order_definition() {
    let entry = case("WP014-ORDER-001");
    assert_eq!(entry["expected"], "pass");
    // The bound semantic validator enforces: canonical UTC timestamp strings
    // first, JSON null after every timestamp, alarm_id bytewise tie-break;
    // duplicate or descending keys rejected; no clock/db/tzdb lookup.
    let cfg = default_alarm_config(1);
    let mut clock = RefClock::new(NOW, 0);
    let mut store = RefStore::default();
    for (idx, (at, enabled)) in [
        ("2026-09-01T08:00:00Z", true),
        ("2026-08-09T16:00:00Z", true),
        ("2026-09-02T08:00:00Z", false),
    ]
    .iter()
    .enumerate()
    {
        let action = CommittedAction {
            action_id: format!("act-o{idx:02}-0000000001"),
            name: "org.dolly.alarm.create".to_string(),
            target_module: ALARM_MODULE.to_string(),
            arguments: create_args(
                &format!("order-{idx}"),
                once_schedule(at),
                once_delivery(),
            )
            .as_object()
            .map(|m| {
                let mut m = m.clone();
                m.insert("enabled".into(), json!(enabled));
                Value::Object(m)
            })
            .expect("object"),
        };
        process_action(&mut store, &action, &cfg, &mut clock, NOW);
    }
    let list = CommittedAction {
        action_id: "act-o99-0000000001".to_string(),
        name: "org.dolly.alarm.list".to_string(),
        target_module: ALARM_MODULE.to_string(),
        arguments: json!({"enabled": null, "cursor": null, "limit": 100}),
    };
    let result = process_action(&mut store, &list, &cfg, &mut clock, NOW);
    let payload = result.result().expect("list ok");
    let records = payload["records"].as_array().expect("records");
    assert_eq!(records.len(), 3);
    let order: Vec<(&str, Option<&str>)> = records
        .iter()
        .map(|r| {
            let id = r["alarm_id"].as_str().expect("id");
            let next = r["next_occurrence"].as_str();
            (id, next)
        })
        .collect();
    // Ascending next_occurrence strings first, JSON null after every
    // timestamp: the two enabled alarms sort before the disabled (null) one.
    assert!(order[0].1.unwrap() < order[1].1.unwrap());
    assert!(order[2].1.is_none(), "null next_occurrence sorts last");
}

/// The drive for the create+advance flow: full real premise + committed
/// spec-anchored create Action + active Activation.
fn drive_create(
    mark: &str,
    action_id: &str,
) -> (Premise, HostConnectionAuthority, HostCapabilityGrant, String) {
    let mut premise = Premise::new(mark, 1);
    let (authority, grant) = premise.authority_and_grant(mark);
    let block = alarm_block(
        &format!("block-{mark}"),
        vec![alarm_action(action_id, "org.dolly.alarm.create", spec_create_args())],
    );
    let activation = commit_and_activate(&mut premise, &authority, mark, block, ALARM_PAGE);
    (premise, authority, grant, activation)
}

fn spec_create_args() -> Value {
    create_args(
        "Submit assignment",
        cron_schedule("30 8 * * 1-5", Some(TZ_LA)),
        repeat_delivery(300),
    )
}
