#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../../..");
const sourceRun = path.join(
  repositoryRoot,
  "artifacts/experiments/probes/camoufox-agent-stream-v0/live-20260812c",
);
const auditRoot = path.join(
  repositoryRoot,
  "artifacts/experiments/probes/camoufox-agent-stream-v0/verifier-audit-v4-20260812a",
);
const verifier = path.join(scriptDirectory, "verify.mjs");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function rewriteJsonLines(filePath, mutate) {
  const rows = (await readFile(filePath, "utf8")).trimEnd().split("\n").map(JSON.parse);
  await writeFile(filePath, `${rows.map((row, index) => JSON.stringify(mutate(row, index))).join("\n")}\n`);
}

const mutations = [
  {
    id: "removed-relevant-source-hash",
    apply: async (root) => {
      const filePath = path.join(root, "run.json");
      const run = await readJson(filePath);
      delete run.relevantSourceHashes[Object.keys(run.relevantSourceHashes).sort()[0]];
      await writeJson(filePath, run);
    },
  },
  {
    id: "extra-artifact",
    apply: async (root) => writeFile(path.join(root, "undeclared.txt"), "unexpected\n"),
  },
  {
    id: "stream-false",
    apply: async (root) => rewriteJsonLines(
      path.join(root, "agent-r1/model-calls.jsonl"),
      (row, index) => index === 0 ? { ...row, request: { ...row.request, stream: false } } : row,
    ),
  },
  {
    id: "done-count-zero",
    apply: async (root) => rewriteJsonLines(
      path.join(root, "agent-r1/model-calls.jsonl"),
      (row, index) => index === 0
        ? { ...row, streamEvidence: { ...row.streamEvidence, doneCount: 0 } }
        : row,
    ),
  },
  {
    id: "wrong-final-state",
    apply: async (root) => {
      await rewriteJsonLines(path.join(root, "agent-r1/events.jsonl"), (row) =>
        row.event === "host_final_state"
          ? { ...row, state: { ...row.state, appliedCount: 2 } }
          : row);
      const casePath = path.join(root, "agent-r1/case.json");
      const summary = await readJson(casePath);
      summary.finalState.appliedCount = 2;
      await writeJson(casePath, summary);
    },
  },
  {
    id: "wrong-png-pixel-with-updated-digest",
    apply: async (root) => {
      const relative = "agent-r1/screenshots/model-screenshot-01.png";
      const imagePath = path.join(root, relative);
      const image = sharp(imagePath);
      const metadata = await image.metadata();
      const { data, info } = await image.removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const offset = (10 * info.width + 10) * info.channels;
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      const mutated = await sharp(data, {
        raw: { width: info.width, height: info.height, channels: info.channels },
      }).png().toBuffer();
      await writeFile(imagePath, mutated);
      let changedEvent = null;
      await rewriteJsonLines(path.join(root, "agent-r1/events.jsonl"), (row) => {
        if (row.event !== "model_tool_result" || row.name !== "browser_take_screenshot") return row;
        const imageEvidence = row.result?.images?.[0];
        if (imageEvidence?.name !== "model-screenshot-01.png") return row;
        changedEvent = {
          ...row,
          result: {
            ...row.result,
            images: [{
              ...imageEvidence,
              byteLength: mutated.length,
              sha256: sha256(mutated),
              metadataWidth: metadata.width,
            }],
          },
        };
        return changedEvent;
      });
      await rewriteJsonLines(path.join(root, "agent-r1/model-calls.jsonl"), (row) => {
        if (row.round <= changedEvent.round) return row;
        return {
          ...row,
          request: {
            ...row.request,
            messages: row.request.messages.map((message) =>
              message.role === "tool" && message.tool_call_id === changedEvent.callId
                ? { ...message, content: JSON.stringify(changedEvent.result) }
                : message),
          },
        };
      });
    },
  },
  {
    id: "reasoning-flag-false",
    apply: async (root) => rewriteJsonLines(
      path.join(root, "agent-r1/model-calls.jsonl"),
      (row, index) => index === 0 ? { ...row, reasoningPresent: false } : row,
    ),
  },
  {
    id: "recorded-process-left",
    apply: async (root) => {
      const casePath = path.join(root, "agent-r1/case.json");
      const summary = await readJson(casePath);
      summary.remainingRecordedProcesses = [{ pid: 1, startTicks: 1 }];
      await writeJson(casePath, summary);
    },
  },
  {
    id: "replaced-request-messages",
    apply: async (root) => rewriteJsonLines(
      path.join(root, "agent-r1/model-calls.jsonl"),
      (row, index) => index === 1
        ? { ...row, request: { ...row.request, messages: [{ role: "user", content: "forged" }] } }
        : row,
    ),
  },
];

async function main() {
  await mkdir(auditRoot, { recursive: false });
  const baselineRoot = path.join(auditRoot, "baseline");
  await cp(sourceRun, baselineRoot, {
    recursive: true,
    filter: (source) => !["verification.json", "sha256sums.txt"].includes(path.basename(source)),
  });
  const baseline = spawnSync(process.execPath, [verifier, "--run-dir", baselineRoot], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (baseline.status !== 0) {
    throw new Error(`unmutated baseline failed: ${baseline.stderr.trim()}`);
  }
  const results = [];
  for (const mutation of mutations) {
    const root = path.join(auditRoot, mutation.id);
    await cp(sourceRun, root, {
      recursive: true,
      filter: (source) => !["verification.json", "sha256sums.txt"].includes(path.basename(source)),
    });
    await mutation.apply(root);
    const child = spawnSync(process.execPath, [verifier, "--run-dir", root], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    const rejected = child.status !== 0;
    results.push({
      id: mutation.id,
      rejected,
      exitStatus: child.status,
      stderr: child.stderr.trim().slice(0, 1000),
    });
    if (!rejected) {
      await rm(path.join(root, "verification.json"), { force: true });
      await rm(path.join(root, "sha256sums.txt"), { force: true });
    }
  }
  const summary = {
    sourceRun: "live-20260812c",
    verifierSha256: sha256(await readFile(verifier)),
    baselineAccepted: true,
    expectedRejected: mutations.length,
    rejected: results.filter((entry) => entry.rejected).length,
    falseGreens: results.filter((entry) => !entry.rejected).map((entry) => entry.id),
    results,
  };
  await writeJson(path.join(auditRoot, "result.json"), summary);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.falseGreens.length > 0) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
