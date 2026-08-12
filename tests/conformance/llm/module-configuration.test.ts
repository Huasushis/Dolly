import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cloneJson, type JsonValue } from "../../../src/core/canonical-json.js";
import { ModuleConfigurationStore } from "../../../src/core/module-configuration-store.js";
import {
  ModelDescriptorRegistry,
  type ChatDescriptorDocument,
  type ChatDescriptorSnapshot,
} from "../../../src/core/model-provider-descriptor.js";
import { validateDollyInstanceConfig } from "../../../src/core/runtime-config.js";
import {
  noRecordedObligations,
} from "../../../src/daemon/console/instance-obligations.js";
import {
  buildTopologyCandidate,
  computeTopologyPlan,
} from "../../../src/daemon/console/topology-revision.js";
import {
  LLM_MODULE_CONFIGURATION_SCHEMA,
  createDefaultLlmModuleConfiguration,
  resolveLlmModuleConfiguration,
  validateLlmModuleConfiguration,
} from "../../../src/extensions/llm/module-configuration.js";

const DIRECTORY = dirname(fileURLToPath(import.meta.url));
const TEMPORARY_ROOT = resolve(DIRECTORY, "../../../..", ".tmp");
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  mkdirSync(TEMPORARY_ROOT, { recursive: true, mode: 0o700 });
  const path = mkdtempSync(join(TEMPORARY_ROOT, "dolly-llm-config-"));
  temporaryDirectories.push(path);
  return path;
}

function descriptorDocument(
  modelId: string,
  contextWindowTokens: number,
  maximumOutputTokens: number,
): ChatDescriptorDocument {
  return {
    schemaVersion: "dolly.model-descriptor/4",
    descriptorVersion: `${modelId}-fixture-v1`,
    endpointId: "fixture.aether",
    operation: "chat-completion",
    modelId,
    adapter: {
      id: "openai.chat",
      version: "fixture-v1",
      requestStrategyId: "openai.chat.request.text-parts.v1",
      responseStrategyId: "openai.chat.response.v1",
      streamStrategyId: "openai.chat.stream.sse.v1",
    },
    limits: {
      maxRequestBytes: 1024 * 1024,
      maxResponseBytes: 1024 * 1024,
      maxInputItems: 128,
      maxInputBytes: 512 * 1024,
      maxOutputBytes: 256 * 1024,
      maxConcurrentRequests: 1,
      maxProviderTimeoutMs: 60_000,
      streaming: {
        state: "supported",
        value: { maxEvents: 20_000, maxBufferedBytes: 256 * 1024 },
      },
    },
    input: {
      modalities: ["text"],
      text: { state: "supported", value: { maxBytesPerItem: 32 * 1024, empty: "forbidden" } },
      media: [],
    },
    retry: {
      maxProviderAttempts: 1,
      safeConditions: ["before-dispatch"],
      providerIdempotency: { state: "unsupported" },
    },
    features: {
      roles: ["system", "user", "assistant", "tool"],
      messageOrderStrategyId: "openai.chat.messages.v1",
      maxMessages: 128,
      maxPartsPerMessage: 16,
      contextWindowTokens: { state: "supported", value: { maximum: contextWindowTokens } },
      maxOutputTokens: { state: "supported", value: { maximum: maximumOutputTokens } },
      mediaRequirementIds: [],
      tools: { state: "unsupported" },
      structuredOutput: { state: "unsupported" },
      jsonObjectOutput: { state: "supported", value: { strategyId: "openai.response-format.json-object.v1" } },
      reasoning: {
        support: "request-controlled",
        requestControl: { kind: "enum-strategy", strategyId: "thinking-object.enabled-disabled.v1" },
        observation: {
          state: "supported",
          value: {
            nonStreamStrategyId: "openai.reasoning-content.nonstream.v1",
            streamStrategyId: "openai.reasoning-content.stream.v1",
            empty: "not-observed",
          },
        },
        replay: { requirement: "forbidden" },
      },
      finishReasons: ["stop", "length", "tool_calls"],
    },
  };
}

function snapshot(modelId: string, context: number, output: number): ChatDescriptorSnapshot {
  const registry = new ModelDescriptorRegistry({
    schemaDigest: `sha256:${"f".repeat(64)}`,
    allowedStrategyIds: new Set([
      "openai.chat.request.text-parts.v1",
      "openai.chat.response.v1",
      "openai.chat.stream.sse.v1",
      "openai.chat.messages.v1",
      "thinking-object.enabled-disabled.v1",
      "openai.reasoning-content.nonstream.v1",
      "openai.reasoning-content.stream.v1",
      "openai.response-format.json-object.v1",
    ]),
  });
  const ref = registry.register(descriptorDocument(modelId, context, output));
  registry.setStatus(ref, "active");
  return registry.snapshot(ref);
}

function moduleEntry(revision: string): JsonValue {
  return {
    moduleId: "agent",
    extensionId: "dolly.llm",
    packageVersion: "1.0.0",
    moduleKind: "conversation",
    isolation: "process",
    configurationReference: { configId: "agent-config", revision, configVersion: 1 },
    permissionPolicyIds: [],
    inputPageIds: ["inbox"],
    outputPageIds: ["outbox"],
    subscriptionStart: "from-now",
    activation: { kind: "reactive" },
    limits: {
      claim: { maxCount: 8, maxBytes: 65_536 },
      maxInputBytes: 1_048_576,
      maxResultBytes: 1_048_576,
      maxFrameBytes: 2_097_152,
      maxRunsPerGeneration: 100,
      maxGenerations: 10,
    },
    timeouts: {
      initializationTimeoutMs: 30_000,
      executionTimeoutMs: 600_000,
      cancellationGraceMs: 5_000,
      terminationTimeoutMs: 5_000,
    },
  };
}

describe("LLM Module configuration", () => {
  it("materializes a closed, immutable, descriptor-bound streaming default", () => {
    const selected = snapshot("qwen3.6-27b", 8192, 2048);
    const configuration = createDefaultLlmModuleConfiguration(selected);

    expect(configuration.schemaVersion).toBe("dolly.llm.module-configuration/1");
    expect(configuration.model.descriptor).toEqual(selected.ref);
    expect(configuration.model.streamingPolicy).toBe("required");
    expect(configuration.tools.policyIds).toEqual([]);
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(() => {
      (configuration.model as { streamingPolicy: string }).streamingPolicy = "forbidden";
    }).toThrow();
    expect(JSON.stringify(configuration)).not.toMatch(/api[_-]?key|base[_-]?url|credential|https?:\/\//iu);
  });

  it("rejects provider fields, malformed tool budgets, and an impossible smaller context", () => {
    const selected = snapshot("deepseek-v4-flash", 1024, 512);
    const valid = createDefaultLlmModuleConfiguration(selected);

    const copy = (value: unknown): Record<string, JsonValue> =>
      cloneJson(value as JsonValue) as Record<string, JsonValue>;
    expect(() => validateLlmModuleConfiguration({
      ...copy(valid),
      apiKey: "must-not-enter-configuration",
    } as JsonValue)).toThrowError(expect.objectContaining({ code: "LLM_CONFIGURATION_INVALID" }));

    expect(() => validateLlmModuleConfiguration({
      ...copy(valid),
      tools: {
        policyIds: ["read-only"],
        limits: { maxRounds: 0, maxCalls: 0, maxCallsPerRound: 0, maxApprovals: 0, maxCallBytes: 0 },
      },
    } as JsonValue)).toThrowError(expect.objectContaining({ code: "LLM_CONFIGURATION_INVALID" }));

    const impossible = validateLlmModuleConfiguration({
      ...copy(valid),
      context: {
        ...copy(valid.context),
        tokenBudget: { estimatorId: "utf8-byte-upper-bound.v1", maxInputTokens: 800 },
      },
      turn: { ...copy(valid.turn), maxOutputTokens: 300 },
    } as JsonValue);
    expect(() => resolveLlmModuleConfiguration(impossible, selected)).toThrowError(
      expect.objectContaining({ code: "LLM_CONTEXT_BUDGET_EXCEEDED" }),
    );
  });

  it("stores model changes as immutable revisions and classifies their reference change as a generation restart", () => {
    const directory = temporaryDirectory();
    const store = new ModuleConfigurationStore({ directory });
    const source = createDefaultLlmModuleConfiguration(snapshot("qwen3.6-27b", 8192, 2048));
    const target = createDefaultLlmModuleConfiguration(snapshot("deepseek-v4-flash", 4096, 1024));
    const first = store.create({
      configId: "agent-config",
      extensionId: "dolly.llm",
      moduleKind: "conversation",
      configVersion: 1,
      schema: LLM_MODULE_CONFIGURATION_SCHEMA,
      configuration: source as unknown as JsonValue,
    });
    const second = store.create({
      configId: "agent-config",
      extensionId: "dolly.llm",
      moduleKind: "conversation",
      configVersion: 1,
      schema: LLM_MODULE_CONFIGURATION_SCHEMA,
      configuration: target as unknown as JsonValue,
    });
    expect(second.revision).not.toBe(first.revision);
    expect(store.resolve({
      configId: second.configId,
      revision: second.revision,
      extensionId: second.extensionId,
      moduleKind: second.moduleKind,
      configVersion: second.configVersion,
      schema: LLM_MODULE_CONFIGURATION_SCHEMA,
    }).configuration).toEqual(target);

    const current = validateDollyInstanceConfig({
      schemaVersion: "dolly.instance/9",
      instanceId: INSTANCE_ID,
      displayName: "Agent",
      stateDirectory: null,
      core: {
        limits: {
          maxFailedAttempts: 3,
          maxStateBytes: 64 * 1024 * 1024,
          maxModuleResultCommitJournalBytes: 16 * 1024 * 1024,
        },
        media: { enabled: false },
        scheduler: { pollIntervalMs: 100, retryBaseMs: 250, retryMaxMs: 30_000 },
      },
      pages: [{ pageId: "inbox" }, { pageId: "outbox" }],
      modules: [moduleEntry(first.revision)],
      logging: { level: "info" },
    });
    const stopped = noRecordedObligations({
      moduleExecutionEnabled: true,
      modules: [{
        moduleId: "agent",
        consumerId: "agent",
        activeClaimTokens: [],
        unknownOutcomeClaimTokens: [],
        claimedPageIds: [],
        generationTerminationProven: true,
      }],
    });
    const candidate = buildTopologyCandidate(current, {
      proposal: {
        pages: current.pages as unknown as readonly JsonValue[],
        modules: [moduleEntry(second.revision)],
      },
    }, stopped);
    const plan = computeTopologyPlan({
      current,
      candidate,
      obligations: stopped,
      expectedRevision: "sha256:" + "a".repeat(64),
      dispositions: [],
      modulePrivateStorage: [],
    });
    expect(plan.entries).toContainEqual(expect.objectContaining({
      element: "module:agent",
      operation: "module.change",
      classification: "generation-restart",
    }));
    expect(plan.entries.find((entry) => entry.operation === "module.change")?.detail)
      .toContain("configurationReference");

    const guarded = computeTopologyPlan({
      current,
      candidate,
      obligations: noRecordedObligations({ moduleExecutionEnabled: false }),
      expectedRevision: "sha256:" + "a".repeat(64),
      dispositions: [],
      modulePrivateStorage: [],
    });
    expect(guarded.entries).toContainEqual(expect.objectContaining({
      operation: "module.change",
      classification: "rejected",
      errorCode: "TOPOLOGY_CAPABILITY_DISABLED",
    }));
  });
});
