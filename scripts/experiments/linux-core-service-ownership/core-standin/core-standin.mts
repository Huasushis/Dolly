/**
 * The experiment Core: a program that can be the main process of a stable
 * systemd service and can be interrupted at any one of the fourteen durable
 * boundaries protocol version 3 enumerates.
 *
 * What this is
 * ------------
 * It composes the shipped Core parts in the order Architecture Decision Record
 * 0009 requires and runs one minimal reactive Module through them:
 *
 *   `linux-module-activation.ts`        proves the service binding and builds
 *                                       the control-group stop prover
 *   `file-core-state-store.ts`          the Claim, the Module process record,
 *                                       and the Module submission record
 *   `linux-module-process-lifecycle.ts` the ordered start and the group stop
 *   `linux-module-launcher/`            the reviewed child launcher
 *   `linux-module-cgroup.ts`            the Module control group and its limits
 *   `framed-json-channel.ts`            the Extension protocol transport
 *   `extension-capability.ts`           the capability authority and session
 *   `module-result-commit.ts` and
 *   `file-module-result-commit-repository.ts`
 *                                       the result commit journal
 *   `core-startup-recovery.ts`          the reconciliation after a restart
 *
 * Nothing here reimplements any of those. Where this file has code of its own
 * it is orchestration, the interruption barrier, and the two durable journals
 * `journals.mts` explains and labels as the experiment's own.
 *
 * What this is not
 * ----------------
 * It is not a product startup path and it deliberately does not go through
 * `runtime-bootstrap.ts`, whose Module guard stays in place until ADR 0009 is
 * Accepted. It is an experiment instrument: it exists to be killed at a known
 * point and to have its durable state examined afterwards.
 *
 * It also does not run `ExtensionProcessHost` or `ModuleActor`. The Extension
 * protocol here is `dolly.experiment.module-protocol/1`, this experiment's own
 * message set over the shipped frame transport. When the 210 cases of the
 * fixed interruption matrix ran, that was forced rather than chosen:
 * `ExtensionProcessHost` could only spawn its own direct child, so the
 * composition ADR 0009 requires — the reviewed launcher creates the process,
 * Core attaches the protocol to the descriptors that survive `exec` — could
 * not be assembled from shipped code at all.
 *
 * The host attachment option and the product adapter for a started launcher
 * now exist, but no runtime path has assembled them end to end. This stand-in
 * still needs to move to the real host and frame protocol. Until that rework
 * and its rerun, results from this instrument are evidence about the durability
 * and ownership boundary design, not evidence that ADR 0009 can be delivered
 * by the current runtime. The protocol substitution directly touches
 * boundaries 4, 7, 8, and 9. Because all three handlers also share this file's
 * launcher start path, no claim that the other boundaries are unaffected is
 * valid without a case-by-case rerun. See
 * `docs/experiments/linux-core-service-ownership-results.md`.
 *
 * How one case runs
 * -----------------
 * The service is started once. Its first invocation runs the workload and
 * stops dead at the case's boundary; the case kills it there. The service
 * manager restarts it, and the second invocation runs startup recovery against
 * whatever the first invocation left durable, writes a report, and exits zero
 * so the service does not restart again. Everything the case asserts is read
 * from that report and from the durable files themselves.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { Barrier, barrierKey } from "./barrier.mjs";
import {
  CapabilityEffectJournal,
  ExtensionResultReceiptJournal,
  ExternalEffectLog,
} from "./journals.mjs";

import type { Writable } from "node:stream";

import { canonicalJsonDigest, type JsonValue } from "../../../../src/core/canonical-json.js";
import {
  ExtensionIsolationPolicy,
  ExtensionProcessHost,
  type AttachedExtensionProcess,
} from "../../../../src/core/extension-process-host.js";
import type { ExtensionPackageManifest } from "../../../../src/core/extension-installation-registry.js";
import { FramedJsonChannel } from "../../../../src/core/framed-json-channel.js";
import { FileCoreStateStore } from "../../../../src/core/file-core-state-store.js";
import { FileModuleResultCommitRepository } from "../../../../src/core/file-module-result-commit-repository.js";
import {
  ModuleResultCommitCoordinator,
  type ModuleResultCommitHookEvent,
} from "../../../../src/core/module-result-commit.js";
import {
  CoreStartupRecovery,
  CoreStartupRecoveryError,
  type ExternalEffectEvidence,
} from "../../../../src/core/core-startup-recovery.js";
import { decideLinuxModuleActivation } from "../../../../src/core/linux-module-activation.js";
import {
  deriveModuleCgroupPath,
  nodeModuleCgroupFileSystem,
  prepareDelegatedCgroupRoot,
  prepareModuleCgroup,
  type ModuleCgroup,
  type ModuleCgroupFileSystem,
  type ModuleCgroupLimits,
} from "../../../../src/core/linux-module-cgroup.js";
import {
  startModuleProcess,
  stopModuleProcess,
  type ModuleLauncherControl,
  type ModuleProcessRecordStore,
} from "../../../../src/core/linux-module-process-lifecycle.js";
import type { ModuleProcessRecord } from "../../../../src/core/module-process-records.js";
import { buildReactiveModuleInput } from "../../../../src/core/reactive-module-input.js";
import { ExtensionCapabilityAuthority } from "../../../../src/core/extension-capability.js";
import { startLinuxModuleLauncher } from "../../../../src/adapters/linux-module-launcher/index.js";
import { createModuleLauncherControl } from "../../../../src/adapters/linux-module-launcher/module-launcher-control.js";

// ---------------------------------------------------------------------------
// Case configuration
// ---------------------------------------------------------------------------

interface StandinConfiguration {
  readonly caseId: string;
  readonly unitName: string;
  readonly serviceMode: "user" | "system";
  readonly stateDirectory: string;
  readonly barrierDirectory: string;
  readonly boundary: string;
  readonly timing: "before" | "after";
  readonly workload: string;
  readonly instanceId: string;
  readonly moduleId: string;
  readonly moduleGenerationId: string;
  readonly interpreterProgram: string;
  readonly launcherScriptPath: string;
  readonly extensionFixturePath: string;
  /**
   * Which experiment this invocation serves. Absent means the fixed
   * interruption matrix, which is the only mode that existed when this file
   * was written and whose behaviour is unchanged by everything below.
   */
  readonly mode?: "interruption" | "live-termination";
  /** `live-termination` only: why Core is terminating the Module. */
  readonly terminationReason?:
    | "hard-timeout"
    | "orderly-stop"
    | "failure-cleanup"
    | "replacement";
  /** `live-termination` only: whether Core verified membership before stopping. */
  readonly membershipTiming?: "before" | "after";
  /** `live-termination` only: whether the Extension forks a descendant first. */
  readonly descendant?: "none" | "forked";
}

const MODULE_LIMITS: ModuleCgroupLimits = {
  memoryMaxBytes: 134_217_728,
  maxProcesses: 32,
  cpuQuotaMicros: 50_000,
  cpuPeriodMicros: 100_000,
};
const MAX_OPEN_FILES = 1024;
const INPUT_PAGE = "experiment-input";
const OUTPUT_PAGE_PREFIX = "experiment-output-";
const CONTENT_SCHEMA = "dolly.experiment.text/1";

function now(): string {
  return new Date().toISOString();
}

function digestOf(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/** Tracks real protocol end/error events and provides a finite close wait. */
function createProtocolChannelCloseWaiter(): {
  readonly closed: boolean;
  markClosed(): void;
  wait(timeoutMs: number): Promise<boolean>;
} {
  let closed = false;
  const waiters = new Set<() => void>();
  return {
    get closed() {
      return closed;
    },
    markClosed() {
      if (closed) return;
      closed = true;
      for (const resolve of waiters) resolve();
      waiters.clear();
    },
    wait(timeoutMs) {
      if (closed) return Promise.resolve(true);
      return new Promise((resolve) => {
        const onClosed = () => {
          clearTimeout(timer);
          waiters.delete(onClosed);
          resolve(true);
        };
        const timer = setTimeout(() => {
          waiters.delete(onClosed);
          resolve(false);
        }, timeoutMs);
        waiters.add(onClosed);
      });
    },
  };
}

function fsyncDirectory(path: string): void {
  // Mirrors the shipped Core-state writer: a directory descriptor cannot be
  // synchronised on Windows, where this experiment never runs.
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeDurableJson(path: string, value: unknown): void {
  const temporaryPath = `${path}.tmp`;
  const descriptor = openSync(temporaryPath, "w");
  try {
    writeSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, path);
  fsyncDirectory(dirname(path));
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Counts this Core invocation before anything else happens.
 *
 * The count is durable and is written before the invocation does any work, so
 * a Core killed at its very first boundary still leaves proof that it ran.
 */
function claimInvocationNumber(path: string): number {
  const previous = readJson<{ count?: number }>(path, {}).count ?? 0;
  const count = previous + 1;
  writeDurableJson(path, { count, at: now() });
  return count;
}

// ---------------------------------------------------------------------------
// Assembly shared by both invocations
// ---------------------------------------------------------------------------

interface CoreAssembly {
  readonly store: FileCoreStateStore;
  readonly repository: FileModuleResultCommitRepository;
  readonly capabilityJournal: CapabilityEffectJournal;
  readonly receipts: ExtensionResultReceiptJournal;
  readonly effects: ExternalEffectLog;
}

/**
 * Opens the durable stores exactly once per Core invocation.
 *
 * One Core-state file has one writer. Opening a second `FileCoreStateStore`
 * over the same path in the same process would create two in-memory views of
 * one file, which is the very inconsistency this experiment is looking for; so
 * this is called once and the result is shared.
 */
function openCore(configuration: StandinConfiguration): CoreAssembly {
  const stateDirectory = configuration.stateDirectory;
  mkdirSync(stateDirectory, { recursive: true });
  let blockCounter = 0;
  let deliveryCounter = 0;
  const store = new FileCoreStateStore({
    path: join(stateDirectory, "core-state.json"),
    maxFailedAttempts: 3,
    nextBlockId: () => `blk-${randomUUID().replace(/-/g, "")}-${++blockCounter}`,
    nextDeliveryId: (kind: string) =>
      `dlv-${kind}-${randomUUID().replace(/-/g, "")}-${++deliveryCounter}`,
    now,
  });
  return {
    store,
    repository: new FileModuleResultCommitRepository({
      path: join(stateDirectory, "result-commit-journal.json"),
    }),
    capabilityJournal: new CapabilityEffectJournal(
      join(stateDirectory, "capability-effect-journal"),
    ),
    receipts: new ExtensionResultReceiptJournal(
      join(stateDirectory, "extension-result-receipts"),
    ),
    effects: new ExternalEffectLog(join(stateDirectory, "external-effects")),
  };
}

/** Builds the shipped commit coordinator over the given collaborators. */
function buildCommitCoordinator(
  collaborators: { blocks: unknown; deliveries: unknown; repository: unknown },
  afterEffect?: (event: ModuleResultCommitHookEvent) => void | Promise<void>,
): ModuleResultCommitCoordinator {
  return new ModuleResultCommitCoordinator({
    blocks: collaborators.blocks as never,
    deliveries: collaborators.deliveries as never,
    repository: collaborators.repository as never,
    now,
    ...(afterEffect === undefined ? {} : { afterEffect }),
  });
}

/**
 * Wraps one object so a named method reaches a barrier before or after it runs.
 *
 * The wrapper forwards every other member unchanged and always calls the real
 * method: the boundary is instrumented, never replaced. A private field in the
 * wrapped class still works because the call keeps the real receiver.
 */
function instrument<T extends object>(
  target: T,
  hooks: Readonly<
    Record<
      string,
      {
        before?: (...arguments_: readonly unknown[]) => void;
        after?: () => void;
        once?: boolean;
      }
    >
  >,
): T {
  const fired = new Set<string>();
  return new Proxy(target, {
    get(object, property, _receiver) {
      const value = Reflect.get(object, property, object);
      if (typeof value !== "function") return value;
      const hook = typeof property === "string" ? hooks[property] : undefined;
      if (!hook) return value.bind(object);
      const name = String(property);
      return (...args: unknown[]) => {
        const skip = hook.once === true && fired.has(name);
        if (!skip) {
          fired.add(name);
          hook.before?.(...args);
        }
        const result = (value as (...values: unknown[]) => unknown).apply(object, args);
        if (!skip) hook.after?.();
        return result;
      };
    },
  }) as T;
}

// ---------------------------------------------------------------------------
// Invocation 1: run the workload and stop at the case's boundary
// ---------------------------------------------------------------------------

interface PendingCapability {
  readonly id: number;
  readonly capabilityType: string;
  readonly operation: string;
  readonly barrier: boolean;
}

async function runWorkload(
  configuration: StandinConfiguration,
  barrier: Barrier,
): Promise<Record<string, unknown>> {
  const target = barrier.target;
  const at = (boundary: string, timing: "before" | "after", detail?: string): void => {
    barrier.reach(barrierKey(boundary, timing), detail);
  };

  // --- Boundary 1: service configuration validation and Core readiness.
  at("M01", "before");
  const activation = await decideLinuxModuleActivation({
    unitName: configuration.unitName,
    mode: configuration.serviceMode,
    launcherInterpreterPath: configuration.interpreterProgram,
    launcherScriptPath: configuration.launcherScriptPath,
  });
  if (!activation.permitted) {
    return {
      phase: "activation-refused",
      refusals: activation.refusals,
      bindingFailures: activation.bindingFailures ?? [],
    };
  }
  const binding = activation.binding;
  // Core readiness includes proving that its own delegated service root can
  // distribute the cpu, memory, and pids controllers to the Module control
  // groups it will create. Without this the child groups have no `memory.max`,
  // `pids.max`, or `cpu.max` file to write at all. systemd delegates the
  // subtree but leaves its `cgroup.subtree_control` to the delegatee, which is
  // Core; `prepareDelegatedCgroupRoot` is the shipped code that does it.
  const delegatedRoot = await prepareDelegatedCgroupRoot({
    delegatedRootCgroupPath: binding.delegatedRootCgroupPath,
  });
  if (!delegatedRoot.prepared) {
    return { phase: "delegated-root-unprepared", failure: delegatedRoot.failure };
  }
  at("M01", "after", binding.serviceInvocationId);

  const processGenerationId = `pg-${randomUUID().replace(/-/g, "")}`;
  const identity = {
    instanceId: configuration.instanceId,
    moduleId: configuration.moduleId,
    processGenerationId,
  };
  const derived = deriveModuleCgroupPath(binding.delegatedRootCgroupPath, identity);

  // Recovery runs before any Module work, in every invocation. On a first
  // invocation it has nothing to reconcile; the ordering is what INV-08 is
  // about, so it is exercised here as well as after a restart.
  const core = openCore(configuration);
  const store = core.store;
  const preRecovery = new CoreStartupRecovery({
    deliveries: store.deliveries,
    commits: buildCommitCoordinator({
      blocks: store.blocks,
      deliveries: store.deliveries,
      repository: core.repository,
    }),
    moduleRecords: store,
    processStopProver: activation.stopProver,
  });
  await preRecovery.recover();
  barrier.note("recovery-complete", "invocation-1");

  // --- Seed the Delivery graph this Run consumes.
  const outputPageCount = configuration.workload === "multiple-output-pages" ? 3 : 1;
  const outputPageIds =
    configuration.workload === "no-output"
      ? []
      : Array.from({ length: outputPageCount }, (_unused, index) => `${OUTPUT_PAGE_PREFIX}${index + 1}`);
  store.deliveries.createPage(INPUT_PAGE);
  for (const pageId of outputPageIds) store.deliveries.createPage(pageId);
  store.deliveries.registerConsumer(INPUT_PAGE, configuration.moduleId, "from-now");
  const inputBlock = store.blocks.commit(
    { payload: { schema: CONTENT_SCHEMA, value: { text: `input for ${configuration.workload}` } } },
    { kind: "external", id: "experiment-console" },
  );
  store.deliveries.append(INPUT_PAGE, inputBlock.id);
  barrier.note("input-seeded", inputBlock.id);

  // The commit coordinator is built over instrumented collaborators so
  // boundaries 10 to 13 can be reached inside it. The instrumented objects
  // forward every call to the same real Block store, Delivery store, and
  // journal; nothing is replaced.
  const commitPhaseSeen = new Set<string>();
  const commits = buildCommitCoordinator(
    {
      blocks: instrument(store.blocks, {
        commitOnce: { before: () => at("M11", "before"), once: true },
      }),
      deliveries: instrument(store.deliveries, {
        appendOnce: { before: () => at("M12", "before"), once: true },
        ack: { before: () => at("M13", "before"), once: true },
      }),
      repository: instrument(core.repository, {
        createPrepared: {
          before: () => at("M10", "before"),
          after: () => at("M10", "after"),
          once: true,
        },
      }),
    },
    (event) => {
      if (commitPhaseSeen.has(event.phase)) return;
      commitPhaseSeen.add(event.phase);
      if (event.phase === "after-block-effect") at("M11", "after");
      else if (event.phase === "after-delivery-effect") at("M12", "after", event.pageId);
      else at("M13", "after");
    },
  );

  // --- Boundaries 2 to 4: the ordered Module process start.
  const records: ModuleProcessRecordStore = instrument(store, {
    appendModuleProcessRecord: {
      before: () => at("M02", "before"),
      after: () => at("M02", "after", processGenerationId),
      once: true,
    },
  }) as unknown as ModuleProcessRecordStore;

  const cgroupFileSystem: ModuleCgroupFileSystem = instrument(nodeModuleCgroupFileSystem, {
    createDirectory: { before: () => at("M03", "before"), once: true },
  });

  let launcherHandle: ReturnType<typeof startLinuxModuleLauncher> | undefined;
  const environPath = join(configuration.stateDirectory, "extension-environment.json");
  const declaredEnvironment: Readonly<Record<string, string>> = Object.freeze({
    DOLLY_FIXTURE_ENVIRON_PATH: environPath,
    DOLLY_MODULE_ID: configuration.moduleId,
    DOLLY_PROCESS_GENERATION_ID: processGenerationId,
  });
  // INV-09 compares what the Extension observed with what Core declared, so
  // the declaration is written down before the Extension can exist.
  writeDurableJson(
    join(configuration.stateDirectory, "declared-environment.json"),
    declaredEnvironment,
  );

  const startLauncher = async (): Promise<ModuleLauncherControl> => {
    // The control group exists and every limit has been written and read back
    // by the time `startModuleProcess` calls this, so this is the instant
    // after boundary 3 and before boundary 4.
    at("M03", "after", derived.filesystemPath);
    at("M04", "before");
    const started = startLinuxModuleLauncher({
      interpreterProgram: configuration.interpreterProgram,
      launcherScriptPath: configuration.launcherScriptPath,
      protocolStdio: ["pipe", "pipe", "pipe"],
      launcherEnvironment: {},
    });
    launcherHandle = started;
    started.child.stderr?.on("data", () => undefined);
    return createModuleLauncherControl({ launcher: started });
  };

  const processRecord: ModuleProcessRecord = {
    schemaVersion: "dolly.module-process-record/1",
    instanceId: configuration.instanceId,
    moduleId: configuration.moduleId,
    moduleGenerationId: configuration.moduleGenerationId,
    processGenerationId,
    packageDigest: digestOf(["experiment-extension-fixture", configuration.workload]),
    configurationReference: {
      configId: "experiment-module-config",
      revision: digestOf(["experiment-module-config", 1]),
      configVersion: 1,
    },
    declaredExternalEffects: "core-capabilities-only",
    serviceInvocationId: binding.serviceInvocationId,
    bootId: binding.bootId,
    moduleCgroupPath: derived.filesystemPath,
    state: "starting",
    createdAt: now(),
    updatedAt: now(),
  };

  const started = await startModuleProcess({
    records,
    processRecord,
    delegatedRootCgroupPath: binding.delegatedRootCgroupPath,
    identity,
    limits: MODULE_LIMITS,
    maxOpenFiles: MAX_OPEN_FILES,
    cgroupFileSystem,
    startLauncher,
    execution: {
      program: configuration.interpreterProgram,
      argumentVector: [
        configuration.interpreterProgram,
        "-I",
        "-B",
        configuration.extensionFixturePath,
      ],
      environment: declaredEnvironment,
    },
  });
  if (!started.executionAuthorized) {
    return {
      phase: "module-start-failed",
      failure: started.failure,
      processGenerationId,
      moduleCgroupPath: derived.filesystemPath,
    };
  }
  const cgroup: ModuleCgroup = started.cgroup;

  // --- The Extension protocol channel over the launcher's own descriptors.
  const child = launcherHandle!.child;
  const channelClose = createProtocolChannelCloseWaiter();
  let onFrame: (message: JsonValue) => void = () => undefined;
  const channel = new FramedJsonChannel(child.stdout!, child.stdin!, {
    maxFrameBytes: 4 * 1024 * 1024,
    onMessage: (message) => onFrame(message),
    onError: () => {
      channelClose.markClosed();
    },
    onEnd: () => {
      channelClose.markClosed();
    },
  });

  const inbound: Record<string, unknown>[] = [];
  const waiters = new Map<string, (frame: Record<string, unknown>) => void>();
  onFrame = (message) => {
    const frame = message as Record<string, unknown>;
    inbound.push(frame);
    const type = String(frame["type"]);
    if (type === "capability-request") {
      void handleCapabilityRequest(frame);
      return;
    }
    waiters.get(type)?.(frame);
  };
  const awaitFrame = (type: string, timeoutMs: number): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(type);
        reject(new Error(`the Extension did not send a ${type} frame within ${timeoutMs} ms`));
      }, timeoutMs);
      waiters.set(type, (frame) => {
        clearTimeout(timer);
        waiters.delete(type);
        resolve(frame);
      });
    });

  // --- The capability authority the Extension's requests go through.
  const authority = new ExtensionCapabilityAuthority({ now });
  const session = authority.openSession({
    extensionId: "experiment-extension",
    instanceId: configuration.instanceId,
    processGenerationId,
    sessionId: `session-${processGenerationId}`,
    moduleId: configuration.moduleId,
    moduleGenerationId: configuration.moduleGenerationId,
  });
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const logHandle = session.issue(
    {
      capabilityType: "structured-log",
      capabilityVersion: "v1",
      operations: ["write", "write-slow"],
      resourceScope: { moduleId: configuration.moduleId },
      expiresAt,
      maxInvocations: 16,
      maxConcurrentInvocations: 4,
      maxArgumentBytes: 65_536,
      maxResultBytes: 65_536,
    },
    async (argumentsValue, context) => {
      if (context.operation === "write-slow") {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      core.effects.append({ capability: "structured-log", arguments: argumentsValue });
      return { written: true };
    },
  );
  const effectHandle = session.issue(
    {
      capabilityType: "external-effect",
      capabilityVersion: "v1",
      operations: ["emit"],
      resourceScope: { moduleId: configuration.moduleId },
      expiresAt,
      maxInvocations: 16,
      maxConcurrentInvocations: 4,
      maxArgumentBytes: 65_536,
      maxResultBytes: 65_536,
      requireIdempotencyKey: true,
    },
    async (argumentsValue) => {
      // A real, externally visible effect: it is durable, it is outside Core
      // state, and repeating it would be a second effect.
      core.effects.append({ capability: "external-effect", arguments: argumentsValue });
      return { emitted: true };
    },
  );

  let claimIdentity: {
    moduleJobId: string;
    claimToken: string;
    runId: string;
    attempt: number;
    moduleGenerationId: string;
  } | null = null;

  async function handleCapabilityRequest(frame: Record<string, unknown>): Promise<void> {
    const pending: PendingCapability = {
      id: Number(frame["id"]),
      capabilityType: String(frame["capabilityType"]),
      operation: String(frame["operation"]),
      barrier: frame["barrier"] === true,
    };
    const invocationId = `${pending.capabilityType}-${pending.id}`;
    const idempotencyKey = String(frame["idempotencyKey"]);
    const runId = claimIdentity?.runId ?? "unclaimed";
    const externallyVisible = pending.capabilityType === "external-effect";
    try {
      // --- Boundary 8, start: the request's effect intent becomes durable
      // before the handler can cause any effect.
      if (pending.barrier) at("M08.start", "before");
      core.capabilityJournal.recordIntent({
        runId,
        moduleJobId: claimIdentity?.moduleJobId ?? "unclaimed",
        invocationId,
        capabilityType: pending.capabilityType,
        operation: pending.operation,
        idempotencyKey,
        externallyVisible,
      });
      if (pending.barrier) at("M08.start", "after", invocationId);

      const value = await session.invoke({
        handle: pending.capabilityType === "external-effect" ? effectHandle : logHandle,
        operation: pending.operation,
        arguments: (frame["arguments"] ?? null) as JsonValue,
        ...(claimIdentity === null
          ? {}
          : { moduleJobId: claimIdentity.moduleJobId, runId: claimIdentity.runId }),
        idempotencyKey,
      });

      // --- Boundary 8, completion: the outcome becomes durable before the
      // Extension is told anything.
      if (pending.barrier) at("M08.completion", "before");
      core.capabilityJournal.recordOutcome({ runId, invocationId, status: "succeeded" });
      if (pending.barrier) at("M08.completion", "after", invocationId);

      await channel.send({
        protocol: "dolly.experiment.module-protocol/1",
        type: "capability-result",
        id: pending.id,
        value: value as JsonValue,
      });
    } catch (error) {
      core.capabilityJournal.recordOutcome({ runId, invocationId, status: "failed" });
      try {
        await channel.send({
          protocol: "dolly.experiment.module-protocol/1",
          type: "capability-error",
          id: pending.id,
          message: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // The channel is gone; the durable outcome above is what matters.
      }
    }
  }

  await awaitFrame("ready", 30_000);
  records.updateModuleProcessRecordState(processGenerationId, "running");
  at("M04", "after", String(started.record.processGenerationId));

  // --- Boundary 5: Delivery Claim persistence.
  at("M05", "before");
  const claim = store.deliveries.claim({
    consumerId: configuration.moduleId,
    pageIds: [INPUT_PAGE],
    moduleGenerationId: configuration.moduleGenerationId,
    maxCount: 16,
    maxBytes: 1_048_576,
  });
  at("M05", "after", claim?.runId ?? "none");
  if (!claim) return { phase: "no-claim", processGenerationId };
  claimIdentity = {
    moduleJobId: claim.moduleJobId,
    claimToken: claim.claimToken,
    runId: claim.runId,
    attempt: claim.attempt,
    moduleGenerationId: claim.moduleGenerationId,
  };

  const input = buildReactiveModuleInput({
    claimedDeliveryIds: claim.deliveryIds,
    blockGroups: claim.blockGroups,
    hasMore: claim.hasMore,
  });

  // --- Boundary 6: Module submission record persistence, before the send.
  at("M06", "before");
  store.appendModuleSubmissionRecord({
    schemaVersion: "dolly.module-submission-record/1",
    moduleJobId: claim.moduleJobId,
    claimToken: claim.claimToken,
    runId: claim.runId,
    attempt: claim.attempt,
    moduleGenerationId: configuration.moduleGenerationId,
    processGenerationId,
    inputDigest: canonicalJsonDigest(input as unknown as JsonValue),
    createdAt: now(),
  });
  at("M06", "after", claim.runId);

  // --- Boundary 7: the `module.execute` protocol send.
  at("M07", "before");
  await channel.send({
    protocol: "dolly.experiment.module-protocol/1",
    type: "execute",
    runId: claim.runId,
    moduleJobId: claim.moduleJobId,
    attempt: claim.attempt,
    workload: configuration.workload,
    outputCount: outputPageIds.length,
    input: input as unknown as JsonValue,
  });
  at("M07", "after", claim.runId);

  const resultFrame = await awaitFrame("result", 120_000);

  // --- Boundary 9: Extension result receipt persistence.
  const outputText = typeof resultFrame["text"] === "string" ? (resultFrame["text"] as string) : undefined;
  at("M09", "before");
  core.receipts.record({
    runId: claim.runId,
    moduleJobId: claim.moduleJobId,
    attempt: claim.attempt,
    resultDigest: digestOf(resultFrame),
    outputCount: outputText === undefined ? 0 : outputPageIds.length,
  });
  at("M09", "after", claim.runId);

  // --- Boundaries 10 to 13 happen inside the shipped commit coordinator; the
  // instrumented collaborators above reach them.
  const commitRecord = await commits.commit({
    moduleJobId: claim.moduleJobId,
    claimToken: claim.claimToken,
    runId: claim.runId,
    attempt: claim.attempt,
    moduleGenerationId: configuration.moduleGenerationId,
    source: { kind: "module", id: configuration.moduleId },
    outputPageIds,
    ...(outputText === undefined
      ? {}
      : { blockProposal: { payload: { schema: CONTENT_SCHEMA, value: { text: outputText } } } }),
  });
  barrier.note("commit-complete", commitRecord.state);

  // --- Boundary 14: Module process record closure and collection.
  at("M14", "before");
  const stopped = await stopModuleProcess({
    records: store,
    processGenerationId,
    cgroup,
    timeoutMs: 20_000,
    closeCapabilitySession: () => session.close(),
    waitForChannelClosed: (timeoutMs) => channelClose.wait(timeoutMs),
    channelCloseTimeoutMs: 20_000,
  });
  if (!stopped.stopped) {
    return {
      phase: "stop-unproven",
      code: stopped.code,
      detail: stopped.detail,
      processGenerationId,
    };
  }
  channel.close();
  await launcherHandle!.waitForExit(10_000);
  // The Claim is terminal, so the submission record has no remaining purpose
  // and the process record can be collected. Both happen in one Core-state
  // update, as ADR 0009 requires.
  store.runAtomicUpdate(() => {
    if (store.getModuleSubmissionRecord(claim.runId)) {
      store.removeModuleSubmissionRecord(claim.runId);
    }
    store.removeModuleProcessRecord(processGenerationId);
  });
  at("M14", "after", processGenerationId);

  return {
    phase: "completed-without-interruption",
    barrierTarget: target,
    processGenerationId,
    runId: claim.runId,
    moduleJobId: claim.moduleJobId,
    commitState: commitRecord.state,
    channelClosed: channelClose.closed,
    inboundFrameTypes: inbound.map((frame) => String(frame["type"])),
  };
}

// ---------------------------------------------------------------------------
// Invocation 2 and later: recover and report
// ---------------------------------------------------------------------------

function describeState(core: CoreAssembly): Record<string, unknown> {
  const store = core.store;
  const pages: Record<string, number> = {};
  for (const page of store.deliveries.snapshot().pages) {
    pages[page.id] = page.deliveryIds.length;
  }
  const graph = store.referenceGraph.snapshot();
  return {
    revision: store.revision,
    activeClaims: store.deliveries.listActiveClaims().map((claim) => ({
      moduleJobId: claim.moduleJobId,
      runId: claim.runId,
      attempt: claim.attempt,
      status: claim.status,
      moduleGenerationId: claim.moduleGenerationId,
    })),
    moduleProcessRecords: store.listModuleProcessRecords().map((record) => ({
      processGenerationId: record.processGenerationId,
      moduleGenerationId: record.moduleGenerationId,
      state: record.state,
      declaredExternalEffects: record.declaredExternalEffects,
      serviceInvocationId: record.serviceInvocationId,
      bootId: record.bootId,
      moduleCgroupPath: record.moduleCgroupPath,
      ...(record.failureCode === undefined ? {} : { failureCode: record.failureCode }),
    })),
    moduleSubmissionRecords: store.listModuleSubmissionRecords().map((record) => ({
      runId: record.runId,
      moduleJobId: record.moduleJobId,
      processGenerationId: record.processGenerationId,
    })),
    commitRecords: core.repository.list().map((record) => ({
      moduleJobId: record.moduleJobId,
      runId: record.runId,
      state: record.state,
      revision: record.revision,
      outputPageIds: [...record.outputPageIds],
      outputDeliveries: record.outputDeliveries.map((delivery) => ({ ...delivery })),
      ...(record.blockId === undefined ? {} : { blockId: record.blockId }),
    })),
    deliveriesByPage: pages,
    blockCount: store.blocks.snapshot().records.length,
    capabilityJournal: core.capabilityJournal.entries(),
    externalEffects: core.effects.entries(),
    resultReceipts: core.receipts.entries(),
    strongReferenceCount: graph.strongReferences.length,
    leaseCount: graph.leases.length,
  };
}

async function runRecovery(
  configuration: StandinConfiguration,
  barrier: Barrier,
): Promise<Record<string, unknown>> {
  barrier.note("recovery-invocation-start");
  const activation = await decideLinuxModuleActivation({
    unitName: configuration.unitName,
    mode: configuration.serviceMode,
    launcherInterpreterPath: configuration.interpreterProgram,
    launcherScriptPath: configuration.launcherScriptPath,
  });
  if (!activation.permitted) {
    return {
      phase: "activation-refused",
      refusals: activation.refusals,
      bindingFailures: activation.bindingFailures ?? [],
    };
  }
  barrier.note("service-binding-verified", activation.binding.serviceInvocationId);

  const core = openCore(configuration);
  const before = describeState(core);

  // ADR 0009 accepts only durable evidence about a submitted Run's external
  // effects. The journal is read from disk on every question, so no in-memory
  // duplicate map can stand in for it after a restart.
  const externalEffectEvidence = {
    inspectRunEffects: async (submission: { runId: string }): Promise<ExternalEffectEvidence> => {
      const unresolved = core.capabilityJournal.unresolvedInvocations(submission.runId);
      if (unresolved.length > 0) {
        return {
          kind: "unknown",
          reason: `${unresolved.length} capability invocation${
            unresolved.length === 1 ? " has" : "s have"
          } a durable effect intent and no durable outcome`,
        };
      }
      const intents = core.capabilityJournal
        .entries()
        .filter(
          (entry): entry is Extract<typeof entry, { kind: "intent" }> =>
            entry.kind === "intent" && entry.runId === submission.runId,
        );
      if (intents.some((intent) => intent.externallyVisible)) {
        // Every externally visible effect of this Run reached a durable
        // outcome, so repeating the Run would repeat the effect: the Claim may
        // be released, but only because the outcome is known.
        return { kind: "terminal" };
      }
      return { kind: "no-effect" };
    },
  };

  // Every empty-group proof the shipped prover produces is recorded here, not
  // taken from recovery's return value. A recovery that legitimately refuses
  // to continue — an unknown external effect outcome, for example — throws
  // before it returns a report, and INV-06 still has to be answerable from the
  // proofs that did happen.
  const stopProofs: { processGenerationId: string; proof: unknown }[] = [];
  const processStopProver = {
    proveStopped: async (item: ModuleProcessRecord) => {
      const proof = await activation.stopProver.proveStopped(item);
      stopProofs.push({ processGenerationId: item.processGenerationId, proof });
      barrier.note(
        "stop-proof",
        `${item.processGenerationId} ${proof.proven ? proof.evidence : `unproven: ${proof.reason}`}`,
      );
      return proof;
    },
  };

  const recovery = new CoreStartupRecovery({
    deliveries: core.store.deliveries,
    commits: buildCommitCoordinator({
      blocks: core.store.blocks,
      deliveries: core.store.deliveries,
      repository: core.repository,
    }),
    moduleRecords: core.store,
    processStopProver,
    externalEffectEvidence,
  });

  let report: unknown = null;
  let failure: { code: string; message: string } | null = null;
  try {
    report = await recovery.recover();
    barrier.note("recovery-complete", "invocation-2");
  } catch (error) {
    failure =
      error instanceof CoreStartupRecoveryError
        ? { code: error.code, message: error.message }
        : { code: "UNEXPECTED", message: error instanceof Error ? error.message : String(error) };
    barrier.note("recovery-refused", failure.code);
  }

  return {
    phase: "recovered",
    binding: {
      serviceInvocationId: activation.binding.serviceInvocationId,
      bootId: activation.binding.bootId,
      delegatedRootCgroupPath: activation.binding.delegatedRootCgroupPath,
      coreCgroupPath: activation.binding.coreCgroupPath,
      mainPid: activation.binding.mainPid,
    },
    stateBeforeRecovery: before,
    stateAfterRecovery: describeState(core),
    recoveryReport: report,
    recoveryFailure: failure,
    stopProofs,
    // The stand-in never signals a process identifier: it terminates control
    // groups. Recorded explicitly so INV-07 is evaluated from evidence.
    signalledRecoveredProcessId: false,
    startedModuleWorkDuringRecovery: false,
  };
}

// ---------------------------------------------------------------------------
// Live Core termination: Core stays alive and terminates one Module
// ---------------------------------------------------------------------------

/** Reads one control-group file, or `null` when it cannot be read. */
function readCgroupFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function cgroupMembers(cgroupPath: string): readonly string[] {
  const content = readCgroupFile(`${cgroupPath}/cgroup.procs`);
  if (content === null) return [];
  return content.split("\n").filter((line) => line.trim().length > 0);
}

function cgroupPopulated(cgroupPath: string): string | null {
  const content = readCgroupFile(`${cgroupPath}/cgroup.events`);
  if (content === null) return null;
  for (const line of content.split("\n")) {
    const [key, value] = line.trim().split(/\s+/u);
    if (key === "populated") return value ?? null;
  }
  return null;
}

/**
 * One live termination case.
 *
 * This is deliberately a separate flow rather than a branch inside
 * `runWorkload`. That function is the fixed interruption matrix's path and is
 * shared by two hundred and ten cases in each of two arms; adding branches to
 * it would put those results at risk for no benefit. Everything below reuses
 * the same shipped parts and the same helpers.
 *
 * Core is never interrupted here. It performs the termination itself, stays
 * alive across it, and writes its own report, so the case's evidence that Core
 * survived is the service manager's unchanged invocation identity rather than
 * anything this file claims about itself.
 */
async function runLiveTermination(
  configuration: StandinConfiguration,
  barrier: Barrier,
): Promise<Record<string, unknown>> {
  const reason = configuration.terminationReason ?? "orderly-stop";
  const membershipTiming = configuration.membershipTiming ?? "after";
  const wantsDescendant = configuration.descendant === "forked";

  const activation = await decideLinuxModuleActivation({
    unitName: configuration.unitName,
    mode: configuration.serviceMode,
    launcherInterpreterPath: configuration.interpreterProgram,
    launcherScriptPath: configuration.launcherScriptPath,
  });
  if (!activation.permitted) {
    return {
      phase: "activation-refused",
      refusals: activation.refusals,
      bindingFailures: activation.bindingFailures ?? [],
    };
  }
  const binding = activation.binding;
  const delegatedRoot = await prepareDelegatedCgroupRoot({
    delegatedRootCgroupPath: binding.delegatedRootCgroupPath,
  });
  if (!delegatedRoot.prepared) {
    return { phase: "delegated-root-unprepared", failure: delegatedRoot.failure };
  }
  barrier.note("service-binding-verified", binding.serviceInvocationId);

  const core = openCore(configuration);
  const store = core.store;
  // INV-08: recovery runs before any Module work in every invocation.
  await new CoreStartupRecovery({
    deliveries: store.deliveries,
    commits: buildCommitCoordinator({
      blocks: store.blocks,
      deliveries: store.deliveries,
      repository: core.repository,
    }),
    moduleRecords: store,
    processStopProver: activation.stopProver,
  }).recover();
  barrier.note("recovery-complete", "live-termination");

  const generations: Record<string, unknown>[] = [];

  /**
   * Starts one Module generation and terminates it for this case's reason.
   *
   * Returns everything the case asserts on. Every reading of the control group
   * comes from kernel files, never from a launcher report or a child handle.
   */
  const runGeneration = async (
    ordinal: number,
    stopBeforeMembership: boolean,
  ): Promise<Record<string, unknown>> => {
    const processGenerationId = `pg-${randomUUID().replace(/-/g, "")}`;
    const identity = {
      instanceId: configuration.instanceId,
      moduleId: configuration.moduleId,
      processGenerationId,
    };
    const derived = deriveModuleCgroupPath(binding.delegatedRootCgroupPath, identity);
    const environPath = join(
      configuration.stateDirectory,
      `extension-environment-${ordinal}.json`,
    );
    const declaredEnvironment: Readonly<Record<string, string>> = Object.freeze({
      DOLLY_FIXTURE_ENVIRON_PATH: environPath,
      DOLLY_MODULE_ID: configuration.moduleId,
      DOLLY_PROCESS_GENERATION_ID: processGenerationId,
    });
    if (ordinal === 1) {
      writeDurableJson(
        join(configuration.stateDirectory, "declared-environment.json"),
        declaredEnvironment,
      );
    }

    // This ordered list records only operations aimed at this generation's
    // derived Module cgroup. It lets the evaluator distinguish a real
    // `cgroup.kill` and empty-state read from a report that merely claims one.
    const cgroupOperations: string[] = [];
    const cgroupFileSystem: ModuleCgroupFileSystem = instrument(
      nodeModuleCgroupFileSystem,
      {
        readTextFile: {
          before: (path) => {
            if (path === `${derived.filesystemPath}/cgroup.events`) {
              cgroupOperations.push("read-cgroup-events");
            }
          },
        },
        writeTextFile: {
          before: (path) => {
            if (path === `${derived.filesystemPath}/cgroup.kill`) {
              cgroupOperations.push("write-cgroup-kill");
            }
          },
        },
        removeDirectory: {
          before: (path) => {
            if (path === derived.filesystemPath) {
              cgroupOperations.push("remove-cgroup-directory");
            }
          },
        },
      },
    );

    let launcherHandle: ReturnType<typeof startLinuxModuleLauncher> | undefined;
    // Filled when the lifecycle performs its early stop check, before the
    // product controller begins configuration and membership verification.
    let preMembership: Record<string, unknown> | null = null;

    const startLauncher = async (): Promise<ModuleLauncherControl> => {
      const started = startLinuxModuleLauncher({
        interpreterProgram: configuration.interpreterProgram,
        launcherScriptPath: configuration.launcherScriptPath,
        protocolStdio: ["pipe", "pipe", "pipe"],
        launcherEnvironment: {},
      });
      launcherHandle = started;
      started.child.stderr?.on("data", () => undefined);
      return createModuleLauncherControl({ launcher: started });
    };

    const processRecord: ModuleProcessRecord = {
      schemaVersion: "dolly.module-process-record/1",
      instanceId: configuration.instanceId,
      moduleId: configuration.moduleId,
      moduleGenerationId: `${configuration.moduleGenerationId}-${ordinal}`,
      processGenerationId,
      packageDigest: digestOf(["experiment-extension-fixture", "live-termination"]),
      configurationReference: {
        configId: "experiment-module-config",
        revision: digestOf(["experiment-module-config", 1]),
        configVersion: 1,
      },
      declaredExternalEffects: "core-capabilities-only",
      serviceInvocationId: binding.serviceInvocationId,
      bootId: binding.bootId,
      moduleCgroupPath: derived.filesystemPath,
      state: "starting",
      createdAt: now(),
      updatedAt: now(),
    };

    const started = await startModuleProcess({
      records: store,
      processRecord,
      delegatedRootCgroupPath: binding.delegatedRootCgroupPath,
      identity,
      limits: MODULE_LIMITS,
      maxOpenFiles: MAX_OPEN_FILES,
      cgroupFileSystem,
      startLauncher,
      execution: {
        program: configuration.interpreterProgram,
        argumentVector: [
          configuration.interpreterProgram,
          "-I",
          "-B",
          configuration.extensionFixturePath,
        ],
        environment: declaredEnvironment,
      },
      stopRequested: () => {
        if (!stopBeforeMembership) return false;
        // The lifecycle evaluates this callback before the product controller
        // begins configuration and membership verification. Record the actual
        // kernel state instead of claiming the launcher has already joined.
        preMembership = {
          at: now(),
          members: cgroupMembers(derived.filesystemPath),
          populated: cgroupPopulated(derived.filesystemPath),
        };
        barrier.note(
          "pre-membership-stop-requested",
          `${processGenerationId} members=${(preMembership["members"] as string[]).length}`,
        );
        return true;
      },
    });

    if (!started.executionAuthorized) {
      // With no observed member, the product lifecycle observes launcher exit,
      // reads the group's current empty state again, and removes the directory
      // without writing cgroup.kill.
      //
      // The independent check below asks the generic termination operation to
      // terminate a different group in which no member was ever observed. It
      // must refuse to call a plain empty reading whole-group termination
      // proof. This is distinct from the case cleanup above, where observed
      // launcher exit plus successful directory removal supplies the missing
      // enforcement.
      const record = store
        .listModuleProcessRecords()
        .find((item) => item.processGenerationId === processGenerationId);
      const afterMembers = cgroupMembers(derived.filesystemPath);
      let genericTerminationCheck: Record<string, unknown> = {
        ran: false,
        reason: "the independent control group could not be prepared",
      };
      try {
        // Use a fresh group so this check cannot reuse or change the case's
        // directory-removal evidence.
        const probeIdentity = {
          instanceId: configuration.instanceId,
          moduleId: configuration.moduleId,
          processGenerationId: `probe-${randomUUID().replace(/-/g, "")}`,
        };
        const probed = await prepareModuleCgroup({
          delegatedRootCgroupPath: binding.delegatedRootCgroupPath,
          identity: probeIdentity,
          limits: MODULE_LIMITS,
        });
        if (probed.prepared) {
          const outcome = await probed.cgroup.terminate({ timeoutMs: 2_000 });
          genericTerminationCheck = outcome.terminated
            ? {
                ran: true,
                refused: false,
                evidence: outcome.evidence,
                detail:
                  "generic termination incorrectly treated a plain empty reading as whole-group termination proof",
              }
            : { ran: true, refused: true, code: outcome.code, detail: outcome.detail };
        } else {
          genericTerminationCheck = {
            ran: false,
            reason: `prepare failed: ${probed.failure.code}`,
          };
        }
      } catch (error) {
        genericTerminationCheck = {
          ran: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      barrier.note(
        "generic-termination-without-observed-membership",
        `${String(genericTerminationCheck["ran"])} ${String(genericTerminationCheck["code"] ?? genericTerminationCheck["reason"] ?? "")}`,
      );
      return {
        ordinal,
        processGenerationId,
        moduleCgroupPath: derived.filesystemPath,
        started: false,
        startFailure: started.failure,
        preMembership,
        executionAuthorized: false,
        cgroupOperations,
        launcherExit: launcherHandle?.exit ?? null,
        groupTerminationAttempted: cgroupOperations.includes("write-cgroup-kill"),
        groupTerminationSkippedBecause:
          started.failure.coreMustExit
            ? "startup cleanup was unconfirmed and the Core service must exit"
            : "no member was observed, so cleanup observed launcher exit, read the current empty state, and removed the directory without cgroup.kill",
        genericTerminationWithoutObservedMembership: genericTerminationCheck,
        membersAfterStop: afterMembers,
        populatedAfterStop: cgroupPopulated(derived.filesystemPath),
        groupDirectoryPresentAfterStop: existsSync(derived.filesystemPath),
        recordState: record?.state ?? null,
        recordFailureCode: record?.failureCode ?? null,
        descendantRequested: wantsDescendant,
        descendantStarted: false,
      };
    }

    const cgroup: ModuleCgroup = started.cgroup;

    // --- The Extension protocol channel, as in the interruption matrix.
    const child = launcherHandle!.child;
    let onFrame: (message: JsonValue) => void = () => undefined;
    const channelClose = createProtocolChannelCloseWaiter();
    const channel = new FramedJsonChannel(child.stdout!, child.stdin!, {
      maxFrameBytes: 4 * 1024 * 1024,
      onMessage: (message) => onFrame(message),
      onError: () => channelClose.markClosed(),
      onEnd: () => channelClose.markClosed(),
    });
    const waiters = new Map<string, (frame: Record<string, unknown>) => void>();
    onFrame = (message) => {
      const frame = message as Record<string, unknown>;
      waiters.get(String(frame["type"]))?.(frame);
    };
    const awaitFrame = (type: string, timeoutMs: number): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(type);
          reject(new Error(`the Extension did not send a ${type} frame within ${timeoutMs} ms`));
        }, timeoutMs);
        waiters.set(type, (frame) => {
          clearTimeout(timer);
          waiters.delete(type);
          resolve(frame);
        });
      });

    await awaitFrame("ready", 30_000);
    store.updateModuleProcessRecordState(processGenerationId, "running");
    barrier.note("extension-ready", processGenerationId);

    await channel.send({
      protocol: "dolly.experiment.module-protocol/1",
      type: "execute",
      runId: `live-${processGenerationId}`,
      moduleJobId: `live-job-${ordinal}`,
      attempt: 1,
      workload: wantsDescendant ? "live-descendant" : "live-quiet",
      outputCount: 0,
      ackDescendant: wantsDescendant,
      input: null,
    });

    let descendantPid: number | null = null;
    if (wantsDescendant) {
      // Deterministic: Core waits for the Extension's own confirmation that the
      // descendant exists. No sleep is used to guess when it appeared.
      const acknowledgement = await awaitFrame("descendant-started", 30_000);
      descendantPid = Number(acknowledgement["descendantPid"]);
      barrier.note("descendant-started", String(descendantPid));
    }

    // `hard-timeout` is a real expiry, not a label: Core waits for a result the
    // fixture never sends, its own finite deadline passes, and the termination
    // that follows is the timeout's cleanup.
    let timeoutExpired = false;
    if (reason === "hard-timeout") {
      try {
        await awaitFrame("result", 2_000);
      } catch {
        timeoutExpired = true;
      }
      barrier.note("hard-timeout-expired", String(timeoutExpired));
    }

    const membersBefore = cgroupMembers(derived.filesystemPath);
    const populatedBefore = cgroupPopulated(derived.filesystemPath);
    barrier.note(
      "before-termination",
      `${processGenerationId} members=${membersBefore.length} populated=${populatedBefore}`,
    );

    const stopped = await stopModuleProcess({
      records: store,
      processGenerationId,
      cgroup,
      timeoutMs: 20_000,
      // This live-termination case does not create a capability authority or
      // issue handles, so there is no applicable capability session to close.
      closeCapabilitySession: () => Promise.resolve(),
      waitForChannelClosed: (timeoutMs) => channelClose.wait(timeoutMs),
      channelCloseTimeoutMs: 20_000,
    });
    const membersAfter = cgroupMembers(derived.filesystemPath);
    const populatedAfter = cgroupPopulated(derived.filesystemPath);
    barrier.note(
      "after-termination",
      `${processGenerationId} stopped=${stopped.stopped} populated=${populatedAfter}`,
    );

    channel.close();
    try {
      await launcherHandle!.waitForExit(10_000);
    } catch {
      // The group termination is the proof; the handle is only a courtesy.
    }

    const record = store
      .listModuleProcessRecords()
      .find((item) => item.processGenerationId === processGenerationId);

    return {
      ordinal,
      processGenerationId,
      moduleCgroupPath: derived.filesystemPath,
      started: true,
      executionAuthorized: true,
      preMembership,
      descendantRequested: wantsDescendant,
      descendantStarted: descendantPid !== null,
      descendantPid,
      hardTimeoutExpired: timeoutExpired,
      membersBeforeTermination: membersBefore,
      populatedBeforeTermination: populatedBefore,
      cgroupOperations,
      groupTerminationAttempted: cgroupOperations.includes("write-cgroup-kill"),
      terminationOutcome: stopped.stopped
        ? { terminated: true, record: { state: stopped.record.state } }
        : { terminated: false, code: stopped.code, detail: stopped.detail },
      membersAfterTermination: membersAfter,
      populatedAfterTermination: populatedAfter,
      groupDirectoryPresentAfterTermination: existsSync(derived.filesystemPath),
      recordState: record?.state ?? null,
      recordFailureCode: record?.failureCode ?? null,
    };
  };

  const first = await runGeneration(1, membershipTiming === "before");
  generations.push(first);

  // INV-06: a replacement may start only after the old group is proven empty.
  // The proof is read back from the first generation's own outcome, so a
  // replacement started without it is visible in the report rather than hidden.
  let replacementStartedAfterProof: boolean | null = null;
  if (reason === "replacement") {
    const outcome = first["terminationOutcome"] as { terminated?: boolean } | undefined;
    replacementStartedAfterProof = outcome?.terminated === true;
    if (replacementStartedAfterProof) {
      generations.push(await runGeneration(2, false));
    } else {
      barrier.note("replacement-withheld", "the old control group was not proven empty");
    }
  }

  return {
    phase: "live-termination-complete",
    terminationReason: reason,
    membershipTiming,
    descendant: configuration.descendant ?? "none",
    binding: {
      serviceInvocationId: binding.serviceInvocationId,
      bootId: binding.bootId,
      delegatedRootCgroupPath: binding.delegatedRootCgroupPath,
      coreCgroupPath: binding.coreCgroupPath,
      mainPid: binding.mainPid,
    },
    generations,
    replacementStartedAfterProof,
    // Core reached the end of this function, so it was alive throughout. The
    // case still proves it independently from the service manager's unchanged
    // invocation identity; this is a cross-check, not the evidence.
    coreStayedAlive: true,
    corePid: process.pid,
    signalledRecoveredProcessId: false,
    stateAfter: describeState(core),
  };
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const configurationPath = process.argv[2];
  if (configurationPath === undefined) {
    process.stderr.write("usage: core-standin.mts <configuration.json>\n");
    return 64;
  }
  const configuration = JSON.parse(readFileSync(configurationPath, "utf8")) as StandinConfiguration;
  mkdirSync(configuration.stateDirectory, { recursive: true });
  mkdirSync(configuration.barrierDirectory, { recursive: true });

  const invocation = claimInvocationNumber(
    join(configuration.stateDirectory, "invocation-count.json"),
  );
  const barrier = new Barrier({
    directory: configuration.barrierDirectory,
    // A live-termination case never interrupts Core, so it has no interruption
    // target and `Barrier.reach` can never block this process.
    target:
      configuration.mode === "live-termination"
        ? null
        : invocation === 1
          ? barrierKey(configuration.boundary, configuration.timing)
          : null,
    invocation,
    describe: () => ({ caseId: configuration.caseId, invocation }),
  });

  let outcome: Record<string, unknown>;
  try {
    if (configuration.mode === "live-termination") {
      // Core is not interrupted in this mode, so there is no second invocation
      // to recover: one invocation performs the termination and reports.
      outcome = await runLiveTermination(configuration, barrier);
    } else {
      outcome =
        invocation === 1
          ? await runWorkload(configuration, barrier)
          : await runRecovery(configuration, barrier);
    }
  } catch (error) {
    outcome = {
      phase: "threw",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
  }

  writeDurableJson(join(configuration.barrierDirectory, `report-${invocation}.json`), {
    caseId: configuration.caseId,
    invocation,
    boundary: configuration.boundary,
    timing: configuration.timing,
    workload: configuration.workload,
    barrierTarget: barrier.target,
    reachedBarrier: barrier.reachedTarget,
    pid: process.pid,
    at: now(),
    ...outcome,
  });
  // Exit zero so `Restart=on-failure` does not restart the service again. A
  // case that needs another restart kills the process instead.
  return 0;
}

process.exitCode = await main();
// Nothing else should keep the event loop alive; anything that does is a leak
// this experiment wants to see rather than hide.
process.exit(process.exitCode);
