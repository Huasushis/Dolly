/**
 * The adapter between a started child launcher and the Extension process host's
 * attached-process seam.
 *
 * `ExtensionProcessHost` deliberately does not know how its attachment
 * terminates a process, so nothing in the host can require whole-group
 * termination: an adapter that signalled one process identifier would satisfy
 * every host contract while leaving descendants running. Architecture Decision
 * Record 0009 records that obligation as Required failure test 13, and it lands
 * here, at the adapter.
 *
 * These scenarios use the real `ModuleCgroup` termination logic over an
 * in-memory stand-in for the control-group filesystem, so the evidence chain
 * under test is the production one: write `cgroup.kill`, then poll
 * `cgroup.events` until it reports `populated 0`. What an in-memory stand-in
 * cannot show is the kernel behaviour that makes group termination necessary in
 * the first place - that a descendant which left the process group survives a
 * process-group signal. That belongs to the Linux-only companion suite in
 * `tests/conformance/security/linux-module-attached-process-integration.test.ts`
 * and cannot be simulated here without assuming the very thing it proves.
 */

import { spawn, ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { attachLinuxModuleProcess } from "../../../src/adapters/linux-module-attached-process.js";
import {
  ExtensionIsolationPolicy,
  ExtensionProcessHost,
} from "../../../src/core/extension-process-host.js";
import type { ExtensionPackageManifest } from "../../../src/core/extension-installation-registry.js";
import {
  ModuleCgroup,
  deriveModuleCgroupPath,
  type ModuleCgroupFileSystem,
} from "../../../src/core/linux-module-cgroup.js";

const DELEGATED_ROOT = "/user.slice/user-1000.slice/user@1000.service/dolly.service";
const IDENTITY = {
  instanceId: "instance-1",
  moduleId: "worker",
  processGenerationId: "pg-0123456789abcdef",
} as const;
const FIXTURE = fileURLToPath(
  new URL("../security/fixtures/extension-process-fixture.mjs", import.meta.url),
);

const FIXTURE_PACKAGE_MANIFEST: ExtensionPackageManifest = {
  schemaVersion: "dolly.extension-package/1",
  extensionId: "com.example.fixture",
  packageVersion: "1.0.0",
  displayName: "Process test fixture",
  description: "Exercises the Extension process protocol in conformance tests.",
  supportedProtocolVersions: ["3.0"],
  entrypoint: "extension-process-fixture.mjs",
  modules: [{
    moduleKind: "fixture",
    activation: "reactive",
    configVersion: 1,
    configurationSchema: { type: "object" },
  }],
  requestedCapabilities: [],
};

/**
 * The control-group files `ModuleCgroup.terminate` reads and writes, in memory.
 * `killEmptiesGroup` is what a working kernel does; leaving it off is how a
 * group that refuses to empty is expressed, which is the case the adapter has
 * to fail closed on.
 */
class FakeCgroupFileSystem implements ModuleCgroupFileSystem {
  readonly writes: { path: string; content: string }[] = [];
  populated = true;
  killEmptiesGroup: boolean;
  readable = true;

  constructor(options: { readonly killEmptiesGroup?: boolean } = {}) {
    this.killEmptiesGroup = options.killEmptiesGroup ?? true;
  }

  async readTextFile(path: string): Promise<string> {
    if (!this.readable) throw new Error(`${path} is unreadable`);
    if (path.endsWith("/cgroup.events")) {
      return `populated ${this.populated ? "1" : "0"}\nfrozen 0\n`;
    }
    throw new Error(`unexpected read of ${path}`);
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    this.writes.push({ path, content });
    if (path.endsWith("/cgroup.kill") && this.killEmptiesGroup) this.populated = false;
  }

  async createDirectory(): Promise<void> {
    throw new Error("not used");
  }
  async removeDirectory(): Promise<void> {
    throw new Error("not used");
  }
  async listChildDirectoryNames(): Promise<readonly string[]> {
    return [];
  }
  async directoryExists(): Promise<boolean> {
    return true;
  }
  async writableFileExists(): Promise<boolean> {
    return true;
  }

  /** Every `cgroup.kill` write this filesystem received. */
  get killWrites(): { path: string; content: string }[] {
    return this.writes.filter((write) => write.path.endsWith("/cgroup.kill"));
  }
}

/** A prepared Module control group whose membership has been verified. */
function verifiedCgroup(
  fileSystem: ModuleCgroupFileSystem,
  options: { readonly membershipObserved?: boolean } = {},
): ModuleCgroup {
  const cgroup = new ModuleCgroup({
    identity: IDENTITY,
    derived: deriveModuleCgroupPath(DELEGATED_ROOT, IDENTITY),
    limits: {},
    fileSystem,
    pollIntervalMs: 2,
  });
  if (options.membershipObserved !== false) cgroup.recordVerifiedMembership([4_242]);
  return cgroup;
}

interface StartedChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly launcher: { readonly processId: number; readonly child: ChildProcess };
}

/**
 * A stand-in for the started launcher. The adapter uses only the launcher's
 * standard streams and its process identifier; the protected control descriptor
 * belongs to the pre-membership phase, which is over before a host attaches.
 */
function startChild(args: readonly string[], cwd: string): StartedChild {
  const child = spawn(process.execPath, [...args], {
    cwd,
    env: {},
    windowsHide: true,
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", () => undefined);
  if (child.pid === undefined) throw new Error("the test child did not start");
  return { child, launcher: { processId: child.pid, child } };
}

function stopChild(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGKILL");
  });
}

function isAlive(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function hostOptions(overrides: Record<string, unknown> = {}) {
  let id = 0;
  return {
    isolation: "process" as const,
    trust: "trusted" as const,
    isolationPolicy: new ExtensionIsolationPolicy(),
    manifest: FIXTURE_PACKAGE_MANIFEST,
    instanceId: "instance-a",
    moduleId: "module-a",
    moduleGenerationId: "module-generation-a",
    moduleKind: "fixture",
    config: {},
    maxFrameBytes: 16 * 1_024,
    initializationTimeoutMs: 5_000,
    shutdownRequestTimeoutMs: 1_000,
    forceKillDelayMs: 100,
    terminationTimeoutMs: 3_000,
    nextIdentifier: (purpose: string) => `${purpose}-${++id}`,
    ...overrides,
  };
}

describe("Linux Module attached process adapter", () => {
  it("carries the Extension protocol on the launcher child's standard streams", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-attached-adapter-streams-"));
    let started: StartedChild | undefined;
    try {
      started = startChild(["-e", "process.stdin.resume()"], scratch);
      const attached = attachLinuxModuleProcess({
        launcher: started.launcher,
        cgroup: verifiedCgroup(new FakeCgroupFileSystem()),
      });

      expect(attached.standardInput).toBe(started.child.stdin);
      expect(attached.standardOutput).toBe(started.child.stdout);
      expect(attached.processId).toBe(started.child.pid);
      expect(attached.exited).toBe(false);
    } finally {
      await stopChild(started?.child);
      rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("refuses a launcher whose standard streams are not pipes", () => {
    const withoutStreams = {
      processId: 4_242,
      child: { stdin: null, stdout: null } as unknown as ChildProcess,
    };
    expect(() =>
      attachLinuxModuleProcess({
        launcher: withoutStreams,
        cgroup: verifiedCgroup(new FakeCgroupFileSystem()),
      }),
    ).toThrowError(/standard/i);
  });

  it("terminates the whole control group instead of signalling the launcher", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-attached-adapter-group-kill-"));
    let started: StartedChild | undefined;
    try {
      started = startChild(["-e", "process.stdin.resume()"], scratch);
      // The group refuses to empty, so nothing can mistake a dead child for a
      // proven-empty group.
      const fileSystem = new FakeCgroupFileSystem({ killEmptiesGroup: false });
      const attached = attachLinuxModuleProcess({
        launcher: started.launcher,
        cgroup: verifiedCgroup(fileSystem),
        terminationTimeoutMs: 100,
      });

      attached.requestTermination();
      await vi.waitFor(() => expect(fileSystem.killWrites.length).toBeGreaterThanOrEqual(1), {
        timeout: 1_000,
        interval: 5,
      });
      expect(fileSystem.killWrites[0]).toMatchObject({ content: "1" });
      expect(fileSystem.killWrites[0]?.path).toContain(IDENTITY.processGenerationId);
      // The launcher process itself was never signalled: whole-group
      // termination is the only mechanism this adapter may use.
      expect(isAlive(started.child)).toBe(true);
      expect(attached.exited).toBe(false);
    } finally {
      await stopChild(started?.child);
      rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("sends no signal at all and still proves the group empty", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-attached-adapter-no-signal-"));
    let started: StartedChild | undefined;
    // Recording that no signal was sent is only half the claim. An adapter that
    // signalled nothing and also terminated nothing would pass a check that
    // only looks for signals, so the positive evidence is required in the same
    // case: `cgroup.kill` was written, and the exit came from `populated 0`.
    const signals: { target: unknown; signal: unknown }[] = [];
    const originalProcessKill = process.kill;
    const originalChildKill = ChildProcess.prototype.kill;
    try {
      started = startChild(["-e", "process.stdin.resume()"], scratch);
      const fileSystem = new FakeCgroupFileSystem();
      const attached = attachLinuxModuleProcess({
        launcher: started.launcher,
        cgroup: verifiedCgroup(fileSystem),
        terminationTimeoutMs: 1_000,
      });

      // Both recorders forward to the real implementation: the point is to
      // observe what the adapter does, not to change it.
      process.kill = ((target: number, signal?: string | number) => {
        signals.push({ target, signal });
        return originalProcessKill.call(process, target, signal as never);
      }) as typeof process.kill;
      ChildProcess.prototype.kill = function patched(this: ChildProcess, signal?: never) {
        signals.push({ target: this.pid, signal });
        return originalChildKill.call(this, signal);
      } as typeof ChildProcess.prototype.kill;

      attached.requestTermination();
      attached.forceTermination();
      await vi.waitFor(() => expect(attached.exited).toBe(true), {
        timeout: 2_000,
        interval: 5,
      });

      process.kill = originalProcessKill;
      ChildProcess.prototype.kill = originalChildKill;

      expect(signals).toEqual([]);
      expect(fileSystem.killWrites.length).toBeGreaterThanOrEqual(1);
      expect(fileSystem.killWrites.every((write) => write.content === "1")).toBe(true);
      expect(attached.terminationAttempts.some((attempt) => attempt.terminated)).toBe(true);
      expect(attached.terminationAttempts.find((attempt) => attempt.terminated)).toMatchObject({
        evidence: "populated-zero",
      });
    } finally {
      process.kill = originalProcessKill;
      ChildProcess.prototype.kill = originalChildKill;
      await stopChild(started?.child);
      rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("escalates with a second whole-group termination rather than doing nothing", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-attached-adapter-escalate-"));
    let started: StartedChild | undefined;
    try {
      started = startChild(["-e", "process.stdin.resume()"], scratch);
      const fileSystem = new FakeCgroupFileSystem({ killEmptiesGroup: false });
      const attached = attachLinuxModuleProcess({
        launcher: started.launcher,
        cgroup: verifiedCgroup(fileSystem),
        terminationTimeoutMs: 50,
      });

      attached.requestTermination();
      await vi.waitFor(() => expect(fileSystem.killWrites.length).toBe(1), {
        timeout: 1_000,
        interval: 5,
      });
      attached.forceTermination();
      await vi.waitFor(() => expect(fileSystem.killWrites.length).toBe(2), {
        timeout: 1_000,
        interval: 5,
      });
      expect(isAlive(started.child)).toBe(true);
    } finally {
      await stopChild(started?.child);
      rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("reports the exit only once the group is proven empty", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-attached-adapter-populated-"));
    let started: StartedChild | undefined;
    try {
      started = startChild(["-e", "process.stdin.resume()"], scratch);
      const fileSystem = new FakeCgroupFileSystem({ killEmptiesGroup: false });
      const attached = attachLinuxModuleProcess({
        launcher: started.launcher,
        cgroup: verifiedCgroup(fileSystem),
        terminationTimeoutMs: 50,
      });
      const observed = vi.fn();
      attached.onExit(observed);

      attached.requestTermination();
      await vi.waitFor(() => expect(attached.terminationAttempts.length).toBe(1), {
        timeout: 1_000,
        interval: 5,
      });
      expect(attached.terminationAttempts[0]).toMatchObject({
        terminated: false,
        code: "MODULE_CGROUP_STILL_POPULATED",
      });
      expect(attached.exited).toBe(false);
      expect(observed).not.toHaveBeenCalled();

      // The kernel now empties the group, and only that reading is the proof.
      fileSystem.killEmptiesGroup = true;
      attached.forceTermination();
      await vi.waitFor(() => expect(attached.exited).toBe(true), {
        timeout: 1_000,
        interval: 5,
      });
      expect(observed).toHaveBeenCalledTimes(1);
      expect(attached.terminationAttempts[1]).toMatchObject({
        terminated: true,
        evidence: "populated-zero",
      });
    } finally {
      await stopChild(started?.child);
      rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("does not report an exit when the launcher child exits but the group stays populated", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-attached-adapter-child-exit-"));
    let started: StartedChild | undefined;
    try {
      started = startChild(["-e", "process.stdin.resume()"], scratch);
      const fileSystem = new FakeCgroupFileSystem({ killEmptiesGroup: false });
      const attached = attachLinuxModuleProcess({
        launcher: started.launcher,
        cgroup: verifiedCgroup(fileSystem),
        terminationTimeoutMs: 50,
      });
      const observed = vi.fn();
      attached.onExit(observed);

      // The direct child really does exit. After control-group membership is
      // verified, that is never proof: a descendant can still hold the group.
      await stopChild(started.child);
      expect(isAlive(started.child)).toBe(false);

      attached.requestTermination();
      await vi.waitFor(() => expect(attached.terminationAttempts.length).toBe(1), {
        timeout: 1_000,
        interval: 5,
      });
      expect(attached.exited).toBe(false);
      expect(observed).not.toHaveBeenCalled();
    } finally {
      await stopChild(started?.child);
      rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("refuses to report an exit when the group never held an observed member", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-attached-adapter-unobserved-"));
    let started: StartedChild | undefined;
    try {
      started = startChild(["-e", "process.stdin.resume()"], scratch);
      const fileSystem = new FakeCgroupFileSystem();
      fileSystem.populated = false;
      const attached = attachLinuxModuleProcess({
        launcher: started.launcher,
        cgroup: verifiedCgroup(fileSystem, { membershipObserved: false }),
        terminationTimeoutMs: 50,
      });

      attached.requestTermination();
      await vi.waitFor(() => expect(attached.terminationAttempts.length).toBe(1), {
        timeout: 1_000,
        interval: 5,
      });
      // An empty reading from a group nothing ever joined repeats its
      // pre-membership state; it is not termination evidence.
      expect(attached.terminationAttempts[0]).toMatchObject({
        terminated: false,
        code: "MODULE_CGROUP_MEMBERSHIP_UNOBSERVED",
      });
      expect(attached.exited).toBe(false);
      expect(fileSystem.killWrites).toHaveLength(0);
    } finally {
      await stopChild(started?.child);
      rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("drives one real Extension through the host over the adapter", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-attached-adapter-end-to-end-"));
    let started: StartedChild | undefined;
    try {
      started = startChild([FIXTURE, "normal"], scratch);
      const fileSystem = new FakeCgroupFileSystem();
      const attached = attachLinuxModuleProcess({
        launcher: started.launcher,
        cgroup: verifiedCgroup(fileSystem),
        terminationTimeoutMs: 1_000,
      });
      const host = new ExtensionProcessHost({
        ...hostOptions(),
        attachedProcess: attached,
      });

      expect(host.snapshot.pid).toBe(started.child.pid);
      await expect(host.start()).resolves.toMatchObject({ state: "ready" });
      await expect(
        host.execute({
          moduleJobId: "module-job-a",
          runId: "run-a",
          attempt: 1,
          deadline: new Date(Date.now() + 1_000).toISOString(),
          responseTimeoutMs: 2_000,
          hasMore: false,
          input: {},
        }),
      ).resolves.toEqual({ ok: true, input: {} });

      await expect(host.stop()).resolves.toMatchObject({ state: "stopped" });
      // The host reported a stop, so the group must have been terminated and
      // proven empty; a protocol shutdown alone is not that proof.
      expect(fileSystem.killWrites.length).toBeGreaterThanOrEqual(1);
      expect(attached.exited).toBe(true);
    } finally {
      await stopChild(started?.child);
      rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("makes the host fail closed when the group is never proven empty", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-attached-adapter-unproven-"));
    let started: StartedChild | undefined;
    try {
      started = startChild([FIXTURE, "normal"], scratch);
      const fileSystem = new FakeCgroupFileSystem({ killEmptiesGroup: false });
      const attached = attachLinuxModuleProcess({
        launcher: started.launcher,
        cgroup: verifiedCgroup(fileSystem),
        terminationTimeoutMs: 100,
      });
      const host = new ExtensionProcessHost({
        ...hostOptions({ forceKillDelayMs: 50, terminationTimeoutMs: 400 }),
        attachedProcess: attached,
      });

      await host.start();
      await expect(host.terminate()).rejects.toMatchObject({
        code: "EXTENSION_TERMINATION_UNCONFIRMED",
      });
      expect(host.snapshot.state).toBe("failed");
      expect(host.snapshot.state).not.toBe("stopped");
    } finally {
      await stopChild(started?.child);
      rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
