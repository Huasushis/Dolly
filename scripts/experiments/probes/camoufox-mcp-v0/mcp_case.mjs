#!/usr/bin/env node
/** Run one scripted MCP-to-Camoufox case and retain raw observations. */

import { createHash } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const BACKEND = "mcp-playwright-remote-camoufox";
const INPUT_TEXT = "Dolly-Camoufox-20260809";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("invalid arguments");
    values.set(key.slice(2), value);
  }
  const repeat = Number(values.get("repeat"));
  const seed = Number(values.get("seed"));
  if (![1, 2, 3].includes(repeat) || !Number.isSafeInteger(seed)) {
    throw new Error("repeat or seed is invalid");
  }
  for (const key of ["run-dir", "fixture", "tool-root", "python"]) {
    if (!values.get(key)) throw new Error(`--${key} is required`);
  }
  return Object.freeze({
    repeat,
    seed,
    runDirectory: resolve(values.get("run-dir")),
    fixture: resolve(values.get("fixture")),
    toolRoot: resolve(values.get("tool-root")),
    python: resolve(values.get("python")),
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function processStartTicks(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").trim().split(/\s+/u);
    const value = Number(fields[21]);
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

async function descendants(rootPid) {
  const entries = await import("node:fs/promises").then(({ readdir }) =>
    readdir("/proc", { withFileTypes: true }),
  );
  const children = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    try {
      const fields = (await readFile(`/proc/${entry.name}/stat`, "utf8")).trim().split(/\s+/u);
      const pid = Number(fields[0]);
      const parent = Number(fields[3]);
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent)) continue;
      const values = children.get(parent) ?? [];
      values.push(pid);
      children.set(parent, values);
    } catch {
      // A process may exit during this read-only snapshot.
    }
  }
  const found = [];
  const pending = [rootPid];
  while (pending.length > 0) {
    const parent = pending.pop();
    for (const pid of (children.get(parent) ?? []).sort((left, right) => left - right)) {
      const startTicks = processStartTicks(pid);
      if (startTicks !== null) found.push({ pid, startTicks });
      pending.push(pid);
    }
  }
  return found;
}

function identityIsLive(identity) {
  return processStartTicks(identity.pid) === identity.startTicks;
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
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && ordered.some(identityIsLive)) await delay(50);
  for (const identity of ordered) {
    if (!identityIsLive(identity)) continue;
    process.kill(identity.pid, "SIGKILL");
    await record("process_signal", { signal: "SIGKILL", identity });
  }
  await delay(100);
  return ordered.filter(identityIsLive);
}

async function createRecorder(path) {
  await mkdir(resolve(path, ".."), { recursive: true });
  const stream = createWriteStream(path, { flags: "wx", encoding: "utf8", mode: 0o600 });
  const started = performance.now();
  let sequence = 0;
  return Object.freeze({
    async record(event, fields = {}) {
      sequence += 1;
      const row = {
        sequence,
        wallTimeUtc: new Date().toISOString(),
        monotonicMsSinceStart: Number((performance.now() - started).toFixed(3)),
        event,
        ...fields,
      };
      await new Promise((resolveWrite, rejectWrite) => {
        stream.write(`${JSON.stringify(row)}\n`, (error) => error ? rejectWrite(error) : resolveWrite());
      });
    },
    close: () => new Promise((resolveClose, rejectClose) => {
      stream.end((error) => error ? rejectClose(error) : resolveClose());
    }),
  });
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
      const endpoint = stdout.match(/ws:\/\/[^\s]+/u)?.[0];
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
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/" || path === "/index.html") {
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
  return Object.freeze({
    url: `http://127.0.0.1:${address.port}/index.html`,
    requestCounts,
    close: () => new Promise((resolveClose, rejectClose) =>
      server.close((error) => error ? rejectClose(error) : resolveClose()),
    ),
  });
}

function textContent(result) {
  return (result.content ?? [])
    .filter((item) => item?.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function summarizeToolResult(result) {
  return {
    isError: result.isError === true,
    content: (result.content ?? []).map((item) => item?.type === "image"
      ? { type: "image", mimeType: item.mimeType, byteLength: Buffer.from(item.data, "base64").length }
      : item),
  };
}

function requireRef(snapshot, role, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const expression = new RegExp(`- ${role} "${escapedName}" \\[ref=([^\\]]+)\\]`, "u");
  const ref = snapshot.match(expression)?.[1];
  if (!ref) throw new Error(`snapshot did not expose ${role} ${name}`);
  return ref;
}

function parseState(result) {
  const text = textContent(result);
  const resultPrefix = "### Result\n";
  const start = text.indexOf(resultPrefix);
  if (start < 0) throw new Error(`state result section missing from tool result: ${text}`);
  const payloadStart = start + resultPrefix.length;
  const nextSection = text.indexOf("\n### ", payloadStart);
  const payload = text.slice(payloadStart, nextSection < 0 ? undefined : nextSection).trim();
  let value = JSON.parse(payload);
  if (typeof value === "string") value = JSON.parse(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("state result is not an object");
  }
  return value;
}

async function screenshotBytes(result) {
  const images = (result.content ?? []).filter((item) => item?.type === "image");
  if (images.length !== 1 || images[0].mimeType !== "image/png") {
    throw new Error("screenshot tool did not return exactly one PNG image");
  }
  return Buffer.from(images[0].data, "base64");
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const rawPath = join(args.runDirectory, "raw", `${BACKEND}-r${args.repeat}.jsonl`);
  const screenshotDirectory = join(args.runDirectory, "screenshots");
  await mkdir(screenshotDirectory, { recursive: true });
  const recorder = await createRecorder(rawPath);
  const record = recorder.record;
  const fixtureBytes = await readFile(args.fixture);
  const registered = new Map();
  const observations = {};
  let fixtureServer;
  let camoufoxServer;
  let client;
  let mcpStderr = "";
  let caught = null;
  let phase = "setup";
  let initializationFailure = false;

  async function registerDescendants(reason) {
    const identities = await descendants(process.pid);
    for (const identity of identities) {
      registered.set(`${identity.pid}:${identity.startTicks}`, identity);
    }
    await record("process_tree", { reason, identities });
  }

  try {
    await record("case_start", {
      backend: BACKEND,
      repeat: args.repeat,
      seed: args.seed,
      runnerPid: process.pid,
      fixtureSha256: sha256(fixtureBytes),
      proxyEnvironment: {
        http_proxy: process.env.http_proxy ?? null,
        https_proxy: process.env.https_proxy ?? null,
        NO_PROXY: process.env.NO_PROXY ?? null,
        no_proxy: process.env.no_proxy ?? null,
      },
    });
    fixtureServer = await startFixtureServer(fixtureBytes);
    await record("local_server_started", { urlOrigin: "http://127.0.0.1:<ephemeral>" });

    phase = "browser_initialization";
    camoufoxServer = spawn(args.python, [
      resolve("scripts/experiments/probes/camoufox-mcp-v0/camoufox_server.py"),
    ], {
      cwd: resolve("."),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const endpoint = await waitForWebSocket(camoufoxServer);
    await registerDescendants("camoufox_endpoint_ready");
    observations.launch = true;

    const sdkRoot = join(args.toolRoot, "node", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import(pathToFileURL(join(sdkRoot, "client", "index.js")).href),
      import(pathToFileURL(join(sdkRoot, "client", "stdio.js")).href),
    ]);
    const mcpCli = join(args.toolRoot, "node", "node_modules", "@playwright", "mcp", "cli.js");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        mcpCli,
        "--endpoint", endpoint,
        "--isolated",
        "--output-dir", join(args.runDirectory, "mcp-internal", `r${args.repeat}`),
        "--viewport-size", "800x600",
        "--timeout-action", "1000",
        "--timeout-navigation", "30000",
        "--snapshot-mode", "none",
      ],
      env: process.env,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      mcpStderr += chunk.toString("utf8");
      if (mcpStderr.length > 16_000) mcpStderr = mcpStderr.slice(-16_000);
    });
    client = new Client({ name: "dolly-camoufox-probe", version: "0.0.1" });
    await client.connect(transport);
    await registerDescendants("mcp_connected");
    const inventory = await client.listTools();
    const toolNames = inventory.tools.map((tool) => tool.name).sort();
    const required = [
      "browser_navigate",
      "browser_take_screenshot",
      "browser_type",
      "browser_click",
      "browser_evaluate",
      "browser_snapshot",
    ];
    await record("mcp_tool_inventory", {
      toolNames,
      schemas: Object.fromEntries(inventory.tools
        .filter((tool) => required.includes(tool.name))
        .map((tool) => [tool.name, tool.inputSchema])),
    });
    const missing = required.filter((name) => !toolNames.includes(name));
    if (missing.length > 0) throw new Error(`required MCP tools missing: ${missing.join(", ")}`);
    observations.required_tool_inventory = true;

    async function callTool(name, arguments_) {
      const started = performance.now();
      const result = await client.callTool({ name, arguments: arguments_ });
      await record("mcp_tool_result", {
        name,
        arguments: arguments_,
        result: summarizeToolResult(result),
        durationMs: Number((performance.now() - started).toFixed(3)),
      });
      return result;
    }

    phase = "navigation";
    const navigation = await callTool("browser_navigate", { url: fixtureServer.url });
    if (navigation.isError === true) throw new Error(`navigation failed: ${textContent(navigation)}`);
    observations.local_navigation = true;
    const initialSnapshotResult = await callTool("browser_snapshot", {});
    const initialSnapshot = textContent(initialSnapshotResult);
    const inputRef = requireRef(initialSnapshot, "textbox", "Probe input");
    const applyRef = requireRef(initialSnapshot, "button", "Apply");
    const bottomRef = requireRef(initialSnapshot, "button", "Bottom");
    const recoverRef = requireRef(initialSnapshot, "button", "Recover");
    const initialState = parseState(await callTool("browser_evaluate", {
      function: "() => JSON.stringify(window.__probeRead())",
    }));

    phase = "scripted_actions";
    const topResult = await callTool("browser_take_screenshot", { type: "png", scale: "css" });
    const topBytes = await screenshotBytes(topResult);
    const topPath = join(screenshotDirectory, `${BACKEND}-r${args.repeat}-top.png`);
    await writeFile(topPath, topBytes, { flag: "wx", mode: 0o600 });
    await record("screenshot_written", {
      label: "top",
      relativePath: relative(args.runDirectory, topPath),
      byteLength: topBytes.length,
      sha256: sha256(topBytes),
    });
    observations.top_screenshot = true;

    await callTool("browser_type", {
      element: "Probe input",
      target: inputRef,
      text: INPUT_TEXT,
    });
    await callTool("browser_click", { element: "Apply", target: applyRef });
    const applied = parseState(await callTool("browser_evaluate", {
      function: "() => JSON.stringify(window.__probeRead())",
    }));
    await record("state_after_apply", { state: applied });
    if (applied.inputText !== INPUT_TEXT || applied.appliedCount !== 1) {
      throw new Error(`unexpected apply state: ${JSON.stringify(applied)}`);
    }
    observations.click = true;
    observations.text_input = true;
    observations.dom_state_change = true;

    await callTool("browser_evaluate", {
      function: "() => { window.scrollTo(0, document.documentElement.scrollHeight); return window.scrollY; }",
    });
    await callTool("browser_click", { element: "Bottom", target: bottomRef });
    const bottom = parseState(await callTool("browser_evaluate", {
      function: "() => JSON.stringify(window.__probeRead())",
    }));
    await record("state_after_bottom", { state: bottom });
    if (bottom.bottomCount !== 1 || !(bottom.scrollY > 0)) {
      throw new Error(`unexpected bottom state: ${JSON.stringify(bottom)}`);
    }
    observations.downward_scroll = true;

    const bottomResult = await callTool("browser_take_screenshot", { type: "png", scale: "css" });
    const bottomBytes = await screenshotBytes(bottomResult);
    const bottomPath = join(screenshotDirectory, `${BACKEND}-r${args.repeat}-bottom.png`);
    await writeFile(bottomPath, bottomBytes, { flag: "wx", mode: 0o600 });
    await record("screenshot_written", {
      label: "bottom",
      relativePath: relative(args.runDirectory, bottomPath),
      byteLength: bottomBytes.length,
      sha256: sha256(bottomBytes),
    });
    observations.bottom_screenshot = true;

    let expectedFailure = null;
    try {
      const missingResult = await callTool("browser_click", {
        element: "deliberately missing target",
        target: "deliberately-missing",
      });
      if (missingResult.isError === true) expectedFailure = textContent(missingResult);
    } catch (error) {
      expectedFailure = error instanceof Error ? error.message : String(error);
      await record("mcp_expected_tool_error", { errorMessage: expectedFailure.slice(0, 4000) });
    }
    if (expectedFailure === null) throw new Error("missing target did not produce an MCP error");
    observations.expected_failure_observed = true;

    await callTool("browser_click", { element: "Recover", target: recoverRef });
    const recovered = parseState(await callTool("browser_evaluate", {
      function: "() => JSON.stringify(window.__probeRead())",
    }));
    await record("state_after_recovery", { state: recovered });
    if (
      recovered.inputText !== INPUT_TEXT ||
      recovered.appliedCount !== 1 ||
      recovered.bottomCount !== 1 ||
      recovered.recoveredCount !== 1 ||
      recovered.pageTimeOrigin !== initialState.pageTimeOrigin
    ) {
      throw new Error(`unexpected recovery state: ${JSON.stringify(recovered)}`);
    }
    observations.same_session_recovery = true;
    await record("local_server_requests", { requestCounts: fixtureServer.requestCounts });
  } catch (error) {
    caught = error;
    initializationFailure = phase === "setup" || phase === "browser_initialization";
    await record("unexpected_error", {
      phase,
      initializationFailure,
      errorType: error?.constructor?.name ?? typeof error,
      errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
      stack: error instanceof Error ? error.stack?.slice(0, 12000) : null,
      mcpStderr: mcpStderr.slice(-4000),
    });
  } finally {
    phase = "cleanup";
    await registerDescendants("before_cleanup");
    if (client) {
      try {
        await client.close();
      } catch (error) {
        await record("mcp_close_error", {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (fixtureServer) {
      try {
        await fixtureServer.close();
      } catch (error) {
        await record("fixture_close_error", {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await delay(100);
    await registerDescendants("cleanup_scan");
    const remaining = await stopExactProcesses(
      [...registered.values()].filter(identityIsLive),
      record,
    );
    observations.clean_close = remaining.length === 0;
    await record("case_end", {
      backend: BACKEND,
      repeat: args.repeat,
      initializationFailure,
      runnerObservations: observations,
      runnerPass: caught === null && Object.values(observations).every(Boolean),
      independentPixelValidationPending: true,
      remainingRecordedProcesses: remaining,
    });
    await recorder.close();
  }
  return caught === null ? 0 : 1;
}

process.exit(await main());
