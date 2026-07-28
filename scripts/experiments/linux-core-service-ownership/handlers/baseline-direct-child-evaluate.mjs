#!/usr/bin/env node
// Decides one `baseline-direct-child` case from three pieces of evidence: the
// barrier snapshot the Core stand-in wrote, the harness's own process
// observations across the SIGKILL, and the successor Core's recovery report.
//
// The point of this arm is to record honestly where the current direct-child
// launch path does not hold the protocol's invariants. Two rules keep that
// honest in both directions:
//
//   * a case is `failed` when an invariant that could have been satisfied at
//     this interruption point was not, even though the arm was never expected
//     to satisfy it. Reporting such a case as `not-applicable` would hide the
//     comparison the experiment exists to make; and
//   * `not-applicable` is reserved for a case where no invariant is decidable
//     at all, so there is nothing the arm could have got right or wrong.
//
// Only one situation meets that second rule, and the handler decides it before
// this file runs: a Run with no output commits no Block and appends no output
// Delivery, so boundaries 11 and 12 have no referent for the `no-output`
// workload. That is a property of the Run rather than of an arm, so the
// proposed design reports the same four cases the same way. The branch below is
// kept as a guard; reaching it would mean a case produced no decidable check at
// all, which would be worth investigating rather than reporting as a result.
//
// Invariant 4, "a Module started outside the validated Core service: zero", is
// treated differently from the rest and deliberately so. It is this arm's
// defining condition, not an outcome of any one interruption: all 210 cases
// violate it identically, before the harness terminates anything. It is
// therefore recorded in every case as a structural violation, with the real
// refusal codes from `inspectCoreServiceBinding`, and it does not by itself
// decide a case's status. Every other invariant is measured per case.
//
// Usage:
//   node baseline-direct-child-evaluate.mjs BARRIER OBSERVATIONS SUCCESSOR OUT
// Prints `status<TAB>reason` on standard output.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const BOUNDARY_ORDER = [
  "M01",
  "M02",
  "M03",
  "M04",
  "M05",
  "M06",
  "M07",
  "M08.start",
  "M08.completion",
  "M09",
  "M10",
  "M11",
  "M12",
  "M13",
  "M14",
];

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

const [barrierPath, observationsPath, successorPath, outputPath] = process.argv.slice(2);
const barrier = readJson(barrierPath, null);
const observations = readJson(observationsPath, null);
const successor = readJson(successorPath, null);

function emit(status, reason, detail) {
  const document = { status, reason, ...detail };
  writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  process.stdout.write(`${status}\t${reason}\n`);
  process.exit(0);
}

if (barrier === null || observations === null) {
  emit("inconclusive", "evidence-missing", { barrierPresent: barrier !== null });
}
if (successor === null) {
  emit("inconclusive", "successor-probe-produced-no-report", {});
}

const boundaryIndex = BOUNDARY_ORDER.indexOf(barrier.boundary);
if (boundaryIndex < 0) {
  emit("inconclusive", "unrecognised-boundary", { boundary: barrier.boundary });
}
const timing = barrier.timing;

// "The step has happened" for ordering purposes: a boundary reached with timing
// `after` counts as completed, `before` does not.
const completed = (id) => {
  const index = BOUNDARY_ORDER.indexOf(id);
  return boundaryIndex > index || (boundaryIndex === index && timing === "after");
};

const liveAtBarrier = (observations.aliveAtBarrier ?? []).filter((entry) => entry.role !== "core");
const survivors = observations.aliveAfterCoreDeath ?? [];
const residue = observations.residualProcessesAfterCleanup ?? [];
const childExisted = Number(barrier.extensionPid ?? 0) > 0;

const checks = [];
function check(id, invariant, applicable, held, note) {
  checks.push({ id, invariant, applicable, held: applicable ? held : null, note });
}

// INV-01: two Module process generations must never overlap. Measured as
// whether anything from the old generation is still alive after its creating
// Core process was killed; anything that is, a replacement would overlap with.
check(
  "K-ORPHAN",
  "INV-01",
  liveAtBarrier.length > 0,
  survivors.length === 0,
  liveAtBarrier.length > 0
    ? `${liveAtBarrier.length} process(es) of the old generation were alive at the barrier; ${survivors.length} outlived Core`
    : "no process of the old generation was alive at the barrier",
);

// INV-08: recovery must reconcile durable records before starting Module work.
// It cannot begin to do that without a durable record of the attempt.
check(
  "K-RECORD",
  "INV-08",
  completed("M02"),
  (successor.durableState?.moduleProcessRecords ?? 0) > 0,
  "the Module process record is the successor's only durable evidence that a process generation was attempted",
);

// INV-06: a replacement may not start before the old process control group is
// proven empty. Decided by the shipped `decideModuleProcessStopProof`.
check(
  "K-STOPPROOF",
  "INV-06",
  childExisted,
  successor.canProveOldGenerationStopped === true,
  successor.hypotheticalStopProof?.reason ?? "no stop proof was available",
);

// INV-03 and INV-08: an unknown outcome must not be retried, which requires the
// successor to be able to tell whether `module.execute` crossed the boundary.
check(
  "K-SUBMISSION",
  "INV-03",
  completed("M06"),
  successor.canDecideWhetherExecuteWasSent === true,
  "without a submission record the send outcome is unknown, so neither retry nor acknowledgement is authorized",
);

// INV-12: the harness must leave nothing behind, whatever the arm did.
check("K-RESIDUE", "INV-12", true, residue.length === 0, `${residue.length} process(es) remained after cleanup`);

const structural = {
  invariant: "INV-04",
  violated: successor.serviceBindingVerified !== true,
  evidence: successor.bindingFailures ?? [],
  note:
    "this arm runs outside a validated stable Core service by definition; the violation is its independent variable, recorded in every case and not counted as the case outcome",
};

// INV-07 is satisfied here for a reason worth recording rather than celebrating:
// the successor has no process identifier at all, so it cannot signal by one.
const recoveredPidNote = {
  invariant: "INV-07",
  satisfied: true,
  vacuous: successor.hasRecoveredProcessIdentifier !== true,
  note:
    successor.hasRecoveredProcessIdentifier === true
      ? "the successor recovered a process identifier and must not signal by it"
      : "satisfied only because the successor recovered no identifier and can therefore act on nothing",
};

const applicable = checks.filter((entry) => entry.applicable);
const failed = applicable.filter((entry) => entry.held !== true);
const detail = {
  boundary: barrier.boundary,
  timing,
  workload: barrier.workload,
  checks,
  structuralInvariantViolation: structural,
  recoveredIdentifierNote: recoveredPidNote,
  aliveAtBarrier: liveAtBarrier,
  survivors,
  residue,
  successorSummary: {
    serviceBindingVerified: successor.serviceBindingVerified,
    moduleProcessRecords: successor.durableState?.moduleProcessRecords ?? 0,
    moduleSubmissionRecords: successor.durableState?.moduleSubmissionRecords ?? 0,
    activeClaims: (successor.durableState?.activeClaims ?? []).length,
    canProveOldGenerationStopped: successor.canProveOldGenerationStopped,
    canDecideWhetherExecuteWasSent: successor.canDecideWhetherExecuteWasSent,
  },
};

if (applicable.length === 0) {
  emit("not-applicable", "no-invariant-is-decidable-at-this-point", detail);
}
if (failed.length === 0) {
  emit("passed", "no-decidable-invariant-was-violated", detail);
}

const failedIds = new Set(failed.map((entry) => entry.id));
const survivorRoles = new Set(survivors.map((entry) => entry.role));
let reason;
if (failedIds.has("K-RESIDUE")) {
  reason = "harness-cleanup-left-residue";
} else if (survivorRoles.has("descendant")) {
  reason = "extension-descendant-survived-core-sigkill";
} else if (survivorRoles.has("extension")) {
  reason = "extension-child-survived-core-sigkill";
} else if (failedIds.has("K-STOPPROOF")) {
  reason = "child-exit-not-provable-after-core-exit";
} else if (failedIds.has("K-SUBMISSION")) {
  reason = "send-outcome-unknown-without-submission-record";
} else if (failedIds.has("K-RECORD")) {
  reason = "no-durable-process-record-outside-a-service";
} else {
  reason = "invariant-violated";
}
emit("failed", reason, detail);
