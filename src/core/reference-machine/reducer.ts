import { canonicalJsonDigest, type JsonValue } from "../../schema-bundle/index.js";
import { hashCoreState, projectCoreState } from "./projection.js";
import { emptyCoreSnapshot, type ActivationRecord, type CoreCommand, type CoreError, type CoreEvent, type CoreSnapshot, type JsonObject, type PageRecord, type ReducerInput, type StagedResult, type Transition } from "./types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_SAFE_INTEGER = 9007199254740991;
function safeNonnegative(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAFE_INTEGER; }
function snapshotCountersValid(state: CoreSnapshot): boolean {
  return safeNonnegative(state.next_commit_seq)
    && safeNonnegative(state.next_page_seq)
    && Object.values(state.subscriptions).every((sub) => safeNonnegative(sub.cursor))
    && Object.values(state.pages).flat().every((page) => Number.isSafeInteger(page.page_seq) && page.page_seq >= 0 && page.page_seq < MAX_SAFE_INTEGER)
    && Object.values(state.activations).every((act) => safeNonnegative(act.attempt))
    && state.journal.every((event) => safeNonnegative(event.commit_seq));
}
function nextAttempt(attempt: number): number | undefined {
  const result = attempt + 1;
  return Number.isSafeInteger(result) && result >= 0 && result <= MAX_SAFE_INTEGER ? result : undefined;
}
function commitIncrementBudget(state: CoreSnapshot, command: CoreCommand): number | undefined {
  switch (command.type) {
    case "Ingress": return command.pages.length + 1;
    case "IssueLease": return state.generations.filter((g) => g.compatible === false).length + 1;
    case "ReceiveResult":
    case "Recover": return 2;
    default: return 1;
  }
}

function copy(state: CoreSnapshot): CoreSnapshot { return structuredClone(state); }
function activation(state: CoreSnapshot, id: string): ActivationRecord | undefined { return state.activations[id]; }
function failure(state: CoreSnapshot, code: string, retryable = false, details?: JsonObject): Transition {
  const error: CoreError = { code, retryable, outcome: "not_applied", ...(details ? { details } : {}) };
  return { outcome: "rolled_back", state, events: [], error, projection: projectCoreState(state), state_hash: hashCoreState(state) };
}
function failureWithEmission(state: CoreSnapshot, commandId: string, code: string, event: string, details: JsonObject): Transition {
  const error: CoreError = { code, retryable: true, outcome: "not_applied", details };
  const emitted: CoreEvent = { event, commit_seq: state.next_commit_seq, command_id: commandId, details };
  return { outcome: "rolled_back", state, events: [emitted], error, projection: projectCoreState(state), state_hash: hashCoreState(state) };
}
function appendEvent(state: CoreSnapshot, commandId: string, event: string, details?: JsonObject): CoreEvent {
  const record: CoreEvent = { event, commit_seq: state.next_commit_seq++, command_id: commandId, ...(details ? { details } : {}) };
  state.journal.push(record);
  return record;
}
function success(state: CoreSnapshot, events: CoreEvent[], reply?: JsonObject, error?: CoreError): Transition {
  return { outcome: "committed", state, events, ...(reply ? { reply } : {}), ...(error ? { error } : {}), projection: projectCoreState(state), state_hash: hashCoreState(state) };
}
function invalidSnapshotTransition(code = "CORE_STATE_CANONICAL_JSON_INVALID"): Transition {
  const stopped = emptyCoreSnapshot();
  stopped.mode = "recovery_required";
  const details: JsonObject = { reason: code };
  stopped.security_incidents.push(details);
  const event = appendEvent(stopped, "snapshot-validation", "RecoveryRequired", details);
  return {
    outcome: "rolled_back_with_safety_stop",
    state: stopped,
    events: [event],
    error: { code, retryable: false, outcome: "not_applied", details },
    projection: projectCoreState(stopped),
    state_hash: hashCoreState(stopped),
    safety_stop: { state: stopped, event },
  };
}
function recordQuarantine(state: CoreSnapshot, command: CoreCommand, activationId: string, reason: string, preserveActivation = false, event = "QuarantineCreated"): CoreEvent {
  const record: JsonObject = { reason, activation_id: activationId };
  state.quarantines[activationId] = record;
  const item = activation(state, activationId);
  if (item && !preserveActivation) item.state = "quarantined";
  if (item) delete item.next_attempt_authorization;
  return appendEvent(state, command.command_id, event, record);
}
function projectedPendingEntries(state: CoreSnapshot, staged: StagedResult): number {
  const cursors = Object.entries(state.subscriptions).map(([subscriptionId, subscription]) => staged.expected_cursors[subscriptionId] === undefined ? subscription.cursor : staged.expected_cursors[subscriptionId]! + 1);
  if (cursors.length === 0) {
    let retained = 0;
    for (const pages of Object.values(state.pages)) for (const page of pages) retained += page.entries.length;
    return retained + staged.projected_admission_entries;
  }
  const earliestCursor = Math.min(...cursors);
  let pending = 0;
  for (const pages of Object.values(state.pages)) for (const page of pages) if (page.page_seq >= earliestCursor) pending += page.entries.length;
  return pending + staged.projected_admission_entries;
}
function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function verifiedDigest(value: JsonValue, claimed: string): boolean {
  if (!DIGEST.test(claimed)) return false;
  try {
    return canonicalJsonDigest(value) === claimed;
  } catch {
    return false;
  }
}
function canonicalValue(value: JsonValue): boolean {
  try {
    canonicalJsonDigest(value);
    return true;
  } catch {
    return false;
  }
}
function sameValue(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  try {
    return canonicalJsonDigest(left) === canonicalJsonDigest(right);
  } catch {
    return false;
  }
}
function replayContract(item: ActivationRecord): { mode: "never_auto_retry" | "fenced_replay"; evidence: "none" | "activation_ledger" } {
  const contract = item.manifest?.frozen_replay_contract;
  if (isObject(contract) && contract.mode === "fenced_replay" && contract.evidence === "activation_ledger") {
    return { mode: "fenced_replay", evidence: "activation_ledger" };
  }
  return { mode: "never_auto_retry", evidence: "none" };
}
function leaseFor(state: CoreSnapshot, activationId: string): JsonObject | undefined {
  const item = activation(state, activationId);
  if (!item) return undefined;
  const candidates = Object.values(state.leases).filter((candidate) =>
    candidate.activation_id === activationId && Number(candidate.attempt) === item.attempt
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}
function parseIntegerMap(value: JsonValue | undefined): Record<string, number> | undefined {
  if (!isObject(value)) return value === undefined ? {} : undefined;
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!Number.isSafeInteger(item) || (item as number) < 0 || (item as number) >= Number.MAX_SAFE_INTEGER) return undefined;
    result[key] = item as number;
  }
  return result;
}
function parsePages(value: JsonValue | undefined): Record<string, PageRecord[]> | undefined {
  if (!isObject(value)) return value === undefined ? {} : undefined;
  const result: Record<string, PageRecord[]> = {};
  for (const [pageId, pages] of Object.entries(value)) {
    if (!Array.isArray(pages)) return undefined;
    const parsed: PageRecord[] = [];
    for (const page of pages) {
      if (!isObject(page) || !Number.isSafeInteger(page.page_seq) || (page.page_seq as number) < 0 || (page.page_seq as number) >= Number.MAX_SAFE_INTEGER || !Array.isArray(page.entries)) return undefined;
      parsed.push({ page_seq: page.page_seq as number, entries: structuredClone(page.entries), ...(page.lossy === true ? { lossy: true } : {}) });
    }
    result[pageId] = parsed;
  }
  return result;
}
function parseStagedResult(value: JsonObject | undefined): StagedResult | undefined {
  const expectedCursors = parseIntegerMap(value?.expected_cursors);
  const admittedPages = parsePages(value?.admitted_pages);
  if (!expectedCursors || !admittedPages) return undefined;
  const outputsValue = value?.outputs;
  if (outputsValue !== undefined && (!Array.isArray(outputsValue) || !outputsValue.every(isObject))) return undefined;
  const projected = value?.projected_admission_entries ?? 0;
  const limit = value?.page_limit;
  if (!Number.isSafeInteger(projected) || (projected as number) < 0 || (projected as number) > Number.MAX_SAFE_INTEGER || (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 0 || (limit as number) > Number.MAX_SAFE_INTEGER))) return undefined;
  return {
    expected_cursors: expectedCursors,
    outputs: structuredClone((outputsValue ?? []) as JsonObject[]),
    admitted_pages: admittedPages,
    projected_admission_entries: projected as number,
    ...(limit === undefined ? {} : { page_limit: limit as number }),
    ...(isObject(value?.validation) ? { validation: structuredClone(value.validation) } : {}),
  };
}
function resultBindingValid(state: CoreSnapshot, command: Extract<CoreCommand, { type: "ReceiveResult" }>, input: ReducerInput): boolean {
  const proof = input.host_result_verification;
  const item = activation(state, command.activation_id);
  const lease = state.leases[command.lease_id];
  if (!proof?.verified || !proof.payload_valid || !item || !lease) return false;
  if (proof.activation_id !== command.activation_id || proof.lease_id !== command.lease_id || proof.result_digest !== command.result_digest) return false;
  if (lease.activation_id !== command.activation_id || lease.token_digest !== proof.token_digest || Number(lease.attempt) !== proof.attempt || item.attempt !== proof.attempt) return false;
  if (lease.extension_connection_id !== proof.extension_connection_id || Number(lease.worker_epoch) !== proof.worker_epoch) return false;
  if ((lease.extension_generation === undefined) !== (proof.extension_generation === undefined)) return false;
  if (proof.extension_generation !== undefined && Number(lease.extension_generation) !== proof.extension_generation) return false;
  if ((lease.manifest_digest === undefined) !== (proof.manifest_digest === undefined)) return false;
  if (proof.manifest_digest !== undefined && lease.manifest_digest !== proof.manifest_digest) return false;
  return true;
}
function replayEvidenceValid(item: ActivationRecord, activationId: string, evidence: NonNullable<ReducerInput["host_replay_evidence"]>): boolean {
  if (!evidence.verified || evidence.activation_id !== activationId || evidence.source_attempt !== item.attempt || !verifiedDigest(evidence.record, evidence.digest)) return false;
  const record = evidence.record;
  if (record.activation_id !== activationId || record.source_attempt !== item.attempt) return false;
  const manifestDigest = item.manifest?.manifest_digest;
  if (typeof manifestDigest !== "string" || record.manifest_digest !== manifestDigest) return false;
  if ((item.extension_generation === undefined) !== (evidence.target_generation === undefined)) return false;
  if (evidence.target_generation !== undefined && (record.target_extension_generation !== evidence.target_generation || item.extension_generation !== evidence.target_generation)) return false;
  const moduleId = item.manifest?.module_id;
  const storageScopeId = item.manifest?.storage_scope_id;
  if (typeof moduleId !== "string" || typeof storageScopeId !== "string") return false;
  if (record.module_id !== moduleId || record.storage_scope_id !== storageScopeId) return false;
  const contract = item.manifest?.frozen_replay_contract;
  if (isObject(contract) && contract.ledger !== undefined && !sameValue(record.ledger, contract.ledger)) return false;
  const observation = record.ledger_state === "complete" ? "succeeded" : record.ledger_state === "failed" ? "failed" : "unknown";
  return evidence.observation === observation;
}
function retryAuthorizationValid(state: CoreSnapshot, activationId: string, item: ActivationRecord): boolean {
  const authorization = item.next_attempt_authorization;
  if (!authorization) return false;
  const authorizedAttempt = nextAttempt(item.attempt);
  if (authorizedAttempt === undefined || authorization.activation_id !== activationId || authorization.source_attempt !== item.attempt || authorization.authorized_attempt !== authorizedAttempt) return false;
  const digest = authorization.evidence_digest;
  if (typeof digest !== "string" || !DIGEST.test(digest)) return false;
  if (authorization.reason === "safe_before_dispatch") {
    const lease = leaseFor(state, activationId);
    return lease?.dispatch_state === "fenced" && lease.fence_evidence_digest === digest;
  }
  if (authorization.reason === "explicit_retryable_failure") return item.result_digest === digest;
  if (authorization.reason === "activation_ledger") return item.replay_evidence?.evidence_digest === digest;
  if (authorization.reason === "operator_review") return authorization.reviewed === true;
  return false;
}

/** Pure reducer for the closed 21-command Core reference-machine boundary. */
export function reduceCore(state: CoreSnapshot, command: CoreCommand, input: ReducerInput): Transition {
  try {
    hashCoreState(state);
  } catch {
    return invalidSnapshotTransition();
  }
  if (!snapshotCountersValid(state)) return invalidSnapshotTransition("CORE_STATE_COUNTER_INVALID");
  const budget = commitIncrementBudget(state, command);
  if (budget === undefined || state.next_commit_seq + budget > MAX_SAFE_INTEGER) return failure(state, "COMMIT_SEQUENCE_EXHAUSTED");
  if (state.mode === "recovery_required" && command.type !== "Recover") return failure(state, "RECOVERY_REQUIRED");
  if (input.storage_observation === "before_commit") return failure(state, "SIMULATED_CRASH", true, input.crash_point ? { crash_point: input.crash_point } : undefined);
  const next = copy(state);
  const events: CoreEvent[] = [];

  switch (command.type) {
    case "InstallConfig": {
      if (!verifiedDigest(command.effective_config, command.digest)) return failure(state, "CONFIG_DIGEST_MISMATCH");
      const current = Number(next.config.revision ?? -1);
      if (command.revision <= current) return failure(state, "CONFIG_REVISION_CONFLICT");
      next.config = { revision: command.revision, effective_config: command.effective_config, digest: command.digest };
      events.push(appendEvent(next, command.command_id, "ConfigInstalled", { revision: command.revision, digest: command.digest }));
      return success(next, events);
    }
    case "InstallGraph": {
      if (!verifiedDigest(command.graph, command.digest)) return failure(state, "GRAPH_DIGEST_MISMATCH");
      const current = Number(next.graph.revision ?? -1);
      if (command.revision <= current) return failure(state, "GRAPH_REVISION_CONFLICT");
      next.graph = { revision: command.revision, graph: command.graph, digest: command.digest };
      events.push(appendEvent(next, command.command_id, "GraphInstalled", { revision: command.revision, digest: command.digest }));
      return success(next, events);
    }
    case "Ingress": {
      const identity = `${command.runtime_source}\u0000${command.ingress_key}`;
      const existing = next.ingress[identity];
      if (existing) {
        if (existing.operation_digest !== command.operation_digest) return failure(state, "STORAGE_IDEMPOTENCY_CONFLICT", false, { identity });
        return success(state, [], { block_id: existing.block_id, idempotent: true });
      }
      if (!canonicalValue(command.block)) return failure(state, "CANONICAL_JSON_INVALID");
      next.ingress[identity] = { operation_digest: command.operation_digest, block_id: command.block_id, pages: [...new Set(command.pages)].sort() };
      const ingressEvent: CoreEvent = { event: "IngressCommitted", commit_seq: next.next_commit_seq++, command_id: command.command_id, details: { block_id: command.block_id } };
      next.blocks[command.block_id] = { ...command.block, commit_seq: ingressEvent.commit_seq };
      for (const page of next.ingress[identity].pages) next.deliveries.push({ block_id: command.block_id, page_id: page, commit_seq: next.next_commit_seq++ });
      next.journal.push(ingressEvent); events.push(ingressEvent);
      return success(next, events, { block_id: command.block_id, idempotent: false });
    }
    case "RuntimeEvent": {
      const identity = `${command.runtime_source}\u0000${command.event_key}`;
      const existing = next.runtime_events[identity];
      if (existing?.operation_digest === command.operation_digest) return success(state, [], { block_id: existing.block_id, idempotent: true });
      if (existing) {
        const incident: JsonObject = { code: "STORAGE_IDEMPOTENCY_CONFLICT", identity, original_digest: existing.operation_digest, conflicting_digest: command.operation_digest };
        next.security_incidents.push(incident);
        events.push(appendEvent(next, command.command_id, "SecurityIncident", incident));
        return success(next, events, undefined, { code: "STORAGE_IDEMPOTENCY_CONFLICT", retryable: false, outcome: "applied", details: incident });
      }
      if (!canonicalValue(command.block)) return failure(state, "CANONICAL_JSON_INVALID");
      next.runtime_events[identity] = { operation_digest: command.operation_digest, block_id: command.block_id };
      next.blocks[command.block_id] = command.block;
      for (const page of [...new Set(command.pages)].sort()) next.deliveries.push({ block_id: command.block_id, page_id: page });
      events.push(appendEvent(next, command.command_id, "RuntimeEventCommitted", { runtime_source: command.runtime_source, event_key: command.event_key }));
      return success(next, events, { block_id: command.block_id, idempotent: false });
    }
    case "GrantStorageWriter": {
      if (next.storage_writer_owner && next.storage_writer_owner !== command.owner) return failure(state, "STORAGE_WRITER_OWNED");
      next.storage_writer_owner = command.owner;
      events.push(appendEvent(next, command.command_id, "StorageWriterGranted", { owner: command.owner }));
      return success(next, events);
    }
    case "ReleaseStorageWriter": {
      if (next.storage_writer_owner !== command.owner) return failure(state, "STORAGE_WRITER_FENCE_CONFLICT");
      next.storage_writer_owner = null;
      events.push(appendEvent(next, command.command_id, "StorageWriterReleased", { owner: command.owner }));
      return success(next, events);
    }
    case "BuildManifest": {
      const existing = next.manifests[command.activation_id];
      if (existing !== undefined) {
        if (sameValue(existing, command.manifest)) return success(state, [], { activation_id: command.activation_id, idempotent: true });
        return failure(state, "STORAGE_IDEMPOTENCY_CONFLICT", false, { activation_id: command.activation_id });
      }
      if (command.expected_graph_revision !== undefined && input.graph_revision !== command.expected_graph_revision) {
        return failureWithEmission(state, command.command_id, "MANIFEST_BUILD_CAS_RETRY", "ManifestBuildCasRetry", { reason: "graph_or_descriptor_changed" });
      }
      if (command.expected_descriptor_revision !== undefined && input.descriptor_revision !== command.expected_descriptor_revision) {
        return failureWithEmission(state, command.command_id, "MANIFEST_BUILD_CAS_RETRY", "ManifestBuildCasRetry", { reason: "graph_or_descriptor_changed" });
      }
      if (!canonicalValue(command.manifest)) return failure(state, "CANONICAL_JSON_INVALID");
      if (isObject(command.manifest.effective_config) && typeof command.manifest.effective_config_digest === "string" && !verifiedDigest(command.manifest.effective_config, command.manifest.effective_config_digest)) return failure(state, "MANIFEST_EFFECTIVE_CONFIG_DIGEST_MISMATCH");
      events.push(appendEvent(next, command.command_id, "ManifestCreated", { activation_id: command.activation_id, reason: String(command.manifest.reason ?? "input") }));
      next.manifests[command.activation_id] = command.manifest;
      next.activations[command.activation_id] = { state: "ready", attempt: 0, manifest: command.manifest };
      return success(next, events);
    }
    case "IssueLease": {
      const item = activation(next, command.activation_id);
      if (!item) return failure(state, "ACTIVATION_NOT_LEASABLE");
      const existing = next.leases[command.lease_id];
      if (existing) {
        const exact = existing.activation_id === command.activation_id
          && existing.token_digest === command.token_digest
          && existing.extension_connection_id === command.extension_connection_id
          && Number(existing.worker_epoch) === command.worker_epoch
          && Number(existing.attempt) === item.attempt
          && (command.extension_generation === undefined || Number(existing.extension_generation) === command.extension_generation);
        if (!exact) return failure(state, "STORAGE_IDEMPOTENCY_CONFLICT", false, { lease_id: command.lease_id });
        const existingGeneration = Number(existing.extension_generation);
        return success(state, [], {
          lease_id: command.lease_id,
          attempt: item.attempt,
          ...(Number.isSafeInteger(existingGeneration) ? { extension_generation: existingGeneration } : {}),
          ...(item.manifest?.effective_config ? { effective_config: item.manifest.effective_config } : {}),
        });
      }
      if (item.state !== "ready" && item.state !== "retry_wait") return failure(state, "ACTIVATION_NOT_LEASABLE");
      const candidates = next.generations.filter((candidate) => candidate.compatible !== false).map((candidate) => Number(candidate.generation)).filter(Number.isSafeInteger);
      const generation = command.extension_generation ?? (candidates.length ? Math.max(...candidates) : next.current_generation ?? undefined);
      if (generation !== undefined && next.generations.length && !candidates.includes(generation)) return failure(state, "EXTENSION_GENERATION_INCOMPATIBLE");
      const attempt = nextAttempt(item.attempt);
      if (attempt === undefined) return failure(state, "ATTEMPT_SEQUENCE_EXHAUSTED");
      delete item.next_attempt_authorization;
      item.state = "leased"; item.attempt = attempt;
      if (generation !== undefined) item.extension_generation = generation;
      const manifestDigest = typeof item.manifest?.manifest_digest === "string" ? item.manifest.manifest_digest : undefined;
      next.leases[command.lease_id] = { activation_id: command.activation_id, token_digest: command.token_digest, extension_connection_id: command.extension_connection_id, worker_epoch: command.worker_epoch, state: "leased", dispatch_state: "prepared", attempt: item.attempt, ...(generation === undefined ? {} : { extension_generation: generation }), ...(manifestDigest === undefined ? {} : { manifest_digest: manifestDigest }) };
      for (const candidate of next.generations) if (candidate.compatible === false) events.push(appendEvent(next, command.command_id, "ExtensionGenerationIncompatible", { generation: Number(candidate.generation), reason: String(candidate.incompatibility_reason ?? "effective_config_schema_digest") }));
      events.push(appendEvent(next, command.command_id, "LeaseIssued", { activation_id: command.activation_id, lease_id: command.lease_id }));
      return success(next, events, { lease_id: command.lease_id, attempt: item.attempt, ...(generation === undefined ? {} : { extension_generation: generation }), ...(item.manifest?.effective_config ? { effective_config: item.manifest.effective_config } : {}) });
    }
    case "DispatchLease": {
      const item = activation(next, command.activation_id);
      const lease = next.leases[command.lease_id];
      if (!item || !lease || lease.activation_id !== command.activation_id || Number(lease.attempt) !== item.attempt) return failure(state, "LEASE_NOT_FOUND");
      if (item.state !== "leased" && item.state !== "dispatched") return failure(state, "ACTIVATION_NOT_DISPATCHABLE");
      const rank: Record<string, number> = { prepared: 1, started: 2, transport_started: 3 };
      const prior = String(lease.dispatch_state ?? "prepared");
      if (rank[command.dispatch_state]! < rank[prior]!) return failure(state, "DISPATCH_EVIDENCE_REGRESSION");
      lease.dispatch_state = command.dispatch_state;
      if (command.dispatch_state !== "prepared") item.state = "dispatched";
      events.push(appendEvent(next, command.command_id, "LeaseDispatchRecorded", { lease_id: command.lease_id, dispatch_state: command.dispatch_state }));
      return success(next, events);
    }
    case "ReceiveResult": {
      if (!resultBindingValid(next, command, input)) return failure(state, "ACTIVATION_FENCE_INVALID");
      const item = activation(next, command.activation_id)!;
      if (command.result && !verifiedDigest(command.result, command.result_digest)) return failure(state, "ACTIVATION_RESULT_DIGEST_MISMATCH");
      if (item.result_digest) {
        if (item.result_digest === command.result_digest) return success(state, [], { activation_id: command.activation_id, disposition: item.authoritative_disposition ?? item.state, idempotent: true });
        const conflict = recordQuarantine(next, command, command.activation_id, "ACTIVATION_RESULT_CONFLICT", item.state === "committed");
        events.push(conflict);
        return success(next, events, undefined, { code: "ACTIVATION_RESULT_CONFLICT", retryable: false, outcome: "applied" });
      }
      if (item.state !== "leased" && item.state !== "dispatched") return failure(state, "ACTIVATION_FENCE_INVALID");
      const authorizedAttempt = command.status === "retryable" ? nextAttempt(item.attempt) : undefined;
      if (command.status === "retryable" && authorizedAttempt === undefined) return failure(state, "ATTEMPT_SEQUENCE_EXHAUSTED");
      item.result_digest = command.result_digest;
      if (command.status === "success") {
        const staged = parseStagedResult(command.result);
        if (!staged) return failure(state, "ACTIVATION_INVALID_RESULT");
        item.state = "result_staged"; item.authoritative_disposition = "result_staged"; item.staged_result = staged;
        if (staged.validation) item.validation = staged.validation;
      } else if (command.status === "retryable") {
        item.state = "retry_wait"; item.authoritative_disposition = "retry_wait"; item.retry_delay = input.retry_jitter ?? 0;
        item.next_attempt_authorization = { activation_id: command.activation_id, authorized_attempt: authorizedAttempt!, source_attempt: item.attempt, reason: "explicit_retryable_failure", evidence_digest: command.result_digest };
      } else {
        events.push(recordQuarantine(next, command, command.activation_id, "ACTIVATION_RESULT_PERMANENT", false, "ModuleQuarantined"));
        item.authoritative_disposition = "quarantined";
      }
      events.push(appendEvent(next, command.command_id, "ResultReceived", { activation_id: command.activation_id, status: command.status, result_digest: command.result_digest }));
      return success(next, events);
    }
    case "BeginFence": {
      const item = activation(next, command.activation_id);
      const lease = leaseFor(next, command.activation_id);
      if (!item || !lease || (item.state !== "leased" && item.state !== "dispatched")) return failure(state, "ACTIVATION_NOT_FENCEABLE");
      item.state = "fencing"; lease.fence_pending = true;
      events.push(appendEvent(next, command.command_id, "FenceStarted", { activation_id: command.activation_id }));
      return success(next, events);
    }
    case "RecordReplayEvidence": {
      const item = activation(next, command.activation_id);
      const lease = leaseFor(next, command.activation_id);
      const evidence = input.host_replay_evidence;
      if (!item || item.state !== "fencing" || !lease || !["started", "transport_started"].includes(String(lease.dispatch_state)) || replayContract(item).evidence !== "activation_ledger") return failure(state, "ACTIVATION_REPLAY_EVIDENCE_INVALID");
      if (!evidence || !replayEvidenceValid(item, command.activation_id, evidence)) return failure(state, "ACTIVATION_REPLAY_EVIDENCE_INVALID");
      if (item.replay_evidence) {
        if (item.replay_evidence.evidence_digest === evidence.digest) return success(state, [], { evidence_digest: evidence.digest, idempotent: true });
        const incident: JsonObject = { code: "STORAGE_IDEMPOTENCY_CONFLICT", activation_id: command.activation_id };
        next.security_incidents.push(incident); events.push(appendEvent(next, command.command_id, "SecurityIncident", incident));
        return success(next, events, undefined, { code: "STORAGE_IDEMPOTENCY_CONFLICT", retryable: false, outcome: "applied", details: incident });
      }
      item.replay_evidence = { ...evidence.record, evidence_digest: evidence.digest, observation: evidence.observation, ...(evidence.target_generation === undefined ? {} : { target_generation: evidence.target_generation }) };
      events.push(appendEvent(next, command.command_id, "ActivationReplayEvidenceRecorded", { activation_id: command.activation_id, observation: evidence.observation, evidence_digest: evidence.digest }));
      return success(next, events);
    }
    case "FenceComplete": {
      const item = activation(next, command.activation_id);
      const lease = leaseFor(next, command.activation_id);
      const proof = input.host_fence_verification;
      if (!item || item.state !== "fencing" || !lease || !proof?.verified || !proof.execution_slot_empty || proof.activation_id !== command.activation_id || proof.source_attempt !== item.attempt || !DIGEST.test(proof.proof_digest)) return failure(state, "FENCE_PROOF_INVALID");
      const dispatchState = String(lease.dispatch_state ?? "prepared");
      lease.dispatch_state = "fenced"; lease.fence_pending = false; lease.fence_evidence_digest = proof.proof_digest;
      const safeBeforeDispatch = dispatchState === "prepared";
      const contract = replayContract(item);
      const ledgerAuthorized = contract.evidence === "activation_ledger" && (item.replay_evidence?.observation === "succeeded" || item.replay_evidence?.observation === "failed");
      if (safeBeforeDispatch || ledgerAuthorized) {
        const evidenceDigest = safeBeforeDispatch ? proof.proof_digest : String(item.replay_evidence!.evidence_digest);
        const authorizedAttempt = nextAttempt(item.attempt);
        if (authorizedAttempt === undefined) return failure(state, "ATTEMPT_SEQUENCE_EXHAUSTED");
        item.state = "retry_wait"; item.retry_delay = command.retry_delay;
        item.next_attempt_authorization = { activation_id: command.activation_id, authorized_attempt: authorizedAttempt, source_attempt: item.attempt, reason: safeBeforeDispatch ? "safe_before_dispatch" : "activation_ledger", evidence_digest: evidenceDigest };
        events.push(appendEvent(next, command.command_id, "ActivationRetryScheduled", { activation_id: command.activation_id, authorization: safeBeforeDispatch ? "safe_before_dispatch" : "activation_ledger" }));
      } else {
        const reason = contract.mode === "never_auto_retry" ? "ACTIVATION_REPLAY_NOT_AUTHORIZED" : "ACTIVATION_EXTERNAL_OUTCOME_UNKNOWN";
        events.push(recordQuarantine(next, command, command.activation_id, reason, false, "ModuleQuarantined"));
      }
      return success(next, events);
    }
    case "ApplyResult": {
      const item = activation(next, command.activation_id);
      if (!item || item.state !== "result_staged" || !item.staged_result) return failure(state, "ACTIVATION_RESULT_NOT_STAGED");
      const staged = item.staged_result;
      for (const expected of Object.values(staged.expected_cursors)) {
        if (!Number.isSafeInteger(expected) || expected < 0 || expected >= Number.MAX_SAFE_INTEGER) {
          return failure(state, "ACTIVATION_INVALID_RESULT");
        }
      }
      for (const pages of Object.values(staged.admitted_pages)) {
        for (const page of pages) {
          if (!Number.isSafeInteger(page.page_seq) || page.page_seq < 0 || page.page_seq >= Number.MAX_SAFE_INTEGER) {
            return failure(state, "PAGE_SEQUENCE_INVALID");
          }
        }
      }
      for (const [subscriptionId, expected] of Object.entries(staged.expected_cursors)) {
        if (next.subscriptions[subscriptionId]?.cursor !== expected) {
          const stopped = copy(state); stopped.mode = "recovery_required";
          const details: JsonObject = { reason: "ACTIVATION_CURSOR_CONFLICT", activation_id: command.activation_id, subscription_id: subscriptionId, expected, actual: state.subscriptions[subscriptionId]?.cursor ?? -1 };
          stopped.security_incidents.push(details);
          const stopEvent = appendEvent(stopped, command.command_id, "RecoveryRequired", details);
          return { outcome: "rolled_back_with_safety_stop", state: stopped, events: [stopEvent], error: { code: "ACTIVATION_CURSOR_CONFLICT", retryable: false, outcome: "applied", details }, projection: projectCoreState(stopped), state_hash: hashCoreState(stopped), safety_stop: { state: stopped, event: stopEvent } };
        }
      }
      const projectedAdmissionEntries = projectedPendingEntries(next, staged);
      if (staged.page_limit !== undefined && projectedAdmissionEntries > staged.page_limit) return failure(state, "PAGE_QUOTA_EXCEEDED", true, { projected_admission_entries: projectedAdmissionEntries });
      for (const [subscriptionId, expected] of Object.entries(staged.expected_cursors)) next.subscriptions[subscriptionId] = { ...next.subscriptions[subscriptionId], cursor: expected + 1 };
      for (const [pageId, admitted] of Object.entries(staged.admitted_pages)) {
        next.pages[pageId] = structuredClone(admitted);
        for (const page of admitted) next.next_page_seq = Math.max(next.next_page_seq, page.page_seq + 1);
      }
      for (const output of staged.outputs) {
        next.outputs.push(structuredClone(output));
        if (typeof output.block_id === "string" && isObject(output.block)) next.blocks[output.block_id] = structuredClone(output.block);
        if (Array.isArray(output.deliveries)) for (const delivery of output.deliveries) if (isObject(delivery)) next.deliveries.push(structuredClone(delivery));
      }
      item.state = "committed"; item.authoritative_disposition = "committed"; delete item.staged_result;
      events.push(appendEvent(next, command.command_id, "ActivationCommitted", { activation_id: command.activation_id, ...(item.result_digest ? { result_digest: item.result_digest } : {}) }));
      return success(next, events, { projected_admission_entries: projectedAdmissionEntries });
    }
    case "CancelActivation": {
      const item = activation(next, command.activation_id); if (!item || item.state === "committed") return failure(state, "ACTIVATION_NOT_CANCELLABLE");
      item.state = "cancelled"; events.push(appendEvent(next, command.command_id, "ActivationCancelled", { activation_id: command.activation_id, reason: command.reason })); return success(next, events);
    }
    case "ResolveQuarantine": {
      const quarantine = next.quarantines[command.activation_id];
      if (!quarantine) return failure(state, "QUARANTINE_NOT_FOUND");
      const item = activation(next, command.activation_id);
      if (!item) return failure(state, "ACTIVATION_NOT_FOUND");
      if (item.state === "committed") return failure(state, "ACTIVATION_COMMITTED_IMMUTABLE");
      if (command.resolution === "retry") {
        const proof = input.host_fence_verification;
        const digest = proof?.proof_digest;
        if (quarantine.fence_complete !== true || !proof?.verified || !proof.execution_slot_empty || proof.activation_id !== command.activation_id || proof.source_attempt !== item.attempt || !digest || !DIGEST.test(digest)) return failure(state, "QUARANTINE_REVIEW_NOT_AUTHORIZED");
        const authorizedAttempt = nextAttempt(item.attempt);
        if (authorizedAttempt === undefined) return failure(state, "ATTEMPT_SEQUENCE_EXHAUSTED");
        item.state = "retry_wait"; item.retry_delay = command.retry_delay ?? input.retry_jitter ?? 0;
        item.next_attempt_authorization = { activation_id: command.activation_id, authorized_attempt: authorizedAttempt, source_attempt: item.attempt, reason: "operator_review", evidence_digest: digest, reviewed: true };
      } else {
        item.state = "cancelled";
      }
      delete next.quarantines[command.activation_id];
      events.push(appendEvent(next, command.command_id, "QuarantineResolved", { activation_id: command.activation_id, resolution: command.resolution }));
      return success(next, events);
    }
    case "CompleteQuarantineFence": {
      if (!next.quarantines[command.activation_id]) return failure(state, "QUARANTINE_NOT_FOUND");
      const proof = input.host_fence_verification;
      if (!proof?.verified || !proof.execution_slot_empty || proof.activation_id !== command.activation_id || proof.source_attempt !== activation(next, command.activation_id)?.attempt) return failure(state, "FENCE_PROOF_INVALID");
      next.quarantines[command.activation_id].fence_complete = true;
      events.push(appendEvent(next, command.command_id, "QuarantineFenceCompleted", { activation_id: command.activation_id })); return success(next, events);
    }
    case "DeadLetterRange": {
      const subscription = next.subscriptions[command.subscription_id];
      if (!subscription || subscription.cursor !== command.start || command.end_exclusive <= command.start || command.end_exclusive > next.next_page_seq) return failure(state, "SUBSCRIPTION_DISPOSITION_CONFLICT");
      subscription.cursor = command.end_exclusive;
      events.push(appendEvent(next, command.command_id, "RangeDeadLettered", { subscription_id: command.subscription_id, start: command.start, end_exclusive: command.end_exclusive, reason: command.reason })); return success(next, events);
    }
    case "SkipRange": {
      const subscription = next.subscriptions[command.subscription_id];
      if (!subscription || subscription.cursor !== command.start || command.end_exclusive <= command.start || command.end_exclusive > next.next_page_seq) return failure(state, "SUBSCRIPTION_DISPOSITION_CONFLICT");
      subscription.cursor = command.end_exclusive;
      events.push(appendEvent(next, command.command_id, "RangeSkipped", { subscription_id: command.subscription_id, start: command.start, end_exclusive: command.end_exclusive })); return success(next, events);
    }
    case "LossyEvict": {
      if (command.start >= command.end_exclusive) return failure(state, "LOSSY_RANGE_INVALID");
      const gap: JsonObject = { page_id: command.page_id, start: command.start, end_exclusive: command.end_exclusive, reason: command.reason };
      next.lossy_gaps.push(gap); next.volatile_lossy_entries = next.volatile_lossy_entries.filter((entry) => entry.page_id !== command.page_id);
      events.push(appendEvent(next, command.command_id, "LossyGap", gap)); return success(next, events);
    }
    case "Recover": {
      const verification = input.recovery_verification;
      if (!verification?.ordered_checks_complete) return failure(state, "RECOVERY_VERIFICATION_INCOMPLETE");
      if (!Number.isSafeInteger(command.persisted_next_page_seq) || command.persisted_next_page_seq < 0 || command.persisted_next_page_seq > Number.MAX_SAFE_INTEGER) return failure(state, "PAGE_SEQUENCE_INVALID");
      if (command.persisted_next_page_seq < state.next_page_seq) return failure(state, "PAGE_SEQUENCE_REGRESSION");
      const valid = verification.invariants_valid && verification.persisted_values_valid && verification.process_fences_valid && verification.staged_results_valid;
      if (!valid) {
        next.mode = "recovery_required";
        const details: JsonObject = { reason: verification.failure_reason ?? "ordered recovery verification failed" };
        next.security_incidents.push(details);
        events.push(appendEvent(next, command.command_id, "RecoveryRequired", details));
        return success(next, events);
      }
      next.volatile_lossy_entries = [];
      if (command.persisted_next_page_seq > next.next_page_seq) {
        const gap: JsonObject = { start: next.next_page_seq, end_exclusive: command.persisted_next_page_seq, reason: "restart" };
        next.lossy_gaps.push(gap); events.push(appendEvent(next, command.command_id, "LossyGap", gap));
      }
      next.next_page_seq = command.persisted_next_page_seq;
      next.mode = "running";
      events.push(appendEvent(next, command.command_id, "RecoveryCompleted"));
      return success(next, events);
    }
  }

  const exhaustive: never = command;
  return failure(state, "UNSUPPORTED_COMMAND", false, { command: (exhaustive as CoreCommand).type as JsonValue });
}
