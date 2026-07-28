import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import {
  type ProcessLauncher,
  type ProcessLaunchObserver,
  type ProcessSignal,
  type SupervisedProcess,
  type SupervisorBootstrapMessage,
  type SupervisorSpawnRequest,
} from "../core/process-supervisor.js";

export interface NodeIpcProcessLauncherOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly windowsHide?: boolean;
  readonly onStdout?: (chunk: Buffer) => void;
  readonly onStderr?: (chunk: Buffer) => void;
}

class NodeIpcSupervisedProcess implements SupervisedProcess {
  readonly pid: number;

  constructor(
    private readonly child: ChildProcess,
    readonly processIdentityToken: string,
  ) {
    if (!Number.isSafeInteger(child.pid) || child.pid === undefined || child.pid <= 0) {
      throw new Error("Spawned child has no valid PID");
    }
    this.pid = child.pid;
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
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill(signal);
  }
}

function observeStream(stream: Readable | null, listener: ((chunk: Buffer) => void) | undefined): void {
  if (!stream || !listener) return;
  stream.on("data", (chunk: Buffer | string) => {
    listener(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
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

export class NodeIpcProcessLauncher implements ProcessLauncher {
  constructor(private readonly options: NodeIpcProcessLauncherOptions) {
    if (options.command.length === 0) throw new TypeError("command must not be empty");
    if (options.args.some((argument) => argument.includes("\u0000"))) {
      throw new TypeError("Process arguments must not contain NUL bytes");
    }
  }

  launch(
    request: SupervisorSpawnRequest,
    observer: ProcessLaunchObserver,
  ): Promise<SupervisedProcess> {
    return new Promise<SupervisedProcess>((resolve, reject) => {
      let spawned = false;
      const child = spawn(this.options.command, [...this.options.args], {
        cwd: this.options.cwd,
        env: this.options.env,
        windowsHide: this.options.windowsHide ?? true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });

      observeStream(child.stdout, this.options.onStdout);
      observeStream(child.stderr, this.options.onStderr);

      child.on("message", (message) => observer.ready(message));
      child.once("exit", (code, signal) => {
        observer.exit({
          code,
          signal,
          observedAt: new Date().toISOString(),
        });
      });
      child.on("error", (error) => {
        if (!spawned) reject(error);
        else observer.error(error);
      });

      child.once("spawn", () => {
        spawned = true;
        let supervised: NodeIpcSupervisedProcess;
        try {
          supervised = new NodeIpcSupervisedProcess(child, request.processIdentityToken);
        } catch (error) {
          reject(error);
          return;
        }
        resolve(supervised);
        queueMicrotask(() => {
          if (!child.connected) {
            observer.error(new Error("Inherited child IPC channel closed before bootstrap"));
            child.kill("SIGTERM");
            return;
          }
          child.send(bootstrapFromRequest(request), (error) => {
            if (!error) return;
            observer.error(error);
            child.kill("SIGTERM");
          });
        });
      });
    });
  }
}
