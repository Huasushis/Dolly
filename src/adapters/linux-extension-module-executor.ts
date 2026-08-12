/**
 * Composes the reviewed Linux launcher, one attached Extension protocol host,
 * and the Linux Module executor without reconstructing any process identity.
 *
 * The public runtime does not call this function. Configured Modules remain
 * rejected by `runtime-bootstrap.ts` until the remaining process, capability,
 * and durable-effect boundaries have independent end-to-end evidence.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ModuleExecutor } from "../core/module-actor.js";
import type { ReactiveModuleInput } from "../core/reactive-module-input.js";
import type { ReactiveModuleResult } from "../core/reactive-module-runtime.js";
import {
  ExtensionProcessHost,
  type AttachedExtensionProcessHostOptions,
} from "../core/extension-process-host.js";
import type { StartModuleProcessOptions } from "../core/linux-module-process-lifecycle.js";
import { createExtensionProcessLinuxProtocolSession } from "./extension-process-module-executor.js";
import {
  createLinuxModuleExecutor,
  type LinuxModuleAuthorizedProcess,
  type LinuxModuleExecutorOptions,
  type LinuxModuleProtocolSession,
} from "./linux-module-executor.js";
import { attachLinuxModuleProcess } from "./linux-module-attached-process.js";
import {
  startLinuxModuleLauncher,
  type StartedLinuxModuleLauncher,
  type StartLinuxModuleLauncherOptions,
} from "./linux-module-launcher/linux-module-launcher-process.js";
import { createModuleLauncherControl } from "./linux-module-launcher/module-launcher-control.js";

type LinuxExtensionHostOptions = Omit<
  AttachedExtensionProcessHostOptions,
  | "attachedProcess"
  | "instanceId"
  | "isolation"
  | "moduleGenerationId"
  | "moduleId"
  | "nextIdentifier"
>;

type LinuxLauncherOptions = Omit<
  StartLinuxModuleLauncherOptions,
  "additionalInheritedStdio" | "immutableInputDescriptor" | "protocolStdio"
>;

export interface LinuxExtensionPackageSnapshotInput {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly stagingDirectory: string;
}

export interface LinuxExtensionModuleExecutorOptions {
  readonly moduleId: string;
  readonly moduleGenerationId: string;
  /**
   * The already-authorized lifecycle inputs. This composition owns launcher
   * creation, so callers cannot substitute a second launcher factory.
   */
  readonly lifecycle: Omit<StartModuleProcessOptions, "startLauncher">;
  /** The reviewed launcher program and its finite control-protocol timeouts. */
  readonly launcher: LinuxLauncherOptions;
  /**
   * Extension protocol configuration without process identity. Instance,
   * Module, and process-generation identifiers come from the durable record.
   */
  readonly host: LinuxExtensionHostOptions;
  /** Registry-captured package bytes; absent only for lower-level non-installed tests. */
  readonly packageSnapshot?: LinuxExtensionPackageSnapshotInput;
  readonly executionTimeoutMs: number;
  readonly cancellationGraceMs: number;
  readonly terminationTimeoutMs: number;
  readonly channelCloseTimeoutMs: number;
  readonly coreExitCleanupTimeoutMs?: number;
  readonly exitCoreProcess?: (status: number) => void;
  /**
   * Generates protocol session and request identifiers. It can never replace
   * the durable process-generation identifier.
   */
  readonly nextProtocolIdentifier?: (purpose: "session" | "request") => string;
  /**
   * Freezes capability grants and other Host-owned setup before the handshake.
   * If it throws, initialization fails but the returned protocol session still
   * owns capability closure and channel observation for safe termination.
   */
  readonly configureHost?: (
    host: ExtensionProcessHost,
    process: LinuxModuleAuthorizedProcess,
  ) => void;
  /** Receives stderr chunks after the adapter has begun draining the pipe. */
  readonly onStandardErrorChunk?: (chunk: Uint8Array) => void;
}

function assertSameConfiguredIdentity(
  options: LinuxExtensionModuleExecutorOptions,
): void {
  const { identity, processRecord } = options.lifecycle;
  if (
    identity.moduleId !== options.moduleId ||
    processRecord.instanceId !== identity.instanceId ||
    processRecord.moduleId !== identity.moduleId ||
    processRecord.moduleGenerationId !== options.moduleGenerationId ||
    processRecord.processGenerationId !== identity.processGenerationId ||
    processRecord.state !== "starting"
  ) {
    throw new TypeError(
      "The Linux Extension executor options do not describe one starting Module process identity",
    );
  }
}

function assertClosedLauncherOptions(options: LinuxLauncherOptions): void {
  const supplied = options as LinuxLauncherOptions & Record<string, unknown>;
  if (
    Object.hasOwn(supplied, "protocolStdio") ||
    Object.hasOwn(supplied, "additionalInheritedStdio") ||
    Object.hasOwn(supplied, "immutableInputDescriptor")
  ) {
    throw new TypeError(
      "Linux Extension launchers must use the adapter-owned protocol pipes and may not inherit extra descriptors",
    );
  }
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function openAnonymousPackageSnapshot(
  snapshot: LinuxExtensionPackageSnapshotInput,
): number {
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(snapshot.digest) ||
    digestBytes(snapshot.bytes) !== snapshot.digest ||
    !isAbsolute(snapshot.stagingDirectory)
  ) {
    throw new TypeError("Installed package snapshot input is invalid");
  }
  const directoryMetadata = lstatSync(snapshot.stagingDirectory);
  const canonicalDirectory = realpathSync.native(snapshot.stagingDirectory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw new TypeError("Installed package snapshot staging directory is unsafe");
  }
  const path = join(
    canonicalDirectory,
    `.dolly-package-snapshot-${randomBytes(24).toString("hex")}.tmp`,
  );
  let writeDescriptor: number | undefined;
  let readDescriptor: number | undefined;
  let pathExists = false;
  try {
    const noFollow = (constants as Readonly<Record<string, number>>).O_NOFOLLOW ?? 0;
    writeDescriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    pathExists = true;
    writeFileSync(writeDescriptor, snapshot.bytes);
    fsyncSync(writeDescriptor);
    closeSync(writeDescriptor);
    writeDescriptor = undefined;
    chmodSync(path, 0o400);
    readDescriptor = openSync(path, constants.O_RDONLY | noFollow);
    const descriptorMetadata = fstatSync(readDescriptor);
    const pathMetadata = lstatSync(path);
    if (
      !descriptorMetadata.isFile() ||
      pathMetadata.isSymbolicLink() ||
      !pathMetadata.isFile() ||
      descriptorMetadata.dev !== pathMetadata.dev ||
      descriptorMetadata.ino !== pathMetadata.ino ||
      descriptorMetadata.size !== snapshot.bytes.byteLength ||
      pathMetadata.size !== snapshot.bytes.byteLength
    ) {
      throw new Error("Installed package snapshot staging file changed identity");
    }
    const digest = createHash("sha256");
    let position = 0;
    while (position < descriptorMetadata.size) {
      const buffer = Buffer.allocUnsafe(
        Math.min(64 * 1024, descriptorMetadata.size - position),
      );
      const bytesRead = readSync(
        readDescriptor,
        buffer,
        0,
        buffer.byteLength,
        position,
      );
      if (bytesRead < 1) throw new Error("Installed package snapshot staging read ended early");
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (`sha256:${digest.digest("hex")}` !== snapshot.digest) {
      throw new Error("Installed package snapshot staging bytes changed");
    }
    unlinkSync(path);
    pathExists = false;
    const result = readDescriptor;
    readDescriptor = undefined;
    return result;
  } finally {
    if (writeDescriptor !== undefined) closeSync(writeDescriptor);
    if (readDescriptor !== undefined) closeSync(readDescriptor);
    if (pathExists) {
      try {
        unlinkSync(path);
      } catch {
        // The exact private path is best-effort cleanup after a fail-closed
        // staging error. The launcher has not been created yet.
      }
    }
  }
}

function generatedProtocolIdentifier(purpose: "session" | "request"): string {
  return `${purpose}-${randomBytes(24).toString("base64url")}`;
}

function sessionWithInitializationFailure(
  session: LinuxModuleProtocolSession,
  failure: unknown,
): LinuxModuleProtocolSession {
  return Object.freeze({
    ...session,
    initialize: async (): Promise<void> => {
      try {
        // The launcher has already been authorized to exec. Opening the Host
        // transport gives the lifecycle a real channel-close observer; the
        // partially configured capability set remains frozen and is revoked
        // during termination. Initialization still cannot report success.
        await session.initialize();
      } catch (initializationFailure) {
        throw new AggregateError(
          [failure, initializationFailure],
          "Extension Host setup and protocol initialization both failed",
        );
      }
      throw failure;
    },
  });
}

/**
 * Builds one product-before-bootstrap Linux Extension executor.
 *
 * Construction starts nothing. `start()` creates exactly one launcher, and
 * the protocol session can be opened only for the exact launcher control
 * object returned by that start. The raw child process is never looked up by
 * process identifier and is never exposed to another lifecycle owner.
 */
export function createLinuxExtensionModuleExecutor(
  options: LinuxExtensionModuleExecutorOptions,
): ModuleExecutor<ReactiveModuleInput, ReactiveModuleResult> {
  assertSameConfiguredIdentity(options);
  assertClosedLauncherOptions(options.launcher);

  let startedLauncher: StartedLinuxModuleLauncher | undefined;
  let launcherControl: Awaited<ReturnType<StartModuleProcessOptions["startLauncher"]>> | undefined;

  const startLauncher = async () => {
    if (startedLauncher !== undefined || launcherControl !== undefined) {
      throw new Error("A Linux Extension executor cannot create more than one launcher");
    }
    let snapshotDescriptor: number | undefined;
    try {
      if (options.packageSnapshot !== undefined) {
        snapshotDescriptor = openAnonymousPackageSnapshot(options.packageSnapshot);
      }
      const started = startLinuxModuleLauncher({
        ...options.launcher,
        protocolStdio: ["pipe", "pipe", "pipe"],
        additionalInheritedStdio: [],
        ...(snapshotDescriptor === undefined
          ? {}
          : { immutableInputDescriptor: snapshotDescriptor }),
      });
      startedLauncher = started;
    } finally {
      if (snapshotDescriptor !== undefined) closeSync(snapshotDescriptor);
    }
    const started = startedLauncher!;
    started.child.stderr?.on("data", (chunk: Buffer) => {
      try {
        options.onStandardErrorChunk?.(new Uint8Array(chunk));
      } catch {
        // Diagnostics cannot stop pipe draining or change process ownership.
      }
    });
    const control = createModuleLauncherControl({ launcher: started });
    launcherControl = control;
    return control;
  };

  const openProtocolSession = (
    process: LinuxModuleAuthorizedProcess,
  ): LinuxModuleProtocolSession => {
    const started = startedLauncher;
    const control = launcherControl;
    if (
      started === undefined ||
      control === undefined ||
      process.launcher !== control ||
      process.launcher.processId !== started.processId
    ) {
      throw new Error(
        "The authorized Linux Module process does not contain this executor's exact launcher",
      );
    }

    const attachedProcess = attachLinuxModuleProcess({
      launcher: started,
      cgroup: process.cgroup,
      terminationTimeoutMs: options.terminationTimeoutMs,
    });
    const nextProtocolIdentifier =
      options.nextProtocolIdentifier ?? generatedProtocolIdentifier;
    const host = new ExtensionProcessHost({
      ...options.host,
      isolation: "process",
      instanceId: process.record.instanceId,
      moduleId: process.record.moduleId,
      moduleGenerationId: process.record.moduleGenerationId,
      attachedProcess,
      nextIdentifier: (purpose) =>
        purpose === "process-generation"
          ? process.record.processGenerationId
          : nextProtocolIdentifier(purpose),
    });
    const session = createExtensionProcessLinuxProtocolSession(host, process, {
      executionTimeoutMs: options.executionTimeoutMs,
      cancellationGraceMs: options.cancellationGraceMs,
    });
    try {
      options.configureHost?.(host, process);
      return session;
    } catch (error) {
      return sessionWithInitializationFailure(session, error);
    }
  };

  const executorOptions: LinuxModuleExecutorOptions = {
    moduleId: options.moduleId,
    moduleGenerationId: options.moduleGenerationId,
    lifecycle: {
      ...options.lifecycle,
      startLauncher,
    },
    openProtocolSession,
    terminationTimeoutMs: options.terminationTimeoutMs,
    channelCloseTimeoutMs: options.channelCloseTimeoutMs,
    ...(options.coreExitCleanupTimeoutMs === undefined
      ? {}
      : { coreExitCleanupTimeoutMs: options.coreExitCleanupTimeoutMs }),
    ...(options.exitCoreProcess === undefined
      ? {}
      : { exitCoreProcess: options.exitCoreProcess }),
  };
  return createLinuxModuleExecutor(executorOptions);
}
