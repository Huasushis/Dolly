import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createExtensionProcessModuleExecutor } from "../../../src/adapters/extension-process-module-executor.js";
import {
  ExtensionIsolationPolicy,
  ExtensionProcessHost,
  type ExtensionIsolationGuarantees,
  type ExtensionProcessHostOptions,
} from "../../../src/core/extension-process-host.js";
import type { JsonValue } from "../../../src/core/canonical-json.js";
import type { ExtensionPackageManifest } from "../../../src/core/extension-installation-registry.js";
import {
  ModuleActor,
  ModuleExecutorTerminationUnconfirmedError,
  ModuleExecutorTerminatedError,
} from "../../../src/core/module-actor.js";
import type { ReactiveModuleInput } from "../../../src/core/reactive-module-input.js";
import type { ReactiveModuleResult } from "../../../src/core/reactive-module-runtime.js";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/extension-process-fixture.mjs", import.meta.url),
);
const FIXTURE_PACKAGE_MANIFEST: ExtensionPackageManifest = {
  schemaVersion: "dolly.extension-package/1",
  extensionId: "com.example.fixture",
  packageVersion: "1.0.0",
  displayName: "Process test fixture",
  description: "Exercises the Extension process protocol in conformance tests.",
  supportedProtocolVersions: ["3.0"],
  entrypoint: "extension-process-fixture.mjs",
  modules: [{
    moduleKind: "fixture",
    activation: "reactive",
    configVersion: 1,
    configurationSchema: { type: "object" },
  }],
  requestedCapabilities: [],
};
const ALL_SANDBOX_GUARANTEES: ExtensionIsolationGuarantees = {
  crashContained: true,
  cpuHangContained: true,
  inheritedEnvironmentScrubbed: true,
  ambientFilesystemDenied: true,
  ambientNetworkDenied: true,
  ambientSubprocessDenied: true,
  hardMemoryLimit: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHost(
  mode: string,
  workingDirectory: string,
  overrides: Partial<ExtensionProcessHostOptions> = {},
): ExtensionProcessHost {
  let id = 0;
  let handle = 0;
  return new ExtensionProcessHost({
    isolation: "process",
    trust: "trusted",
    isolationPolicy: new ExtensionIsolationPolicy(),
    manifest: FIXTURE_PACKAGE_MANIFEST,
    command: process.execPath,
    args: [FIXTURE, mode],
    workingDirectory,
    instanceId: "instance-a",
    moduleId: "module-a",
    moduleGenerationId: "module-generation-a",
    moduleKind: "fixture",
    config: {},
    maxFrameBytes: 16 * 1_024,
    initializationTimeoutMs: 5_000,
    shutdownRequestTimeoutMs: 1_000,
    forceKillDelayMs: 500,
    terminationTimeoutMs: 2_000,
    nextIdentifier: (purpose) => `${purpose}-${++id}`,
    nextCapabilityHandle: () => Buffer.alloc(32, ++handle).toString("base64url"),
    ...overrides,
  });
}

function execution(input = {}) {
  return {
    moduleJobId: "module-job-a",
    runId: "run-a",
    attempt: 1,
    deadline: new Date(Date.now() + 1_000).toISOString(),
    responseTimeoutMs: 2_000,
    hasMore: false,
    input,
  } as const;
}

describe("Extension process isolation and capability checks", () => {
  it("refuses public untrusted code without a passing operating-system sandbox", () => {
    const policy = new ExtensionIsolationPolicy();
    expect(() => policy.resolve("process", "untrusted")).toThrowError(
      expect.objectContaining({ code: "EXTENSION_ISOLATION_DENIED" }),
    );
    expect(() => policy.resolve("sandbox", "untrusted")).toThrowError(
      expect.objectContaining({ code: "EXTENSION_SANDBOX_UNAVAILABLE" }),
    );

    const declaredBackend = new ExtensionIsolationPolicy([
      {
        backendId: "test-only-sandbox",
        backendVersion: "v1",
        platform: process.platform,
        conformanceStatus: "passed",
        guarantees: ALL_SANDBOX_GUARANTEES,
      },
    ]);
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-process-protocol-isolation-"));
    try {
      expect(
        () =>
          createHost("normal", scratch, {
            isolation: "sandbox",
            trust: "untrusted",
            isolationPolicy: declaredBackend,
          }),
      ).toThrowError(expect.objectContaining({ code: "EXTENSION_ISOLATION_DENIED" }));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects incomplete sandbox guarantee evidence", () => {
    expect(
      () =>
        new ExtensionIsolationPolicy([
          {
            backendId: "incomplete-sandbox",
            backendVersion: "v1",
            platform: process.platform,
            conformanceStatus: "passed",
            guarantees: {
              crashContained: true,
            } as ExtensionIsolationGuarantees,
          },
        ]),
    ).toThrowError(expect.objectContaining({ code: "EXTENSION_HOST_OPTIONS_INVALID" }));
  });

  it("rejects Extension process protocol 2.0 during manifest negotiation", () => {
    expect(() =>
      createHost("normal", tmpdir(), {
        manifest: {
          ...FIXTURE_PACKAGE_MANIFEST,
          extensionId: "com.example.old-protocol",
          supportedProtocolVersions: ["2.0"],
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "EXTENSION_PROCESS_PROTOCOL_INCOMPATIBLE" }),
    );
  });

  it("rejects a process that responds with Extension process protocol 2.0", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-old-protocol-"));
    const host = createHost("old-protocol", scratch);
    try {
      await expect(host.start()).rejects.toMatchObject({
        code: "EXTENSION_PROCESS_PROTOCOL_INCOMPATIBLE",
      });
      await host.stop();
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("revokes the session and reaches stopped state when process startup fails", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-start-failure-"));
    const host = createHost("normal", scratch, {
      command: join(scratch, "missing-extension-command"),
      args: [],
    });
    try {
      await expect(host.start()).rejects.toMatchObject({ code: "EXTENSION_INTERNAL" });
      expect(host.snapshot.state).toBe("stopped");
      await expect(host.terminate()).resolves.toMatchObject({ state: "stopped" });
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("does not begin initialization after termination starts during process launch", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-initialization-stop-"));
    const host = createHost("initialize-hang", scratch, {
      initializationTimeoutMs: 5_000,
      forceKillDelayMs: 50,
      terminationTimeoutMs: 1_000,
    });
    const startFailure = host.start().catch((error: unknown) => error);

    try {
      await vi.waitFor(() => expect(host.snapshot.pid).toBeTypeOf("number"), {
        timeout: 1_000,
        interval: 5,
      });
      await expect(host.terminate()).resolves.toMatchObject({ state: "stopped" });
      await expect(startFailure).resolves.toMatchObject({ code: "EXTENSION_STATE_INVALID" });
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("keeps a terminated process stopped when Module creation is still pending", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-module-create-stop-"));
    const markerPath = join(scratch, "module-create-received.txt");
    const host = createHost("module-create-hang", scratch, {
      config: { markerPath },
      initializationTimeoutMs: 5_000,
      forceKillDelayMs: 50,
      terminationTimeoutMs: 1_000,
    });
    const startFailure = host.start().catch((error: unknown) => error);

    try {
      await vi.waitFor(() => expect(existsSync(markerPath)).toBe(true), {
        timeout: 1_000,
        interval: 5,
      });
      await expect(host.terminate()).resolves.toMatchObject({ state: "stopped" });
      await expect(startFailure).resolves.toMatchObject({ code: "EXTENSION_PROCESS_EXITED" });
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects the removed moduleInstanceId field under protocol 3.0", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-old-module-id-field-"));
    const host = createHost("old-module-id-field", scratch);
    try {
      await expect(host.start()).rejects.toMatchObject({
        code: "EXTENSION_PROCESS_PROTOCOL_VIOLATION",
      });
      await host.stop();
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects the removed moduleHandle field under protocol 3.0", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-old-module-handle-field-"));
    const host = createHost("old-module-handle-field", scratch);
    try {
      await expect(host.start()).rejects.toMatchObject({
        code: "EXTENSION_PROCESS_PROTOCOL_VIOLATION",
      });
      await host.stop();
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("sends isolation, not the removed profile field, during initialization", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-initialization-fields-"));
    const host = createHost("initialization-fields", scratch);
    try {
      await host.start();
      await expect(host.execute(execution())).resolves.toEqual({
        isolation: "process",
        hasProfile: false,
      });
      const stop = host.stop();
      expect(host.stop()).toBe(stop);
      await stop;
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("scrubs inherited environment but truthfully exposes ordinary process authority", async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-extension-process-protocol-authority-"));
    const scratch = join(root, "scratch");
    const outside = join(root, "outside-host-canary.txt");
    mkdirSync(scratch);
    writeFileSync(outside, "synthetic-host-canary", "utf8");
    const previousSecret = process.env.DOLLY_HOST_SECRET;
    process.env.DOLLY_HOST_SECRET = "must-not-be-inherited";
    const host = createHost("authority-probe", scratch, {
      config: { probeFilePath: outside },
    });

    try {
      const ready = await host.start();
      expect(ready).toMatchObject({
        isolation: "process",
        state: "ready",
        guarantees: {
          crashContained: true,
          cpuHangContained: true,
          inheritedEnvironmentScrubbed: true,
          ambientFilesystemDenied: false,
          ambientNetworkDenied: false,
          ambientSubprocessDenied: false,
          hardMemoryLimit: false,
        },
      });
      await expect(host.execute(execution())).resolves.toEqual({
        inheritedSecret: null,
        fileValue: "synthetic-host-canary",
        listenerOpened: true,
        subprocessCreated: true,
      });
      await expect(host.stop()).resolves.toMatchObject({ state: "stopped" });
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      if (previousSecret === undefined) delete process.env.DOLLY_HOST_SECRET;
      else process.env.DOLLY_HOST_SECRET = previousSecret;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("contains a real CPU loop and confirms process exit after the response timeout", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-process-protocol-cpu-"));
    const host = createHost("cpu-loop", scratch, {
      shutdownRequestTimeoutMs: 200,
      forceKillDelayMs: 500,
    });
    try {
      await host.start();
      const startedAt = Date.now();
      await expect(
        host.execute({
          ...execution(),
          deadline: new Date(Date.now() + 25).toISOString(),
          responseTimeoutMs: 50,
        }),
      ).rejects.toBeInstanceOf(ModuleExecutorTerminatedError);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("stops a real unresponsive child within the configured host response bound", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-process-stop-hang-"));
    const host = createHost("cpu-loop", scratch, {
      shutdownRequestTimeoutMs: 50,
      forceKillDelayMs: 500,
    });
    try {
      await host.start();
      const executionResult = host.execute({
        ...execution(),
        deadline: new Date(Date.now() + 2_000).toISOString(),
        responseTimeoutMs: 4_000,
      });
      const rejection = expect(executionResult).rejects.toBeInstanceOf(
        ModuleExecutorTerminatedError,
      );
      const startedAt = Date.now();
      await expect(host.stop()).resolves.toMatchObject({ state: "stopped" });
      await rejection;
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("delivers cooperative cancellation without stopping a responsive process", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-process-cancel-"));
    const host = createHost("cancel-aware", scratch);
    try {
      await host.start();
      const result = host.execute(execution());
      await expect(host.cancel("run-a", "soft-timeout")).resolves.toBe("sent");
      await expect(host.cancel("run-a", "soft-timeout")).resolves.toBe("already-sent");
      await expect(result).resolves.toEqual({ cancelled: true, reason: "soft-timeout" });
      expect(host.snapshot.state).toBe("ready");
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("waits for real process exit and rejects a result that arrives after termination", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-process-late-result-"));
    const host = createHost("late-after-cancel", scratch);
    try {
      await host.start();
      const executionResult = host.execute(execution());
      const rejection = expect(executionResult).rejects.toBeInstanceOf(
        ModuleExecutorTerminatedError,
      );
      await expect(host.cancel("run-a", "hard-timeout")).resolves.toBe("sent");
      const termination = host.terminate();
      expect(host.terminate()).toBe(termination);
      await expect(termination).resolves.toMatchObject({ state: "stopped" });
      await rejection;
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("reports a real child crash only after the stopped environment is confirmed", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-process-crash-"));
    const host = createHost("crash", scratch);
    try {
      await host.start();
      await expect(host.execute(execution())).rejects.toBeInstanceOf(
        ModuleExecutorTerminatedError,
      );
      expect(host.snapshot.state).toBe("stopped");
      await expect(host.terminate()).resolves.toMatchObject({ state: "stopped" });
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("keeps the same process ready after an ordinary extension business error", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-process-business-error-"));
    const host = createHost("business-error", scratch);
    try {
      await host.start();
      const processGenerationId = host.snapshot.processGenerationId;
      await expect(host.execute(execution())).rejects.toMatchObject({
        code: "EXTENSION_INTERNAL",
      });
      expect(host.snapshot).toMatchObject({ state: "ready", processGenerationId });
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects an oversized frame before JSON parsing and terminates only that extension", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-process-protocol-frame-"));
    const host = createHost("oversized-frame", scratch);
    try {
      await host.start();
      await expect(host.execute(execution())).rejects.toBeInstanceOf(
        ModuleExecutorTerminatedError,
      );
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("routes declared capabilities through the broker and rejects a handle in a new session", async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-extension-process-protocol-capability-"));
    const firstScratch = join(root, "first");
    const secondScratch = join(root, "second");
    mkdirSync(firstScratch);
    mkdirSync(secondScratch);
    const handler = vi.fn(async () => ({ fromHost: true }));
    const first = createHost("capability", firstScratch);
    const oldHandle = first.grantCapability(
      {
        capabilityType: "private-storage",
        capabilityVersion: "v1",
        operations: ["read"],
        resourceScope: { namespace: "module-a" },
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxInvocations: 2,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 256,
        maxResultBytes: 256,
        executionScope: {
          moduleJobId: "module-job-capability",
          runId: "run-capability",
        },
        requireIdempotencyKey: true,
      },
      handler,
    );

    let second: ExtensionProcessHost | undefined;
    try {
      await first.start();
      await expect(
        first.execute({
          ...execution(),
          moduleJobId: "module-job-capability",
          runId: "run-capability",
        }),
      ).resolves.toEqual({ fromHost: true });
      expect(handler).toHaveBeenCalledTimes(1);
      await first.stop();

      second = createHost("stale-capability", secondScratch, {
        config: {
          staleHandle: {
            schemaVersion: oldHandle.schemaVersion,
            handle: oldHandle.handle,
          },
        },
      });
      await second.start();
      await expect(
        second.execute({
          ...execution(),
          moduleJobId: "module-job-capability",
          runId: "run-capability",
        }),
      ).resolves.toEqual({ capabilityErrorCode: "CAPABILITY_DENIED" });
      await second.stop();
    } finally {
      if (first.snapshot.state !== "stopped") await first.stop().catch(() => undefined);
      if (second && second.snapshot.state !== "stopped") {
        await second.stop().catch(() => undefined);
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds one process-lifetime capability handle to each current Run", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-active-run-capability-"));
    const host = createHost("capability-active-run", scratch);
    const observed: Array<{ moduleJobId?: string; runId?: string; attempt?: number }> = [];
    host.grantCapability(
      {
        capabilityType: "private-storage",
        capabilityVersion: "v1",
        operations: ["read"],
        resourceScope: { descriptor: "fixture-model", executionScope: "active-run" },
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxInvocations: 2,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 256,
        maxResultBytes: 256,
        requireIdempotencyKey: true,
      },
      async (_argumentsValue, context) => {
        observed.push({
          moduleJobId: context.moduleJobId,
          runId: context.runId,
          attempt: (context as typeof context & { attempt?: number }).attempt,
        });
        return { fromHost: true };
      },
    );

    try {
      await host.start();
      await expect(host.execute(execution())).resolves.toEqual({ fromHost: true });
      await expect(
        host.execute({
          ...execution(),
          moduleJobId: "module-job-b",
          runId: "run-b",
          attempt: 2,
        }),
      ).resolves.toEqual({ fromHost: true });
      expect(observed).toEqual([
        { moduleJobId: "module-job-a", runId: "run-a", attempt: 1 },
        { moduleJobId: "module-job-b", runId: "run-b", attempt: 2 },
      ]);
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a Module result while one of that Run's capabilities is still active", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-result-before-capability-"));
    const capabilityStartedMarkerPath = join(scratch, "capability-started");
    const host = createHost("capability-result-before-effect", scratch, {
      config: { capabilityStartedMarkerPath },
    });
    let handlerStarted = false;
    let handlerAborted = false;
    const finishHandler = deferred<{ fromHost: boolean }>();
    host.grantCapability(
      {
        capabilityType: "private-storage",
        capabilityVersion: "v1",
        operations: ["read"],
        resourceScope: { descriptor: "fixture-model" },
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxInvocations: 1,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 256,
        maxResultBytes: 256,
        requireIdempotencyKey: true,
      },
      async (_argumentsValue, context) => {
        handlerStarted = true;
        context.signal.addEventListener(
          "abort",
          () => {
            handlerAborted = true;
          },
          { once: true },
        );
        writeFileSync(capabilityStartedMarkerPath, "started", "utf8");
        return finishHandler.promise;
      },
    );

    try {
      await host.start();
      const result = host.execute(execution()).then(
        (value) => ({ status: "succeeded" as const, value }),
        (error: unknown) => ({ status: "failed" as const, error }),
      );
      await vi.waitFor(() => expect(handlerStarted).toBe(true), {
        timeout: 1_000,
        interval: 5,
      });
      await vi.waitFor(() => expect(handlerAborted).toBe(true), {
        timeout: 1_000,
        interval: 5,
      });
      finishHandler.resolve({ fromHost: true });
      const boundedResult = Promise.race([
        result,
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error(`Module result did not settle from ${host.snapshot.state}`)),
            3_000,
          );
        }),
      ]);
      await expect(boundedResult).resolves.toEqual({
        status: "failed",
        error: expect.any(ModuleExecutorTerminatedError),
      });
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      finishHandler.resolve({ fromHost: true });
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects Module job and Run identifiers that do not match the active Run", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-forged-run-identifiers-"));
    const host = createHost("capability", scratch);
    const handler = vi.fn(async () => ({ fromHost: true }));
    host.grantCapability(
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
        requireIdempotencyKey: true,
      },
      handler,
    );

    try {
      await host.start();
      await expect(host.execute(execution())).resolves.toEqual({
        capabilityErrorCode: "CAPABILITY_SCOPE_MISMATCH",
      });
      expect(handler).not.toHaveBeenCalled();
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a capability request made while no Run is active", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-capability-idle-"));
    const host = createHost("capability-outside-run", scratch);
    const handler = vi.fn(async () => ({ fromHost: true }));
    host.grantCapability(
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
        executionScope: {
          moduleJobId: "module-job-capability",
          runId: "run-capability",
        },
        requireIdempotencyKey: true,
      },
      handler,
    );

    try {
      await host.start();
      await expect(
        host.execute({
          ...execution(),
          moduleJobId: "module-job-capability",
          runId: "run-capability",
        }),
      ).resolves.toEqual({ capabilityErrorCode: "CAPABILITY_SCOPE_MISMATCH" });
      expect(handler).not.toHaveBeenCalled();
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a capability request that omits the Run identifier", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-capability-no-run-"));
    const host = createHost("capability-missing-run-id", scratch);
    const handler = vi.fn(async () => ({ fromHost: true }));
    host.grantCapability(
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
        executionScope: {
          moduleJobId: "module-job-capability",
          runId: "run-capability",
        },
        requireIdempotencyKey: true,
      },
      handler,
    );

    try {
      await host.start();
      await expect(
        host.execute({
          ...execution(),
          moduleJobId: "module-job-capability",
          runId: "run-capability",
        }),
      ).resolves.toEqual({ capabilityErrorCode: "CAPABILITY_SCOPE_MISMATCH" });
      expect(handler).not.toHaveBeenCalled();
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects the processingId capability field under protocol 3.0", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-old-module-job-field-"));
    const host = createHost("old-module-job-field", scratch);
    const handler = vi.fn(async () => ({ fromHost: true }));
    host.grantCapability(
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
        executionScope: {
          moduleJobId: "module-job-capability",
          runId: "run-capability",
        },
        requireIdempotencyKey: true,
      },
      handler,
    );
    try {
      await host.start();
      await expect(host.execute({
        ...execution(),
        moduleJobId: "module-job-capability",
        runId: "run-capability",
      })).resolves.toEqual({
        capabilityErrorCode: "CAPABILITY_DENIED",
      });
      expect(handler).not.toHaveBeenCalled();
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });


  it("does not replace a Module executor until an aborted capability handler settles", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-capability-drain-"));
    const host = createHost("capability", scratch);
    const handlerStarted = deferred<void>();
    const handlerAborted = deferred<void>();
    const finishHandler = deferred<{ fromHost: boolean }>();
    host.grantCapability(
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
        executionScope: {
          moduleJobId: "module-job-capability",
          runId: "run-capability",
        },
        requireIdempotencyKey: true,
      },
      async (_argumentsValue, context) => {
        context.signal.addEventListener(
          "abort",
          () => handlerAborted.resolve(),
          { once: true },
        );
        handlerStarted.resolve();
        return finishHandler.promise;
      },
    );

    let executorCreations = 0;
    const actor = new ModuleActor<ReactiveModuleInput, ReactiveModuleResult>({
      moduleId: "module-a",
      initialModuleGenerationId: "module-generation-a",
      maxQueuedRuns: 1,
      maxQueuedInputBytes: 1_024,
      maxInputBytes: 512,
      maxRunsPerGeneration: 10,
      maxGenerations: 2,
      requireProcessIsolation: true,
      initializationTimeoutMs: 5_000,
      terminationTimeoutMs: 3_000,
      nextModuleGenerationId: () => "module-generation-b",
      monotonicNow: () => 1,
      snapshotInput: (input) => structuredClone(input),
      measureInputBytes: (input) => Buffer.byteLength(JSON.stringify(input)),
      snapshotOutput: (output) => structuredClone(output),
      createExecutor: (moduleGenerationId) => {
        executorCreations += 1;
        if (executorCreations === 1) {
          return createExtensionProcessModuleExecutor(host, {
            moduleId: "module-a",
            moduleGenerationId,
            executionTimeoutMs: 1_000,
            cancellationGraceMs: 2_000,
          });
        }
        return {
          isolation: "process" as const,
          start: async () => undefined,
          execute: async () => ({ schemaVersion: "dolly.module-result/1" as const }),
          terminate: vi.fn().mockResolvedValue(undefined),
        };
      },
      acceptResult: () => undefined,
    });

    try {
      await actor.start();
      const outcome = actor.submit({
        moduleGenerationId: "module-generation-a",
        moduleJobId: "module-job-capability",
        runId: "run-capability",
        attempt: 1,
        input: {
          schemaVersion: "dolly.reactive-module-input/2",
          claimedDeliveryIds: [],
          blockGroups: [],
          hasMore: false,
        },
      });
      await handlerStarted.promise;
      const hardTimeout = actor.hardTimeout("run-capability");
      await handlerAborted.promise;
      await Promise.resolve();
      expect(executorCreations).toBe(1);
      expect(actor.moduleGenerationId).toBe("module-generation-a");

      finishHandler.resolve({ fromHost: true });
      await expect(hardTimeout).resolves.toBe("module-generation-fenced");
      await expect(outcome).resolves.toMatchObject({ status: "fenced" });
      expect(executorCreations).toBe(2);
      expect(actor.moduleGenerationId).toBe("module-generation-b");
      await actor.stop();
    } finally {
      if (host.snapshot.state !== "stopped") {
        finishHandler.resolve({ fromHost: true });
        await host.terminate().catch(() => undefined);
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("reports unconfirmed termination while a capability handler ignores abort", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-capability-timeout-"));
    const host = createHost("capability", scratch, {
      forceKillDelayMs: 20,
      terminationTimeoutMs: 100,
    });
    const handlerStarted = deferred<void>();
    const handlerAborted = deferred<void>();
    const finishHandler = deferred<{ fromHost: boolean }>();
    let handlerAbortObserved = false;
    host.grantCapability(
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
        executionScope: {
          moduleJobId: "module-job-capability",
          runId: "run-capability",
        },
        requireIdempotencyKey: true,
      },
      async (_argumentsValue, context) => {
        context.signal.addEventListener(
          "abort",
          () => {
            handlerAbortObserved = true;
            handlerAborted.resolve();
          },
          { once: true },
        );
        handlerStarted.resolve();
        return finishHandler.promise;
      },
    );

    try {
      await host.start();
      const result = host.execute({
        ...execution(),
        moduleJobId: "module-job-capability",
        runId: "run-capability",
      });
      await handlerStarted.promise;
      const termination = host.terminate();
      expect(handlerAbortObserved).toBe(true);
      await handlerAborted.promise;
      await expect(termination).rejects.toMatchObject({
        code: "EXTENSION_TERMINATION_UNCONFIRMED",
      });
      await expect(result).rejects.toBeInstanceOf(
        ModuleExecutorTerminationUnconfirmedError,
      );
      expect(host.snapshot.state).toBe("failed");

      finishHandler.resolve({ fromHost: true });
      await expect(host.terminate()).resolves.toMatchObject({ state: "stopped" });
    } finally {
      finishHandler.resolve({ fromHost: true });
      if (host.snapshot.state !== "stopped") {
        await host.terminate().catch(() => undefined);
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("treats a stale Run result as a protocol violation, not a valid late result", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-process-protocol-stale-"));
    const host = createHost("stale-result", scratch);
    try {
      await host.start();
      await expect(host.execute(execution())).rejects.toBeInstanceOf(
        ModuleExecutorTerminatedError,
      );
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
