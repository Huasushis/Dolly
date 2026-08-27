use std::collections::{BTreeMap, BTreeSet};

use dolly_canonical_json::canonicalize;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::command::*;
use crate::effective_config::{
    EFFECTIVE_CONFIG_MAX_PROPERTIES, EFFECTIVE_CONFIG_MAX_PROPERTIES_CODE,
    MAX_EFFECTIVE_CONFIG_PROPERTIES,
};
use crate::projection::{hash_core_state, project_core_state};
use crate::types::*;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SafetyStop {
    pub state: CoreSnapshot,
    pub event: CoreEvent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Transition {
    pub outcome: TransitionOutcome,
    pub state: CoreSnapshot,
    pub events: Vec<CoreEvent>,
    pub error: Option<CoreError>,
    pub reply: Option<Value>,
    pub projection: Value,
    pub state_hash: String,
    pub safety_stop: Option<SafetyStop>,
}

fn failure(
    state: &CoreSnapshot,
    code: &str,
    retryable: bool,
    details: Option<Value>,
) -> Transition {
    Transition {
        outcome: TransitionOutcome::RolledBack,
        state: state.clone(),
        events: Vec::new(),
        error: Some(CoreError {
            code: code.into(),
            retryable,
            outcome: ErrorOutcome::NotApplied,
            details,
        }),
        reply: None,
        projection: project_core_state(state),
        state_hash: hash_core_state(state).expect("validated core snapshot"),
        safety_stop: None,
    }
}
fn failure_with_emission(
    state: &CoreSnapshot,
    command_id: &str,
    code: &str,
    event: &str,
    retryable: bool,
    details: Value,
) -> Transition {
    let emitted = CoreEvent {
        event: event.into(),
        commit_seq: state.next_commit_seq,
        command_id: command_id.into(),
        details: Some(details.clone()),
    };
    Transition {
        outcome: TransitionOutcome::RolledBack,
        state: state.clone(),
        events: vec![emitted],
        error: Some(CoreError {
            code: code.into(),
            retryable,
            outcome: ErrorOutcome::NotApplied,
            details: Some(details),
        }),
        reply: None,
        projection: project_core_state(state),
        state_hash: hash_core_state(state).expect("validated core snapshot"),
        safety_stop: None,
    }
}
fn append_event(
    state: &mut CoreSnapshot,
    command_id: &str,
    event: &str,
    details: Option<Value>,
) -> CoreEvent {
    let record = CoreEvent {
        event: event.into(),
        commit_seq: state.next_commit_seq,
        command_id: command_id.into(),
        details,
    };
    state.next_commit_seq += 1;
    state.journal.push(record.clone());
    record
}
fn success(
    state: CoreSnapshot,
    events: Vec<CoreEvent>,
    reply: Option<Value>,
    error: Option<CoreError>,
) -> Transition {
    let projection = project_core_state(&state);
    let state_hash = hash_core_state(&state).expect("validated core snapshot");
    Transition {
        outcome: TransitionOutcome::Committed,
        state,
        events,
        error,
        reply,
        projection,
        state_hash,
        safety_stop: None,
    }
}
fn digest_format(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn canonical_digest(value: &Value) -> Option<String> {
    canonicalize(value)
        .ok()
        .map(|(_, digest)| digest.to_canonical_string())
}
fn invalid_snapshot_transition(code: &str) -> Transition {
    let mut stopped = empty_core_snapshot();
    stopped.mode = InstanceMode::RecoveryRequired;
    let details = json!({"reason":code});
    stopped.security_incidents.push(details.clone());
    let event = append_event(
        &mut stopped,
        "snapshot-validation",
        "RecoveryRequired",
        Some(details.clone()),
    );
    Transition {
        outcome: TransitionOutcome::RolledBackWithSafetyStop,
        state: stopped.clone(),
        events: vec![event.clone()],
        error: Some(CoreError {
            code: code.into(),
            retryable: false,
            outcome: ErrorOutcome::NotApplied,
            details: Some(details.clone()),
        }),
        reply: None,
        projection: project_core_state(&stopped),
        state_hash: hash_core_state(&stopped).expect("recovery snapshot canonicalizes"),
        safety_stop: Some(SafetyStop {
            state: stopped,
            event,
        }),
    }
}
fn verified_digest(value: &Value, claimed: &str) -> bool {
    digest_format(claimed) && canonical_digest(value).as_deref() == Some(claimed)
}
fn object_i64(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}
fn object_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}
fn same_value(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => canonical_digest(left)
            .zip(canonical_digest(right))
            .is_some_and(|(left, right)| left == right),
        _ => false,
    }
}
fn manifest_neighbor_projection_valid(manifest: &Value) -> bool {
    let Some(neighbors) = manifest.get("neighbor_descriptors") else {
        return true;
    };
    let Some(neighbors) = neighbors.as_array() else {
        return false;
    };
    neighbors.iter().all(|neighbor| {
        let Some(neighbor) = neighbor.as_object() else {
            return false;
        };
        let wrapper_keys = [
            "module_id",
            "descriptor_revision",
            "source_descriptor_digest",
            "relationships",
            "projection",
        ];
        if neighbor.len() != wrapper_keys.len()
            || !wrapper_keys
                .iter()
                .all(|key| neighbor.contains_key(*key))
        {
            return false;
        }
        let Some(relationships) = neighbor.get("relationships").and_then(Value::as_array) else {
            return false;
        };
        let input_producer = relationships.len() == 1
            && relationships[0].as_str() == Some("input_producer");
        let output_consumer = relationships.len() == 1
            && relationships[0].as_str() == Some("output_consumer");
        let both = relationships.len() == 2
            && relationships[0].as_str() == Some("input_producer")
            && relationships[1].as_str() == Some("output_consumer");
        let allowed_projection_keys: &[&str] = if input_producer {
            &["display_name", "trust", "metadata", "emits"]
        } else if output_consumer {
            &["display_name", "trust", "metadata", "accepts", "actions"]
        } else if both {
            &[
                "display_name",
                "trust",
                "metadata",
                "emits",
                "accepts",
                "actions",
            ]
        } else {
            return false;
        };
        let Some(projection) = neighbor.get("projection").and_then(Value::as_object) else {
            return false;
        };
        projection.len() == allowed_projection_keys.len()
            && allowed_projection_keys
                .iter()
                .all(|key| projection.contains_key(*key))
    })
}

fn lease_id_for(state: &CoreSnapshot, activation_id: &str) -> Option<String> {
    let attempt = state.activations.get(activation_id)?.attempt;
    let mut candidates = state.leases.iter().filter(|(_, value)| {
        object_str(value, "activation_id") == Some(activation_id)
            && object_i64(value, "attempt") == Some(attempt)
    });
    let first = candidates.next()?.0.clone();
    if candidates.next().is_some() {
        return None;
    }
    Some(first)
}
fn replay_contract(item: &ActivationRecord) -> (&'static str, &'static str) {
    let contract = item
        .manifest
        .as_ref()
        .and_then(|value| value.get("frozen_replay_contract"));
    if contract
        .and_then(|value| value.get("mode"))
        .and_then(Value::as_str)
        == Some("fenced_replay")
        && contract
            .and_then(|value| value.get("evidence"))
            .and_then(Value::as_str)
            == Some("activation_ledger")
    {
        ("fenced_replay", "activation_ledger")
    } else {
        ("never_auto_retry", "none")
    }
}
fn record_quarantine(
    state: &mut CoreSnapshot,
    command_id: &str,
    activation_id: &str,
    reason: &str,
    preserve: bool,
    event: &str,
) -> CoreEvent {
    let record = json!({"reason":reason,"activation_id":activation_id});
    state
        .quarantines
        .insert(activation_id.into(), record.clone());
    if let Some(item) = state.activations.get_mut(activation_id) {
        if !preserve {
            item.state = ActivationState::Quarantined;
        }
        item.next_attempt_authorization = None;
    }
    append_event(state, command_id, event, Some(record))
}
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
fn safe_nonnegative(value: i64) -> bool {
    (0..=MAX_SAFE_INTEGER).contains(&value)
}
fn snapshot_counters_valid(state: &CoreSnapshot) -> bool {
    safe_nonnegative(state.next_commit_seq)
        && safe_nonnegative(state.next_page_seq)
        && state
            .subscriptions
            .values()
            .all(|subscription| safe_nonnegative(subscription.cursor))
        && state
            .pages
            .values()
            .flatten()
            .all(|page| page.page_seq >= 0 && page.page_seq < MAX_SAFE_INTEGER)
        && state
            .activations
            .values()
            .all(|activation| safe_nonnegative(activation.attempt))
        && state
            .journal
            .iter()
            .all(|event| safe_nonnegative(event.commit_seq))
}
fn next_attempt(attempt: i64) -> Option<i64> {
    attempt
        .checked_add(1)
        .filter(|value| safe_nonnegative(*value))
}
fn commit_increment_budget(state: &CoreSnapshot, command: &CoreCommand) -> Option<i64> {
    match command {
        CoreCommand::Ingress(command) => i64::try_from(command.pages.len()).ok()?.checked_add(1),
        CoreCommand::IssueLease(_) => i64::try_from(
            state
                .generations
                .iter()
                .filter(|generation| {
                    generation.get("compatible").and_then(Value::as_bool) == Some(false)
                })
                .count(),
        )
        .ok()?
        .checked_add(1),
        CoreCommand::ReceiveResult(_) | CoreCommand::Recover(_) => Some(2),
        _ => Some(1),
    }
}
fn parse_staged(value: Option<&Value>) -> Option<StagedResult> {
    let empty = Value::Object(Map::new());
    let value = value.unwrap_or(&empty);
    let object = value.as_object()?;
    let expected_cursors = match object.get("expected_cursors") {
        None => BTreeMap::new(),
        Some(value) => serde_json::from_value(value.clone()).ok()?,
    };
    let outputs = match object.get("outputs") {
        None => Vec::new(),
        Some(value) => serde_json::from_value(value.clone()).ok()?,
    };
    let admitted_pages: BTreeMap<String, Vec<PageRecord>> = match object.get("admitted_pages") {
        None => BTreeMap::new(),
        Some(value) => serde_json::from_value(value.clone()).ok()?,
    };
    let projected_admission_entries = object
        .get("projected_admission_entries")
        .map_or(Some(0), Value::as_i64)?;
    let page_limit = object.get("page_limit").map(Value::as_i64).transpose()?;
    if expected_cursors
        .values()
        .any(|value| *value < 0 || *value >= MAX_SAFE_INTEGER)
        || admitted_pages
            .values()
            .flatten()
            .any(|page| page.page_seq < 0 || page.page_seq >= MAX_SAFE_INTEGER)
        || !(0..=MAX_SAFE_INTEGER).contains(&projected_admission_entries)
        || page_limit.is_some_and(|value| !(0..=MAX_SAFE_INTEGER).contains(&value))
    {
        return None;
    }
    let validation = object.get("validation").cloned();
    Some(StagedResult {
        expected_cursors,
        outputs,
        admitted_pages,
        projected_admission_entries,
        page_limit,
        validation,
    })
}
trait OptionTranspose<T> {
    fn transpose(self) -> Option<Option<T>>;
}
impl<T> OptionTranspose<T> for Option<Option<T>> {
    fn transpose(self) -> Option<Option<T>> {
        match self {
            None => Some(None),
            Some(Some(value)) => Some(Some(value)),
            Some(None) => None,
        }
    }
}
fn result_binding_valid(
    state: &CoreSnapshot,
    command: &ReceiveResultCommand,
    input: &EnvironmentInput,
) -> bool {
    let Some(proof) = input.host_result_verification.as_ref() else {
        return false;
    };
    let Some(item) = state.activations.get(&command.activation_id) else {
        return false;
    };
    let Some(lease) = state.leases.get(&command.lease_id) else {
        return false;
    };
    proof.verified
        && proof.payload_valid
        && proof.activation_id == command.activation_id
        && proof.lease_id == command.lease_id
        && proof.result_digest == command.result_digest
        && object_str(lease, "activation_id") == Some(command.activation_id.as_str())
        && object_str(lease, "token_digest") == Some(proof.token_digest.as_str())
        && object_i64(lease, "attempt") == Some(proof.attempt)
        && item.attempt == proof.attempt
        && object_str(lease, "extension_connection_id")
            == Some(proof.extension_connection_id.as_str())
        && object_i64(lease, "worker_epoch") == Some(proof.worker_epoch)
        && object_i64(lease, "extension_generation") == proof.extension_generation
        && lease
            .get("manifest_digest")
            .and_then(Value::as_str)
            .map(str::to_string)
            == proof.manifest_digest
}
fn replay_evidence_valid(
    item: &ActivationRecord,
    activation_id: &str,
    evidence: &HostReplayEvidence,
) -> bool {
    if !evidence.verified
        || evidence.activation_id != activation_id
        || evidence.source_attempt != item.attempt
        || !verified_digest(&evidence.record, &evidence.digest)
    {
        return false;
    }
    let record = &evidence.record;
    if object_str(record, "activation_id") != Some(activation_id)
        || object_i64(record, "source_attempt") != Some(item.attempt)
    {
        return false;
    }
    let Some(manifest) = item.manifest.as_ref() else {
        return false;
    };
    let Some(manifest_digest) = object_str(manifest, "manifest_digest") else {
        return false;
    };
    if object_str(record, "manifest_digest") != Some(manifest_digest)
        || object_i64(record, "target_extension_generation") != evidence.target_generation
        || item.extension_generation != evidence.target_generation
    {
        return false;
    }
    let (Some(module_id), Some(storage_scope_id)) =
        (manifest.get("module_id"), manifest.get("storage_scope_id"))
    else {
        return false;
    };
    if record.get("module_id") != Some(module_id)
        || record.get("storage_scope_id") != Some(storage_scope_id)
    {
        return false;
    }
    if let Some(ledger) = manifest
        .get("frozen_replay_contract")
        .and_then(|value| value.get("ledger"))
    {
        if !same_value(record.get("ledger"), Some(ledger)) {
            return false;
        }
    }
    let observation = match object_str(record, "ledger_state") {
        Some("complete") => ReplayEvidenceObservation::Succeeded,
        Some("failed") => ReplayEvidenceObservation::Failed,
        _ => ReplayEvidenceObservation::Unknown,
    };
    evidence.observation == observation
}
fn stored_replay_evidence_valid(item: &ActivationRecord, activation_id: &str) -> bool {
    let Some(stored) = item.replay_evidence.as_ref() else {
        return false;
    };
    let Some(target_generation) = object_i64(stored, "target_generation") else {
        return false;
    };
    if item.extension_generation != Some(target_generation) {
        return false;
    }
    let Some(digest) = object_str(stored, "evidence_digest") else {
        return false;
    };
    let observation = match object_str(stored, "observation") {
        Some("succeeded") => ReplayEvidenceObservation::Succeeded,
        Some("failed") => ReplayEvidenceObservation::Failed,
        Some("unknown") => ReplayEvidenceObservation::Unknown,
        _ => return false,
    };
    let mut source = stored.clone();
    let Some(source) = source.as_object_mut() else {
        return false;
    };
    source.remove("evidence_digest");
    source.remove("observation");
    source.remove("target_generation");
    replay_evidence_valid(
        item,
        activation_id,
        &HostReplayEvidence {
            verified: true,
            activation_id: activation_id.to_string(),
            source_attempt: item.attempt,
            target_generation: Some(target_generation),
            observation,
            record: Value::Object(source.clone()),
            digest: digest.to_string(),
        },
    )
}

fn retry_authorization_valid(
    state: &CoreSnapshot,
    activation_id: &str,
    item: &ActivationRecord,
) -> bool {
    let Some(auth) = item.next_attempt_authorization.as_ref() else {
        return false;
    };
    let Some(authorized_attempt) = next_attempt(item.attempt) else {
        return false;
    };
    if object_str(auth, "activation_id") != Some(activation_id)
        || object_i64(auth, "source_attempt") != Some(item.attempt)
        || object_i64(auth, "authorized_attempt") != Some(authorized_attempt)
    {
        return false;
    }
    let Some(digest) = object_str(auth, "evidence_digest") else {
        return false;
    };
    if !digest_format(digest) {
        return false;
    }
    match object_str(auth, "reason") {
        Some("safe_before_dispatch") => lease_id_for(state, activation_id)
            .and_then(|id| state.leases.get(&id))
            .is_some_and(|lease| {
                object_str(lease, "dispatch_state") == Some("fenced")
                    && object_str(lease, "fence_evidence_digest") == Some(digest)
            }),
        Some("explicit_retryable_failure") => item.result_digest.as_deref() == Some(digest),
        Some("activation_ledger") => {
            item.replay_evidence
                .as_ref()
                .and_then(|value| object_str(value, "evidence_digest"))
                == Some(digest)
        }
        Some("operator_review") => auth.get("reviewed").and_then(Value::as_bool) == Some(true),
        _ => false,
    }
}
fn projected_pending(state: &CoreSnapshot, staged: &StagedResult) -> i64 {
    let cursors: Vec<i64> = state
        .subscriptions
        .iter()
        .map(|(id, subscription)| {
            staged
                .expected_cursors
                .get(id)
                .map_or(subscription.cursor, |cursor| cursor + 1)
        })
        .collect();
    let mut count = 0;
    if cursors.is_empty() {
        for pages in state.pages.values() {
            for page in pages {
                count += i64::try_from(page.entries.len()).unwrap_or(i64::MAX);
            }
        }
    } else {
        let earliest = *cursors.iter().min().unwrap();
        for pages in state.pages.values() {
            for page in pages {
                if page.page_seq >= earliest {
                    count += i64::try_from(page.entries.len()).unwrap_or(i64::MAX);
                }
            }
        }
    }
    count.saturating_add(staged.projected_admission_entries)
}

pub fn reduce(state: &CoreSnapshot, command: &CoreCommand, input: &EnvironmentInput) -> Transition {
    if hash_core_state(state).is_err() {
        return invalid_snapshot_transition("CORE_STATE_CANONICAL_JSON_INVALID");
    }
    if !snapshot_counters_valid(state) {
        return invalid_snapshot_transition("CORE_STATE_COUNTER_INVALID");
    }
    if state.mode == InstanceMode::RecoveryRequired && !matches!(command, CoreCommand::Recover(_)) {
        return failure(state, "RECOVERY_REQUIRED", false, None);
    }
    if input.storage_observation == Some(StorageObservation::BeforeCommit) {
        return failure(
            state,
            "SIMULATED_CRASH",
            true,
            input
                .crash_point
                .as_ref()
                .map(|label| json!({"crash_point":label})),
        );
    }
    let Some(commit_increment_budget) = commit_increment_budget(state, command) else {
        return failure(state, "COMMIT_SEQUENCE_EXHAUSTED", false, None);
    };
    if state
        .next_commit_seq
        .checked_add(commit_increment_budget)
        .is_none_or(|next_commit_seq| next_commit_seq > MAX_SAFE_INTEGER)
    {
        return failure(state, "COMMIT_SEQUENCE_EXHAUSTED", false, None);
    }
    let mut next = state.clone();
    let mut events = Vec::new();
    match command {
        CoreCommand::InstallConfig(c) => {
            if !verified_digest(&c.effective_config, &c.digest) {
                return failure(state, "CONFIG_DIGEST_MISMATCH", false, None);
            }
            if next
                .config
                .get("revision")
                .and_then(Value::as_i64)
                .unwrap_or(-1)
                >= c.revision
            {
                return failure(state, "CONFIG_REVISION_CONFLICT", false, None);
            }
            if c.effective_config
                .as_object()
                .map_or(0, |object| object.len())
                > MAX_EFFECTIVE_CONFIG_PROPERTIES
            {
                return failure_with_emission(
                    state,
                    &c.command_id,
                    EFFECTIVE_CONFIG_MAX_PROPERTIES_CODE,
                    "ConfigurationCandidateRejected",
                    false,
                    json!({"reason": EFFECTIVE_CONFIG_MAX_PROPERTIES}),
                );
            }
            next.config = json!({"revision":c.revision,"effective_config":c.effective_config,"digest":c.digest});
            events.push(append_event(
                &mut next,
                &c.command_id,
                "ConfigInstalled",
                Some(json!({"revision":c.revision,"digest":c.digest})),
            ));
            success(next, events, None, None)
        }
        CoreCommand::InstallGraph(c) => {
            if !verified_digest(&c.graph, &c.digest) {
                return failure(state, "GRAPH_DIGEST_MISMATCH", false, None);
            }
            if next
                .graph
                .get("revision")
                .and_then(Value::as_i64)
                .unwrap_or(-1)
                >= c.revision
            {
                return failure(state, "GRAPH_REVISION_CONFLICT", false, None);
            }
            next.graph = json!({"revision":c.revision,"graph":c.graph,"digest":c.digest});
            events.push(append_event(
                &mut next,
                &c.command_id,
                "GraphInstalled",
                Some(json!({"revision":c.revision,"digest":c.digest})),
            ));
            success(next, events, None, None)
        }
        CoreCommand::Ingress(c) => {
            let identity = format!("{}\0{}", c.runtime_source, c.ingress_key);
            if let Some(existing) = next.ingress.get(&identity) {
                if existing.operation_digest != c.operation_digest {
                    return failure(
                        state,
                        "STORAGE_IDEMPOTENCY_CONFLICT",
                        false,
                        Some(json!({"identity":identity})),
                    );
                }
                return success(
                    state.clone(),
                    Vec::new(),
                    Some(json!({"block_id":existing.block_id,"idempotent":true})),
                    None,
                );
            }
            if canonical_digest(&c.block).is_none() {
                return failure(state, "CANONICAL_JSON_INVALID", false, None);
            }
            let pages: BTreeSet<_> = c.pages.iter().cloned().collect();
            let pages: Vec<_> = pages.into_iter().collect();
            next.ingress.insert(
                identity,
                IngressRecord {
                    operation_digest: c.operation_digest.clone(),
                    block_id: c.block_id.clone(),
                    pages: pages.clone(),
                },
            );
            let event = CoreEvent {
                event: "IngressCommitted".into(),
                commit_seq: next.next_commit_seq,
                command_id: c.command_id.clone(),
                details: Some(json!({"block_id":c.block_id})),
            };
            next.next_commit_seq += 1;
            next.blocks.insert(c.block_id.clone(), {
                let mut block = c.block.clone();
                if let Some(map) = block.as_object_mut() {
                    map.insert("commit_seq".into(), json!(event.commit_seq));
                }
                block
            });
            for page in pages {
                next.deliveries.push(
                    json!({"block_id":c.block_id,"page_id":page,"commit_seq":next.next_commit_seq}),
                );
                next.next_commit_seq += 1;
            }
            next.journal.push(event.clone());
            events.push(event);
            success(
                next,
                events,
                Some(json!({"block_id":c.block_id,"idempotent":false})),
                None,
            )
        }
        CoreCommand::RuntimeEvent(c) => {
            let identity = format!("{}\0{}", c.runtime_source, c.event_key);
            if let Some(existing) = next.runtime_events.get(&identity) {
                if existing.operation_digest == c.operation_digest {
                    return success(
                        state.clone(),
                        Vec::new(),
                        Some(json!({"block_id":existing.block_id,"idempotent":true})),
                        None,
                    );
                }
                let incident = json!({"code":"STORAGE_IDEMPOTENCY_CONFLICT","identity":identity,"original_digest":existing.operation_digest,"conflicting_digest":c.operation_digest});
                next.security_incidents.push(incident.clone());
                events.push(append_event(
                    &mut next,
                    &c.command_id,
                    "SecurityIncident",
                    Some(incident.clone()),
                ));
                return success(
                    next,
                    events,
                    None,
                    Some(CoreError {
                        code: "STORAGE_IDEMPOTENCY_CONFLICT".into(),
                        retryable: false,
                        outcome: ErrorOutcome::NotApplied,
                        details: Some(incident),
                    }),
                );
            }
            if canonical_digest(&c.block).is_none() {
                return failure(state, "CANONICAL_JSON_INVALID", false, None);
            }
            next.runtime_events.insert(
                identity,
                RuntimeEventRecord {
                    operation_digest: c.operation_digest.clone(),
                    block_id: c.block_id.clone(),
                },
            );
            next.blocks.insert(c.block_id.clone(), c.block.clone());
            for page in c.pages.iter().cloned().collect::<BTreeSet<_>>() {
                next.deliveries
                    .push(json!({"block_id":c.block_id,"page_id":page}));
            }
            events.push(append_event(
                &mut next,
                &c.command_id,
                "RuntimeEventCommitted",
                Some(json!({"runtime_source":c.runtime_source,"event_key":c.event_key})),
            ));
            success(
                next,
                events,
                Some(json!({"block_id":c.block_id,"idempotent":false})),
                None,
            )
        }
        CoreCommand::GrantStorageWriter(c) => {
            if next
                .storage_writer_owner
                .as_deref()
                .is_some_and(|owner| owner != c.owner)
            {
                return failure(state, "STORAGE_WRITER_OWNED", false, None);
            }
            next.storage_writer_owner = Some(c.owner.clone());
            events.push(append_event(
                &mut next,
                &c.command_id,
                "StorageWriterGranted",
                Some(json!({"owner":c.owner})),
            ));
            success(next, events, None, None)
        }
        CoreCommand::ReleaseStorageWriter(c) => {
            if next.storage_writer_owner.as_deref() != Some(c.owner.as_str()) {
                return failure(state, "STORAGE_WRITER_FENCE_CONFLICT", false, None);
            }
            next.storage_writer_owner = None;
            events.push(append_event(
                &mut next,
                &c.command_id,
                "StorageWriterReleased",
                Some(json!({"owner":c.owner})),
            ));
            success(next, events, None, None)
        }
        CoreCommand::BuildManifest(c) => {
            if let Some(existing) = next.manifests.get(&c.activation_id) {
                if same_value(Some(existing), Some(&c.manifest)) {
                    return success(
                        state.clone(),
                        Vec::new(),
                        Some(json!({"activation_id":c.activation_id,"idempotent":true})),
                        None,
                    );
                }
                return failure(
                    state,
                    "STORAGE_IDEMPOTENCY_CONFLICT",
                    false,
                    Some(json!({"activation_id":c.activation_id})),
                );
            }
            if c.expected_graph_revision
                .is_some_and(|revision| input.graph_revision != Some(revision))
                || c.expected_descriptor_revision
                    .is_some_and(|revision| input.descriptor_revision != Some(revision))
            {
                return failure_with_emission(
                    state,
                    &c.command_id,
                    "MANIFEST_BUILD_CAS_RETRY",
                    "ManifestBuildCasRetry",
                    true,
                    json!({"reason":"graph_or_descriptor_changed"}),
                );
            }
            if !manifest_neighbor_projection_valid(&c.manifest) {
                return failure(
                    state,
                    "MANIFEST_DESCRIPTOR_PROJECTION_INVALID",
                    false,
                    None,
                );
            }
            if canonical_digest(&c.manifest).is_none() {
                return failure(state, "CANONICAL_JSON_INVALID", false, None);
            }
            if let (Some(config), Some(digest)) = (
                c.manifest.get("effective_config"),
                c.manifest
                    .get("effective_config_digest")
                    .and_then(Value::as_str),
            ) {
                if !verified_digest(config, digest) {
                    return failure(
                        state,
                        "MANIFEST_EFFECTIVE_CONFIG_DIGEST_MISMATCH",
                        false,
                        None,
                    );
                }
            }
            let reason = c
                .manifest
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("input");
            events.push(append_event(
                &mut next,
                &c.command_id,
                "ManifestCreated",
                Some(json!({"activation_id":c.activation_id,"reason":reason})),
            ));
            next.manifests
                .insert(c.activation_id.clone(), c.manifest.clone());
            next.activations.insert(
                c.activation_id.clone(),
                ActivationRecord {
                    state: ActivationState::Ready,
                    attempt: 0,
                    manifest: Some(c.manifest.clone()),
                    ..Default::default()
                },
            );
            success(next, events, None, None)
        }
        CoreCommand::IssueLease(c) => {
            let Some(item) = next.activations.get(&c.activation_id) else {
                return failure(state, "ACTIVATION_NOT_LEASABLE", false, None);
            };
            if let Some(existing) = next.leases.get(&c.lease_id) {
                let exact = object_str(existing, "activation_id") == Some(c.activation_id.as_str())
                    && object_str(existing, "token_digest") == Some(c.token_digest.as_str())
                    && object_str(existing, "extension_connection_id")
                        == Some(c.extension_connection_id.as_str())
                    && object_i64(existing, "worker_epoch") == Some(c.worker_epoch)
                    && object_i64(existing, "attempt") == Some(item.attempt)
                    && c.extension_generation == object_i64(existing, "extension_generation");
                if !exact {
                    return failure(
                        state,
                        "STORAGE_IDEMPOTENCY_CONFLICT",
                        false,
                        Some(json!({"lease_id":c.lease_id})),
                    );
                }
                let mut reply = Map::new();
                reply.insert("lease_id".into(), json!(c.lease_id));
                reply.insert("attempt".into(), json!(item.attempt));
                if let Some(value) = object_i64(existing, "extension_generation") {
                    reply.insert("extension_generation".into(), json!(value));
                }
                if let Some(value) = item
                    .manifest
                    .as_ref()
                    .and_then(|manifest| manifest.get("effective_config"))
                {
                    reply.insert("effective_config".into(), value.clone());
                }
                return success(state.clone(), Vec::new(), Some(Value::Object(reply)), None);
            }
            if !matches!(
                item.state,
                ActivationState::Ready | ActivationState::RetryWait
            ) {
                return failure(state, "ACTIVATION_NOT_LEASABLE", false, None);
            }
            if item.state == ActivationState::RetryWait
                && !retry_authorization_valid(&next, &c.activation_id, item)
            {
                return failure(state, "ACTIVATION_RETRY_NOT_AUTHORIZED", false, None);
            }
            let candidates: Vec<i64> = next
                .generations
                .iter()
                .filter(|value| value.get("compatible").and_then(Value::as_bool) != Some(false))
                .filter_map(|value| object_i64(value, "generation"))
                .collect();
            let generation = c
                .extension_generation
                .or_else(|| candidates.iter().max().copied())
                .or(next.current_generation);
            if generation
                .is_some_and(|value| !next.generations.is_empty() && !candidates.contains(&value))
            {
                return failure(state, "EXTENSION_GENERATION_INCOMPATIBLE", false, None);
            }
            let Some(attempt) = next_attempt(item.attempt) else {
                return failure(state, "ATTEMPT_SEQUENCE_EXHAUSTED", false, None);
            };
            let item = next.activations.get_mut(&c.activation_id).unwrap();
            item.next_attempt_authorization = None;
            item.state = ActivationState::Leased;
            item.attempt = attempt;
            item.extension_generation = generation;
            let manifest_digest = item
                .manifest
                .as_ref()
                .and_then(|value| object_str(value, "manifest_digest"))
                .map(str::to_string);
            let effective_config = item
                .manifest
                .as_ref()
                .and_then(|value| value.get("effective_config"))
                .cloned();
            let mut lease = Map::new();
            lease.insert("activation_id".into(), json!(c.activation_id));
            lease.insert("token_digest".into(), json!(c.token_digest));
            lease.insert("state".into(), json!("leased"));
            lease.insert("dispatch_state".into(), json!("prepared"));
            lease.insert("attempt".into(), json!(attempt));
            lease.insert(
                "extension_connection_id".into(),
                json!(c.extension_connection_id),
            );
            lease.insert("worker_epoch".into(), json!(c.worker_epoch));
            if let Some(value) = generation {
                lease.insert("extension_generation".into(), json!(value));
            }
            if let Some(value) = manifest_digest {
                lease.insert("manifest_digest".into(), json!(value));
            }
            next.leases.insert(c.lease_id.clone(), Value::Object(lease));
            for candidate in next.generations.clone() {
                if candidate.get("compatible").and_then(Value::as_bool) == Some(false) {
                    events.push(append_event(
                        &mut next,
                        &c.command_id,
                        "ExtensionGenerationIncompatible",
                        Some(json!({
                            "generation":object_i64(&candidate,"generation"),
                            "reason":object_str(&candidate,"incompatibility_reason")
                                .unwrap_or("effective_config_schema_digest"),
                        })),
                    ))
                }
            }
            events.push(append_event(
                &mut next,
                &c.command_id,
                "LeaseIssued",
                Some(json!({"activation_id":c.activation_id,"lease_id":c.lease_id})),
            ));
            let mut reply = Map::new();
            reply.insert("lease_id".into(), json!(c.lease_id));
            reply.insert("attempt".into(), json!(attempt));
            if let Some(value) = generation {
                reply.insert("extension_generation".into(), json!(value));
            }
            if let Some(value) = effective_config {
                reply.insert("effective_config".into(), value);
            }
            success(next, events, Some(Value::Object(reply)), None)
        }
        CoreCommand::DispatchLease(c) => {
            let Some(item) = next.activations.get(&c.activation_id) else {
                return failure(state, "LEASE_NOT_FOUND", false, None);
            };
            if !matches!(
                item.state,
                ActivationState::Leased | ActivationState::Dispatched
            ) {
                return failure(state, "ACTIVATION_NOT_DISPATCHABLE", false, None);
            }
            let Some(lease) = next.leases.get(&c.lease_id) else {
                return failure(state, "LEASE_NOT_FOUND", false, None);
            };
            if object_str(lease, "activation_id") != Some(c.activation_id.as_str())
                || object_i64(lease, "attempt") != Some(item.attempt)
            {
                return failure(state, "LEASE_NOT_FOUND", false, None);
            }
            let rank = |value: &str| match value {
                "prepared" => 1,
                "started" => 2,
                "transport_started" => 3,
                _ => 0,
            };
            let dispatch = match c.dispatch_state {
                DispatchState::Prepared => "prepared",
                DispatchState::Started => "started",
                DispatchState::TransportStarted => "transport_started",
            };
            if rank(dispatch) < rank(object_str(lease, "dispatch_state").unwrap_or("prepared")) {
                return failure(state, "DISPATCH_EVIDENCE_REGRESSION", false, None);
            }
            next.leases
                .get_mut(&c.lease_id)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("dispatch_state".into(), json!(dispatch));
            if c.dispatch_state != DispatchState::Prepared {
                next.activations.get_mut(&c.activation_id).unwrap().state =
                    ActivationState::Dispatched;
            }
            events.push(append_event(
                &mut next,
                &c.command_id,
                "LeaseDispatchRecorded",
                Some(json!({"lease_id":c.lease_id,"dispatch_state":dispatch})),
            ));
            success(next, events, None, None)
        }
        CoreCommand::ReceiveResult(c) => {
            if !result_binding_valid(&next, c, input) {
                return failure(state, "ACTIVATION_FENCE_INVALID", false, None);
            }
            if c.result
                .as_ref()
                .is_some_and(|value| !verified_digest(value, &c.result_digest))
            {
                events.push(record_quarantine(
                    &mut next,
                    &c.command_id,
                    &c.activation_id,
                    "ACTIVATION_RESULT_DIGEST_MISMATCH",
                    false,
                    "ModuleQuarantined",
                ));
                return success(
                    next,
                    events,
                    None,
                    Some(CoreError {
                        code: "ACTIVATION_RESULT_DIGEST_MISMATCH".into(),
                        retryable: false,
                        outcome: ErrorOutcome::Applied,
                        details: None,
                    }),
                );
            }
            let existing = next
                .activations
                .get(&c.activation_id)
                .and_then(|item| item.result_digest.clone());
            if let Some(existing) = existing {
                if existing == c.result_digest {
                    let item = next.activations.get(&c.activation_id).unwrap();
                    return success(
                        state.clone(),
                        Vec::new(),
                        Some(
                            json!({"activation_id":c.activation_id,"disposition":item.authoritative_disposition.unwrap_or(item.state),"idempotent":true}),
                        ),
                        None,
                    );
                }
                let preserve = next
                    .activations
                    .get(&c.activation_id)
                    .is_some_and(|item| item.state == ActivationState::Committed);
                events.push(record_quarantine(
                    &mut next,
                    &c.command_id,
                    &c.activation_id,
                    "ACTIVATION_RESULT_CONFLICT",
                    preserve,
                    "QuarantineCreated",
                ));
                return success(
                    next,
                    events,
                    None,
                    Some(CoreError {
                        code: "ACTIVATION_RESULT_CONFLICT".into(),
                        retryable: false,
                        outcome: ErrorOutcome::Applied,
                        details: None,
                    }),
                );
            }
            if !next.activations.get(&c.activation_id).is_some_and(|item| {
                matches!(
                    item.state,
                    ActivationState::Leased | ActivationState::Dispatched
                )
            }) {
                return failure(state, "ACTIVATION_FENCE_INVALID", false, None);
            }
            let staged = if c.status == ReceiveResultStatus::Success {
                let Some(staged) = parse_staged(c.result.as_ref()) else {
                    return failure(state, "ACTIVATION_INVALID_RESULT", false, None);
                };
                Some(staged)
            } else {
                None
            };
            let authorized_attempt = if c.status == ReceiveResultStatus::Retryable {
                let Some(authorized_attempt) = next
                    .activations
                    .get(&c.activation_id)
                    .and_then(|item| next_attempt(item.attempt))
                else {
                    return failure(state, "ATTEMPT_SEQUENCE_EXHAUSTED", false, None);
                };
                Some(authorized_attempt)
            } else {
                None
            };
            let item = next.activations.get_mut(&c.activation_id).unwrap();
            item.result_digest = Some(c.result_digest.clone());
            match c.status {
                ReceiveResultStatus::Success => {
                    let staged = staged.unwrap();
                    item.validation = staged.validation.clone();
                    item.staged_result = Some(staged);
                    item.state = ActivationState::ResultStaged;
                    item.authoritative_disposition = Some(ActivationState::ResultStaged)
                }
                ReceiveResultStatus::Retryable => {
                    item.state = ActivationState::RetryWait;
                    item.authoritative_disposition = Some(ActivationState::RetryWait);
                    item.retry_delay = input.retry_jitter;
                    item.next_attempt_authorization = Some(
                        json!({"activation_id":c.activation_id,"authorized_attempt":authorized_attempt.unwrap(),"source_attempt":item.attempt,"reason":"explicit_retryable_failure","evidence_digest":c.result_digest}),
                    )
                }
                ReceiveResultStatus::Permanent => {}
            }
            if c.status == ReceiveResultStatus::Permanent {
                events.push(record_quarantine(
                    &mut next,
                    &c.command_id,
                    &c.activation_id,
                    "ACTIVATION_RESULT_PERMANENT",
                    false,
                    "ModuleQuarantined",
                ));
                next.activations
                    .get_mut(&c.activation_id)
                    .unwrap()
                    .authoritative_disposition = Some(ActivationState::Quarantined)
            }
            events.push(append_event(&mut next,&c.command_id,"ResultReceived",Some(json!({"activation_id":c.activation_id,"status":c.status,"result_digest":c.result_digest}))));
            success(next, events, None, None)
        }
        CoreCommand::BeginFence(c) => {
            let Some(lease_id) = lease_id_for(&next, &c.activation_id) else {
                return failure(state, "ACTIVATION_NOT_FENCEABLE", false, None);
            };
            if !next.activations.get(&c.activation_id).is_some_and(|item| {
                matches!(
                    item.state,
                    ActivationState::Leased | ActivationState::Dispatched
                )
            }) {
                return failure(state, "ACTIVATION_NOT_FENCEABLE", false, None);
            }
            next.activations.get_mut(&c.activation_id).unwrap().state = ActivationState::Fencing;
            next.leases
                .get_mut(&lease_id)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("fence_pending".into(), json!(true));
            events.push(append_event(
                &mut next,
                &c.command_id,
                "FenceStarted",
                Some(json!({"activation_id":c.activation_id})),
            ));
            success(next, events, None, None)
        }
        CoreCommand::RecordReplayEvidence(c) => {
            let Some(lease_id) = lease_id_for(&next, &c.activation_id) else {
                return failure(state, "ACTIVATION_REPLAY_EVIDENCE_INVALID", false, None);
            };
            let Some(item) = next.activations.get(&c.activation_id) else {
                return failure(state, "ACTIVATION_REPLAY_EVIDENCE_INVALID", false, None);
            };
            let dispatch = object_str(next.leases.get(&lease_id).unwrap(), "dispatch_state");
            if item.state != ActivationState::Fencing
                || !matches!(dispatch, Some("started" | "transport_started"))
                || replay_contract(item).1 != "activation_ledger"
            {
                return failure(state, "ACTIVATION_REPLAY_EVIDENCE_INVALID", false, None);
            }
            let Some(evidence) = input.host_replay_evidence.as_ref() else {
                return failure(state, "ACTIVATION_REPLAY_EVIDENCE_INVALID", false, None);
            };
            if !replay_evidence_valid(item, &c.activation_id, evidence) {
                return failure(state, "ACTIVATION_REPLAY_EVIDENCE_INVALID", false, None);
            }
            if let Some(existing) = item.replay_evidence.as_ref() {
                if object_str(existing, "evidence_digest") == Some(evidence.digest.as_str()) {
                    return success(
                        state.clone(),
                        Vec::new(),
                        Some(json!({"evidence_digest":evidence.digest,"idempotent":true})),
                        None,
                    );
                }
                let incident =
                    json!({"code":"STORAGE_IDEMPOTENCY_CONFLICT","activation_id":c.activation_id});
                next.security_incidents.push(incident.clone());
                events.push(append_event(
                    &mut next,
                    &c.command_id,
                    "SecurityIncident",
                    Some(incident.clone()),
                ));
                return success(
                    next,
                    events,
                    None,
                    Some(CoreError {
                        code: "STORAGE_IDEMPOTENCY_CONFLICT".into(),
                        retryable: false,
                        outcome: ErrorOutcome::NotApplied,
                        details: Some(incident),
                    }),
                );
            }
            let mut record = evidence.record.clone();
            let Some(map) = record.as_object_mut() else {
                return failure(state, "ACTIVATION_REPLAY_EVIDENCE_INVALID", false, None);
            };
            map.insert("evidence_digest".into(), json!(evidence.digest));
            map.insert("observation".into(), json!(evidence.observation));
            if let Some(generation) = evidence.target_generation {
                map.insert("target_generation".into(), json!(generation));
            }
            next.activations
                .get_mut(&c.activation_id)
                .unwrap()
                .replay_evidence = Some(record);
            events.push(append_event(&mut next,&c.command_id,"ActivationReplayEvidenceRecorded",Some(json!({"activation_id":c.activation_id,"observation":evidence.observation,"evidence_digest":evidence.digest}))));
            success(next, events, None, None)
        }
        CoreCommand::FenceComplete(c) => {
            let Some(lease_id) = lease_id_for(&next, &c.activation_id) else {
                return failure(state, "FENCE_PROOF_INVALID", false, None);
            };
            let Some(item) = next.activations.get(&c.activation_id) else {
                return failure(state, "FENCE_PROOF_INVALID", false, None);
            };
            let Some(proof) = input.host_fence_verification.as_ref() else {
                return failure(state, "FENCE_PROOF_INVALID", false, None);
            };
            if item.state != ActivationState::Fencing
                || !proof.verified
                || !proof.execution_slot_empty
                || proof.activation_id != c.activation_id
                || proof.source_attempt != item.attempt
                || !digest_format(&proof.proof_digest)
            {
                return failure(state, "FENCE_PROOF_INVALID", false, None);
            }
            let dispatch = object_str(next.leases.get(&lease_id).unwrap(), "dispatch_state")
                .unwrap_or("prepared")
                .to_string();
            {
                let lease = next
                    .leases
                    .get_mut(&lease_id)
                    .unwrap()
                    .as_object_mut()
                    .unwrap();
                lease.insert("dispatch_state".into(), json!("fenced"));
                lease.insert("fence_pending".into(), json!(false));
                lease.insert("fence_evidence_digest".into(), json!(proof.proof_digest));
            }
            let item = next.activations.get(&c.activation_id).unwrap();
            let contract = replay_contract(item);
            let ledger_evidence_valid = stored_replay_evidence_valid(item, &c.activation_id);
            let ledger_authorized = contract.1 == "activation_ledger"
                && ledger_evidence_valid
                && matches!(
                    item.replay_evidence
                        .as_ref()
                        .and_then(|value| object_str(value, "observation")),
                    Some("succeeded" | "failed")
                );
            if dispatch == "prepared" || ledger_authorized {
                let evidence_digest = if dispatch == "prepared" {
                    proof.proof_digest.clone()
                } else {
                    object_str(item.replay_evidence.as_ref().unwrap(), "evidence_digest")
                        .unwrap()
                        .to_string()
                };
                let reason = if dispatch == "prepared" {
                    "safe_before_dispatch"
                } else {
                    "activation_ledger"
                };
                let Some(authorized_attempt) = next_attempt(item.attempt) else {
                    return failure(state, "ATTEMPT_SEQUENCE_EXHAUSTED", false, None);
                };
                let item = next.activations.get_mut(&c.activation_id).unwrap();
                item.state = ActivationState::RetryWait;
                item.retry_delay = Some(c.retry_delay);
                item.next_attempt_authorization = Some(
                    json!({"activation_id":c.activation_id,"authorized_attempt":authorized_attempt,"source_attempt":item.attempt,"reason":reason,"evidence_digest":evidence_digest}),
                );
                events.push(append_event(
                    &mut next,
                    &c.command_id,
                    "ActivationRetryScheduled",
                    Some(json!({"activation_id":c.activation_id,"authorization":reason})),
                ))
            } else {
                let reason = if contract.0 == "never_auto_retry" {
                    "ACTIVATION_REPLAY_NOT_AUTHORIZED"
                } else if contract.1 == "activation_ledger"
                    && item.replay_evidence.is_some()
                    && !ledger_evidence_valid
                {
                    "ACTIVATION_REPLAY_CONTRACT_VIOLATION"
                } else {
                    "ACTIVATION_EXTERNAL_OUTCOME_UNKNOWN"
                };
                events.push(record_quarantine(
                    &mut next,
                    &c.command_id,
                    &c.activation_id,
                    reason,
                    false,
                    "ModuleQuarantined",
                ))
            }
            success(next, events, None, None)
        }
        CoreCommand::ApplyResult(c) => {
            let Some(item) = next.activations.get(&c.activation_id) else {
                return failure(state, "ACTIVATION_RESULT_NOT_STAGED", false, None);
            };
            if !matches!(
                item.state,
                ActivationState::ResultStaged | ActivationState::CommitBlocked
            ) || item.staged_result.is_none()
            {
                return failure(state, "ACTIVATION_RESULT_NOT_STAGED", false, None);
            }
            let staged = item.staged_result.clone().unwrap();
            for (subscription_id, expected) in &staged.expected_cursors {
                if next
                    .subscriptions
                    .get(subscription_id)
                    .map(|record| record.cursor)
                    != Some(*expected)
                {
                    let mut stopped = state.clone();
                    stopped.mode = InstanceMode::RecoveryRequired;
                    let actual = state
                        .subscriptions
                        .get(subscription_id)
                        .map_or(-1, |record| record.cursor);
                    let details = json!({"reason":"ACTIVATION_CURSOR_CONFLICT","activation_id":c.activation_id,"subscription_id":subscription_id,"expected":expected,"actual":actual});
                    stopped.security_incidents.push(details.clone());
                    let event = append_event(
                        &mut stopped,
                        &c.command_id,
                        "RecoveryRequired",
                        Some(details.clone()),
                    );
                    let projection = project_core_state(&stopped);
                    let state_hash =
                        hash_core_state(&stopped).expect("validated recovery snapshot");
                    return Transition {
                        outcome: TransitionOutcome::RolledBackWithSafetyStop,
                        state: stopped.clone(),
                        events: vec![event.clone()],
                        error: Some(CoreError {
                            code: "ACTIVATION_CURSOR_CONFLICT".into(),
                            retryable: false,
                            outcome: ErrorOutcome::Applied,
                            details: Some(details),
                        }),
                        reply: None,
                        projection,
                        state_hash,
                        safety_stop: Some(SafetyStop {
                            state: stopped,
                            event,
                        }),
                    };
                }
            }
            let projected = projected_pending(&next, &staged);
            if let Some(limit) = staged.page_limit.filter(|limit| projected > *limit) {
                if staged.projected_admission_entries > limit {
                    let item = next.activations.get_mut(&c.activation_id).unwrap();
                    item.state = ActivationState::CommitBlocked;
                    item.authoritative_disposition = Some(ActivationState::CommitBlocked);
                    return success(
                        next,
                        Vec::new(),
                        None,
                        Some(CoreError {
                            code: "ACTIVATION_COMMIT_BLOCKED".into(),
                            retryable: true,
                            outcome: ErrorOutcome::Applied,
                            details: Some(
                                json!({"projected_admission_entries":projected}),
                            ),
                        }),
                    );
                }
                return failure(
                    state,
                    "PAGE_QUOTA_EXCEEDED",
                    true,
                    Some(json!({"projected_admission_entries":projected})),
                );
            }
            for (id, expected) in &staged.expected_cursors {
                next.subscriptions.get_mut(id).unwrap().cursor = expected + 1;
            }
            for (page_id, pages) in &staged.admitted_pages {
                next.pages.insert(page_id.clone(), pages.clone());
                for page in pages {
                    let Some(sequence_after_page) = page.page_seq.checked_add(1) else {
                        return failure(state, "PAGE_SEQUENCE_INVALID", false, None);
                    };
                    if sequence_after_page > MAX_SAFE_INTEGER {
                        return failure(state, "PAGE_SEQUENCE_INVALID", false, None);
                    }
                    next.next_page_seq = next.next_page_seq.max(sequence_after_page);
                }
            }
            for output in &staged.outputs {
                next.outputs.push(output.clone());
                if let (Some(block_id), Some(block)) =
                    (object_str(output, "block_id"), output.get("block"))
                {
                    next.blocks.insert(block_id.into(), block.clone());
                }
                if let Some(deliveries) = output.get("deliveries").and_then(Value::as_array) {
                    next.deliveries.extend(deliveries.iter().cloned())
                }
            }
            let item = next.activations.get_mut(&c.activation_id).unwrap();
            item.state = ActivationState::Committed;
            item.authoritative_disposition = Some(ActivationState::Committed);
            item.staged_result = None;
            let digest = item.result_digest.clone();
            // INV-ROUTE-001: report the manifest-pinned graph revision, never
            // the active graph at result time (INV-CFG-003).
            let graph_revision = item
                .manifest
                .as_ref()
                .and_then(|manifest| manifest.get("graph_revision"))
                .and_then(Value::as_i64);
            let mut details = json!({"activation_id":c.activation_id,"result_digest":digest});
            if let Some(graph_revision) = graph_revision {
                details["graph_revision"] = json!(graph_revision);
            }
            events.push(append_event(
                &mut next,
                &c.command_id,
                "ActivationCommitted",
                Some(details),
            ));
            success(
                next,
                events,
                Some(json!({"projected_admission_entries":projected})),
                None,
            )
        }
        CoreCommand::CancelActivation(c) => {
            let Some(item) = next.activations.get_mut(&c.activation_id) else {
                return failure(state, "ACTIVATION_NOT_CANCELLABLE", false, None);
            };
            if item.state == ActivationState::Committed {
                return failure(state, "ACTIVATION_NOT_CANCELLABLE", false, None);
            }
            item.state = ActivationState::Cancelled;
            events.push(append_event(
                &mut next,
                &c.command_id,
                "ActivationCancelled",
                Some(json!({"activation_id":c.activation_id,"reason":c.reason})),
            ));
            success(next, events, None, None)
        }
        CoreCommand::ResolveQuarantine(c) => {
            let Some(quarantine) = next.quarantines.get(&c.activation_id) else {
                return failure(state, "QUARANTINE_NOT_FOUND", false, None);
            };
            let Some(item) = next.activations.get(&c.activation_id) else {
                return failure(state, "ACTIVATION_NOT_FOUND", false, None);
            };
            if item.state == ActivationState::Committed {
                return failure(state, "ACTIVATION_COMMITTED_IMMUTABLE", false, None);
            }
            let attempt = item.attempt;
            if c.resolution == ResolveQuarantineResolution::Retry {
                let Some(proof) = input.host_fence_verification.as_ref() else {
                    return failure(state, "QUARANTINE_REVIEW_NOT_AUTHORIZED", false, None);
                };
                if quarantine.get("fence_complete").and_then(Value::as_bool) != Some(true)
                    || !proof.verified
                    || !proof.execution_slot_empty
                    || proof.activation_id != c.activation_id
                    || proof.source_attempt != attempt
                    || !digest_format(&proof.proof_digest)
                {
                    return failure(state, "QUARANTINE_REVIEW_NOT_AUTHORIZED", false, None);
                }
            }
            let authorized_attempt = if c.resolution == ResolveQuarantineResolution::Retry {
                let Some(authorized_attempt) = next_attempt(attempt) else {
                    return failure(state, "ATTEMPT_SEQUENCE_EXHAUSTED", false, None);
                };
                Some(authorized_attempt)
            } else {
                None
            };
            next.quarantines.remove(&c.activation_id);
            let item = next.activations.get_mut(&c.activation_id).unwrap();
            match c.resolution {
                ResolveQuarantineResolution::Retry => {
                    let proof = input.host_fence_verification.as_ref().unwrap();
                    item.state = ActivationState::RetryWait;
                    item.retry_delay = c.retry_delay.or(input.retry_jitter);
                    item.next_attempt_authorization = Some(
                        json!({"activation_id":c.activation_id,"authorized_attempt":authorized_attempt.unwrap(),"source_attempt":attempt,"reason":"operator_review","evidence_digest":proof.proof_digest,"reviewed":true}),
                    )
                }
                ResolveQuarantineResolution::Cancel => item.state = ActivationState::Cancelled,
            }
            events.push(append_event(
                &mut next,
                &c.command_id,
                "QuarantineResolved",
                Some(json!({"activation_id":c.activation_id,"resolution":c.resolution})),
            ));
            success(next, events, None, None)
        }
        CoreCommand::CompleteQuarantineFence(c) => {
            if !next.quarantines.contains_key(&c.activation_id) {
                return failure(state, "QUARANTINE_NOT_FOUND", false, None);
            }
            let Some(proof) = input.host_fence_verification.as_ref() else {
                return failure(state, "FENCE_PROOF_INVALID", false, None);
            };
            if !proof.verified
                || !proof.execution_slot_empty
                || proof.activation_id != c.activation_id
                || next
                    .activations
                    .get(&c.activation_id)
                    .map(|item| item.attempt)
                    != Some(proof.source_attempt)
            {
                return failure(state, "FENCE_PROOF_INVALID", false, None);
            }
            let Some(quarantine) = next
                .quarantines
                .get_mut(&c.activation_id)
                .and_then(Value::as_object_mut)
            else {
                return failure(state, "QUARANTINE_STATE_INVALID", false, None);
            };
            quarantine.insert("fence_complete".into(), json!(true));
            events.push(append_event(
                &mut next,
                &c.command_id,
                "QuarantineFenceCompleted",
                Some(json!({"activation_id":c.activation_id})),
            ));
            success(next, events, None, None)
        }
        CoreCommand::DeadLetterRange(c) => {
            let Some(subscription) = next.subscriptions.get(&c.subscription_id) else {
                return failure(state, "SUBSCRIPTION_DISPOSITION_CONFLICT", false, None);
            };
            if subscription.cursor != c.start
                || c.end_exclusive <= c.start
                || c.end_exclusive > next.next_page_seq
            {
                return failure(state, "SUBSCRIPTION_DISPOSITION_CONFLICT", false, None);
            }
            next.subscriptions
                .get_mut(&c.subscription_id)
                .unwrap()
                .cursor = c.end_exclusive;
            events.push(append_event(&mut next,&c.command_id,"RangeDeadLettered",Some(json!({"subscription_id":c.subscription_id,"start":c.start,"end_exclusive":c.end_exclusive,"reason":c.reason}))));
            success(next, events, None, None)
        }
        CoreCommand::SkipRange(c) => {
            let Some(subscription) = next.subscriptions.get(&c.subscription_id) else {
                return failure(state, "SUBSCRIPTION_DISPOSITION_CONFLICT", false, None);
            };
            if subscription.cursor != c.start
                || c.end_exclusive <= c.start
                || c.end_exclusive > next.next_page_seq
            {
                return failure(state, "SUBSCRIPTION_DISPOSITION_CONFLICT", false, None);
            }
            next.subscriptions
                .get_mut(&c.subscription_id)
                .unwrap()
                .cursor = c.end_exclusive;
            events.push(append_event(&mut next,&c.command_id,"RangeSkipped",Some(json!({"subscription_id":c.subscription_id,"start":c.start,"end_exclusive":c.end_exclusive}))));
            success(next, events, None, None)
        }
        CoreCommand::LossyEvict(c) => {
            if c.start >= c.end_exclusive {
                return failure(state, "LOSSY_RANGE_INVALID", false, None);
            }
            let gap = json!({"page_id":c.page_id,"start":c.start,"end_exclusive":c.end_exclusive,"reason":c.reason});
            next.lossy_gaps.push(gap.clone());
            next.volatile_lossy_entries
                .retain(|entry| object_str(entry, "page_id") != Some(c.page_id.as_str()));
            events.push(append_event(
                &mut next,
                &c.command_id,
                "LossyGap",
                Some(gap),
            ));
            success(next, events, None, None)
        }
        CoreCommand::Recover(c) => {
            let Some(verification) = input.recovery_verification.as_ref() else {
                return failure(state, "RECOVERY_VERIFICATION_INCOMPLETE", false, None);
            };
            if !verification.ordered_checks_complete {
                return failure(state, "RECOVERY_VERIFICATION_INCOMPLETE", false, None);
            }
            if !safe_nonnegative(c.persisted_next_page_seq) {
                return failure(state, "PAGE_SEQUENCE_INVALID", false, None);
            }
            if c.persisted_next_page_seq < state.next_page_seq {
                return failure(state, "PAGE_SEQUENCE_REGRESSION", false, None);
            }
            let valid = verification.invariants_valid
                && verification.persisted_values_valid
                && verification.process_fences_valid
                && verification.staged_results_valid;
            if !valid {
                next.mode = InstanceMode::RecoveryRequired;
                let details = json!({"reason":verification.failure_reason.as_deref().unwrap_or("ordered recovery verification failed")});
                next.security_incidents.push(details.clone());
                events.push(append_event(
                    &mut next,
                    &c.command_id,
                    "RecoveryRequired",
                    Some(details),
                ));
                return success(next, events, None, None);
            }
            next.volatile_lossy_entries.clear();
            if c.persisted_next_page_seq > next.next_page_seq {
                let gap = json!({"start":next.next_page_seq,"end_exclusive":c.persisted_next_page_seq,"reason":"restart"});
                next.lossy_gaps.push(gap.clone());
                events.push(append_event(
                    &mut next,
                    &c.command_id,
                    "LossyGap",
                    Some(gap),
                ))
            }
            next.next_page_seq = c.persisted_next_page_seq;
            next.mode = InstanceMode::Running;
            events.push(append_event(
                &mut next,
                &c.command_id,
                "RecoveryCompleted",
                None,
            ));
            success(next, events, None, None)
        }
    }
}
