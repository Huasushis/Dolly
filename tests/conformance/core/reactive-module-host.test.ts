import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "../../../src/core/canonical-json.js";
import type { ExtensionPackageManifest } from "../../../src/core/extension-installation-registry.js";
import type {
  ReactiveModuleRecoveryResult,
  ReactiveModuleTickResult,
} from "../../../src/core/reactive-module-runtime.js";
import {
  composeReactiveModuleHost,
  ReactiveModuleHost,
  type ManagedReactiveModuleRuntime,
  type ReactiveModuleHostComposition,
} from "../../../src/core/reactive-module-host.js";
import {
  createDefaultDollyInstanceConfig,
  validateDollyInstanceConfig,
  type DollyInstanceConfig,
} from "../../../src/core/runtime-config.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

function runtime(
  id: string,
  events: string[],
  start: () => Promise<void> = async () => undefined,
  stop: () => Promise<void> = async () => undefined,
): ManagedReactiveModuleRuntime {
  return {
    moduleGenerationId: `${id}-generation`,
    start: async () => {
      events.push(`start:${id}`);
      await start();
    },
    stop: async () => {
      events.push(`stop:${id}`);
      await stop();
    },
    tick: async (): Promise<ReactiveModuleTickResult> => ({ status: "idle" }),
  };
}

function scheduler(events: string[]) {
  return {
    register: vi.fn((registration: { readonly moduleId: string }) => {
      events.push(`register:${registration.moduleId}`);
    }),
    start: vi.fn(() => {
      events.push("scheduler:start");
    }),
    stop: vi.fn(async () => {
      events.push("scheduler:stop");
    }),
    recoverModule: vi.fn(async (): Promise<ReactiveModuleRecoveryResult> => ({
      status: "nothing-to-recover",
    })),
    status: vi.fn((): { readonly quarantineReason: string | null } => ({
      quarantineReason: null,
    })),
  };
}

function registration(id: string, managed: ManagedReactiveModuleRuntime) {
  return {
    moduleId: id,
    runtime: managed,
    inputPageIds: [`${id}-input`],
    outputPageIds: [`${id}-output`],
    mailbox: { maxResidentCount: 10, maxResidentBytes: 1024 },
    claimLimits: {
      baselineCount: 1,
      baselineBytes: 1024,
      maxCount: 1,
      maxBytes: 1024,
    },
  };
}

function configuredInstance(
  overrides: Readonly<Record<string, JsonValue>> = {},
): DollyInstanceConfig {
  const base = createDefaultDollyInstanceConfig(INSTANCE_ID);
  return validateDollyInstanceConfig({
    ...base,
    pages: [{ pageId: "worker-input" }, { pageId: "worker-output" }],
    modules: [{
      moduleId: "worker",
      extensionId: "org.example.worker",
      packageVersion: "1.0.0",
      moduleKind: "transform",
      isolation: "process",
      configurationReference: {
        configId: "worker-default",
        revision: `sha256:${"1".repeat(64)}`,
        configVersion: 1,
      },
      permissionPolicyIds: [],
      inputPageIds: ["worker-input"],
      outputPageIds: ["worker-output"],
      subscriptionStart: "from-now",
      activation: { kind: "reactive" },
      limits: {
        claim: { maxCount: 4, maxBytes: 4096 },
        maxInputBytes: 4096,
        maxResultBytes: 4096,
        maxFrameBytes: 8192,
        maxRunsPerGeneration: 100,
        maxGenerations: 10,
      },
      timeouts: {
        initializationTimeoutMs: 1000,
        executionTimeoutMs: 1000,
        cancellationGraceMs: 100,
        terminationTimeoutMs: 1000,
      },
      ...overrides,
    }],
  });
}

function composition(
  config: DollyInstanceConfig,
  managed = runtime("worker", []),
  manifest: ExtensionPackageManifest = {
    schemaVersion: "dolly.extension-package/1",
    extensionId: "org.example.worker",
    packageVersion: "1.0.0",
    displayName: "Worker",
    description: "Test worker",
    supportedProtocolVersions: ["3.0"],
    entrypoint: "dist/worker.mjs",
    modules: [{
      moduleKind: "transform",
      activation: "reactive",
      configVersion: 1,
      configurationSchema: { type: "object" },
    }],
    requestedCapabilities: [],
  },
): ReactiveModuleHostComposition {
  return {
    configuration: config,
    deliveries: {
      inspectPending: () => ({ pendingCount: 0, pendingBytes: 0 }),
      inspectResident: () => ({
        pendingCount: 0,
        pendingBytes: 0,
        claimedCount: 0,
        claimedBytes: 0,
        residentCount: 0,
        residentBytes: 0,
      }),
    },
    clock: {
      monotonicNow: () => 0,
      schedule: () => ({ cancel: () => undefined }),
    },
    scheduling: {
      maxConcurrentModules: 1,
      backpressureAction: "pause-upstream",
      downstreamRecheckMs: 100,
      noProgressAfterMs: 5000,
      claimLimitCount: 1,
      claimLimitBytes: 1024,
      retryJitterRatio: 0,
      lowWatermarkRatio: 1,
    },
    registrations: [{
      moduleId: "worker",
      runtime: managed,
      mailbox: { maxResidentCount: 10, maxResidentBytes: 8192 },
      manifest,
    }],
  };
}

describe("reactive Module host lifecycle", () => {
  it("starts the Scheduler only after every runtime and stops it before runtimes", async () => {
    const events: string[] = [];
    const fakeScheduler = scheduler(events);
    const host = new ReactiveModuleHost(
      fakeScheduler as never,
      [registration("a", runtime("a", events)), registration("b", runtime("b", events))],
    );

    await host.start();
    expect(host.state).toBe("running");
    await host.stop();
    expect(host.state).toBe("stopped");
    expect(events).toEqual([
      "register:a",
      "register:b",
      "start:a",
      "start:b",
      "scheduler:start",
      "scheduler:stop",
      "stop:b",
      "stop:a",
    ]);
  });

  it("does not report running while a startup result still awaits output capacity", async () => {
    const events: string[] = [];
    let outputCommitWaiting = true;
    let startupRecoveryPending = true;
    const managed: ManagedReactiveModuleRuntime = {
      moduleGenerationId: "worker-generation",
      get outputCommitWaiting() {
        return outputCommitWaiting;
      },
      get startupRecoveryPending() {
        return startupRecoveryPending;
      },
      start: vi.fn(async () => {
        events.push("start:worker");
      }),
      stop: vi.fn(async () => {
        events.push("stop:worker");
      }),
      tick: vi.fn(async (): Promise<ReactiveModuleTickResult> => ({ status: "idle" })),
    };
    const host = new ReactiveModuleHost(
      scheduler(events) as never,
      [registration("worker", managed)],
    );

    await host.start();
    expect(host.state).toBe("recovering");

    outputCommitWaiting = false;
    expect(host.state).toBe("recovering");

    startupRecoveryPending = false;
    expect(host.state).toBe("running");

    outputCommitWaiting = true;
    expect(host.state).toBe("running");
    await expect(host.stop()).resolves.toBeUndefined();
  });

  it("routes operator recovery through the Scheduler-owned Module fence", async () => {
    const events: string[] = [];
    const fakeScheduler = scheduler(events);
    fakeScheduler.recoverModule.mockResolvedValue({
      status: "retry-scheduled",
      moduleJobId: "job-1",
      claimToken: "claim-1",
      runId: "run-1",
      attempt: 1,
      moduleGenerationId: "worker-generation",
      failure: { code: "MODULE_FAILED", retryable: true },
    });
    const managed = runtime("worker", events);
    const host = new ReactiveModuleHost(
      fakeScheduler as never,
      [registration("worker", managed)],
    );

    await expect(host.recoverModule("worker")).rejects.toThrow(
      "cannot recover from created",
    );
    await host.start();
    await expect(host.recoverModule("worker")).resolves.toMatchObject({
      status: "retry-scheduled",
    });
    expect(fakeScheduler.recoverModule).toHaveBeenCalledTimes(1);
    expect(fakeScheduler.recoverModule).toHaveBeenCalledWith("worker");
    await host.stop();
  });

  it("stops runtime work while an operator recovery is still fenced by the Scheduler", async () => {
    const events: string[] = [];
    let finishRecovery!: (result: ReactiveModuleRecoveryResult) => void;
    const recovery = new Promise<ReactiveModuleRecoveryResult>((resolve) => {
      finishRecovery = resolve;
    });
    const fakeScheduler = scheduler(events);
    fakeScheduler.recoverModule.mockImplementation(() => recovery);
    fakeScheduler.stop.mockImplementation(async () => {
      events.push("scheduler:stop");
      await recovery;
    });
    const managed = runtime("worker", events);
    const host = new ReactiveModuleHost(
      fakeScheduler as never,
      [registration("worker", managed)],
    );
    await host.start();

    const recovering = host.recoverModule("worker");
    const stopping = host.stop();
    await vi.waitFor(() => expect(events).toContain("stop:worker"));
    expect(host.state).toBe("stopping");

    finishRecovery({ status: "nothing-to-recover" });
    await recovering;
    await stopping;
    expect(host.state).toBe("stopped");
  });

  it("does not report running when runtime recovery clears locally but Scheduler keeps quarantine", async () => {
    const events: string[] = [];
    let startupRecoveryPending = true;
    const managed: ManagedReactiveModuleRuntime = {
      moduleGenerationId: "worker-generation",
      get startupRecoveryPending() {
        return startupRecoveryPending;
      },
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      tick: vi.fn(async (): Promise<ReactiveModuleTickResult> => ({ status: "idle" })),
    };
    const fakeScheduler = scheduler(events);
    fakeScheduler.status.mockReturnValue({
      quarantineReason: "RECOVERY_REQUIRED:commit-outcome-unknown",
    });
    fakeScheduler.recoverModule.mockImplementation(async () => {
      startupRecoveryPending = false;
      throw new Error("invalid recovery result");
    });
    const host = new ReactiveModuleHost(
      fakeScheduler as never,
      [registration("worker", managed)],
    );
    await host.start();
    expect(host.state).toBe("recovering");

    await expect(host.recoverModule("worker")).rejects.toThrow(
      "invalid recovery result",
    );
    expect(host.state).toBe("recovering");
    await host.stop();
  });

  it("stops runtime work without waiting for the Scheduler tick drain first", async () => {
    const events: string[] = [];
    let finishSchedulerStop: (() => void) | undefined;
    const fakeScheduler = scheduler(events);
    fakeScheduler.stop.mockImplementation(() => {
      events.push("scheduler:stop");
      return new Promise<void>((resolve) => {
        finishSchedulerStop = resolve;
      });
    });
    const managed = runtime(
      "worker",
      events,
      async () => undefined,
      async () => finishSchedulerStop?.(),
    );
    const host = new ReactiveModuleHost(
      fakeScheduler as never,
      [registration("worker", managed)],
    );
    await host.start();

    await expect(host.stop()).resolves.toBeUndefined();
    expect(events).toEqual([
      "register:worker",
      "start:worker",
      "scheduler:start",
      "scheduler:stop",
      "stop:worker",
    ]);
  });

  it("retries a failed runtime termination instead of caching a rejected stop", async () => {
    const events: string[] = [];
    let stopAttempts = 0;
    const managed = runtime(
      "worker",
      events,
      async () => undefined,
      async () => {
        stopAttempts += 1;
        if (stopAttempts === 1) throw new Error("termination unconfirmed");
      },
    );
    const host = new ReactiveModuleHost(
      scheduler(events) as never,
      [registration("worker", managed)],
    );
    await host.start();

    await expect(host.stop()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: "termination unconfirmed" })],
    });
    expect(host.state).toBe("failed");
    await expect(host.stop()).resolves.toBeUndefined();
    expect(host.state).toBe("stopped");
    expect(stopAttempts).toBe(2);
  });

  it("preserves an explicit activation descriptor when it registers a runtime", () => {
    const events: string[] = [];
    const fakeScheduler = scheduler(events);

    new ReactiveModuleHost(
      fakeScheduler as never,
      [{
        ...registration("periodic", runtime("periodic", events)),
        activation: { kind: "periodic", periodMs: 250, allowEmptyInput: false },
      }],
    );

    expect(fakeScheduler.register).toHaveBeenCalledWith(expect.objectContaining({
      moduleId: "periodic",
      activation: { kind: "periodic", periodMs: 250, allowEmptyInput: false },
      claimLimits: {
        baselineCount: 1,
        baselineBytes: 1024,
        maxCount: 1,
        maxBytes: 1024,
      },
    }));
  });

  it("preserves a source activation binding when it registers a runtime", () => {
    const events: string[] = [];
    const fakeScheduler = scheduler(events);
    const sourceActivationBinding = {
      schemaVersion: "dolly.source-activation-binding/1" as const,
      moduleId: "source",
      privatePageId: "private-source-page",
    };

    new ReactiveModuleHost(
      fakeScheduler as never,
      [{
        ...registration("source", runtime("source", events)),
        inputPageIds: [],
        activation: { kind: "source" },
        sourceActivationBinding,
      }],
    );

    expect(fakeScheduler.register).toHaveBeenCalledWith(expect.objectContaining({
      moduleId: "source",
      activation: { kind: "source" },
      sourceActivationBinding,
      claimLimits: {
        baselineCount: 1,
        baselineBytes: 1024,
        maxCount: 1,
        maxBytes: 1024,
      },
    }));
  });

  it("rolls already-started runtimes back in reverse order without starting Scheduler", async () => {
    const events: string[] = [];
    const fakeScheduler = scheduler(events);
    const failure = new Error("second runtime failed");
    const host = new ReactiveModuleHost(
      fakeScheduler as never,
      [
        registration("a", runtime("a", events)),
        registration("b", runtime("b", events, async () => { throw failure; })),
      ],
    );

    await expect(host.start()).rejects.toBe(failure);
    expect(host.state).toBe("failed");
    expect(fakeScheduler.start).not.toHaveBeenCalled();
    expect(events).toEqual([
      "register:a",
      "register:b",
      "start:a",
      "start:b",
      "stop:a",
    ]);
  });

  it("composes routes only from one validated Delivery-backed process Module configuration", () => {
    const config = configuredInstance();
    const host = composeReactiveModuleHost(composition(config));

    expect(host).toBeInstanceOf(ReactiveModuleHost);

    expect(() => composeReactiveModuleHost({
      ...composition(config),
      configuration: { ...config, schemaVersion: "dolly.instance/8" } as never,
    })).toThrow(/schemaVersion is unsupported/u);

    expect(() => composeReactiveModuleHost(composition(configuredInstance({
      activation: { kind: "periodic", periodMs: 1000, allowEmptyInput: false },
    })))).toThrow(/does not support periodic activation/u);

    expect(() => composeReactiveModuleHost(composition(configuredInstance({
      activation: { kind: "periodic", periodMs: 1000, allowEmptyInput: true },
    })))).toThrow(/empty periodic completion boundary/u);

    expect(() => composeReactiveModuleHost(composition(configuredInstance({
      isolation: "none",
    })))).toThrow(/process isolation/u);
  });

  it("requires one exact runtime and mailbox registration per configured Module", () => {
    const config = configuredInstance();
    const input = composition(config);

    expect(() => composeReactiveModuleHost({
      ...input,
      registrations: [],
    })).toThrow(/missing runtime registrations: worker/u);

    expect(() => composeReactiveModuleHost({
      ...input,
      registrations: [
        ...input.registrations,
        {
          moduleId: "unexpected",
          runtime: runtime("unexpected", []),
          mailbox: { maxResidentCount: 1, maxResidentBytes: 256 },
          manifest: input.registrations[0]!.manifest,
        },
      ],
    })).toThrow(/unknown runtime registrations: unexpected/u);
  });

  it("binds each runtime to the exact package identity, Module kind, and configuration version", () => {
    const config = configuredInstance();
    const input = composition(config);
    const manifest = input.registrations[0]!.manifest;

    expect(() => composeReactiveModuleHost({
      ...input,
      registrations: [{
        ...input.registrations[0]!,
        manifest: { ...manifest, extensionId: "org.example.other" },
      }],
    })).toThrow(/package identity does not match/u);

    expect(() => composeReactiveModuleHost(composition(configuredInstance({
      moduleKind: "other-kind",
    })))).toThrow(/does not declare Module kind other-kind/u);

    expect(() => composeReactiveModuleHost(composition(configuredInstance({
      configurationReference: {
        configId: "worker-default",
        revision: `sha256:${"1".repeat(64)}`,
        configVersion: 2,
      },
    })))).toThrow(/does not support configuration version 2/u);
  });

  it("narrows the candidate default batch to each Module's hard Claim maximum", async () => {
    const config = configuredInstance();
    const input = composition(config);
    const tick = vi.fn(async (): Promise<ReactiveModuleTickResult> => ({ status: "idle" }));
    const managed: ManagedReactiveModuleRuntime = {
      moduleGenerationId: "worker-generation",
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      tick,
    };
    const scheduled: { delayMs: number; callback: () => void }[] = [];
    const host = composeReactiveModuleHost({
      ...input,
      scheduling: {
        ...input.scheduling,
        claimLimitCount: 5,
        claimLimitBytes: 4097,
      },
      registrations: [{ ...input.registrations[0]!, runtime: managed }],
      deliveries: {
        inspectPending: () => ({ pendingCount: 5, pendingBytes: 5000 }),
        inspectResident: () => ({
          pendingCount: 5,
          pendingBytes: 5000,
          claimedCount: 0,
          claimedBytes: 0,
          residentCount: 5,
          residentBytes: 5000,
        }),
      },
      clock: {
        monotonicNow: () => 0,
        schedule: (delayMs, callback) => {
          scheduled.push({ delayMs, callback });
          return { cancel: () => undefined };
        },
      },
    });
    await host.start();
    scheduled.find((timer) => timer.delayMs === 0)!.callback();
    await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(1));
    expect(tick).toHaveBeenCalledWith({
      claimLimitCount: 4,
      claimLimitBytes: 4096,
    });
    await host.stop();
  });

  it("uses configured Page routes and passes the exact explicit batch to the runtime", async () => {
    const config = configuredInstance();
    const tick = vi.fn(async (): Promise<ReactiveModuleTickResult> => ({ status: "idle" }));
    const managed: ManagedReactiveModuleRuntime = {
      moduleGenerationId: "worker-generation",
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      tick,
    };
    const inspectPending = vi.fn(() => ({ pendingCount: 1, pendingBytes: 64 }));
    const inspectResident = vi.fn(() => ({
      pendingCount: 1,
      pendingBytes: 64,
      claimedCount: 0,
      claimedBytes: 0,
      residentCount: 1,
      residentBytes: 64,
    }));
    const scheduled: { delayMs: number; callback: () => void; cancelled: boolean }[] = [];
    const input = composition(config, managed);
    const host = composeReactiveModuleHost({
      ...input,
      deliveries: { inspectPending, inspectResident },
      clock: {
        monotonicNow: () => 10,
        schedule: (delayMs, callback) => {
          const timer = { delayMs, callback, cancelled: false };
          scheduled.push(timer);
          return { cancel: () => { timer.cancelled = true; } };
        },
      },
    });

    await host.start();
    const immediate = scheduled.find((timer) => timer.delayMs === 0);
    expect(immediate).toBeDefined();
    immediate!.callback();
    await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(1));

    expect(inspectPending).toHaveBeenCalledWith("worker", ["worker-input"]);
    expect(tick).toHaveBeenCalledWith({ claimLimitCount: 1, claimLimitBytes: 1024 });
    await host.stop();
  });
});
