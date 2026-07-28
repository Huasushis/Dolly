/**
 * OPS-001 at the multi-instance layer, exercised with real child processes.
 *
 * Every lifecycle assertion below drives `DaemonInstanceManager`, which owns
 * the controller lock, the durable process record, and the audit trail, and
 * delegates per-process supervision to `ProcessSupervisor`. The children are
 * genuine operating-system processes launched over an inherited control
 * channel, so generation races, readiness timeouts, confirmed exits, and the
 * restart budget are observed rather than simulated.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeIpcProcessLauncher } from "../../../src/adapters/node-ipc-process-launcher.js";
import { NetworkExposurePolicy } from "../../../src/core/network-exposure.js";
import {
  ProcessSupervisorError,
  type ProcessLaunchObserver,
  type ProcessLauncher,
  type SupervisedProcess,
  type SupervisorSpawnRequest,
} from "../../../src/core/process-supervisor.js";
import {
  DaemonInstanceManager,
  type DaemonAuditEvent,
  type DaemonInstanceManagerOptions,
} from "../../../src/daemon/daemon-instance-manager.js";
import { InstanceProcessRecordStore } from "../../../src/daemon/instance-process-record-store.js";
import { observeProcessLiveness } from "../../../src/daemon/process-identity.js";
import {
  createTestInstanceRegistry,
  type TestInstanceRegistry,
} from "./fixtures/daemon-test-registry.js";

const CHILD_FIXTURE = fileURLToPath(new URL("./fixtures/daemon-instance-child.ts", import.meta.url));

type ChildBehavior = "ready" | "silent" | "exit-before-ready";

interface LaunchRecord {
  readonly index: number;
  readonly behavior: ChildBehavior;
  readonly request: SupervisorSpawnRequest;
  readonly observer: ProcessLaunchObserver;
  readonly child: SupervisedProcess;
}

/**
 * Launches the real fixture child, choosing a scripted behaviour per spawn and
 * keeping every supervisor observer so a test can replay a delayed callback
 * from an earlier process generation.
 */
class ScriptedRealChildLauncher implements ProcessLauncher {
  readonly launches: LaunchRecord[] = [];
  readonly timeline: string[] = [];
  readonly stderr: Buffer[] = [];
  #nextIndex = 0;

  constructor(private readonly behaviors: readonly ChildBehavior[]) {
    if (behaviors.length === 0) throw new Error("At least one behaviour is required");
  }

  behaviorFor(index: number): ChildBehavior {
    return this.behaviors[Math.min(index, this.behaviors.length - 1)]!;
  }

  async launch(
    request: SupervisorSpawnRequest,
    observer: ProcessLaunchObserver,
  ): Promise<SupervisedProcess> {
    const index = this.#nextIndex;
    this.#nextIndex += 1;
    const behavior = this.behaviorFor(index);
    this.timeline.push(`launch:${index}`);
    const delegate = new NodeIpcProcessLauncher({
      command: process.execPath,
      args: ["--import", "tsx/esm", CHILD_FIXTURE],
      cwd: process.cwd(),
      env: { ...process.env, DOLLY_TEST_CHILD_BEHAVIOR: behavior },
      onStderr: (chunk) => this.stderr.push(chunk),
    });
    const traced: ProcessLaunchObserver = {
      ready: (envelope) => {
        this.timeline.push(`ready:${index}`);
        observer.ready(envelope);
      },
      channelLost: (event) => {
        this.timeline.push(`channel-lost:${index}`);
        observer.channelLost(event);
      },
      exit: (event) => {
        this.timeline.push(`exit:${index}`);
        observer.exit(event);
      },
      error: (error) => {
        this.timeline.push(`error:${index}`);
        observer.error(error);
      },
    };
    const child = await delegate.launch(request, traced);
    this.launches.push({ index, behavior, request, observer, child });
    return child;
  }

  diagnostics(): string {
    return `timeline=${this.timeline.join(",")}\nchild stderr:\n${Buffer.concat(this.stderr).toString("utf8")}`;
  }
}

async function waitUntil(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("OPS-001 multi-instance daemon supervision with real children", () => {
  let root: string;
  let registry: TestInstanceRegistry;
  let managers: DaemonInstanceManager[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-daemon-supervision-"));
    registry = createTestInstanceRegistry(root);
    managers = [];
  });

  afterEach(async () => {
    for (const manager of managers) await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
  });

  function createManager(
    launcher: ProcessLauncher,
    overrides: Partial<DaemonInstanceManagerOptions> = {},
    audit?: (event: DaemonAuditEvent) => void,
  ): DaemonInstanceManager {
    const manager = new DaemonInstanceManager({
      registryDirectory: registry.registryDirectory,
      processRecordDirectory: join(root, "process-records"),
      createLauncher: () => launcher,
      daemonProtocolVersion: "daemon-v1",
      ipcProtocolVersion: "ipc-v1",
      readinessEndpointPolicy: {
        mode: "network",
        exposure: new NetworkExposurePolicy({ mode: "local", listenPort: 0 }),
      },
      readinessTimeoutMs: 2_000,
      gracefulStopTimeoutMs: 5_000,
      hardStopTimeoutMs: 5_000,
      restartPolicy: {
        rollingWindowMs: 60_000,
        maxUnexpectedExits: 2,
        stableResetMs: 400,
        baseDelayMs: 20,
        maxDelayMs: 60,
        jitterRatio: 0,
      },
      ...(audit === undefined ? {} : { audit }),
      ...overrides,
    });
    managers.push(manager);
    return manager;
  }

  it("starts a registered instance, records a proven identity, and reports evidence-backed readiness",
    async () => {
      const instance = registry.register("alpha");
      const launcher = new ScriptedRealChildLauncher(["ready"]);
      const events: DaemonAuditEvent[] = [];
      const manager = createManager(launcher, {}, (event) => events.push(event));

      const report = await manager.startInstance(instance.instanceId, "op-start-alpha");
      expect(report.status).toBe("running");
      expect(report.managedByThisDaemon).toBe(true);
      expect(report.evidence.controllerLock).toBe("held-by-this-daemon");
      expect(report.evidence.readinessHandshake).toBe("authenticated");
      expect(report.pid).toBeGreaterThan(0);
      expect(report.endpoints).toHaveLength(1);
      expect(new URL(report.endpoints[0]!.address).hostname).toBe("127.0.0.1");

      const records = new InstanceProcessRecordStore({
        directory: join(root, "process-records"),
      });
      const record = records.read(instance.instanceId);
      expect(record).not.toBeNull();
      expect(record!.pid).toBe(report.pid);
      expect(record!.processGenerationId).toBe(report.processGenerationId);
      expect(record!.state).toBe("running");
      expect(record!.ipcSessionId).toMatch(/^sha256:[0-9a-f]{64}$/u);
      // The record names the authenticated session without storing the secret
      // that authenticates it.
      expect(JSON.stringify(record)).not.toContain(launcher.launches[0]!.request.readinessSecret);
      expect(JSON.stringify(record)).not.toContain(
        launcher.launches[0]!.request.processIdentityToken,
      );

      expect(events.map((event) => event.eventType)).toContain("instance.ready");
      for (const event of events) {
        expect(JSON.stringify(event)).not.toContain(
          launcher.launches[0]!.request.processIdentityToken,
        );
      }

      const stopped = await manager.stopInstance(instance.instanceId, "op-stop-alpha");
      expect(stopped.status).toBe("stopped");
      expect(records.read(instance.instanceId)).toBeNull();
    },
    40_000,
  );

  it("ignores a delayed exit and error from an earlier process generation",
    async () => {
      const instance = registry.register("beta");
      const launcher = new ScriptedRealChildLauncher(["exit-before-ready", "ready"]);
      const manager = createManager(launcher);

      await expect(
        manager.startInstance(instance.instanceId, "op-start-beta"),
      ).rejects.toBeInstanceOf(ProcessSupervisorError);

      await waitUntil(
        `a second generation to reach running (${launcher.diagnostics()})`,
        async () => (await manager.describeInstance(instance.instanceId)).status === "running",
      );
      const running = await manager.describeInstance(instance.instanceId);
      const currentGeneration = running.processGenerationId;
      const currentPid = running.pid!;
      expect(launcher.launches).toHaveLength(2);
      expect(currentGeneration).toBe(launcher.launches[1]!.request.processGenerationId);

      // Replay callbacks belonging to the first generation after the second is
      // already running. They name generation one, so they must change nothing.
      const stale = launcher.launches[0]!;
      stale.observer.error(new Error("late transport failure from generation one"));
      stale.observer.exit({ code: 137, signal: "SIGKILL", observedAt: new Date().toISOString() });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const after = await manager.describeInstance(instance.instanceId);
      expect(after.status).toBe("running");
      expect(after.processGenerationId).toBe(currentGeneration);
      expect(after.pid).toBe(currentPid);
      expect(after.lastFailure).toBeUndefined();
      expect(launcher.launches).toHaveLength(2);
      expect(observeProcessLiveness(currentPid)).toBe("present");

      // The same replay path applied to the current generation does mutate
      // state, which proves the assertions above are about the generation
      // check and not about a callback that never arrived.
      launcher.launches[1]!.observer.exit({
        code: 137,
        signal: "SIGKILL",
        observedAt: new Date().toISOString(),
      });
      await waitUntil(
        `the current generation's exit to trigger a restart (${launcher.diagnostics()})`,
        () => launcher.launches.length === 3,
      );
      await launcher.launches[1]!.child.terminate("SIGTERM");
    },
    40_000,
  );

  it("times out readiness and observes the confirmed exit before the next spawn",
    async () => {
      const instance = registry.register("gamma");
      const launcher = new ScriptedRealChildLauncher(["silent", "ready"]);
      const manager = createManager(launcher, { readinessTimeoutMs: 700 });

      await expect(
        manager.startInstance(instance.instanceId, "op-start-gamma"),
      ).rejects.toMatchObject({ code: "SUPERVISOR_READINESS_TIMEOUT" });

      await waitUntil(
        `the replacement generation to start (${launcher.diagnostics()})`,
        () => launcher.timeline.includes("launch:1"),
      );
      const firstExit = launcher.timeline.indexOf("exit:0");
      const secondLaunch = launcher.timeline.indexOf("launch:1");
      expect(firstExit).toBeGreaterThanOrEqual(0);
      expect(secondLaunch).toBeGreaterThan(firstExit);
    },
    40_000,
  );

  it("spends a rolling restart budget across real children and then requires an explicit retry",
    async () => {
      const instance = registry.register("delta");
      const launcher = new ScriptedRealChildLauncher([
        "exit-before-ready",
        "exit-before-ready",
        "exit-before-ready",
        "ready",
      ]);
      const manager = createManager(launcher);

      await expect(
        manager.startInstance(instance.instanceId, "op-start-delta"),
      ).rejects.toBeInstanceOf(ProcessSupervisorError);

      await waitUntil(
        `the restart budget to be exhausted (${launcher.diagnostics()})`,
        async () => (await manager.describeInstance(instance.instanceId)).status === "failed",
      );
      const failed = await manager.describeInstance(instance.instanceId);
      expect(failed.status).toBe("failed");
      expect(failed.unexpectedExitCount).toBe(3);
      expect(failed.lastFailure?.message).toContain("Restart budget exhausted");
      expect(launcher.launches).toHaveLength(3);

      // An ordinary start is refused: recovering from `failed` is an explicit
      // administrative action.
      await expect(
        manager.startInstance(instance.instanceId, "op-restart-delta"),
      ).rejects.toMatchObject({ code: "SUPERVISOR_FAILED_RETRY_REQUIRED" });
      expect(launcher.launches).toHaveLength(3);

      const retried = await manager.retryInstance(instance.instanceId, "op-retry-delta");
      expect(retried.status).toBe("running");
      expect(retried.unexpectedExitCount).toBe(0);
      expect(launcher.launches).toHaveLength(4);
    },
    60_000,
  );

  it("resets the restart budget only after a stable readiness period, not on each spawn",
    async () => {
      const instance = registry.register("epsilon");
      const launcher = new ScriptedRealChildLauncher(["exit-before-ready", "ready"]);
      const manager = createManager(launcher, {
        restartPolicy: {
          rollingWindowMs: 60_000,
          maxUnexpectedExits: 5,
          stableResetMs: 600,
          baseDelayMs: 20,
          maxDelayMs: 60,
          jitterRatio: 0,
        },
      });

      await expect(
        manager.startInstance(instance.instanceId, "op-start-epsilon"),
      ).rejects.toBeInstanceOf(ProcessSupervisorError);
      await waitUntil(
        `the replacement generation to become ready (${launcher.diagnostics()})`,
        async () => (await manager.describeInstance(instance.instanceId)).status === "running",
      );

      // The spawn itself must not clear the budget the earlier crash consumed.
      const justAfterSpawn = await manager.describeInstance(instance.instanceId);
      expect(justAfterSpawn.unexpectedExitCount).toBe(1);
      expect(justAfterSpawn.restartStreak).toBe(1);

      await waitUntil(
        "the stable readiness period to reset the budget",
        async () => (await manager.describeInstance(instance.instanceId)).unexpectedExitCount === 0,
      );
      const afterStablePeriod = await manager.describeInstance(instance.instanceId);
      expect(afterStablePeriod.status).toBe("running");
      expect(afterStablePeriod.restartStreak).toBe(0);
    },
    40_000,
  );

  it("refuses a retry while the current generation is still running and keeps stop idempotent",
    async () => {
      const instance = registry.register("zeta");
      const launcher = new ScriptedRealChildLauncher(["ready"]);
      const manager = createManager(launcher);

      const running = await manager.startInstance(instance.instanceId, "op-start-zeta");
      expect(running.status).toBe("running");
      const pid = running.pid!;

      await expect(
        manager.retryInstance(instance.instanceId, "op-retry-zeta"),
      ).rejects.toMatchObject({ code: "SUPERVISOR_PROCESS_EXIT_UNCONFIRMED" });
      expect(launcher.launches).toHaveLength(1);
      expect(observeProcessLiveness(pid)).toBe("present");

      const [first, second] = await Promise.all([
        manager.stopInstance(instance.instanceId, "op-stop-zeta"),
        manager.stopInstance(instance.instanceId, "op-stop-zeta"),
      ]);
      expect(first.status).toBe("stopped");
      expect(second.status).toBe("stopped");
      await waitUntil("the stopped child to leave the process table", () =>
        observeProcessLiveness(pid) === "absent",
      );
      // An intentional stop disables automatic restart for that generation, so
      // waiting well past the backoff delay must not produce another spawn.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(launcher.launches).toHaveLength(1);
      expect((await manager.describeInstance(instance.instanceId)).status).toBe("stopped");
      expect(manager.managedInstanceIds).toEqual([]);
    },
    40_000,
  );

  it("keeps two instances independent and reports each one separately",
    async () => {
      const first = registry.register("eta");
      const second = registry.register("theta");
      const firstLauncher = new ScriptedRealChildLauncher(["ready"]);
      const secondLauncher = new ScriptedRealChildLauncher(["ready"]);
      const manager = new DaemonInstanceManager({
        registryDirectory: registry.registryDirectory,
        processRecordDirectory: join(root, "process-records"),
        createLauncher: (instance) =>
          instance.instanceId === first.instanceId ? firstLauncher : secondLauncher,
        daemonProtocolVersion: "daemon-v1",
        ipcProtocolVersion: "ipc-v1",
        readinessEndpointPolicy: {
          mode: "network",
          exposure: new NetworkExposurePolicy({ mode: "local", listenPort: 0 }),
        },
        readinessTimeoutMs: 5_000,
      });
      managers.push(manager);

      await manager.startInstance(first.instanceId, "op-start-eta");
      const reports = await manager.listInstances();
      expect(reports).toHaveLength(2);
      const firstReport = reports.find((report) => report.instanceId === first.instanceId)!;
      const secondReport = reports.find((report) => report.instanceId === second.instanceId)!;
      expect(firstReport.status).toBe("running");
      expect(firstReport.evidence.readinessHandshake).toBe("authenticated");
      expect(secondReport.status).toBe("stopped");
      expect(secondReport.evidence.controllerLock).toBe("unheld");
      expect(secondReport.evidence.processRecord).toBe("none");
      expect(secondReport.evidence.readinessHandshake).toBe("absent");

      await manager.startInstance(second.instanceId, "op-start-theta");
      const both = await manager.listInstances();
      expect(both.map((report) => report.status)).toEqual(["running", "running"]);
      expect(new Set(both.map((report) => report.pid)).size).toBe(2);
      expect(manager.managedInstanceIds).toHaveLength(2);
    },
    60_000,
  );

  it("reports a spawned but not yet ready instance as starting, with no authenticated handshake",
    async () => {
      const instance = registry.register("kappa");
      const launcher = new ScriptedRealChildLauncher(["silent"]);
      const manager = createManager(launcher, { readinessTimeoutMs: 10_000 });
      const records = new InstanceProcessRecordStore({
        directory: join(root, "process-records"),
      });

      const starting = manager.startInstance(instance.instanceId, "op-start-kappa");
      starting.catch(() => undefined);
      await waitUntil(
        `the instance to report starting (${launcher.diagnostics()})`,
        async () => (await manager.describeInstance(instance.instanceId)).status === "starting",
      );

      const report = await manager.describeInstance(instance.instanceId);
      expect(report.status).toBe("starting");
      expect(report.evidence.readinessHandshake).toBe("absent");
      expect(report.endpoints).toEqual([]);
      expect(report.pid).toBeGreaterThan(0);
      await waitUntil("the durable record to name the starting generation", () => {
        const record = records.read(instance.instanceId);
        return record !== null && record.state === "starting" && record.pid === report.pid;
      });

      const stopped = await manager.stopInstance(instance.instanceId, "op-stop-kappa");
      expect(stopped.status).toBe("stopped");
      await expect(starting).rejects.toMatchObject({
        code: "SUPERVISOR_STOPPED_DURING_START",
      });
      expect(records.read(instance.instanceId)).toBeNull();
    },
    40_000,
  );

  it("refuses lifecycle commands for an identifier that is not registered", async () => {
    const launcher = new ScriptedRealChildLauncher(["ready"]);
    const manager = createManager(launcher);
    await expect(
      manager.startInstance("00000000-0000-4000-8000-000000000000", "op-missing"),
    ).rejects.toMatchObject({ code: "DAEMON_INSTANCE_NOT_REGISTERED" });
    expect(launcher.launches).toHaveLength(0);
  });

  it("rejects an operation identifier that is not a valid identifier", async () => {
    const instance = registry.register("iota");
    const launcher = new ScriptedRealChildLauncher(["ready"]);
    const manager = createManager(launcher);
    await expect(
      manager.startInstance(instance.instanceId, "not a valid id"),
    ).rejects.toMatchObject({ code: "DAEMON_INSTANCE_OPERATION_INVALID" });
    expect(launcher.launches).toHaveLength(0);
  });
});
