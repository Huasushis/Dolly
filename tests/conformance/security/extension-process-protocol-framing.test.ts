import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  FramedJsonChannel,
  type FramedJsonError,
} from "../../../src/core/framed-json-channel.js";

function frame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const result = Buffer.allocUnsafe(4 + payload.byteLength);
  result.writeUInt32BE(payload.byteLength, 0);
  payload.copy(result, 4);
  return result;
}

function exercise(text: string, maxFrameBytes = 1_024) {
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const messages: unknown[] = [];
  const errors: FramedJsonError[] = [];
  const channel = new FramedJsonChannel(inbound, outbound, {
    maxFrameBytes,
    onMessage: (message) => messages.push(message),
    onError: (error) => errors.push(error),
  });
  inbound.write(frame(text));
  return { channel, inbound, outbound, messages, errors };
}

describe("extension process protocol length-prefixed JSON framing (TST-PROTO-002 depth)", () => {
  it("parses fragmented and adjacent frames without newline assumptions", async () => {
    const inbound = new PassThrough();
    const outbound = new PassThrough();
    const messages: unknown[] = [];
    const errors: FramedJsonError[] = [];
    const channel = new FramedJsonChannel(inbound, outbound, {
      maxFrameBytes: 1_024,
      onMessage: (message) => messages.push(message),
      onError: (error) => errors.push(error),
    });
    const bytes = Buffer.concat([frame('{"one":1}'), frame('[true,"two"]')]);
    inbound.write(bytes.subarray(0, 2));
    inbound.write(bytes.subarray(2, 9));
    inbound.write(bytes.subarray(9));
    expect(messages).toEqual([{ one: 1 }, [true, "two"]]);
    expect(errors).toEqual([]);
    channel.close();
  });

  it("rejects duplicate object keys before JSON.parse can overwrite them", () => {
    const { inbound, messages, errors } = exercise(
      '{"jsonrpc":"2.0","a":1,"a":2}',
    );
    expect(messages).toEqual([]);
    expect(errors.map((error) => error.code)).toEqual(["FRAME_JSON_INVALID"]);
    inbound.end();
  });

  it("accepts a complete frame at the 96-level limit, top-level container counted as 1", () => {
    const { inbound, messages, errors } = exercise(
      "[".repeat(96) + "1" + "]".repeat(96),
    );
    expect(messages.length).toBe(1);
    expect(errors).toEqual([]);
    inbound.end();
  });

  it("rejects an array frame nested to depth 97 with FRAME_TOO_DEEP and latches the connection", () => {
    const { channel, inbound, outbound, messages, errors } = exercise(
      "[".repeat(97) + "1" + "]".repeat(97),
    );
    expect(messages).toEqual([]);
    expect(errors.map((error) => error.code)).toEqual(["FRAME_TOO_DEEP"]);
    // The over-depth rejection must not leak payload bytes onto the stream.
    expect(outbound.readableLength).toBe(0);
    // A subsequent valid frame cannot recover the latched connection.
    inbound.write(frame('{"jsonrpc":"2.0","id":"ok","method":"ping"}'));
    expect(messages).toEqual([]);
    expect(outbound.readableLength).toBe(0);
    channel.close();
  });

  it("rejects an object frame nested to depth 97 with FRAME_TOO_DEEP", () => {
    const { inbound, messages, errors } = exercise(
      "[".repeat(96) + '[{"jsonrpc":"2.0","id":"x","params":{}}]' + "]".repeat(96),
    );
    expect(messages).toEqual([]);
    expect(errors.map((error) => error.code)).toEqual(["FRAME_TOO_DEEP"]);
  });

  it("returns FRAME_TOO_DEEP when arrays and objects both exceed 96", () => {
    const { inbound, messages, errors } = exercise(
      "[".repeat(95) + '{"jsonrpc":"2.0","id":"x","params":{}}' + "]".repeat(95),
    );
    expect(messages).toEqual([]);
    expect(errors.map((error) => error.code)).toEqual(["FRAME_TOO_DEEP"]);
    inbound.end();
  });

  it("ignores brackets, escaped quotes, and backslashes inside strings when measuring depth", () => {
    // Structural depth is 2: string content carries many brackets and both
    // escape forms, none of which count as containers.
    const payload = JSON.stringify([
      "[[[{{{" + "[\"{[\\\"escaped\\\"]}\"" + "]]]}}}",
      "[{]}",
      '\\"\\\\[',
    ]);
    const inbound = new PassThrough();
    const messages: unknown[] = [];
    const errors: FramedJsonError[] = [];
    void errors;
    const outbound = new PassThrough();
    const channel = new FramedJsonChannel(inbound, outbound, {
      maxFrameBytes: 1_024,
      onMessage: (message) => messages.push(message),
      onError: vi.fn(),
    });
    inbound.write(frame(payload));
    expect(messages.length).toBe(1);
    channel.close();
  });

  it("accepts UTF-8 multi-byte characters inside strings without misreading structural bytes", () => {
    const { inbound, messages, errors } = exercise(
      JSON.stringify({ key: '中文[你好]{{{"quoted"}]]]' }),
    );
    expect(messages.length).toBe(1);
    expect(errors).toEqual([]);
    inbound.end();
  });

  it("does not echo a payload nor emit further frames after an over-deep rejection", async () => {
    const { channel, inbound, outbound, messages, errors } = exercise(
      "[".repeat(97) + '{"jsonrpc":"2.0","id":"deep","method":"x"}' + "]".repeat(97),
      // The payload itself is small; nesting, not bytes, exceeds the limit.
      64 * 1024,
    );
    expect(messages).toEqual([]);
    expect(errors.map((error) => error.code)).toEqual(["FRAME_TOO_DEEP"]);
    expect(outbound.readableLength).toBe(0);
    // The channel is latched: a later well-formed frame is dropped and send()
    // reports the channel unusable rather than emitting an extension message.
    inbound.write(frame('{"jsonrpc":"2.0","id":"ok","method":"ping"}'));
    expect(messages).toEqual([]);
    expect(outbound.readableLength).toBe(0);
    expect(channel.closed).toBe(false);
    await expect(
      channel.send({ jsonrpc: "2.0", id: "s", method: "ping" }),
    ).rejects.toMatchObject({ code: "FRAME_CHANNEL_CLOSED" });
    channel.close();
  });

  it("rejects an over-limit length from the four-byte header before the body arrives", () => {
    const { channel, inbound, outbound, messages, errors } = exercise(
      "x".repeat(20),
      16,
    );
    expect(messages).toEqual([]);
    expect(errors.map((error) => error.code)).toEqual(["FRAME_LENGTH_INVALID"]);
    expect(outbound.readableLength).toBe(0);
    channel.close();
  });

  it("rejects non-UTF8 bytes with FRAME_UTF8_INVALID before any depth handling", () => {
    const payload = Buffer.concat([
      Buffer.from('[{"jsonrpc":"2.0","id":"u","method":"ping","s":"'),
      Buffer.from([0xff]),
      Buffer.from('"}]'),
    ]);
    const inboundBytes = Buffer.allocUnsafe(4 + payload.byteLength);
    inboundBytes.writeUInt32BE(payload.byteLength, 0);
    payload.copy(inboundBytes, 4);
    const inbound = new PassThrough();
    const outbound = new PassThrough();
    const errors: FramedJsonError[] = [];
    const channel = new FramedJsonChannel(inbound, outbound, {
      maxFrameBytes: 64 * 1024,
      onMessage: vi.fn(),
      onError: (error) => errors.push(error),
    });
    inbound.write(inboundBytes);
    expect(errors.map((error) => error.code)).toEqual(["FRAME_UTF8_INVALID"]);
    expect(outbound.readableLength).toBe(0);
    channel.close();
  });
});
