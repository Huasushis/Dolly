#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createExtensionProcessModuleExecutor } from "../../../../src/adapters/extension-process-module-executor.js";
import {
  createModulePrivateStorageCapability,
  ModulePrivateStorageBackend,
} from "../../../../src/core/capabilities/module-private-storage-capability.js";
import type { JsonValue } from "../../../../src/core/canonical-json.js";
import {
  ExtensionIsolationPolicy,
  ExtensionProcessHost,
} from "../../../../src/core/extension-process-host.js";
import { FileCoreStateStore } from "../../../../src/core/file-core-state-store.js";
import { FileModuleResultCommitRepository } from "../../../../src/core/file-module-result-commit-repository.js";
import { deriveModuleCgroupPath } from "../../../../src/core/linux-module-cgroup.js";
import { EndpointBindingRegistry } from "../../../../src/core/model-provider-binding.js";
import {
  ChatModelBroker,
  type ChatBrokerInvocation,
  type ChatBrokerResult,
  type ModelHttpTransport,
  type ModelHttpTransportRequest,
  type ModelHttpTransportResponse,
  type ModelSecretResolver,
} from "../../../../src/core/model-provider-broker.js";
import { ModelDescriptorRegistry } from "../../../../src/core/model-provider-descriptor.js";
import {
  ModuleScheduler,
  systemSchedulerClock,
} from "../../../../src/core/module-scheduler.js";
import { createModuleResultCommitCoordinator } from "../../../../src/core/module-result-commit-factory.js";
import {
  createModelOperationCapability,
  type ChatModelBrokerPort,
} from "../../../../src/core/provider-capabilities/model-operation-capability.js";
import {
  ReactiveModuleHost,
  type ManagedReactiveModuleRuntime,
} from "../../../../src/core/reactive-module-host.js";
import {
  ReactiveModuleRuntime,
  type ReactiveModuleFailure,
  type ReactiveModuleRuntimeOptions,
} from "../../../../src/core/reactive-module-runtime.js";
import { waitForAgentCase } from "./wait-for-case.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../../..");
const workspaceRoot = resolve(repositoryRoot, "..");
const artifactRoot = join(repositoryRoot, "artifacts/experiments/probes/general-agent-live-v0");
const preregistrationPath = join(
  repositoryRoot,
  "docs/experiments/preregistrations/general-agent-live-v0.json",
);
const extensionPath = join(scriptDirectory, "extension.mjs");
const NOW = "2026-08-09T00:00:00.000Z";
const HIDDEN_CODENAME = "EMBER-7421";
const SCHEMA_DIGEST = `sha256:${"e".repeat(64)}`;
const CHAT_STRATEGIES = new Set([
  "openai.chat.request.text-parts.v1",
  "openai.chat.response.v1",
  "aether.qwen.chat.response.v2",
  "openai.chat.stream.sse.v1",
  "openai.chat.message-order.v1",
  "openai.reasoning-content.nonstream.v1",
  "openai.reasoning-content.stream.v1",
  "thinking-object.enabled-disabled.v1",
]);

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

class ExperimentFetchTransport implements ModelHttpTransport {
  readonly #recordResponse: (record: JsonValue) => void;

  constructor(recordResponse: (record: JsonValue) => void) {
    this.#recordResponse = recordResponse;
  }

  async dispatch(input: ModelHttpTransportRequest): Promise<ModelHttpTransportResponse> {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error("experiment model transport timeout")),
      input.timeoutMs,
    );
    let response: Response;
    try {
      response = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        body: Buffer.from(input.body),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      this.#recordResponse({
        schemaVersion: "general-agent-live/provider-response/1",
        httpStatus: null,
        failureKind: "network-before-response-headers",
        response: null,
      });
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", abortFromCaller);
      throw error;
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const reader = response.body?.getReader();
    const responseChunks: Buffer[] = [];
    const recordResponse = this.#recordResponse;
    let responseRecorded = false;
    const recordOnce = (record: JsonValue) => {
      if (responseRecorded) return;
      responseRecorded = true;
      recordResponse(record);
    };
    const body = (async function* () {
      let observedBytes = 0;
      try {
        if (!reader) {
          recordOnce({
            schemaVersion: "general-agent-live/provider-response/1",
            httpStatus: response.status,
            response: null,
          });
          return;
        }
        while (true) {
          const item = await reader.read();
          if (item.done) {
            const responseText = Buffer.concat(responseChunks).toString("utf8");
            let responseValue: JsonValue;
            try {
              responseValue = JSON.parse(responseText) as JsonValue;
            } catch {
              responseValue = { invalidJsonUtf8: responseText };
            }
            recordOnce({
              schemaVersion: "general-agent-live/provider-response/1",
              httpStatus: response.status,
              response: responseValue,
            });
            return;
          }
          observedBytes += item.value.byteLength;
          if (observedBytes > input.maxResponseBytes) {
            controller.abort(new Error("experiment model response exceeded its byte budget"));
            throw new Error("experiment model response exceeded its byte budget");
          }
          const chunk = Buffer.from(item.value);
          responseChunks.push(chunk);
          yield Uint8Array.from(chunk);
        }
      } catch (error) {
        recordOnce({
          schemaVersion: "general-agent-live/provider-response/1",
          httpStatus: response.status,
          failureKind: "response-body-read-failed",
          response: null,
        });
        throw error;
      } finally {
        clearTimeout(timeout);
        input.signal.removeEventListener("abort", abortFromCaller);
      }
    })();
    const providerRequestId =
      headers["x-request-id"] ?? headers["request-id"] ?? headers["x-amzn-requestid"];
    return {
      status: response.status,
      headers,
      ...(providerRequestId === undefined ? {} : { providerRequestId }),
      body,
      abort: (reason) => controller.abort(reason),
    };
  }
}

function parseArguments(argv: readonly string[]): { runId: string } {
  if (argv.length !== 2 || argv[0] !== "--run-id" || !/^live-v8-[A-Za-z0-9._-]+$/u.test(argv[1]!)) {
    throw new Error("usage: run.mts --run-id live-v8-<identifier>");
  }
  return { runId: argv[1]! };
}

function loadAetherEnvironment(): { baseUrl: string; apiKey: string } {
  const values = new Map<string, string>();
  for (const line of readFileSync(join(repositoryRoot, ".env"), "utf8").split(/\r?\n/u)) {
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
  const loopback = host === "127.0.0.1" || host === "::1";
  if (loopback) {
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
    schemaVersion: "dolly.model-descriptor/3" as const,
    descriptorVersion: "owner-aether-qwen3.6-27b-v1",
    endpointId: "owner-aether-live-fixture",
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
      text: {
        state: "supported" as const,
        value: { maxBytesPerItem: 32 * 1024, empty: "forbidden" as const },
      },
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
      reasoning: {
        support: "request-controlled" as const,
        requestControl: {
          kind: "enum-strategy" as const,
          strategyId: "thinking-object.enabled-disabled.v1",
        },
        observation: {
          state: "supported" as const,
          value: {
            nonStreamStrategyId: "openai.reasoning-content.nonstream.v1",
            empty: "not-observed" as const,
          },
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
    schemaVersion: "general-agent-live/model-call/1",
    startedAt,
    completedAt,
    requestId: invocation.requestId,
    context: invocation.context as unknown as JsonValue,
    reasoningPolicy: invocation.reasoningPolicy,
    budgets: invocation.budgets as unknown as JsonValue,
    input: invocation.input as unknown as JsonValue,
    result:
      result.status === "succeeded"
        ? {
            status: result.status,
            output: result.output as unknown as JsonValue,
            usage: result.usage as unknown as JsonValue,
          }
        : {
            status: result.status,
            error: result.error as unknown as JsonValue,
            usage: result.usage as unknown as JsonValue,
          },
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseAgentResult(blockValue: JsonValue): Record<string, unknown> {
  const items = (blockValue as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length !== 1) throw new Error("Agent output item count invalid");
  const text = (items[0] as { text?: unknown }).text;
  if (typeof text !== "string") throw new Error("Agent output text missing");
  const result = JSON.parse(text);
  if (result === null || Array.isArray(result) || typeof result !== "object") {
    throw new Error("Agent output is not an object");
  }
  return result;
}

async function runCondition(options: {
  conditionId: "no-storage-tool" | "private-storage-tool";
  runDirectory: string;
  broker: ChatModelBrokerPort;
}): Promise<JsonValue> {
  const conditionRoot = mkdtempSync(
    join(resolve(workspaceRoot, ".tmp"), `general-agent-${options.conditionId}-`),
  );
  const instanceId = `instance-agent-${options.conditionId}`;
  const moduleId = "general-agent";
  const moduleGenerationId = `module-generation-${options.conditionId}-1`;
  const extensionHosts: ExtensionProcessHost[] = [];
  let host: ReactiveModuleHost | undefined;
  let childPid: number | undefined;
  let processGenerationId: string | undefined;
  let executorStartFailure: string | undefined;
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
    const commits = createModuleResultCommitCoordinator({
      core,
      repository,
      now: () => NOW,
      mailboxes: [{
        consumerId: "sink",
        pageIds: ["output"],
        maxResidentCount: 4,
        maxResidentBytes: 1024 * 1024,
      }],
    });
    const storage = new ModulePrivateStorageBackend({
      root: join(conditionRoot, "module-private-storage"),
      now: () => NOW,
    });
    const namespace = storage.namespaceFor(instanceId, moduleId);
    storage.replace(
      { namespace, instanceId, moduleId },
      [
        {
          key: "archived-note",
          value: { status: "archived", codename: "ASH-0000" },
          updatedAt: NOW,
        },
        {
          key: "deployment-note",
          value: { status: "active", codename: HIDDEN_CODENAME },
          updatedAt: NOW,
        },
      ],
    );
    const runtimeDeliveries: ReactiveModuleRuntimeOptions["deliveries"] = {
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
      executionTimeoutMs: 400_000,
      cancellationGraceMs: 5_000,
      initializationTimeoutMs: 5_000,
      terminationTimeoutMs: 5_000,
      maxRunsPerGeneration: 2,
      maxGenerations: 1,
      declaredExternalEffects: "core-capabilities-only",
      deliveries: runtimeDeliveries,
      persistModuleSubmission: (request) => {
        if (!processGenerationId) throw new Error("process generation is not ready");
        core.appendModuleSubmissionRecord({
          schemaVersion: "dolly.module-submission-record/1",
          ...request,
          processGenerationId,
          createdAt: NOW,
        });
      },
      releaseDeliveryClaim: (identity) => core.releaseDeliveryClaim(identity),
      negativelyAcknowledgeDeliveryClaim: (request) =>
        core.negativelyAcknowledgeDeliveryClaim(request),
      getModuleSubmissionRecord: (runId) => core.getModuleSubmissionRecord(runId),
      commits,
      nextModuleGenerationId: () => `${moduleGenerationId}-unused`,
      monotonicNow: () => ++monotonic,
      createExecutor: (generationId) => {
        try {
        const extensionHost = new ExtensionProcessHost({
          isolation: "process",
          trust: "trusted",
          isolationPolicy: new ExtensionIsolationPolicy(),
          manifest: {
            schemaVersion: "dolly.extension-package/1",
            extensionId: "org.dolly.general-agent-live-fixture",
            packageVersion: "1.0.0",
            displayName: "General Agent live fixture",
            description: "Capability-mediated Scheduler effect experiment.",
            supportedProtocolVersions: ["3.0"],
            entrypoint: "extension.mjs",
            modules: [{
              moduleKind: "general-agent",
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
          moduleKind: "general-agent",
          config: {},
          maxFrameBytes: 1024 * 1024,
          maxConcurrentCapabilityRequests: 1,
          initializationTimeoutMs: 5_000,
          shutdownRequestTimeoutMs: 2_000,
          forceKillDelayMs: 500,
          terminationTimeoutMs: 5_000,
          nextIdentifier: (purpose) => `${purpose}-${options.conditionId}-${++identifierSequence}`,
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
          serviceInvocationId:
            options.conditionId === "no-storage-tool" ? "1".repeat(32) : "2".repeat(32),
          bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
          // Candidate composition only: this records the intended path but the
          // experiment does not claim delegated-cgroup attachment or stop proof.
          moduleCgroupPath: deriveModuleCgroupPath(
            "/system.slice/dolly-core.service",
            { instanceId, moduleId, processGenerationId },
          ).filesystemPath,
          state: "starting",
          createdAt: NOW,
          updatedAt: NOW,
        });
        const modelDefinition = createModelOperationCapability({
          descriptor: descriptorRef,
          ownerScope: "owner-live-fixture",
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
          roles: ["system", "user"],
          limits: {
            maxInvocations: options.conditionId === "private-storage-tool" ? 3 : 1,
            maxInvocationsPerRun: options.conditionId === "private-storage-tool" ? 3 : 1,
            maxInvocationsPerWindow: options.conditionId === "private-storage-tool" ? 3 : 1,
            rateWindowMs: 60_000,
          },
          maxConcurrentInvocations: 1,
          requireIdempotencyKey: true,
          nextRequestId: () =>
            `agent-${options.conditionId}-model-request-${++modelRequestSequence}`,
        });
        extensionHost.grantCapability(modelDefinition.grant, modelDefinition.handler);
        if (options.conditionId === "private-storage-tool") {
          const storageDefinition = createModulePrivateStorageCapability({
            backend: storage,
            instanceId,
            moduleId,
            operations: ["list", "get"],
            expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            limits: { maxInvocations: 2, maxListResults: 8 },
            maxConcurrentInvocations: 1,
            requireIdempotencyKey: true,
          });
          extensionHost.grantCapability(storageDefinition.grant, storageDefinition.handler);
        }
        extensionHosts.push(extensionHost);
        const executor = createExtensionProcessModuleExecutor(extensionHost, {
          moduleId,
          moduleGenerationId: generationId,
          executionTimeoutMs: 400_000,
          cancellationGraceMs: 5_000,
        });
        return {
          isolation: executor.isolation,
          start: async () => {
            try {
              await executor.start?.();
            } catch (error) {
              executorStartFailure =
                error instanceof Error
                  ? `${error.name}: ${error.message}`
                  : "non-Error executor startup failure";
              throw error;
            }
          },
          execute: executor.execute,
          cancel: executor.cancel,
          terminate: executor.terminate,
        };
        } catch (error) {
          executorStartFailure =
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : "non-Error executor construction failure";
          throw error;
        }
      },
      classifyFailure: (failure: ReactiveModuleFailure) => ({
        code: failure.code,
        retryable: false,
      }),
    });
    const managedRuntime: ManagedReactiveModuleRuntime = {
      get moduleGenerationId() {
        return runtime.moduleGenerationId;
      },
      tick: () => runtime.tick(),
      start: async () => {
        try {
          await runtime.start();
        } catch (error) {
          const actorFailure = error instanceof Error ? error.message : "unknown actor failure";
          throw new Error(
            executorStartFailure === undefined
              ? actorFailure
              : `${actorFailure}; executor cause: ${executorStartFailure}`,
          );
        }
        if (!processGenerationId) throw new Error("process generation was not recorded");
        core.updateModuleProcessRecordState(processGenerationId, "running");
      },
      stop: async () => {
        if (
          processGenerationId &&
          core.getModuleProcessRecord(processGenerationId)?.state === "running"
        ) {
          core.updateModuleProcessRecordState(processGenerationId, "stopping");
        }
        await runtime.stop();
      },
    };
    const scheduler = new ModuleScheduler({
      instanceId,
      deliveries: core.deliveries,
      clock: systemSchedulerClock(),
      pollIntervalMs: 100,
      retryBaseMs: 100,
      retryMaxMs: 1_000,
      maxConcurrentModules: 1,
      backpressureAction: "pause-upstream",
      downstreamRecheckMs: 100,
      noProgressAfterMs: 410_000,
      claimLimitCount: 1,
      claimLimitBytes: 64 * 1024,
      retryJitterRatio: 0,
    });
    host = new ReactiveModuleHost(scheduler, [{
      moduleId,
      runtime: managedRuntime,
      inputPageIds: ["input"],
      outputPageIds: ["output"],
      mailbox: { maxPendingCount: 4, maxPendingBytes: 1024 * 1024 },
    }]);

    await host.start();
    childPid = extensionHosts[0]?.snapshot.pid;
    if (childPid === undefined) throw new Error("Extension child PID was not observed");
    const taskBlock = core.blocks.commit(
      {
        payload: {
          schema: "dolly.content/1",
          value: {
            items: [{
              type: "text",
              text: "Find the active deployment codename in private memory. Use available tools and do not guess.",
              format: "plain",
            }],
          },
        },
      },
      { kind: "external", id: "experiment" },
    );
    core.deliveries.append("input", taskBlock.id);
    const committed = await waitForAgentCase({
      findCommitted: () => repository.list().find((record) => record.state === "committed"),
      listDeadLetters: () => core.deliveries.listDeadLetters(),
      readSchedulerStatus: () => scheduler.status(moduleId),
      timeoutMs: 420_000,
    });
    if (!committed.blockId) throw new Error("Agent result committed no Block");
    const block = core.blocks.get(committed.blockId);
    if (!block) throw new Error("Committed Agent Block is missing");
    const result = parseAgentResult(block.payload.value);
    const schedulerCompletion =
      core.deliveries.inspectPending(moduleId, ["input"]).pendingCount === 0 &&
      core.deliveries.inspectPending("sink", ["output"]).pendingCount === 1 &&
      core.listModuleSubmissionRecords().length === 0;

    await host.stop();
    const childStopped = !processIsAlive(childPid);
    return {
      schemaVersion: "general-agent-live/case/1",
      conditionId: options.conditionId,
      result: result as unknown as JsonValue,
      schedulerCompletion,
      childPidRecorded: true,
      childStopped,
      linuxControlGroupProof: false,
      commit: {
        moduleJobId: committed.moduleJobId,
        runId: committed.runId,
        blockId: committed.blockId,
        outputDeliveries: committed.outputDeliveries,
      },
    };
  } finally {
    if (host?.state === "running") await host.stop().catch(() => undefined);
    for (const extensionHost of extensionHosts) {
      if (extensionHost.snapshot.state !== "stopped") {
        await extensionHost.terminate().catch(() => undefined);
      }
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
  const { runId } = parseArguments(process.argv.slice(2));
  mkdirSync(resolve(workspaceRoot, ".tmp"), { recursive: true, mode: 0o700 });
  const preregistrationBytes = readFileSync(preregistrationPath);
  const fixture = loadAetherEnvironment();
  const exactUrl = completionUrl(fixture.baseUrl);
  const host = exactUrl.hostname.replace(/^\[|\]$/gu, "");
  const networkScope = host === "127.0.0.1" || host === "::1" ? "loopback" : "public";
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
    bindingRevision: "owner-aether-live-fixture-binding-v1",
    descriptorRefs: [descriptorRef],
    exactUrl: exactUrl.href,
    networkScope,
    authentication: {
      kind: "bearer-secret",
      secretRef: "owner-aether-api-key",
      secretRevision: "runtime-env-v1",
    },
    limits: {
      maxRequestBytes: 128 * 1024,
      maxResponseBytes: 512 * 1024,
      maxTimeoutMs: 180_000,
    },
  });
  bindings.setStatus(bindingRef, "active");

  // No run artifact is created until all local capability and provider
  // configuration preflight has succeeded.
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  const runDirectory = join(artifactRoot, "runs", runId);
  mkdirSync(join(artifactRoot, "runs"), { recursive: true, mode: 0o700 });
  mkdirSync(runDirectory, { mode: 0o700 });
  writeFileSync(join(runDirectory, "preregistration.json"), preregistrationBytes, { flag: "wx" });
  const modelCallsPath = join(runDirectory, "model-calls.jsonl");
  const providerResponsesPath = join(runDirectory, "provider-responses.jsonl");
  const casesPath = join(runDirectory, "cases.jsonl");
  writeFileSync(modelCallsPath, "", { flag: "wx" });
  writeFileSync(providerResponsesPath, "", { flag: "wx" });
  writeFileSync(casesPath, "", { flag: "wx" });

  let secretReleases = 0;
  const secrets: ModelSecretResolver = {
    resolve: async (secretRef, secretRevision) => {
      if (secretRef !== "owner-aether-api-key" || secretRevision !== "runtime-env-v1") {
        throw new Error("unexpected model secret reference");
      }
      return {
        value: fixture.apiKey,
        release: () => {
          secretReleases += 1;
        },
      };
    },
  };
  const broker = new ChatModelBroker({
    descriptors,
    bindings,
    secrets,
    transport: new ExperimentFetchTransport((record) => {
      appendFileSync(providerResponsesPath, `${JSON.stringify(record)}\n`, "utf8");
    }),
    now: () => new Date().toISOString(),
  });
  let providerCalls = 0;
  const observedBroker: ChatModelBrokerPort = {
    invoke: async (invocation, options) => {
      providerCalls += 1;
      if (providerCalls > 4) throw new Error("registered provider-call budget exceeded");
      const startedAt = new Date().toISOString();
      const result = await broker.invoke(invocation, options);
      const completedAt = new Date().toISOString();
      appendFileSync(
        modelCallsPath,
        `${JSON.stringify(safeModelCall(invocation, result, startedAt, completedAt))}\n`,
        "utf8",
      );
      return result;
    },
  };

  const startedAt = new Date().toISOString();
  let status: "completed" | "failed" = "completed";
  let failure: string | undefined;
  try {
    for (const conditionId of ["no-storage-tool", "private-storage-tool"] as const) {
      const caseRow = await runCondition({ conditionId, runDirectory, broker: observedBroker });
      appendFileSync(casesPath, `${JSON.stringify(caseRow)}\n`, "utf8");
    }
  } catch (error) {
    status = "failed";
    failure = error instanceof Error ? error.message : "unknown failure";
  }
  const completedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: "general-agent-live/run-manifest/1",
    experimentId: "general-agent-live-v0",
    experimentVersion: 8,
    runId,
    status,
    ...(failure === undefined ? {} : { failure }),
    startedAt,
    completedAt,
    preregistrationSha256: sha256(preregistrationBytes),
    providerCalls,
    secretLeasesReleased: secretReleases,
    model: "qwen3.6-27b",
    reasoningControl: "thinking.type",
    modelTransport: "experiment-bounded-fetch-no-redirect-v1",
    productBootstrapModulesRemainRejected: true,
    linuxControlGroupProof: false,
    proxyEnvironmentPresent: Boolean(process.env.http_proxy || process.env.https_proxy),
    artifacts: {
      "provider-responses.jsonl": sha256(readFileSync(providerResponsesPath)),
      "model-calls.jsonl": sha256(readFileSync(modelCallsPath)),
      "cases.jsonl": sha256(readFileSync(casesPath)),
    },
  };
  writeFileSync(
    join(runDirectory, "run-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  if (status !== "completed") throw new Error(failure ?? "live run failed");
}

await main();
