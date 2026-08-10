#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createExtensionEffectJournalLifecycle } from "../../../../src/adapters/extension-effect-run-lifecycle.js";
import { createExtensionProcessModuleExecutor } from "../../../../src/adapters/extension-process-module-executor.js";
import {
  EffectIntentJournal,
  effectIntentEvidenceSource,
} from "../../../../src/core/capabilities/effect-intent-journal.js";
import { FileEffectIntentStore } from "../../../../src/core/capabilities/file-effect-intent-store.js";
import { ModulePrivateStorageBackend } from "../../../../src/core/capabilities/module-private-storage-capability.js";
import type { JsonValue } from "../../../../src/core/canonical-json.js";
import {
  ExtensionIsolationPolicy,
  ExtensionProcessHost,
} from "../../../../src/core/extension-process-host.js";
import { FileCoreStateStore } from "../../../../src/core/file-core-state-store.js";
import { FileModuleResultCommitRepository } from "../../../../src/core/file-module-result-commit-repository.js";
import { FileToolJournalRepository } from "../../../../src/core/file-tool-journal-repository.js";
import { deriveModuleCgroupPath } from "../../../../src/core/linux-module-cgroup.js";
import { EndpointBindingRegistry } from "../../../../src/core/model-provider-binding.js";
import {
  ChatModelBroker,
  type ChatBrokerInvocation,
  type ChatBrokerResult,
  type ModelSecretResolver,
} from "../../../../src/core/model-provider-broker.js";
import { ModelDescriptorRegistry } from "../../../../src/core/model-provider-descriptor.js";
import {
  ModuleScheduler,
  systemSchedulerClock,
} from "../../../../src/core/module-scheduler.js";
import { createModuleResultCommitCoordinator } from "../../../../src/core/module-result-commit-factory.js";
import {
  createModelOperationCapabilityV2,
  type ChatModelBrokerPort,
} from "../../../../src/core/provider-capabilities/model-operation-capability.js";
import { createToolInvocationCapabilityV2 } from "../../../../src/core/provider-capabilities/tool-invocation-capability.js";
import {
  ReactiveModuleHost,
  type ManagedReactiveModuleRuntime,
} from "../../../../src/core/reactive-module-host.js";
import {
  ReactiveModuleRuntime,
  type ReactiveModuleFailure,
  type ReactiveModuleRuntimeOptions,
} from "../../../../src/core/reactive-module-runtime.js";
import {
  ToolPolicySession,
  ToolRegistry,
  type ToolDescriptor,
  type ToolExecutor,
  type ToolExecutionOutcome,
  type ToolTurnBudget,
} from "../../../../src/core/tool-policy.js";
import { ExperimentFetchTransport } from "../general-agent-live-v0/run.mjs";
import { waitForAgentCase } from "../general-agent-live-v0/wait-for-case.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../../..");
const workspaceRoot = resolve(repositoryRoot, "..");
const extensionPath = join(scriptDirectory, "extension.mjs");
const preregistrationPath = join(
  repositoryRoot,
  "docs/experiments/preregistrations/scheduler-agent-task-switch-v0.json",
);
const protocolPath = join(repositoryRoot, "docs/experiments/protocol.md");
const NOW = "2026-08-10T00:00:00.000Z";
const SCHEMA_DIGEST = `sha256:${"f".repeat(64)}`;
const TASK_ID = "release-aurora";
const CHECKPOINT_KEY = `task.${TASK_ID}.checkpoint`;
const CHECKPOINT = {
  schemaVersion: "dolly.task-checkpoint/1",
  taskId: TASK_ID,
  objective: "Publish the Aurora package after owner approval",
  completed: ["unit-tests", "package-built"],
  constraints: { channel: "canary", retentionHours: 24 },
  nextAction: { kind: "request-approval", target: "owner", reason: "publish-canary" },
  sourceId: "task-a-input",
} as const;
const TASK_SEQUENCE = [
  { phase: "checkpoint", taskId: TASK_ID, checkpointKey: CHECKPOINT_KEY, checkpoint: CHECKPOINT },
  { phase: "unrelated", taskId: "arithmetic-cobalt", question: "What is 29 - 12?" },
  { phase: "resume", taskId: TASK_ID, request: "Resume this task from memory and identify the next action." },
] as const;
const IMPLEMENTATION_PATHS = [
  "scripts/experiments/probes/scheduler-agent-task-switch-v0/run.mts",
  "scripts/experiments/probes/scheduler-agent-task-switch-v0/extension.mjs",
  "scripts/experiments/probes/scheduler-agent-task-switch-v0/verify.mjs",
] as const;
const PRODUCTION_PATHS = [
  "src/adapters/extension-effect-run-lifecycle.ts",
  "src/adapters/extension-process-module-executor.ts",
  "src/core/capabilities/effect-intent-journal.ts",
  "src/core/capabilities/file-effect-intent-store.ts",
  "src/core/capabilities/module-private-storage-capability.ts",
  "src/core/extension-process-host.ts",
  "src/core/file-core-state-store.ts",
  "src/core/file-tool-journal-repository.ts",
  "src/core/model-provider-broker.ts",
  "src/core/model-provider-chat.ts",
  "src/core/model-provider-descriptor.ts",
  "src/core/module-result-commit.ts",
  "src/core/module-scheduler.ts",
  "src/core/provider-capabilities/model-operation-capability.ts",
  "src/core/provider-capabilities/tool-invocation-capability.ts",
  "src/core/reactive-module-host.ts",
  "src/core/reactive-module-runtime.ts",
  "src/core/runtime-bootstrap.ts",
  "src/core/tool-policy.ts",
] as const;
const CHAT_STRATEGIES = new Set([
  "openai.chat.request.text-parts.v1",
  "aether.qwen.chat.response.v2",
  "openai.chat.message-order.v1",
  "openai.reasoning-content.nonstream.v1",
  "thinking-object.enabled-disabled.v1",
  "openai.response-format.json-object.v1",
]);

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function loadAetherEnvironment(): { baseUrl: string; apiKey: string } {
  const values = new Map<string, string>();
  const source = readFileSync(join(repositoryRoot, ".env"), "utf8");
  for (const line of source.split(/\r?\n/u)) {
    const match = /^\s*(AETHER_BASE_URL|AETHER_API_KEY)\s*=\s*(.*)\s*$/u.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(match[1]!, value);
  }
  const baseUrl = values.get("AETHER_BASE_URL");
  const apiKey = values.get("AETHER_API_KEY");
  if (!baseUrl || !apiKey) throw new Error("Aether fixture is not configured");
  return { baseUrl, apiKey };
}

function completionUrl(baseValue: string): URL {
  const url = new URL(baseValue);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Aether base URL contains a forbidden component");
  }
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (host === "127.0.0.1" || host === "::1") {
    if (url.protocol !== "http:" || url.port === "") {
      throw new Error("Loopback Aether requires HTTP and an explicit port");
    }
  } else if (url.protocol !== "https:") {
    throw new Error("Non-loopback Aether requires HTTPS");
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "")}/v1/chat/completions`;
  return url;
}

function descriptorDocument() {
  return {
    schemaVersion: "dolly.model-descriptor/4" as const,
    descriptorVersion: "owner-aether-qwen3.6-27b-task-switch-v2",
    endpointId: "owner-aether-task-switch-fixture",
    operation: "chat-completion" as const,
    modelId: "qwen3.6-27b",
    adapter: {
      id: "openai-compatible-chat",
      version: "v1",
      requestStrategyId: "openai.chat.request.text-parts.v1",
      responseStrategyId: "aether.qwen.chat.response.v2",
    },
    limits: {
      maxRequestBytes: 128 * 1024,
      maxResponseBytes: 512 * 1024,
      maxInputItems: 64,
      maxInputBytes: 96 * 1024,
      maxOutputBytes: 256 * 1024,
      maxConcurrentRequests: 1,
      maxProviderTimeoutMs: 180_000,
      streaming: { state: "unsupported" as const },
    },
    input: {
      modalities: ["text" as const],
      text: { state: "supported" as const, value: { maxBytesPerItem: 32 * 1024, empty: "forbidden" as const } },
      media: [],
    },
    retry: {
      maxProviderAttempts: 1,
      safeConditions: ["before-dispatch" as const],
      providerIdempotency: { state: "unsupported" as const },
    },
    features: {
      roles: ["system", "user", "assistant", "tool"],
      messageOrderStrategyId: "openai.chat.message-order.v1",
      maxMessages: 64,
      maxPartsPerMessage: 16,
      contextWindowTokens: { state: "supported" as const, value: { maximum: 32_768 } },
      maxOutputTokens: { state: "supported" as const, value: { maximum: 8_192 } },
      mediaRequirementIds: [],
      tools: { state: "unsupported" as const },
      structuredOutput: { state: "unsupported" as const },
      jsonObjectOutput: {
        state: "supported" as const,
        value: { strategyId: "openai.response-format.json-object.v1" },
      },
      reasoning: {
        support: "request-controlled" as const,
        requestControl: { kind: "enum-strategy" as const, strategyId: "thinking-object.enabled-disabled.v1" },
        observation: {
          state: "supported" as const,
          value: { nonStreamStrategyId: "openai.reasoning-content.nonstream.v1", empty: "not-observed" as const },
        },
        replay: { requirement: "forbidden" as const },
      },
      finishReasons: ["stop", "length", "tool_calls"],
    },
  };
}

function safeModelCall(
  invocation: ChatBrokerInvocation,
  result: ChatBrokerResult,
  startedAt: string,
  completedAt: string,
): JsonValue {
  return {
    schemaVersion: "scheduler-agent-task-switch/model-call/1",
    startedAt,
    completedAt,
    finishedAt: completedAt,
    requestId: invocation.requestId,
    context: invocation.context as unknown as JsonValue,
    reasoningPolicy: invocation.reasoningPolicy,
    budgets: invocation.budgets as unknown as JsonValue,
    input: invocation.input as unknown as JsonValue,
    result: result.status === "succeeded"
      ? { status: result.status, output: result.output as unknown as JsonValue, usage: result.usage as unknown as JsonValue }
      : { status: result.status, error: result.error as unknown as JsonValue, usage: result.usage as unknown as JsonValue },
  };
}

function checkpointSchema() {
  return {
    type: "object" as const,
    properties: {
      schemaVersion: { type: "string" as const, maxBytes: 64, enum: ["dolly.task-checkpoint/1"] },
      taskId: { type: "string" as const, maxBytes: 128 },
      objective: { type: "string" as const, maxBytes: 512 },
      completed: { type: "array" as const, items: { type: "string" as const, maxBytes: 128 }, maxItems: 16 },
      constraints: {
        type: "object" as const,
        properties: {
          channel: { type: "string" as const, maxBytes: 64 },
          retentionHours: { type: "integer" as const, minimum: 1, maximum: 168 },
        },
        required: ["channel", "retentionHours"],
        additionalProperties: false as const,
        maxProperties: 2,
      },
      nextAction: {
        type: "object" as const,
        properties: {
          kind: { type: "string" as const, maxBytes: 64 },
          target: { type: "string" as const, maxBytes: 64 },
          reason: { type: "string" as const, maxBytes: 128 },
        },
        required: ["kind", "target", "reason"],
        additionalProperties: false as const,
        maxProperties: 3,
      },
      sourceId: { type: "string" as const, maxBytes: 128 },
    },
    required: ["schemaVersion", "taskId", "objective", "completed", "constraints", "nextAction", "sourceId"],
    additionalProperties: false as const,
    maxProperties: 7,
  };
}

function storageTools(): readonly ToolDescriptor[] {
  const list: ToolDescriptor = {
    toolId: "storage.list",
    wireName: "storage_list",
    description: "List structured task-checkpoint keys under one exact task prefix.",
    argumentSchema: {
      type: "object",
      properties: {
        prefix: { type: "string", minBytes: 1, maxBytes: 256 },
        limit: { type: "integer", minimum: 1, maximum: 3 },
      },
      required: ["prefix", "limit"],
      additionalProperties: false,
      maxProperties: 2,
    },
    resultSchema: {
      type: "object",
      properties: {
        schemaVersion: { type: "string", maxBytes: 64, enum: ["dolly.storage-list/1"] },
        keys: { type: "array", items: { type: "string", maxBytes: 256 }, maxItems: 3 },
        truncated: { type: "boolean" },
      },
      required: ["schemaVersion", "keys", "truncated"],
      additionalProperties: false,
      maxProperties: 3,
    },
    effectClass: "read",
    resourceScope: "task-checkpoints",
    approval: "never",
    idempotency: "effect-key",
    outcomeQuery: "supported",
    parallel: "safe",
    deadlineMs: 1_000,
    maxArgumentBytes: 1_024,
    maxResultBytes: 4 * 1_024,
  };
  const get: ToolDescriptor = {
    toolId: "storage.get",
    wireName: "storage_get",
    description: "Read one task checkpoint by a key returned from storage_list.",
    argumentSchema: {
      type: "object",
      properties: { key: { type: "string", minBytes: 1, maxBytes: 256 } },
      required: ["key"],
      additionalProperties: false,
      maxProperties: 1,
    },
    resultSchema: {
      type: "object",
      properties: {
        schemaVersion: { type: "string", maxBytes: 64, enum: ["dolly.storage-get/1"] },
        found: { type: "enum", values: [true] },
        value: checkpointSchema(),
        updatedAt: { type: "string", maxBytes: 64 },
      },
      required: ["schemaVersion", "found", "value", "updatedAt"],
      additionalProperties: false,
      maxProperties: 4,
    },
    effectClass: "read",
    resourceScope: "task-checkpoints",
    approval: "never",
    idempotency: "effect-key",
    outcomeQuery: "supported",
    parallel: "safe",
    deadlineMs: 1_000,
    maxArgumentBytes: 1_024,
    maxResultBytes: 8 * 1_024,
  };
  const set: ToolDescriptor = {
    toolId: "storage.set",
    wireName: "storage_set",
    description: "Store one sourced structured checkpoint for a paused task; Host approval is required.",
    argumentSchema: {
      type: "object",
      properties: {
        key: { type: "string", minBytes: 1, maxBytes: 256 },
        value: checkpointSchema(),
      },
      required: ["key", "value"],
      additionalProperties: false,
      maxProperties: 2,
    },
    resultSchema: {
      type: "object",
      properties: {
        schemaVersion: { type: "string", maxBytes: 64, enum: ["dolly.storage-set/1"] },
        stored: { type: "enum", values: [true] },
        revision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        entryCount: { type: "integer", minimum: 1, maximum: 128 },
      },
      required: ["schemaVersion", "stored", "revision", "entryCount"],
      additionalProperties: false,
      maxProperties: 4,
    },
    effectClass: "write",
    resourceScope: "task-checkpoints",
    approval: "required",
    idempotency: "effect-key",
    outcomeQuery: "supported",
    parallel: "serial",
    deadlineMs: 1_000,
    maxArgumentBytes: 8 * 1_024,
    maxResultBytes: 1_024,
  };
  return [list, get, set];
}

function storageExecutor(options: {
  readonly backend: ModulePrivateStorageBackend;
  readonly instanceId: string;
  readonly moduleId: string;
}): ToolExecutor {
  const namespace = options.backend.namespaceFor(options.instanceId, options.moduleId);
  const binding = { namespace, instanceId: options.instanceId, moduleId: options.moduleId };
  return {
    execute: async (request): Promise<ToolExecutionOutcome> => {
      if (request.toolId === "storage.list") {
        const prefix = request.arguments.prefix as string;
        const limit = request.arguments.limit as number;
        const matching = options.backend.read(binding).entries.filter((entry) => entry.key.startsWith(prefix));
        const page = matching.slice(0, limit);
        return {
          status: "succeeded",
          content: {
            schemaVersion: "dolly.storage-list/1",
            keys: page.map((entry) => entry.key),
            truncated: page.length < matching.length,
          },
        };
      }
      if (request.toolId === "storage.get") {
        const key = request.arguments.key as string;
        const entry = options.backend.read(binding).entries.find((candidate) => candidate.key === key);
        return entry
          ? {
              status: "succeeded",
              content: {
                schemaVersion: "dolly.storage-get/1",
                found: true,
                value: entry.value,
                updatedAt: entry.updatedAt,
              },
            }
          : { status: "failed", code: "CHECKPOINT_NOT_FOUND" };
      }
      if (request.toolId === "storage.set") {
        const key = request.arguments.key as string;
        const value = request.arguments.value as JsonValue;
        const current = options.backend.read(binding);
        const stored = options.backend.replace(binding, [
          ...current.entries.filter((entry) => entry.key !== key),
          { key, value, updatedAt: options.backend.timestamp() },
        ]);
        return {
          status: "succeeded",
          content: {
            schemaVersion: "dolly.storage-set/1",
            stored: true,
            revision: stored.revision,
            entryCount: stored.entries.length,
          },
        };
      }
      return { status: "failed", code: "CHECKPOINT_TOOL_UNKNOWN" };
    },
  };
}

const TOOL_BUDGET: ToolTurnBudget = {
  maxRounds: 2,
  maxCalls: 2,
  maxCallsPerRound: 1,
  maxApprovals: 1,
  maxCallBytes: 12 * 1_024,
};

function textBlock(value: JsonValue) {
  return {
    payload: {
      schema: "dolly.content/1",
      value: { items: [{ type: "text" as const, text: JSON.stringify(value), format: "plain" as const }] },
    },
  };
}

function parseAgentResult(value: JsonValue): Record<string, unknown> {
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length !== 1) throw new Error("Agent output item count invalid");
  const text = (items[0] as { text?: unknown }).text;
  if (typeof text !== "string") throw new Error("Agent output text is absent");
  const parsed = JSON.parse(text);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Agent output is not one object");
  }
  return parsed as Record<string, unknown>;
}

async function runCondition(options: {
  readonly conditionId: "no-checkpoint" | "structured-checkpoint";
  readonly broker: ChatModelBrokerPort;
  readonly runDirectory: string;
}): Promise<JsonValue> {
  const conditionRoot = mkdtempSync(
    join(resolve(workspaceRoot, ".tmp"), `scheduler-agent-task-switch-${options.conditionId}-`),
  );
  const instanceId = `instance-task-switch-${options.conditionId}`;
  const moduleId = "task-switch-agent";
  const moduleGenerationId = `module-generation-${options.conditionId}-1`;
  const grantedCapabilityTypes = options.conditionId === "structured-checkpoint"
    ? ["model-operation", "tool-invocation"]
    : ["model-operation"];
  let processGenerationId: string | undefined;
  let childPid: number | undefined;
  let host: ReactiveModuleHost | undefined;
  let extensionHost: ExtensionProcessHost | undefined;
  const toolJournalPath = join(conditionRoot, "tool-rounds.json");
  const effectPath = join(conditionRoot, "effect-intents.json");
  try {
    let blockSequence = 0;
    let deliverySequence = 0;
    let identifierSequence = 0;
    let modelRequestSequence = 0;
    let monotonic = 0;
    const core = new FileCoreStateStore({
      path: join(conditionRoot, "core-state.json"),
      maxFailedAttempts: 1,
      nextBlockId: () => `block-${options.conditionId}-${++blockSequence}`,
      nextDeliveryId: (kind) => `${kind}-${options.conditionId}-${++deliverySequence}`,
      now: () => NOW,
    });
    core.deliveries.createPage("input");
    core.deliveries.createPage("output");
    core.deliveries.registerConsumer("input", moduleId, "from-now");
    core.deliveries.registerConsumer("output", "sink", "from-now");
    const repository = new FileModuleResultCommitRepository({
      path: join(conditionRoot, "module-result-commits.json"),
    });
    const toolJournal = new FileToolJournalRepository({ path: toolJournalPath });
    const effectJournal = new EffectIntentJournal({
      store: new FileEffectIntentStore({ path: effectPath }),
      now: () => NOW,
    });
    const effectLifecycle = createExtensionEffectJournalLifecycle({
      journal: effectJournal,
      getModuleSubmissionRecord: (runId) => core.getModuleSubmissionRecord(runId),
    });
    const storage = new ModulePrivateStorageBackend({
      root: join(conditionRoot, "module-private-storage"),
      now: () => NOW,
    });
    const storageBinding = {
      namespace: storage.namespaceFor(instanceId, moduleId),
      instanceId,
      moduleId,
    };
    const commits = createModuleResultCommitCoordinator({
      core,
      repository,
      now: () => NOW,
      mailboxes: [{
        consumerId: "sink",
        pageIds: ["output"],
        maxResidentCount: 3,
        maxResidentBytes: 1024 * 1024,
      }],
    });
    const deliveries: ReactiveModuleRuntimeOptions["deliveries"] = {
      validateClaimPages: core.deliveries.validateClaimPages.bind(core.deliveries),
      validateOutputPages: core.deliveries.validateOutputPages.bind(core.deliveries),
      claim: core.deliveries.claim.bind(core.deliveries),
      flushPersistence: core.deliveries.flushPersistence.bind(core.deliveries),
      inspectClaim: core.deliveries.inspectClaim.bind(core.deliveries),
      inspectClaimInput: core.deliveries.inspectClaimInput.bind(core.deliveries),
    };
    const runtime = new ReactiveModuleRuntime({
      moduleId,
      initialModuleGenerationId: moduleGenerationId,
      inputPageIds: ["input"],
      outputPageIds: ["output"],
      claimMaxCount: 1,
      claimMaxBytes: 64 * 1024,
      maxInputBytes: 64 * 1024,
      maxResultBytes: 256 * 1024,
      executionTimeoutMs: 180_000,
      cancellationGraceMs: 5_000,
      initializationTimeoutMs: 5_000,
      terminationTimeoutMs: 5_000,
      maxRunsPerGeneration: 3,
      maxGenerations: 1,
      declaredExternalEffects: "core-capabilities-only",
      externalEffectEvidence: effectIntentEvidenceSource(effectJournal),
      deliveries,
      persistModuleSubmission: (request) => {
        if (!processGenerationId) throw new Error("process generation is absent");
        core.appendModuleSubmissionRecord({
          schemaVersion: "dolly.module-submission-record/1",
          ...request,
          processGenerationId,
          createdAt: NOW,
        });
      },
      releaseDeliveryClaim: (identity) => core.releaseDeliveryClaim(identity),
      negativelyAcknowledgeDeliveryClaim: (request) => core.negativelyAcknowledgeDeliveryClaim(request),
      getModuleSubmissionRecord: (runId) => core.getModuleSubmissionRecord(runId),
      commits,
      nextModuleGenerationId: () => `${moduleGenerationId}-unused`,
      monotonicNow: () => ++monotonic,
      createExecutor: (generationId) => {
        extensionHost = new ExtensionProcessHost({
          isolation: "process",
          trust: "trusted",
          isolationPolicy: new ExtensionIsolationPolicy(),
          manifest: {
            schemaVersion: "dolly.extension-package/1",
            extensionId: "org.dolly.scheduler-agent-task-switch",
            packageVersion: "1.0.0",
            displayName: "Scheduler task-switch Agent fixture",
            description: "Exploratory structured checkpoint effect fixture.",
            supportedProtocolVersions: ["3.0"],
            entrypoint: "extension.mjs",
            modules: [{
              moduleKind: "task-switch-agent",
              activation: "reactive",
              configVersion: 1,
              configurationSchema: { type: "object" },
            }],
            requestedCapabilities: [],
          },
          command: process.execPath,
          args: [extensionPath],
          workingDirectory: conditionRoot,
          instanceId,
          moduleId,
          moduleGenerationId: generationId,
          moduleKind: "task-switch-agent",
          config: {},
          maxFrameBytes: 1024 * 1024,
          maxConcurrentCapabilityRequests: 1,
          initializationTimeoutMs: 5_000,
          shutdownRequestTimeoutMs: 2_000,
          forceKillDelayMs: 500,
          terminationTimeoutMs: 5_000,
          nextIdentifier: (purpose) => `${purpose}-${options.conditionId}-${++identifierSequence}`,
          effectRunLifecycle: effectLifecycle,
        });
        processGenerationId = extensionHost.snapshot.processGenerationId;
        core.appendModuleProcessRecord({
          schemaVersion: "dolly.module-process-record/1",
          instanceId,
          moduleId,
          moduleGenerationId: generationId,
          processGenerationId,
          packageDigest: `sha256:${"a".repeat(64)}`,
          configurationReference: {
            configId: `config-${options.conditionId}`,
            revision: `sha256:${"b".repeat(64)}`,
            configVersion: 1,
          },
          declaredExternalEffects: "core-capabilities-only",
          serviceInvocationId: options.conditionId === "no-checkpoint" ? "4".repeat(32) : "5".repeat(32),
          bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
          moduleCgroupPath: deriveModuleCgroupPath(
            "/system.slice/dolly-core.service",
            { instanceId, moduleId, processGenerationId },
          ).filesystemPath,
          state: "starting",
          createdAt: NOW,
          updatedAt: NOW,
        });
        const modelInvocationLimit = options.conditionId === "no-checkpoint" ? 3 : 8;
        const modelDefinition = createModelOperationCapabilityV2({
          descriptor: descriptorRef,
          ownerScope: "owner-task-switch-fixture",
          budgets: {
            maxProviderAttempts: 1,
            maxWallTimeMs: 180_000,
            maxRequestBytes: 128 * 1024,
            maxResponseBytes: 512 * 1024,
            maxInputItems: 64,
            maxInputBytes: 96 * 1024,
            maxOutputBytes: 256 * 1024,
            maxOutputTokens: 5_200,
          },
          executionScope: "active-run",
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          now: () => new Date().toISOString(),
          chat: options.broker,
          operations: ["chat"],
          reasoningPolicies: ["require", "disable"],
          outputContracts: ["text", "json-object"],
          roles: ["system", "user"],
          limits: {
            maxInvocations: modelInvocationLimit,
            maxInvocationsPerRun: 4,
            maxInvocationsPerWindow: modelInvocationLimit,
            rateWindowMs: 60_000,
          },
          maxConcurrentInvocations: 1,
          requireIdempotencyKey: true,
          nextRequestId: () => `task-switch-model-request-${options.conditionId}-${++modelRequestSequence}`,
        });
        extensionHost.grantCapability(modelDefinition.grant, modelDefinition.handler);
        if (options.conditionId === "structured-checkpoint") {
          const descriptors = storageTools();
          const registry = new ToolRegistry(descriptors, descriptors.map((entry) => entry.toolId));
          const executor = storageExecutor({ backend: storage, instanceId, moduleId });
          const toolDefinition = createToolInvocationCapabilityV2({
            executionScope: "active-run",
            expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            operations: ["list-tools", "execute-round"],
            limits: {
              maxInvocations: 5,
              maxInvocationsPerRun: 3,
              maxCallsPerRound: 1,
            },
            maxConcurrentInvocations: 1,
            resolveRun: ({ moduleJobId }) => ({
              registry,
              budget: TOOL_BUDGET,
              policy: new ToolPolicySession({
                moduleJobId,
                registry,
                repository: toolJournal,
                approval: {
                  decide: async (request) => ({
                    decision: request.toolId === "storage.set" ? "approved" : "denied",
                    code: request.toolId === "storage.set"
                      ? "CHECKPOINT_POLICY_APPROVED"
                      : "CHECKPOINT_POLICY_DENIED",
                  }),
                },
                executor,
                budget: TOOL_BUDGET,
                approvalPolicyRevision: "task-checkpoint-policy-v1",
              }),
            }),
          });
          extensionHost.grantCapability(toolDefinition.grant, toolDefinition.handler);
        }
        const executor = createExtensionProcessModuleExecutor(extensionHost, {
          moduleId,
          moduleGenerationId: generationId,
          executionTimeoutMs: 180_000,
          cancellationGraceMs: 5_000,
        });
        return executor;
      },
      classifyFailure: (failure: ReactiveModuleFailure) => ({ code: failure.code, retryable: false }),
    });
    const managed: ManagedReactiveModuleRuntime = {
      get moduleGenerationId() {
        return runtime.moduleGenerationId;
      },
      tick: (limits) => runtime.tick(limits),
      start: async () => {
        await runtime.start();
        if (!processGenerationId) throw new Error("process generation was not recorded");
        core.updateModuleProcessRecordState(processGenerationId, "running");
      },
      stop: async () => {
        if (processGenerationId && core.getModuleProcessRecord(processGenerationId)?.state === "running") {
          core.updateModuleProcessRecordState(processGenerationId, "stopping");
        }
        await runtime.stop();
      },
    };
    const scheduler = new ModuleScheduler({
      instanceId,
      deliveries: core.deliveries,
      clock: systemSchedulerClock(),
      pollIntervalMs: 60_000,
      retryBaseMs: 100,
      retryMaxMs: 1_000,
      maxConcurrentModules: 1,
      backpressureAction: "pause-upstream",
      downstreamRecheckMs: 100,
      noProgressAfterMs: 170_000,
      claimLimitCount: 1,
      claimLimitBytes: 64 * 1024,
      retryJitterRatio: 0,
    });
    host = new ReactiveModuleHost(scheduler, [{
      moduleId,
      runtime: managed,
      inputPageIds: ["input"],
      outputPageIds: ["output"],
      mailbox: { maxPendingCount: 4, maxPendingBytes: 1024 * 1024 },
    }]);
    await host.start();
    childPid = extensionHost?.snapshot.pid;
    if (childPid === undefined) throw new Error("Extension child PID was not observed");

    const seenJobs = new Set<string>();
    const phaseRows: JsonValue[] = [];
    const committedIdentities: Array<{
      readonly moduleJobId: string;
      readonly claimToken: string;
      readonly runId: string;
      readonly attempt: number;
      readonly moduleGenerationId: string;
    }> = [];
    for (const task of TASK_SEQUENCE) {
      const block = core.blocks.commit(textBlock(task as unknown as JsonValue), {
        kind: "external",
        id: `task-switch-${task.phase}`,
      });
      core.deliveries.append("input", block.id);
      const committed = await waitForAgentCase({
        findCommitted: () => repository.list().find(
          (record) => record.state === "committed" && !seenJobs.has(record.moduleJobId),
        ),
        listDeadLetters: () => core.deliveries.listDeadLetters(),
        readSchedulerStatus: () => scheduler.status(moduleId),
        timeoutMs: 180_000,
      });
      seenJobs.add(committed.moduleJobId);
      if (!committed.blockId) throw new Error("Agent result committed no Block");
      const resultBlock = core.blocks.get(committed.blockId);
      if (!resultBlock) throw new Error("Agent result Block is absent");
      const result = parseAgentResult(resultBlock.payload.value);
      if (result.phase !== task.phase) throw new Error("Agent result phase drifted");
      const liveEvidence = effectJournal.evidenceForRun(committed);
      const reopenedEvidence = new EffectIntentJournal({
        store: new FileEffectIntentStore({ path: effectPath }),
        now: () => NOW,
      }).evidenceForRun(committed);
      if (liveEvidence.kind !== "terminal" || reopenedEvidence.kind !== "terminal") {
        throw new Error("Agent Run capability evidence is not terminal");
      }
      committedIdentities.push(committed);
      phaseRows.push({
        phase: task.phase,
        input: task as unknown as JsonValue,
        result: result as unknown as JsonValue,
        commit: {
          moduleJobId: committed.moduleJobId,
          runId: committed.runId,
          attempt: committed.attempt,
          moduleGenerationId: committed.moduleGenerationId,
          blockId: committed.blockId,
        },
      });
    }

    const storedEntries = storage.read(storageBinding).entries;
    const effectArtifact = `effect-intents-${options.conditionId}.json`;
    const effectBytes = readFileSync(effectPath);
    writeFileSync(join(options.runDirectory, effectArtifact), effectBytes, { flag: "wx", mode: 0o600 });
    let toolArtifact: string | null = null;
    let toolSha256: string | null = null;
    if (options.conditionId === "structured-checkpoint") {
      toolArtifact = `tool-rounds-${options.conditionId}.json`;
      const toolBytes = readFileSync(toolJournalPath);
      toolSha256 = sha256(toolBytes);
      writeFileSync(join(options.runDirectory, toolArtifact), toolBytes, { flag: "wx", mode: 0o600 });
    }
    await host.stop();
    const childStopped = !processIsAlive(childPid);
    return {
      schemaVersion: "scheduler-agent-task-switch/case/1",
      conditionId: options.conditionId,
      phases: phaseRows,
      sameProcessAcrossPhases: new Set(committedIdentities.map((entry) => entry.moduleGenerationId)).size === 1,
      distinctRuns: new Set(committedIdentities.map((entry) => entry.runId)).size === 3,
      schedulerCompletion:
        core.deliveries.inspectPending(moduleId, ["input"]).pendingCount === 0 &&
        core.deliveries.inspectPending("sink", ["output"]).pendingCount === 3 &&
        core.listModuleSubmissionRecords().length === 0,
      childPidRecorded: true,
      childStopped,
      childCapabilityTypes: grantedCapabilityTypes,
      storageEntries: storedEntries as unknown as JsonValue,
      effectJournal: { artifact: effectArtifact, sha256: sha256(effectBytes), evidence: "terminal-all-runs" },
      toolJournal: toolArtifact === null ? null : { artifact: toolArtifact, sha256: toolSha256 },
      linuxControlGroupProof: false,
    };
  } catch (error) {
    for (const [source, name] of [
      [effectPath, `failed-evidence-effect-intents-${options.conditionId}.json`],
      [toolJournalPath, `failed-evidence-tool-rounds-${options.conditionId}.json`],
    ] as const) {
      if (existsSync(source)) {
        writeFileSync(join(options.runDirectory, name), readFileSync(source), {
          flag: "wx",
          mode: 0o600,
        });
      }
    }
    throw error;
  } finally {
    if (host?.state === "running") await host.stop().catch(() => undefined);
    if (extensionHost && extensionHost.snapshot.state !== "stopped") {
      await extensionHost.terminate().catch(() => undefined);
    }
    if (childPid !== undefined && processIsAlive(childPid)) {
      throw new Error(`Recorded Extension child ${childPid} remained alive`);
    }
    rmSync(conditionRoot, { recursive: true, force: true });
  }
}

let descriptorRef: ReturnType<ModelDescriptorRegistry["register"]>;

async function main(): Promise<void> {
  if (process.env.RUN_LIVE_INTEGRATION !== "1" || process.env.RUN_PAID_INTEGRATION !== "1") {
    throw new Error("RUN_LIVE_INTEGRATION=1 and RUN_PAID_INTEGRATION=1 are required");
  }
  if (process.argv.length !== 4 || process.argv[2] !== "--run-id") {
    throw new Error("usage: run.mts --run-id task-switch-v0-<identifier>");
  }
  const runId = process.argv[3]!;
  if (!/^task-switch-v0-[A-Za-z0-9._-]+$/u.test(runId)) throw new Error("run ID is invalid");
  const preregistrationBytes = readFileSync(preregistrationPath);
  const preregistration = JSON.parse(preregistrationBytes.toString("utf8")) as {
    readonly experimentId?: unknown;
    readonly experimentVersion?: unknown;
    readonly status?: unknown;
    readonly protocol?: { readonly sha256?: unknown };
    readonly domainDesign?: {
      readonly implementationSha256?: Readonly<Record<string, unknown>>;
      readonly productionSourceSha256?: Readonly<Record<string, unknown>>;
    };
  };
  if (
    preregistration.experimentId !== "scheduler-agent-task-switch-v0" ||
    preregistration.experimentVersion !== 2 ||
    preregistration.status !== "frozen-before-first-run"
  ) {
    throw new Error("task-switch preregistration is not frozen");
  }
  const protocolSha256 = sha256(readFileSync(protocolPath));
  if (preregistration.protocol?.sha256 !== protocolSha256) {
    throw new Error("experiment protocol digest changed");
  }
  const verifyInventory = (paths: readonly string[], values: Readonly<Record<string, unknown>> | undefined) => {
    if (!values || JSON.stringify(Object.keys(values).sort()) !== JSON.stringify([...paths].sort())) {
      throw new Error("frozen source inventory is invalid");
    }
    return Object.fromEntries(paths.map((path) => {
      const actual = sha256(readFileSync(join(repositoryRoot, path)));
      if (values[path] !== actual) throw new Error(`frozen source changed: ${path}`);
      return [path, actual];
    }));
  };
  const implementationSha256 = verifyInventory(
    IMPLEMENTATION_PATHS,
    preregistration.domainDesign?.implementationSha256,
  );
  const productionSourceSha256 = verifyInventory(
    PRODUCTION_PATHS,
    preregistration.domainDesign?.productionSourceSha256,
  );
  const fixture = loadAetherEnvironment();
  const exactUrl = completionUrl(fixture.baseUrl);
  const descriptors = new ModelDescriptorRegistry({
    schemaDigest: SCHEMA_DIGEST,
    allowedStrategyIds: CHAT_STRATEGIES,
  });
  descriptorRef = descriptors.register(descriptorDocument());
  descriptors.setStatus(descriptorRef, "active");
  const bindings = new EndpointBindingRegistry();
  const bindingRef = bindings.register({
    schemaVersion: "dolly.endpoint-binding/2",
    endpointId: descriptorRef.endpointId,
    bindingRevision: "owner-aether-task-switch-binding-v1",
    descriptorRefs: [descriptorRef],
    exactUrl: exactUrl.href,
    networkScope: ["127.0.0.1", "::1"].includes(exactUrl.hostname) ? "loopback" : "public",
    authentication: {
      kind: "bearer-secret",
      secretRef: "owner-aether-api-key",
      secretRevision: "runtime-env-v1",
    },
    limits: { maxRequestBytes: 128 * 1024, maxResponseBytes: 512 * 1024, maxTimeoutMs: 180_000 },
  });
  bindings.setStatus(bindingRef, "active");

  const artifactRoot = join(repositoryRoot, "artifacts/experiments/probes/scheduler-agent-task-switch-v0");
  const runDirectory = join(artifactRoot, "runs", runId);
  mkdirSync(resolve(workspaceRoot, ".tmp"), { recursive: true, mode: 0o700 });
  mkdirSync(join(artifactRoot, "runs"), { recursive: true, mode: 0o700 });
  mkdirSync(runDirectory, { mode: 0o700 });
  writeFileSync(join(runDirectory, "preregistration.json"), preregistrationBytes, { flag: "wx" });
  const providerPath = join(runDirectory, "provider-responses.jsonl");
  const modelPath = join(runDirectory, "model-calls.jsonl");
  const casesPath = join(runDirectory, "cases.jsonl");
  writeFileSync(providerPath, "", { flag: "wx" });
  writeFileSync(modelPath, "", { flag: "wx" });
  writeFileSync(casesPath, "", { flag: "wx" });
  const providerRows: JsonValue[] = [];
  const modelRows: JsonValue[] = [];
  let secretReleases = 0;
  const secrets: ModelSecretResolver = {
    resolve: async (secretRef, secretRevision) => {
      if (secretRef !== "owner-aether-api-key" || secretRevision !== "runtime-env-v1") {
        throw new Error("unexpected secret reference");
      }
      return { value: fixture.apiKey, release: () => { secretReleases += 1; } };
    },
  };
  const broker = new ChatModelBroker({
    descriptors,
    bindings,
    secrets,
    transport: new ExperimentFetchTransport((row) => {
      providerRows.push(row);
      appendFileSync(providerPath, `${JSON.stringify(row)}\n`, "utf8");
    }),
    now: () => new Date().toISOString(),
  });
  let providerCalls = 0;
  const observedBroker: ChatModelBrokerPort = {
    invoke: async (invocation, options) => {
      providerCalls += 1;
      if (providerCalls > 11) throw new Error("provider-call budget exceeded");
      const startedAt = new Date().toISOString();
      const result = await broker.invoke(invocation, options);
      const row = safeModelCall(invocation, result, startedAt, new Date().toISOString());
      modelRows.push(row);
      appendFileSync(modelPath, `${JSON.stringify(row)}\n`, "utf8");
      return result;
    },
  };

  const startedAt = new Date().toISOString();
  const caseRows: JsonValue[] = [];
  let status: "completed" | "failed" = "completed";
  let failure: string | null = null;
  try {
    for (const conditionId of ["no-checkpoint", "structured-checkpoint"] as const) {
      const row = await runCondition({ conditionId, broker: observedBroker, runDirectory });
      caseRows.push(row);
      appendFileSync(casesPath, `${JSON.stringify(row)}\n`, "utf8");
    }
  } catch (error) {
    status = "failed";
    failure = error instanceof Error ? error.message : "unknown failure";
  }
  const completedAt = new Date().toISOString();
  const analysis = {
    schemaVersion: "scheduler-agent-task-switch/analysis/1",
    experimentId: "scheduler-agent-task-switch-v0",
    runId,
    status,
    failure,
    observedConditions: caseRows.length,
    providerCalls,
    provisionalClassification: status === "completed"
      ? "candidate-supported-pending-independent-validation"
      : "inconclusive",
  };
  writeFileSync(join(runDirectory, "analysis.json"), `${JSON.stringify(analysis, null, 2)}\n`, { flag: "wx" });
  const artifactDigests: Record<string, string> = {};
  const failedEvidencePaths = readdirSync(runDirectory)
    .filter((name) => name.startsWith("failed-evidence-") && name.endsWith(".json"))
    .sort()
    .map((name) => join(runDirectory, name));
  for (const path of [
    providerPath,
    modelPath,
    casesPath,
    join(runDirectory, "analysis.json"),
    ...failedEvidencePaths,
  ]) {
    artifactDigests[path.slice(runDirectory.length + 1)] = sha256(readFileSync(path));
  }
  for (const row of caseRows as Array<Record<string, any>>) {
    for (const evidence of [row.effectJournal, row.toolJournal]) {
      if (evidence?.artifact) artifactDigests[evidence.artifact] = evidence.sha256;
    }
  }
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const dirtyWorktree = execFileSync("git", ["status", "--porcelain"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim() !== "";
  const perCaseAccounting = Object.fromEntries(
    (["no-checkpoint", "structured-checkpoint"] as const).map((conditionId) => {
      const rows = modelRows.filter((row) => {
        const requestId = (row as { requestId?: unknown }).requestId;
        return typeof requestId === "string" && requestId.includes(`-${conditionId}-`);
      }) as Array<Record<string, unknown>>;
      const providerStart = conditionId === "no-checkpoint" ? 0 : 3;
      const providerEnd = conditionId === "no-checkpoint" ? 3 : 11;
      const conditionProviderRows = providerRows.slice(providerStart, providerEnd) as Array<Record<string, unknown>>;
      let promptTokens = 0;
      let completionTokens = 0;
      let recordsWithTokenUsage = 0;
      let errors = 0;
      let latencyMs = 0;
      for (const row of rows) {
        const result = row.result as Record<string, unknown> | undefined;
        if (result?.status !== "succeeded") errors += 1;
        const started = Date.parse(String(row.startedAt));
        const completed = Date.parse(String(row.completedAt));
        if (Number.isFinite(started) && Number.isFinite(completed)) {
          latencyMs += Math.max(0, completed - started);
        }
      }
      for (const providerRow of conditionProviderRows) {
        const response = providerRow.response as Record<string, unknown> | undefined;
        const usage = response?.usage as Record<string, unknown> | undefined;
        if (
          typeof usage?.prompt_tokens === "number" &&
          typeof usage?.completion_tokens === "number"
        ) {
          promptTokens += usage.prompt_tokens;
          completionTokens += usage.completion_tokens;
          recordsWithTokenUsage += 1;
        }
      }
      return [conditionId, {
        modelCalls: rows.length,
        providerAttempts: conditionProviderRows.length,
        retries: 0,
        errors,
        tokens: {
          prompt: promptTokens,
          completion: completionTokens,
          total: promptTokens + completionTokens,
          recordsWithUsage: recordsWithTokenUsage,
          recordsMissingUsage: conditionProviderRows.length - recordsWithTokenUsage,
        },
        latencyMs,
      }];
    }),
  );
  const manifest = {
    schemaVersion: "scheduler-agent-task-switch/run-manifest/1",
    experimentId: "scheduler-agent-task-switch-v0",
    experimentVersion: 2,
    runId,
    status,
    failure,
    startedAt,
    completedAt,
    sourceCommit,
    dirtyWorktree,
    preregistrationSha256: sha256(preregistrationBytes),
    protocolSha256,
    implementationSha256,
    productionSourceSha256,
    datasetSha256: sha256(JSON.stringify(TASK_SEQUENCE)),
    dataset: {
      id: "synthetic-task-switch-aurora",
      version: "1",
      split: "exploratory-evaluation",
      contentSha256: sha256(JSON.stringify(TASK_SEQUENCE)),
    },
    conditionOrder: ["no-checkpoint", "structured-checkpoint"],
    configuration: {
      descriptorVersion: descriptorRef.descriptorVersion,
      conditions: ["no-checkpoint", "structured-checkpoint"],
      phases: ["checkpoint", "unrelated", "resume"],
      checkpointSchemaVersion: "dolly.task-checkpoint/1",
      toolBudget: TOOL_BUDGET,
    },
    modelEndpointCapabilityProfile: {
      endpointId: "owner-aether-task-switch-fixture",
      descriptorVersion: descriptorRef.descriptorVersion,
      operation: "chat-completion",
      reasoningControl: "thinking.type",
      outputContracts: ["text", "json-object"],
      providerSeedControl: "unavailable",
    },
    modelIdentifier: "qwen3.6-27b",
    backend: "live",
    seeds: [81010, 81011],
    providerCalls,
    maximumProviderCalls: 11,
    perCaseAccounting,
    resourceBudgets: {
      maximumProviderCalls: 11,
      maximumOutputTokensAcrossCalls: 19_600,
      perProviderCallTimeoutMs: 180_000,
      maximumRunWallClockMs: 2_100_000,
      maximumExternallyBilledSpendUsd: 0,
    },
    rawOutputs: [
      "provider-responses.jsonl",
      "model-calls.jsonl",
      "cases.jsonl",
      "effect-intents-no-checkpoint.json",
      "effect-intents-structured-checkpoint.json",
      "tool-rounds-structured-checkpoint.json",
      ...failedEvidencePaths.map((path) => path.slice(runDirectory.length + 1)),
    ],
    validatorResults: "pending-independent-validation",
    aggregateMetrics: {
      provisionalClassification: analysis.provisionalClassification,
      observedConditions: caseRows.length,
    },
    backendKind: "live",
    executionOrder: ["no-checkpoint", "structured-checkpoint"],
    providerSeedControl: "unavailable",
    maximumExternallyBilledSpendUsd: 0,
    spendBasis: "owner self-deployed Aether fixture; 11-call hard cap remains authoritative",
    model: "qwen3.6-27b",
    endpointAndCredentialRedacted: true,
    temperatureWire: "omitted",
    providerDefaultSampling: "unverified",
    reasoningControl: "thinking.type",
    secretLeasesReleased: secretReleases,
    productBootstrapModulesRemainRejected: true,
    linuxControlGroupProof: false,
    artifacts: artifactDigests,
  };
  writeFileSync(join(runDirectory, "run-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });

  const publicBytes = [
    readFileSync(providerPath),
    readFileSync(modelPath),
    readFileSync(casesPath),
    readFileSync(join(runDirectory, "analysis.json")),
    readFileSync(join(runDirectory, "run-manifest.json")),
  ];
  if (publicBytes.some((bytes) => bytes.includes(fixture.apiKey) || bytes.includes(fixture.baseUrl))) {
    throw new Error("private fixture value leaked into artifacts");
  }
  if (status !== "completed") throw new Error(failure ?? "task-switch run failed");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
