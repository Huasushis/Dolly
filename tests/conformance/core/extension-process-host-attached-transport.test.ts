/**
 * `ExtensionProcessHost` attached to a process Core already started.
 *
 * Architecture Decision Record 0009 keeps `ExtensionProcessHost` in Core and
 * keeps each Module a direct child of Core, but on Linux that child is created
 * by the reviewed launcher in a fixed order: persist the process record,
 * prepare the control group, start the launcher, verify kernel membership, and
 * only then authorize `exec`. The host therefore cannot start the process
 * itself. It must attach to a process Core already started, over that
 * process's existing standard input and output.
 *
 * These tests pin the attached host to the same initialization, orderly-stop,
 * forced-termination, and confirmed-exit behavior as a host that started its
 * own child, and above all to failing closed whenever the attached process's
 * exit cannot be observed. An attached host that reported termination without
 * that evidence would let Core release a Claim or start a replacement Module
 * generation while the old Extension process is still running.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createExtensionProcessLinuxProtocolSession } from "../../../src/adapters/extension-process-module-executor.js";
import type { LinuxModuleAuthorizedProcess } from "../../../src/adapters/linux-module-executor.js";
import type { JsonValue } from "../../../src/core/canonical-json.js";
import {
  ExtensionIsolationPolicy,
  ExtensionProcessHost,
  type AttachedExtensionProcess,
  type AttachedExtensionProcessHostOptions,
} from "../../../src/core/extension-process-host.js";
import type { ExtensionPackageManifest } from "../../../src/core/extension-installation-registry.js";
import { FramedJsonChannel } from "../../../src/core/framed-json-channel.js";
import { ModuleExecutorTerminatedError } from "../../../src/core/module-actor.js";

const PROTOCOL_VERSION = "3.0";
const MAX_FRAME_BYTES = 16 * 1_024;
const FIXTURE = fileURLToPath(
  new URL("../security/fixtures/extension-process-fixture.mjs", import.meta.url),
);

const FIXTURE_PACKAGE_MANIFEST: ExtensionPackageManifest = {
  schemaVersion: "dolly.extension-package/1",
  extensionId: "com.example.fixture",
  packageVersion: "1.0.0",
  displayName: "Process test fixture",
  description: "Exercises the Extension process protocol in conformance tests.",
  supportedProtocolVersions: [PROTOCOL_VERSION],
  entrypoint: "extension-process-fixture.mjs",
  modules: [{
    moduleKind: "fixture",
    activation: "reactive",
    configVersion: 1,
    configurationSchema: { type: "object" },
  }],
  requestedCapabilities: [],
};

/** Host options shared by both construction modes, minus the transport. */
function hostOptions(overrides: Record<string, unknown> = {}) {
  let id = 0;
  let handle = 0;
  return {
    isolation: "process" as const,
    trust: "trusted" as const,
    isolationPolicy: new ExtensionIsolationPolicy(),
    manifest: FIXTURE_PACKAGE_MANIFEST,
    instanceId: "instance-a",
    moduleId: "module-a",
    moduleGenerationId: "module-generation-a",
    moduleKind: "fixture",
    config: {},
    maxFrameBytes: MAX_FRAME_BYTES,
    initializationTimeoutMs: 2_000,
    shutdownRequestTimeoutMs: 300,
    forceKillDelayMs: 100,
    terminationTimeoutMs: 600,
    nextIdentifier: (purpose: string) => `${purpose}-${++id}`,
    nextCapabilityHandle: () => Buffer.alloc(32, ++handle).toString("base64url"),
    ...overrides,
  };
}

function execution(overrides: Record<string, unknown> = {}) {
  return {
    moduleJobId: "module-job-a",
    runId: "run-a",
    attempt: 1,
    deadline: new Date(Date.now() + 1_000).toISOString(),
    responseTimeoutMs: 2_000,
    hasMore: false,
    input: {},
    ...overrides,
  } as const;
}

interface AttachedProcessDouble {
  /** The value handed to the host in place of a command to start. */
  readonly attachment: AttachedExtensionProcess;
  /** Every termination step the host asked for, in order. */
  readonly terminationSteps: ("request" | "force")[];
  /** Reports the attached process's exit to the host. */
  reportExit(): void;
  /** The stream the host writes protocol frames to. */
  readonly hostWrites: PassThrough;
  /** The stream the host reads protocol frames from. */
  readonly hostReads: PassThrough;
}

/**
 * A process the test "already started": two in-memory streams plus explicit
 * control over whether and when its exit becomes observable. Nothing here
 * exits on its own, so a host that assumes an exit it was never shown fails
 * these tests instead of silently reporting a stopped Module.
 */
function createAttachedProcessDouble(processId = 4_242): AttachedProcessDouble {
  const hostWrites = new PassThrough();
  const hostReads = new PassThrough();
  const terminationSteps: ("request" | "force")[] = [];
  const observers = new Set<() => void>();
  let exited = false;
  return {
    attachment: {
      standardInput: hostWrites,
      standardOutput: hostReads,
      processId,
      get exited() {
        return exited;
      },
      onExit: (observer: () => void) => {
        if (exited) observer();
        else observers.add(observer);
      },
      requestTermination: () => {
        terminationSteps.push("request");
      },
      forceTermination: () => {
        terminationSteps.push("force");
      },
    },
    terminationSteps,
    reportExit: () => {
      if (exited) return;
      exited = true;
      for (const observer of observers) observer();
      observers.clear();
    },
    hostWrites,
    hostReads,
  };
}

interface ProtocolRequest {
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, JsonValue>;
}

interface FakeExtension {
  /** Every request the host sent over the attached transport, in order. */
  readonly requests: ProtocolRequest[];
  /** Every response the host sent to an Extension-issued request. */
  readonly responses: Record<string, JsonValue>[];
  waitForRequest(method: string): Promise<ProtocolRequest>;
  respond(id: string, result: JsonValue): Promise<void>;
  send(message: JsonValue): Promise<void>;
  writeRawBytes(bytes: Buffer): void;
}

const DEFAULT_AUTO_ANSWERED = [
  "dolly.initialize",
  "module.create",
  "module.stop",
  "dolly.shutdown",
] as const;

/**
 * The Extension side of the attached transport. It answers the handshake and
 * shutdown methods by default so each test only has to describe the behavior
 * it is actually pinning.
 */
function startFakeExtension(
  double: AttachedProcessDouble,
  options: { readonly autoAnswer?: readonly string[] } = {},
): FakeExtension {
  const requests: ProtocolRequest[] = [];
  const responses: Record<string, JsonValue>[] = [];
  const waiters = new Map<string, ((request: ProtocolRequest) => void)[]>();
  const autoAnswer = new Set(options.autoAnswer ?? DEFAULT_AUTO_ANSWERED);

  const defaultResult = (request: ProtocolRequest): JsonValue => {
    const sessionId = request.params.sessionId as JsonValue;
    if (request.method === "dolly.initialize") {
      return {
        protocolVersion: PROTOCOL_VERSION,
        sessionId,
        extensionId: request.params.extensionId as JsonValue,
        packageVersion: FIXTURE_PACKAGE_MANIFEST.packageVersion,
        moduleKinds: ["fixture"],
      };
    }
    if (request.method === "module.create") {
      return {
        protocolVersion: PROTOCOL_VERSION,
        sessionId,
        moduleId: request.params.moduleId as JsonValue,
        moduleGenerationId: request.params.moduleGenerationId as JsonValue,
      };
    }
    return { protocolVersion: PROTOCOL_VERSION, sessionId, stopped: true };
  };

  const channel: FramedJsonChannel = new FramedJsonChannel(
    double.hostWrites,
    double.hostReads,
    {
      maxFrameBytes: MAX_FRAME_BYTES,
      onMessage: (message) => {
        const envelope = message as Record<string, JsonValue>;
        if (typeof envelope.method !== "string") {
          responses.push(envelope);
          return;
        }
        if (typeof envelope.id !== "string") return;
        const request: ProtocolRequest = {
          id: envelope.id,
          method: envelope.method,
          params: (envelope.params ?? {}) as Record<string, JsonValue>,
        };
        requests.push(request);
        const waiting = waiters.get(request.method);
        if (waiting) {
          waiters.delete(request.method);
          for (const resolve of waiting) resolve(request);
        }
        if (!autoAnswer.has(request.method)) return;
        void channel
          .send({ jsonrpc: "2.0", id: request.id, result: defaultResult(request) })
          .catch(() => undefined);
      },
      onError: () => undefined,
      onEnd: () => undefined,
    },
  );

  return {
    requests,
    responses,
    waitForRequest: (method) =>
      new Promise<ProtocolRequest>((resolve) => {
        const seen = requests.find((request) => request.method === method);
        if (seen) {
          resolve(seen);
          return;
        }
        const waiting = waiters.get(method) ?? [];
        waiting.push(resolve);
        waiters.set(method, waiting);
      }),
    respond: (id, result) => channel.send({ jsonrpc: "2.0", id, result }),
    send: (message) => channel.send(message),
    writeRawBytes: (bytes) => {
      double.hostReads.write(bytes);
    },
  };
}

/** The `module.execute` result shape the host accepts for one Run. */
function executeResult(request: ProtocolRequest, result: JsonValue): JsonValue {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: request.params.sessionId as JsonValue,
    moduleId: request.params.moduleId as JsonValue,
    moduleGenerationId: request.params.moduleGenerationId as JsonValue,
    runId: request.params.runId as JsonValue,
    result,
  };
}

describe("Extension process host attached to a process Core already started", () => {
  it("attaches to an existing process instead of starting one", async () => {
    const double = createAttachedProcessDouble(31_337);
    const host = new ExtensionProcessHost({
      ...hostOptions(),
      attachedProcess: double.attachment,
    });

    // The process exists before the host does, so its identifier is visible
    // without any host-side process creation.
    expect(host.snapshot).toMatchObject({ state: "created", pid: 31_337 });

    const extension = startFakeExtension(double);
    await expect(host.start()).resolves.toMatchObject({ state: "ready" });
    expect(double.terminationSteps).toEqual([]);

    const stop = host.stop();
    await extension.waitForRequest("dolly.shutdown");
    double.reportExit();
    await expect(stop).resolves.toMatchObject({ state: "stopped" });
  });

  it("lets the Linux owner close capabilities and observe the protocol channel separately", async () => {
    const double = createAttachedProcessDouble();
    const host = new ExtensionProcessHost({
      ...hostOptions(),
      attachedProcess: double.attachment,
    });
    startFakeExtension(double);
    await host.start();

    await expect(host.waitForChannelClosed(5)).resolves.toBe(false);
    await expect(host.closeCapabilitySession()).resolves.toBeUndefined();
    expect(double.terminationSteps).toEqual([]);

    double.hostReads.end();
    await expect(host.waitForChannelClosed(100)).resolves.toBe(true);
    await vi.waitFor(() => expect(double.terminationSteps).toContain("request"));
    double.reportExit();
    await expect(host.terminate()).resolves.toMatchObject({ state: "stopped" });
  });

  it("runs one request through the identity-bound Linux protocol session adapter", async () => {
    const wallClockNow = 1_700_000_000_000;
    const double = createAttachedProcessDouble();
    const host = new ExtensionProcessHost({
      ...hostOptions({ wallClockNow: () => wallClockNow }),
      attachedProcess: double.attachment,
    });
    const extension = startFakeExtension(double);
    const snapshot = host.snapshot;
    const processId = double.attachment.processId;
    if (processId === undefined) throw new Error("attached process identifier is missing");
    const process = {
      executionAuthorized: true,
      launcher: {
        processId,
        configure: async () => undefined,
        authorizeExecution: async () => ({
          executionAuthorized: true,
          verifiedProcessIds: [processId],
        } as const),
        requestExit: async () => true,
      },
      record: {
        schemaVersion: "dolly.module-process-record/1",
        instanceId: snapshot.instanceId,
        moduleId: snapshot.moduleId,
        moduleGenerationId: snapshot.moduleGenerationId,
        processGenerationId: snapshot.processGenerationId,
        packageDigest: `sha256:${"a".repeat(64)}`,
        configurationReference: {
          configId: "config-attached",
          revision: `sha256:${"b".repeat(64)}`,
          configVersion: 1,
        },
        declaredExternalEffects: "none",
        serviceInvocationId: "service-invocation-attached",
        bootId: "11111111-1111-4111-8111-111111111111",
        moduleCgroupPath: "/sys/fs/cgroup/core/attached",
        state: "starting",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
      cgroup: {
        identity: {
          instanceId: snapshot.instanceId,
          moduleId: snapshot.moduleId,
          processGenerationId: snapshot.processGenerationId,
        },
        path: "/sys/fs/cgroup/core/attached",
        membershipObserved: true,
        removed: false,
      } as never,
    } satisfies LinuxModuleAuthorizedProcess;
    const session = createExtensionProcessLinuxProtocolSession(host, process, {
      executionTimeoutMs: 1_000,
      cancellationGraceMs: 250,
      wallClockNow: () => wallClockNow,
    });

    await session.initialize();
    const result = session.execute({
      moduleJobId: "module-job-linux",
      runId: "run-linux",
      attempt: 1,
      hasMore: false,
      input: {
        schemaVersion: "dolly.reactive-module-input/2",
        claimedDeliveryIds: [],
        blockGroups: [],
        hasMore: false,
      },
    });
    const request = await extension.waitForRequest("module.execute");
    await extension.respond(request.id, executeResult(request, { ok: true }));
    await expect(result).resolves.toEqual({ ok: true });

    await session.closeCapabilitySession();
    double.reportExit();
    await expect(session.waitForChannelClosed(100)).resolves.toBe(true);
    await expect(host.terminate()).resolves.toMatchObject({ state: "stopped" });
  });

  it("rejects options that both start a command and attach a process", () => {
    const double = createAttachedProcessDouble();
    expect(
      () =>
        new ExtensionProcessHost({
          ...hostOptions(),
          command: process.execPath,
          args: [],
          workingDirectory: tmpdir(),
          attachedProcess: double.attachment,
        } as unknown as AttachedExtensionProcessHostOptions),
    ).toThrowError(expect.objectContaining({ code: "EXTENSION_HOST_OPTIONS_INVALID" }));
  });

  it("rejects an attachment that cannot report the process exit", () => {
    const double = createAttachedProcessDouble();
    const { onExit: _omitted, ...withoutExitObservation } = double.attachment;
    expect(
      () =>
        new ExtensionProcessHost({
          ...hostOptions(),
          attachedProcess: withoutExitObservation,
        } as unknown as AttachedExtensionProcessHostOptions),
    ).toThrowError(expect.objectContaining({ code: "EXTENSION_HOST_OPTIONS_INVALID" }));
  });

  it("rejects an attachment that cannot terminate the process", () => {
    const double = createAttachedProcessDouble();
    const { requestTermination: _omitted, ...withoutTermination } = double.attachment;
    expect(
      () =>
        new ExtensionProcessHost({
          ...hostOptions(),
          attachedProcess: withoutTermination,
        } as unknown as AttachedExtensionProcessHostOptions),
    ).toThrowError(expect.objectContaining({ code: "EXTENSION_HOST_OPTIONS_INVALID" }));
  });

  it("terminates the attached process it never started rather than assuming it exited", async () => {
    const double = createAttachedProcessDouble();
    const host = new ExtensionProcessHost({
      ...hostOptions(),
      attachedProcess: double.attachment,
    });

    // A host that never ran the protocol still has a live process to stop: the
    // attached process was created before the host and outlives a host that
    // only assumes it is gone.
    const termination = host.terminate();
    const settled = vi.fn();
    void termination.then(settled, settled);
    await vi.waitFor(() => expect(double.terminationSteps).toContain("request"), {
      timeout: 500,
      interval: 5,
    });
    expect(settled).not.toHaveBeenCalled();
    expect(host.snapshot.state).not.toBe("stopped");

    double.reportExit();
    await expect(termination).resolves.toMatchObject({ state: "stopped" });
  });

  it("fails closed when the attached process exit is never observed", async () => {
    const double = createAttachedProcessDouble();
    const host = new ExtensionProcessHost({
      ...hostOptions({ forceKillDelayMs: 50, terminationTimeoutMs: 300 }),
      attachedProcess: double.attachment,
    });
    startFakeExtension(double);

    await host.start();
    await expect(host.terminate()).rejects.toMatchObject({
      code: "EXTENSION_TERMINATION_UNCONFIRMED",
    });
    expect(host.snapshot.state).toBe("failed");
    expect(host.snapshot.state).not.toBe("stopped");
    expect(double.terminationSteps).toContain("request");
  });

  // The next two cases drive the clock themselves. Wall-clock waits could not
  // tell "the host waited for the force delay" apart from "this machine was
  // busy", which would both hide a missing delay and fail a correct host under
  // load.
  it("escalates to forced termination only after the force delay", async () => {
    vi.useFakeTimers();
    try {
      const double = createAttachedProcessDouble();
      const host = new ExtensionProcessHost({
        ...hostOptions({ forceKillDelayMs: 100, terminationTimeoutMs: 1_000 }),
        attachedProcess: double.attachment,
      });

      const termination = host.terminate();
      void termination.catch(() => undefined);
      expect(double.terminationSteps).toEqual(["request"]);

      await vi.advanceTimersByTimeAsync(99);
      expect(double.terminationSteps).toEqual(["request"]);

      await vi.advanceTimersByTimeAsync(1);
      expect(double.terminationSteps).toEqual(["request", "force"]);

      double.reportExit();
      await expect(termination).resolves.toMatchObject({ state: "stopped" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not force termination when the attached process exits first", async () => {
    vi.useFakeTimers();
    try {
      const double = createAttachedProcessDouble();
      const host = new ExtensionProcessHost({
        ...hostOptions({ forceKillDelayMs: 100, terminationTimeoutMs: 1_000 }),
        attachedProcess: double.attachment,
      });

      const termination = host.terminate();
      void termination.catch(() => undefined);
      expect(double.terminationSteps).toEqual(["request"]);

      await vi.advanceTimersByTimeAsync(50);
      double.reportExit();
      await expect(termination).resolves.toMatchObject({ state: "stopped" });

      // Well past the force delay: an exit that was observed must cancel the
      // escalation, not merely postpone it.
      await vi.advanceTimersByTimeAsync(500);
      expect(double.terminationSteps).toEqual(["request"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the whole protocol over the attached streams", async () => {
    const double = createAttachedProcessDouble();
    const host = new ExtensionProcessHost({
      ...hostOptions(),
      attachedProcess: double.attachment,
    });
    const extension = startFakeExtension(double);

    await host.start();
    const initialize = extension.requests[0];
    expect(initialize).toMatchObject({ method: "dolly.initialize" });
    expect(initialize?.params).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      isolation: "process",
      limits: { maxFrameBytes: MAX_FRAME_BYTES },
    });
    expect(extension.requests[1]).toMatchObject({ method: "module.create" });

    const run = host.execute(execution());
    const request = await extension.waitForRequest("module.execute");
    await extension.respond(request.id, executeResult(request, { ok: true }));
    await expect(run).resolves.toEqual({ ok: true });

    const stop = host.stop();
    await extension.waitForRequest("dolly.shutdown");
    double.reportExit();
    await expect(stop).resolves.toMatchObject({ state: "stopped" });
    expect(extension.requests.map((entry) => entry.method)).toEqual([
      "dolly.initialize",
      "module.create",
      "module.execute",
      "module.stop",
      "dolly.shutdown",
    ]);
  });

  it("enforces the frame byte limit on the attached input", async () => {
    const double = createAttachedProcessDouble();
    const host = new ExtensionProcessHost({
      ...hostOptions(),
      attachedProcess: double.attachment,
    });
    const extension = startFakeExtension(double);

    await host.start();
    const run = host.execute(execution());
    await extension.waitForRequest("module.execute");
    const oversized = Buffer.allocUnsafe(4);
    oversized.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    extension.writeRawBytes(oversized);

    await vi.waitFor(() => expect(double.terminationSteps).toContain("request"), {
      timeout: 1_000,
      interval: 5,
    });
    double.reportExit();
    await expect(run).rejects.toBeInstanceOf(ModuleExecutorTerminatedError);
    expect(host.snapshot.state).toBe("stopped");
  });

  it("enforces the initialization deadline on the attached streams", async () => {
    const double = createAttachedProcessDouble();
    const host = new ExtensionProcessHost({
      ...hostOptions({ initializationTimeoutMs: 100 }),
      attachedProcess: double.attachment,
    });
    startFakeExtension(double, { autoAnswer: [] });

    const failure = host.start().catch((error: unknown) => error);
    await vi.waitFor(() => expect(double.terminationSteps).toContain("request"), {
      timeout: 1_000,
      interval: 5,
    });
    double.reportExit();
    await expect(failure).resolves.toMatchObject({
      code: "EXTENSION_RESPONSE_TIMEOUT",
    });
    expect(host.snapshot.state).toBe("stopped");
  });

  it("forces termination after an orderly stop when the attached process stays alive", async () => {
    const double = createAttachedProcessDouble();
    const host = new ExtensionProcessHost({
      ...hostOptions(),
      attachedProcess: double.attachment,
    });
    const extension = startFakeExtension(double);

    await host.start();
    const stop = host.stop();
    await extension.waitForRequest("dolly.shutdown");
    // The Extension answered the orderly stop but its process is still there.
    // A confirmed exit, not a well-formed response, is the proof the host owes.
    await vi.waitFor(() => expect(double.terminationSteps).toContain("request"), {
      timeout: 1_000,
      interval: 5,
    });
    double.reportExit();
    await expect(stop).resolves.toMatchObject({ state: "stopped" });
  });

  it("closes the capability session before it confirms the attached exit", async () => {
    const double = createAttachedProcessDouble();
    const host = new ExtensionProcessHost({
      ...hostOptions({ terminationTimeoutMs: 2_000 }),
      attachedProcess: double.attachment,
    });
    const extension = startFakeExtension(double);

    let aborted = false;
    let releaseHandler!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let finishHandler!: () => void;
    const handlerFinished = new Promise<void>((resolve) => {
      finishHandler = resolve;
    });
    const handle = host.grantCapability(
      {
        capabilityType: "private-storage",
        capabilityVersion: "v1",
        operations: ["read"],
        resourceScope: { namespace: "module-a" },
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxInvocations: 1,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 256,
        maxResultBytes: 256,
        executionScope: { moduleJobId: "module-job-a", runId: "run-a" },
        requireIdempotencyKey: true,
      },
      async (_argumentsValue, context) => {
        context.signal.addEventListener("abort", () => {
          aborted = true;
        }, { once: true });
        releaseHandler();
        await handlerFinished;
        return { fromHost: true };
      },
    );

    await host.start();
    const run = host.execute(execution());
    const request = await extension.waitForRequest("module.execute");
    await extension.send({
      jsonrpc: "2.0",
      id: "extension-1",
      method: "capability.invoke",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        sessionId: request.params.sessionId as JsonValue,
        handle: handle as unknown as JsonValue,
        operation: "read",
        arguments: { key: "fixture-key" },
        moduleJobId: "module-job-a",
        runId: "run-a",
        idempotencyKey: "fixture-effect",
      },
    });
    await handlerStarted;

    const termination = host.terminate();
    expect(aborted).toBe(true);
    finishHandler();
    double.reportExit();
    await expect(termination).resolves.toMatchObject({ state: "stopped" });
    await expect(run).rejects.toBeInstanceOf(ModuleExecutorTerminatedError);
  });

  it("attaches to a real child process the test started and confirms its exit", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-attached-real-child-"));
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      child = spawn(process.execPath, [FIXTURE, "normal"], {
        cwd: scratch,
        env: {},
        windowsHide: true,
        detached: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stderr.on("data", () => undefined);
      const started = child;
      await new Promise<void>((resolve, reject) => {
        started.once("spawn", resolve);
        started.once("error", reject);
      });

      const exitObservers = new Set<() => void>();
      started.once("exit", () => {
        for (const observer of exitObservers) observer();
        exitObservers.clear();
      });
      const attachment: AttachedExtensionProcess = {
        standardInput: started.stdin,
        standardOutput: started.stdout,
        ...(started.pid === undefined ? {} : { processId: started.pid }),
        get exited() {
          return started.exitCode !== null || started.signalCode !== null;
        },
        onExit: (observer: () => void) => {
          if (started.exitCode !== null || started.signalCode !== null) observer();
          else exitObservers.add(observer);
        },
        requestTermination: () => {
          started.kill("SIGTERM");
        },
        forceTermination: () => {
          started.kill("SIGKILL");
        },
      };

      const host = new ExtensionProcessHost({
        ...hostOptions({ terminationTimeoutMs: 3_000, shutdownRequestTimeoutMs: 1_000 }),
        attachedProcess: attachment,
      });

      expect(host.snapshot.pid).toBe(started.pid);
      await expect(host.start()).resolves.toMatchObject({ state: "ready" });
      await expect(host.execute(execution())).resolves.toEqual({ ok: true, input: {} });
      await expect(host.stop()).resolves.toMatchObject({ state: "stopped" });
      expect(started.exitCode !== null || started.signalCode !== null).toBe(true);
    } finally {
      if (child) {
        const running = child;
        if (running.exitCode === null && running.signalCode === null) {
          running.kill("SIGKILL");
        }
        // Windows keeps the working directory locked while the process lives,
        // so the removal below must not race the kill above.
        await new Promise<void>((resolve) => {
          if (running.exitCode !== null || running.signalCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(resolve, 2_000);
          running.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
