#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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

import { createExtensionEffectJournalLifecycle } from "../../../../src/adapters/extension-effect-run-lifecycle.js";
import { createExtensionProcessModuleExecutor } from "../../../../src/adapters/extension-process-module-executor.js";
import {
  EffectIntentJournal,
  effectIntentEvidenceSource,
} from "../../../../src/core/capabilities/effect-intent-journal.js";
import { FileEffectIntentStore } from "../../../../src/core/capabilities/file-effect-intent-store.js";
import {
  createModulePrivateStorageCapabilityV2,
  ModulePrivateStorageBackend,
} from "../../../../src/core/capabilities/module-private-storage-capability.js";
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
import { waitForAgentCase } from "./wait-for-case.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../../..");
const workspaceRoot = resolve(repositoryRoot, "..");
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
  "openai.response-format.json-object.v1",
]);
const REGISTRY_EXPERIMENT_IMPLEMENTATION_PATHS = [
  "scripts/experiments/probes/general-agent-live-v0/run.mts",
  "scripts/experiments/probes/general-agent-live-v0/extension.mjs",
  "scripts/experiments/probes/general-agent-live-v0/verify-tool-registry.mjs",
] as const;
const REGISTRY_EXPERIMENT_PRODUCTION_PATHS = [
  "src/adapters/extension-effect-run-lifecycle.ts",
  "src/adapters/extension-process-module-executor.ts",
  "src/core/capabilities/effect-intent-journal.ts",
  "src/core/capabilities/file-effect-intent-store.ts",
  "src/core/delivery-store.ts",
  "src/core/extension-process-host.ts",
  "src/core/file-core-state-store.ts",
  "src/core/file-tool-journal-repository.ts",
  "src/core/model-provider-broker.ts",
  "src/core/model-provider-chat.ts",
  "src/core/model-provider-descriptor.ts",
  "src/core/module-result-commit-factory.ts",
  "src/core/module-result-commit.ts",
  "src/core/module-scheduler.ts",
  "src/core/provider-capabilities/model-operation-capability.ts",
  "src/core/provider-capabilities/tool-invocation-capability.ts",
  "src/core/reactive-module-host.ts",
  "src/core/reactive-module-runtime.ts",
  "src/core/runtime-bootstrap.ts",
  "src/core/tool-policy.ts",
] as const;
const DATASET_DEFINITION = {
  schemaVersion: "general-agent-tool-registry/dataset/1",
  task:
    "Find the active deployment codename in private memory. Use available tools and do not guess.",
  entries: [
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
} as const;

type AgentConditionId =
  | "no-storage-tool"
  | "private-storage-tool"
  | "tool-registry-storage";

interface AgentExperimentConfiguration {
  readonly experimentId:
    | "general-agent-live-v0"
    | "general-agent-tool-registry-v0"
    | "general-agent-tool-registry-v1"
    | "general-agent-tool-registry-v2"
    | "general-agent-tool-registry-v3"
    | "general-agent-tool-registry-v4"
    | "general-agent-tool-registry-v5"
    | "general-agent-tool-registry-v6"
    | "general-agent-tool-registry-v7";
  readonly experimentVersion: number;
  readonly modelCapabilityVersion: 1 | 2;
  readonly separatePlanningCall: boolean;
  readonly runId: string;
  readonly artifactRoot: string;
  readonly preregistrationPath: string;
  readonly executionOrder: readonly {
    readonly evaluationSeed: number;
    readonly repetition: number;
    readonly conditionId: AgentConditionId;
    readonly modelRequestIdBase: string;
  }[];
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : undefined;
}

function providerTokenAccounting(rows: readonly JsonValue[]): JsonValue {
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let recordsWithUsage = 0;
  let recordsMissingUsage = 0;
  for (const row of rows) {
    const response = isJsonRecord(row) && isJsonRecord(row.response)
      ? row.response
      : undefined;
    let usage = response !== undefined && isJsonRecord(response.usage)
      ? response.usage
      : undefined;
    if (usage === undefined && typeof response?.eventStreamUtf8 === "string") {
      for (const event of response.eventStreamUtf8.split(/\r?\n\r?\n/u)) {
        const line = event.split(/\r?\n/u).find((candidate) => candidate.startsWith("data:"));
        if (!line) continue;
        const payload = line.slice(5).replace(/^ /u, "");
        if (payload === "[DONE]") continue;
        try {
          const value = JSON.parse(payload) as JsonValue;
          if (isJsonRecord(value) && isJsonRecord(value.usage)) usage = value.usage;
        } catch {
          // The strict Broker decoder owns SSE validity. Accounting does not
          // repair malformed provider evidence after the fact.
        }
      }
    }
    const promptTokens = nonNegativeInteger(usage?.prompt_tokens);
    const completionTokens = nonNegativeInteger(usage?.completion_tokens);
    const totalTokens = nonNegativeInteger(usage?.total_tokens);
    if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {
      recordsMissingUsage += 1;
      continue;
    }
    prompt += promptTokens;
    completion += completionTokens;
    total += totalTokens;
    recordsWithUsage += 1;
  }
  return { prompt, completion, total, recordsWithUsage, recordsMissingUsage };
}

function caseAccounting(options: {
  readonly plannedCase: AgentExperimentConfiguration["executionOrder"][number];
  readonly modelRows: readonly JsonValue[];
  readonly providerRows: readonly JsonValue[];
}): JsonValue {
  let providerAttempts = 0;
  let retries = 0;
  let modelErrors = 0;
  let aggregateLatencyMs = 0;
  for (const row of options.modelRows) {
    if (!isJsonRecord(row)) continue;
    const result = isJsonRecord(row.result) ? row.result : undefined;
    const usage = result !== undefined && isJsonRecord(result.usage) ? result.usage : undefined;
    const attempts = nonNegativeInteger(usage?.providerAttempts) ?? 0;
    providerAttempts += attempts;
    retries += Math.max(0, attempts - 1);
    if (result?.status !== "succeeded") modelErrors += 1;
    const started = typeof row.startedAt === "string" ? Date.parse(row.startedAt) : Number.NaN;
    const completed = typeof row.completedAt === "string" ? Date.parse(row.completedAt) : Number.NaN;
    if (Number.isFinite(started) && Number.isFinite(completed) && completed >= started) {
      aggregateLatencyMs += completed - started;
    }
  }
  const providerErrors = options.providerRows.filter(
    (row) =>
      !isJsonRecord(row) ||
      row.httpStatus !== 200 ||
      Object.hasOwn(row, "failureKind"),
  ).length;
  return {
    evaluationSeed: options.plannedCase.evaluationSeed,
    repetition: options.plannedCase.repetition,
    conditionId: options.plannedCase.conditionId,
    providerCalls: options.modelRows.length,
    providerAttempts,
    retries,
    modelErrors,
    providerErrors,
    aggregateLatencyMs,
    tokens: providerTokenAccounting(options.providerRows),
    monetaryCost: {
      measured: false,
      currency: null,
      amount: null,
      enforcedBudget: false,
    },
  };
}

export class ExperimentFetchTransport implements ModelHttpTransport {
  readonly #recordResponse: (record: JsonValue) => void;

  constructor(recordResponse: (record: JsonValue) => void) {
    this.#recordResponse = recordResponse;
  }

  async dispatch(input: ModelHttpTransportRequest): Promise<ModelHttpTransportResponse> {
    let requestBody: JsonValue;
    try {
      requestBody = JSON.parse(Buffer.from(input.body).toString("utf8")) as JsonValue;
    } catch {
      throw new Error("experiment model request body is not JSON");
    }
    if (requestBody === null || Array.isArray(requestBody) || typeof requestBody !== "object") {
      throw new Error("experiment model request body is not one JSON object");
    }
    const requestEvidence = {
      requestBody,
      requestBodySha256: sha256(input.body),
    };
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
        ...requestEvidence,
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
    const providerRequestId =
      headers["x-request-id"] ?? headers["request-id"] ?? headers["x-amzn-requestid"];
    if (response.status < 200 || response.status >= 300) {
      let observedBytes = 0;
      try {
        if (reader) {
          while (true) {
            const item = await reader.read();
            if (item.done) break;
            observedBytes += item.value.byteLength;
            if (observedBytes > input.maxResponseBytes) {
              controller.abort(new Error("experiment model response exceeded its byte budget"));
              throw new Error("experiment model response exceeded its byte budget");
            }
            responseChunks.push(Buffer.from(item.value));
          }
        }
        const responseText = Buffer.concat(responseChunks).toString("utf8");
        let responseValue: JsonValue = null;
        if (responseText !== "") {
          try {
            responseValue = JSON.parse(responseText) as JsonValue;
          } catch {
            responseValue = { invalidJsonUtf8: responseText };
          }
        }
        recordOnce({
          schemaVersion: "general-agent-live/provider-response/1",
          ...requestEvidence,
          httpStatus: response.status,
          responseContentType: headers["content-type"] ?? null,
          response: responseValue,
        });
      } catch (error) {
        recordOnce({
          schemaVersion: "general-agent-live/provider-response/1",
          ...requestEvidence,
          httpStatus: response.status,
          responseContentType: headers["content-type"] ?? null,
          failureKind: "response-body-read-failed",
          response: null,
        });
        throw error;
      } finally {
        clearTimeout(timeout);
        input.signal.removeEventListener("abort", abortFromCaller);
      }
      return {
        status: response.status,
        headers,
        ...(providerRequestId === undefined ? {} : { providerRequestId }),
        body: (async function* () {
          for (const chunk of responseChunks) yield Uint8Array.from(chunk);
        })(),
        abort: (reason) => controller.abort(reason),
      };
    }
    const body = (async function* () {
      let observedBytes = 0;
      try {
        if (!reader) {
          recordOnce({
            schemaVersion: "general-agent-live/provider-response/1",
            ...requestEvidence,
            httpStatus: response.status,
            responseContentType: headers["content-type"] ?? null,
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
              ...requestEvidence,
              httpStatus: response.status,
              responseContentType: headers["content-type"] ?? null,
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
          ...requestEvidence,
          httpStatus: response.status,
          responseContentType: headers["content-type"] ?? null,
          failureKind: "response-body-read-failed",
          response: null,
        });
        throw error;
      } finally {
        if (!responseRecorded) {
          recordOnce({
            schemaVersion: "general-agent-live/provider-response/1",
            ...requestEvidence,
            httpStatus: response.status,
            responseContentType: headers["content-type"] ?? null,
            failureKind: "response-consumer-stopped-before-end",
            response: {
              eventStreamUtf8: Buffer.concat(responseChunks).toString("utf8"),
            },
          });
        }
        clearTimeout(timeout);
        input.signal.removeEventListener("abort", abortFromCaller);
      }
    })();
    return {
      status: response.status,
      headers,
      ...(providerRequestId === undefined ? {} : { providerRequestId }),
      body,
      abort: (reason) => controller.abort(reason),
    };
  }
}

function normalizeProviderEvidence(row: JsonValue): JsonValue {
  if (!isJsonRecord(row) || !isJsonRecord(row.requestBody) || !isJsonRecord(row.response)) {
    return row;
  }
  if (row.requestBody.stream !== true || typeof row.response.invalidJsonUtf8 !== "string") {
    return row;
  }
  return {
    ...row,
    response: { eventStreamUtf8: row.response.invalidJsonUtf8 },
  };
}

function parseArguments(argv: readonly string[]): AgentExperimentConfiguration {
  if (argv.length !== 2 || argv[0] !== "--run-id") {
    throw new Error(
      "usage: run.mts --run-id live-v8-<identifier>|registry-v1-<identifier>",
    );
  }
  const runId = argv[1]!;
  if (/^live-v8-[A-Za-z0-9._-]+$/u.test(runId)) {
    return {
      experimentId: "general-agent-live-v0",
      experimentVersion: 8,
      modelCapabilityVersion: 1,
      separatePlanningCall: false,
      runId,
      artifactRoot: join(
        repositoryRoot,
        "artifacts/experiments/probes/general-agent-live-v0",
      ),
      preregistrationPath: join(
        repositoryRoot,
        "docs/experiments/preregistrations/general-agent-live-v0.json",
      ),
      executionOrder: [
        {
          evaluationSeed: 7421,
          repetition: 1,
          conditionId: "no-storage-tool",
          modelRequestIdBase: "no-storage-tool",
        },
        {
          evaluationSeed: 7421,
          repetition: 1,
          conditionId: "private-storage-tool",
          modelRequestIdBase: "private-storage-tool",
        },
      ],
    };
  }
  if (/^registry-v1-[A-Za-z0-9._-]+$/u.test(runId)) {
    return {
      experimentId: "general-agent-tool-registry-v0",
      experimentVersion: 1,
      modelCapabilityVersion: 1,
      separatePlanningCall: false,
      runId,
      artifactRoot: join(
        repositoryRoot,
        "artifacts/experiments/probes/general-agent-tool-registry-v0",
      ),
      preregistrationPath: join(
        repositoryRoot,
        "docs/experiments/preregistrations/general-agent-tool-registry-v0.json",
      ),
      executionOrder: [
        {
          evaluationSeed: 7421,
          repetition: 1,
          conditionId: "no-storage-tool",
          modelRequestIdBase: "no-storage-tool-seed-7421",
        },
        {
          evaluationSeed: 7421,
          repetition: 1,
          conditionId: "tool-registry-storage",
          modelRequestIdBase: "tool-registry-storage-seed-7421",
        },
        {
          evaluationSeed: 7422,
          repetition: 2,
          conditionId: "tool-registry-storage",
          modelRequestIdBase: "tool-registry-storage-seed-7422",
        },
        {
          evaluationSeed: 7422,
          repetition: 2,
          conditionId: "no-storage-tool",
          modelRequestIdBase: "no-storage-tool-seed-7422",
        },
      ],
    };
  }
  if (/^registry-v2-[A-Za-z0-9._-]+$/u.test(runId)) {
    return {
      experimentId: "general-agent-tool-registry-v1",
      experimentVersion: 2,
      modelCapabilityVersion: 2,
      separatePlanningCall: false,
      runId,
      artifactRoot: join(
        repositoryRoot,
        "artifacts/experiments/probes/general-agent-tool-registry-v1",
      ),
      preregistrationPath: join(
        repositoryRoot,
        "docs/experiments/preregistrations/general-agent-tool-registry-v1.json",
      ),
      executionOrder: [
        {
          evaluationSeed: 7421,
          repetition: 1,
          conditionId: "no-storage-tool",
          modelRequestIdBase: "no-storage-tool-seed-7421",
        },
        {
          evaluationSeed: 7421,
          repetition: 1,
          conditionId: "tool-registry-storage",
          modelRequestIdBase: "tool-registry-storage-seed-7421",
        },
        {
          evaluationSeed: 7422,
          repetition: 2,
          conditionId: "tool-registry-storage",
          modelRequestIdBase: "tool-registry-storage-seed-7422",
        },
        {
          evaluationSeed: 7422,
          repetition: 2,
          conditionId: "no-storage-tool",
          modelRequestIdBase: "no-storage-tool-seed-7422",
        },
      ],
    };
  }
  if (/^registry-v3-[A-Za-z0-9._-]+$/u.test(runId)) {
    return {
      experimentId: "general-agent-tool-registry-v2",
      experimentVersion: 3,
      modelCapabilityVersion: 2,
      separatePlanningCall: true,
      runId,
      artifactRoot: join(
        repositoryRoot,
        "artifacts/experiments/probes/general-agent-tool-registry-v2",
      ),
      preregistrationPath: join(
        repositoryRoot,
        "docs/experiments/preregistrations/general-agent-tool-registry-v2.json",
      ),
      executionOrder: [
        {
          evaluationSeed: 7421,
          repetition: 1,
          conditionId: "no-storage-tool",
          modelRequestIdBase: "no-storage-tool-seed-7421",
        },
        {
          evaluationSeed: 7421,
          repetition: 1,
          conditionId: "tool-registry-storage",
          modelRequestIdBase: "tool-registry-storage-seed-7421",
        },
        {
          evaluationSeed: 7422,
          repetition: 2,
          conditionId: "tool-registry-storage",
          modelRequestIdBase: "tool-registry-storage-seed-7422",
        },
        {
          evaluationSeed: 7422,
          repetition: 2,
          conditionId: "no-storage-tool",
          modelRequestIdBase: "no-storage-tool-seed-7422",
        },
      ],
    };
  }
  if (/^registry-v4-[A-Za-z0-9._-]+$/u.test(runId)) {
    return {
      experimentId: "general-agent-tool-registry-v3",
      experimentVersion: 4,
      modelCapabilityVersion: 2,
      separatePlanningCall: true,
      runId,
      artifactRoot: join(
        repositoryRoot,
        "artifacts/experiments/probes/general-agent-tool-registry-v3",
      ),
      preregistrationPath: join(
        repositoryRoot,
        "docs/experiments/preregistrations/general-agent-tool-registry-v3.json",
      ),
      executionOrder: [
        {
          evaluationSeed: 7423,
          repetition: 1,
          conditionId: "no-storage-tool",
          modelRequestIdBase: "no-storage-tool-seed-7423",
        },
        {
          evaluationSeed: 7423,
          repetition: 1,
          conditionId: "tool-registry-storage",
          modelRequestIdBase: "tool-registry-storage-seed-7423",
        },
        {
          evaluationSeed: 7424,
          repetition: 2,
          conditionId: "tool-registry-storage",
          modelRequestIdBase: "tool-registry-storage-seed-7424",
        },
        {
          evaluationSeed: 7424,
          repetition: 2,
          conditionId: "no-storage-tool",
          modelRequestIdBase: "no-storage-tool-seed-7424",
        },
      ],
    };
  }
  if (/^registry-v5-[A-Za-z0-9._-]+$/u.test(runId)) {
    return {
      experimentId: "general-agent-tool-registry-v4",
      experimentVersion: 5,
      modelCapabilityVersion: 2,
      separatePlanningCall: true,
      runId,
      artifactRoot: join(
        repositoryRoot,
        "artifacts/experiments/probes/general-agent-tool-registry-v4",
      ),
      preregistrationPath: join(
        repositoryRoot,
        "docs/experiments/preregistrations/general-agent-tool-registry-v4.json",
      ),
      executionOrder: [
        {
          evaluationSeed: 7425,
          repetition: 1,
          conditionId: "no-storage-tool",
          modelRequestIdBase: "no-storage-tool-seed-7425",
        },
        {
          evaluationSeed: 7425,
          repetition: 1,
          conditionId: "tool-registry-storage",
          modelRequestIdBase: "tool-registry-storage-seed-7425",
        },
        {
          evaluationSeed: 7426,
          repetition: 2,
          conditionId: "tool-registry-storage",
          modelRequestIdBase: "tool-registry-storage-seed-7426",
        },
        {
          evaluationSeed: 7426,
          repetition: 2,
          conditionId: "no-storage-tool",
          modelRequestIdBase: "no-storage-tool-seed-7426",
        },
      ],
    };
  }
  if (/^registry-v6-[A-Za-z0-9._-]+$/u.test(runId)) {
    return {
      experimentId: "general-agent-tool-registry-v5",
      experimentVersion: 6,
      modelCapabilityVersion: 2,
      separatePlanningCall: true,
      runId,
      artifactRoot: join(
        repositoryRoot,
        "artifacts/experiments/probes/general-agent-tool-registry-v5",
      ),
      preregistrationPath: join(
        repositoryRoot,
        "docs/experiments/preregistrations/general-agent-tool-registry-v5.json",
      ),
      executionOrder: [
        {
          evaluationSeed: 7427,
          repetition: 1,
          conditionId: "no-storage-tool",
          modelRequestIdBase: "no-storage-tool-seed-7427",
        },
        {
          evaluationSeed: 7427,
          repetition: 1,
          conditionId: "tool-registry-storage",
          modelRequestIdBase: "tool-registry-storage-seed-7427",
        },
        {
          evaluationSeed: 7428,
          repetition: 2,
          conditionId: "tool-registry-storage",
          modelRequestIdBase: "tool-registry-storage-seed-7428",
        },
        {
          evaluationSeed: 7428,
          repetition: 2,
          conditionId: "no-storage-tool",
          modelRequestIdBase: "no-storage-tool-seed-7428",
        },
      ],
    };
  }
  if (/^registry-v7-[A-Za-z0-9._-]+$/u.test(runId)) {
    return {
      experimentId: "general-agent-tool-registry-v6",
      experimentVersion: 7,
      modelCapabilityVersion: 2,
      separatePlanningCall: true,
      runId,
      artifactRoot: join(
        repositoryRoot,
        "artifacts/experiments/probes/general-agent-tool-registry-v6",
      ),
      preregistrationPath: join(
        repositoryRoot,
        "docs/experiments/preregistrations/general-agent-tool-registry-v6.json",
      ),
      executionOrder: [
        {
          evaluationSeed: 7429,
          repetition: 1,
          conditionId: "no-storage-tool",
          modelRequestIdBase: "no-storage-tool-seed-7429",
        },
        {
          evaluationSeed: 7429,
          repetition: 1,
          conditionId: "tool-registry-storage",
          modelRequestIdBase: "tool-registry-storage-seed-7429",
        },
        {
          evaluationSeed: 7430,
          repetition: 2,
          conditionId: "tool-registry-storage",
          modelRequestIdBase: "tool-registry-storage-seed-7430",
        },
        {
          evaluationSeed: 7430,
          repetition: 2,
          conditionId: "no-storage-tool",
          modelRequestIdBase: "no-storage-tool-seed-7430",
        },
      ],
    };
  }
  if (/^registry-v8-[A-Za-z0-9._-]+$/u.test(runId)) {
    return {
      experimentId: "general-agent-tool-registry-v7",
      experimentVersion: 8,
      modelCapabilityVersion: 2,
      separatePlanningCall: true,
      runId,
      artifactRoot: join(
        repositoryRoot,
        "artifacts/experiments/probes/general-agent-tool-registry-v7",
      ),
      preregistrationPath: join(
        repositoryRoot,
        "docs/experiments/preregistrations/general-agent-tool-registry-v7.json",
      ),
      executionOrder: [
        {
          evaluationSeed: 7431,
          repetition: 1,
          conditionId: "no-storage-tool",
          modelRequestIdBase: "no-storage-tool-seed-7431",
        },
        {
          evaluationSeed: 7431,
          repetition: 1,
          conditionId: "tool-registry-storage",
          modelRequestIdBase: "tool-registry-storage-seed-7431",
        },
        {
          evaluationSeed: 7432,
          repetition: 2,
          conditionId: "tool-registry-storage",
          modelRequestIdBase: "tool-registry-storage-seed-7432",
        },
        {
          evaluationSeed: 7432,
          repetition: 2,
          conditionId: "no-storage-tool",
          modelRequestIdBase: "no-storage-tool-seed-7432",
        },
      ],
    };
  }
  throw new Error(
    "usage: run.mts --run-id live-v8-<identifier>|registry-v1-<identifier>|registry-v2-<identifier>|registry-v3-<identifier>|registry-v4-<identifier>|registry-v5-<identifier>|registry-v6-<identifier>|registry-v7-<identifier>|registry-v8-<identifier>",
  );
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

function descriptorDocument(jsonObjectOutput: boolean) {
  return {
    schemaVersion: jsonObjectOutput
      ? "dolly.model-descriptor/4" as const
      : "dolly.model-descriptor/3" as const,
    descriptorVersion: jsonObjectOutput
      ? "owner-aether-qwen3.6-27b-v2"
      : "owner-aether-qwen3.6-27b-v1",
    endpointId: "owner-aether-live-fixture",
    operation: "chat-completion" as const,
    modelId: "qwen3.6-27b",
    adapter: {
      id: "openai-compatible-chat",
      version: "v1",
      requestStrategyId: "openai.chat.request.text-parts.v1",
      responseStrategyId: "aether.qwen.chat.response.v2",
      streamStrategyId: "openai.chat.stream.sse.v1",
    },
    limits: {
      maxRequestBytes: 128 * 1024,
      maxResponseBytes: 512 * 1024,
      maxInputItems: 64,
      maxInputBytes: 96 * 1024,
      maxOutputBytes: 256 * 1024,
      maxConcurrentRequests: 1,
      maxProviderTimeoutMs: 180_000,
      streaming: {
        state: "supported" as const,
        value: { maxEvents: 32_768, maxBufferedBytes: 128 * 1024 },
      },
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
      ...(jsonObjectOutput
        ? {
            jsonObjectOutput: {
              state: "supported" as const,
              value: { strategyId: "openai.response-format.json-object.v1" },
            },
          }
        : {}),
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
            streamStrategyId: "openai.reasoning-content.stream.v1",
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

const STORAGE_TOOL_LIST_LIMIT = 3;
const STORAGE_TOOL_BUDGET: ToolTurnBudget = {
  maxRounds: 2,
  maxCalls: 2,
  maxCallsPerRound: 1,
  maxApprovals: 0,
  maxCallBytes: 2 * 1024,
};

function storageToolDescriptors(): readonly ToolDescriptor[] {
  return [
    {
      toolId: "storage.list",
      wireName: "storage_list",
      description: "List private-memory keys in lexical order before reading a relevant item; for discovery, request the largest limit allowed by argumentSchema.",
      argumentSchema: {
        type: "object",
        properties: {
          prefix: { type: "string", maxBytes: 256 },
          limit: { type: "integer", minimum: 1, maximum: STORAGE_TOOL_LIST_LIMIT },
          after: { type: "string", maxBytes: 256 },
        },
        required: ["prefix", "limit"],
        additionalProperties: false,
        maxProperties: 3,
      },
      resultSchema: {
        type: "object",
        properties: {
          schemaVersion: {
            type: "string",
            maxBytes: 64,
            enum: ["dolly.storage-list/1"],
          },
          keys: {
            type: "array",
            items: { type: "string", maxBytes: 256 },
            maxItems: STORAGE_TOOL_LIST_LIMIT,
          },
          truncated: { type: "boolean" },
          nextAfter: { type: "string", maxBytes: 256 },
        },
        required: ["schemaVersion", "keys", "truncated"],
        additionalProperties: false,
        maxProperties: 4,
      },
      effectClass: "read",
      resourceScope: "module-private-storage",
      approval: "never",
      idempotency: "effect-key",
      outcomeQuery: "supported",
      parallel: "safe",
      deadlineMs: 1_000,
      maxArgumentBytes: 1_024,
      maxResultBytes: 4 * 1_024,
    },
    {
      toolId: "storage.get",
      wireName: "storage_get",
      description: "Read one private-memory item by a key returned from the list operation.",
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
          schemaVersion: {
            type: "string",
            maxBytes: 64,
            enum: ["dolly.storage-get/1"],
          },
          found: { type: "enum", values: [true] },
          value: {
            type: "object",
            properties: {
              status: { type: "string", maxBytes: 32 },
              codename: { type: "string", maxBytes: 64 },
            },
            required: ["status", "codename"],
            additionalProperties: false,
            maxProperties: 2,
          },
          updatedAt: { type: "string", maxBytes: 64 },
        },
        required: ["schemaVersion", "found", "value", "updatedAt"],
        additionalProperties: false,
        maxProperties: 4,
      },
      effectClass: "read",
      resourceScope: "module-private-storage",
      approval: "never",
      idempotency: "effect-key",
      outcomeQuery: "supported",
      parallel: "safe",
      deadlineMs: 1_000,
      maxArgumentBytes: 1_024,
      maxResultBytes: 4 * 1_024,
    },
  ];
}

function createReadOnlyStorageToolExecutor(options: {
  readonly storage: ModulePrivateStorageBackend;
  readonly instanceId: string;
  readonly moduleId: string;
}): ToolExecutor {
  const namespace = options.storage.namespaceFor(options.instanceId, options.moduleId);
  const binding = { namespace, instanceId: options.instanceId, moduleId: options.moduleId };
  return {
    execute: async (request): Promise<ToolExecutionOutcome> => {
      if (request.toolId === "storage.list") {
        const prefix = request.arguments.prefix as string;
        const limit = request.arguments.limit as number;
        const after = request.arguments.after as string | undefined;
        const matching = options.storage
          .read(binding)
          .entries.filter(
            (entry) =>
              entry.key.startsWith(prefix) && (after === undefined || entry.key > after),
          );
        const page = matching.slice(0, limit);
        const truncated = page.length < matching.length;
        return {
          status: "succeeded" as const,
          content: {
            schemaVersion: "dolly.storage-list/1",
            keys: page.map((entry) => entry.key),
            truncated,
            ...(truncated ? { nextAfter: page[page.length - 1]!.key } : {}),
          },
        };
      }
      if (request.toolId === "storage.get") {
        const key = request.arguments.key as string;
        const entry = options.storage.read(binding).entries.find((candidate) => candidate.key === key);
        if (!entry) return { status: "failed" as const, code: "STORAGE_KEY_NOT_FOUND" };
        return {
          status: "succeeded" as const,
          content: {
            schemaVersion: "dolly.storage-get/1",
            found: true,
            value: entry.value,
            updatedAt: entry.updatedAt,
          },
        };
      }
      return { status: "failed" as const, code: "TOOL_NOT_IMPLEMENTED" };
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
  conditionId: AgentConditionId;
  evaluationSeed: number;
  repetition: number;
  modelRequestIdBase: string;
  runDirectory: string;
  broker: ChatModelBrokerPort;
  modelCapabilityVersion: 1 | 2;
  separatePlanningCall: boolean;
}): Promise<JsonValue> {
  const caseIdentity = `${options.conditionId}-seed-${options.evaluationSeed}`;
  const conditionRoot = mkdtempSync(
    join(resolve(workspaceRoot, ".tmp"), `general-agent-${caseIdentity}-`),
  );
  const instanceId = `instance-agent-${caseIdentity}`;
  const moduleId = "general-agent";
  const moduleGenerationId = `module-generation-${caseIdentity}-1`;
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
      nextBlockId: () => `block-${caseIdentity}-${++blockSequence}`,
      nextDeliveryId: (kind) => `${kind}-${caseIdentity}-${++deliverySequence}`,
      now: () => NOW,
    });
    core.deliveries.createPage("input");
    core.deliveries.createPage("output");
    core.deliveries.registerConsumer("input", moduleId, "from-now");
    core.deliveries.registerConsumer("output", "sink", "from-now");
    const repository = new FileModuleResultCommitRepository({
      path: join(conditionRoot, "module-result-commits.json"),
    });
    const toolJournalRepository = new FileToolJournalRepository({
      path: join(conditionRoot, "tool-rounds.json"),
    });
    const effectJournal = new EffectIntentJournal({
      store: new FileEffectIntentStore({
        path: join(conditionRoot, "effect-intents.json"),
      }),
      now: () => NOW,
    });
    const effectRunLifecycle = createExtensionEffectJournalLifecycle({
      journal: effectJournal,
      getModuleSubmissionRecord: (runId) => core.getModuleSubmissionRecord(runId),
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
      DATASET_DEFINITION.entries,
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
      externalEffectEvidence: effectIntentEvidenceSource(effectJournal),
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
          nextIdentifier: (purpose) => `${purpose}-${caseIdentity}-${++identifierSequence}`,
          effectRunLifecycle,
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
            configId: `config-${caseIdentity}`,
            revision: `sha256:${"b".repeat(64)}`,
            configVersion: 1,
          },
          declaredExternalEffects: "core-capabilities-only",
          serviceInvocationId:
            options.conditionId === "no-storage-tool"
              ? "1".repeat(32)
              : options.conditionId === "private-storage-tool"
                ? "2".repeat(32)
                : "3".repeat(32),
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
        const modelInvocationLimit = options.separatePlanningCall
          ? options.conditionId === "no-storage-tool"
            ? 2
            : 5
          : options.conditionId === "no-storage-tool"
            ? 1
            : 3;
        const modelOptions = {
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
          operations: options.separatePlanningCall
            ? (["chat", "describe"] as const)
            : (["chat"] as const),
          reasoningPolicies: ["require", "disable"],
          allowStreaming: true,
          requireStreaming: true,
          roles: ["system", "user"],
          limits: {
            maxInvocations: modelInvocationLimit,
            maxInvocationsPerRun: modelInvocationLimit,
            maxInvocationsPerWindow: modelInvocationLimit,
            rateWindowMs: 60_000,
          },
          maxConcurrentInvocations: 1,
          requireIdempotencyKey: true,
          nextRequestId: () =>
            `agent-${options.modelRequestIdBase}-model-request-${++modelRequestSequence}`,
        } as const;
        const modelDefinition = options.modelCapabilityVersion === 2
          ? createModelOperationCapabilityV2({
              ...modelOptions,
              outputContracts: options.separatePlanningCall
                ? ["text", "json-object"]
                : ["json-object"],
            })
          : createModelOperationCapability(modelOptions);
        extensionHost.grantCapability(modelDefinition.grant, modelDefinition.handler);
        if (options.conditionId === "private-storage-tool") {
          const storageDefinition = createModulePrivateStorageCapabilityV2({
            backend: storage,
            instanceId,
            moduleId,
            operations: ["list", "get"],
            executionScope: "active-run",
            expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            limits: {
              maxInvocations: 2,
              maxInvocationsPerRun: 2,
              maxListResults: 8,
            },
            maxConcurrentInvocations: 1,
            requireIdempotencyKey: true,
          });
          extensionHost.grantCapability(storageDefinition.grant, storageDefinition.handler);
        } else if (options.conditionId === "tool-registry-storage") {
          const descriptors = storageToolDescriptors();
          const registry = new ToolRegistry(
            descriptors,
            descriptors.map((descriptor) => descriptor.toolId),
          );
          const toolExecutor = createReadOnlyStorageToolExecutor({
            storage,
            instanceId,
            moduleId,
          });
          const toolDefinition = createToolInvocationCapabilityV2({
            executionScope: "active-run",
            expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            operations: ["list-tools", "execute-round"],
            limits: {
              maxInvocations: 3,
              maxInvocationsPerRun: 3,
              maxCallsPerRound: 1,
            },
            maxConcurrentInvocations: 1,
            resolveRun: ({ moduleJobId }) => ({
              registry,
              budget: STORAGE_TOOL_BUDGET,
              policy: new ToolPolicySession({
                moduleJobId,
                registry,
                repository: toolJournalRepository,
                approval: {
                  decide: async () => {
                    throw new Error("Read-only experiment tools must not request approval");
                  },
                },
                executor: toolExecutor,
                budget: STORAGE_TOOL_BUDGET,
                approvalPolicyRevision: "read-only-tools-v1",
              }),
            }),
          });
          extensionHost.grantCapability(toolDefinition.grant, toolDefinition.handler);
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
      mailbox: { maxResidentCount: 4, maxResidentBytes: 1024 * 1024 },
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
              text: DATASET_DEFINITION.task,
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
    const effectEvidence = effectJournal.evidenceForRun(committed);
    const reopenedEffectEvidence = new EffectIntentJournal({
      store: new FileEffectIntentStore({
        path: join(conditionRoot, "effect-intents.json"),
      }),
      now: () => NOW,
    }).evidenceForRun(committed);
    if (effectEvidence.kind !== "terminal" || reopenedEffectEvidence.kind !== "terminal") {
      throw new Error("Agent capability effects were not durably closed for the committed Run");
    }
    const effectArtifact = `effect-intents-${caseIdentity}.json`;
    const effectBytes = readFileSync(join(conditionRoot, "effect-intents.json"));
    writeFileSync(join(options.runDirectory, effectArtifact), effectBytes, {
      flag: "wx",
      mode: 0o600,
    });

    await host.stop();
    const childStopped = !processIsAlive(childPid);
    return {
      schemaVersion: "general-agent-live/case/1",
      conditionId: options.conditionId,
      evaluationSeed: options.evaluationSeed,
      repetition: options.repetition,
      result: result as unknown as JsonValue,
      schedulerCompletion,
      childPidRecorded: true,
      childStopped,
      linuxControlGroupProof: false,
      effectJournal: {
        artifact: effectArtifact,
        sha256: sha256(effectBytes),
        evidence: "terminal",
      },
      commit: {
        moduleJobId: committed.moduleJobId,
        claimToken: committed.claimToken,
        runId: committed.runId,
        attempt: committed.attempt,
        moduleGenerationId: committed.moduleGenerationId,
        blockId: committed.blockId,
        outputDeliveries: committed.outputDeliveries,
      },
    } as unknown as JsonValue;
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
  const experiment = parseArguments(process.argv.slice(2));
  const { artifactRoot, preregistrationPath, runId } = experiment;
  mkdirSync(resolve(workspaceRoot, ".tmp"), { recursive: true, mode: 0o700 });
  const preregistrationBytes = readFileSync(preregistrationPath);
  const protocolBytes = readFileSync(join(repositoryRoot, "docs/experiments/protocol.md"));
  const protocolSha256 = sha256(protocolBytes);
  let implementationSha256: Readonly<Record<string, string>> = {};
  let productionSourceSha256: Readonly<Record<string, string>> = {};
  if (experiment.experimentId.startsWith("general-agent-tool-registry-")) {
    const preregistration = JSON.parse(preregistrationBytes.toString("utf8")) as {
      protocol?: { sha256?: unknown };
      domainDesign?: { implementationFiles?: unknown; productionSourceFiles?: unknown };
    };
    if (preregistration.protocol?.sha256 !== protocolSha256) {
      throw new Error("experiment protocol bytes differ from the frozen preregistration");
    }
    const registeredFiles = preregistration.domainDesign?.implementationFiles;
    if (
      registeredFiles === null ||
      Array.isArray(registeredFiles) ||
      typeof registeredFiles !== "object"
    ) {
      throw new Error("experiment implementation file digests are absent");
    }
    const registeredPaths = Object.keys(registeredFiles).sort();
    if (
      JSON.stringify(registeredPaths) !==
      JSON.stringify([...REGISTRY_EXPERIMENT_IMPLEMENTATION_PATHS].sort())
    ) {
      throw new Error("experiment implementation file inventory is invalid");
    }
    implementationSha256 = Object.fromEntries(
      Object.entries(registeredFiles as Record<string, unknown>).map(([path, expected]) => {
        if (typeof expected !== "string" || !/^[0-9a-f]{64}$/u.test(expected)) {
          throw new Error(`experiment implementation digest is invalid for ${path}`);
        }
        const actual = sha256(readFileSync(join(repositoryRoot, path)));
        if (actual !== expected) {
          throw new Error(`experiment implementation bytes differ for ${path}`);
        }
        return [path, actual];
      }),
    );
    if (experiment.separatePlanningCall) {
      const productionFiles = preregistration.domainDesign?.productionSourceFiles;
      if (
        productionFiles === null ||
        Array.isArray(productionFiles) ||
        typeof productionFiles !== "object"
      ) {
        throw new Error("experiment production source digests are absent");
      }
      const registeredProductionPaths = Object.keys(productionFiles).sort();
      if (
        JSON.stringify(registeredProductionPaths) !==
        JSON.stringify([...REGISTRY_EXPERIMENT_PRODUCTION_PATHS].sort())
      ) {
        throw new Error("experiment production source inventory is invalid");
      }
      productionSourceSha256 = Object.fromEntries(
        Object.entries(productionFiles as Record<string, unknown>).map(([path, expected]) => {
          if (typeof expected !== "string" || !/^[0-9a-f]{64}$/u.test(expected)) {
            throw new Error(`experiment production source digest is invalid for ${path}`);
          }
          const actual = sha256(readFileSync(join(repositoryRoot, path)));
          if (actual !== expected) {
            throw new Error(`experiment production source bytes differ for ${path}`);
          }
          return [path, actual];
        }),
      );
    }
  }
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const dirtyWorktree =
    execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim().length > 0;
  const fixture = loadAetherEnvironment();
  const exactUrl = completionUrl(fixture.baseUrl);
  const host = exactUrl.hostname.replace(/^\[|\]$/gu, "");
  const networkScope = host === "127.0.0.1" || host === "::1" ? "loopback" : "public";
  const descriptors = new ModelDescriptorRegistry({
    schemaDigest: SCHEMA_DIGEST,
    allowedStrategyIds: CHAT_STRATEGIES,
  });
  descriptorRef = descriptors.register(
    descriptorDocument(experiment.modelCapabilityVersion === 2),
  );
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
  const providerResponseRows: JsonValue[] = [];
  const modelCallRows: JsonValue[] = [];

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
      const evidence = normalizeProviderEvidence(record);
      providerResponseRows.push(evidence);
      appendFileSync(providerResponsesPath, `${JSON.stringify(evidence)}\n`, "utf8");
    }),
    now: () => new Date().toISOString(),
  });
  const maximumProviderCalls = experiment.executionOrder.reduce(
    (total, plannedCase) =>
      total +
        (plannedCase.conditionId === "no-storage-tool"
          ? 1
          : experiment.separatePlanningCall
            ? 4
            : 3),
    0,
  );
  let providerCalls = 0;
  const observedBroker: ChatModelBrokerPort = {
    invoke: async (invocation, options) => {
      providerCalls += 1;
      if (providerCalls > maximumProviderCalls) {
        throw new Error("registered provider-call budget exceeded");
      }
      const startedAt = new Date().toISOString();
      const result = await broker.invoke(invocation, options);
      const completedAt = new Date().toISOString();
      const modelCall = safeModelCall(invocation, result, startedAt, completedAt);
      modelCallRows.push(modelCall);
      appendFileSync(
        modelCallsPath,
        `${JSON.stringify(modelCall)}\n`,
        "utf8",
      );
      return result;
    },
  };

  const startedAt = new Date().toISOString();
  let status: "completed" | "failed" = "completed";
  let failure: string | undefined;
  const caseRows: JsonValue[] = [];
  const perCaseAccounting: JsonValue[] = [];
  try {
    for (const plannedCase of experiment.executionOrder) {
      const modelCallsBeforeCase = modelCallRows.length;
      const providerResponsesBeforeCase = providerResponseRows.length;
      const caseRow = await runCondition({
        ...plannedCase,
        runDirectory,
        broker: observedBroker,
        modelCapabilityVersion: experiment.modelCapabilityVersion,
        separatePlanningCall: experiment.separatePlanningCall,
      });
      caseRows.push(caseRow);
      perCaseAccounting.push(caseAccounting({
        plannedCase,
        modelRows: modelCallRows.slice(modelCallsBeforeCase),
        providerRows: providerResponseRows.slice(providerResponsesBeforeCase),
      }));
      appendFileSync(casesPath, `${JSON.stringify(caseRow)}\n`, "utf8");
    }
  } catch (error) {
    status = "failed";
    failure = error instanceof Error ? error.message : "unknown failure";
  }
  const completedAt = new Date().toISOString();
  const rows = caseRows as unknown as readonly {
    conditionId?: string;
    effectJournal?: { artifact?: unknown; sha256?: unknown; evidence?: unknown };
    result?: {
      actions?: readonly string[];
      answer?: { answer?: unknown; grounded?: unknown; evidenceKeys?: unknown };
      reasoningObserved?: readonly boolean[];
    };
  }[];
  const baselineRows = rows.filter((row) => row.conditionId === "no-storage-tool");
  const treatmentRows = rows.filter((row) => row.conditionId !== "no-storage-tool");
  const expectedTreatmentActions =
    experiment.experimentId.startsWith("general-agent-tool-registry-")
      ? ["storage_list", "storage_get", "answer"]
      : ["storage.list", "storage.get", "answer"];
  const baselineHiddenCodenameRate =
    baselineRows.length === 0
      ? null
      : baselineRows.filter((row) =>
          JSON.stringify(row.result?.answer ?? null).includes(HIDDEN_CODENAME),
        ).length / baselineRows.length;
  const treatmentGroundedRecoveryRate =
    treatmentRows.length === 0
      ? null
      : treatmentRows.filter(
          (row) =>
            row.result?.answer?.grounded === true &&
            typeof row.result.answer.answer === "string" &&
            row.result.answer.answer.includes(HIDDEN_CODENAME) &&
            Array.isArray(row.result.answer.evidenceKeys) &&
            row.result.answer.evidenceKeys.includes("deployment-note"),
        ).length / treatmentRows.length;
  const exactToolSequenceRate =
    treatmentRows.length === 0
      ? null
      : treatmentRows.filter(
          (row) => JSON.stringify(row.result?.actions) === JSON.stringify(expectedTreatmentActions),
        ).length / treatmentRows.length;
  const reasoningObservationRate =
    treatmentRows.length === 0
      ? null
      : treatmentRows.filter((row) => row.result?.reasoningObserved?.[0] === true).length /
        treatmentRows.length;
  const aggregateMetrics = {
    pairedGroundedRecovery:
      treatmentGroundedRecoveryRate === null || baselineHiddenCodenameRate === null
        ? null
        : treatmentGroundedRecoveryRate - baselineHiddenCodenameRate,
    treatmentGroundedRecoveryRate,
    baselineHiddenCodenameRate,
    exactToolSequenceRate,
    reasoningObservationRate,
  };
  const analysis = {
    schemaVersion: "general-agent-tool-registry/analysis/1",
    experimentId: experiment.experimentId,
    experimentVersion: experiment.experimentVersion,
    runId,
    status,
    observedCases: caseRows.length,
    plannedCases: experiment.executionOrder.length,
    providerCalls,
    aggregateMetrics,
    provisionalClassification:
      status !== "completed"
        ? "inconclusive"
        : aggregateMetrics.pairedGroundedRecovery === 1 && exactToolSequenceRate === 1
          ? "candidate-supported-pending-independent-validation"
          : "candidate-rejected-pending-independent-validation",
    productBootstrapModulesRemainRejected: true,
    linuxControlGroupProof: false,
  };
  const analysisPath = join(runDirectory, "analysis.json");
  writeFileSync(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`, { flag: "wx" });
  const effectArtifacts = Object.fromEntries(rows.map((row) => {
    const artifact = row.effectJournal?.artifact;
    const digest = row.effectJournal?.sha256;
    if (
      typeof artifact !== "string" ||
      !/^effect-intents-[A-Za-z0-9._-]+\.json$/u.test(artifact) ||
      typeof digest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(digest) ||
      row.effectJournal?.evidence !== "terminal"
    ) {
      throw new Error("Completed Agent case has invalid effect-journal evidence");
    }
    return [artifact, digest];
  }));
  const rawOutputs = {
    providerResponsesSha256: sha256(readFileSync(providerResponsesPath)),
    modelCallsSha256: sha256(readFileSync(modelCallsPath)),
    casesSha256: sha256(readFileSync(casesPath)),
    analysisSha256: sha256(readFileSync(analysisPath)),
  };
  const manifest = {
    schemaVersion: "general-agent-live/run-manifest/1",
    experimentId: experiment.experimentId,
    experimentVersion: experiment.experimentVersion,
    protocolSha256,
    runId,
    status,
    failure: failure ?? null,
    startedAt,
    finishedAt: completedAt,
    completedAt,
    preregistrationSha256: sha256(preregistrationBytes),
    sourceCommit,
    dirtyWorktree,
    configuration: {
      conditionIds: [...new Set(experiment.executionOrder.map((entry) => entry.conditionId))],
      configuredStorageListLimit:
        experiment.experimentId.startsWith("general-agent-tool-registry-")
          ? STORAGE_TOOL_LIST_LIMIT
          : 8,
      productBootstrapComposition: false,
      implementationSha256,
      productionSourceSha256,
      modelCapabilityVersion: experiment.modelCapabilityVersion,
      separatePlanningCall: experiment.separatePlanningCall,
      modelOutputContracts: experiment.separatePlanningCall
        ? ["text", "json-object"]
        : experiment.modelCapabilityVersion === 2
          ? ["json-object"]
          : ["text"],
    },
    dataset: {
      id: "synthetic-private-memory-codename",
      version: "1",
      entriesPerCase: 2,
      contentSha256: sha256(JSON.stringify(DATASET_DEFINITION)),
    },
    modelEndpointCapabilityProfile: {
      networkScope,
      descriptorVersion: descriptorRef.descriptorVersion,
      operation: descriptorRef.operation,
      responseStrategyId: "aether.qwen.chat.response.v2",
      ...(experiment.modelCapabilityVersion === 2
        ? { jsonObjectOutputStrategyId: "openai.response-format.json-object.v1" }
        : {}),
      endpointAndCredentialRedacted: true,
    },
    modelIdentifier: "qwen3.6-27b",
    backend: {
      kind: "live",
      adapter: "openai-compatible-chat",
      silentFallbackAllowed: false,
    },
    sampling: {
      temperatureWire: "omitted",
      providerDefault: "unverified",
    },
    seeds: [...new Set(experiment.executionOrder.map((entry) => entry.evaluationSeed))],
    executionOrder: experiment.executionOrder.map((entry) => ({
      evaluationSeed: entry.evaluationSeed,
      repetition: entry.repetition,
      conditionId: entry.conditionId,
    })),
    resourceBudgets: {
      maximumCases: experiment.executionOrder.length,
      maximumProviderCalls,
      perModelCallTimeoutMs: 180_000,
      perCaseTimeoutMs: 420_000,
      maximumToolCapabilityInvocationsPerTreatment: 3,
      monetaryCostMeasured: false,
      monetaryBudgetEnforced: false,
    },
    perCaseAccounting,
    rawOutputs,
    validatorResults: {
      preregistrationStructure:
        experiment.experimentId.startsWith("general-agent-tool-registry-")
          ? "valid-before-run"
          : "legacy",
      independentValidation: "pending",
    },
    aggregateMetrics,
    providerCalls,
    secretLeasesReleased: secretReleases,
    model: "qwen3.6-27b",
    reasoningControl: "thinking.type",
    modelTransport: "experiment-bounded-fetch-no-redirect-v1",
    productBootstrapModulesRemainRejected: true,
    linuxControlGroupProof: false,
    proxyEnvironmentPresent: Boolean(process.env.http_proxy || process.env.https_proxy),
    artifacts: {
      "provider-responses.jsonl": rawOutputs.providerResponsesSha256,
      "model-calls.jsonl": rawOutputs.modelCallsSha256,
      "cases.jsonl": rawOutputs.casesSha256,
      "analysis.json": rawOutputs.analysisSha256,
      ...effectArtifacts,
    },
  };
  writeFileSync(
    join(runDirectory, "run-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  if (status !== "completed") throw new Error(failure ?? "live run failed");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
