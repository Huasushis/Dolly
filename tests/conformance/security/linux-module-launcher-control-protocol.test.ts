import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { FramedJsonChannel } from "../../../src/core/framed-json-channel.js";
import {
  LAUNCHER_CONTROL_MAX_FRAME_BYTES,
  LAUNCHER_PROTOCOL_VERSION,
  LauncherControlProtocolError,
  createLauncherConfigureCommand,
  createLauncherExecuteCommand,
  createLauncherExitCommand,
  createLauncherInCgroupEvent,
  parseLauncherConfigureCommand,
  parseLauncherControlCommand,
  parseLauncherExecuteCommand,
  parseLauncherInCgroupEvent,
} from "../../../src/adapters/linux-module-launcher/launcher-control-protocol.js";

const MODULE_CGROUP_PATH = "/sys/fs/cgroup/user.slice/dolly.service/mod-1";

function frame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const result = Buffer.allocUnsafe(4 + payload.byteLength);
  result.writeUInt32BE(payload.byteLength, 0);
  payload.copy(result, 4);
  return result;
}

function protocolErrorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof LauncherControlProtocolError) return error.code;
    return `unexpected error: ${String(error)}`;
  }
  return "no error thrown";
}

describe("launcher control protocol version 1 messages", () => {
  it("round-trips the four version 1 messages", () => {
    const configure = createLauncherConfigureCommand(MODULE_CGROUP_PATH, 256);
    expect(configure).toEqual({
      launcherProtocol: 1,
      command: "configure",
      moduleCgroupPath: MODULE_CGROUP_PATH,
      maxOpenFiles: 256,
    });
    expect(parseLauncherConfigureCommand(configure)).toEqual(configure);

    const execute = createLauncherExecuteCommand(
      "/usr/bin/node",
      ["/usr/bin/node", "/opt/dolly/extension/entrypoint.mjs"],
      { NODE_ENV: "production" },
    );
    expect(parseLauncherExecuteCommand(execute)).toEqual(execute);

    expect(parseLauncherControlCommand(createLauncherExitCommand())).toEqual({
      launcherProtocol: 1,
      command: "exit",
    });
    expect(parseLauncherInCgroupEvent(createLauncherInCgroupEvent())).toEqual({
      launcherProtocol: 1,
      event: "in-cgroup",
    });
    expect(LAUNCHER_PROTOCOL_VERSION).toBe(1);
  });

  it("rejects unknown fields, missing fields, and an unsupported version", () => {
    expect(
      protocolErrorCode(() =>
        parseLauncherConfigureCommand({
          launcherProtocol: 1,
          command: "configure",
          moduleCgroupPath: MODULE_CGROUP_PATH,
          maxOpenFiles: 256,
          extra: true,
        }),
      ),
    ).toBe("LAUNCHER_CONTROL_MESSAGE_INVALID");
    expect(
      protocolErrorCode(() =>
        parseLauncherConfigureCommand({
          launcherProtocol: 1,
          command: "configure",
          moduleCgroupPath: MODULE_CGROUP_PATH,
        }),
      ),
    ).toBe("LAUNCHER_CONTROL_MESSAGE_INVALID");
    expect(
      protocolErrorCode(() =>
        parseLauncherConfigureCommand({
          launcherProtocol: 2,
          command: "configure",
          moduleCgroupPath: MODULE_CGROUP_PATH,
          maxOpenFiles: 256,
        }),
      ),
    ).toBe("LAUNCHER_CONTROL_MESSAGE_INVALID");
    expect(protocolErrorCode(() => parseLauncherControlCommand({ command: "start" }))).toBe(
      "LAUNCHER_CONTROL_MESSAGE_INVALID",
    );
  });

  it("rejects a Module cgroup path that could redirect the cgroup.procs write", () => {
    for (const path of [
      "relative/mod-1",
      "/etc/passwd",
      "/sys/fs/cgroup",
      "/sys/fs/cgroup/../../etc/mod-1",
      "/sys/fs/cgroup/mod-1/",
      "/sys/fs/cgroup//mod-1",
      "/sys/fs/cgroup/mod\u00001",
    ]) {
      expect(
        protocolErrorCode(() => createLauncherConfigureCommand(path, 256)),
        `expected ${JSON.stringify(path)} to be rejected`,
      ).toBe("LAUNCHER_CONTROL_MESSAGE_INVALID");
    }
    expect(() =>
      createLauncherConfigureCommand("/sys/fs/cgroup/user.slice/dolly.service/mod-1", 256),
    ).not.toThrow();
  });

  it("rejects an open-file limit outside its accepted integer range", () => {
    for (const value of [0, 8, 1.5, -1, 1_048_577, Number.NaN, "256"]) {
      expect(
        protocolErrorCode(() =>
          createLauncherConfigureCommand(MODULE_CGROUP_PATH, value as number),
        ),
        `expected ${String(value)} to be rejected`,
      ).toBe("LAUNCHER_CONTROL_MESSAGE_INVALID");
    }
  });

  it("rejects an execute command whose program, arguments, or environment are unusable", () => {
    expect(
      protocolErrorCode(() => createLauncherExecuteCommand("node", ["node"], {})),
    ).toBe("LAUNCHER_CONTROL_MESSAGE_INVALID");
    expect(
      protocolErrorCode(() => createLauncherExecuteCommand("/usr/bin/node", [], {})),
    ).toBe("LAUNCHER_CONTROL_MESSAGE_INVALID");
    expect(
      protocolErrorCode(() =>
        createLauncherExecuteCommand("/usr/bin/node", ["/usr/bin/node"], {
          "BAD=NAME": "x",
        }),
      ),
    ).toBe("LAUNCHER_CONTROL_MESSAGE_INVALID");
    expect(
      protocolErrorCode(() =>
        createLauncherExecuteCommand("/usr/bin/node", ["/usr/bin/node"], {
          NODE_ENV: "produ\u0000ction",
        }),
      ),
    ).toBe("LAUNCHER_CONTROL_MESSAGE_INVALID");
    expect(
      protocolErrorCode(() =>
        createLauncherExecuteCommand("/usr/bin/node", ["/usr/bin/node"], {
          NODE_ENV: 7 as unknown as string,
        }),
      ),
    ).toBe("LAUNCHER_CONTROL_MESSAGE_INVALID");
  });

  it("rejects a command that would not fit the 4096-byte control frame", () => {
    expect(
      protocolErrorCode(() =>
        createLauncherExecuteCommand("/usr/bin/node", ["/usr/bin/node", "a".repeat(5_000)], {}),
      ),
    ).toBe("LAUNCHER_CONTROL_FRAME_TOO_LARGE");
  });
});

describe("launcher control descriptor framing", () => {
  it("accepts a version 1 frame split across writes and rejects an oversized frame", () => {
    const inbound = new PassThrough();
    const outbound = new PassThrough();
    const onMessage = vi.fn();
    const onError = vi.fn();
    const channel = new FramedJsonChannel(inbound, outbound, {
      maxFrameBytes: LAUNCHER_CONTROL_MAX_FRAME_BYTES,
      onMessage,
      onError,
    });

    const bytes = frame(JSON.stringify(createLauncherInCgroupEvent()));
    inbound.write(bytes.subarray(0, 3));
    inbound.write(bytes.subarray(3));
    expect(onMessage).toHaveBeenCalledWith({ launcherProtocol: 1, event: "in-cgroup" });
    expect(onError).not.toHaveBeenCalled();

    const oversized = Buffer.allocUnsafe(4);
    oversized.writeUInt32BE(LAUNCHER_CONTROL_MAX_FRAME_BYTES + 1, 0);
    inbound.write(oversized);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]?.code).toBe("FRAME_LENGTH_INVALID");
    channel.close();
  });

  it("rejects malformed JSON and duplicate keys on the control descriptor", () => {
    for (const text of ['{"launcherProtocol":1,', '{"event":"in-cgroup"', 'not json']) {
      const inbound = new PassThrough();
      const onError = vi.fn();
      const channel = new FramedJsonChannel(inbound, new PassThrough(), {
        maxFrameBytes: LAUNCHER_CONTROL_MAX_FRAME_BYTES,
        onMessage: vi.fn(),
        onError,
      });
      inbound.write(frame(text));
      expect(onError, `expected ${text} to be rejected`).toHaveBeenCalledTimes(1);
      channel.close();
    }

    const inbound = new PassThrough();
    const onError = vi.fn();
    const channel = new FramedJsonChannel(inbound, new PassThrough(), {
      maxFrameBytes: LAUNCHER_CONTROL_MAX_FRAME_BYTES,
      onMessage: vi.fn(),
      onError,
    });
    inbound.write(frame('{"launcherProtocol":1,"launcherProtocol":1,"event":"in-cgroup"}'));
    expect(onError).toHaveBeenCalledTimes(1);
    channel.close();
  });

  it("rejects an in-cgroup event carrying an unexpected field", () => {
    expect(
      protocolErrorCode(() =>
        parseLauncherInCgroupEvent({
          launcherProtocol: 1,
          event: "in-cgroup",
          processId: 42,
        }),
      ),
    ).toBe("LAUNCHER_CONTROL_MESSAGE_INVALID");
    expect(
      protocolErrorCode(() =>
        parseLauncherInCgroupEvent({ launcherProtocol: 1, event: "executing" }),
      ),
    ).toBe("LAUNCHER_CONTROL_MESSAGE_INVALID");
  });
});
