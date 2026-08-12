#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
const preregistrationRelativePath =
  "docs/experiments/preregistrations/camoufox-agent-stream-v0.json";
const requiredSourcePaths = [
  preregistrationRelativePath,
  "scripts/experiments/probes/camoufox-mcp-v0/fixture/index.html",
  "scripts/experiments/probes/camoufox-agent-stream-v0/run.mjs",
  "scripts/experiments/probes/camoufox-agent-stream-v0/verify.mjs",
  "scripts/experiments/probes/strict-openai-tool-sse.mjs",
].sort();

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

function committedBytes(commit, relativePath) {
  return execFileSync("git", ["show", `${commit}:${relativePath}`], {
    cwd: repositoryRoot,
    encoding: null,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function systemInstruction() {
  return [
    "You are a browser Agent operating a synthetic local page through host-selected tools.",
    "Choose every action yourself from the supplied tool results; never invent element references.",
    "Take a PNG screenshot before changing page state and another after the goal is complete.",
    "For type and click, put the snapshot's exact e<number> reference in target and a human-readable label in element. Perform Apply, Bottom, and Recover exactly once each.",
    "After the exact goal is complete, stop calling tools and briefly report completion.",
    "Keep internal analysis under 300 words per round and preserve output budget for tool calls.",
  ].join(" ");
}

function expectedToolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "browser_navigate",
        description: "Navigate the browser to the supplied local task URL.",
        parameters: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browser_snapshot",
        description: "Return the current accessibility snapshot with exact element references.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "browser_take_screenshot",
        description: "Take a PNG screenshot of the current viewport. The host retains the image and returns its hash and dimensions metadata.",
        parameters: {
          type: "object",
          properties: { type: { type: "string", enum: ["png"] } },
          required: ["type"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browser_type",
        description: "Type the exact target text into an element reference discovered from a snapshot.",
        parameters: {
          type: "object",
          properties: {
            element: {
              type: "string",
              description: "Human-readable element description, such as Probe input. Never put a snapshot ref here.",
            },
            target: {
              type: "string",
              description: "Exact element reference returned by browser_snapshot, such as e9. Never put a human-readable description here.",
            },
            text: { type: "string" },
          },
          required: ["target", "text"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browser_click",
        description: "Click one element reference discovered from a snapshot; Playwright scrolls it into view when needed.",
        parameters: {
          type: "object",
          properties: {
            element: {
              type: "string",
              description: "Human-readable element description, such as Apply. Never put a snapshot ref here.",
            },
            target: {
              type: "string",
              description: "Exact element reference returned by browser_snapshot, such as e10. Never put a human-readable description here.",
            },
          },
          required: ["target"],
          additionalProperties: false,
        },
      },
    },
  ];
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

function assertModelRows(rows, preregistration, caseIndex, toolEvents) {
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
    if (request.tool_choice !== "auto" || !same(request.tools, expectedToolDefinitions())) {
      throw new Error(`case ${caseIndex} changed the frozen model-facing tool contract`);
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
  const finalRows = [...byLogicalCall.values()].map((attempts) => attempts.at(-1));
  const eventsByRound = new Map();
  for (const event of toolEvents) {
    const values = eventsByRound.get(event.round) ?? [];
    values.push(event);
    eventsByRound.set(event.round, values);
  }
  const navigation = toolEvents.find((event) => event.name === "browser_navigate");
  const fixtureUrl = navigation?.arguments?.url;
  if (typeof fixtureUrl !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\/index\.html$/u.test(fixtureUrl)) {
    throw new Error(`case ${caseIndex} has no exact loopback navigation URL`);
  }
  const firstMessages = finalRows[0]?.request?.messages;
  if (!same(firstMessages, [
    { role: "system", content: systemInstruction() },
    {
      role: "user",
      content: `${preregistration.agent.goal} Local page URL: ${fixtureUrl}`,
    },
  ])) throw new Error(`case ${caseIndex} initial messages differ from the frozen task`);
  for (let index = 0; index < finalRows.length; index += 1) {
    const row = finalRows[index];
    if (row.round !== index + 1) throw new Error(`case ${caseIndex} model rounds are not contiguous`);
    const choice = row.response?.choices?.[0];
    const calls = choice?.message?.tool_calls ?? [];
    const roundEvents = eventsByRound.get(row.round) ?? [];
    if ((choice?.finish_reason === "tool_calls") !== (calls.length > 0)) {
      throw new Error(`case ${caseIndex} finish reason does not match its model tool calls`);
    }
    if (calls.length !== roundEvents.length) {
      throw new Error(`case ${caseIndex} model/MCP call count differs in round ${row.round}`);
    }
    for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
      const call = calls[callIndex];
      const event = roundEvents[callIndex];
      let argumentsValue;
      try {
        argumentsValue = JSON.parse(call.function.arguments);
      } catch {
        throw new Error(`case ${caseIndex} has malformed retained tool arguments`);
      }
      if (
        call.id !== event.callId ||
        call.function.name !== event.name ||
        !same(argumentsValue, event.arguments)
      ) throw new Error(`case ${caseIndex} model call and MCP execution differ`);
    }
    const next = finalRows[index + 1];
    if (next) {
      const assistant = {
        role: "assistant",
        content: choice.message.content,
        reasoning_content: choice.message.reasoning_content,
        ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
      };
      const toolMessages = roundEvents.map((event) => ({
        role: "tool",
        tool_call_id: event.callId,
        content: JSON.stringify(event.result),
      }));
      if (!same(next.request.messages, [...row.request.messages, assistant, ...toolMessages])) {
        throw new Error(`case ${caseIndex} request conversation was not exact replay`);
      }
    } else if (choice.finish_reason === "tool_calls") {
      throw new Error(`case ${caseIndex} ended without a final model response`);
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
  const currentPreregistrationBytes = await readFile(preregistrationPath);
  const copiedPreregistration = await readFile(path.join(runDirectory, "preregistration.json"));
  const run = JSON.parse(await readFile(path.join(runDirectory, "run.json"), "utf8"));
  if (!/^[0-9a-f]{40}$/u.test(run.sourceCommit)) throw new Error("source commit is invalid");
  const committedPreregistration = committedBytes(run.sourceCommit, preregistrationRelativePath);
  if (!copiedPreregistration.equals(committedPreregistration)) {
    throw new Error("run preregistration bytes differ from its source commit");
  }
  const preregistration = JSON.parse(copiedPreregistration);
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
  const recordedSourcePaths = Object.keys(run.relevantSourceHashes).sort();
  if (!same(recordedSourcePaths, requiredSourcePaths)) {
    throw new Error("run relevant source inventory is not exact");
  }
  for (const [relativePath, expectedHash] of Object.entries(run.relevantSourceHashes)) {
    const actual = sha256(committedBytes(run.sourceCommit, relativePath));
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
    const toolEvents = events.filter((row) => row.event === "model_tool_result");
    const model = assertModelRows(modelRows, preregistration, caseIndex, toolEvents);
    totalLogicalCalls += model.logicalCalls;
    totalAttempts += model.attempts;
    totalReasoningResponses += model.successful.filter((row) => row.reasoningPresent).length;
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
    const retainedHashes = [];
    for (const name of screenshotFiles) {
      retainedHashes.push(sha256(await readFile(path.join(caseDirectory, "screenshots", name))));
    }
    const mcpHashes = [];
    for (const name of mcpOwned) {
      mcpHashes.push(sha256(await readFile(path.join(caseDirectory, "mcp-internal", name))));
    }
    if (!same(retainedHashes.sort(), mcpHashes.sort())) {
      throw new Error(`${casePrefix} retained and MCP-owned screenshots differ`);
    }
    if (!same(summary, run.cases[caseIndex - 1])) {
      throw new Error(`${casePrefix} case summary differs from run metadata`);
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
  const expectedFiles = new Set(["preregistration.json", "run.json"]);
  for (let caseIndex = 1; caseIndex <= preregistration.execution.repetitions; caseIndex += 1) {
    const prefix = `agent-r${caseIndex}`;
    expectedFiles.add(`${prefix}/case.json`);
    expectedFiles.add(`${prefix}/events.jsonl`);
    expectedFiles.add(`${prefix}/model-calls.jsonl`);
    for (const name of await readdir(path.join(runDirectory, prefix, "screenshots"))) {
      expectedFiles.add(`${prefix}/screenshots/${name}`);
    }
    for (const name of await readdir(path.join(runDirectory, prefix, "mcp-internal"))) {
      expectedFiles.add(`${prefix}/mcp-internal/${name}`);
    }
  }
  if (!same(existing, [...expectedFiles].sort())) {
    throw new Error("run artifact inventory is not exact");
  }
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
    currentPreregistrationSha256: sha256(currentPreregistrationBytes),
    runPreregistrationSha256: sha256(copiedPreregistration),
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
