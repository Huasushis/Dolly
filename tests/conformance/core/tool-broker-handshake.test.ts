/**
 * First falsifiable conformance slice for the Host Tool Broker MCP handshake.
 *
 * Pins the spec obligations in docs/spec/services/tool-broker.md section 2 and
 * REQ-TOOL-008: the broker sends the legacy `initialize` request with
 * `protocolVersion = "2025-06-18"`, requires the response to select exactly
 * that version, and sends `notifications/initialized` before any discovery or
 * execution. It MUST NOT fall forward to another version advertised or
 * selected by the server. A server that cannot complete that exact lifecycle
 * is incompatible.
 *
 * The slice owns only the stdio handshake seam. There is no tool discovery,
 * invocation, idempotency, authorization, Streamable HTTP, or product wiring
 * here; those are later gates.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  adaptToolBrokerServer,
  parseToolBrokerConfig,
  startToolBrokerServer,
  TOOL_BROKER_CONFIG_SCHEMA,
  type HostResolvedExecutablePremise,
  type ToolBrokerConfigDocumentInput,
  type ToolBrokerServer,
  type ToolBrokerServerConfig,
  type ToolBrokerServerState,
  type PrepareResult,
} from "../../../src/core/tool-broker/index.js";
import { assertJsonValue, isJsonObject, type JsonValue } from "../../../src/core/canonical-json.js";

const FAKE_SERVER = fileURLToPath(
  new URL("./fixtures/tool-broker-fake-mcp-server.ts", import.meta.url),
);
const MCP_PROTOCOL_VERSION = "2025-06-18";

function spawnFake(mode: string) {
  return spawn(process.execPath, ["--import", "tsx/esm", FAKE_SERVER, mode], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

/**
 * Starts buffering the child's stderr immediately. The fake server echoes every
 * received frame to stderr as `RECV: <json-line>`, so this captures the exact
 * frames the broker sent (initialize request, notifications/initialized).
 * `messages` holds the parsed JSON values; `lines` holds the raw `RECV:` lines.
 * `done` resolves after the stderr stream ends or closes.
 */
function captureReceivedFrames(child: ChildProcess): {
  lines: string[];
  messages: JsonValue[];
  done: Promise<void>;
} {
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

/** Package identity shared by the fake server's v1 stdio transport. */
const FAKE_PACKAGE_ID = "org.dolly.tests.fake-mcp";
const FAKE_PACKAGE_VERSION = "1.0.0";
const FAKE_PACKAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const FAKE_EXECUTABLE = "bin/fake-mcp-server";
const FAKE_EXECUTABLE_DIGEST = `sha256:${"b".repeat(64)}`;

/** Builds the frozen v1 document for the fake stdio server. The mode is
 * carried in `transport.args` like every other configured arg; the Host
 * resolves `transport.executable` to a concrete file at start time (the
 * premise below). */
function baseDocument(mode: string): ToolBrokerConfigDocumentInput {
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
          args: ["--import", "tsx/esm", FAKE_SERVER, mode],
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
        tools: {},
      },
    },
  };
}

/** Parses a v1 document and returns the exact minted server config for the
 * fake server. The factory requires this minted identity. */
function parsedServer(document: ToolBrokerConfigDocumentInput): ToolBrokerServerConfig {
  return parseToolBrokerConfig(document, { configRevision: "rev-1" }).servers["fake-mcp"];
}

/** Host-resolved executable premise that echoes the configured identity and
 * names the concrete file (the injected spawn DI resolves to the fixture). */
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

/** Branded server config for handshake tests (empty closed tool map). */
function baseConfig(): ToolBrokerServerConfig {
  return parsedServer(baseDocument("exact"));
}

describe("Tool Broker 2025-06-18 stdio handshake (REQ-TOOL-008)", () => {
  it("sends initialize with the exact protocol version and completes the lifecycle", async () => {
    const child = spawnFake("exact");
    const capture = captureReceivedFrames(child);
    const broker = startToolBrokerServer(baseConfig(), premise(), {
      spawn: () => child,
      now: () => 0,
    });
    const result = await broker.prepare();

    expect(result.state).toBe("Ready");
    expect(result.toolServerId).toBe("fake-mcp");
    expect(result.toolServerGeneration).toBe(1);

    await capture.done;

    const initializeFrame = capture.messages.find(
      (message): message is Readonly<Record<string, JsonValue>> =>
        isJsonObject(message) &&
        message.method === "initialize",
    );
    expect(initializeFrame).toBeDefined();
    expect(initializeFrame!.jsonrpc).toBe("2.0");
    expect(initializeFrame!.method).toBe("initialize");
    expect(typeof initializeFrame!.id).toBe("number");
    expect((initializeFrame!.params as { protocolVersion?: unknown }).protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    assertJsonValue(initializeFrame!.params);

    const initializedFrame = capture.messages.find(
      (message): message is Readonly<Record<string, JsonValue>> =>
        isJsonObject(message) &&
        message.method === "notifications/initialized",
    );
    expect(initializedFrame).toBeDefined();
    expect(initializedFrame?.jsonrpc).toBe("2.0");
    // The initialized notification must follow the initialize request.
    const initializeIndex = capture.messages.indexOf(initializeFrame!);
    const initializedIndex = capture.messages.indexOf(initializedFrame as JsonValue);
    expect(initializedIndex).toBeGreaterThan(initializeIndex);

    await broker.stop();
    expect(broker.state).toBe("Stopped");
  });

  it("fails closed when the server advertises a different protocol version", async () => {
    const child = spawnFake("wrong-version");
    const capture = captureReceivedFrames(child);
    const broker = startToolBrokerServer(baseConfig(), premise(), {
      spawn: () => child,
      now: () => 0,
    });
    const result = await broker.prepare();

    expect(result.state).toBe("Quarantined");
    expect(result.errorCode).toBe("TOOL_BROKER_PROTOCOL_VERSION_MISMATCH");
    // No discovery or invocation frame is sent after the mismatch.
    await capture.done;
    const methods = capture.messages.map(
      (message) => (message as { method?: string }).method,
    );
    expect(methods).not.toContain("tools/list");
    expect(methods).not.toContain("tools/call");

    // The child is torn down on failure.
    await broker.stop();
    expect(child.exitCode).not.toBeNull();
    expect(broker.state).toBe("Stopped");
  });

  it("fails closed when the server sends a malformed response", async () => {
    const child = spawnFake("malformed");
    const broker = startToolBrokerServer(baseConfig(), premise(), {
      spawn: () => child,
      now: () => 0,
    });
    const result = await broker.prepare();

    expect(result.state).toBe("Quarantined");
    expect(result.errorCode).toBe("TOOL_BROKER_HANDSHAKE_MALFORMED");

    await broker.stop();
    expect(broker.state).toBe("Stopped");
  });

  it("fails closed on startup timeout when the server never responds", async () => {
    const child = spawnFake("no-response");
    // A fresh document with a shorter startup limit; parsed into a fresh
    // minted config (spread copies are rejected by the factory).
    const base = baseDocument("no-response");
    const baseServer = base.servers["fake-mcp"] as Record<string, unknown>;
    const shortDoc: ToolBrokerConfigDocumentInput = {
      ...base,
      servers: {
        ...base.servers,
        "fake-mcp": {
          ...baseServer,
          limits: { ...(baseServer.limits as Record<string, unknown>), startup_timeout_ms: 200 },
        },
      },
    };
    const broker = startToolBrokerServer(parsedServer(shortDoc), premise(), {
      spawn: () => child,
      now: () => 0,
    });
    const result = await broker.prepare();

    expect(result.state).toBe("Quarantined");
    expect(result.errorCode).toBe("TOOL_BROKER_STARTUP_TIMEOUT");

    await broker.stop();
    expect(broker.state).toBe("Stopped");
  });

  it("fails closed when the child exits before responding", async () => {
    const child = spawnFake("early-exit");
    const broker = startToolBrokerServer(baseConfig(), premise(), {
      spawn: () => child,
      now: () => 0,
    });
    const result = await broker.prepare();

    expect(result.state).toBe("Quarantined");
    expect(result.errorCode).toBe("TOOL_BROKER_CHILD_EXITED");

    await broker.stop();
    expect(broker.state).toBe("Stopped");
  });

  it("fails closed when a duplicate initialize response arrives during discovery", async () => {
    const child = spawnFake("duplicate-init");
    const broker = startToolBrokerServer(baseConfig(), premise(), {
      spawn: () => child,
      now: () => 0,
    });
    const result = await broker.prepare();

    // The first response selects 2025-06-18 and completes the handshake; the
    // duplicate is then read while the discovery request (a request id the
    // duplicate does not own) is in flight. An unexpected-id frame during an
    // in-flight request is a request-correlation violation, so the session
    // fails closed rather than letting a stray frame ride a later request.
    expect(result.state).toBe("Quarantined");
    expect(result.errorCode).toBe("TOOL_BROKER_PROTOCOL_FAILURE");

    await broker.stop();
    expect(broker.state).toBe("Stopped");
  });

  it("quarantines when the server sends initialized before the initialize result", async () => {
    const child = spawnFake("initialized-first");
    const broker = startToolBrokerServer(baseConfig(), premise(), {
      spawn: () => child,
      now: () => 0,
    });
    const result = await broker.prepare();

    // An out-of-order initialized notification is version-foreign lifecycle
    // behaviour and must not be treated as completion of the handshake.
    expect(result.state).toBe("Quarantined");

    await broker.stop();
    expect(broker.state).toBe("Stopped");
  });

  it("tears down the exact child on any handshake failure with no orphan", async () => {
    const child = spawnFake("wrong-version");
    const broker = startToolBrokerServer(baseConfig(), premise(), {
      spawn: () => child,
      now: () => 0,
    });
    await broker.prepare();
    await broker.stop();

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(broker.state).toBe("Stopped");
    // No dangling reference: a second stop is a no-op.
    await expect(broker.stop()).resolves.toBeUndefined();
  });

  it("rejects an unknown top-level config field", () => {
    expect(() =>
      parseToolBrokerConfig(
        { ...baseDocument("exact"), unexpected: true } as unknown as ToolBrokerConfigDocumentInput,
        { configRevision: "rev-1" },
      ),
    ).toThrow(/TOOL_BROKER_CONFIG_INVALID/u);
  });

  it("rejects a protocol version other than 2025-06-18", () => {
    const doc = baseDocument("exact");
    (doc.servers["fake-mcp"] as Record<string, unknown>).protocol_version = "2026-07-28";
    expect(() =>
      parseToolBrokerConfig(doc as unknown as ToolBrokerConfigDocumentInput, { configRevision: "rev-1" }),
    ).toThrow(/TOOL_BROKER_CONFIG_INVALID/u);
  });

  it("rejects an adapter other than mcp", () => {
    const doc = baseDocument("exact");
    (doc.servers["fake-mcp"] as Record<string, unknown>).adapter = "mcp-next";
    expect(() =>
      parseToolBrokerConfig(doc as unknown as ToolBrokerConfigDocumentInput, { configRevision: "rev-1" }),
    ).toThrow(/TOOL_BROKER_CONFIG_INVALID/u);
  });

  it("rejects a non-stdio transport in this slice", () => {
    const doc = baseDocument("exact");
    (doc.servers["fake-mcp"] as Record<string, unknown>).transport = { kind: "streamable_http", endpoint: "https://example.invalid" };
    expect(() =>
      parseToolBrokerConfig(doc as unknown as ToolBrokerConfigDocumentInput, { configRevision: "rev-1" }),
    ).toThrow(/TOOL_BROKER_CONFIG_INVALID/u);
  });

  it("exposes a deterministic request id sequence starting at 1", async () => {
    const child = spawnFake("exact");
    const capture = captureReceivedFrames(child);
    const broker = startToolBrokerServer(baseConfig(), premise(), {
      spawn: () => child,
      now: () => 0,
    });
    await broker.prepare();
    await capture.done;
    await broker.stop();

    const initializeFrame = capture.messages.find(
      (message): message is { id: number; method: string } =>
        typeof message === "object" &&
        message !== null &&
        (message as { method?: unknown }).method === "initialize",
    );
    expect(initializeFrame).toBeDefined();
    expect(initializeFrame!.id).toBe(1);
  });

  it("adaptToolBrokerServer returns a frozen, reusable prepared descriptor", async () => {
    const child = spawnFake("exact");
    const broker = startToolBrokerServer(baseConfig(), premise(), {
      spawn: () => child,
      now: () => 0,
    });
    const prepared = await broker.prepare();
    const adapted = adaptToolBrokerServer(prepared);
    expect(Object.isFrozen(adapted)).toBe(true);
    expect(adapted.toolServerId).toBe("fake-mcp");
    expect(adapted.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    await broker.stop();
  });

  it("rejects a caller-forged Ready result with no minted identity", async () => {
    const forged: PrepareResult = {
      state: "Ready",
      toolServerId: "ghost",
      toolServerGeneration: 2,
    };
    expect(() => adaptToolBrokerServer(forged)).toThrow(
      /exact.*PrepareResult|mint/iu,
    );
  });

  it("rejects a spread copy of a genuine result", async () => {
    const child = spawnFake("exact");
    const broker = startToolBrokerServer(baseConfig(), premise(), {
      spawn: () => child,
      now: () => 0,
    });
    const prepared = await broker.prepare();
    const copied = { ...prepared };
    expect(copied).not.toBe(prepared);
    expect(() => adaptToolBrokerServer(copied)).toThrow(
      /exact.*PrepareResult|mint/iu,
    );
    await broker.stop();
  });

  it("reuses the exact minted identity on an idempotent prepare call", async () => {
    const child = spawnFake("exact");
    const broker = startToolBrokerServer(baseConfig(), premise(), {
      spawn: () => child,
      now: () => 0,
    });
    const first = await broker.prepare();
    const second = await broker.prepare();
    expect(second).toBe(first);
    const adapted = adaptToolBrokerServer(second);
    expect(adapted.toolServerId).toBe("fake-mcp");
    expect(adapted.toolServerGeneration).toBe(1);
    await broker.stop();
  });

  it("cannot mutate a genuine Quarantined result into Ready; identity does not project", async () => {
    const child = spawnFake("wrong-version");
    const broker = startToolBrokerServer(baseConfig(), premise(), {
      spawn: () => child,
      now: () => 0,
    });
    const result = await broker.prepare();
    expect(result.state).toBe("Quarantined");
    // The minted result is frozen: mutation must fail in strict mode.
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => {
      (result as { state: string }).state = "Ready";
    }).toThrow(TypeError);
    expect(result.state).toBe("Quarantined");
    // Identity cannot project altered authority either way.
    expect(() => adaptToolBrokerServer(result)).toThrow(/Ready/iu);
    await broker.stop();
  });

  it("cannot mutate a genuine Ready generation to project altered authority", async () => {
    const child = spawnFake("exact");
    const broker = startToolBrokerServer(baseConfig(), premise(), {
      spawn: () => child,
      now: () => 0,
    });
    const result = await broker.prepare();
    expect(result.state).toBe("Ready");
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => {
      (result as { toolServerGeneration: number }).toolServerGeneration = 99;
    }).toThrow(TypeError);
    expect(() => {
      (result as { toolServerId: string }).toolServerId = "ghost";
    }).toThrow(TypeError);

    const adapted = adaptToolBrokerServer(result);
    expect(adapted.toolServerId).toBe("fake-mcp");
    expect(adapted.toolServerGeneration).toBe(1);
    await broker.stop();
  });
});
