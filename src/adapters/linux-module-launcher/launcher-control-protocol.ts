/**
 * Launcher control protocol version 1, specified by
 * `docs/spec/extension-process-protocol.md` Section 4.1.1.
 *
 * The launcher control protocol is the fixed message contract between Core and
 * the child launcher on the protected control descriptor. That descriptor is
 * one Core-created private channel inherited at a fixed descriptor number; it
 * is distinct from the Extension protocol transport on standard input and
 * output. Frames use the same four-byte big-endian length-prefixed UTF-8 JSON
 * framing as the Extension process protocol, with a 4096-byte maximum frame.
 *
 * The protocol is versioned separately from the Extension process protocol
 * because the launcher is a fixed reviewed executable that runs before any
 * Extension code, so its version field is `launcherProtocol` rather than the
 * Extension protocol version.
 *
 * Every value the launcher acts on arrives in these Core-validated frames: the
 * launcher reads no path, limit, program, or environment from environment
 * variables or its command line. This module is therefore the only place where
 * Core checks those values before they cross the control descriptor, and the
 * launcher repeats the same checks on the values it receives.
 */
import { canonicalJsonByteLength, deepFreeze, type JsonValue } from "../../core/canonical-json.js";

export const LAUNCHER_PROTOCOL_VERSION = 1;

/** Maximum control frame size in bytes, from specification Section 4.1.1. */
export const LAUNCHER_CONTROL_MAX_FRAME_BYTES = 4096;

/**
 * Fixed descriptor number of the protected control descriptor in the launcher
 * process. Descriptors 0 and 1 carry the Extension protocol transport and 2
 * carries bounded diagnostic standard-error text, so the control descriptor is
 * the first descriptor after them.
 */
export const LAUNCHER_CONTROL_DESCRIPTOR = 3;

/**
 * Mount point of the cgroup version 2 filesystem. A Module cgroup path is
 * accepted only below this directory so that a wrong or corrupted path cannot
 * make the launcher write its process identifier into an unrelated file.
 */
export const CGROUP_V2_MOUNT_POINT = "/sys/fs/cgroup";

/** Smallest accepted `RLIMIT_NOFILE` value; the launcher itself needs a few descriptors. */
export const MIN_MAX_OPEN_FILES = 16;

/** Largest accepted `RLIMIT_NOFILE` value. */
export const MAX_MAX_OPEN_FILES = 1_048_576;

const MAX_ARGUMENT_COUNT = 256;
const MAX_ENVIRONMENT_ENTRY_COUNT = 128;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Nonzero launcher exit statuses. Each value names the reason the launcher
 * refused to continue, so a Core diagnostic can distinguish them without
 * parsing standard-error text. The launcher never exits zero before `exec`.
 */
export const LAUNCHER_EXIT_STATUS = {
  /** A malformed, oversized, unknown, out-of-order, or duplicate-key frame arrived. */
  frameInvalid: 10,
  /** The control descriptor reached end of file or failed. */
  controlChannelClosed: 11,
  /** The fixed internal deadline expired before `exec`. */
  deadlineExpired: 12,
  /** Core sent the `exit` command. */
  exitCommanded: 13,
  /** Writing the launcher process identifier into the Module cgroup failed. */
  cgroupJoinFailed: 14,
  /** Applying `RLIMIT_NOFILE` or closing inherited descriptors failed. */
  processLimitFailed: 15,
  /** `exec` of the Core-supplied program failed. */
  executeFailed: 16,
  /** The launcher was started with unexpected command-line arguments. */
  invocationInvalid: 17,
} as const;

export type LauncherControlProtocolErrorCode =
  | "LAUNCHER_CONTROL_MESSAGE_INVALID"
  | "LAUNCHER_CONTROL_FRAME_TOO_LARGE";

export class LauncherControlProtocolError extends Error {
  constructor(
    readonly code: LauncherControlProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LauncherControlProtocolError";
  }
}

export interface LauncherConfigureCommand {
  readonly launcherProtocol: typeof LAUNCHER_PROTOCOL_VERSION;
  readonly command: "configure";
  readonly moduleCgroupPath: string;
  readonly maxOpenFiles: number;
}

export interface LauncherExecuteCommand {
  readonly launcherProtocol: typeof LAUNCHER_PROTOCOL_VERSION;
  readonly command: "execute";
  readonly program: string;
  /**
   * The complete argument vector passed to `exec`, including its first element,
   * which becomes the executed program's `argv[0]`.
   */
  readonly argumentVector: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

export interface LauncherExitCommand {
  readonly launcherProtocol: typeof LAUNCHER_PROTOCOL_VERSION;
  readonly command: "exit";
}

export interface LauncherInCgroupEvent {
  readonly launcherProtocol: typeof LAUNCHER_PROTOCOL_VERSION;
  readonly event: "in-cgroup";
}

export type LauncherControlCommand =
  | LauncherConfigureCommand
  | LauncherExecuteCommand
  | LauncherExitCommand;

function invalid(message: string): LauncherControlProtocolError {
  return new LauncherControlProtocolError("LAUNCHER_CONTROL_MESSAGE_INVALID", message);
}

function assertClosedObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid(`${label} must be a plain object`);
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalid(`${label} contains an unknown field`);
    }
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw invalid(`${label} is missing a required field`);
    }
  }
}

function assertProtocolVersion(value: Record<string, unknown>, label: string): void {
  if (value.launcherProtocol !== LAUNCHER_PROTOCOL_VERSION) {
    throw invalid(`${label} does not carry launcher protocol version 1`);
  }
}

function assertNoNul(value: string, label: string): void {
  if (value.includes("\u0000")) {
    throw invalid(`${label} must not contain a NUL byte`);
  }
}

function assertAbsolutePosixPath(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(`${label} must be a non-empty string`);
  }
  assertNoNul(value, label);
  if (!value.startsWith("/")) {
    throw invalid(`${label} must be an absolute POSIX path`);
  }
  if (value.length > 1 && value.endsWith("/")) {
    throw invalid(`${label} must not end with a path separator`);
  }
  for (const segment of value.slice(1).split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw invalid(`${label} must not contain an empty, "." or ".." segment`);
    }
  }
}

/**
 * A Module cgroup path is always constructed by Core from its own instance,
 * Module, and process-generation identities. Requiring a strict descendant of
 * the cgroup version 2 mount point keeps a wrong value from redirecting the
 * launcher's `cgroup.procs` write outside the cgroup filesystem.
 */
export function assertModuleCgroupPath(value: unknown): asserts value is string {
  assertAbsolutePosixPath(value, "moduleCgroupPath");
  if (!value.startsWith(`${CGROUP_V2_MOUNT_POINT}/`)) {
    throw invalid(`moduleCgroupPath must be below ${CGROUP_V2_MOUNT_POINT}`);
  }
}

function assertMaxOpenFiles(value: unknown): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < MIN_MAX_OPEN_FILES ||
    value > MAX_MAX_OPEN_FILES
  ) {
    throw invalid(
      `maxOpenFiles must be an integer between ${MIN_MAX_OPEN_FILES} and ${MAX_MAX_OPEN_FILES}`,
    );
  }
}

function assertArgumentVector(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARGUMENT_COUNT) {
    throw invalid(`argumentVector must be an array of 1 to ${MAX_ARGUMENT_COUNT} strings`);
  }
  for (const argument of value) {
    if (typeof argument !== "string") {
      throw invalid("argumentVector must contain only strings");
    }
    assertNoNul(argument, "argumentVector entry");
  }
}

function assertEnvironment(value: unknown): asserts value is Readonly<Record<string, string>> {
  assertClosedObjectShape(value, "environment");
  const names = Object.keys(value);
  if (names.length > MAX_ENVIRONMENT_ENTRY_COUNT) {
    throw invalid(`environment must contain at most ${MAX_ENVIRONMENT_ENTRY_COUNT} entries`);
  }
  for (const name of names) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
      throw invalid("environment contains an invalid variable name");
    }
    const entry = (value as Record<string, unknown>)[name];
    if (typeof entry !== "string") {
      throw invalid("environment values must be strings");
    }
    assertNoNul(entry, "environment value");
  }
}

function assertClosedObjectShape(value: unknown, label: string): asserts value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid(`${label} must be a plain object`);
  }
}

function assertFrameFits(message: JsonValue, label: string): void {
  const byteLength = canonicalJsonByteLength(message);
  if (byteLength > LAUNCHER_CONTROL_MAX_FRAME_BYTES) {
    throw new LauncherControlProtocolError(
      "LAUNCHER_CONTROL_FRAME_TOO_LARGE",
      `${label} is ${byteLength} bytes and exceeds the ${LAUNCHER_CONTROL_MAX_FRAME_BYTES}-byte control frame limit`,
    );
  }
}

export function createLauncherConfigureCommand(
  moduleCgroupPath: string,
  maxOpenFiles: number,
): LauncherConfigureCommand {
  assertModuleCgroupPath(moduleCgroupPath);
  assertMaxOpenFiles(maxOpenFiles);
  const message: LauncherConfigureCommand = {
    launcherProtocol: LAUNCHER_PROTOCOL_VERSION,
    command: "configure",
    moduleCgroupPath,
    maxOpenFiles,
  };
  assertFrameFits(message as unknown as JsonValue, "configure command");
  return deepFreeze(message);
}

export function parseLauncherConfigureCommand(value: unknown): LauncherConfigureCommand {
  assertClosedObject(
    value,
    ["launcherProtocol", "command", "moduleCgroupPath", "maxOpenFiles"],
    "configure command",
  );
  assertProtocolVersion(value, "configure command");
  if (value.command !== "configure") {
    throw invalid("configure command has an unexpected command field");
  }
  assertModuleCgroupPath(value.moduleCgroupPath);
  assertMaxOpenFiles(value.maxOpenFiles);
  return createLauncherConfigureCommand(value.moduleCgroupPath, value.maxOpenFiles);
}

export function createLauncherExecuteCommand(
  program: string,
  argumentVector: readonly string[],
  environment: Readonly<Record<string, string>>,
): LauncherExecuteCommand {
  assertAbsolutePosixPath(program, "program");
  assertArgumentVector(argumentVector);
  assertEnvironment(environment);
  const message: LauncherExecuteCommand = {
    launcherProtocol: LAUNCHER_PROTOCOL_VERSION,
    command: "execute",
    program,
    argumentVector: [...argumentVector],
    environment: { ...environment },
  };
  assertFrameFits(message as unknown as JsonValue, "execute command");
  return deepFreeze(message);
}

export function parseLauncherExecuteCommand(value: unknown): LauncherExecuteCommand {
  assertClosedObject(
    value,
    ["launcherProtocol", "command", "program", "argumentVector", "environment"],
    "execute command",
  );
  assertProtocolVersion(value, "execute command");
  if (value.command !== "execute") {
    throw invalid("execute command has an unexpected command field");
  }
  assertAbsolutePosixPath(value.program, "program");
  assertArgumentVector(value.argumentVector);
  assertEnvironment(value.environment);
  return createLauncherExecuteCommand(value.program, value.argumentVector, value.environment);
}

export function createLauncherExitCommand(): LauncherExitCommand {
  return deepFreeze({
    launcherProtocol: LAUNCHER_PROTOCOL_VERSION,
    command: "exit",
  } satisfies LauncherExitCommand);
}

export function parseLauncherExitCommand(value: unknown): LauncherExitCommand {
  assertClosedObject(value, ["launcherProtocol", "command"], "exit command");
  assertProtocolVersion(value, "exit command");
  if (value.command !== "exit") {
    throw invalid("exit command has an unexpected command field");
  }
  return createLauncherExitCommand();
}

export function createLauncherInCgroupEvent(): LauncherInCgroupEvent {
  return deepFreeze({
    launcherProtocol: LAUNCHER_PROTOCOL_VERSION,
    event: "in-cgroup",
  } satisfies LauncherInCgroupEvent);
}

export function parseLauncherInCgroupEvent(value: unknown): LauncherInCgroupEvent {
  assertClosedObject(value, ["launcherProtocol", "event"], "in-cgroup event");
  assertProtocolVersion(value, "in-cgroup event");
  if (value.event !== "in-cgroup") {
    throw invalid("in-cgroup event has an unexpected event field");
  }
  return createLauncherInCgroupEvent();
}

/**
 * Parses any Core-to-launcher command. The launcher decides separately whether
 * the parsed command is allowed in its current phase, so an out-of-order but
 * well-formed command still parses here and is rejected by the caller.
 */
export function parseLauncherControlCommand(value: unknown): LauncherControlCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("control command must be an object");
  }
  const command = (value as Record<string, unknown>).command;
  switch (command) {
    case "configure":
      return parseLauncherConfigureCommand(value);
    case "execute":
      return parseLauncherExecuteCommand(value);
    case "exit":
      return parseLauncherExitCommand(value);
    default:
      throw invalid("control command names an unknown command");
  }
}

/** Converts a control message to the JSON value accepted by the framed channel. */
export function asLauncherControlJson(
  message: LauncherControlCommand | LauncherInCgroupEvent,
): JsonValue {
  return message as unknown as JsonValue;
}
