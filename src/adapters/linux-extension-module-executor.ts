/**
 * Composes the reviewed Linux launcher, one attached Extension protocol host,
 * and the Linux Module executor without reconstructing any process identity.
 *
 * The public runtime does not call this function. Configured Modules remain
 * rejected by `runtime-bootstrap.ts` until the remaining process, capability,
 * and durable-effect boundaries have independent end-to-end evidence.
 */

import { randomBytes } from "node:crypto";
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
  "additionalInheritedStdio" | "protocolStdio"
>;

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
    Object.hasOwn(supplied, "additionalInheritedStdio")
  ) {
    throw new TypeError(
      "Linux Extension launchers must use the adapter-owned protocol pipes and may not inherit extra descriptors",
    );
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
    const started = startLinuxModuleLauncher({
      ...options.launcher,
      protocolStdio: ["pipe", "pipe", "pipe"],
      additionalInheritedStdio: [],
    });
    startedLauncher = started;
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
      ...(options.host.wallClockNow === undefined
        ? {}
        : { wallClockNow: options.host.wallClockNow }),
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
