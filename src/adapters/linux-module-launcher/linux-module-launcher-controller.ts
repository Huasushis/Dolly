/**
 * Core side of the launcher control protocol specified by
 * `docs/spec/extension-process-protocol.md` Section 4.1.1 and Architecture
 * Decision Record (ADR) 0009 "Module process control".
 *
 * The controller drives one child launcher through one attempt to start one
 * Module process: it sends `configure`, waits for the launcher's `in-cgroup`
 * event, re-checks the launcher's cgroup membership by reading the kernel
 * `cgroup.procs` file itself, confirms that no stop was requested, and only
 * then sends `execute`.
 *
 * The controller deliberately has no way to send an operating-system signal.
 * ADR 0009 requires that Core never signal a process identifier during the
 * pre-membership phase: it asks the launcher to exit through the protected
 * control descriptor and waits for an observed exit. When that exit cannot be
 * observed within a finite wait, the controller reports the failure with
 * `launcherExitObserved: false` so that the caller applies the ADR 0009
 * pre-membership rule (Core exits unsuccessfully and lets the Core service's
 * systemd cleanup remove the whole service cgroup) rather than attempting a
 * process-identifier-based cleanup.
 *
 * Every phase is bounded by a finite wait.
 */
import type { JsonValue } from "../../core/canonical-json.js";
import {
  asLauncherControlJson,
  createLauncherConfigureCommand,
  createLauncherExecuteCommand,
  createLauncherExitCommand,
  parseLauncherInCgroupEvent,
} from "./launcher-control-protocol.js";

/**
 * The framed JSON channel on the protected control descriptor, reduced to the
 * two operations the controller needs. Inbound frames are delivered to the
 * controller by the owner of the channel through `receiveControlMessage`.
 */
export interface LinuxModuleLauncherControlChannel {
  send(message: JsonValue): Promise<void>;
  close(): void;
}

export interface LinuxModuleLauncherExecutionRequest {
  /** Process identifier of the direct child launcher, from the child handle. */
  readonly launcherProcessId: number;
  /** Core-derived Module cgroup path; never supplied by an Extension. */
  readonly moduleCgroupPath: string;
  readonly maxOpenFiles: number;
  /** Absolute installed runtime executable. */
  readonly program: string;
  readonly argumentVector: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  /** Checked synchronously immediately before the `execute` frame is sent. */
  readonly stopRequested?: () => boolean;
}

export interface LinuxModuleLauncherControllerOptions {
  readonly channel: LinuxModuleLauncherControlChannel;
  /**
   * Reads the process identifiers listed in the Module cgroup's `cgroup.procs`
   * kernel file. Membership is proven from this file, never from the launcher's
   * own report.
   */
  readonly readModuleCgroupProcessIds: (
    moduleCgroupPath: string,
  ) => Promise<readonly number[]>;
  /**
   * Waits for an observed exit of the direct child launcher, resolving `true`
   * only when the exit was actually observed within the timeout.
   */
  readonly waitForLauncherExit: (timeoutMs: number) => Promise<boolean>;
  readonly configureTimeoutMs?: number;
  readonly inCgroupTimeoutMs?: number;
  readonly membershipTimeoutMs?: number;
  readonly exitObservationTimeoutMs?: number;
}

export type LinuxModuleLauncherFailureCode =
  /** The `configure` or `execute` frame could not be written to the control descriptor. */
  | "LAUNCHER_CONTROL_SEND_FAILED"
  /** The control descriptor closed or failed before the launcher was authorized. */
  | "LAUNCHER_CONTROL_CHANNEL_CLOSED"
  /** The launcher sent a malformed, unknown, or out-of-order frame. */
  | "LAUNCHER_CONTROL_PROTOCOL_VIOLATION"
  /** A phase exceeded its finite wait. */
  | "LAUNCHER_CONTROL_TIMEOUT"
  /** The kernel cgroup files did not confirm the launcher's membership. */
  | "LAUNCHER_MEMBERSHIP_UNVERIFIED"
  /** A stop was requested before the launcher was authorized to execute. */
  | "LAUNCHER_STOP_REQUESTED";

export interface LinuxModuleLauncherExecuting {
  readonly outcome: "executing";
  readonly moduleCgroupPath: string;
  /** Process identifiers read back from `cgroup.procs` during verification. */
  readonly verifiedProcessIds: readonly number[];
}

export interface LinuxModuleLauncherFailed {
  readonly outcome: "failed";
  readonly code: LinuxModuleLauncherFailureCode;
  readonly message: string;
  /**
   * Every process identifier read from `cgroup.procs` before the failure.
   * This is empty when the process list could not be read successfully.
   */
  readonly observedProcessIds: readonly number[];
  /** Whether the `execute` send began, so delivery can no longer be disproved. */
  readonly executeCommandMayHaveBeenDelivered: boolean;
  /**
   * Whether kernel cgroup membership was verified before the failure. Once it
   * is `true`, ADR 0009 requires cgroup-level termination and a `populated 0`
   * observation; a child exit is no longer sufficient evidence.
   */
  readonly membershipVerified: boolean;
  /**
   * Whether the launcher's exit was actually observed. In the pre-membership
   * phase a `false` value means the caller could not prove the launcher stopped
   * and must not start a replacement.
   */
  readonly launcherExitObserved: boolean;
}

export type LinuxModuleLauncherOutcome =
  | LinuxModuleLauncherExecuting
  | LinuxModuleLauncherFailed;

type ControllerPhase =
  | "created"
  | "configuring"
  | "awaiting-in-cgroup"
  | "verifying-membership"
  | "authorizing"
  | "settled";

interface PendingWait {
  readonly resolve: () => void;
  readonly reject: (reason: ControllerAbort) => void;
}

interface ControllerAbort {
  readonly code: LinuxModuleLauncherFailureCode;
  readonly message: string;
}

function isControllerAbort(value: unknown): value is ControllerAbort {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ControllerAbort).code === "string" &&
    typeof (value as ControllerAbort).message === "string"
  );
}

function assertTimeout(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 600_000) {
    throw new TypeError(`${label} must be an integer between 1 and 600000`);
  }
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject({ code: "LAUNCHER_CONTROL_TIMEOUT", message } satisfies ControllerAbort),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class LinuxModuleLauncherController {
  readonly #channel: LinuxModuleLauncherControlChannel;
  readonly #readModuleCgroupProcessIds: LinuxModuleLauncherControllerOptions["readModuleCgroupProcessIds"];
  readonly #waitForLauncherExit: LinuxModuleLauncherControllerOptions["waitForLauncherExit"];
  readonly #configureTimeoutMs: number;
  readonly #inCgroupTimeoutMs: number;
  readonly #membershipTimeoutMs: number;
  readonly #exitObservationTimeoutMs: number;

  #phase: ControllerPhase = "created";
  #membershipVerified = false;
  #stopRequested = false;
  #inCgroupReceived = false;
  #pendingInCgroup?: PendingWait;
  #abort?: ControllerAbort;
  #observedProcessIds: readonly number[] = [];
  #verifiedProcessIds: readonly number[] = [];
  #executeCommandMayHaveBeenDelivered = false;

  constructor(options: LinuxModuleLauncherControllerOptions) {
    this.#channel = options.channel;
    this.#readModuleCgroupProcessIds = options.readModuleCgroupProcessIds;
    this.#waitForLauncherExit = options.waitForLauncherExit;
    this.#configureTimeoutMs = options.configureTimeoutMs ?? 5_000;
    this.#inCgroupTimeoutMs = options.inCgroupTimeoutMs ?? 5_000;
    this.#membershipTimeoutMs = options.membershipTimeoutMs ?? 5_000;
    this.#exitObservationTimeoutMs = options.exitObservationTimeoutMs ?? 5_000;
    assertTimeout(this.#configureTimeoutMs, "configureTimeoutMs");
    assertTimeout(this.#inCgroupTimeoutMs, "inCgroupTimeoutMs");
    assertTimeout(this.#membershipTimeoutMs, "membershipTimeoutMs");
    assertTimeout(this.#exitObservationTimeoutMs, "exitObservationTimeoutMs");
  }

  get membershipVerified(): boolean {
    return this.#membershipVerified;
  }

  /**
   * Requests that the launcher stop before it is authorized to execute. The
   * request is honored through the control descriptor; no signal is sent.
   */
  requestStop(): void {
    if (this.#stopRequested) return;
    this.#stopRequested = true;
    this.#failPendingWait({
      code: "LAUNCHER_STOP_REQUESTED",
      message: "A stop was requested before the launcher was authorized to execute",
    });
  }

  /** Delivers one inbound control frame from the launcher. */
  receiveControlMessage(message: JsonValue): void {
    // The launcher can only report in-cgroup after the configure command
    // reached it, so the event is accepted while the local write is still
    // settling as well as while the controller waits for it.
    const awaitingEvent = this.#phase === "configuring" || this.#phase === "awaiting-in-cgroup";
    if (!awaitingEvent || this.#inCgroupReceived) {
      this.#failPendingWait({
        code: "LAUNCHER_CONTROL_PROTOCOL_VIOLATION",
        message: "The launcher sent an out-of-order control frame",
      });
      return;
    }
    try {
      parseLauncherInCgroupEvent(message);
    } catch {
      this.#failPendingWait({
        code: "LAUNCHER_CONTROL_PROTOCOL_VIOLATION",
        message: "The launcher sent a malformed or unknown control frame",
      });
      return;
    }
    this.#inCgroupReceived = true;
    const pending = this.#pendingInCgroup;
    this.#pendingInCgroup = undefined;
    pending?.resolve();
  }

  /** Reports that the control descriptor closed or failed. */
  observeControlChannelClosed(): void {
    this.#failPendingWait({
      code: "LAUNCHER_CONTROL_CHANNEL_CLOSED",
      message: "The launcher control descriptor closed before authorization",
    });
  }

  /**
   * Runs the whole pre-execution sequence once and reports whether the launcher
   * was authorized to execute the Core-validated program.
   */
  async authorizeExecution(
    request: LinuxModuleLauncherExecutionRequest,
  ): Promise<LinuxModuleLauncherOutcome> {
    if (this.#phase !== "created") {
      throw new Error("authorizeExecution may run only once for one launcher");
    }
    if (!Number.isSafeInteger(request.launcherProcessId) || request.launcherProcessId < 1) {
      throw new TypeError("launcherProcessId must be a positive integer");
    }
    const configure = createLauncherConfigureCommand(
      request.moduleCgroupPath,
      request.maxOpenFiles,
    );
    const execute = createLauncherExecuteCommand(
      request.program,
      request.argumentVector,
      request.environment,
    );

    try {
      this.#phase = "configuring";
      this.#throwIfAborted();
      await withTimeout(
        this.#channel.send(asLauncherControlJson(configure)).catch((cause: unknown) => {
          throw {
            code: "LAUNCHER_CONTROL_SEND_FAILED",
            message: `The configure command could not be sent: ${String(cause)}`,
          } satisfies ControllerAbort;
        }),
        this.#configureTimeoutMs,
        "The configure command was not written before its timeout",
      );

      this.#phase = "awaiting-in-cgroup";
      await this.#awaitInCgroup();

      this.#phase = "verifying-membership";
      this.#throwIfAborted();
      await this.#verifyMembership(request);
      this.#membershipVerified = true;

      this.#phase = "authorizing";
      // A control-protocol violation or channel loss observed while membership
      // was being read must still prevent authorization.
      this.#throwIfAborted();
      if (this.#stopRequested || request.stopRequested?.() === true) {
        throw {
          code: "LAUNCHER_STOP_REQUESTED",
          message: "A stop was requested before the launcher was authorized to execute",
        } satisfies ControllerAbort;
      }
      this.#executeCommandMayHaveBeenDelivered = true;
      await withTimeout(
        this.#channel.send(asLauncherControlJson(execute)).catch((cause: unknown) => {
          throw {
            code: "LAUNCHER_CONTROL_SEND_FAILED",
            message: `The execute command could not be sent: ${String(cause)}`,
          } satisfies ControllerAbort;
        }),
        this.#configureTimeoutMs,
        "The execute command was not written before its timeout",
      );
      this.#throwIfAborted();

      this.#phase = "settled";
      return {
        outcome: "executing",
        moduleCgroupPath: request.moduleCgroupPath,
        verifiedProcessIds: this.#verifiedProcessIds,
      };
    } catch (cause) {
      this.#phase = "settled";
      const abort = isControllerAbort(cause)
        ? cause
        : {
            code: "LAUNCHER_CONTROL_PROTOCOL_VIOLATION" as const,
            message: `The launcher sequence failed: ${String(cause)}`,
          };
      return await this.#fail(abort);
    }
  }

  async #awaitInCgroup(): Promise<void> {
    this.#throwIfAborted();
    if (this.#inCgroupReceived) return;
    const wait = new Promise<void>((resolve, reject) => {
      this.#pendingInCgroup = { resolve, reject };
    });
    try {
      await withTimeout(
        wait,
        this.#inCgroupTimeoutMs,
        "The launcher did not report in-cgroup before its timeout",
      );
    } finally {
      this.#pendingInCgroup = undefined;
    }
  }

  async #verifyMembership(request: LinuxModuleLauncherExecutionRequest): Promise<void> {
    let processIds: readonly number[];
    try {
      processIds = await withTimeout(
        this.#readModuleCgroupProcessIds(request.moduleCgroupPath),
        this.#membershipTimeoutMs,
        "The Module cgroup process list could not be read before its timeout",
      );
    } catch (cause) {
      if (isControllerAbort(cause)) throw cause;
      throw {
        code: "LAUNCHER_MEMBERSHIP_UNVERIFIED",
        message: `The Module cgroup process list could not be read: ${String(cause)}`,
      } satisfies ControllerAbort;
    }
    this.#observedProcessIds = [...processIds];
    if (!processIds.includes(request.launcherProcessId)) {
      throw {
        code: "LAUNCHER_MEMBERSHIP_UNVERIFIED",
        message: "The Module cgroup does not contain the launcher process identifier",
      } satisfies ControllerAbort;
    }
    // A prepared Module cgroup is non-reused and holds only this launcher, so
    // any other member is an unexplained process and fails closed.
    if (processIds.some((processId) => processId !== request.launcherProcessId)) {
      throw {
        code: "LAUNCHER_MEMBERSHIP_UNVERIFIED",
        message: "The Module cgroup contains a process other than the launcher",
      } satisfies ControllerAbort;
    }
    this.#verifiedProcessIds = [...processIds];
  }

  async #fail(abort: ControllerAbort): Promise<LinuxModuleLauncherFailed> {
    // Asking the launcher to exit is always done through the control
    // descriptor. A send failure is expected when the channel already closed
    // and must not change the reported reason.
    await withTimeout(
      this.#channel.send(asLauncherControlJson(createLauncherExitCommand())),
      this.#configureTimeoutMs,
      "The exit command was not written before its timeout",
    ).catch(() => undefined);

    if (this.#membershipVerified) {
      // After membership, ADR 0009 requires cgroup-level termination and a
      // `populated 0` observation. A child exit would not be sufficient
      // evidence, so this controller does not wait for one.
      return {
        outcome: "failed",
        code: abort.code,
        message: abort.message,
        observedProcessIds: this.#observedProcessIds,
        executeCommandMayHaveBeenDelivered:
          this.#executeCommandMayHaveBeenDelivered,
        membershipVerified: true,
        launcherExitObserved: false,
      };
    }

    let launcherExitObserved = false;
    try {
      launcherExitObserved = await this.#waitForLauncherExit(this.#exitObservationTimeoutMs);
    } catch {
      launcherExitObserved = false;
    }
    return {
      outcome: "failed",
      code: abort.code,
      message: abort.message,
      observedProcessIds: this.#observedProcessIds,
      executeCommandMayHaveBeenDelivered:
        this.#executeCommandMayHaveBeenDelivered,
      membershipVerified: false,
      launcherExitObserved,
    };
  }

  #failPendingWait(abort: ControllerAbort): void {
    this.#abort ??= abort;
    const pending = this.#pendingInCgroup;
    this.#pendingInCgroup = undefined;
    pending?.reject(abort);
  }

  #throwIfAborted(): void {
    if (this.#abort) throw this.#abort;
  }
}
