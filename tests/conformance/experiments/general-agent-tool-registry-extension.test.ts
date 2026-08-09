import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { isJsonObject, type JsonValue } from "../../../src/core/canonical-json.js";
import {
  ExtensionIsolationPolicy,
  ExtensionProcessHost,
} from "../../../src/core/extension-process-host.js";
import type { ExtensionPackageManifest } from "../../../src/core/extension-installation-registry.js";
import { createToolInvocationCapabilityV2 } from "../../../src/core/provider-capabilities/index.js";
import {
  InMemoryToolJournalRepository,
  ToolPolicySession,
  ToolRegistry,
  type ToolDescriptor,
  type ToolExecutionOutcome,
  type ToolExecutionRequest,
  type ToolTurnBudget,
} from "../../../src/core/tool-policy.js";

const EXTENSION = fileURLToPath(
  new URL(
    "../../../scripts/experiments/probes/general-agent-live-v0/extension.mjs",
    import.meta.url,
  ),
);
const MANIFEST: ExtensionPackageManifest = {
  schemaVersion: "dolly.extension-package/1",
  extensionId: "org.dolly.general-agent-registry-fixture",
  packageVersion: "1.0.0",
  displayName: "General Agent registry fixture",
  description: "Exercises registry-derived JSON actions in a real child process.",
  supportedProtocolVersions: ["3.0"],
  entrypoint: "extension.mjs",
  modules: [{
    moduleKind: "general-agent",
    activation: "reactive",
    configVersion: 1,
    configurationSchema: { type: "object" },
  }],
  requestedCapabilities: [],
};
const BUDGET: ToolTurnBudget = {
  maxRounds: 2,
  maxCalls: 2,
  maxCallsPerRound: 1,
  maxApprovals: 0,
  maxCallBytes: 2_048,
};

function descriptor(options: {
  toolId: string;
  wireName: string;
  description: string;
  argumentSchema: ToolDescriptor["argumentSchema"];
  resultSchema: ToolDescriptor["resultSchema"];
}): ToolDescriptor {
  return {
    ...options,
    effectClass: "read",
    resourceScope: "synthetic-memory",
    approval: "never",
    idempotency: "effect-key",
    outcomeQuery: "supported",
    parallel: "safe",
    deadlineMs: 1_000,
    maxArgumentBytes: 1_024,
    maxResultBytes: 4_096,
  };
}

describe("general Agent tool-registry Extension", () => {
  it("uses Host-selected tool names and limits instead of storage-name constants", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-agent-tool-registry-extension-"));
    let identifier = 0;
    let handle = 0;
    const host = new ExtensionProcessHost({
      isolation: "process",
      trust: "trusted",
      isolationPolicy: new ExtensionIsolationPolicy(),
      manifest: MANIFEST,
      command: process.execPath,
      args: [EXTENSION],
      workingDirectory: scratch,
      instanceId: "instance-a",
      moduleId: "module-a",
      moduleGenerationId: "module-generation-a",
      moduleKind: "general-agent",
      config: {},
      maxFrameBytes: 1024 * 1024,
      maxConcurrentCapabilityRequests: 1,
      initializationTimeoutMs: 5_000,
      shutdownRequestTimeoutMs: 1_000,
      forceKillDelayMs: 500,
      terminationTimeoutMs: 2_000,
      nextIdentifier: (purpose) => `${purpose}-${++identifier}`,
      nextCapabilityHandle: () => Buffer.alloc(32, ++handle).toString("base64url"),
    });
    const tools = [
      descriptor({
        toolId: "synthetic.discover",
        wireName: "alpha_discover",
        description: "Discover synthetic memory keys before reading one item.",
        argumentSchema: {
          type: "object",
          properties: {
            prefix: { type: "string", maxBytes: 16 },
            limit: { type: "integer", minimum: 1, maximum: 3 },
          },
          required: ["prefix", "limit"],
          additionalProperties: false,
          maxProperties: 2,
        },
        resultSchema: {
          type: "object",
          properties: {
            keys: { type: "array", items: { type: "string", maxBytes: 32 }, maxItems: 3 },
          },
          required: ["keys"],
          additionalProperties: false,
          maxProperties: 1,
        },
      }),
      descriptor({
        toolId: "synthetic.read",
        wireName: "beta_read",
        description: "Read one synthetic memory item by a discovered key.",
        argumentSchema: {
          type: "object",
          properties: { key: { type: "string", maxBytes: 32 } },
          required: ["key"],
          additionalProperties: false,
          maxProperties: 1,
        },
        resultSchema: {
          type: "object",
          properties: {
            status: { type: "string", maxBytes: 16 },
            codename: { type: "string", maxBytes: 32 },
          },
          required: ["status", "codename"],
          additionalProperties: false,
          maxProperties: 2,
        },
      }),
    ] as const;
    const registry = new ToolRegistry(tools, tools.map((tool) => tool.toolId));
    const execute = vi.fn(
      async (request: ToolExecutionRequest): Promise<ToolExecutionOutcome> => {
        if (request.toolId === "synthetic.discover") {
          return { status: "succeeded", content: { keys: ["deployment-note"] } };
        }
        return {
          status: "succeeded",
          content: { status: "active", codename: "EMBER-7421" },
        };
      },
    );
    const toolCapability = createToolInvocationCapabilityV2({
      executionScope: "active-run",
      expiresAt: "2099-01-01T00:00:00.000Z",
      limits: { maxInvocations: 3, maxInvocationsPerRun: 3, maxCallsPerRound: 1 },
      resolveRun: ({ moduleJobId }) => ({
        registry,
        budget: BUDGET,
        policy: new ToolPolicySession({
          moduleJobId,
          registry,
          repository: new InMemoryToolJournalRepository(),
          approval: { decide: vi.fn() },
          executor: { execute },
          budget: BUDGET,
          approvalPolicyRevision: "policy-1",
        }),
      }),
    });
    host.grantCapability(toolCapability.grant, toolCapability.handler);

    let modelRound = 0;
    const prompts: string[] = [];
    host.grantCapability(
      {
        capabilityType: "model-operation",
        capabilityVersion: "v1",
        operations: ["chat"],
        resourceScope: { executionScope: "active-run", model: "fake" },
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxInvocations: 3,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 128 * 1024,
        maxResultBytes: 128 * 1024,
        requireIdempotencyKey: true,
      },
      async (argumentsValue) => {
        if (!isJsonObject(argumentsValue)) throw new Error("model arguments are not an object");
        const messages = argumentsValue.messages;
        if (!Array.isArray(messages) || !isJsonObject(messages[0])) {
          throw new Error("model messages are absent");
        }
        const parts = messages[0].parts;
        if (!Array.isArray(parts) || !isJsonObject(parts[0])) {
          throw new Error("model message parts are absent");
        }
        const prompt = parts[0].text;
        if (typeof prompt !== "string") throw new Error("model prompt is absent");
        prompts.push(prompt);
        modelRound += 1;
        const finalContent =
          modelRound === 1
            ? JSON.stringify({ action: "alpha_discover", arguments: { prefix: "", limit: 3 } })
            : modelRound === 2
              ? JSON.stringify({ action: "beta_read", arguments: { key: "deployment-note" } })
              : JSON.stringify({
                  action: "answer",
                  answer: "The active deployment codename is EMBER-7421.",
                  grounded: true,
                  evidenceKeys: ["deployment-note"],
                });
        const reasoning: JsonValue =
          modelRound === 1
            ? { state: "observed", parts: ["Inspect the registry before acting."] }
            : { state: "not-observed" };
        return {
          schemaVersion: "dolly.model-operation-result/1",
          operation: "chat",
          status: "succeeded",
          output: {
            finalContent,
            finishReason: "stop",
            reasoning,
          },
        };
      },
    );

    try {
      await host.start();
      const result = await host.execute({
        moduleJobId: "module-job-a",
        runId: "run-a",
        attempt: 1,
        deadline: new Date(Date.now() + 5_000).toISOString(),
        responseTimeoutMs: 10_000,
        hasMore: false,
        input: {
          blockGroups: [{
            block: {
              payload: {
                schema: "dolly.content/1",
                value: {
                  items: [{
                    type: "text",
                    text: "Find the active deployment codename in private memory.",
                    format: "plain",
                  }],
                },
              },
            },
          }],
        },
      });
      const text = (result as {
        blockProposal?: { payload?: { value?: { items?: { text?: string }[] } } };
      }).blockProposal?.payload?.value?.items?.[0]?.text;
      if (typeof text !== "string") throw new Error("Agent result text is absent");
      const agentResult = JSON.parse(text);
      expect(agentResult).toMatchObject({
        conditionId: "tool-registry-storage",
        actions: ["alpha_discover", "beta_read", "answer"],
        capabilityTypes: ["model-operation", "tool-invocation"],
        answer: { grounded: true, evidenceKeys: ["deployment-note"] },
      });
      expect(agentResult.answer.answer).toContain("EMBER-7421");
      expect(agentResult.toolRegistry.tools.map((tool: { name: string }) => tool.name)).toEqual([
        "alpha_discover",
        "beta_read",
      ]);
      expect(prompts).toHaveLength(3);
      expect(prompts[0]).toContain('"maximum":3');
      expect(prompts[0]).toContain("alpha_discover");
      expect(prompts[0]).toContain("successResultSchema");
      expect(execute).toHaveBeenCalledTimes(2);
      expect(readFileSync(EXTENSION, "utf8")).not.toMatch(/storage_(?:list|get)/u);
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
