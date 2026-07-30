/**
 * Deterministic rules of the Module control group (cgroup) lifecycle: path
 * derivation, limit read-back, the membership ordering that keeps an empty
 * reading from being a false positive, and the stop-proof decision required by
 * Architecture Decision Record (ADR) 0009.
 *
 * These run on every platform because they drive an in-memory stand-in for the
 * control-group filesystem. Whether the kernel really terminates a whole group
 * is a different question, and it is answered by
 * `tests/conformance/security/linux-module-cgroup-integration.test.ts`, which
 * runs only inside a delegated cgroup version 2 subtree on Linux.
 */
import { describe, expect, it } from "vitest";
import {
  CGROUP_V2_MOUNT_POINT,
  LinuxModuleCgroupStopProver,
  ModuleCgroupError,
  assertValidModuleCgroupLimits,
  decideModuleProcessStopProof,
  deriveModuleCgroupPath,
  isDerivedModuleCgroupPath,
  parseCgroupEventsPopulated,
  prepareDelegatedCgroupRoot,
  prepareModuleCgroup,
  type ModuleCgroupFileSystem,
  type ModuleCgroupLimits,
  type ModuleProcessStopObservation,
} from "../../../src/core/linux-module-cgroup.js";
import type { ModuleProcessRecord } from "../../../src/core/module-process-records.js";

const DELEGATED_ROOT = "/user.slice/user-1000.slice/user@1000.service/dolly.service";
const IDENTITY = {
  instanceId: "instance-1",
  moduleId: "worker",
  processGenerationId: "pg-0123456789abcdef",
} as const;
const LIMITS: ModuleCgroupLimits = {
  memoryMaxBytes: 67_108_864,
  maxProcesses: 16,
  cpuQuotaMicros: 50_000,
  cpuPeriodMicros: 100_000,
};
const BOOT_ID = "11111111-2222-3333-4444-555555555555";

const EMPTY_EVENTS = "populated 0\nfrozen 0\n";
const POPULATED_EVENTS = "populated 1\nfrozen 0\n";

const DEFAULT_CONTROL_FILES: Readonly<Record<string, string>> = {
  "cgroup.procs": "",
  "cgroup.events": EMPTY_EVENTS,
  "cgroup.kill": "",
  "cgroup.controllers": "cpu memory pids",
  "cgroup.subtree_control": "",
  "memory.max": "max",
  "memory.oom.group": "0",
  "pids.max": "max",
  "cpu.max": "max 100000",
};

function errno(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface FakeCgroupBehavior {
  /** Base names a newly created control group does not get at all. */
  readonly absentFiles?: readonly string[];
  /** Base names whose writes are dropped, as an unavailable controller does. */
  readonly ignoredWrites?: readonly string[];
  /** Base names that exist but fail a write-permission check. */
  readonly unwritableFiles?: readonly string[];
  /** Whether writing `cgroup.kill` empties the group, as the kernel does. */
  readonly killEmptiesGroup?: boolean;
  /** Number of directory removals that fail before normal behavior resumes. */
  readonly removeFailures?: number;
}

/**
 * An in-memory stand-in for the control-group filesystem. It reproduces the
 * behaviour the implementation depends on: a new group starts with the
 * kernel's unlimited defaults, a control file cannot be created by writing to
 * it, and a directory can be removed only when it has no child directory.
 */
class FakeCgroupFileSystem implements ModuleCgroupFileSystem {
  readonly writeLog: { path: string; content: string }[] = [];
  readonly removalLog: string[] = [];
  readonly #files = new Map<string, string>();
  readonly #directories = new Set<string>();
  readonly #behavior: FakeCgroupBehavior;
  #remainingRemoveFailures: number;

  constructor(behavior: FakeCgroupBehavior = {}) {
    this.#behavior = behavior;
    this.#remainingRemoveFailures = behavior.removeFailures ?? 0;
  }

  /** Creates a group directly, bypassing the code under test. */
  addCgroup(path: string, files: Readonly<Record<string, string>> = {}): void {
    this.#directories.add(path);
    for (const [name, value] of Object.entries({ ...DEFAULT_CONTROL_FILES, ...files })) {
      if (this.#behavior.absentFiles?.includes(name)) continue;
      this.#files.set(`${path}/${name}`, value);
    }
  }

  setPopulated(path: string, populated: boolean): void {
    this.#files.set(`${path}/cgroup.events`, populated ? POPULATED_EVENTS : EMPTY_EVENTS);
  }

  fileContent(path: string): string | undefined {
    return this.#files.get(path);
  }

  async readTextFile(path: string): Promise<string> {
    const value = this.#files.get(path);
    if (value === undefined) {
      throw errno(this.#directories.has(path) ? "EISDIR" : "ENOENT", `read ${path}`);
    }
    return value;
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    this.writeLog.push({ path, content });
    if (!this.#files.has(path)) throw errno("ENOENT", `write ${path}`);
    if (this.#behavior.ignoredWrites?.includes(baseName(path))) return;
    if (baseName(path) === "cgroup.subtree_control") {
      // The kernel takes "+name" and "-name" tokens and reports the resulting
      // enabled set, so a read-back never repeats what was written.
      const enabled = new Set(this.#files.get(path)!.trim().split(/\s+/).filter(Boolean));
      for (const token of content.trim().split(/\s+/).filter(Boolean)) {
        if (token.startsWith("+")) enabled.add(token.slice(1));
        else if (token.startsWith("-")) enabled.delete(token.slice(1));
        else throw errno("EINVAL", `write ${path}`);
      }
      this.#files.set(path, [...enabled].join(" "));
      return;
    }
    this.#files.set(path, content);
    if (
      baseName(path) === "cgroup.kill" &&
      content === "1" &&
      (this.#behavior.killEmptiesGroup ?? true)
    ) {
      this.setPopulated(parentPath(path), false);
    }
  }

  async createDirectory(path: string): Promise<void> {
    if (this.#directories.has(path)) throw errno("EEXIST", `mkdir ${path}`);
    if (!this.#directories.has(parentPath(path))) throw errno("ENOENT", `mkdir ${path}`);
    this.addCgroup(path);
  }

  async removeDirectory(path: string): Promise<void> {
    this.removalLog.push(path);
    if (this.#remainingRemoveFailures > 0) {
      this.#remainingRemoveFailures -= 1;
      throw errno("EBUSY", `rmdir ${path}`);
    }
    if (!this.#directories.has(path)) throw errno("ENOENT", `rmdir ${path}`);
    if ((await this.listChildDirectoryNames(path)).length > 0) {
      throw errno("ENOTEMPTY", `rmdir ${path}`);
    }
    this.#directories.delete(path);
    for (const key of [...this.#files.keys()]) {
      if (key.startsWith(`${path}/`)) this.#files.delete(key);
    }
  }

  async listChildDirectoryNames(path: string): Promise<readonly string[]> {
    if (!this.#directories.has(path)) throw errno("ENOENT", `readdir ${path}`);
    const names: string[] = [];
    for (const candidate of this.#directories) {
      if (!candidate.startsWith(`${path}/`)) continue;
      const rest = candidate.slice(path.length + 1);
      if (!rest.includes("/")) names.push(rest);
    }
    return names;
  }

  async directoryExists(path: string): Promise<boolean> {
    return this.#directories.has(path);
  }

  async writableFileExists(path: string): Promise<boolean> {
    if (!this.#files.has(path)) return false;
    return !this.#behavior.unwritableFiles?.includes(baseName(path));
  }
}

/**
 * Replaces the result of reading chosen paths. The override returns a promise
 * when it handles the path, so it can also reject with a specific error code,
 * and `undefined` when the underlying filesystem should answer.
 *
 * It delegates by composition rather than by prototype: the fake keeps its
 * state in private class fields, which an object created from it would not be
 * able to reach.
 */
class ReadOverrideFileSystem implements ModuleCgroupFileSystem {
  constructor(
    private readonly inner: FakeCgroupFileSystem,
    private readonly override: (path: string) => Promise<string> | undefined,
  ) {}

  readTextFile(path: string): Promise<string> {
    return this.override(path) ?? this.inner.readTextFile(path);
  }
  writeTextFile(path: string, content: string): Promise<void> {
    return this.inner.writeTextFile(path, content);
  }
  createDirectory(path: string): Promise<void> {
    return this.inner.createDirectory(path);
  }
  removeDirectory(path: string): Promise<void> {
    return this.inner.removeDirectory(path);
  }
  listChildDirectoryNames(path: string): Promise<readonly string[]> {
    return this.inner.listChildDirectoryNames(path);
  }
  directoryExists(path: string): Promise<boolean> {
    return this.inner.directoryExists(path);
  }
  writableFileExists(path: string): Promise<boolean> {
    return this.inner.writableFileExists(path);
  }
}

/**
 * Records every path an operation addresses, so a test can prove that a
 * rejected value never reached the filesystem at all.
 */
class AccessLogFileSystem implements ModuleCgroupFileSystem {
  readonly addressedPaths: string[] = [];

  constructor(private readonly inner: ModuleCgroupFileSystem) {}

  #note<T>(path: string, operation: () => Promise<T>): Promise<T> {
    this.addressedPaths.push(path);
    return operation();
  }

  readTextFile(path: string): Promise<string> {
    return this.#note(path, () => this.inner.readTextFile(path));
  }
  writeTextFile(path: string, content: string): Promise<void> {
    return this.#note(path, () => this.inner.writeTextFile(path, content));
  }
  createDirectory(path: string): Promise<void> {
    return this.#note(path, () => this.inner.createDirectory(path));
  }
  removeDirectory(path: string): Promise<void> {
    return this.#note(path, () => this.inner.removeDirectory(path));
  }
  listChildDirectoryNames(path: string): Promise<readonly string[]> {
    return this.#note(path, () => this.inner.listChildDirectoryNames(path));
  }
  directoryExists(path: string): Promise<boolean> {
    return this.#note(path, () => this.inner.directoryExists(path));
  }
  writableFileExists(path: string): Promise<boolean> {
    return this.#note(path, () => this.inner.writableFileExists(path));
  }
}

function newFileSystem(behavior: FakeCgroupBehavior = {}): FakeCgroupFileSystem {
  const fileSystem = new FakeCgroupFileSystem(behavior);
  fileSystem.addCgroup(`${CGROUP_V2_MOUNT_POINT}${DELEGATED_ROOT}`, {
    "cgroup.subtree_control": "cpu memory pids",
  });
  return fileSystem;
}

function modulePath(): string {
  return deriveModuleCgroupPath(DELEGATED_ROOT, IDENTITY).filesystemPath;
}

async function prepare(fileSystem: ModuleCgroupFileSystem, limits = LIMITS) {
  return prepareModuleCgroup({
    delegatedRootCgroupPath: DELEGATED_ROOT,
    identity: IDENTITY,
    limits,
    fileSystem,
    pollIntervalMs: 1,
  });
}

function processRecord(overrides: Partial<ModuleProcessRecord> = {}): ModuleProcessRecord {
  const processGenerationId = overrides.processGenerationId ?? IDENTITY.processGenerationId;
  return {
    schemaVersion: "dolly.module-process-record/1",
    instanceId: IDENTITY.instanceId,
    moduleId: IDENTITY.moduleId,
    moduleGenerationId: "module-generation-1",
    processGenerationId,
    packageDigest: `sha256:${"a".repeat(64)}`,
    configurationReference: {
      configId: "config-1",
      revision: `sha256:${"b".repeat(64)}`,
      configVersion: 1,
    },
    declaredExternalEffects: "none",
    serviceInvocationId: "invocation-1",
    bootId: BOOT_ID,
    moduleCgroupPath: deriveModuleCgroupPath(DELEGATED_ROOT, {
      ...IDENTITY,
      processGenerationId,
    }).filesystemPath,
    state: "running",
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
    ...overrides,
  };
}

function observation(
  overrides: Partial<ModuleProcessStopObservation> = {},
): ModuleProcessStopObservation {
  return {
    currentBootId: BOOT_ID,
    serviceBindingVerified: true,
    events: { kind: "populated", populated: false },
    pathRecreated: false,
    cgroupMountPoint: CGROUP_V2_MOUNT_POINT,
    ...overrides,
  };
}

describe("Module cgroup path derivation", () => {
  it("derives the path from Core identities only, embedding the process generation", () => {
    const derived = deriveModuleCgroupPath(DELEGATED_ROOT, IDENTITY);
    expect(derived.filesystemPath).toBe(
      `${CGROUP_V2_MOUNT_POINT}${DELEGATED_ROOT}/${derived.directoryName}`,
    );
    expect(derived.cgroupPath).toBe(`${DELEGATED_ROOT}/${derived.directoryName}`);
    expect(derived.directoryName).toMatch(
      new RegExp(`^dolly-module-${IDENTITY.processGenerationId}-[0-9a-f]{64}$`),
    );
    // The whole name stays inside the Linux file-name limit.
    expect(Buffer.byteLength(derived.directoryName, "utf8")).toBeLessThanOrEqual(255);
    expect(deriveModuleCgroupPath(DELEGATED_ROOT, IDENTITY)).toEqual(derived);
  });

  it("gives a different path to every distinct identity", () => {
    const paths = new Set(
      [
        IDENTITY,
        { ...IDENTITY, instanceId: "instance-2" },
        { ...IDENTITY, moduleId: "other" },
        { ...IDENTITY, processGenerationId: "pg-fedcba9876543210" },
      ].map((identity) => deriveModuleCgroupPath(DELEGATED_ROOT, identity).filesystemPath),
    );
    expect(paths.size).toBe(4);
  });

  it("rejects a process generation identifier that is not a usable directory name", () => {
    for (const processGenerationId of [
      "..",
      ".",
      "pg/escape",
      "pg with space",
      "pg.with.dots",
      "-leading-dash",
      "",
      "p".repeat(129),
    ]) {
      expect(
        () => deriveModuleCgroupPath(DELEGATED_ROOT, { ...IDENTITY, processGenerationId }),
        `processGenerationId ${JSON.stringify(processGenerationId)} must be rejected`,
      ).toThrow(ModuleCgroupError);
    }
  });

  it("rejects a delegated root that is not an absolute path without relative segments", () => {
    for (const root of ["relative/path", "/root/../escape", "/root/", "/", ""]) {
      expect(
        () => deriveModuleCgroupPath(root, IDENTITY),
        `delegated root ${JSON.stringify(root)} must be rejected`,
      ).toThrow(ModuleCgroupError);
    }
  });

  it("recognises only its own derived paths for a given process generation", () => {
    const derived = deriveModuleCgroupPath(DELEGATED_ROOT, IDENTITY);
    expect(
      isDerivedModuleCgroupPath(derived.filesystemPath, IDENTITY.processGenerationId),
    ).toBe(true);
    expect(isDerivedModuleCgroupPath(derived.filesystemPath, "pg-other")).toBe(false);
    // The kernel-relative form is not below the mount point.
    expect(isDerivedModuleCgroupPath(derived.cgroupPath, IDENTITY.processGenerationId)).toBe(
      false,
    );
    expect(
      isDerivedModuleCgroupPath(
        `/sys/fs/cgroup/dolly/${IDENTITY.processGenerationId}`,
        IDENTITY.processGenerationId,
      ),
    ).toBe(false);
    expect(isDerivedModuleCgroupPath(undefined, IDENTITY.processGenerationId)).toBe(false);
  });
});

describe("Module cgroup limit validation", () => {
  it("accepts finite page-aligned limits", () => {
    expect(() => assertValidModuleCgroupLimits(LIMITS)).not.toThrow();
  });

  it("rejects a memory limit the kernel would round to a different value", () => {
    expect(() =>
      assertValidModuleCgroupLimits({ ...LIMITS, memoryMaxBytes: 67_108_863 }),
    ).toThrow(/multiple of 4096/);
  });

  it("rejects non-finite, zero, and out-of-range limits", () => {
    const cases: ModuleCgroupLimits[] = [
      { ...LIMITS, memoryMaxBytes: 0 },
      { ...LIMITS, memoryMaxBytes: Number.POSITIVE_INFINITY },
      { ...LIMITS, maxProcesses: 0 },
      { ...LIMITS, maxProcesses: 1.5 },
      { ...LIMITS, cpuQuotaMicros: -1 },
      { ...LIMITS, cpuPeriodMicros: 999 },
      { ...LIMITS, cpuPeriodMicros: 1_000_001 },
    ];
    for (const limits of cases) {
      expect(
        () => assertValidModuleCgroupLimits(limits),
        `${JSON.stringify(limits)} must be rejected`,
      ).toThrow(ModuleCgroupError);
    }
  });
});

describe("Delegated control-group root preparation", () => {
  it("enables the required controllers and reads them back", async () => {
    const fileSystem = newFileSystem();
    const result = await prepareDelegatedCgroupRoot({
      delegatedRootCgroupPath: DELEGATED_ROOT,
      fileSystem,
    });
    expect(result.prepared).toBe(true);
    if (!result.prepared) return;
    expect([...result.root.subtreeControl].sort()).toEqual(["cpu", "memory", "pids"]);
  });

  it("refuses a root that still holds processes", async () => {
    const fileSystem = newFileSystem();
    const populated = new ReadOverrideFileSystem(fileSystem, (path) =>
      path.endsWith("/cgroup.procs") ? Promise.resolve("1234\n") : undefined,
    );
    const result = await prepareDelegatedCgroupRoot({
      delegatedRootCgroupPath: DELEGATED_ROOT,
      fileSystem: populated,
    });
    expect(result.prepared).toBe(false);
    if (result.prepared) return;
    expect(result.failure.code).toBe("MODULE_CGROUP_DELEGATED_ROOT_POPULATED");
  });

  it("refuses a root whose subtree control does not enable every controller", async () => {
    const fileSystem = newFileSystem({ ignoredWrites: ["cgroup.subtree_control"] });
    fileSystem.addCgroup(`${CGROUP_V2_MOUNT_POINT}${DELEGATED_ROOT}`, {
      "cgroup.subtree_control": "cpu pids",
    });
    const result = await prepareDelegatedCgroupRoot({
      delegatedRootCgroupPath: DELEGATED_ROOT,
      fileSystem,
    });
    expect(result.prepared).toBe(false);
    if (result.prepared) return;
    expect(result.failure.code).toBe("MODULE_CGROUP_CONTROLLER_UNAVAILABLE");
    expect(result.failure.detail).toContain("memory");
  });

  it("refuses a root that is missing a required controller", async () => {
    const fileSystem = newFileSystem();
    fileSystem.addCgroup(`${CGROUP_V2_MOUNT_POINT}${DELEGATED_ROOT}`, {
      "cgroup.controllers": "cpu pids",
    });
    const result = await prepareDelegatedCgroupRoot({
      delegatedRootCgroupPath: DELEGATED_ROOT,
      fileSystem,
    });
    expect(result.prepared).toBe(false);
    if (result.prepared) return;
    expect(result.failure.code).toBe("MODULE_CGROUP_CONTROLLER_UNAVAILABLE");
  });
});

describe("Module cgroup preparation", () => {
  it("writes and reads back every required limit", async () => {
    const fileSystem = newFileSystem();
    const result = await prepare(fileSystem);
    expect(result.prepared).toBe(true);
    if (!result.prepared) return;
    expect(result.cgroup.limits).toEqual({
      "memory.max": "67108864",
      "memory.oom.group": "1",
      "pids.max": "16",
      "cpu.max": "50000 100000",
    });
    expect(await fileSystem.directoryExists(result.cgroup.path)).toBe(true);
    expect(result.cgroup.membershipObserved).toBe(false);
  });

  it("fails closed and removes the group when a limit reads back as the unlimited default", async () => {
    const fileSystem = newFileSystem({ ignoredWrites: ["pids.max"] });
    const result = await prepare(fileSystem);
    expect(result.prepared).toBe(false);
    if (result.prepared) return;
    expect(result.failure.code).toBe("MODULE_CGROUP_LIMIT_NOT_ENFORCED");
    expect(result.failure.detail).toContain("unlimited default");
    expect(result.failure.detail).toContain("pids.max");
    expect(await fileSystem.directoryExists(modulePath())).toBe(false);
  });

  it("fails closed when a limit reads back as any other unrequested value", async () => {
    const fileSystem = newFileSystem();
    const rounding = new ReadOverrideFileSystem(fileSystem, (path) =>
      path.endsWith("/memory.max") ? Promise.resolve("67112960") : undefined,
    );
    const result = await prepare(rounding);
    expect(result.prepared).toBe(false);
    if (result.prepared) return;
    expect(result.failure.code).toBe("MODULE_CGROUP_LIMIT_NOT_ENFORCED");
    expect(result.failure.detail).toContain("67112960");
    expect(await fileSystem.directoryExists(modulePath())).toBe(false);
  });

  it("fails closed when a controller file does not exist at all", async () => {
    const fileSystem = newFileSystem({ absentFiles: ["memory.oom.group"] });
    const result = await prepare(fileSystem);
    expect(result.prepared).toBe(false);
    if (result.prepared) return;
    expect(result.failure.code).toBe("MODULE_CGROUP_LIMIT_WRITE_FAILED");
    expect(result.failure.detail).toContain("memory.oom.group");
    expect(await fileSystem.directoryExists(modulePath())).toBe(false);
  });

  it("fails closed when cgroup.kill is missing or not writable", async () => {
    for (const behavior of [
      { absentFiles: ["cgroup.kill"] },
      { unwritableFiles: ["cgroup.kill"] },
    ]) {
      const fileSystem = newFileSystem(behavior);
      const result = await prepare(fileSystem);
      expect(result.prepared, JSON.stringify(behavior)).toBe(false);
      if (result.prepared) continue;
      expect(result.failure.code).toBe("MODULE_CGROUP_TERMINATION_UNSUPPORTED");
      expect(await fileSystem.directoryExists(modulePath())).toBe(false);
    }
  });

  it("fails closed when cgroup.events cannot report a populated value", async () => {
    const fileSystem = newFileSystem();
    const broken = new ReadOverrideFileSystem(fileSystem, (path) =>
      path === `${modulePath()}/cgroup.events` ? Promise.resolve("frozen 0\n") : undefined,
    );
    const result = await prepare(broken);
    expect(result.prepared).toBe(false);
    if (result.prepared) return;
    expect(result.failure.code).toBe("MODULE_CGROUP_TERMINATION_UNSUPPORTED");
    expect(await fileSystem.directoryExists(modulePath())).toBe(false);
  });

  it("refuses to reuse an existing path and leaves it untouched", async () => {
    const fileSystem = newFileSystem();
    fileSystem.addCgroup(modulePath());
    const result = await prepare(fileSystem);
    expect(result.prepared).toBe(false);
    if (result.prepared) return;
    expect(result.failure.code).toBe("MODULE_CGROUP_PATH_IN_USE");
    expect(await fileSystem.directoryExists(modulePath())).toBe(true);
  });

  it("reports an invalid limit before it creates anything", async () => {
    const fileSystem = newFileSystem();
    const result = await prepare(fileSystem, { ...LIMITS, memoryMaxBytes: 1 });
    expect(result.prepared).toBe(false);
    if (result.prepared) return;
    expect(result.failure.code).toBe("MODULE_CGROUP_LIMITS_INVALID");
    expect(fileSystem.writeLog).toEqual([]);
    expect(await fileSystem.directoryExists(modulePath())).toBe(false);
  });
});

describe("Whole-group termination", () => {
  async function prepared(behavior: FakeCgroupBehavior = {}) {
    const fileSystem = newFileSystem(behavior);
    const result = await prepare(fileSystem);
    if (!result.prepared) throw new Error(`preparation failed: ${result.failure.detail}`);
    return { fileSystem, cgroup: result.cgroup };
  }

  it("refuses to call a never-populated group terminated", async () => {
    const { fileSystem, cgroup } = await prepared();
    const result = await cgroup.terminate({ timeoutMs: 50, pollIntervalMs: 5 });
    expect(result.terminated).toBe(false);
    if (result.terminated) return;
    expect(result.code).toBe("MODULE_CGROUP_MEMBERSHIP_UNOBSERVED");
    // No member was ever seen, so the group is not killed and nothing is
    // reported as proven. This is the false positive the delegation probe hit:
    // a group nobody has joined yet also reports `populated 0`.
    expect(fileSystem.writeLog.some((entry) => entry.path.endsWith("/cgroup.kill"))).toBe(
      false,
    );
    expect(cgroup.terminationProven).toBe(false);
  });

  it("proves termination once membership was verified from cgroup.procs", async () => {
    const { fileSystem, cgroup } = await prepared();
    fileSystem.setPopulated(cgroup.path, true);
    cgroup.recordObservedProcessIds([4321]);
    const result = await cgroup.terminate({ timeoutMs: 500, pollIntervalMs: 1 });
    expect(result.terminated).toBe(true);
    if (!result.terminated) return;
    expect(result.evidence).toBe("populated-zero");
    expect(fileSystem.fileContent(`${cgroup.path}/cgroup.kill`)).toBe("1");
    expect(cgroup.terminationProven).toBe(true);
  });

  it("accepts membership established by a populated reading at termination time", async () => {
    const { fileSystem, cgroup } = await prepared();
    fileSystem.setPopulated(cgroup.path, true);
    const result = await cgroup.terminate({ timeoutMs: 500, pollIntervalMs: 1 });
    expect(result.terminated).toBe(true);
  });

  it("rejects an empty process list as membership evidence", async () => {
    const { cgroup } = await prepared();
    expect(() => cgroup.recordObservedProcessIds([])).toThrow(TypeError);
    expect(cgroup.membershipObserved).toBe(false);
  });

  it("reports a bounded timeout instead of pretending the group emptied", async () => {
    const { fileSystem, cgroup } = await prepared({ killEmptiesGroup: false });
    fileSystem.setPopulated(cgroup.path, true);
    cgroup.recordObservedProcessIds([4321]);
    const result = await cgroup.terminate({ timeoutMs: 60, pollIntervalMs: 5 });
    expect(result.terminated).toBe(false);
    if (result.terminated) return;
    expect(result.code).toBe("MODULE_CGROUP_STILL_POPULATED");
    expect(result.readings).toBeGreaterThan(1);
    expect(cgroup.terminationProven).toBe(false);
  });

  it("reports an unreadable path rather than an empty group", async () => {
    const fileSystem = newFileSystem();
    let killed = false;
    const failsAfterKill = new ReadOverrideFileSystem(fileSystem, (path) =>
      killed && path.endsWith("/cgroup.events")
        ? Promise.reject(errno("EACCES", `read ${path}`))
        : undefined,
    );
    const result = await prepare(failsAfterKill);
    if (!result.prepared) throw new Error("preparation failed");
    const cgroup = result.cgroup;
    fileSystem.setPopulated(cgroup.path, true);
    cgroup.recordObservedProcessIds([4321]);
    killed = true;
    const terminated = await cgroup.terminate({ timeoutMs: 40, pollIntervalMs: 5 });
    expect(terminated.terminated).toBe(false);
    if (terminated.terminated) return;
    expect(terminated.code).toBe("MODULE_CGROUP_PATH_UNAVAILABLE");
    expect(cgroup.terminationProven).toBe(false);
  });

  it("reports an unavailable path when cgroup.kill cannot be written", async () => {
    const { fileSystem, cgroup } = await prepared();
    fileSystem.setPopulated(cgroup.path, true);
    cgroup.recordObservedProcessIds([4321]);
    await fileSystem.removeDirectory(cgroup.path);
    const terminated = await cgroup.terminate({ timeoutMs: 50, pollIntervalMs: 5 });
    expect(terminated.terminated).toBe(false);
    if (terminated.terminated) return;
    expect(terminated.code).toBe("MODULE_CGROUP_PATH_UNAVAILABLE");
  });

  it("waits for a first member and reports a bounded timeout when none arrives", async () => {
    const { cgroup } = await prepared();
    const result = await cgroup.waitForMembership({ timeoutMs: 40, pollIntervalMs: 5 });
    expect(result.observed).toBe(false);
    if (result.observed) return;
    expect(result.code).toBe("MODULE_CGROUP_MEMBERSHIP_TIMEOUT");
    expect(cgroup.membershipObserved).toBe(false);
  });

  it("observes a first member once one joins", async () => {
    const { fileSystem, cgroup } = await prepared();
    setTimeout(() => fileSystem.setPopulated(cgroup.path, true), 10);
    const result = await cgroup.waitForMembership({ timeoutMs: 1_000, pollIntervalMs: 2 });
    expect(result.observed).toBe(true);
    expect(cgroup.membershipObserved).toBe(true);
  });
});

describe("Module cgroup removal", () => {
  it("removes an empty group after launcher exit without claiming termination", async () => {
    const fileSystem = newFileSystem();
    const result = await prepare(fileSystem);
    if (!result.prepared) throw new Error("preparation failed");

    const removal =
      await result.cgroup.removeAfterLauncherExitBeforeExecutionAuthorization();

    expect(removal.removed).toBe(true);
    expect(result.cgroup.removed).toBe(true);
    expect(result.cgroup.terminationProven).toBe(false);
    expect(
      result.cgroup.launcherExitObservedBeforeExecutionAuthorization,
    ).toBe(true);
    expect(
      fileSystem.writeLog.some(({ path }) => path.endsWith("/cgroup.kill")),
    ).toBe(false);
  });

  it("retains a group that still has a member after launcher exit", async () => {
    const fileSystem = newFileSystem();
    const result = await prepare(fileSystem);
    if (!result.prepared) throw new Error("preparation failed");
    fileSystem.setPopulated(result.cgroup.path, true);

    const removal =
      await result.cgroup.removeAfterLauncherExitBeforeExecutionAuthorization();

    expect(removal).toMatchObject({
      removed: false,
      code: "MODULE_CGROUP_REMOVE_BEFORE_PROOF",
    });
    expect(result.cgroup.membershipObserved).toBe(true);
    expect(result.cgroup.terminationProven).toBe(false);
    expect(await fileSystem.directoryExists(result.cgroup.path)).toBe(true);
  });

  it("rechecks an empty group when a prior removal failed", async () => {
    const fileSystem = newFileSystem({ removeFailures: 1 });
    const result = await prepare(fileSystem);
    if (!result.prepared) throw new Error("preparation failed");

    const first =
      await result.cgroup.removeAfterLauncherExitBeforeExecutionAuthorization();
    expect(first).toMatchObject({
      removed: false,
      code: "MODULE_CGROUP_REMOVE_FAILED",
    });
    expect(result.cgroup.membershipObserved).toBe(false);

    fileSystem.setPopulated(result.cgroup.path, true);
    const second =
      await result.cgroup.removeAfterLauncherExitBeforeExecutionAuthorization();
    expect(second).toMatchObject({
      removed: false,
      code: "MODULE_CGROUP_REMOVE_BEFORE_PROOF",
    });
    expect(result.cgroup.membershipObserved).toBe(true);
    expect(await fileSystem.directoryExists(result.cgroup.path)).toBe(true);
  });

  it("refuses to remove a group that has not been proven empty", async () => {
    const fileSystem = newFileSystem();
    const result = await prepare(fileSystem);
    if (!result.prepared) throw new Error("preparation failed");
    const removal = await result.cgroup.remove();
    expect(removal.removed).toBe(false);
    if (removal.removed) return;
    expect(removal.code).toBe("MODULE_CGROUP_REMOVE_BEFORE_PROOF");
    expect(await fileSystem.directoryExists(result.cgroup.path)).toBe(true);
  });

  it("does not block termination after a premature removal request", async () => {
    const fileSystem = newFileSystem();
    const result = await prepare(fileSystem);
    if (!result.prepared) throw new Error("preparation failed");
    const cgroup = result.cgroup;
    fileSystem.setPopulated(cgroup.path, true);
    cgroup.recordObservedProcessIds([4321]);

    // Do not await the rejection first. A pre-proof removal must not briefly
    // present itself as an active removal and reject this termination.
    const prematureRemoval = cgroup.remove();
    const termination = cgroup.terminate({ timeoutMs: 500, pollIntervalMs: 1 });
    await expect(prematureRemoval).resolves.toMatchObject({
      removed: false,
      code: "MODULE_CGROUP_REMOVE_BEFORE_PROOF",
    });
    await expect(termination).resolves.toMatchObject({
      terminated: true,
      evidence: "populated-zero",
    });
  });

  it("removes child control groups a Module created before removing the group", async () => {
    const fileSystem = newFileSystem();
    const result = await prepare(fileSystem);
    if (!result.prepared) throw new Error("preparation failed");
    const cgroup = result.cgroup;
    fileSystem.addCgroup(`${cgroup.path}/nested`);
    fileSystem.addCgroup(`${cgroup.path}/nested/deeper`);
    fileSystem.setPopulated(cgroup.path, true);
    cgroup.recordObservedProcessIds([4321]);
    expect((await cgroup.terminate({ timeoutMs: 500, pollIntervalMs: 1 })).terminated).toBe(
      true,
    );
    const removal = await cgroup.remove();
    expect(removal.removed).toBe(true);
    if (!removal.removed) return;
    expect([...removal.removedChildCgroups].sort()).toEqual([
      `${cgroup.path}/nested`,
      `${cgroup.path}/nested/deeper`,
    ]);
    expect(await fileSystem.directoryExists(cgroup.path)).toBe(false);
  });

  it("shares one filesystem removal between simultaneous callers", async () => {
    const fileSystem = newFileSystem();
    const result = await prepare(fileSystem);
    if (!result.prepared) throw new Error("preparation failed");
    const cgroup = result.cgroup;
    fileSystem.setPopulated(cgroup.path, true);
    cgroup.recordObservedProcessIds([4321]);
    expect((await cgroup.terminate()).terminated).toBe(true);

    const first = cgroup.remove();
    const second = cgroup.remove();
    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({ removed: true });
    await expect(second).resolves.toMatchObject({ removed: true });
    expect(fileSystem.removalLog.filter((path) => path === cgroup.path)).toHaveLength(1);
  });

  it("waits for an earlier termination before it removes the control group", async () => {
    const inner = newFileSystem();
    const firstEventsReadStarted = deferred<void>();
    const releaseFirstEventsRead = deferred<void>();
    let holdFirstEventsRead = false;
    let firstEventsReadHeld = false;
    const fileSystem = new ReadOverrideFileSystem(inner, (path) => {
      if (
        holdFirstEventsRead &&
        !firstEventsReadHeld &&
        path.endsWith("/cgroup.events")
      ) {
        firstEventsReadHeld = true;
        firstEventsReadStarted.resolve();
        return releaseFirstEventsRead.promise.then(() => inner.readTextFile(path));
      }
      return undefined;
    });
    const result = await prepare(fileSystem);
    if (!result.prepared) throw new Error("preparation failed");
    const cgroup = result.cgroup;
    inner.setPopulated(cgroup.path, true);
    cgroup.recordObservedProcessIds([4321]);
    holdFirstEventsRead = true;

    const firstTermination = cgroup.terminate({ timeoutMs: 500, pollIntervalMs: 1 });
    await firstEventsReadStarted.promise;

    // A forced retry may proceed while the first call is blocked. It proves
    // the group empty, but must not let removal delete the path the first call
    // is still reading.
    const secondTermination = await cgroup.terminate({ timeoutMs: 500, pollIntervalMs: 1 });
    expect(secondTermination).toMatchObject({ terminated: true, evidence: "populated-zero" });
    const removal = cgroup.remove({ terminationWaitTimeoutMs: 10 });
    const refusedTermination = await cgroup.terminate();
    expect(refusedTermination).toMatchObject({
      terminated: false,
      code: "MODULE_CGROUP_REMOVAL_IN_PROGRESS",
    });

    const timedOutRemoval = await removal;
    expect(timedOutRemoval).toMatchObject({
      removed: false,
      code: "MODULE_CGROUP_TERMINATION_PENDING",
    });
    expect(await inner.directoryExists(cgroup.path)).toBe(true);

    // A timed-out removal does not schedule a delayed deletion. Once the old
    // call finishes, a caller must explicitly retry removal.
    releaseFirstEventsRead.resolve();
    expect(await firstTermination).toMatchObject({ terminated: true, evidence: "populated-zero" });
    await Promise.resolve();
    expect(await inner.directoryExists(cgroup.path)).toBe(true);
    expect(await cgroup.remove()).toMatchObject({ removed: true });
    expect(await inner.directoryExists(cgroup.path)).toBe(false);
  });
});

describe("cgroup.events parsing", () => {
  it("reads the populated flag and rejects anything else", () => {
    expect(parseCgroupEventsPopulated("populated 0\nfrozen 0\n")).toBe(false);
    expect(parseCgroupEventsPopulated("populated 1\nfrozen 0\n")).toBe(true);
    expect(parseCgroupEventsPopulated("frozen 0\npopulated 1")).toBe(true);
    expect(parseCgroupEventsPopulated("")).toBeUndefined();
    expect(parseCgroupEventsPopulated("frozen 0\n")).toBeUndefined();
    expect(parseCgroupEventsPopulated("populated\n")).toBeUndefined();
    expect(parseCgroupEventsPopulated("populated yes\n")).toBeUndefined();
    expect(parseCgroupEventsPopulated("populated 0\npopulated 1\n")).toBeUndefined();
  });
});

describe("Module process stop proof", () => {
  it("accepts a changed Linux boot identifier", () => {
    const proof = decideModuleProcessStopProof(
      processRecord({ bootId: "99999999-2222-3333-4444-555555555555" }),
      observation({ events: { kind: "populated", populated: true } }),
    );
    expect(proof).toEqual({ proven: true, evidence: "changed-boot-identifier" });
  });

  it("accepts populated 0 within the same boot", () => {
    expect(decideModuleProcessStopProof(processRecord(), observation())).toEqual({
      proven: true,
      evidence: "populated-zero",
    });
  });

  it("accepts a missing path that still carries the process generation", () => {
    expect(
      decideModuleProcessStopProof(
        processRecord(),
        observation({ events: { kind: "missing" } }),
      ),
    ).toEqual({ proven: true, evidence: "missing-path" });
  });

  it("fails closed on a populated, recreated, unreadable, or unparsable path", () => {
    const cases: { observation: ModuleProcessStopObservation; reason: RegExp }[] = [
      {
        observation: observation({ events: { kind: "populated", populated: true } }),
        reason: /populated 1/,
      },
      {
        observation: observation({ events: { kind: "missing" }, pathRecreated: true }),
        reason: /ambiguous/,
      },
      {
        observation: observation({ events: { kind: "unreadable", detail: "EACCES" } }),
        reason: /could not be read/,
      },
      {
        observation: observation({
          events: { kind: "unparsable", detail: "unexpected contents" },
        }),
        reason: /could not be interpreted/,
      },
    ];
    for (const testCase of cases) {
      const proof = decideModuleProcessStopProof(processRecord(), testCase.observation);
      expect(proof.proven, JSON.stringify(testCase.observation.events)).toBe(false);
      if (proof.proven) continue;
      expect(proof.reason).toMatch(testCase.reason);
    }
  });

  it("fails closed without a verified service binding or a readable boot identifier", () => {
    for (const override of [{ serviceBindingVerified: false }, { currentBootId: undefined }]) {
      const proof = decideModuleProcessStopProof(processRecord(), observation(override));
      expect(proof.proven, JSON.stringify(override)).toBe(false);
    }
  });

  it("fails closed when the recorded path was not derived from that process generation", () => {
    const proof = decideModuleProcessStopProof(
      processRecord({
        moduleCgroupPath: `/sys/fs/cgroup/dolly/${IDENTITY.processGenerationId}`,
      }),
      observation({ events: { kind: "missing" } }),
    );
    expect(proof.proven).toBe(false);
    if (proof.proven) return;
    expect(proof.reason).toMatch(/was not derived from process generation/);
  });
});

describe("LinuxModuleCgroupStopProver observations", () => {
  function prover(fileSystem: ModuleCgroupFileSystem, serviceBindingVerified = true) {
    return new LinuxModuleCgroupStopProver({
      serviceBindingVerified,
      fileSystem,
      readBootId: async () => BOOT_ID,
    });
  }

  it("proves an existing empty group stopped", async () => {
    const fileSystem = newFileSystem();
    const record = processRecord();
    fileSystem.addCgroup(record.moduleCgroupPath);
    expect(await prover(fileSystem).proveStopped(record)).toEqual({
      proven: true,
      evidence: "populated-zero",
    });
  });

  it("refuses a group that still holds a process", async () => {
    const fileSystem = newFileSystem();
    const record = processRecord();
    fileSystem.addCgroup(record.moduleCgroupPath);
    fileSystem.setPopulated(record.moduleCgroupPath, true);
    expect((await prover(fileSystem).proveStopped(record)).proven).toBe(false);
  });

  it("proves a missing path stopped", async () => {
    const record = processRecord();
    expect(await prover(newFileSystem()).proveStopped(record)).toEqual({
      proven: true,
      evidence: "missing-path",
    });
  });

  it("refuses a path that is missing its control file but present as a directory", async () => {
    const record = processRecord();
    const fileSystem = newFileSystem();
    fileSystem.addCgroup(record.moduleCgroupPath);
    const withoutEvents = new ReadOverrideFileSystem(fileSystem, (path) =>
      path === `${record.moduleCgroupPath}/cgroup.events`
        ? Promise.reject(errno("ENOENT", `read ${path}`))
        : undefined,
    );
    const proof = await prover(withoutEvents).proveStopped(record);
    expect(proof.proven).toBe(false);
    if (proof.proven) return;
    expect(proof.reason).toMatch(/ambiguous/);
  });

  it("refuses an inaccessible path", async () => {
    const fileSystem = newFileSystem();
    const record = processRecord();
    fileSystem.addCgroup(record.moduleCgroupPath);
    const denied = new ReadOverrideFileSystem(fileSystem, (path) =>
      path.endsWith("/cgroup.events")
        ? Promise.reject(errno("EACCES", `read ${path}`))
        : undefined,
    );
    const proof = await prover(denied).proveStopped(record);
    expect(proof.proven).toBe(false);
    if (proof.proven) return;
    expect(proof.reason).toMatch(/could not be read/);
  });

  it("refuses everything when the service binding is unverified", async () => {
    const fileSystem = newFileSystem();
    const record = processRecord();
    fileSystem.addCgroup(record.moduleCgroupPath);
    expect((await prover(fileSystem, false).proveStopped(record)).proven).toBe(false);
  });

  it("validates the recorded path before it addresses the filesystem", async () => {
    for (const moduleCgroupPath of [
      `/sys/fs/cgroup/dolly/${IDENTITY.processGenerationId}`,
      `/sys/fs/cgroup/../../etc/${IDENTITY.processGenerationId}`,
      `/tmp/evil/${IDENTITY.processGenerationId}`,
    ]) {
      const log = new AccessLogFileSystem(newFileSystem());
      const proof = await prover(log).proveStopped(processRecord({ moduleCgroupPath }));
      expect(proof.proven, moduleCgroupPath).toBe(false);
      if (proof.proven) continue;
      expect(proof.reason).toMatch(/was not derived from process generation/);
      // Nothing about a record that cannot be Core-derived may choose which
      // file this process opens.
      expect(log.addressedPaths, `${moduleCgroupPath} was addressed`).toEqual([]);
    }
  });
});
