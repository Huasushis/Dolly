#!/usr/bin/env -S pnpm exec tsx

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createExtensionEffectJournalLifecycle } from "../../../../src/adapters/extension-effect-run-lifecycle.js";
import { createExtensionProcessModuleExecutor } from "../../../../src/adapters/extension-process-module-executor.js";
import { SharpMediaInspector } from "../../../../src/adapters/sharp-media-inspector.js";
import { EffectIntentJournal } from "../../../../src/core/capabilities/effect-intent-journal.js";
import { FileEffectIntentStore } from "../../../../src/core/capabilities/file-effect-intent-store.js";
import type { JsonValue } from "../../../../src/core/canonical-json.js";
import { ExtensionIsolationPolicy, ExtensionProcessHost } from "../../../../src/core/extension-process-host.js";
import { FileCoreStateStore, createFileCoreStateStoreWithStoppedRecordWriter } from "../../../../src/core/file-core-state-store.js";
import { FileMediaByteStore } from "../../../../src/core/file-media-byte-store.js";
import { FileModuleResultCommitRepository } from "../../../../src/core/file-module-result-commit-repository.js";
import { deriveModuleCgroupPath } from "../../../../src/core/linux-module-cgroup.js";
import { createDeliveredModelMediaResolver } from "../../../../src/core/media-capability/index.js";
import { EndpointBindingRegistry } from "../../../../src/core/model-provider-binding.js";
import {
  ChatModelBroker,
  type ChatBrokerInvocation,
  type ChatBrokerResult,
  type ModelHttpTransport,
  type ModelHttpTransportRequest,
  type ModelHttpTransportResponse,
  type ModelMediaResolver,
} from "../../../../src/core/model-provider-broker.js";
import { ModelDescriptorRegistry, type ChatDescriptorDocument } from "../../../../src/core/model-provider-descriptor.js";
import { NodeModelHttpTransport } from "../../../../src/core/model-provider-node-http.js";
import { ModuleScheduler, systemSchedulerClock } from "../../../../src/core/module-scheduler.js";
import { createModuleResultCommitCoordinator } from "../../../../src/core/module-result-commit-factory.js";
import { createModelOperationCapabilityV3 } from "../../../../src/core/provider-capabilities/model-operation-capability.js";
import { ReactiveModuleHost, type ManagedReactiveModuleRuntime } from "../../../../src/core/reactive-module-host.js";
import {
  ReactiveModuleRuntime,
  type ReactiveModuleFailure,
  type ReactiveModuleRuntimeOptions,
} from "../../../../src/core/reactive-module-runtime.js";
import { generateFixtures } from "../multimodal-input-v0/common.mjs";
import {
  AETHER_MODEL_ID,
  IMAGE_TASK_PROMPT,
  evaluateImageAnswer,
} from "../multimodal-input-v0/aether-client.mjs";
import { waitForAgentCase } from "../general-agent-live-v0/wait-for-case.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "../../../..");
const WORKSPACE_ROOT = resolve(REPOSITORY_ROOT, "..");
const EXTENSION_PATH = join(SCRIPT_DIRECTORY, "extension.mjs");
const PREREGISTRATION_PATH = join(
  REPOSITORY_ROOT,
  "docs/experiments/preregistrations/scheduler-inline-media-agent-live-v0.json",
);
const ARTIFACT_ROOT = join(
  REPOSITORY_ROOT,
  "artifacts/experiments/probes/scheduler-inline-media-agent-live-v0",
);
const STRATEGIES = new Set([
  "openai.chat.request.content-parts.v1",
  "openai.chat.response.v1",
  "openai.chat.stream.sse.v1",
  "openai.chat.message-order.v1",
  "openai.reasoning-content.nonstream.v1",
  "openai.reasoning-content.stream.v1",
  "thinking-object.enabled-disabled.v1",
  "openai.response-format.json-object.v1",
  "media.inline-copy.v1",
  "openai.chat.media.inline-image-url.v1",
]);

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

function readPrivateEnvironment(name: "AETHER_BASE_URL" | "AETHER_API_KEY"): string {
  const direct = process.env[name];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const line = readFileSync(join(REPOSITORY_ROOT, ".env"), "utf8")
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} is not configured`);
  const raw = line.slice(name.length + 1).trim();
  const value =
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1)
      : raw;
  if (value.length === 0 || /[\r\n]/u.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function exactChatUrl(configured: string): URL {
  const url = new URL(configured);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("AETHER_BASE_URL contains forbidden URL components");
  }
  if (url.protocol !== "https:") throw new Error("The live endpoint must use HTTPS");
  const basePath = url.pathname.replace(/\/+$/u, "").replace(/\/chat\/completions$/u, "");
  url.pathname = `${basePath.endsWith("/v1") ? basePath : `${basePath}/v1`}/chat/completions`
    .replace(/\/+/gu, "/");
  return url;
}

function descriptor(): ChatDescriptorDocument {
  return {
    schemaVersion: "dolly.model-descriptor/4",
    descriptorVersion: "aether-scheduler-inline-png-strict-sse-v0",
    endpointId: "owner-aether-private-endpoint",
    operation: "chat-completion",
    modelId: AETHER_MODEL_ID,
    adapter: {
      id: "openai-compatible-chat",
      version: "v1",
      requestStrategyId: "openai.chat.request.content-parts.v1",
      responseStrategyId: "openai.chat.response.v1",
      streamStrategyId: "openai.chat.stream.sse.v1",
    },
    limits: {
      maxRequestBytes: 2_000_000,
      maxResponseBytes: 2_000_000,
      maxInputItems: 16,
      maxInputBytes: 1_500_000,
      maxOutputBytes: 512_000,
      maxConcurrentRequests: 1,
      maxProviderTimeoutMs: 1_800_000,
      streaming: {
        state: "supported",
        value: { maxEvents: 20_000, maxBufferedBytes: 256_000 },
      },
    },
    input: {
      modalities: ["text", "image"],
      text: { state: "supported", value: { maxBytesPerItem: 32_000, empty: "forbidden" } },
      media: [{
        requirementId: "aether-inline-png-v0",
        modality: "image",
        mimeTypes: ["image/png"],
        deliveryModes: ["inline"],
        maxItems: 1,
        maxBytesPerItem: 1_000_000,
        maxAggregateBytes: 1_000_000,
        providerFetchesAfterAcceptance: false,
        lifetimeStrategyId: "media.inline-copy.v1",
        placementStrategyId: "openai.chat.media.inline-image-url.v1",
      }],
    },
    retry: {
      maxProviderAttempts: 1,
      safeConditions: ["before-dispatch"],
      providerIdempotency: { state: "unsupported" },
    },
    features: {
      roles: ["system", "user", "assistant", "tool"],
      messageOrderStrategyId: "openai.chat.message-order.v1",
      maxMessages: 16,
      maxPartsPerMessage: 8,
      contextWindowTokens: { state: "unknown" },
      maxOutputTokens: { state: "supported", value: { maximum: 4096 } },
      mediaRequirementIds: ["aether-inline-png-v0"],
      tools: { state: "unsupported" },
      structuredOutput: { state: "unsupported" },
      jsonObjectOutput: {
        state: "supported",
        value: { strategyId: "openai.response-format.json-object.v1" },
      },
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

class ObservedStreamingTransport implements ModelHttpTransport {
  readonly observation: Record<string, unknown> = {
    dispatches: 0,
    stream: false,
    includeUsage: false,
    thinkingType: null,
    enableThinkingPresent: null,
    outputContract: null,
    mediaPlacement: null,
    responseChunks: 0,
    responseBytes: 0,
  };

  constructor(private readonly inner: ModelHttpTransport) {}

  async dispatch(request: ModelHttpTransportRequest): Promise<ModelHttpTransportResponse> {
    const bodyBytes = Buffer.from(request.body);
    const body = JSON.parse(bodyBytes.toString("utf8")) as Record<string, any>;
    const mediaUrl = body.messages?.[0]?.content?.[1]?.image_url?.url;
    if (
      body.stream !== true ||
      body.stream_options?.include_usage !== true ||
      body.thinking?.type !== "disabled" ||
      Object.hasOwn(body, "enable_thinking") ||
      body.response_format?.type !== "json_object" ||
      typeof mediaUrl !== "string" ||
      !mediaUrl.startsWith("data:image/png;base64,")
    ) {
      throw new Error("Product broker emitted a non-conforming Agent request");
    }
    this.observation.dispatches = (this.observation.dispatches as number) + 1;
    this.observation.requestBytes = bodyBytes.byteLength;
    this.observation.requestSha256 = sha256(bodyBytes);
    this.observation.stream = true;
    this.observation.includeUsage = true;
    this.observation.thinkingType = "disabled";
    this.observation.enableThinkingPresent = false;
    this.observation.outputContract = "json_object";
    this.observation.mediaPlacement = "inline-png-data-url";
    this.observation.mediaDataUrlSha256 = sha256(mediaUrl);
    this.observation.timeoutMs = request.timeoutMs;
    const started = Date.now();
    const response = await this.inner.dispatch(request);
    this.observation.responseStatus = response.status;
    this.observation.responseContentType = response.headers["content-type"] ?? null;
    const observation = this.observation;
    const originalBody = response.body;
    return {
      ...response,
      body: (async function* () {
        for await (const chunk of originalBody) {
          observation.responseChunks = (observation.responseChunks as number) + 1;
          observation.responseBytes = (observation.responseBytes as number) + chunk.byteLength;
          observation.lastChunkAfterMs = Date.now() - started;
          yield chunk;
        }
      })(),
    };
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseAgentOutput(value: JsonValue): Record<string, any> {
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length !== 1) throw new Error("Agent output item count invalid");
  const text = (items[0] as { text?: unknown }).text;
  if (typeof text !== "string") throw new Error("Agent output text is absent");
  const parsed = JSON.parse(text);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Agent output is not one JSON object");
  }
  return parsed;
}

const runIdIndex = process.argv.indexOf("--run-id");
const runId = runIdIndex >= 0 ? process.argv[runIdIndex + 1] : undefined;
if (
  process.env.RUN_LIVE_INTEGRATION !== "1" ||
  process.env.RUN_PAID_INTEGRATION !== "1" ||
  process.argv.length !== 4 ||
  runIdIndex !== 2 ||
  !/^live-v2-[a-z0-9][a-z0-9-]{0,63}$/u.test(runId ?? "")
) {
  throw new Error("usage requires live/paid opt-in and --run-id live-v2-<unique-suffix>");
}

const artifactDirectory = join(ARTIFACT_ROOT, runId!);
if (existsSync(artifactDirectory)) throw new Error("refusing to overwrite an existing run");
mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
const preregistrationBytes = readFileSync(PREREGISTRATION_PATH);
const preregistration = JSON.parse(preregistrationBytes.toString("utf8"));
const implementationSha256 = (preregistration.implementationFiles as string[]).map((path) => ({
  path,
  sha256: sha256(readFileSync(join(REPOSITORY_ROOT, path))),
}));
for (const frozen of preregistration.implementationSha256 as Array<{ path: string; sha256: string }>) {
  if (implementationSha256.find((entry) => entry.path === frozen.path)?.sha256 !== frozen.sha256) {
    throw new Error(`implementation hash mismatch: ${frozen.path}`);
  }
}
writeFileSync(join(artifactDirectory, "preregistration.json"), preregistrationBytes, {
  flag: "wx",
  mode: 0o600,
});

const conditionRoot = mkdtempSync(join(resolve(WORKSPACE_ROOT, ".tmp"), "scheduler-media-agent-"));
const statePath = join(conditionRoot, "core-state.json");
const resultCommitPath = join(conditionRoot, "module-result-commits.json");
const effectIntentPath = join(conditionRoot, "effect-intents.json");
const instanceId = "instance-scheduler-media-agent-live";
const moduleId = "general-agent";
const moduleGenerationId = "general-agent-generation-1";
let processGenerationId: string | undefined;
let extensionHost: ExtensionProcessHost | undefined;
let host: ReactiveModuleHost | undefined;
let childPid: number | undefined;
let executorStartFailure: string | undefined;
let apiKey = "";
let secretReleases = 0;
let stopped = false;
let completed = false;
let transportObservation: Record<string, unknown> | undefined;

try {
  const now = () => new Date().toISOString();
  let blockSequence = 0;
  let deliverySequence = 0;
  let identifierSequence = 0;
  let modelRequestSequence = 0;
  let monotonic = 0;
  const image = (await generateFixtures()).agentTaskPng;
  const coreState = createFileCoreStateStoreWithStoppedRecordWriter({
    path: statePath,
    maxFailedAttempts: 1,
    nextBlockId: () => `scheduler-media-block-${++blockSequence}`,
    nextDeliveryId: (kind) => `scheduler-media-${kind}-${++deliverySequence}`,
    now,
    media: {
      durability: "persistent",
      bytes: new FileMediaByteStore({
        directory: join(conditionRoot, "media", "objects"),
        maxMediaBytes: 1_000_000,
      }),
      inspector: new SharpMediaInspector({ maxInputPixels: 1_000_000 }),
      maxMediaBytes: 1_000_000,
      maxTotalMediaBytes: 2_000_000,
      idNamespace: `scheduler-media-${runId}`,
    },
  });
  const core = coreState.store;
  if (!core.media) throw new Error("FileCore Media was not enabled");
  core.deliveries.createPage("input");
  core.deliveries.createPage("output");
  core.deliveries.registerConsumer("input", moduleId, "from-now");
  core.deliveries.registerConsumer("output", "sink", "from-now");
  const registered = await core.media.registerMedia({
    registrationId: "scheduler-media-registration-1",
    bytes: image,
    declaredMimeType: "image/png",
    provenance: { sourceClass: "streamed-upload" },
  });
  const repository = new FileModuleResultCommitRepository({ path: resultCommitPath });
  const effectJournal = new EffectIntentJournal({
    store: new FileEffectIntentStore({ path: effectIntentPath }),
    now,
  });
  const effectRunLifecycle = createExtensionEffectJournalLifecycle({
    journal: effectJournal,
    getModuleSubmissionRecord: (runId) => core.getModuleSubmissionRecord(runId),
  });
  const commits = createModuleResultCommitCoordinator({
    core,
    repository,
    now,
    mailboxes: [{
      consumerId: "sink",
      pageIds: ["output"],
      maxResidentCount: 2,
      maxResidentBytes: 512 * 1024,
    }],
  });

  const descriptors = new ModelDescriptorRegistry({
    schemaDigest: `sha256:${"6".repeat(64)}`,
    allowedStrategyIds: STRATEGIES,
  });
  const descriptorRef = descriptors.register(descriptor());
  descriptors.setStatus(descriptorRef, "active");
  const bindings = new EndpointBindingRegistry();
  const bindingRef = bindings.register({
    schemaVersion: "dolly.endpoint-binding/2",
    endpointId: descriptorRef.endpointId,
    bindingRevision: "owner-aether-scheduler-media-live-v0",
    descriptorRefs: [descriptorRef],
    exactUrl: exactChatUrl(readPrivateEnvironment("AETHER_BASE_URL")).href,
    networkScope: "public",
    authentication: {
      kind: "bearer-secret",
      secretRef: "owner-aether-key",
      secretRevision: "live-process-memory-only",
    },
    limits: {
      maxRequestBytes: 2_000_000,
      maxResponseBytes: 2_000_000,
      maxTimeoutMs: 1_800_000,
    },
  });
  bindings.setStatus(bindingRef, "active");
  apiKey = readPrivateEnvironment("AETHER_API_KEY");
  const transport = new ObservedStreamingTransport(new NodeModelHttpTransport());
  transportObservation = transport.observation;
  const mediaResolver: ModelMediaResolver = {
    resolve: async (request, options) => {
      const snapshot = extensionHost?.snapshot;
      if (!snapshot) throw new Error("Extension session is unavailable");
      const active = core.deliveries.listActiveClaims().find(
        (candidate) =>
          candidate.consumerId === moduleId &&
          candidate.moduleJobId === request.context.moduleJobId &&
          candidate.runId === request.context.runId &&
          candidate.attempt === request.context.attempt &&
          candidate.moduleGenerationId === request.context.moduleGenerationId,
      );
      if (!active) throw new Error("The model request has no exact active Delivery Claim");
      const input = core.deliveries.inspectClaimInput(active);
      const resolver = createDeliveredModelMediaResolver({
        claim: {
          moduleJobId: active.moduleJobId,
          runId: active.runId,
          blockGroups: input.blockGroups,
        },
        session: {
          extensionId: snapshot.extensionId,
          instanceId: snapshot.instanceId,
          processGenerationId: snapshot.processGenerationId,
          sessionId: snapshot.sessionId,
          moduleId: snapshot.moduleId,
          moduleGenerationId: snapshot.moduleGenerationId,
        },
        source: core.media!,
        isActiveRun: (context) => core.deliveries.listActiveClaims().some(
          (candidate) =>
            candidate.consumerId === moduleId &&
            candidate.moduleJobId === context.moduleJobId &&
            candidate.runId === context.runId &&
            candidate.attempt === context.attempt &&
            candidate.moduleGenerationId === context.moduleGenerationId,
        ),
        now,
      });
      return resolver.resolve(request, options);
    },
  };
  const broker = new ChatModelBroker({
    descriptors,
    bindings,
    secrets: {
      resolve: async () => ({
        value: apiKey,
        release: () => {
          secretReleases += 1;
        },
      }),
    },
    transport,
    media: mediaResolver,
  });

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
    executionTimeoutMs: 1_800_000,
    cancellationGraceMs: 5_000,
    initializationTimeoutMs: 10_000,
    terminationTimeoutMs: 10_000,
    maxRunsPerGeneration: 1,
    maxGenerations: 1,
    declaredExternalEffects: "unrestricted",
    deliveries: runtimeDeliveries,
    persistModuleSubmission: (request) => {
      if (!processGenerationId) throw new Error("process generation is unavailable");
      core.appendModuleSubmissionRecord({
        schemaVersion: "dolly.module-submission-record/1",
        ...request,
        processGenerationId,
        createdAt: now(),
      });
    },
    releaseDeliveryClaim: (identity) => core.releaseDeliveryClaim(identity),
    negativelyAcknowledgeDeliveryClaim: (request) => core.negativelyAcknowledgeDeliveryClaim(request),
    getModuleSubmissionRecord: (runId) => core.getModuleSubmissionRecord(runId),
    commits,
    nextModuleGenerationId: () => `${moduleGenerationId}-unused`,
    monotonicNow: () => ++monotonic,
    createExecutor: (generationId) => {
      try {
        extensionHost = new ExtensionProcessHost({
          isolation: "process",
          trust: "trusted",
          isolationPolicy: new ExtensionIsolationPolicy(),
          manifest: {
            schemaVersion: "dolly.extension-package/1",
            extensionId: "org.dolly.scheduler-inline-media-agent-live",
            packageVersion: "1.0.0",
            displayName: "Scheduler inline Media Agent live fixture",
            description: "Uses only a Host-selected model-operation/v3 capability.",
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
          args: [EXTENSION_PATH],
          workingDirectory: conditionRoot,
          instanceId,
          moduleId,
          moduleGenerationId: generationId,
          moduleKind: "general-agent",
          config: {},
          maxFrameBytes: 1024 * 1024,
          maxConcurrentCapabilityRequests: 1,
          initializationTimeoutMs: 10_000,
          shutdownRequestTimeoutMs: 2_000,
          forceKillDelayMs: 500,
          terminationTimeoutMs: 10_000,
          nextIdentifier: (purpose) => `${purpose}-scheduler-media-${++identifierSequence}`,
          effectRunLifecycle,
        });
        const snapshot = extensionHost.snapshot;
        processGenerationId = snapshot.processGenerationId;
        core.appendModuleProcessRecord({
          schemaVersion: "dolly.module-process-record/1",
          instanceId,
          moduleId,
          moduleGenerationId: generationId,
          processGenerationId,
          packageDigest: `sha256:${"a".repeat(64)}`,
          configurationReference: {
            configId: "scheduler-media-live-config",
            revision: `sha256:${"b".repeat(64)}`,
            configVersion: 1,
          },
          declaredExternalEffects: "unrestricted",
          serviceInvocationId: "4".repeat(32),
          bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
          moduleCgroupPath: deriveModuleCgroupPath(
            "/sys/fs/cgroup/system.slice/dolly-core.service",
            { instanceId, moduleId, processGenerationId },
          ).filesystemPath,
          state: "starting",
          createdAt: now(),
          updatedAt: now(),
        });
        const capability = createModelOperationCapabilityV3({
          descriptor: descriptorRef,
          ownerScope: "owner-live-fixture",
          budgets: {
            maxProviderAttempts: 1,
            maxWallTimeMs: 1_800_000,
            maxRequestBytes: 2_000_000,
            maxResponseBytes: 2_000_000,
            maxInputItems: 16,
            maxInputBytes: 1_500_000,
            maxOutputBytes: 512_000,
            maxOutputTokens: 1_200,
            maxMediaItems: 1,
            maxResolvedMediaBytes: image.byteLength,
          },
          executionScope: "active-run",
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
          now,
          chat: { invoke: (invocation, options) => broker.invoke(invocation, options) },
          operations: ["chat", "describe"],
          reasoningPolicies: ["disable"],
          allowStreaming: true,
          requireStreaming: true,
          roles: ["user"],
          limits: {
            maxInvocations: 1,
            maxInvocationsPerRun: 1,
            maxInvocationsPerWindow: 1,
            rateWindowMs: 60_000,
          },
          maxConcurrentInvocations: 1,
          requireIdempotencyKey: true,
          nextRequestId: () => `scheduler-media-model-request-${++modelRequestSequence}`,
          outputContracts: ["json-object"],
          mediaRequirementIds: ["aether-inline-png-v0"],
        });
        extensionHost.grantCapability(capability.grant, capability.handler);
        const executor = createExtensionProcessModuleExecutor(extensionHost, {
          moduleId,
          moduleGenerationId: generationId,
          executionTimeoutMs: 1_800_000,
          cancellationGraceMs: 5_000,
        });
        return executor;
      } catch (error) {
        executorStartFailure = error instanceof Error
          ? `${error.name}: ${error.message}`
          : "non-Error executor construction failure";
        throw error;
      }
    },
    classifyFailure: (failure: ReactiveModuleFailure) => ({ code: failure.code, retryable: false }),
  });
  const managedRuntime: ManagedReactiveModuleRuntime = {
    get moduleGenerationId() {
      return runtime.moduleGenerationId;
    },
    tick: (limits) => runtime.tick(limits),
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
      childPid = extensionHost?.snapshot.pid;
      if (childPid === undefined) throw new Error("Extension child PID was not observed");
    },
    stop: async () => {
      if (processGenerationId && core.getModuleProcessRecord(processGenerationId)?.state === "running") {
        core.updateModuleProcessRecordState(processGenerationId, "stopping");
      }
      await runtime.stop();
      if (processGenerationId) coreState.stoppedRecordWriter.writeStopped(processGenerationId);
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
    noProgressAfterMs: 1_810_000,
    claimLimitCount: 1,
    claimLimitBytes: 64 * 1024,
    retryJitterRatio: 0,
  });
  host = new ReactiveModuleHost(scheduler, [{
    moduleId,
    runtime: managedRuntime,
    inputPageIds: ["input"],
    outputPageIds: ["output"],
    mailbox: { maxResidentCount: 2, maxResidentBytes: 512 * 1024 },
  }]);

  await host.start();
  const inputBlock = core.blocks.commit({
    payload: {
      schema: "dolly.content/1",
      value: {
        items: [
          { type: "text", text: IMAGE_TASK_PROMPT, format: "plain" },
          { type: "media-reference", mediaId: registered.mediaId },
        ],
      },
    },
  }, { kind: "external", id: "live-fixture" });
  core.deliveries.append("input", inputBlock.id);
  const startedAt = new Date().toISOString();
  const committed = await waitForAgentCase({
    findCommitted: () => repository.list().find((record) => record.state === "committed"),
    listDeadLetters: () => core.deliveries.listDeadLetters(),
    readSchedulerStatus: () => scheduler.status(moduleId),
    timeoutMs: 1_830_000,
  });
  const outputBlock = committed.blockId === undefined ? null : core.blocks.get(committed.blockId);
  if (!outputBlock) throw new Error("The committed Agent output Block is missing");
  const agentOutput = parseAgentOutput(outputBlock.payload.value);
  const answer = evaluateImageAnswer(agentOutput.finalContent);
  const effectEvidence = effectJournal.evidenceForRun(committed);
  const reopenedEffectEvidence = new EffectIntentJournal({
    store: new FileEffectIntentStore({ path: effectIntentPath }),
    now,
  }).evidenceForRun(committed);
  if (effectEvidence.kind !== "terminal" || reopenedEffectEvidence.kind !== "terminal") {
    throw new Error("The successful provider effect was not durably terminal");
  }
  const beforeStop = {
    processAlive: childPid !== undefined && processIsAlive(childPid),
    processState: processGenerationId === undefined
      ? null
      : core.getModuleProcessRecord(processGenerationId)?.state ?? null,
  };
  await host.stop();
  stopped = true;
  apiKey = "";
  const finishedAt = new Date().toISOString();
  const result = {
    schemaVersion: "dolly.scheduler-inline-media-agent-live-result/1",
    experimentId: preregistration.experimentId,
    runId,
    startedAt,
    finishedAt,
    status: "succeeded",
    exactImageAnswer: answer.exact,
    parsedAnswer: answer.parsed,
    agent: {
      capabilityVersion: agentOutput.capabilityVersion,
      strictStreamRequested: agentOutput.strictStreamRequested,
      childCredentialEnvironmentPresent: agentOutput.childCredentialEnvironmentPresent,
      finishReason: agentOutput.finishReason,
      reasoningState: agentOutput.reasoningState,
      outputSha256: sha256(agentOutput.finalContent),
    },
    scheduler: {
      committedResults: repository.list().length,
      pendingInput: core.deliveries.inspectPending(moduleId, ["input"]).pendingCount,
      pendingOutput: core.deliveries.inspectPending("sink", ["output"]).pendingCount,
      activeClaims: core.deliveries.listActiveClaims().length,
      deadLetters: core.deliveries.listDeadLetters().length,
      finalState: scheduler.state,
    },
    process: {
      started: true,
      childPidRecorded: childPid !== undefined,
      aliveBeforeStop: beforeStop.processAlive,
      stateBeforeStop: beforeStop.processState,
      aliveAfterStop: childPid !== undefined && processIsAlive(childPid),
      stateAfterStop: processGenerationId === undefined
        ? null
        : core.getModuleProcessRecord(processGenerationId)?.state ?? null,
      linuxControlGroupProof: false,
    },
    media: {
      mimeType: registered.mimeType,
      byteLength: registered.byteLength,
      width: registered.width,
      height: registered.height,
      digest: registered.digest,
      providerAccessRecords: core.media.listProviderAccessRecords().length,
      remainingLeases: core.media.referenceGraph.leaseCountFor({ kind: "media", id: registered.mediaId }),
    },
    effectEvidence: effectEvidence.kind,
    reopenedEffectEvidence: reopenedEffectEvidence.kind,
    requestWire: transport.observation,
    secretReleases,
    endpointRecorded: false,
    credentialRecorded: false,
    productBootstrapModulesRemainRejected: true,
  };
  writeJson(join(artifactDirectory, "result.json"), result);
  copyFileSync(effectIntentPath, join(artifactDirectory, "effect-intents.json"));
  writeJson(join(artifactDirectory, "manifest.json"), {
    schemaVersion: "dolly.scheduler-inline-media-agent-live-manifest/1",
    experimentId: preregistration.experimentId,
    experimentVersion: preregistration.experimentVersion,
    runId,
    preregistrationSha256: sha256(preregistrationBytes),
    sourceRevision: preregistration.sourceRevision,
    implementationSha256,
    backend: {
      endpointRecorded: false,
      credentialRecorded: false,
      modelId: AETHER_MODEL_ID,
      logicalModelCalls: 1,
      providerAttemptsMaximum: 1,
      nonStreamFallbackAllowed: false,
    },
    artifacts: {
      resultSha256: sha256(readFileSync(join(artifactDirectory, "result.json"))),
      effectIntentsSha256: sha256(readFileSync(join(artifactDirectory, "effect-intents.json"))),
    },
  });
  completed = answer.exact === true;
  if (!completed) throw new Error("The strict-streaming Agent returned a non-exact image answer");
  rmSync(conditionRoot, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({
    artifactDirectory: relative(REPOSITORY_ROOT, artifactDirectory),
    status: "succeeded",
    exactImageAnswer: true,
  })}\n`);
} catch (error) {
  apiKey = "";
  writeJson(join(artifactDirectory, "failure.json"), {
    schemaVersion: "dolly.scheduler-inline-media-agent-live-failure/1",
    experimentId: preregistration.experimentId,
    experimentVersion: preregistration.experimentVersion,
    runId,
    status: "failed",
    errorName: error instanceof Error ? error.name : "unknown",
    errorMessage: error instanceof Error ? error.message : "non-Error failure",
    executorStartFailure: executorStartFailure ?? null,
    requestWire: transportObservation ?? null,
    childPidRecorded: childPid !== undefined,
    childAliveAtFailure: childPid !== undefined && processIsAlive(childPid),
    scratchRetained: relative(WORKSPACE_ROOT, conditionRoot),
    endpointRecorded: false,
    credentialRecorded: false,
  });
  throw error;
} finally {
  apiKey = "";
  if (!stopped && host !== undefined && host.state !== "stopped") {
    await host.stop().catch(() => undefined);
  }
  if (!completed && childPid !== undefined && processIsAlive(childPid)) {
    process.stderr.write(`Agent child ${childPid} remains alive; retained exact scratch ${conditionRoot}\n`);
  }
}
