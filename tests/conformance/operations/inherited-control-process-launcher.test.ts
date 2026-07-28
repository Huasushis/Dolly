import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { InheritedControlProcessLauncher } from "../../../src/adapters/inherited-control-process-launcher.js";
import {
  ProcessSupervisor,
  ProcessSupervisorError,
  type ProcessLauncher,
  type ProcessLaunchObserver,
  type ProcessSignal,
  type ProcessSupervisorSnapshot,
  type SupervisedProcess,
  type SupervisorReadinessEndpointPolicy,
  type SupervisorSpawnRequest,
} from "../../../src/core/process-supervisor.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/inherited-control-child.ts", import.meta.url),
);
const inheritedSecretName = "DOLLY_PARENT_SECRET";
const originalInheritedSecret = process.env[inheritedSecretName];

afterEach(() => {
  if (originalInheritedSecret === undefined) delete process.env[inheritedSecretName];
  else process.env[inheritedSecretName] = originalInheritedSecret;
});

async function waitFor(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Condition did not become true before the deadline");
}

function createSupervisor(
  mode: string,
  options: {
    readonly stdout?: Buffer[];
    readonly stderr?: Buffer[];
    readonly environment?: Readonly<Record<string, string>>;
    readonly readinessEndpointPolicy?: SupervisorReadinessEndpointPolicy;
    readonly maxUnexpectedExits?: number;
  } = {},
): ProcessSupervisor {
  const launcher = new InheritedControlProcessLauncher({
    command: process.execPath,
    args: ["--import", "tsx/esm", fixturePath, mode],
    cwd: process.cwd(),
    environment: options.environment,
    authenticationTimeoutMs: 10_000,
    onStdout: (chunk) => options.stdout?.push(chunk),
    onStderr: (chunk) => options.stderr?.push(chunk),
  });
  return new ProcessSupervisor({
    instanceId: "replacement-launcher-instance",
    configRevision: `sha256:${"a".repeat(64)}`,
    daemonProtocolVersion: "daemon-v1",
    ipcProtocolVersion: "ipc-v1",
    launcher,
    readinessEndpointPolicy: options.readinessEndpointPolicy ?? { mode: "none" },
    readinessTimeoutMs: 15_000,
    gracefulStopTimeoutMs: 1_000,
    hardStopTimeoutMs: 500,
    restartPolicy: {
      rollingWindowMs: 60_000,
      maxUnexpectedExits: options.maxUnexpectedExits ?? 0,
      stableResetMs: 60_000,
      baseDelayMs: 10_000,
      maxDelayMs: 10_000,
      jitterRatio: 0,
    },
    random: () => 0.5,
    nextProcessGenerationId: (() => {
      let generation = 0;
      return () => `replacement-generation-${++generation}`;
    })(),
    nextSecret: (kind) => ({
      "process-identity": "I".repeat(43),
      "readiness-challenge": "C".repeat(43),
      "readiness-secret": "S".repeat(43),
    })[kind],
  });
}

async function expectRejectedWithoutRunning(mode: string): Promise<void> {
  const supervisor = createSupervisor(mode);
  await expect(supervisor.start(`start-${mode}`)).rejects.toBeInstanceOf(
    ProcessSupervisorError,
  );
  await waitFor(() => supervisor.snapshot.state !== "stopping");
  expect(supervisor.snapshot.state).not.toBe("running");
  expect(supervisor.snapshot.endpoints).toEqual([]);
}

function waitForExit(child: ChildProcess): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Process exit timed out")), 20_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

class ControlledTerminationLauncher implements ProcessLauncher {
  readonly children: Array<{
    readonly process: SupervisedProcess;
    readonly requestedSignals: ProcessSignal[];
  }> = [];

  constructor(private readonly launcher: ProcessLauncher) {}

  async launch(
    request: SupervisorSpawnRequest,
    observer: ProcessLaunchObserver,
  ): Promise<SupervisedProcess> {
    const process = await this.launcher.launch(request, observer);
    const requestedSignals: ProcessSignal[] = [];
    const childNumber = this.children.length + 1;
    this.children.push({ process, requestedSignals });
    return {
      pid: process.pid,
      processIdentityToken: process.processIdentityToken,
      verifyIdentity: (expectedIdentityToken) =>
        process.verifyIdentity(expectedIdentityToken),
      terminate: (signal) => {
        requestedSignals.push(signal);
        if (childNumber > 1) return process.terminate(signal);
      },
    };
  }

  terminateFirstChild(): Promise<void> | void {
    return this.children[0]?.process.terminate("SIGKILL");
  }
}

describe("authenticated inherited child control channel", () => {
  it("accepts fragmented frames, listenerless readiness, and an explicit child environment", async () => {
    process.env[inheritedSecretName] = "must-not-be-inherited";
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const supervisor = createSupervisor("valid-fragmented", {
      stdout,
      stderr,
      environment: { DOLLY_ALLOWED_VALUE: "visible" },
    });

    const running = await supervisor.start("start-fragmented");
    expect(running).toMatchObject({ state: "running", endpoints: [] });
    await waitFor(() => Buffer.concat(stdout).includes(0x0a));
    const diagnostic = JSON.parse(Buffer.concat(stdout).toString("utf8")) as {
      inheritedSecretPresent: boolean;
      allowedValue: string | null;
    };
    expect(diagnostic).toEqual({
      inheritedSecretPresent: false,
      allowedValue: "visible",
    });
    const publicOutput = Buffer.concat([...stdout, ...stderr]).toString("utf8");
    for (const secret of ["I".repeat(43), "C".repeat(43), "S".repeat(43)]) {
      expect(publicOutput).not.toContain(secret);
    }
    await expect(supervisor.stop("stop-fragmented")).resolves.toMatchObject({
      state: "stopped",
    });
  }, 30_000);

  it.each([
    "duplicate-key",
    "malformed-json",
    "oversized-frame",
    "wrong-auth-mac",
    "wrong-auth-binding",
  ])("rejects %s before trusting the child", async (mode) => {
    await expectRejectedWithoutRunning(mode);
  }, 30_000);

  it("does not replace a child that failed authentication until its exit is observed", async () => {
    const stdout: Buffer[] = [];
    const launcher = new ControlledTerminationLauncher(
      new InheritedControlProcessLauncher({
        command: process.execPath,
        args: ["--import", "tsx/esm", fixturePath, "authentication-failure-then-valid"],
        cwd: process.cwd(),
        authenticationTimeoutMs: 10_000,
        onStdout: (chunk) => stdout.push(chunk),
      }),
    );
    let generation = 0;
    const supervisor = new ProcessSupervisor({
      instanceId: "replacement-launcher-instance",
      configRevision: `sha256:${"a".repeat(64)}`,
      daemonProtocolVersion: "daemon-v1",
      ipcProtocolVersion: "ipc-v1",
      launcher,
      readinessEndpointPolicy: { mode: "none" },
      readinessTimeoutMs: 15_000,
      gracefulStopTimeoutMs: 1_000,
      hardStopTimeoutMs: 500,
      restartPolicy: { maxUnexpectedExits: 0 },
      nextProcessGenerationId: () => `replacement-generation-${++generation}`,
      nextSecret: (kind) => ({
        "process-identity": "I".repeat(43),
        "readiness-challenge": "C".repeat(43),
        "readiness-secret": "S".repeat(43),
      })[kind],
    });

    await expect(supervisor.start("start-authentication-failure")).rejects.toMatchObject({
      code: "SUPERVISOR_CONTROL_CHANNEL_LOST",
      details: { reason: "protocol-error" },
    });
    await waitFor(() => Buffer.concat(stdout).toString("utf8").includes(
      "PROCESS:replacement-generation-1:",
    ));
    const firstPid = supervisor.snapshot.pid;
    expect(firstPid).toBeGreaterThan(0);
    expect(supervisor.snapshot.state).toBe("stopping");
    expect(processIsAlive(firstPid!)).toBe(true);
    expect(launcher.children).toHaveLength(1);
    expect(launcher.children[0]?.requestedSignals).toEqual(["SIGTERM"]);

    await expect(supervisor.retry("retry-before-exit")).rejects.toMatchObject({
      code: "SUPERVISOR_PROCESS_EXIT_UNCONFIRMED",
      details: {
        processGenerationId: "replacement-generation-1",
        state: "stopping",
      },
    });
    expect(supervisor.snapshot.pid).toBe(firstPid);
    expect(launcher.children).toHaveLength(1);
    expect(Buffer.concat(stdout).toString("utf8").match(/^PROCESS:/gmu)).toHaveLength(1);

    await launcher.terminateFirstChild();
    await waitFor(() => supervisor.snapshot.state === "failed");
    expect(processIsAlive(firstPid!)).toBe(false);

    await expect(supervisor.retry("retry-after-exit")).resolves.toMatchObject({
      state: "running",
      processGenerationId: "replacement-generation-2",
    });
    expect(Buffer.concat(stdout).toString("utf8").match(/^PROCESS:/gmu)).toHaveLength(2);
    await expect(supervisor.stop("stop-after-authentication-retry")).resolves.toMatchObject({
      state: "stopped",
    });
  }, 30_000);

  it.each(["stale-generation", "wrong-readiness-mac"])(
    "rejects authenticated readiness with %s",
    async (mode) => {
      await expectRejectedWithoutRunning(mode);
    },
    30_000,
  );

  it("withdraws running state and endpoints as soon as the authenticated channel is lost", async () => {
    const supervisor = createSupervisor("drop-control", { maxUnexpectedExits: 5 });
    const snapshots: ProcessSupervisorSnapshot[] = [];
    supervisor.subscribe((snapshot) => snapshots.push(snapshot));
    await expect(supervisor.start("start-drop-control")).resolves.toMatchObject({
      state: "running",
    });
    await waitFor(() => snapshots.some((snapshot) => snapshot.state === "stopping"));
    const stopping = snapshots.find((snapshot) => snapshot.state === "stopping")!;
    expect(stopping.endpoints).toEqual([]);
    await waitFor(() => supervisor.snapshot.state === "backoff");
    expect(supervisor.snapshot.lastFailure?.code).toBe("SUPERVISOR_CONTROL_CHANNEL_LOST");
    await expect(supervisor.stop("stop-after-control-loss")).resolves.toMatchObject({
      state: "stopped",
    });
  }, 30_000);

  it("forces bounded child exit when its real parent exits and shutdown does not finish", async () => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const parent = spawn(
      process.execPath,
      ["--import", "tsx/esm", fixturePath, "parent-harness"],
      {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    parent.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
    parent.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
    const parentExit = waitForExit(parent);
    let grandchildPid: number | undefined;
    try {
      await waitFor(() => /GRANDCHILD:\d+/u.test(Buffer.concat(stdout).toString("utf8")));
      const match = /GRANDCHILD:(\d+)/u.exec(Buffer.concat(stdout).toString("utf8"));
      grandchildPid = Number(match?.[1]);
      expect(Number.isSafeInteger(grandchildPid)).toBe(true);
      expect(await parentExit).toEqual({ code: 0, signal: null });
      await waitFor(() => !processIsAlive(grandchildPid!), 15_000);
      expect(Buffer.concat(stderr).toString("utf8")).toBe("");
    } finally {
      if (grandchildPid !== undefined && processIsAlive(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
      await parentExit.catch(() => undefined);
    }
  }, 45_000);
});
