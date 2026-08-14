import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "../../../../src/schema-bundle/index.js";
import { emptyCoreSnapshot, hashCoreState, reduceCore, type CoreCommand, type CoreSnapshot, type JsonObject, type ReducerInput } from "../../../../src/core/reference-machine/index.js";

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;
const FENCE = `sha256:${"f".repeat(64)}`;

const input: ReducerInput = {
  now: "2026-01-01T00:00:00Z",
  retry_jitter: 17,
  graph_revision: 1,
  descriptor_revision: 1,
  host_replay_evidence: {
    activation_id: "a",
    source_attempt: 1,
    observation: "not_started",
    record: {},
    digest: canonicalJsonDigest({}),
    verified: true,
  },
  host_fence_verification: {
    verified: true,
    activation_id: "a",
    source_attempt: 1,
    execution_slot_empty: true,
    proof_digest: FENCE,
  },
  recovery_verification: {
    ordered_checks_complete: true,
    invariants_valid: true,
    persisted_values_valid: true,
    process_fences_valid: true,
    staged_results_valid: true,
  },
};

function run(state: CoreSnapshot, command: CoreCommand, override: Partial<ReducerInput> = {}) {
  return reduceCore(state, command, { ...input, ...override });
}

function leasedState(state: "leased" | "dispatched" | "committed" = "leased", resultDigest?: string): CoreSnapshot {
  const snapshot = emptyCoreSnapshot();
  snapshot.activations.a = { state, attempt: 1, ...(resultDigest ? { result_digest: resultDigest, authoritative_disposition: state } : {}) };
  snapshot.leases.l = { activation_id: "a", token_digest: "token-digest", extension_connection_id: "connection-1", worker_epoch: 1, attempt: 1, dispatch_state: state === "leased" ? "prepared" : "started" };
  return snapshot;
}

function resultVerification(resultDigest: string): ReducerInput["host_result_verification"] {
  return { verified: true, payload_valid: true, activation_id: "a", lease_id: "l", token_digest: "token-digest", extension_connection_id: "connection-1", worker_epoch: 1, attempt: 1, result_digest: resultDigest };
}

function stagedState(payload: JsonObject): CoreSnapshot {
  const state = emptyCoreSnapshot();
  state.activations.a = {
    state: "result_staged",
    attempt: 1,
    result_digest: canonicalJsonDigest(payload),
    authoritative_disposition: "result_staged",
    staged_result: {
      expected_cursors: (payload.expected_cursors ?? {}) as Record<string, number>,
      outputs: (payload.outputs ?? []) as JsonObject[],
      admitted_pages: (payload.admitted_pages ?? {}) as never,
      projected_admission_entries: Number(payload.projected_admission_entries ?? 0),
      ...(payload.page_limit === undefined ? {} : { page_limit: Number(payload.page_limit) }),
    },
  };
  return state;
}

function retryWaitState(authorization?: JsonObject): CoreSnapshot {
  const state = emptyCoreSnapshot();
  state.activations.a = {
    state: "retry_wait",
    attempt: 1,
    result_digest: A,
    ...(authorization ? { next_attempt_authorization: authorization } : {}),
  };
  return state;
}

const retryAuthorization: JsonObject = { activation_id: "a", source_attempt: 1, authorized_attempt: 2, reason: "explicit_retryable_failure", evidence_digest: A };

function retryLeaseCommand(command_id: string): CoreCommand {
  return { type: "IssueLease", extension_connection_id: "connection-1", worker_epoch: 1, command_id, activation_id: "a", lease_id: `lease-${command_id}`, token_digest: "token" };
}

describe("Core reference abstract machine", () => {
  it("admits idempotent ingress once with sorted unique Pages", () => {
    const state = emptyCoreSnapshot(); state.next_commit_seq = 10;
    const first = run(state, { type: "Ingress", command_id: "1", runtime_source: "channel", ingress_key: "m1", operation_digest: A, block_id: "block-1", block: { kind: "text" }, pages: ["b", "a", "b"] });
    const replay = run(first.state, { type: "Ingress", command_id: "2", runtime_source: "channel", ingress_key: "m1", operation_digest: A, block_id: "ignored", block: { kind: "other" }, pages: ["a", "b"] });
    expect(Object.keys(replay.state.blocks)).toEqual(["block-1"]);
    expect(replay.state.deliveries).toHaveLength(2);
    expect(replay.state.next_commit_seq).toBe(13);
    expect(replay.reply).toMatchObject({ block_id: "block-1", idempotent: true });
    expect(first.events.map((event) => event.event)).toEqual(["IngressCommitted"]);
  });

  it("uses runtime source and event key identity and preserves the first digest", () => {
    const command: CoreCommand = { type: "RuntimeEvent", command_id: "1", runtime_source: "timer", event_key: "tick", operation_digest: A, block_id: "b1", block: {}, pages: ["p"] };
    const first = run(emptyCoreSnapshot(), command);
    const replay = run(first.state, { ...command, command_id: "2", block_id: "b2" });
    const conflict = run(replay.state, { ...command, command_id: "3", operation_digest: B });
    expect(replay.reply).toMatchObject({ block_id: "b1", idempotent: true });
    expect(conflict.error?.code).toBe("STORAGE_IDEMPOTENCY_CONFLICT");
    expect(conflict.state.runtime_events["timer\u0000tick"]?.operation_digest).toBe(A);
    expect(conflict.events.map((event) => event.event)).toEqual(["SecurityIncident"]);
  });

  it("rolls back staged application before committing a distinct cursor safety stop", () => {
    const state = stagedState({ expected_cursors: { s: 7 }, outputs: [{ value: "must-not-commit" }] });
    state.subscriptions.s = { cursor: 8 };
    const before = hashCoreState(state);
    const transition = run(state, { type: "ApplyResult", command_id: "apply", activation_id: "a" });
    expect(transition.outcome).toBe("rolled_back_with_safety_stop");
    expect(transition.error?.code).toBe("ACTIVATION_CURSOR_CONFLICT");
    expect(transition.state.mode).toBe("recovery_required");
    expect(transition.state.activations.a?.state).toBe("result_staged");
    expect(transition.state.outputs).toEqual([]);
    expect(transition.state.subscriptions.s?.cursor).toBe(8);
    const priorWithoutStop = structuredClone(transition.state);
    priorWithoutStop.mode = "running"; priorWithoutStop.security_incidents = []; priorWithoutStop.journal = []; priorWithoutStop.next_commit_seq = 1;
    expect(hashCoreState(priorWithoutStop)).toBe(before);
  });

  it("stages authoritative application data and ignores later caller mutation", () => {
    const payload: JsonObject = {
      expected_cursors: { s: 2 },
      outputs: [{ block_id: "out", block: { kind: "text" }, deliveries: [{ page_id: "p", block_id: "out" }] }],
      admitted_pages: { p: [{ page_seq: 3, entries: [{ block_id: "out" }] }] },
      projected_admission_entries: 1,
      page_limit: 4,
    };
    const digest = canonicalJsonDigest(payload);
    const state = leasedState("dispatched"); state.subscriptions.s = { cursor: 2 };
    const staged = run(state, { type: "ReceiveResult", command_id: "receive", activation_id: "a", lease_id: "l", status: "success", result_digest: digest, result: payload }, { host_result_verification: resultVerification(digest) });
    (payload.outputs as JsonObject[])[0]!.block_id = "tampered";
    const applied = run(staged.state, { type: "ApplyResult", command_id: "apply", activation_id: "a" });
    expect(applied.state.activations.a?.state).toBe("committed");
    expect(applied.state.blocks.out).toEqual({ kind: "text" });
    expect(applied.state.blocks.tampered).toBeUndefined();
    expect(applied.state.subscriptions.s?.cursor).toBe(3);
    expect(applied.state.next_page_seq).toBe(4);
  });

  it("preserves committed output for equal and conflicting Host-bound result replay", () => {
    const state = leasedState("committed", A); state.outputs = [{ durable: true }];
    const equal = run(state, { type: "ReceiveResult", command_id: "equal", activation_id: "a", lease_id: "l", status: "success", result_digest: A }, { host_result_verification: resultVerification(A) });
    expect(equal.state).toBe(state);
    expect(equal.events).toEqual([]);
    expect(equal.reply).toMatchObject({ disposition: "committed", idempotent: true });
    const conflict = run(state, { type: "ReceiveResult", command_id: "conflict", activation_id: "a", lease_id: "l", status: "success", result_digest: B }, { host_result_verification: resultVerification(B) });
    expect(conflict.state.activations.a?.state).toBe("committed");
    expect(conflict.state.activations.a?.result_digest).toBe(A);
    expect(conflict.state.outputs).toEqual([{ durable: true }]);
    expect(conflict.error?.code).toBe("ACTIVATION_RESULT_CONFLICT");
  });

  it("rejects forged result bindings and caller-manufactured replay evidence", () => {
    const resultState = leasedState("dispatched");
    const forged = run(resultState, { type: "ReceiveResult", command_id: "receive", activation_id: "a", lease_id: "l", status: "success", result_digest: A }, { host_result_verification: { ...resultVerification(A)!, token_digest: "wrong" } });
    expect(forged.error?.code).toBe("ACTIVATION_FENCE_INVALID");

    const fenceState = leasedState("dispatched");
    fenceState.activations.a!.manifest = { frozen_replay_contract: { mode: "fenced_replay", evidence: "activation_ledger" } };
    const begun = run(fenceState, { type: "BeginFence", command_id: "begin", activation_id: "a" });
    const unverified = run(begun.state, { type: "RecordReplayEvidence", command_id: "record", activation_id: "a" }, { host_replay_evidence: { ...input.host_replay_evidence!, verified: false } });
    expect(unverified.error?.code).toBe("ACTIVATION_REPLAY_EVIDENCE_INVALID");
  });

  it("quarantines started never-auto-retry work and consumes safe retry authority once", () => {
    const started = leasedState("dispatched");
    started.activations.a!.manifest = { frozen_replay_contract: { mode: "never_auto_retry", evidence: "none" } };
    const begun = run(started, { type: "BeginFence", command_id: "begin", activation_id: "a" });
    const quarantined = run(begun.state, { type: "FenceComplete", command_id: "complete", activation_id: "a", retry_delay: 1 });
    expect(quarantined.state.activations.a?.state).toBe("quarantined");
    expect(quarantined.events.at(-1)?.event).toBe("ModuleQuarantined");

    const prepared = leasedState();
    const preparedBegun = run(prepared, { type: "BeginFence", command_id: "begin-2", activation_id: "a" });
    const scheduled = run(preparedBegun.state, { type: "FenceComplete", command_id: "complete-2", activation_id: "a", retry_delay: 17 });
    expect(scheduled.state.activations.a?.next_attempt_authorization).toMatchObject({ source_attempt: 1, authorized_attempt: 2, reason: "safe_before_dispatch", evidence_digest: FENCE });
    const issued = run(scheduled.state, { type: "IssueLease", extension_connection_id: "connection-1", worker_epoch: 1, command_id: "lease", activation_id: "a", lease_id: "l2", token_digest: "token-2" });
    expect(issued.state.activations.a?.attempt).toBe(2);
    expect(issued.state.activations.a?.next_attempt_authorization).toBeUndefined();
    const replay = run(issued.state, { type: "IssueLease", extension_connection_id: "connection-1", worker_epoch: 1, command_id: "lease-again", activation_id: "a", lease_id: "l3", token_digest: "token-3" });
    expect(replay.error?.code).toBe("ACTIVATION_NOT_LEASABLE");
  });

  it("keeps RecoveryRequired until every ordered Host check passes and refuses sequence regression", () => {
    const state = emptyCoreSnapshot(); state.mode = "recovery_required"; state.next_page_seq = 9;
    expect(run(state, { type: "Recover", command_id: "regress", persisted_next_page_seq: 8 }).error?.code).toBe("PAGE_SEQUENCE_REGRESSION");
    const incomplete = run(state, { type: "Recover", command_id: "incomplete", persisted_next_page_seq: 9 }, { recovery_verification: { ...input.recovery_verification!, ordered_checks_complete: false } });
    expect(incomplete.error?.code).toBe("RECOVERY_VERIFICATION_INCOMPLETE");
    const invalid = run(state, { type: "Recover", command_id: "invalid", persisted_next_page_seq: 9 }, { recovery_verification: { ...input.recovery_verification!, persisted_values_valid: false, failure_reason: "digest mismatch" } });
    expect(invalid.state.mode).toBe("recovery_required");
    const verified = run(invalid.state, { type: "Recover", command_id: "verified", persisted_next_page_seq: 9 });
    expect(verified.state.mode).toBe("running");
  });

  it("rejects noncanonical configuration and graph integrity digests", () => {
    const config = { mode: "strict" };
    expect(run(emptyCoreSnapshot(), { type: "InstallConfig", command_id: "bad", revision: 1, effective_config: config, digest: "d" }).error?.code).toBe("CONFIG_DIGEST_MISMATCH");
    expect(run(emptyCoreSnapshot(), { type: "InstallConfig", command_id: "good", revision: 1, effective_config: config, digest: canonicalJsonDigest(config) }).state.config.revision).toBe(1);
    expect(run(emptyCoreSnapshot(), { type: "InstallGraph", command_id: "bad-graph", revision: 1, graph: {}, digest: A }).error?.code).toBe("GRAPH_DIGEST_MISMATCH");
  });

  it("exercises all 21 closed command variants without I/O", () => {
    const cases: Array<{ state: CoreSnapshot; command: CoreCommand; override?: Partial<ReducerInput> }> = [];
    cases.push({ state: emptyCoreSnapshot(), command: { type: "InstallConfig", command_id: "c1", revision: 1, effective_config: {}, digest: canonicalJsonDigest({}) } });
    cases.push({ state: emptyCoreSnapshot(), command: { type: "InstallGraph", command_id: "c2", revision: 1, graph: {}, digest: canonicalJsonDigest({}) } });
    cases.push({ state: emptyCoreSnapshot(), command: { type: "Ingress", command_id: "c3", runtime_source: "r", ingress_key: "k", operation_digest: A, block_id: "b", block: {}, pages: [] } });
    cases.push({ state: emptyCoreSnapshot(), command: { type: "RuntimeEvent", command_id: "c4", runtime_source: "r", event_key: "e", operation_digest: A, block_id: "b", block: {}, pages: [] } });
    cases.push({ state: emptyCoreSnapshot(), command: { type: "GrantStorageWriter", command_id: "c5", owner: "w" } });
    const writer = emptyCoreSnapshot(); writer.storage_writer_owner = "w"; cases.push({ state: writer, command: { type: "ReleaseStorageWriter", command_id: "c6", owner: "w" } });
    cases.push({ state: emptyCoreSnapshot(), command: { type: "BuildManifest", command_id: "c7", activation_id: "a", manifest: {}, expected_graph_revision: 1, expected_descriptor_revision: 1 } });
    const ready = emptyCoreSnapshot(); ready.activations.a = { state: "ready", attempt: 0 }; cases.push({ state: ready, command: { type: "IssueLease", extension_connection_id: "connection-1", worker_epoch: 1, command_id: "c8", activation_id: "a", lease_id: "l", token_digest: "token" } });
    const leased = leasedState(); cases.push({ state: leased, command: { type: "DispatchLease", command_id: "c9", activation_id: "a", lease_id: "l", dispatch_state: "started" } });
    const resultPayload = {}; const resultDigest = canonicalJsonDigest(resultPayload); cases.push({ state: leasedState("dispatched"), command: { type: "ReceiveResult", command_id: "c10", activation_id: "a", lease_id: "l", result_digest: resultDigest, status: "success", result: resultPayload }, override: { host_result_verification: resultVerification(resultDigest) } });
    cases.push({ state: leasedState(), command: { type: "BeginFence", command_id: "c11", activation_id: "a" } });
    const fencing = leasedState("dispatched"); fencing.activations.a!.state = "fencing"; fencing.activations.a!.manifest = { frozen_replay_contract: { mode: "fenced_replay", evidence: "activation_ledger" } }; cases.push({ state: fencing, command: { type: "RecordReplayEvidence", command_id: "c12", activation_id: "a" } });
    const completing = leasedState(); completing.activations.a!.state = "fencing"; cases.push({ state: completing, command: { type: "FenceComplete", command_id: "c13", activation_id: "a", retry_delay: 1 } });
    cases.push({ state: stagedState({}), command: { type: "ApplyResult", command_id: "c14", activation_id: "a" } });
    cases.push({ state: ready, command: { type: "CancelActivation", command_id: "c15", activation_id: "a", reason: "operator" } });
    const quarantined = emptyCoreSnapshot(); quarantined.activations.a = { state: "quarantined", attempt: 1 }; quarantined.quarantines.a = { reason: "x" };
    cases.push({ state: quarantined, command: { type: "ResolveQuarantine", command_id: "c16", activation_id: "a", resolution: "cancel" } });
    cases.push({ state: quarantined, command: { type: "CompleteQuarantineFence", command_id: "c17", activation_id: "a" } });
    const page = emptyCoreSnapshot(); page.next_page_seq = 3; page.subscriptions.s = { cursor: 1 };
    cases.push({ state: page, command: { type: "DeadLetterRange", command_id: "c18", subscription_id: "s", start: 1, end_exclusive: 2, reason: "invalid" } });
    cases.push({ state: page, command: { type: "SkipRange", command_id: "c19", subscription_id: "s", start: 1, end_exclusive: 2 } });
    cases.push({ state: emptyCoreSnapshot(), command: { type: "LossyEvict", command_id: "c20", page_id: "p", start: 1, end_exclusive: 2, reason: "overflow" } });
    cases.push({ state: emptyCoreSnapshot(), command: { type: "Recover", command_id: "c21", persisted_next_page_seq: 2 } });
    expect(cases).toHaveLength(21);
    for (const item of cases) expect(run(item.state, item.command, item.override).state_hash, item.command.type).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("models every CP-01..15 transaction as exact prior or exact complete durable state", () => {
    const scenarios: Array<{ label: string; state: CoreSnapshot; command: CoreCommand; observation: "before_commit" | "after_commit"; override?: Partial<ReducerInput> }> = [];
    const manifest = (): CoreSnapshot => emptyCoreSnapshot();
    scenarios.push({ label: "CP-01", state: manifest(), command: { type: "BuildManifest", command_id: "CP-01", activation_id: "a", manifest: {} }, observation: "before_commit" });
    scenarios.push({ label: "CP-02", state: manifest(), command: { type: "BuildManifest", command_id: "CP-02", activation_id: "a", manifest: {} }, observation: "before_commit" });
    scenarios.push({ label: "CP-03", state: manifest(), command: { type: "BuildManifest", command_id: "CP-03", activation_id: "a", manifest: {} }, observation: "after_commit" });
    const ready = emptyCoreSnapshot(); ready.activations.a = { state: "ready", attempt: 0 }; scenarios.push({ label: "CP-04", state: ready, command: { type: "IssueLease", extension_connection_id: "connection-1", worker_epoch: 1, command_id: "CP-04", activation_id: "a", lease_id: "l", token_digest: "token" }, observation: "after_commit" });
    scenarios.push({ label: "CP-05", state: leasedState("dispatched"), command: { type: "BeginFence", command_id: "CP-05", activation_id: "a" }, observation: "after_commit" });
    scenarios.push({ label: "CP-06", state: leasedState("dispatched"), command: { type: "BeginFence", command_id: "CP-06", activation_id: "a" }, observation: "after_commit" });
    const resultPayload = {}; const resultDigest = canonicalJsonDigest(resultPayload); scenarios.push({ label: "CP-07", state: leasedState("dispatched"), command: { type: "ReceiveResult", command_id: "CP-07", activation_id: "a", lease_id: "l", status: "success", result_digest: resultDigest, result: resultPayload }, observation: "after_commit", override: { host_result_verification: resultVerification(resultDigest) } });
    scenarios.push({ label: "CP-08", state: stagedState({ outputs: [{ value: 1 }] }), command: { type: "ApplyResult", command_id: "CP-08", activation_id: "a" }, observation: "before_commit" });
    for (const label of ["CP-09", "CP-10", "CP-11"]) scenarios.push({ label, state: stagedState({ outputs: [{ value: label }] }), command: { type: "ApplyResult", command_id: label, activation_id: "a" }, observation: "after_commit" });
    scenarios.push({ label: "CP-12", state: emptyCoreSnapshot(), command: { type: "InstallConfig", command_id: "CP-12", revision: 1, effective_config: {}, digest: canonicalJsonDigest({}) }, observation: "before_commit" });
    const disposition = emptyCoreSnapshot(); disposition.next_page_seq = 3; disposition.subscriptions.s = { cursor: 1 }; scenarios.push({ label: "CP-13", state: disposition, command: { type: "SkipRange", command_id: "CP-13", subscription_id: "s", start: 1, end_exclusive: 2 }, observation: "before_commit" });
    scenarios.push({ label: "CP-14", state: emptyCoreSnapshot(), command: { type: "LossyEvict", command_id: "CP-14", page_id: "p", start: 1, end_exclusive: 2, reason: "gc-observation" }, observation: "before_commit" });
    scenarios.push({ label: "CP-15", state: emptyCoreSnapshot(), command: { type: "RuntimeEvent", command_id: "CP-15", runtime_source: "r", event_key: "e", operation_digest: A, block_id: "b", block: {}, pages: ["p"] }, observation: "before_commit" });
    expect(scenarios.map(({ label }) => label)).toEqual(Array.from({ length: 15 }, (_, index) => `CP-${String(index + 1).padStart(2, "0")}`));
    for (const scenario of scenarios) {
      const transition = run(scenario.state, scenario.command, { ...scenario.override, crash_point: scenario.label, storage_observation: scenario.observation });
      if (scenario.observation === "before_commit") {
        expect(transition.outcome, scenario.label).toBe("rolled_back");
        expect(transition.state_hash, scenario.label).toBe(hashCoreState(scenario.state));
        expect(transition.events, scenario.label).toEqual([]);
      } else {
        expect(transition.outcome, scenario.label).toBe("committed");
        expect(transition.state_hash, scenario.label).not.toBe(hashCoreState(scenario.state));
      }
    }
  });

  it("holds deterministic idempotency and crash rollback across adversarial generated fan-out", () => {
    for (let seed = 1; seed <= 128; seed += 1) {
      const pages = Array.from({ length: 1 + (seed % 9) }, (_, index) => `p${(seed * 17 + index * 13) % 7}`);
      const command: CoreCommand = { type: "Ingress", command_id: `i${seed}`, runtime_source: `r${seed % 3}`, ingress_key: `k${seed}`, operation_digest: A, block_id: `b${seed}`, block: { seed }, pages };
      const first = run(emptyCoreSnapshot(), command);
      const repeat = run(first.state, { ...command, command_id: `r${seed}`, pages: [...pages].reverse() });
      expect(repeat.state_hash).toBe(first.state_hash);
      expect(repeat.state.deliveries.filter((entry) => entry.block_id === `b${seed}`)).toHaveLength(new Set(pages).size);
      const crashed = run(emptyCoreSnapshot(), command, { crash_point: "CP-15", storage_observation: "before_commit" });
      expect(crashed.state_hash).toBe(hashCoreState(emptyCoreSnapshot()));
    }
  });
  it("fails closed on stale leases, forged authority, invalid ranges, recovery failures, and non-canonical input", () => {
    const ready = emptyCoreSnapshot();
    ready.activations.a = { state: "ready", attempt: 0 };
    const firstLease = run(ready, { type: "IssueLease", command_id: "l1", activation_id: "a", lease_id: "l1", token_digest: "t1", extension_connection_id: "connection-1", worker_epoch: 1 });
    const firstFence = run(firstLease.state, { type: "BeginFence", command_id: "f1", activation_id: "a" });
    const firstRetry = run(firstFence.state, { type: "FenceComplete", command_id: "fc1", activation_id: "a", retry_delay: 1 });
    const secondLease = run(firstRetry.state, { type: "IssueLease", command_id: "l2", activation_id: "a", lease_id: "l2", token_digest: "t2", extension_connection_id: "connection-2", worker_epoch: 2 });
    const secondFence = run(secondLease.state, { type: "BeginFence", command_id: "f2", activation_id: "a" });
    const secondRetry = run(secondFence.state, { type: "FenceComplete", command_id: "fc2", activation_id: "a", retry_delay: 2 }, {
      host_fence_verification: { verified: true, activation_id: "a", source_attempt: 2, execution_slot_empty: true, proof_digest: FENCE },
    });
    expect(secondRetry.state.activations.a?.state).toBe("retry_wait");
    expect(secondRetry.state.leases.l2?.dispatch_state).toBe("fenced");
    expect(secondRetry.state.leases.l1?.dispatch_state).toBe("fenced");

    const payload: JsonObject = {};
    const payloadDigest = canonicalJsonDigest(payload);
    const generationSubstitution = run(
      leasedState("dispatched"),
      { type: "ReceiveResult", command_id: "receive", activation_id: "a", lease_id: "l", status: "success", result_digest: payloadDigest, result: payload },
      { host_result_verification: { ...resultVerification(payloadDigest)!, extension_generation: 8 } },
    );
    expect(generationSubstitution.error?.code).toBe("ACTIVATION_FENCE_INVALID");
    const connectionSubstitution = run(
      leasedState("dispatched"),
      { type: "ReceiveResult", command_id: "receive", activation_id: "a", lease_id: "l", status: "success", result_digest: payloadDigest, result: payload },
      { host_result_verification: { ...resultVerification(payloadDigest)!, extension_connection_id: "other" } },
    );
    expect(connectionSubstitution.error?.code).toBe("ACTIVATION_FENCE_INVALID");

    const replayState = leasedState("dispatched");
    replayState.activations.a!.manifest = {
      manifest_digest: A,
      module_id: "writer",
      storage_scope_id: "scope-1",
      frozen_replay_contract: { mode: "fenced_replay", evidence: "activation_ledger", ledger: { namespace: "effects" } },
    };
    replayState.activations.a!.extension_generation = 8;
    replayState.leases.l!.manifest_digest = A;
    replayState.leases.l!.extension_generation = 8;
    const replayFence = run(replayState, { type: "BeginFence", command_id: "begin", activation_id: "a" });
    const forgedRecord: JsonObject = {
      activation_id: "a",
      source_attempt: 1,
      manifest_digest: A,
      module_id: "other",
      storage_scope_id: "scope-1",
      target_extension_generation: 8,
      ledger: { namespace: "effects" },
      ledger_state: "complete",
    };
    const forgedEvidence = run(replayFence.state, { type: "RecordReplayEvidence", command_id: "record", activation_id: "a" }, {
      host_replay_evidence: {
        verified: true,
        activation_id: "a",
        source_attempt: 1,
        target_generation: 8,
        observation: "succeeded",
        record: forgedRecord,
        digest: canonicalJsonDigest(forgedRecord),
      },
    });
    expect(forgedEvidence.error?.code).toBe("ACTIVATION_REPLAY_EVIDENCE_INVALID");
    const forgedScopeRecord: JsonObject = { ...forgedRecord, module_id: "writer", storage_scope_id: "other-scope" };
    const forgedScopeEvidence = run(replayFence.state, { type: "RecordReplayEvidence", command_id: "record-scope", activation_id: "a" }, {
      host_replay_evidence: {
        verified: true,
        activation_id: "a",
        source_attempt: 1,
        target_generation: 8,
        observation: "succeeded",
        record: forgedScopeRecord,
        digest: canonicalJsonDigest(forgedScopeRecord),
      },
    });
    expect(forgedScopeEvidence.error?.code).toBe("ACTIVATION_REPLAY_EVIDENCE_INVALID");

    for (const type of ["DeadLetterRange", "SkipRange"] as const) {
      const disposition = emptyCoreSnapshot();
      disposition.next_page_seq = 10;
      disposition.subscriptions.s = { cursor: 5 };
      const command: CoreCommand = type === "DeadLetterRange"
        ? { type, command_id: type, subscription_id: "s", start: 5, end_exclusive: 3, reason: "invalid" }
        : { type, command_id: type, subscription_id: "s", start: 5, end_exclusive: 3 };
      const rejected = run(disposition, command);
      expect(rejected.error?.code).toBe("SUBSCRIPTION_DISPOSITION_CONFLICT");
      expect(rejected.state.subscriptions.s?.cursor).toBe(5);
    }

    const recovering = emptyCoreSnapshot();
    recovering.mode = "recovery_required";
    recovering.next_page_seq = 7;
    recovering.volatile_lossy_entries = [{ page_id: "lossy", page_seq: 7 }];
    const failedRecovery = run(recovering, { type: "Recover", command_id: "recover", persisted_next_page_seq: 12 }, {
      recovery_verification: { ordered_checks_complete: true, invariants_valid: false, persisted_values_valid: true, process_fences_valid: true, staged_results_valid: true, failure_reason: "integrity" },
    });
    expect(failedRecovery.state.next_page_seq).toBe(7);
    expect(failedRecovery.state.volatile_lossy_entries).toEqual(recovering.volatile_lossy_entries);
    expect(failedRecovery.state.mode).toBe("recovery_required");

    const committed = leasedState("committed", A);
    committed.outputs = [{ durable: true }];
    committed.quarantines.a = { reason: "ACTIVATION_RESULT_CONFLICT", fence_complete: true };
    const retriedCommitted = run(committed, { type: "ResolveQuarantine", command_id: "resolve", activation_id: "a", resolution: "retry" });
    expect(retriedCommitted.error?.code).toBe("ACTIVATION_COMMITTED_IMMUTABLE");
    expect(retriedCommitted.state.outputs).toEqual([{ durable: true }]);

    const nonCanonical = run(emptyCoreSnapshot(), { type: "Ingress", command_id: "bad", runtime_source: "r", ingress_key: "k", operation_digest: A, block_id: "b", block: { value: Number.NaN } as unknown as JsonObject, pages: [] });
    expect(nonCanonical.error?.code).toBe("CANONICAL_JSON_INVALID");
  });

  it("makes manifest identity immutable while preserving exact replay", () => {
    const first = run(emptyCoreSnapshot(), { type: "BuildManifest", command_id: "first", activation_id: "a", manifest: { reason: "input" } });
    const replay = run(first.state, { type: "BuildManifest", command_id: "replay", activation_id: "a", manifest: { reason: "input" } });
    expect(replay.state_hash).toBe(first.state_hash);
    expect(replay.events).toEqual([]);
    const conflict = run(first.state, { type: "BuildManifest", command_id: "conflict", activation_id: "a", manifest: { reason: "timer" } });
    expect(conflict.error?.code).toBe("STORAGE_IDEMPOTENCY_CONFLICT");
    expect(conflict.state.manifests.a).toEqual({ reason: "input" });
  });

  it("fails closed on a non-canonical snapshot without throwing", () => {
    const malformed = emptyCoreSnapshot() as CoreSnapshot & { negative_zero?: number };
    malformed.negative_zero = -0;
    const result = run(malformed, { type: "Ingress", command_id: "invalid-snapshot", runtime_source: "host", ingress_key: "invalid-snapshot", operation_digest: A, block_id: "invalid-snapshot", block: {}, pages: [] });
    expect(result.outcome).toBe("rolled_back_with_safety_stop");
    expect(result.error?.code).toBe("CORE_STATE_CANONICAL_JSON_INVALID");
    expect(result.state.mode).toBe("recovery_required");
    expect(result.safety_stop).toBeDefined();
    expect("negative_zero" in result.state).toBe(false);
  });

  it("preserves exact lease replay and rejects lease identifier collisions", () => {
    const ready = emptyCoreSnapshot();
    ready.activations.a = { state: "ready", attempt: 0 };
    const command: CoreCommand = { type: "IssueLease", command_id: "first", activation_id: "a", lease_id: "lease", token_digest: "token", extension_connection_id: "connection", worker_epoch: 7 };
    const first = run(ready, command);
    const replay = run(first.state, { ...command, command_id: "replay" });
    expect(replay.state_hash).toBe(first.state_hash);
    expect(replay.events).toEqual([]);
    expect(replay.reply).toMatchObject({ lease_id: "lease", attempt: 1 });
    const collision = run(first.state, { ...command, command_id: "collision", token_digest: "different" });
    expect(collision.error?.code).toBe("STORAGE_IDEMPOTENCY_CONFLICT");
    expect(collision.state_hash).toBe(first.state_hash);
  });

  it("rejects page and cursor sequences that cannot be incremented safely", () => {
    const pageState = stagedState({ expected_cursors: {}, admitted_pages: { p: [{ page_seq: Number.MAX_SAFE_INTEGER, entries: [] }] }, outputs: [], projected_admission_entries: 0 });
    const page = run(pageState, { type: "ApplyResult", command_id: "page", activation_id: "a" });
    expect(page.error?.code).toBe("PAGE_SEQUENCE_INVALID");
    expect(page.state_hash).toBe(hashCoreState(pageState));

    const cursorState = stagedState({ expected_cursors: { s: Number.MAX_SAFE_INTEGER }, admitted_pages: {}, outputs: [], projected_admission_entries: 0 });
    cursorState.subscriptions.s = { cursor: Number.MAX_SAFE_INTEGER };
    const cursor = run(cursorState, { type: "ApplyResult", command_id: "cursor", activation_id: "a" });
    expect(cursor.error?.code).toBe("ACTIVATION_INVALID_RESULT");
    expect(cursor.state_hash).toBe(hashCoreState(cursorState));

    const recovering = emptyCoreSnapshot();
    recovering.mode = "recovery_required";
    const recovered = run(recovering, { type: "Recover", command_id: "recover-unsafe", persisted_next_page_seq: Number.MAX_SAFE_INTEGER + 1 });
    expect(recovered.error?.code).toBe("PAGE_SEQUENCE_INVALID");
    expect(recovered.state_hash).toBe(hashCoreState(recovering));
  });
  it("WP-003: rejects IssueLease on retry_wait without next_attempt_authorization", () => {
    const state = retryWaitState();
    const result = run(state, retryLeaseCommand("no-auth"));
    expect(result.error?.code).toBe("ACTIVATION_RETRY_NOT_AUTHORIZED");
  });

  it("WP-003: rejects IssueLease on retry_wait with wrong activation_id in authorization", () => {
    const state = retryWaitState({ ...retryAuthorization, activation_id: "other" });
    const result = run(state, retryLeaseCommand("wrong-id"));
    expect(result.error?.code).toBe("ACTIVATION_RETRY_NOT_AUTHORIZED");
  });

  it("WP-003: rejects IssueLease on retry_wait with wrong authorized_attempt", () => {
    const state = retryWaitState({ ...retryAuthorization, authorized_attempt: 3 });
    const result = run(state, retryLeaseCommand("wrong-attempt"));
    expect(result.error?.code).toBe("ACTIVATION_RETRY_NOT_AUTHORIZED");
  });

  it("WP-003: rejects IssueLease on retry_wait with wrong source_attempt", () => {
    const state = retryWaitState({ ...retryAuthorization, source_attempt: 0 });
    const result = run(state, retryLeaseCommand("wrong-source"));
    expect(result.error?.code).toBe("ACTIVATION_RETRY_NOT_AUTHORIZED");
  });

  it("WP-003: accepts IssueLease on retry_wait with valid authorization and consumes it", () => {
    const state = retryWaitState(retryAuthorization);
    const result = run(state, retryLeaseCommand("valid-auth"));
    expect(result.outcome).toBe("committed");
    expect(result.state.activations.a?.state).toBe("leased");
    expect(result.state.activations.a?.attempt).toBe(2);
    expect(result.state.activations.a?.next_attempt_authorization).toBeUndefined();
  });

  it("WP-003: accepts IssueLease on ready state without authorization (regression guard)", () => {
    const state = emptyCoreSnapshot();
    state.activations.a = { state: "ready", attempt: 0 };
    const result = run(state, retryLeaseCommand("ready-no-auth"));
    expect(result.outcome).toBe("committed");
    expect(result.state.activations.a?.state).toBe("leased");
    expect(result.state.activations.a?.attempt).toBe(1);
  });

  it("rejects snapshots with counters exceeding MAX_SAFE_INTEGER", () => {
    const overCommit = emptyCoreSnapshot();
    overCommit.next_commit_seq = Number.MAX_SAFE_INTEGER + 1;
    const commitResult = run(overCommit, { type: "Ingress", command_id: "bad-commit", runtime_source: "host", ingress_key: "k", operation_digest: A, block_id: "b", block: {}, pages: [] });
    expect(commitResult.outcome).toBe("rolled_back_with_safety_stop");
    expect(commitResult.error?.code).toBe("CORE_STATE_COUNTER_INVALID");
    expect(commitResult.state.mode).toBe("recovery_required");

    const overAttempt = emptyCoreSnapshot();
    overAttempt.activations.a = { state: "ready", attempt: Number.MAX_SAFE_INTEGER + 1 };
    const attemptResult = run(overAttempt, { type: "IssueLease", command_id: "bad-attempt", activation_id: "a", lease_id: "l", token_digest: "t", extension_connection_id: "c", worker_epoch: 1 });
    expect(attemptResult.outcome).toBe("rolled_back_with_safety_stop");
    expect(attemptResult.error?.code).toBe("CORE_STATE_COUNTER_INVALID");
  });

  it("rejects Ingress that would exhaust the commit sequence budget", () => {
    const nearLimit = emptyCoreSnapshot();
    nearLimit.next_commit_seq = Number.MAX_SAFE_INTEGER - 1;
    const result = run(nearLimit, { type: "Ingress", command_id: "exhaust", runtime_source: "host", ingress_key: "k", operation_digest: A, block_id: "b", block: {}, pages: ["p1"] });
    expect(result.error?.code).toBe("COMMIT_SEQUENCE_EXHAUSTED");
    expect(result.state_hash).toBe(hashCoreState(nearLimit));
  });

  it("rejects IssueLease when the attempt sequence is exhausted", () => {
    const ready = emptyCoreSnapshot();
    ready.activations.a = { state: "ready", attempt: Number.MAX_SAFE_INTEGER };
    const result = run(ready, { type: "IssueLease", command_id: "exhaust", activation_id: "a", lease_id: "l", token_digest: "t", extension_connection_id: "c", worker_epoch: 1 });
    expect(result.error?.code).toBe("ATTEMPT_SEQUENCE_EXHAUSTED");
    expect(result.state_hash).toBe(hashCoreState(ready));
  });

  it("rejects ReceiveResult retry authorization when the attempt sequence is exhausted", () => {
    const dispatched = leasedState("dispatched");
    dispatched.activations.a!.attempt = Number.MAX_SAFE_INTEGER;
    dispatched.leases.l.attempt = Number.MAX_SAFE_INTEGER;
    const resultDigest = canonicalJsonDigest({});
    const result = run(dispatched, { type: "ReceiveResult", command_id: "exhaust", activation_id: "a", lease_id: "l", status: "retryable", result_digest: resultDigest }, { host_result_verification: { ...resultVerification(resultDigest)!, attempt: Number.MAX_SAFE_INTEGER } });
    expect(result.error?.code).toBe("ATTEMPT_SEQUENCE_EXHAUSTED");
    expect(result.state_hash).toBe(hashCoreState(dispatched));
  });
});

describe("WP-003: IssueLease idempotency replay boundary", () => {
  it("rejects replay omitting extension_generation when stored lease has one", () => {
    const state = emptyCoreSnapshot();
    state.activations.a = { state: "ready", attempt: 0 };
    state.generations = [{ generation: 8, compatible: true }];
    const original = run(state, {
      type: "IssueLease", command_id: "cmd-1", activation_id: "a", lease_id: "lease-1",
      token_digest: A, extension_connection_id: "conn-1", worker_epoch: 1, extension_generation: 8,
    });
    expect(original.outcome).toBe("committed");
    expect(original.reply?.extension_generation).toBe(8);
    const replay = run(original.state, {
      type: "IssueLease", command_id: "cmd-2", activation_id: "a", lease_id: "lease-1",
      token_digest: A, extension_connection_id: "conn-1", worker_epoch: 1,
    });
    expect(replay.outcome).toBe("rolled_back");
    expect(replay.error?.code).toBe("STORAGE_IDEMPOTENCY_CONFLICT");
  });

  it("accepts replay with matching extension_generation", () => {
    const state = emptyCoreSnapshot();
    state.activations.a = { state: "ready", attempt: 0 };
    state.generations = [{ generation: 8, compatible: true }];
    const original = run(state, {
      type: "IssueLease", command_id: "cmd-1", activation_id: "a", lease_id: "lease-1",
      token_digest: A, extension_connection_id: "conn-1", worker_epoch: 1, extension_generation: 8,
    });
    expect(original.outcome).toBe("committed");
    const replay = run(original.state, {
      type: "IssueLease", command_id: "cmd-2", activation_id: "a", lease_id: "lease-1",
      token_digest: A, extension_connection_id: "conn-1", worker_epoch: 1, extension_generation: 8,
    });
    expect(replay.outcome).toBe("committed");
    expect(replay.reply?.extension_generation).toBe(8);
  });

  it("accepts replay omitting extension_generation when stored lease also lacks one", () => {
    const state = emptyCoreSnapshot();
    state.activations.a = { state: "ready", attempt: 0 };
    const original = run(state, {
      type: "IssueLease", command_id: "cmd-1", activation_id: "a", lease_id: "lease-2",
      token_digest: A, extension_connection_id: "conn-1", worker_epoch: 1,
    });
    expect(original.outcome).toBe("committed");
    expect(original.reply?.extension_generation).toBeUndefined();
    const replay = run(original.state, {
      type: "IssueLease", command_id: "cmd-2", activation_id: "a", lease_id: "lease-2",
      token_digest: A, extension_connection_id: "conn-1", worker_epoch: 1,
    });
    expect(replay.outcome).toBe("committed");
  });

  it("rejects replay with mismatched extension_generation", () => {
    const state = emptyCoreSnapshot();
    state.activations.a = { state: "ready", attempt: 0 };
    state.generations = [{ generation: 8, compatible: true }, { generation: 9, compatible: true }];
    const original = run(state, {
      type: "IssueLease", command_id: "cmd-1", activation_id: "a", lease_id: "lease-3",
      token_digest: A, extension_connection_id: "conn-1", worker_epoch: 1, extension_generation: 8,
    });
    expect(original.outcome).toBe("committed");
    const replay = run(original.state, {
      type: "IssueLease", command_id: "cmd-2", activation_id: "a", lease_id: "lease-3",
      token_digest: A, extension_connection_id: "conn-1", worker_epoch: 1, extension_generation: 9,
    });
    expect(replay.outcome).toBe("rolled_back");
    expect(replay.error?.code).toBe("STORAGE_IDEMPOTENCY_CONFLICT");
  });

  it("rejects replay omitting extension_generation when stored lease has a present null (malformed)", () => {
    const state = emptyCoreSnapshot();
    state.activations.a = { state: "ready", attempt: 0 };
    // Simulate a corrupted stored lease with a present null extension_generation
    state.leases["lease-malformed"] = {
      activation_id: "a",
      token_digest: A,
      extension_connection_id: "conn-1",
      worker_epoch: 1,
      attempt: 1,
      extension_generation: null as unknown as number,
    };
    const replay = run(state, {
      type: "IssueLease", command_id: "cmd-1", activation_id: "a", lease_id: "lease-malformed",
      token_digest: A, extension_connection_id: "conn-1", worker_epoch: 1,
    });
    expect(replay.outcome).toBe("rolled_back");
    expect(replay.error?.code).toBe("STORAGE_IDEMPOTENCY_CONFLICT");
  });

  it("rejects replay omitting extension_generation when stored lease has a present string (malformed)", () => {
    const state = emptyCoreSnapshot();
    state.activations.a = { state: "ready", attempt: 0 };
    // Simulate a malformed stored lease with a present string extension_generation
    state.leases["lease-malformed-str"] = {
      activation_id: "a",
      token_digest: A,
      extension_connection_id: "conn-1",
      worker_epoch: 1,
      attempt: 1,
      extension_generation: "8" as unknown as number,
    };
    const replay = run(state, {
      type: "IssueLease", command_id: "cmd-1", activation_id: "a", lease_id: "lease-malformed-str",
      token_digest: A, extension_connection_id: "conn-1", worker_epoch: 1,
    });
    expect(replay.outcome).toBe("rolled_back");
    expect(replay.error?.code).toBe("STORAGE_IDEMPOTENCY_CONFLICT");
  });

  it("rejects generation replay when persisted extension_generation is a malformed numeric string", () => {
    const state = emptyCoreSnapshot();
    // Attempt-aligned corrupted lease: every identity field matches the command
    // and Number(existing.attempt) equals item.attempt, so only the generation
    // comparison decides the replay instead of short-circuiting on attempt.
    state.activations.a = { state: "ready", attempt: 1 };
    state.leases["lease-malformed-str"] = {
      activation_id: "a",
      token_digest: A,
      extension_connection_id: "conn-1",
      worker_epoch: 1,
      attempt: 1,
      extension_generation: "8" as unknown as number,
    };
    const replay = run(state, {
      type: "IssueLease", command_id: "cmd-1", activation_id: "a", lease_id: "lease-malformed-str",
      token_digest: A, extension_connection_id: "conn-1", worker_epoch: 1, extension_generation: 8,
    });
    expect(replay.outcome).toBe("rolled_back");
    expect(replay.error?.code).toBe("STORAGE_IDEMPOTENCY_CONFLICT");
  });

  it("rejects generation replay when persisted extension_generation is null or a wrong type", () => {
    for (const malformed of [null, true, "eight"]) {
      const state = emptyCoreSnapshot();
      state.activations.a = { state: "ready", attempt: 1 };
      const leaseId = `lease-${String(malformed)}`;
      state.leases[leaseId] = {
        activation_id: "a",
        token_digest: A,
        extension_connection_id: "conn-1",
        worker_epoch: 1,
        attempt: 1,
        extension_generation: malformed as unknown as number,
      };
      const replay = run(state, {
        type: "IssueLease", command_id: "cmd-1", activation_id: "a", lease_id: leaseId,
        token_digest: A, extension_connection_id: "conn-1", worker_epoch: 1, extension_generation: 8,
      });
      expect(replay.outcome, String(malformed)).toBe("rolled_back");
      expect(replay.error?.code, String(malformed)).toBe("STORAGE_IDEMPOTENCY_CONFLICT");
    }
  });

  it("rejects result binding when persisted extension_generation is a malformed numeric string", () => {
    const state = leasedState("dispatched");
    state.leases.l!.extension_generation = "8" as unknown as number;
    const payloadDigest = canonicalJsonDigest({});
    const result = run(
      state,
      { type: "ReceiveResult", command_id: "receive", activation_id: "a", lease_id: "l", status: "success", result_digest: payloadDigest, result: {} },
      { host_result_verification: { ...resultVerification(payloadDigest)!, extension_generation: 8 } },
    );
    expect(result.outcome).toBe("rolled_back");
    expect(result.error?.code).toBe("ACTIVATION_FENCE_INVALID");
  });
});
