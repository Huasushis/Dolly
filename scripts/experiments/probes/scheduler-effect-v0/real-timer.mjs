import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

import {
  createRandom,
  ensureFiniteJson,
  percentileNearestRank,
  round,
} from "./common.mjs";

const ARRIVAL_END_MS = 500;
const OBSERVATION_END_MS = 800;
const FIXED_PERIOD_MS = 20;
const WATERMARK_RECORDS = 4;
const WATERMARK_MAX_AGE_MS = 35;
const CONTROL_SAMPLE_MS = 10;

export async function runRealTimerCase({
  loadProfile,
  policyId,
  seed,
  repetition,
  rawPath,
}) {
  const caseId = `real-timer__line__${loadProfile}__${policyId}__rep-${repetition}`;
  const random = createRandom(seed);
  const raw = [];
  const timers = new Set();
  const modules = new Map([
    ["source", moduleState("source", 1, undefined, undefined)],
    ["worker", moduleState("worker", 5, 18, 30)],
    ["sink", moduleState("sink", 3, undefined, undefined)],
  ]);
  const downstream = new Map([
    ["source", "worker"],
    ["worker", "sink"],
    ["sink", null],
  ]);
  const timerSlips = [];
  const latencies = [];
  const counters = {
    calls: 0,
    emptyCalls: 0,
    serialViolations: 0,
    arrivalsDuringRun: 0,
    feedbackTooFast: 0,
    feedbackTooSlow: 0,
    policyUpdates: 0,
    arrivalsPlanned: 0,
    arrivalsAccepted: 0,
    terminalOccurrences: 0,
  };
  let eventSequence = 0;
  let blockSequence = 0;
  let stopped = false;
  let peakQueuedRecords = 0;
  const startTime = performance.now();
  const elapsed = () => performance.now() - startTime;
  const log = (event, details = {}) => {
    raw.push(
      ensureFiniteJson({
        event,
        caseId,
        mode: "real-timer",
        timeMs: round(elapsed(), 6),
        sequence: eventSequence++,
        ...details,
      }),
    );
  };
  const recordQueuePeak = () => {
    const queuedRecords = [...modules.values()].reduce(
      (sum, module) => sum + module.queue.length,
      0,
    );
    peakQueuedRecords = Math.max(peakQueuedRecords, queuedRecords);
    log("queue_snapshot", { queuedRecords });
  };
  const scheduleAt = (dueMs, timerKind, callback) => {
    if (stopped) return;
    const handle = setTimeout(() => {
      timers.delete(handle);
      if (stopped && timerKind !== "service") return;
      const actualMs = elapsed();
      const slipMs = Math.max(0, actualMs - dueMs);
      timerSlips.push({ value: slipMs, weight: 1 });
      log("timer_fire", {
        timerKind,
        dueMs: round(dueMs, 6),
        actualMs: round(actualMs, 6),
        slipMs: round(slipMs, 6),
      });
      callback();
    }, Math.max(0, dueMs - elapsed()));
    timers.add(handle);
  };

  const scheduleEligibility = (moduleId) => {
    if (stopped || policyId === "fixed-period") return;
    const module = modules.get(moduleId);
    if (module.busy || module.queue.length === 0) return;
    let dueMs = elapsed();
    if (policyId === "queue-watermark" && module.queue.length < WATERMARK_RECORDS) {
      dueMs = Math.max(dueMs, module.queue[0].enqueuedAtMs + WATERMARK_MAX_AGE_MS);
    } else if (isAdaptive(policyId) && module.lastStartMs !== null) {
      dueMs = Math.max(dueMs, module.lastStartMs + module.gateIntervalMs);
    }
    if (module.eligibilityDueMs !== null && module.eligibilityDueMs <= dueMs) {
      return;
    }
    module.eligibilityVersion += 1;
    module.eligibilityDueMs = dueMs;
    const version = module.eligibilityVersion;
    scheduleAt(dueMs, "eligibility", () => {
      if (version !== module.eligibilityVersion) return;
      module.eligibilityDueMs = null;
      if (module.busy || module.queue.length === 0) return;
      if (
        policyId === "queue-watermark" &&
        module.queue.length < WATERMARK_RECORDS &&
        elapsed() + 0.05 < module.queue[0].enqueuedAtMs + WATERMARK_MAX_AGE_MS
      ) {
        scheduleEligibility(moduleId);
        return;
      }
      startModule(moduleId, policyId);
    });
  };

  const enqueue = (moduleId, block) => {
    const module = modules.get(moduleId);
    module.queue.push({ ...block, enqueuedAtMs: elapsed() });
    if (module.busy) {
      module.arrivalsDuringCurrentRun += 1;
      counters.arrivalsDuringRun += 1;
    }
    log("queue_enqueue", { moduleId, blockId: block.blockId });
    recordQueuePeak();
    scheduleEligibility(moduleId);
  };

  const startModule = (moduleId, reason) => {
    const module = modules.get(moduleId);
    if (module.busy) {
      counters.serialViolations += 1;
      return;
    }
    if (module.queue.length === 0 && policyId !== "fixed-period") return;
    const batch = module.queue;
    module.queue = [];
    module.eligibilityVersion += 1;
    module.eligibilityDueMs = null;
    recordQueuePeak();
    const nowMs = elapsed();
    const cadenceMs = module.lastStartMs === null ? null : nowMs - module.lastStartMs;
    if (cadenceMs !== null && module.preferredMinMs !== undefined) {
      if (cadenceMs < module.preferredMinMs) {
        module.feedbackSinceControl.push("too-fast");
        counters.feedbackTooFast += 1;
      } else if (cadenceMs > module.preferredMaxMs) {
        module.feedbackSinceControl.push("too-slow");
        counters.feedbackTooSlow += 1;
      }
    }
    module.lastStartMs = nowMs;
    module.busy = true;
    module.arrivalsDuringCurrentRun = 0;
    counters.calls += 1;
    if (batch.length === 0) counters.emptyCalls += 1;
    log("module_start", {
      moduleId,
      reason,
      inputRecordCount: batch.length,
      gateIntervalMs: round(module.gateIntervalMs, 6),
    });
    const dueMs = nowMs + module.serviceTimeMs;
    scheduleAt(dueMs, "service", () => {
      if (moduleId === "sink") {
        for (const block of batch) {
          for (const root of block.roots) {
            const latencyMs = elapsed() - root.originMs;
            latencies.push({ value: latencyMs, weight: root.count });
            counters.terminalOccurrences += root.count;
            log("terminal_consume", {
              moduleId,
              rootId: root.rootId,
              occurrences: root.count,
              latencyMs: round(latencyMs, 6),
            });
          }
        }
      } else if (batch.length > 0) {
        const roots = batch.flatMap((block) => block.roots);
        enqueue(downstream.get(moduleId), {
          blockId: `${caseId}:block:${++blockSequence}`,
          roots,
        });
      }
      module.lastServiceTimeMs = module.serviceTimeMs;
      module.busy = false;
      log("module_commit", {
        moduleId,
        arrivalsDuringRun: module.arrivalsDuringCurrentRun,
      });
      module.arrivalsDuringCurrentRun = 0;
      scheduleEligibility(moduleId);
    });
  };

  const controlTick = () => {
    for (const [moduleId, module] of modules) {
      const targetId = downstream.get(moduleId);
      const target = targetId === null ? null : modules.get(targetId);
      const countPressure = target ? target.queue.length / 12 : 0;
      const servicePressure = target ? target.lastServiceTimeMs / 15 : 0;
      const pressure =
        policyId === "adaptive-count-only"
          ? countPressure
          : Math.max(countPressure, servicePressure);
      const oldIntervalMs = module.gateIntervalMs;
      const candidates = [
        pressure >= 0.8
          ? Math.min(80, oldIntervalMs * 1.5)
          : pressure <= 0.25
            ? Math.max(1, oldIntervalMs - 1)
            : oldIntervalMs,
      ];
      if (policyId !== "adaptive-no-module-feedback") {
        if (module.feedbackSinceControl.includes("too-fast")) {
          candidates.push(
            Math.min(
              80,
              Math.max(oldIntervalMs * 1.5, module.preferredMinMs ?? 1),
            ),
          );
        }
        if (module.feedbackSinceControl.includes("too-slow")) {
          candidates.push(Math.max(1, oldIntervalMs - 2));
        }
      }
      const nextIntervalMs = candidates.some(
        (candidate) => candidate > oldIntervalMs,
      )
        ? Math.max(...candidates)
        : Math.min(...candidates);
      module.feedbackSinceControl = [];
      if (nextIntervalMs !== oldIntervalMs) {
        module.gateIntervalMs = nextIntervalMs;
        counters.policyUpdates += 1;
        log("policy_update", {
          moduleId,
          oldIntervalMs: round(oldIntervalMs, 6),
          newIntervalMs: round(nextIntervalMs, 6),
        });
        scheduleEligibility(moduleId);
      }
    }
  };

  log("case_start", { loadProfile, policyId, seed, repetition });
  let arrivalAtMs = 0;
  let sourceSequence = 0;
  while (arrivalAtMs <= ARRIVAL_END_MS) {
    const nominalMs =
      loadProfile === "shock"
        ? arrivalAtMs >= 125 && arrivalAtMs <= 325
          ? 5
          : 20
        : 12;
    const rootId = `${caseId}:source:${sourceSequence++}`;
    counters.arrivalsPlanned += 1;
    const dueMs = arrivalAtMs;
    log("external_arrival_planned", {
      rootId,
      dueMs: round(dueMs, 6),
    });
    scheduleAt(dueMs, "external-arrival", () => {
      counters.arrivalsAccepted += 1;
      log("external_accept", { rootId });
      enqueue("source", {
        blockId: rootId,
        roots: [{ rootId, originMs: dueMs, count: 1 }],
      });
    });
    arrivalAtMs += nominalMs * (0.8 + random() * 0.4);
  }
  if (policyId === "fixed-period") {
    for (const moduleId of modules.keys()) {
      for (let dueMs = 0; dueMs <= OBSERVATION_END_MS; dueMs += FIXED_PERIOD_MS) {
        scheduleAt(dueMs, "fixed-period", () => startModule(moduleId, "fixed-period"));
      }
    }
  }
  if (isAdaptive(policyId)) {
    for (let dueMs = 0; dueMs <= OBSERVATION_END_MS; dueMs += CONTROL_SAMPLE_MS) {
      scheduleAt(dueMs, "control", controlTick);
    }
  }

  await new Promise((resolveStop) => setTimeout(resolveStop, OBSERVATION_END_MS));
  stopped = true;
  // Do not start more work after the frozen 800 ms observation boundary. Give
  // a call that was already in flight one bounded service window to commit.
  await new Promise((resolveDrain) => setTimeout(resolveDrain, 20));
  for (const handle of timers) clearTimeout(handle);
  timers.clear();
  const metrics = {
    calls: counters.calls,
    emptyCalls: counters.emptyCalls,
    throughputPerSecond: round(
      counters.terminalOccurrences / (OBSERVATION_END_MS / 1000),
      6,
    ),
    terminalOccurrences: counters.terminalOccurrences,
    p95LatencyMs: percentileNearestRank(latencies, 0.95),
    peakQueuedRecords,
    serialViolations: counters.serialViolations,
    arrivalsDuringRun: counters.arrivalsDuringRun,
    feedbackOutsidePreferredCadence:
      counters.feedbackTooFast + counters.feedbackTooSlow,
    policyUpdates: counters.policyUpdates,
    arrivalsPlanned: counters.arrivalsPlanned,
    arrivalsAccepted: counters.arrivalsAccepted,
    finalQueuedRecords: [...modules.values()].reduce(
      (sum, module) => sum + module.queue.length,
      0,
    ),
    busyModulesAtStop: [...modules.values()].filter((module) => module.busy).length,
    timerSamples: timerSlips.length,
    p95TimerSlipMs: percentileNearestRank(timerSlips, 0.95),
    maxTimerSlipMs: round(
      Math.max(0, ...timerSlips.map((sample) => sample.value)),
      6,
    ),
  };
  log("case_end", { metrics });
  mkdirSync(dirname(rawPath), { recursive: true });
  writeFileSync(rawPath, `${raw.join("\n")}\n`, { flag: "wx" });
  return {
    caseId,
    mode: "real-timer",
    loadProfile,
    policyId,
    seed,
    repetition,
    metrics,
  };
}

function moduleState(id, serviceTimeMs, preferredMinMs, preferredMaxMs) {
  return {
    id,
    serviceTimeMs,
    preferredMinMs,
    preferredMaxMs,
    queue: [],
    busy: false,
    arrivalsDuringCurrentRun: 0,
    lastStartMs: null,
    lastServiceTimeMs: 0,
    gateIntervalMs: 8,
    feedbackSinceControl: [],
    eligibilityVersion: 0,
    eligibilityDueMs: null,
  };
}

function isAdaptive(policyId) {
  return [
    "downstream-backlog-service-adaptive-period",
    "adaptive-count-only",
    "adaptive-mean-fanout",
    "adaptive-no-module-feedback",
  ].includes(policyId);
}
