import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  canonicalizeJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import { NetworkExposurePolicy } from "./network-exposure.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const CONFIG_REVISION_PATTERN = /^(?:sha256:[0-9a-f]{64}|[A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;

export type ProcessSupervisorState =
  | "stopped"
  | "starting"
  | "ready"
  | "running"
  | "stopping"
  | "backoff"
  | "failed";

export type ProcessSignal = "SIGTERM" | "SIGKILL";

export interface SupervisorEndpoint {
  readonly kind: "http" | "https" | "ipc";
  readonly address: string;
}

export interface SupervisorBootstrapMessage {
  readonly schemaVersion: "dolly.supervisor-bootstrap/1";
  readonly instanceId: string;
  readonly processGenerationId: string;
  readonly processIdentityToken: string;
  readonly daemonProtocolVersion: string;
  readonly ipcProtocolVersion: string;
  readonly configRevision: string;
  readonly readinessChallenge: string;
  readonly readinessSecret: string;
}

export interface ChildReadinessReport {
  readonly endpoints: readonly SupervisorEndpoint[];
  readonly durableStateReady: boolean;
  readonly requiredListenersReady: boolean;
}

export interface ChildReadinessEnvelope {
  readonly schemaVersion: "dolly.child-readiness/1";
  readonly instanceId: string;
  readonly processGenerationId: string;
  readonly processIdentityToken: string;
  readonly daemonProtocolVersion: string;
  readonly ipcProtocolVersion: string;
  readonly configRevision: string;
  readonly readinessChallenge: string;
  readonly endpoints: readonly SupervisorEndpoint[];
  readonly durableStateReady: boolean;
  readonly requiredListenersReady: boolean;
  readonly proof: string;
}

export interface SupervisorSpawnRequest extends SupervisorBootstrapMessage {
  readonly requestedAt: string;
}

export interface SupervisorExitEvent {
  readonly code: number | null;
  readonly signal: string | null;
  readonly observedAt: string;
}

export interface ProcessLaunchObserver {
  ready(envelope: unknown): void;
  channelLost(event: SupervisorChannelLossEvent): void;
  exit(event: SupervisorExitEvent): void;
  error(error: unknown): void;
}

export interface SupervisorChannelLossEvent {
  readonly reason: "eof" | "transport-error" | "protocol-error";
  readonly observedAt: string;
}

export interface SupervisedProcess {
  readonly pid: number;
  readonly processIdentityToken: string;
  verifyIdentity(expectedIdentityToken: string): Promise<boolean>;
  terminate(signal: ProcessSignal): Promise<void> | void;
}

export interface ProcessLauncher {
  launch(
    request: SupervisorSpawnRequest,
    observer: ProcessLaunchObserver,
  ): Promise<SupervisedProcess>;
}

export interface SupervisorClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface SupervisorRestartPolicy {
  readonly rollingWindowMs: number;
  readonly maxUnexpectedExits: number;
  readonly stableResetMs: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

export interface ProcessSupervisorOptions {
  readonly instanceId: string;
  readonly configRevision: string;
  readonly daemonProtocolVersion: string;
  readonly ipcProtocolVersion: string;
  readonly launcher: ProcessLauncher;
  readonly readinessEndpointPolicy: SupervisorReadinessEndpointPolicy;
  readonly readinessTimeoutMs?: number;
  readonly gracefulStopTimeoutMs?: number;
  readonly hardStopTimeoutMs?: number;
  readonly restartPolicy?: Partial<SupervisorRestartPolicy>;
  readonly maxRememberedOperations?: number;
  readonly clock?: SupervisorClock;
  readonly random?: () => number;
  readonly nextProcessGenerationId?: () => string;
  readonly nextSecret?: (
    kind: "readiness-secret" | "readiness-challenge" | "process-identity",
  ) => string;
}

/** Declares whether readiness must report no listener or one policy-bound listener. */
export type SupervisorReadinessEndpointPolicy =
  | { readonly mode: "none" }
  | {
      readonly mode: "network";
      readonly exposure: NetworkExposurePolicy;
    };

export interface SupervisorFailure {
  readonly code: ProcessSupervisorErrorCode;
  readonly message: string;
  readonly processGenerationId?: string;
  readonly observedAt: string;
}

export interface ProcessSupervisorSnapshot {
  readonly instanceId: string;
  readonly state: ProcessSupervisorState;
  readonly desiredRunning: boolean;
  readonly desiredConfigRevision: string;
  readonly effectiveConfigRevision?: string;
  readonly processGenerationId?: string;
  readonly pid?: number;
  readonly endpoints: readonly SupervisorEndpoint[];
  readonly unexpectedExitCount: number;
  readonly restartStreak: number;
  readonly nextRestartAt?: string;
  readonly lastFailure?: SupervisorFailure;
}

/**
 * `SUPERVISOR_PROCESS_EXIT_UNCONFIRMED` means that retry cannot start a
 * replacement because the current supervised process may still be alive. It
 * distinguishes this refusal from a launch failure so callers do not treat a
 * failed retry as permission to start another process generation.
 */
export type ProcessSupervisorErrorCode =
  | "SUPERVISOR_CONFIG_INVALID"
  | "SUPERVISOR_OPERATION_INVALID"
  | "SUPERVISOR_OPERATION_CONFLICT"
  | "SUPERVISOR_OPERATION_LIMIT"
  | "SUPERVISOR_FAILED_RETRY_REQUIRED"
  | "SUPERVISOR_PROCESS_EXIT_UNCONFIRMED"
  | "SUPERVISOR_START_FAILED"
  | "SUPERVISOR_CONTROL_CHANNEL_LOST"
  | "SUPERVISOR_READINESS_INVALID"
  | "SUPERVISOR_READINESS_TIMEOUT"
  | "SUPERVISOR_STOPPED_DURING_START"
  | "SUPERVISOR_PROCESS_IDENTITY_UNPROVEN"
  | "SUPERVISOR_STOP_TIMEOUT";

export class ProcessSupervisorError extends Error {
  constructor(
    readonly code: ProcessSupervisorErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "ProcessSupervisorError";
  }
}

const DEFAULT_RESTART_POLICY: SupervisorRestartPolicy = {
  rollingWindowMs: 5 * 60_000,
  maxUnexpectedExits: 5,
  stableResetMs: 10 * 60_000,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  jitterRatio: 0.2,
};

const SYSTEM_CLOCK: SupervisorClock = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  settled: boolean;
}

interface ActiveGeneration {
  readonly processGenerationId: string;
  readonly processIdentityToken: string;
  readonly readinessSecret: string;
  readonly readinessChallenge: string;
  readonly startCompletion: Deferred<ProcessSupervisorSnapshot>;
  readonly exitCompletion: Deferred<SupervisorExitEvent>;
  child?: SupervisedProcess;
  endpoints: readonly SupervisorEndpoint[];
  effectiveConfigRevision?: string;
  readinessTimer?: unknown;
  stableTimer?: unknown;
  gracefulTimer?: unknown;
  hardTimer?: unknown;
  terminationRequest?: Promise<void>;
  intentionalStop: boolean;
  exitHandled: boolean;
  controlChannelLost: boolean;
}

interface OperationRecord {
  readonly kind: "start" | "stop" | "retry";
  readonly promise: Promise<ProcessSupervisorSnapshot>;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const result: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve: (value) => {
      if (result.settled) return;
      result.settled = true;
      resolvePromise(value);
    },
    reject: (reason) => {
      if (result.settled) return;
      result.settled = true;
      rejectPromise(reason);
    },
    settled: false,
  };
  void result.promise.catch(() => undefined);
  return result;
}

function assertClosedObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProcessSupervisorError(
      "SUPERVISOR_READINESS_INVALID",
      `${label} must be an object`,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProcessSupervisorError(
      "SUPERVISOR_READINESS_INVALID",
      `${label} must be a plain object`,
    );
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ProcessSupervisorError(
        "SUPERVISOR_READINESS_INVALID",
        `${label} contains unknown field ${key}`,
      );
    }
  }
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new ProcessSupervisorError(
      "SUPERVISOR_CONFIG_INVALID",
      `${label} is not a valid identifier`,
    );
  }
}

function assertSecret(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SECRET_PATTERN.test(value)) {
    throw new ProcessSupervisorError(
      "SUPERVISOR_CONFIG_INVALID",
      `${label} must be 43-128 base64url characters`,
    );
  }
}

function assertConfigRevision(value: unknown): asserts value is string {
  if (typeof value !== "string" || !CONFIG_REVISION_PATTERN.test(value)) {
    throw new ProcessSupervisorError(
      "SUPERVISOR_CONFIG_INVALID",
      "configRevision is invalid",
    );
  }
}

function assertFiniteDuration(value: number, label: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new ProcessSupervisorError(
      "SUPERVISOR_CONFIG_INVALID",
      `${label} must be a ${allowZero ? "non-negative" : "positive"} safe integer`,
    );
  }
}

function canonicalTime(epochMs: number): string {
  if (!Number.isFinite(epochMs)) {
    throw new ProcessSupervisorError(
      "SUPERVISOR_CONFIG_INVALID",
      "Supervisor clock returned an invalid time",
    );
  }
  return new Date(epochMs).toISOString();
}

function readinessPayload(
  envelope: Omit<ChildReadinessEnvelope, "proof">,
): Record<string, JsonValue> {
  return {
    schemaVersion: envelope.schemaVersion,
    instanceId: envelope.instanceId,
    processGenerationId: envelope.processGenerationId,
    processIdentityToken: envelope.processIdentityToken,
    daemonProtocolVersion: envelope.daemonProtocolVersion,
    ipcProtocolVersion: envelope.ipcProtocolVersion,
    configRevision: envelope.configRevision,
    readinessChallenge: envelope.readinessChallenge,
    endpoints: envelope.endpoints.map((endpoint) => ({
      kind: endpoint.kind,
      address: endpoint.address,
    })),
    durableStateReady: envelope.durableStateReady,
    requiredListenersReady: envelope.requiredListenersReady,
  };
}

function readinessProof(
  secret: string,
  envelope: Omit<ChildReadinessEnvelope, "proof">,
): string {
  return createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(canonicalizeJson(readinessPayload(envelope)), "utf8")
    .digest("base64url");
}

function proofMatches(actual: string, expected: string): boolean {
  if (!SECRET_PATTERN.test(actual) || !SECRET_PATTERN.test(expected)) return false;
  const actualBytes = Buffer.from(actual, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function validateEndpoint(value: unknown, index: number): SupervisorEndpoint {
  assertClosedObject(value, ["kind", "address"], `endpoints[${index}]`);
  if (value.kind !== "http" && value.kind !== "https" && value.kind !== "ipc") {
    throw new ProcessSupervisorError(
      "SUPERVISOR_READINESS_INVALID",
      `endpoints[${index}].kind is invalid`,
    );
  }
  if (
    typeof value.address !== "string" ||
    value.address.length === 0 ||
    value.address.length > 2_048 ||
    /[\u0000-\u001f\u007f]/u.test(value.address)
  ) {
    throw new ProcessSupervisorError(
      "SUPERVISOR_READINESS_INVALID",
      `endpoints[${index}].address is invalid`,
    );
  }
  if (value.kind === "http" || value.kind === "https") {
    let parsed: URL;
    try {
      parsed = new URL(value.address);
    } catch {
      throw new ProcessSupervisorError(
        "SUPERVISOR_READINESS_INVALID",
        `endpoints[${index}].address is not a valid URL`,
      );
    }
    if (
      parsed.protocol !== `${value.kind}:` ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hash !== "" ||
      parsed.search !== "" ||
      (parsed.pathname !== "" && parsed.pathname !== "/") ||
      parsed.hostname.length === 0 ||
      (parsed.port !== "" && Number(parsed.port) === 0)
    ) {
      throw new ProcessSupervisorError(
        "SUPERVISOR_READINESS_INVALID",
        `endpoints[${index}].address is not a bound ${value.kind} origin`,
      );
    }
  }
  return Object.freeze({ kind: value.kind, address: value.address });
}

export function parseSupervisorBootstrapMessage(value: unknown): SupervisorBootstrapMessage {
  assertClosedObject(
    value,
    [
      "schemaVersion",
      "instanceId",
      "processGenerationId",
      "processIdentityToken",
      "daemonProtocolVersion",
      "ipcProtocolVersion",
      "configRevision",
      "readinessChallenge",
      "readinessSecret",
    ],
    "bootstrap",
  );
  if (value.schemaVersion !== "dolly.supervisor-bootstrap/1") {
    throw new ProcessSupervisorError(
      "SUPERVISOR_READINESS_INVALID",
      "Bootstrap schemaVersion is unsupported",
    );
  }
  assertId(value.instanceId, "instanceId");
  assertId(value.processGenerationId, "processGenerationId");
  assertSecret(value.processIdentityToken, "processIdentityToken");
  assertId(value.daemonProtocolVersion, "daemonProtocolVersion");
  assertId(value.ipcProtocolVersion, "ipcProtocolVersion");
  assertConfigRevision(value.configRevision);
  assertSecret(value.readinessChallenge, "readinessChallenge");
  assertSecret(value.readinessSecret, "readinessSecret");
  return deepFreeze({ ...value }) as unknown as SupervisorBootstrapMessage;
}

export function createAuthenticatedReadinessEnvelope(
  bootstrapValue: SupervisorBootstrapMessage,
  report: ChildReadinessReport,
): ChildReadinessEnvelope {
  const bootstrap = parseSupervisorBootstrapMessage(bootstrapValue);
  if (!Array.isArray(report.endpoints) || report.endpoints.length > 8) {
    throw new ProcessSupervisorError(
      "SUPERVISOR_READINESS_INVALID",
      "Readiness must report between zero and eight endpoints",
    );
  }
  const endpoints = report.endpoints.map((endpoint, index) => validateEndpoint(endpoint, index));
  if (report.durableStateReady !== true || report.requiredListenersReady !== true) {
    throw new ProcessSupervisorError(
      "SUPERVISOR_READINESS_INVALID",
      "Readiness cannot be reported before durable state and required listeners are ready",
    );
  }
  const payload: Omit<ChildReadinessEnvelope, "proof"> = {
    schemaVersion: "dolly.child-readiness/1",
    instanceId: bootstrap.instanceId,
    processGenerationId: bootstrap.processGenerationId,
    processIdentityToken: bootstrap.processIdentityToken,
    daemonProtocolVersion: bootstrap.daemonProtocolVersion,
    ipcProtocolVersion: bootstrap.ipcProtocolVersion,
    configRevision: bootstrap.configRevision,
    readinessChallenge: bootstrap.readinessChallenge,
    endpoints,
    durableStateReady: true,
    requiredListenersReady: true,
  };
  return deepFreeze({ ...payload, proof: readinessProof(bootstrap.readinessSecret, payload) });
}

function parseReadinessEnvelope(value: unknown): ChildReadinessEnvelope {
  assertClosedObject(
    value,
    [
      "schemaVersion",
      "instanceId",
      "processGenerationId",
      "processIdentityToken",
      "daemonProtocolVersion",
      "ipcProtocolVersion",
      "configRevision",
      "readinessChallenge",
      "endpoints",
      "durableStateReady",
      "requiredListenersReady",
      "proof",
    ],
    "readiness",
  );
  if (value.schemaVersion !== "dolly.child-readiness/1") {
    throw new ProcessSupervisorError(
      "SUPERVISOR_READINESS_INVALID",
      "Readiness schemaVersion is unsupported",
    );
  }
  assertId(value.instanceId, "instanceId");
  assertId(value.processGenerationId, "processGenerationId");
  assertSecret(value.processIdentityToken, "processIdentityToken");
  assertId(value.daemonProtocolVersion, "daemonProtocolVersion");
  assertId(value.ipcProtocolVersion, "ipcProtocolVersion");
  assertConfigRevision(value.configRevision);
  assertSecret(value.readinessChallenge, "readinessChallenge");
  assertSecret(value.proof, "proof");
  if (!Array.isArray(value.endpoints) || value.endpoints.length > 8) {
    throw new ProcessSupervisorError(
      "SUPERVISOR_READINESS_INVALID",
      "Readiness must contain between zero and eight endpoints",
    );
  }
  const endpoints = value.endpoints.map((endpoint, index) => validateEndpoint(endpoint, index));
  if (value.durableStateReady !== true || value.requiredListenersReady !== true) {
    throw new ProcessSupervisorError(
      "SUPERVISOR_READINESS_INVALID",
      "Readiness prerequisites are incomplete",
    );
  }
  return {
    schemaVersion: value.schemaVersion,
    instanceId: value.instanceId,
    processGenerationId: value.processGenerationId,
    processIdentityToken: value.processIdentityToken,
    daemonProtocolVersion: value.daemonProtocolVersion,
    ipcProtocolVersion: value.ipcProtocolVersion,
    configRevision: value.configRevision,
    readinessChallenge: value.readinessChallenge,
    endpoints,
    durableStateReady: true,
    requiredListenersReady: true,
    proof: value.proof,
  };
}

export class ProcessSupervisor {
  readonly #instanceId: string;
  readonly #configRevision: string;
  readonly #daemonProtocolVersion: string;
  readonly #ipcProtocolVersion: string;
  readonly #launcher: ProcessLauncher;
  readonly #readinessEndpointPolicy: SupervisorReadinessEndpointPolicy;
  readonly #clock: SupervisorClock;
  readonly #random: () => number;
  readonly #nextProcessGenerationId: () => string;
  readonly #nextSecret: ProcessSupervisorOptions["nextSecret"];
  readonly #restartPolicy: SupervisorRestartPolicy;
  readonly #readinessTimeoutMs: number;
  readonly #gracefulStopTimeoutMs: number;
  readonly #hardStopTimeoutMs: number;
  readonly #maxRememberedOperations: number;
  readonly #operations = new Map<string, OperationRecord>();
  readonly #listeners = new Set<(snapshot: ProcessSupervisorSnapshot) => void>();

  #state: ProcessSupervisorState = "stopped";
  #desiredRunning = false;
  #active?: ActiveGeneration;
  #lastProcessGenerationId?: string;
  #lastFailure?: SupervisorFailure;
  #unexpectedExitTimes: number[] = [];
  #restartStreak = 0;
  #restartTimer?: unknown;
  #restartDueAt?: number;
  #commandTail: Promise<void> = Promise.resolve();

  constructor(options: ProcessSupervisorOptions) {
    assertId(options.instanceId, "instanceId");
    assertConfigRevision(options.configRevision);
    assertId(options.daemonProtocolVersion, "daemonProtocolVersion");
    assertId(options.ipcProtocolVersion, "ipcProtocolVersion");
    this.#instanceId = options.instanceId;
    this.#configRevision = options.configRevision;
    this.#daemonProtocolVersion = options.daemonProtocolVersion;
    this.#ipcProtocolVersion = options.ipcProtocolVersion;
    this.#launcher = options.launcher;
    if (
      options.readinessEndpointPolicy.mode !== "none" &&
      options.readinessEndpointPolicy.mode !== "network"
    ) {
      throw new ProcessSupervisorError(
        "SUPERVISOR_CONFIG_INVALID",
        "readinessEndpointPolicy is invalid",
      );
    }
    if (
      options.readinessEndpointPolicy.mode === "network" &&
      !(options.readinessEndpointPolicy.exposure instanceof NetworkExposurePolicy)
    ) {
      throw new ProcessSupervisorError(
        "SUPERVISOR_CONFIG_INVALID",
        "Network endpoint expectation requires an exposure policy",
      );
    }
    this.#readinessEndpointPolicy = options.readinessEndpointPolicy;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#random = options.random ?? Math.random;
    this.#nextProcessGenerationId =
      options.nextProcessGenerationId ?? (() => `process-${randomBytes(24).toString("base64url")}`);
    this.#nextSecret = options.nextSecret ?? (() => randomBytes(32).toString("base64url"));
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 30_000;
    this.#gracefulStopTimeoutMs = options.gracefulStopTimeoutMs ?? 10_000;
    this.#hardStopTimeoutMs = options.hardStopTimeoutMs ?? 5_000;
    this.#maxRememberedOperations = options.maxRememberedOperations ?? 1_024;
    this.#restartPolicy = { ...DEFAULT_RESTART_POLICY, ...options.restartPolicy };

    assertFiniteDuration(this.#readinessTimeoutMs, "readinessTimeoutMs");
    assertFiniteDuration(this.#gracefulStopTimeoutMs, "gracefulStopTimeoutMs");
    assertFiniteDuration(this.#hardStopTimeoutMs, "hardStopTimeoutMs");
    assertFiniteDuration(this.#maxRememberedOperations, "maxRememberedOperations");
    assertFiniteDuration(this.#restartPolicy.rollingWindowMs, "rollingWindowMs");
    assertFiniteDuration(
      this.#restartPolicy.maxUnexpectedExits,
      "maxUnexpectedExits",
      true,
    );
    assertFiniteDuration(this.#restartPolicy.stableResetMs, "stableResetMs");
    assertFiniteDuration(this.#restartPolicy.baseDelayMs, "baseDelayMs");
    assertFiniteDuration(this.#restartPolicy.maxDelayMs, "maxDelayMs");
    if (this.#restartPolicy.maxDelayMs < this.#restartPolicy.baseDelayMs) {
      throw new ProcessSupervisorError(
        "SUPERVISOR_CONFIG_INVALID",
        "maxDelayMs must be at least baseDelayMs",
      );
    }
    if (
      !Number.isFinite(this.#restartPolicy.jitterRatio) ||
      this.#restartPolicy.jitterRatio < 0 ||
      this.#restartPolicy.jitterRatio > 1
    ) {
      throw new ProcessSupervisorError(
        "SUPERVISOR_CONFIG_INVALID",
        "jitterRatio must be between zero and one",
      );
    }
  }

  get snapshot(): ProcessSupervisorSnapshot {
    this.#pruneUnexpectedExits();
    const active = this.#active;
    const snapshot: ProcessSupervisorSnapshot = {
      instanceId: this.#instanceId,
      state: this.#state,
      desiredRunning: this.#desiredRunning,
      desiredConfigRevision: this.#configRevision,
      ...(active?.effectiveConfigRevision === undefined
        ? {}
        : { effectiveConfigRevision: active.effectiveConfigRevision }),
      ...(this.#lastProcessGenerationId === undefined
        ? {}
        : { processGenerationId: this.#lastProcessGenerationId }),
      ...(active?.child === undefined ? {} : { pid: active.child.pid }),
      endpoints:
        active && (this.#state === "ready" || this.#state === "running")
          ? active.endpoints.map((endpoint) => ({ ...endpoint }))
          : [],
      unexpectedExitCount: this.#unexpectedExitTimes.length,
      restartStreak: this.#restartStreak,
      ...(this.#restartDueAt === undefined
        ? {}
        : { nextRestartAt: canonicalTime(this.#restartDueAt) }),
      ...(this.#lastFailure === undefined ? {} : { lastFailure: { ...this.#lastFailure } }),
    };
    return deepFreeze(snapshot) as ProcessSupervisorSnapshot;
  }

  subscribe(listener: (snapshot: ProcessSupervisorSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => this.#listeners.delete(listener);
  }

  start(operationId: string): Promise<ProcessSupervisorSnapshot> {
    return this.#operation("start", operationId, async () => {
      const result = await this.#enqueueCommand(() => this.#beginStart(false));
      return result.completion;
    });
  }

  retry(operationId: string): Promise<ProcessSupervisorSnapshot> {
    return this.#operation("retry", operationId, async () => {
      const result = await this.#enqueueCommand(() => this.#beginStart(true));
      return result.completion;
    });
  }

  stop(operationId: string): Promise<ProcessSupervisorSnapshot> {
    return this.#operation("stop", operationId, async () => {
      const result = await this.#enqueueCommand(() => this.#beginStop());
      return result.completion;
    });
  }

  reportUnhealthy(processGenerationId: string, reason = "Health check failed"): void {
    const active = this.#active;
    if (
      !active ||
      active.processGenerationId !== processGenerationId ||
      this.#state !== "running"
    ) {
      return;
    }
    this.#setFailure("SUPERVISOR_START_FAILED", reason, processGenerationId);
    active.startCompletion.reject(
      new ProcessSupervisorError("SUPERVISOR_START_FAILED", reason, {
        processGenerationId,
      }),
    );
    this.#transition("stopping");
    void this.#requestTermination(active);
  }

  #operation(
    kind: OperationRecord["kind"],
    operationId: string,
    execute: () => Promise<ProcessSupervisorSnapshot>,
  ): Promise<ProcessSupervisorSnapshot> {
    if (!ID_PATTERN.test(operationId)) {
      return Promise.reject(
        new ProcessSupervisorError(
          "SUPERVISOR_OPERATION_INVALID",
          "operationId is not a valid identifier",
        ),
      );
    }
    const existing = this.#operations.get(operationId);
    if (existing) {
      if (existing.kind !== kind) {
        return Promise.reject(
          new ProcessSupervisorError(
            "SUPERVISOR_OPERATION_CONFLICT",
            `Operation ${operationId} was already used for ${existing.kind}`,
          ),
        );
      }
      return existing.promise;
    }
    if (this.#operations.size >= this.#maxRememberedOperations) {
      return Promise.reject(
        new ProcessSupervisorError(
          "SUPERVISOR_OPERATION_LIMIT",
          "Supervisor operation journal is full",
        ),
      );
    }
    const promise = execute();
    this.#operations.set(operationId, { kind, promise });
    return promise;
  }

  #enqueueCommand<T>(work: () => Promise<T> | T): Promise<T> {
    const run = this.#commandTail.then(work, work);
    this.#commandTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #beginStart(explicitRetry: boolean): Promise<{
    completion: Promise<ProcessSupervisorSnapshot>;
  }> {
    if (explicitRetry && this.#active) {
      throw new ProcessSupervisorError(
        "SUPERVISOR_PROCESS_EXIT_UNCONFIRMED",
        `Cannot retry before exit of generation ${this.#active.processGenerationId} is confirmed`,
        {
          processGenerationId: this.#active.processGenerationId,
          state: this.#state,
        },
      );
    }
    if (this.#state === "failed" && !explicitRetry) {
      throw new ProcessSupervisorError(
        "SUPERVISOR_FAILED_RETRY_REQUIRED",
        "A failed instance requires an explicit retry operation",
      );
    }
    if (this.#state === "stopping") {
      throw new ProcessSupervisorError(
        "SUPERVISOR_START_FAILED",
        "Cannot start while the current generation is stopping",
      );
    }
    if (this.#active && (this.#state === "starting" || this.#state === "ready" || this.#state === "running")) {
      return {
        completion:
          this.#state === "running"
            ? Promise.resolve(this.snapshot)
            : this.#active.startCompletion.promise,
      };
    }

    this.#desiredRunning = true;
    this.#cancelRestartTimer();
    if (explicitRetry) {
      this.#unexpectedExitTimes = [];
      this.#restartStreak = 0;
      this.#lastFailure = undefined;
    }
    return this.#launchGeneration();
  }

  async #launchGeneration(): Promise<{ completion: Promise<ProcessSupervisorSnapshot> }> {
    const processGenerationId = this.#nextProcessGenerationId();
    const processIdentityToken = this.#nextSecret!("process-identity");
    const readinessChallenge = this.#nextSecret!("readiness-challenge");
    const readinessSecret = this.#nextSecret!("readiness-secret");
    assertId(processGenerationId, "processGenerationId");
    assertSecret(processIdentityToken, "processIdentityToken");
    assertSecret(readinessChallenge, "readinessChallenge");
    assertSecret(readinessSecret, "readinessSecret");

    const active: ActiveGeneration = {
      processGenerationId,
      processIdentityToken,
      readinessSecret,
      readinessChallenge,
      startCompletion: deferred<ProcessSupervisorSnapshot>(),
      exitCompletion: deferred<SupervisorExitEvent>(),
      endpoints: [],
      intentionalStop: false,
      exitHandled: false,
      controlChannelLost: false,
    };
    this.#active = active;
    this.#lastProcessGenerationId = processGenerationId;
    this.#restartDueAt = undefined;
    this.#transition("starting");

    active.readinessTimer = this.#clock.setTimer(() => {
      if (this.#active !== active || this.#state !== "starting") return;
      const error = new ProcessSupervisorError(
        "SUPERVISOR_READINESS_TIMEOUT",
        `Generation ${processGenerationId} did not become ready in time`,
        { processGenerationId },
      );
      this.#setFailure(error.code, error.message, processGenerationId);
      active.startCompletion.reject(error);
      this.#transition("stopping");
      void this.#requestTermination(active);
    }, this.#readinessTimeoutMs);

    const requestedAt = canonicalTime(this.#clock.now());
    const request: SupervisorSpawnRequest = {
      schemaVersion: "dolly.supervisor-bootstrap/1",
      instanceId: this.#instanceId,
      processGenerationId,
      processIdentityToken,
      daemonProtocolVersion: this.#daemonProtocolVersion,
      ipcProtocolVersion: this.#ipcProtocolVersion,
      configRevision: this.#configRevision,
      readinessChallenge,
      readinessSecret,
      requestedAt,
    };

    try {
      const child = await this.#launcher.launch(request, {
        ready: (envelope) => this.#handleReadiness(processGenerationId, envelope),
        channelLost: (event) => this.#handleControlChannelLoss(processGenerationId, event),
        exit: (event) => this.#handleExit(processGenerationId, event),
        error: (error) => this.#handleProcessError(processGenerationId, error),
      });
      if (this.#active !== active || active.exitHandled) {
        void child.terminate("SIGTERM");
      } else if (
        child.processIdentityToken !== processIdentityToken ||
        !Number.isSafeInteger(child.pid) ||
        child.pid <= 0
      ) {
        active.child = child;
        const error = new ProcessSupervisorError(
          "SUPERVISOR_PROCESS_IDENTITY_UNPROVEN",
          "Launcher returned a child with an invalid process identity",
          { processGenerationId },
        );
        this.#setFailure(error.code, error.message, processGenerationId);
        active.startCompletion.reject(error);
        this.#transition("stopping");
        void this.#requestTermination(active);
      } else {
        active.child = child;
        if (this.#state === "stopping") void this.#requestTermination(active);
        else this.#emit();
      }
    } catch {
      if (this.#active === active && !active.exitHandled) {
        this.#clearGenerationTimers(active);
        this.#active = undefined;
        const error = new ProcessSupervisorError(
          "SUPERVISOR_START_FAILED",
          "Process launcher failed before readiness",
          { processGenerationId },
        );
        this.#setFailure(
          error.code,
          error.message,
          processGenerationId,
        );
        active.startCompletion.reject(error);
        active.exitCompletion.resolve({
          code: null,
          signal: null,
          observedAt: canonicalTime(this.#clock.now()),
        });
        this.#recordUnexpectedExit(processGenerationId);
      }
    }
    return { completion: active.startCompletion.promise };
  }

  async #beginStop(): Promise<{ completion: Promise<ProcessSupervisorSnapshot> }> {
    this.#desiredRunning = false;
    this.#cancelRestartTimer();
    const active = this.#active;
    if (!active) {
      this.#transition("stopped");
      return { completion: Promise.resolve(this.snapshot) };
    }
    if (active.intentionalStop) {
      return {
        completion: active.exitCompletion.promise.then(() => this.snapshot),
      };
    }

    active.intentionalStop = true;
    this.#clearTimer(active.readinessTimer);
    active.readinessTimer = undefined;
    this.#clearTimer(active.stableTimer);
    active.stableTimer = undefined;
    active.startCompletion.reject(
      new ProcessSupervisorError(
        "SUPERVISOR_STOPPED_DURING_START",
        "The generation was stopped before startup completed",
        { processGenerationId: active.processGenerationId },
      ),
    );
    this.#transition("stopping");
    await this.#requestTermination(active);
    return {
      completion: active.exitCompletion.promise.then(() => this.snapshot),
    };
  }

  #handleReadiness(processGenerationId: string, value: unknown): void {
    const active = this.#active;
    if (
      !active ||
      active.processGenerationId !== processGenerationId ||
      this.#state !== "starting"
    ) {
      return;
    }
    try {
      const envelope = parseReadinessEnvelope(value);
      if (
        envelope.instanceId !== this.#instanceId ||
        envelope.processGenerationId !== active.processGenerationId ||
        envelope.processIdentityToken !== active.processIdentityToken ||
        envelope.daemonProtocolVersion !== this.#daemonProtocolVersion ||
        envelope.ipcProtocolVersion !== this.#ipcProtocolVersion ||
        envelope.configRevision !== this.#configRevision ||
        envelope.readinessChallenge !== active.readinessChallenge
      ) {
        throw new ProcessSupervisorError(
          "SUPERVISOR_READINESS_INVALID",
          "Readiness identity, protocol, challenge, or configuration does not match the spawn",
        );
      }
      const { proof, ...unsigned } = envelope;
      const expectedProof = readinessProof(active.readinessSecret, unsigned);
      if (!proofMatches(proof, expectedProof)) {
        throw new ProcessSupervisorError(
          "SUPERVISOR_READINESS_INVALID",
          "Readiness proof is invalid",
        );
      }

      this.#validateReadinessEndpoints(envelope.endpoints);

      this.#clearTimer(active.readinessTimer);
      active.readinessTimer = undefined;
      active.endpoints = envelope.endpoints.map((endpoint) => Object.freeze({ ...endpoint }));
      active.effectiveConfigRevision = envelope.configRevision;
      this.#lastFailure = undefined;
      this.#transition("ready");
      this.#transition("running");
      active.startCompletion.resolve(this.snapshot);
      active.stableTimer = this.#clock.setTimer(() => {
        if (
          this.#active !== active ||
          this.#state !== "running" ||
          !this.#desiredRunning
        ) {
          return;
        }
        this.#unexpectedExitTimes = [];
        this.#restartStreak = 0;
        this.#emit();
      }, this.#restartPolicy.stableResetMs);
    } catch (cause) {
      const error =
        cause instanceof ProcessSupervisorError
          ? cause
          : new ProcessSupervisorError(
              "SUPERVISOR_READINESS_INVALID",
              "Readiness message is invalid",
            );
      this.#setFailure(error.code, error.message, processGenerationId);
      active.startCompletion.reject(error);
      this.#transition("stopping");
      void this.#requestTermination(active);
    }
  }

  #handleProcessError(processGenerationId: string, cause: unknown): void {
    const active = this.#active;
    if (!active || active.processGenerationId !== processGenerationId) return;
    void cause;
    this.#setFailure(
      "SUPERVISOR_START_FAILED",
      "Child process transport error",
      processGenerationId,
    );
  }

  #handleControlChannelLoss(
    processGenerationId: string,
    event: SupervisorChannelLossEvent,
  ): void {
    const active = this.#active;
    if (
      !active ||
      active.processGenerationId !== processGenerationId ||
      active.exitHandled ||
      active.intentionalStop ||
      (this.#state !== "starting" &&
        this.#state !== "ready" &&
        this.#state !== "running")
    ) {
      return;
    }
    active.controlChannelLost = true;
    active.endpoints = [];
    active.effectiveConfigRevision = undefined;
    this.#clearTimer(active.readinessTimer);
    active.readinessTimer = undefined;
    this.#clearTimer(active.stableTimer);
    active.stableTimer = undefined;
    const error = new ProcessSupervisorError(
      "SUPERVISOR_CONTROL_CHANNEL_LOST",
      `Child control channel failed (${event.reason})`,
      { processGenerationId, reason: event.reason },
    );
    this.#setFailure(error.code, error.message, processGenerationId);
    active.startCompletion.reject(error);
    this.#transition("stopping");
    void this.#requestTermination(active);
  }

  #handleExit(processGenerationId: string, event: SupervisorExitEvent): void {
    const active = this.#active;
    if (!active || active.processGenerationId !== processGenerationId || active.exitHandled) {
      return;
    }
    active.exitHandled = true;
    this.#clearGenerationTimers(active);
    this.#active = undefined;
    active.exitCompletion.resolve(event);

    if (active.intentionalStop || !this.#desiredRunning) {
      active.startCompletion.reject(
        new ProcessSupervisorError(
          "SUPERVISOR_STOPPED_DURING_START",
          "The generation exited during an intentional stop",
          { processGenerationId },
        ),
      );
      this.#transition("stopped");
      return;
    }

    active.startCompletion.reject(
      new ProcessSupervisorError(
        "SUPERVISOR_START_FAILED",
        `Generation ${processGenerationId} exited unexpectedly`,
        { processGenerationId },
      ),
    );
    if (!active.controlChannelLost) {
      this.#setFailure(
        "SUPERVISOR_START_FAILED",
        `Generation exited unexpectedly (code=${String(event.code)}, signal=${String(event.signal)})`,
        processGenerationId,
      );
    }
    this.#recordUnexpectedExit(processGenerationId);
  }

  #validateReadinessEndpoints(endpoints: readonly SupervisorEndpoint[]): void {
    if (this.#readinessEndpointPolicy.mode === "none") {
      if (endpoints.length !== 0) {
        throw new ProcessSupervisorError(
          "SUPERVISOR_READINESS_INVALID",
          "A listenerless generation must not report endpoints",
        );
      }
      return;
    }
    if (endpoints.length !== 1 || endpoints[0]!.kind === "ipc") {
      throw new ProcessSupervisorError(
        "SUPERVISOR_READINESS_INVALID",
        "A network generation must report exactly one HTTP(S) listener",
      );
    }
    try {
      this.#readinessEndpointPolicy.exposure.validateListenerEndpoint({
        kind: endpoints[0]!.kind,
        address: endpoints[0]!.address,
      });
    } catch {
      throw new ProcessSupervisorError(
        "SUPERVISOR_READINESS_INVALID",
        "Readiness endpoint violates the configured exposure policy",
      );
    }
  }

  #requestTermination(active: ActiveGeneration): Promise<void> {
    const child = active.child;
    if (!child || this.#active !== active || active.exitHandled) return Promise.resolve();
    if (active.terminationRequest) return active.terminationRequest;
    const request = this.#performTermination(active, child);
    active.terminationRequest = request;
    return request;
  }

  async #performTermination(
    active: ActiveGeneration,
    child: SupervisedProcess,
  ): Promise<void> {
    const identityProven = await child.verifyIdentity(active.processIdentityToken);
    if (this.#active !== active || active.exitHandled) return;
    if (!identityProven) {
      this.#failUnresolvedIdentity(active);
      return;
    }
    try {
      await child.terminate("SIGTERM");
    } catch (cause) {
      this.#handleProcessError(active.processGenerationId, cause);
    }
    if (this.#active !== active || active.exitHandled) return;
    active.gracefulTimer = this.#clock.setTimer(() => {
      void this.#escalateTermination(active);
    }, this.#gracefulStopTimeoutMs);
  }

  async #escalateTermination(active: ActiveGeneration): Promise<void> {
    if (this.#active !== active || active.exitHandled || !active.child) return;
    const identityProven = await active.child.verifyIdentity(active.processIdentityToken);
    if (this.#active !== active || active.exitHandled) return;
    if (!identityProven) {
      this.#failUnresolvedIdentity(active);
      return;
    }
    try {
      await active.child.terminate("SIGKILL");
    } catch (cause) {
      this.#handleProcessError(active.processGenerationId, cause);
    }
    if (this.#active !== active || active.exitHandled) return;
    active.hardTimer = this.#clock.setTimer(() => {
      if (this.#active !== active || active.exitHandled) return;
      const error = new ProcessSupervisorError(
        "SUPERVISOR_STOP_TIMEOUT",
        "The proven child did not exit after graceful and hard termination",
        { processGenerationId: active.processGenerationId },
      );
      this.#desiredRunning = false;
      this.#setFailure(error.code, error.message, active.processGenerationId);
      active.startCompletion.reject(error);
      active.exitCompletion.reject(error);
      this.#transition("failed");
    }, this.#hardStopTimeoutMs);
  }

  #failUnresolvedIdentity(active: ActiveGeneration): void {
    const error = new ProcessSupervisorError(
      "SUPERVISOR_PROCESS_IDENTITY_UNPROVEN",
      "The live process identity could not be proven; no signal was sent",
      { processGenerationId: active.processGenerationId },
    );
    this.#desiredRunning = false;
    this.#setFailure(error.code, error.message, active.processGenerationId);
    active.startCompletion.reject(error);
    active.exitCompletion.reject(error);
    this.#transition("failed");
  }

  #recordUnexpectedExit(processGenerationId: string): void {
    const now = this.#clock.now();
    this.#unexpectedExitTimes = this.#unexpectedExitTimes.filter(
      (timestamp) => now - timestamp <= this.#restartPolicy.rollingWindowMs,
    );
    this.#unexpectedExitTimes.push(now);
    this.#restartStreak += 1;
    if (this.#unexpectedExitTimes.length > this.#restartPolicy.maxUnexpectedExits) {
      this.#desiredRunning = false;
      this.#restartDueAt = undefined;
      this.#setFailure(
        "SUPERVISOR_START_FAILED",
        `Restart budget exhausted after generation ${processGenerationId}`,
        processGenerationId,
      );
      this.#transition("failed");
      return;
    }

    const exponent = Math.max(0, this.#restartStreak - 1);
    const uncapped = this.#restartPolicy.baseDelayMs * 2 ** exponent;
    const capped = Math.min(uncapped, this.#restartPolicy.maxDelayMs);
    const randomValue = this.#random();
    if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
      this.#desiredRunning = false;
      this.#setFailure(
        "SUPERVISOR_CONFIG_INVALID",
        "Supervisor random source returned a value outside [0, 1]",
        processGenerationId,
      );
      this.#transition("failed");
      return;
    }
    const jitterFactor =
      1 - this.#restartPolicy.jitterRatio + 2 * this.#restartPolicy.jitterRatio * randomValue;
    const delay = Math.max(0, Math.round(capped * jitterFactor));
    this.#restartDueAt = now + delay;
    this.#transition("backoff");
    this.#restartTimer = this.#clock.setTimer(() => {
      if (
        this.#state !== "backoff" ||
        !this.#desiredRunning ||
        this.#lastProcessGenerationId !== processGenerationId
      ) {
        return;
      }
      this.#restartTimer = undefined;
      this.#restartDueAt = undefined;
      void this.#enqueueCommand(async () => {
        if (
          this.#state !== "backoff" ||
          !this.#desiredRunning ||
          this.#lastProcessGenerationId !== processGenerationId
        ) {
          return;
        }
        const launched = await this.#launchGeneration();
        void launched.completion.catch(() => undefined);
      });
    }, delay);
  }

  #pruneUnexpectedExits(): void {
    const now = this.#clock.now();
    this.#unexpectedExitTimes = this.#unexpectedExitTimes.filter(
      (timestamp) => now - timestamp <= this.#restartPolicy.rollingWindowMs,
    );
  }

  #setFailure(
    code: ProcessSupervisorErrorCode,
    message: string,
    processGenerationId?: string,
  ): void {
    this.#lastFailure = deepFreeze({
      code,
      message,
      ...(processGenerationId === undefined ? {} : { processGenerationId }),
      observedAt: canonicalTime(this.#clock.now()),
    }) as SupervisorFailure;
  }

  #transition(state: ProcessSupervisorState): void {
    this.#state = state;
    this.#emit();
  }

  #emit(): void {
    if (this.#listeners.size === 0) return;
    const snapshot = this.snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }

  #cancelRestartTimer(): void {
    this.#clearTimer(this.#restartTimer);
    this.#restartTimer = undefined;
    this.#restartDueAt = undefined;
  }

  #clearGenerationTimers(active: ActiveGeneration): void {
    this.#clearTimer(active.readinessTimer);
    this.#clearTimer(active.stableTimer);
    this.#clearTimer(active.gracefulTimer);
    this.#clearTimer(active.hardTimer);
    active.readinessTimer = undefined;
    active.stableTimer = undefined;
    active.gracefulTimer = undefined;
    active.hardTimer = undefined;
  }

  #clearTimer(handle: unknown): void {
    if (handle !== undefined) this.#clock.clearTimer(handle);
  }
}
