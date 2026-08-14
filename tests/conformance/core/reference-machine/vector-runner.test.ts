import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest, type JsonValue } from "../../../../src/schema-bundle/index.js";
import { parseStrictJsonBytes } from "../../../../src/core/strict-json.js";
import { emptyCoreSnapshot, reduceCore, type CoreEvent, type CoreSnapshot, type JsonObject, type ReducerInput, type Transition } from "../../../../src/core/reference-machine/index.js";

const SPEC_ROOT = path.resolve(import.meta.dirname, "../../../../dolly-spec");
const VECTOR_ROOT = path.join(SPEC_ROOT, "test-vectors", "core");
// Repository-owned overlay; the imported snapshot stays byte-faithful.
const OVERLAY_ROOT = path.resolve(import.meta.dirname, "../../../../test-vectors/core");
const FIXTURE_ROOT = path.join(SPEC_ROOT, "test-vectors", "fixtures");
const FENCE = `sha256:${"f".repeat(64)}`;
// Host-owned test-environment state; replay evidence cannot define its own authority scope.
const ACTIVATION_LEDGER_STORAGE_SCOPE_ID = "0198ab31-6c44-7e8a-b2bb-000000000109";

type RecordValue = Record<string, unknown>;
interface Assertion { path: string; op: "equals" | "not_equals" | "contains" | "count" | "absent" | "unchanged"; value?: unknown }
interface FrozenVector {
  test_id: string;
  initial: RecordValue;
  stimulus: RecordValue;
  expected: { outcome: string; assertions: Assertion[]; emitted: RecordValue[]; crash_label: string | null };
}
interface ScenarioResult { outcome: string; observed: RecordValue; before: RecordValue; emitted: RecordValue[] }

function object(value: unknown, label: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as RecordValue;
}
function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}
function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
  return value as number;
}
function readFrozenJsonTestFile(file: string): JsonValue {
  return parseStrictJsonBytes(readFileSync(file), { maxBytes: 2 * 1024 * 1024, maxDepth: 128 });
}
function fixture(name: string): RecordValue {
  const envelope = object(readFrozenJsonTestFile(path.join(FIXTURE_ROOT, `${name}.json`)), `fixture ${name}`);
  expect(envelope.schema, `fixture ${name}`).toBe("dolly.test-fixture/v1");
  return structuredClone(object(envelope.value, `fixture ${name}.value`));
}
function initialValue(vector: FrozenVector): RecordValue {
  const initial = structuredClone(vector.initial);
  const fixtureName = initial.fixture;
  delete initial.fixture;
  return fixtureName === undefined ? initial : { ...fixture(text(fixtureName, `${vector.test_id}.initial.fixture`)), ...initial };
}
function transition(state: CoreSnapshot, command: Parameters<typeof reduceCore>[1], override: Partial<ReducerInput> = {}): Transition {
  return reduceCore(state, command, {
    now: "2026-08-10T22:00:00.000000Z",
    graph_revision: 1,
    descriptor_revision: 1,
    retry_jitter: 0,
    recovery_verification: { ordered_checks_complete: true, invariants_valid: true, persisted_values_valid: true, process_fences_valid: true, staged_results_valid: true },
    ...override,
  });
}
function flattened(event: CoreEvent): RecordValue { return { event: event.event, ...(event.details ?? {}) }; }
function executeChannelSend(action: RecordValue): JsonObject {
  if (action.name !== "org.dolly.channel.send") throw new Error("unsupported deterministic action");
  const argumentsValue = object(action.arguments, "action.arguments");
  const parts = list(argumentsValue.parts, "action.arguments.parts");
  return {
    schema: "dolly.action-result/v1",
    action_id: text(action.action_id, "action_id"),
    status: "succeeded",
    result: {
      schema: "dolly.channel.send-result/v1",
      session_id: text(argumentsValue.session_id, "session_id"),
      delivery_outcome: "sent",
      messages: parts.map((_, index) => ({ ordinal: index, external_message_id: `transport-${index + 1}` })),
    },
    error: null,
  };
}
function pointer(document: unknown, rawPointer: string): unknown {
  if (rawPointer === "") return document;
  if (!rawPointer.startsWith("/")) throw new Error(`invalid RFC 6901 pointer: ${rawPointer}`);
  let current: unknown = document;
  for (const token of rawPointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (Array.isArray(current)) current = current[Number(token)];
    else if (current !== null && typeof current === "object") current = (current as RecordValue)[token];
    else return undefined;
  }
  return current;
}
function expectationValue(assertion: Assertion, observed: RecordValue): unknown {
  if (typeof assertion.value === "string" && assertion.value.startsWith("@same:")) return pointer(observed, assertion.value.slice("@same:".length));
  return assertion.value;
}
function enforceAssertion(assertion: Assertion, scenario: ScenarioResult): void {
  const actual = pointer(scenario.observed, assertion.path);
  const expected = expectationValue(assertion, scenario.observed);
  switch (assertion.op) {
    case "equals": expect(actual, assertion.path).toEqual(expected); break;
    case "not_equals": expect(actual, assertion.path).not.toEqual(expected); break;
    case "contains": {
      if (Array.isArray(actual)) expect(actual, assertion.path).toContainEqual(expected);
      else if (typeof actual === "string") expect(actual, assertion.path).toContain(String(expected));
      else expect(actual, assertion.path).toMatchObject(object(expected, `${assertion.path}.value`));
      break;
    }
    case "count": {
      const count = Array.isArray(actual) || typeof actual === "string" ? actual.length : actual && typeof actual === "object" ? Object.keys(actual).length : -1;
      expect(count, assertion.path).toBe(expected);
      break;
    }
    case "absent": expect(actual, assertion.path).toBeUndefined(); break;
    case "unchanged": expect(actual, assertion.path).toEqual(pointer(scenario.before, assertion.path)); break;
  }
}
function stagedState(activationId: string, expectedCursors: Record<string, number>, outputs: JsonObject[] = [], admittedPages: Record<string, Array<{ page_seq: number; entries: JsonValue[] }>> = {}, projected = 0, pageLimit?: number): CoreSnapshot {
  const state = emptyCoreSnapshot();
  state.activations[activationId] = { state: "result_staged", attempt: 1, authoritative_disposition: "result_staged", result_digest: `sha256:${"4".repeat(64)}`, staged_result: { expected_cursors: expectedCursors, outputs, admitted_pages: admittedPages, projected_admission_entries: projected, ...(pageLimit === undefined ? {} : { page_limit: pageLimit }) } };
  return state;
}
function fenceScenario(initial: RecordValue, stimulus: RecordValue): { transition: Transition; state: CoreSnapshot } {
  const state = emptyCoreSnapshot();
  const activationState = text(initial.activation_state, "activation_state");
  const dispatch = object(initial.last_dispatch, "last_dispatch");
  state.activations.a = { state: activationState === "leased" && dispatch.state === "started" ? "dispatched" : "leased", attempt: integer(initial.attempt, "attempt"), manifest: { frozen_replay_contract: initial.frozen_replay_contract as JsonValue } };
  state.leases.l = { activation_id: "a", token_digest: "token", attempt: 1, dispatch_state: dispatch.state as JsonValue };
  state.subscriptions.s = { cursor: integer(initial.cursor, "cursor") };
  const begun = transition(state, { type: "BeginFence", command_id: "begin", activation_id: "a" });
  const proofDigest = text(stimulus.host_fence_evidence_digest, "host_fence_evidence_digest");
  const completed = transition(begun.state, { type: "FenceComplete", command_id: "complete", activation_id: "a", retry_delay: Number(stimulus.retry_jitter_ms ?? 0) }, { host_fence_verification: { verified: true, activation_id: "a", source_attempt: 1, execution_slot_empty: true, proof_digest: proofDigest } });
  return { transition: completed, state: completed.state };
}

function execute(vector: FrozenVector): ScenarioResult {
  const initial = initialValue(vector);
  const stimulus = vector.stimulus;
  switch (vector.test_id) {
    case "TST-CORE-001": {
      const state = emptyCoreSnapshot(); state.next_commit_seq = integer(initial.next_commit_seq, "next_commit_seq");
      const commands = list(stimulus.commands, "commands").map((entry) => object(entry, "ingress command"));
      const results: RecordValue[] = []; const emitted: CoreEvent[] = []; let current = state;
      for (const [index, item] of commands.entries()) {
        expect(item.kind).toBe("ingress");
        const [runtimeSource, ingressKey] = text(item.key, "ingress key").split(":", 2);
        const draft = fixture(text(item.draft_fixture, "draft_fixture"));
        const digest = canonicalJsonDigest({ key: item.key, draft } as JsonValue);
        const result = transition(current, { type: "Ingress", command_id: `ingress-${index}`, runtime_source: runtimeSource!, ingress_key: ingressKey!, operation_digest: digest, block_id: "derived-block-1", block: draft as JsonObject, pages: list(item.pages, "pages").map(String) });
        current = result.state; results.push(result.reply ?? {}); emitted.push(...result.events);
      }
      return { outcome: results[1]?.idempotent === true ? "idempotent_existing_result" : "unexpected", before: {}, observed: { blocks: current.blocks, deliveries: current.deliveries, results, next_commit_seq: current.next_commit_seq }, emitted: [{ event: "IngressCommitted", count: emitted.filter((event) => event.event === "IngressCommitted").length }] };
    }
    case "TST-CORE-002": {
      const activationInitial = object(initial.activation, "activation");
      const activationId = text(activationInitial.activation_id, "activation_id");
      const subscription = object(initial.input_subscription, "input_subscription");
      const cursor = integer(subscription.cursor, "cursor");
      const outputPages = object(initial.output_pages, "output_pages");
      const blockId = "staged-output";
      const admittedPages = Object.fromEntries(Object.entries(outputPages).map(([pageId, page]) => [
        pageId,
        [{ page_seq: integer(object(page, pageId).next_page_seq, `${pageId}.next_page_seq`), entries: [{ block_id: blockId }] }],
      ]));
      const stagedOutput = object(activationInitial.staged_output, "staged_output");
      const state = stagedState(
        activationId,
        { input: cursor },
        [{ block_id: blockId, block: stagedOutput as JsonObject, deliveries: Object.keys(outputPages).map((pageId) => ({ block_id: blockId, page_id: pageId })) }],
        admittedPages,
        Object.keys(outputPages).length,
      );
      state.activations[activationId]!.result_digest = text(activationInitial.result_digest, "result_digest");
      state.subscriptions.input = { cursor };
      state.next_commit_seq = integer(initial.next_commit_seq, "next_commit_seq");
      for (const pageId of Object.keys(outputPages)) state.pages[pageId] = [];
      const result = transition(state, { type: "ApplyResult", command_id: "apply", activation_id: activationId }, { crash_point: text(stimulus.crash_at, "crash_at"), storage_observation: "before_commit" });
      return {
        outcome: result.error?.code === "SIMULATED_CRASH" ? "transaction_absent_after_recovery" : "unexpected",
        before: {},
        observed: {
          activation: result.state.activations[activationId],
          cursor: result.state.subscriptions.input?.cursor,
          deliveries: result.state.deliveries,
          output_block: result.state.blocks[blockId],
        },
        emitted: result.events.map(flattened),
      };
    }
    case "TST-CORE-003": {
      const target = text(vector.initial.target_module, "target_module");
      const observer = text(vector.initial.other_module, "other_module");
      const action = object(initial.action, "action");
      const actionId = text(action.action_id, "action_id");
      expect(object(action.target, "target").module_id).toBe(target);
      const subscriptions = list(initial.subscriptions, "subscriptions").map((value) => object(value, "subscription"));
      const targetSubscriptions = subscriptions.filter((subscription) => subscription.module_id === target);
      expect(subscriptions.some((subscription) => subscription.module_id === observer)).toBe(true);
      const occurrenceCount = list(initial.deliveries, "deliveries").filter((delivery) =>
        targetSubscriptions.some((subscription) => subscription.page_id === object(delivery, "delivery").page_id)
      ).length;
      const manifest: JsonObject = { input_items: [{ action_id: actionId, action: action as JsonObject, occurrence_count: occurrenceCount }], reason: "input" };
      const built = transition(emptyCoreSnapshot(), { type: "BuildManifest", command_id: "build", activation_id: "target", manifest });
      const leased = transition(built.state, { type: "IssueLease", command_id: "lease", activation_id: "target", lease_id: "lease", token_digest: "token", extension_connection_id: "connection-1", worker_epoch: 1 });
      const dispatched = transition(leased.state, { type: "DispatchLease", command_id: "dispatch", activation_id: "target", lease_id: "lease", dispatch_state: "started" });
      const actionResult = executeChannelSend(action);
      const resultPayload: JsonObject = {
        expected_cursors: {},
        outputs: [{ block_id: "action-result", block: actionResult, action_ledger: { action_id: actionId, status: actionResult.status }, deliveries: [] }],
        admitted_pages: {},
        projected_admission_entries: 0,
      };
      const resultDigest = canonicalJsonDigest(resultPayload);
      const received = transition(
        dispatched.state,
        { type: "ReceiveResult", command_id: "result", activation_id: "target", lease_id: "lease", result_digest: resultDigest, status: "success", result: resultPayload },
        { host_result_verification: {
          verified: true,
          payload_valid: true,
          activation_id: "target",
          lease_id: "lease",
          token_digest: "token",
          extension_connection_id: "connection-1",
          worker_epoch: 1,
          attempt: 1,
          result_digest: resultDigest,
        } },
      );
      const applied = transition(received.state, { type: "ApplyResult", command_id: "apply", activation_id: "target" });
      const committedOutputs = applied.state.outputs;
      const targetLedger = committedOutputs.map((output) => object(output.action_ledger, "action_ledger"));
      const observerLedger = committedOutputs.filter((output) => output.target_module === observer).map((output) => object(output.action_ledger, "observer action_ledger"));
      const emitted = committedOutputs.map((output) => object(output.block, "action result"));
      return {
        outcome: applied.state.activations.target?.state === "committed" && targetLedger.length === 1 && occurrenceCount === 2 ? "one_target_execution" : "unexpected",
        before: {},
        observed: { target: { manifest: applied.state.manifests.target, action_ledger: targetLedger }, observer: { action_ledger: observerLedger } },
        emitted,
      };
    }
    case "TST-CORE-004": {
      const state = emptyCoreSnapshot(); state.mode = "recovery_required"; state.next_page_seq = integer(initial.diagnostic_cursor, "diagnostic_cursor"); state.volatile_lossy_entries = list(initial.memory_entries, "memory_entries").map((pageSeq) => ({ page_seq: Number(pageSeq) }));
      const recovered = transition(state, { type: "Recover", command_id: "restart", persisted_next_page_seq: integer(initial.persisted_next_page_seq, "persisted_next_page_seq") });
      const gaps = recovered.state.lossy_gaps.map((gap) => ({ from_page_seq: gap.start, to_page_seq: gap.end_exclusive, reason: gap.reason }));
      return { outcome: recovered.state.lossy_gaps.length === 1 ? "pending_loss_reported_as_gap" : "unexpected", before: {}, observed: { page: { next_page_seq: recovered.state.next_page_seq, memory_entries: recovered.state.volatile_lossy_entries }, manifest: { lossy_gaps: gaps } }, emitted: recovered.events.filter((event) => event.event === "LossyGap").map(flattened) };
    }
    case "TST-CORE-005": {
      const activationInitial = object(initial.activation, "activation"); const activationId = text(activationInitial.activation_id, "activation_id"); const issuedFence = object(list(initial.issued_fences, "issued_fences")[0], "issued_fence");
      const state = emptyCoreSnapshot();
      state.activations[activationId] = {
        state: "committed",
        attempt: 1,
        result_digest: text(vector.initial.authoritative_result_digest, "authoritative_result_digest"),
        authoritative_disposition: "committed",
      };
      state.leases.l = {
        activation_id: activationId,
        token_digest: issuedFence.token_hash as JsonValue,
        extension_connection_id: "connection-1",
        worker_epoch: 1,
        attempt: 1,
        extension_generation: issuedFence.extension_generation as JsonValue,
        dispatch_state: "started",
      };
      state.outputs = structuredClone(list(initial.outputs, "outputs") as JsonObject[]);
      const before = { outputs: structuredClone(state.outputs) };
      const digest = text(stimulus.result_digest, "result_digest");
      const result = transition(
        state,
        { type: "ReceiveResult", command_id: "result", activation_id: activationId, lease_id: "l", result_digest: digest, status: "success" },
        { host_result_verification: {
          verified: stimulus.authenticated_previously_issued_fence === true,
          payload_valid: true,
          activation_id: activationId,
          lease_id: "l",
          token_digest: text(issuedFence.token_hash, "token_hash"),
          extension_connection_id: "connection-1",
          worker_epoch: 1,
          attempt: 1,
          extension_generation: Number(issuedFence.extension_generation),
          result_digest: digest,
        } },
      );
      return { outcome: result.error?.code ?? "unexpected", before, observed: { activation: result.state.activations[activationId], module: { lifecycle_state: result.state.quarantines[activationId] ? "quarantined" : "idle" }, outputs: result.state.outputs }, emitted: result.events.map(flattened) };
    }
    case "TST-CORE-006": {
      const result = fenceScenario(initial, stimulus); const item = result.state.activations.a!; const lease = result.state.leases.l!;
      return { outcome: String(result.transition.error?.code ?? result.state.quarantines.a?.reason ?? "ACTIVATION_REPLAY_NOT_AUTHORIZED"), before: {}, observed: { activation: { state: item.state, next_attempt_authorization: item.next_attempt_authorization, last_dispatch: { state: lease.dispatch_state } }, module: {}, subscription: { cursor: result.state.subscriptions.s?.cursor } }, emitted: result.transition.events.map(flattened) };
    }
    case "TST-CORE-007": {
      const result = fenceScenario(initial, stimulus); const item = result.state.activations.a!;
      const authorization = item.next_attempt_authorization;
      return { outcome: item.state === "retry_wait" ? "safe_before_dispatch_retry" : "unexpected", before: {}, observed: { activation: { state: item.state, next_attempt_authorization: authorization && { authorized_attempt: authorization.authorized_attempt, source_attempt: authorization.source_attempt, reason: authorization.reason, evidence_digest: authorization.evidence_digest }, retry_delay_ms: item.retry_delay }, module: {}, subscription: { cursor: result.state.subscriptions.s?.cursor } }, emitted: result.transition.events.map(flattened) };
    }
    case "TST-CORE-008": {
      let state = emptyCoreSnapshot(); const commands = list(stimulus.commands, "commands").map((value) => object(value, "runtime event")); const results: Transition[] = [];
      for (const [index, command] of commands.entries()) {
        const result = transition(state, { type: "RuntimeEvent", command_id: `event-${index}`, runtime_source: text(command.runtime_source, "runtime_source"), event_key: text(command.event_key, "event_key"), operation_digest: text(command.operation_digest, "operation_digest"), block_id: "runtime-block", block: { source: "clock" }, pages: ["timer", "audit"] });
        results.push(result); state = result.state;
      }
      const deliveryCounts = new Map<string, number>(); for (const delivery of state.deliveries) deliveryCounts.set(String(delivery.page_id), (deliveryCounts.get(String(delivery.page_id)) ?? 0) + 1);
      const original = Object.values(state.runtime_events)[0]!;
      return { outcome: results[2]!.error?.code === "STORAGE_IDEMPOTENCY_CONFLICT" ? "one_commit_one_replay_one_conflict" : "unexpected", before: {}, observed: { runtime_event_operations: state.runtime_events, blocks: state.blocks, deliveries: { by_target_page: [...deliveryCounts.values()].every((count) => count === 1) ? "one_each" : "duplicate" }, third: { error: results[2]!.error?.code }, original }, emitted: [flattened(results[0]!.events[0]!), { event: "SecurityIncident", reason: results[2]!.error?.code }] };
    }
    case "TST-CORE-009": {
      const casesInitial = object(initial.cases, "initial.cases"); const casesStimulus = object(stimulus.cases, "stimulus.cases"); const observed: RecordValue = {}; const emitted: RecordValue[] = [];
      for (const caseName of ["complete", "unknown"]) {
        const initialCase = object(casesInitial[caseName], caseName);
        const commands = list(object(casesStimulus[caseName], caseName).commands, `${caseName}.commands`).map((value) => object(value, "fence command"));
        const recordCommand = commands[1]!;
        const evidenceRecord = object(recordCommand.record, "evidence record");
        const activationId = text(initialCase.activation_id, "activation_id");
        const state = emptyCoreSnapshot();
        state.activations[activationId] = {
          state: "dispatched",
          attempt: 1,
          extension_generation: integer(initialCase.target_extension_generation, "target_extension_generation"),
          manifest: {
            manifest_digest: initialCase.manifest_digest as JsonValue,
            frozen_replay_contract: initialCase.frozen_replay_contract as JsonValue,
            module_id: text(initialCase.module_id, "module_id"),
            storage_scope_id: ACTIVATION_LEDGER_STORAGE_SCOPE_ID,
          },
        };
        state.leases.l = {
          activation_id: activationId,
          token_digest: "token",
          attempt: 1,
          extension_generation: initialCase.target_extension_generation as JsonValue,
          dispatch_state: "started",
          manifest_digest: initialCase.manifest_digest as JsonValue,
        };
        state.subscriptions.s = { cursor: integer(initialCase.cursor, "cursor") };
        const begun = transition(state, { type: "BeginFence", command_id: `${caseName}-begin`, activation_id: activationId });
        const expectedEvidenceDigest = text(recordCommand.expected_evidence_digest, "expected_evidence_digest");
        const evidenceDigest = canonicalJsonDigest(evidenceRecord as JsonObject);
        if (evidenceDigest !== expectedEvidenceDigest) throw new Error(`${caseName} evidence digest does not match its record`);
        const ledgerState = text(evidenceRecord.ledger_state, "ledger_state");
        const recorded = transition(begun.state, { type: "RecordReplayEvidence", command_id: `${caseName}-record`, activation_id: activationId }, { host_replay_evidence: { verified: true, activation_id: activationId, source_attempt: 1, target_generation: Number(evidenceRecord.target_extension_generation), observation: ledgerState === "complete" ? "succeeded" : "unknown", record: evidenceRecord as JsonObject, digest: evidenceDigest } });
        const completeCommand = commands[2]!; const proofDigest = text(completeCommand.host_fence_evidence_digest, "host_fence_evidence_digest"); const completed = transition(recorded.state, { type: "FenceComplete", command_id: `${caseName}-complete`, activation_id: activationId, retry_delay: Number(completeCommand.retry_jitter_ms ?? 0) }, { host_fence_verification: { verified: true, activation_id: activationId, source_attempt: 1, execution_slot_empty: true, proof_digest: proofDigest } });
        const item = completed.state.activations[activationId]!; const authorization = item.next_attempt_authorization; observed[caseName] = { activation: { state: item.state, next_attempt_authorization: authorization && { authorized_attempt: authorization.authorized_attempt, source_attempt: authorization.source_attempt, reason: authorization.reason, evidence_digest: authorization.evidence_digest }, last_dispatch: { state: completed.state.leases.l?.dispatch_state, fence_evidence_digest: completed.state.leases.l?.fence_evidence_digest }, retry_delay_ms: item.retry_delay }, subscription: { cursor: completed.state.subscriptions.s?.cursor }, quarantine: completed.state.quarantines[activationId] };
        if (caseName === "complete") { emitted.push({ case: caseName, ...flattened(recorded.events[0]!) }, { case: caseName, ...flattened(completed.events[0]!) }); }
        else emitted.push({ case: caseName, ...flattened(completed.events[0]!) });
      }
      return { outcome: object(object(observed.complete, "complete").activation, "activation").state === "retry_wait" && object(object(observed.unknown, "unknown").activation, "activation").state === "quarantined" ? "complete_authorized_unknown_quarantined" : "unexpected", before: {}, observed, emitted };
    }
    case "TST-CORE-010": {
      const primaryInitial = initial; const primaryPage = object(primaryInitial.page, "page"); const primaryActivation = object(primaryInitial.activation, "activation"); const subscription = object(list(primaryPage.subscriptions, "subscriptions")[0], "subscription"); const pageId = text(primaryPage.page_id, "page_id");
      const primary = stagedState("a", { worker: integer(subscription.cursor, "cursor") }, [], { [pageId]: [{ page_seq: integer(primaryPage.next_page_seq, "next_page_seq"), entries: [{}] }] }, 1, integer(object(primaryPage.quota, "quota").max_entries, "max_entries")); primary.subscriptions.worker = { cursor: integer(subscription.cursor, "cursor") }; primary.pages[pageId] = [{ page_seq: 1, entries: [{}] }]; primary.next_page_seq = integer(primaryPage.next_page_seq, "next_page_seq");
      const applied = transition(primary, { type: "ApplyResult", command_id: "primary", activation_id: "a" });
      const controlInitial = object(initial.lagging_subscriber_control, "lagging_subscriber_control"); const controlPage = object(controlInitial.page, "control.page"); const controlSubs = list(controlPage.subscriptions, "control.subscriptions").map((value) => object(value, "subscription")); const controlId = text(controlPage.page_id, "control.page_id");
      const control = stagedState("a", { worker: 1 }, [], { [controlId]: [{ page_seq: 2, entries: [{}] }] }, 1, integer(object(controlPage.quota, "quota").max_entries, "max_entries")); for (const item of controlSubs) control.subscriptions[text(item.module_id, "module_id")] = { cursor: integer(item.cursor, "cursor") }; control.pages[controlId] = [{ page_seq: 1, entries: [{}] }]; control.next_page_seq = 2;
      const blocked = transition(control, { type: "ApplyResult", command_id: "control", activation_id: "a" });
      return { outcome: applied.state.activations.a?.state === "committed" && blocked.error?.code === "PAGE_QUOTA_EXCEEDED" ? "committed_with_projected_pending_count_one" : "unexpected", before: {}, observed: { activation: applied.state.activations.a, page: { subscriptions: [{ cursor: applied.state.subscriptions.worker?.cursor }], next_page_seq: applied.state.next_page_seq, projected_admission_entries: applied.reply?.projected_admission_entries, pending_deliveries: applied.state.pages[pageId] }, lagging_subscriber_control: { activation: { state: blocked.error?.code === "PAGE_QUOTA_EXCEEDED" ? "commit_blocked" : blocked.state.activations.a?.state }, page: { projected_admission_entries: blocked.error?.details?.projected_admission_entries, subscriptions: [{ cursor: blocked.state.subscriptions.worker?.cursor }, { cursor: blocked.state.subscriptions.observer?.cursor }], next_page_seq: blocked.state.next_page_seq } } }, emitted: applied.events.map(flattened) };
    }
    case "TST-CORE-011": {
      const page = object(initial.page, "page"); const subscription = object(initial.subscription, "subscription"); const state = emptyCoreSnapshot(); state.next_page_seq = integer(page.next_page_seq, "next_page_seq"); state.subscriptions.worker = { cursor: integer(subscription.cursor, "cursor"), paused: subscription.status === "paused" };
      const result = transition(state, { type: "SkipRange", command_id: "skip", subscription_id: "worker", start: integer(stimulus.expected_cursor, "expected_cursor"), end_exclusive: integer(stimulus.end_exclusive, "end_exclusive") });
      return { outcome: result.error?.code ?? "unexpected", before: {}, observed: { subscription: result.state.subscriptions.worker, page: { next_page_seq: result.state.next_page_seq }, disposition_audit_rows: [] }, emitted: result.events.map(flattened) };
    }
    case "TST-CORE-012": {
      const graph = object(initial.active_graph, "active_graph"); const replacement = object(initial.verified_inactive_descriptor, "verified_inactive_descriptor"); const state = emptyCoreSnapshot(); state.graph = { revision: graph.graph_revision as JsonValue };
      const stale = transition(state, { type: "BuildManifest", command_id: "stale", activation_id: "a", manifest: {}, expected_graph_revision: integer(graph.graph_revision, "graph_revision"), expected_descriptor_revision: integer(graph.module_descriptor_revision, "descriptor_revision") }, { graph_revision: 8, descriptor_revision: integer(replacement.descriptor_revision, "replacement revision") });
      const manifest: JsonObject = { graph_revision: 8, module_descriptor_revision: replacement.descriptor_revision as JsonValue, module_descriptor_digest: replacement.descriptor_digest as JsonValue };
      const retried = transition(stale.state, { type: "BuildManifest", command_id: "retry", activation_id: "a", manifest, expected_graph_revision: 8, expected_descriptor_revision: integer(replacement.descriptor_revision, "replacement revision") }, { graph_revision: 8, descriptor_revision: integer(replacement.descriptor_revision, "replacement revision") });
      return { outcome: stale.error?.code === "MANIFEST_BUILD_CAS_RETRY" && retried.state.manifests.a ? "stale_build_retried_against_complete_new_graph_tuple" : "unexpected", before: {}, observed: { manifest: retried.state.manifests.a, manifests_with_graph_7_descriptor_10: Object.values(retried.state.manifests).filter((item) => item.graph_revision === 7 && item.module_descriptor_revision === 10) }, emitted: stale.events.map(flattened) };
    }
    case "TST-CORE-013": {
      const committedAction = object(initial.committed_action, "committed_action");
      const binding = object(committedAction.contract_binding, "contract_binding");
      const manifest: JsonObject = { action_contract_binding: binding as JsonObject };
      const built = transition(emptyCoreSnapshot(), { type: "BuildManifest", command_id: "build", activation_id: "a", manifest });
      const leased = transition(built.state, { type: "IssueLease", command_id: "lease", activation_id: "a", lease_id: "l", token_digest: "token", extension_connection_id: "connection-1", worker_epoch: 1 });
      const dispatched = transition(leased.state, { type: "DispatchLease", command_id: "dispatch", activation_id: "a", lease_id: "l", dispatch_state: "started" });
      const resultPayload: JsonObject = {
        expected_cursors: {},
        outputs: [{ block_id: "action-result", block: object(stimulus.result, "result") as JsonObject }],
        admitted_pages: {},
        projected_admission_entries: 0,
        validation: {
          descriptor_revision: binding.descriptor_revision as JsonValue,
          action_contract_digest: binding.action_contract_digest as JsonValue,
          consulted_current_descriptor: false,
        },
      };
      const resultDigest = canonicalJsonDigest(resultPayload);
      const received = transition(
        dispatched.state,
        { type: "ReceiveResult", command_id: "result", activation_id: "a", lease_id: "l", result_digest: resultDigest, status: "success", result: resultPayload },
        { host_result_verification: {
          verified: true,
          payload_valid: true,
          activation_id: "a",
          lease_id: "l",
          token_digest: "token",
          extension_connection_id: "connection-1",
          worker_epoch: 1,
          attempt: 1,
          result_digest: resultDigest,
        } },
      );
      const applied = transition(received.state, { type: "ApplyResult", command_id: "apply", activation_id: "a" });
      return { outcome: applied.state.activations.a?.state === "committed" ? "result_validated_by_creation_time_contract" : "unexpected", before: {}, observed: { validation: applied.state.activations.a?.validation, activation: applied.state.activations.a }, emitted: applied.events.map(flattened) };
    }
    case "TST-CORE-014": {
      const lossyPage = object(initial.lossy_page, "lossy_page"); const gaps = list(lossyPage.pending_unreported_gaps, "pending_unreported_gaps"); const manifest: JsonObject = { reason: stimulus.reason as JsonValue, input_items: [], cursor_spans: [], lossy_gaps: gaps as JsonValue };
      const built = transition(emptyCoreSnapshot(), { type: "BuildManifest", command_id: "build", activation_id: "a", manifest });
      return { outcome: built.state.activations.a?.state === "ready" ? "gap_only_manifest_ready" : "unexpected", before: {}, observed: { manifest: built.state.manifests.a, activation: built.state.activations.a }, emitted: built.events.map(flattened) };
    }
    case "TST-CORE-015": {
      const activationInitial = object(initial.activation, "activation"); const subscription = object(initial.subscription, "subscription"); const activationId = text(activationInitial.activation_id, "activation_id"); const cursorSpan = object(activationInitial.cursor_span, "cursor_span"); const state = stagedState(activationId, { worker: integer(cursorSpan.from_page_seq, "from_page_seq") }, [{ value: "must-not-commit" }]); state.activations[activationId]!.result_digest = text(activationInitial.authoritative_result_digest, "result_digest"); state.subscriptions.worker = { cursor: integer(subscription.cursor, "cursor") };
      const applied = transition(state, { type: "ApplyResult", command_id: "apply", activation_id: activationId }, { crash_point: text(stimulus.injection_point, "injection_point"), storage_observation: "after_commit" });
      const module = object(initial.module, "module");
      return { outcome: applied.error?.code ?? "unexpected", before: {}, observed: { instance_state: applied.state.mode === "recovery_required" ? "RecoveryRequired" : "Running", activation: { state: applied.state.activations[activationId]?.state, authoritative_result_digest: applied.state.activations[activationId]?.result_digest }, module, subscription: applied.state.subscriptions.worker, outputs: applied.state.outputs, incident_evidence: applied.state.security_incidents }, emitted: applied.events.map(flattened) };
    }
    case "TST-CORE-016": {
      const activationInitial = object(initial.activation, "activation"); const manifest = object(activationInitial.manifest, "manifest"); const state = emptyCoreSnapshot(); state.activations.a = { state: "ready", attempt: integer(activationInitial.attempt, "attempt"), manifest: manifest as JsonObject }; const frozenSchema = text(manifest.effective_config_schema_digest, "frozen schema"); state.generations = list(initial.generations, "generations").map((value) => { const generation = object(value, "generation"); const supported = list(generation.supported_config_schema_digests, "supported schemas").map(String); return { generation: generation.generation as JsonValue, current_for_module: generation.current_for_module as JsonValue, compatible: supported.includes(frozenSchema), ready_for_module: supported.includes(frozenSchema), incompatibility_reason: "effective_config_schema_digest" }; }); state.current_generation = 8;
      const before = { current_module_config: structuredClone(initial.current_module_config) };
      const issued = transition(state, { type: "IssueLease", extension_connection_id: "connection-1", worker_epoch: 1, command_id: "lease", activation_id: "a", lease_id: "l", token_digest: "token" });
      const incompatible = issued.events.find((event) => event.event === "ExtensionGenerationIncompatible")!;
      return { outcome: issued.state.leases.l?.extension_generation === 8 ? "old_compatible_generation_executes_frozen_config" : "unexpected", before, observed: { generations: issued.state.generations, lease: issued.state.leases.l, activation: issued.state.activations.a, module_activate_request: { manifest: { effective_config: issued.reply?.effective_config, effective_config_digest: manifest.effective_config_digest } }, current_module_config: initial.current_module_config }, emitted: [flattened(incompatible)] };
    }
    case "TST-CORE-017": {
      const activationInitial = object(initial.activation, "activation");
      const commands = list(stimulus.commands, "commands").map((value) => object(value, "lease command"));
      const state = emptyCoreSnapshot();
      state.activations.a = { state: activationInitial.state === "retry_wait" ? "retry_wait" : "ready", attempt: integer(activationInitial.attempt, "attempt") };
      const resolve = (command: RecordValue) => ({
        command_id: text(command.command_id, "command_id"),
        activation_id: text(command.activation_id, "activation_id"),
        lease_id: text(command.lease_id, "lease_id"),
        token_digest: text(command.token_digest, "token_digest"),
        extension_connection_id: text(command.extension_connection_id, "extension_connection_id"),
        worker_epoch: integer(command.worker_epoch, "worker_epoch"),
        ...(command.extension_generation === undefined ? {} : { extension_generation: integer(command.extension_generation, "extension_generation") }),
      });
      const issued = transition(state, { type: "IssueLease", ...resolve(commands[0]!) });
      const replay = transition(issued.state, { type: "IssueLease", ...resolve(commands[1]!) });
      return {
        outcome: replay.error?.code === "STORAGE_IDEMPOTENCY_CONFLICT" ? "omitted_generation_replay_refused" : "unexpected",
        before: {},
        observed: { lease: issued.state.leases[resolve(commands[0]!).lease_id], activation: { state: issued.state.activations.a?.state, attempt: issued.state.activations.a?.attempt }, replay_error_code: replay.error?.code ?? null },
        emitted: issued.events.map(flattened),
      };
    }
    case "TST-CORE-018": {
      const activationInitial = object(initial.activation, "activation");
      const state = emptyCoreSnapshot();
      state.activations.a = { state: activationInitial.state === "retry_wait" ? "retry_wait" : "ready", attempt: integer(activationInitial.attempt, "attempt") };
      state.generations = list(initial.generations, "generations").map((value) => object(value, "generation record")) as unknown as JsonObject[];
      const issued = transition(state, {
        type: "IssueLease",
        command_id: text(stimulus.command_id, "command_id"),
        activation_id: "a",
        lease_id: text(stimulus.lease_id, "lease_id"),
        token_digest: text(stimulus.token_digest, "token_digest"),
        extension_connection_id: text(stimulus.extension_connection_id, "extension_connection_id"),
        worker_epoch: integer(stimulus.worker_epoch, "worker_epoch"),
        extension_generation: integer(stimulus.extension_generation, "extension_generation"),
      });
      return {
        outcome: issued.error?.code === "CORE_STATE_GENERATION_INVALID" ? "malformed_pool_generation_refused" : "unexpected",
        before: {},
        observed: { error_code: issued.error?.code ?? null, activation: { state: issued.state.activations.a?.state, attempt: issued.state.activations.a?.attempt } },
        emitted: issued.events.map(flattened),
      };
    }
    case "TST-CORE-019": {
      const activationInitial = object(initial.activation, "activation");
      const leaseInitial = object(initial.lease, "lease");
      const proof = object(initial.proof, "proof");
      const activationId = text(activationInitial.activation_id, "activation_id");
      const leaseId = text(stimulus.lease_id, "lease_id");
      const resultDigest = text(proof.result_digest, "proof.result_digest");
      const state = emptyCoreSnapshot();
      state.activations[activationId] = { state: "dispatched", attempt: integer(activationInitial.attempt, "attempt") };
      state.leases[leaseId] = { ...structuredClone(leaseInitial), activation_id: activationId } as JsonObject;
      const received = transition(state, {
        type: "ReceiveResult",
        command_id: text(stimulus.command_id, "command_id"),
        activation_id: activationId,
        lease_id: leaseId,
        status: "success",
        result: undefined,
        result_digest: resultDigest,
      }, {
        host_result_verification: {
          verified: true,
          payload_valid: true,
          activation_id: activationId,
          lease_id: leaseId,
          token_digest: text(proof.token_digest, "proof.token_digest"),
          extension_connection_id: text(proof.extension_connection_id, "proof.extension_connection_id"),
          attempt: integer(proof.attempt, "proof.attempt"),
          worker_epoch: integer(proof.worker_epoch, "proof.worker_epoch"),
          result_digest: resultDigest,
        },
      });
      return {
        outcome: received.error?.code === "ACTIVATION_FENCE_INVALID" ? "malformed_lease_generation_binding_refused" : "unexpected",
        before: {},
        observed: { error_code: received.error?.code ?? null, lease: received.state.leases[leaseId], activation: { state: received.state.activations[activationId]?.state } },
        emitted: received.events.map(flattened),
      };
    }
    default: throw new Error(`unmapped immutable vector ${vector.test_id}`);
  }
}

const vectors = [...new Set([VECTOR_ROOT, OVERLAY_ROOT].flatMap((root) => readdirSync(root).filter((name) => /^TST-CORE-\d{3}.*\.json$/.test(name))))]
  .sort()
  .map((name) => {
    const owner = [VECTOR_ROOT, OVERLAY_ROOT].find((root) => existsSync(path.join(root, name)));
    return object(readFrozenJsonTestFile(path.join(owner!, name)), name) as unknown as FrozenVector;
  });

describe("immutable Core vectors", () => {
  it("executes exactly TST-CORE-001 through TST-CORE-019", () => {
    expect(vectors.map((vector) => vector.test_id)).toEqual(Array.from({ length: 19 }, (_, index) => `TST-CORE-${String(index + 1).padStart(3, "0")}`));
  });

  for (const vector of vectors) {
    it(`${vector.test_id} enforces imported outcome, assertions, and ordered emissions`, () => {
      const scenario = execute(vector);
      expect(scenario.outcome).toBe(vector.expected.outcome);
      expect(vector.expected.assertions.length).toBeGreaterThan(0);
      for (const assertion of vector.expected.assertions) enforceAssertion(assertion, scenario);
      expect(scenario.emitted).toHaveLength(vector.expected.emitted.length);
      for (const [index, required] of vector.expected.emitted.entries()) expect(scenario.emitted[index]).toMatchObject(required);
    });
  }
});
