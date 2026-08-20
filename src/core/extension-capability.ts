import { randomBytes } from "node:crypto";
import {
  assertJsonValue,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import { isVersion19ProcessGenerationId } from "./linux-identifier-formats.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const TRACK_IN_FLIGHT_INVOCATION = Symbol("trackInFlightInvocation");
const REVOKE_CAPABILITY_SESSION = Symbol("revokeCapabilitySession");

export interface ExtensionSessionIdentity {
  readonly extensionId: string;
  readonly instanceId: string;
  readonly processGenerationId: string;
  readonly sessionId: string;
  readonly moduleId: string;
  readonly moduleGenerationId: string;
}

export interface ExtensionCapabilityHandle {
  readonly schemaVersion: "dolly.capability-handle/1";
  readonly handle: string;
}

export interface ExtensionExecutionScope {
  readonly moduleJobId: string;
  readonly runId: string;
}

export interface ExtensionCapabilityGrant {
  readonly capabilityType: string;
  readonly capabilityVersion: string;
  readonly operations: readonly string[];
  readonly resourceScope: JsonValue;
  readonly expiresAt: string;
  readonly maxInvocations: number;
  /** Maximum distinct invocations this handle may accept for one active Run. */
  readonly maxInvocationsPerRun?: number;
  readonly maxConcurrentInvocations: number;
  readonly maxArgumentBytes: number;
  readonly maxResultBytes: number;
  readonly executionScope?: ExtensionExecutionScope;
  readonly requireIdempotencyKey?: boolean;
}

export type ExtensionCapabilityRunCapacity =
  | {
      readonly status: "admitted";
      readonly deadline: string;
    }
  | {
      readonly status: "rotation-required";
      readonly reason:
        | "capability-revoked"
        | "capability-expiry-insufficient"
        | "capability-quota-insufficient";
    };

export interface ExtensionCapabilityInvocation {
  readonly handle: ExtensionCapabilityHandle;
  readonly operation: string;
  readonly arguments: JsonValue;
  readonly moduleJobId?: string;
  readonly runId?: string;
  /** Host-verified attempt number for the active Run; never extension authority. */
  readonly attempt?: number;
  /** Host-verified absolute deadline for the active Run. */
  readonly deadline?: string;
  readonly idempotencyKey?: string;
}

export interface ExtensionCapabilityInvocationContext {
  readonly identity: ExtensionSessionIdentity;
  readonly capabilityType: string;
  readonly capabilityVersion: string;
  readonly operation: string;
  readonly resourceScope: JsonValue;
  readonly moduleJobId?: string;
  readonly runId?: string;
  readonly attempt?: number;
  readonly deadline?: string;
  readonly idempotencyKey?: string;
  readonly signal: AbortSignal;
}

export type ExtensionCapabilityHandler = (
  argumentsValue: JsonValue,
  context: ExtensionCapabilityInvocationContext,
) => Promise<JsonValue> | JsonValue;

export type ExtensionCapabilityErrorCode =
  | "CAPABILITY_CONFIG_INVALID"
  | "CAPABILITY_SESSION_CONFLICT"
  | "CAPABILITY_SESSION_CLOSED"
  | "CAPABILITY_DENIED"
  | "CAPABILITY_REVOKED"
  | "CAPABILITY_EXPIRED"
  | "CAPABILITY_SCOPE_MISMATCH"
  | "CAPABILITY_QUOTA_EXCEEDED"
  | "CAPABILITY_ARGUMENT_INVALID"
  | "CAPABILITY_RESULT_INVALID"
  | "CAPABILITY_DEPENDENCY_FAILED";

export class ExtensionCapabilityError extends Error {
  constructor(
    readonly code: ExtensionCapabilityErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "ExtensionCapabilityError";
  }
}

const PREFLIGHT_REFUSALS = new WeakSet<ExtensionCapabilityError>();

/**
 * True only for an authority refusal raised before a capability handler was
 * entered. The marker is process-local and cannot be forged by an Extension
 * or by a handler constructing an error with the same public fields.
 */
export function isExtensionCapabilityPreflightRefusal(
  error: unknown,
): error is ExtensionCapabilityError {
  return error instanceof ExtensionCapabilityError && PREFLIGHT_REFUSALS.has(error);
}

interface CapabilityRecord {
  readonly handle: string;
  readonly sessionId: string;
  readonly grant: ExtensionCapabilityGrant;
  readonly handler: ExtensionCapabilityHandler;
  readonly effects: Map<string, { digest: string; promise: Promise<JsonValue> }>;
  readonly runInvocations: Map<string, number>;
  invocations: number;
  concurrent: number;
  revoked: boolean;
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new ExtensionCapabilityError(
      "CAPABILITY_CONFIG_INVALID",
      `${label} is not a valid identifier`,
    );
  }
}

function canonicalTime(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new ExtensionCapabilityError(
      "CAPABILITY_CONFIG_INVALID",
      `${label} is not a valid timestamp`,
    );
  }
  return new Date(timestamp).toISOString();
}

function assertPositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ExtensionCapabilityError(
      "CAPABILITY_CONFIG_INVALID",
      `${label} must be a positive safe integer`,
    );
  }
}

function immutableJson<T extends JsonValue>(value: T): T {
  assertJsonValue(value);
  return deepFreeze(cloneJson(value)) as T;
}

function immutableIdentity(identity: ExtensionSessionIdentity): ExtensionSessionIdentity {
  assertId(identity.extensionId, "extensionId");
  assertId(identity.instanceId, "instanceId");
  if (
    typeof identity.processGenerationId !== "string" ||
    (!ID_PATTERN.test(identity.processGenerationId) &&
      !isVersion19ProcessGenerationId(identity.processGenerationId))
  ) {
    throw new ExtensionCapabilityError(
      "CAPABILITY_CONFIG_INVALID",
      "processGenerationId is not a valid identifier",
    );
  }
  assertId(identity.sessionId, "sessionId");
  assertId(identity.moduleId, "moduleId");
  assertId(identity.moduleGenerationId, "moduleGenerationId");
  return deepFreeze({ ...identity }) as ExtensionSessionIdentity;
}

function immutableGrant(
  grant: ExtensionCapabilityGrant,
  now: () => string,
): ExtensionCapabilityGrant {
  assertId(grant.capabilityType, "capabilityType");
  assertId(grant.capabilityVersion, "capabilityVersion");
  if (
    !Array.isArray(grant.operations) ||
    grant.operations.length === 0 ||
    grant.operations.length > 64
  ) {
    throw new ExtensionCapabilityError(
      "CAPABILITY_CONFIG_INVALID",
      "Capability operations must contain between 1 and 64 entries",
    );
  }
  const operations = [...grant.operations];
  for (const operation of operations) assertId(operation, "operation");
  if (new Set(operations).size !== operations.length) {
    throw new ExtensionCapabilityError(
      "CAPABILITY_CONFIG_INVALID",
      "Capability operations must be unique",
    );
  }
  assertPositive(grant.maxInvocations, "maxInvocations");
  if (grant.maxInvocationsPerRun !== undefined) {
    assertPositive(grant.maxInvocationsPerRun, "maxInvocationsPerRun");
    if (grant.maxInvocationsPerRun > grant.maxInvocations) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_CONFIG_INVALID",
        "maxInvocationsPerRun cannot exceed maxInvocations",
      );
    }
  }
  assertPositive(grant.maxConcurrentInvocations, "maxConcurrentInvocations");
  assertPositive(grant.maxArgumentBytes, "maxArgumentBytes");
  assertPositive(grant.maxResultBytes, "maxResultBytes");
  const expiresAt = canonicalTime(grant.expiresAt, "expiresAt");
  const nowMs = Date.parse(canonicalTime(now(), "clock"));
  if (Date.parse(expiresAt) <= nowMs) {
    throw new ExtensionCapabilityError(
      "CAPABILITY_CONFIG_INVALID",
      "Capability expiry must be in the future",
    );
  }
  const resourceScope = immutableJson(grant.resourceScope);
  let executionScope: ExtensionExecutionScope | undefined;
  if (grant.executionScope) {
    assertId(grant.executionScope.moduleJobId, "moduleJobId");
    assertId(grant.executionScope.runId, "runId");
    executionScope = deepFreeze({ ...grant.executionScope });
  }
  return deepFreeze({
    capabilityType: grant.capabilityType,
    capabilityVersion: grant.capabilityVersion,
    operations,
    resourceScope,
    expiresAt,
    maxInvocations: grant.maxInvocations,
    ...(grant.maxInvocationsPerRun === undefined
      ? {}
      : { maxInvocationsPerRun: grant.maxInvocationsPerRun }),
    maxConcurrentInvocations: grant.maxConcurrentInvocations,
    maxArgumentBytes: grant.maxArgumentBytes,
    maxResultBytes: grant.maxResultBytes,
    ...(executionScope === undefined ? {} : { executionScope }),
    ...(grant.requireIdempotencyKey === true ? { requireIdempotencyKey: true } : {}),
  }) as ExtensionCapabilityGrant;
}

export interface ExtensionCapabilityAuthorityOptions {
  readonly now: () => string;
  readonly nextHandle?: () => string;
  readonly maxSessions?: number;
  readonly maxCapabilitiesPerSession?: number;
}

export class ExtensionCapabilityAuthority {
  readonly #now: () => string;
  readonly #nextHandle: () => string;
  readonly #maxSessions: number;
  readonly #maxCapabilitiesPerSession: number;
  readonly #sessions = new Map<string, ExtensionCapabilitySession>();
  readonly #usedSessionIds = new Set<string>();
  readonly #records = new Map<string, CapabilityRecord>();

  constructor(options: ExtensionCapabilityAuthorityOptions) {
    this.#now = options.now;
    this.#nextHandle = options.nextHandle ?? (() => randomBytes(32).toString("base64url"));
    this.#maxSessions = options.maxSessions ?? 1_024;
    this.#maxCapabilitiesPerSession = options.maxCapabilitiesPerSession ?? 256;
    assertPositive(this.#maxSessions, "maxSessions");
    assertPositive(this.#maxCapabilitiesPerSession, "maxCapabilitiesPerSession");
    canonicalTime(this.#now(), "clock");
  }

  openSession(identityValue: ExtensionSessionIdentity): ExtensionCapabilitySession {
    const identity = immutableIdentity(identityValue);
    if (this.#usedSessionIds.has(identity.sessionId)) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_SESSION_CONFLICT",
        "Extension session identity is already active",
      );
    }
    if (this.#sessions.size >= this.#maxSessions) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_QUOTA_EXCEEDED",
        "Extension session limit reached",
      );
    }
    const session = new ExtensionCapabilitySession(this, identity);
    this.#sessions.set(identity.sessionId, session);
    this.#usedSessionIds.add(identity.sessionId);
    return session;
  }

  issue(
    session: ExtensionCapabilitySession,
    grantValue: ExtensionCapabilityGrant,
    handler: ExtensionCapabilityHandler,
  ): ExtensionCapabilityHandle {
    this.#assertActiveSession(session);
    const sessionRecords = [...this.#records.values()].filter(
      (record) => record.sessionId === session.identity.sessionId,
    );
    if (sessionRecords.length >= this.#maxCapabilitiesPerSession) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_QUOTA_EXCEEDED",
        "Capability limit reached for this session",
      );
    }
    const grant = immutableGrant(grantValue, this.#now);
    const handle = this.#nextHandle();
    if (!HANDLE_PATTERN.test(handle) || this.#records.has(handle)) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_CONFIG_INVALID",
        "Capability handle source returned an invalid or duplicate value",
      );
    }
    this.#records.set(handle, {
      handle,
      sessionId: session.identity.sessionId,
      grant,
      handler,
      effects: new Map(),
      runInvocations: new Map(),
      invocations: 0,
      concurrent: 0,
      revoked: false,
    });
    return deepFreeze({
      schemaVersion: "dolly.capability-handle/1" as const,
      handle,
    });
  }

  revoke(session: ExtensionCapabilitySession, handle: ExtensionCapabilityHandle): "revoked" | "absent" {
    this.#assertActiveSession(session);
    const record = this.#recordFor(session, handle, false);
    if (!record) return "absent";
    record.revoked = true;
    return "revoked";
  }

  async invoke(
    session: ExtensionCapabilitySession,
    invocation: ExtensionCapabilityInvocation,
  ): Promise<JsonValue> {
    try {
      return this.#prepareAndInvoke(session, invocation);
    } catch (error) {
      if (error instanceof ExtensionCapabilityError) PREFLIGHT_REFUSALS.add(error);
      throw error;
    }
  }

  inspectRunCapacity(
    session: ExtensionCapabilitySession,
    deadlineValue: string,
  ): ExtensionCapabilityRunCapacity {
    this.#assertActiveSession(session);
    const deadline = canonicalTime(deadlineValue, "deadline");
    const nowMs = Date.parse(canonicalTime(this.#now(), "clock"));
    const deadlineMs = Date.parse(deadline);
    if (deadlineMs <= nowMs) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_CONFIG_INVALID",
        "Run admission deadline must be in the future",
      );
    }
    const records = [...this.#records.values()].filter(
      (record) => record.sessionId === session.identity.sessionId,
    );
    if (records.some((record) => record.revoked)) {
      return Object.freeze({
        status: "rotation-required",
        reason: "capability-revoked",
      } as const);
    }
    if (records.some((record) => Date.parse(record.grant.expiresAt) <= deadlineMs)) {
      return Object.freeze({
        status: "rotation-required",
        reason: "capability-expiry-insufficient",
      } as const);
    }
    if (records.some((record) =>
      record.grant.maxInvocationsPerRun !== undefined &&
      record.grant.maxInvocations - record.invocations < record.grant.maxInvocationsPerRun
    )) {
      return Object.freeze({
        status: "rotation-required",
        reason: "capability-quota-insufficient",
      } as const);
    }
    return Object.freeze({ status: "admitted", deadline });
  }

  #prepareAndInvoke(
    session: ExtensionCapabilitySession,
    invocation: ExtensionCapabilityInvocation,
  ): Promise<JsonValue> {
    this.#assertActiveSession(session);
    const record = this.#recordFor(session, invocation.handle, true)!;
    if (record.revoked) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_REVOKED",
        "Capability has been revoked",
      );
    }
    const invocationNowMs = Date.parse(canonicalTime(this.#now(), "clock"));
    if (invocationNowMs >= Date.parse(record.grant.expiresAt)) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_EXPIRED",
        "Capability has expired",
      );
    }
    assertId(invocation.operation, "operation");
    if (!record.grant.operations.includes(invocation.operation)) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_DENIED",
        "Capability does not authorize this operation",
      );
    }
    if (record.grant.executionScope) {
      if (
        invocation.moduleJobId !== record.grant.executionScope.moduleJobId ||
        invocation.runId !== record.grant.executionScope.runId
      ) {
        throw new ExtensionCapabilityError(
          "CAPABILITY_SCOPE_MISMATCH",
          "Capability is not valid for this execution",
        );
      }
    } else if (invocation.moduleJobId !== undefined || invocation.runId !== undefined) {
      if (invocation.moduleJobId !== undefined) assertId(invocation.moduleJobId, "moduleJobId");
      if (invocation.runId !== undefined) assertId(invocation.runId, "runId");
    }
    if (invocation.attempt !== undefined) {
      if (
        invocation.moduleJobId === undefined ||
        invocation.runId === undefined ||
        !Number.isSafeInteger(invocation.attempt) ||
        invocation.attempt <= 0
      ) {
        throw new ExtensionCapabilityError(
          "CAPABILITY_SCOPE_MISMATCH",
          "Capability attempt does not identify a valid active Run",
        );
      }
    }
    if (invocation.deadline !== undefined) {
      if (
        invocation.moduleJobId === undefined ||
        invocation.runId === undefined ||
        invocation.attempt === undefined
      ) {
        throw new ExtensionCapabilityError(
          "CAPABILITY_SCOPE_MISMATCH",
          "Capability deadline does not identify a complete active Run",
        );
      }
      const deadline = canonicalTime(invocation.deadline, "deadline");
      if (invocationNowMs >= Date.parse(deadline)) {
        throw new ExtensionCapabilityError(
          "CAPABILITY_EXPIRED",
          "Capability active Run deadline has expired",
        );
      }
    }
    if (record.grant.requireIdempotencyKey === true) {
      assertId(invocation.idempotencyKey, "idempotencyKey");
    } else if (invocation.idempotencyKey !== undefined) {
      assertId(invocation.idempotencyKey, "idempotencyKey");
    }
    let argumentsValue: JsonValue;
    try {
      argumentsValue = immutableJson(invocation.arguments);
    } catch {
      throw new ExtensionCapabilityError(
        "CAPABILITY_ARGUMENT_INVALID",
        "Capability arguments are not closed JSON",
      );
    }
    if (canonicalJsonByteLength(argumentsValue) > record.grant.maxArgumentBytes) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_QUOTA_EXCEEDED",
        "Capability argument byte limit exceeded",
      );
    }

    const effectKey = invocation.idempotencyKey;
    const effectDigest = canonicalJsonDigest({
      operation: invocation.operation,
      arguments: argumentsValue,
      ...(invocation.moduleJobId === undefined ? {} : { moduleJobId: invocation.moduleJobId }),
    });
    this.#assertActiveSession(session);
    if (record.revoked) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_REVOKED",
        "Capability has been revoked",
      );
    }
    if (effectKey !== undefined) {
      const existing = record.effects.get(effectKey);
      if (existing) {
        if (existing.digest !== effectDigest) {
          throw new ExtensionCapabilityError(
            "CAPABILITY_SCOPE_MISMATCH",
            "Idempotency key was reused for a different capability effect",
          );
        }
        return existing.promise;
      }
    }
    const runInvocationKey =
      invocation.moduleJobId === undefined || invocation.runId === undefined
        ? undefined
        : `${invocation.moduleJobId}\u0000${invocation.runId}`;
    if (record.grant.maxInvocationsPerRun !== undefined && runInvocationKey === undefined) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_SCOPE_MISMATCH",
        "Capability requires an active Run invocation scope",
      );
    }
    if (
      runInvocationKey !== undefined &&
      record.grant.maxInvocationsPerRun !== undefined &&
      (record.runInvocations.get(runInvocationKey) ?? 0) >=
        record.grant.maxInvocationsPerRun
    ) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_QUOTA_EXCEEDED",
        "Capability active Run invocation limit reached",
        {
          limit: "maxInvocationsPerRun",
          allowed: record.grant.maxInvocationsPerRun,
        },
      );
    }
    if (record.invocations >= record.grant.maxInvocations) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_QUOTA_EXCEEDED",
        "Capability invocation limit reached",
      );
    }
    if (record.concurrent >= record.grant.maxConcurrentInvocations) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_QUOTA_EXCEEDED",
        "Capability concurrency limit reached",
      );
    }

    const controller = new AbortController();
    const operation = session[TRACK_IN_FLIGHT_INVOCATION](
      controller,
      {
        ...(invocation.moduleJobId === undefined
          ? {}
          : { moduleJobId: invocation.moduleJobId }),
        ...(invocation.runId === undefined ? {} : { runId: invocation.runId }),
      },
      () => this.#execute(session, record, invocation, argumentsValue, controller.signal),
    );
    record.invocations += 1;
    if (runInvocationKey !== undefined) {
      record.runInvocations.set(
        runInvocationKey,
        (record.runInvocations.get(runInvocationKey) ?? 0) + 1,
      );
    }
    record.concurrent += 1;
    if (effectKey !== undefined) {
      record.effects.set(effectKey, { digest: effectDigest, promise: operation });
    }
    return operation;
  }

  close(session: ExtensionCapabilitySession): Promise<void> {
    const active = this.#sessions.get(session.identity.sessionId);
    if (active !== session && !session.closed) return Promise.resolve();
    return session.close();
  }

  [REVOKE_CAPABILITY_SESSION](session: ExtensionCapabilitySession): void {
    if (this.#sessions.get(session.identity.sessionId) !== session) return;
    for (const record of this.#records.values()) {
      if (record.sessionId === session.identity.sessionId) record.revoked = true;
    }
    this.#sessions.delete(session.identity.sessionId);
  }

  async #execute(
    session: ExtensionCapabilitySession,
    record: CapabilityRecord,
    invocation: ExtensionCapabilityInvocation,
    argumentsValue: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    try {
      if (
        signal.aborted ||
        session.closed ||
        record.revoked ||
        this.#sessions.get(record.sessionId) !== session
      ) {
        throw new ExtensionCapabilityError(
          "CAPABILITY_REVOKED",
          "Capability was revoked before its handler started",
        );
      }
      const context: ExtensionCapabilityInvocationContext = Object.freeze({
        identity: session.identity,
        capabilityType: record.grant.capabilityType,
        capabilityVersion: record.grant.capabilityVersion,
        operation: invocation.operation,
        resourceScope: record.grant.resourceScope,
        ...(invocation.moduleJobId === undefined
          ? {}
          : { moduleJobId: invocation.moduleJobId }),
        ...(invocation.runId === undefined ? {} : { runId: invocation.runId }),
        ...(invocation.attempt === undefined ? {} : { attempt: invocation.attempt }),
        ...(invocation.deadline === undefined ? {} : { deadline: invocation.deadline }),
        ...(invocation.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: invocation.idempotencyKey }),
        signal,
      });
      const rawResult = await record.handler(argumentsValue, context);
      if (
        signal.aborted ||
        session.closed ||
        record.revoked ||
        this.#sessions.get(record.sessionId) !== session
      ) {
        throw new ExtensionCapabilityError(
          "CAPABILITY_REVOKED",
          "Capability was revoked before its result became observable",
        );
      }
      let result: JsonValue;
      try {
        result = immutableJson(rawResult);
      } catch {
        throw new ExtensionCapabilityError(
          "CAPABILITY_RESULT_INVALID",
          "Capability broker returned a non-JSON result",
        );
      }
      if (canonicalJsonByteLength(result) > record.grant.maxResultBytes) {
        throw new ExtensionCapabilityError(
          "CAPABILITY_QUOTA_EXCEEDED",
          "Capability result byte limit exceeded",
        );
      }
      if (
        signal.aborted ||
        session.closed ||
        record.revoked ||
        this.#sessions.get(record.sessionId) !== session
      ) {
        throw new ExtensionCapabilityError(
          "CAPABILITY_REVOKED",
          "Capability was revoked before its result became observable",
        );
      }
      return result;
    } catch (error) {
      if (
        signal.aborted ||
        session.closed ||
        record.revoked ||
        this.#sessions.get(record.sessionId) !== session
      ) {
        throw new ExtensionCapabilityError(
          "CAPABILITY_REVOKED",
          "Capability was revoked before its result became observable",
        );
      }
      if (error instanceof ExtensionCapabilityError) throw error;
      throw new ExtensionCapabilityError(
        "CAPABILITY_DEPENDENCY_FAILED",
        "Capability broker dependency failed",
      );
    } finally {
      record.concurrent -= 1;
    }
  }

  #recordFor(
    session: ExtensionCapabilitySession,
    handleValue: ExtensionCapabilityHandle,
    required: boolean,
  ): CapabilityRecord | null {
    if (
      handleValue?.schemaVersion !== "dolly.capability-handle/1" ||
      typeof handleValue.handle !== "string" ||
      !HANDLE_PATTERN.test(handleValue.handle)
    ) {
      if (!required) return null;
      throw new ExtensionCapabilityError("CAPABILITY_DENIED", "Capability is not authorized");
    }
    const record = this.#records.get(handleValue.handle);
    if (!record || record.sessionId !== session.identity.sessionId) {
      if (!required) return null;
      throw new ExtensionCapabilityError("CAPABILITY_DENIED", "Capability is not authorized");
    }
    return record;
  }

  #assertActiveSession(session: ExtensionCapabilitySession): void {
    if (
      session.closed ||
      this.#sessions.get(session.identity.sessionId) !== session
    ) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_SESSION_CLOSED",
        "Extension capability session is closed",
      );
    }
  }
}

export class ExtensionCapabilitySession {
  #closed = false;
  #closePromise?: Promise<void>;
  readonly #inFlightInvocations = new Map<
    Promise<JsonValue>,
    {
      readonly controller: AbortController;
      readonly moduleJobId?: string;
      readonly runId?: string;
    }
  >();

  constructor(
    private readonly authority: ExtensionCapabilityAuthority,
    readonly identity: ExtensionSessionIdentity,
  ) {}

  get closed(): boolean {
    return this.#closed;
  }

  issue(
    grant: ExtensionCapabilityGrant,
    handler: ExtensionCapabilityHandler,
  ): ExtensionCapabilityHandle {
    return this.authority.issue(this, grant, handler);
  }

  invoke(invocation: ExtensionCapabilityInvocation): Promise<JsonValue> {
    return this.authority.invoke(this, invocation);
  }

  inspectRunCapacity(deadline: string): ExtensionCapabilityRunCapacity {
    return this.authority.inspectRunCapacity(this, deadline);
  }

  revoke(handle: ExtensionCapabilityHandle): "revoked" | "absent" {
    return this.authority.revoke(this, handle);
  }

  [TRACK_IN_FLIGHT_INVOCATION](
    controller: AbortController,
    scope: { readonly moduleJobId?: string; readonly runId?: string },
    execute: () => Promise<JsonValue>,
  ): Promise<JsonValue> {
    if (this.#closed) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_SESSION_CLOSED",
        "Extension capability session is closed",
      );
    }
    const operation = Promise.resolve().then(execute);
    this.#inFlightInvocations.set(operation, { controller, ...scope });
    void operation.then(
      () => this.#inFlightInvocations.delete(operation),
      () => this.#inFlightInvocations.delete(operation),
    );
    return operation;
  }

  /**
   * Revokes the current authorization for one Run without destroying handles
   * that a long-lived Module may use in a later Run.
   */
  cancelExecution(scope: ExtensionExecutionScope): void {
    assertId(scope.moduleJobId, "moduleJobId");
    assertId(scope.runId, "runId");
    const reason = new ExtensionCapabilityError(
      "CAPABILITY_REVOKED",
      "Capability authorization for the Run was revoked",
    );
    for (const invocation of this.#inFlightInvocations.values()) {
      if (
        invocation.moduleJobId === scope.moduleJobId &&
        invocation.runId === scope.runId &&
        !invocation.controller.signal.aborted
      ) {
        invocation.controller.abort(reason);
      }
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    let resolveClose!: () => void;
    const close = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    this.#closePromise = close;
    this.#closed = true;
    this.authority[REVOKE_CAPABILITY_SESSION](this);
    const inFlight = [...this.#inFlightInvocations.entries()];
    const reason = new ExtensionCapabilityError(
      "CAPABILITY_SESSION_CLOSED",
      "Extension capability session is closed",
    );
    for (const [, invocation] of inFlight) {
      if (!invocation.controller.signal.aborted) invocation.controller.abort(reason);
    }
    void Promise.allSettled(inFlight.map(([operation]) => operation)).then(() => resolveClose());
    return close;
  }
}
