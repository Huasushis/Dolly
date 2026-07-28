import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { FramedJsonChannel, type FramedJsonError } from "../core/framed-json-channel.js";
import {
  asControlJson,
  createParentControlBootstrap,
  INHERITED_CONTROL_MAX_FRAME_BYTES,
  parseChildControlAuthenticated,
  parseChildControlHello,
  parseChildControlReadiness,
  type ParentControlBootstrapMessage,
} from "../core/inherited-child-control-protocol.js";
import {
  type ProcessLauncher,
  type ProcessLaunchObserver,
  type ProcessSignal,
  type SupervisedProcess,
  type SupervisorBootstrapMessage,
  type SupervisorChannelLossEvent,
  type SupervisorSpawnRequest,
} from "../core/process-supervisor.js";

export interface InheritedControlProcessLauncherOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly windowsHide?: boolean;
  readonly authenticationTimeoutMs?: number;
  readonly onStdout?: (chunk: Buffer) => void;
  readonly onStderr?: (chunk: Buffer) => void;
}

class SpawnedChildProcess implements SupervisedProcess {
  readonly pid: number;

  constructor(
    private readonly child: ChildProcess,
    readonly processIdentityToken: string,
    private readonly beforeTerminate: () => void,
  ) {
    this.pid = child.pid!;
  }

  async verifyIdentity(expectedIdentityToken: string): Promise<boolean> {
    return (
      expectedIdentityToken === this.processIdentityToken &&
      this.child.pid === this.pid &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    );
  }

  terminate(signal: ProcessSignal): void {
    this.beforeTerminate();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill(signal);
  }
}

function assertTimeout(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new TypeError(`${label} must be an integer between 1 and 60000`);
  }
}

function explicitEnvironment(
  environment: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  const names = new Set<string>();
  for (const [name, value] of Object.entries(environment ?? {})) {
    const comparisonName = process.platform === "win32" ? name.toUpperCase() : name;
    if (
      name.length === 0 ||
      name.includes("=") ||
      name.includes("\u0000") ||
      value.includes("\u0000") ||
      names.has(comparisonName)
    ) {
      throw new TypeError("Explicit child environment contains an invalid entry");
    }
    names.add(comparisonName);
    result[name] = value;
  }
  return result;
}

function observeStream(
  stream: Readable | null,
  listener: ((chunk: Buffer) => void) | undefined,
): void {
  if (!stream) return;
  stream.on("data", (chunk: Buffer | string) => {
    if (listener) listener(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  stream.resume();
}

function bootstrapFromRequest(request: SupervisorSpawnRequest): SupervisorBootstrapMessage {
  return {
    schemaVersion: request.schemaVersion,
    instanceId: request.instanceId,
    processGenerationId: request.processGenerationId,
    processIdentityToken: request.processIdentityToken,
    daemonProtocolVersion: request.daemonProtocolVersion,
    ipcProtocolVersion: request.ipcProtocolVersion,
    configRevision: request.configRevision,
    readinessChallenge: request.readinessChallenge,
    readinessSecret: request.readinessSecret,
  };
}

function lossReason(error: FramedJsonError): SupervisorChannelLossEvent["reason"] {
  return error.code === "FRAME_TRANSPORT_FAILED"
    ? "transport-error"
    : "protocol-error";
}

export class InheritedControlProcessLauncher implements ProcessLauncher {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #authenticationTimeoutMs: number;

  constructor(private readonly options: InheritedControlProcessLauncherOptions) {
    if (!isAbsolute(options.command)) {
      throw new TypeError("command must be an absolute path");
    }
    if (
      options.command.includes("\u0000") ||
      options.args.some((argument) => argument.includes("\u0000"))
    ) {
      throw new TypeError("Process command and arguments must not contain NUL bytes");
    }
    this.#environment = explicitEnvironment(options.environment);
    this.#authenticationTimeoutMs = options.authenticationTimeoutMs ?? 5_000;
    assertTimeout(this.#authenticationTimeoutMs, "authenticationTimeoutMs");
  }

  launch(
    request: SupervisorSpawnRequest,
    observer: ProcessLaunchObserver,
  ): Promise<SupervisedProcess> {
    return new Promise<SupervisedProcess>((resolve, reject) => {
      let spawned = false;
      let settled = false;
      let authenticated = false;
      let readinessReceived = false;
      let closing = false;
      let exited = false;
      let lossReported = false;
      let parentBootstrap: ParentControlBootstrapMessage | undefined;
      let channel: FramedJsonChannel | undefined;
      let authenticationTimer: ReturnType<typeof setTimeout> | undefined;

      const child = spawn(this.options.command, [...this.options.args], {
        cwd: this.options.cwd,
        env: this.#environment,
        windowsHide: this.options.windowsHide ?? true,
        detached: false,
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      });

      observeStream(child.stdout, this.options.onStdout);
      observeStream(child.stderr, this.options.onStderr);

      const reportLoss = (reason: SupervisorChannelLossEvent["reason"]): void => {
        if (exited || closing || lossReported) return;
        lossReported = true;
        if (authenticationTimer) clearTimeout(authenticationTimer);
        observer.channelLost({ reason, observedAt: new Date().toISOString() });
        channel?.close();
      };

      const handleMessage = (message: unknown): void => {
        try {
          if (!parentBootstrap) {
            const hello = parseChildControlHello(message);
            parentBootstrap = createParentControlBootstrap(
              bootstrapFromRequest(request),
              hello.childNonce,
            );
            void channel!.send(asControlJson(parentBootstrap)).catch(() => {
              reportLoss("transport-error");
            });
            return;
          }
          if (!authenticated) {
            parseChildControlAuthenticated(message, parentBootstrap);
            authenticated = true;
            if (authenticationTimer) clearTimeout(authenticationTimer);
            return;
          }
          if (readinessReceived) {
            reportLoss("protocol-error");
            return;
          }
          readinessReceived = true;
          observer.ready(parseChildControlReadiness(message));
        } catch {
          reportLoss("protocol-error");
        }
      };

      child.once("exit", (code, signal) => {
        exited = true;
        if (authenticationTimer) clearTimeout(authenticationTimer);
        channel?.close();
        observer.exit({ code, signal, observedAt: new Date().toISOString() });
      });
      child.on("error", (error) => {
        if (!spawned) {
          if (!settled) {
            settled = true;
            reject(error);
          }
          return;
        }
        observer.error(error);
      });

      child.once("spawn", () => {
        spawned = true;
        settled = true;
        resolve(new SpawnedChildProcess(
          child,
          request.processIdentityToken,
          () => {
            closing = true;
          },
        ));
        const parentWrites = child.stdio[3] as Writable | null;
        const parentReads = child.stdio[4] as Readable | null;
        if (!parentWrites || !parentReads) {
          reportLoss("transport-error");
          return;
        }
        channel = new FramedJsonChannel(parentReads, parentWrites, {
          maxFrameBytes: INHERITED_CONTROL_MAX_FRAME_BYTES,
          onMessage: handleMessage,
          onError: (error) => reportLoss(lossReason(error)),
          onEnd: () => reportLoss("eof"),
        });
        authenticationTimer = setTimeout(
          () => reportLoss("protocol-error"),
          this.#authenticationTimeoutMs,
        );
        authenticationTimer.unref?.();
      });
    });
  }
}
