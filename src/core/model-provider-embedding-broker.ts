import {
  canonicalJsonByteLength,
  canonicalJsonDigest,
  canonicalizeJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import type { EndpointBindingRegistry } from "./model-provider-binding.js";
import {
  ModelBrokerError,
  executeBoundModelHttp,
  immutableError,
  validateModelInvocationBudgets,
  validateModelInvocationContext,
  type ModelHttpTransport,
  type ModelInvocationBudgets,
  type ModelInvocationContext,
  type ModelOperationError,
  type ModelSecretResolver,
  type ModelUsage,
} from "./model-provider-broker.js";
import {
  EmbeddingDescriptorRegistry,
  ModelEmbeddingError,
  decodeOpenAiCompatibleEmbeddingResponse,
  encodeOpenAiCompatibleTextEmbeddingRequest,
  type EmbeddingInput,
  type EmbeddingOutput,
} from "./model-provider-embedding.js";
import {
  ModelDescriptorError,
  type DescriptorRef,
} from "./model-provider-descriptor.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface EmbeddingBrokerInvocation {
  readonly schemaVersion: "dolly.model.embedding-invocation/3";
  /** Unique identity of one Dolly provider-request-service call. */
  readonly requestId: string;
  readonly descriptor: DescriptorRef;
  readonly context: ModelInvocationContext;
  readonly budgets: ModelInvocationBudgets;
  readonly input: EmbeddingInput;
}

export type EmbeddingBrokerResult =
  | {
      readonly schemaVersion: "dolly.model-result/2";
      readonly requestId: string;
      readonly operationId: string;
      /** Provider-issued request identity; omitted unless the provider returned a valid ID. */
      readonly providerRequestId?: string;
      readonly descriptor: DescriptorRef;
      readonly status: "succeeded";
      readonly output: EmbeddingOutput;
      readonly usage: ModelUsage;
    }
  | {
      readonly schemaVersion: "dolly.model-result/2";
      readonly requestId: string;
      readonly operationId: string;
      /** Provider-issued request identity; omitted unless the provider returned a valid ID. */
      readonly providerRequestId?: string;
      readonly descriptor: DescriptorRef;
      readonly status: "failed" | "cancelled";
      readonly error: ModelOperationError;
      readonly usage: ModelUsage;
    };

export interface EmbeddingModelBrokerOptions {
  readonly descriptors: EmbeddingDescriptorRegistry;
  readonly bindings: EndpointBindingRegistry;
  readonly secrets: ModelSecretResolver;
  readonly transport: ModelHttpTransport;
  readonly now?: () => string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function closed(value: unknown, keys: readonly string[], label: string): void {
  if (!isPlainObject(value)) {
    throw new ModelBrokerError("BROKER_REQUEST_INVALID", `${label} is invalid`);
  }
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ModelBrokerError("BROKER_REQUEST_INVALID", `${label} contains unknown fields`);
  }
}

function validateInvocation(invocation: EmbeddingBrokerInvocation): void {
  closed(
    invocation,
    ["schemaVersion", "requestId", "descriptor", "context", "budgets", "input"],
    "invocation",
  );
  if (invocation.schemaVersion !== "dolly.model.embedding-invocation/3") {
    throw new ModelBrokerError("BROKER_REQUEST_INVALID", "Invocation schema is unsupported");
  }
  if (typeof invocation.requestId !== "string" || !ID_PATTERN.test(invocation.requestId)) {
    throw new ModelBrokerError("BROKER_REQUEST_INVALID", "requestId is invalid");
  }
  validateModelInvocationContext(invocation.context);
  validateModelInvocationBudgets(invocation.budgets);
  if (invocation.budgets.maxInputTokens !== undefined) {
    throw new ModelBrokerError(
      "BROKER_REQUEST_INVALID",
      "This embedding broker version cannot enforce token budgets",
    );
  }
}

function usage(attempts: number, output?: EmbeddingOutput): ModelUsage {
  return deepFreeze({
    providerAttempts: attempts,
    observations:
      output === undefined
        ? [{ name: "provider-usage", state: "unavailable" as const }]
        : [
            {
              name: "embedding-items",
              state: "observed" as const,
              source: "broker-estimate" as const,
              value: output.items.length,
              unit: "items",
            },
          ],
  });
}

function failedResult(
  invocation: EmbeddingBrokerInvocation,
  descriptor: DescriptorRef,
  error: ModelOperationError,
  attempts: number,
  providerRequestId?: string,
): EmbeddingBrokerResult {
  return deepFreeze({
    schemaVersion: "dolly.model-result/2",
    requestId: invocation.requestId,
    operationId: invocation.context.operationId,
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
    descriptor,
    status:
      error.code === "CANCELLED" || error.code === "DEADLINE_EXCEEDED"
        ? "cancelled"
        : "failed",
    error,
    usage: usage(attempts),
  });
}

export class EmbeddingModelBroker {
  readonly #descriptors: EmbeddingDescriptorRegistry;
  readonly #bindings: EndpointBindingRegistry;
  readonly #secrets: ModelSecretResolver;
  readonly #transport: ModelHttpTransport;
  readonly #now: () => string;

  constructor(options: EmbeddingModelBrokerOptions) {
    this.#descriptors = options.descriptors;
    this.#bindings = options.bindings;
    this.#secrets = options.secrets;
    this.#transport = options.transport;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async invoke(
    invocation: EmbeddingBrokerInvocation,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<EmbeddingBrokerResult> {
    validateInvocation(invocation);
    let descriptorSnapshot;
    try {
      descriptorSnapshot = this.#descriptors.snapshot(invocation.descriptor);
    } catch (error) {
      const code =
        error instanceof ModelDescriptorError && error.code === "DESCRIPTOR_DIGEST_MISMATCH"
          ? "DESCRIPTOR_DIGEST_MISMATCH"
          : error instanceof ModelDescriptorError && error.code === "DESCRIPTOR_DISABLED"
            ? "DESCRIPTOR_DISABLED"
            : "DESCRIPTOR_NOT_FOUND";
      return failedResult(
        invocation,
        invocation.descriptor,
        immutableError(code, "validation", "after-reconfiguration", "Descriptor unavailable"),
        0,
      );
    }
    const descriptor = descriptorSnapshot.ref;

    let plan;
    try {
      plan = encodeOpenAiCompatibleTextEmbeddingRequest(
        descriptorSnapshot,
        invocation.input,
      );
    } catch (error) {
      const code =
        error instanceof ModelEmbeddingError && error.code === "EMBEDDING_LIMIT_EXCEEDED"
          ? "BUDGET_EXCEEDED"
          : error instanceof ModelEmbeddingError &&
              (error.code === "EMBEDDING_FEATURE_UNSUPPORTED" ||
                error.code === "EMBEDDING_STRATEGY_UNSUPPORTED")
            ? "FEATURE_UNSUPPORTED"
            : "INVALID_REQUEST";
      return failedResult(
        invocation,
        descriptor,
        immutableError(code, "validation", "never", "Embedding request validation failed"),
        0,
      );
    }

    let inputBytes: number;
    try {
      inputBytes = canonicalJsonByteLength(invocation.input);
    } catch {
      return failedResult(
        invocation,
        descriptor,
        immutableError("INVALID_REQUEST", "validation", "never", "Embedding input is invalid"),
        0,
      );
    }
    if (
      inputBytes > invocation.budgets.maxInputBytes ||
      invocation.input.items.length > invocation.budgets.maxInputItems ||
      plan.bodyBytes > invocation.budgets.maxRequestBytes
    ) {
      return failedResult(
        invocation,
        descriptor,
        immutableError("BUDGET_EXCEEDED", "validation", "never", "Invocation budget exceeded"),
        0,
      );
    }

    let bindingSnapshot;
    try {
      bindingSnapshot = this.#bindings.snapshot(descriptor);
    } catch {
      return failedResult(
        invocation,
        descriptor,
        immutableError(
          "BINDING_UNAVAILABLE",
          "validation",
          "after-reconfiguration",
          "Endpoint binding unavailable",
        ),
        0,
      );
    }

    const transportResult = await executeBoundModelHttp({
      binding: bindingSnapshot.document,
      descriptorLimits: descriptorSnapshot.document.limits,
      budgets: invocation.budgets,
      deadline: invocation.context.deadline,
      body: Buffer.from(canonicalizeJson(plan.body), "utf8"),
      contentType: plan.contentType,
      secrets: this.#secrets,
      transport: this.#transport,
      now: this.#now,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (transportResult.status !== "succeeded") {
      return failedResult(
        invocation,
        descriptor,
        transportResult.error,
        transportResult.attempts,
        transportResult.providerRequestId,
      );
    }

    try {
      const output = decodeOpenAiCompatibleEmbeddingResponse(
        descriptorSnapshot,
        invocation.input,
        transportResult.responseBytes,
      );
      if (canonicalJsonByteLength(output) > invocation.budgets.maxOutputBytes) {
        return failedResult(
          invocation,
          descriptor,
          immutableError(
            "OUTPUT_LIMIT_EXCEEDED",
            "response",
            "never",
            "Normalized embedding output exceeds its budget",
          ),
          transportResult.attempts,
          transportResult.providerRequestId,
        );
      }
      return deepFreeze({
        schemaVersion: "dolly.model-result/2",
        requestId: invocation.requestId,
        operationId: invocation.context.operationId,
        ...(transportResult.providerRequestId === undefined
          ? {}
          : { providerRequestId: transportResult.providerRequestId }),
        descriptor,
        status: "succeeded",
        output,
        usage: usage(transportResult.attempts, output),
      });
    } catch (error) {
      const outputLimit =
        error instanceof ModelEmbeddingError && error.code === "EMBEDDING_LIMIT_EXCEEDED";
      return failedResult(
        invocation,
        descriptor,
        immutableError(
          outputLimit ? "OUTPUT_LIMIT_EXCEEDED" : "PROVIDER_PROTOCOL_ERROR",
          "response",
          "never",
          "Embedding provider response validation failed",
        ),
        transportResult.attempts,
        transportResult.providerRequestId,
      );
    }
  }
}

export function embeddingInvocationDigest(invocation: EmbeddingBrokerInvocation): string {
  return canonicalJsonDigest(invocation as unknown as JsonValue);
}
