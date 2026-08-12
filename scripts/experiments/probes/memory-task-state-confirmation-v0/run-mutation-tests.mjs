#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../../..");
const runsRoot = path.join(
  repositoryRoot,
  "artifacts/experiments/probes/memory-task-state-confirmation-v0/runs",
);
const mutationRoot = path.join(
  repositoryRoot,
  "artifacts/experiments/probes/memory-task-state-confirmation-v0/verification-mutations",
);
const HASHED_FILES = [
  "analysis.json",
  "cases.jsonl",
  "dataset.jsonl",
  "model-raw.jsonl",
  "preregistration.json",
];
const DIGEST_KEYS = {
  "analysis.json": "analysis",
  "cases.jsonl": "cases",
  "dataset.jsonl": "dataset",
  "model-raw.jsonl": "modelRaw",
  "preregistration.json": "preregistration",
};

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--run-id" ||
    !/^aether-v1-[a-zA-Z0-9._-]+$/u.test(argv[1])) {
    throw new Error("usage: run-mutation-tests.mjs --run-id aether-v1-<suffix>");
  }
  return argv[1];
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonLines(rows) {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

async function readRows(directory, name) {
  return (await readFile(path.join(directory, name), "utf8"))
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function refreshIntegrity(directory) {
  const manifestPath = path.join(directory, "run-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const name of HASHED_FILES) {
    const bytes = await readFile(path.join(directory, name));
    const key = DIGEST_KEYS[name];
    if (manifest.rawOutputs?.[key]) {
      manifest.rawOutputs[key].sha256 = sha256(bytes);
      if (name.endsWith(".jsonl")) {
        manifest.rawOutputs[key].rows = bytes.toString("utf8").trimEnd().split("\n").length;
      }
    }
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const checksums = [];
  for (const name of [...HASHED_FILES].sort()) {
    checksums.push(`${sha256(await readFile(path.join(directory, name)))}  ${name}`);
  }
  await writeFile(path.join(directory, "sha256sums.txt"), `${checksums.join("\n")}\n`);
}

function firstFixtureSecret(bytes) {
  for (const line of bytes.toString("utf8").split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:AETHER_API_KEY|AETHER_BASE_URL)\s*=\s*(.*)\s*$/u);
    if (!match) continue;
    let value = match[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value) return value;
  }
  throw new Error("configured fixture value is unavailable");
}

async function main() {
  const runId = parseArguments(process.argv.slice(2));
  const source = path.join(runsRoot, runId);
  const parent = path.join(mutationRoot, runId);
  await mkdir(parent, { recursive: true });
  const fixtureSecret = firstFixtureSecret(await readFile(path.join(repositoryRoot, ".env")));
  const mutations = [
    {
      id: "remove-case",
      mutate: async (directory) => {
        const rows = await readRows(directory, "cases.jsonl");
        rows.pop();
        await writeFile(path.join(directory, "cases.jsonl"), jsonLines(rows));
        await refreshIntegrity(directory);
      },
    },
    {
      id: "flip-stream-false",
      mutate: async (directory) => {
        const rows = await readRows(directory, "model-raw.jsonl");
        rows[0].request.stream = false;
        await writeFile(path.join(directory, "model-raw.jsonl"), jsonLines(rows));
        await refreshIntegrity(directory);
      },
    },
    {
      id: "inject-enable-thinking",
      mutate: async (directory) => {
        const rows = await readRows(directory, "model-raw.jsonl");
        rows[0].request.enable_thinking = false;
        await writeFile(path.join(directory, "model-raw.jsonl"), jsonLines(rows));
        await refreshIntegrity(directory);
      },
    },
    {
      id: "retry-http200-content",
      mutate: async (directory) => {
        const rows = await readRows(directory, "model-raw.jsonl");
        const first = rows[0];
        first.failureKind = "content-or-schema";
        first.contentFailure = "synthetic mutation";
        rows.splice(1, 0, {
          ...first,
          callIndex: Math.max(...rows.map((row) => row.callIndex)) + 1,
          attemptIndex: 2,
          failureKind: null,
          contentFailure: null,
        });
        await writeFile(path.join(directory, "model-raw.jsonl"), jsonLines(rows));
        await refreshIntegrity(directory);
      },
    },
    {
      id: "swap-scenario-output",
      mutate: async (directory) => {
        const rows = await readRows(directory, "cases.jsonl");
        [rows[0].output, rows[1].output] = [rows[1].output, rows[0].output];
        await writeFile(path.join(directory, "cases.jsonl"), jsonLines(rows));
        await refreshIntegrity(directory);
      },
    },
    {
      id: "accept-duplicate-citation-as-extra-claim",
      mutate: async (directory) => {
        const rows = await readRows(directory, "cases.jsonl");
        rows[0].metrics.claimCoverage = 1;
        rows[0].metrics.semanticSuccess = 1;
        rows[0].metrics.corroborationCount = 99;
        await writeFile(path.join(directory, "cases.jsonl"), jsonLines(rows));
        await refreshIntegrity(directory);
      },
    },
    {
      id: "remove-artifact-digest",
      mutate: async (directory) => {
        const manifestPath = path.join(directory, "run-manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        delete manifest.rawOutputs.cases;
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      },
    },
    {
      id: "inject-configured-secret",
      mutate: async (directory) => {
        const manifestPath = path.join(directory, "run-manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        manifest.note = fixtureSecret;
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      },
    },
  ];

  const results = [];
  for (const mutation of mutations) {
    const target = path.join(parent, mutation.id);
    await mkdir(target);
    await cp(source, target, { recursive: true, force: false, errorOnExist: true });
    await mutation.mutate(target);
    let rejected = false;
    let verifierOutput = "";
    try {
      verifierOutput = execFileSync(process.execPath, [
        path.join(scriptDirectory, "verify.mjs"),
        "--run-directory",
        target,
        "--no-write",
      ], {
        cwd: repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      rejected = true;
      verifierOutput = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    results.push({ mutationId: mutation.id, rejected, verifierOutput: verifierOutput.slice(0, 4096) });
    if (!rejected) throw new Error(`verifier accepted mutation ${mutation.id}`);
  }
  const summary = {
    schemaVersion: "memory-task-state-confirmation/mutation-summary-v1",
    runId,
    mutationCount: results.length,
    rejectedCount: results.filter((result) => result.rejected).length,
    results,
  };
  await writeFile(path.join(parent, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, {
    flag: "wx",
  });
  process.stdout.write(`${JSON.stringify({
    runId,
    mutationCount: summary.mutationCount,
    rejectedCount: summary.rejectedCount,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
