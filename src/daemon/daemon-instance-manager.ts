/**
 * Multi-instance supervision for the Dolly daemon.
 *
 * One daemon manages many instances. Per-instance process supervision — the
 * generation-aware state machine, the authenticated readiness handshake, the
 * rolling restart budget, and the refusal to signal an unproven process — is
 * already implemented by `ProcessSupervisor`, so this manager composes it
 * rather than reimplementing it. What it adds is everything that only exists
 * once there is more than one instance:
 *
 * - enumerating registered instances and reporting a status backed by
 *   evidence (controller-lock ownership, an authenticated readiness handshake,
 *   and a reconciled durable process record) instead of a single field;
 * - owning the `controllerLock` for exactly the instances it supervises, as
 *   `security-operations.md` Section 7.5 requires;
 * - maintaining the durable process records of Section 7.4 so a later daemon
 *   can tell a proven live child from an identifier it must never signal; and
 *   emitting the Section 11 audit events for each administrative action.
 *
 * Every path that could reach a signal goes through recorded identity first.
 * When identity cannot be proven the record is marked stale, the instance
 * becomes visibly unresolved, and no signal and no duplicate spawn follow.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { deepFreeze, type JsonValue } from "../core/canonical-json.js";
import {
  InstanceControllerLock,
  InstanceControllerLockError,
} from "../core/instance-controller-lock.js";
import { projectRuntimeInstanceStableId } from "../core/runtime-authority-identities.js";
import {
  ProcessSupervisor,
  ProcessSupervisorError,
  type ProcessLauncher,
  type ProcessSupervisorSnapshot,
  type ProcessSupervisorState,
  type SupervisorClock,
  type SupervisorEndpoint,
  type SupervisorFailure,
  type SupervisorReadinessEndpointPolicy,
  type SupervisorRestartPolicy,
} from "../core/process-supervisor.js";
import {
  deriveIpcSessionId,
  InstanceProcessRecordStore,
  type InstanceProcessRecord,
  type InstanceProcessRecordState,
} from "./instance-process-record-store.js";
import {
  evaluateProcessRecord,
  probeInstanceControllerLock,
  readInstanceRegistry,
  type ControllerLockObservation,
  type ProcessRecordEvidence,
  type RegisteredInstance,
} from "./instance-registry.js";
import { createOsProcessIdentityProbe, type ProcessIdentityProbe } from "./process-identity.js";
import {
  ProcessGenerationSequence,
  formatProcessGenerationToken,
  parseProcessGenerationToken,
} from "./process-generation.js";

const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type DaemonInstanceStatus =
  | ProcessSupervisorState
  | "controlled-elsewhere"
  | "orphaned"
  | "unresolved";

export interface DaemonInstanceEvidence {
  readonly controllerLock: ControllerLockObservation;
  /** `authenticated` only after a validated readiness envelope for the current generation. */
  readonly readinessHandshake: "authenticated" | "absent";
  readonly processRecord: ProcessRecordEvidence["kind"];
  /** Why identity could not be proven, when that is the reason for the status. */
  readonly identityReason?: string;
}

export interface DaemonInstanceReport {
  readonly instanceId: string;
  readonly configPath: string;
  readonly stateDirectory: string;
  readonly desiredConfigRevision: string;
  readonly status: DaemonInstanceStatus;
  readonly managedByThisDaemon: boolean;
  readonly evidence: DaemonInstanceEvidence;
  readonly processGenerationId?: string;
  readonly pid?: number;
  readonly endpoints: readonly SupervisorEndpoint[];
  readonly unexpectedExitCount: number;
  readonly restartStreak: number;
  readonly nextRestartAt?: string;
  readonly lastFailure?: SupervisorFailure;
}

export interface DaemonAuditEvent {
  readonly schemaVersion: "dolly.daemon-audit/1";
  readonly observedAt: string;
  readonly eventType: string;
  readonly result: "succeeded" | "refused" | "failed";
  readonly operationId: string;
  readonly instanceId: string;
  readonly controllerId: string;
  readonly configRevision: string;
  readonly processGenerationId?: string;
  readonly pid?: number;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

export type DaemonInstanceManagerErrorCode =
  | "DAEMON_INSTANCE_NOT_REGISTERED"
  | "DAEMON_INSTANCE_OPERATION_INVALID"
  | "DAEMON_INSTANCE_CONTROLLED_ELSEWHERE"
  | "DAEMON_INSTANCE_IDENTITY_UNPROVEN"
  | "DAEMON_INSTANCE_ORPHAN_UNRESOLVED"
  | "DAEMON_INSTANCE_LOCK_FAILED"
  | "DAEMON_INSTANCE_SHUTTING_DOWN";

export class DaemonInstanceManagerError extends Error {
  constructor(
    readonly code: DaemonInstanceManagerErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "DaemonInstanceManagerError";
  }
}

export interface DaemonInstanceManagerOptions {
  /** Directory holding `instances/` records and controller-lock namespacing. */
  readonly registryDirectory: string;
  /** Owner-only directory holding one durable process record per instance. */
  readonly processRecordDirectory: string;
  readonly createLauncher: (instance: RegisteredInstance) => ProcessLauncher;
  readonly daemonProtocolVersion: string;
  readonly ipcProtocolVersion: string;
  readonly readinessEndpointPolicy: SupervisorReadinessEndpointPolicy;
  readonly identityProbe?: ProcessIdentityProbe;
  readonly controllerId?: string;
  readonly audit?: (event: DaemonAuditEvent) => void;
  readonly clock?: SupervisorClock;
  readonly now?: () => string;
  readonly random?: () => number;
  readonly readinessTimeoutMs?: number;
  readonly gracefulStopTimeoutMs?: number;
  readonly hardStopTimeoutMs?: number;
  readonly restartPolicy?: Partial<SupervisorRestartPolicy>;
}

/**
 * Correlates the generation identifier the supervisor allocates with the
 * per-generation identity secret it allocates immediately afterwards, so the
 * durable record can name the authenticated IPC session without storing the
 * secret that authenticates it.
 */
class GenerationSecretLedger {
  readonly #generations: ProcessGenerationSequence;
  readonly #ipcSessionIds = new Map<string, string>();
  #pending?: string;

  constructor(generations: ProcessGenerationSequence) {
    this.#generations = generations;
  }

  nextProcessGenerationId(): string {
    const processGenerationId = formatProcessGenerationToken(this.#generations.bump());
    this.#pending = processGenerationId;
    return processGenerationId;
  }

  nextSecret(kind: "readiness-secret" | "readiness-challenge" | "process-identity"): string {
    const secret = randomBytes(32).toString("base64url");
    if (kind !== "process-identity") return secret;
    const processGenerationId = this.#pending;
    if (processGenerationId === undefined) {
      throw new DaemonInstanceManagerError(
        "DAEMON_INSTANCE_OPERATION_INVALID",
        "A process identity secret was requested outside a generation allocation",
      );
    }
    this.#pending = undefined;
    if (this.#ipcSessionIds.size > 64) {
      const oldest = this.#ipcSessionIds.keys().next();
      if (!oldest.done) this.#ipcSessionIds.delete(oldest.value);
    }
    this.#ipcSessionIds.set(processGenerationId, deriveIpcSessionId(secret));
    return secret;
  }

  ipcSessionId(processGenerationId: string): string | undefined {
    return this.#ipcSessionIds.get(processGenerationId);
  }
}

interface ManagedInstance {
  readonly instance: RegisteredInstance;
  readonly lock: InstanceControllerLock;
  readonly supervisor: ProcessSupervisor;
  readonly ledger: GenerationSecretLedger;
  readonly authenticatedGenerations: Set<string>;
  unsubscribe: () => void;
  snapshot: ProcessSupervisorSnapshot;
  recordTail: Promise<void>;
}

function mapRecordState(state: ProcessSupervisorState): InstanceProcessRecordState | undefined {
  switch (state) {
    case "starting":
      return "starting";
    case "ready":
    case "running":
      return "running";
    case "stopping":
      return "stopping";
    default:
      return undefined;
  }
}

/** Failures after which the child may still be alive, so the record is stale. */
function leavesProcessPossiblyAlive(failure: SupervisorFailure | undefined): boolean {
  return (
    failure?.code === "SUPERVISOR_PROCESS_IDENTITY_UNPROVEN" ||
    failure?.code === "SUPERVISOR_STOP_TIMEOUT"
  );
}

export class DaemonInstanceManager {
  readonly #options: DaemonInstanceManagerOptions;
  readonly #records: InstanceProcessRecordStore;
  readonly #probe: ProcessIdentityProbe;
  readonly #controllerId: string;
  readonly #generations: ProcessGenerationSequence;
  readonly #now: () => string;
  readonly #managed = new Map<string, ManagedInstance>();
  readonly #instanceTails = new Map<string, Promise<unknown>>();
  #shuttingDown = false;

  constructor(options: DaemonInstanceManagerOptions) {
    this.#options = options;
    this.#records = new InstanceProcessRecordStore({
      directory: options.processRecordDirectory,
    });
    this.#probe = options.identityProbe ?? createOsProcessIdentityProbe();
    this.#controllerId = options.controllerId ?? randomUUID();
    // One supervision epoch per daemon session: the controller identity scopes
    // every generation counter, so a later session can never reuse a token.
    this.#generations = new ProcessGenerationSequence({ epoch: this.#controllerId });
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  get controllerId(): string {
    return this.#controllerId;
  }

  /** Instances this daemon currently owns a controller lock for. */
  get managedInstanceIds(): readonly string[] {
    return [...this.#managed.keys()].sort();
  }

  listRegisteredInstances(): readonly RegisteredInstance[] {
    return readInstanceRegistry(this.#options.registryDirectory);
  }

  /**
   * Reports every registered instance. A status is derived from observed
   * evidence: this daemon's authenticated supervision, otherwise controller
   * lock ownership, otherwise a reconciled durable process record.
   */
  async listInstances(
    options: { readonly probeControllerLocks?: boolean } = {},
  ): Promise<readonly DaemonInstanceReport[]> {
    const probeLocks = options.probeControllerLocks ?? true;
    const reports: DaemonInstanceReport[] = [];
    for (const instance of this.listRegisteredInstances()) {
      reports.push(
        await this.#enqueue(instance.instanceId, () => this.#report(instance, probeLocks)),
      );
    }
    return deepFreeze(reports) as readonly DaemonInstanceReport[];
  }

  async describeInstance(instanceId: string): Promise<DaemonInstanceReport> {
    const instance = this.#requireRegistered(instanceId);
    return this.#enqueue(instanceId, () => this.#report(instance, true));
  }

  startInstance(instanceId: string, operationId: string): Promise<DaemonInstanceReport> {
    return this.#start(instanceId, operationId, false);
  }

  /** Explicit administrative retry after the restart budget was exhausted. */
  retryInstance(instanceId: string, operationId: string): Promise<DaemonInstanceReport> {
    return this.#start(instanceId, operationId, true);
  }

  stopInstance(instanceId: string, operationId: string): Promise<DaemonInstanceReport> {
    return this.#stop(instanceId, operationId);
  }

  /**
   * Removes a stale durable record. Cleaning up a record and terminating a
   * proven child are separate audited operations; this one never signals.
   */
  clearStaleRecord(instanceId: string, operationId: string): Promise<DaemonInstanceReport> {
    return this.#serialize(instanceId, operationId, async () => {
      const instance = this.#requireRegistered(instanceId);
      const record = this.#records.read(instanceId);
      if (record !== null && record.state !== "stale") {
        this.#audit({
          eventType: "instance.stale-record-cleanup",
          result: "refused",
          operationId,
          instance,
          processGenerationId: record.processGenerationId,
          pid: record.pid,
          details: { reason: "record-is-not-marked-stale", recordState: record.state },
        });
        throw new DaemonInstanceManagerError(
          "DAEMON_INSTANCE_OPERATION_INVALID",
          "Only a stale process record can be cleaned up",
          { instanceId, recordState: record.state },
        );
      }
      const removed = this.#records.clear(instanceId);
      this.#audit({
        eventType: "instance.stale-record-cleanup",
        result: "succeeded",
        operationId,
        instance,
        ...(record === null ? {} : { processGenerationId: record.processGenerationId, pid: record.pid }),
        details: { removed, signalled: false },
      });
      return this.#report(instance, true);
    });
  }

  /** Stops everything this daemon owns and releases its controller locks. */
  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    const instanceIds = [...this.#managed.keys()];
    for (const instanceId of instanceIds) {
      const managed = this.#managed.get(instanceId);
      if (!managed) continue;
      try {
        await managed.supervisor.stop(`shutdown-${randomUUID()}`);
      } catch {
        // A refused stop still releases this daemon's ownership below; the
        // durable record keeps whatever evidence the supervisor produced.
      }
      await this.#enqueue(instanceId, () => this.#detach(managed));
    }
  }

  /**
   * Only the critical section — lock ownership, reconciliation, and supervisor
   * registration — runs inside the per-instance queue. Waiting for readiness
   * stays outside it so a stuck start cannot block reporting or its own stop.
   */
  async #start(
    instanceId: string,
    operationId: string,
    explicitRetry: boolean,
  ): Promise<DaemonInstanceReport> {
    this.#assertOperationId(operationId);
    const managed = await this.#enqueue(instanceId, () =>
      this.#prepare(instanceId, operationId, explicitRetry),
    );
    await this.#runSupervisorCommand(managed, operationId, explicitRetry);
    return this.#report(managed.instance, false);
  }

  async #prepare(
    instanceId: string,
    operationId: string,
    explicitRetry: boolean,
  ): Promise<ManagedInstance> {
    const instance = this.#requireRegistered(instanceId);
    const existing = this.#managed.get(instanceId);
    if (existing) return existing;

    const lock = await this.#acquireLock(instance, operationId);
    try {
      await this.#reconcileBeforeSpawn(instance, operationId);
    } catch (error) {
      await lock.release();
      throw error;
    }

    const ledger = new GenerationSecretLedger(this.#generations);
    const managed: ManagedInstance = {
      instance,
      lock,
      ledger,
      authenticatedGenerations: new Set<string>(),
      supervisor: new ProcessSupervisor({
        instanceId: instance.instanceId,
        configRevision: instance.desiredConfigRevision,
        daemonProtocolVersion: this.#options.daemonProtocolVersion,
        ipcProtocolVersion: this.#options.ipcProtocolVersion,
        launcher: this.#options.createLauncher(instance),
        readinessEndpointPolicy: this.#options.readinessEndpointPolicy,
        nextProcessGenerationId: () => ledger.nextProcessGenerationId(),
        nextSecret: (kind) => ledger.nextSecret(kind),
        ...(this.#options.clock === undefined ? {} : { clock: this.#options.clock }),
        ...(this.#options.random === undefined ? {} : { random: this.#options.random }),
        ...(this.#options.readinessTimeoutMs === undefined
          ? {}
          : { readinessTimeoutMs: this.#options.readinessTimeoutMs }),
        ...(this.#options.gracefulStopTimeoutMs === undefined
          ? {}
          : { gracefulStopTimeoutMs: this.#options.gracefulStopTimeoutMs }),
        ...(this.#options.hardStopTimeoutMs === undefined
          ? {}
          : { hardStopTimeoutMs: this.#options.hardStopTimeoutMs }),
        ...(this.#options.restartPolicy === undefined
          ? {}
          : { restartPolicy: this.#options.restartPolicy }),
      }),
      unsubscribe: () => undefined,
      snapshot: undefined as unknown as ProcessSupervisorSnapshot,
      recordTail: Promise.resolve(),
    };
    managed.snapshot = managed.supervisor.snapshot;
    this.#managed.set(instanceId, managed);
    managed.unsubscribe = managed.supervisor.subscribe((snapshot) => {
      this.#observeSnapshot(managed, snapshot);
    });

    this.#audit({
      eventType: "instance.start",
      result: "succeeded",
      operationId,
      instance,
      details: { explicitRetry, controllerLockAcquired: true },
    });
    return managed;
  }

  async #runSupervisorCommand(
    managed: ManagedInstance,
    operationId: string,
    explicitRetry: boolean,
  ): Promise<void> {
    try {
      await (explicitRetry
        ? managed.supervisor.retry(operationId)
        : managed.supervisor.start(operationId));
      this.#audit({
        eventType: "instance.ready",
        result: "succeeded",
        operationId,
        instance: managed.instance,
        ...(managed.snapshot.processGenerationId === undefined
          ? {}
          : { processGenerationId: managed.snapshot.processGenerationId }),
        ...(managed.snapshot.pid === undefined ? {} : { pid: managed.snapshot.pid }),
      });
    } catch (error) {
      this.#audit({
        eventType: explicitRetry ? "instance.retry" : "instance.start",
        result: "failed",
        operationId,
        instance: managed.instance,
        ...(managed.snapshot.processGenerationId === undefined
          ? {}
          : { processGenerationId: managed.snapshot.processGenerationId }),
        details: {
          failureCode:
            error instanceof ProcessSupervisorError ? error.code : "SUPERVISOR_UNKNOWN_FAILURE",
        },
      });
      await managed.recordTail;
      throw error;
    }
    await managed.recordTail;
  }

  async #stop(instanceId: string, operationId: string): Promise<DaemonInstanceReport> {
    this.#assertOperationId(operationId);
    const managed = this.#managed.get(instanceId);
    if (!managed) {
      return this.#enqueue(instanceId, () => this.#stopUnmanaged(instanceId, operationId));
    }
    // The stop itself waits outside the per-instance queue: it must be able to
    // cancel a start that is still waiting for readiness.
    try {
      await managed.supervisor.stop(operationId);
    } finally {
      await managed.recordTail;
    }
    return this.#enqueue(instanceId, () => this.#finishStop(managed, operationId));
  }

  async #stopUnmanaged(instanceId: string, operationId: string): Promise<DaemonInstanceReport> {
    const instance = this.#requireRegistered(instanceId);
    if (this.#managed.has(instanceId)) return this.#report(instance, false);

    // Stopping an instance this daemon does not own is idempotent only when
    // the durable evidence proves nothing of ours is still running.
    const record = this.#records.read(instanceId);
    this.#guardRecordGeneration(record);
    const evidence = await evaluateProcessRecord(record, this.#probe);
    if (evidence.kind === "identity-unprovable") {
      await this.#markStale(instance, evidence.record, evidence.reason, operationId);
      throw new DaemonInstanceManagerError(
        "DAEMON_INSTANCE_IDENTITY_UNPROVEN",
        "The recorded process identity could not be proven; no signal was sent",
        { instanceId, reason: evidence.reason, pid: evidence.record.pid },
      );
    }
    if (evidence.kind === "live-identity-proven") {
      throw new DaemonInstanceManagerError(
        "DAEMON_INSTANCE_ORPHAN_UNRESOLVED",
        "A proven live child exists without a controller; adopt or terminate it explicitly",
        { instanceId, pid: evidence.record.pid },
      );
    }
    if (evidence.kind !== "none") this.#records.clear(instanceId);
    this.#audit({
      eventType: "instance.stop",
      result: "succeeded",
      operationId,
      instance,
      details: { alreadyStopped: true, evidence: evidence.kind },
    });
    return this.#report(instance, true);
  }

  async #finishStop(
    managed: ManagedInstance,
    operationId: string,
  ): Promise<DaemonInstanceReport> {
    const stoppedSnapshot = managed.snapshot;
    if (this.#managed.get(managed.instance.instanceId) === managed) {
      await this.#detach(managed);
      this.#audit({
        eventType: "instance.stop",
        result: "succeeded",
        operationId,
        instance: managed.instance,
        ...(stoppedSnapshot.processGenerationId === undefined
          ? {}
          : { processGenerationId: stoppedSnapshot.processGenerationId }),
        details: { alreadyStopped: false },
      });
    }
    return this.#report(managed.instance, true);
  }

  async #detach(managed: ManagedInstance): Promise<void> {
    managed.unsubscribe();
    this.#managed.delete(managed.instance.instanceId);
    await managed.recordTail;
    try {
      await managed.lock.release();
    } catch {
      // A lost lock is already fatal for this controller's authority; the
      // successor proves ownership through the kernel object, not this call.
    }
  }

  async #acquireLock(
    instance: RegisteredInstance,
    operationId: string,
  ): Promise<InstanceControllerLock> {
    if (this.#shuttingDown) {
      throw new DaemonInstanceManagerError(
        "DAEMON_INSTANCE_SHUTTING_DOWN",
        "The daemon is shutting down and will not adopt another instance",
        { instanceId: instance.instanceId },
      );
    }
    try {
      return await InstanceControllerLock.acquire({
        directory: this.#options.registryDirectory,
        // The controller namespace is keyed by the deterministic Runtime
        // StableId of the instance, derived from the registry UUIDv4 source.
        // The kernel lock never sees the raw UUIDv4 or a config path.
        instanceId: projectRuntimeInstanceStableId(instance.instanceId),
      });
    } catch (error) {
      const held =
        error instanceof InstanceControllerLockError && error.code === "CONTROLLER_LOCK_HELD";
      this.#audit({
        eventType: "instance.start",
        result: "refused",
        operationId,
        instance,
        details: {
          reason: held ? "controller-lock-held-elsewhere" : "controller-lock-unavailable",
        },
      });
      if (held) {
        throw new DaemonInstanceManagerError(
          "DAEMON_INSTANCE_CONTROLLED_ELSEWHERE",
          "Another controller owns this instance",
          { instanceId: instance.instanceId },
        );
      }
      throw new DaemonInstanceManagerError(
        "DAEMON_INSTANCE_LOCK_FAILED",
        "Could not acquire the instance controller lock",
        {
          instanceId: instance.instanceId,
          cause: error instanceof InstanceControllerLockError ? error.code : "unknown",
        },
      );
    }
  }

  /**
   * Refuses an ownership decision on a durable record that names a process
   * generation this daemon's epoch no longer vouches for. An older generation
   * of this same epoch is stale and a same-epoch token this session never
   * issued is invalid. Records from an earlier epoch or written before tokens
   * existed are skipped: the operating-system identity evidence decides those
   * exactly as it always has, so current-generation behavior is unchanged.
   */
  #guardRecordGeneration(record: InstanceProcessRecord | null): void {
    if (record === null) return;
    const token = parseProcessGenerationToken(record.processGenerationId);
    if (token === undefined || token.epoch !== this.#generations.epoch) return;
    this.#generations.guard(token);
  }

  /**
   * Reconciles the durable process record before any spawn. A record that
   * cannot be proven dead never becomes a second running child.
   */
  async #reconcileBeforeSpawn(instance: RegisteredInstance, operationId: string): Promise<void> {
    const record = this.#records.read(instance.instanceId);
    this.#guardRecordGeneration(record);
    const evidence = await evaluateProcessRecord(record, this.#probe);
    if (evidence.kind === "none") return;
    if (evidence.kind === "identity-unprovable") {
      await this.#markStale(instance, evidence.record, evidence.reason, operationId);
      throw new DaemonInstanceManagerError(
        "DAEMON_INSTANCE_IDENTITY_UNPROVEN",
        "A recorded process identifier could not be proven, so no signal and no replacement spawn are permitted",
        {
          instanceId: instance.instanceId,
          pid: evidence.record.pid,
          reason: evidence.reason,
        },
      );
    }
    if (evidence.kind === "live-identity-proven") {
      this.#audit({
        eventType: "instance.orphan-detected",
        result: "refused",
        operationId,
        instance,
        processGenerationId: evidence.record.processGenerationId,
        pid: evidence.record.pid,
        details: { signalled: false },
      });
      throw new DaemonInstanceManagerError(
        "DAEMON_INSTANCE_ORPHAN_UNRESOLVED",
        "A proven live child from an earlier controller is still running; it was not signalled and no replacement was started",
        { instanceId: instance.instanceId, pid: evidence.record.pid },
      );
    }
    this.#records.clear(instance.instanceId);
    this.#audit({
      eventType: "instance.stale-record-cleanup",
      result: "succeeded",
      operationId,
      instance,
      processGenerationId: evidence.record.processGenerationId,
      pid: evidence.record.pid,
      details: { evidence: evidence.kind, signalled: false },
    });
  }

  async #markStale(
    instance: RegisteredInstance,
    record: InstanceProcessRecord,
    reason: string,
    operationId: string,
  ): Promise<void> {
    if (record.state !== "stale" || record.staleReason !== reason) {
      this.#records.write({
        ...record,
        state: "stale",
        staleReason: reason,
        updatedAt: this.#canonicalNow(),
      });
    }
    this.#audit({
      eventType: "instance.identity-unproven",
      result: "refused",
      operationId,
      instance,
      processGenerationId: record.processGenerationId,
      pid: record.pid,
      details: { reason, signalled: false },
    });
    await Promise.resolve();
  }

  #observeSnapshot(managed: ManagedInstance, snapshot: ProcessSupervisorSnapshot): void {
    managed.snapshot = snapshot;
    if (
      (snapshot.state === "ready" || snapshot.state === "running") &&
      snapshot.processGenerationId !== undefined
    ) {
      managed.authenticatedGenerations.add(snapshot.processGenerationId);
    }
    managed.recordTail = managed.recordTail
      .then(() => this.#persistRecord(managed, snapshot))
      .catch(() => undefined);
  }

  async #persistRecord(
    managed: ManagedInstance,
    snapshot: ProcessSupervisorSnapshot,
  ): Promise<void> {
    const instanceId = managed.instance.instanceId;
    const recordState = mapRecordState(snapshot.state);
    const processGenerationId = snapshot.processGenerationId;

    if (recordState !== undefined) {
      // The generation has no durable identity until the launcher has bound a
      // real child to it, so an early `starting` snapshot writes nothing.
      if (processGenerationId === undefined || snapshot.pid === undefined) return;
      const existing = this.#records.read(instanceId);
      if (existing !== null && existing.processGenerationId === processGenerationId) {
        if (existing.state !== recordState) {
          this.#records.write({
            ...existing,
            state: recordState,
            updatedAt: this.#canonicalNow(),
          });
        }
        return;
      }
      const observation = await this.#probe.observe(snapshot.pid);
      const ipcSessionId = managed.ledger.ipcSessionId(processGenerationId);
      if (ipcSessionId === undefined) return;
      const timestamp = this.#canonicalNow();
      this.#records.write({
        schemaVersion: "dolly.instance-process-record/1",
        instanceId,
        processGenerationId,
        pid: snapshot.pid,
        controllerId: this.#controllerId,
        configRevision: managed.instance.desiredConfigRevision,
        ipcSessionId,
        state: recordState,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(observation.kind === "identity"
          ? { osIdentityToken: observation.identityToken }
          : {}),
      });
      return;
    }

    if (snapshot.state === "failed" && leavesProcessPossiblyAlive(snapshot.lastFailure)) {
      const existing = this.#records.read(instanceId);
      if (existing !== null && existing.state !== "stale") {
        this.#records.write({
          ...existing,
          state: "stale",
          staleReason: snapshot.lastFailure?.code ?? "SUPERVISOR_STOP_TIMEOUT",
          updatedAt: this.#canonicalNow(),
        });
      }
      return;
    }

    // Every remaining state follows an observed exit for the last generation.
    if (snapshot.pid === undefined) this.#records.clear(instanceId);
  }

  async #report(
    instance: RegisteredInstance,
    probeControllerLock: boolean,
  ): Promise<DaemonInstanceReport> {
    const managed = this.#managed.get(instance.instanceId);
    if (managed) {
      const snapshot = managed.snapshot;
      const authenticated =
        snapshot.processGenerationId !== undefined &&
        managed.authenticatedGenerations.has(snapshot.processGenerationId) &&
        (snapshot.state === "ready" || snapshot.state === "running");
      const unresolved =
        snapshot.state === "failed" && leavesProcessPossiblyAlive(snapshot.lastFailure);
      return deepFreeze({
        instanceId: instance.instanceId,
        configPath: instance.configPath,
        stateDirectory: instance.stateDirectory,
        desiredConfigRevision: instance.desiredConfigRevision,
        status: unresolved ? "unresolved" : snapshot.state,
        managedByThisDaemon: true,
        evidence: {
          controllerLock: "held-by-this-daemon",
          readinessHandshake: authenticated ? "authenticated" : "absent",
          processRecord:
            this.#records.read(instance.instanceId) === null ? "none" : "live-identity-proven",
          ...(unresolved ? { identityReason: snapshot.lastFailure?.code } : {}),
        },
        ...(snapshot.processGenerationId === undefined
          ? {}
          : { processGenerationId: snapshot.processGenerationId }),
        ...(snapshot.pid === undefined ? {} : { pid: snapshot.pid }),
        endpoints: snapshot.endpoints.map((endpoint) => ({ ...endpoint })),
        unexpectedExitCount: snapshot.unexpectedExitCount,
        restartStreak: snapshot.restartStreak,
        ...(snapshot.nextRestartAt === undefined
          ? {}
          : { nextRestartAt: snapshot.nextRestartAt }),
        ...(snapshot.lastFailure === undefined ? {} : { lastFailure: snapshot.lastFailure }),
      }) as DaemonInstanceReport;
    }

    const controllerLock: ControllerLockObservation = probeControllerLock
      ? await probeInstanceControllerLock(this.#options.registryDirectory, instance.instanceId)
      : "unheld";
    const evidence = await evaluateProcessRecord(
      this.#records.read(instance.instanceId),
      this.#probe,
    );
    let status: DaemonInstanceStatus;
    if (controllerLock === "held-elsewhere") {
      status = "controlled-elsewhere";
    } else if (evidence.kind === "live-identity-proven") {
      status = "orphaned";
    } else if (evidence.kind === "identity-unprovable") {
      status = "unresolved";
    } else {
      status = "stopped";
    }
    const record = evidence.kind === "none" ? undefined : evidence.record;
    return deepFreeze({
      instanceId: instance.instanceId,
      configPath: instance.configPath,
      stateDirectory: instance.stateDirectory,
      desiredConfigRevision: instance.desiredConfigRevision,
      status,
      managedByThisDaemon: false,
      evidence: {
        controllerLock,
        readinessHandshake: "absent",
        processRecord: evidence.kind,
        ...(evidence.kind === "identity-unprovable" ? { identityReason: evidence.reason } : {}),
      },
      ...(record === undefined
        ? {}
        : { processGenerationId: record.processGenerationId, pid: record.pid }),
      endpoints: [],
      unexpectedExitCount: 0,
      restartStreak: 0,
    }) as DaemonInstanceReport;
  }

  #requireRegistered(instanceId: string): RegisteredInstance {
    const instance = this.listRegisteredInstances().find(
      (candidate) => candidate.instanceId === instanceId,
    );
    if (!instance) {
      throw new DaemonInstanceManagerError(
        "DAEMON_INSTANCE_NOT_REGISTERED",
        "No instance with this identifier is registered on this machine",
        { instanceId },
      );
    }
    return instance;
  }

  #assertOperationId(operationId: string): void {
    if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
      throw new DaemonInstanceManagerError(
        "DAEMON_INSTANCE_OPERATION_INVALID",
        "operationId is not a valid identifier",
      );
    }
  }

  #serialize<T>(
    instanceId: string,
    operationId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      this.#assertOperationId(operationId);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#enqueue(instanceId, work);
  }

  /**
   * Runs one unit of work per instance at a time. Reporting shares this queue
   * with lifecycle commands because the controller-lock probe momentarily
   * acquires the lock; letting it interleave with a start would make a
   * daemon's own report steal the lock from that same daemon's spawn.
   *
   * Callers already running inside this queue must use `#report` directly.
   */
  #enqueue<T>(instanceId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#instanceTails.get(instanceId) ?? Promise.resolve();
    const run = previous.then(work, work);
    this.#instanceTails.set(
      instanceId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  #canonicalNow(): string {
    const candidate = this.#now();
    const parsed = Date.parse(candidate);
    if (!Number.isFinite(parsed)) {
      throw new DaemonInstanceManagerError(
        "DAEMON_INSTANCE_OPERATION_INVALID",
        "The daemon clock returned an invalid instant",
      );
    }
    return new Date(parsed).toISOString();
  }

  #audit(event: {
    readonly eventType: string;
    readonly result: DaemonAuditEvent["result"];
    readonly operationId: string;
    readonly instance: RegisteredInstance;
    readonly processGenerationId?: string;
    readonly pid?: number;
    readonly details?: Readonly<Record<string, JsonValue>>;
  }): void {
    const sink = this.#options.audit;
    if (!sink) return;
    sink(
      deepFreeze({
        schemaVersion: "dolly.daemon-audit/1",
        observedAt: this.#canonicalNow(),
        eventType: event.eventType,
        result: event.result,
        operationId: event.operationId,
        instanceId: event.instance.instanceId,
        controllerId: this.#controllerId,
        configRevision: event.instance.desiredConfigRevision,
        ...(event.processGenerationId === undefined
          ? {}
          : { processGenerationId: event.processGenerationId }),
        ...(event.pid === undefined ? {} : { pid: event.pid }),
        ...(event.details === undefined ? {} : { details: event.details }),
      }) as DaemonAuditEvent,
    );
  }
}
