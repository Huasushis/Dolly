#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../../..");
const artifactRoot = path.join(
  repositoryRoot,
  "artifacts/experiments/probes/camoufox-agent-stream-v0",
);
const preregistrationPath = path.join(
  repositoryRoot,
  "docs/experiments/preregistrations/camoufox-agent-stream-v0.json",
);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--run-dir") {
    throw new Error("usage: verify.mjs --run-dir <artifact run directory>");
  }
  const runDirectory = path.resolve(argv[1]);
  if (!runDirectory.startsWith(`${artifactRoot}${path.sep}`)) {
    throw new Error("run directory is outside the experiment artifact root");
  }
  return { runDirectory };
}

function jsonLines(bytes, label) {
  const text = bytes.toString("utf8");
  if (text.length === 0 || !text.endsWith("\n")) throw new Error(`${label} is not final-LF JSONL`);
  return text.trimEnd().split("\n").map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${label} row ${index + 1} is not JSON`);
    }
  });
}

function loadConfiguredSecrets() {
  const values = {};
  for (const line of readFileSync(path.join(repositoryRoot, ".env"), "utf8").split(/\r?\n/u)) {
    const match = /^\s*(AETHER_BASE_URL|AETHER_API_KEY)\s*=\s*(.*)\s*$/u.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

async function filesRecursively(root, prefix = "") {
  const found = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix.replaceAll(path.sep, "/"), entry.name);
    if (entry.isDirectory()) found.push(...await filesRecursively(root, relative));
    else if (entry.isFile()) found.push(relative);
    else throw new Error(`artifact is not a regular file: ${relative}`);
  }
  return found.sort();
}

function pixel(raw, info, x, y) {
  const start = (y * info.width + x) * info.channels;
  return [...raw.subarray(start, start + 3)];
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function imageClass(filePath) {
  const { data, info } = await sharp(filePath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== 800 || info.height !== 600 || info.channels !== 3) {
    throw new Error(`screenshot dimensions/channels are invalid: ${filePath}`);
  }
  const top =
    same(pixel(data, info, 10, 10), [18, 52, 86]) &&
    same(pixel(data, info, 50, 50), [255, 51, 102]) &&
    same(pixel(data, info, 760, 500), [246, 240, 220]);
  const bottom =
    same(pixel(data, info, 10, 10), [32, 64, 96]) &&
    same(pixel(data, info, 50, 500), [51, 204, 153]) &&
    same(pixel(data, info, 760, 300), [32, 64, 96]);
  if (!top && !bottom) throw new Error(`screenshot does not match a frozen viewport oracle: ${filePath}`);
  return top ? "top" : "bottom";
}

function assertModelRows(rows, preregistration, caseIndex) {
  const successful = rows.filter((row) => row.failureKind === null);
  const byLogicalCall = new Map();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.logicalCallIndex) || row.logicalCallIndex < 1) {
      throw new Error(`case ${caseIndex} has an invalid logical-call index`);
    }
    const values = byLogicalCall.get(row.logicalCallIndex) ?? [];
    values.push(row);
    byLogicalCall.set(row.logicalCallIndex, values);
    const request = row.request;
    if (
      request?.stream !== true ||
      request?.stream_options?.include_usage !== true ||
      request?.thinking?.type !== "enabled" ||
      request?.max_tokens !== preregistration.generationTransport.request.max_tokens ||
      request?.model !== preregistration.backend.model ||
      Object.hasOwn(request ?? {}, "enable_thinking") ||
      Object.hasOwn(request ?? {}, "temperature")
    ) throw new Error(`case ${caseIndex} contains a non-frozen model request`);
    if (!Array.isArray(request.messages) || !Array.isArray(request.tools)) {
      throw new Error(`case ${caseIndex} omits the request conversation or tools`);
    }
  }
  for (const [logicalCallIndex, attempts] of byLogicalCall) {
    if (attempts.length < 1 || attempts.length > 2) {
      throw new Error(`case ${caseIndex} logical call ${logicalCallIndex} has an invalid attempt count`);
    }
    if (attempts.at(-1).failureKind !== null) {
      throw new Error(`case ${caseIndex} logical call ${logicalCallIndex} did not complete`);
    }
    for (const failed of attempts.slice(0, -1)) {
      if (!["timeout", "before-response-headers", "retryable-http"].includes(failed.failureKind)) {
        throw new Error(`case ${caseIndex} retried a forbidden failure`);
      }
    }
  }
  for (const row of successful) {
    if (
      row.streamEvidence?.usageEventCount !== 1 ||
      row.streamEvidence?.doneCount !== 1 ||
      !/^text\/event-stream(?:\s*;|$)/iu.test(row.streamEvidence?.contentType ?? "") ||
      row.response?.choices?.length !== 1 ||
      !row.response?.usage
    ) throw new Error(`case ${caseIndex} accepted a non-strict streaming result`);
    const message = row.response.choices[0]?.message;
    const reasoning = typeof message?.reasoning_content === "string"
      ? message.reasoning_content
      : "";
    if (row.reasoningPresent !== (reasoning.trim().length > 0)) {
      throw new Error(`case ${caseIndex} reasoning observation is inconsistent`);
    }
  }
  return { logicalCalls: byLogicalCall.size, attempts: rows.length, successful };
}

async function main() {
  const { runDirectory } = parseArguments(process.argv.slice(2));
  const existing = await filesRecursively(runDirectory);
  if (existing.includes("verification.json") || existing.includes("sha256sums.txt")) {
    throw new Error("verification outputs already exist; never overwrite a run");
  }
  const preregistrationBytes = await readFile(preregistrationPath);
  const copiedPreregistration = await readFile(path.join(runDirectory, "preregistration.json"));
  if (!copiedPreregistration.equals(preregistrationBytes)) {
    throw new Error("run preregistration bytes differ from the frozen source");
  }
  const preregistration = JSON.parse(preregistrationBytes);
  const run = JSON.parse(await readFile(path.join(runDirectory, "run.json"), "utf8"));
  const configured = loadConfiguredSecrets();
  const artifactBytes = Buffer.concat(await Promise.all(existing.map((relative) =>
    readFile(path.join(runDirectory, relative)))));
  for (const value of [configured.AETHER_API_KEY, configured.AETHER_BASE_URL]) {
    if (value && artifactBytes.includes(Buffer.from(value))) {
      throw new Error("configured secret or private endpoint leaked into artifacts");
    }
  }
  if (
    run.experimentId !== preregistration.experimentId ||
    run.version !== preregistration.version ||
    run.moduleStartupRefusalChanged !== false ||
    !Array.isArray(run.cases) ||
    run.cases.length !== preregistration.execution.repetitions
  ) throw new Error("run identity or planned coverage is invalid");
  for (const [relativePath, expectedHash] of Object.entries(run.relevantSourceHashes)) {
    const actual = sha256(await readFile(path.join(repositoryRoot, relativePath)));
    if (actual !== expectedHash) throw new Error(`relevant source drifted: ${relativePath}`);
  }

  const caseResults = [];
  let totalLogicalCalls = 0;
  let totalAttempts = 0;
  let totalReasoningResponses = 0;
  for (let caseIndex = 1; caseIndex <= preregistration.execution.repetitions; caseIndex += 1) {
    const casePrefix = `agent-r${caseIndex}`;
    const caseDirectory = path.join(runDirectory, casePrefix);
    const summary = JSON.parse(await readFile(path.join(caseDirectory, "case.json"), "utf8"));
    const events = jsonLines(await readFile(path.join(caseDirectory, "events.jsonl")), `${casePrefix}/events`);
    const modelRows = jsonLines(
      await readFile(path.join(caseDirectory, "model-calls.jsonl")),
      `${casePrefix}/model-calls`,
    );
    if (events.some((row, index) => row.sequence !== index + 1)) {
      throw new Error(`${casePrefix} event sequence is not contiguous`);
    }
    const model = assertModelRows(modelRows, preregistration, caseIndex);
    totalLogicalCalls += model.logicalCalls;
    totalAttempts += model.attempts;
    totalReasoningResponses += model.successful.filter((row) => row.reasoningPresent).length;
    const toolEvents = events.filter((row) => row.event === "model_tool_result");
    const toolNames = toolEvents.map((row) => row.name);
    if (!same(toolNames, summary.toolNames)) throw new Error(`${casePrefix} tool trace mismatch`);
    if (!preregistration.agent.requiredToolsPerCase.every((name) => toolNames.includes(name))) {
      throw new Error(`${casePrefix} omitted a required model-selected tool`);
    }
    if (toolEvents.some((row) => !preregistration.agent.allowedTools.includes(row.name))) {
      throw new Error(`${casePrefix} executed a non-allowlisted model tool`);
    }
    const state = events.filter((row) => row.event === "host_final_state").at(-1)?.state;
    if (!state || !same({
      inputText: state.inputText,
      appliedCount: state.appliedCount,
      bottomCount: state.bottomCount,
      recoveredCount: state.recoveredCount,
    }, preregistration.data.targetState)) throw new Error(`${casePrefix} final state is wrong`);
    if (!same(state, summary.finalState)) throw new Error(`${casePrefix} final state was re-reported incorrectly`);
    if (summary.remainingRecordedProcesses?.length !== 0) {
      throw new Error(`${casePrefix} left a recorded process alive`);
    }
    const screenshotEvents = toolEvents.filter((row) => row.name === "browser_take_screenshot");
    if (screenshotEvents.length < preregistration.agent.screenshotMinimum) {
      throw new Error(`${casePrefix} did not take enough model-selected screenshots`);
    }
    const classifications = [];
    const screenshotNames = [];
    for (const event of screenshotEvents) {
      if (event.result?.images?.length !== 1) throw new Error(`${casePrefix} screenshot evidence is absent`);
      const image = event.result.images[0];
      const relative = `${casePrefix}/screenshots/${image.name}`;
      const bytes = await readFile(path.join(runDirectory, relative));
      if (bytes.length !== image.byteLength || sha256(bytes) !== image.sha256) {
        throw new Error(`${casePrefix} screenshot digest mismatch`);
      }
      classifications.push(await imageClass(path.join(runDirectory, relative)));
      screenshotNames.push(image.name);
    }
    if (!classifications.includes("top") || !classifications.includes("bottom")) {
      throw new Error(`${casePrefix} lacks both frozen top and bottom screenshot oracles`);
    }
    const screenshotFiles = (await readdir(path.join(caseDirectory, "screenshots"))).sort();
    if (!same(screenshotFiles, screenshotNames.sort())) {
      throw new Error(`${casePrefix} screenshot inventory is not closed`);
    }
    const mcpOwned = (await readdir(path.join(caseDirectory, "mcp-internal"))).sort();
    if (mcpOwned.length !== screenshotEvents.length || mcpOwned.some((name) => !/^page-.*\.png$/u.test(name))) {
      throw new Error(`${casePrefix} MCP-owned screenshot inventory is invalid`);
    }
    if (summary.runnerPass !== true) throw new Error(`${casePrefix} runner reported failure`);
    caseResults.push({
      caseIndex,
      valid: true,
      logicalCalls: model.logicalCalls,
      attempts: model.attempts,
      reasoningResponses: model.successful.filter((row) => row.reasoningPresent).length,
      toolCalls: toolEvents.length,
      screenshots: screenshotEvents.length,
    });
  }
  if (
    totalLogicalCalls !== run.accounting.logicalCalls ||
    totalAttempts !== run.accounting.requestAttempts ||
    totalReasoningResponses !== run.accounting.reasoningResponses ||
    caseResults.length !== 3
  ) throw new Error("run accounting does not reconstruct from raw cases");
  if (
    totalLogicalCalls > preregistration.execution.maximumLogicalModelCalls ||
    totalAttempts > preregistration.execution.maximumRequestAttempts
  ) throw new Error("run exceeded its frozen model-call budget");
  const verification = {
    experimentId: preregistration.experimentId,
    runId: run.runId,
    valid: true,
    completeCases: caseResults.length,
    caseResults,
    totalLogicalCalls,
    totalAttempts,
    totalReasoningResponses,
    checkedAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(runDirectory, "verification.json"),
    `${JSON.stringify(verification, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  const checksummed = (await filesRecursively(runDirectory)).filter((name) => name !== "sha256sums.txt");
  const checksumRows = [];
  for (const relative of checksummed) {
    checksumRows.push(`${sha256(await readFile(path.join(runDirectory, relative)))}  ${relative}`);
  }
  await writeFile(path.join(runDirectory, "sha256sums.txt"), `${checksumRows.join("\n")}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(verification)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
