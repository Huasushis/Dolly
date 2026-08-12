#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readStrictOpenAiToolSse } from "../strict-openai-tool-sse.mjs";
import { readBoundedResponseText } from "../memory-association-task-switch-v0/strict-chat-sse.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../../..");
const preregistrationPath = "docs/experiments/preregistrations/camoufox-agent-stream-v0.json";
const fixturePath = "scripts/experiments/probes/camoufox-mcp-v0/fixture/index.html";
const implementationPaths = [
  preregistrationPath,
  fixturePath,
  "scripts/experiments/probes/camoufox-agent-stream-v0/run.mjs",
  "scripts/experiments/probes/camoufox-agent-stream-v0/verify.mjs",
  "scripts/experiments/probes/strict-openai-tool-sse.mjs",
];
const toolRoot = "/home/ubuntu/codex-dolly/.tools/camoufox-mcp-v0";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArguments(argv) {
  if (
    argv.length !== 2 ||
    argv[0] !== "--run-id" ||
    !/^live-[A-Za-z0-9._-]+$/u.test(argv[1])
  ) {
    throw new Error("usage: run.mjs --run-id live-<unique-id>");
  }
  return { runId: argv[1] };
}

function loadEnv(bytes) {
  const values = {};
  for (const line of bytes.toString("utf8").split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
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

function completionUrl(value) {
  const result = new URL(value);
  if (result.username || result.password || result.search || result.hash) {
    throw new Error("Aether base URL contains a forbidden component");
  }
  const host = result.hostname.replace(/^\[|\]$/gu, "");
  if (host === "127.0.0.1" || host === "::1") {
    if (result.protocol !== "http:" || result.port === "") {
      throw new Error("loopback Aether requires HTTP and an explicit port");
    }
  } else if (result.protocol !== "https:") {
    throw new Error("non-loopback Aether requires HTTPS");
  }
  result.pathname = `${result.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "")}/v1/chat/completions`;
  return result;
}

function committedBytes(relativePath) {
  return execFileSync("git", ["show", `HEAD:${relativePath}`], {
    cwd: repositoryRoot,
    encoding: null,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function assertCommitted(relativePath) {
  const current = await readFile(path.join(repositoryRoot, relativePath));
  if (!current.equals(committedBytes(relativePath))) {
    throw new Error(`live source differs from HEAD: ${relativePath}`);
  }
  return current;
}

function processStartTicks(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").trim().split(/\s+/u);
    const result = Number(fields[21]);
    return Number.isSafeInteger(result) ? result : null;
  } catch {
    return null;
  }
}

function identityIsLive(identity) {
  return processStartTicks(identity.pid) === identity.startTicks;
}

async function descendants(rootPid) {
  const entries = await readdir("/proc", { withFileTypes: true });
  const byParent = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    try {
      const fields = (await readFile(`/proc/${entry.name}/stat`, "utf8")).trim().split(/\s+/u);
      const pid = Number(fields[0]);
      const parent = Number(fields[3]);
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent)) continue;
      const values = byParent.get(parent) ?? [];
      values.push(pid);
      byParent.set(parent, values);
    } catch {
      // A process may exit during the snapshot.
    }
  }
  const found = [];
  const pending = [rootPid];
  while (pending.length > 0) {
    const parent = pending.pop();
    for (const pid of (byParent.get(parent) ?? []).sort((left, right) => left - right)) {
      const startTicks = processStartTicks(pid);
      if (startTicks !== null) found.push({ pid, startTicks });
      pending.push(pid);
    }
  }
  return found;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function stopExactProcesses(identities, record) {
  const unique = new Map(identities.map((identity) => [
    `${identity.pid}:${identity.startTicks}`,
    identity,
  ]));
  const ordered = [...unique.values()].reverse();
  for (const identity of ordered) {
    if (!identityIsLive(identity)) continue;
    process.kill(identity.pid, "SIGTERM");
    await record("process_signal", { signal: "SIGTERM", identity });
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && ordered.some(identityIsLive)) await delay(50);
  for (const identity of ordered) {
    if (!identityIsLive(identity)) continue;
    process.kill(identity.pid, "SIGKILL");
    await record("process_signal", { signal: "SIGKILL", identity });
  }
  await delay(100);
  return ordered.filter(identityIsLive);
}

function waitForWebSocket(child, timeoutMs = 30_000) {
  return new Promise((resolveEndpoint, rejectEndpoint) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      rejectEndpoint(new Error(`Camoufox endpoint timeout; stderr=${stderr.slice(-2000)}`));
    }, timeoutMs);
    const onStdout = (chunk) => {
      stdout += chunk.toString("utf8");
      const endpoint = /ws:\/\/[^\s]+/u.exec(stdout)?.[0];
      if (!endpoint) return;
      cleanup();
      resolveEndpoint(endpoint);
    };
    const onStderr = (chunk) => { stderr += chunk.toString("utf8"); };
    const onExit = (code, signal) => {
      cleanup();
      rejectEndpoint(new Error(
        `Camoufox endpoint exited before readiness: code=${code}, signal=${signal}, stderr=${stderr.slice(-2000)}`,
      ));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}

async function startFixtureServer(fixtureBytes) {
  const requestCounts = { success: 0, notFound: 0 };
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/" || pathname === "/index.html") {
      requestCounts.success += 1;
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": fixtureBytes.length,
        "Cache-Control": "no-store",
      });
      response.end(fixtureBytes);
      return;
    }
    requestCounts.notFound += 1;
    response.writeHead(404, { "Content-Length": 0 });
    response.end();
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture address missing");
  return {
    url: `http://127.0.0.1:${address.port}/index.html`,
    requestCounts,
    close: () => new Promise((resolveClose, rejectClose) =>
      server.close((error) => error ? rejectClose(error) : resolveClose())),
  };
}

function textContent(result) {
  return (result.content ?? [])
    .filter((entry) => entry?.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

function parseState(result) {
  const text = textContent(result);
  const prefix = "### Result\n";
  const start = text.indexOf(prefix);
  if (start < 0) throw new Error("state result section missing");
  const bodyStart = start + prefix.length;
  const next = text.indexOf("\n### ", bodyStart);
  let value = JSON.parse(text.slice(bodyStart, next < 0 ? undefined : next).trim());
  if (typeof value === "string") value = JSON.parse(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("state result is not an object");
  }
  return value;
}

function agentToolDefinitions() {
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

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} contains unsupported fields`);
  }
  return value;
}

function validateToolArguments(name, value, fixtureUrl) {
  if (name === "browser_navigate") {
    exactKeys(value, ["url"], name);
    if (value.url !== fixtureUrl) throw new Error("browser navigation escaped the supplied local URL");
    return value;
  }
  if (name === "browser_snapshot") {
    return exactKeys(value, [], name);
  }
  if (name === "browser_take_screenshot") {
    exactKeys(value, ["type"], name);
    if (value.type !== "png") throw new Error("only PNG screenshots are allowed");
    return value;
  }
  if (name === "browser_type") {
    const allowed = Object.hasOwn(value, "element")
      ? ["element", "target", "text"]
      : ["target", "text"];
    exactKeys(value, allowed, name);
    if (
      typeof value.target !== "string" || value.target.length === 0 || value.target.length > 200 ||
      value.text !== "AGENT-TARGET-4821" ||
      (value.element !== undefined && (typeof value.element !== "string" || value.element.length > 200))
    ) throw new Error("browser_type arguments are outside the host policy");
    return value;
  }
  if (name === "browser_click") {
    const allowed = Object.hasOwn(value, "element") ? ["element", "target"] : ["target"];
    exactKeys(value, allowed, name);
    if (
      typeof value.target !== "string" || value.target.length === 0 || value.target.length > 200 ||
      (value.element !== undefined && (typeof value.element !== "string" || value.element.length > 200))
    ) throw new Error("browser_click arguments are outside the host policy");
    return value;
  }
  throw new Error(`model selected a non-allowlisted tool: ${name}`);
}

function summarizeToolResult(result, images) {
  const text = textContent(result);
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new Error("MCP text result exceeded its limit");
  return {
    isError: result.isError === true,
    text,
    images,
  };
}

async function writeScreenshotImages(result, screenshotDirectory, sequence) {
  const images = (result.content ?? []).filter((entry) => entry?.type === "image");
  if (images.length !== 1 || images[0].mimeType !== "image/png") {
    throw new Error("screenshot tool did not return exactly one PNG");
  }
  const bytes = Buffer.from(images[0].data, "base64");
  const name = `model-screenshot-${String(sequence).padStart(2, "0")}.png`;
  await writeFile(path.join(screenshotDirectory, name), bytes, { flag: "wx", mode: 0o600 });
  return [{ name, mimeType: "image/png", byteLength: bytes.length, sha256: sha256(bytes) }];
}

async function createRecorder(filePath) {
  await writeFile(filePath, "", { flag: "wx", mode: 0o600 });
  let sequence = 0;
  const started = performance.now();
  return async (event, fields = {}) => {
    sequence += 1;
    await appendFile(filePath, `${JSON.stringify({
      sequence,
      event,
      monotonicMsSinceStart: Number((performance.now() - started).toFixed(3)),
      wallTimeUtc: new Date().toISOString(),
      ...fields,
    })}\n`);
  };
}

async function runCase({ caseIndex, caseDirectory, preregistration, requestUrl, apiKey }) {
  await mkdir(path.join(caseDirectory, "screenshots"), { recursive: true });
  await mkdir(path.join(caseDirectory, "mcp-internal"), { recursive: true });
  const eventPath = path.join(caseDirectory, "events.jsonl");
  const modelPath = path.join(caseDirectory, "model-calls.jsonl");
  const record = await createRecorder(eventPath);
  await writeFile(modelPath, "", { flag: "wx", mode: 0o600 });
  const fixtureBytes = await readFile(path.join(repositoryRoot, fixturePath));
  const processes = new Map();
  const toolNames = [];
  let logicalCalls = 0;
  let requestAttempts = 0;
  let screenshotCount = 0;
  let reasoningResponses = 0;
  let fixtureServer;
  let camoufoxServer;
  let client;
  let finalState = null;
  let finalAnswer = null;
  let error = null;
  let initializationFailure = false;
  let phase = "initialization";

  async function registerDescendants(reason) {
    const identities = await descendants(process.pid);
    for (const identity of identities) processes.set(`${identity.pid}:${identity.startTicks}`, identity);
    await record("process_tree", { reason, identities });
  }

  try {
    await record("case_start", { caseIndex, fixtureSha256: sha256(fixtureBytes) });
    fixtureServer = await startFixtureServer(fixtureBytes);
    await record("fixture_started", { origin: "http://127.0.0.1:<ephemeral>" });
    const python = path.join(toolRoot, "venv/bin/python");
    const localEnvironment = {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: path.join(toolRoot, "home"),
      XDG_CACHE_HOME: path.join(toolRoot, "cache"),
      TMPDIR: path.join(toolRoot, "tmp"),
      npm_config_cache: path.join(toolRoot, "npm-cache"),
      PIP_CACHE_DIR: path.join(toolRoot, "pip-cache"),
      PYTHONPYCACHEPREFIX: "/home/ubuntu/codex-dolly/.tmp/camoufox-pycache",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    };
    camoufoxServer = spawn(python, [
      path.join(repositoryRoot, "scripts/experiments/probes/camoufox-mcp-v0/camoufox_server.py"),
    ], {
      cwd: repositoryRoot,
      env: localEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const directStartTicks = processStartTicks(camoufoxServer.pid);
    if (directStartTicks === null) throw new Error("Camoufox child identity was unavailable");
    processes.set(`${camoufoxServer.pid}:${directStartTicks}`, {
      pid: camoufoxServer.pid,
      startTicks: directStartTicks,
    });
    const endpoint = await waitForWebSocket(camoufoxServer);
    await registerDescendants("camoufox_ready");

    const sdkRoot = path.join(toolRoot, "node/node_modules/@modelcontextprotocol/sdk/dist/esm");
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import(pathToFileURL(path.join(sdkRoot, "client/index.js")).href),
      import(pathToFileURL(path.join(sdkRoot, "client/stdio.js")).href),
    ]);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.join(toolRoot, "node/node_modules/@playwright/mcp/cli.js"),
        "--endpoint", endpoint,
        "--isolated",
        "--output-dir", path.join(caseDirectory, "mcp-internal"),
        "--viewport-size", "800x600",
        "--timeout-action", "3000",
        "--timeout-navigation", "30000",
        "--snapshot-mode", "none",
      ],
      env: localEnvironment,
      stderr: "pipe",
    });
    client = new Client({ name: "dolly-camoufox-agent-stream", version: "0.0.1" });
    await client.connect(transport);
    await registerDescendants("mcp_connected");
    const inventory = await client.listTools();
    const available = new Set(inventory.tools.map((entry) => entry.name));
    for (const required of preregistration.agent.allowedTools) {
      if (!available.has(required)) throw new Error(`required MCP tool missing: ${required}`);
    }
    await record("mcp_inventory", { toolNames: [...available].sort() });
    phase = "agent";

    const definitions = agentToolDefinitions();
    const messages = [
      {
        role: "system",
        content: [
          "You are a browser Agent operating a synthetic local page through host-selected tools.",
          "Choose every action yourself from the supplied tool results; never invent element references.",
          "Take a PNG screenshot before changing page state and another after the goal is complete.",
          "For type and click, put the snapshot's exact e<number> reference in target and a human-readable label in element. Perform Apply, Bottom, and Recover exactly once each.",
          "After the exact goal is complete, stop calling tools and briefly report completion.",
          "Keep internal analysis under 300 words per round and preserve output budget for tool calls.",
        ].join(" "),
      },
      {
        role: "user",
        content: `${preregistration.agent.goal} Local page URL: ${fixtureServer.url}`,
      },
    ];

    async function persistModel(row) {
      await appendFile(modelPath, `${JSON.stringify(row)}\n`);
    }

    async function callModel(round) {
      logicalCalls += 1;
      if (logicalCalls > preregistration.agent.maximumRounds) {
        throw new Error("model round limit exceeded");
      }
      const request = {
        model: preregistration.backend.model,
        messages,
        tools: definitions,
        tool_choice: "auto",
        thinking: { type: "enabled" },
        max_tokens: preregistration.generationTransport.request.max_tokens,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (Object.hasOwn(request, "enable_thinking")) throw new Error("enable_thinking is forbidden");
      for (let attemptIndex = 1; attemptIndex <= 2; attemptIndex += 1) {
        requestAttempts += 1;
        const startedAt = new Date().toISOString();
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          preregistration.generationTransport.request.timeoutMs,
        );
        let response;
        try {
          response = await fetch(requestUrl, {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(request),
            signal: controller.signal,
            redirect: "error",
          });
          if (!response.ok) {
            const responseText = await readBoundedResponseText(response, 1024 * 1024);
            const retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
            await persistModel({
              round,
              logicalCallIndex: logicalCalls,
              attemptIndex,
              request,
              response: { status: response.status, body: responseText.slice(0, 16_000) },
              streamEvidence: null,
              startedAt,
              finishedAt: new Date().toISOString(),
              failureKind: retryable ? "retryable-http" : "terminal-http",
            });
            clearTimeout(timer);
            if (retryable && attemptIndex < 2) {
              await delay(2_000);
              continue;
            }
            throw new Error(`Aether HTTP ${response.status}`);
          }
          let parsed;
          try {
            parsed = await readStrictOpenAiToolSse(response, {
              maximumResponseBytes: 4 * 1024 * 1024,
              maximumBufferedBytes: 512 * 1024,
              maximumOutputBytes: 1024 * 1024,
              maximumEvents: 40_000,
              maximumToolCalls: 8,
            });
          } catch (streamError) {
            const failureKind = streamError?.name === "AbortError"
              ? "timeout"
              : "http-200-stream-protocol";
            await persistModel({
              round,
              logicalCallIndex: logicalCalls,
              attemptIndex,
              request,
              response: null,
              streamEvidence: null,
              startedAt,
              finishedAt: new Date().toISOString(),
              failureKind,
              error: streamError instanceof Error ? streamError.message : String(streamError),
            });
            clearTimeout(timer);
            if (failureKind === "timeout" && attemptIndex < 2) {
              await delay(2_000);
              continue;
            }
            throw streamError;
          }
          clearTimeout(timer);
          const message = parsed.body.choices[0].message;
          const reasoning = typeof message.reasoning_content === "string"
            ? message.reasoning_content
            : "";
          await persistModel({
            round,
            logicalCallIndex: logicalCalls,
            attemptIndex,
            request,
            response: parsed.body,
            streamEvidence: parsed.evidence,
            reasoningPresent: reasoning.trim().length > 0,
            reasoningCharacterCount: reasoning.length,
            startedAt,
            finishedAt: new Date().toISOString(),
            failureKind: null,
          });
          if (reasoning.trim().length > 0) reasoningResponses += 1;
          return parsed.body;
        } catch (requestError) {
          clearTimeout(timer);
          if (response === undefined) {
            await persistModel({
              round,
              logicalCallIndex: logicalCalls,
              attemptIndex,
              request,
              response: null,
              streamEvidence: null,
              startedAt,
              finishedAt: new Date().toISOString(),
              failureKind: requestError?.name === "AbortError" ? "timeout" : "before-response-headers",
              error: requestError instanceof Error ? requestError.message : String(requestError),
            });
          }
          if (response !== undefined || attemptIndex >= 2) throw requestError;
          await delay(2_000);
        }
      }
      throw new Error("model request attempts exhausted");
    }

    for (let round = 1; round <= preregistration.agent.maximumRounds; round += 1) {
      const completion = await callModel(round);
      const choice = completion.choices[0];
      const assistant = choice.message;
      messages.push({
        role: "assistant",
        content: assistant.content,
        reasoning_content: assistant.reasoning_content,
        ...(assistant.tool_calls ? { tool_calls: assistant.tool_calls } : {}),
      });
      if (choice.finish_reason !== "tool_calls") {
        finalAnswer = assistant.content;
        break;
      }
      for (const call of assistant.tool_calls) {
        if (toolNames.length >= preregistration.agent.maximumToolCalls) {
          throw new Error("model tool-call limit exceeded");
        }
        const name = call.function.name;
        let argumentsValue;
        try {
          argumentsValue = JSON.parse(call.function.arguments);
        } catch {
          throw new Error("model tool arguments are not JSON");
        }
        validateToolArguments(name, argumentsValue, fixtureServer.url);
        const started = performance.now();
        const result = await client.callTool({ name, arguments: argumentsValue });
        toolNames.push(name);
        let images = [];
        if (name === "browser_take_screenshot") {
          screenshotCount += 1;
          images = await writeScreenshotImages(
            result,
            path.join(caseDirectory, "screenshots"),
            screenshotCount,
          );
        }
        const summary = summarizeToolResult(result, images);
        await record("model_tool_result", {
          round,
          callId: call.id,
          name,
          arguments: argumentsValue,
          result: summary,
          durationMs: Number((performance.now() - started).toFixed(3)),
        });
        if (result.isError === true) throw new Error(`MCP tool failed: ${name}`);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(summary) });
      }
    }
    if (finalAnswer === null) throw new Error("model did not produce a final response");
    phase = "oracle";
    const oracleResult = await client.callTool({
      name: "browser_evaluate",
      arguments: { function: "() => JSON.stringify(window.__probeRead())" },
    });
    finalState = parseState(oracleResult);
    await record("host_final_state", { state: finalState });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    initializationFailure = phase === "initialization";
    await record("case_error", { phase, initializationFailure, error });
  } finally {
    phase = "cleanup";
    try {
      if (client) await client.close();
    } catch (closeError) {
      await record("mcp_close_error", {
        error: closeError instanceof Error ? closeError.message : String(closeError),
      });
    }
    try {
      if (fixtureServer) await fixtureServer.close();
    } catch (closeError) {
      await record("fixture_close_error", {
        error: closeError instanceof Error ? closeError.message : String(closeError),
      });
    }
    await delay(100);
    await registerDescendants("before_exact_cleanup");
    const remaining = await stopExactProcesses(
      [...processes.values()].filter(identityIsLive),
      record,
    );
    const expected = preregistration.data.targetState;
    const statePass = finalState !== null &&
      finalState.inputText === expected.inputText &&
      finalState.appliedCount === expected.appliedCount &&
      finalState.bottomCount === expected.bottomCount &&
      finalState.recoveredCount === expected.recoveredCount;
    const requiredToolsPass = preregistration.agent.requiredToolsPerCase.every((name) =>
      toolNames.includes(name));
    const runnerPass = error === null && statePass && requiredToolsPass &&
      screenshotCount >= preregistration.agent.screenshotMinimum && remaining.length === 0;
    const caseSummary = {
      caseIndex,
      runnerPass,
      initializationFailure,
      error,
      logicalCalls,
      requestAttempts,
      reasoningResponses,
      toolNames,
      screenshotCount,
      finalState,
      finalAnswer,
      fixtureRequestCounts: fixtureServer?.requestCounts ?? null,
      remainingRecordedProcesses: remaining,
      statePass,
      requiredToolsPass,
    };
    await writeFile(
      path.join(caseDirectory, "case.json"),
      `${JSON.stringify(caseSummary, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await record("case_end", { runnerPass, remainingRecordedProcesses: remaining });
    return caseSummary;
  }
}

async function main() {
  if (process.env.RUN_LIVE_INTEGRATION !== "1" || process.env.RUN_PAID_INTEGRATION !== "1") {
    throw new Error("RUN_LIVE_INTEGRATION=1 and RUN_PAID_INTEGRATION=1 are required");
  }
  const { runId } = parseArguments(process.argv.slice(2));
  const sourceBytes = {};
  for (const relativePath of implementationPaths) {
    sourceBytes[relativePath] = await assertCommitted(relativePath);
  }
  const preregistration = JSON.parse(sourceBytes[preregistrationPath]);
  if (
    preregistration.experimentId !== "camoufox-agent-stream-v0" ||
    preregistration.status !== "frozen-before-live-model-and-browser-execution"
  ) throw new Error("preregistration is not frozen");
  const fixtureBytes = sourceBytes[fixturePath];
  if (sha256(fixtureBytes) !== preregistration.data.fixtureSha256) {
    throw new Error("fixture hash mismatch");
  }
  const environment = { ...loadEnv(await readFile(path.join(repositoryRoot, ".env"))), ...process.env };
  const baseUrl = environment.AETHER_BASE_URL;
  const apiKey = environment.AETHER_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("Aether fixture is not configured");
  const requestUrl = completionUrl(baseUrl);
  const runDirectory = path.join(
    repositoryRoot,
    preregistration.evidence.artifactRoot,
    runId,
  );
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    path.join(runDirectory, "preregistration.json"),
    sourceBytes[preregistrationPath],
    { flag: "wx", mode: 0o600 },
  );
  const startedAt = new Date().toISOString();
  const cases = [];
  let consecutiveInitializationFailures = 0;
  for (let caseIndex = 1; caseIndex <= preregistration.execution.repetitions; caseIndex += 1) {
    if (Date.now() - Date.parse(startedAt) > preregistration.execution.maximumWallClockMs) break;
    const caseDirectory = path.join(runDirectory, `agent-r${caseIndex}`);
    await mkdir(caseDirectory, { recursive: false });
    const result = await runCase({
      caseIndex,
      caseDirectory,
      preregistration,
      requestUrl,
      apiKey,
    });
    cases.push(result);
    consecutiveInitializationFailures = result.initializationFailure
      ? consecutiveInitializationFailures + 1
      : 0;
    if (consecutiveInitializationFailures >= 2) break;
  }
  const logicalCalls = cases.reduce((sum, entry) => sum + entry.logicalCalls, 0);
  const requestAttempts = cases.reduce((sum, entry) => sum + entry.requestAttempts, 0);
  if (logicalCalls > preregistration.execution.maximumLogicalModelCalls) {
    throw new Error("global logical model-call budget exceeded");
  }
  if (requestAttempts > preregistration.execution.maximumRequestAttempts) {
    throw new Error("global request-attempt budget exceeded");
  }
  const run = {
    experimentId: preregistration.experimentId,
    version: preregistration.version,
    runId,
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim(),
    relevantSourceHashes: Object.fromEntries(
      Object.entries(sourceBytes).map(([name, bytes]) => [name, sha256(bytes)]),
    ),
    endpointSha256: sha256(Buffer.from(requestUrl.origin)),
    model: preregistration.backend.model,
    startedAt,
    finishedAt: new Date().toISOString(),
    cases,
    accounting: {
      completeCases: cases.filter((entry) => entry.runnerPass).length,
      logicalCalls,
      requestAttempts,
      reasoningResponses: cases.reduce((sum, entry) => sum + entry.reasoningResponses, 0),
      screenshots: cases.reduce((sum, entry) => sum + entry.screenshotCount, 0),
    },
    independentVerification: "not-run",
    moduleStartupRefusalChanged: false,
  };
  await writeFile(path.join(runDirectory, "run.json"), `${JSON.stringify(run, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify({ runId, ...run.accounting })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
