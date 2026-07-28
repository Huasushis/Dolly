#!/usr/bin/env node
// Invariant evaluation for one live Core termination case.
//
// The handler runs the experiment; this decides what the evidence means, from
// the stand-in's report and the run's own trace. Every check names the
// invariant it comes from, and a check whose subject does not exist at this
// point is reported `not-evaluable` rather than counted either way.
//
// Exit codes:
//   0  every evaluable check passed
//   1  at least one failed
//   2  the evaluation could not be performed
//   3  the case is structurally impossible, proven from this run's evidence
//   4  the case definition and the shipped pre-membership design disagree

import { readFileSync, writeFileSync } from "node:fs";

/**
 * What a `before membership` case is required to prove.
 *
 * Catalogue version 1 asked all sixteen cases for "control-group-level
 * termination proven by populated 0". The shipped design refuses to give that
 * for the pre-membership phase on purpose: `ModuleCgroup.terminate` returns
 * `MODULE_CGROUP_MEMBERSHIP_UNOBSERVED` for a group whose membership was never
 * observed, because an empty reading there would only repeat the state the
 * group had before anything joined. ADR 0009 directs that phase to the
 * launcher's control descriptor instead.
 *
 * That disagreement was adjudicated by revising the catalogue, not this file:
 * a criterion the person running the cases can rewrite when the cases fail is
 * not a pre-registered criterion. Catalogue version 2 splits the requirement by
 * phase and, for this phase, requires the launcher-control-descriptor path
 * *and* that a `populated 0` proof was refused rather than reported.
 *
 * The second half is a strengthening, not a relaxation. It makes the refusal
 * itself an invariant under test: if a later change let this phase report
 * `populated 0`, these cases go red.
 *
 * Results produced under catalogue version 1 used the superseded single
 * criterion and MUST NOT be merged with these.
 */
const PRE_MEMBERSHIP_POLICY = "launcher-control-descriptor";

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
  process.stderr.write("live-core-termination-evaluate: arguments must be --name value pairs\n");
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
const record = (id, invariant, status, detail) => checks.push({ id, invariant, status, detail });
const pass = (id, invariant, detail) => record(id, invariant, "passed", detail);
const fail = (id, invariant, detail) => record(id, invariant, "failed", detail);
const skip = (id, invariant, detail) => record(id, invariant, "not-evaluable", detail);
const decide = (id, invariant, condition, passDetail, failDetail) =>
  condition ? pass(id, invariant, passDetail) : fail(id, invariant, failDetail);

const report = readJson(options.report);
const trace = readLines(options.trace);
const reason = options.reason;
const membership = options.membership;
const wantsDescendant = options.descendant === "forked";

function finish(code) {
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
          terminationReason: reason,
          membershipTiming: membership,
          descendant: options.descendant,
          preMembershipPolicy: PRE_MEMBERSHIP_POLICY,
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
  process.exit(code ?? (failed.length === 0 ? 0 : 1));
}

if (report === undefined) {
  process.stderr.write("live-core-termination-evaluate: the stand-in report is unreadable\n");
  process.exit(2);
}
if (report.phase !== "live-termination-complete") {
  fail(
    "standin-completed-the-case",
    "INV-04",
    `the stand-in stopped in phase ${String(report.phase)} instead of completing the termination`,
  );
  finish(1);
}

const generations = Array.isArray(report.generations) ? report.generations : [];
const first = generations[0];
if (first === undefined) {
  fail("module-generation-started", "INV-01", "the stand-in reported no Module generation at all");
  finish(1);
}

// ---------------------------------------------------------------------------
// The Core service stayed alive across the Module's termination
// ---------------------------------------------------------------------------

// This is the whole premise of the group: unlike the interruption matrix, no
// Core is killed here. The evidence is the service manager's own invocation
// identity, not the stand-in's claim about itself.
decide(
  "core-service-was-never-restarted",
  "INV-04",
  options["first-invocation-id"] !== "" &&
    options["first-invocation-id"] === options["last-invocation-id"] &&
    options.restarts === "0",
  `the Core service kept one invocation (${options["first-invocation-id"]}) and restarted ${options.restarts} time(s)`,
  `the Core service invocation changed from ${options["first-invocation-id"]} to ${options["last-invocation-id"]} with NRestarts=${options.restarts}, so Core did not stay alive`,
);

decide(
  "module-started-inside-the-validated-core-service",
  "INV-04",
  typeof report.binding?.serviceInvocationId === "string" &&
    report.binding.serviceInvocationId.length > 0,
  "the Module was started under a verified Core service binding",
  "the Module was started without a verified Core service binding",
);

decide(
  "declared-core-capabilities-only",
  "INV-05",
  first.started === false || first.executionAuthorized === true,
  "the Module process record declared core-capabilities-only external effects",
  "the Module was activated without the declared external-effect configuration",
);

decide(
  "no-signal-by-recovered-process-identifier",
  "INV-07",
  report.signalledRecoveredProcessId === false,
  "termination addressed the control group; no recovered process identifier was signalled",
  "a process identifier from a durable record was signalled",
);

// ---------------------------------------------------------------------------
// The pre-membership half
// ---------------------------------------------------------------------------

if (membership === "before") {
  const authorized = first.executionAuthorized === true;
  const failureCode = first.startFailure?.code;

  decide(
    "execution-was-never-authorized",
    "INV-01",
    !authorized,
    `Core stopped the start before authorizing execution (${String(failureCode)})`,
    "execution was authorized even though the case stops before membership is verified",
  );

  // The trace is written before each step proceeds, so it is the run's own
  // ordered record. `pre-membership-stop-requested` can only have been appended
  // from inside the shipped `stopRequested` seam, which runs after the launcher
  // joined the group and before Core verified it.
  const reachedSeam = trace.some((line) => line.includes("pre-membership-stop-requested"));
  decide(
    "stop-was-requested-at-the-pre-membership-seam",
    "INV-01",
    reachedSeam,
    "the stop was requested after the launcher joined the group and before Core verified membership",
    "the run never reached the pre-membership stop seam",
  );

  if (wantsDescendant) {
    // Structural impossibility, established from this run rather than asserted
    // from the case name: the Extension only exists after `exec`, and `exec` is
    // authorized only after membership is verified.
    if (!authorized && reachedSeam && first.descendantStarted === false) {
      skip(
        "descendant-before-membership",
        "INV-01",
        "the Extension is executed only after membership is verified, so it cannot fork a descendant before that point; this run reached the pre-membership seam with execution never authorized and no descendant started",
      );
      finish(3);
    }
    fail(
      "descendant-before-membership",
      "INV-01",
      "the case expects no descendant to be possible here, but this run did not show that",
    );
    finish(1);
  }

  decide(
    "launcher-exit-was-observed",
    "INV-01",
    first.startFailure?.coreMustExit === false,
    "the launcher's exit through its control descriptor was observed, so Core did not have to exit",
    "the launcher's exit could not be observed, so ADR 0009 requires Core to exit and let the service cleanup remove the group",
  );

  decide(
    "no-process-remains-in-the-module-group",
    "INV-01",
    Array.isArray(first.membersAfterStop) && first.membersAfterStop.length === 0,
    "the Module control group holds no process after the pre-membership stop",
    `${(first.membersAfterStop ?? []).length} process(es) remain in the Module control group`,
  );

  if (PRE_MEMBERSHIP_POLICY === "report-disagreement") {
    skip(
      "group-termination-proven-by-populated-zero",
      "INV-06",
      `the case requires a "populated 0" proof, and the shipped pre-membership path deliberately does not produce one (${String(
        first.groupTerminationSkippedBecause,
      )}); this disagreement is reported rather than resolved here`,
    );
    decide(
      "no-residue",
      "INV-12",
      options.residue === "0",
      "this case left no unit, process, or control group behind",
      "this case left a unit, process, or control group behind",
    );
    finish(4);
  }

  // Catalogue version 2, first half: this phase never performs a group
  // termination, so nothing may be left behind by one either.
  decide(
    "the-group-was-removed-without-a-group-termination",
    "INV-06",
    first.groupTerminationAttempted === false &&
      (first.populatedAfterStop === "0" || first.populatedAfterStop === null),
    "the launcher-control-descriptor path stopped the launcher and left no process in the group",
    `the Module control group still reported populated ${String(first.populatedAfterStop)}`,
  );

  // Catalogue version 2, second half, and the reason this revision is a
  // strengthening: the refusal is asked for and must happen. The stand-in
  // reopens the group and asks the shipped code to prove it empty; a group
  // never observed to hold a process must answer
  // MODULE_CGROUP_MEMBERSHIP_UNOBSERVED. A run in which that proof succeeded
  // is a failure of this case even though nothing crashed.
  const probe = first.populatedZeroRefusalProbe ?? {};
  decide(
    "a-populated-zero-proof-was-refused-for-this-phase",
    "INV-06",
    probe.ran === true &&
      probe.refused === true &&
      probe.code === "MODULE_CGROUP_MEMBERSHIP_UNOBSERVED",
    `the shipped code refused to prove this group empty before membership was observed (${String(probe.code)})`,
    probe.ran === true
      ? `the shipped code did not refuse a populated 0 proof for the pre-membership phase (${String(
          probe.code ?? probe.evidence,
        )}: ${String(probe.detail)})`
      : `the refusal could not be tested: ${String(probe.reason)}`,
  );

  decide(
    "no-residue",
    "INV-12",
    options.residue === "0",
    "this case left no unit, process, or control group behind",
    "this case left a unit, process, or control group behind",
  );
  finish();
}

// ---------------------------------------------------------------------------
// The post-membership half: whole-group termination proven by `populated 0`
// ---------------------------------------------------------------------------

decide(
  "execution-was-authorized-after-membership-was-verified",
  "INV-01",
  first.started === true && first.executionAuthorized === true,
  "Core verified control-group membership and then authorized execution",
  `the Module never reached the running state (${String(first.startFailure?.code)})`,
);

if (wantsDescendant) {
  decide(
    "descendant-existed-before-termination",
    "INV-01",
    first.descendantStarted === true && Number.isInteger(first.descendantPid),
    `the Extension confirmed descendant ${String(first.descendantPid)} before Core terminated anything`,
    "the Extension never confirmed a descendant, so this case would not test group-level termination",
  );
  // The descendant is started with `start_new_session`, so it is not in the
  // Extension's process group. Two members is what distinguishes group
  // termination from a process-group signal; one member would mean the case
  // proved nothing even if it went on to pass.
  const members = Array.isArray(first.membersBeforeTermination)
    ? first.membersBeforeTermination
    : [];
  decide(
    "module-group-held-the-extension-and-its-descendant",
    "INV-01",
    members.length >= 2,
    `the Module control group held ${members.length} processes before termination`,
    `the Module control group held ${members.length} process(es), so a descendant outside the Extension's process group was not present to be terminated`,
  );
} else {
  skip(
    "module-group-held-a-descendant",
    "INV-01",
    "this case runs without a descendant by design",
  );
}

const outcome = first.terminationOutcome ?? {};
decide(
  "group-termination-proven-by-populated-zero",
  "INV-06",
  outcome.terminated === true,
  "the Module control group was terminated and proven empty by cgroup.events reporting populated 0",
  `the Module control group was not proven empty (${String(outcome.code)}: ${String(outcome.detail)})`,
);

decide(
  "no-process-survived-the-group-termination",
  "INV-06",
  Array.isArray(first.membersAfterTermination) && first.membersAfterTermination.length === 0,
  "no process remained in the Module control group after termination",
  `${(first.membersAfterTermination ?? []).length} process(es) survived the group termination`,
);

decide(
  "module-process-record-reached-stopped",
  "INV-01",
  first.recordState === "stopped",
  "the Module process record moved to stopped only after the group was proven empty",
  `the Module process record is in state ${String(first.recordState)}`,
);

if (reason === "hard-timeout") {
  decide(
    "hard-timeout-actually-expired",
    "INV-03",
    first.hardTimeoutExpired === true,
    "Core's own finite deadline expired before it terminated the Module",
    "the deadline never expired, so this case did not exercise a hard timeout",
  );
} else {
  skip("hard-timeout-actually-expired", "INV-03", `this case terminates for ${reason}`);
}

if (reason === "replacement") {
  // INV-06 in its strictest form: the replacement may not start until the old
  // group is proven empty.
  decide(
    "replacement-started-only-after-the-old-group-was-proven-empty",
    "INV-06",
    report.replacementStartedAfterProof === true,
    "the replacement generation started only after the old control group was proven empty",
    "a replacement generation started without proof that the old control group was empty",
  );
  const second = generations[1];
  decide(
    "replacement-generation-ran-and-was-itself-terminated",
    "INV-01",
    second !== undefined && second.terminationOutcome?.terminated === true,
    "the replacement generation started, ran, and was itself terminated with a proven empty group",
    "the replacement generation did not complete a proven termination",
  );
  // Two generations existed in sequence, never at once: the first is proven
  // empty before the second starts, which is what INV-01 bounds.
  decide(
    "never-more-than-one-live-process-generation",
    "INV-01",
    generations.length <= 2 &&
      generations.every((generation) => generation.recordState === "stopped"),
    `${generations.length} Module generation(s) ran in sequence and each ended stopped`,
    "a Module generation was left live alongside another",
  );
} else {
  skip(
    "replacement-started-only-after-the-old-group-was-proven-empty",
    "INV-06",
    `this case terminates for ${reason} and starts no replacement`,
  );
  decide(
    "never-more-than-one-live-process-generation",
    "INV-01",
    generations.length === 1,
    "exactly one Module process generation existed",
    `${generations.length} Module process generations existed for a case that starts no replacement`,
  );
}

// The stand-in never receives an Extension result in this mode, so there is no
// commit to duplicate and no unknown outcome to retry. Both are recorded as not
// evaluable rather than as free passes.
skip("no-duplicate-output-commit", "INV-02", "a live-termination case commits no output Block");
if (reason !== "hard-timeout") {
  skip("no-unknown-outcome-retried", "INV-03", "no Extension outcome was pending at termination");
}
skip(
  "declared-environment-observed",
  "INV-09",
  "the Extension environment is compared in the fixed interruption matrix; this case terminates the Module before any result",
);
skip(
  "limit-bypasses",
  "INV-10",
  "control-group limits are evaluated by the resource-limits group",
);
skip(
  "unreconciled-references-or-leases",
  "INV-11",
  "this case opens no Claim, so it holds no strong reference or access lease",
);

decide(
  "no-residue",
  "INV-12",
  options.residue === "0",
  "this case left no unit, process, or control group behind",
  "this case left a unit, process, or control group behind",
);

finish();
