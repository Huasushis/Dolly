/**
 * Discovery and contract-pinning conformance (spec section 3): the broker
 * issues `tools/list` during `prepare()`, after the handshake and before
 * Ready. The server's advertised content is verification input only: it can
 * verify the closed Host-configured tool map, never widen it. Missing
 * configured upstream, schema-digest mismatch, duplicate, or malformed
 * discovery content rejects the candidate with `TOOL_CONFIG_INVALID` and
 * quarantines. A mooted/Ready generation carries a pinned catalog whose
 * identity (server id + generation + config revision) gates later use via
 * `matchToolCatalog`.
 *
 * Wire/envelope violations (wrong id, error envelope, notification-as-
 * response, malformed line) are protocol failures; content violations
 * (missing upstream, digest mismatch, duplicates, malformed entries) are
 * `TOOL_CONFIG_INVALID`. The enabled-by-default W1 handshake and ping suites
 * keep their existing coverage; this file owns the discovery layer on top.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseToolBrokerConfig,
  startToolBrokerServer,
  pinnedToolCatalog,
  matchToolCatalog,
  type PrepareResult,
  type ToolBrokerServer,
  type ToolBrokerServerConfig,
} from "../../../src/core/tool-broker/index.js";
import {
  canonicalJsonDigest,
  type JsonValue,
} from "../../../src/core/canonical-json.js";

const FAKE_SERVER = fileURLToPath(
  new URL("./fixtures/tool-broker-fake-mcp-server.ts", import.meta.url),
);
const MCP_PROTOCOL_VERSION = "2025-06-18";

/** One configured tool binding shared by most tests: alias "repo_search_issues"
 * upstream "github.search_issues" with a small object-form input schema. */
const SCHEMA: JsonValue = {
  type: "object",
  properties: { q: { type: "string" } },
  required: ["q"],
  additionalProperties: false,
};
const SCHEMA_DIGEST = canonicalJsonDigest(SCHEMA);

function spawnFake(mode: string, catalogJson?: string): ChildProcess {
  const args = ["--import", "tsx/esm", FAKE_SERVER, mode];
  if (catalogJson !== undefined) args.push(catalogJson);
  return spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

/** Builds the discovery config with a closed empty-or-single tool map. */
function discoveryConfig(overrides: Partial<ToolBrokerServerConfig> = {}): ToolBrokerServerConfig {
  return {
    serverId: "fake-mcp",
    adapter: "mcp",
    protocolVersion: MCP_PROTOCOL_VERSION,
    transport: {
      kind: "stdio",
      command: process.execPath,
      args: ["--import", "tsx/esm", FAKE_SERVER, "discovery-ok"],
      env: {},
    },
    startupTimeoutMs: 2000,
    configRevision: "rev-1",
    tools: {
      repo_search_issues: {
        upstreamName: "github.search_issues",
        inputSchema: SCHEMA,
        inputSchemaDigest: SCHEMA_DIGEST,
      },
    },
    ...overrides,
  };
}

/** Collects broker instances so their children are never left running. */
const running: Array<{ broker: ToolBrokerServer; child: ChildProcess }> = [];
afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop()!;
    if (entry.broker.state !== "Stopped") {
      await entry.broker.stop().catch(() => undefined);
    }
  }
});

interface StartedDiscovery {
  broker: ToolBrokerServer;
  child: ChildProcess;
}

/** Starts a broker whose fixture serves the given tools/list result content. */
function startDiscovery(
  mode: string,
  catalogContent?: JsonValue,
  overrides: Partial<ToolBrokerServerConfig> = {},
): StartedDiscovery {
  const child = spawnFake(mode, catalogContent === undefined ? undefined : JSON.stringify(catalogContent));
  const broker = startToolBrokerServer(discoveryConfig(overrides), {
    spawn: () => child,
    now: () => 0,
  });
  running.push({ broker, child });
  return { broker, child };
}

/** Asserts the TOOL_CONFIG_INVALID quarantine contract shared by every
 * discovery-content failure: the returned Quarantined result carries the
 * code and teardown completed (child confirmed dead). */
function assertDiscoveryRejected(result: PrepareResult, child: ChildProcess): void {
  expect(result.state).toBe("Quarantined");
  expect(result.errorCode).toBe("TOOL_CONFIG_INVALID");
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
}

describe("Tool Broker discovery and catalog pinning (spec section 3)", () => {
  it("pins the configured catalog on an exact tools/list match", async () => {
    const { broker, child } = startDiscovery("discovery-ok", {
      tools: [
        {
          name: "github.search_issues",
          description: "search issues",
          inputSchema: SCHEMA,
        },
      ],
    });
    const prepared = await broker.prepare();
    expect(prepared.state).toBe("Ready");
    expect(broker.state).toBe("Ready");

    // Discovery happens after the handshake, before Ready; the pinned catalog
    // is available on the Ready result.
    const catalog = pinnedToolCatalog(prepared);
    expect(catalog.schema).toBe("dolly.tool-catalog/v1");
    expect(catalog.toolServerId).toBe("fake-mcp");
    expect(catalog.toolServerGeneration).toBe(1);
    expect(catalog.configRevision).toBe("rev-1");
    expect(catalog.tools.repo_search_issues.upstreamName).toBe("github.search_issues");
    expect(catalog.tools.repo_search_issues.inputSchemaDigest).toBe(SCHEMA_DIGEST);
    expect(Object.isFrozen(catalog.tools)).toBe(true);

    // The catalog matches the context it was pinned to.
    expect(
      matchToolCatalog(catalog, {
        toolServerId: "fake-mcp",
        toolServerGeneration: 1,
        configRevision: "rev-1",
      }),
    ).toBe(true);
    await broker.stop();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("rejects with TOOL_CONFIG_INVALID when a configured upstream is not advertised", async () => {
    const { broker, child } = startDiscovery("discovery-ok", {
      tools: [
        {
          name: "github.some_other_tool",
          description: "unrelated",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    const prepared = await broker.prepare();
    assertDiscoveryRejected(prepared, child);
    await broker.stop();
  });

  it("rejects with TOOL_CONFIG_INVALID on an advertised schema digest mismatch", async () => {
    const { broker, child } = startDiscovery("discovery-ok", {
      tools: [
        {
          name: "github.search_issues",
          description: "search issues",
          inputSchema: { type: "object", properties: { q: { type: "integer" } } },
        },
      ],
    });
    const prepared = await broker.prepare();
    // Same upstream name but a different schema -> digest mismatch.
    assertDiscoveryRejected(prepared, child);
    await broker.stop();
  });

  it("never widens the pinned catalog with extra advertised tools", async () => {
    const { broker, child } = startDiscovery("discovery-ok", {
      tools: [
        {
          name: "github.search_issues",
          description: "search issues",
          inputSchema: SCHEMA,
        },
        {
          name: "github.extra_tool",
          description: "not configured",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    const prepared = await broker.prepare();
    expect(prepared.state).toBe("Ready");

    const catalog = pinnedToolCatalog(prepared);
    // The catalog is exactly the closed configured map; the extra advertised
    // tool never appears in it.
    expect(Object.keys(catalog.tools)).toEqual(["repo_search_issues"]);
    expect(catalog.tools.extra_tool ?? null).toBeNull();
    await broker.stop();
  });

  it("rejects with TOOL_CONFIG_INVALID on a duplicate advertised name", async () => {
    const { broker, child } = startDiscovery("discovery-ok", {
      tools: [
        { name: "github.search_issues", description: "a", inputSchema: SCHEMA },
        { name: "github.search_issues", description: "b", inputSchema: SCHEMA },
      ],
    });
    const prepared = await broker.prepare();
    assertDiscoveryRejected(prepared, child);
    await broker.stop();
  });

  it("rejects with TOOL_CONFIG_INVALID on malformed tools/list content", async () => {
    // result.tools must be an array of well-formed entries: non-array value.
    const nonArray = startDiscovery("discovery-ok", { tools: "not-an-array" } as unknown as JsonValue);
    const preparedNonArray = await nonArray.broker.prepare();
    assertDiscoveryRejected(preparedNonArray, nonArray.child);
    await nonArray.broker.stop();

    // Unknown entry field.
    const unknownKey = startDiscovery("discovery-ok", {
      tools: [{ name: "github.search_issues", inputSchema: SCHEMA, surprise: 1 }],
    } as unknown as JsonValue);
    const preparedUnknownKey = await unknownKey.broker.prepare();
    assertDiscoveryRejected(preparedUnknownKey, unknownKey.child);
    await unknownKey.broker.stop();

    // Non-object-form root schema.
    const badSchema = startDiscovery("discovery-ok", {
      tools: [{ name: "github.search_issues", inputSchema: { type: "string" } }],
    } as unknown as JsonValue);
    const preparedBadSchema = await badSchema.broker.prepare();
    assertDiscoveryRejected(preparedBadSchema, badSchema.child);
    await badSchema.broker.stop();
  });

  it("rejects with TOOL_CONFIG_INVALID when an advertised entry has an invalid name", async () => {
    const { broker, child } = startDiscovery("discovery-ok", {
      tools: [{ name: "", description: "empty name", inputSchema: SCHEMA }],
    } as unknown as JsonValue);
    const prepared = await broker.prepare();
    assertDiscoveryRejected(prepared, child);
    await broker.stop();
  });

  it("classifies wire-level discovery violations as protocol failures", async () => {
    // Error envelope instead of a result.
    const errorCase = startDiscovery("discovery-error");
    const preparedError = await errorCase.broker.prepare();
    expect(preparedError.state).toBe("Quarantined");
    expect(preparedError.errorCode).toBe("TOOL_BROKER_PROTOCOL_FAILURE");
    await errorCase.broker.stop();

    // A notification can never complete a request.
    const notificationCase = startDiscovery("discovery-notification");
    const preparedNotification = await notificationCase.broker.prepare();
    expect(preparedNotification.state).toBe("Quarantined");
    expect(preparedNotification.errorCode).toBe("TOOL_BROKER_PROTOCOL_FAILURE");
    await notificationCase.broker.stop();

    // A wrong id is a correlation violation.
    const wrongIdCase = startDiscovery("discovery-wrong-id");
    const preparedWrongId = await wrongIdCase.broker.prepare();
    expect(preparedWrongId.state).toBe("Quarantined");
    expect(preparedWrongId.errorCode).toBe("TOOL_BROKER_PROTOCOL_FAILURE");
    await wrongIdCase.broker.stop();

    // A non-JSON line is a malformed read.
    const malformedCase = startDiscovery("discovery-malformed");
    const preparedMalformed = await malformedCase.broker.prepare();
    expect(preparedMalformed.state).toBe("Quarantined");
    expect(preparedMalformed.errorCode).toBe("TOOL_BROKER_PROTOCOL_FAILURE");
    await malformedCase.broker.stop();
  });

  it("rejects with TOOL_BROKER_STARTUP_TIMEOUT when discovery never responds", async () => {
    const { broker, child } = startDiscovery("discovery-no-response", undefined, { startupTimeoutMs: 400 });
    const prepared = await broker.prepare();
    expect(prepared.state).toBe("Quarantined");
    expect(prepared.errorCode).toBe("TOOL_BROKER_STARTUP_TIMEOUT");
    await broker.stop();
  });

  it("rejects a stale-generation catalog and matches only its own context", async () => {
    const { broker, child } = startDiscovery("discovery-ok", {
      tools: [{ name: "github.search_issues", description: "search issues", inputSchema: SCHEMA }],
    });
    const prepared = await broker.prepare();
    expect(prepared.state).toBe("Ready");
    const catalog = pinnedToolCatalog(prepared);

    // Same server and revision, but the context reports a newer generation.
    expect(
      matchToolCatalog(catalog, {
        toolServerId: "fake-mcp",
        toolServerGeneration: 2,
        configRevision: "rev-1",
      }),
    ).toBe(false);
    // Same server and generation, but a newer config revision.
    expect(
      matchToolCatalog(catalog, {
        toolServerId: "fake-mcp",
        toolServerGeneration: 1,
        configRevision: "rev-2",
      }),
    ).toBe(false);
    await broker.stop();
  });

  it("rejects an externally fabricated catalog and forged access", async () => {
    const { broker, child } = startDiscovery("discovery-ok", {
      tools: [{ name: "github.search_issues", description: "search issues", inputSchema: SCHEMA }],
    });
    const prepared = await broker.prepare();

    // A caller-built catalog cannot pass the identity gate.
    const forgedCatalog = {
      schema: "dolly.tool-catalog/v1",
      toolServerId: "fake-mcp",
      toolServerGeneration: 1,
      configRevision: "rev-1",
      tools: { repo_search_issues: { upstreamName: "github.search_issues", inputSchema: SCHEMA, inputSchemaDigest: SCHEMA_DIGEST } },
    } as const;
    expect(() =>
      matchToolCatalog(forgedCatalog as never, {
        toolServerId: "fake-mcp",
        toolServerGeneration: 1,
        configRevision: "rev-1",
      }),
    ).toThrow(/produced by prepare/iu);

    // A spread copy of the genuine catalog is a different object: rejected.
    expect(() => matchToolCatalog({ ...pinnedToolCatalog(prepared) }, {
      toolServerId: "fake-mcp",
      toolServerGeneration: 1,
      configRevision: "rev-1",
    })).toThrow(/produced by prepare/iu);

    // pinnedToolCatalog requires the exact minted Ready result; a spread copy
    // is not that identity.
    expect(() => pinnedToolCatalog({ ...prepared })).toThrow(/exact PrepareResult/iu);
    await broker.stop();
  });

  it("config admission rejects a rotated schema digest and a duplicate upstream", () => {
    // The configured digest must equal the recomputed JCS digest of the
    // embedded schema: a stale/rotated key cannot pin a different contract.
    expect(() =>
      parseToolBrokerConfig({
        ...discoveryConfig(),
        tools: {
          repo_search_issues: {
            upstreamName: "github.search_issues",
            inputSchema: SCHEMA,
            inputSchemaDigest: canonicalJsonDigest({ type: "object", properties: {} }),
          },
        },
      }),
    ).toThrow(/TOOL_BROKER_CONFIG_INVALID/iu);

    // Two aliases cannot bind the same upstream name in the closed map.
    expect(() =>
      parseToolBrokerConfig({
        ...discoveryConfig(),
        tools: {
          a: { upstreamName: "github.same", inputSchema: SCHEMA, inputSchemaDigest: SCHEMA_DIGEST },
          b: { upstreamName: "github.same", inputSchema: SCHEMA, inputSchemaDigest: SCHEMA_DIGEST },
        },
      }),
    ).toThrow(/TOOL_BROKER_CONFIG_INVALID/iu);
  });

  it("exposes the pinned catalog only on a minted Ready result", async () => {
    const { broker, child } = startDiscovery("discovery-ok", {
      tools: [{ name: "github.search_issues", description: "search issues", inputSchema: SCHEMA }],
    });
    // A Quarantined result carries no catalog.
    const rejectedBroker = startDiscovery("discovery-error");
    const rejected = await rejectedBroker.broker.prepare();
    expect(rejected.state).toBe("Quarantined");
    expect(rejected.catalog ?? null).toBeNull();
    await rejectedBroker.broker.stop();

    const prepared = await broker.prepare();
    expect(prepared.state).toBe("Ready");
    const catalog = pinnedToolCatalog(prepared);
    expect(typeof catalog.tools).toBe("object");
    await broker.stop();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});
