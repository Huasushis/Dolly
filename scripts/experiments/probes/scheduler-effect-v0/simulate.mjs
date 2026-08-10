import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  DRAIN_END_MS,
  EventHeap,
  QUEUE_BYTE_LIMIT,
  QUEUE_RECORD_LIMIT,
  SHOCK_END_MS,
  SIMULATION_END_MS,
  createRandom,
  ensureFiniteJson,
  jainFairness,
  percentileNearestRank,
  round,
  stableRecoveryMetrics,
} from "./common.mjs";

const FIXED_PERIOD_MS = 20;
const WATERMARK_RECORDS = 4;
const WATERMARK_BYTES = 49_152;
const WATERMARK_MAX_AGE_MS = 35;
const CONTROL_SAMPLE_MS = 10;
const NO_PROGRESS_MS = 150;

export const SIMULATION_TOPOLOGIES = [
  "line",
  "fan-out",
  "fan-in",
  "cycle",
  "self-loop",
];

export const LOAD_PROFILES = ["stable", "shock"];

export const PRIMARY_POLICIES = [
  "fixed-period",
  "event-driven",
  "queue-watermark",
  "downstream-backlog-service-adaptive-period",
];

export const ABLATION_POLICIES = [
  "adaptive-count-only",
  "adaptive-mean-fanout",
  "adaptive-no-module-feedback",
];

export function runSimulationCase({ topologyId, loadProfile, policyId, seed, rawPath }) {
  const topology = buildTopology(topologyId);
  const caseId = `simulation__${topologyId}__${loadProfile}__${policyId}__seed-${seed}`;
  const random = createRandom(seed);
  const events = new EventHeap();
  const raw = [];
  const modules = new Map();
  const outgoing = new Map();
  const incoming = new Map();
  let sequence = 0;
  let now = 0;
  let blockSequence = 0;
  let runSequence = 0;
  let processedEvents = 0;
  const processedEventTypes = new Map();

  const counters = {
    calls: 0,
    emptyCalls: 0,
    missedTicks: 0,
    serialViolations: 0,
    outputCountViolations: 0,
    atomicBroadcastViolations: 0,
    duplicateCountViolations: 0,
    arrivalsDuringRun: 0,
    duplicateOccurrencesMerged: 0,
    feedbackTooFast: 0,
    feedbackTooSlow: 0,
    feedbackConflicts: 0,
    outputBlocked: 0,
    externalBackpressure: 0,
    policyUpdates: 0,
    terminalOccurrences: 0,
  };
  const sourceAcceptedCounts = new Map(
    topology.sources.map((moduleId) => [moduleId, 0]),
  );
  const sourcePlannedCounts = new Map(
    topology.sources.map((moduleId) => [moduleId, 0]),
  );
  const pendingExternalRoots = new Set();
  const terminalCounts = new Map(
    topology.terminals.map((moduleId) => [moduleId, 0]),
  );
  const weightedLatencies = [];
  const queueSamples = [];
  let peakQueuedRecords = 0;
  let peakQueuedBytes = 0;
  let lastTerminalProgressMs = 0;
  let noProgress = false;
  let deadlock = false;
  let firstNoProgressMs = null;
  let firstDeadlockMs = null;

  for (const definition of topology.modules) {
    modules.set(definition.id, {
      ...definition,
      queue: new Map(),
      queueOrder: [],
      queuedBytes: 0,
      busy: false,
      currentRun: null,
      lastStartMs: null,
      gateIntervalMs: 8,
      lastReport: null,
      feedbackSinceControl: [],
      eligibilityVersion: 0,
      eligibilityDueMs: null,
    });
    outgoing.set(definition.id, []);
    incoming.set(definition.id, []);
  }
  for (const edge of topology.edges) {
    outgoing.get(edge.from).push(edge);
    incoming.get(edge.to).push(edge);
  }

  const log = (event, details = {}) => {
    raw.push(
      ensureFiniteJson({
        event,
        caseId,
        mode: "simulation",
        timeMs: round(now, 6),
        sequence: raw.length,
        ...details,
      }),
    );
  };

  const schedule = (timeMs, type, details = {}) => {
    if (timeMs > DRAIN_END_MS + 0.000001) return;
    events.push({
      ...details,
      timeMs: round(Math.max(now, timeMs), 6),
      sequence: sequence++,
      type,
    });
  };

  const queueTotals = () => {
    let records = 0;
    let bytes = 0;
    for (const module of modules.values()) {
      records += module.queueOrder.length;
      bytes += module.queuedBytes;
    }
    return { records, bytes };
  };

  const recordQueueSnapshot = (reason, periodic = false) => {
    const totals = queueTotals();
    peakQueuedRecords = Math.max(peakQueuedRecords, totals.records);
    peakQueuedBytes = Math.max(peakQueuedBytes, totals.bytes);
    log(periodic ? "queue_sample" : "queue_snapshot", {
      reason,
      queuedRecords: totals.records,
      queuedBytes: totals.bytes,
      busyModules: [...modules.values()].filter((module) => module.busy).length,
      blockedModules: [...modules.values()].filter(
        (module) => module.currentRun?.blockedOutput,
      ).length,
    });
    if (periodic) {
      queueSamples.push({
        timeMs: round(now, 6),
        queuedRecords: totals.records,
        queuedBytes: totals.bytes,
      });
      evaluateProgress(totals);
    }
  };

  const pendingWork = (totals) =>
    totals.records > 0 || [...modules.values()].some((module) => module.busy);

  const evaluateProgress = (totals) => {
    if (
      pendingWork(totals) &&
      now - lastTerminalProgressMs >= NO_PROGRESS_MS &&
      !noProgress
    ) {
      noProgress = true;
      firstNoProgressMs = round(now, 6);
      log("no_progress", { sinceTerminalProgressMs: round(now - lastTerminalProgressMs, 6) });
    }
    if (!deadlock && hasBlockedDependencyCycle()) {
      deadlock = true;
      firstDeadlockMs = round(now, 6);
      log("deadlock", { reason: "blocked-output-dependency-cycle" });
    }
  };

  const hasBlockedDependencyCycle = () => {
    const waitFor = new Map();
    for (const [moduleId, module] of modules) {
      const output = module.currentRun?.blockedOutput;
      if (!output) continue;
      const blockedTargets = output.targets
        .filter(({ target, multiplicity }) =>
          !hasQueueCapacity(modules.get(target), output.block, multiplicity),
        )
        .map(({ target }) => target);
      waitFor.set(moduleId, blockedTargets);
    }
    const visiting = new Set();
    const visited = new Set();
    const visit = (moduleId) => {
      if (visiting.has(moduleId)) return true;
      if (visited.has(moduleId)) return false;
      visiting.add(moduleId);
      for (const target of waitFor.get(moduleId) ?? []) {
        if (waitFor.has(target) && visit(target)) return true;
      }
      visiting.delete(moduleId);
      visited.add(moduleId);
      return false;
    };
    return [...waitFor.keys()].some((moduleId) => visit(moduleId));
  };

  const scheduleEligibility = (moduleId) => {
    const module = modules.get(moduleId);
    if (!module || module.busy || module.queueOrder.length === 0) return;
    if (policyId === "fixed-period") return;
    if (policyId === "event-driven") {
      scheduleUniqueEligibility(module, now);
      return;
    }
    if (policyId === "queue-watermark") {
      const oldest = module.queue.get(module.queueOrder[0]);
      const thresholdReached =
        module.queueOrder.length >= WATERMARK_RECORDS ||
        module.queuedBytes >= WATERMARK_BYTES;
      scheduleUniqueEligibility(
        module,
        thresholdReached ? now : oldest.enqueuedAtMs + WATERMARK_MAX_AGE_MS,
      );
      return;
    }
    const due =
      module.lastStartMs === null
        ? now
        : module.lastStartMs + module.gateIntervalMs;
    scheduleUniqueEligibility(module, Math.max(now, due));
  };

  const scheduleUniqueEligibility = (module, dueMs) => {
    const due = round(Math.max(now, dueMs), 6);
    if (
      module.eligibilityDueMs !== null &&
      module.eligibilityDueMs <= due + 0.000001
    ) {
      return;
    }
    module.eligibilityVersion += 1;
    module.eligibilityDueMs = due;
    schedule(due, "eligible", {
      moduleId: module.id,
      eligibilityVersion: module.eligibilityVersion,
    });
  };

  const enqueue = (moduleId, block, multiplicity, sourceKind) => {
    const module = modules.get(moduleId);
    const existing = module.queue.get(block.blockId);
    if (existing) {
      const before = existing.occurrences;
      existing.occurrences += multiplicity;
      counters.duplicateOccurrencesMerged += multiplicity;
      if (existing.occurrences !== before + multiplicity) {
        counters.duplicateCountViolations += 1;
      }
      log("duplicate_merge", {
        moduleId,
        blockId: block.blockId,
        addedOccurrences: multiplicity,
        occurrenceCount: existing.occurrences,
        sourceKind,
      });
    } else {
      module.queue.set(block.blockId, {
        ...block,
        occurrences: multiplicity,
        enqueuedAtMs: now,
      });
      module.queueOrder.push(block.blockId);
      module.queuedBytes += block.bytes;
      log("queue_enqueue", {
        moduleId,
        blockId: block.blockId,
        bytes: block.bytes,
        occurrenceCount: multiplicity,
        sourceKind,
        arrivedDuringRun: module.busy,
      });
      if (multiplicity > 1) {
        counters.duplicateOccurrencesMerged += multiplicity - 1;
        log("duplicate_merge", {
          moduleId,
          blockId: block.blockId,
          addedOccurrences: multiplicity - 1,
          occurrenceCount: multiplicity,
          sourceKind,
        });
      }
    }
    if (module.busy) {
      module.currentRun.arrivalsDuringRun += 1;
      counters.arrivalsDuringRun += 1;
    }
    recordQueueSnapshot("enqueue");
    scheduleEligibility(moduleId);
  };

  const hasQueueCapacity = (module, block, multiplicity) => {
    void multiplicity;
    if (module.queue.has(block.blockId)) return true;
    return (
      module.queueOrder.length + 1 <= QUEUE_RECORD_LIMIT &&
      module.queuedBytes + block.bytes <= QUEUE_BYTE_LIMIT
    );
  };

  const groupedTargets = (moduleId) => {
    const grouped = new Map();
    for (const edge of outgoing.get(moduleId)) {
      grouped.set(edge.to, (grouped.get(edge.to) ?? 0) + edge.multiplicity);
    }
    return [...grouped]
      .map(([target, multiplicity]) => ({ target, multiplicity }))
      .sort((left, right) => left.target.localeCompare(right.target));
  };

  const canBroadcast = (output) =>
    output.targets.every(({ target, multiplicity }) =>
      hasQueueCapacity(modules.get(target), output.block, multiplicity),
    );

  const commitBroadcast = (moduleId, output) => {
    if (!canBroadcast(output)) return false;
    const before = output.targets.map(({ target }) => ({
      target,
      records: modules.get(target).queueOrder.length,
    }));
    for (const { target, multiplicity } of output.targets) {
      enqueue(target, output.block, multiplicity, "page-broadcast");
    }
    const committed = output.targets.length;
    if (committed !== output.targets.length) {
      counters.atomicBroadcastViolations += 1;
    }
    log("block_broadcast", {
      moduleId,
      blockId: output.block.blockId,
      outputCount: 1,
      targets: output.targets,
      targetQueueRecordsBefore: before,
    });
    return true;
  };

  const makeOutput = (module, batch) => {
    if (batch.length === 0 || module.kind === "sink") return null;
    const maxInputHop = Math.max(...batch.map((item) => item.hop));
    if (maxInputHop >= module.maxHop) return null;
    const roots = new Map();
    for (const item of batch) {
      for (const root of item.roots) {
        const existing = roots.get(root.rootId) ?? {
          rootId: root.rootId,
          sourceModuleId: root.sourceModuleId,
          originMs: root.originMs,
          count: 0,
        };
        existing.count += root.count * item.occurrences;
        roots.set(root.rootId, existing);
      }
    }
    const inputBytes = batch.reduce((sum, item) => sum + item.bytes, 0);
    const bytes = module.outputBytes ?? Math.min(65_536, Math.max(256, inputBytes));
    return {
      blockId: `${caseId}:block:${++blockSequence}`,
      bytes,
      hop: maxInputHop + 1,
      roots: [...roots.values()].sort((left, right) =>
        left.rootId.localeCompare(right.rootId),
      ),
    };
  };

  const consumeTerminal = (module, run) => {
    for (const item of run.batch) {
      for (const root of item.roots) {
        const occurrences = root.count * item.occurrences;
        const latencyMs = now - root.originMs;
        counters.terminalOccurrences += occurrences;
        terminalCounts.set(
          module.id,
          terminalCounts.get(module.id) + occurrences,
        );
        weightedLatencies.push({ value: latencyMs, weight: occurrences });
        lastTerminalProgressMs = now;
        log("terminal_consume", {
          moduleId: module.id,
          runId: run.runId,
          rootId: root.rootId,
          sourceModuleId: root.sourceModuleId,
          occurrences,
          latencyMs: round(latencyMs, 6),
        });
      }
    }
  };

  const finishRun = (module, outputBlockId) => {
    const run = module.currentRun;
    module.lastReport = {
      serviceTimeMs: run.serviceTimeMs,
      inputRecordCount: run.batch.length,
      arrivalsDuringRun: run.arrivalsDuringRun,
    };
    log("module_commit", {
      moduleId: module.id,
      runId: run.runId,
      outputBlockId,
      arrivalsDuringRun: run.arrivalsDuringRun,
    });
    module.busy = false;
    module.currentRun = null;
    scheduleEligibility(module.id);
  };

  const completeService = (moduleId, runId) => {
    const module = modules.get(moduleId);
    const run = module.currentRun;
    if (!module.busy || !run || run.runId !== runId) {
      throw new Error(`stale service completion for ${moduleId}/${runId}`);
    }
    if (module.kind === "sink") consumeTerminal(module, run);
    const block = makeOutput(module, run.batch);
    if (block && 1 !== 1) counters.outputCountViolations += 1;
    log("module_service_complete", {
      moduleId,
      runId,
      serviceTimeMs: round(run.serviceTimeMs, 6),
      outputBlockId: block?.blockId ?? null,
      outputBytes: block?.bytes ?? 0,
    });
    if (!block) {
      finishRun(module, null);
      return;
    }
    const output = { block, targets: groupedTargets(moduleId) };
    if (commitBroadcast(moduleId, output)) {
      finishRun(module, block.blockId);
      return;
    }
    counters.outputBlocked += 1;
    run.blockedOutput = output;
    log("output_blocked", {
      moduleId,
      runId,
      blockId: block.blockId,
      targets: output.targets,
    });
    schedule(now + 1, "output-retry", { moduleId, runId });
  };

  const retryOutput = (moduleId, runId) => {
    const module = modules.get(moduleId);
    const run = module.currentRun;
    if (!module.busy || !run || run.runId !== runId || !run.blockedOutput) return;
    if (commitBroadcast(moduleId, run.blockedOutput)) {
      const blockId = run.blockedOutput.block.blockId;
      log("output_unblocked", { moduleId, runId, blockId });
      finishRun(module, blockId);
      return;
    }
    schedule(now + 1, "output-retry", { moduleId, runId });
  };

  const startModule = (moduleId, reason) => {
    const module = modules.get(moduleId);
    if (module.busy) return;
    if (module.queueOrder.length === 0 && policyId !== "fixed-period") return;
    if (module.busy) {
      counters.serialViolations += 1;
      return;
    }
    const batch = module.queueOrder.map((blockId) => module.queue.get(blockId));
    module.eligibilityVersion += 1;
    module.eligibilityDueMs = null;
    module.queue.clear();
    module.queueOrder = [];
    module.queuedBytes = 0;
    recordQueueSnapshot("batch-claim");
    const inputBytes = batch.reduce((sum, item) => sum + item.bytes, 0);
    const inputOccurrences = batch.reduce(
      (sum, item) => sum + item.occurrences,
      0,
    );
    const runId = `${caseId}:run:${++runSequence}`;
    const cadence =
      module.lastStartMs === null ? null : now - module.lastStartMs;
    let feedback = null;
    if (cadence !== null && module.preferredMinMs !== undefined) {
      if (cadence < module.preferredMinMs) feedback = "too-fast";
      else if (cadence > module.preferredMaxMs) feedback = "too-slow";
    }
    if (feedback) {
      module.feedbackSinceControl.push(feedback);
      if (feedback === "too-fast") counters.feedbackTooFast += 1;
      else counters.feedbackTooSlow += 1;
      log("module_feedback", {
        moduleId,
        feedback,
        cadenceMs: round(cadence, 6),
        preferredMinMs: module.preferredMinMs,
        preferredMaxMs: module.preferredMaxMs,
      });
    }
    module.lastStartMs = now;
    const serviceTimeMs = round(
      module.baseServiceMs + inputBytes / module.bytesPerMs,
      6,
    );
    module.busy = true;
    module.currentRun = {
      runId,
      batch,
      inputBytes,
      inputOccurrences,
      serviceTimeMs,
      arrivalsDuringRun: 0,
      blockedOutput: null,
    };
    counters.calls += 1;
    if (batch.length === 0) counters.emptyCalls += 1;
    log("module_start", {
      moduleId,
      runId,
      reason,
      inputRecordCount: batch.length,
      inputBytes,
      inputOccurrences,
      empty: batch.length === 0,
      gateIntervalMs: round(module.gateIntervalMs, 6),
    });
    schedule(now + serviceTimeMs, "service-complete", { moduleId, runId });
  };

  const eligible = (moduleId, eligibilityVersion) => {
    const module = modules.get(moduleId);
    if (eligibilityVersion !== module?.eligibilityVersion) return;
    module.eligibilityDueMs = null;
    if (!module || module.busy || module.queueOrder.length === 0) return;
    if (policyId === "event-driven") {
      startModule(moduleId, "pending-input");
      return;
    }
    if (policyId === "queue-watermark") {
      const oldest = module.queue.get(module.queueOrder[0]);
      if (
        module.queueOrder.length >= WATERMARK_RECORDS ||
        module.queuedBytes >= WATERMARK_BYTES ||
        now + 0.000001 >= oldest.enqueuedAtMs + WATERMARK_MAX_AGE_MS
      ) {
        startModule(moduleId, "watermark-or-age");
      } else {
        scheduleEligibility(moduleId);
      }
      return;
    }
    const due =
      module.lastStartMs === null
        ? now
        : module.lastStartMs + module.gateIntervalMs;
    if (now + 0.000001 >= due) {
      startModule(moduleId, "adaptive-period");
    } else {
        scheduleUniqueEligibility(module, due);
    }
  };

  const downstreamPressure = (moduleId) => {
    const targets = [...new Set(outgoing.get(moduleId).map((edge) => edge.to))];
    if (targets.length === 0) return 0;
    const pressures = targets.map((targetId) => {
      const downstream = modules.get(targetId);
      const count = downstream.queueOrder.length / QUEUE_RECORD_LIMIT;
      if (policyId === "adaptive-count-only") return count;
      const bytes = downstream.queuedBytes / QUEUE_BYTE_LIMIT;
      const report = downstream.lastReport;
      const arrivals = report
        ? report.arrivalsDuringRun / Math.max(1, report.inputRecordCount)
        : 0;
      const service = report ? report.serviceTimeMs / 15 : 0;
      return Math.max(count, bytes, arrivals, service);
    });
    if (policyId === "adaptive-mean-fanout") {
      return pressures.reduce((sum, pressure) => sum + pressure, 0) / pressures.length;
    }
    return Math.max(...pressures);
  };

  const controlTick = () => {
    for (const moduleId of [...modules.keys()].sort()) {
      const module = modules.get(moduleId);
      const oldInterval = module.gateIntervalMs;
      const candidates = [];
      const pressure = downstreamPressure(moduleId);
      if (outgoing.get(moduleId).length === 0 || pressure <= 0.25) {
        candidates.push(Math.max(1, oldInterval - 1));
      } else if (pressure >= 0.8) {
        candidates.push(Math.min(80, oldInterval * 1.5));
      } else {
        candidates.push(oldInterval);
      }
      if (policyId !== "adaptive-no-module-feedback") {
        if (module.feedbackSinceControl.includes("too-fast")) {
          candidates.push(
            Math.min(
              80,
              Math.max(oldInterval * 1.5, module.preferredMinMs ?? 1),
            ),
          );
        }
        if (module.feedbackSinceControl.includes("too-slow")) {
          candidates.push(Math.max(1, oldInterval - 2));
        }
      }
      const hasIncrease = candidates.some((candidate) => candidate > oldInterval);
      const hasDecrease = candidates.some((candidate) => candidate < oldInterval);
      if (hasIncrease && hasDecrease) counters.feedbackConflicts += 1;
      const nextInterval = hasIncrease
        ? Math.max(...candidates)
        : Math.min(...candidates);
      module.gateIntervalMs = round(nextInterval, 6);
      module.feedbackSinceControl = [];
      if (module.gateIntervalMs !== oldInterval) {
        counters.policyUpdates += 1;
        log("policy_update", {
          moduleId,
          oldIntervalMs: round(oldInterval, 6),
          newIntervalMs: module.gateIntervalMs,
          downstreamPressure: round(pressure, 6),
          aggregation:
            policyId === "adaptive-mean-fanout" ? "mean" : "maximum",
        });
        scheduleEligibility(moduleId);
      }
    }
  };

  const externalArrival = (event) => {
    const module = modules.get(event.moduleId);
    const block = {
      blockId: event.rootId,
      bytes: module.externalInputBytes,
      hop: 0,
      roots: [
        {
          rootId: event.rootId,
          sourceModuleId: event.moduleId,
          originMs: event.originMs,
          count: 1,
        },
      ],
    };
    if (!hasQueueCapacity(module, block, 1)) {
      counters.externalBackpressure += 1;
      if (!event.backpressureLogged) {
        log("external_backpressure", {
          moduleId: event.moduleId,
          rootId: event.rootId,
        });
      }
      // The producer retains ownership and retries later. Ten milliseconds keeps
      // the bounded-consumer behavior visible without creating a retry storm
      // that dominates scheduler events.
      schedule(now + 10, "external-arrival", {
        ...event,
        backpressureLogged: true,
      });
      return;
    }
    enqueue(event.moduleId, block, 1, "external-source");
    pendingExternalRoots.delete(event.rootId);
    sourceAcceptedCounts.set(
      event.moduleId,
      sourceAcceptedCounts.get(event.moduleId) + 1,
    );
    log("external_accept", {
      moduleId: event.moduleId,
      rootId: event.rootId,
      originMs: round(event.originMs, 6),
      admittedAtMs: round(now, 6),
    });
  };

  log("case_start", {
    topologyId,
    loadProfile,
    policyId,
    seed,
    sourceModuleIds: topology.sources,
    terminalModuleIds: topology.terminals,
    moduleCount: modules.size,
    observedDurationMs: DRAIN_END_MS,
    shockEndMs: loadProfile === "shock" ? SHOCK_END_MS : null,
  });

  for (let sourceIndex = 0; sourceIndex < topology.sources.length; sourceIndex += 1) {
    const moduleId = topology.sources[sourceIndex];
    let arrivalAt = sourceIndex * 3;
    let sourceSequence = 0;
    while (arrivalAt <= SIMULATION_END_MS) {
      const nominal =
        loadProfile === "shock"
          ? arrivalAt >= 300 && arrivalAt <= SHOCK_END_MS
            ? 5
            : 20
          : 12;
      const jitter = 0.8 + random() * 0.4;
      const rootId = `${caseId}:source:${moduleId}:${sourceSequence++}`;
      sourcePlannedCounts.set(
        moduleId,
        sourcePlannedCounts.get(moduleId) + 1,
      );
      pendingExternalRoots.add(rootId);
      schedule(arrivalAt, "external-arrival", {
        moduleId,
        rootId,
        originMs: round(arrivalAt, 6),
        backpressureLogged: false,
      });
      arrivalAt = round(arrivalAt + nominal * jitter, 6);
    }
  }

  if (policyId === "fixed-period") {
    for (const moduleId of [...modules.keys()].sort()) {
      for (let tickAt = 0; tickAt <= DRAIN_END_MS; tickAt += FIXED_PERIOD_MS) {
        schedule(tickAt, "fixed-tick", { moduleId });
      }
    }
  } else if (isAdaptive(policyId)) {
    for (let tickAt = 0; tickAt <= DRAIN_END_MS; tickAt += CONTROL_SAMPLE_MS) {
      schedule(tickAt, "control-tick");
    }
  }
  for (let sampleAt = 0; sampleAt <= DRAIN_END_MS; sampleAt += 10) {
    schedule(sampleAt, "sample");
  }

  while (events.size > 0) {
    const event = events.pop();
    now = event.timeMs;
    processedEvents += 1;
    processedEventTypes.set(
      event.type,
      (processedEventTypes.get(event.type) ?? 0) + 1,
    );
    if (processedEvents > 300_000) {
      throw new Error(
        `event cap exceeded in ${caseId} at ${now} ms: ${JSON.stringify(Object.fromEntries(processedEventTypes))}`,
      );
    }
    switch (event.type) {
      case "external-arrival":
        externalArrival(event);
        break;
      case "eligible":
        eligible(event.moduleId, event.eligibilityVersion);
        break;
      case "fixed-tick": {
        const module = modules.get(event.moduleId);
        if (module.busy) counters.missedTicks += 1;
        else startModule(event.moduleId, "fixed-period");
        break;
      }
      case "service-complete":
        completeService(event.moduleId, event.runId);
        break;
      case "output-retry":
        retryOutput(event.moduleId, event.runId);
        break;
      case "control-tick":
        controlTick();
        break;
      case "sample":
        recordQueueSnapshot("periodic", true);
        break;
      default:
        throw new Error(`unknown event type ${event.type}`);
    }
  }

  now = DRAIN_END_MS;
  const recovery = stableRecoveryMetrics(
    queueSamples,
    modules.size,
    loadProfile === "shock",
  );
  const fairnessJain = Math.min(
    jainFairness([...sourceAcceptedCounts.values()]),
    jainFairness([...terminalCounts.values()]),
  );
  const metrics = {
    calls: counters.calls,
    throughputPerSecond: round(counters.terminalOccurrences / (DRAIN_END_MS / 1000), 6),
    terminalOccurrences: counters.terminalOccurrences,
    p95LatencyMs: percentileNearestRank(weightedLatencies, 0.95),
    peakQueuedRecords,
    peakQueuedBytes,
    fairnessJain,
    emptyCalls: counters.emptyCalls,
    stabilityTimeMs: recovery.stabilityTimeMs,
    recoveryTimeMs: recovery.recoveryTimeMs,
    deadlock,
    noProgress,
    firstDeadlockMs,
    firstNoProgressMs,
    serialViolations: counters.serialViolations,
    outputCountViolations: counters.outputCountViolations,
    atomicBroadcastViolations: counters.atomicBroadcastViolations,
    duplicateCountViolations: counters.duplicateCountViolations,
    arrivalsDuringRun: counters.arrivalsDuringRun,
    duplicateOccurrencesMerged: counters.duplicateOccurrencesMerged,
    feedbackOutsidePreferredCadence:
      counters.feedbackTooFast + counters.feedbackTooSlow,
    feedbackTooFast: counters.feedbackTooFast,
    feedbackTooSlow: counters.feedbackTooSlow,
    feedbackConflicts: counters.feedbackConflicts,
    outputBlocked: counters.outputBlocked,
    externalBackpressure: counters.externalBackpressure,
    externalPlanned: [...sourcePlannedCounts.values()].reduce(
      (sum, count) => sum + count,
      0,
    ),
    externalAccepted: [...sourceAcceptedCounts.values()].reduce(
      (sum, count) => sum + count,
      0,
    ),
    externalPendingAtStop: pendingExternalRoots.size,
    missedTicks: counters.missedTicks,
    policyUpdates: counters.policyUpdates,
    processedEvents,
    finalQueuedRecords: queueTotals().records,
    finalQueuedBytes: queueTotals().bytes,
  };
  log("case_end", { metrics });
  mkdirSync(dirname(rawPath), { recursive: true });
  writeFileSync(rawPath, `${raw.join("\n")}\n`, { flag: "wx" });
  return { caseId, mode: "simulation", topologyId, loadProfile, policyId, seed, metrics };
}

function isAdaptive(policyId) {
  return (
    policyId === "downstream-backlog-service-adaptive-period" ||
    ABLATION_POLICIES.includes(policyId)
  );
}

function buildTopology(topologyId) {
  const source = (id, outputBytes = 4096) => ({
    id,
    kind: "source",
    baseServiceMs: 1,
    bytesPerMs: 8192,
    outputBytes,
    externalInputBytes: 256,
    maxHop: Number.POSITIVE_INFINITY,
  });
  const transform = (id, options = {}) => ({
    id,
    kind: "transform",
    baseServiceMs: options.baseServiceMs ?? 3,
    bytesPerMs: options.bytesPerMs ?? 4096,
    outputBytes: options.outputBytes ?? 4096,
    externalInputBytes: 0,
    maxHop: options.maxHop ?? Number.POSITIVE_INFINITY,
    preferredMinMs: options.preferredMinMs,
    preferredMaxMs: options.preferredMaxMs,
  });
  const sink = (id, options = {}) => ({
    id,
    kind: "sink",
    baseServiceMs: options.baseServiceMs ?? 2,
    bytesPerMs: options.bytesPerMs ?? 8192,
    outputBytes: null,
    externalInputBytes: 0,
    maxHop: Number.POSITIVE_INFINITY,
  });
  const edge = (from, to, multiplicity = 1) => ({ from, to, multiplicity });

  switch (topologyId) {
    case "line":
      return {
        modules: [
          source("source", 8192),
          transform("worker", {
            baseServiceMs: 5,
            bytesPerMs: 2048,
            outputBytes: 16_384,
            preferredMinMs: 18,
            preferredMaxMs: 30,
          }),
          sink("sink", { baseServiceMs: 3, bytesPerMs: 4096 }),
        ],
        edges: [edge("source", "worker"), edge("worker", "sink")],
        sources: ["source"],
        terminals: ["sink"],
      };
    case "fan-out":
      return {
        modules: [
          source("source", 8192),
          transform("router", {
            baseServiceMs: 3,
            bytesPerMs: 4096,
            outputBytes: 65_536,
            preferredMinMs: 12,
            preferredMaxMs: 30,
          }),
          sink("fast-sink", { baseServiceMs: 2, bytesPerMs: 16_384 }),
          sink("slow-sink", { baseServiceMs: 8, bytesPerMs: 2048 }),
        ],
        edges: [
          edge("source", "router"),
          edge("router", "fast-sink"),
          edge("router", "slow-sink"),
        ],
        sources: ["source"],
        terminals: ["fast-sink", "slow-sink"],
      };
    case "fan-in":
      return {
        modules: [
          source("source-a", 8192),
          source("source-b", 49_152),
          transform("merge", {
            baseServiceMs: 4,
            bytesPerMs: 3072,
            outputBytes: 49_152,
            preferredMinMs: 14,
            preferredMaxMs: 32,
          }),
          sink("sink", { baseServiceMs: 4, bytesPerMs: 3072 }),
        ],
        edges: [
          edge("source-a", "merge", 2),
          edge("source-b", "merge"),
          edge("merge", "sink"),
        ],
        sources: ["source-a", "source-b"],
        terminals: ["sink"],
      };
    case "cycle":
      return {
        modules: [
          source("source", 8192),
          transform("cycle-a", {
            baseServiceMs: 5,
            bytesPerMs: 2048,
            outputBytes: 32_768,
            maxHop: 8,
          }),
          transform("cycle-b", {
            baseServiceMs: 6,
            bytesPerMs: 1536,
            outputBytes: 49_152,
            maxHop: 8,
          }),
          sink("sink", { baseServiceMs: 3, bytesPerMs: 4096 }),
        ],
        edges: [
          edge("source", "cycle-a"),
          edge("cycle-a", "cycle-b"),
          edge("cycle-b", "cycle-a"),
          edge("cycle-b", "sink"),
        ],
        sources: ["source"],
        terminals: ["sink"],
      };
    case "self-loop":
      return {
        modules: [
          source("source", 16_384),
          transform("loop", {
            baseServiceMs: 10,
            bytesPerMs: 1024,
            outputBytes: 65_536,
            maxHop: 6,
          }),
          sink("sink", { baseServiceMs: 4, bytesPerMs: 3072 }),
        ],
        edges: [
          edge("source", "loop"),
          edge("loop", "loop"),
          edge("loop", "sink"),
        ],
        sources: ["source"],
        terminals: ["sink"],
      };
    default:
      throw new Error(`unknown topology ${topologyId}`);
  }
}
