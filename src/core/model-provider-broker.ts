import {
  canonicalJsonByteLength,
  canonicalJsonDigest,
  canonicalizeJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import type {
  EndpointBindingDocument,
  EndpointBindingRegistry,
} from "./model-provider-binding.js";
import {
  ModelChatError,
  decodeOpenAiCompatibleChatResponse,
  encodeOpenAiCompatibleChatRequest,
  mapReasoningPolicy,
  validateChatOutputContract,
  type ChatInput,
  type ChatOutput,
  type ReasoningPolicy,
} from "./model-provider-chat.js";
import {
  ModelDescriptorError,
  type DescriptorLimits,
  type DescriptorRef,
  type ModelDescriptorRegistry,
} from "./model-provider-descriptor.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface ModelInvocationContext {
  /** Stable upper-level operation identity that may span service calls and retries. */
  readonly operationId: string;
  readonly instanceId: string;
  readonly ownerScope: string;
  /** Stable identity of one configured Module. */
  readonly moduleId?: string;
  readonly moduleGenerationId?: string;
  readonly moduleJobId?: string;
  readonly runId?: string;
  /** Upper-level Module work retry number, not a provider dispatch count. */
  readonly attempt?: number;
  readonly sessionId?: string;
  readonly conversationId?: string;
  readonly backgroundJobId?: string;
  /** Caller-supplied stable key for provider duplicate suppression. */
  readonly idempotencyKey?: string;
  readonly deadline: string;
}

export interface ModelInvocationBudgets {
  readonly maxProviderAttempts: number;
  readonly maxWallTimeMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxInputItems: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxMediaItems?: number;
  readonly maxResolvedMediaBytes?: number;
  readonly maxCost?: { readonly currency: string; readonly decimalAmount: string };
}

export interface ChatBrokerInvocation {
  readonly schemaVersion: "dolly.model.chat-invocation/3";
  /** Unique identity of one Dolly provider-request-service call. */
  readonly requestId: string;
  readonly descriptor: DescriptorRef;
  readonly context: ModelInvocationContext;
  readonly budgets: ModelInvocationBudgets;
  readonly reasoningPolicy: ReasoningPolicy;
  readonly input: Omit<ChatInput, "reasoning">;
}

export type ModelErrorCode =
  | "INVALID_REQUEST"
  | "FEATURE_UNSUPPORTED"
  | "DESCRIPTOR_NOT_FOUND"
  | "DESCRIPTOR_DIGEST_MISMATCH"
  | "DESCRIPTOR_DISABLED"
  | "BINDING_UNAVAILABLE"
  | "BUDGET_EXCEEDED"
  | "AUTHENTICATION_FAILED"
  | "RATE_LIMITED"
  | "PROVIDER_REJECTED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_PROTOCOL_ERROR"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "DEADLINE_EXCEEDED"
  | "CANCELLED"
  | "INDETERMINATE_REMOTE_OUTCOME"
  | "REASONING_REQUIRED_NOT_OBSERVED"
  | "INTERNAL_ERROR";

export type RetryClass =
  | "never"
  | "same-snapshot-before-deadline"
  | "after-bounded-backoff"
  | "after-reconfiguration"
  | "indeterminate";

export interface ModelOperationError {
  readonly code: ModelErrorCode;
  readonly phase: "validation" | "dispatch" | "response" | "cleanup";
  readonly retryClass: RetryClass;
  readonly message: string;
  readonly retryAfterMs?: number;
}

export interface ModelUsage {
  /** Number of provider transport dispatches actually attempted by this service call. */
  readonly providerAttempts: number;
  readonly observations: readonly {
    readonly name: string;
    readonly state: "observed" | "unknown" | "unavailable";
    readonly source?: "provider" | "broker-estimate";
    readonly value?: number | string;
    readonly unit?: string;
  }[];
}

export type ChatBrokerResult =
  | {
      readonly schemaVersion: "dolly.model-result/2";
      readonly requestId: string;
      readonly operationId: string;
      /** Provider-issued request identity; omitted unless the provider returned a valid ID. */
      readonly providerRequestId?: string;
      readonly descriptor: DescriptorRef;
      readonly status: "succeeded";
      readonly output: ChatOutput;
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

export interface ModelSecretLease {
  readonly value: string;
  release(): void | Promise<void>;
}

export interface ModelSecretResolver {
  resolve(secretRef: string, secretRevision: string): Promise<ModelSecretLease>;
}

export interface ModelHttpTransportRequest {
  readonly url: URL;
  readonly networkScope: EndpointBindingDocument["networkScope"];
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly signal: AbortSignal;
}

export interface ModelHttpTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Provider-issued request identity, when the response contains one. */
  readonly providerRequestId?: string;
  readonly body: AsyncIterable<Uint8Array>;
  abort(reason?: Error): void;
}

export interface ModelHttpTransport {
  dispatch(request: ModelHttpTransportRequest): Promise<ModelHttpTransportResponse>;
}

export class ModelHttpTransportError extends Error {
  constructor(
    readonly outcome: "not-accepted" | "accepted-or-unknown",
    message = "Model transport failed",
  ) {
    super(message);
    this.name = "ModelHttpTransportError";
  }
}

export interface ChatModelBrokerOptions {
  readonly descriptors: ModelDescriptorRegistry;
  readonly bindings: EndpointBindingRegistry;
  readonly secrets: ModelSecretResolver;
  readonly transport: ModelHttpTransport;
  readonly now?: () => string;
}

export class ModelBrokerError extends Error {
  constructor(readonly code: "BROKER_REQUEST_INVALID", message: string) {
    super(message);
    this.name = "ModelBrokerError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function closed(value: unknown, keys: readonly string[], label: string): void {
  if (!isPlainObject(value)) throw new ModelBrokerError("BROKER_REQUEST_INVALID", `${label} invalid`);
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ModelBrokerError("BROKER_REQUEST_INVALID", `${label} contains unknown fields`);
  }
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new ModelBrokerError("BROKER_REQUEST_INVALID", `${label} is invalid`);
  }
  return value;
}

function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ModelBrokerError("BROKER_REQUEST_INVALID", `${label} is invalid`);
  }
  return value as number;
}

export function immutableError(
  code: ModelErrorCode,
  phase: ModelOperationError["phase"],
  retryClass: RetryClass,
  message: string,
  retryAfterMs?: number,
): ModelOperationError {
  return deepFreeze({
    code,
    phase,
    retryClass,
    message,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function usage(attempts: number, output?: ChatOutput): ModelUsage {
  return deepFreeze({
    providerAttempts: attempts,
    observations: [
      output === undefined
        ? { name: "provider-usage", state: "unavailable" as const }
        : {
            name: "reasoning",
            state: "observed" as const,
            source: "provider" as const,
            value: output.reasoning.state,
          },
    ],
  });
}

function failedResult(
  invocation: ChatBrokerInvocation,
  descriptor: DescriptorRef,
  error: ModelOperationError,
  attempts: number,
  providerRequestId?: string,
): ChatBrokerResult {
  return deepFreeze({
    schemaVersion: "dolly.model-result/2",
    requestId: invocation.requestId,
    operationId: invocation.context.operationId,
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
    descriptor,
    status: error.code === "CANCELLED" || error.code === "DEADLINE_EXCEEDED"
      ? "cancelled"
      : "failed",
    error,
    usage: usage(attempts),
  });
}

function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const lower = name.toLowerCase();
  const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === lower);
  return matches.length === 1 ? matches[0]![1] : undefined;
}

async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

class ModelHttpBodyError extends Error {
  constructor(readonly kind: "limit" | "protocol", message: string) {
    super(message);
    this.name = "ModelHttpBodyError";
  }
}

function abortResponseQuietly(
  response: ModelHttpTransportResponse,
  reason?: Error,
): void {
  try {
    response.abort(reason);
  } catch {
    // A cleanup failure never replaces the already-classified provider result.
  }
}

async function readBoundedBody(
  response: ModelHttpTransportResponse,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    for (;;) {
      const item = await awaitWithSignal(Promise.resolve(iterator.next()), signal);
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) {
        throw new ModelHttpBodyError(
          "protocol",
          "Provider transport returned a non-byte body",
        );
      }
      total += item.value.byteLength;
      if (total > maxBytes) {
        throw new ModelHttpBodyError(
          "limit",
          "Provider response exceeds its byte limit",
        );
      }
      chunks.push(Uint8Array.from(item.value));
    }
  } catch (error) {
    abortResponseQuietly(response, error instanceof Error ? error : undefined);
    throw error;
  } finally {
    try {
      await iterator.return?.();
    } catch {
      // The primary body result determines the caller-visible classification.
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export type BoundModelHttpResult =
  | {
      readonly status: "succeeded";
      readonly providerRequestId?: string;
      readonly attempts: 1;
      readonly responseBytes: Uint8Array;
    }
  | {
      readonly status: "failed" | "cancelled";
      readonly providerRequestId?: string;
      readonly attempts: 0 | 1;
      readonly error: ModelOperationError;
    };

export interface BoundModelHttpOptions {
  readonly binding: EndpointBindingDocument;
  readonly descriptorLimits: DescriptorLimits;
  readonly budgets: ModelInvocationBudgets;
  readonly deadline: string;
  readonly body: Uint8Array;
  readonly contentType: "application/json";
  readonly secrets: ModelSecretResolver;
  readonly transport: ModelHttpTransport;
  readonly now: () => string;
  readonly signal?: AbortSignal;
}

function boundHttpFailure(
  error: ModelOperationError,
  attempts: 0 | 1,
  providerRequestId?: string,
): BoundModelHttpResult {
  return deepFreeze({
    status:
      error.code === "CANCELLED" || error.code === "DEADLINE_EXCEEDED"
        ? "cancelled"
        : "failed",
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
    attempts,
    error,
  });
}

export async function executeBoundModelHttp(
  options: BoundModelHttpOptions,
): Promise<BoundModelHttpResult> {
  const { binding, descriptorLimits, budgets } = options;
  if (
    budgets.maxProviderAttempts < 1 ||
    options.body.byteLength > budgets.maxRequestBytes ||
    options.body.byteLength > descriptorLimits.maxRequestBytes ||
    options.body.byteLength > binding.limits.maxRequestBytes
  ) {
    return boundHttpFailure(
      immutableError("BUDGET_EXCEEDED", "validation", "never", "Invocation budget exceeded"),
      0,
    );
  }

  const nowMs = Date.parse(options.now());
  const deadlineMs = Date.parse(options.deadline);
  const timeoutMs = Math.floor(
    Math.min(
      budgets.maxWallTimeMs,
      descriptorLimits.maxProviderTimeoutMs,
      binding.limits.maxTimeoutMs,
      deadlineMs - nowMs,
      2_147_483_647,
    ),
  );
  if (!Number.isFinite(nowMs) || !Number.isFinite(deadlineMs) || timeoutMs <= 0) {
    return boundHttpFailure(
      immutableError(
        "DEADLINE_EXCEEDED",
        "validation",
        "never",
        "Invocation deadline elapsed",
      ),
      0,
    );
  }
  const maxResponseBytes = Math.min(
    budgets.maxResponseBytes,
    descriptorLimits.maxResponseBytes,
    binding.limits.maxResponseBytes,
  );

  const controller = new AbortController();
  let deadlineElapsed = false;
  const onParentAbort = () =>
    controller.abort(options.signal?.reason ?? new Error("cancelled"));
  options.signal?.addEventListener("abort", onParentAbort, { once: true });
  if (options.signal?.aborted) onParentAbort();
  const timer = setTimeout(() => {
    deadlineElapsed = true;
    controller.abort(new Error("deadline"));
  }, timeoutMs);

  let secretLease: ModelSecretLease | undefined;
  let response: ModelHttpTransportResponse | undefined;
  let dispatched = false;
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      "accept-encoding": "identity",
      "content-type": options.contentType,
    };
    if (binding.authentication.kind === "bearer-secret") {
      const secretPromise = options.secrets.resolve(
        binding.authentication.secretRef,
        binding.authentication.secretRevision,
      );
      try {
        secretLease = await awaitWithSignal(secretPromise, controller.signal);
      } catch {
        if (controller.signal.aborted) {
          void secretPromise
            .then((lateLease) => lateLease.release())
            .catch(() => undefined);
          return boundHttpFailure(
            immutableError(
              deadlineElapsed ? "DEADLINE_EXCEEDED" : "CANCELLED",
              "dispatch",
              "never",
              deadlineElapsed ? "Invocation deadline elapsed" : "Invocation cancelled",
            ),
            0,
          );
        }
        return boundHttpFailure(
          immutableError(
            "AUTHENTICATION_FAILED",
            "dispatch",
            "after-reconfiguration",
            "Provider authentication unavailable",
          ),
          0,
        );
      }
      if (
        typeof secretLease.value !== "string" ||
        secretLease.value.length === 0 ||
        Buffer.byteLength(secretLease.value, "utf8") > 16 * 1024 ||
        /[\r\n]/u.test(secretLease.value)
      ) {
        return boundHttpFailure(
          immutableError(
            "AUTHENTICATION_FAILED",
            "dispatch",
            "after-reconfiguration",
            "Provider authentication unavailable",
          ),
          0,
        );
      }
      headers.authorization = `Bearer ${secretLease.value}`;
    }
    if (controller.signal.aborted) {
      return boundHttpFailure(
        immutableError(
          deadlineElapsed ? "DEADLINE_EXCEEDED" : "CANCELLED",
          "dispatch",
          "never",
          deadlineElapsed ? "Invocation deadline elapsed" : "Invocation cancelled",
        ),
        0,
      );
    }

    dispatched = true;
    const dispatchPromise = options.transport.dispatch({
      url: new URL(binding.exactUrl),
      networkScope: binding.networkScope,
      method: "POST",
      headers: deepFreeze(headers),
      body: Uint8Array.from(options.body),
      timeoutMs,
      maxResponseBytes,
      signal: controller.signal,
    });
    try {
      response = await awaitWithSignal(dispatchPromise, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        void dispatchPromise
          .then((lateResponse) => abortResponseQuietly(lateResponse))
          .catch(() => undefined);
      }
      throw error;
    }
    const providerRequestId =
      typeof response.providerRequestId === "string" && ID_PATTERN.test(response.providerRequestId)
        ? response.providerRequestId
        : undefined;
    if (controller.signal.aborted) {
      abortResponseQuietly(response);
      return boundHttpFailure(
        immutableError(
          deadlineElapsed ? "DEADLINE_EXCEEDED" : "CANCELLED",
          "dispatch",
          "never",
          deadlineElapsed ? "Invocation deadline elapsed" : "Invocation cancelled",
        ),
        1,
        providerRequestId,
      );
    }
    if (
      !Number.isSafeInteger(response.status) ||
      response.status < 100 ||
      response.status > 599
    ) {
      abortResponseQuietly(response);
      return boundHttpFailure(
        immutableError(
          "PROVIDER_PROTOCOL_ERROR",
          "response",
          "never",
          "Provider response status is invalid",
        ),
        1,
        providerRequestId,
      );
    }
    if (response.status !== 200) {
      abortResponseQuietly(response);
      const retryAfter = header(response.headers, "retry-after");
      const retryAfterSeconds =
        retryAfter && /^\d+$/u.test(retryAfter) ? Number(retryAfter) : undefined;
      const retryAfterMs =
        retryAfterSeconds !== undefined && Number.isSafeInteger(retryAfterSeconds)
          ? Math.min(retryAfterSeconds * 1000, 86_400_000)
          : undefined;
      const code: ModelErrorCode =
        response.status === 401 || response.status === 403
          ? "AUTHENTICATION_FAILED"
          : response.status === 429
            ? "RATE_LIMITED"
            : response.status >= 500
              ? "PROVIDER_UNAVAILABLE"
              : "PROVIDER_REJECTED";
      const retryClass: RetryClass =
        response.status === 429 || response.status >= 500
          ? "after-bounded-backoff"
          : "never";
      return boundHttpFailure(
        immutableError(
          code,
          "response",
          retryClass,
          "Provider rejected the request",
          retryAfterMs,
        ),
        1,
        providerRequestId,
      );
    }
    const contentType = header(response.headers, "content-type");
    if (!contentType || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
      abortResponseQuietly(response);
      return boundHttpFailure(
        immutableError(
          "PROVIDER_PROTOCOL_ERROR",
          "response",
          "never",
          "Provider response content type is invalid",
        ),
        1,
        providerRequestId,
      );
    }
    const contentEncoding = header(response.headers, "content-encoding");
    if (contentEncoding !== undefined && contentEncoding.toLowerCase().trim() !== "identity") {
      abortResponseQuietly(response);
      return boundHttpFailure(
        immutableError(
          "PROVIDER_PROTOCOL_ERROR",
          "response",
          "never",
          "Compressed provider responses are not accepted by this HTTP transport",
        ),
        1,
        providerRequestId,
      );
    }
    try {
      const responseBytes = await readBoundedBody(response, maxResponseBytes, controller.signal);
      return Object.freeze({
        status: "succeeded",
        ...(providerRequestId === undefined ? {} : { providerRequestId }),
        attempts: 1,
        responseBytes,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return boundHttpFailure(
          immutableError(
            deadlineElapsed ? "DEADLINE_EXCEEDED" : "CANCELLED",
            "response",
            "never",
            deadlineElapsed ? "Invocation deadline elapsed" : "Invocation cancelled",
          ),
          1,
          providerRequestId,
        );
      }
      return boundHttpFailure(
        immutableError(
          error instanceof ModelHttpBodyError && error.kind === "limit"
            ? "OUTPUT_LIMIT_EXCEEDED"
            : error instanceof ModelHttpBodyError
              ? "PROVIDER_PROTOCOL_ERROR"
              : "INDETERMINATE_REMOTE_OUTCOME",
          "response",
          error instanceof ModelHttpBodyError ? "never" : "indeterminate",
          "Provider response could not be read",
        ),
        1,
        providerRequestId,
      );
    }
  } catch (error) {
    if (controller.signal.aborted) {
      if (response) abortResponseQuietly(response);
      return boundHttpFailure(
        immutableError(
          deadlineElapsed ? "DEADLINE_EXCEEDED" : "CANCELLED",
          dispatched ? "dispatch" : "validation",
          "never",
          deadlineElapsed ? "Invocation deadline elapsed" : "Invocation cancelled",
        ),
        dispatched ? 1 : 0,
      );
    }
    const indeterminate =
      !(error instanceof ModelHttpTransportError) || error.outcome === "accepted-or-unknown";
    return boundHttpFailure(
      immutableError(
        indeterminate ? "INDETERMINATE_REMOTE_OUTCOME" : "PROVIDER_UNAVAILABLE",
        "dispatch",
        indeterminate ? "indeterminate" : "same-snapshot-before-deadline",
        "Provider transport failed",
      ),
      dispatched ? 1 : 0,
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onParentAbort);
    if (secretLease) {
      try {
        void Promise.resolve(secretLease.release()).catch(() => undefined);
      } catch {
        // A cleanup failure never exposes secret-manager details to the caller.
      }
    }
  }
}

export function validateModelInvocationContext(value: ModelInvocationContext): void {
  closed(
    value,
    [
      "operationId",
      "instanceId",
      "ownerScope",
      "moduleId",
      "moduleGenerationId",
      "moduleJobId",
      "runId",
      "attempt",
      "sessionId",
      "conversationId",
      "backgroundJobId",
      "idempotencyKey",
      "deadline",
    ],
    "context",
  );
  id(value.operationId, "operationId");
  id(value.instanceId, "instanceId");
  id(value.ownerScope, "ownerScope");
  for (const [label, candidate] of Object.entries(value)) {
    if (
      label !== "deadline" &&
      label !== "attempt" &&
      candidate !== undefined &&
      label !== "operationId" &&
      label !== "instanceId" &&
      label !== "ownerScope"
    ) {
      id(candidate, label);
    }
  }
  if (value.attempt !== undefined) positive(value.attempt, "attempt");
  if (!Number.isFinite(Date.parse(value.deadline))) {
    throw new ModelBrokerError("BROKER_REQUEST_INVALID", "deadline is invalid");
  }
  const moduleFields = [
    value.moduleId,
    value.moduleGenerationId,
    value.moduleJobId,
    value.runId,
    value.attempt,
  ];
  if (
    moduleFields.some((candidate) => candidate !== undefined) &&
    moduleFields.some((candidate) => candidate === undefined)
  ) {
    throw new ModelBrokerError(
      "BROKER_REQUEST_INVALID",
      "Module invocations require complete generation and run identity",
    );
  }
}

export function validateModelInvocationBudgets(value: ModelInvocationBudgets): void {
  closed(
    value,
    [
      "maxProviderAttempts",
      "maxWallTimeMs",
      "maxRequestBytes",
      "maxResponseBytes",
      "maxInputItems",
      "maxInputBytes",
      "maxOutputBytes",
      "maxInputTokens",
      "maxOutputTokens",
      "maxMediaItems",
      "maxResolvedMediaBytes",
      "maxCost",
    ],
    "budgets",
  );
  for (const field of [
    "maxProviderAttempts",
    "maxWallTimeMs",
    "maxRequestBytes",
    "maxResponseBytes",
    "maxInputItems",
    "maxInputBytes",
    "maxOutputBytes",
  ] as const) {
    positive(value[field], field);
  }
  for (const field of [
    "maxInputTokens",
    "maxOutputTokens",
    "maxMediaItems",
    "maxResolvedMediaBytes",
  ] as const) {
    if (value[field] !== undefined) positive(value[field], field);
  }
  if (value.maxCost !== undefined) {
    throw new ModelBrokerError(
      "BROKER_REQUEST_INVALID",
      "This broker version cannot enforce monetary budgets",
    );
  }
}

function validateInvocation(invocation: ChatBrokerInvocation): void {
  closed(
    invocation,
    [
      "schemaVersion",
      "requestId",
      "descriptor",
      "context",
      "budgets",
      "reasoningPolicy",
      "input",
    ],
    "invocation",
  );
  if (invocation.schemaVersion !== "dolly.model.chat-invocation/3") {
    throw new ModelBrokerError("BROKER_REQUEST_INVALID", "Invocation schema is unsupported");
  }
  id(invocation.requestId, "requestId");
  validateModelInvocationContext(invocation.context);
  validateModelInvocationBudgets(invocation.budgets);
  if (
    invocation.reasoningPolicy !== "default" &&
    invocation.reasoningPolicy !== "prefer" &&
    invocation.reasoningPolicy !== "require" &&
    invocation.reasoningPolicy !== "disable"
  ) {
    throw new ModelBrokerError("BROKER_REQUEST_INVALID", "reasoningPolicy is invalid");
  }
}

export class ChatModelBroker {
  readonly #descriptors: ModelDescriptorRegistry;
  readonly #bindings: EndpointBindingRegistry;
  readonly #secrets: ModelSecretResolver;
  readonly #transport: ModelHttpTransport;
  readonly #now: () => string;

  constructor(options: ChatModelBrokerOptions) {
    this.#descriptors = options.descriptors;
    this.#bindings = options.bindings;
    this.#secrets = options.secrets;
    this.#transport = options.transport;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async invoke(
    invocation: ChatBrokerInvocation,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ChatBrokerResult> {
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

    if (invocation.input.stream) {
      return failedResult(
        invocation,
        descriptor,
        immutableError(
          "FEATURE_UNSUPPORTED",
          "validation",
          "never",
          "Streaming transport is not implemented by this broker version",
        ),
        0,
      );
    }

    let plan;
    let decision;
    try {
      decision = mapReasoningPolicy(
        descriptorSnapshot.document.features.reasoning,
        invocation.reasoningPolicy,
        "non-stream",
      );
      plan = encodeOpenAiCompatibleChatRequest(
        descriptorSnapshot,
        { ...invocation.input, reasoning: decision.directive },
        {
          maxOutputTokens:
            invocation.budgets.maxOutputTokens === undefined
              ? undefined
              : descriptorSnapshot.document.features.maxOutputTokens.state === "supported"
                ? Math.min(
                    invocation.budgets.maxOutputTokens,
                    descriptorSnapshot.document.features.maxOutputTokens.value.maximum,
                  )
                : invocation.budgets.maxOutputTokens,
        },
      );
    } catch (error) {
      const code =
        error instanceof ModelChatError && error.code === "CHAT_LIMIT_EXCEEDED"
          ? "BUDGET_EXCEEDED"
          : error instanceof ModelChatError && error.code === "CHAT_FEATURE_UNSUPPORTED"
            ? "FEATURE_UNSUPPORTED"
            : "INVALID_REQUEST";
      return failedResult(
        invocation,
        descriptor,
        immutableError(code, "validation", "never", "Model request validation failed"),
        0,
      );
    }

    const binding = bindingSnapshot.document;
    const inputBytes = canonicalJsonByteLength(invocation.input);
    const inputItems = invocation.input.messages.length;
    if (
      invocation.budgets.maxProviderAttempts < 1 ||
      plan.bodyBytes > invocation.budgets.maxRequestBytes ||
      plan.bodyBytes > binding.limits.maxRequestBytes ||
      inputBytes > invocation.budgets.maxInputBytes ||
      inputItems > invocation.budgets.maxInputItems
    ) {
      return failedResult(
        invocation,
        descriptor,
        immutableError("BUDGET_EXCEEDED", "validation", "never", "Invocation budget exceeded"),
        0,
      );
    }
    const transportResult = await executeBoundModelHttp({
      binding,
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
      const output = decodeOpenAiCompatibleChatResponse(
        descriptorSnapshot,
        transportResult.responseBytes,
        decision,
      );
      validateChatOutputContract(output, invocation.input.outputContract);
      if (canonicalJsonByteLength(output) > invocation.budgets.maxOutputBytes) {
        return failedResult(
          invocation,
          descriptor,
          immutableError(
            "OUTPUT_LIMIT_EXCEEDED",
            "response",
            "never",
            "Normalized provider output exceeds its budget",
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
      return failedResult(
        invocation,
        descriptor,
        immutableError(
          error instanceof ModelChatError &&
            error.code === "REASONING_REQUIRED_NOT_OBSERVED"
            ? "REASONING_REQUIRED_NOT_OBSERVED"
            : error instanceof ModelChatError && error.code === "CHAT_LIMIT_EXCEEDED"
              ? "OUTPUT_LIMIT_EXCEEDED"
              : "PROVIDER_PROTOCOL_ERROR",
          "response",
          "never",
          "Provider response validation failed",
        ),
        transportResult.attempts,
        transportResult.providerRequestId,
      );
    }
  }
}

export function modelInvocationDigest(invocation: ChatBrokerInvocation): string {
  return canonicalJsonDigest(invocation);
}
