/**
 * Starts the child launcher and wires its protected control descriptor to a
 * `LinuxModuleLauncherController`.
 *
 * The control descriptor is one private bidirectional channel inherited at
 * descriptor number 3. Node.js creates a Unix socket pair for a `"pipe"` entry
 * at descriptor 3 and above on Linux, which matches the specification's
 * description of the control channel as one Core-created private channel.
 *
 * This adapter is Linux-only at run time. It is written so that the launcher
 * program itself stays replaceable: the caller supplies the absolute
 * interpreter path and script path, and nothing else about the launcher is
 * assumed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";
import { FramedJsonChannel } from "../../core/framed-json-channel.js";
import { LAUNCHER_CONTROL_MAX_FRAME_BYTES } from "./launcher-control-protocol.js";
import {
  LinuxModuleLauncherController,
  type LinuxModuleLauncherControllerOptions,
} from "./linux-module-launcher-controller.js";
import { readModuleCgroupProcessIds } from "./cgroup-procs.js";

export type LauncherProtocolStdio = "pipe" | "ignore" | "inherit" | number;

/**
 * A launch that never produced a usable launcher process. It is distinct from
 * a launcher failure reported over the control protocol, because no Extension
 * code can have run and no control group can have been joined.
 */
export class LinuxModuleLauncherStartError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LinuxModuleLauncherStartError";
  }
}

export interface StartLinuxModuleLauncherOptions {
  /** Absolute path of the interpreter that runs the launcher script. */
  readonly interpreterProgram: string;
  /** Absolute path of the installed launcher script. */
  readonly launcherScriptPath: string;
  /**
   * Descriptors 0, 1, and 2 of the launcher process. Descriptors 0 and 1 carry
   * the Extension protocol transport and survive `exec`; descriptor 2 carries
   * bounded diagnostic standard-error text.
   */
  readonly protocolStdio?: readonly [
    LauncherProtocolStdio,
    LauncherProtocolStdio,
    LauncherProtocolStdio,
  ];
  /** Explicit minimal environment for the launcher process itself. */
  readonly launcherEnvironment?: Readonly<Record<string, string>>;
  /**
   * Read-only regular file containing Host-frozen package bytes. It is mapped
   * to child descriptor 4; the reviewed launcher preserves only that exact
   * regular/read-only shape, and only the confinement command may consume it.
   */
  readonly immutableInputDescriptor?: number;
  /**
   * Extra descriptors inherited above the control descriptor. A real launch
   * passes none; tests use them to prove that the launcher closes every
   * inherited descriptor it must not keep.
   */
  readonly additionalInheritedStdio?: readonly LauncherProtocolStdio[];
  readonly controllerTimeouts?: Pick<
    LinuxModuleLauncherControllerOptions,
    | "configureTimeoutMs"
    | "inCgroupTimeoutMs"
    | "membershipTimeoutMs"
    | "exitObservationTimeoutMs"
  >;
  /** Overrides the kernel membership reader; the default reads `cgroup.procs`. */
  readonly readModuleCgroupProcessIds?: (
    moduleCgroupPath: string,
  ) => Promise<readonly number[]>;
}

export interface StartedLinuxModuleLauncher {
  readonly processId: number;
  readonly child: ChildProcess;
  readonly controller: LinuxModuleLauncherController;
  /** Resolves `true` only when the launcher exit was observed within the timeout. */
  waitForExit(timeoutMs: number): Promise<boolean>;
  /** Exit status and signal once observed. */
  readonly exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  /**
   * The asynchronous launch failure, once observed. A launcher that never
   * started reports its reason here rather than as an uncaught exception.
   */
  readonly launchError: Error | undefined;
  /**
   * Resolves with the launch failure if one is observed within the timeout,
   * or `undefined` when none is. A caller that must fail closed on a missing
   * interpreter awaits this before it trusts the control channel.
   */
  waitForLaunchError(timeoutMs: number): Promise<Error | undefined>;
  /** Sends raw bytes on the control descriptor; used only by protocol tests. */
  writeRawControlBytes(bytes: Buffer): void;
  closeControlChannel(): void;
}

/** Absolute path of the launcher script shipped next to this module. */
export function defaultLauncherScriptPath(): string {
  return fileURLToPath(new URL("./launcher.py", import.meta.url));
}

export function startLinuxModuleLauncher(
  options: StartLinuxModuleLauncherOptions,
): StartedLinuxModuleLauncher {
  if (!isAbsolute(options.interpreterProgram) || !isAbsolute(options.launcherScriptPath)) {
    throw new TypeError("The launcher interpreter and script paths must be absolute");
  }
  const [stdin, stdout, stderr] = options.protocolStdio ?? ["pipe", "pipe", "pipe"];
  if (
    options.immutableInputDescriptor !== undefined &&
    (!Number.isSafeInteger(options.immutableInputDescriptor) ||
      options.immutableInputDescriptor < 0)
  ) {
    throw new TypeError("immutableInputDescriptor must be a non-negative file descriptor");
  }
  const child = spawn(
    options.interpreterProgram,
    // Isolated mode ignores PYTHON* environment variables and the user site
    // directory; -B keeps the installed launcher directory free of cache files.
    ["-I", "-B", options.launcherScriptPath],
    {
      stdio: [
        stdin,
        stdout,
        stderr,
        "pipe",
        options.immutableInputDescriptor ?? "ignore",
        ...(options.additionalInheritedStdio ?? []),
      ],
      env: { ...(options.launcherEnvironment ?? {}) },
      detached: false,
    },
  );

  // A failed launch reports its reason asynchronously. Without this listener,
  // an absent or unusable interpreter makes Node re-throw the emitter's
  // `error` event as an uncaught exception and Core exits, which under
  // `Restart=on-failure` becomes a restart loop that spends the finite restart
  // budget. Architecture Decision Record 0009 requires the missing-interpreter
  // case to fail closed the same way a missing systemd does, so the reason is
  // captured here and surfaced to the caller instead.
  let launchError: Error | undefined;
  const launchErrorListeners = new Set<() => void>();
  child.once("error", (error: Error) => {
    launchError = error;
    for (const listener of launchErrorListeners) listener();
    launchErrorListeners.clear();
  });

  if (child.pid === undefined) {
    throw new LinuxModuleLauncherStartError(
      `The child launcher could not be started with ${options.interpreterProgram}`,
    );
  }

  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const exitListeners = new Set<() => void>();
  child.once("exit", (code, signal) => {
    exit = { code, signal };
    for (const listener of exitListeners) listener();
    exitListeners.clear();
  });

  const waitForExit = (timeoutMs: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (exit) {
        resolve(true);
        return;
      }
      const listener = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        exitListeners.delete(listener);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      exitListeners.add(listener);
    });

  const controlSocket = child.stdio[3] as (Readable & Writable) | null;
  if (!controlSocket) {
    // The launcher is already running but has no channel to receive its
    // `exit` command, so the only way to stop it is to close the descriptors
    // it inherited. It exits on a closed control descriptor by design, and it
    // has not been authorized to execute anything.
    child.stdin?.destroy();
    child.stdout?.destroy();
    throw new LinuxModuleLauncherStartError(
      "The launcher control descriptor was not created",
    );
  }

  let controller!: LinuxModuleLauncherController;
  const channel = new FramedJsonChannel(controlSocket, controlSocket, {
    maxFrameBytes: LAUNCHER_CONTROL_MAX_FRAME_BYTES,
    onMessage: (message) => controller.receiveControlMessage(message),
    onError: () => controller.observeControlChannelClosed(),
    onEnd: () => controller.observeControlChannelClosed(),
  });

  controller = new LinuxModuleLauncherController({
    channel,
    readModuleCgroupProcessIds:
      options.readModuleCgroupProcessIds ?? readModuleCgroupProcessIds,
    waitForLauncherExit: waitForExit,
    ...options.controllerTimeouts,
  });

  const waitForLaunchError = (timeoutMs: number): Promise<Error | undefined> =>
    new Promise<Error | undefined>((resolve) => {
      if (launchError) {
        resolve(launchError);
        return;
      }
      const listener = (): void => {
        clearTimeout(timer);
        resolve(launchError);
      };
      const timer = setTimeout(() => {
        launchErrorListeners.delete(listener);
        resolve(undefined);
      }, timeoutMs);
      timer.unref?.();
      launchErrorListeners.add(listener);
    });

  return {
    processId: child.pid,
    child,
    controller,
    waitForExit,
    waitForLaunchError,
    get exit() {
      return exit;
    },
    get launchError() {
      return launchError;
    },
    writeRawControlBytes: (bytes) => {
      controlSocket.write(bytes);
    },
    closeControlChannel: () => {
      channel.close();
    },
  };
}
