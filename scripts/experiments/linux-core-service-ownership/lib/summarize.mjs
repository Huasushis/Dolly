#!/usr/bin/env node
// Turns the per-case result ledger into the machine-readable summary the
// protocol's "Artifacts" section requires, including failed and inconclusive
// cases, and decides the run verdict.
//
// Two rules from the protocol are enforced here rather than trusted from the
// case handlers:
//   * a case that did not retain every artifact it declared is inconclusive,
//     never passing; and
//   * a case in the ordered list that produced no result line at all is
//     inconclusive, never silently dropped.
//
// Usage:
//   node summarize.mjs --manifest FILE --results FILE --inventory-before FILE \
//     --inventory-after FILE --cleanup FILE --output FILE

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const TERMINAL_STATUSES = new Set(["passed", "failed", "inconclusive", "not-applicable"]);

function parseArguments(argv) {
  const options = {
    manifest: null,
    results: null,
    inventoryBefore: null,
    inventoryAfter: null,
    cleanup: null,
    output: null,
  };
  const single = {
    "--manifest": "manifest",
    "--results": "results",
    "--inventory-before": "inventoryBefore",
    "--inventory-after": "inventoryAfter",
    "--cleanup": "cleanup",
    "--output": "output",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = single[argv[index]];
    if (key === undefined) {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
    options[key] = argv[index + 1];
    index += 1;
  }
  for (const [name, value] of Object.entries(options)) {
    if (value === null) {
      throw new Error(`missing required argument for ${name}`);
    }
  }
  return options;
}

function readLines(path) {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function readResults(path) {
  const results = new Map();
  for (const line of readLines(path)) {
    const entry = JSON.parse(line);
    results.set(entry.caseId, entry);
  }
  return results;
}

// Residue is the difference between the inventory taken before the run and the
// one taken after cleanup. Anything the run added and did not remove violates
// invariant INV-12.
function residue(beforePath, afterPath) {
  const before = new Set(readLines(beforePath));
  const after = readLines(afterPath);
  const added = after.filter((line) => !before.has(line));
  return {
    beforeCount: before.size,
    afterCount: after.length,
    added,
    clean: added.length === 0,
  };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(options.manifest, "utf8"));
  const results = readResults(options.results);
  const cleanup = JSON.parse(readFileSync(options.cleanup, "utf8"));
  const leftover = residue(options.inventoryBefore, options.inventoryAfter);

  const byStatus = { passed: 0, failed: 0, inconclusive: 0, "not-applicable": 0 };
  const failed = [];
  const inconclusive = [];
  const baselineObservations = [];
  const invariantViolations = new Map();
  const evaluated = [];

  for (const declared of manifest.cases) {
    const result = results.get(declared.id);
    let status;
    let reason;
    let missingArtifacts = [];

    if (result === undefined) {
      status = "inconclusive";
      reason = "no-result-recorded";
    } else if (!TERMINAL_STATUSES.has(result.status)) {
      status = "inconclusive";
      reason = `unrecognised-status:${result.status}`;
    } else {
      status = result.status;
      reason = result.reason ?? null;
      const retained = new Set(result.artifacts ?? []);
      missingArtifacts = declared.requiredArtifacts.filter((name) => !retained.has(name));
      // A missing artifact makes the case inconclusive, not passing.
      if (missingArtifacts.length > 0 && status === "passed") {
        status = "inconclusive";
        reason = "required-artifact-missing";
      }
    }

    const entry = {
      caseId: declared.id,
      group: declared.group,
      arm: declared.arm,
      source: declared.source,
      enforcesInvariants: declared.enforcesInvariants,
      status,
      reason,
      missingArtifacts,
      exitCode: result?.exitCode ?? null,
      durationMs: result?.durationMs ?? null,
      retries: result?.retries ?? 0,
      timedOut: result?.timedOut ?? false,
      cleanupResult: result?.cleanupResult ?? null,
      invariantViolations: result?.invariantViolations ?? [],
      iterations: result?.iterations ?? 0,
    };
    evaluated.push(entry);
    byStatus[status] += 1;

    for (const violation of entry.invariantViolations) {
      invariantViolations.set(violation, (invariantViolations.get(violation) ?? 0) + 1);
    }
    if (status === "failed") {
      if (declared.enforcesInvariants) {
        failed.push(entry);
      } else {
        baselineObservations.push(entry);
      }
    }
    if (status === "inconclusive") {
      inconclusive.push(entry);
    }
  }

  const enforcingCases = evaluated.filter((entry) => entry.enforcesInvariants);
  const enforcingPassed = enforcingCases.filter((entry) => entry.status === "passed").length;
  const enforcingIncomplete = enforcingCases.filter((entry) => entry.status === "inconclusive").length;

  // A baseline arm exists to be weaker than the proposal, so its failures are
  // expected observations rather than defects. Counting both arms in one
  // tally produces output that reads as self-contradictory, such as
  // "failed 14" beside "verdict pass". The counts are therefore reported
  // separately, and only the enforcing tally shares the verdict's meaning.
  const tally = (entries) => {
    const counts = { passed: 0, failed: 0, inconclusive: 0, "not-applicable": 0 };
    for (const entry of entries) {
      if (counts[entry.status] !== undefined) counts[entry.status] += 1;
    }
    return counts;
  };
  const enforcingCounts = tally(enforcingCases);
  const baselineCounts = tally(evaluated.filter((entry) => !entry.enforcesInvariants));

  let verdict;
  let verdictReason;
  if (manifest.mode === "smoke") {
    // A smoke run checks the harness, not the hypotheses. It succeeds when the
    // harness produced a manifest, classified every case, and left no residue.
    // It never reports an experiment result.
    const unexpected = evaluated.filter((entry) => entry.status !== "inconclusive").length;
    verdict = leftover.clean && cleanup.ok && unexpected === 0 ? "harness-ok" : "harness-fail";
    verdictReason =
      verdict === "harness-ok"
        ? "every case was classified inconclusive as expected, cleanup succeeded, and no residue remains"
        : "the harness self-check did not hold; see cleanup, residue, and per-case status";
  } else if (failed.length > 0) {
    verdict = "fail";
    verdictReason = `${failed.length} case(s) that must satisfy the strict invariants failed`;
  } else if (!leftover.clean || !cleanup.ok) {
    verdict = "fail";
    verdictReason = "cleanup did not complete or test residue remains, violating INV-12";
  } else if (enforcingIncomplete > 0) {
    verdict = "incomplete";
    verdictReason = `${enforcingIncomplete} case(s) are inconclusive; the matrix is not complete`;
  } else {
    verdict = "pass";
    verdictReason = "every case that must satisfy the strict invariants passed with its artifacts";
  }

  const summary = {
    experiment: manifest.experiment,
    protocolVersion: manifest.protocolVersion,
    runId: manifest.runId,
    mode: manifest.mode,
    profile: manifest.profile,
    // A smoke run must never be read as evidence about the hypotheses.
    harnessSelfCheck: manifest.mode === "smoke",
    experimentResult: manifest.mode === "smoke" ? "none" : verdict,
    verdict,
    verdictReason,
    startedAt: manifest.startedAt,
    completedAt: new Date().toISOString(),
    caseCount: manifest.cases.length,
    counts: byStatus,
    // The verdict is a statement about the enforcing arm only.
    enforcingCounts,
    // Baseline failures are the experiment's expected observations.
    baselineCounts,
    enforcingCaseCount: enforcingCases.length,
    enforcingPassed,
    enforcingIncomplete,
    failed,
    inconclusive,
    baselineObservations,
    invariantViolations: [...invariantViolations].map(([id, count]) => ({ invariant: id, count })),
    // Carried through from the manifest so a reader of summary.json alone can
    // tell a narrowed run from a complete one. A run that excluded cases must
    // never be read as "the whole group passed".
    selection: manifest.selection ?? null,
    cleanup,
    residue: leftover,
    cases: evaluated,
  };

  writeFileSync(options.output, `${JSON.stringify(summary, null, 2)}\n`);

  // The enforcing arm is reported first because the verdict speaks only about
  // it. The baseline line is printed only when a baseline case ran, and it is
  // labelled as an observation so a reader does not mistake an expected
  // baseline failure for a defect.
  const baselineTotal = Object.values(baselineCounts).reduce((sum, n) => sum + n, 0);
  const report = [
    `experiment            ${summary.experiment}`,
    `run                   ${summary.runId} (mode ${summary.mode}, profile ${summary.profile})`,
    `cases                 ${summary.caseCount}`,
    `passed                ${enforcingCounts.passed}`,
    `failed                ${enforcingCounts.failed}`,
    `inconclusive          ${enforcingCounts.inconclusive}`,
    `not applicable        ${enforcingCounts["not-applicable"]}`,
    ...(baselineTotal === 0
      ? []
      : [
          `baseline observed     ${baselineCounts.passed} met, ` +
            `${baselineCounts.failed} did not meet, ` +
            `${baselineCounts.inconclusive} inconclusive, ` +
            `${baselineCounts["not-applicable"]} not applicable ` +
            `(expected: a baseline is not required to satisfy the invariants)`,
        ]),
    // A narrowed selection is printed where the counts are read, not only left
    // in the manifest. A reader who sees "passed" without seeing this line
    // would take a partial run for a complete one.
    ...(summary.selection && !summary.selection.complete
        ? [
            `selection             narrowed: ${summary.selection.selectedCaseCount} of ` +
              `${summary.selection.catalogCaseCount} case(s) (by ` +
              `${summary.selection.narrowedBy.join(", ")})` +
              (summary.selection.excludedIds.length > 0
                ? `; excluded ${summary.selection.excludedIds.join(", ")}`
                : ""),
          ]
        : []),
    `cleanup ok            ${cleanup.ok}`,
    `residue clean         ${leftover.clean}`,
    `verdict               ${summary.verdict} (${summary.verdictReason})`,
    `experiment result     ${summary.experimentResult}`,
  ].join("\n");
  process.stdout.write(`${report}\n`);

  // A failed or incomplete run must exit non-zero and stay a failed run.
  if (verdict === "pass" || verdict === "harness-ok") {
    process.exitCode = 0;
  } else if (verdict === "incomplete") {
    process.exitCode = 4;
  } else {
    process.exitCode = 1;
  }
}

main();
