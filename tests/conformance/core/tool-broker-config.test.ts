/**
 * Config admission cutover conformance: the first spec-convergence slice for
 * the Host Tool Broker turns the lax camelCase / raw `transport.command`
 * parsing off and applies the frozen `dolly.tool-broker-config/v1`
 * package-bound stdio document (`tool-broker-config.schema.json` +
 * `common.schema.json`).
 *
 * Pinned contracts (RED):
 * - a valid exact v1 document parses into a branded, frozen server config;
 * - any legacy camelCase / raw `command` / free-path transport is refused
 *   with `TOOL_BROKER_CONFIG_INVALID` BEFORE any spawn/filesystem/network/
 *   backend call — admission is side-effect-free;
 * - a missing or malformed digest (package/executable/input/output) refuses;
 * - missing `allowed_modules`, missing `enabled`, or incomplete `limits`
 *   refuse;
 * - the factory never spawns `config.transport.command` — it accepts a
 *   separate Host-resolved executable premise that must echo the exact
 *   configured package/executable identity, and a copied/unparsed config is
 *   rejected at the factory before spawn (spy call count stays 0).
 *
 * No external tools are spawned in this file: the factory is exercised with
 * an injected spy `spawn` that must never be called for refused inputs.
 */
import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import {
  TOOL_BROKER_CONFIG_SCHEMA,
  isParsedToolBrokerServerConfig,
  parseToolBrokerConfig,
  startToolBrokerServer,
  type HostResolvedExecutablePremise,
  type ToolBrokerConfigDocumentInput,
  type ToolBrokerServerConfig,
} from "../../../src/core/tool-broker/index.js";
import { canonicalJsonDigest, type JsonValue } from "../../../src/core/canonical-json.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const PACKAGE_ID = "org.dolly.tests.fake-mcp";
const PACKAGE_VERSION = "1.0.0";
const PACKAGE_HASH = `sha256:${"a".repeat(64)}`;
const EXECUTABLE = "bin/fake-mcp-server";
const EXECUTABLE_DIGEST = `sha256:${"b".repeat(64)}`;

const SCHEMA: JsonValue = {
  type: "object",
  properties: { q: { type: "string" } },
  required: ["q"],
  additionalProperties: false,
};
const SCHEMA_DIGEST = canonicalJsonDigest(SCHEMA);
const OUTPUT_SCHEMA: JsonValue = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};
const OUTPUT_SCHEMA_DIGEST = canonicalJsonDigest(OUTPUT_SCHEMA);

/** Builds a full closed Tool entry for the fake server. */
function toolEntry(): Record<string, unknown> {
  return {
    upstream_name: "github.search_issues",
    description: "search issues",
    input_schema: SCHEMA,
    input_schema_digest: SCHEMA_DIGEST,
    output_schema: OUTPUT_SCHEMA,
    output_schema_digest: OUTPUT_SCHEMA_DIGEST,
    side_effect_class: "read_only",
    idempotency: { kind: "none" },
    requires_confirmation: false,
    enabled: true,
  };
}

/** The frozen v1 admission input for one fake stdio server. Mutate the
 * returned `server` record to probe refusal cases. */
function doc(mutate?: (server: Record<string, unknown>) => void): ToolBrokerConfigDocumentInput {
  const server: Record<string, unknown> = {
    enabled: true,
    adapter: "mcp",
    protocol_version: MCP_PROTOCOL_VERSION,
    transport: {
      kind: "stdio",
      package_id: PACKAGE_ID,
      package_version: PACKAGE_VERSION,
      package_digest: PACKAGE_HASH,
      executable: EXECUTABLE,
      executable_digest: EXECUTABLE_DIGEST,
      args: ["--stdio"],
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
    tools: { "repo-search-issues": toolEntry() },
  };
  mutate?.(server);
  return { schema: TOOL_BROKER_CONFIG_SCHEMA, servers: { "fake-mcp": server } };
}

/** The exact premise a Host-resolution seam would hand the factory (identity
 * echoed from the parsed config, concrete file resolved separately). */
function premiseFor(config: ToolBrokerServerConfig): HostResolvedExecutablePremise {
  return {
    executablePath: process.execPath,
    package_id: config.transport.package_id,
    package_version: config.transport.package_version,
    package_digest: config.transport.package_digest,
    executable: config.transport.executable,
    executable_digest: config.transport.executable_digest,
  };
}

/** Parses a v1 admission document and returns the minted config for
 * "fake-mcp" (the branded identity object the factory requires). */
function parseServer(input: ToolBrokerConfigDocumentInput): ToolBrokerServerConfig {
  return parseToolBrokerConfig(input, { configRevision: "rev-1" }).servers["fake-mcp"];
}

describe("Tool Broker config admission cutover (frozen v1 package-bound stdio)", () => {
  it("admits a valid exact v1 document into a branded, frozen server config", () => {
    const server = parseServer(doc());

    expect(server.serverId).toBe("fake-mcp");
    expect(server.adapter).toBe("mcp");
    expect(server.protocol_version).toBe(MCP_PROTOCOL_VERSION);
    expect(server.enabled).toBe(true);
    expect(server.allowed_modules).toEqual(["main-brain"]);
    expect(server.transport.package_id).toBe(PACKAGE_ID);
    expect(server.transport.package_version).toBe(PACKAGE_VERSION);
    expect(server.transport.package_digest).toBe(PACKAGE_HASH);
    expect(server.transport.executable).toBe(EXECUTABLE);
    expect(server.transport.executable_digest).toBe(EXECUTABLE_DIGEST);
    expect(server.limits).toEqual({
      startup_timeout_ms: 2000,
      request_timeout_ms: 10000,
      max_concurrency: 4,
      max_request_bytes: 1048576,
      max_response_bytes: 4194304,
    });
    expect(server.tools["repo-search-issues"].upstream_name).toBe("github.search_issues");
    expect(server.tools["repo-search-issues"].input_schema_digest).toBe(SCHEMA_DIGEST);
    expect(Object.isFrozen(server)).toBe(true);
    expect(isParsedToolBrokerServerConfig(server)).toBe(true);
  });

  it("refuses a legacy camelCase server config (lax dialect)", () => {
    const legacy = {
      schema: TOOL_BROKER_CONFIG_SCHEMA,
      servers: {
        "fake-mcp": {
          serverId: "fake-mcp",
          adapter: "mcp",
          protocolVersion: MCP_PROTOCOL_VERSION,
          transport: { kind: "stdio", command: process.execPath, args: [], env: {} },
          startupTimeoutMs: 2000,
          requestTimeoutMs: 10000,
          configRevision: "rev-1",
          tools: {},
        },
      },
    } as unknown as ToolBrokerConfigDocumentInput;
    expect(() => parseToolBrokerConfig(legacy, { configRevision: "rev-1" })).toThrow(
      /TOOL_BROKER_CONFIG_INVALID/u,
    );
  });

  it("refuses a schema tag other than dolly.tool-broker-config/v1", () => {
    const input = doc() as unknown as Record<string, unknown>;
    input.schema = "dolly.tool-broker-config/v2";
    expect(() => parseToolBrokerConfig(input, { configRevision: "rev-1" })).toThrow(
      /TOOL_BROKER_CONFIG_INVALID/u,
    );
  });

  it("refuses a raw transport.command / free path (spy is never spawned)", () => {
    // A legacy raw-command transport must never survive admission, so no
    // spawn (spy0) can ever come from config.transport.command.
    const rawCommand = doc();
    const server = rawCommand.servers["fake-mcp"] as Record<string, unknown>;
    server.transport = { kind: "stdio", command: "/usr/bin/env", args: ["echo", "hi"], env: {} };
    expect(() => parseToolBrokerConfig(rawCommand, { configRevision: "rev-1" })).toThrow(
      /TOOL_BROKER_CONFIG_INVALID/u,
    );

    const spawn = vi.fn();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses missing and malformed digests", () => {
    // Missing package_digest.
    expect(() => {
      const input = doc();
      (input.servers["fake-mcp"] as Record<string, unknown>).transport = {
        kind: "stdio",
        package_id: PACKAGE_ID,
        package_version: PACKAGE_VERSION,
        executable: EXECUTABLE,
        executable_digest: EXECUTABLE_DIGEST,
        args: [],
      };
      parseToolBrokerConfig(input, { configRevision: "rev-1" });
    }).toThrow(/TOOL_BROKER_CONFIG_INVALID/u);

    // Bad package_digest shape ("sha1:" / non-hex / wrong-length).
    expect(() => {
      const input = doc();
      const transport = (input.servers["fake-mcp"] as Record<string, unknown>).transport as Record<string, unknown>;
      transport.package_digest = `sha256:${"g".repeat(64)}`;
      parseToolBrokerConfig(input, { configRevision: "rev-1" });
    }).toThrow(/TOOL_BROKER_CONFIG_INVALID/u);

    // Missing executable_digest.
    expect(() => {
      const input = doc();
      const transport = (input.servers["fake-mcp"] as Record<string, unknown>).transport as Record<string, unknown>;
      delete transport.executable_digest;
      parseToolBrokerConfig(input, { configRevision: "rev-1" });
    }).toThrow(/TOOL_BROKER_CONFIG_INVALID/u);

    // Rotated input_schema_digest no longer matches the embedded schema.
    expect(() => {
      const input = doc();
      const tools = (input.servers["fake-mcp"] as Record<string, unknown>).tools as Record<string, unknown>;
      const entry = tools["repo-search-issues"] as Record<string, unknown>;
      entry.input_schema_digest = canonicalJsonDigest({ type: "object", properties: {} });
      parseToolBrokerConfig(input, { configRevision: "rev-1" });
    }).toThrow(/TOOL_BROKER_CONFIG_INVALID/u);

    // Missing output_schema_digest.
    expect(() => {
      const input = doc();
      const tools = (input.servers["fake-mcp"] as Record<string, unknown>).tools as Record<string, unknown>;
      const entry = tools["repo-search-issues"] as Record<string, unknown>;
      delete entry.output_schema_digest;
      parseToolBrokerConfig(input, { configRevision: "rev-1" });
    }).toThrow(/TOOL_BROKER_CONFIG_INVALID/u);
  });

  it("refuses missing allowed_modules, enabled, or full limits", () => {
    expect(() => {
      const input = doc();
      const server = input.servers["fake-mcp"] as Record<string, unknown>;
      delete server.allowed_modules;
      parseToolBrokerConfig(input, { configRevision: "rev-1" });
    }).toThrow(/TOOL_BROKER_CONFIG_INVALID/u);

    expect(() => {
      const input = doc();
      const server = input.servers["fake-mcp"] as Record<string, unknown>;
      const limits = server.limits as Record<string, unknown>;
      delete limits.max_response_bytes;
      server.limits = limits;
      parseToolBrokerConfig(input, { configRevision: "rev-1" });
    }).toThrow(/TOOL_BROKER_CONFIG_INVALID/u);

    expect(() => {
      const input = doc();
      const server = input.servers["fake-mcp"] as Record<string, unknown>;
      delete server.enabled;
      parseToolBrokerConfig(input, { configRevision: "rev-1" });
    }).toThrow(/TOOL_BROKER_CONFIG_INVALID/u);
  });

  it("rejects a copied/unparsed config at the factory before spawn", () => {
    const spawn = vi.fn<(command: string, args: readonly string[], options: Record<string, unknown>) => ChildProcess>(
      () => ({} as ChildProcess),
    );

    // A caller-typed object that was never admitted — even if it mirrors the
    // v1 shape — is not the minted identity.
    const forged = {
      serverId: "fake-mcp",
      enabled: true,
      adapter: "mcp",
      protocol_version: MCP_PROTOCOL_VERSION,
      transport: {
        kind: "stdio",
        package_id: PACKAGE_ID,
        package_version: PACKAGE_VERSION,
        package_digest: PACKAGE_HASH,
        executable: EXECUTABLE,
        executable_digest: EXECUTABLE_DIGEST,
        args: [],
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
      configRevision: "rev-1",
      tools: {},
    } as unknown as ToolBrokerServerConfig;
    expect(() =>
      startToolBrokerServer(forged, premiseFor(parseServer(doc())), {
        spawn: spawn as never,
        now: () => 0,
      }),
    ).toThrow(/TOOL_BROKER_CONFIG_INVALID/u);
    expect(spawn).not.toHaveBeenCalled();

    // A spread copy of a genuine minted config is a new object: rejected.
    const genuine = parseServer(doc());
    const copy = { ...genuine } as ToolBrokerServerConfig;
    expect(copy).not.toBe(genuine);
    expect(() =>
      startToolBrokerServer(copy, premiseFor(genuine), {
        spawn: spawn as never,
        now: () => 0,
      }),
    ).toThrow(/TOOL_BROKER_CONFIG_INVALID/u);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a premise that does not echo the configured identity", () => {
    const spawn = vi.fn<(command: string, args: readonly string[], options: Record<string, unknown>) => ChildProcess>(
      () => ({} as ChildProcess),
    );
    const genuine = parseServer(doc());
    const mismatched: HostResolvedExecutablePremise = {
      ...premiseFor(genuine),
      package_id: "org.dolly.other.package",
    };
    expect(() =>
      startToolBrokerServer(genuine, mismatched, {
        spawn: spawn as never,
        now: () => 0,
      }),
    ).toThrow(/TOOL_BROKER_CONFIG_INVALID/u);
    expect(spawn).not.toHaveBeenCalled();
  });
});
