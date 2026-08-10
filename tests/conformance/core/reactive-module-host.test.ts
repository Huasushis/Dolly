import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "../../../src/core/canonical-json.js";
import type { ExtensionPackageManifest } from "../../../src/core/extension-installation-registry.js";
import type { ReactiveModuleTickResult } from "../../../src/core/reactive-module-runtime.js";
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
  };
}

function registration(id: string, managed: ManagedReactiveModuleRuntime) {
  return {
    moduleId: id,
    runtime: managed,
    inputPageIds: [`${id}-input`],
    outputPageIds: [`${id}-output`],
    mailbox: { maxPendingCount: 10, maxPendingBytes: 1024 },
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
      mailbox: { maxPendingCount: 10, maxPendingBytes: 8192 },
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
    })))).toThrow(/empty or source completion boundary/u);

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
          mailbox: { maxPendingCount: 1, maxPendingBytes: 256 },
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

  it("rejects a Scheduler batch that exceeds any Module claim maximum", () => {
    const config = configuredInstance();
    const input = composition(config);

    expect(() => composeReactiveModuleHost({
      ...input,
      scheduling: { ...input.scheduling, claimLimitCount: 5 },
    })).toThrow(/claimLimitCount 5 exceeds Module worker maximum 4/u);

    expect(() => composeReactiveModuleHost({
      ...input,
      scheduling: { ...input.scheduling, claimLimitBytes: 4097 },
    })).toThrow(/claimLimitBytes 4097 exceeds Module worker maximum 4096/u);
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
    const scheduled: { delayMs: number; callback: () => void; cancelled: boolean }[] = [];
    const input = composition(config, managed);
    const host = composeReactiveModuleHost({
      ...input,
      deliveries: { inspectPending },
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
