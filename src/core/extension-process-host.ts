import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import {
  cloneJson,
  deepFreeze,
  isJsonObject,
  type JsonValue,
} from "./canonical-json.js";
import type { DeliveryClaimIdentity } from "./delivery-store.js";
import {
  ExtensionCapabilityAuthority,
  ExtensionCapabilityError,
  type ExtensionCapabilityGrant,
  type ExtensionCapabilityHandle,
  type ExtensionCapabilityHandler,
  type ExtensionCapabilitySession,
} from "./extension-capability.js";
import { FramedJsonChannel, FramedJsonError } from "./framed-json-channel.js";
import {
  ModuleExecutorTerminationUnconfirmedError,
  ModuleExecutorTerminatedError,
  type ModuleCancellationReason,
} from "./module-actor.js";
import type { ExtensionPackageManifest } from "./extension-installation-registry.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
// The extension process protocol is the versioned JSON message contract used
// between Dolly and an extension running in another process.
const EXTENSION_PROCESS_PROTOCOL_VERSION = "3.0";

// Isolation states what boundary the host actually enforces. Trust is a
// separate policy decision about which boundary an Extension is allowed to use.
export type ExtensionIsolation = "none" | "process" | "sandbox";

// Trust records only whether the deployer permits Extension code to run without
// a sandbox. Review and approval evidence belongs in installation audit data.
export type ExtensionTrust = "trusted" | "untrusted";

// Each field names one independently testable property of an isolation
// implementation. A false value must remain visible to operators and policy.
export interface ExtensionIsolationGuarantees {
  readonly crashContained: boolean;
  readonly cpuHangContained: boolean;
  readonly inheritedEnvironmentScrubbed: boolean;
  readonly ambientFilesystemDenied: boolean;
  readonly ambientNetworkDenied: boolean;
  readonly ambientSubprocessDenied: boolean;
  readonly hardMemoryLimit: boolean;
}

// This descriptor records test evidence about an installed sandbox backend. It
// does not itself launch a process or establish a sandbox.
export interface ExtensionSandboxBackendDescriptor {
  readonly backendId: string;
  readonly backendVersion: string;
  readonly platform: NodeJS.Platform;
  readonly conformanceStatus: "passed" | "failed" | "not-run";
  readonly guarantees: ExtensionIsolationGuarantees;
}

// A launch decision is the policy result for one trust/isolation request,
// including only guarantees supported by the selected implementation.
export interface ExtensionLaunchDecision {
  readonly isolation: ExtensionIsolation;
  readonly backendId?: string;
  readonly guarantees: ExtensionIsolationGuarantees;
}

export type ExtensionProcessHostErrorCode =
  | "EXTENSION_HOST_OPTIONS_INVALID"
  | "EXTENSION_INVOCATION_INVALID"
  | "EXTENSION_ISOLATION_DENIED"
  | "EXTENSION_SANDBOX_UNAVAILABLE"
  | "EXTENSION_STATE_INVALID"
  | "EXTENSION_PROCESS_PROTOCOL_INCOMPATIBLE"
  | "EXTENSION_PROCESS_PROTOCOL_VIOLATION"
  | "EXTENSION_QUOTA_EXCEEDED"
  | "EXTENSION_DEADLINE_EXCEEDED"
  | "EXTENSION_RESPONSE_TIMEOUT"
  | "EXTENSION_PROCESS_EXITED"
  | "EXTENSION_TERMINATION_UNCONFIRMED"
  | "EXTENSION_INTERNAL";

export class ExtensionProcessHostError extends Error {
  constructor(
    readonly code: ExtensionProcessHostErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "ExtensionProcessHostError";
  }
}

const NO_ISOLATION_GUARANTEES: ExtensionIsolationGuarantees = deepFreeze({
  crashContained: false,
  cpuHangContained: false,
  inheritedEnvironmentScrubbed: false,
  ambientFilesystemDenied: false,
  ambientNetworkDenied: false,
  ambientSubprocessDenied: false,
  hardMemoryLimit: false,
});

const PROCESS_ISOLATION_GUARANTEES: ExtensionIsolationGuarantees = deepFreeze({
  crashContained: true,
  cpuHangContained: true,
  inheritedEnvironmentScrubbed: true,
  ambientFilesystemDenied: false,
  ambientNetworkDenied: false,
  ambientSubprocessDenied: false,
  hardMemoryLimit: false,
});

const ISOLATION_GUARANTEE_KEYS = [
  "crashContained",
  "cpuHangContained",
  "inheritedEnvironmentScrubbed",
  "ambientFilesystemDenied",
  "ambientNetworkDenied",
  "ambientSubprocessDenied",
  "hardMemoryLimit",
] as const satisfies readonly (keyof ExtensionIsolationGuarantees)[];

function immutableIsolationGuarantees(
  value: ExtensionIsolationGuarantees,
): ExtensionIsolationGuarantees {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExtensionProcessHostError(
      "EXTENSION_HOST_OPTIONS_INVALID",
      "Sandbox guarantees must be an object",
    );
  }
  const allowed = new Set<string>(ISOLATION_GUARANTEE_KEYS);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ExtensionProcessHostError(
      "EXTENSION_HOST_OPTIONS_INVALID",
      "Sandbox guarantees contain an unknown field",
    );
  }
  for (const key of ISOLATION_GUARANTEE_KEYS) {
    if (typeof value[key] !== "boolean") {
      throw new ExtensionProcessHostError(
        "EXTENSION_HOST_OPTIONS_INVALID",
        `Sandbox guarantee ${key} must be boolean`,
      );
    }
  }
  return deepFreeze({
    crashContained: value.crashContained,
    cpuHangContained: value.cpuHangContained,
    inheritedEnvironmentScrubbed: value.inheritedEnvironmentScrubbed,
    ambientFilesystemDenied: value.ambientFilesystemDenied,
    ambientNetworkDenied: value.ambientNetworkDenied,
    ambientSubprocessDenied: value.ambientSubprocessDenied,
    hardMemoryLimit: value.hardMemoryLimit,
  });
}

function sandboxGuaranteesAreComplete(guarantees: ExtensionIsolationGuarantees): boolean {
  return ISOLATION_GUARANTEE_KEYS.every((key) => guarantees[key]);
}

// This policy checks whether requested isolation is permitted by trust and by
// the sandbox evidence available on the current platform.
export class ExtensionIsolationPolicy {
  readonly #backends: readonly ExtensionSandboxBackendDescriptor[];

  constructor(backends: readonly ExtensionSandboxBackendDescriptor[] = []) {
    const ids = new Set<string>();
    this.#backends = backends.map((backend) => {
      assertIdentifier(backend.backendId, "backendId");
      assertIdentifier(backend.backendVersion, "backendVersion");
      assertIdentifier(backend.platform, "platform");
      if (
        backend.conformanceStatus !== "passed" &&
        backend.conformanceStatus !== "failed" &&
        backend.conformanceStatus !== "not-run"
      ) {
        throw new ExtensionProcessHostError(
          "EXTENSION_HOST_OPTIONS_INVALID",
          "Sandbox conformance status is unsupported",
        );
      }
      if (ids.has(backend.backendId)) {
        throw new ExtensionProcessHostError(
          "EXTENSION_HOST_OPTIONS_INVALID",
          "Sandbox backend IDs must be unique",
        );
      }
      ids.add(backend.backendId);
      return deepFreeze({
        backendId: backend.backendId,
        backendVersion: backend.backendVersion,
        platform: backend.platform,
        conformanceStatus: backend.conformanceStatus,
        guarantees: immutableIsolationGuarantees(backend.guarantees),
      });
    });
  }

  resolve(
    isolation: ExtensionIsolation,
    trust: ExtensionTrust,
  ): ExtensionLaunchDecision {
    if (isolation !== "none" && isolation !== "process" && isolation !== "sandbox") {
      throw new ExtensionProcessHostError(
        "EXTENSION_HOST_OPTIONS_INVALID",
        "Extension isolation must be none, process, or sandbox",
      );
    }
    if (trust !== "trusted" && trust !== "untrusted") {
      throw new ExtensionProcessHostError(
        "EXTENSION_HOST_OPTIONS_INVALID",
        "Extension trust classification is unsupported",
      );
    }
    if (trust === "untrusted" && isolation !== "sandbox") {
      throw new ExtensionProcessHostError(
        "EXTENSION_ISOLATION_DENIED",
        "Untrusted extensions require sandbox isolation",
      );
    }
    if (isolation === "none") {
      return deepFreeze({
        isolation,
        guarantees: NO_ISOLATION_GUARANTEES,
      });
    }
    if (isolation === "process") {
      return deepFreeze({
        isolation,
        guarantees: PROCESS_ISOLATION_GUARANTEES,
      });
    }
    const backend = this.#backends.find(
      (candidate) =>
        candidate.platform === process.platform &&
        candidate.conformanceStatus === "passed" &&
        sandboxGuaranteesAreComplete(candidate.guarantees),
    );
    if (!backend) {
      throw new ExtensionProcessHostError(
        "EXTENSION_SANDBOX_UNAVAILABLE",
        `No passing sandbox backend is available for ${process.platform}`,
      );
    }
    return deepFreeze({
      isolation,
      backendId: backend.backendId,
      guarantees: { ...backend.guarantees },
    });
  }
}

/**
 * A process that was already started elsewhere and that this host takes over
 * the Extension protocol on, instead of starting a process of its own.
 *
 * It exists because process creation and process termination are not always
 * the host's to perform. On Linux, Architecture Decision Record 0009 has Core
 * create the Module process through a reviewed child launcher in a fixed
 * order - persist the process record, prepare the control group, start the
 * launcher, verify kernel control-group membership, authorize `exec` - and
 * terminate it by terminating its whole control group. The host must not
 * perform either step, but it still owns the protocol on the process's
 * standard input and output, and it still owes the same proof that the process
 * stopped.
 *
 * Every member is required. A host that could ask a process to stop but could
 * never observe it stop would have to either wait forever or claim an exit it
 * never saw, so an attachment that cannot report the exit is rejected when the
 * host is constructed.
 */
export interface AttachedExtensionProcess {
  /** The process's standard input. The host writes protocol frames to it. */
  readonly standardInput: Writable;
  /** The process's standard output. The host reads protocol frames from it. */
  readonly standardOutput: Readable;
  /** Reported in the host snapshot as diagnostic data. Never used to signal. */
  readonly processId?: number;
  /** Whether the process's exit has already been observed. */
  readonly exited: boolean;
  /**
   * Registers an observer of the process's exit. The host registers one
   * observer when it is constructed. An implementation must invoke the
   * observer once, and must invoke it immediately when the exit was already
   * observed.
   */
  onExit(observer: () => void): void;
  /**
   * Asks the process to stop. The host calls this once per termination and
   * then waits for the observed exit; it never signals a process identifier.
   */
  requestTermination(): void;
  /**
   * Escalates to forced termination. The host calls this only after
   * `forceKillDelayMs` has passed with no observed exit.
   *
   * An implementation must actually terminate here. Doing nothing would
   * assert that the earlier `requestTermination` had already succeeded, and
   * nothing has verified that: an exit is confirmed only through `onExit`,
   * never from either call returning. Repeating an idempotent termination
   * costs nothing, so there is no reason to skip it.
   */
  forceTermination(): void;
}

export interface ExtensionProcessHostOptions {
  readonly isolation: "process" | "sandbox";
  readonly trust: ExtensionTrust;
  readonly isolationPolicy: ExtensionIsolationPolicy;
  readonly manifest: ExtensionPackageManifest;
  readonly command: string;
  readonly args: readonly string[];
  readonly workingDirectory: string;
  readonly instanceId: string;
  readonly moduleId: string;
  readonly moduleGenerationId: string;
  readonly moduleKind: string;
  readonly config: JsonValue;
  readonly maxFrameBytes?: number;
  readonly initializationTimeoutMs?: number;
  readonly shutdownRequestTimeoutMs?: number;
  readonly forceKillDelayMs?: number;
  readonly terminationTimeoutMs?: number;
  readonly maxConcurrentCapabilityRequests?: number;
  readonly wallClockNow?: () => number;
  readonly nextIdentifier?: (purpose: "process-generation" | "session" | "request") => string;
  readonly nextCapabilityHandle?: () => string;
  /**
   * Host-owned durable accounting for every Core-mediated capability effect.
   * When supplied, the Host will not send `module.execute` until the exact Run
   * is open and will route every invocation of a granted handle through it.
   */
  readonly effectRunLifecycle?: ExtensionEffectRunLifecycle;
}

export interface ExtensionEffectRunRequest {
  readonly moduleJobId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly moduleGenerationId: string;
  readonly processGenerationId: string;
}

export interface ExtensionCapabilityEffectInvocation {
  readonly identity: DeliveryClaimIdentity;
  readonly capabilityType: string;
  readonly capabilityVersion: string;
  readonly operation: string;
  readonly arguments: JsonValue;
  readonly idempotencyKey?: string;
}

/**
 * Trusted Core boundary that resolves a protocol Run to its exact Claim,
 * persists Run admission, and records every granted capability invocation.
 */
export interface ExtensionEffectRunLifecycle {
  resolveRunIdentity(request: ExtensionEffectRunRequest): DeliveryClaimIdentity;
  openRun(identity: DeliveryClaimIdentity): void;
  invokeCapability(
    invocation: ExtensionCapabilityEffectInvocation,
    execute: () => Promise<JsonValue>,
  ): Promise<JsonValue>;
  closeRun(identity: DeliveryClaimIdentity): void;
}

/**
 * The same host options, for a host that attaches to a process Core already
 * started. It has no launch command because it starts nothing.
 */
export interface AttachedExtensionProcessHostOptions
  extends Omit<ExtensionProcessHostOptions, "command" | "args" | "workingDirectory"> {
  readonly attachedProcess: AttachedExtensionProcess;
}

/** Where one host's process comes from: it starts one, or it is handed one. */
type ExtensionProcessSource =
  | {
      readonly kind: "start-command";
      readonly command: string;
      readonly args: readonly string[];
      readonly workingDirectory: string;
    }
  | { readonly kind: "attached-process"; readonly process: AttachedExtensionProcess };

export interface ExtensionExecuteInvocation {
  readonly moduleJobId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly deadline: string;
  readonly responseTimeoutMs: number;
  readonly hasMore: boolean;
  readonly input: JsonValue;
}

export type ExtensionProcessHostState =
  | "created"
  | "starting"
  | "ready"
  | "executing"
  | "stopping"
  | "stopped"
  | "failed";

/** Read-only state of one Extension process host, including before process creation. */
export interface ExtensionProcessHostSnapshot {
  readonly isolation: "process" | "sandbox";
  readonly state: ExtensionProcessHostState;
  readonly extensionId: string;
  readonly instanceId: string;
  readonly moduleId: string;
  readonly moduleGenerationId: string;
  readonly processGenerationId: string;
  readonly sessionId: string;
  readonly pid?: number;
  readonly guarantees: ExtensionIsolationGuarantees;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  settled: boolean;
}

interface PendingRequest {
  readonly id: string;
  readonly method: string;
  readonly deferred: Deferred<JsonValue>;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ActiveRun {
  readonly moduleJobId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly deadline: string;
  readonly requestId: string;
  readonly effectIdentity?: DeliveryClaimIdentity;
  acceptingCapabilities: boolean;
  cancellationSent: boolean;
  effectRunClosed: boolean;
}

interface GrantedCapabilityDescriptor {
  readonly capabilityType: string;
  readonly capabilityVersion: string;
  readonly operations: readonly string[];
  readonly handle: ExtensionCapabilityHandle;
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

function assertIdentifier(
  value: unknown,
  label: string,
  errorCode: ExtensionProcessHostErrorCode = "EXTENSION_HOST_OPTIONS_INVALID",
): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new ExtensionProcessHostError(
      errorCode,
      `${label} is not a valid identifier`,
    );
  }
}

function assertPositive(
  value: number,
  label: string,
  errorCode: ExtensionProcessHostErrorCode = "EXTENSION_HOST_OPTIONS_INVALID",
): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ExtensionProcessHostError(
      errorCode,
      `${label} must be a positive safe integer`,
    );
  }
}

function assertTimerDelay(
  value: number,
  label: string,
  errorCode: ExtensionProcessHostErrorCode = "EXTENSION_HOST_OPTIONS_INVALID",
): void {
  assertPositive(value, label, errorCode);
  if (value > MAX_TIMER_DELAY_MS) {
    throw new ExtensionProcessHostError(
      errorCode,
      `${label} exceeds the maximum supported timer delay`,
    );
  }
}

function assertClosedObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExtensionProcessHostError(
      "EXTENSION_PROCESS_PROTOCOL_VIOLATION",
      `${label} must be an object`,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ExtensionProcessHostError(
      "EXTENSION_PROCESS_PROTOCOL_VIOLATION",
      `${label} must be a plain object`,
    );
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ExtensionProcessHostError(
        "EXTENSION_PROCESS_PROTOCOL_VIOLATION",
        `${label} contains an unknown field`,
      );
    }
  }
}

function immutableJson(value: JsonValue): JsonValue {
  return deepFreeze(cloneJson(value)) as JsonValue;
}

function moduleKindsFromManifest(manifest: ExtensionPackageManifest): readonly string[] {
  if (
    manifest.schemaVersion !== "dolly.extension-package/1" &&
    manifest.schemaVersion !== "dolly.extension-package/2" &&
    manifest.schemaVersion !== "dolly.extension-package/3" &&
    manifest.schemaVersion !== "dolly.extension-package/4"
  ) {
    throw new ExtensionProcessHostError(
      "EXTENSION_PROCESS_PROTOCOL_INCOMPATIBLE",
      "Extension manifest version is unsupported",
    );
  }
  // Versions 2 through 4 add static Core-owned schema and activation
  // declarations. They do not change process negotiation and grant no process
  // capability. Keep this boundary closed even if a caller forges the
  // TypeScript manifest type.
  if (
    !Array.isArray(manifest.requestedCapabilities) ||
    manifest.requestedCapabilities.length !== 0
  ) {
    throw new ExtensionProcessHostError(
      "EXTENSION_HOST_OPTIONS_INVALID",
      "Extension process manifests cannot request capabilities",
    );
  }
  assertIdentifier(manifest.extensionId, "extensionId");
  assertIdentifier(manifest.packageVersion, "packageVersion");
  if (
    !Array.isArray(manifest.supportedProtocolVersions) ||
    manifest.supportedProtocolVersions.length === 0 ||
    !manifest.supportedProtocolVersions.includes(EXTENSION_PROCESS_PROTOCOL_VERSION)
  ) {
    throw new ExtensionProcessHostError(
      "EXTENSION_PROCESS_PROTOCOL_INCOMPATIBLE",
      `Extension does not support protocol version ${EXTENSION_PROCESS_PROTOCOL_VERSION}`,
    );
  }
  if (!Array.isArray(manifest.modules) || manifest.modules.length === 0) {
    throw new ExtensionProcessHostError(
      "EXTENSION_HOST_OPTIONS_INVALID",
      "Extension must declare at least one module kind",
    );
  }
  const moduleKinds = manifest.modules.map((module) => module.moduleKind);
  for (const kind of moduleKinds) assertIdentifier(kind, "moduleKind");
  if (new Set(moduleKinds).size !== moduleKinds.length) {
    throw new ExtensionProcessHostError(
      "EXTENSION_HOST_OPTIONS_INVALID",
      "Extension module kinds must be unique",
    );
  }
  return deepFreeze([...moduleKinds]);
}

/**
 * Decides whether this host starts its own child or attaches to a process Core
 * already started, and rejects options that ask for both. Which one it is also
 * decides who may terminate the process, so the two cannot be combined.
 */
function readProcessSource(
  options: ExtensionProcessHostOptions | AttachedExtensionProcessHostOptions,
): ExtensionProcessSource {
  if ("attachedProcess" in options) {
    const launch = options as Partial<ExtensionProcessHostOptions>;
    if (
      launch.command !== undefined ||
      launch.args !== undefined ||
      launch.workingDirectory !== undefined
    ) {
      throw new ExtensionProcessHostError(
        "EXTENSION_HOST_OPTIONS_INVALID",
        "An attached Extension process cannot also carry a launch command",
      );
    }
    assertAttachedProcess(options.attachedProcess);
    return { kind: "attached-process", process: options.attachedProcess };
  }
  const { command, args } = options;
  if (typeof command !== "string" || command.length === 0 || command.includes("\u0000")) {
    throw new ExtensionProcessHostError("EXTENSION_HOST_OPTIONS_INVALID", "Launch command is invalid");
  }
  if (
    !Array.isArray(args) ||
    args.length > 64 ||
    args.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length > 4_096 ||
        argument.includes("\u0000"),
    )
  ) {
    throw new ExtensionProcessHostError("EXTENSION_HOST_OPTIONS_INVALID", "Launch arguments are invalid");
  }
  return {
    kind: "start-command",
    command,
    args: [...args],
    workingDirectory: options.workingDirectory,
  };
}

function assertStreamMethods(
  value: unknown,
  methods: readonly string[],
  label: string,
): void {
  if (value === null || typeof value !== "object") {
    throw new ExtensionProcessHostError(
      "EXTENSION_HOST_OPTIONS_INVALID",
      `The attached Extension process has no ${label}`,
    );
  }
  for (const method of methods) {
    if (typeof (value as Record<string, unknown>)[method] !== "function") {
      throw new ExtensionProcessHostError(
        "EXTENSION_HOST_OPTIONS_INVALID",
        `The attached Extension process's ${label} is not a usable stream`,
      );
    }
  }
}

/**
 * Rejects an attachment the host could not both terminate and prove stopped.
 * The host has no other way to end an Extension process it did not start, so a
 * missing member here would become an unprovable termination later.
 */
function assertAttachedProcess(
  value: unknown,
): asserts value is AttachedExtensionProcess {
  if (value === null || typeof value !== "object") {
    throw new ExtensionProcessHostError(
      "EXTENSION_HOST_OPTIONS_INVALID",
      "The attached Extension process must be an object",
    );
  }
  const candidate = value as Record<string, unknown>;
  assertStreamMethods(candidate.standardInput, ["write", "end", "once", "off"], "standard input");
  assertStreamMethods(candidate.standardOutput, ["on", "once", "off"], "standard output");
  if (typeof candidate.exited !== "boolean") {
    throw new ExtensionProcessHostError(
      "EXTENSION_HOST_OPTIONS_INVALID",
      "The attached Extension process does not report whether it has exited",
    );
  }
  if (typeof candidate.onExit !== "function") {
    throw new ExtensionProcessHostError(
      "EXTENSION_HOST_OPTIONS_INVALID",
      "The attached Extension process cannot report its exit",
    );
  }
  for (const method of ["requestTermination", "forceTermination"] as const) {
    if (typeof candidate[method] !== "function") {
      throw new ExtensionProcessHostError(
        "EXTENSION_HOST_OPTIONS_INVALID",
        "The attached Extension process cannot be terminated",
      );
    }
  }
  if (
    candidate.processId !== undefined &&
    (typeof candidate.processId !== "number" ||
      !Number.isSafeInteger(candidate.processId) ||
      candidate.processId <= 0)
  ) {
    throw new ExtensionProcessHostError(
      "EXTENSION_HOST_OPTIONS_INVALID",
      "The attached Extension process identifier is not a positive integer",
    );
  }
}

/**
 * Presents a child this host started as the same attachment shape, so both
 * construction modes run one termination and exit-confirmation path.
 *
 * This is correct only because the host started this child itself and nothing
 * else can have descended from it yet. It is not a template for an attachment
 * to a process the host did not start. In particular, the Linux adapter must
 * not terminate by signalling: once control-group membership is verified,
 * Architecture Decision Record 0009 requires termination of the whole Module
 * control group, and a descendant that left the process group survives a signal
 * sent here. Such an adapter would satisfy every contract this host states while
 * leaving processes running, which is exactly why the obligation is tested at
 * the adapter instead. See `src/adapters/linux-module-attached-process.ts`.
 */
function attachChildProcess(
  child: ChildProcessWithoutNullStreams,
): AttachedExtensionProcess {
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;
  return {
    standardInput: child.stdin,
    standardOutput: child.stdout,
    get processId() {
      return child.pid;
    },
    get exited() {
      return exited();
    },
    onExit: (observer) => {
      if (exited()) observer();
      else child.once("exit", observer);
    },
    requestTermination: () => {
      child.kill("SIGTERM");
    },
    forceTermination: () => {
      child.kill("SIGKILL");
    },
  };
}

function assertGeneratedIdentifier(value: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new ExtensionProcessHostError(
      "EXTENSION_HOST_OPTIONS_INVALID",
      "Runtime generated an invalid identifier",
    );
  }
}

// ExtensionProcessHost starts and supervises one Module in another process.
// The ordinary launcher below enforces process isolation and rejects sandbox
// isolation until a sandbox backend controls the actual launch.
export class ExtensionProcessHost {
  readonly #decision: ExtensionLaunchDecision;
  readonly #extensionId: string;
  readonly #packageVersion: string;
  readonly #moduleKinds: readonly string[];
  readonly #source: ExtensionProcessSource;
  readonly #instanceId: string;
  readonly #moduleId: string;
  readonly #moduleGenerationId: string;
  readonly #moduleKind: string;
  readonly #config: JsonValue;
  readonly #maxFrameBytes: number;
  readonly #initializationTimeoutMs: number;
  readonly #shutdownRequestTimeoutMs: number;
  readonly #forceKillDelayMs: number;
  readonly #terminationTimeoutMs: number;
  readonly #maxConcurrentCapabilityRequests: number;
  readonly #wallClockNow: () => number;
  readonly #nextIdentifier: NonNullable<ExtensionProcessHostOptions["nextIdentifier"]>;
  readonly #effectRunLifecycle: ExtensionEffectRunLifecycle | undefined;
  readonly #processGenerationId: string;
  readonly #sessionId: string;
  readonly #capabilitySession: ExtensionCapabilitySession;
  readonly #grantedCapabilities: GrantedCapabilityDescriptor[] = [];
  readonly #pending = new Map<string, PendingRequest>();
  readonly #exit = deferred<void>();
  readonly #protocolChannelClosed = deferred<void>();

  #state: ExtensionProcessHostState = "created";
  #process?: AttachedExtensionProcess;
  #channel?: FramedJsonChannel;
  #terminationRequested = false;
  #stopPromise?: Promise<ExtensionProcessHostSnapshot>;
  #terminatePromise?: Promise<ExtensionProcessHostSnapshot>;
  #forceKillTimer?: ReturnType<typeof setTimeout>;
  #capabilityClosePromise?: Promise<void>;
  #exitCleanupPromise?: Promise<void>;
  #activeRun?: ActiveRun;
  #activeCapabilityRequests = 0;

  constructor(options: ExtensionProcessHostOptions | AttachedExtensionProcessHostOptions) {
    this.#decision = options.isolationPolicy.resolve(options.isolation, options.trust);
    if (this.#decision.isolation !== "process") {
      throw new ExtensionProcessHostError(
        "EXTENSION_ISOLATION_DENIED",
        "This host launches an ordinary child process and does not implement an operating-system sandbox",
      );
    }
    this.#extensionId = options.manifest.extensionId;
    this.#packageVersion = options.manifest.packageVersion;
    this.#moduleKinds = moduleKindsFromManifest(options.manifest);
    this.#source = readProcessSource(options);
    assertIdentifier(options.instanceId, "instanceId");
    assertIdentifier(options.moduleId, "moduleId");
    assertIdentifier(options.moduleGenerationId, "moduleGenerationId");
    assertIdentifier(options.moduleKind, "moduleKind");
    if (!this.#moduleKinds.includes(options.moduleKind)) {
      throw new ExtensionProcessHostError(
        "EXTENSION_HOST_OPTIONS_INVALID",
        "Requested module kind is not declared by the extension",
      );
    }
    this.#instanceId = options.instanceId;
    this.#moduleId = options.moduleId;
    this.#moduleGenerationId = options.moduleGenerationId;
    this.#moduleKind = options.moduleKind;
    this.#config = immutableJson(options.config);
    this.#maxFrameBytes = options.maxFrameBytes ?? 256 * 1_024;
    this.#initializationTimeoutMs = options.initializationTimeoutMs ?? 10_000;
    this.#shutdownRequestTimeoutMs = options.shutdownRequestTimeoutMs ?? 10_000;
    this.#forceKillDelayMs = options.forceKillDelayMs ?? 2_000;
    this.#terminationTimeoutMs = options.terminationTimeoutMs ?? 10_000;
    this.#maxConcurrentCapabilityRequests = options.maxConcurrentCapabilityRequests ?? 8;
    this.#wallClockNow = options.wallClockNow ?? Date.now;
    this.#effectRunLifecycle = options.effectRunLifecycle;
    let generatedId = 0;
    this.#nextIdentifier =
      options.nextIdentifier ??
      ((purpose) => `${purpose}-${randomBytes(24).toString("base64url")}-${++generatedId}`);
    for (const [label, value] of [
      ["maxFrameBytes", this.#maxFrameBytes],
      ["maxConcurrentCapabilityRequests", this.#maxConcurrentCapabilityRequests],
    ] as const) {
      assertPositive(value, label);
    }
    for (const [label, value] of [
      ["initializationTimeoutMs", this.#initializationTimeoutMs],
      ["shutdownRequestTimeoutMs", this.#shutdownRequestTimeoutMs],
      ["forceKillDelayMs", this.#forceKillDelayMs],
      ["terminationTimeoutMs", this.#terminationTimeoutMs],
    ] as const) {
      assertTimerDelay(value, label);
    }
    if (this.#terminationTimeoutMs <= this.#forceKillDelayMs) {
      throw new ExtensionProcessHostError(
        "EXTENSION_HOST_OPTIONS_INVALID",
        "terminationTimeoutMs must be greater than forceKillDelayMs",
      );
    }
    this.#processGenerationId = this.#generateIdentifier("process-generation");
    this.#sessionId = this.#generateIdentifier("session");
    const capabilityAuthority = new ExtensionCapabilityAuthority({
      now: () => new Date(this.#wallClockNow()).toISOString(),
      ...(options.nextCapabilityHandle === undefined
        ? {}
        : { nextHandle: options.nextCapabilityHandle }),
      maxSessions: 1,
    });
    this.#capabilitySession = capabilityAuthority.openSession({
      extensionId: this.#extensionId,
      instanceId: this.#instanceId,
      processGenerationId: this.#processGenerationId,
      sessionId: this.#sessionId,
      moduleId: this.#moduleId,
      moduleGenerationId: this.#moduleGenerationId,
    });
    if (this.#source.kind === "attached-process") {
      // The attached process exists before this host does, so the host holds it
      // and observes its exit from here on. A termination requested before
      // `start()` then still has a real process to stop and a real exit to wait
      // for, instead of a missing child that would look like an exit.
      this.#process = this.#source.process;
      this.#observeProcessExit(this.#source.process);
    }
  }

  get snapshot(): ExtensionProcessHostSnapshot {
    return deepFreeze({
      isolation: this.#decision.isolation as "process" | "sandbox",
      state: this.#state,
      extensionId: this.#extensionId,
      instanceId: this.#instanceId,
      moduleId: this.#moduleId,
      moduleGenerationId: this.#moduleGenerationId,
      processGenerationId: this.#processGenerationId,
      sessionId: this.#sessionId,
      ...(this.#process?.processId === undefined ? {} : { pid: this.#process.processId }),
      guarantees: { ...this.#decision.guarantees },
    });
  }

  grantCapability(
    grant: ExtensionCapabilityGrant,
    handler: ExtensionCapabilityHandler,
  ): ExtensionCapabilityHandle {
    if (this.#state !== "created") {
      throw new ExtensionProcessHostError(
        "EXTENSION_STATE_INVALID",
        "Capabilities must be frozen before extension startup",
      );
    }
    const handle = this.#capabilitySession.issue(grant, handler);
    this.#grantedCapabilities.push(
      deepFreeze({
        capabilityType: grant.capabilityType,
        capabilityVersion: grant.capabilityVersion,
        operations: [...grant.operations],
        handle,
      }),
    );
    return handle;
  }

  async start(): Promise<ExtensionProcessHostSnapshot> {
    if (this.#state !== "created") {
      throw new ExtensionProcessHostError(
        "EXTENSION_STATE_INVALID",
        "Extension process can be started only once",
      );
    }
    this.#state = "starting";
    try {
      await this.#openTransport();
      this.#requireStarting();
      const initialized = await this.#request(
        "dolly.initialize",
        {
          protocolVersion: EXTENSION_PROCESS_PROTOCOL_VERSION,
          sessionId: this.#sessionId,
          extensionId: this.#extensionId,
          instanceId: this.#instanceId,
          processGenerationId: this.#processGenerationId,
          isolation: this.#decision.isolation,
          guarantees: { ...this.#decision.guarantees },
          config: this.#config,
          limits: {
            maxFrameBytes: this.#maxFrameBytes,
            maxConcurrentCapabilityRequests: this.#maxConcurrentCapabilityRequests,
          },
          capabilities: this.#grantedCapabilities.map((descriptor) => ({
            capabilityType: descriptor.capabilityType,
            capabilityVersion: descriptor.capabilityVersion,
            operations: [...descriptor.operations],
            handle: { ...descriptor.handle },
          })),
        },
        this.#initializationTimeoutMs,
      );
      this.#requireStarting();
      this.#validateInitializeResult(initialized);
      const created = await this.#request(
        "module.create",
        {
          protocolVersion: EXTENSION_PROCESS_PROTOCOL_VERSION,
          sessionId: this.#sessionId,
          moduleId: this.#moduleId,
          moduleGenerationId: this.#moduleGenerationId,
          moduleKind: this.#moduleKind,
          config: this.#config,
        },
        this.#initializationTimeoutMs,
      );
      this.#requireStarting();
      this.#validateCreateResult(created);
      this.#state = "ready";
      return this.snapshot;
    } catch (error) {
      await this.terminate();
      throw error;
    }
  }

  async execute(invocation: ExtensionExecuteInvocation): Promise<JsonValue> {
    if (
      this.#state === "failed" ||
      this.#state === "stopping" ||
      this.#state === "stopped"
    ) {
      try {
        await this.terminate();
      } catch {
        throw new ModuleExecutorTerminationUnconfirmedError(
          "Extension process termination could not be confirmed",
        );
      }
      throw new ModuleExecutorTerminatedError(
        "Extension process is stopped and cannot execute another module run",
      );
    }
    if (this.#state !== "ready") {
      throw new ExtensionProcessHostError(
        "EXTENSION_STATE_INVALID",
        "Extension process is not ready for execution",
      );
    }
    assertIdentifier(invocation.moduleJobId, "moduleJobId", "EXTENSION_INVOCATION_INVALID");
    assertIdentifier(invocation.runId, "runId", "EXTENSION_INVOCATION_INVALID");
    assertPositive(invocation.attempt, "attempt", "EXTENSION_INVOCATION_INVALID");
    assertTimerDelay(
      invocation.responseTimeoutMs,
      "responseTimeoutMs",
      "EXTENSION_INVOCATION_INVALID",
    );
    const deadlineMs = Date.parse(invocation.deadline);
    const now = this.#wallClockNow();
    if (
      typeof invocation.deadline !== "string" ||
      !Number.isFinite(deadlineMs) ||
      new Date(deadlineMs).toISOString() !== invocation.deadline
    ) {
      throw new ExtensionProcessHostError(
        "EXTENSION_INVOCATION_INVALID",
        "deadline must be an ISO 8601 timestamp",
      );
    }
    if (!Number.isFinite(now) || deadlineMs <= now) {
      throw new ExtensionProcessHostError(
        "EXTENSION_DEADLINE_EXCEEDED",
        "Extension execution deadline has already passed",
      );
    }
    if (invocation.responseTimeoutMs <= deadlineMs - now) {
      throw new ExtensionProcessHostError(
        "EXTENSION_INVOCATION_INVALID",
        "responseTimeoutMs must extend beyond the extension execution deadline",
      );
    }
    if (typeof invocation.hasMore !== "boolean") {
      throw new ExtensionProcessHostError("EXTENSION_INVOCATION_INVALID", "hasMore must be boolean");
    }
    const input = immutableJson(invocation.input);
    const effectIdentity = this.#openEffectRun({
      moduleJobId: invocation.moduleJobId,
      runId: invocation.runId,
      attempt: invocation.attempt,
      moduleGenerationId: this.#moduleGenerationId,
      processGenerationId: this.#processGenerationId,
    });
    this.#state = "executing";
    let requestId: string | undefined;
    try {
      const response = await this.#request(
        "module.execute",
        {
          protocolVersion: EXTENSION_PROCESS_PROTOCOL_VERSION,
          sessionId: this.#sessionId,
          moduleId: this.#moduleId,
          moduleGenerationId: this.#moduleGenerationId,
          moduleJobId: invocation.moduleJobId,
          runId: invocation.runId,
          attempt: invocation.attempt,
          deadline: invocation.deadline,
          hasMore: invocation.hasMore,
          input,
        },
        invocation.responseTimeoutMs,
        (id) => {
          requestId = id;
          this.#activeRun = {
            moduleJobId: invocation.moduleJobId,
            runId: invocation.runId,
            attempt: invocation.attempt,
            deadline: invocation.deadline,
            requestId: id,
            ...(effectIdentity === undefined ? {} : { effectIdentity }),
            acceptingCapabilities: true,
            cancellationSent: false,
            effectRunClosed: false,
          };
        },
      );
      const result = this.#validateExecuteResult(response, invocation.runId);
      if (this.#state === "executing") this.#state = "ready";
      return result;
    } catch (error) {
      if (
        error instanceof ExtensionProcessHostError &&
        (error.code === "EXTENSION_PROCESS_PROTOCOL_VIOLATION" || error.code === "EXTENSION_PROCESS_PROTOCOL_INCOMPATIBLE")
      ) {
        this.#handleProtocolFailure(error);
      }
      const currentState: ExtensionProcessHostState = this.snapshot.state;
      const fatal =
        currentState === "failed" ||
        currentState === "stopping" ||
        currentState === "stopped" ||
        (error instanceof ExtensionProcessHostError &&
          (error.code === "EXTENSION_PROCESS_PROTOCOL_VIOLATION" ||
            error.code === "EXTENSION_PROCESS_PROTOCOL_INCOMPATIBLE" ||
            error.code === "EXTENSION_RESPONSE_TIMEOUT" ||
            error.code === "EXTENSION_PROCESS_EXITED"));
      if (fatal) {
        try {
          await this.terminate();
        } catch {
          throw new ModuleExecutorTerminationUnconfirmedError(
            "Extension process termination could not be confirmed",
          );
        }
        throw new ModuleExecutorTerminatedError(
          "Extension process stopped before completing module execution",
        );
      }
      if (this.#state === "executing") {
        this.#state = "ready";
      }
      throw error;
    } finally {
      if (requestId === undefined && effectIdentity !== undefined) {
        try {
          this.#effectRunLifecycle?.closeRun(effectIdentity);
        } catch {
          // No protocol request was issued. A failed close leaves conservative
          // open evidence for recovery instead of changing the primary error.
        }
      }
      if (requestId && this.#activeRun?.requestId === requestId) {
        this.#activeRun = undefined;
      }
    }
  }

  async cancel(
    runId: string,
    reason: ModuleCancellationReason,
  ): Promise<"sent" | "already-sent" | "not-active"> {
    assertIdentifier(runId, "runId", "EXTENSION_INVOCATION_INVALID");
    if (
      reason !== "soft-timeout" &&
      reason !== "hard-timeout" &&
      reason !== "shutdown"
    ) {
      throw new ExtensionProcessHostError(
        "EXTENSION_INVOCATION_INVALID",
        "Cancellation reason is unsupported",
      );
    }
    const active = this.#activeRun;
    if (!active || active.runId !== runId) return "not-active";
    if (active.cancellationSent) return "already-sent";
    active.cancellationSent = true;
    active.acceptingCapabilities = false;
    this.#capabilitySession.cancelExecution({
      moduleJobId: active.moduleJobId,
      runId: active.runId,
    });
    try {
      await this.#channel!.send({
        jsonrpc: "2.0",
        method: "dolly.cancel",
        params: {
          protocolVersion: EXTENSION_PROCESS_PROTOCOL_VERSION,
          sessionId: this.#sessionId,
          requestId: active.requestId,
          reason,
        },
      });
      return "sent";
    } catch {
      throw new ExtensionProcessHostError(
        "EXTENSION_PROCESS_EXITED",
        "Extension transport closed before cancellation delivery",
      );
    }
  }

  /**
   * Revokes every issued capability handle and synchronously stops admission
   * of new capability calls. The returned Promise waits for handlers that had
   * already entered. Linux process ownership calls this before terminating the
   * control group; it does not signal or stop the process itself.
   */
  closeCapabilitySession(): Promise<void> {
    if (this.#capabilityClosePromise) return this.#capabilityClosePromise;
    const active = this.#activeRun;
    if (active) active.acceptingCapabilities = false;
    try {
      this.#capabilityClosePromise = Promise.resolve(this.#capabilitySession.close()).then(
        () => {
          if (active) this.#closeEffectRun(active);
        },
      );
    } catch (error) {
      this.#capabilityClosePromise = Promise.reject(error);
    }
    return this.#capabilityClosePromise;
  }

  /** Observes only the Extension protocol transport, never process exit. */
  async waitForChannelClosed(timeoutMs: number): Promise<boolean> {
    assertTimerDelay(timeoutMs, "channelCloseTimeoutMs");
    if (this.#protocolChannelClosed.settled || this.#channel?.closed === true) {
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([
        this.#protocolChannelClosed.promise.then(() => true as const),
        timedOut,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  terminate(): Promise<ExtensionProcessHostSnapshot> {
    if (this.#terminatePromise) return this.#terminatePromise;
    const termination = this.#performTerminate();
    this.#terminatePromise = termination;
    void termination.catch(() => {
      if (this.#terminatePromise === termination) this.#terminatePromise = undefined;
    });
    return termination;
  }

  stop(): Promise<ExtensionProcessHostSnapshot> {
    if (this.#terminatePromise) return this.#terminatePromise;
    if (this.#stopPromise) return this.#stopPromise;
    const stop = this.#performStop();
    this.#stopPromise = stop;
    void stop.catch(() => {
      if (this.#stopPromise === stop) this.#stopPromise = undefined;
    });
    return stop;
  }

  async #performTerminate(): Promise<ExtensionProcessHostSnapshot> {
    this.#terminationRequested = true;
    if (this.#state === "created") {
      this.#state = "stopping";
      // A host that started nothing has nothing to stop, but an attached host
      // holds a process from construction on. Going through the one termination
      // path keeps that difference from becoming an assumed exit.
      this.#startForcedProcessTermination();
      await this.#waitForConfirmedExit();
      this.#state = "stopped";
      return this.snapshot;
    }
    if (this.#state === "stopped") return this.snapshot;

    this.#state = "stopping";
    this.#rejectPending(
      new ExtensionProcessHostError(
        "EXTENSION_PROCESS_EXITED",
        "Extension process was terminated before completing its request",
      ),
    );
    this.#startForcedProcessTermination();
    await this.#waitForConfirmedExit();
    this.#state = "stopped";
    return this.snapshot;
  }

  async #performStop(): Promise<ExtensionProcessHostSnapshot> {
    this.#terminationRequested = true;
    if (this.#state === "created") {
      this.#state = "stopping";
      this.#startForcedProcessTermination();
      await this.#waitForConfirmedExit();
      this.#state = "stopped";
      return this.snapshot;
    }
    if (this.#state === "stopped") return this.snapshot;
    if (this.#state === "failed") {
      this.#startForcedProcessTermination();
      await this.#waitForConfirmedExit();
      this.#state = "stopped";
      return this.snapshot;
    }
    const moduleWasCreated = this.#state === "ready" || this.#state === "executing";
    this.#state = "stopping";
    try {
      if (moduleWasCreated) {
        const stopped = await this.#request(
          "module.stop",
          {
            protocolVersion: EXTENSION_PROCESS_PROTOCOL_VERSION,
            sessionId: this.#sessionId,
            moduleId: this.#moduleId,
            moduleGenerationId: this.#moduleGenerationId,
          },
          this.#shutdownRequestTimeoutMs,
        );
        this.#validateControlResult(stopped, "module.stop");
      }
      const shutdown = await this.#request(
        "dolly.shutdown",
        { protocolVersion: EXTENSION_PROCESS_PROTOCOL_VERSION, sessionId: this.#sessionId },
        this.#shutdownRequestTimeoutMs,
      );
      this.#validateControlResult(shutdown, "dolly.shutdown");
    } catch {
      this.#startForcedProcessTermination();
    }
    if (this.#process && !this.#process.exited) {
      this.#startForcedProcessTermination();
    }
    await this.#waitForConfirmedExit();
    this.#state = "stopped";
    return this.snapshot;
  }

  async #openTransport(): Promise<void> {
    if (this.#source.kind === "attached-process") {
      // The process and its exit observation were taken over when this host was
      // constructed. Only the protocol channel is opened here.
      this.#openChannel(this.#source.process);
      return;
    }
    await this.#spawn(this.#source);
  }

  async #spawn(source: {
    readonly command: string;
    readonly args: readonly string[];
    readonly workingDirectory: string;
  }): Promise<void> {
    const child = spawn(source.command, [...source.args], {
      cwd: source.workingDirectory,
      env: {},
      windowsHide: true,
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const started = attachChildProcess(child);
    this.#process = started;
    child.stderr.on("data", () => undefined);
    this.#observeProcessExit(started);
    await new Promise<void>((resolve, reject) => {
      const onError = () => {
        child.off("spawn", onSpawn);
        this.#process = undefined;
        this.#handleExit();
        reject(
          new ExtensionProcessHostError(
            "EXTENSION_INTERNAL",
            "Extension process failed to launch",
          ),
        );
      };
      const onSpawn = () => {
        child.off("error", onError);
        child.on("error", () => this.#handleChildProcessError());
        resolve();
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });
    this.#openChannel(started);
  }

  #openChannel(attached: AttachedExtensionProcess): void {
    this.#channel = new FramedJsonChannel(attached.standardOutput, attached.standardInput, {
      maxFrameBytes: this.#maxFrameBytes,
      onMessage: (message) => this.#handleMessage(message),
      onError: (error) => {
        this.#markProtocolChannelClosed();
        this.#handleProtocolFailure(error);
      },
      onEnd: () => {
        this.#markProtocolChannelClosed();
        if (!attached.exited) {
          this.#handleProtocolFailure(
            new FramedJsonError("FRAME_TRANSPORT_FAILED", "Extension protocol ended early"),
          );
        }
      },
    });
  }

  /**
   * Registers the one exit observation this host relies on. An exit that was
   * already observed is reported immediately, so a process handed over after it
   * died is never waited for.
   */
  #observeProcessExit(attached: AttachedExtensionProcess): void {
    attached.onExit(() => this.#handleExit());
    if (attached.exited) this.#handleExit();
  }

  async #request(
    method: string,
    params: JsonValue,
    responseTimeoutMs: number,
    onRequestId?: (id: string) => void,
  ): Promise<JsonValue> {
    const id = this.#generateIdentifier("request");
    if (this.#pending.has(id)) {
      throw new ExtensionProcessHostError(
        "EXTENSION_HOST_OPTIONS_INVALID",
        "Runtime generated a duplicate request ID",
      );
    }
    const pending = deferred<JsonValue>();
    const timer = setTimeout(() => this.#handleRequestTimeout(id), responseTimeoutMs);
    this.#pending.set(id, { id, method, deferred: pending, timer });
    onRequestId?.(id);
    try {
      await this.#channel!.send({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
    } catch {
      clearTimeout(timer);
      this.#pending.delete(id);
      pending.reject(
        new ExtensionProcessHostError(
          "EXTENSION_PROCESS_EXITED",
          "Extension transport closed before request delivery",
        ),
      );
    }
    return pending.promise;
  }

  #handleMessage(message: JsonValue): void {
    try {
      assertClosedObject(message, ["jsonrpc", "id", "result", "error", "method", "params"], "message");
      if (message.jsonrpc !== "2.0" || typeof message.id !== "string") {
        throw new ExtensionProcessHostError(
          "EXTENSION_PROCESS_PROTOCOL_VIOLATION",
          "Extension message has an invalid JSON-RPC envelope",
        );
      }
      if (typeof message.method === "string") {
        if (message.result !== undefined || message.error !== undefined) {
          throw new ExtensionProcessHostError(
            "EXTENSION_PROCESS_PROTOCOL_VIOLATION",
            "JSON-RPC request cannot also be a response",
          );
        }
        void this.#handleCapabilityRequest(message.id, message.method, message.params).catch(() => {
          this.#handleProtocolFailure(
            new ExtensionProcessHostError(
              "EXTENSION_PROCESS_PROTOCOL_VIOLATION",
              "Capability response transport failed",
            ),
          );
        });
        return;
      }
      if ((message.result === undefined) === (message.error === undefined)) {
        throw new ExtensionProcessHostError(
          "EXTENSION_PROCESS_PROTOCOL_VIOLATION",
          "JSON-RPC response must contain exactly one of result or error",
        );
      }
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      if (pending.method === "module.execute") {
        const active = this.#activeRun;
        if (!active || active.requestId !== pending.id) {
          throw new ExtensionProcessHostError(
            "EXTENSION_PROCESS_PROTOCOL_VIOLATION",
            "Module result does not belong to the active Run",
          );
        }
        // Close admission at the response frame, before any promise
        // continuation can race a capability handler to completion.
        active.acceptingCapabilities = false;
        if (this.#activeCapabilityRequests !== 0) {
          throw new ExtensionProcessHostError(
            "EXTENSION_PROCESS_PROTOCOL_VIOLATION",
            "Extension returned a Module result before its capability requests settled",
          );
        }
        this.#closeEffectRun(active);
      }
      if (message.error !== undefined) {
        clearTimeout(pending.timer);
        this.#pending.delete(message.id);
        pending.deferred.reject(
          new ExtensionProcessHostError(
            "EXTENSION_INTERNAL",
            "Extension returned a sanitized failure",
          ),
        );
      } else {
        const result = immutableJson(message.result!);
        clearTimeout(pending.timer);
        this.#pending.delete(message.id);
        pending.deferred.resolve(result);
      }
    } catch (error) {
      this.#handleProtocolFailure(
        error instanceof ExtensionProcessHostError
          ? error
          : new ExtensionProcessHostError(
              "EXTENSION_PROCESS_PROTOCOL_VIOLATION",
              "Extension sent a malformed protocol message",
            ),
      );
    }
  }

  async #handleCapabilityRequest(
    id: string,
    method: string,
    paramsValue: JsonValue | undefined,
  ): Promise<void> {
    if (method !== "capability.invoke") {
      await this.#sendRpcError(id, "CAPABILITY_DENIED", "Capability request is not authorized");
      return;
    }
    // The current protocol defines no capability operation outside an active
    // Run, so a request before `module.execute` or after the Run ended is a
    // scope mismatch. Architecture Decision Record 0009 depends on this: the
    // absence of a Module submission record may mean no Core-mediated
    // external effect was authorized for that Run.
    if (
      this.#state !== "executing" ||
      !this.#activeRun ||
      !this.#activeRun.acceptingCapabilities
    ) {
      await this.#sendRpcError(
        id,
        "CAPABILITY_SCOPE_MISMATCH",
        "Capability requests are authorized only while a Run is active",
      );
      return;
    }
    if (this.#activeCapabilityRequests >= this.#maxConcurrentCapabilityRequests) {
      await this.#sendRpcError(id, "QUOTA_EXCEEDED", "Capability request limit reached");
      return;
    }
    this.#activeCapabilityRequests += 1;
    try {
      assertClosedObject(
        paramsValue,
        [
          "protocolVersion",
          "sessionId",
          "handle",
          "operation",
          "arguments",
          "moduleJobId",
          "runId",
          "idempotencyKey",
        ],
        "capability.invoke params",
      );
      if (paramsValue.protocolVersion !== EXTENSION_PROCESS_PROTOCOL_VERSION || paramsValue.sessionId !== this.#sessionId) {
        throw new ExtensionCapabilityError(
          "CAPABILITY_DENIED",
          "Capability session is not authorized",
        );
      }
      // Both identifiers are required: one Module job can have more than one
      // Run after a retry, while a Run identifier alone does not identify the
      // persistent Module job.
      const active = this.#activeRun;
      if (
        paramsValue.moduleJobId === undefined ||
        paramsValue.runId === undefined ||
        !active ||
        paramsValue.moduleJobId !== active.moduleJobId ||
        paramsValue.runId !== active.runId
      ) {
        throw new ExtensionCapabilityError(
          "CAPABILITY_SCOPE_MISMATCH",
          "Capability Module job or Run identifier does not match the active Run",
        );
      }
      const argumentsValue = immutableJson(paramsValue.arguments);
      const operation = paramsValue.operation as string;
      const idempotencyKey =
        paramsValue.idempotencyKey === undefined
          ? undefined
          : paramsValue.idempotencyKey as string;
      const descriptor = this.#grantedCapability(
        paramsValue.handle,
        operation,
      );
      // Only the host's own verified values reach the capability authority;
      // the Extension-provided fields are untrusted comparison inputs.
      const invoke = () =>
        this.#capabilitySession.invoke({
          handle: paramsValue.handle as unknown as ExtensionCapabilityHandle,
          operation,
          arguments: argumentsValue,
          moduleJobId: active.moduleJobId,
          runId: active.runId,
          attempt: active.attempt,
          deadline: active.deadline,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        });
      const lifecycle = this.#effectRunLifecycle;
      const result =
        lifecycle && active.effectIdentity && descriptor
          ? await lifecycle.invokeCapability(
              {
                identity: active.effectIdentity,
                capabilityType: descriptor.capabilityType,
                capabilityVersion: descriptor.capabilityVersion,
                operation,
                arguments: argumentsValue,
                ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
              },
              invoke,
            )
          : await invoke();
      await this.#channel?.send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: EXTENSION_PROCESS_PROTOCOL_VERSION,
          sessionId: this.#sessionId,
          value: result,
        },
      });
    } catch (error) {
      const errorCode =
        error instanceof ExtensionCapabilityError ? error.code : "CAPABILITY_DENIED";
      const message =
        error instanceof ExtensionCapabilityError
          ? error.message
          : "Capability request is not authorized";
      await this.#sendRpcError(id, errorCode, message);
    } finally {
      this.#activeCapabilityRequests -= 1;
    }
  }

  #sendRpcError(id: string, errorCode: string, message: string): Promise<void> {
    return (
      this.#channel?.send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32_001,
          message,
          data: { errorCode, retryable: false },
        },
      }) ?? Promise.resolve()
    );
  }

  #openEffectRun(
    request: ExtensionEffectRunRequest,
  ): DeliveryClaimIdentity | undefined {
    const lifecycle = this.#effectRunLifecycle;
    if (!lifecycle) return undefined;
    const identity = lifecycle.resolveRunIdentity(request);
    if (
      identity.moduleJobId !== request.moduleJobId ||
      identity.runId !== request.runId ||
      identity.attempt !== request.attempt ||
      identity.moduleGenerationId !== request.moduleGenerationId
    ) {
      throw new ExtensionProcessHostError(
        "EXTENSION_INVOCATION_INVALID",
        "Effect Run resolver returned a foreign Claim identity",
      );
    }
    assertIdentifier(identity.claimToken, "claimToken", "EXTENSION_INVOCATION_INVALID");
    const immutableIdentity = deepFreeze({ ...identity });
    lifecycle.openRun(immutableIdentity);
    return immutableIdentity;
  }

  #closeEffectRun(active: ActiveRun): void {
    if (active.effectRunClosed || active.effectIdentity === undefined) return;
    this.#effectRunLifecycle!.closeRun(active.effectIdentity);
    active.effectRunClosed = true;
  }

  #grantedCapability(
    handleValue: JsonValue | undefined,
    operation: string,
  ): GrantedCapabilityDescriptor | undefined {
    if (
      handleValue === undefined ||
      !isJsonObject(handleValue) ||
      handleValue.schemaVersion !== "dolly.capability-handle/1" ||
      typeof handleValue.handle !== "string"
    ) {
      return undefined;
    }
    return this.#grantedCapabilities.find(
      (descriptor) =>
        descriptor.handle.handle === handleValue.handle &&
        descriptor.operations.includes(operation),
    );
  }

  #handleRequestTimeout(id: string): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    const error = new ExtensionProcessHostError(
      "EXTENSION_RESPONSE_TIMEOUT",
      `Extension method ${pending.method} exceeded the host response timeout`,
    );
    pending.deferred.reject(error);
    if (
      pending.method === "module.execute" &&
      this.#activeRun?.requestId === id &&
      !this.#activeRun.cancellationSent
    ) {
      this.#activeRun.cancellationSent = true;
      void this.#channel
        ?.send({
          jsonrpc: "2.0",
          method: "dolly.cancel",
          params: {
            protocolVersion: EXTENSION_PROCESS_PROTOCOL_VERSION,
            sessionId: this.#sessionId,
            requestId: id,
            reason: "response-timeout",
          },
        })
        .catch(() => undefined);
    }
    this.#state = "failed";
    this.#startForcedProcessTermination();
  }

  #handleProtocolFailure(error: FramedJsonError | ExtensionProcessHostError): void {
    if (this.#state === "stopped" || this.#state === "failed") return;
    void error;
    this.#state = "failed";
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.deferred.reject(
        new ExtensionProcessHostError(
          "EXTENSION_PROCESS_PROTOCOL_VIOLATION",
          "Extension protocol failed validation",
        ),
      );
    }
    this.#pending.clear();
    this.#startForcedProcessTermination();
  }

  #startForcedProcessTermination(): void {
    void this.closeCapabilitySession().catch(() => undefined);
    const attached = this.#process;
    if (!attached) {
      // Only a host that starts its own child reaches this: either the child was
      // never created, or its creation failed. There is no process, so there is
      // nothing to terminate and nothing to wait for. An attached host always
      // has a process here and must never take this branch, because taking it
      // would report an exit the host never observed.
      this.#finishAfterProcessExit();
      return;
    }
    if (attached.exited) {
      this.#handleExit();
      return;
    }
    if (this.#forceKillTimer) return;
    try {
      attached.requestTermination();
    } catch {
      // The confirmation timeout reports failure if no exit event follows.
    }
    this.#forceKillTimer = setTimeout(() => {
      this.#forceKillTimer = undefined;
      if (!attached.exited) {
        try {
          attached.forceTermination();
        } catch {
          // The confirmation timeout reports failure if no exit event follows.
        }
      }
    }, this.#forceKillDelayMs);
  }

  #handleChildProcessError(): void {
    if (
      this.#state === "failed" ||
      this.#state === "stopping" ||
      this.#state === "stopped"
    ) {
      return;
    }
    this.#state = "failed";
    this.#rejectPending(
      new ExtensionProcessHostError(
        "EXTENSION_PROCESS_EXITED",
        "Extension process reported a runtime error",
      ),
    );
    this.#startForcedProcessTermination();
  }

  #handleExit(): void {
    this.#finishAfterProcessExit();
  }

  #finishAfterProcessExit(): void {
    if (this.#exit.settled || this.#exitCleanupPromise) return;
    if (this.#forceKillTimer) clearTimeout(this.#forceKillTimer);
    this.#forceKillTimer = undefined;
    this.#channel?.close();
    this.#markProtocolChannelClosed();
    this.#rejectPending(
      new ExtensionProcessHostError(
        "EXTENSION_PROCESS_EXITED",
        "Extension process exited before completing its request",
      ),
    );
    if (!this.#terminationRequested) this.#state = "failed";
    const cleanup = this.closeCapabilitySession().then(
      () => this.#exit.resolve(),
      (error: unknown) => this.#exit.reject(error),
    );
    this.#exitCleanupPromise = cleanup;
  }

  async #waitForConfirmedExit(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new ExtensionProcessHostError(
            "EXTENSION_TERMINATION_UNCONFIRMED",
            "Extension process exit and capability handler drain were not confirmed in time",
          ),
        );
      }, this.#terminationTimeoutMs);
    });
    try {
      await Promise.race([this.#exit.promise, timeout]);
    } catch (error) {
      this.#channel?.close();
      this.#markProtocolChannelClosed();
      void this.closeCapabilitySession().catch(() => undefined);
      this.#rejectPending(
        new ExtensionProcessHostError(
          "EXTENSION_TERMINATION_UNCONFIRMED",
          "Extension process termination could not be confirmed",
        ),
      );
      this.#state = "failed";
      if (
        error instanceof ExtensionProcessHostError &&
        error.code === "EXTENSION_TERMINATION_UNCONFIRMED"
      ) {
        throw error;
      }
      throw new ExtensionProcessHostError(
        "EXTENSION_TERMINATION_UNCONFIRMED",
        "Extension process cleanup failed before termination was confirmed",
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #markProtocolChannelClosed(): void {
    this.#protocolChannelClosed.resolve(undefined);
  }

  #rejectPending(error: ExtensionProcessHostError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.deferred.reject(error);
    }
    this.#pending.clear();
  }

  #validateInitializeResult(value: JsonValue): void {
    assertClosedObject(
      value,
      ["protocolVersion", "sessionId", "extensionId", "packageVersion", "moduleKinds"],
      "initialize result",
    );
    if (
      value.protocolVersion !== EXTENSION_PROCESS_PROTOCOL_VERSION ||
      value.sessionId !== this.#sessionId ||
      value.extensionId !== this.#extensionId ||
      value.packageVersion !== this.#packageVersion ||
      JSON.stringify(value.moduleKinds) !== JSON.stringify(this.#moduleKinds)
    ) {
      throw new ExtensionProcessHostError(
        "EXTENSION_PROCESS_PROTOCOL_INCOMPATIBLE",
        "Extension initialization identity or protocol version does not match its manifest",
      );
    }
  }

  #requireStarting(): void {
    if (this.#state !== "starting") {
      throw new ExtensionProcessHostError(
        "EXTENSION_STATE_INVALID",
        "Extension process startup was cancelled before initialization completed",
      );
    }
  }

  #validateCreateResult(value: JsonValue): void {
    assertClosedObject(
      value,
      ["protocolVersion", "sessionId", "moduleId", "moduleGenerationId"],
      "module.create result",
    );
    if (
      value.protocolVersion !== EXTENSION_PROCESS_PROTOCOL_VERSION ||
      value.sessionId !== this.#sessionId ||
      value.moduleId !== this.#moduleId ||
      value.moduleGenerationId !== this.#moduleGenerationId
    ) {
      throw new ExtensionProcessHostError(
        "EXTENSION_PROCESS_PROTOCOL_VIOLATION",
        "Module creation identity does not match the request",
      );
    }
  }

  #validateExecuteResult(value: JsonValue, runId: string): JsonValue {
    assertClosedObject(
      value,
      ["protocolVersion", "sessionId", "moduleId", "moduleGenerationId", "runId", "result"],
      "module.execute result",
    );
    if (
      value.protocolVersion !== EXTENSION_PROCESS_PROTOCOL_VERSION ||
      value.sessionId !== this.#sessionId ||
      value.moduleId !== this.#moduleId ||
      value.moduleGenerationId !== this.#moduleGenerationId ||
      value.runId !== runId ||
      value.result === undefined
    ) {
      throw new ExtensionProcessHostError(
        "EXTENSION_PROCESS_PROTOCOL_VIOLATION",
        "Module execution result is stale or does not match the request",
      );
    }
    return immutableJson(value.result);
  }

  #validateControlResult(value: JsonValue, method: string): void {
    assertClosedObject(value, ["protocolVersion", "sessionId", "stopped"], `${method} result`);
    if (
      value.protocolVersion !== EXTENSION_PROCESS_PROTOCOL_VERSION ||
      value.sessionId !== this.#sessionId ||
      value.stopped !== true
    ) {
      throw new ExtensionProcessHostError(
        "EXTENSION_PROCESS_PROTOCOL_VIOLATION",
        `${method} response does not match this extension session`,
      );
    }
  }

  #generateIdentifier(purpose: "process-generation" | "session" | "request"): string {
    const value = this.#nextIdentifier(purpose);
    assertGeneratedIdentifier(value);
    return value;
  }
}
