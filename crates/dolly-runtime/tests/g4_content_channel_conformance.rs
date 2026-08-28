//! Authoritative G4 conformance for the WP-010 Asset and WP-013A/013B
//! Channel content/channel substrate.
//!
//! This suite freezes the PRODUCT_RED/acceptance matrix for G4 without
//! implementing production behavior. The matrix fixture is the authoritative
//! document: every case names its expected outcome (`product_red`, `pass`, or
//! `blocked`), the stable interface seam it expects from Asset and Channel,
//! and the exact causal red when product behavior is missing.
//!
//! Executables here split into three groups:
//!
//! - fail-closed controls (`G4-CONTROL-*`, expected `pass`): negative
//!   authority and premise-direction properties already enforced by the
//!   accepted G1-G3 boundaries. They run against the current product and must
//!   stay green.
//! - product-red probes (`G4-WP010-*`, `G4-WP013A-*`, expected `product_red`):
//!   each first proves the harness is healthy (config install, graph install,
//!   durable Core ingress commit all succeed) and then asserts a WP-010/013A
//!   contract the current product does not provide, failing with an exact
//!   `PRODUCT_RED` message naming the seam. These are red until the product
//!   implements the seam, at which point the probe is rewritten to drive it.
//! - blocked declarations (`G4-WP013B-*`, `expected product_red` with
//!   `blocked: true`): retained in the matrix, asserted to be blocked, and
//!   never executed until WP-010 and WP-013A interfaces freeze.
//!
//! Premise direction is invariant: producer/upstream premise -> durable
//! explicit premise -> consumer/downstream only. There is no echo, reverse
//! authority, cross-Extension leakage, or opposite-direction premise; the
//! controls prove the Core transaction enforces that today.

use dolly_canonical_json::canonicalize;
use dolly_core_domain::{ActionName, ExtensionId};
use dolly_core_reducer::{
    CoreCommand, EnvironmentInput, IngressCommand, InstallConfigCommand, InstallGraphCommand,
    Transition, TransitionOutcome,
};
use dolly_storage::SqliteCoreStore;
use rusqlite::Connection;
use serde_json::{Value, json};

const MATRIX: &str = include_str!("fixtures/g4_content_channel_conformance.json");
const TARGET_PAGE: &str = "page-web-primary";

fn matrix() -> Value {
    serde_json::from_str(MATRIX).expect("G4 matrix fixture must be valid JSON")
}

fn case(id: &str) -> Value {
    matrix()["cases"]
        .as_array()
        .expect("G4 matrix cases must be an array")
        .iter()
        .find(|candidate| candidate["id"] == id)
        .cloned()
        .unwrap_or_else(|| panic!("G4 matrix case {id} is missing"))
}

fn canonical_digest(value: &Value) -> String {
    canonicalize(value)
        .expect("fixture value must be canonical JSON")
        .1
        .to_canonical_string()
}

fn input() -> EnvironmentInput {
    EnvironmentInput {
        now: "2026-08-28T00:00:00.000000Z".into(),
        ..Default::default()
    }
}

fn descriptor(module_id: &str) -> Value {
    json!({
        "schema": "dolly.module-descriptor/v1",
        "module_id": module_id,
        "descriptor_revision": 1,
        "display_name": module_id,
        "accepts": {"summary":"input","part_kinds":["text"],"action_names":[]},
        "emits": {"summary":"output","part_kinds":["text"],"action_names":["org.dolly.channel.send"]},
        "actions": [
            {
                "name": "org.dolly.channel.send",
                "summary": "send a message through the configured Channel transport"
            }
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

fn graph_snapshot(module_id: &str) -> Value {
    let descriptor = descriptor(module_id);
    let mut descriptors = serde_json::Map::new();
    descriptors.insert(
        module_id.into(),
        json!({
            "module_id": module_id,
            "descriptor_revision": 1,
            "source_descriptor_digest": canonical_digest(&descriptor),
            "value": descriptor
        }),
    );
    json!({
        "receiving_module": module_id,
        "input_pages": {"page-web-primary": ["web-channel"]},
        "output_pages": {},
        "subscriptions": {},
        "descriptors": descriptors,
        "authorized_metadata_namespaces": ["org.dolly.channel"],
        "authorized_action_names": ["org.dolly.channel.send"]
    })
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
    let command = CoreCommand::InstallConfig(InstallConfigCommand {
        command_id: format!("{mark}-config"),
        revision: 1,
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

fn install_graph(store: &mut SqliteCoreStore<'_>, module_id: &str, mark: &str) {
    let graph = graph_snapshot(module_id);
    let command = CoreCommand::InstallGraph(InstallGraphCommand {
        command_id: format!("{mark}-graph"),
        revision: 1,
        digest: canonical_digest(&graph),
        graph,
    });
    let transition = store
        .transact(&command, &input())
        .expect("graph transaction must execute");
    assert_eq!(
        transition.outcome,
        TransitionOutcome::Committed,
        "harness: graph install must commit"
    );
}

/// One fresh in-memory Core connection with config and graph installed.
/// Every probe starts from this proven-healthy harness base so that a later
/// `PRODUCT_RED` is causally attributable to the missing product seam.
fn probe_connection(module_id: &str, mark: &str) -> Connection {
    let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
    {
        let mut store = SqliteCoreStore::new(&mut connection).expect("core schema");
        install_config(&mut store, mark);
        install_graph(&mut store, module_id, mark);
    }
    connection
}

fn transact_ingress(
    connection: &mut Connection,
    source: &str,
    key: &str,
    operation_digest: &str,
    block_id: &str,
    block: Value,
    pages: Vec<String>,
    command_id: &str,
) -> Transition {
    let mut store = SqliteCoreStore::new(connection).expect("core schema");
    store
        .transact(
            &CoreCommand::Ingress(IngressCommand {
                command_id: command_id.into(),
                runtime_source: source.into(),
                ingress_key: key.into(),
                operation_digest: operation_digest.into(),
                block_id: block_id.into(),
                block,
                pages,
            }),
            &input(),
        )
        .expect("ingress transaction must execute")
}

/// The exact causal red: every harness step succeeded; only the missing
/// product behavior named by the seam turns the case red.
fn product_red(case_id: &str, seam: &str, cause: &str, area: &str) -> ! {
    panic!(
        "PRODUCT_RED [{case_id}] seam={seam} cause={cause} area={area}; \
         every harness step above (config install, graph install, durable Core \
         ingress commit) succeeded, so this failure is causal to the missing \
         product behavior, not a harness, build, or environment failure"
    )
}

fn text_block(message: &str) -> Value {
    json!({
        "schema": "dolly.block/v1",
        "parts": [{"kind": "text", "text": message, "format": "plain"}]
    })
}

fn channel_metadata_block(message: &str) -> Value {
    json!({
        "schema": "dolly.block/v1",
        "parts": [{"kind": "text", "text": message, "format": "plain"}],
        "metadata": {
            "org.dolly.channel": {
                "channel_id": "web-primary",
                "transport": "web",
                "session_id": "session-main",
                "external_conversation_id": "opaque-redacted-id",
                "external_message_id": "ext-msg-42",
                "sender_class": "user",
                "received_at": "2026-08-28T00:00:00.000000Z",
                "event_kind": "message"
            }
        }
    })
}

fn asset_input_draft(media_type: &str, base64_payload: &str, domain: &str) -> Value {
    json!({
        "schema": "dolly.block/v1",
        "parts": [],
        "asset_input": {
            "source_kind": "inline_base64",
            "media_type": media_type,
            "base64": base64_payload,
            "import_id": "0198ab31-6c44-7e8a-b2bb-000000000201",
            "max_bytes": 1048576,
            "security_domain": domain
        }
    })
}

fn assert_harness_committed(transition: &Transition) {
    assert_eq!(
        transition.outcome,
        TransitionOutcome::Committed,
        "harness: durable ingress commit must succeed before the seam probe"
    );
    assert!(
        transition.state.blocks.values().next().is_some(),
        "harness: the committed block must be durable in the Core snapshot"
    );
}

// ---------------------------------------------------------------------------
// Matrix retention: the authoritative document stays canonical.
// ---------------------------------------------------------------------------

#[test]
fn g4_matrix_retains_all_declared_cases_and_causal_classification() {
    let document = matrix();
    assert_eq!(document["schema"], "dolly.g4-content-channel-conformance/v1");
    assert!(
        !document["spec_basis"].as_array().expect("spec_basis").is_empty(),
        "matrix must name its normative spec basis"
    );

    let source_boundary = &document["source_boundary"];
    assert_eq!(source_boundary["g1_fixture"], "crates/dolly-runtime/tests/fixtures/g1_runtime_conformance.json");
    assert_eq!(source_boundary["g1_case"], "G1-EXEC-001");
    assert_eq!(source_boundary["g2_fixture"], "crates/dolly-runtime/tests/fixtures/g2_extension_host_sdk_conformance.json");
    assert_eq!(source_boundary["g2_case"], "G2-ADMISSION-001");
    assert!(
        source_boundary["handoff"]
            .as_str()
            .expect("handoff")
            .contains("WP-010 Asset and WP-013A/013B Channel seams")
    );
    assert!(
        source_boundary["authority"]
            .as_str()
            .expect("authority")
            .contains("Core remains the only authority")
    );
    assert_eq!(
        source_boundary["effect_boundary"],
        "before Asset import, host.ingress.submit, and outbound Channel effects"
    );

    let classification = &document["classification"];
    for expected in ["product_red", "pass", "blocked"] {
        assert!(
            classification[expected]
                .as_str()
                .expect("classification entry")
                .len()
                > 30,
            "classification must explain {expected}"
        );
    }

    let cases = document["cases"].as_array().expect("cases");
    let mut ids = std::collections::BTreeSet::new();
    for entry in cases {
        let id = entry["id"].as_str().expect("case id");
        assert!(ids.insert(id.to_owned()), "duplicate G4 case id {id}");
        assert!(!entry["name"].as_str().expect("case name").is_empty());
        assert!(
            entry["kind"].as_str().expect("case kind").len() >= 4,
            "case {id} must carry a kind"
        );
        let expected = entry["expected"].as_str().expect("case expected");
        assert!(
            expected == "product_red" || expected == "pass",
            "case {id}: expected must be product_red or pass, got {expected}"
        );
        if expected == "product_red" {
            assert!(
                entry["seam"].as_str().expect("seam").len() > 20,
                "case {id} must name the stable interface seam expected from Asset and Channel"
            );
            assert!(
                entry["causal_red"].as_str().expect("causal_red").len() > 20,
                "case {id} must state the exact causal red"
            );
            if entry["blocked"].as_bool().unwrap_or(false) {
                let reason = entry["blocked_reason"].as_str().expect("blocked_reason");
                assert!(
                    reason.contains("not frozen"),
                    "case {id}: blocked_reason must require frozen interfaces"
                );
                assert!(
                    entry["unblocked_when"].as_array().expect("unblocked_when").len() >= 1,
                    "case {id}: blocked cases must name the unblock conditions"
                );
            }
        } else {
            let references = entry["references"]
                .as_array()
                .expect("pass control must reference existing tests");
            assert!(!references.is_empty(), "case {id}: pass control needs references");
        }
    }

    let evidence = document["evidence"].as_object().expect("evidence");
    assert!(!evidence.is_empty(), "matrix must declare its evidence coverage");
    for (area, case_ids) in evidence {
        let case_ids = case_ids.as_array().expect("evidence case ids");
        assert!(!case_ids.is_empty(), "evidence area {area} has no cases");
        for case_id in case_ids {
            let case_id = case_id.as_str().expect("evidence case id");
            assert!(ids.contains(case_id), "evidence area {area} references undeclared case {case_id}");
        }
    }

    // Every declared evidence area requested by the gate is present.
    for required in [
        "wp010_import_bound_and_crash_recovery",
        "wp010_canonical_identity_and_dedup",
        "wp010_mime_and_security_refusal",
        "wp010_leases_and_gc",
        "wp010_replicas_and_domain_isolation",
        "wp013a_authenticated_text_round_trip",
        "wp013a_ingress_reconciliation",
        "wp013a_authorization",
        "wp013a_replay_and_idempotency",
        "wp013a_unknown_and_partial_outbound",
        "wp013a_backpressure",
        "wp013a_redaction",
        "wp013a_no_direct_page_or_cursor_mutation",
        "wp013b_asset_import_and_send_seam",
        "wp013b_mime_lease_media_abuse_round_trip",
        "premise_direction_controls",
    ] {
        assert!(
            evidence.contains_key(required),
            "matrix must cover evidence area {required}"
        );
    }
}

#[test]
fn g4_matrix_retains_all_declared_controls() {
    for entry in matrix()["cases"].as_array().expect("cases") {
        if entry["expected"] == "pass" {
            let id = entry["id"].as_str().expect("control id");
            assert!(
                id.starts_with("G4-CONTROL-"),
                "control {id} must use the G4-CONTROL- prefix"
            );
            let assertion = entry["assertion"].as_str().expect("control assertion");
            assert!(
                assertion.len() > 20,
                "control {id} must state its executable assertion"
            );
        }
    }
}

#[test]
fn g4_wp013b_multimodal_cases_remain_blocked_until_interfaces_freeze() {
    for id in [
        "G4-WP013B-ASSET-SEND-SEAM-001",
        "G4-WP013B-MIME-LEASE-001",
        "G4-WP013B-MEDIA-ABUSE-001",
    ] {
        let entry = case(id);
        assert_eq!(entry["expected"], "product_red");
        assert_eq!(
            entry["blocked"], true,
            "WP-013B case {id} must remain blocked while WP-010 and WP-013A are not frozen"
        );
        let reason = entry["blocked_reason"].as_str().expect("blocked_reason");
        assert!(
            reason.contains("WP-010") && reason.contains("WP-013A"),
            "case {id}: blocked_reason must name both prerequisite work packages"
        );
        let unblocked = entry["unblocked_when"].as_array().expect("unblocked_when");
        for condition in unblocked {
            let condition = condition.as_str().expect("unblock condition");
            assert!(
                condition.starts_with("G4-WP010-") || condition.starts_with("G4-WP013A-"),
                "case {id}: unblock condition {condition} must be a frozen WP-010/013A case"
            );
        }
        // No executable body may run for a blocked seam; the seam is declared
        // only in the matrix.
    }
}

// ---------------------------------------------------------------------------
// Fail-closed controls (expected pass): premise direction and authority.
// ---------------------------------------------------------------------------

#[test]
fn g4_control_premise_direction_is_durable_explicit_and_never_reversible() {
    let entry = case("G4-CONTROL-PREMISE-DIRECTION-001");
    assert_eq!(entry["expected"], "pass");

    let mut connection = probe_connection("web-channel", "g4-premise");
    let block = text_block("Hello.");
    let digest = canonical_digest(&block);

    let first = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &digest,
        "g4-premise-block",
        block.clone(),
        vec![TARGET_PAGE.into()],
        "g4-premise-1",
    );
    assert_eq!(first.outcome, TransitionOutcome::Committed);
    let ingress_identity = "channel-web\0ext-42";
    assert_eq!(
        first.state.ingress[ingress_identity].block_id, "g4-premise-block",
        "producer premise must resolve to its durable block"
    );
    assert!(
        first.state.blocks.contains_key("g4-premise-block"),
        "the committed block is the durable explicit premise consumers see"
    );

    // Identical replay returns the prior mapping and emits nothing new.
    let replay = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &digest,
        "g4-premise-block",
        block.clone(),
        vec![TARGET_PAGE.into()],
        "g4-premise-2",
    );
    assert_eq!(replay.outcome, TransitionOutcome::Committed);
    assert_eq!(
        replay.reply,
        Some(json!({"block_id": "g4-premise-block", "idempotent": true}))
    );
    assert!(replay.events.is_empty(), "replay must not re-emit an event");

    // A different digest under the same key is a conflict, never an overwrite:
    // there is no reverse authority to replace a committed premise.
    let tampered = text_block("Tampered.");
    let tampered_digest = canonical_digest(&tampered);
    let conflict = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &tampered_digest,
        "g4-premise-block-tampered",
        tampered,
        vec![TARGET_PAGE.into()],
        "g4-premise-3",
    );
    assert_eq!(conflict.outcome, TransitionOutcome::RolledBack);
    let error = conflict.error.expect("conflict must carry a Core error");
    assert_eq!(error.code, "STORAGE_IDEMPOTENCY_CONFLICT");
    assert!(
        conflict.state.blocks.contains_key("g4-premise-block"),
        "the committed premise survives the conflict attempt"
    );
    assert!(
        !conflict.state.blocks.contains_key("g4-premise-block-tampered"),
        "the conflicting block must not be committed"
    );

    // The premise is durable: a fresh store over the same connection still
    // resolves the producer key to the committed mapping.
    {
        let reopened = SqliteCoreStore::new(&mut connection).expect("reopened core schema");
        let snapshot = reopened.snapshot().expect("reopened snapshot");
        assert_eq!(
            snapshot.ingress[ingress_identity].block_id, "g4-premise-block",
            "the durable explicit premise must survive a store reopen"
        );
    }
}

#[test]
fn g4_control_ingress_keys_are_producer_scoped_without_echo_collision() {
    let entry = case("G4-CONTROL-SOURCE-SCOPED-001");
    assert_eq!(entry["expected"], "pass");

    let mut connection = probe_connection("web-channel", "g4-scoped");
    let web_block = channel_metadata_block("from web");
    let cli_block = channel_metadata_block("from cli");

    let web = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &canonical_digest(&web_block),
        "g4-scoped-web-block",
        web_block.clone(),
        vec![TARGET_PAGE.into()],
        "g4-scoped-web",
    );
    assert_eq!(web.outcome, TransitionOutcome::Committed);
    let cli = transact_ingress(
        &mut connection,
        "channel-cli",
        "ext-42",
        &canonical_digest(&cli_block),
        "g4-scoped-cli-block",
        cli_block.clone(),
        vec![TARGET_PAGE.into()],
        "g4-scoped-cli",
    );
    assert_eq!(cli.outcome, TransitionOutcome::Committed);

    // Same external key under two producers are independent records; there is
    // no echo: replaying the web key returns only the web mapping.
    let snapshot = {
        let store = SqliteCoreStore::new(&mut connection).expect("core schema");
        store.snapshot().expect("snapshot")
    };
    assert_eq!(snapshot.ingress.len(), 2, "producer-scoped keys must not collide");
    assert_eq!(snapshot.ingress["channel-web\0ext-42"].block_id, "g4-scoped-web-block");
    assert_eq!(snapshot.ingress["channel-cli\0ext-42"].block_id, "g4-scoped-cli-block");

    let web_replay = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &canonical_digest(&web_block),
        "g4-scoped-web-block",
        web_block.clone(),
        vec![TARGET_PAGE.into()],
        "g4-scoped-web-replay",
    );
    assert_eq!(
        web_replay.reply,
        Some(json!({"block_id": "g4-scoped-web-block", "idempotent": true})),
        "replaying one producer must return only that producer's prior mapping"
    );
}

#[test]
fn g4_control_action_names_are_owner_fenced_against_cross_extension_forgery() {
    let entry = case("G4-CONTROL-ACTION-OWNER-001");
    assert_eq!(entry["expected"], "pass");

    let channel = ExtensionId::from_string("org.dolly.channel".into()).expect("channel extension id");
    let other = ExtensionId::from_string("org.example.other".into()).expect("other extension id");

    let send = ActionName::parse_for_owner(&channel, "org.dolly.channel.send")
        .expect("the Channel owns org.dolly.channel.send");
    assert_eq!(send.as_str(), "org.dolly.channel.send");
    assert_eq!(send.owner().as_str(), "org.dolly.channel");

    // A cross-extension forgery cannot even be constructed with the Channel's
    // owner: parse_for_owner binds the exact owner prefix.
    assert!(
        ActionName::parse_for_owner(&other, "org.dolly.channel.send").is_err(),
        "another Extension must not construct the Channel action name"
    );
    assert!(
        ActionName::parse_for_owner(&channel, "org.example.other.send").is_err(),
        "the Channel must not construct another Extension's action name"
    );
    assert!(
        ActionName::parse_for_owner(&channel, "org.dolly.channel").is_err(),
        "an action name requires an operation label after the owner"
    );
}

#[test]
fn g4_control_core_catalog_has_no_third_party_page_or_cursor_mutation() {
    let entry = case("G4-CONTROL-NO-DIRECT-MUTATION-001");
    assert_eq!(entry["expected"], "pass");

    // The exhaustive match is the durable binding: the Core transaction
    // catalog is exactly this set, and none of its variants is a direct
    // page-append or Module-cursor-advance command reachable by a third party.
    fn catalog_binding(command: &CoreCommand) -> &'static str {
        match command {
            CoreCommand::InstallConfig(_) => "config",
            CoreCommand::InstallGraph(_) => "graph",
            CoreCommand::Ingress(_) => "external_draft:block_publication",
            CoreCommand::RuntimeEvent(_) => "host_event:block_publication",
            CoreCommand::GrantStorageWriter(_) => "storage_authority",
            CoreCommand::ReleaseStorageWriter(_) => "storage_authority",
            CoreCommand::BuildManifest(_) => "activation:premise",
            CoreCommand::IssueLease(_) => "activation:lease",
            CoreCommand::DispatchLease(_) => "activation:lease",
            CoreCommand::ReceiveResult(_) => "activation:result",
            CoreCommand::BeginFence(_) => "activation:fence",
            CoreCommand::RecordReplayEvidence(_) => "activation:replay_evidence",
            CoreCommand::FenceComplete(_) => "activation:fence",
            CoreCommand::ApplyResult(_) => "activation:result_commit",
            CoreCommand::CancelActivation(_) => "activation:cancel",
            CoreCommand::ResolveQuarantine(_) => "activation:quarantine",
            CoreCommand::CompleteQuarantineFence(_) => "activation:quarantine",
            CoreCommand::DeadLetterRange(_) => "delivery:dead_letter",
            CoreCommand::SkipRange(_) => "delivery:skip",
            CoreCommand::LossyEvict(_) => "delivery:lossy_evict",
            CoreCommand::Recover(_) => "recovery",
        }
    }

    let samples = [
        CoreCommand::InstallConfig(InstallConfigCommand {
            command_id: "c".into(),
            revision: 1,
            effective_config: json!({}),
            digest: String::new(),
        }),
        CoreCommand::Ingress(IngressCommand {
            command_id: "c".into(),
            runtime_source: "s".into(),
            ingress_key: "k".into(),
            operation_digest: "d".into(),
            block_id: "b".into(),
            block: json!({}),
            pages: vec![],
        }),
    ];
    for command in &samples {
        let binding = catalog_binding(command);
        assert!(
            binding != "page_append" && binding != "cursor_advance",
            "catalog must contain no direct page or cursor mutation"
        );
    }

    // External drafts reach a Page only through block publication, never by
    // mutating Page or cursor records directly.
    let mut connection = probe_connection("web-channel", "g4-nodirect");
    let transition = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &canonical_digest(&text_block("Hello.")),
        "g4-nodirect-block",
        text_block("Hello."),
        vec![TARGET_PAGE.into()],
        "g4-nodirect",
    );
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
    let snapshot = {
        let store = SqliteCoreStore::new(&mut connection).expect("core schema");
        store.snapshot().expect("snapshot")
    };
    assert!(snapshot.blocks.contains_key("g4-nodirect-block"));
    assert!(
        snapshot.deliveries.iter().any(|delivery| {
            delivery["block_id"] == "g4-nodirect-block" && delivery["page_id"] == TARGET_PAGE
        }),
        "the block, not a Page handle, is what carries the draft to the consumer"
    );
}

#[test]
fn g4_control_block_bytes_stay_untrusted_until_a_core_asset_authority_exists() {
    let entry = case("G4-CONTROL-ASSET-UNTRUSTED-001");
    assert_eq!(entry["expected"], "pass");

    let mut connection = probe_connection("web-channel", "g4-untrusted");
    let draft = asset_input_draft("image/png", "aW1hZ2UtYnl0ZXM=", "personal");
    let transition = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &canonical_digest(&draft),
        "g4-untrusted-block",
        draft.clone(),
        vec![TARGET_PAGE.into()],
        "g4-untrusted",
    );
    assert_eq!(transition.outcome, TransitionOutcome::Committed);

    // The asset_input bytes ride verbatim as untrusted Block content: no
    // ImportId result, no content-hash Asset record, no availability claim,
    // and no asset/pin/replica store in the durable snapshot.
    let committed = &transition.state.blocks["g4-untrusted-block"];
    assert_eq!(
        committed["asset_input"]["base64"], "aW1hZ2UtYnl0ZXM=",
        "harness: the draft bytes are persisted verbatim"
    );
    assert!(
        committed.get("asset_id").is_none(),
        "no AssetId may be minted from block content"
    );
    assert_eq!(
        transition.reply,
        Some(json!({"block_id": "g4-untrusted-block", "idempotent": false})),
        "the only durable reply today is the ingress mapping"
    );
    let snapshot_value = serde_json::to_value(&transition.state).expect("snapshot JSON");
    for absent in ["imports", "asset_records", "assets", "asset_views", "pins", "replicas"] {
        assert!(
            snapshot_value.get(absent).is_none(),
            "the durable snapshot must not fabricate an {absent} store before WP-010"
        );
    }
}

// ---------------------------------------------------------------------------
// WP-010 Asset product-red probes.
// ---------------------------------------------------------------------------

#[test]
fn g4_wp010_bounded_import_and_crash_recovery_round_trip() {
    let entry = case("G4-WP010-IMPORT-BOUND-001");
    assert_eq!(entry["expected"], "product_red");
    let seam = entry["seam"].as_str().expect("seam");

    let mut connection = probe_connection("web-channel", "g4-import-bound");
    let draft = asset_input_draft("image/png", "aW1hZ2UtYnl0ZXM=", "personal");
    let transition = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &canonical_digest(&draft),
        "g4-import-bound-block",
        draft.clone(),
        vec![TARGET_PAGE.into()],
        "g4-import-bound",
    );
    assert_harness_committed(&transition);
    assert_eq!(
        transition.state.blocks["g4-import-bound-block"]["asset_input"]["source_kind"],
        "inline_base64",
        "harness: the draft arrives at the only durable route that exists"
    );

    product_red(
        "G4-WP010-IMPORT-BOUND-001",
        seam,
        "the only durable route is CoreCommand::Ingress, which commits the block verbatim with a caller-chosen block_id; there is no ImportId persisted ACCEPTED before acquisition, no byte bound, no private staging object, no AVAILABLE gate, and no crash restart from ACCEPTED",
        "WP-010 Asset import",
    );
}

#[test]
fn g4_wp010_canonical_identity_and_dedup_are_core_authority_only() {
    let entry = case("G4-WP010-IDENTITY-DEDUP-001");
    assert_eq!(entry["expected"], "product_red");
    let seam = entry["seam"].as_str().expect("seam");

    let mut connection = probe_connection("web-channel", "g4-identity");
    let draft = asset_input_draft("image/png", "aW1hZ2UtYnl0ZXM=", "personal");
    let first = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &canonical_digest(&draft),
        "g4-identity-block-1",
        draft.clone(),
        vec![TARGET_PAGE.into()],
        "g4-identity-1",
    );
    assert_harness_committed(&first);
    let second = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-43",
        &canonical_digest(&draft),
        "g4-identity-block-2",
        draft.clone(),
        vec![TARGET_PAGE.into()],
        "g4-identity-2",
    );
    assert_harness_committed(&second);
    assert!(
        first.state.blocks.contains_key("g4-identity-block-1")
            && second.state.blocks.contains_key("g4-identity-block-2"),
        "harness: identical accepted bytes can be committed twice as distinct blocks"
    );

    product_red(
        "G4-WP010-IDENTITY-DEDUP-001",
        seam,
        "there is no ast_b3_ AssetId minting authority and no content-addressed import record, so identical accepted bytes within one security domain cannot resolve to a single AssetId and deduplication is unverifiable",
        "WP-010 Asset identity",
    );
}

#[test]
fn g4_wp010_mime_and_security_refusal_precede_availability() {
    let entry = case("G4-WP010-MIME-SECURITY-001");
    assert_eq!(entry["expected"], "product_red");
    let seam = entry["seam"].as_str().expect("seam");

    let mut connection = probe_connection("web-channel", "g4-mime");
    // HTML bytes declared as image/png: a MIME spoof the Asset Service must refuse.
    let html_b64 = base64_html();
    let draft = asset_input_draft("image/png", &html_b64, "personal");
    let transition = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &canonical_digest(&draft),
        "g4-mime-block",
        draft.clone(),
        vec![TARGET_PAGE.into()],
        "g4-mime",
    );
    assert_harness_committed(&transition);
    assert_eq!(
        transition.state.blocks["g4-mime-block"]["asset_input"]["media_type"],
        "image/png",
        "harness: the declared media type is persisted today with no sniffing"
    );

    product_red(
        "G4-WP010-MIME-SECURITY-001",
        seam,
        "untrusted bytes ride verbatim inside a committed Block with no bounded sniffing, no media allowlist, no MEDIA_TYPE_MISMATCH/UNSAFE_MEDIA refusal, no SOURCE_DENIED SSRF policy, and no strict base64 or bounded-stream limit",
        "WP-010 Asset MIME and security",
    );
}

#[test]
fn g4_wp010_leases_pins_and_gc_use_atomic_durable_retention() {
    let entry = case("G4-WP010-LEASE-GC-001");
    assert_eq!(entry["expected"], "product_red");
    let seam = entry["seam"].as_str().expect("seam");

    let mut connection = probe_connection("web-channel", "g4-lease-gc");
    let draft = asset_input_draft("image/png", "aW1hZ2UtYnl0ZXM=", "personal");
    let transition = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &canonical_digest(&draft),
        "g4-lease-gc-block",
        draft.clone(),
        vec![TARGET_PAGE.into()],
        "g4-lease-gc",
    );
    assert_harness_committed(&transition);

    product_red(
        "G4-WP010-LEASE-GC-001",
        seam,
        "there is no unguessable LeaseId, no finite-lease record atomic with a non-tombstone check, no durable pin, and no mark/tombstone/sweep GC, so retention races and tombstone-resurrection semantics cannot be exercised",
        "WP-010 Asset leases and GC",
    );
}

#[test]
fn g4_wp010_required_replicas_never_expose_unverified_bytes() {
    let entry = case("G4-WP010-REPLICA-001");
    assert_eq!(entry["expected"], "product_red");
    let seam = entry["seam"].as_str().expect("seam");

    let mut connection = probe_connection("web-channel", "g4-replica");
    let mut draft = asset_input_draft("image/png", "aW1hZ2UtYnl0ZXM=", "personal");
    draft["asset_input"]["remote_required"] = json!(true);
    let transition = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &canonical_digest(&draft),
        "g4-replica-block",
        draft.clone(),
        vec![TARGET_PAGE.into()],
        "g4-replica",
    );
    assert_harness_committed(&transition);

    product_red(
        "G4-WP010-REPLICA-001",
        seam,
        "there is no replica state machine and no remote_required demand, so an unverified required replica could never be held non-available or return REMOTE_REPLICA_FAILED",
        "WP-010 Asset replicas",
    );
}

#[test]
fn g4_wp010_security_domain_isolation_is_recorded_and_enforced() {
    let entry = case("G4-WP010-DOMAIN-ISOLATION-001");
    assert_eq!(entry["expected"], "product_red");
    let seam = entry["seam"].as_str().expect("seam");

    let mut connection = probe_connection("web-channel", "g4-domain");
    let personal = asset_input_draft("image/png", "aW1hZ2UtYnl0ZXM=", "personal");
    let work = asset_input_draft("image/png", "aW1hZ2UtYnl0ZXM=", "work");
    let first = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &canonical_digest(&personal),
        "g4-domain-personal-block",
        personal.clone(),
        vec![TARGET_PAGE.into()],
        "g4-domain-1",
    );
    assert_harness_committed(&first);
    let second = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-43",
        &canonical_digest(&work),
        "g4-domain-work-block",
        work.clone(),
        vec![TARGET_PAGE.into()],
        "g4-domain-2",
    );
    assert_harness_committed(&second);

    product_red(
        "G4-WP010-DOMAIN-ISOLATION-001",
        seam,
        "the durable snapshot has no security_domain asset record, so identical bytes in two domains are indistinguishable and a cross-domain read cannot be denied",
        "WP-010 Asset domain isolation",
    );
}

// ---------------------------------------------------------------------------
// WP-013A Channel product-red probes.
// ---------------------------------------------------------------------------

#[test]
fn g4_wp013a_authenticated_text_round_trip_runs_producer_to_premise_to_consumer() {
    let entry = case("G4-WP013A-ROUNDTRIP-001");
    assert_eq!(entry["expected"], "product_red");
    let seam = entry["seam"].as_str().expect("seam");

    let mut connection = probe_connection("web-channel", "g4-roundtrip");
    let block = channel_metadata_block("Hello.");
    let transition = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &canonical_digest(&block),
        "g4-roundtrip-block",
        block.clone(),
        vec![TARGET_PAGE.into()],
        "g4-roundtrip",
    );
    assert_harness_committed(&transition);
    assert_eq!(
        transition.state.blocks["g4-roundtrip-block"]["metadata"]["org.dolly.channel"]
            ["channel_id"],
        "web-primary",
        "harness: the channel-shaped draft reaches the durable Core premise"
    );

    product_red(
        "G4-WP013A-ROUNDTRIP-001",
        seam,
        "CoreCommand::Ingress accepts a caller-shaped block and block_id verbatim, so no producer identity is derived by the Host; there is no Channel package, no activation that consumes the committed draft into a channel-owned org.dolly.channel.send action, and no send ActionContract execution",
        "WP-013A Channel text round trip",
    );
}

#[test]
fn g4_wp013a_ingress_reconciliation_reads_status_instead_of_resubmitting() {
    let entry = case("G4-WP013A-INGRESS-RECONCILE-001");
    assert_eq!(entry["expected"], "product_red");
    let seam = entry["seam"].as_str().expect("seam");

    let mut connection = probe_connection("web-channel", "g4-reconcile");
    let block = channel_metadata_block("Hello.");
    let digest = canonical_digest(&block);
    let first = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &digest,
        "g4-reconcile-block",
        block.clone(),
        vec![TARGET_PAGE.into()],
        "g4-reconcile-1",
    );
    assert_harness_committed(&first);
    // Simulate a lost response: the caller only knows it submitted. The only
    // reconciliation today is resubmitting the identical command, which must
    // answer the committed mapping.
    let retried = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &digest,
        "g4-reconcile-block",
        block.clone(),
        vec![TARGET_PAGE.into()],
        "g4-reconcile-2",
    );
    assert_eq!(
        retried.reply,
        Some(json!({"block_id": "g4-reconcile-block", "idempotent": true})),
        "harness: identical resubmission answers the prior mapping"
    );

    product_red(
        "G4-WP013A-INGRESS-RECONCILE-001",
        seam,
        "host.ingress.status does not exist: a lost-response caller cannot read absent|committed for its principal and key without resubmitting, so reconciliation forces a resubmission that the product contract forbids after an authoritative state",
        "WP-013A Channel ingress reconciliation",
    );
}

#[test]
fn g4_wp013a_sender_conversation_session_and_capability_are_authorized_before_dispatch() {
    let entry = case("G4-WP013A-AUTHORIZATION-001");
    assert_eq!(entry["expected"], "product_red");
    let seam = entry["seam"].as_str().expect("seam");

    let mut connection = probe_connection("web-channel", "g4-authz");
    // An unauthenticated event with no session: the Channel must refuse before
    // any ingest or dispatch record exists.
    let mut hostile = channel_metadata_block("Hello.");
    hostile["metadata"]["org.dolly.channel"]["sender_class"] = json!("anonymous");
    hostile["metadata"]["org.dolly.channel"]["session_id"] = json!(Value::Null);
    let transition = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &canonical_digest(&hostile),
        "g4-authz-block",
        hostile.clone(),
        vec![TARGET_PAGE.into()],
        "g4-authz",
    );
    assert_harness_committed(&transition);

    product_red(
        "G4-WP013A-AUTHORIZATION-001",
        seam,
        "no Channel transport, session map, or capability check exists, so an unauthenticated event or session-missing send has no authorization decision to fail before dispatch",
        "WP-013A Channel authorization",
    );
}

#[test]
fn g4_wp013a_outbound_replay_returns_the_existing_result_without_resend() {
    let entry = case("G4-WP013A-REPLAY-001");
    assert_eq!(entry["expected"], "product_red");
    let seam = entry["seam"].as_str().expect("seam");

    let mut connection = probe_connection("web-channel", "g4-replay");
    let action = json!({
        "name": "org.dolly.channel.send",
        "action_id": "0198ab31-6c44-7e8a-b2bb-000000000091",
        "target": {"module_id": "web-channel"},
        "arguments": {
            "session_id": "session-main",
            "parts": [{"kind": "text", "text": "Hello.", "format": "plain"}],
            "reply_to_external_message_id": null
        }
    });
    let block = json!({
        "schema": "dolly.block/v1",
        "parts": [{"kind": "action", "action": action}]
    });
    let transition = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &canonical_digest(&block),
        "g4-replay-block",
        block.clone(),
        vec![TARGET_PAGE.into()],
        "g4-replay",
    );
    assert_harness_committed(&transition);

    product_red(
        "G4-WP013A-REPLAY-001",
        seam,
        "no outbound ledger and no action_id identity exist, so a confirmed action replay cannot return the existing result and an unknown send has no quarantine disposition",
        "WP-013A Channel replay and idempotency",
    );
}

#[test]
fn g4_wp013a_unknown_and_partial_outcomes_are_explicit_and_non_retryable() {
    let entry = case("G4-WP013A-UNKNOWN-PARTIAL-001");
    assert_eq!(entry["expected"], "product_red");
    let seam = entry["seam"].as_str().expect("seam");

    let mut connection = probe_connection("web-channel", "g4-unknown-partial");
    let block = json!({
        "schema": "dolly.block/v1",
        "parts": [{"kind": "text", "text": "split", "format": "plain"}]
    });
    let transition = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &canonical_digest(&block),
        "g4-unknown-partial-block",
        block.clone(),
        vec![TARGET_PAGE.into()],
        "g4-unknown-partial",
    );
    assert_harness_committed(&transition);

    product_red(
        "G4-WP013A-UNKNOWN-PARTIAL-001",
        seam,
        "no dispatch record or outcome envelope exists, so a timeout or crash after possible send has no `unknown` disposition, and a split send has no terminal `partial` ActionResult with code CHANNEL_PARTIAL_DELIVERY, retryable false, outcome applied, and per-piece ordinals",
        "WP-013A Channel unknown and partial outbound",
    );
}

#[test]
fn g4_wp013a_outbound_rate_limits_use_bounded_queues_and_caller_deadlines() {
    let entry = case("G4-WP013A-BACKPRESSURE-001");
    assert_eq!(entry["expected"], "product_red");
    let seam = entry["seam"].as_str().expect("seam");

    let mut connection = probe_connection("web-channel", "g4-backpressure");
    let block = channel_metadata_block("burst");
    let transition = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &canonical_digest(&block),
        "g4-backpressure-block",
        block.clone(),
        vec![TARGET_PAGE.into()],
        "g4-backpressure",
    );
    assert_harness_committed(&transition);

    product_red(
        "G4-WP013A-BACKPRESSURE-001",
        seam,
        "no outbound transport queue, rate/concurrency configuration, or caller deadline exists, so a burst cannot be bounded and transport unavailability cannot be proven to leave Core input state untouched",
        "WP-013A Channel backpressure",
    );
}

#[test]
fn g4_wp013a_credentials_paths_and_signed_urls_never_enter_metadata_or_logs() {
    let entry = case("G4-WP013A-REDACTION-001");
    assert_eq!(entry["expected"], "product_red");
    let seam = entry["seam"].as_str().expect("seam");

    let mut connection = probe_connection("web-channel", "g4-redaction");
    let mut credential_carrying = channel_metadata_block("Hello.");
    credential_carrying["metadata"]["org.dolly.channel"]["authorization"] =
        json!("Bearer super-secret-token");
    credential_carrying["metadata"]["org.dolly.channel"]["attachment_path"] =
        json!("/home/ubuntu/secrets/private.png");
    let transition = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &canonical_digest(&credential_carrying),
        "g4-redaction-block",
        credential_carrying.clone(),
        vec![TARGET_PAGE.into()],
        "g4-redaction",
    );
    assert_harness_committed(&transition);
    assert_eq!(
        transition.state.blocks["g4-redaction-block"]["metadata"]["org.dolly.channel"]
            ["authorization"],
        "Bearer super-secret-token",
        "harness: the credential-shaped field is persisted verbatim today"
    );

    product_red(
        "G4-WP013A-REDACTION-001",
        seam,
        "the durable block copies whatever JSON the caller submits, so a draft carrying credentials or a local path is persisted verbatim with no namespaced-metadata filtering and no redaction boundary",
        "WP-013A Channel redaction",
    );
}

#[test]
fn g4_wp013a_channel_cannot_append_to_a_page_or_advance_a_cursor_directly() {
    let entry = case("G4-WP013A-NO-DIRECT-MUTATION-001");
    assert_eq!(entry["expected"], "product_red");
    let seam = entry["seam"].as_str().expect("seam");

    let mut connection = probe_connection("web-channel", "g4-nodirect-channel");
    let block = channel_metadata_block("Hello.");
    let transition = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &canonical_digest(&block),
        "g4-nodirect-channel-block",
        block.clone(),
        vec![TARGET_PAGE.into()],
        "g4-nodirect-channel",
    );
    assert_harness_committed(&transition);

    product_red(
        "G4-WP013A-NO-DIRECT-MUTATION-001",
        seam,
        "a Channel implementation does not exist, so the negative direct-mutation route set cannot be exercised against it; the Core-side premise that no third-party direct-mutation command exists is enforced by G4-CONTROL-NO-DIRECT-MUTATION-001, and a future Channel must route every write through host.ingress.submit",
        "WP-013A Channel no direct Page or cursor mutation",
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Small HTML payload, base64-encoded: a MIME spoof when declared as image/png.
fn base64_html() -> String {
    const HTML: &[u8] = b"<html><body>not an image</body></html>";
    let mut encoded = String::with_capacity(HTML.len().div_ceil(3) * 4);
    use std::fmt::Write as _;
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut i = 0;
    while i < HTML.len() {
        let b0 = HTML[i] as u32;
        let b1 = if i + 1 < HTML.len() { HTML[i + 1] as u32 } else { 0 };
        let b2 = if i + 2 < HTML.len() { HTML[i + 2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        let _ = write!(
            encoded,
            "{}{}{}{}",
            TABLE[(triple >> 18) as usize & 63] as char,
            TABLE[(triple >> 12) as usize & 63] as char,
            if i + 1 < HTML.len() { TABLE[(triple >> 6) as usize & 63] as char } else { '=' },
            if i + 2 < HTML.len() { TABLE[triple as usize & 63] as char } else { '=' }
        );
        i += 3;
    }
    encoded
}
