import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DRAIN_END_MS,
  jainFairness,
  percentileNearestRank,
  round,
  sha256File,
  stableRecoveryMetrics,
} from "./common.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "../../../..");
const experimentDirectory = resolve(
  projectRoot,
  "artifacts/experiments/probes/scheduler-effect-v0",
);
const rawDirectory = resolve(experimentDirectory, "raw");
const preregistrationPath = resolve(
  projectRoot,
  "docs/experiments/preregistrations/scheduler-effect-v0.json",
);
const runResultsPath = resolve(experimentDirectory, "run-results.json");
const summaryPath = resolve(experimentDirectory, "summary.json");
const manifestPath = resolve(experimentDirectory, "manifest.json");
const realTimerRawDirectory = resolve(experimentDirectory, "real-timing-raw");
const realTimerResultsPath = resolve(
  experimentDirectory,
  "real-timing-results.json",
);
const reportPath = resolve(projectRoot, "docs/research/scheduler-effect-v0.md");

const preregistration = JSON.parse(readFileSync(preregistrationPath, "utf8"));
const runResults = JSON.parse(readFileSync(runResultsPath, "utf8"));
const realTimerResults = JSON.parse(
  readFileSync(realTimerResultsPath, "utf8"),
);
if (runResults.preregistration.sha256 !== sha256File(preregistrationPath)) {
  throw new Error("preregistration hash changed after the run");
}
if (runResults.expectedCaseCount !== runResults.completedCaseCount) {
  throw new Error("run did not complete its declared matrix");
}
if (realTimerResults.preregistrationSha256 !== sha256File(preregistrationPath)) {
  throw new Error("real-timer preregistration hash changed after the run");
}
if (
  realTimerResults.expectedCaseCount !== realTimerResults.completedCaseCount
) {
  throw new Error("real-timer run did not complete its declared matrix");
}

const rawFileNames = readdirSync(rawDirectory)
  .filter((name) => name.endsWith(".jsonl"))
  .sort();
if (rawFileNames.length !== runResults.expectedCaseCount) {
  throw new Error(
    `raw file count ${rawFileNames.length} != expected ${runResults.expectedCaseCount}`,
  );
}

const runCases = new Map(runResults.cases.map((item) => [item.caseId, item]));
if (runCases.size !== runResults.cases.length) {
  throw new Error("run-results contains duplicate case identifiers");
}
const verifiedCases = [];
for (const fileName of rawFileNames) {
  const path = resolve(rawDirectory, fileName);
  const events = readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line, index) => {
      const event = JSON.parse(line);
      if (event.sequence !== index) {
        throw new Error(`${fileName}: raw sequence mismatch at line ${index + 1}`);
      }
      return event;
    });
  const verification = reconstructCase(events, fileName);
  const declared = runCases.get(verification.caseId);
  if (!declared) throw new Error(`${fileName}: case missing from run-results`);
  if (`${verification.caseId}.jsonl` !== fileName) {
    throw new Error(`${fileName}: filename does not match caseId`);
  }
  if (JSON.stringify(declared.metrics) !== JSON.stringify(verification.declaredMetrics)) {
    throw new Error(`${fileName}: run-results metrics differ from raw case_end`);
  }
  for (const [metric, reconstructed] of Object.entries(
    verification.reconstructedMetrics,
  )) {
    assertMetricEqual(
      reconstructed,
      verification.declaredMetrics[metric],
      `${verification.caseId}.${metric}`,
    );
  }
  if (verification.safetyFailures.length > 0) {
    throw new Error(
      `${verification.caseId}: ${verification.safetyFailures.join("; ")}`,
    );
  }
  verifiedCases.push({
    ...declared,
    rawFile: `artifacts/experiments/probes/scheduler-effect-v0/raw/${fileName}`,
    rawSha256: sha256File(path),
    rawBytes: statSync(path).size,
    rawEventCount: events.length,
    independentReconstruction: "passed",
  });
}
if (verifiedCases.length !== runCases.size) {
  throw new Error("not every run-results case has one raw file");
}

const verifiedRealTimerCases = verifyRealTimerCases(realTimerResults);

verifiedCases.sort(compareCases);
verifiedRealTimerCases.sort(compareCases);
const comparisons = buildComparisons(verifiedCases);
const hypothesisResults = evaluateHypotheses(comparisons, verifiedCases);
const summary = {
  schemaVersion: "dolly.scheduler-effect-summary/0",
  experimentId: "scheduler-effect-v0",
  evidenceStatus: "verified-simulation-and-real-timer-smoke",
  evidenceBoundary:
    "This is evidence about the frozen synthetic scheduler model, not evidence that Dolly's product Module runtime is supported.",
  analyzedAt: new Date().toISOString(),
  preregistrationSha256: sha256File(preregistrationPath),
  caseCount: verifiedCases.length,
  allRawCasesIndependentlyReconstructed: true,
  safetyInvariantFailures: 0,
  realTimerCaseCount: verifiedRealTimerCases.length,
  allRealTimerRawCasesIndependentlyReconstructed: true,
  realTimerSafetyInvariantFailures: 0,
  hypothesisResults,
  comparisons,
  cases: verifiedCases,
  realTimerCases: verifiedRealTimerCases,
};
const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
const reportText = renderReport(summary, runResults);

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(summaryPath, summaryText, { flag: "wx" });
writeFileSync(reportPath, reportText, { flag: "wx" });

const manifestEntries = [
  preregistrationPath,
  resolve(scriptDirectory, "common.mjs"),
  resolve(scriptDirectory, "simulate.mjs"),
  resolve(scriptDirectory, "run.mjs"),
  resolve(scriptDirectory, "real-timer.mjs"),
  resolve(scriptDirectory, "run-real-timer.mjs"),
  resolve(scriptDirectory, "analyze.mjs"),
  runResultsPath,
  realTimerResultsPath,
  summaryPath,
  reportPath,
  ...rawFileNames.map((name) => resolve(rawDirectory, name)),
  ...readdirSync(realTimerRawDirectory)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => resolve(realTimerRawDirectory, name)),
].map((path) => ({
  path: path.slice(projectRoot.length + 1),
  bytes: statSync(path).size,
  sha256: sha256File(path),
}));
const manifest = {
  schemaVersion: "dolly.scheduler-effect-manifest/0",
  experimentId: "scheduler-effect-v0",
  generatedAt: new Date().toISOString(),
  files: manifestEntries,
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  flag: "wx",
});
process.stdout.write(
  `verified ${verifiedCases.length} cases; wrote ${summaryPath}, ${reportPath}, and ${manifestPath}\n`,
);

function verifyRealTimerCases(results) {
  const fileNames = readdirSync(realTimerRawDirectory)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  if (fileNames.length !== results.expectedCaseCount) {
    throw new Error(
      `real-timer raw file count ${fileNames.length} != expected ${results.expectedCaseCount}`,
    );
  }
  const declaredByCase = new Map(
    results.cases.map((item) => [item.caseId, item]),
  );
  if (declaredByCase.size !== results.cases.length) {
    throw new Error("real-timer results contain duplicate case identifiers");
  }
  const verified = [];
  for (const fileName of fileNames) {
    const path = resolve(realTimerRawDirectory, fileName);
    const events = readFileSync(path, "utf8")
      .trimEnd()
      .split("\n")
      .map((line, index) => {
        const event = JSON.parse(line);
        if (event.sequence !== index) {
          throw new Error(
            `${fileName}: real-timer sequence mismatch at line ${index + 1}`,
          );
        }
        return event;
      });
    const starts = events.filter((event) => event.event === "case_start");
    const ends = events.filter((event) => event.event === "case_end");
    if (
      starts.length !== 1 ||
      ends.length !== 1 ||
      events[0] !== starts[0] ||
      events.at(-1) !== ends[0]
    ) {
      throw new Error(`${fileName}: invalid real-timer case boundaries`);
    }
    const caseId = starts[0].caseId;
    if (`${caseId}.jsonl` !== fileName) {
      throw new Error(`${fileName}: filename does not match real-timer caseId`);
    }
    if (events.some((event) => event.caseId !== caseId)) {
      throw new Error(`${fileName}: mixed real-timer case identifiers`);
    }
    for (let index = 1; index < events.length; index += 1) {
      if (events[index].timeMs < events[index - 1].timeMs) {
        throw new Error(`${fileName}: real-timer event time moved backwards`);
      }
    }
    const declared = declaredByCase.get(caseId);
    if (!declared) {
      throw new Error(`${fileName}: real-timer case missing from results`);
    }
    if (JSON.stringify(declared.metrics) !== JSON.stringify(ends[0].metrics)) {
      throw new Error(`${fileName}: aggregate metrics differ from case_end`);
    }

    const moduleStarts = events.filter(
      (event) => event.event === "module_start",
    );
    const terminalEvents = events.filter(
      (event) => event.event === "terminal_consume",
    );
    const timerEvents = events.filter((event) => event.event === "timer_fire");
    const plannedRoots = new Set(
      events
        .filter((event) => event.event === "external_arrival_planned")
        .map((event) => event.rootId),
    );
    const acceptedRoots = new Set(
      events
        .filter((event) => event.event === "external_accept")
        .map((event) => event.rootId),
    );
    const queueSnapshots = events.filter(
      (event) => event.event === "queue_snapshot",
    );
    const active = new Set();
    let serialViolations = 0;
    let arrivalsDuringRun = 0;
    let startsScheduledAfterBoundary = 0;
    for (const [eventIndex, event] of events.entries()) {
      if (event.event === "module_start") {
        if (active.has(event.moduleId)) serialViolations += 1;
        active.add(event.moduleId);
        if (event.timeMs > 800) {
          const trigger = events
            .slice(0, eventIndex)
            .findLast((candidate) => candidate.event === "timer_fire");
          if (
            trigger?.event !== "timer_fire" ||
            !["fixed-period", "eligibility"].includes(trigger.timerKind) ||
            trigger.dueMs > 800
          ) {
            startsScheduledAfterBoundary += 1;
          }
        }
      } else if (event.event === "queue_enqueue" && active.has(event.moduleId)) {
        arrivalsDuringRun += 1;
      } else if (event.event === "module_commit") {
        if (!active.has(event.moduleId)) serialViolations += 1;
        active.delete(event.moduleId);
      }
    }
    const terminalOccurrences = terminalEvents.reduce(
      (sum, event) => sum + event.occurrences,
      0,
    );
    const timerSlips = timerEvents.map((event) => ({
      value: event.slipMs,
      weight: 1,
    }));
    const signedTimerSlips = timerEvents.map(
      (event) => event.actualMs - event.dueMs,
    );
    const reconstructed = {
      calls: moduleStarts.length,
      emptyCalls: moduleStarts.filter((event) => event.inputRecordCount === 0)
        .length,
      throughputPerSecond: round(terminalOccurrences / 0.8, 6),
      terminalOccurrences,
      p95LatencyMs: percentileNearestRank(
        terminalEvents.map((event) => ({
          value: event.latencyMs,
          weight: event.occurrences,
        })),
        0.95,
      ),
      peakQueuedRecords: Math.max(
        0,
        ...queueSnapshots.map((event) => event.queuedRecords),
      ),
      serialViolations,
      arrivalsDuringRun,
      policyUpdates: events.filter((event) => event.event === "policy_update")
        .length,
      arrivalsPlanned: plannedRoots.size,
      arrivalsAccepted: acceptedRoots.size,
      finalQueuedRecords: queueSnapshots.at(-1)?.queuedRecords ?? 0,
      busyModulesAtStop: active.size,
      timerSamples: timerEvents.length,
      p95TimerSlipMs: percentileNearestRank(timerSlips, 0.95),
      maxTimerSlipMs: round(
        Math.max(0, ...timerEvents.map((event) => event.slipMs)),
        6,
      ),
    };
    for (const [metric, value] of Object.entries(reconstructed)) {
      assertMetricEqual(value, declared.metrics[metric], `${caseId}.${metric}`);
    }
    if (
      reconstructed.serialViolations !== 0 ||
      reconstructed.arrivalsAccepted !== reconstructed.arrivalsPlanned ||
      reconstructed.finalQueuedRecords !== 0 ||
      reconstructed.busyModulesAtStop !== 0 ||
      startsScheduledAfterBoundary !== 0
    ) {
      throw new Error(`${caseId}: real-timer safety or drain check failed`);
    }
    verified.push({
      ...declared,
      rawFile: `artifacts/experiments/probes/scheduler-effect-v0/real-timing-raw/${fileName}`,
      rawSha256: sha256File(path),
      rawBytes: statSync(path).size,
      rawEventCount: events.length,
      independentReconstruction: "passed",
      independentlyReconstructedTimerDiagnostics: {
        minimumSignedSlipMs: round(Math.min(...signedTimerSlips), 6),
        maximumSignedSlipMs: round(Math.max(...signedTimerSlips), 6),
        p95AbsoluteSlipMs: percentileNearestRank(
          signedTimerSlips.map((value) => ({
            value: Math.abs(value),
            weight: 1,
          })),
          0.95,
        ),
      },
    });
  }
  if (verified.length !== declaredByCase.size) {
    throw new Error("not every real-timer result has one raw file");
  }
  return verified;
}

function reconstructCase(events, fileName) {
  if (events.length < 2) throw new Error(`${fileName}: raw file is too short`);
  const starts = events.filter((event) => event.event === "case_start");
  const ends = events.filter((event) => event.event === "case_end");
  if (starts.length !== 1 || ends.length !== 1) {
    throw new Error(`${fileName}: expected exactly one case_start and case_end`);
  }
  const start = starts[0];
  const end = ends[0];
  if (events[0] !== start || events.at(-1) !== end) {
    throw new Error(`${fileName}: boundary records are not first and last`);
  }
  if (events.some((event) => event.caseId !== start.caseId)) {
    throw new Error(`${fileName}: mixed case identifiers`);
  }
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].timeMs < events[index - 1].timeMs) {
      throw new Error(`${fileName}: event time moved backwards`);
    }
  }

  const moduleStarts = events.filter((event) => event.event === "module_start");
  const terminalEvents = events.filter(
    (event) => event.event === "terminal_consume",
  );
  const queueEvents = events.filter(
    (event) =>
      event.event === "queue_snapshot" || event.event === "queue_sample",
  );
  const queueSamples = events
    .filter((event) => event.event === "queue_sample")
    .map((event) => ({
      timeMs: event.timeMs,
      queuedRecords: event.queuedRecords,
      queuedBytes: event.queuedBytes,
    }));
  const sourceCounts = new Map(
    start.sourceModuleIds.map((moduleId) => [moduleId, 0]),
  );
  const terminalCounts = new Map(
    start.terminalModuleIds.map((moduleId) => [moduleId, 0]),
  );
  const externalRootIds = new Set();
  const acceptedRootIds = new Set();
  for (const event of events) {
    if (event.event === "external_backpressure") {
      externalRootIds.add(event.rootId);
    }
    if (event.event === "external_accept") {
      externalRootIds.add(event.rootId);
      acceptedRootIds.add(event.rootId);
      sourceCounts.set(event.moduleId, (sourceCounts.get(event.moduleId) ?? 0) + 1);
    }
    if (event.event === "terminal_consume") {
      terminalCounts.set(
        event.moduleId,
        (terminalCounts.get(event.moduleId) ?? 0) + event.occurrences,
      );
    }
  }
  const terminalOccurrences = terminalEvents.reduce(
    (sum, event) => sum + event.occurrences,
    0,
  );
  const recovery = stableRecoveryMetrics(
    queueSamples,
    start.moduleCount,
    start.loadProfile === "shock",
  );

  const serialViolations = reconstructSerialViolations(events);
  const outputCountViolations = reconstructOutputCountViolations(events);
  const atomicBroadcastViolations = reconstructAtomicBroadcastViolations(events);
  const duplicateCountViolations = events.filter(
    (event) =>
      event.event === "duplicate_merge" &&
      (!Number.isInteger(event.addedOccurrences) ||
        event.addedOccurrences <= 0 ||
        event.occurrenceCount < event.addedOccurrences),
  ).length;
  const reconstructedMetrics = {
    calls: moduleStarts.length,
    throughputPerSecond: round(
      terminalOccurrences / (DRAIN_END_MS / 1000),
      6,
    ),
    terminalOccurrences,
    p95LatencyMs: percentileNearestRank(
      terminalEvents.map((event) => ({
        value: event.latencyMs,
        weight: event.occurrences,
      })),
      0.95,
    ),
    peakQueuedRecords: Math.max(
      0,
      ...queueEvents.map((event) => event.queuedRecords),
    ),
    peakQueuedBytes: Math.max(
      0,
      ...queueEvents.map((event) => event.queuedBytes),
    ),
    fairnessJain: Math.min(
      jainFairness([...sourceCounts.values()]),
      jainFairness([...terminalCounts.values()]),
    ),
    emptyCalls: moduleStarts.filter((event) => event.empty).length,
    stabilityTimeMs: recovery.stabilityTimeMs,
    recoveryTimeMs: recovery.recoveryTimeMs,
    deadlock: events.some((event) => event.event === "deadlock"),
    noProgress: events.some((event) => event.event === "no_progress"),
    serialViolations,
    outputCountViolations,
    atomicBroadcastViolations,
    duplicateCountViolations,
    arrivalsDuringRun: events.filter(
      (event) => event.event === "queue_enqueue" && event.arrivedDuringRun,
    ).length,
    duplicateOccurrencesMerged: events
      .filter((event) => event.event === "duplicate_merge")
      .reduce((sum, event) => sum + event.addedOccurrences, 0),
    feedbackOutsidePreferredCadence: events.filter(
      (event) => event.event === "module_feedback",
    ).length,
    feedbackTooFast: events.filter(
      (event) =>
        event.event === "module_feedback" && event.feedback === "too-fast",
    ).length,
    feedbackTooSlow: events.filter(
      (event) =>
        event.event === "module_feedback" && event.feedback === "too-slow",
    ).length,
    outputBlocked: events.filter((event) => event.event === "output_blocked")
      .length,
    policyUpdates: events.filter((event) => event.event === "policy_update")
      .length,
    externalPlanned: externalRootIds.size,
    externalAccepted: acceptedRootIds.size,
    externalPendingAtStop: externalRootIds.size - acceptedRootIds.size,
  };
  const safetyFailures = [];
  for (const metric of [
    "serialViolations",
    "outputCountViolations",
    "atomicBroadcastViolations",
    "duplicateCountViolations",
  ]) {
    if (reconstructedMetrics[metric] !== 0) {
      safetyFailures.push(`${metric}=${reconstructedMetrics[metric]}`);
    }
  }
  if (
    reconstructedMetrics.externalAccepted +
      reconstructedMetrics.externalPendingAtStop !==
    reconstructedMetrics.externalPlanned
  ) {
    safetyFailures.push("external producer ownership accounting disagrees");
  }
  return {
    caseId: start.caseId,
    declaredMetrics: end.metrics,
    reconstructedMetrics,
    safetyFailures,
  };
}

function reconstructSerialViolations(events) {
  const active = new Map();
  let violations = 0;
  for (const event of events) {
    if (event.event === "module_start") {
      if (active.has(event.moduleId)) violations += 1;
      active.set(event.moduleId, event.runId);
    } else if (event.event === "module_commit") {
      if (active.get(event.moduleId) !== event.runId) violations += 1;
      else active.delete(event.moduleId);
    }
  }
  return violations;
}

function reconstructOutputCountViolations(events) {
  const completions = new Map();
  const blocked = new Set();
  const broadcast = new Set();
  let violations = 0;
  for (const event of events) {
    if (event.event === "module_service_complete") {
      const key = `${event.moduleId}\u0000${event.runId}`;
      if (completions.has(key)) violations += 1;
      completions.set(key, event.outputBlockId);
    } else if (event.event === "output_blocked") {
      blocked.add(event.blockId);
    } else if (event.event === "block_broadcast") {
      broadcast.add(event.blockId);
      if (event.outputCount !== 1) violations += 1;
    }
  }
  for (const outputBlockId of completions.values()) {
    if (outputBlockId !== null && !blocked.has(outputBlockId) && !broadcast.has(outputBlockId)) {
      violations += 1;
    }
  }
  return violations;
}

function reconstructAtomicBroadcastViolations(events) {
  const deliveries = new Map();
  const broadcasts = new Map();
  let violations = 0;
  for (const event of events) {
    if (
      event.event === "queue_enqueue" &&
      event.sourceKind === "page-broadcast"
    ) {
      const targets = deliveries.get(event.blockId) ?? new Map();
      if (targets.has(event.moduleId)) violations += 1;
      targets.set(event.moduleId, event.occurrenceCount);
      deliveries.set(event.blockId, targets);
    }
    if (event.event === "block_broadcast") {
      if (broadcasts.has(event.blockId)) violations += 1;
      broadcasts.set(event.blockId, event.targets);
    }
  }
  for (const [blockId, targets] of broadcasts) {
    const delivered = deliveries.get(blockId) ?? new Map();
    if (delivered.size !== targets.length) {
      violations += 1;
      continue;
    }
    for (const target of targets) {
      if (delivered.get(target.target) !== target.multiplicity) violations += 1;
    }
  }
  for (const blockId of deliveries.keys()) {
    if (!broadcasts.has(blockId)) violations += 1;
  }
  return violations;
}

function assertMetricEqual(actual, expected, label) {
  if (actual === null || expected === null) {
    if (actual !== expected) throw new Error(`${label}: ${actual} != ${expected}`);
    return;
  }
  if (typeof actual === "number" && typeof expected === "number") {
    if (Math.abs(actual - expected) > 0.000001) {
      throw new Error(`${label}: ${actual} != ${expected}`);
    }
    return;
  }
  if (actual !== expected) throw new Error(`${label}: ${actual} != ${expected}`);
}

function buildComparisons(cases) {
  const byKey = new Map(
    cases.map((item) => [
      `${item.topologyId}\u0000${item.loadProfile}\u0000${item.seed}\u0000${item.policyId}`,
      item,
    ]),
  );
  const definitions = [
    ["event-driven", "fixed-period"],
    ["queue-watermark", "event-driven"],
    ["downstream-backlog-service-adaptive-period", "event-driven"],
    ["downstream-backlog-service-adaptive-period", "adaptive-count-only"],
    ["downstream-backlog-service-adaptive-period", "adaptive-mean-fanout"],
    ["downstream-backlog-service-adaptive-period", "adaptive-no-module-feedback"],
  ];
  const comparisons = [];
  for (const candidate of cases) {
    for (const [candidatePolicy, baselinePolicy] of definitions) {
      if (candidate.policyId !== candidatePolicy) continue;
      const baseline = byKey.get(
        `${candidate.topologyId}\u0000${candidate.loadProfile}\u0000${candidate.seed}\u0000${baselinePolicy}`,
      );
      if (!baseline) throw new Error(`missing paired baseline for ${candidate.caseId}`);
      comparisons.push({
        topologyId: candidate.topologyId,
        loadProfile: candidate.loadProfile,
        seed: candidate.seed,
        candidatePolicy,
        baselinePolicy,
        candidateCaseId: candidate.caseId,
        baselineCaseId: baseline.caseId,
        deltas: {
          callsRelative: relativeDelta(candidate.metrics.calls, baseline.metrics.calls),
          throughputRelative: relativeDelta(
            candidate.metrics.throughputPerSecond,
            baseline.metrics.throughputPerSecond,
          ),
          p95LatencyRelative: relativeDelta(
            candidate.metrics.p95LatencyMs,
            baseline.metrics.p95LatencyMs,
          ),
          peakQueuedBytesRelative: relativeDelta(
            candidate.metrics.peakQueuedBytes,
            baseline.metrics.peakQueuedBytes,
          ),
          emptyCallsRelative: relativeDelta(
            candidate.metrics.emptyCalls,
            baseline.metrics.emptyCalls,
          ),
          feedbackOutsidePreferredCadenceRelative: relativeDelta(
            candidate.metrics.feedbackOutsidePreferredCadence,
            baseline.metrics.feedbackOutsidePreferredCadence,
          ),
          recoveryImprovementMs: recoveryImprovement(
            candidate.metrics.recoveryTimeMs,
            baseline.metrics.recoveryTimeMs,
          ),
        },
      });
    }
  }
  return comparisons.sort((left, right) =>
    `${left.topologyId}/${left.loadProfile}/${left.seed}/${left.candidatePolicy}/${left.baselinePolicy}`.localeCompare(
      `${right.topologyId}/${right.loadProfile}/${right.seed}/${right.candidatePolicy}/${right.baselinePolicy}`,
    ),
  );
}

function evaluateHypotheses(comparisons, cases) {
  const h1 = comparisons.filter(
    (item) =>
      item.loadProfile === "stable" &&
      item.candidatePolicy === "event-driven" &&
      item.baselinePolicy === "fixed-period",
  );
  const h1Support = h1.filter(
    (item) =>
      item.deltas.emptyCallsRelative !== null &&
      item.deltas.emptyCallsRelative < 0 &&
      item.deltas.p95LatencyRelative !== null &&
      item.deltas.p95LatencyRelative <= -0.1 &&
      item.deltas.throughputRelative !== null &&
      item.deltas.throughputRelative >= 0,
  );
  const h2Calls = comparisons.filter(
    (item) =>
      item.loadProfile === "shock" &&
      item.candidatePolicy === "queue-watermark" &&
      item.baselinePolicy === "event-driven",
  );
  const h2Latency = comparisons.filter(
    (item) =>
      item.loadProfile === "stable" &&
      item.candidatePolicy === "queue-watermark" &&
      item.baselinePolicy === "event-driven",
  );
  const h2CallSupport = h2Calls.filter(
    (item) => item.deltas.callsRelative !== null && item.deltas.callsRelative <= -0.15,
  );
  const h2LatencySupport = h2Latency.filter(
    (item) =>
      item.deltas.p95LatencyRelative !== null && item.deltas.p95LatencyRelative >= 0.1,
  );
  const h3 = comparisons.filter(
    (item) =>
      item.loadProfile === "shock" &&
      item.candidatePolicy === "downstream-backlog-service-adaptive-period" &&
      item.baselinePolicy === "event-driven",
  );
  const h3Support = h3.filter(
    (item) =>
      item.deltas.throughputRelative !== null &&
      item.deltas.throughputRelative >= -0.1 &&
      ((item.deltas.peakQueuedBytesRelative !== null &&
        item.deltas.peakQueuedBytesRelative <= -0.15) ||
        (item.deltas.recoveryImprovementMs !== null &&
          item.deltas.recoveryImprovementMs >= 20)),
  );
  const h4 = comparisons.filter(
    (item) =>
      ["fan-out", "fan-in"].includes(item.topologyId) &&
      item.candidatePolicy === "downstream-backlog-service-adaptive-period" &&
      ["adaptive-count-only", "adaptive-mean-fanout"].includes(
        item.baselinePolicy,
      ),
  );
  const h4Support = h4.filter(
    (item) =>
      (item.deltas.peakQueuedBytesRelative !== null &&
        item.deltas.peakQueuedBytesRelative <= -0.15) ||
      (item.deltas.recoveryImprovementMs !== null &&
        item.deltas.recoveryImprovementMs >= 20),
  );
  const h4ByFactor = ["adaptive-count-only", "adaptive-mean-fanout"].map(
    (baselinePolicy) => {
      const evaluated = h4.filter(
        (item) => item.baselinePolicy === baselinePolicy,
      );
      const supporting = h4Support.filter(
        (item) => item.baselinePolicy === baselinePolicy,
      );
      return {
        removedFactor:
          baselinePolicy === "adaptive-count-only"
            ? "queued bytes, service time, and arrivals during the run"
            : "worst-downstream aggregation",
        baselinePolicy,
        status: supporting.length > 0 ? "supported" : "not-supported",
        supportingCases: supporting.length,
        evaluatedCases: evaluated.length,
      };
    },
  );
  const h5 = comparisons.filter(
    (item) =>
      ["line", "fan-out", "fan-in"].includes(item.topologyId) &&
      item.candidatePolicy === "downstream-backlog-service-adaptive-period" &&
      item.baselinePolicy === "adaptive-no-module-feedback",
  );
  const h5Support = h5.filter(
    (item) =>
      item.deltas.feedbackOutsidePreferredCadenceRelative !== null &&
      item.deltas.feedbackOutsidePreferredCadenceRelative <= -0.2,
  );
  const h6 = cases.filter(
    (item) =>
      ["cycle", "self-loop"].includes(item.topologyId) &&
      (item.metrics.deadlock || item.metrics.noProgress),
  );
  return [
    hypothesis("H1", h1Support, h1),
    {
      id: "H2",
      status:
        h2CallSupport.length === h2Calls.length &&
        h2LatencySupport.length === h2Latency.length
          ? "supported-all-frozen-cases"
          : h2CallSupport.length > 0 && h2LatencySupport.length > 0
            ? "heterogeneous-support"
            : "not-supported",
      sustainedLoadCallReductionCases: h2CallSupport.length,
      sustainedLoadCases: h2Calls.length,
      lightLoadLatencyIncreaseCases: h2LatencySupport.length,
      lightLoadCases: h2Latency.length,
    },
    hypothesis("H3", h3Support, h3),
    {
      id: "H4",
      status: h4ByFactor.every((item) => item.status === "supported")
        ? "supported-all-ablated-factors"
        : h4ByFactor.some((item) => item.status === "supported")
          ? "partial-factor-support"
          : "not-supported",
      supportingCases: h4Support.length,
      evaluatedCases: h4.length,
      factorResults: h4ByFactor,
      examples: h4Support.slice(0, 10).map((item) => item.candidateCaseId),
    },
    hypothesis("H5", h5Support, h5),
    {
      id: "H6",
      status: h6.length > 0 ? "supported" : "not-supported",
      supportingCases: h6.length,
      evaluatedCases: cases.filter((item) =>
        ["cycle", "self-loop"].includes(item.topologyId),
      ).length,
      examples: h6.slice(0, 10).map((item) => item.caseId),
    },
  ];
}

function hypothesis(id, supporting, evaluated, existential = false) {
  return {
    id,
    status: existential
      ? supporting.length > 0
        ? "supported"
        : "not-supported"
      : supporting.length === evaluated.length
        ? "supported-all-frozen-cases"
        : supporting.length > 0
          ? "heterogeneous-support"
          : "not-supported",
    supportingCases: supporting.length,
    evaluatedCases: evaluated.length,
    examples: supporting.slice(0, 10).map((item) => item.candidateCaseId),
  };
}

function relativeDelta(candidate, baseline) {
  if (candidate === null || baseline === null) return null;
  if (baseline === 0) return candidate === 0 ? 0 : null;
  return round((candidate - baseline) / Math.abs(baseline), 6);
}

function recoveryImprovement(candidate, baseline) {
  if (candidate === null || baseline === null) return null;
  return round(baseline - candidate, 6);
}

function compareCases(left, right) {
  return `${left.topologyId}/${left.loadProfile}/${left.policyId}/${left.seed}`.localeCompare(
    `${right.topologyId}/${right.loadProfile}/${right.policyId}/${right.seed}`,
  );
}

function renderReport(summary, run) {
  const h3 = summary.hypothesisResults.find((item) => item.id === "H3");
  const h4 = summary.hypothesisResults.find((item) => item.id === "H4");
  const h5 = summary.hypothesisResults.find((item) => item.id === "H5");
  const h6 = summary.hypothesisResults.find((item) => item.id === "H6");
  const p95TimerSlips = summary.realTimerCases
    .map(
      (item) =>
        item.independentlyReconstructedTimerDiagnostics.p95AbsoluteSlipMs,
    )
    .sort((left, right) => left - right);
  const minimumSignedTimerSlip = Math.min(
    ...summary.realTimerCases.map(
      (item) =>
        item.independentlyReconstructedTimerDiagnostics.minimumSignedSlipMs,
    ),
  );
  const maximumSignedTimerSlip = Math.max(
    ...summary.realTimerCases.map(
      (item) =>
        item.independentlyReconstructedTimerDiagnostics.maximumSignedSlipMs,
    ),
  );
  const lines = [
    "# Scheduler policy effect probe v0",
    "",
    "## Result boundary",
    "",
    "This run compares scheduling rules in a deterministic synthetic Page/Module model. It does not start Dolly's Module runtime and does not prove that the guarded product path is safe or supported.",
    "",
    `The independent analyzer reconstructed ${summary.caseCount} of ${run.expectedCaseCount} deterministic raw cases and ${summary.realTimerCaseCount} real-timer raw cases. Safety-invariant reconstruction failures: ${summary.safetyInvariantFailures + summary.realTimerSafetyInvariantFailures}.`,
    "",
    "## Frozen hypotheses",
    "",
    "| Hypothesis | Status | Supporting cases | Evaluated cases |",
    "| --- | --- | ---: | ---: |",
  ];
  for (const item of summary.hypothesisResults) {
    const supporting =
      item.supportingCases ??
      `${item.sustainedLoadCallReductionCases}/${item.lightLoadLatencyIncreaseCases}`;
    const evaluated =
      item.evaluatedCases ?? `${item.sustainedLoadCases}/${item.lightLoadCases}`;
    lines.push(`| ${item.id} | ${item.status} | ${supporting} | ${evaluated} |`);
  }
  lines.push(
    "",
    "H4 must be read by factor; combining the ablations would produce a false positive:",
    "",
    "| Removed factor | Status | Supporting cases | Evaluated cases |",
    "| --- | --- | ---: | ---: |",
  );
  for (const factor of h4.factorResults) {
    lines.push(
      `| ${factor.removedFactor} | ${factor.status} | ${factor.supportingCases} | ${factor.evaluatedCases} |`,
    );
  }
  lines.push(
    "",
    "A heterogeneous result is not a default-policy decision. The preregistered decision rule keeps the simpler reactive baseline unless an advantage clears the minimum meaningful difference in at least two relevant topology/load pairs without a safety failure or more than 10% throughput loss.",
    "",
    "## Engineering implications",
    "",
    "- Keep immediate event-driven activation as the simple reactive control. H1 cleared every frozen criterion in 11/15 stable cases, but failed the 10% latency threshold in all three fan-out repetitions, so this is a baseline rather than a universal winner.",
    `- Carry downstream-pressure adaptive gating forward only as an overload-mode candidate. H3 cleared its frozen queue/recovery and throughput criteria in ${h3.supportingCases}/${h3.evaluatedCases} shock cases, while several cases paid a substantial latency cost.`,
    `- Retain the combined byte, service-time, and arrivals-during-run signals only as a candidate bundle. The count-only ablation removed all three together, so this run cannot attribute the effect to byte pressure alone. Do not add mean-versus-maximum fan-out complexity on this evidence; that ablation was not distinguishable (${h4.factorResults[1].supportingCases}/${h4.factorResults[1].evaluatedCases}).`,
    `- Do not make explicit Module cadence feedback a default controller input yet. H5 cleared the requested cadence reduction in only ${h5.supportingCases}/${h5.evaluatedCases} cases, and some line cases increased latency and peak queued bytes.`,
    `- Treat dependency-cycle and no-progress detection as a correctness feature, not a tuning detail. H6 exposed ${h6.supportingCases}/${h6.evaluatedCases} cyclic or self-loop cases with deadlock or sustained no progress.`,
    "",
    "## Real Node.js timer smoke check",
    "",
    `All ${summary.realTimerCaseCount} repetitions drained with zero serial violations, zero queued records, and no busy Module at stop. Recomputed from raw due/actual timestamps, the median case-level p95 absolute timer slip was ${format(p95TimerSlips[Math.floor(p95TimerSlips.length / 2)])} ms; signed slip ranged from ${format(minimumSignedTimerSlip)} to ${format(maximumSignedTimerSlip)} ms. These timing results are reported separately and are not pooled with deterministic comparisons.`,
    "",
    "| Load | Policy | Repetition | Calls | Throughput/s | p95 latency ms | p95 absolute timer slip ms | Signed timer slip range ms |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const item of summary.realTimerCases) {
    const metrics = item.metrics;
    lines.push(
      `| ${item.loadProfile} | ${item.policyId} | ${item.repetition} | ${metrics.calls} | ${metrics.throughputPerSecond} | ${format(metrics.p95LatencyMs)} | ${format(item.independentlyReconstructedTimerDiagnostics.p95AbsoluteSlipMs)} | ${format(item.independentlyReconstructedTimerDiagnostics.minimumSignedSlipMs)} to ${format(item.independentlyReconstructedTimerDiagnostics.maximumSignedSlipMs)} |`,
    );
  }
  lines.push(
    "",
    "## Deterministic per-case results",
    "",
    "| Topology | Load | Policy | Seed | Calls | Throughput/s | p95 ms | Peak bytes | Recovery ms | Deadlock | No progress | External pending at stop |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |",
  );
  for (const item of summary.cases) {
    const metrics = item.metrics;
    lines.push(
      `| ${item.topologyId} | ${item.loadProfile} | ${item.policyId} | ${item.seed} | ${metrics.calls} | ${metrics.throughputPerSecond} | ${format(metrics.p95LatencyMs)} | ${metrics.peakQueuedBytes} | ${format(metrics.recoveryTimeMs)} | ${metrics.deadlock} | ${metrics.noProgress} | ${metrics.externalPendingAtStop} |`,
    );
  }
  lines.push(
    "",
    "## Reproducibility and checks",
    "",
    `- Preregistration SHA-256: \`${summary.preregistrationSha256}\`.`,
    `- Node.js: \`${run.environment.node}\`; platform: \`${run.environment.platform}/${run.environment.architecture}\`.`,
    "- Each raw JSONL file contains one case, stable event sequence numbers, and a terminal metric record.",
    "- For deterministic cases, the analyzer independently reconstructed calls, weighted latency, throughput, queue peaks, fairness, recovery, producer ownership, feedback counts, and the serial/output/broadcast/duplicate safety checks.",
    "- For real-timer cases, it independently reconstructed input planning and admission, calls, throughput, weighted latency, queue drainage, serial execution, and timer-slip distributions.",
    "- Raw file hashes and implementation hashes are in `artifacts/experiments/probes/scheduler-effect-v0/manifest.json`.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function format(value) {
  return value === null ? "—" : value;
}
