import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "../../../src/core/canonical-json.js";
import {
  LinuxModuleLauncherController,
  type LinuxModuleLauncherExecutionRequest,
  type LinuxModuleLauncherOutcome,
} from "../../../src/adapters/linux-module-launcher/linux-module-launcher-controller.js";
import { createLauncherInCgroupEvent } from "../../../src/adapters/linux-module-launcher/launcher-control-protocol.js";

const LAUNCHER_PROCESS_ID = 4_242;
const MODULE_CGROUP_PATH = "/sys/fs/cgroup/user.slice/dolly.service/mod-7";

const REQUEST: LinuxModuleLauncherExecutionRequest = {
  launcherProcessId: LAUNCHER_PROCESS_ID,
  moduleCgroupPath: MODULE_CGROUP_PATH,
  maxOpenFiles: 128,
  program: "/usr/bin/node",
  argumentVector: ["/usr/bin/node", "/opt/dolly/extension/entrypoint.mjs"],
  environment: { NODE_ENV: "production" },
};

interface Harness {
  readonly controller: LinuxModuleLauncherController;
  readonly sent: JsonValue[];
  readonly channelClosed: () => boolean;
  readonly waitForLauncherExit: ReturnType<typeof vi.fn>;
  readonly commandNames: () => string[];
}

interface HarnessOptions {
  readonly cgroupProcessIds?: readonly number[] | (() => Promise<readonly number[]>);
  readonly launcherExitObserved?: boolean;
  readonly sendFails?: boolean;
  readonly timeoutMs?: number;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const sent: JsonValue[] = [];
  let closed = false;
  const waitForLauncherExit = vi.fn(async () => options.launcherExitObserved ?? true);
  const configuredProcessIds = options.cgroupProcessIds;
  const readModuleCgroupProcessIds =
    typeof configuredProcessIds === "function"
      ? configuredProcessIds
      : async () => configuredProcessIds ?? [LAUNCHER_PROCESS_ID];
  const timeoutMs = options.timeoutMs ?? 50;
  const controller = new LinuxModuleLauncherController({
    channel: {
      send: async (message) => {
        if (options.sendFails) throw new Error("control descriptor is broken");
        sent.push(message);
      },
      close: () => {
        closed = true;
      },
    },
    readModuleCgroupProcessIds,
    waitForLauncherExit,
    configureTimeoutMs: timeoutMs,
    inCgroupTimeoutMs: timeoutMs,
    membershipTimeoutMs: timeoutMs,
    exitObservationTimeoutMs: timeoutMs,
  });
  return {
    controller,
    sent,
    channelClosed: () => closed,
    waitForLauncherExit,
    commandNames: () =>
      sent.map((message) => String((message as Record<string, unknown>).command)),
  };
}

/** Waits for the controller to have written `count` frames. */
async function waitForSentCount(harness: Harness, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200 && harness.sent.length < count; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("LinuxModuleLauncherController authorization sequence", () => {
  it("sends execute only after kernel cgroup membership is verified", async () => {
    const harness = createHarness();
    const observed: string[] = [];
    const readOrder = vi.fn(async () => {
      observed.push("read-cgroup-procs");
      return [LAUNCHER_PROCESS_ID];
    });
    const controller = new LinuxModuleLauncherController({
      channel: {
        send: async (message) => {
          observed.push(`send:${String((message as Record<string, unknown>).command)}`);
          harness.sent.push(message);
        },
        close: () => undefined,
      },
      readModuleCgroupProcessIds: readOrder,
      waitForLauncherExit: async () => true,
      inCgroupTimeoutMs: 500,
    });

    const outcome = controller.authorizeExecution(REQUEST);
    await waitForSentCount(harness, 1);
    controller.receiveControlMessage(createLauncherInCgroupEvent() as unknown as JsonValue);
    const result = await outcome;

    expect(result).toEqual({
      outcome: "executing",
      moduleCgroupPath: MODULE_CGROUP_PATH,
      verifiedProcessIds: [LAUNCHER_PROCESS_ID],
    } satisfies LinuxModuleLauncherOutcome);
    expect(observed).toEqual(["send:configure", "read-cgroup-procs", "send:execute"]);
    expect(controller.membershipVerified).toBe(true);
  });

  it("refuses to execute when cgroup.procs does not list the launcher", async () => {
    const harness = createHarness({ cgroupProcessIds: [] });
    const outcome = harness.controller.authorizeExecution(REQUEST);
    await waitForSentCount(harness, 1);
    harness.controller.receiveControlMessage(
      createLauncherInCgroupEvent() as unknown as JsonValue,
    );
    const result = await outcome;

    expect(result).toMatchObject({
      outcome: "failed",
      code: "LAUNCHER_MEMBERSHIP_UNVERIFIED",
      observedProcessIds: [],
      membershipVerified: false,
      launcherExitObserved: true,
    });
    expect(harness.commandNames()).toEqual(["configure", "exit"]);
  });

  it("refuses to execute when the Module cgroup holds an unexplained process", async () => {
    const harness = createHarness({ cgroupProcessIds: [LAUNCHER_PROCESS_ID, 99] });
    const outcome = harness.controller.authorizeExecution(REQUEST);
    await waitForSentCount(harness, 1);
    harness.controller.receiveControlMessage(
      createLauncherInCgroupEvent() as unknown as JsonValue,
    );
    const result = await outcome;

    expect(result).toMatchObject({
      outcome: "failed",
      code: "LAUNCHER_MEMBERSHIP_UNVERIFIED",
      observedProcessIds: [LAUNCHER_PROCESS_ID, 99],
      membershipVerified: false,
    });
    expect(harness.commandNames()).toEqual(["configure", "exit"]);
  });

  it("reports an unproven launcher exit instead of signalling a process identifier", async () => {
    const harness = createHarness({ cgroupProcessIds: [], launcherExitObserved: false });
    const outcome = harness.controller.authorizeExecution(REQUEST);
    await waitForSentCount(harness, 1);
    harness.controller.receiveControlMessage(
      createLauncherInCgroupEvent() as unknown as JsonValue,
    );
    const result = await outcome;

    expect(result).toMatchObject({
      outcome: "failed",
      code: "LAUNCHER_MEMBERSHIP_UNVERIFIED",
      membershipVerified: false,
      launcherExitObserved: false,
    });
    expect(harness.waitForLauncherExit).toHaveBeenCalledTimes(1);
    // The controller has no dependency that can send a signal: the only stop
    // path is the exit command on the control descriptor.
    expect(harness.commandNames()).toEqual(["configure", "exit"]);
  });

  it("stops through the control descriptor when a stop is requested before authorization", async () => {
    const harness = createHarness();
    const outcome = harness.controller.authorizeExecution(REQUEST);
    await waitForSentCount(harness, 1);
    harness.controller.requestStop();
    const result = await outcome;

    expect(result).toMatchObject({
      outcome: "failed",
      code: "LAUNCHER_STOP_REQUESTED",
      membershipVerified: false,
      launcherExitObserved: true,
    });
    expect(harness.commandNames()).toEqual(["configure", "exit"]);
  });

  it("reports a verified membership when the stop arrives after verification", async () => {
    let resolveRead: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveRead = resolve;
    });
    const harness = createHarness({
      cgroupProcessIds: async () => {
        await gate;
        return [LAUNCHER_PROCESS_ID];
      },
      timeoutMs: 2_000,
    });
    const outcome = harness.controller.authorizeExecution(REQUEST);
    await waitForSentCount(harness, 1);
    harness.controller.receiveControlMessage(
      createLauncherInCgroupEvent() as unknown as JsonValue,
    );
    await new Promise((resolve) => setImmediate(resolve));
    harness.controller.requestStop();
    resolveRead?.();
    const result = await outcome;

    expect(result).toMatchObject({
      outcome: "failed",
      code: "LAUNCHER_STOP_REQUESTED",
      observedProcessIds: [LAUNCHER_PROCESS_ID],
      membershipVerified: true,
      // After membership, ADR 0009 requires cgroup-level termination evidence,
      // so no child exit is claimed here.
      launcherExitObserved: false,
    });
    expect(harness.commandNames()).toEqual(["configure", "exit"]);
    expect(harness.waitForLauncherExit).not.toHaveBeenCalled();
  });

  it("reports that execute may have been delivered when its send times out", async () => {
    const sent: JsonValue[] = [];
    const controller = new LinuxModuleLauncherController({
      channel: {
        send: async (message) => {
          sent.push(message);
          const command = String((message as Record<string, unknown>).command);
          if (command === "execute") {
            await new Promise<void>(() => undefined);
          }
        },
        close: () => undefined,
      },
      readModuleCgroupProcessIds: async () => [LAUNCHER_PROCESS_ID],
      waitForLauncherExit: async () => true,
      configureTimeoutMs: 30,
      inCgroupTimeoutMs: 100,
      membershipTimeoutMs: 100,
      exitObservationTimeoutMs: 100,
    });

    const authorization = controller.authorizeExecution(REQUEST);
    for (let attempt = 0; attempt < 100 && sent.length < 1; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    controller.receiveControlMessage(
      createLauncherInCgroupEvent() as unknown as JsonValue,
    );
    const result = await authorization;

    expect(result).toMatchObject({
      outcome: "failed",
      code: "LAUNCHER_CONTROL_TIMEOUT",
      observedProcessIds: [LAUNCHER_PROCESS_ID],
      executeCommandMayHaveBeenDelivered: true,
      membershipVerified: true,
      launcherExitObserved: false,
    });
    expect(
      sent.map((message) => String((message as Record<string, unknown>).command)),
    ).toEqual(["configure", "execute", "exit"]);
  });

  it("returns the original failure when sending exit times out", async () => {
    const sent: string[] = [];
    const controller = new LinuxModuleLauncherController({
      channel: {
        send: async (message) => {
          const command = String((message as Record<string, unknown>).command);
          sent.push(command);
          if (command === "exit") {
            await new Promise<void>(() => undefined);
          }
        },
        close: () => undefined,
      },
      readModuleCgroupProcessIds: async () => [],
      waitForLauncherExit: async () => true,
      configureTimeoutMs: 30,
      inCgroupTimeoutMs: 100,
      membershipTimeoutMs: 100,
      exitObservationTimeoutMs: 100,
    });

    const authorization = controller.authorizeExecution(REQUEST);
    for (let attempt = 0; attempt < 100 && sent.length < 1; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    controller.receiveControlMessage(
      createLauncherInCgroupEvent() as unknown as JsonValue,
    );
    const result = await authorization;

    expect(result).toMatchObject({
      outcome: "failed",
      code: "LAUNCHER_MEMBERSHIP_UNVERIFIED",
      observedProcessIds: [],
      executeCommandMayHaveBeenDelivered: false,
      membershipVerified: false,
      launcherExitObserved: true,
    });
    expect(sent).toEqual(["configure", "exit"]);
  });

  it("rejects an out-of-order or malformed frame from the launcher", async () => {
    for (const frame of [
      { launcherProtocol: 1, event: "executing" },
      { launcherProtocol: 2, event: "in-cgroup" },
      { event: "in-cgroup" },
      "in-cgroup",
    ] as JsonValue[]) {
      const harness = createHarness();
      const outcome = harness.controller.authorizeExecution(REQUEST);
      await waitForSentCount(harness, 1);
      harness.controller.receiveControlMessage(frame);
      const result = await outcome;
      expect(result, `expected ${JSON.stringify(frame)} to be rejected`).toMatchObject({
        outcome: "failed",
        code: "LAUNCHER_CONTROL_PROTOCOL_VIOLATION",
        membershipVerified: false,
      });
      expect(harness.commandNames()).toEqual(["configure", "exit"]);
    }
  });

  it("rejects a second in-cgroup event", async () => {
    const harness = createHarness({ timeoutMs: 2_000 });
    let resolveRead: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveRead = resolve;
    });
    const controller = new LinuxModuleLauncherController({
      channel: {
        send: async (message) => {
          harness.sent.push(message);
        },
        close: () => undefined,
      },
      readModuleCgroupProcessIds: async () => {
        await gate;
        return [LAUNCHER_PROCESS_ID];
      },
      waitForLauncherExit: async () => true,
      inCgroupTimeoutMs: 2_000,
      membershipTimeoutMs: 2_000,
    });
    const outcome = controller.authorizeExecution(REQUEST);
    await waitForSentCount(harness, 1);
    const event = createLauncherInCgroupEvent() as unknown as JsonValue;
    controller.receiveControlMessage(event);
    await new Promise((resolve) => setImmediate(resolve));
    controller.receiveControlMessage(event);
    resolveRead?.();
    const result = await outcome;

    expect(result).toMatchObject({
      outcome: "failed",
      code: "LAUNCHER_CONTROL_PROTOCOL_VIOLATION",
      // Membership was already read from the kernel before the extra frame
      // arrived, so the caller must terminate the whole Module cgroup.
      membershipVerified: true,
    });
    expect(harness.sent.map((m) => String((m as Record<string, unknown>).command))).toEqual([
      "configure",
      "exit",
    ]);
  });

  it("fails when the control descriptor closes before the in-cgroup event", async () => {
    const harness = createHarness();
    const outcome = harness.controller.authorizeExecution(REQUEST);
    await waitForSentCount(harness, 1);
    harness.controller.observeControlChannelClosed();
    const result = await outcome;

    expect(result).toMatchObject({
      outcome: "failed",
      code: "LAUNCHER_CONTROL_CHANNEL_CLOSED",
      membershipVerified: false,
    });
  });

  it("fails on a finite timeout when the launcher never reports in-cgroup", async () => {
    const harness = createHarness({ timeoutMs: 30 });
    const result = await harness.controller.authorizeExecution(REQUEST);

    expect(result).toMatchObject({
      outcome: "failed",
      code: "LAUNCHER_CONTROL_TIMEOUT",
      membershipVerified: false,
    });
    expect(harness.commandNames()).toEqual(["configure", "exit"]);
  });

  it("fails when the configure command cannot be written", async () => {
    const harness = createHarness({ sendFails: true });
    const result = await harness.controller.authorizeExecution(REQUEST);

    expect(result).toMatchObject({
      outcome: "failed",
      code: "LAUNCHER_CONTROL_SEND_FAILED",
      membershipVerified: false,
    });
    expect(harness.sent).toEqual([]);
  });

  it("rejects a second authorization attempt for the same launcher", async () => {
    const harness = createHarness({ timeoutMs: 30 });
    await harness.controller.authorizeExecution(REQUEST);
    await expect(harness.controller.authorizeExecution(REQUEST)).rejects.toThrow(
      /only once/,
    );
  });

  it("rejects a request whose values would not pass Core validation", async () => {
    const harness = createHarness();
    await expect(
      harness.controller.authorizeExecution({ ...REQUEST, moduleCgroupPath: "/tmp/mod-7" }),
    ).rejects.toThrow(/moduleCgroupPath/);
    await expect(
      harness.controller.authorizeExecution({ ...REQUEST, launcherProcessId: 0 }),
    ).rejects.toThrow(/launcherProcessId/);
  });
});
