import type { JsonValue } from "./canonical-json.js";
import {
  assertExtensionModuleCompatibility,
  type ExtensionPackageManifest,
} from "./extension-installation-registry.js";
import {
  ModuleScheduler,
  type SchedulerBackpressureAction,
  type SchedulerClock,
  type SchedulerEvent,
  type SchedulerMailboxLimits,
  type SchedulerMailboxReader,
  type SchedulerModuleClaimLimits,
  type SchedulableModuleRuntime,
} from "./module-scheduler.js";
import {
  validateDollyInstanceConfig,
  type DollyInstanceConfig,
} from "./runtime-config.js";
import type { ReactiveModuleRecoveryResult } from "./reactive-module-runtime.js";
import type { SourceActivationSchedulerBinding } from "./source-activation-queue.js";

export type ReactiveModuleHostState =
  | "created"
  | "starting"
  | "recovering"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export interface ManagedReactiveModuleRuntime extends SchedulableModuleRuntime {
  /** A startup-restored result has not yet reached its exact committed state. */
  readonly startupRecoveryPending?: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ReactiveModuleHostRegistration {
  readonly moduleId: string;
  readonly runtime: ManagedReactiveModuleRuntime;
  readonly inputPageIds: readonly string[];
  readonly outputPageIds: readonly string[];
  readonly mailbox: SchedulerMailboxLimits;
  /** Product composition supplies this; direct legacy harnesses may omit it. */
  readonly claimLimits?: SchedulerModuleClaimLimits;
  readonly activation?:
    | { readonly kind: "reactive" }
    | { readonly kind: "source" }
    | {
        readonly kind: "periodic";
        readonly periodMs: number;
        readonly allowEmptyInput: false;
      };
  readonly sourceActivationBinding?: SourceActivationSchedulerBinding;
}

/**
 * Scheduler constraints that `dolly.instance/9` cannot yet persist. They stay
 * explicit at this candidate composition boundary instead of being hidden as
 * demo constants or silently added to the closed product schema.
 */
export interface ReactiveModuleSchedulingConstraints {
  readonly maxConcurrentModules: number;
  readonly backpressureAction: SchedulerBackpressureAction;
  readonly downstreamRecheckMs: number;
  readonly noProgressAfterMs: number;
  readonly claimLimitCount: number;
  readonly claimLimitBytes: number;
  readonly retryJitterRatio: number;
  readonly lowWatermarkRatio: number;
}

export interface ReactiveModuleHostRuntimeRegistration {
  readonly moduleId: string;
  readonly runtime: ManagedReactiveModuleRuntime;
  readonly mailbox: SchedulerMailboxLimits;
  /** Static compatibility input only; this candidate seam does not prove installation provenance. */
  readonly manifest: ExtensionPackageManifest;
  /** Required for source activation and authenticated against the same Delivery view. */
  readonly sourceActivationBinding?: SourceActivationSchedulerBinding;
}

export interface ReactiveModuleHostComposition {
  /** The complete document is validated again; a structural cast is not trusted. */
  readonly configuration: Readonly<DollyInstanceConfig>;
  readonly deliveries: SchedulerMailboxReader;
  readonly clock: SchedulerClock;
  readonly scheduling: ReactiveModuleSchedulingConstraints;
  readonly registrations: readonly ReactiveModuleHostRuntimeRegistration[];
  /** Test/host injection only; it is not Extension-controlled configuration. */
  readonly random?: () => number;
  /** Structured observation only; it cannot influence Scheduler decisions. */
  readonly onSchedulerEvent?: (event: SchedulerEvent) => void;
}

/**
 * Builds the product-before-startup Delivery-backed vertical slice from one
 * validated instance document. Package versions 1 and 2 support reactive
 * Modules; version 3 can additionally declare the durable source mode, and
 * version 4 can declare the non-empty periodic mode. The
 * Scheduler itself can preserve a non-empty periodic descriptor, but
 * composition rejects it until a later complete package schema can declare
 * that support. Page routes and the three released
 * polling/retry values come only from the instance document. The constraints
 * absent from instance version 9 must be supplied explicitly. Its Claim
 * values are a default baseline target; composition derives an exact
 * per-Module baseline and hard ceiling before any runtime starts.
 *
 * `openDollyRuntime` deliberately does not call this function. Linux process
 * ownership, durable external-effect evidence, and the next instance schema
 * remain prerequisites for removing the product startup refusal.
 */
export function composeReactiveModuleHost(
  input: ReactiveModuleHostComposition,
): ReactiveModuleHost {
  const configuration = validateDollyInstanceConfig(
    input.configuration as unknown as JsonValue,
  );
  const registrations = new Map<string, ReactiveModuleHostRuntimeRegistration>();
  for (const registration of input.registrations) {
    if (registrations.has(registration.moduleId)) {
      throw new TypeError(
        `Reactive Module composition has duplicate runtime registration ${registration.moduleId}`,
      );
    }
    registrations.set(registration.moduleId, registration);
  }

  const configuredIds = new Set(configuration.modules.map((module) => module.moduleId));
  const missing = configuration.modules
    .map((module) => module.moduleId)
    .filter((moduleId) => !registrations.has(moduleId));
  if (missing.length > 0) {
    throw new TypeError(
      `Reactive Module composition is missing runtime registrations: ${missing.sort().join(", ")}`,
    );
  }
  const unknown = [...registrations.keys()].filter((moduleId) => !configuredIds.has(moduleId));
  if (unknown.length > 0) {
    throw new TypeError(
      `Reactive Module composition has unknown runtime registrations: ${unknown.sort().join(", ")}`,
    );
  }

  const hostRegistrations = configuration.modules.map((module) => {
    if (module.activation.kind === "periodic" && module.activation.allowEmptyInput) {
      throw new TypeError(
        `Reactive Module composition cannot provide an empty periodic completion boundary for Module ${module.moduleId}`,
      );
    }
    if (module.isolation !== "process") {
      throw new TypeError(
        `Reactive Module composition requires process isolation for Module ${module.moduleId}`,
      );
    }
    const claim = module.limits.claim;
    if (module.activation.kind !== "source" && claim === null) {
      throw new TypeError(
        `Reactive Module composition requires Claim limits for Module ${module.moduleId}`,
      );
    }
    const maxClaimCount = module.activation.kind === "source" ? 1 : claim!.maxCount;
    const maxClaimBytes = module.activation.kind === "source"
      ? module.limits.maxInputBytes
      : claim!.maxBytes;
    const claimLimits: SchedulerModuleClaimLimits = {
      baselineCount: Math.min(input.scheduling.claimLimitCount, maxClaimCount),
      baselineBytes: Math.min(input.scheduling.claimLimitBytes, maxClaimBytes),
      maxCount: maxClaimCount,
      maxBytes: maxClaimBytes,
    };
    const registration = registrations.get(module.moduleId)!;
    assertExtensionModuleCompatibility(registration.manifest, {
      extensionId: module.extensionId,
      packageVersion: module.packageVersion,
      moduleKind: module.moduleKind,
      configVersion: module.configurationReference.configVersion,
      activation: module.activation.kind,
    });
    const activation = module.activation.kind === "periodic"
      ? {
          kind: "periodic" as const,
          periodMs: module.activation.periodMs,
          allowEmptyInput: false as const,
        }
      : module.activation.kind === "source"
        ? { kind: "source" as const }
        : { kind: "reactive" as const };
    if (
      (activation.kind === "source") !==
        (registration.sourceActivationBinding !== undefined)
    ) {
      throw new TypeError(
        `Module ${module.moduleId} source activation binding does not match its configured activation`,
      );
    }
    return {
      moduleId: module.moduleId,
      runtime: registration.runtime,
      inputPageIds: module.inputPageIds,
      outputPageIds: module.outputPageIds,
      mailbox: registration.mailbox,
      claimLimits,
      activation,
      ...(registration.sourceActivationBinding === undefined
        ? {}
        : { sourceActivationBinding: registration.sourceActivationBinding }),
    } satisfies ReactiveModuleHostRegistration;
  });

  const scheduler = new ModuleScheduler({
    instanceId: configuration.instanceId,
    deliveries: input.deliveries,
    clock: input.clock,
    pollIntervalMs: configuration.core.scheduler.pollIntervalMs,
    retryBaseMs: configuration.core.scheduler.retryBaseMs,
    retryMaxMs: configuration.core.scheduler.retryMaxMs,
    ...input.scheduling,
    random: input.random,
    onEvent: input.onSchedulerEvent,
  });
  return new ReactiveModuleHost(scheduler, hostRegistrations);
}

/**
 * Coordinates one set of already-constructed reactive Module runtimes with one
 * Scheduler. It is deliberately outside `openDollyRuntime`: the product
 * bootstrap keeps its Module migration refusal until process ownership,
 * configuration, and Linux control-group construction are all connected.
 */
export class ReactiveModuleHost {
  readonly #scheduler: ModuleScheduler;
  readonly #modules: readonly ReactiveModuleHostRegistration[];
  #state: ReactiveModuleHostState = "created";
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  readonly #startedRuntimes: ManagedReactiveModuleRuntime[] = [];
  readonly #startupRecoveryModuleIds = new Set<string>();
  #schedulerStarted = false;

  constructor(
    scheduler: ModuleScheduler,
    registrations: readonly ReactiveModuleHostRegistration[],
  ) {
    if (registrations.length === 0) {
      throw new TypeError("Reactive Module host requires at least one Module");
    }
    const moduleIds = new Set<string>();
    const copied = registrations.map((registration) => {
      if (moduleIds.has(registration.moduleId)) {
        throw new TypeError(`Reactive Module host has duplicate Module ${registration.moduleId}`);
      }
      moduleIds.add(registration.moduleId);
      return Object.freeze({
        moduleId: registration.moduleId,
        runtime: registration.runtime,
        inputPageIds: Object.freeze([...registration.inputPageIds]),
        outputPageIds: Object.freeze([...registration.outputPageIds]),
        mailbox: Object.freeze({ ...registration.mailbox }),
        ...(registration.claimLimits === undefined
          ? {}
          : { claimLimits: Object.freeze({ ...registration.claimLimits }) }),
        ...(registration.activation === undefined
          ? {}
          : { activation: Object.freeze({ ...registration.activation }) }),
        ...(registration.sourceActivationBinding === undefined
          ? {}
          : { sourceActivationBinding: registration.sourceActivationBinding }),
      });
    });
    this.#scheduler = scheduler;
    this.#modules = Object.freeze(copied);
    for (const registration of this.#modules) {
      this.#scheduler.register({
        ...registration,
      });
    }
  }

  get state(): ReactiveModuleHostState {
    if (this.#state === "recovering") {
      for (const moduleId of this.#startupRecoveryModuleIds) {
        const registration = this.#modules.find((entry) => entry.moduleId === moduleId)!;
        if (
          registration.runtime.startupRecoveryPending !== true &&
          this.#scheduler.status(moduleId).quarantineReason === null
        ) {
          this.#startupRecoveryModuleIds.delete(moduleId);
        }
      }
      if (this.#startupRecoveryModuleIds.size === 0) {
        this.#state = "running";
      }
    }
    return this.#state;
  }

  start(): Promise<void> {
    if (this.#state === "running" || this.#state === "recovering") {
      return Promise.resolve();
    }
    if (this.#startPromise) return this.#startPromise;
    if (this.#state !== "created") {
      return Promise.reject(
        new Error(`Reactive Module host cannot start from ${this.#state}`),
      );
    }
    this.#state = "starting";
    const operation = this.#startAll();
    this.#startPromise = operation;
    void operation.finally(() => {
      if (this.#startPromise === operation) this.#startPromise = undefined;
    }).catch(() => undefined);
    return operation;
  }

  /**
   * Resolves one quarantined Module through the Scheduler-owned in-flight
   * fence. Callers select only the configured Module identifier; they cannot
   * substitute a runtime or bypass retry/backpressure settlement.
   */
  async recoverModule(moduleId: string): Promise<ReactiveModuleRecoveryResult> {
    const state = this.state;
    if (state !== "running" && state !== "recovering") {
      throw new Error(`Reactive Module host cannot recover from ${state}`);
    }
    const result = await this.#scheduler.recoverModule(moduleId);
    // Reading state removes any startup recovery whose durable commit reached
    // a terminal result while the Scheduler held the recovery fence.
    void this.state;
    return result;
  }

  async #startAll(): Promise<void> {
    try {
      for (const registration of this.#modules) {
        await registration.runtime.start();
        this.#startedRuntimes.push(registration.runtime);
      }
      this.#scheduler.start();
      this.#schedulerStarted = true;
      for (const registration of this.#modules) {
        if (registration.runtime.startupRecoveryPending === true) {
          this.#startupRecoveryModuleIds.add(registration.moduleId);
        }
      }
      // A prepared result that still awaits downstream capacity is a known
      // startup recovery operation, not a ready instance. The Scheduler may
      // drive the exact commit and any downstream work needed to free space,
      // but callers must continue to treat external ingress as closed until
      // every such runtime reports that its commit-only recovery finished.
      this.#state = this.#startupRecoveryModuleIds.size > 0
        ? "recovering"
        : "running";
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      for (const runtime of [...this.#startedRuntimes].reverse()) {
        try {
          await runtime.stop();
          this.#startedRuntimes.splice(this.#startedRuntimes.indexOf(runtime), 1);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      this.#state = "failed";
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Reactive Module host startup and rollback failed",
        );
      }
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    if (
      this.#state !== "running" &&
      this.#state !== "recovering" &&
      this.#state !== "failed"
    ) {
      return Promise.reject(
        new Error(`Reactive Module host cannot stop from ${this.#state}`),
      );
    }
    this.#state = "stopping";
    const operation = this.#stopAll();
    this.#stopPromise = operation;
    void operation.finally(() => {
      if (this.#stopPromise === operation) this.#stopPromise = undefined;
    }).catch(() => undefined);
    return operation;
  }

  async #stopAll(): Promise<void> {
    const errors: unknown[] = [];
    const operations: Array<{
      readonly kind: "scheduler" | "runtime";
      readonly runtime?: ManagedReactiveModuleRuntime;
      readonly operation: Promise<void>;
    }> = [];
    if (this.#schedulerStarted) {
      try {
        // `stop()` changes Scheduler state to stopping synchronously, so no
        // later dispatch can begin. Do not await its in-flight tick drain
        // before asking runtimes to cancel and terminate those same ticks.
        operations.push({ kind: "scheduler", operation: this.#scheduler.stop() });
      } catch (error) {
        errors.push(error);
      }
    }
    for (const runtime of [...this.#startedRuntimes].reverse()) {
      try {
        operations.push({ kind: "runtime", runtime, operation: runtime.stop() });
      } catch (error) {
        errors.push(error);
      }
    }
    const results = await Promise.allSettled(
      operations.map((entry) => entry.operation),
    );
    results.forEach((result, index) => {
      const entry = operations[index]!;
      if (result.status === "rejected") {
        errors.push(result.reason);
        return;
      }
      if (entry.kind === "scheduler") {
        this.#schedulerStarted = false;
        return;
      }
      const runtime = entry.runtime!;
      const runtimeIndex = this.#startedRuntimes.indexOf(runtime);
      if (runtimeIndex >= 0) this.#startedRuntimes.splice(runtimeIndex, 1);
    });
    this.#state = errors.length === 0 ? "stopped" : "failed";
    if (errors.length > 0) {
      throw new AggregateError(errors, "Reactive Module host shutdown failed");
    }
  }
}
