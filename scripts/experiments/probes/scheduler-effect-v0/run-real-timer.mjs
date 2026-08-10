import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SEEDS, sha256File } from "./common.mjs";
import { runRealTimerCase } from "./real-timer.mjs";
import {
  ABLATION_POLICIES,
  LOAD_PROFILES,
  PRIMARY_POLICIES,
} from "./simulate.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "../../../..");
const experimentDirectory = resolve(
  projectRoot,
  "artifacts/experiments/probes/scheduler-effect-v0",
);
const rawDirectory = resolve(experimentDirectory, "real-timing-raw");
const resultsPath = resolve(experimentDirectory, "real-timing-results.json");
const preregistrationPath = resolve(
  projectRoot,
  "docs/experiments/preregistrations/scheduler-effect-v0.json",
);
const preregistration = JSON.parse(readFileSync(preregistrationPath, "utf8"));
const policies = [...PRIMARY_POLICIES, ...ABLATION_POLICIES];
const matrix = LOAD_PROFILES.flatMap((loadProfile) =>
  policies.flatMap((policyId) =>
    SEEDS.map((seed, index) => ({
      loadProfile,
      policyId,
      seed,
      repetition: index + 1,
    })),
  ),
);
if (preregistration.repetitions.realTimingPerPolicy !== SEEDS.length) {
  throw new Error("real-timer repetition count does not match the frozen seeds");
}
mkdirSync(rawDirectory, { recursive: true });
const startedAt = new Date().toISOString();
const cases = [];
for (const [index, item] of matrix.entries()) {
  const caseId = `real-timer__line__${item.loadProfile}__${item.policyId}__rep-${item.repetition}`;
  cases.push(
    await runRealTimerCase({
      ...item,
      rawPath: resolve(rawDirectory, `${caseId}.jsonl`),
    }),
  );
  process.stdout.write(`completed real timer ${index + 1}/${matrix.length} ${caseId}\n`);
}
writeFileSync(
  resultsPath,
  `${JSON.stringify(
    {
      schemaVersion: "dolly.scheduler-effect-real-timer-run/0",
      experimentId: "scheduler-effect-v0",
      evidenceStatus: "portability-smoke-only",
      startedAt,
      finishedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
      preregistrationSha256: sha256File(preregistrationPath),
      implementationFiles: ["common.mjs", "real-timer.mjs", "run-real-timer.mjs"].map(
        (name) => ({ name, sha256: sha256File(resolve(scriptDirectory, name)) }),
      ),
      expectedCaseCount: matrix.length,
      completedCaseCount: cases.length,
      cases,
    },
    null,
    2,
  )}\n`,
  { flag: "wx" },
);
