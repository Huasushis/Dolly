import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SEEDS, sha256File } from "./common.mjs";
import {
  ABLATION_POLICIES,
  LOAD_PROFILES,
  PRIMARY_POLICIES,
  SIMULATION_TOPOLOGIES,
  runSimulationCase,
} from "./simulate.mjs";

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
const policies = [...PRIMARY_POLICIES, ...ABLATION_POLICIES];
const matrix = SIMULATION_TOPOLOGIES.flatMap((topologyId) =>
  LOAD_PROFILES.flatMap((loadProfile) =>
    policies.flatMap((policyId) =>
      SEEDS.map((seed) => ({ topologyId, loadProfile, policyId, seed })),
    ),
  ),
);

if (process.argv.slice(2).includes("--list")) {
  process.stdout.write(
    `${JSON.stringify({ cases: matrix.length, matrix }, null, 2)}\n`,
  );
  process.exit(0);
}
if (process.argv.length > 2) {
  throw new Error(`unsupported arguments: ${process.argv.slice(2).join(" ")}`);
}

const preregistration = JSON.parse(
  readFileSync(preregistrationPath, "utf8"),
);
if (preregistration.experimentId !== "scheduler-effect-v0") {
  throw new Error("unexpected preregistration experimentId");
}
if (preregistration.status !== "locked-before-first-run") {
  throw new Error("preregistration is not locked-before-first-run");
}

mkdirSync(rawDirectory, { recursive: true });
const startedAt = new Date().toISOString();
const results = [];
for (const [index, item] of matrix.entries()) {
  const caseId = `simulation__${item.topologyId}__${item.loadProfile}__${item.policyId}__seed-${item.seed}`;
  const rawPath = resolve(rawDirectory, `${caseId}.jsonl`);
  results.push(runSimulationCase({ ...item, rawPath }));
  if ((index + 1) % 10 === 0 || index + 1 === matrix.length) {
    process.stdout.write(`completed ${index + 1}/${matrix.length} ${caseId}\n`);
  }
}

const implementationFiles = ["common.mjs", "simulate.mjs", "run.mjs"].map(
  (name) => {
    const path = resolve(scriptDirectory, name);
    return {
      path: `scripts/experiments/probes/scheduler-effect-v0/${name}`,
      sha256: sha256File(path),
    };
  },
);
const runResults = {
  schemaVersion: "dolly.scheduler-effect-run/0",
  experimentId: "scheduler-effect-v0",
  evidenceStatus: "pending-independent-analysis",
  startedAt,
  finishedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  preregistration: {
    path: "docs/experiments/preregistrations/scheduler-effect-v0.json",
    sha256: sha256File(preregistrationPath),
  },
  implementationFiles,
  expectedCaseCount: matrix.length,
  completedCaseCount: results.length,
  cases: results,
};
writeFileSync(runResultsPath, `${JSON.stringify(runResults, null, 2)}\n`, {
  flag: "wx",
});
process.stdout.write(`wrote ${runResultsPath}\n`);
