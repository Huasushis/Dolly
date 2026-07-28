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

describe("extension process protocol length-prefixed JSON framing", () => {
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
    const inbound = new PassThrough();
    const outbound = new PassThrough();
    const onMessage = vi.fn();
    const onError = vi.fn();
    const channel = new FramedJsonChannel(inbound, outbound, {
      maxFrameBytes: 1_024,
      onMessage,
      onError,
    });
    inbound.write(frame('{"jsonrpc":"2.0","id":"one","id":"forged"}'));
    expect(onMessage).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "FRAME_JSON_INVALID" }),
    );
    channel.close();
  });

  it("rejects an over-limit length from the four-byte header without waiting for a body", () => {
    const inbound = new PassThrough();
    const outbound = new PassThrough();
    const onError = vi.fn();
    const channel = new FramedJsonChannel(inbound, outbound, {
      maxFrameBytes: 16,
      onMessage: vi.fn(),
      onError,
    });
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(17, 0);
    inbound.write(header);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "FRAME_LENGTH_INVALID" }),
    );
    channel.close();
  });
});
