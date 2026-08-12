#!/usr/bin/env -S pnpm exec tsx

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SharpMediaInspector } from "../../../../src/adapters/sharp-media-inspector.js";
import type { Block } from "../../../../src/core/block-store.js";
import { createDeliveredModelMediaResolver } from "../../../../src/core/media-capability/index.js";
import { EndpointBindingRegistry } from "../../../../src/core/model-provider-binding.js";
import {
  ChatModelBroker,
  type ChatBrokerInvocation,
  type ChatBrokerResult,
  type ModelHttpTransport,
  type ModelHttpTransportRequest,
  type ModelHttpTransportResponse,
} from "../../../../src/core/model-provider-broker.js";
import { ModelDescriptorRegistry, type ChatDescriptorDocument } from "../../../../src/core/model-provider-descriptor.js";
import { NodeModelHttpTransport } from "../../../../src/core/model-provider-node-http.js";
import { InMemoryMediaByteStore, MediaStore } from "../../../../src/core/media-store.js";
import { ReferenceGraph } from "../../../../src/core/reference-graph.js";
import { generateFixtures } from "../multimodal-input-v0/common.mjs";
import {
  AETHER_MODEL_ID,
  IMAGE_TASK_PROMPT,
  evaluateImageAnswer,
} from "../multimodal-input-v0/aether-client.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "../../../..");
const PREREGISTRATION_PATH = join(
  REPOSITORY_ROOT,
  "docs/experiments/preregistrations/model-broker-inline-media-live-v0.json",
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

function readPrivateEnvironment(name: "AETHER_BASE_URL" | "AETHER_API_KEY"): string {
  const fromProcess = process.env[name];
  if (typeof fromProcess === "string" && fromProcess.length > 0) return fromProcess;
  const text = readFileSync(join(REPOSITORY_ROOT, ".env"), "utf8");
  const line = text.split(/\r?\n/u).find((candidate) => candidate.startsWith(`${name}=`));
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
  if (url.protocol !== "https:") throw new Error("This public canary requires an HTTPS endpoint");
  const basePath = url.pathname.replace(/\/+$/u, "").replace(/\/chat\/completions$/u, "");
  url.pathname = `${basePath.endsWith("/v1") ? basePath : `${basePath}/v1`}/chat/completions`
    .replace(/\/+/gu, "/");
  return url;
}

function descriptor(): ChatDescriptorDocument {
  return {
    schemaVersion: "dolly.model-descriptor/4",
    descriptorVersion: "aether-inline-png-strict-sse-v0",
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
      text: {
        state: "supported",
        value: { maxBytesPerItem: 32_000, empty: "forbidden" },
      },
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
        requestControl: {
          kind: "enum-strategy",
          strategyId: "thinking-object.enabled-disabled.v1",
        },
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
  observation: Record<string, unknown> | undefined;

  constructor(private readonly inner: ModelHttpTransport) {}

  dispatch(request: ModelHttpTransportRequest): Promise<ModelHttpTransportResponse> {
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
      throw new Error("Product broker emitted a non-conforming live request");
    }
    this.observation = {
      requestBytes: bodyBytes.byteLength,
      requestSha256: sha256(bodyBytes),
      stream: true,
      includeUsage: true,
      thinkingType: "disabled",
      enableThinkingPresent: false,
      outputContract: "json_object",
      mediaPlacement: "inline-png-data-url",
      mediaDataUrlSha256: sha256(mediaUrl),
      timeoutMs: request.timeoutMs,
    };
    return this.inner.dispatch(request);
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

const runIdIndex = process.argv.indexOf("--run-id");
const runId = runIdIndex >= 0 ? process.argv[runIdIndex + 1] : undefined;
if (
  process.env.RUN_LIVE_INTEGRATION !== "1" ||
  process.env.RUN_PAID_INTEGRATION !== "1" ||
  process.argv.length !== 4 ||
  runIdIndex !== 2 ||
  !/^live-v0-[a-z0-9][a-z0-9-]{0,63}$/u.test(runId ?? "")
) {
  throw new Error("usage requires live/paid opt-in and --run-id live-v0-<unique-suffix>");
}

const artifactDirectory = join(
  REPOSITORY_ROOT,
  "artifacts/experiments/probes/model-broker-inline-media-live-v0",
  runId!,
);
if (existsSync(artifactDirectory)) throw new Error("refusing to overwrite an existing run");
mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });

const preregistrationBytes = readFileSync(PREREGISTRATION_PATH);
const preregistration = JSON.parse(preregistrationBytes.toString("utf8"));
const sourcePaths = preregistration.implementationFiles as string[];
const sourceHashes = sourcePaths.map((path) => ({
  path,
  sha256: sha256(readFileSync(join(REPOSITORY_ROOT, path))),
}));
for (const frozen of preregistration.implementationSha256 as Array<{ path: string; sha256: string }>) {
  const actual = sourceHashes.find((entry) => entry.path === frozen.path)?.sha256;
  if (actual !== frozen.sha256) throw new Error(`implementation hash mismatch: ${frozen.path}`);
}

writeJson(join(artifactDirectory, "manifest.json"), {
  schemaVersion: "dolly.model-broker-inline-media-live-manifest/1",
  experimentId: preregistration.experimentId,
  experimentVersion: preregistration.experimentVersion,
  runId,
  preregistrationSha256: sha256(preregistrationBytes),
  sourceRevision: preregistration.sourceRevision,
  implementationSha256: sourceHashes,
  backend: {
    endpointRecorded: false,
    credentialRecorded: false,
    modelId: AETHER_MODEL_ID,
    requestCountMaximum: 1,
  },
  moduleProcessesStarted: 0,
  ossUsed: false,
  nonStreamFallbackAllowed: false,
});

let apiKey = readPrivateEnvironment("AETHER_API_KEY");
const exactUrl = exactChatUrl(readPrivateEnvironment("AETHER_BASE_URL"));
const image = (await generateFixtures()).agentTaskPng;
const media = new MediaStore({
  durability: "volatile",
  referenceGraph: new ReferenceGraph(),
  bytes: new InMemoryMediaByteStore(),
  inspector: new SharpMediaInspector({ maxInputPixels: 1_000_000 }),
  maxMediaBytes: 1_000_000,
  idNamespace: `broker-live-${runId}`,
});
const registered = await media.registerMedia({
  registrationId: "registration-live-image-1",
  bytes: image,
  declaredMimeType: "image/png",
  provenance: { sourceClass: "extension-bytes" },
});

const block: Block = {
  schemaVersion: "dolly.block/2",
  id: "block-live-image-1",
  sequence: "000000000000000000001",
  source: { kind: "external", id: "canary" },
  createdAt: new Date().toISOString(),
  payload: {
    schema: "dolly.content/1",
    value: { items: [{ type: "media-reference", mediaId: registered.mediaId }] },
  },
};
const claim = {
  moduleJobId: "module-job-live-image-1",
  runId: "module-run-live-image-1",
  blockGroups: [{ block, deliveryIds: ["delivery-live-image-1"] }],
};
const session = {
  extensionId: "live-canary-extension",
  instanceId: "live-canary-instance",
  processGenerationId: "live-canary-process-generation",
  sessionId: "live-canary-session",
  moduleId: "live-canary-brain",
  moduleGenerationId: "live-canary-module-generation",
};
const mediaResolver = createDeliveredModelMediaResolver({
  claim,
  session,
  source: media,
  isActiveRun: (context) =>
    context.moduleJobId === claim.moduleJobId && context.runId === claim.runId,
  now: () => new Date().toISOString(),
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
  bindingRevision: "owner-aether-live-inline-v0",
  descriptorRefs: [descriptorRef],
  exactUrl: exactUrl.href,
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

let secretReleases = 0;
const transport = new ObservedStreamingTransport(new NodeModelHttpTransport());
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
const invocation: ChatBrokerInvocation = {
  schemaVersion: "dolly.model.chat-invocation/3",
  requestId: "model-request-live-image-1",
  descriptor: descriptorRef,
  context: {
    operationId: "operation-live-image-1",
    instanceId: session.instanceId,
    ownerScope: "owner-live-canary",
    moduleId: session.moduleId,
    moduleGenerationId: session.moduleGenerationId,
    moduleJobId: claim.moduleJobId,
    runId: claim.runId,
    attempt: 1,
    sessionId: session.sessionId,
    deadline: new Date(Date.now() + 1_800_000).toISOString(),
  },
  budgets: {
    maxProviderAttempts: 1,
    maxWallTimeMs: 1_800_000,
    maxRequestBytes: 2_000_000,
    maxResponseBytes: 2_000_000,
    maxInputItems: 16,
    maxInputBytes: 1_500_000,
    maxOutputBytes: 512_000,
    maxOutputTokens: 1200,
    maxMediaItems: 1,
    maxResolvedMediaBytes: image.byteLength,
  },
  reasoningPolicy: "disable",
  input: {
    schemaVersion: "dolly.model.chat-input/3",
    messages: [{
      role: "user",
      parts: [
        { kind: "text", text: IMAGE_TASK_PROMPT },
        {
          kind: "media",
          mediaReference: { type: "media-reference", mediaId: registered.mediaId },
          requirementId: "aether-inline-png-v0",
        },
      ],
    }],
    outputContract: { kind: "json-object" },
    stream: true,
  },
};

const startedAt = new Date().toISOString();
let result: ChatBrokerResult;
try {
  result = await broker.invoke(invocation);
} finally {
  apiKey = "";
}
const finishedAt = new Date().toISOString();
const answer = result.status === "succeeded"
  ? evaluateImageAnswer(result.output.finalContent)
  : { parsed: null, exact: false };
const sanitized = {
  schemaVersion: "dolly.model-broker-inline-media-live-result/1",
  experimentId: preregistration.experimentId,
  runId,
  startedAt,
  finishedAt,
  status: result.status,
  exactImageAnswer: answer.exact,
  parsedAnswer: answer.parsed,
  ...(result.status === "succeeded"
    ? {
        finishReason: result.output.finishReason,
        contentBytes: Buffer.byteLength(result.output.finalContent, "utf8"),
        contentSha256: sha256(result.output.finalContent),
        reasoningState: result.output.reasoning.state,
        usage: result.usage,
      }
    : { error: result.error, usage: result.usage }),
  requestWire: transport.observation ?? null,
  media: {
    mimeType: registered.mimeType,
    byteLength: registered.byteLength,
    width: registered.width,
    height: registered.height,
    digest: registered.digest,
    providerAccessRecords: media.listProviderAccessRecords().length,
    remainingLeases: media.referenceGraph.leaseCountFor({ kind: "media", id: registered.mediaId }),
  },
  secretReleases,
  endpointRecorded: false,
  credentialRecorded: false,
  moduleProcessesStarted: 0,
};
writeJson(join(artifactDirectory, "result.json"), sanitized);
process.stdout.write(`${JSON.stringify({ artifactDirectory: relative(REPOSITORY_ROOT, artifactDirectory), status: result.status, exactImageAnswer: answer.exact })}\n`);
if (result.status !== "succeeded" || answer.exact !== true) process.exitCode = 1;
