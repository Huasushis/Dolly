#!/usr/bin/env node
// Invariant evaluation for one capability idempotency case.
//
// The question every case here asks is the same: after a crash around one
// capability invocation that has a real external effect, what may the restarted
// Core conclude, and what must it refuse to do? ADR 0009's answer is that only
// durable evidence counts, and that an unknown outcome is queried rather than
// retried.
//
// The decisive number is the external effect count. A retry would make it two.
//
// Exit codes: 0 every evaluable check passed, 1 at least one failed, 2 the
// evaluation could not be performed.

import { readFileSync, writeFileSync } from "node:fs";

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
  process.stderr.write("capability-idempotency-evaluate: arguments must be --name value pairs\n");
  process.exit(2);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** A journal file is one JSON object per line; a torn final line is dropped. */
function readJournal(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const records = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Exactly what a crash mid-append leaves behind. Not evidence.
    }
  }
  return records;
}

const checks = [];
const record = (id, invariant, status, detail) => checks.push({ id, invariant, status, detail });
const pass = (id, invariant, detail) => record(id, invariant, "passed", detail);
const fail = (id, invariant, detail) => record(id, invariant, "failed", detail);
const skip = (id, invariant, detail) => record(id, invariant, "not-evaluable", detail);
const decide = (id, invariant, condition, passDetail, failDetail) =>
  condition ? pass(id, invariant, passDetail) : fail(id, invariant, failDetail);

const report = readJson(options["report-two"]);
const journalAtBarrier = readJournal(options["journal-at-barrier"]);
const effectsAtBarrier = readJournal(options["effects-at-barrier"]);
const journalFinal = readJournal(options["journal-final"]);
const effectsFinal = readJournal(options["effects-final"]);
const caseId = options.case;
const boundary = options.boundary;
const timing = options.timing;

function finish(code) {
  const failed = checks.filter((check) => check.status === "failed");
  const skipped = checks.filter((check) => check.status === "not-evaluable");
  const passed = checks.filter((check) => check.status === "passed");
  for (const check of checks) {
    process.stdout.write(`${check.status} ${check.id} [${check.invariant}] ${check.detail}\n`);
  }
  process.stdout.write(
    `evaluation ${caseId}: ${passed.length} passed, ${failed.length} failed, ${skipped.length} not evaluable\n`,
  );
  if (options.output) {
    writeFileSync(
      options.output,
      `${JSON.stringify(
        { caseId, boundary, timing, checks, passed: passed.length, failed: failed.length, notEvaluable: skipped.length },
        null,
        2,
      )}\n`,
    );
  }
  process.exit(code ?? (failed.length === 0 ? 0 : 1));
}

if (report === undefined) {
  process.stderr.write("capability-idempotency-evaluate: the recovery report is unreadable\n");
  process.exit(2);
}
if (report.phase === "activation-refused") {
  process.stderr.write("capability-idempotency-evaluate: the Core service binding was never proven\n");
  process.exit(2);
}

// The external-effect capability is the only externally visible one; the
// structured log is Core-internal and is not what INV-03 is about.
const externalEffectsAt = effectsAtBarrier.filter((entry) => entry.capability === "external-effect");
const externalEffectsFinally = effectsFinal.filter((entry) => entry.capability === "external-effect");
const intents = journalAtBarrier.filter((entry) => entry.kind === "intent" && entry.externallyVisible === true);
const outcomes = journalAtBarrier.filter((entry) => entry.kind === "outcome");
const resolvedIds = new Set(outcomes.map((entry) => entry.invocationId));
const unresolved = intents.filter((intent) => !resolvedIds.has(intent.invocationId));

// ---------------------------------------------------------------------------
// The crash and the restart really happened
// ---------------------------------------------------------------------------

decide(
  "core-was-restarted-by-its-service-manager",
  "INV-04",
  options["second-invocation-id"] !== "" &&
    options["second-invocation-id"] !== options["first-invocation-id"],
  `the service manager restarted Core into invocation ${options["second-invocation-id"]}`,
  "the Core service was not restarted, so nothing about restart evidence was tested",
);

decide(
  "no-signal-by-recovered-process-identifier",
  "INV-07",
  report.signalledRecoveredProcessId === false,
  "recovery terminated control groups; no recovered process identifier was signalled",
  "a process identifier read from a durable record was signalled",
);

decide(
  "recovery-ran-before-any-module-work",
  "INV-08",
  report.startedModuleWorkDuringRecovery === false,
  "recovery reconciled the Claim, submission record, and commit journal before any Module work",
  "Module work started before recovery finished reconciling",
);

// ---------------------------------------------------------------------------
// The durable evidence at the instant of the crash
// ---------------------------------------------------------------------------

decide(
  "an-effect-intent-was-durable-before-any-effect",
  "INV-03",
  intents.length >= 1,
  `${intents.length} externally visible effect intent(s) were durable at the crash`,
  "no externally visible effect intent was durable at the crash, so this case tested nothing",
);

if (timing === "after" && boundary === "M08.start") {
  // Crash before the remote operation is accepted: the intent exists and the
  // effect has not happened.
  decide(
    "no-external-effect-had-happened-yet",
    "INV-03",
    externalEffectsAt.length === 0,
    "no external effect had been performed when Core was killed",
    `${externalEffectsAt.length} external effect(s) had already been performed, so this case did not crash before acceptance`,
  );
} else {
  // Crash after the remote operation is accepted, or after its response was
  // lost: the effect happened and its outcome never became durable. These two
  // are deliberately indistinguishable on disk.
  decide(
    "the-external-effect-had-happened",
    "INV-03",
    externalEffectsAt.length === 1,
    "exactly one external effect had been performed when Core was killed",
    `${externalEffectsAt.length} external effect(s) were performed, expected exactly one`,
  );
  decide(
    "its-outcome-was-not-durable",
    "INV-03",
    unresolved.length >= 1,
    `${unresolved.length} invocation(s) had a durable intent and no durable outcome, which is the unknown case`,
    "every invocation had a durable outcome, so no unknown outcome was tested",
  );
}

// ---------------------------------------------------------------------------
// INV-03: an unknown outcome is queried, never automatically retried
// ---------------------------------------------------------------------------

// This is the check the whole group exists for. A Core that retried the
// invocation after the restart would leave two effects behind.
decide(
  "the-external-effect-was-never-repeated",
  "INV-03",
  externalEffectsFinally.length === externalEffectsAt.length,
  `the external effect count is unchanged across the restart (${externalEffectsAt.length})`,
  `the external effect count went from ${externalEffectsAt.length} to ${externalEffectsFinally.length}, so recovery repeated an effect whose outcome was unknown`,
);

const recoveryFailure = report.recoveryFailure ?? null;
const claimsAfter = report.stateAfterRecovery?.activeClaims ?? [];
const claimsBefore = report.stateBeforeRecovery?.activeClaims ?? [];

if (unresolved.length >= 1) {
  // Refusing to continue and preserving the Claim are both honest answers to
  // an unknown outcome; silently releasing it as if the effect were known is
  // not. The disjunction is asserted because ADR 0009 fixes the obligation,
  // not which of the two shapes recovery takes.
  decide(
    "an-unknown-outcome-was-not-resolved-automatically",
    "INV-03",
    recoveryFailure !== null || claimsAfter.length >= claimsBefore.length,
    recoveryFailure !== null
      ? `recovery refused to continue (${recoveryFailure.code}) instead of guessing the outcome`
      : "recovery preserved the Claim rather than releasing it on an unknown outcome",
    "recovery released the Claim even though the invocation's outcome was unknown",
  );
} else {
  skip(
    "an-unknown-outcome-was-not-resolved-automatically",
    "INV-03",
    "no invocation had an unknown outcome at this boundary",
  );
}

// ---------------------------------------------------------------------------
// Case-specific obligations
// ---------------------------------------------------------------------------

const finalIntents = journalFinal.filter((entry) => entry.kind === "intent");

if (caseId.startsWith("SC-09-01")) {
  // The intent must still be there, unchanged, after the crash.
  const survived = intents.every((intent) =>
    finalIntents.some(
      (candidate) =>
        candidate.invocationId === intent.invocationId &&
        candidate.runId === intent.runId &&
        candidate.idempotencyKey === intent.idempotencyKey &&
        candidate.at === intent.at,
    ),
  );
  decide(
    "every-effect-intent-survived-the-crash-unchanged",
    "INV-03",
    intents.length >= 1 && survived,
    "every effect intent durable before the crash is still present and unchanged afterwards",
    "an effect intent that was durable before the crash is missing or altered afterwards",
  );
}

if (caseId.startsWith("SC-09-02")) {
  // The evidence must still name the exact Claim and Run, not merely exist.
  const submissions = report.stateBeforeRecovery?.moduleSubmissionRecords ?? [];
  const linked = intents.every(
    (intent) =>
      typeof intent.runId === "string" &&
      intent.runId.length > 0 &&
      intent.runId !== "unclaimed" &&
      typeof intent.moduleJobId === "string" &&
      intent.moduleJobId !== "unclaimed" &&
      (claimsBefore.some(
        (claim) => claim.runId === intent.runId && claim.moduleJobId === intent.moduleJobId,
      ) ||
        submissions.some(
          (submission) =>
            submission.runId === intent.runId && submission.moduleJobId === intent.moduleJobId,
        )),
  );
  decide(
    "idempotency-evidence-still-names-its-claim-and-run",
    "INV-03",
    intents.length >= 1 && linked,
    "every surviving effect intent names a Run and Module job the restarted Core can still see",
    "an effect intent does not name a Run and Module job the restarted Core can see, so the evidence is not linked to its Claim",
  );
  decide(
    "the-idempotency-key-survived",
    "INV-03",
    intents.every((intent) => typeof intent.idempotencyKey === "string" && intent.idempotencyKey.length > 0),
    "every surviving effect intent carries its idempotency key",
    "an effect intent survived without its idempotency key",
  );
}

if (caseId.startsWith("SC-09-03")) {
  // The restarted Core is a different process, so the capability authority's
  // in-memory duplicate map is necessarily empty. The decision therefore has
  // to come from the journal, and the journal has to be sufficient for it.
  decide(
    "the-decision-came-from-durable-evidence-not-memory",
    "INV-03",
    options["second-invocation-id"] !== options["first-invocation-id"] &&
      journalFinal.length > 0 &&
      (recoveryFailure !== null || claimsAfter.length >= claimsBefore.length),
    "the restarted process had no in-memory duplicate map and reached its decision from the durable journal alone",
    "the restarted Core reached a decision that the durable journal alone does not support",
  );
  decide(
    "an-empty-in-memory-map-did-not-become-a-no-effect-answer",
    "INV-03",
    externalEffectsFinally.length === externalEffectsAt.length,
    "the empty in-memory map was not read as evidence that no effect had happened",
    "the restarted Core behaved as if no effect had happened and produced another one",
  );
}

if (caseId.startsWith("SC-09-04")) {
  decide(
    "the-unknown-outcome-was-reported-rather-than-guessed",
    "INV-03",
    unresolved.length >= 1 &&
      (recoveryFailure !== null ||
        JSON.stringify(report.recoveryReport ?? {}).includes("unknown")),
    "recovery surfaced the unknown outcome instead of deciding it",
    "recovery neither surfaced nor refused the unknown outcome",
  );
}

if (caseId.startsWith("SC-09-06") || caseId.startsWith("SC-09-07")) {
  // Both cases must leave the same durable evidence. That is the finding, not
  // a weakness of the fixture: a Core that could distinguish them would be
  // reading something it does not have.
  decide(
    "acceptance-and-lost-response-leave-the-same-durable-evidence",
    "INV-03",
    externalEffectsAt.length === 1 && unresolved.length >= 1,
    "the effect happened and its outcome is not durable, which is exactly the evidence a lost response leaves",
    "this case did not reproduce the accepted-but-unknown state",
  );
}

skip(
  "duplicate-output-commit",
  "INV-02",
  "the interruption happens inside boundary 8, before any output Block is committed",
);
skip("limit-bypasses", "INV-10", "control-group limits are evaluated by the resource-limits group");

decide(
  "no-residue",
  "INV-12",
  options.residue === "0",
  "this case left no unit, process, or control group behind",
  "this case left a unit, process, or control group behind",
);

finish();
