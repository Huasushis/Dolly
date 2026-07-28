import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeIpcProcessLauncher } from "../../../src/adapters/node-ipc-process-launcher.js";
import { NetworkExposurePolicy } from "../../../src/core/network-exposure.js";
import {
  createAuthenticatedReadinessEnvelope,
  ProcessSupervisor,
  ProcessSupervisorError,
  type ChildReadinessEnvelope,
  type ChildReadinessReport,
  type ProcessLaunchObserver,
  type ProcessLauncher,
  type ProcessSignal,
  type ProcessSupervisorOptions,
  type SupervisedProcess,
  type SupervisorBootstrapMessage,
  type SupervisorSpawnRequest,
} from "../../../src/core/process-supervisor.js";

function bootstrap(request: SupervisorSpawnRequest): SupervisorBootstrapMessage {
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

class FakeChild implements SupervisedProcess {
  readonly terminateSignals: ProcessSignal[] = [];
  identityProven = true;

  constructor(
    readonly pid: number,
    readonly request: SupervisorSpawnRequest,
    private readonly observer: ProcessLaunchObserver,
  ) {}

  get processIdentityToken(): string {
    return this.request.processIdentityToken;
  }

  verifyIdentity(expectedIdentityToken: string): Promise<boolean> {
    return Promise.resolve(
      this.identityProven && expectedIdentityToken === this.processIdentityToken,
    );
  }

  terminate(signal: ProcessSignal): void {
    this.terminateSignals.push(signal);
  }

  ready(
    transform?: (envelope: ChildReadinessEnvelope) => unknown,
  ): void {
    const report: ChildReadinessReport = {
      endpoints: [{ kind: "http", address: `http://127.0.0.1:${this.pid}` }],
      durableStateReady: true,
      requiredListenersReady: true,
    };
    const envelope = createAuthenticatedReadinessEnvelope(bootstrap(this.request), report);
    this.observer.ready(transform ? transform(envelope) : envelope);
  }

  readyWithReport(report: ChildReadinessReport): void {
    this.observer.ready(createAuthenticatedReadinessEnvelope(bootstrap(this.request), report));
  }

  exit(code: number | null = 1, signal: string | null = null): void {
    this.observer.exit({
      code,
      signal,
      observedAt: new Date().toISOString(),
    });
  }
}

class FakeLauncher implements ProcessLauncher {
  readonly children: FakeChild[] = [];

  async launch(
    request: SupervisorSpawnRequest,
    observer: ProcessLaunchObserver,
  ): Promise<SupervisedProcess> {
    const child = new FakeChild(20_000 + this.children.length, request, observer);
    this.children.push(child);
    return child;
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error("Condition did not become true after draining microtasks");
}

function createFakeSupervisor(
  launcher: FakeLauncher,
  overrides: Partial<ProcessSupervisorOptions> = {},
): ProcessSupervisor {
  let generation = 0;
  let secret = 0;
  return new ProcessSupervisor({
    instanceId: "instance-a",
    configRevision: `sha256:${"a".repeat(64)}`,
    daemonProtocolVersion: "daemon-v1",
    ipcProtocolVersion: "ipc-v1",
    launcher,
    readinessEndpointPolicy: {
      mode: "network",
      exposure: new NetworkExposurePolicy({ mode: "local", listenPort: 0 }),
    },
    readinessTimeoutMs: 100,
    gracefulStopTimeoutMs: 50,
    hardStopTimeoutMs: 25,
    restartPolicy: {
      rollingWindowMs: 5 * 60_000,
      maxUnexpectedExits: 5,
      stableResetMs: 10 * 60_000,
      baseDelayMs: 10,
      maxDelayMs: 1_000,
      jitterRatio: 0,
    },
    random: () => 0.5,
    nextProcessGenerationId: () => `process-generation-${++generation}`,
    nextSecret: () => Buffer.alloc(32, ++secret).toString("base64url"),
    ...overrides,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OPS-001 generation-aware daemon supervision", () => {
  it("ignores stale readiness and exit callbacks after a replacement generation is running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T08:00:00.000Z"));
    const launcher = new FakeLauncher();
    const supervisor = createFakeSupervisor(launcher);

    const firstStart = supervisor.start("start-first");
    await waitFor(() => launcher.children.length === 1);
    const first = launcher.children[0]!;
    first.exit(1);
    await expect(firstStart).rejects.toMatchObject({ code: "SUPERVISOR_START_FAILED" });
    expect(supervisor.snapshot.state).toBe("backoff");

    await vi.advanceTimersByTimeAsync(10);
    await waitFor(() => launcher.children.length === 2);
    const second = launcher.children[1]!;
    second.ready();
    expect(supervisor.snapshot).toMatchObject({
      state: "running",
      processGenerationId: "process-generation-2",
      pid: second.pid,
    });

    first.ready();
    first.exit(1);
    expect(supervisor.snapshot).toMatchObject({
      state: "running",
      processGenerationId: "process-generation-2",
      pid: second.pid,
    });

    const stopped = supervisor.stop("stop-after-stale-events");
    await waitFor(() => second.terminateSignals.length === 1);
    second.exit(0, "SIGTERM");
    await expect(stopped).resolves.toMatchObject({ state: "stopped" });
  });

  it("rejects a tampered readiness envelope and does not replace it before confirmed exit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T08:00:00.000Z"));
    const launcher = new FakeLauncher();
    const supervisor = createFakeSupervisor(launcher);

    const starting = supervisor.start("start-tampered");
    const rejectedStart = expect(starting).rejects.toMatchObject({
      code: "SUPERVISOR_READINESS_INVALID",
    });
    await waitFor(() => launcher.children.length === 1);
    const child = launcher.children[0]!;
    child.ready((envelope) => ({
      ...envelope,
      endpoints: [{ kind: "http", address: "http://127.0.0.1:65535" }],
    }));

    await rejectedStart;
    await waitFor(() => child.terminateSignals.includes("SIGTERM"));
    expect(supervisor.snapshot.state).toBe("stopping");
    await vi.advanceTimersByTimeAsync(40);
    expect(launcher.children).toHaveLength(1);

    child.exit(null, "SIGTERM");
    expect(supervisor.snapshot.state).toBe("backoff");
    const stopped = supervisor.stop("cancel-tampered-restart");
    await expect(stopped).resolves.toMatchObject({ state: "stopped" });
  });

  it.each([
    {
      name: "a missing network listener",
      policy: {
        mode: "network" as const,
        exposure: new NetworkExposurePolicy({ mode: "local", listenPort: 0 }),
      },
      endpoints: [],
    },
    {
      name: "a listener for a listenerless process",
      policy: { mode: "none" as const },
      endpoints: [{ kind: "http" as const, address: "http://127.0.0.1:20000" }],
    },
    {
      name: "a public listener under a local-only policy",
      policy: {
        mode: "network" as const,
        exposure: new NetworkExposurePolicy({ mode: "local", listenPort: 0 }),
      },
      endpoints: [{ kind: "http" as const, address: "http://0.0.0.0:20000" }],
    },
  ])("rejects authenticated readiness with $name", async ({ policy, endpoints }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T08:00:00.000Z"));
    const launcher = new FakeLauncher();
    const supervisor = createFakeSupervisor(launcher, {
      readinessEndpointPolicy: policy,
    });

    const starting = supervisor.start("start-invalid-endpoint");
    const rejectedStart = expect(starting).rejects.toMatchObject({
      code: "SUPERVISOR_READINESS_INVALID",
    });
    await waitFor(() => launcher.children.length === 1);
    const child = launcher.children[0]!;
    child.readyWithReport({
      endpoints,
      durableStateReady: true,
      requiredListenersReady: true,
    });

    await rejectedStart;
    await waitFor(() => child.terminateSignals.includes("SIGTERM"));
    child.exit(null, "SIGTERM");
    await expect(supervisor.stop("stop-invalid-endpoint")).resolves.toMatchObject({
      state: "stopped",
    });
  });

  it("times out readiness, terminates the same generation, and waits for exit before restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T08:00:00.000Z"));
    const launcher = new FakeLauncher();
    const supervisor = createFakeSupervisor(launcher);

    const starting = supervisor.start("start-timeout");
    const rejectedStart = expect(starting).rejects.toMatchObject({
      code: "SUPERVISOR_READINESS_TIMEOUT",
    });
    await waitFor(() => launcher.children.length === 1);
    const child = launcher.children[0]!;
    await vi.advanceTimersByTimeAsync(100);
    await rejectedStart;
    await waitFor(() => child.terminateSignals.includes("SIGTERM"));
    expect(supervisor.snapshot.state).toBe("stopping");

    await vi.advanceTimersByTimeAsync(40);
    expect(launcher.children).toHaveLength(1);
    child.exit(null, "SIGKILL");
    expect(supervisor.snapshot.state).toBe("backoff");
    await vi.advanceTimersByTimeAsync(10);
    await waitFor(() => launcher.children.length === 2);

    const replacement = launcher.children[1]!;
    replacement.ready();
    expect(supervisor.snapshot.state).toBe("running");
    const stopped = supervisor.stop("stop-timeout-replacement");
    await waitFor(() => replacement.terminateSignals.includes("SIGTERM"));
    replacement.exit(0, "SIGTERM");
    await stopped;
  });

  it("keeps a rolling restart budget across child objects and requires explicit retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T08:00:00.000Z"));
    const launcher = new FakeLauncher();
    const supervisor = createFakeSupervisor(launcher, {
      restartPolicy: {
        rollingWindowMs: 5 * 60_000,
        maxUnexpectedExits: 2,
        stableResetMs: 10 * 60_000,
        baseDelayMs: 10,
        maxDelayMs: 1_000,
        jitterRatio: 0,
      },
    });

    const initial = supervisor.start("start-budget");
    await waitFor(() => launcher.children.length === 1);
    launcher.children[0]!.ready();
    await initial;

    launcher.children[0]!.exit(1);
    expect(supervisor.snapshot).toMatchObject({ state: "backoff", unexpectedExitCount: 1 });
    await vi.advanceTimersByTimeAsync(10);
    await waitFor(() => launcher.children.length === 2);
    launcher.children[1]!.ready();

    launcher.children[1]!.exit(1);
    expect(supervisor.snapshot).toMatchObject({ state: "backoff", unexpectedExitCount: 2 });
    await vi.advanceTimersByTimeAsync(20);
    await waitFor(() => launcher.children.length === 3);
    launcher.children[2]!.ready();

    launcher.children[2]!.exit(1);
    expect(supervisor.snapshot).toMatchObject({
      state: "failed",
      desiredRunning: false,
      unexpectedExitCount: 3,
    });
    await expect(supervisor.start("ordinary-start-after-failure")).rejects.toMatchObject({
      code: "SUPERVISOR_FAILED_RETRY_REQUIRED",
    });

    const retry = supervisor.retry("explicit-retry");
    await waitFor(() => launcher.children.length === 4);
    launcher.children[3]!.ready();
    await expect(retry).resolves.toMatchObject({
      state: "running",
      unexpectedExitCount: 0,
    });
    const stopped = supervisor.stop("stop-after-retry");
    await waitFor(() => launcher.children[3]!.terminateSignals.includes("SIGTERM"));
    launcher.children[3]!.exit(0, "SIGTERM");
    await stopped;
  });

  it("keeps exponential backoff across spawns and resets it only after stable readiness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T08:00:00.000Z"));
    const launcher = new FakeLauncher();
    const supervisor = createFakeSupervisor(launcher, {
      restartPolicy: {
        rollingWindowMs: 100,
        maxUnexpectedExits: 5,
        stableResetMs: 1_000,
        baseDelayMs: 10,
        maxDelayMs: 1_000,
        jitterRatio: 0,
      },
    });

    const initial = supervisor.start("start-streak");
    await waitFor(() => launcher.children.length === 1);
    launcher.children[0]!.ready();
    await initial;
    launcher.children[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(10);
    await waitFor(() => launcher.children.length === 2);
    launcher.children[1]!.ready();

    await vi.advanceTimersByTimeAsync(101);
    expect(supervisor.snapshot).toMatchObject({
      unexpectedExitCount: 0,
      restartStreak: 1,
    });
    const secondExitAt = Date.now();
    launcher.children[1]!.exit(1);
    expect(supervisor.snapshot).toMatchObject({ state: "backoff", restartStreak: 2 });
    expect(Date.parse(supervisor.snapshot.nextRestartAt!) - secondExitAt).toBe(20);

    await vi.advanceTimersByTimeAsync(20);
    await waitFor(() => launcher.children.length === 3);
    launcher.children[2]!.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(supervisor.snapshot).toMatchObject({
      unexpectedExitCount: 0,
      restartStreak: 0,
    });
    const stableExitAt = Date.now();
    launcher.children[2]!.exit(1);
    expect(Date.parse(supervisor.snapshot.nextRestartAt!) - stableExitAt).toBe(10);
    await supervisor.stop("cancel-stable-reset-restart");
  });

  it("never signals a process whose identity cannot be proven", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T08:00:00.000Z"));
    const launcher = new FakeLauncher();
    const supervisor = createFakeSupervisor(launcher);
    const starting = supervisor.start("start-unproven");
    await waitFor(() => launcher.children.length === 1);
    const child = launcher.children[0]!;
    child.ready();
    await starting;
    child.identityProven = false;

    const stopping = supervisor.stop("stop-unproven");
    const rejectedStop = expect(stopping).rejects.toMatchObject({
      code: "SUPERVISOR_PROCESS_IDENTITY_UNPROVEN",
    });
    await rejectedStop;
    expect(child.terminateSignals).toEqual([]);
    expect(supervisor.snapshot).toMatchObject({
      state: "failed",
      desiredRunning: false,
      lastFailure: { code: "SUPERVISOR_PROCESS_IDENTITY_UNPROVEN" },
    });

    await expect(supervisor.retry("retry-unproven")).rejects.toMatchObject({
      code: "SUPERVISOR_PROCESS_EXIT_UNCONFIRMED",
      details: {
        processGenerationId: "process-generation-1",
        state: "failed",
      },
    });
    expect(launcher.children).toHaveLength(1);
    expect(supervisor.snapshot).toMatchObject({
      state: "failed",
      processGenerationId: "process-generation-1",
      pid: child.pid,
      lastFailure: { code: "SUPERVISOR_PROCESS_IDENTITY_UNPROVEN" },
    });
    child.exit(0, null);

    const retryAfterExit = supervisor.retry("retry-after-confirmed-exit");
    await waitFor(() => launcher.children.length === 2);
    const replacement = launcher.children[1]!;
    replacement.ready();
    await expect(retryAfterExit).resolves.toMatchObject({
      state: "running",
      processGenerationId: "process-generation-2",
      pid: replacement.pid,
    });
    const stopped = supervisor.stop("stop-after-confirmed-exit-retry");
    await waitFor(() => replacement.terminateSignals.includes("SIGTERM"));
    replacement.exit(0, "SIGTERM");
    await stopped;
  });

  it("rejects retry when hard termination has not produced a confirmed exit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T08:00:00.000Z"));
    const launcher = new FakeLauncher();
    const supervisor = createFakeSupervisor(launcher);
    const starting = supervisor.start("start-unconfirmed-exit");
    await waitFor(() => launcher.children.length === 1);
    const child = launcher.children[0]!;
    child.ready();
    await starting;

    const stopping = supervisor.stop("stop-unconfirmed-exit");
    const rejectedStop = expect(stopping).rejects.toMatchObject({
      code: "SUPERVISOR_STOP_TIMEOUT",
    });
    await waitFor(() => child.terminateSignals.includes("SIGTERM"));
    await vi.advanceTimersByTimeAsync(50);
    await waitFor(() => child.terminateSignals.includes("SIGKILL"));
    await vi.advanceTimersByTimeAsync(25);
    await rejectedStop;

    await expect(supervisor.retry("retry-unconfirmed-exit")).rejects.toMatchObject({
      code: "SUPERVISOR_PROCESS_EXIT_UNCONFIRMED",
      details: {
        processGenerationId: "process-generation-1",
        state: "failed",
      },
    });
    expect(launcher.children).toHaveLength(1);
    expect(child.terminateSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(supervisor.snapshot).toMatchObject({
      state: "failed",
      processGenerationId: "process-generation-1",
      pid: child.pid,
      lastFailure: { code: "SUPERVISOR_STOP_TIMEOUT" },
    });
    child.exit(0, "SIGKILL");
  });

  it("rejects retry while the current generation is running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T08:00:00.000Z"));
    const launcher = new FakeLauncher();
    const supervisor = createFakeSupervisor(launcher);
    const starting = supervisor.start("start-before-running-retry");
    await waitFor(() => launcher.children.length === 1);
    const child = launcher.children[0]!;
    child.ready();
    await starting;

    await expect(supervisor.retry("retry-while-running")).rejects.toMatchObject({
      code: "SUPERVISOR_PROCESS_EXIT_UNCONFIRMED",
      details: {
        processGenerationId: "process-generation-1",
        state: "running",
      },
    });
    expect(launcher.children).toHaveLength(1);
    expect(supervisor.snapshot).toMatchObject({
      state: "running",
      processGenerationId: "process-generation-1",
      pid: child.pid,
    });

    const stopped = supervisor.stop("stop-after-running-retry");
    await waitFor(() => child.terminateSignals.includes("SIGTERM"));
    child.exit(0, "SIGTERM");
    await expect(stopped).resolves.toMatchObject({ state: "stopped" });
  });

  it("makes stop idempotent by operation ID and refuses operation-ID reuse", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T08:00:00.000Z"));
    const launcher = new FakeLauncher();
    const supervisor = createFakeSupervisor(launcher);

    const starting = supervisor.start("start-idempotence");
    await waitFor(() => launcher.children.length === 1);
    const child = launcher.children[0]!;
    child.ready();
    await starting;

    const firstStop = supervisor.stop("same-stop");
    const repeatedStop = supervisor.stop("same-stop");
    expect(repeatedStop).toBe(firstStop);
    await expect(supervisor.start("same-stop")).rejects.toBeInstanceOf(ProcessSupervisorError);
    await waitFor(() => child.terminateSignals.length === 1);
    child.exit(0, "SIGTERM");
    await expect(firstStop).resolves.toMatchObject({ state: "stopped" });
    expect(child.terminateSignals).toEqual(["SIGTERM"]);
  });

  it(
    "launches a real child on an inherited IPC channel and trusts only authenticated readiness",
    async () => {
      const fixturePath = fileURLToPath(
        new URL("./fixtures/supervisor-child.ts", import.meta.url),
      );
      const stderr: Buffer[] = [];
      const launcher = new NodeIpcProcessLauncher({
        command: process.execPath,
        args: ["--import", "tsx/esm", fixturePath],
        cwd: process.cwd(),
        onStderr: (chunk) => stderr.push(chunk),
      });
      const supervisor = new ProcessSupervisor({
        instanceId: "real-child-instance",
        configRevision: `sha256:${"b".repeat(64)}`,
        daemonProtocolVersion: "daemon-v1",
        ipcProtocolVersion: "ipc-v1",
        launcher,
        readinessEndpointPolicy: {
          mode: "network",
          exposure: new NetworkExposurePolicy({ mode: "local", listenPort: 0 }),
        },
        readinessTimeoutMs: 5_000,
        gracefulStopTimeoutMs: 5_000,
        hardStopTimeoutMs: 2_000,
        restartPolicy: { maxUnexpectedExits: 0 },
      });
      const states: string[] = [];
      supervisor.subscribe((snapshot) => states.push(snapshot.state));

      try {
        const running = await supervisor.start("start-real-child");
        expect(running.state).toBe("running");
        expect(running.pid).toBeGreaterThan(0);
        expect(running.endpoints).toHaveLength(1);
        const endpoint = new URL(running.endpoints[0]!.address);
        expect(endpoint.hostname).toBe("127.0.0.1");
        expect(Number(endpoint.port)).toBeGreaterThan(0);
        expect(states).toEqual(expect.arrayContaining(["starting", "ready", "running"]));

        await expect(supervisor.stop("stop-real-child")).resolves.toMatchObject({
          state: "stopped",
        });
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nchild stderr:\n${Buffer.concat(stderr).toString("utf8")}`,
        );
      }
    },
    15_000,
  );
});
