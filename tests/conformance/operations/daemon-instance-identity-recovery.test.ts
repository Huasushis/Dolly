/**
 * OPS-001 process identity and OPS-002 registry evidence for the daemon.
 *
 * The rule under test is `security-operations.md` Section 7.4: a process
 * identifier is not an identity, so a recovered identifier is signalled only
 * after the live process is matched against the stored identity, and an
 * unprovable identifier is marked stale and left untouched. Each case below
 * records a real, running operating-system process and then checks both that
 * the daemon refused to act and that the process is still alive afterwards.
 */

import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NetworkExposurePolicy } from "../../../src/core/network-exposure.js";
import type {
  ProcessLaunchObserver,
  ProcessLauncher,
  SupervisedProcess,
  SupervisorSpawnRequest,
} from "../../../src/core/process-supervisor.js";
import {
  DaemonInstanceManager,
  type DaemonAuditEvent,
} from "../../../src/daemon/daemon-instance-manager.js";
import {
  InstanceProcessRecordStore,
  deriveIpcSessionId,
  type InstanceProcessRecord,
} from "../../../src/daemon/instance-process-record-store.js";
import {
  evaluateProcessRecord,
  probeInstanceControllerLock,
  readInstanceRegistry,
} from "../../../src/daemon/instance-registry.js";
import {
  PortableLivenessIdentityProbe,
  observeProcessLiveness,
  parseProcStatStartTime,
  type ProcessIdentityObservation,
  type ProcessIdentityProbe,
} from "../../../src/daemon/process-identity.js";
import {
  createTestInstanceRegistry,
  type TestInstanceRegistry,
} from "./fixtures/daemon-test-registry.js";

const IDLE_FIXTURE = fileURLToPath(new URL("./fixtures/idle-process.ts", import.meta.url));
const LOCK_FIXTURE = fileURLToPath(new URL("./fixtures/controller-lock-child.ts", import.meta.url));

/** A launcher that must never be used; using it would mean a duplicate spawn. */
class ForbiddenLauncher implements ProcessLauncher {
  launchCount = 0;

  launch(
    _request: SupervisorSpawnRequest,
    _observer: ProcessLaunchObserver,
  ): Promise<SupervisedProcess> {
    this.launchCount += 1;
    return Promise.reject(new Error("The daemon must not spawn a replacement in this state"));
  }
}

class StubIdentityProbe implements ProcessIdentityProbe {
  readonly observed: number[] = [];

  constructor(private readonly answer: ProcessIdentityObservation) {}

  observe(pid: number): Promise<ProcessIdentityObservation> {
    this.observed.push(pid);
    return Promise.resolve(this.answer);
  }
}

async function waitForLine(
  child: ChildProcess & { readonly stdout: Readable },
  marker: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child never printed ${marker}`)), 20_000);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(marker)) {
        clearTimeout(timer);
        resolve(output);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited before ${marker} (${String(code)})`));
    });
  });
}

describe("daemon process identity, recovery, and registry evidence", () => {
  let root: string;
  let registry: TestInstanceRegistry;
  let records: InstanceProcessRecordStore;
  let managers: DaemonInstanceManager[];
  let children: Set<ChildProcess>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-daemon-identity-"));
    registry = createTestInstanceRegistry(root);
    records = new InstanceProcessRecordStore({ directory: join(root, "process-records") });
    managers = [];
    children = new Set();
  });

  afterEach(async () => {
    for (const manager of managers) await manager.shutdown();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  async function startIdleProcess(): Promise<ChildProcessWithoutNullStreams> {
    const child = spawn(process.execPath, ["--import", "tsx/esm", IDLE_FIXTURE], {
      cwd: process.cwd(),
      stdio: "pipe",
      windowsHide: true,
    });
    children.add(child);
    await waitForLine(child, "READY ");
    return child;
  }

  function createManager(
    launcher: ProcessLauncher,
    probe: ProcessIdentityProbe,
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
      identityProbe: probe,
      ...(audit === undefined ? {} : { audit }),
    });
    managers.push(manager);
    return manager;
  }

  function seedRecord(
    instanceId: string,
    pid: number,
    overrides: Partial<InstanceProcessRecord> = {},
  ): InstanceProcessRecord {
    return records.write({
      schemaVersion: "dolly.instance-process-record/1",
      instanceId,
      processGenerationId: "process-recovered-generation",
      pid,
      controllerId: "44444444-4444-4444-8444-444444444444",
      configRevision: `sha256:${"c".repeat(64)}`,
      ipcSessionId: deriveIpcSessionId("recovered-session-material"),
      state: "running",
      createdAt: "2026-07-25T10:00:00.000Z",
      updatedAt: "2026-07-25T10:00:00.000Z",
      osIdentityToken: "recorded-identity-token",
      ...overrides,
    } as InstanceProcessRecord);
  }

  it("never signals a live process whose identity cannot be proven and never spawns a replacement",
    async () => {
      const instance = registry.register("unprovable");
      const child = await startIdleProcess();
      seedRecord(instance.instanceId, child.pid!);

      const launcher = new ForbiddenLauncher();
      const events: DaemonAuditEvent[] = [];
      const manager = createManager(
        launcher,
        new PortableLivenessIdentityProbe("process-identity-unsupported-for-test"),
        (event) => events.push(event),
      );

      await expect(
        manager.startInstance(instance.instanceId, "op-start-unprovable"),
      ).rejects.toMatchObject({ code: "DAEMON_INSTANCE_IDENTITY_UNPROVEN" });

      expect(launcher.launchCount).toBe(0);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(observeProcessLiveness(child.pid!)).toBe("present");

      const stale = records.read(instance.instanceId);
      expect(stale?.state).toBe("stale");
      expect(stale?.staleReason).toBe("process-identity-unsupported-for-test");
      expect(stale?.pid).toBe(child.pid);

      const refusal = events.find((event) => event.eventType === "instance.identity-unproven");
      expect(refusal?.result).toBe("refused");
      expect(refusal?.details?.signalled).toBe(false);

      const report = await manager.describeInstance(instance.instanceId);
      expect(report.status).toBe("unresolved");
      expect(report.evidence.processRecord).toBe("identity-unprovable");
      expect(report.evidence.readinessHandshake).toBe("absent");
    },
    40_000,
  );

  it("refuses a stop for an unprovable identifier without signalling it",
    async () => {
      const instance = registry.register("unprovable-stop");
      const child = await startIdleProcess();
      seedRecord(instance.instanceId, child.pid!);
      const manager = createManager(
        new ForbiddenLauncher(),
        new PortableLivenessIdentityProbe("no-identity-token-on-this-platform"),
      );

      await expect(
        manager.stopInstance(instance.instanceId, "op-stop-unprovable"),
      ).rejects.toMatchObject({ code: "DAEMON_INSTANCE_IDENTITY_UNPROVEN" });
      expect(child.exitCode).toBeNull();
      expect(observeProcessLiveness(child.pid!)).toBe("present");
      expect(records.read(instance.instanceId)?.state).toBe("stale");
    },
    40_000,
  );

  it("treats a reused identifier as a proven exit, clears the record, and leaves the live process alone",
    async () => {
      const instance = registry.register("reused");
      const child = await startIdleProcess();
      seedRecord(instance.instanceId, child.pid!, { osIdentityToken: "identity-from-an-older-boot" });
      const launcher = new ForbiddenLauncher();
      const events: DaemonAuditEvent[] = [];
      const manager = createManager(
        launcher,
        new StubIdentityProbe({ kind: "identity", identityToken: "identity-of-a-different-process" }),
        (event) => events.push(event),
      );

      // The spawn is refused because this launcher always fails, but
      // reconciliation must have concluded the recorded child was gone.
      await expect(
        manager.startInstance(instance.instanceId, "op-start-reused"),
      ).rejects.toBeInstanceOf(Error);
      expect(launcher.launchCount).toBe(1);
      expect(records.read(instance.instanceId)).toBeNull();
      expect(child.exitCode).toBeNull();
      expect(observeProcessLiveness(child.pid!)).toBe("present");

      const cleanup = events.find((event) => event.eventType === "instance.stale-record-cleanup");
      expect(cleanup?.details?.evidence).toBe("proven-exited-pid-reused");
      expect(cleanup?.details?.signalled).toBe(false);
    },
    40_000,
  );

  it("reports a proven live orphan and refuses both a duplicate spawn and a blind stop",
    async () => {
      const instance = registry.register("orphan");
      const child = await startIdleProcess();
      seedRecord(instance.instanceId, child.pid!, { osIdentityToken: "matching-identity-token" });
      const launcher = new ForbiddenLauncher();
      const manager = createManager(
        launcher,
        new StubIdentityProbe({ kind: "identity", identityToken: "matching-identity-token" }),
      );

      const report = await manager.describeInstance(instance.instanceId);
      expect(report.status).toBe("orphaned");
      expect(report.evidence.processRecord).toBe("live-identity-proven");
      expect(report.pid).toBe(child.pid);

      await expect(
        manager.startInstance(instance.instanceId, "op-start-orphan"),
      ).rejects.toMatchObject({ code: "DAEMON_INSTANCE_ORPHAN_UNRESOLVED" });
      await expect(
        manager.stopInstance(instance.instanceId, "op-stop-orphan"),
      ).rejects.toMatchObject({ code: "DAEMON_INSTANCE_ORPHAN_UNRESOLVED" });
      expect(launcher.launchCount).toBe(0);
      expect(observeProcessLiveness(child.pid!)).toBe("present");
      expect(records.read(instance.instanceId)?.state).toBe("running");
    },
    40_000,
  );

  it("proves an exited child from its absent identifier and then permits a normal start",
    async () => {
      const instance = registry.register("exited");
      const child = await startIdleProcess();
      const pid = child.pid!;
      child.kill("SIGKILL");
      await once(child, "exit");
      seedRecord(instance.instanceId, pid);

      const evidence = await evaluateProcessRecord(
        records.read(instance.instanceId),
        new PortableLivenessIdentityProbe("identity-token-unavailable"),
      );
      expect(evidence.kind).toBe("proven-exited-absent");

      const launcher = new ForbiddenLauncher();
      const manager = createManager(
        launcher,
        new PortableLivenessIdentityProbe("identity-token-unavailable"),
      );
      await expect(
        manager.startInstance(instance.instanceId, "op-start-exited"),
      ).rejects.toBeInstanceOf(Error);
      // Reconciliation cleared the proven-dead record and allowed the spawn.
      expect(launcher.launchCount).toBe(1);
      expect(records.read(instance.instanceId)).toBeNull();
    },
    40_000,
  );

  it("cleans up only a stale record and never signals while doing it",
    async () => {
      const instance = registry.register("cleanup");
      const child = await startIdleProcess();
      seedRecord(instance.instanceId, child.pid!);
      const events: DaemonAuditEvent[] = [];
      const manager = createManager(
        new ForbiddenLauncher(),
        new PortableLivenessIdentityProbe("identity-token-unavailable"),
        (event) => events.push(event),
      );

      await expect(
        manager.clearStaleRecord(instance.instanceId, "op-clean-running"),
      ).rejects.toMatchObject({ code: "DAEMON_INSTANCE_OPERATION_INVALID" });
      expect(records.read(instance.instanceId)?.state).toBe("running");

      await expect(
        manager.startInstance(instance.instanceId, "op-start-cleanup"),
      ).rejects.toMatchObject({ code: "DAEMON_INSTANCE_IDENTITY_UNPROVEN" });
      expect(records.read(instance.instanceId)?.state).toBe("stale");

      const cleaned = await manager.clearStaleRecord(instance.instanceId, "op-clean-stale");
      expect(cleaned.status).toBe("stopped");
      expect(records.read(instance.instanceId)).toBeNull();
      expect(observeProcessLiveness(child.pid!)).toBe("present");
      const cleanupEvent = events
        .filter((event) => event.eventType === "instance.stale-record-cleanup")
        .at(-1);
      expect(cleanupEvent?.details?.signalled).toBe(false);
      expect(cleanupEvent?.details?.removed).toBe(true);
    },
    40_000,
  );

  it("reports an instance owned by another live controller as controlled elsewhere",
    async () => {
      const instance = registry.register("controlled");
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx/esm",
          LOCK_FIXTURE,
          registry.registryDirectory,
          instance.instanceId,
          "55555555-5555-4555-8555-555555555555",
          "2026-07-25T11:00:00.000Z",
        ],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      children.add(child);
      await waitForLine(child, "READY");

      expect(
        await probeInstanceControllerLock(registry.registryDirectory, instance.instanceId),
      ).toBe("held-elsewhere");

      const launcher = new ForbiddenLauncher();
      const manager = createManager(
        launcher,
        new PortableLivenessIdentityProbe("identity-token-unavailable"),
      );
      const reports = await manager.listInstances();
      const report = reports.find((entry) => entry.instanceId === instance.instanceId)!;
      expect(report.status).toBe("controlled-elsewhere");
      expect(report.evidence.controllerLock).toBe("held-elsewhere");
      expect(report.evidence.readinessHandshake).toBe("absent");

      await expect(
        manager.startInstance(instance.instanceId, "op-start-controlled"),
      ).rejects.toMatchObject({ code: "DAEMON_INSTANCE_CONTROLLED_ELSEWHERE" });
      expect(launcher.launchCount).toBe(0);

      child.kill("SIGTERM");
      await once(child, "exit");
      expect(
        await probeInstanceControllerLock(registry.registryDirectory, instance.instanceId),
      ).toBe("unheld");
    },
    40_000,
  );

  it("enumerates every registered instance from the shared registry directory", () => {
    const first = registry.register("registry-a");
    const second = registry.register("registry-b");
    const listed = readInstanceRegistry(registry.registryDirectory);
    expect(listed.map((entry) => entry.instanceId).sort()).toEqual(
      [first.instanceId, second.instanceId].sort(),
    );
    for (const entry of listed) {
      expect(entry.desiredConfigRevision).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(entry.configPath.endsWith(".json")).toBe(true);
    }
  });

  it("derives a Linux identity token from a boot identifier and process start time", async () => {
    const { LinuxProcIdentityProbe } = await import("../../../src/daemon/process-identity.js");
    const bootId = "0f9c1e5a-7d31-4b8c-9c11-2a4d6e8f0b13";
    const probe = new LinuxProcIdentityProbe({
      readProcFile: (path) => {
        if (path === "/proc/sys/kernel/random/boot_id") return `${bootId}\n`;
        if (path === "/proc/4242/stat") {
          // Field 2 deliberately contains a space and parentheses.
          return `4242 (my (odd) app) S 1 4242 4242 0 -1 4194560 500 0 0 0 3 4 0 0 20 0 1 0 987654 12345 6 18446744073709551615\n`;
        }
        const error: NodeJS.ErrnoException = new Error("missing");
        error.code = "ENOENT";
        throw error;
      },
      signal: () => {
        const error: NodeJS.ErrnoException = new Error("no such process");
        error.code = "ESRCH";
        throw error;
      },
    });
    await expect(probe.observe(4242)).resolves.toEqual({
      kind: "identity",
      identityToken: `linux-proc/1:${bootId}:987654`,
    });
    await expect(probe.observe(4243)).resolves.toEqual({ kind: "absent" });
    expect(parseProcStatStartTime("1 (a b) S 1")).toBeUndefined();
  });
});
