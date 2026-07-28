/**
 * Verification that the running Dolly Core process is the main process of its
 * stable systemd Core service, as required by the "Stable Core service
 * lifecycle" section of Architecture Decision Record 0009
 * (`docs/adr/0009-linux-core-service-process-ownership.md`).
 *
 * Two directions of the binding are proven before Core may accept Module work:
 *
 * 1. the systemd service manager reports this operating-system process
 *    identifier as the unit's main process identifier; and
 * 2. this process's own control group, read from the Linux process filesystem
 *    at `/proc/self/cgroup`, is the delegated subgroup of the control group
 *    the manager reports for that same unit.
 *
 * The manager reports the service control-group root (`.../name.service`)
 * while the main process actually lives in the delegated subgroup
 * (`.../name.service/core`), so direction 2 compares against the reported path
 * joined with the effective `DelegateSubgroup` name, never against the
 * reported path itself.
 *
 * The unit name is only a candidate: Architecture Decision Record 0009 allows
 * Core to carry it in its minimal environment but treats neither it nor a
 * saved process identifier as authority. A wrong candidate name simply fails
 * one of the two directions above.
 *
 * Everything here fails closed. A missing, unreadable, or unverifiable value
 * produces a structured failure carrying a reason code; no function in this
 * module throws a bare string, and no partial observation is reported as
 * success. Every external wait is bounded.
 */

import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import { promisify } from "node:util";
import {
  isLinuxBootId,
  isServiceInvocationId,
} from "./linux-identifier-formats.js";

const execFileAsync = promisify(execFile);

/** The delegated subgroup that must hold the Core process itself. */
export const REQUIRED_DELEGATE_SUBGROUP = "core";

/** Control-group version 2 controllers Module resource limits depend on. */
export const REQUIRED_CGROUP_CONTROLLERS = ["cpu", "memory", "pids"] as const;

/** `CGROUP2_SUPER_MAGIC` from the Linux kernel, reported by `statfs`. */
const CGROUP2_SUPER_MAGIC = 0x63677270;

const DEFAULT_CGROUP_ROOT = "/sys/fs/cgroup";
const DEFAULT_QUERY_TIMEOUT_MS = 5_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 15_000;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;

const SYSTEMD_BUS_NAME = "org.freedesktop.systemd1";
const SYSTEMD_MANAGER_OBJECT = "/org/freedesktop/systemd1";
const SYSTEMD_MANAGER_INTERFACE = "org.freedesktop.systemd1.Manager";
const SYSTEMD_UNIT_INTERFACE = "org.freedesktop.systemd1.Unit";
const SYSTEMD_SERVICE_INTERFACE = "org.freedesktop.systemd1.Service";
const DBUS_PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";

/**
 * How the Core service is installed. A `user` service runs under the calling
 * user's systemd manager and therefore requires user lingering; a `system`
 * service runs under the system manager and instead requires a dedicated,
 * non-root service account.
 */
export type CoreServiceMode = "user" | "system";

export type CoreServiceBindingFailureCode =
  // Availability of the evidence itself.
  | "CORE_SERVICE_PLATFORM_UNSUPPORTED"
  | "CORE_SERVICE_MANAGER_UNAVAILABLE"
  | "CORE_SERVICE_UNIT_NOT_FOUND"
  | "CORE_SERVICE_QUERY_TIMEOUT"
  | "CORE_SERVICE_PROPERTY_UNREADABLE"
  // Two-direction binding proof.
  | "CORE_SERVICE_MAIN_PID_MISMATCH"
  | "CORE_SERVICE_CONTROL_GROUP_UNAVAILABLE"
  | "CORE_SERVICE_PROCESS_CGROUP_UNAVAILABLE"
  | "CORE_SERVICE_CGROUP_MISMATCH"
  | "CORE_SERVICE_INVOCATION_ID_UNAVAILABLE"
  | "CORE_SERVICE_BOOT_ID_UNAVAILABLE"
  // Effective unit settings.
  | "CORE_SERVICE_TYPE_INVALID"
  | "CORE_SERVICE_RESTART_POLICY_INVALID"
  | "CORE_SERVICE_RESTART_LIMIT_INVALID"
  | "CORE_SERVICE_KILL_MODE_INVALID"
  | "CORE_SERVICE_SIGKILL_DISABLED"
  | "CORE_SERVICE_STOP_TIMEOUT_INVALID"
  | "CORE_SERVICE_DELEGATION_DISABLED"
  | "CORE_SERVICE_DELEGATE_SUBGROUP_INVALID"
  | "CORE_SERVICE_CGROUP_V2_UNAVAILABLE"
  | "CORE_SERVICE_CONTROLLER_UNAVAILABLE"
  | "CORE_SERVICE_EXIT_TYPE_INVALID"
  | "CORE_SERVICE_RESTART_MODE_INVALID"
  // Settings that weaken the required semantics.
  | "CORE_SERVICE_REMAIN_AFTER_EXIT_ENABLED"
  | "CORE_SERVICE_SUCCESS_EXIT_STATUS_OVERRIDDEN"
  | "CORE_SERVICE_RESTART_PREVENT_EXIT_STATUS_OVERRIDDEN"
  | "CORE_SERVICE_ENVIRONMENT_NOT_MINIMAL"
  // The command the manager executes.
  | "CORE_SERVICE_EXEC_START_PATH_INVALID"
  | "CORE_SERVICE_EXEC_START_ENVIRONMENT_EXPANDED"
  // Service-manager lifetime.
  | "CORE_SERVICE_USER_LINGERING_DISABLED"
  | "CORE_SERVICE_USER_LINGERING_UNKNOWN"
  | "CORE_SERVICE_ACCOUNT_INVALID";

export interface CoreServiceBindingFailure {
  readonly code: CoreServiceBindingFailureCode;
  readonly detail: string;
}

/**
 * A set of process exit statuses configured on the unit. systemd reports
 * `SuccessExitStatus` and `RestartPreventExitStatus` as one list of numeric
 * exit codes and one list of signal numbers.
 */
export interface ExitStatusSet {
  readonly exitCodes: readonly number[];
  readonly signals: readonly number[];
}

/**
 * The systemd `ExecStartEx` flag that corresponds to the `:` prefix in a unit
 * file: systemd does not expand environment variables in this command's
 * executable path or arguments.
 */
export const NO_ENVIRONMENT_EXPANSION_FLAG = "no-env-expand";

/**
 * One command line of `ExecStart`. The manager reports the resolved executable
 * path, the argument vector, and the prefix flags of the unit-file line; the
 * flags are read from `ExecStartEx`, because the older `ExecStart` property
 * omits everything but `ignore-failure`.
 */
export interface CoreServiceExecCommand {
  readonly path: string;
  readonly argumentVector: readonly string[];
  /** systemd prefix flags, for example `no-env-expand` for the `:` prefix. */
  readonly flags: readonly string[];
}

/**
 * The effective unit settings the service manager currently applies, read
 * from its interface rather than from unit-file text. Durations are
 * microseconds, with `Number.POSITIVE_INFINITY` standing for the systemd
 * `infinity` value.
 */
export interface CoreServiceUnitProperties {
  readonly invocationId: string;
  readonly startLimitBurst: number;
  readonly startLimitIntervalUSec: number;
  readonly mainPid: number;
  readonly controlGroup: string;
  readonly type: string;
  readonly restart: string;
  readonly killMode: string;
  readonly sendSigkill: boolean;
  readonly timeoutStopUSec: number;
  readonly delegate: boolean;
  readonly delegateSubgroup: string;
  readonly exitType: string;
  readonly restartMode: string;
  readonly remainAfterExit: boolean;
  readonly successExitStatus: ExitStatusSet;
  readonly restartPreventExitStatus: ExitStatusSet;
  readonly passEnvironment: readonly string[];
  readonly environmentFiles: readonly string[];
  readonly execStart: readonly CoreServiceExecCommand[];
  readonly user: string;
}

/**
 * Every fact gathered about the current Core service in one bounded pass.
 * `verifyCoreServiceBinding` is a pure function of this record, so the same
 * decision logic runs against a live Linux service and against fixtures on any
 * platform.
 */
export interface CoreServiceObservation {
  readonly mode: CoreServiceMode;
  readonly unitName: string;
  /** This process's own identifier, not a saved or reported one. */
  readonly selfPid: number;
  /** Path from the `0::` line of `/proc/self/cgroup`, absent when unreadable. */
  readonly selfCgroupPath: string | undefined;
  /** Contents of `/proc/sys/kernel/random/boot_id`, absent when unreadable. */
  readonly bootId: string | undefined;
  readonly unit: CoreServiceUnitProperties;
  /** `cgroup.controllers` of the delegated service root, absent when unreadable. */
  readonly delegatedRootControllers: readonly string[] | undefined;
  /** Whether the control-group mount really is control-group version 2. */
  readonly cgroupFilesystemIsV2: boolean;
  /** `Linger` for the owning user; absent when it could not be determined. */
  readonly lingerEnabled: boolean | undefined;
}

/**
 * The proven binding. `serviceInvocationId` and `bootId` are the two values a
 * Module process record persists so a later Core invocation can tell an old
 * record apart from the current service instance.
 */
export interface VerifiedCoreServiceBinding {
  readonly mode: CoreServiceMode;
  readonly unitName: string;
  readonly serviceInvocationId: string;
  readonly bootId: string;
  readonly mainPid: number;
  /**
   * The delegated service root reported by the manager. It holds no processes
   * of its own; Core creates every Module control group as a sibling of the
   * `core` subgroup inside it.
   */
  readonly delegatedRootCgroupPath: string;
  /** Where the Core process itself runs: the delegated root's `core` subgroup. */
  readonly coreCgroupPath: string;
  readonly delegatedRootControllers: readonly string[];
}

export type CoreServiceBindingResult =
  | { readonly verified: true; readonly binding: VerifiedCoreServiceBinding }
  | { readonly verified: false; readonly failures: readonly CoreServiceBindingFailure[] };

export type CoreServiceObservationResult =
  | { readonly observed: true; readonly observation: CoreServiceObservation }
  | { readonly observed: false; readonly failures: readonly CoreServiceBindingFailure[] };

export interface CoreServiceInspectionOptions {
  /** Candidate unit name, for example `dolly-core@instance.service`. */
  readonly unitName: string;
  readonly mode: CoreServiceMode;
  /** Bound on one service-manager or filesystem query. */
  readonly queryTimeoutMs?: number;
  /** Bound on the whole inspection. */
  readonly overallTimeoutMs?: number;
  readonly cgroupRoot?: string;
  readonly busctlPath?: string;
  readonly loginctlPath?: string;
}

// ---------------------------------------------------------------------------
// Pure parsing helpers. These are exported so the deterministic tests can
// exercise the exact text and byte shapes systemd produces.
// ---------------------------------------------------------------------------

/**
 * Reads the control-group path of the calling process from `/proc/self/cgroup`
 * contents. Control-group version 2 uses a single `0::<path>` line; anything
 * else means the process is not on a pure version 2 hierarchy and no path is
 * returned.
 */
export function parseProcessCgroupPath(content: string): string | undefined {
  let unifiedPath: string | undefined;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    // Each line is `hierarchy-id:controllers:path`; the path may contain `:`.
    const firstSeparator = line.indexOf(":");
    if (firstSeparator < 0) return undefined;
    const secondSeparator = line.indexOf(":", firstSeparator + 1);
    if (secondSeparator < 0) return undefined;
    const hierarchyId = line.slice(0, firstSeparator);
    const controllers = line.slice(firstSeparator + 1, secondSeparator);
    const path = line.slice(secondSeparator + 1);
    if (hierarchyId !== "0" || controllers !== "") return undefined;
    if (!path.startsWith("/")) return undefined;
    if (unifiedPath !== undefined) return undefined;
    unifiedPath = path;
  }
  return unifiedPath;
}

/** Reads `/proc/sys/kernel/random/boot_id` contents as a lower-case UUID. */
export function parseBootId(content: string): string | undefined {
  const value = content.trim().toLowerCase();
  return isLinuxBootId(value) ? value : undefined;
}

/**
 * Converts the systemd `InvocationID` byte array to its 32-character
 * lower-case hexadecimal form. An all-zero identifier means the unit has no
 * current invocation and is rejected.
 */
export function parseInvocationId(value: unknown): string | undefined {
  let bytes: Uint8Array;
  if (typeof value === "string") {
    // `busctl` may render a byte array as base64 depending on its version.
    try {
      bytes = Buffer.from(value, "base64");
    } catch {
      return undefined;
    }
  } else if (Array.isArray(value)) {
    if (!value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) {
      return undefined;
    }
    bytes = Uint8Array.from(value as number[]);
  } else {
    return undefined;
  }
  if (bytes.length !== 16) return undefined;
  if (bytes.every((byte) => byte === 0)) return undefined;
  const hex = Buffer.from(bytes).toString("hex");
  return isServiceInvocationId(hex) ? hex : undefined;
}

/** Reads the whitespace-separated controller names of a `cgroup.controllers` file. */
export function parseCgroupControllers(content: string): readonly string[] {
  return content.trim().split(/\s+/).filter((name) => name.length > 0);
}

/**
 * Reads the value of `loginctl show-user --property=Linger --value`.
 * An unrecognised value yields `undefined` so it fails closed as unknown
 * rather than as disabled.
 */
export function parseLingerProperty(output: string): boolean | undefined {
  const value = output.trim().toLowerCase();
  if (value === "yes" || value === "true" || value === "1") return true;
  if (value === "no" || value === "false" || value === "0") return false;
  return undefined;
}

// ---------------------------------------------------------------------------
// Verification. Pure, total, and platform independent.
// ---------------------------------------------------------------------------

/**
 * Applies every rule of the "Stable Core service lifecycle" section to one
 * observation. All failures are reported together so an operator sees the
 * complete reason the Core service was rejected.
 */
export function verifyCoreServiceBinding(
  observation: CoreServiceObservation,
): CoreServiceBindingResult {
  const failures: CoreServiceBindingFailure[] = [];
  const add = (code: CoreServiceBindingFailureCode, detail: string): void => {
    failures.push({ code, detail });
  };
  const unit = observation.unit;

  // --- Direction 1: the manager reports this process as the unit's main one.
  if (unit.mainPid !== observation.selfPid) {
    add(
      "CORE_SERVICE_MAIN_PID_MISMATCH",
      `service manager reports main process ${unit.mainPid} for unit "${observation.unitName}" but this process is ${observation.selfPid}`,
    );
  }

  // --- Direction 2: this process's cgroup is the unit's delegated subgroup.
  const controlGroup = normalizeCgroupPath(unit.controlGroup);
  if (controlGroup === undefined) {
    add(
      "CORE_SERVICE_CONTROL_GROUP_UNAVAILABLE",
      `service manager reported no usable control group for unit "${observation.unitName}"`,
    );
  }
  if (observation.selfCgroupPath === undefined) {
    add(
      "CORE_SERVICE_PROCESS_CGROUP_UNAVAILABLE",
      "this process has no readable control-group version 2 path in /proc/self/cgroup",
    );
  }
  const selfCgroupPath =
    observation.selfCgroupPath === undefined
      ? undefined
      : normalizeCgroupPath(observation.selfCgroupPath);
  let expectedCoreCgroup: string | undefined;
  if (controlGroup !== undefined && selfCgroupPath !== undefined) {
    // The manager reports the service root; the main process lives one level
    // down in the delegated subgroup, so the comparison joins the two.
    expectedCoreCgroup =
      unit.delegateSubgroup === ""
        ? controlGroup
        : `${controlGroup}/${unit.delegateSubgroup}`;
    if (selfCgroupPath !== expectedCoreCgroup) {
      add(
        "CORE_SERVICE_CGROUP_MISMATCH",
        `this process runs in control group "${selfCgroupPath}" but unit "${observation.unitName}" delegates "${expectedCoreCgroup}"`,
      );
    }
  }

  // --- Identifiers a Module process record persists.
  const invocationId = unit.invocationId.toLowerCase();
  if (!isServiceInvocationId(invocationId)) {
    add(
      "CORE_SERVICE_INVOCATION_ID_UNAVAILABLE",
      `service manager reported no usable invocation identifier for unit "${observation.unitName}"`,
    );
  }
  if (observation.bootId === undefined) {
    add(
      "CORE_SERVICE_BOOT_ID_UNAVAILABLE",
      "the Linux boot identifier at /proc/sys/kernel/random/boot_id could not be read",
    );
  }

  // --- Effective unit settings.
  if (unit.type !== "exec") {
    add("CORE_SERVICE_TYPE_INVALID", `Type is "${unit.type}" but must be "exec"`);
  }
  if (unit.restart !== "on-failure") {
    add(
      "CORE_SERVICE_RESTART_POLICY_INVALID",
      `Restart is "${unit.restart}" but must be "on-failure"`,
    );
  }
  // systemd disables its restart rate limit when either the burst or the
  // interval is zero, which would let Core restart without bound.
  if (
    !Number.isFinite(unit.startLimitBurst) ||
    !Number.isInteger(unit.startLimitBurst) ||
    unit.startLimitBurst < 1 ||
    !Number.isFinite(unit.startLimitIntervalUSec) ||
    unit.startLimitIntervalUSec <= 0
  ) {
    add(
      "CORE_SERVICE_RESTART_LIMIT_INVALID",
      `restart limit is not finite: StartLimitBurst=${unit.startLimitBurst}, StartLimitIntervalUSec=${describeDuration(unit.startLimitIntervalUSec)}`,
    );
  }
  if (unit.killMode !== "control-group") {
    add(
      "CORE_SERVICE_KILL_MODE_INVALID",
      `KillMode is "${unit.killMode}" but must be "control-group"`,
    );
  }
  if (!unit.sendSigkill) {
    add(
      "CORE_SERVICE_SIGKILL_DISABLED",
      "SendSIGKILL is disabled, so a stuck Core service could never be forced to stop",
    );
  }
  if (!Number.isFinite(unit.timeoutStopUSec) || unit.timeoutStopUSec <= 0) {
    add(
      "CORE_SERVICE_STOP_TIMEOUT_INVALID",
      `TimeoutStopUSec is ${describeDuration(unit.timeoutStopUSec)} but must be finite and positive`,
    );
  }
  if (!unit.delegate) {
    add(
      "CORE_SERVICE_DELEGATION_DISABLED",
      "Delegate is not enabled, so Core cannot own control groups below its service root",
    );
  }
  if (unit.delegateSubgroup !== REQUIRED_DELEGATE_SUBGROUP) {
    add(
      "CORE_SERVICE_DELEGATE_SUBGROUP_INVALID",
      `DelegateSubgroup is "${unit.delegateSubgroup}" but must be "${REQUIRED_DELEGATE_SUBGROUP}" so the delegated root holds no processes`,
    );
  }
  if (!observation.cgroupFilesystemIsV2) {
    add(
      "CORE_SERVICE_CGROUP_V2_UNAVAILABLE",
      "the control-group mount is not control-group version 2",
    );
  }
  if (observation.delegatedRootControllers === undefined) {
    add(
      "CORE_SERVICE_CONTROLLER_UNAVAILABLE",
      "the delegated service root's cgroup.controllers could not be read",
    );
  } else {
    const missing = REQUIRED_CGROUP_CONTROLLERS.filter(
      (controller) => !observation.delegatedRootControllers!.includes(controller),
    );
    if (missing.length > 0) {
      add(
        "CORE_SERVICE_CONTROLLER_UNAVAILABLE",
        `the delegated service root is missing the required controller${missing.length === 1 ? "" : "s"} ${missing.join(", ")}`,
      );
    }
  }
  if (unit.exitType !== "main") {
    add(
      "CORE_SERVICE_EXIT_TYPE_INVALID",
      `ExitType is "${unit.exitType}" but must be "main"; "cgroup" would keep the service active after the Core process exits`,
    );
  }
  if (unit.restartMode !== "normal") {
    add(
      "CORE_SERVICE_RESTART_MODE_INVALID",
      `RestartMode is "${unit.restartMode}" but must be "normal"; "direct" would skip the inactive state that removes the old service control group`,
    );
  }

  // --- Settings that weaken the required semantics.
  if (unit.remainAfterExit) {
    add(
      "CORE_SERVICE_REMAIN_AFTER_EXIT_ENABLED",
      "RemainAfterExit is enabled, so a dead Core process would still be reported as an active service",
    );
  }
  if (!isExitStatusSetEmpty(unit.successExitStatus)) {
    add(
      "CORE_SERVICE_SUCCESS_EXIT_STATUS_OVERRIDDEN",
      `SuccessExitStatus is set (${describeExitStatusSet(unit.successExitStatus)}), which can treat a forced Core exit as success and suppress the required restart`,
    );
  }
  if (!isExitStatusSetEmpty(unit.restartPreventExitStatus)) {
    add(
      "CORE_SERVICE_RESTART_PREVENT_EXIT_STATUS_OVERRIDDEN",
      `RestartPreventExitStatus is set (${describeExitStatusSet(unit.restartPreventExitStatus)}), which can prevent the required Core restart`,
    );
  }
  if (unit.passEnvironment.length > 0 || unit.environmentFiles.length > 0) {
    add(
      "CORE_SERVICE_ENVIRONMENT_NOT_MINIMAL",
      `the service imports environment it does not declare explicitly: PassEnvironment=[${unit.passEnvironment.join(", ")}], EnvironmentFile=[${unit.environmentFiles.join(", ")}]`,
    );
  }

  // --- The command the manager executes.
  for (const failure of checkExecStart(unit.execStart)) {
    add(failure.code, failure.detail);
  }

  // --- Service-manager lifetime.
  if (observation.mode === "user") {
    if (observation.lingerEnabled === undefined) {
      add(
        "CORE_SERVICE_USER_LINGERING_UNKNOWN",
        "user lingering could not be determined, so the user service manager's lifetime after the last login session is unproven",
      );
    } else if (!observation.lingerEnabled) {
      add(
        "CORE_SERVICE_USER_LINGERING_DISABLED",
        "user lingering is disabled, so the user service manager stops when the last login session ends; enable lingering or install a system service with a dedicated service account",
      );
    }
  } else if (unit.user === "" || unit.user === "root" || unit.user === "0") {
    add(
      "CORE_SERVICE_ACCOUNT_INVALID",
      `a system Core service requires a dedicated non-root service account but User is "${unit.user}"`,
    );
  }

  if (failures.length > 0) {
    return { verified: false, failures };
  }
  return {
    verified: true,
    binding: {
      mode: observation.mode,
      unitName: observation.unitName,
      serviceInvocationId: invocationId,
      bootId: observation.bootId!,
      mainPid: unit.mainPid,
      delegatedRootCgroupPath: controlGroup!,
      coreCgroupPath: expectedCoreCgroup!,
      delegatedRootControllers: [...observation.delegatedRootControllers!],
    },
  };
}

/**
 * Text that systemd or a shell would interpret rather than pass through: the
 * variable marker `$`, the unit specifier marker `%`, quotes, and the
 * separators and operators a shell would act on. ADR 0009 requires the Core
 * command to be absolute installed paths with no such text.
 */
const INTERPRETED_TEXT_PATTERN = /[$%'"`\\;&|<>(){}[\]*?~!#\s]/;

function describeInterpretedText(value: string): string {
  const match = INTERPRETED_TEXT_PATTERN.exec(value);
  if (!match) return "";
  return /\s/.test(match[0]) ? "whitespace" : `the character ${JSON.stringify(match[0])}`;
}

/**
 * Applies the `ExecStart` rules of the "Stable Core service lifecycle"
 * section: exactly one command, started with the systemd `:` prefix so no
 * environment variable is expanded, and addressed only by an absolute
 * installed path that carries no text systemd or a shell would interpret.
 */
export function checkExecStart(
  execStart: readonly CoreServiceExecCommand[],
): readonly CoreServiceBindingFailure[] {
  const failures: CoreServiceBindingFailure[] = [];
  if (execStart.length !== 1) {
    failures.push({
      code: "CORE_SERVICE_EXEC_START_PATH_INVALID",
      detail:
        execStart.length === 0
          ? "the service manager reports no ExecStart command for the Core service"
          : `ExecStart has ${execStart.length} commands but a Type=exec Core service must have exactly one`,
    });
    return failures;
  }
  const command = execStart[0]!;
  if (!command.flags.includes(NO_ENVIRONMENT_EXPANSION_FLAG)) {
    failures.push({
      code: "CORE_SERVICE_EXEC_START_ENVIRONMENT_EXPANDED",
      detail: `ExecStart does not use the systemd ":" prefix (${NO_ENVIRONMENT_EXPANSION_FLAG}), so the service manager expands environment variables in the executable path and its arguments`,
    });
  }
  if (typeof command.path !== "string" || command.path.length === 0) {
    failures.push({
      code: "CORE_SERVICE_EXEC_START_PATH_INVALID",
      detail: "the ExecStart executable path is empty",
    });
    return failures;
  }
  if (!isAbsoluteInstalledPath(command.path)) {
    failures.push({
      code: "CORE_SERVICE_EXEC_START_PATH_INVALID",
      detail: `the ExecStart executable path ${JSON.stringify(command.path)} is not an absolute installed path without "." or ".." segments`,
    });
  } else {
    const interpreted = describeInterpretedText(command.path);
    if (interpreted !== "") {
      failures.push({
        code: "CORE_SERVICE_EXEC_START_PATH_INVALID",
        detail: `the ExecStart executable path ${JSON.stringify(command.path)} contains ${interpreted}, which systemd or a shell would interpret rather than treat as part of an installed path`,
      });
    }
  }
  for (const argument of command.argumentVector) {
    if (typeof argument !== "string" || !/[$%]/.test(argument)) continue;
    failures.push({
      code: "CORE_SERVICE_EXEC_START_ENVIRONMENT_EXPANDED",
      detail: `the ExecStart argument ${JSON.stringify(argument)} contains variable-like text; the Core command carries only literal installed paths and options`,
    });
  }
  return failures;
}

function isAbsoluteInstalledPath(value: string): boolean {
  if (!value.startsWith("/") || value.includes("\0")) return false;
  if (value.length > 1 && value.endsWith("/")) return false;
  for (const segment of value.slice(1).split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") return false;
  }
  return true;
}

function normalizeCgroupPath(value: string): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("/")) return undefined;
  if (value.includes("\0")) return undefined;
  // systemd never reports a trailing separator, but a redundant one must not
  // turn a real mismatch into a match.
  const trimmed = value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
  return trimmed;
}

function isExitStatusSetEmpty(value: ExitStatusSet): boolean {
  return value.exitCodes.length === 0 && value.signals.length === 0;
}

function describeExitStatusSet(value: ExitStatusSet): string {
  return `exit codes [${value.exitCodes.join(", ")}], signals [${value.signals.join(", ")}]`;
}

function describeDuration(microseconds: number): string {
  return Number.isFinite(microseconds) ? String(microseconds) : "infinity";
}

// ---------------------------------------------------------------------------
// Linux observation. Every wait is bounded and every failure is structured.
// ---------------------------------------------------------------------------

class ObservationFailure extends Error {
  constructor(
    readonly code: CoreServiceBindingFailureCode,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "ObservationFailure";
  }
}

class Deadline {
  readonly #expiresAt: number;
  readonly #perQueryMs: number;

  constructor(overallMs: number, perQueryMs: number) {
    this.#expiresAt = Date.now() + overallMs;
    this.#perQueryMs = perQueryMs;
  }

  /** Milliseconds the next query may take, or a failure once the bound is spent. */
  next(what: string): number {
    const remaining = this.#expiresAt - Date.now();
    if (remaining <= 0) {
      throw new ObservationFailure(
        "CORE_SERVICE_QUERY_TIMEOUT",
        `the bounded Core service inspection expired before ${what}`,
      );
    }
    return Math.min(this.#perQueryMs, remaining);
  }
}

interface BusctlValue {
  readonly type: string;
  readonly data: unknown;
}

/**
 * Gathers the complete Core service observation on Linux. `busctl` and
 * `loginctl` are run with argument arrays, never through a shell, so no
 * observed value can be interpreted as a command.
 */
export async function collectCoreServiceObservation(
  options: CoreServiceInspectionOptions,
): Promise<CoreServiceObservationResult> {
  if (process.platform !== "linux") {
    return {
      observed: false,
      failures: [
        {
          code: "CORE_SERVICE_PLATFORM_UNSUPPORTED",
          detail: `Core service binding verification requires Linux but this process runs on ${process.platform}`,
        },
      ],
    };
  }

  const busctl = options.busctlPath ?? "busctl";
  const loginctl = options.loginctlPath ?? "loginctl";
  const cgroupRoot = options.cgroupRoot ?? DEFAULT_CGROUP_ROOT;
  const busScope = options.mode === "user" ? "--user" : "--system";
  const deadline = new Deadline(
    options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS,
    options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
  );

  try {
    const objectPath = await resolveUnitObjectPath(
      busctl,
      busScope,
      options.unitName,
      deadline,
    );
    const serviceProperties = await readAllProperties(
      busctl,
      busScope,
      objectPath,
      SYSTEMD_SERVICE_INTERFACE,
      deadline,
    );
    const unitProperties = await readAllProperties(
      busctl,
      busScope,
      objectPath,
      SYSTEMD_UNIT_INTERFACE,
      deadline,
    );

    const unit: CoreServiceUnitProperties = {
      invocationId:
        parseInvocationId(requireProperty(unitProperties, "InvocationID").data) ?? "",
      startLimitBurst: readUnsigned(unitProperties, "StartLimitBurst"),
      startLimitIntervalUSec: readDuration(unitProperties, "StartLimitIntervalUSec"),
      mainPid: readUnsigned(serviceProperties, "MainPID"),
      controlGroup: readText(serviceProperties, "ControlGroup"),
      type: readText(serviceProperties, "Type"),
      restart: readText(serviceProperties, "Restart"),
      killMode: readText(serviceProperties, "KillMode"),
      sendSigkill: readBoolean(serviceProperties, "SendSIGKILL"),
      timeoutStopUSec: readDuration(serviceProperties, "TimeoutStopUSec"),
      delegate: readBoolean(serviceProperties, "Delegate"),
      delegateSubgroup: readText(serviceProperties, "DelegateSubgroup"),
      exitType: readText(serviceProperties, "ExitType"),
      restartMode: readText(serviceProperties, "RestartMode"),
      remainAfterExit: readBoolean(serviceProperties, "RemainAfterExit"),
      successExitStatus: readExitStatusSet(serviceProperties, "SuccessExitStatus"),
      restartPreventExitStatus: readExitStatusSet(
        serviceProperties,
        "RestartPreventExitStatus",
      ),
      passEnvironment: readTextArray(serviceProperties, "PassEnvironment"),
      environmentFiles: readEnvironmentFiles(serviceProperties, "EnvironmentFiles"),
      execStart: readExecCommands(serviceProperties, "ExecStartEx"),
      user: readText(serviceProperties, "User"),
    };

    const selfCgroupPath = await readOptionalFile(
      "/proc/self/cgroup",
      deadline,
      parseProcessCgroupPath,
    );
    const bootId = await readOptionalFile(
      "/proc/sys/kernel/random/boot_id",
      deadline,
      parseBootId,
    );
    const cgroupFilesystemIsV2 = await checkCgroupVersion2(cgroupRoot, deadline);
    const normalizedControlGroup = normalizeCgroupPath(unit.controlGroup);
    const delegatedRootControllers =
      normalizedControlGroup === undefined
        ? undefined
        : await readOptionalFile(
            `${cgroupRoot}${normalizedControlGroup}/cgroup.controllers`,
            deadline,
            parseCgroupControllers,
          );
    const lingerEnabled =
      options.mode === "user"
        ? await readLingerProperty(loginctl, deadline)
        : undefined;

    return {
      observed: true,
      observation: {
        mode: options.mode,
        unitName: options.unitName,
        selfPid: process.pid,
        selfCgroupPath,
        bootId,
        unit,
        delegatedRootControllers,
        cgroupFilesystemIsV2,
        lingerEnabled,
      },
    };
  } catch (error) {
    if (error instanceof ObservationFailure) {
      return { observed: false, failures: [{ code: error.code, detail: error.detail }] };
    }
    return {
      observed: false,
      failures: [
        {
          code: "CORE_SERVICE_MANAGER_UNAVAILABLE",
          detail: `the Core service could not be inspected: ${describeError(error)}`,
        },
      ],
    };
  }
}

/**
 * Collects the observation and verifies it. This is the single entry point a
 * caller uses before it may accept Module work; it never throws.
 */
export async function inspectCoreServiceBinding(
  options: CoreServiceInspectionOptions,
): Promise<CoreServiceBindingResult> {
  const observed = await collectCoreServiceObservation(options);
  if (!observed.observed) {
    return { verified: false, failures: observed.failures };
  }
  return verifyCoreServiceBinding(observed.observation);
}

async function resolveUnitObjectPath(
  busctl: string,
  busScope: string,
  unitName: string,
  deadline: Deadline,
): Promise<string> {
  const stdout = await runCommand(
    busctl,
    [
      busScope,
      "--json=short",
      "call",
      SYSTEMD_BUS_NAME,
      SYSTEMD_MANAGER_OBJECT,
      SYSTEMD_MANAGER_INTERFACE,
      "GetUnit",
      "s",
      unitName,
    ],
    deadline,
    `resolving unit "${unitName}"`,
    (stderr) =>
      /NoSuchUnit|not loaded|Unit .* not found/i.test(stderr)
        ? new ObservationFailure(
            "CORE_SERVICE_UNIT_NOT_FOUND",
            `the service manager does not have unit "${unitName}" loaded`,
          )
        : undefined,
  );
  const parsed = parseJson(stdout, `the GetUnit reply for "${unitName}"`);
  const data = (parsed as { data?: unknown }).data;
  const objectPath = Array.isArray(data) ? data[0] : undefined;
  if (typeof objectPath !== "string" || !objectPath.startsWith("/")) {
    throw new ObservationFailure(
      "CORE_SERVICE_UNIT_NOT_FOUND",
      `the service manager returned no object path for unit "${unitName}"`,
    );
  }
  return objectPath;
}

async function readAllProperties(
  busctl: string,
  busScope: string,
  objectPath: string,
  interfaceName: string,
  deadline: Deadline,
): Promise<Map<string, BusctlValue>> {
  const stdout = await runCommand(
    busctl,
    [
      busScope,
      "--json=short",
      "call",
      SYSTEMD_BUS_NAME,
      objectPath,
      DBUS_PROPERTIES_INTERFACE,
      "GetAll",
      "s",
      interfaceName,
    ],
    deadline,
    `reading ${interfaceName} properties`,
    () => undefined,
  );
  const parsed = parseJson(stdout, `the ${interfaceName} property reply`);
  const data = (parsed as { data?: unknown }).data;
  const entries = Array.isArray(data) ? data[0] : undefined;
  if (entries === null || typeof entries !== "object") {
    throw new ObservationFailure(
      "CORE_SERVICE_PROPERTY_UNREADABLE",
      `the service manager returned no ${interfaceName} properties`,
    );
  }
  const properties = new Map<string, BusctlValue>();
  for (const [name, value] of Object.entries(entries as Record<string, unknown>)) {
    if (value !== null && typeof value === "object" && "data" in value) {
      properties.set(name, value as BusctlValue);
    }
  }
  return properties;
}

function requireProperty(
  properties: Map<string, BusctlValue>,
  name: string,
): BusctlValue {
  const value = properties.get(name);
  if (value === undefined) {
    throw new ObservationFailure(
      "CORE_SERVICE_PROPERTY_UNREADABLE",
      `the service manager did not report the "${name}" property`,
    );
  }
  return value;
}

function readText(properties: Map<string, BusctlValue>, name: string): string {
  const value = requireProperty(properties, name).data;
  if (typeof value !== "string") {
    throw new ObservationFailure(
      "CORE_SERVICE_PROPERTY_UNREADABLE",
      `the "${name}" property is not a string`,
    );
  }
  return value;
}

function readBoolean(properties: Map<string, BusctlValue>, name: string): boolean {
  const value = requireProperty(properties, name).data;
  if (typeof value !== "boolean") {
    throw new ObservationFailure(
      "CORE_SERVICE_PROPERTY_UNREADABLE",
      `the "${name}" property is not a boolean`,
    );
  }
  return value;
}

function readUnsigned(properties: Map<string, BusctlValue>, name: string): number {
  const value = requireProperty(properties, name).data;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ObservationFailure(
      "CORE_SERVICE_PROPERTY_UNREADABLE",
      `the "${name}" property is not an unsigned integer`,
    );
  }
  return value;
}

/**
 * Reads a systemd microsecond duration. systemd encodes `infinity` as the
 * largest unsigned 64-bit value, which JSON cannot represent exactly, so any
 * value at or beyond the safe integer range is treated as infinite.
 */
function readDuration(properties: Map<string, BusctlValue>, name: string): number {
  const value = requireProperty(properties, name).data;
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    throw new ObservationFailure(
      "CORE_SERVICE_PROPERTY_UNREADABLE",
      `the "${name}" property is not a duration`,
    );
  }
  return value >= Number.MAX_SAFE_INTEGER ? Number.POSITIVE_INFINITY : value;
}

function readTextArray(
  properties: Map<string, BusctlValue>,
  name: string,
): readonly string[] {
  const value = requireProperty(properties, name).data;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ObservationFailure(
      "CORE_SERVICE_PROPERTY_UNREADABLE",
      `the "${name}" property is not a string array`,
    );
  }
  return value as string[];
}

/** Reads `EnvironmentFiles`, a list of (path, ignore-missing) pairs. */
function readEnvironmentFiles(
  properties: Map<string, BusctlValue>,
  name: string,
): readonly string[] {
  const value = requireProperty(properties, name).data;
  if (!Array.isArray(value)) {
    throw new ObservationFailure(
      "CORE_SERVICE_PROPERTY_UNREADABLE",
      `the "${name}" property is not an array`,
    );
  }
  return value.map((entry) => {
    if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
    throw new ObservationFailure(
      "CORE_SERVICE_PROPERTY_UNREADABLE",
      `the "${name}" property contains an unexpected entry`,
    );
  });
}

/**
 * Reads `ExecStartEx`, whose type is `a(sasasttttuii)`: for each command line
 * the executable path, its argument vector, and its prefix flags, followed by
 * timing and status fields this module does not use. The flags are why this
 * property is read instead of `ExecStart`: only `ExecStartEx` reports the
 * `no-env-expand` flag that the unit-file `:` prefix sets.
 */
function readExecCommands(
  properties: Map<string, BusctlValue>,
  name: string,
): readonly CoreServiceExecCommand[] {
  const value = requireProperty(properties, name).data;
  if (!Array.isArray(value)) {
    throw new ObservationFailure(
      "CORE_SERVICE_PROPERTY_UNREADABLE",
      `the "${name}" property is not an array of command lines`,
    );
  }
  const isStringArray = (entry: unknown): entry is string[] =>
    Array.isArray(entry) && entry.every((item) => typeof item === "string");
  return value.map((entry) => {
    if (
      !Array.isArray(entry) ||
      typeof entry[0] !== "string" ||
      !isStringArray(entry[1]) ||
      !isStringArray(entry[2])
    ) {
      throw new ObservationFailure(
        "CORE_SERVICE_PROPERTY_UNREADABLE",
        `the "${name}" property contains a command line without a path, argument vector, and flag list`,
      );
    }
    return {
      path: entry[0],
      argumentVector: [...entry[1]],
      flags: [...entry[2]],
    };
  });
}

/** Reads `(aiai)`: one list of exit codes and one list of signal numbers. */
function readExitStatusSet(
  properties: Map<string, BusctlValue>,
  name: string,
): ExitStatusSet {
  const value = requireProperty(properties, name).data;
  if (!Array.isArray(value) || value.length !== 2) {
    throw new ObservationFailure(
      "CORE_SERVICE_PROPERTY_UNREADABLE",
      `the "${name}" property is not an exit status set`,
    );
  }
  const toNumbers = (input: unknown): readonly number[] => {
    if (!Array.isArray(input) || input.some((entry) => typeof entry !== "number")) {
      throw new ObservationFailure(
        "CORE_SERVICE_PROPERTY_UNREADABLE",
        `the "${name}" property contains a non-numeric status`,
      );
    }
    return input as number[];
  };
  return { exitCodes: toNumbers(value[0]), signals: toNumbers(value[1]) };
}

async function readOptionalFile<T>(
  path: string,
  deadline: Deadline,
  parse: (content: string) => T | undefined,
): Promise<T | undefined> {
  const timeoutMs = deadline.next(`reading ${path}`);
  try {
    const content = await readFile(path, {
      encoding: "utf8",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return parse(content);
  } catch {
    return undefined;
  }
}

/**
 * Whether the control-group mount really is control-group version 2.
 *
 * `statfs` has no abort signal, and a `statfs` call on an unresponsive mount
 * can block for as long as that mount takes, so the wait is bounded here
 * instead. A mount that does not answer within the bound is reported as a
 * bounded-inspection timeout rather than left to hang; any other failure is
 * simply not proof of version 2 and fails closed as `false`.
 *
 * Exported so the bound itself can be exercised without a Linux host.
 */
export async function inspectCgroupFilesystemVersion2(
  cgroupRoot: string,
  timeoutMs: number,
  readFilesystemStats: (path: string) => Promise<{ readonly type: number }> = statfs,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_resolveExpiry, rejectExpiry) => {
    timer = setTimeout(() => {
      rejectExpiry(
        new ObservationFailure(
          "CORE_SERVICE_QUERY_TIMEOUT",
          `reading the filesystem type of the control-group mount at ${cgroupRoot} exceeded its bounded wait`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    const stats = await Promise.race([readFilesystemStats(cgroupRoot), expiry]);
    return stats.type === CGROUP2_SUPER_MAGIC;
  } catch (error) {
    if (error instanceof ObservationFailure) throw error;
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function checkCgroupVersion2(
  cgroupRoot: string,
  deadline: Deadline,
): Promise<boolean> {
  const timeoutMs = deadline.next(
    `inspecting the control-group mount at ${cgroupRoot}`,
  );
  return inspectCgroupFilesystemVersion2(cgroupRoot, timeoutMs);
}

async function readLingerProperty(
  loginctl: string,
  deadline: Deadline,
): Promise<boolean | undefined> {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) return undefined;
  try {
    const stdout = await runCommand(
      loginctl,
      ["show-user", "--property=Linger", "--value", String(uid)],
      deadline,
      "reading user lingering",
      () => undefined,
    );
    return parseLingerProperty(stdout);
  } catch (error) {
    // Lingering that cannot be determined is reported as unknown, and
    // `verifyCoreServiceBinding` still fails closed on it.
    if (error instanceof ObservationFailure && error.code === "CORE_SERVICE_QUERY_TIMEOUT") {
      throw error;
    }
    return undefined;
  }
}

async function runCommand(
  file: string,
  args: readonly string[],
  deadline: Deadline,
  what: string,
  classifyStderr: (stderr: string) => ObservationFailure | undefined,
): Promise<string> {
  const timeoutMs = deadline.next(what);
  try {
    const { stdout } = await execFileAsync(file, [...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const failure = classifyCommandError(error, file, what, classifyStderr);
    throw failure;
  }
}

function classifyCommandError(
  error: unknown,
  file: string,
  what: string,
  classifyStderr: (stderr: string) => ObservationFailure | undefined,
): ObservationFailure {
  const detail = error as {
    killed?: boolean;
    signal?: string | null;
    code?: string | number;
    stderr?: string;
  };
  if (detail.killed === true || detail.signal === "SIGKILL") {
    return new ObservationFailure(
      "CORE_SERVICE_QUERY_TIMEOUT",
      `${file} exceeded its bounded wait while ${what}`,
    );
  }
  const stderr = typeof detail.stderr === "string" ? detail.stderr : "";
  const classified = classifyStderr(stderr);
  if (classified) return classified;
  if (detail.code === "ENOENT") {
    return new ObservationFailure(
      "CORE_SERVICE_MANAGER_UNAVAILABLE",
      `${file} is not installed, so the systemd service manager cannot be queried`,
    );
  }
  return new ObservationFailure(
    "CORE_SERVICE_MANAGER_UNAVAILABLE",
    `${file} failed while ${what}: ${stderr.trim() || describeError(error)}`,
  );
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ObservationFailure(
      "CORE_SERVICE_PROPERTY_UNREADABLE",
      `${what} was not valid JSON`,
    );
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
