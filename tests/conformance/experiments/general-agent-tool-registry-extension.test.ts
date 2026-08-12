import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { InstalledModulePermissionPolicyRegistry } from "../../../src/adapters/installed-module-permission-policy.js";
import { isJsonObject, type JsonValue } from "../../../src/core/canonical-json.js";
import {
  ExtensionIsolationPolicy,
  ExtensionProcessHost,
} from "../../../src/core/extension-process-host.js";
import type { ExtensionPackageManifest } from "../../../src/core/extension-installation-registry.js";
import { FileToolJournalRepository } from "../../../src/core/file-tool-journal-repository.js";
import type { InstalledExtensionModule } from "../../../src/core/installed-extension-module.js";
import type { ChatBrokerInvocation } from "../../../src/core/model-provider-broker.js";
import { ModelDescriptorRegistry } from "../../../src/core/model-provider-descriptor.js";
import {
  ToolRegistry,
  type ToolDescriptor,
  type ToolExecutionOutcome,
  type ToolExecutionRequest,
  type ToolTurnBudget,
} from "../../../src/core/tool-policy.js";
import {
  CHAT_STRATEGIES,
  chatDescriptor,
  objectFormReasoning,
} from "../model-provider/fixtures.js";

const EXTENSION = fileURLToPath(
  new URL(
    "../../../scripts/experiments/probes/general-agent-live-v0/extension.mjs",
    import.meta.url,
  ),
);
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const WORKSPACE_TMP = resolve(REPOSITORY_ROOT, "..", ".tmp");
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
  it.each([
    [
      "a Markdown-fenced object",
      '```json\n{"answer":"unknown","grounded":false,"evidenceKeys":[]}\n```',
    ],
    [
      "an object-valued answer",
      '{"answer":{"value":"unknown"},"grounded":false,"evidenceKeys":[]}',
    ],
  ])("rejects %s from a v2 model capability", async (_label, invalidContent) => {
    mkdirSync(WORKSPACE_TMP, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(WORKSPACE_TMP, "dolly-agent-json-fence-"));
    let identifier = 0;
    const host = new ExtensionProcessHost({
      isolation: "process",
      trust: "trusted",
      isolationPolicy: new ExtensionIsolationPolicy(),
      manifest: MANIFEST,
      command: process.execPath,
      args: [EXTENSION],
      workingDirectory: scratch,
      instanceId: "instance-fence",
      moduleId: "module-fence",
      moduleGenerationId: "module-generation-fence",
      moduleKind: "general-agent",
      config: {},
      maxFrameBytes: 1024 * 1024,
      maxConcurrentCapabilityRequests: 1,
      initializationTimeoutMs: 5_000,
      shutdownRequestTimeoutMs: 1_000,
      forceKillDelayMs: 500,
      terminationTimeoutMs: 2_000,
      nextIdentifier: (purpose) => `${purpose}-${++identifier}`,
    });
    host.grantCapability(
      {
        capabilityType: "model-operation",
        capabilityVersion: "v2",
        operations: ["chat", "describe"],
        resourceScope: {
          executionScope: "active-run",
          model: "fake",
          outputContracts: ["text", "json-object"],
        },
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxInvocations: 2,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 128 * 1024,
        maxResultBytes: 128 * 1024,
        requireIdempotencyKey: true,
      },
      async (_argumentsValue, context): Promise<JsonValue> =>
        context.operation === "describe"
          ? {
              schemaVersion: "dolly.model-operation-description/2",
              modality: "chat",
              outputContracts: ["json-object", "text"],
            }
          : {
              schemaVersion: "dolly.model-operation-result/1",
              operation: "chat",
              status: "succeeded",
              output: {
                finalContent: invalidContent,
                finishReason: "stop",
                reasoning: { state: "not-observed" },
              },
            },
    );
    try {
      await host.start();
      await expect(host.execute({
        moduleJobId: "module-job-fence",
        runId: "run-fence",
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
                  items: [{ type: "text", text: "Answer without guessing.", format: "plain" }],
                },
              },
            },
          }],
        },
      })).rejects.toThrow();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("uses Host-selected tool names and limits instead of storage-name constants", async () => {
    mkdirSync(WORKSPACE_TMP, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(WORKSPACE_TMP, "dolly-agent-tool-registry-extension-"));
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
    const toolJournalPath = join(scratch, "tool-rounds.json");
    const toolJournalRepository = new FileToolJournalRepository({ path: toolJournalPath });
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
    const modelRounds = new Map<string, number>();
    const prompts: string[] = [];
    const outputContracts: unknown[] = [];
    const streams: boolean[] = [];
    const descriptors = new ModelDescriptorRegistry({
      schemaDigest: `sha256:${"7".repeat(64)}`,
      allowedStrategyIds: CHAT_STRATEGIES,
    });
    const baseDescriptor = chatDescriptor({
      jsonObjectOutput: "supported",
      reasoning: objectFormReasoning(),
    });
    const modelDescriptor = descriptors.register({
      ...baseDescriptor,
      features: {
        ...baseDescriptor.features,
        maxOutputTokens: { state: "supported", value: { maximum: 8_192 } },
      },
    });
    descriptors.setStatus(modelDescriptor, "active");
    let modelRequest = 0;
    const invokeModel = vi.fn(async (invocation: ChatBrokerInvocation) => {
      outputContracts.push(invocation.input.outputContract);
      streams.push(invocation.input.stream);
      const firstPart = invocation.input.messages[0]?.parts[0];
      if (firstPart?.kind !== "text") throw new Error("model prompt is absent");
      prompts.push(firstPart.text);
      const moduleJobId = invocation.context.moduleJobId;
      if (moduleJobId === undefined) throw new Error("active Module job is absent");
      const modelRound = (modelRounds.get(moduleJobId) ?? 0) + 1;
      modelRounds.set(moduleJobId, modelRound);
      const duplicateRead = moduleJobId === "module-job-duplicate";
      const stuckRead = moduleJobId === "module-job-stuck";
      const finalContent =
        modelRound === 1
          ? "Discover the available keys, read the active note, then answer with its source."
          : modelRound === 2
            ? JSON.stringify({ action: "alpha_discover", arguments: { prefix: "", limit: 3 } })
            : modelRound === 3
              ? JSON.stringify(duplicateRead || stuckRead
                ? { action: "alpha_discover", arguments: { limit: 3, prefix: "" } }
                : { action: "beta_read", arguments: { key: "deployment-note" } })
              : modelRound === 4 && stuckRead
                ? JSON.stringify({ action: "alpha_discover", arguments: { prefix: "", limit: 3 } })
                : modelRound === 4 && duplicateRead
                ? JSON.stringify({ action: "beta_read", arguments: { key: "deployment-note" } })
                : JSON.stringify({
                  action: "answer",
                  answer: "The active deployment codename is EMBER-7421.",
                  grounded: true,
                  evidenceKeys: moduleJobId === "module-job-ungrounded"
                    ? ["alpha_discover", "beta_read"]
                    : ["deployment-note"],
              });
      const reasoning =
        modelRound === 1
          ? { state: "observed" as const, parts: ["Inspect the registry before acting."] }
          : { state: "not-observed" as const };
      return {
        schemaVersion: "dolly.model-result/2" as const,
        requestId: invocation.requestId,
        operationId: invocation.context.operationId,
        descriptor: invocation.descriptor,
        status: "succeeded" as const,
        output: {
          schemaVersion: "dolly.model.chat-output/1" as const,
          finalContent,
          reasoning,
          toolCalls: [],
          finishReason: "stop",
        },
        usage: { providerAttempts: 1, observations: [] },
      };
    });
    const policies = new InstalledModulePermissionPolicyRegistry({
      nextRequestId: () => `installed-agent-model-request-${++modelRequest}`,
      policies: [{
        kind: "strict-streaming-chat",
        policyId: "model.owner-primary",
        descriptor: modelDescriptor,
        ownerScope: "owner-1",
        budgets: {
          maxProviderAttempts: 1,
          maxWallTimeMs: 30_000,
          maxRequestBytes: 128 * 1024,
          maxResponseBytes: 128 * 1024,
          maxInputItems: 64,
          maxInputBytes: 64 * 1024,
          maxOutputBytes: 64 * 1024,
          maxOutputTokens: 5_200,
        },
        chat: { invoke: invokeModel },
        outputContracts: ["text", "json-object"],
        reasoningPolicies: ["require", "disable"],
        roles: ["system", "user"],
        limits: {
          maxInvocations: 32,
          maxInvocationsPerRun: 8,
          maxInvocationsPerWindow: 32,
          rateWindowMs: 60_000,
        },
        capabilityLifetimeMs: 60_000,
      }, {
        kind: "registered-tools",
        policyId: "tools.owner-memory",
        registry,
        repository: toolJournalRepository,
        executor: { execute },
        budget: BUDGET,
        approvalPolicyRevision: "policy-1",
        limits: {
          maxInvocations: 16,
          maxInvocationsPerRun: 4,
          maxCallsPerRound: 1,
          maxArgumentBytes: 8 * 1024,
          maxResultBytes: 16 * 1024,
        },
        capabilityLifetimeMs: 60_000,
      }],
    });
    policies.setupFor({
      instanceId: "instance-a",
      installation: {
        manifest: MANIFEST,
        packageDigest: `sha256:${"a".repeat(64)}`,
      },
      module: {
        moduleId: "module-a",
        extensionId: MANIFEST.extensionId,
        moduleKind: "general-agent",
        permissionPolicyIds: ["model.owner-primary", "tools.owner-memory"],
        configurationReference: {
          configId: "agent-config",
          revision: `sha256:${"b".repeat(64)}`,
          configVersion: 1,
        },
      },
      packageModule: MANIFEST.modules[0],
      configuration: {
        schemaVersion: "dolly.module-configuration/1",
        configId: "agent-config",
        revision: `sha256:${"b".repeat(64)}`,
        extensionId: MANIFEST.extensionId,
        moduleKind: "general-agent",
        configVersion: 1,
        configuration: {},
      },
    } as unknown as InstalledExtensionModule).configureHost(host);

    const execution = (
      moduleJobId: string,
      runId: string,
    ): Parameters<ExtensionProcessHost["execute"]>[0] => ({
      moduleJobId,
      runId,
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

    try {
      await host.start();
      await expect(
        host.execute(execution("module-job-ungrounded", "run-ungrounded")),
      ).rejects.toThrow();
      const result = await host.execute(execution("module-job-a", "run-a"));
      const text = (result as {
        blockProposal?: { payload?: { value?: { items?: { text?: string }[] } } };
      }).blockProposal?.payload?.value?.items?.[0]?.text;
      if (typeof text !== "string") throw new Error("Agent result text is absent");
      const agentResult = JSON.parse(text);
      expect(agentResult).toMatchObject({
        conditionId: "tool-registry-storage",
        actions: ["alpha_discover", "beta_read", "answer"],
        capabilityTypes: ["model-operation", "tool-invocation"],
        capabilityContracts: [
          { capabilityType: "model-operation", capabilityVersion: "v2" },
          { capabilityType: "tool-invocation", capabilityVersion: "v2" },
        ],
        modelOutputContracts: ["json-object", "text"],
        answer: { grounded: true, evidenceKeys: ["deployment-note"] },
      });
      expect(agentResult.answer.answer).toContain("EMBER-7421");
      const duplicateResult = await host.execute(
        execution("module-job-duplicate", "run-duplicate"),
      );
      const duplicateText = (duplicateResult as {
        blockProposal?: { payload?: { value?: { items?: { text?: string }[] } } };
      }).blockProposal?.payload?.value?.items?.[0]?.text;
      if (typeof duplicateText !== "string") {
        throw new Error("Duplicate-action Agent result text is absent");
      }
      const duplicateAgentResult = JSON.parse(duplicateText);
      expect(duplicateAgentResult).toMatchObject({
        conditionId: "tool-registry-storage",
        actions: ["alpha_discover", "beta_read", "answer"],
        modelActions: ["alpha_discover", "alpha_discover", "beta_read", "answer"],
        noProgressEvents: [{
          kind: "duplicate-read-reused",
          name: "alpha_discover",
          priorObservationIndex: 0,
        }],
        answer: { grounded: true, evidenceKeys: ["deployment-note"] },
      });
      expect(duplicateAgentResult.answer.answer).toContain("EMBER-7421");
      await expect(
        host.execute(execution("module-job-stuck", "run-stuck")),
      ).rejects.toThrow();
      expect(agentResult.planningNoteChars).toBeGreaterThan(0);
      expect(agentResult.toolRegistry.tools.map((tool: { name: string }) => tool.name)).toEqual([
        "alpha_discover",
        "beta_read",
      ]);
      expect(prompts).toHaveLength(17);
      expect(prompts[0]).toContain('"maximum":3');
      expect(prompts[0]).toContain("alpha_discover");
      expect(prompts[0]).toContain("successResultSchema");
      expect(invokeModel).toHaveBeenCalledTimes(17);
      expect(streams).toEqual(Array.from({ length: 17 }, () => true));
      expect(outputContracts).toEqual([
        { kind: "text" },
        { kind: "json-object" },
        { kind: "json-object" },
        { kind: "json-object" },
        { kind: "text" },
        { kind: "json-object" },
        { kind: "json-object" },
        { kind: "json-object" },
        { kind: "text" },
        { kind: "json-object" },
        { kind: "json-object" },
        { kind: "json-object" },
        { kind: "json-object" },
        { kind: "text" },
        { kind: "json-object" },
        { kind: "json-object" },
        { kind: "json-object" },
      ]);
      expect(execute).toHaveBeenCalledTimes(7);
      expect(
        new FileToolJournalRepository({ path: toolJournalPath })
          .listRounds("module-job-a"),
      ).toEqual([
        expect.objectContaining({ roundIndex: 1, state: "complete" }),
        expect.objectContaining({ roundIndex: 2, state: "complete" }),
      ]);
      expect(
        new FileToolJournalRepository({ path: toolJournalPath })
          .listRounds("module-job-stuck"),
      ).toEqual([
        expect.objectContaining({ roundIndex: 1, state: "complete" }),
      ]);
      expect(
        new FileToolJournalRepository({ path: toolJournalPath })
          .listRounds("module-job-duplicate"),
      ).toEqual([
        expect.objectContaining({ roundIndex: 1, state: "complete" }),
        expect.objectContaining({ roundIndex: 2, state: "complete" }),
      ]);
      expect(readFileSync(EXTENSION, "utf8")).not.toMatch(/storage_(?:list|get)/u);
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
