#!/usr/bin/env node
// Invariant evaluation for one case of the fixed interruption matrix.
//
// The handler runs the experiment; this decides what the evidence means. It is
// separate so the decision can be read without reading shell, and so the same
// decision runs against retained artifacts after the fact.
//
// Every check names the invariant it comes from. A check that cannot be
// evaluated for this boundary — the Extension environment when the Extension
// never existed, the control-group limits when no control group was created
// yet — is reported as `not-evaluable` and says why. It is never silently
// counted as a pass, and it never turns into a failure either: protocol
// version 3 asks for the twelve invariants at every boundary, and at some
// boundaries the subject of an invariant does not exist yet.
//
// Exit codes: 0 every evaluable check passed, 1 at least one failed, 2 the
// evaluation could not be performed.

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key.startsWith("--")) return null;
    options[key.slice(2)] = argv[index + 1] ?? "";
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
if (options === null) {
  process.stderr.write("fixed-interruption-evaluate: arguments must be --name value pairs\n");
  process.exit(2);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readLines(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

const checks = [];
const record = (id, invariant, status, detail) => {
  checks.push({ id, invariant, status, detail });
};
const pass = (id, invariant, detail) => record(id, invariant, "passed", detail);
const fail = (id, invariant, detail) => record(id, invariant, "failed", detail);
const skip = (id, invariant, detail) => record(id, invariant, "not-evaluable", detail);
const decide = (id, invariant, condition, passDetail, failDetail) =>
  condition ? pass(id, invariant, passDetail) : fail(id, invariant, failDetail);

const boundaryKey = `${options.boundary}-${options.timing}`;
const report = readJson(options["report-two"]);
const traceOne = readLines(options["trace-one"]);
const traceTwo = readLines(options["trace-two"]);
const arrival = readJson(options.arrival);
const moduleCgroupsAtBarrier = readLines(options["module-cgroups-at-barrier"]);
const declaredEnvironment = readJson(options["declared-environment"]);
const observedEnvironment = readJson(options["observed-environment"]);

if (report === undefined) {
  process.stderr.write("the recovery report is missing or unreadable\n");
  process.exit(2);
}

const before = report.stateBeforeRecovery ?? {};
const after = report.stateAfterRecovery ?? {};
const recoveryReport = report.recoveryReport ?? null;
const recoveryFailure = report.recoveryFailure ?? null;

const traceKey = (line) => line.split(/\s+/)[2] ?? "";
const boundaryKeyPattern = /^M\d{2}(\.[a-z]+)?-(before|after)$/;

// ---------------------------------------------------------------------------
// The interruption itself
// ---------------------------------------------------------------------------

decide(
  "interruption-point",
  "protocol:barrier",
  arrival !== undefined && arrival.barrier === boundaryKey,
  `Core stopped at ${boundaryKey} and was terminated there`,
  `the arrival record names ${arrival?.barrier ?? "nothing"} but this case interrupts ${boundaryKey}`,
);

decide(
  "nothing-ran-after-the-boundary",
  "protocol:barrier",
  traceOne.length > 0 && traceKey(traceOne[traceOne.length - 1]) === boundaryKey,
  `the interrupted invocation's last durable point is ${boundaryKey}`,
  `the interrupted invocation continued past ${boundaryKey} to ${traceKey(traceOne[traceOne.length - 1] ?? "")}`,
);

// The proof that the real service restart path ran is a second systemd
// invocation of the same unit, with a different invocation identifier, that
// the service manager created. `NRestarts` is recorded too, but it is not the
// proof: the manager clears it once the unit goes inactive again.
const firstInvocation = String(options["first-invocation-id"] ?? "").toLowerCase();
const secondInvocation = String(options["second-invocation-id"] ?? "").toLowerCase();
const invocationPattern = /^[0-9a-f]{32}$/;
decide(
  "service-manager-restarted-core",
  "adr-0009:stable-core-service-lifecycle",
  report.invocation >= 2 &&
    invocationPattern.test(firstInvocation) &&
    invocationPattern.test(secondInvocation) &&
    firstInvocation !== secondInvocation &&
    String(report.binding?.serviceInvocationId ?? "").toLowerCase() === secondInvocation,
  `the service manager started a second invocation ${secondInvocation} of the same unit (${options.restarts} restart(s) counted) and Core invocation ${report.invocation} recovered inside it`,
  `the restart evidence is incomplete: first invocation ${firstInvocation || "none"}, second ${secondInvocation || "none"}, Core invocation ${report.invocation}, recovering Core bound to ${report.binding?.serviceInvocationId ?? "nothing"}`,
);

decide(
  "recovery-ran",
  "INV-08",
  report.phase === "recovered",
  "the restarted Core reached startup recovery",
  `the restarted Core reported phase ${report.phase}`,
);

// ---------------------------------------------------------------------------
// INV-08: recovery reconciles before any Module work
// ---------------------------------------------------------------------------

const moduleWorkInRecovery = traceTwo.map(traceKey).filter((key) => boundaryKeyPattern.test(key));
const recoveryIndex = traceTwo.findIndex((line) =>
  ["recovery-complete", "recovery-refused"].includes(traceKey(line)),
);
const bindingIndex = traceTwo.findIndex((line) => traceKey(line) === "service-binding-verified");
decide(
  "recovery-starts-no-module-work",
  "INV-08",
  moduleWorkInRecovery.length === 0 &&
    report.startedModuleWorkDuringRecovery === false &&
    bindingIndex >= 0 &&
    recoveryIndex > bindingIndex,
  "the recovering invocation proved its service binding and reconciled before doing anything else, and started no Module work",
  `the recovering invocation reached ${moduleWorkInRecovery.join(", ") || "no boundary"} with binding at ${bindingIndex} and reconciliation at ${recoveryIndex}`,
);

// ---------------------------------------------------------------------------
// INV-04 and INV-05: what a Module process record must carry
// ---------------------------------------------------------------------------

const processRecordsBefore = before.moduleProcessRecords ?? [];
const processRecordsAfter = after.moduleProcessRecords ?? [];
const firstInvocationId = String(options["first-invocation-id"] ?? "").toLowerCase();

if (processRecordsBefore.length === 0) {
  skip(
    "module-started-inside-the-validated-service",
    "INV-04",
    "no Module process record exists at this boundary, so no Module was started at all",
  );
} else {
  const foreign = processRecordsBefore.filter(
    (item) => String(item.serviceInvocationId).toLowerCase() !== firstInvocationId,
  );
  decide(
    "module-started-inside-the-validated-service",
    "INV-04",
    foreign.length === 0 && firstInvocationId.length === 32,
    `every Module process record carries the interrupted service invocation ${firstInvocationId}`,
    `${foreign.length} Module process record(s) do not carry the service invocation identifier ${firstInvocationId}`,
  );
}

const validationBeforeStart = (() => {
  const startIndex = traceOne.findIndex((line) => traceKey(line) === "M02-before");
  if (startIndex < 0) return null;
  const validatedIndex = traceOne.findIndex((line) => traceKey(line) === "M01-after");
  return validatedIndex >= 0 && validatedIndex < startIndex;
})();
if (validationBeforeStart === null) {
  skip(
    "service-validated-before-any-module-work",
    "INV-04",
    "the interruption happened before any Module process record was attempted",
  );
} else {
  decide(
    "service-validated-before-any-module-work",
    "INV-04",
    validationBeforeStart,
    "the Core service binding was proven before the first Module process record",
    "a Module process record was created before the Core service binding was proven",
  );
}

if (processRecordsBefore.length === 0) {
  skip("declared-external-effects", "INV-05", "no Module process record exists at this boundary");
} else {
  const undeclared = processRecordsBefore.filter(
    (item) => item.declaredExternalEffects !== "core-capabilities-only",
  );
  decide(
    "declared-external-effects",
    "INV-05",
    undeclared.length === 0,
    "every Module process record declares core-capabilities-only external effects",
    `${undeclared.length} Module process record(s) do not declare core-capabilities-only external effects`,
  );
}

// ---------------------------------------------------------------------------
// INV-01 and INV-06: one live generation, and no replacement without proof
// ---------------------------------------------------------------------------

decide(
  "one-live-process-generation",
  "INV-01",
  moduleCgroupsAtBarrier.length <= 1,
  `${moduleCgroupsAtBarrier.length} Module control group(s) existed at the interruption point`,
  `${moduleCgroupsAtBarrier.length} Module control groups existed at once, which is more than one live process generation`,
);

const unstoppedAfter = processRecordsAfter.filter((item) => item.state !== "stopped");
decide(
  "no-unproven-process-survives-recovery",
  "INV-01",
  unstoppedAfter.length === 0 || recoveryFailure?.code === "STARTUP_MODULE_PROCESS_UNPROVEN",
  unstoppedAfter.length === 0
    ? "every Module process record is stopped after recovery"
    : `recovery refused to continue with ${unstoppedAfter.length} unproven Module process record(s)`,
  `${unstoppedAfter.length} Module process record(s) are not stopped and recovery did not refuse`,
);

const generationsBefore = new Set(processRecordsBefore.map((item) => item.processGenerationId));
const generationsAfter = new Set(processRecordsAfter.map((item) => item.processGenerationId));
const appeared = [...generationsAfter].filter((id) => !generationsBefore.has(id));
// The proofs are read from what the shipped prover actually produced, not from
// recovery's return value: a recovery that correctly refuses to continue never
// returns one.
const proven = new Set(
  (report.stopProofs ?? [])
    .filter((entry) => entry.proof?.proven === true)
    .map((entry) => entry.processGenerationId),
);
const provedWithoutEvidence = processRecordsBefore
  .filter((item) => item.state !== "stopped")
  .filter(
    (item) =>
      processRecordsAfter.some(
        (later) => later.processGenerationId === item.processGenerationId && later.state === "stopped",
      ) && !proven.has(item.processGenerationId),
  );
decide(
  "no-replacement-without-an-empty-group-proof",
  "INV-06",
  appeared.length === 0 && provedWithoutEvidence.length === 0,
  `recovery started no replacement generation and proved ${proven.size} old control group(s) empty`,
  appeared.length > 0
    ? `${appeared.length} new process generation(s) appeared during recovery`
    : `${provedWithoutEvidence.length} process record(s) became stopped without an empty-group proof`,
);

// ---------------------------------------------------------------------------
// INV-02: nothing committed twice
// ---------------------------------------------------------------------------

const deliveriesByPage = after.deliveriesByPage ?? {};
const outputPages = Object.keys(deliveriesByPage).filter((page) =>
  page.startsWith("experiment-output-"),
);
const duplicated = outputPages.filter((page) => deliveriesByPage[page] > 1);
const commitRecords = after.commitRecords ?? [];
const committed = commitRecords.filter((item) => item.state === "committed");
const deliveryCountMismatch = committed.filter(
  (item) => item.outputDeliveries.length !== item.outputPageIds.length,
);
decide(
  "exactly-once-output",
  "INV-02",
  duplicated.length === 0 &&
    commitRecords.length <= 1 &&
    deliveryCountMismatch.length === 0 &&
    (after.blockCount ?? 0) <= 2,
  `no output Page holds more than one Delivery; ${commitRecords.length} commit record(s), ${after.blockCount} Block(s)`,
  duplicated.length > 0
    ? `output Page(s) ${duplicated.join(", ")} hold more than one Delivery`
    : commitRecords.length > 1
      ? `${commitRecords.length} result commit records exist for one Run`
      : deliveryCountMismatch.length > 0
        ? "a committed result records a different number of output Deliveries than output Pages"
        : `${after.blockCount} Blocks exist but one input and at most one output Block are possible`,
);

// ---------------------------------------------------------------------------
// INV-03: an unknown outcome is never retried
// ---------------------------------------------------------------------------

const journalBefore = before.capabilityJournal ?? [];
const intents = journalBefore.filter((entry) => entry.kind === "intent");
const outcomes = new Set(
  journalBefore.filter((entry) => entry.kind === "outcome").map((entry) => entry.invocationId),
);
const unresolvedEffects = intents.filter(
  (entry) => entry.externallyVisible === true && !outcomes.has(entry.invocationId),
);
const released = recoveryReport?.releasedClaims ?? [];
const unresolvedRuns = new Set(unresolvedEffects.map((entry) => entry.runId));
const wronglyReleased = released.filter((claim) => unresolvedRuns.has(claim.runId));
const effectsGrew =
  (after.externalEffects ?? []).length > (before.externalEffects ?? []).length;

if (unresolvedEffects.length === 0) {
  decide(
    "unknown-outcome-not-retried",
    "INV-03",
    !effectsGrew,
    "no capability invocation has an unknown outcome, and recovery caused no further external effect",
    "recovery caused an additional external effect",
  );
} else {
  decide(
    "unknown-outcome-not-retried",
    "INV-03",
    wronglyReleased.length === 0 && !effectsGrew &&
      (recoveryFailure?.code === "STARTUP_ACTIVE_CLAIM_UNRESOLVED" ||
        (recoveryReport?.unknownOutcomeClaims ?? []).length > 0),
    `${unresolvedEffects.length} capability invocation(s) have a durable intent and no durable outcome, and recovery preserved the Claim for audited operator action`,
    wronglyReleased.length > 0
      ? `recovery released ${wronglyReleased.length} Claim(s) whose external effect outcome is unknown`
      : effectsGrew
        ? "recovery repeated an external effect"
        : "an unknown external effect outcome did not stop recovery from continuing",
  );
}

// ---------------------------------------------------------------------------
// INV-07: no signal by a recovered process identifier
// ---------------------------------------------------------------------------

decide(
  "no-signal-by-recovered-identifier",
  "INV-07",
  report.signalledRecoveredProcessId === false,
  "Core signalled no process identifier read back from a durable record",
  "Core reported signalling a recovered process identifier",
);

// ---------------------------------------------------------------------------
// INV-09: the Extension observes only declared environment
// ---------------------------------------------------------------------------

if (observedEnvironment === undefined || declaredEnvironment === undefined) {
  skip(
    "declared-environment-only",
    "INV-09",
    "the Extension had not started at this boundary, so it observed no environment",
  );
} else {
  const declaredKeys = Object.keys(declaredEnvironment).sort();
  const observedKeys = Object.keys(observedEnvironment).sort();
  const undeclared = observedKeys.filter(
    (key) => !(key in declaredEnvironment) || observedEnvironment[key] !== declaredEnvironment[key],
  );
  decide(
    "declared-environment-only",
    "INV-09",
    undeclared.length === 0 && declaredKeys.length === observedKeys.length,
    `the Extension observed exactly the ${declaredKeys.length} declared environment values`,
    `the Extension observed ${undeclared.length} undeclared or altered environment value(s): ${undeclared.join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// INV-10: the isolation limits really apply
// ---------------------------------------------------------------------------

const EXPECTED_LIMITS = {
  "memory.max": "134217728",
  "pids.max": "32",
  "cpu.max": "50000 100000",
};
const cgroupSnapshotDirectory = options["cgroup-snapshot-dir"];
let limitGroups = [];
try {
  limitGroups = existsSync(cgroupSnapshotDirectory) ? readdirSync(cgroupSnapshotDirectory) : [];
} catch {
  limitGroups = [];
}
if (limitGroups.length === 0) {
  skip(
    "isolation-limits-applied",
    "INV-10",
    "no Module control group existed at this boundary, so there was no limit to read back",
  );
} else {
  const wrong = [];
  for (const group of limitGroups) {
    for (const [file, expected] of Object.entries(EXPECTED_LIMITS)) {
      const path = join(cgroupSnapshotDirectory, group, file);
      let actual;
      try {
        actual = readFileSync(path, "utf8").trim();
      } catch {
        wrong.push(`${group}/${file}: unreadable`);
        continue;
      }
      if (actual !== expected) wrong.push(`${group}/${file}: ${actual} (expected ${expected})`);
    }
  }
  decide(
    "isolation-limits-applied",
    "INV-10",
    wrong.length === 0,
    `every limit read back from ${limitGroups.length} Module control group(s) matches the configured value`,
    `limit read-back mismatch: ${wrong.join("; ")}`,
  );
}

// ---------------------------------------------------------------------------
// INV-11: nothing unreconciled after terminal cleanup
// ---------------------------------------------------------------------------

// "After terminal cleanup" is the operative phrase: a Claim that recovery
// deliberately preserved for audited operator action is not terminal, and the
// access lease that Claim holds over its input Blocks is reconciled, not
// leaked. So the lease count is required to be zero once no Claim remains, and
// otherwise to be accounted for by the Claims that do remain.
const activeClaims = after.activeClaims ?? [];
const activeRunIds = new Set(activeClaims.map((claim) => claim.runId));
const orphanSubmissions = (after.moduleSubmissionRecords ?? []).filter(
  (item) => !activeRunIds.has(item.runId),
);
const leaseCount = after.leaseCount ?? 0;
const leasesAccounted =
  activeClaims.length === 0 ? leaseCount === 0 : leaseCount <= activeClaims.length;
decide(
  "no-unreconciled-references-or-leases",
  "INV-11",
  leasesAccounted && (orphanSubmissions.length === 0 || recoveryFailure !== null),
  activeClaims.length === 0
    ? "no access lease and no orphaned submission record remain after terminal cleanup"
    : `${leaseCount} access lease(s) remain, each accounted for by one of the ${activeClaims.length} Claim(s) recovery preserved`,
  !leasesAccounted
    ? `${leaseCount} access lease(s) remain but only ${activeClaims.length} Claim(s) could hold them`
    : `${orphanSubmissions.length} submission record(s) remain with no Claim after a successful recovery`,
);

// ---------------------------------------------------------------------------
// Cross-record consistency the ADR requires of recovery's own decisions
// ---------------------------------------------------------------------------

const submittedRuns = new Set((before.moduleSubmissionRecords ?? []).map((item) => item.runId));
const wronglyNeverSubmitted = released.filter(
  (claim) => claim.reason === "never-submitted" && submittedRuns.has(claim.runId),
);
decide(
  "submitted-run-is-never-treated-as-unsubmitted",
  "INV-03",
  wronglyNeverSubmitted.length === 0,
  "recovery released no Claim as never-submitted whose Run had a durable submission record",
  `${wronglyNeverSubmitted.length} Claim(s) with a durable submission record were released as never-submitted`,
);

// ---------------------------------------------------------------------------
// INV-12: no residue
// ---------------------------------------------------------------------------

decide(
  "no-residue",
  "INV-12",
  options.residue === "0",
  "this case left no unit, process, or control group behind",
  "this case left a unit, process, or control group behind",
);

// ---------------------------------------------------------------------------

const failed = checks.filter((check) => check.status === "failed");
const skipped = checks.filter((check) => check.status === "not-evaluable");
const passed = checks.filter((check) => check.status === "passed");

for (const check of checks) {
  process.stdout.write(`${check.status} ${check.id} [${check.invariant}] ${check.detail}\n`);
}
process.stdout.write(
  `evaluation ${options.case}: ${passed.length} passed, ${failed.length} failed, ${skipped.length} not evaluable\n`,
);

if (options.output) {
  writeFileSync(
    options.output,
    `${JSON.stringify(
      {
        caseId: options.case,
        boundary: options.boundary,
        timing: options.timing,
        workload: options.workload,
        checks,
        passed: passed.length,
        failed: failed.length,
        notEvaluable: skipped.length,
      },
      null,
      2,
    )}\n`,
  );
}

process.exit(failed.length === 0 ? 0 : 1);
