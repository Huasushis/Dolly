/**
 * Kernel-level scenarios for the Module control group (cgroup) lifecycle.
 *
 * These need the environment Architecture Decision Record (ADR) 0009 defines
 * for the Core service: Linux, cgroup version 2, and a delegated service
 * subtree with `DelegateSubgroup=core`. An ordinary shell is not in such a
 * subtree, so the suite skips itself and says why. Running it inside one is
 * what `scripts/run-linux-module-launcher-integration.sh` does, and that
 * script takes the test file to run as its argument:
 *
 *   ./scripts/run-linux-module-launcher-integration.sh \
 *       tests/conformance/security/linux-module-cgroup-integration.test.ts
 *
 * On Windows the whole suite is skipped. Windows has no control groups, no
 * `cgroup.kill`, and no `cgroup.events`, so there is no partial form of these
 * scenarios that would mean anything. The deterministic rules — path
 * derivation, limit read-back, the membership ordering, and the stop-proof
 * decision — are covered on every platform by
 * `tests/conformance/core/linux-module-cgroup.test.ts`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CGROUP_V2_MOUNT_POINT,
  LinuxModuleCgroupStopProver,
  nodeModuleCgroupFileSystem,
  prepareDelegatedCgroupRoot,
  prepareModuleCgroup,
  readLinuxBootId,
  type ModuleCgroup,
  type ModuleCgroupFileSystem,
  type ModuleCgroupLimits,
} from "../../../src/core/linux-module-cgroup.js";
import type { ModuleProcessRecord } from "../../../src/core/module-process-records.js";

const LIMITS: ModuleCgroupLimits = {
  memoryMaxBytes: 67_108_864,
  maxProcesses: 16,
  cpuQuotaMicros: 50_000,
  cpuPeriodMicros: 100_000,
};

function delegatedRootCgroupPath(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const line = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find((candidate) => candidate.startsWith("0::"));
    if (!line) return undefined;
    const path = line.slice("0::".length);
    return path.endsWith("/core") ? path.slice(0, -"/core".length) : undefined;
  } catch {
    return undefined;
  }
}

const delegatedRoot = delegatedRootCgroupPath();

if (
  process.env.DOLLY_LINUX_MODULE_INTEGRATION_REQUIRED === "1" &&
  delegatedRoot === undefined
) {
  throw new Error(
    "The Linux Module integration runner did not place the test process in the required delegated control-group subtree",
  );
}

if (delegatedRoot === undefined) {
  // eslint-disable-next-line no-console
  console.warn(
    `[skip] Module cgroup integration scenarios need Linux with a delegated cgroup ` +
      `version 2 service subtree (Delegate=yes, DelegateSubgroup=core). Platform is ` +
      `${process.platform}.`,
  );
}

/** Filesystem that drops the `cgroup.kill` write, leaving the group populated. */
const fileSystemThatCannotKill: ModuleCgroupFileSystem = {
  ...nodeModuleCgroupFileSystem,
  async writeTextFile(path, content) {
    if (path.endsWith("/cgroup.kill")) return;
    return nodeModuleCgroupFileSystem.writeTextFile(path, content);
  },
};

async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.skipIf(delegatedRoot === undefined)("Module cgroup on a real Linux kernel", () => {
  const root = delegatedRoot!;
  const created: ModuleCgroup[] = [];
  const children: ChildProcess[] = [];
  let scratch: string;
  let generation = 0;

  function nextIdentity(): {
    instanceId: string;
    moduleId: string;
    processGenerationId: string;
  } {
    generation += 1;
    return {
      instanceId: "dolly-test-instance",
      moduleId: "dolly-test-module",
      processGenerationId: `pg-${process.pid}-${generation}`,
    };
  }

  async function prepare(
    fileSystem: ModuleCgroupFileSystem = nodeModuleCgroupFileSystem,
    limits: ModuleCgroupLimits = LIMITS,
  ): Promise<ModuleCgroup> {
    const result = await prepareModuleCgroup({
      delegatedRootCgroupPath: root,
      identity: nextIdentity(),
      limits,
      fileSystem,
    });
    if (!result.prepared) {
      throw new Error(`${result.failure.code}: ${result.failure.detail}`);
    }
    created.push(result.cgroup);
    return result.cgroup;
  }

  /**
   * Starts a shell that moves itself into the Module cgroup and only then
   * creates its descendants, so every process is inside the group. This is the
   * same self-migration the reviewed child launcher performs; the launcher
   * itself is exercised by the launcher integration suite.
   */
  function startInCgroup(cgroupPath: string, script: string): ChildProcess {
    const child = spawn(
      "/bin/sh",
      ["-c", `echo $$ > ${cgroupPath}/cgroup.procs || exit 1\n${script}`],
      { stdio: "ignore" },
    );
    children.push(child);
    return child;
  }

  async function readEvents(cgroupPath: string): Promise<string> {
    return (await readFile(`${cgroupPath}/cgroup.events`, "utf8")).trim();
  }

  async function readProcessIds(cgroupPath: string): Promise<number[]> {
    const text = await readFile(`${cgroupPath}/cgroup.procs`, "utf8");
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => Number.parseInt(line, 10));
  }

  /** Records the kernel `cgroup.procs` evidence, refusing an empty reading. */
  async function recordMembershipFromKernel(cgroup: ModuleCgroup): Promise<void> {
    const processIds = await readProcessIds(cgroup.path);
    expect(processIds.length, `${cgroup.path} holds no process`).toBeGreaterThan(0);
    cgroup.recordVerifiedMembership(processIds);
  }

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "dolly-test-cgroup-"));
    const prepared = await prepareDelegatedCgroupRoot({ delegatedRootCgroupPath: root });
    expect(
      prepared.prepared,
      prepared.prepared ? "" : `${prepared.failure.code}: ${prepared.failure.detail}`,
    ).toBe(true);
  });

  afterAll(async () => {
    // Best-effort cleanup. The residue scenario below turns anything left over
    // into a visible failure rather than a silent leak.
    for (const cgroup of created) {
      try {
        await writeFile(`${cgroup.path}/cgroup.kill`, "1");
      } catch {
        /* the group may already be gone */
      }
      try {
        await rmdir(cgroup.path);
      } catch {
        /* the group may already be gone */
      }
    }
    for (const child of children) child.kill("SIGKILL");
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("enables the required controllers on the delegated root, which holds no processes", async () => {
    const rootPath = `${CGROUP_V2_MOUNT_POINT}${root}`;
    expect((await readFile(`${rootPath}/cgroup.procs`, "utf8")).trim()).toBe("");
    const subtree = (await readFile(`${rootPath}/cgroup.subtree_control`, "utf8")).trim();
    for (const controller of ["cpu", "memory", "pids"]) {
      expect(subtree.split(/\s+/)).toContain(controller);
    }
  });

  it("writes every required limit and reads back the requested finite value", async () => {
    const cgroup = await prepare();
    expect(cgroup.limits).toEqual({
      "memory.max": "67108864",
      "memory.oom.group": "1",
      "pids.max": "16",
      "cpu.max": "50000 100000",
    });
    // Read straight from the kernel rather than from the returned object.
    for (const [file, value] of Object.entries(cgroup.limits)) {
      expect((await readFile(`${cgroup.path}/${file}`, "utf8")).trim(), file).toBe(value);
    }
  });

  it("refuses to reuse a Module cgroup path", async () => {
    const identity = nextIdentity();
    const first = await prepareModuleCgroup({
      delegatedRootCgroupPath: root,
      identity,
      limits: LIMITS,
    });
    expect(first.prepared).toBe(true);
    if (first.prepared) created.push(first.cgroup);
    const second = await prepareModuleCgroup({
      delegatedRootCgroupPath: root,
      identity,
      limits: LIMITS,
    });
    expect(second.prepared).toBe(false);
    if (second.prepared) return;
    expect(second.failure.code).toBe("MODULE_CGROUP_PATH_IN_USE");
  });

  it("enforces pids.max rather than only storing it", async () => {
    const cgroup = await prepare(nodeModuleCgroupFileSystem, { ...LIMITS, maxProcesses: 4 });
    // The shell moves itself in first, so every fork below counts against the
    // limit, and more are attempted than the limit allows.
    startInCgroup(cgroup.path, "for i in 1 2 3 4 5 6 7 8 9 10; do sleep 30 & done; sleep 30");
    const denied = await waitUntil(async () =>
      /(^|\n)max [1-9]/.test(await readFile(`${cgroup.path}/pids.events`, "utf8")),
    );
    expect(denied, `pids.events did not record a denied fork`).toBe(true);
    const current = Number.parseInt(
      (await readFile(`${cgroup.path}/pids.current`, "utf8")).trim(),
      10,
    );
    expect(current).toBeLessThanOrEqual(4);

    await recordMembershipFromKernel(cgroup);
    expect((await cgroup.terminate()).terminated).toBe(true);
  });

  it("refuses to report an unjoined group terminated, even though the kernel says populated 0", async () => {
    const cgroup = await prepare();
    // The kernel really does report an empty group here. That reading is the
    // pre-membership state, not evidence that anything stopped: it is the
    // false positive recorded in the delegation probe.
    expect(await readEvents(cgroup.path)).toContain("populated 0");
    expect(await readProcessIds(cgroup.path)).toEqual([]);

    const result = await cgroup.terminate({ timeoutMs: 1_000 });
    expect(result.terminated).toBe(false);
    if (result.terminated) return;
    expect(result.code).toBe("MODULE_CGROUP_MEMBERSHIP_UNOBSERVED");
    expect(cgroup.terminationProven).toBe(false);

    // Removal is refused for the same reason: there is no proof to preserve.
    const removal = await cgroup.remove();
    expect(removal.removed).toBe(false);
    if (removal.removed) return;
    expect(removal.code).toBe("MODULE_CGROUP_REMOVE_BEFORE_PROOF");
  });

  it("observes membership only after a process joins the group", async () => {
    const cgroup = await prepare();
    const tooEarly = await cgroup.waitForMembership({ timeoutMs: 150, pollIntervalMs: 20 });
    expect(tooEarly.observed).toBe(false);
    expect(cgroup.membershipObserved).toBe(false);

    startInCgroup(cgroup.path, "exec sleep 30");
    const observed = await cgroup.waitForMembership({ timeoutMs: 10_000 });
    expect(observed.observed).toBe(true);
    expect(await readEvents(cgroup.path)).toContain("populated 1");

    await recordMembershipFromKernel(cgroup);
    expect((await cgroup.terminate()).terminated).toBe(true);
  });

  it("terminates a whole group of descendants and proves populated 0", async () => {
    const cgroup = await prepare();
    const heartbeat = join(scratch, "heartbeat");
    // One shell, one background descendant that keeps writing, and one more
    // descendant. Only the shell is a direct child of this test process.
    startInCgroup(
      cgroup.path,
      `( while :; do date +%s%N > ${heartbeat}; sleep 0.05; done ) &\n` +
        `( sleep 60 ) &\nexec sleep 60`,
    );
    expect((await cgroup.waitForMembership({ timeoutMs: 10_000 })).observed).toBe(true);
    expect(
      await waitUntil(async () => (await readProcessIds(cgroup.path)).length >= 3),
      "the group never held the shell and its descendants",
    ).toBe(true);
    expect(
      await waitUntil(async () => (await readFile(heartbeat, "utf8").catch(() => "")) !== ""),
      "the descendant never wrote its heartbeat",
    ).toBe(true);

    await recordMembershipFromKernel(cgroup);
    const result = await cgroup.terminate();
    expect(result.terminated, result.terminated ? "" : `${result.code}: ${result.detail}`).toBe(
      true,
    );
    if (!result.terminated) return;
    expect(result.evidence).toBe("populated-zero");
    expect(await readEvents(cgroup.path)).toContain("populated 0");
    expect(await readProcessIds(cgroup.path)).toEqual([]);

    // The descendant that kept writing really stopped: its file does not change
    // again. That is evidence about the descendant, not about a child handle.
    const afterKill = await readFile(heartbeat, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await readFile(heartbeat, "utf8")).toBe(afterKill);

    const removal = await cgroup.remove();
    expect(removal.removed, removal.removed ? "" : removal.detail).toBe(true);
    expect(await nodeModuleCgroupFileSystem.directoryExists(cgroup.path)).toBe(false);
  });

  it("reports a bounded timeout when the group does not empty", async () => {
    // The kill is suppressed so the group stays populated. Everything else is
    // the real kernel: the wait reads the real `cgroup.events`.
    const cgroup = await prepare(fileSystemThatCannotKill);
    startInCgroup(cgroup.path, "exec sleep 60");
    expect((await cgroup.waitForMembership({ timeoutMs: 10_000 })).observed).toBe(true);

    const result = await cgroup.terminate({ timeoutMs: 300, pollIntervalMs: 20 });
    expect(result.terminated).toBe(false);
    if (result.terminated) return;
    expect(result.code).toBe("MODULE_CGROUP_STILL_POPULATED");
    expect(result.readings).toBeGreaterThan(1);
    expect(cgroup.terminationProven).toBe(false);
    expect(await readEvents(cgroup.path)).toContain("populated 1");

    // Terminate for real, so the scenario leaves nothing behind.
    await writeFile(`${cgroup.path}/cgroup.kill`, "1");
    expect(
      await waitUntil(async () => (await readEvents(cgroup.path)).includes("populated 0")),
    ).toBe(true);
    await rmdir(cgroup.path);
  });

  it("proves a stopped process from populated 0, a missing path, and a changed boot", async () => {
    const bootId = await readLinuxBootId();
    expect(bootId).toBeDefined();
    const cgroup = await prepare();
    const record = (overrides: Partial<ModuleProcessRecord> = {}): ModuleProcessRecord => ({
      schemaVersion: "dolly.module-process-record/1",
      instanceId: cgroup.identity.instanceId,
      moduleId: cgroup.identity.moduleId,
      moduleGenerationId: "dolly-test-module-generation",
      processGenerationId: cgroup.identity.processGenerationId,
      packageDigest: `sha256:${"a".repeat(64)}`,
      configurationReference: {
        configId: "dolly-test-config",
        revision: `sha256:${"b".repeat(64)}`,
        configVersion: 1,
      },
      declaredExternalEffects: "none",
      serviceInvocationId: "dolly-test-invocation",
      bootId: bootId!,
      moduleCgroupPath: cgroup.path,
      state: "running",
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
      ...overrides,
    });
    const prover = new LinuxModuleCgroupStopProver({ serviceBindingVerified: true });

    // 1. The group exists and is empty within the same boot.
    expect(await prover.proveStopped(record())).toEqual({
      proven: true,
      evidence: "populated-zero",
    });

    // 2. A live process makes the same path unprovable.
    startInCgroup(cgroup.path, "exec sleep 60");
    expect((await cgroup.waitForMembership({ timeoutMs: 10_000 })).observed).toBe(true);
    const populatedProof = await prover.proveStopped(record());
    expect(populatedProof.proven).toBe(false);
    if (!populatedProof.proven) expect(populatedProof.reason).toMatch(/populated 1/);

    // 3. A different boot identifier proves the old process cannot exist even
    //    while this path is populated by a new one.
    expect(
      await prover.proveStopped(record({ bootId: "00000000-0000-0000-0000-000000000000" })),
    ).toEqual({ proven: true, evidence: "changed-boot-identifier" });

    // 4. After real termination and removal the missing path is proof.
    await recordMembershipFromKernel(cgroup);
    expect((await cgroup.terminate()).terminated).toBe(true);
    expect((await cgroup.remove()).removed).toBe(true);
    expect(await prover.proveStopped(record())).toEqual({
      proven: true,
      evidence: "missing-path",
    });
  });

  it("refuses a stop proof when the service binding is unverified", async () => {
    const cgroup = await prepare();
    const prover = new LinuxModuleCgroupStopProver({ serviceBindingVerified: false });
    const proof = await prover.proveStopped({
      schemaVersion: "dolly.module-process-record/1",
      instanceId: cgroup.identity.instanceId,
      moduleId: cgroup.identity.moduleId,
      moduleGenerationId: "dolly-test-module-generation",
      processGenerationId: cgroup.identity.processGenerationId,
      packageDigest: `sha256:${"a".repeat(64)}`,
      configurationReference: {
        configId: "dolly-test-config",
        revision: `sha256:${"b".repeat(64)}`,
        configVersion: 1,
      },
      declaredExternalEffects: "none",
      serviceInvocationId: "dolly-test-invocation",
      bootId: (await readLinuxBootId())!,
      moduleCgroupPath: cgroup.path,
      state: "running",
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
    });
    expect(proof.proven).toBe(false);
  });

  it("leaves no Module cgroup behind", async () => {
    for (const cgroup of created) {
      if (!(await nodeModuleCgroupFileSystem.directoryExists(cgroup.path))) continue;
      // Whatever is left must already be empty; it is removed directly rather
      // than through the proof path, which must never be given a false reading.
      expect(await cgroup.readPopulated(), `${cgroup.path} still holds processes`).toBe(false);
      await rmdir(cgroup.path);
    }
    const entries = await readdir(`${CGROUP_V2_MOUNT_POINT}${root}`, { withFileTypes: true });
    expect(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)).toEqual([
      "core",
    ]);
  });
});
