import {
  ModuleScheduler,
  type SchedulerMailboxLimits,
  type SchedulableModuleRuntime,
} from "./module-scheduler.js";

export type ReactiveModuleHostState =
  | "created"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export interface ManagedReactiveModuleRuntime extends SchedulableModuleRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ReactiveModuleHostRegistration {
  readonly moduleId: string;
  readonly runtime: ManagedReactiveModuleRuntime;
  readonly inputPageIds: readonly string[];
  readonly outputPageIds: readonly string[];
  readonly mailbox: SchedulerMailboxLimits;
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
      });
    });
    this.#scheduler = scheduler;
    this.#modules = Object.freeze(copied);
    for (const registration of this.#modules) {
      this.#scheduler.register({
        ...registration,
        activation: { kind: "reactive" },
      });
    }
  }

  get state(): ReactiveModuleHostState {
    return this.#state;
  }

  start(): Promise<void> {
    if (this.#state === "running") return Promise.resolve();
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

  async #startAll(): Promise<void> {
    try {
      for (const registration of this.#modules) {
        await registration.runtime.start();
        this.#startedRuntimes.push(registration.runtime);
      }
      this.#scheduler.start();
      this.#schedulerStarted = true;
      this.#state = "running";
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
    if (this.#state !== "running" && this.#state !== "failed") {
      return Promise.reject(
        new Error(`Reactive Module host cannot stop from ${this.#state}`),
      );
    }
    this.#state = "stopping";
    const operation = this.#stopAll();
    this.#stopPromise = operation;
    return operation;
  }

  async #stopAll(): Promise<void> {
    const errors: unknown[] = [];
    if (this.#schedulerStarted) {
      try {
        await this.#scheduler.stop();
        this.#schedulerStarted = false;
      } catch (error) {
        errors.push(error);
      }
    }
    for (const runtime of [...this.#startedRuntimes].reverse()) {
      try {
        await runtime.stop();
        this.#startedRuntimes.splice(this.#startedRuntimes.indexOf(runtime), 1);
      } catch (error) {
        errors.push(error);
      }
    }
    this.#state = errors.length === 0 ? "stopped" : "failed";
    if (errors.length > 0) {
      throw new AggregateError(errors, "Reactive Module host shutdown failed");
    }
  }
}
