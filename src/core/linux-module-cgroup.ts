/**
 * The Linux control-group (cgroup) side of Module process ownership, specified
 * by the "Module process control" section of Architecture Decision Record
 * (ADR) 0009 (`docs/adr/0009-linux-core-service-process-ownership.md`).
 *
 * A **Module cgroup** is one non-reused cgroup version 2 directory that holds
 * exactly one Module process generation and every descendant it creates. It is
 * a sibling of the `core` subgroup inside the Core service's delegated root, so
 * the delegated root itself keeps no processes and can distribute the `cpu`,
 * `memory`, and `pids` controllers to its children.
 *
 * This module owns three things and nothing else:
 *
 * 1. **Preparation.** The path is derived from Core's own instance, Module, and
 *    process-generation identities; no Extension or configuration value
 *    supplies it. Every required limit is written and read back, and the
 *    termination files are checked, before a launcher may be started. Any
 *    missing file or read-back that is not the requested finite value fails
 *    closed with a reason code.
 * 2. **Whole-group termination.** Termination writes `cgroup.kill` and then
 *    waits for `cgroup.events` to report `populated 0`. A direct child exit or
 *    a child process handle is never accepted as evidence, and no operation
 *    here ever sends a signal to a process identifier.
 * 3. **Removal.** After an empty-group proof, it removes the Module cgroup and
 *    any empty child groups. Removal waits for termination calls that began
 *    before it, so it cannot delete files another termination call is reading.
 * 4. **Stop proof after a Core restart.** `LinuxModuleCgroupStopProver`
 *    implements the `ModuleProcessStopProver` interface startup recovery uses,
 *    with the three proofs ADR 0009 accepts: `populated 0` within the same
 *    Linux boot, a missing path that still carries the record's non-reused
 *    process-generation identifier, and a changed Linux boot identifier.
 *
 * Reading `populated 0` proves nothing until the group has been observed to
 * hold a member: a group that nobody has joined yet reports `populated 0` too.
 * `docs/takeover/linux-cgroup-delegation-probe-20260726.md` records exactly
 * that false positive from the mechanism probe, so `ModuleCgroup.terminate`
 * refuses to report success unless membership was observed first, either from
 * the kernel `cgroup.procs` file or from a `populated 1` reading.
 *
 * That ordering rule applies to a live Module, not to startup recovery. During
 * recovery the Core process that could have started the process is gone and
 * systemd has already removed its service cgroup, so nothing can join an old
 * Module cgroup afterwards; ADR 0009 therefore accepts a plain `populated 0`
 * reading there.
 */

import { canonicalJsonDigest } from "./canonical-json.js";
import { REQUIRED_CGROUP_CONTROLLERS } from "./linux-core-service-binding.js";
import {
  CGROUP_V2_MOUNT_POINT,
  PROCESS_GENERATION_ID_RULE,
  isAbsoluteCgroupPath,
  isDerivedModuleCgroupPath,
  isLinuxBootId,
  isProcessGenerationId,
  moduleCgroupDirectoryName,
} from "./linux-identifier-formats.js";
import type {
  ModuleProcessStopProof,
  ModuleProcessStopProver,
} from "./core-startup-recovery.js";
import type { ModuleProcessRecord } from "./module-process-records.js";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, rmdir, stat, writeFile } from "node:fs/promises";

/**
 * Mount point of the cgroup version 2 filesystem, and the path shape rules
 * shared with the durable Module process record. The Linux Module launcher
 * adapter declares the same mount point for the launcher control protocol; the
 * value is the fixed Linux mount point in both places, and Core cannot import
 * it from an adapter because the dependency runs the other way.
 */
export {
  CGROUP_V2_MOUNT_POINT,
  isDerivedModuleCgroupPath,
} from "./linux-identifier-formats.js";

/**
 * The kernel stores `memory.max` in whole pages and reports the rounded value,
 * so a request that is not a page multiple can never read back unchanged. The
 * smallest Linux page size is required here; on a host with a larger page size
 * a value that is a multiple of this but not of the real page size still fails
 * the read-back check, which fails closed rather than open.
 */
const MEMORY_MAX_GRANULARITY_BYTES = 4096;

/** Bounds the kernel accepts for the period field of `cpu.max`. */
const MIN_CPU_PERIOD_MICROS = 1_000;
const MAX_CPU_PERIOD_MICROS = 1_000_000;

const DEFAULT_TERMINATION_TIMEOUT_MS = 5_000;
const DEFAULT_MEMBERSHIP_TIMEOUT_MS = 5_000;

/**
 * Interval between `cgroup.events` readings while waiting for a group to empty
 * or to gain its first member.
 *
 * A bounded poll is used rather than an event subscription. The kernel exposes
 * `cgroup.events` change notification through `poll(2)`/`epoll(7)` readiness on
 * the open file, and Node.js offers no way to wait on `POLLPRI` for a regular
 * file; `fs.watch` would instead rely on inotify delivery from the kernel
 * control-group filesystem, which is not a documented interface. Polling needs
 * no such guarantee, cannot lose a wake-up, and is cheap: the probe recorded
 * `populated 0` within one 50-millisecond reading, far inside the finite
 * deadline below.
 */
const DEFAULT_POLL_INTERVAL_MS = 20;

const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

/** Bounds the recursive removal of child cgroups a Module process may have created. */
const MAX_CHILD_CGROUP_DEPTH = 8;

// ---------------------------------------------------------------------------
// Failure codes
// ---------------------------------------------------------------------------

export type ModuleCgroupFailureCode =
  /** An identity or delegated root value cannot produce a safe cgroup path. */
  | "MODULE_CGROUP_IDENTITY_INVALID"
  | "MODULE_CGROUP_DELEGATED_ROOT_INVALID"
  /** A requested limit is not a finite value the kernel can store unchanged. */
  | "MODULE_CGROUP_LIMITS_INVALID"
  /** The delegated root holds processes, so it cannot distribute controllers. */
  | "MODULE_CGROUP_DELEGATED_ROOT_POPULATED"
  /** A required controller is missing from the delegated root or its subtree. */
  | "MODULE_CGROUP_CONTROLLER_UNAVAILABLE"
  /** The derived path already exists; a Module cgroup path is never reused. */
  | "MODULE_CGROUP_PATH_IN_USE"
  | "MODULE_CGROUP_CREATE_FAILED"
  | "MODULE_CGROUP_LIMIT_WRITE_FAILED"
  | "MODULE_CGROUP_LIMIT_UNREADABLE"
  /** A limit read back as an unlimited default or as any other unrequested value. */
  | "MODULE_CGROUP_LIMIT_NOT_ENFORCED"
  /** `cgroup.kill` or `cgroup.events` is missing, so group termination is unprovable. */
  | "MODULE_CGROUP_TERMINATION_UNSUPPORTED";

export class ModuleCgroupError extends Error {
  constructor(
    readonly code: ModuleCgroupFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ModuleCgroupError";
  }
}

export interface ModuleCgroupFailure {
  readonly code: ModuleCgroupFailureCode;
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// Filesystem interface
// ---------------------------------------------------------------------------

/**
 * The control-group filesystem operations this module needs. Injecting them
 * keeps the path derivation, read-back, and proof rules testable on a host
 * without cgroups; the default implementation below is the only production one.
 */
export interface ModuleCgroupFileSystem {
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
  createDirectory(path: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
  listChildDirectoryNames(path: string): Promise<readonly string[]>;
  directoryExists(path: string): Promise<boolean>;
  /** Whether the path is a regular file this process may write to. */
  writableFileExists(path: string): Promise<boolean>;
}

export const nodeModuleCgroupFileSystem: ModuleCgroupFileSystem = {
  async readTextFile(path) {
    return readFile(path, "utf8");
  },
  async writeTextFile(path, content) {
    // Control files take one write per value and reject a trailing newline in
    // some kernels, so the value is written exactly as the kernel expects it.
    await writeFile(path, content);
  },
  async createDirectory(path) {
    await mkdir(path);
  },
  async removeDirectory(path) {
    await rmdir(path);
  },
  async listChildDirectoryNames(path) {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  },
  async directoryExists(path) {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
  async writableFileExists(path) {
    try {
      if (!(await stat(path)).isFile()) return false;
      await access(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Identity and path derivation
// ---------------------------------------------------------------------------

/**
 * The three Core-owned identities a Module cgroup path is derived from. Every
 * value comes from Core's durable state; none is read from Extension code, a
 * Module package, or Module configuration.
 */
export interface ModuleCgroupIdentity {
  readonly instanceId: string;
  readonly moduleId: string;
  readonly processGenerationId: string;
}

export interface DerivedModuleCgroupPath {
  /** Single directory name of the Module cgroup inside the delegated root. */
  readonly directoryName: string;
  /**
   * Path of the group as the kernel and systemd report control groups, that is
   * relative to the cgroup version 2 mount point.
   */
  readonly cgroupPath: string;
  /**
   * Path of the same group in the filesystem. This is the value a Module
   * process record stores and the value the child launcher joins.
   */
  readonly filesystemPath: string;
}

function isSafePathValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

/**
 * Derives the Module cgroup path from Core's own identities.
 *
 * The directory name carries the non-reused `processGenerationId` literally so
 * that a later Core invocation can tell from the path alone which process
 * generation the group belonged to, which is what ADR 0009 requires before a
 * missing path may count as proof. It also carries the SHA-256 digest of the
 * canonical JSON array `[instanceId, moduleId, processGenerationId]`, so a path
 * belonging to another instance or another Module can never be mistaken for
 * this one even if an identifier were reused by mistake.
 */
export function deriveModuleCgroupPath(
  delegatedRootCgroupPath: string,
  identity: ModuleCgroupIdentity,
  cgroupMountPoint: string = CGROUP_V2_MOUNT_POINT,
): DerivedModuleCgroupPath {
  if (!isAbsoluteCgroupPath(delegatedRootCgroupPath)) {
    throw new ModuleCgroupError(
      "MODULE_CGROUP_DELEGATED_ROOT_INVALID",
      `the delegated service control-group path ${JSON.stringify(delegatedRootCgroupPath)} is not an absolute control-group path`,
    );
  }
  if (!isAbsoluteCgroupPath(cgroupMountPoint)) {
    throw new ModuleCgroupError(
      "MODULE_CGROUP_DELEGATED_ROOT_INVALID",
      `the control-group mount point ${JSON.stringify(cgroupMountPoint)} is not an absolute path`,
    );
  }
  for (const field of ["instanceId", "moduleId", "processGenerationId"] as const) {
    if (!isSafePathValue(identity[field])) {
      throw new ModuleCgroupError(
        "MODULE_CGROUP_IDENTITY_INVALID",
        `the Module cgroup identity field "${field}" must be a non-empty string without a NUL byte`,
      );
    }
  }
  if (!isProcessGenerationId(identity.processGenerationId)) {
    throw new ModuleCgroupError(
      "MODULE_CGROUP_IDENTITY_INVALID",
      `processGenerationId ${JSON.stringify(identity.processGenerationId)} is not usable as a control-group directory name; ${PROCESS_GENERATION_ID_RULE}`,
    );
  }
  const digest = canonicalJsonDigest([
    identity.instanceId,
    identity.moduleId,
    identity.processGenerationId,
  ]).slice("sha256:".length);
  const directoryName = moduleCgroupDirectoryName(identity.processGenerationId, digest);
  const cgroupPath = `${delegatedRootCgroupPath}/${directoryName}`;
  return {
    directoryName,
    cgroupPath,
    filesystemPath: `${cgroupMountPoint}${cgroupPath}`,
  };
}

// ---------------------------------------------------------------------------
// Control-file parsing
// ---------------------------------------------------------------------------

/**
 * Reads the `populated` flag of a `cgroup.events` file. The kernel writes one
 * `key value` pair per line; `populated` is 1 when the group or any descendant
 * holds a live process. An unknown or missing value returns `undefined` so the
 * caller fails closed instead of assuming the group is empty.
 */
export function parseCgroupEventsPopulated(content: string): boolean | undefined {
  let populated: boolean | undefined;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const separator = line.indexOf(" ");
    if (separator < 0) return undefined;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (key !== "populated") continue;
    if (populated !== undefined) return undefined;
    if (value === "0") populated = false;
    else if (value === "1") populated = true;
    else return undefined;
  }
  return populated;
}

/** Reads the whitespace-separated names of a `cgroup.controllers` file. */
export function parseCgroupControllerNames(content: string): readonly string[] {
  return content
    .trim()
    .split(/\s+/)
    .filter((name) => name.length > 0);
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * The Module resource limits the kernel enforces through control-group files.
 * These are the control-group members of `LinuxModuleProcessLimits` in
 * `docs/spec/core-runtime.md` Section 5.2; that record's `maxOpenFiles` is not
 * here because `RLIMIT_NOFILE` is a process resource limit the child launcher
 * applies to itself, not a control-group file.
 */
export interface ModuleCgroupLimits {
  /** `memory.max`, in bytes; must be a whole number of 4096-byte pages. */
  readonly memoryMaxBytes: number;
  /**
   * `pids.max`: the largest number of kernel tasks (processes and threads) the
   * group may hold. The existing property name is retained for configuration
   * compatibility; it does not narrow the kernel's task-counting behavior.
   */
  readonly maxProcesses: number;
  /** Quota field of `cpu.max`, in microseconds per period. */
  readonly cpuQuotaMicros: number;
  /** Period field of `cpu.max`, in microseconds. */
  readonly cpuPeriodMicros: number;
}

interface ControlFileExpectation {
  readonly file: string;
  readonly value: string;
  readonly meaning: string;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Rejects a limit the kernel could not store as the exact requested finite
 * value, before anything is written. `memory.max` is page-granular, and
 * `cpu.max` accepts only a period between one millisecond and one second.
 */
export function assertValidModuleCgroupLimits(
  limits: ModuleCgroupLimits,
): asserts limits is ModuleCgroupLimits {
  const invalid = (detail: string): never => {
    throw new ModuleCgroupError("MODULE_CGROUP_LIMITS_INVALID", detail);
  };
  if (!isPositiveSafeInteger(limits.memoryMaxBytes)) {
    invalid("memoryMaxBytes must be a positive safe integer");
  }
  if (limits.memoryMaxBytes % MEMORY_MAX_GRANULARITY_BYTES !== 0) {
    invalid(
      `memoryMaxBytes must be a multiple of ${MEMORY_MAX_GRANULARITY_BYTES} because the kernel stores memory.max in whole pages and would read back a rounded value`,
    );
  }
  if (!isPositiveSafeInteger(limits.maxProcesses)) {
    invalid("maxProcesses must be a positive safe integer");
  }
  if (!isPositiveSafeInteger(limits.cpuQuotaMicros)) {
    invalid("cpuQuotaMicros must be a positive safe integer");
  }
  if (
    !isPositiveSafeInteger(limits.cpuPeriodMicros) ||
    limits.cpuPeriodMicros < MIN_CPU_PERIOD_MICROS ||
    limits.cpuPeriodMicros > MAX_CPU_PERIOD_MICROS
  ) {
    invalid(
      `cpuPeriodMicros must be between ${MIN_CPU_PERIOD_MICROS} and ${MAX_CPU_PERIOD_MICROS} microseconds`,
    );
  }
}

/**
 * The exact control-file contents a prepared Module cgroup must read back.
 * `memory.oom.group` is included because ADR 0009 requires a memory limit
 * breach to end the whole Module process group, not only the one allocating
 * process.
 */
export function moduleCgroupControlFileExpectations(
  limits: ModuleCgroupLimits,
): readonly ControlFileExpectation[] {
  return [
    {
      file: "memory.max",
      value: String(limits.memoryMaxBytes),
      meaning: "the Module memory limit",
    },
    {
      file: "memory.oom.group",
      value: "1",
      meaning: "whole-group termination when the memory limit is exceeded",
    },
    {
      file: "pids.max",
      value: String(limits.maxProcesses),
      meaning: "the Module process-count limit",
    },
    {
      file: "cpu.max",
      value: `${limits.cpuQuotaMicros} ${limits.cpuPeriodMicros}`,
      meaning: "the Module processor rate limit",
    },
  ];
}

// ---------------------------------------------------------------------------
// Delegated root preparation
// ---------------------------------------------------------------------------

export interface DelegatedCgroupRootPreparation {
  readonly filesystemPath: string;
  readonly controllers: readonly string[];
  readonly subtreeControl: readonly string[];
}

export type DelegatedCgroupRootResult =
  | { readonly prepared: true; readonly root: DelegatedCgroupRootPreparation }
  | { readonly prepared: false; readonly failure: ModuleCgroupFailure };

export interface PrepareDelegatedCgroupRootOptions {
  /** Delegated service root as systemd reports it, relative to the mount point. */
  readonly delegatedRootCgroupPath: string;
  readonly cgroupMountPoint?: string;
  readonly fileSystem?: ModuleCgroupFileSystem;
}

/**
 * Applies the checks ADR 0009 requires of the delegated service root before
 * Core accepts Module work: the root holds no processes of its own, and it
 * distributes the `cpu`, `memory`, and `pids` controllers to its children.
 * Without those controllers a child cgroup has no `memory.max`, `pids.max`, or
 * `cpu.max` file at all, so this step is a precondition of every read-back
 * check below.
 */
export async function prepareDelegatedCgroupRoot(
  options: PrepareDelegatedCgroupRootOptions,
): Promise<DelegatedCgroupRootResult> {
  const fileSystem = options.fileSystem ?? nodeModuleCgroupFileSystem;
  const mountPoint = options.cgroupMountPoint ?? CGROUP_V2_MOUNT_POINT;
  if (
    !isAbsoluteCgroupPath(options.delegatedRootCgroupPath) ||
    !isAbsoluteCgroupPath(mountPoint)
  ) {
    return {
      prepared: false,
      failure: {
        code: "MODULE_CGROUP_DELEGATED_ROOT_INVALID",
        detail: `the delegated service control-group path ${JSON.stringify(options.delegatedRootCgroupPath)} or mount point ${JSON.stringify(mountPoint)} is not an absolute path`,
      },
    };
  }
  const filesystemPath = `${mountPoint}${options.delegatedRootCgroupPath}`;

  let processes: string;
  let controllerText: string;
  try {
    processes = await fileSystem.readTextFile(`${filesystemPath}/cgroup.procs`);
    controllerText = await fileSystem.readTextFile(`${filesystemPath}/cgroup.controllers`);
  } catch (error) {
    return {
      prepared: false,
      failure: {
        code: "MODULE_CGROUP_CONTROLLER_UNAVAILABLE",
        detail: `the delegated service root at ${filesystemPath} could not be read: ${describeError(error)}`,
      },
    };
  }
  if (processes.trim().length > 0) {
    return {
      prepared: false,
      failure: {
        code: "MODULE_CGROUP_DELEGATED_ROOT_POPULATED",
        detail: `the delegated service root at ${filesystemPath} contains processes, so cgroup version 2 will not let it distribute controllers to Module cgroups`,
      },
    };
  }
  const controllers = parseCgroupControllerNames(controllerText);
  const missing = REQUIRED_CGROUP_CONTROLLERS.filter(
    (controller) => !controllers.includes(controller),
  );
  if (missing.length > 0) {
    return {
      prepared: false,
      failure: {
        code: "MODULE_CGROUP_CONTROLLER_UNAVAILABLE",
        detail: `the delegated service root at ${filesystemPath} is missing the required controller${missing.length === 1 ? "" : "s"} ${missing.join(", ")}`,
      },
    };
  }

  const request = REQUIRED_CGROUP_CONTROLLERS.map((name) => `+${name}`).join(" ");
  let subtreeControl: readonly string[];
  try {
    await fileSystem.writeTextFile(
      `${filesystemPath}/cgroup.subtree_control`,
      request,
    );
    subtreeControl = parseCgroupControllerNames(
      await fileSystem.readTextFile(`${filesystemPath}/cgroup.subtree_control`),
    );
  } catch (error) {
    return {
      prepared: false,
      failure: {
        code: "MODULE_CGROUP_CONTROLLER_UNAVAILABLE",
        detail: `the delegated service root at ${filesystemPath} did not accept "${request}": ${describeError(error)}`,
      },
    };
  }
  const notEnabled = REQUIRED_CGROUP_CONTROLLERS.filter(
    (controller) => !subtreeControl.includes(controller),
  );
  if (notEnabled.length > 0) {
    return {
      prepared: false,
      failure: {
        code: "MODULE_CGROUP_CONTROLLER_UNAVAILABLE",
        detail: `cgroup.subtree_control of ${filesystemPath} read back as "${subtreeControl.join(" ")}" and does not enable ${notEnabled.join(", ")}`,
      },
    };
  }
  return {
    prepared: true,
    root: { filesystemPath, controllers, subtreeControl },
  };
}

// ---------------------------------------------------------------------------
// Module cgroup preparation
// ---------------------------------------------------------------------------

export interface PrepareModuleCgroupOptions {
  /** Delegated service root as systemd reports it, relative to the mount point. */
  readonly delegatedRootCgroupPath: string;
  readonly identity: ModuleCgroupIdentity;
  readonly limits: ModuleCgroupLimits;
  readonly cgroupMountPoint?: string;
  readonly fileSystem?: ModuleCgroupFileSystem;
  readonly pollIntervalMs?: number;
}

export type PrepareModuleCgroupResult =
  | { readonly prepared: true; readonly cgroup: ModuleCgroup }
  | { readonly prepared: false; readonly failure: ModuleCgroupFailure };

/**
 * Creates one Module cgroup, writes every required limit, reads each one back,
 * and verifies that the termination files exist. It fails closed on the first
 * problem and removes the directory it created, so a rejected preparation
 * leaves nothing behind.
 */
export async function prepareModuleCgroup(
  options: PrepareModuleCgroupOptions,
): Promise<PrepareModuleCgroupResult> {
  const fileSystem = options.fileSystem ?? nodeModuleCgroupFileSystem;
  const mountPoint = options.cgroupMountPoint ?? CGROUP_V2_MOUNT_POINT;

  let derived: DerivedModuleCgroupPath;
  try {
    assertValidModuleCgroupLimits(options.limits);
    derived = deriveModuleCgroupPath(
      options.delegatedRootCgroupPath,
      options.identity,
      mountPoint,
    );
  } catch (error) {
    if (error instanceof ModuleCgroupError) {
      return { prepared: false, failure: { code: error.code, detail: error.message } };
    }
    throw error;
  }

  const path = derived.filesystemPath;
  try {
    await fileSystem.createDirectory(path);
  } catch (error) {
    const code = errorCode(error);
    return {
      prepared: false,
      failure: {
        code: code === "EEXIST" ? "MODULE_CGROUP_PATH_IN_USE" : "MODULE_CGROUP_CREATE_FAILED",
        detail:
          code === "EEXIST"
            ? `the Module control group ${path} already exists; a Module cgroup path is never reused`
            : `the Module control group ${path} could not be created: ${describeError(error)}`,
      },
    };
  }

  const failAndClean = async (
    failure: ModuleCgroupFailure,
  ): Promise<PrepareModuleCgroupResult> => {
    // The group has never held a process at this point, so removing the empty
    // directory is safe. A removal problem is reported, never swallowed.
    let detail = failure.detail;
    try {
      await fileSystem.removeDirectory(path);
    } catch (error) {
      detail = `${detail}; the partially prepared control group ${path} could also not be removed: ${describeError(error)}`;
    }
    return { prepared: false, failure: { code: failure.code, detail } };
  };

  const readBack: Record<string, string> = {};
  for (const expectation of moduleCgroupControlFileExpectations(options.limits)) {
    const file = `${path}/${expectation.file}`;
    try {
      await fileSystem.writeTextFile(file, expectation.value);
    } catch (error) {
      return failAndClean({
        code: "MODULE_CGROUP_LIMIT_WRITE_FAILED",
        detail: `${expectation.file} would not accept ${JSON.stringify(expectation.value)} for ${expectation.meaning}: ${describeError(error)}`,
      });
    }
    let actual: string;
    try {
      actual = (await fileSystem.readTextFile(file)).trim();
    } catch (error) {
      return failAndClean({
        code: "MODULE_CGROUP_LIMIT_UNREADABLE",
        detail: `${expectation.file} could not be read back after writing ${expectation.meaning}: ${describeError(error)}`,
      });
    }
    if (actual !== expectation.value) {
      // "max" is the kernel's unlimited default; reporting it separately makes
      // an unenforced limit obvious instead of looking like an ordinary
      // mismatch.
      const unlimited = actual === "max" || actual.startsWith("max ");
      return failAndClean({
        code: "MODULE_CGROUP_LIMIT_NOT_ENFORCED",
        detail: unlimited
          ? `${expectation.file} read back as the unlimited default ${JSON.stringify(actual)} instead of the requested ${JSON.stringify(expectation.value)}, so ${expectation.meaning} is not enforced`
          : `${expectation.file} read back as ${JSON.stringify(actual)} instead of the requested ${JSON.stringify(expectation.value)} for ${expectation.meaning}`,
      });
    }
    readBack[expectation.file] = actual;
  }

  // Termination must be provable before anything may join the group.
  try {
    const events = await fileSystem.readTextFile(`${path}/cgroup.events`);
    if (parseCgroupEventsPopulated(events) === undefined) {
      return failAndClean({
        code: "MODULE_CGROUP_TERMINATION_UNSUPPORTED",
        detail: `cgroup.events of ${path} does not report a usable "populated" value, so an empty-group proof would be impossible`,
      });
    }
  } catch (error) {
    return failAndClean({
      code: "MODULE_CGROUP_TERMINATION_UNSUPPORTED",
      detail: `cgroup.events of ${path} could not be read, so an empty-group proof would be impossible: ${describeError(error)}`,
    });
  }
  // `cgroup.kill` is write-only and accepts only the value 1, which would
  // terminate the group, so its usability is checked by presence and write
  // permission rather than by a trial write. The kill itself is proven by the
  // Linux integration scenarios, which kill a group that really holds
  // processes and descendants.
  if (!(await fileSystem.writableFileExists(`${path}/cgroup.kill`))) {
    return failAndClean({
      code: "MODULE_CGROUP_TERMINATION_UNSUPPORTED",
      detail: `cgroup.kill of ${path} is missing or not writable, so whole-group termination would be impossible`,
    });
  }

  return {
    prepared: true,
    cgroup: new ModuleCgroup({
      identity: options.identity,
      derived,
      limits: readBack,
      fileSystem,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    }),
  };
}

// ---------------------------------------------------------------------------
// Membership, termination, and removal
// ---------------------------------------------------------------------------

export type ModuleCgroupMembershipResult =
  | { readonly observed: true; readonly waitedMs: number }
  | {
      readonly observed: false;
      readonly code: "MODULE_CGROUP_MEMBERSHIP_TIMEOUT" | "MODULE_CGROUP_PATH_UNAVAILABLE";
      readonly detail: string;
      readonly waitedMs: number;
    };

export type ModuleCgroupTerminationFailureCode =
  /**
   * Nothing was ever observed inside the group, so `populated 0` would only
   * repeat the pre-membership reading and prove nothing. ADR 0009 requires the
   * launcher's protected control descriptor for this phase instead.
   */
  | "MODULE_CGROUP_MEMBERSHIP_UNOBSERVED"
  | "MODULE_CGROUP_KILL_WRITE_FAILED"
  /** Removal has begun, so a new termination call must not reopen the path race. */
  | "MODULE_CGROUP_REMOVAL_IN_PROGRESS"
  /** The finite wait expired while the group still held a process. */
  | "MODULE_CGROUP_STILL_POPULATED"
  /** The control files could not be read, so emptiness is unproven, not false. */
  | "MODULE_CGROUP_PATH_UNAVAILABLE";

export type ModuleCgroupTerminationResult =
  | {
      readonly terminated: true;
      readonly evidence: "populated-zero";
      readonly waitedMs: number;
      readonly readings: number;
    }
  | {
      readonly terminated: false;
      readonly code: ModuleCgroupTerminationFailureCode;
      readonly detail: string;
      readonly waitedMs: number;
      readonly readings: number;
    };

export type ModuleCgroupRemovalResult =
  | { readonly removed: true; readonly removedChildCgroups: readonly string[] }
  | {
      readonly removed: false;
      readonly code:
        | "MODULE_CGROUP_REMOVE_BEFORE_PROOF"
        /** Existing termination calls did not finish before the bounded wait. */
        | "MODULE_CGROUP_TERMINATION_PENDING"
        | "MODULE_CGROUP_REMOVE_FAILED";
      readonly detail: string;
    };

export interface ModuleCgroupWaitOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface ModuleCgroupRemovalOptions {
  /**
   * Maximum time removal waits for termination calls that began before removal.
   * On expiry no directory is removed, and a later caller may retry removal.
   */
  readonly terminationWaitTimeoutMs?: number;
}

interface ModuleCgroupConstructorOptions {
  readonly identity: ModuleCgroupIdentity;
  readonly derived: DerivedModuleCgroupPath;
  readonly limits: Readonly<Record<string, string>>;
  readonly fileSystem: ModuleCgroupFileSystem;
  readonly pollIntervalMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * One prepared Module control group. The object exists only while Core owns
 * that group; it holds no process identifier and never signals a process.
 */
export class ModuleCgroup {
  readonly identity: ModuleCgroupIdentity;
  /** Filesystem path of the group; the value stored in the process record. */
  readonly path: string;
  /** Path of the group as the kernel reports control groups. */
  readonly cgroupPath: string;
  /** The limit values read back from the kernel, keyed by control-file name. */
  readonly limits: Readonly<Record<string, string>>;

  readonly #fileSystem: ModuleCgroupFileSystem;
  readonly #pollIntervalMs: number;
  #membershipObserved = false;
  #terminationProven = false;
  #activeTerminationOperations = 0;
  readonly #terminationWaiters = new Set<() => void>();
  #removalPromise: Promise<ModuleCgroupRemovalResult> | undefined;
  #removalResult: Extract<ModuleCgroupRemovalResult, { readonly removed: true }> | undefined;

  constructor(options: ModuleCgroupConstructorOptions) {
    this.identity = options.identity;
    this.path = options.derived.filesystemPath;
    this.cgroupPath = options.derived.cgroupPath;
    this.limits = Object.freeze({ ...options.limits });
    this.#fileSystem = options.fileSystem;
    this.#pollIntervalMs = options.pollIntervalMs;
  }

  /** Whether a member has ever been observed inside the group. */
  get membershipObserved(): boolean {
    return this.#membershipObserved;
  }

  /** Whether this group has been proven empty since it was terminated. */
  get terminationProven(): boolean {
    return this.#terminationProven;
  }

  /**
   * Records the kernel `cgroup.procs` evidence the launcher controller gathers
   * when it verifies launcher membership. Only a non-empty list counts: a
   * launcher's own report is never evidence, and an empty file is the
   * pre-membership state.
   */
  recordVerifiedMembership(processIds: readonly number[]): void {
    if (processIds.length === 0) {
      throw new TypeError(
        "recordVerifiedMembership needs at least one process identifier read from cgroup.procs",
      );
    }
    this.#membershipObserved = true;
  }

  /** Reads `cgroup.events` once. `undefined` means the reading was unusable. */
  async readPopulated(): Promise<boolean | undefined> {
    try {
      const content = await this.#fileSystem.readTextFile(`${this.path}/cgroup.events`);
      const populated = parseCgroupEventsPopulated(content);
      if (populated === true) this.#membershipObserved = true;
      return populated;
    } catch {
      return undefined;
    }
  }

  /**
   * Waits until the group reports `populated 1`. This is the second accepted
   * way to establish membership, for a caller that has no `cgroup.procs`
   * reading of its own.
   */
  async waitForMembership(
    options: ModuleCgroupWaitOptions = {},
  ): Promise<ModuleCgroupMembershipResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_MEMBERSHIP_TIMEOUT_MS;
    const intervalMs = options.pollIntervalMs ?? this.#pollIntervalMs;
    const startedAt = Date.now();
    let lastReadable = true;
    for (;;) {
      const populated = await this.readPopulated();
      lastReadable = populated !== undefined;
      if (populated === true) {
        return { observed: true, waitedMs: Date.now() - startedAt };
      }
      if (Date.now() - startedAt >= timeoutMs) {
        return lastReadable
          ? {
              observed: false,
              code: "MODULE_CGROUP_MEMBERSHIP_TIMEOUT",
              detail: `no process joined ${this.path} within ${timeoutMs} ms`,
              waitedMs: Date.now() - startedAt,
            }
          : {
              observed: false,
              code: "MODULE_CGROUP_PATH_UNAVAILABLE",
              detail: `cgroup.events of ${this.path} could not be read while waiting for membership`,
              waitedMs: Date.now() - startedAt,
            };
      }
      await sleep(intervalMs);
    }
  }

  /**
   * Terminates every process in the group and its descendants, then waits for
   * `cgroup.events` to report `populated 0`.
   *
   * The result never claims success without that reading. It refuses outright
   * when no member was ever observed, because an empty reading would then only
   * repeat the state the group had before anything joined; that is the false
   * positive recorded in the delegation probe.
   */
  async terminate(
    options: ModuleCgroupWaitOptions = {},
  ): Promise<ModuleCgroupTerminationResult> {
    if (this.#removalResult !== undefined) {
      return {
        terminated: false,
        code: "MODULE_CGROUP_PATH_UNAVAILABLE",
        detail: `${this.path} has already been removed after its empty-group proof`,
        waitedMs: 0,
        readings: 0,
      };
    }
    if (this.#removalPromise !== undefined) {
      return {
        terminated: false,
        code: "MODULE_CGROUP_REMOVAL_IN_PROGRESS",
        detail: `${this.path} is being removed after an empty-group proof, so a new termination call is refused`,
        waitedMs: 0,
        readings: 0,
      };
    }
    this.#activeTerminationOperations += 1;
    try {
      return await this.#terminateOnce(options);
    } finally {
      this.#activeTerminationOperations -= 1;
      if (this.#activeTerminationOperations === 0) {
        for (const resolve of this.#terminationWaiters) resolve();
        this.#terminationWaiters.clear();
      }
    }
  }

  async #terminateOnce(
    options: ModuleCgroupWaitOptions,
  ): Promise<ModuleCgroupTerminationResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS;
    const intervalMs = options.pollIntervalMs ?? this.#pollIntervalMs;
    const startedAt = Date.now();
    let readings = 0;

    if (!this.#membershipObserved) {
      // One reading can still establish membership: a process may have joined
      // since the caller last looked.
      readings += 1;
      const populated = await this.readPopulated();
      if (populated === undefined) {
        return {
          terminated: false,
          code: "MODULE_CGROUP_PATH_UNAVAILABLE",
          detail: `cgroup.events of ${this.path} could not be read, so the group cannot be proven empty`,
          waitedMs: Date.now() - startedAt,
          readings,
        };
      }
      if (!this.#membershipObserved) {
        return {
          terminated: false,
          code: "MODULE_CGROUP_MEMBERSHIP_UNOBSERVED",
          detail: `${this.path} has never been observed to hold a process, so "populated 0" would repeat its pre-membership state instead of proving termination; use the launcher control descriptor for the pre-membership phase`,
          waitedMs: Date.now() - startedAt,
          readings,
        };
      }
    }

    try {
      await this.#fileSystem.writeTextFile(`${this.path}/cgroup.kill`, "1");
    } catch (error) {
      return {
        terminated: false,
        code:
          errorCode(error) === "ENOENT"
            ? "MODULE_CGROUP_PATH_UNAVAILABLE"
            : "MODULE_CGROUP_KILL_WRITE_FAILED",
        detail: `cgroup.kill of ${this.path} could not be written: ${describeError(error)}`,
        waitedMs: Date.now() - startedAt,
        readings,
      };
    }

    let lastReadable = true;
    for (;;) {
      readings += 1;
      const populated = await this.readPopulated();
      lastReadable = populated !== undefined;
      if (populated === false) {
        this.#terminationProven = true;
        return {
          terminated: true,
          evidence: "populated-zero",
          waitedMs: Date.now() - startedAt,
          readings,
        };
      }
      if (Date.now() - startedAt >= timeoutMs) {
        return lastReadable
          ? {
              terminated: false,
              code: "MODULE_CGROUP_STILL_POPULATED",
              detail: `${this.path} still reported "populated 1" ${timeoutMs} ms after cgroup.kill, so its processes are not proven stopped`,
              waitedMs: Date.now() - startedAt,
              readings,
            }
          : {
              terminated: false,
              code: "MODULE_CGROUP_PATH_UNAVAILABLE",
              detail: `cgroup.events of ${this.path} became unreadable after cgroup.kill, so the group cannot be proven empty`,
              waitedMs: Date.now() - startedAt,
              readings,
            };
      }
      await sleep(intervalMs);
    }
  }

  /**
   * Removes the proven-empty group. A Module process may have created child
   * cgroups, which the kernel requires to be removed first; they are empty
   * after termination, so they are removed here and reported. A removal holds
   * the path against new termination calls and waits for calls already in
   * progress; on timeout it leaves the directory in place.
   */
  remove(
    options: ModuleCgroupRemovalOptions = {},
  ): Promise<ModuleCgroupRemovalResult> {
    if (this.#removalResult !== undefined) return Promise.resolve(this.#removalResult);
    if (this.#removalPromise !== undefined) return this.#removalPromise;
    const removal = this.#removeOnce(options);
    this.#removalPromise = removal;
    void removal.then(
      (result) => {
        if (this.#removalPromise !== removal) return;
        if (result.removed) this.#removalResult = result;
        this.#removalPromise = undefined;
      },
      () => {
        if (this.#removalPromise === removal) this.#removalPromise = undefined;
      },
    );
    return removal;
  }

  async #removeOnce(
    options: ModuleCgroupRemovalOptions,
  ): Promise<ModuleCgroupRemovalResult> {
    if (!this.#terminationProven) {
      return {
        removed: false,
        code: "MODULE_CGROUP_REMOVE_BEFORE_PROOF",
        detail: `${this.path} has not been proven empty, so removing it would destroy the evidence that its processes stopped`,
      };
    }
    const terminationWaitTimeoutMs =
      options.terminationWaitTimeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS;
    if (!(await this.#waitForTerminationOperations(terminationWaitTimeoutMs))) {
      return {
        removed: false,
        code: "MODULE_CGROUP_TERMINATION_PENDING",
        detail: `${this.path} still has a termination call in progress after ${terminationWaitTimeoutMs} ms; removal did not address the directory`,
      };
    }
    const removedChildCgroups: string[] = [];
    try {
      await this.#removeChildCgroups(this.path, MAX_CHILD_CGROUP_DEPTH, removedChildCgroups);
      await this.#fileSystem.removeDirectory(this.path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        // The group is gone, which is the state removal aims at. It is
        // reported as removed with whatever children were seen.
        return { removed: true, removedChildCgroups };
      }
      return {
        removed: false,
        code: "MODULE_CGROUP_REMOVE_FAILED",
        detail: `${this.path} could not be removed: ${describeError(error)}`,
      };
    }
    return { removed: true, removedChildCgroups };
  }

  #waitForTerminationOperations(timeoutMs: number): Promise<boolean> {
    if (this.#activeTerminationOperations === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (completed: boolean): void => {
        clearTimeout(timer);
        this.#terminationWaiters.delete(onTerminationsFinished);
        resolve(completed);
      };
      const onTerminationsFinished = (): void => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.#terminationWaiters.add(onTerminationsFinished);
    });
  }

  async #removeChildCgroups(
    path: string,
    depth: number,
    removed: string[],
  ): Promise<void> {
    if (depth <= 0) {
      throw new Error(
        `child control groups below ${this.path} are nested deeper than ${MAX_CHILD_CGROUP_DEPTH} levels`,
      );
    }
    let names: readonly string[];
    try {
      names = await this.#fileSystem.listChildDirectoryNames(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      const child = `${path}/${name}`;
      await this.#removeChildCgroups(child, depth - 1, removed);
      try {
        await this.#fileSystem.removeDirectory(child);
        removed.push(child);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Stop proof after a Core restart
// ---------------------------------------------------------------------------

/** What one reading of an old Module cgroup's `cgroup.events` file showed. */
export type ModuleCgroupEventsObservation =
  | { readonly kind: "populated"; readonly populated: boolean }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly detail: string }
  | { readonly kind: "unparsable"; readonly detail: string };

/**
 * Everything the stop-proof decision depends on, gathered in one bounded pass
 * so the decision itself is a pure function that runs on any platform.
 */
export interface ModuleProcessStopObservation {
  /** `/proc/sys/kernel/random/boot_id`, absent when it could not be read. */
  readonly currentBootId: string | undefined;
  /** Whether Core has verified its current systemd service binding. */
  readonly serviceBindingVerified: boolean;
  readonly events: ModuleCgroupEventsObservation;
  /**
   * Whether the path existed again when it was checked a second time after a
   * missing reading. A recreated path is ambiguous evidence and fails closed.
   */
  readonly pathRecreated: boolean;
  readonly cgroupMountPoint: string;
}

/**
 * Decides whether one old Module process record may be marked stopped, using
 * only the proofs ADR 0009 accepts. Everything else, including a populated,
 * inaccessible, ambiguous, or malformed observation, fails closed.
 */
export function decideModuleProcessStopProof(
  record: ModuleProcessRecord,
  observation: ModuleProcessStopObservation,
): ModuleProcessStopProof {
  if (!observation.serviceBindingVerified) {
    return {
      proven: false,
      reason:
        "the current systemd Core service binding is not verified, so no observation of an old Module control group can be trusted",
    };
  }
  if (observation.currentBootId === undefined) {
    return {
      proven: false,
      reason: `the current Linux boot identifier at ${BOOT_ID_PATH} could not be read, so the record's boot identifier cannot be compared`,
    };
  }
  if (record.bootId !== observation.currentBootId) {
    // A process from an earlier boot cannot still exist. Core still derives a
    // fresh non-reused path for the replacement; the old path is never reused
    // as an identity.
    return { proven: true, evidence: "changed-boot-identifier" };
  }
  if (
    !isDerivedModuleCgroupPath(
      record.moduleCgroupPath,
      record.processGenerationId,
      observation.cgroupMountPoint,
    )
  ) {
    return {
      proven: false,
      reason: `the recorded Module control-group path ${JSON.stringify(record.moduleCgroupPath)} was not derived from process generation ${record.processGenerationId} below ${observation.cgroupMountPoint}`,
    };
  }
  switch (observation.events.kind) {
    case "populated":
      return observation.events.populated
        ? {
            proven: false,
            reason: `${record.moduleCgroupPath} still reports "populated 1", so a Module process may still be running`,
          }
        : { proven: true, evidence: "populated-zero" };
    case "missing":
      if (observation.pathRecreated) {
        return {
          proven: false,
          reason: `${record.moduleCgroupPath} was missing and then present again, so its state is ambiguous`,
        };
      }
      // The path carries a process-generation identifier Core never reuses, so
      // a missing directory cannot be a different generation's group, and the
      // kernel removes a control group only when it is empty.
      return { proven: true, evidence: "missing-path" };
    case "unreadable":
      return {
        proven: false,
        reason: `${record.moduleCgroupPath} could not be read: ${observation.events.detail}`,
      };
    case "unparsable":
      return {
        proven: false,
        reason: `cgroup.events of ${record.moduleCgroupPath} could not be interpreted: ${observation.events.detail}`,
      };
  }
}

export interface LinuxModuleCgroupStopProverOptions {
  /**
   * Whether Core has already verified its current systemd service binding.
   * ADR 0009 requires that verification before any old-path observation may
   * count as evidence.
   */
  readonly serviceBindingVerified: boolean;
  readonly cgroupMountPoint?: string;
  readonly fileSystem?: ModuleCgroupFileSystem;
  /** Overridable so the decision can be exercised without a Linux host. */
  readonly readBootId?: () => Promise<string | undefined>;
}

/** Reads and validates `/proc/sys/kernel/random/boot_id`. */
export async function readLinuxBootId(
  fileSystem: ModuleCgroupFileSystem = nodeModuleCgroupFileSystem,
): Promise<string | undefined> {
  try {
    const value = (await fileSystem.readTextFile(BOOT_ID_PATH)).trim().toLowerCase();
    return isLinuxBootId(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `ModuleProcessStopProver` startup recovery uses on Linux. It gathers one
 * observation per record and applies `decideModuleProcessStopProof`; it never
 * infers absence from a saved process identifier and never signals anything.
 */
export class LinuxModuleCgroupStopProver implements ModuleProcessStopProver {
  readonly #serviceBindingVerified: boolean;
  readonly #cgroupMountPoint: string;
  readonly #fileSystem: ModuleCgroupFileSystem;
  readonly #readBootId: () => Promise<string | undefined>;

  constructor(options: LinuxModuleCgroupStopProverOptions) {
    this.#serviceBindingVerified = options.serviceBindingVerified;
    this.#cgroupMountPoint = options.cgroupMountPoint ?? CGROUP_V2_MOUNT_POINT;
    this.#fileSystem = options.fileSystem ?? nodeModuleCgroupFileSystem;
    this.#readBootId = options.readBootId ?? (() => readLinuxBootId(this.#fileSystem));
  }

  async proveStopped(record: ModuleProcessRecord): Promise<ModuleProcessStopProof> {
    return decideModuleProcessStopProof(record, await this.observe(record));
  }

  /** Gathers the observation for one record. Exposed so a caller can log it. */
  async observe(record: ModuleProcessRecord): Promise<ModuleProcessStopObservation> {
    const currentBootId = await this.#readBootId();
    let events: ModuleCgroupEventsObservation;
    let pathRecreated = false;
    // The recorded path is validated before it addresses the filesystem, not
    // after. `decideModuleProcessStopProof` rejects a path this module could
    // not have derived, so reading one first would let a corrupted record
    // choose which file this process opens for no gain.
    if (
      !isDerivedModuleCgroupPath(
        record.moduleCgroupPath,
        record.processGenerationId,
        this.#cgroupMountPoint,
      )
    ) {
      return {
        currentBootId,
        serviceBindingVerified: this.#serviceBindingVerified,
        events: {
          kind: "unreadable",
          detail: `${JSON.stringify(record.moduleCgroupPath)} is not a Core-derived Module control-group path, so it was not read`,
        },
        pathRecreated: false,
        cgroupMountPoint: this.#cgroupMountPoint,
      };
    }
    try {
      const content = await this.#fileSystem.readTextFile(
        `${record.moduleCgroupPath}/cgroup.events`,
      );
      const populated = parseCgroupEventsPopulated(content);
      events =
        populated === undefined
          ? { kind: "unparsable", detail: `unexpected contents ${JSON.stringify(content)}` }
          : { kind: "populated", populated };
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        events = { kind: "missing" };
        pathRecreated = await this.#fileSystem.directoryExists(record.moduleCgroupPath);
      } else {
        events = { kind: "unreadable", detail: describeError(error) };
      }
    }
    return {
      currentBootId,
      serviceBindingVerified: this.#serviceBindingVerified,
      events,
      pathRecreated,
      cgroupMountPoint: this.#cgroupMountPoint,
    };
  }
}
