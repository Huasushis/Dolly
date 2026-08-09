import { describe, expect, it, vi } from "vitest";
import type { ReactiveModuleTickResult } from "../../../src/core/reactive-module-runtime.js";
import {
  ReactiveModuleHost,
  type ManagedReactiveModuleRuntime,
} from "../../../src/core/reactive-module-host.js";

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
});
