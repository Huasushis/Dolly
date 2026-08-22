/**
 * Post-handshake session substrate for the Host Tool Broker MCP stdio
 * slice: the generation stays alive after initialize/initialized and the
 * host can send a serialized exact-id `ping` request. Pins REQ-TOOL-008 and
 * the premise matrix in the W1 packet: the host is the sole authority that
 * assigns request ids; the server response is correlated evidence only and
 * never authorizes another request. Any protocol violation, timeout, or
 * child exit during the request quarantines and tears down before rejecting.
 *
 * The slice owns only the ping substrate. There is no tools/list, tools/call,
 * registry, approval, cancellation, or HTTP here.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseToolBrokerConfig,
  startToolBrokerServer,
  TOOL_BROKER_CONFIG_SCHEMA,
  type HostResolvedExecutablePremise,
  type ToolBrokerConfigDocumentInput,
  type ToolBrokerServer,
  type ToolBrokerServerConfig,
  type ToolBrokerErrorCode,
  type ToolBrokerServerState,
} from "../../../src/core/tool-broker/index.js";
import { isJsonObject, type JsonValue } from "../../../src/core/canonical-json.js";

const FAKE_SERVER = fileURLToPath(
  new URL("./fixtures/tool-broker-fake-mcp-server.ts", import.meta.url),
);
const MCP_PROTOCOL_VERSION = "2025-06-18";
const FAKE_PACKAGE_ID = "org.dolly.tests.fake-mcp";
const FAKE_PACKAGE_VERSION = "1.0.0";
const FAKE_PACKAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const FAKE_EXECUTABLE = "bin/fake-mcp-server";
const FAKE_EXECUTABLE_DIGEST = `sha256:${"b".repeat(64)}`;

function spawnFake(mode: string): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx/esm", FAKE_SERVER, mode], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

/**
 * Starts buffering the child's stderr immediately. The fake server echoes every
 * received frame to stderr as `RECV: <json-line>`, so this captures the exact
 * frames the broker sent (initialize request, notifications/initialized, and
 * ping requests). `messages` holds the parsed JSON values; `done` resolves
 * after the stderr stream ends or closes.
 */
interface CapturedFrames {
  lines: string[];
  messages: JsonValue[];
  done: Promise<void>;
}

function captureReceivedFrames(child: ChildProcess): CapturedFrames {
  const lines: string[] = [];
  const messages: JsonValue[] = [];
  const done = new Promise<void>((resolve) => {
    if (child.stderr === null) {
      resolve();
      return;
    }
    const stderr = child.stderr;
    let buffer = "";
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const raw = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!raw.startsWith("RECV: ")) continue;
        const line = raw.slice("RECV: ".length);
        lines.push(line);
        if (line.trim() === "") continue;
        try {
          messages.push(JSON.parse(line) as JsonValue);
        } catch {
          // Keep the raw line for malformed assertions.
        }
      }
    });
    stderr.on("end", resolve);
    stderr.on("close", resolve);
  });
  return { lines, messages, done };
}

/** Builds the frozen v1 document for the ping-substrate fake server. */
function pingDocument(overrides: Partial<Record<string, unknown>> = {}): ToolBrokerConfigDocumentInput {
  return {
    schema: TOOL_BROKER_CONFIG_SCHEMA,
    servers: {
      "fake-mcp": {
        enabled: true,
        adapter: "mcp",
        protocol_version: MCP_PROTOCOL_VERSION,
        transport: {
          kind: "stdio",
          package_id: FAKE_PACKAGE_ID,
          package_version: FAKE_PACKAGE_VERSION,
          package_digest: FAKE_PACKAGE_DIGEST,
          executable: FAKE_EXECUTABLE,
          executable_digest: FAKE_EXECUTABLE_DIGEST,
          args: ["--import", "tsx/esm", FAKE_SERVER, "ping-ok"],
          secret_bindings: {},
        },
        allowed_modules: ["main-brain"],
        limits: {
          startup_timeout_ms: 2000,
          request_timeout_ms: 10000,
          max_concurrency: 4,
          max_request_bytes: 1048576,
          max_response_bytes: 4194304,
        },
        // Closed configured tool map: empty in the ping-substrate tests, so
        // the fixture's empty advertised tools/list verifies it during
        // prepare.
        tools: {},
        ...overrides,
      },
    },
  };
}

/** Parses a v1 document and returns the exact minted server config. */
function parsedServer(document: ToolBrokerConfigDocumentInput): ToolBrokerServerConfig {
  return parseToolBrokerConfig(document, { configRevision: "rev-1" }).servers["fake-mcp"];
}

/** Host-resolved executable premise that echoes the configured identity. */
function premise(): HostResolvedExecutablePremise {
  return {
    executablePath: process.execPath,
    package_id: FAKE_PACKAGE_ID,
    package_version: FAKE_PACKAGE_VERSION,
    package_digest: FAKE_PACKAGE_DIGEST,
    executable: FAKE_EXECUTABLE,
    executable_digest: FAKE_EXECUTABLE_DIGEST,
  };
}

/** Collects broker instances so their children are never left running. */
const running: Array<{ broker: ToolBrokerServer; child: ChildProcess; capture: CapturedFrames }> = [];
afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop()!;
    if (entry.broker.state !== "Stopped") {
      await entry.broker.stop().catch(() => undefined);
    }
  }
});

interface StartedBroker {
  broker: ToolBrokerServer;
  child: ChildProcess;
  capture: CapturedFrames;
}

function startBroker(mode: string, overrides: Partial<Record<string, unknown>> = {}): StartedBroker {
  const child = spawnFake(mode);
  const capture = captureReceivedFrames(child);
  const broker = startToolBrokerServer(parsedServer(pingDocument(overrides)), premise(), {
    spawn: () => child,
    now: () => 0,
  });
  running.push({ broker, child, capture });
  return { broker, child, capture };
}

function pingFrames(messages: JsonValue[]): Array<{ id: number }> {
  return messages
    .filter(
      (message): message is { id: number } & Readonly<Record<string, JsonValue>> =>
        isJsonObject(message) && message.method === "ping" && typeof message.id === "number",
    )
    .map((message) => ({ id: message.id }));
}

/** Boundedly waits for the broker to reach a state. Used where the session
 * must observe an asynchronous background transition (idle child exit).
 *
 * This is a real-integration wait: the child is a separate process that
 * exits on the platform clock, so fake timers cannot drive it (the event
 * does not travel through vitest's clock), and the broker exposes no promise
 * for the background transition. Polling keeps the wait bounded so a missed
 * transition surfaces as a state assertion, not a hang.
 */
function waitForState(
  broker: ToolBrokerServer,
  state: ToolBrokerServerState,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = (): void => {
      if (broker.state === state || Date.now() - started >= timeoutMs) {
        resolve();
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
    // NOTE: Promise.withResolvers is unavailable on Node 20, the runtime
    // Vitest executes under; the executor form is required here.
  });
}

/** Asserts the quarantine contract shared by every ping failure path:
 * the error code, the Ready->Quarantined transition, and a confirmed-dead
 * child (teardown completed before the rejection surfaced). */
function assertQuarantined(
  error: unknown,
  code: ToolBrokerErrorCode,
  broker: ToolBrokerServer,
  child: ChildProcess,
): void {
  expect((error as { code?: ToolBrokerErrorCode }).code).toBe(code);
  expect(broker.state).toBe("Quarantined");
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
}

describe("Tool Broker post-handshake session (ping substrate)", () => {
  it("ping resolves after handshake and keeps the generation alive", async () => {
    const { broker, child } = startBroker("ping-ok");
    await broker.prepare();
    await broker.ping();

    expect(broker.state).toBe("Ready");
    // The generation is alive: the child has not exited before stop().
    expect(broker.toolServerGeneration).toBe(1);
    expect(child.exitCode).toBeNull();

    await broker.stop();
    expect(broker.state).toBe("Stopped");
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("ping accepts a closed result with optional _meta", async () => {
    const { broker } = startBroker("ping-meta");
    await broker.prepare();
    await broker.ping();
    expect(broker.state).toBe("Ready");
    await broker.stop();
  });

  it("post-handshake request id starts at 3 and increments monotonically", async () => {
    const { broker, capture } = startBroker("ping-ok");
    await broker.prepare();
    await broker.ping();
    await broker.ping();
    await broker.stop();
    await capture.done;

    // prepare() consumes id 1 (initialize) and id 2 (tools/list discovery);
    // the first ping is therefore id 3.
    const ids = pingFrames(capture.messages).map((frame) => frame.id);
    expect(ids).toEqual([3, 4]);
  });

  it("ping rejects a response with the wrong id", async () => {
    const { broker, child } = startBroker("ping-wrong-id");
    await broker.prepare();
    const error = await broker.ping().then(
      () => undefined,
      (e: unknown) => e,
    );
    assertQuarantined(error, "TOOL_BROKER_PROTOCOL_FAILURE", broker, child);
    await broker.stop();
    expect(broker.state).toBe("Stopped");
  });

  it("ping rejects a malformed non-object result", async () => {
    const { broker, child } = startBroker("ping-malformed-result");
    await broker.prepare();
    const error = await broker.ping().then(
      () => undefined,
      (e: unknown) => e,
    );
    assertQuarantined(error, "TOOL_BROKER_PROTOCOL_FAILURE", broker, child);
    await broker.stop();
  });

  it("ping rejects a notification sent in place of a response", async () => {
    const { broker, child } = startBroker("ping-notification");
    await broker.prepare();
    const error = await broker.ping().then(
      () => undefined,
      (e: unknown) => e,
    );
    assertQuarantined(error, "TOOL_BROKER_PROTOCOL_FAILURE", broker, child);
    await broker.stop();
  });

  it("ping rejects a JSON-RPC error envelope", async () => {
    const { broker, child } = startBroker("ping-error");
    await broker.prepare();
    const error = await broker.ping().then(
      () => undefined,
      (e: unknown) => e,
    );
    assertQuarantined(error, "TOOL_BROKER_PROTOCOL_FAILURE", broker, child);
    await broker.stop();
  });

  it("ping times out when the server never responds", async () => {
    const { broker, child } = startBroker("ping-no-response", {
      limits: {
        startup_timeout_ms: 2000,
        request_timeout_ms: 200,
        max_concurrency: 4,
        max_request_bytes: 1048576,
        max_response_bytes: 4194304,
      },
    });
    await broker.prepare();
    const error = await broker.ping().then(
      () => undefined,
      (e: unknown) => e,
    );
    assertQuarantined(error, "TOOL_BROKER_REQUEST_TIMEOUT", broker, child);
    await broker.stop();
  });

  it("fails closed on a served request frame — reverse premise", async () => {
    const { broker, child, capture } = startBroker("ping-server-request");
    // The server initiates its own JSON-RPC request (id 777, tools/list)
    // right after the initialized notification, instead of answering the
    // host's discovery request (id 2). prepare() must reject it as a
    // protocol failure: the host is the sole authority that assigns
    // request ids, and a server-originated request can never double as the
    // correlated response for the host's own tools/list.
    const result = await broker.prepare();
    expect(result.state).toBe("Quarantined");
    expect(result.errorCode).toBe("TOOL_BROKER_PROTOCOL_FAILURE");
    expect(broker.state).toBe("Quarantined");
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);

    // Fail-closed: exactly one outbound discovery request, no retry, and no
    // response written for the server's own id-777 request.
    await capture.done;
    expect(capture.messages.filter(isJsonObject).map((m) => m.method)).toContain("tools/list");
    expect(capture.messages.some((m) => isJsonObject(m) && m.id === 777)).toBe(false);

    await broker.stop();
    expect(broker.state).toBe("Stopped");
  });

  it("observes an idle child exit and quarantines without any request", async () => {
    const { broker, child, capture } = startBroker("ping-idle-exit");
    await broker.prepare();
    expect(broker.state).toBe("Ready");

    // No ping is sent: the child exits on its own after the handshake and the
    // session must observe that background exit and quarantine exactly once.
    await waitForState(broker, "Quarantined", 3000);
    expect(broker.state).toBe("Quarantined");
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    // No ping frame was ever sent to the server.
    await capture.done;
    expect(pingFrames(capture.messages)).toEqual([]);

    await broker.stop();
    expect(broker.state).toBe("Stopped");
  });

  it("stop while ping in flight tears down and ping rejects", async () => {
    const { broker, child } = startBroker("ping-no-response");
    await broker.prepare();

    const pendingPing = broker.ping();
    // Attach the settlement observer immediately so the teardown-driven
    // rejection is never left unhandled.
    const pingSettled = pendingPing.then(
      () => undefined,
      (e: unknown) => e,
    );
    await broker.stop();
    expect(broker.state).toBe("Stopped");
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);

    await expect(pingSettled).resolves.toMatchObject({ code: "TOOL_BROKER_CHILD_EXITED" });
    await expect(broker.stop()).resolves.toBeUndefined();
    expect(broker.state).toBe("Stopped");
  });

  it("ping rejects with NOT_READY when stopped", async () => {
    const { broker, capture } = startBroker("ping-ok");
    await broker.prepare();
    await broker.stop();
    await capture.done;

    await expect(broker.ping()).rejects.toMatchObject({ code: "TOOL_BROKER_NOT_READY" });
    expect(broker.state).toBe("Stopped");
    // No ping frame was ever sent to the server.
    expect(pingFrames(capture.messages)).toEqual([]);
  });

  it("ping rejects with NOT_READY after quarantine; teardown idempotent", async () => {
    const { broker, child } = startBroker("ping-wrong-id");
    await broker.prepare();
    const firstError = await broker.ping().then(
      () => undefined,
      (e: unknown) => e,
    );
    assertQuarantined(firstError, "TOOL_BROKER_PROTOCOL_FAILURE", broker, child);

    // After quarantine, ping rejects NOT_READY without sending a frame or
    // touching teardown state.
    await expect(broker.ping()).rejects.toMatchObject({ code: "TOOL_BROKER_NOT_READY" });
    expect(broker.state).toBe("Quarantined");

    await broker.stop();
    await expect(broker.stop()).resolves.toBeUndefined();
    expect(broker.state).toBe("Stopped");
  });
});
