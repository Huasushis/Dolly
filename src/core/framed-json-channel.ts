import { TextDecoder } from "node:util";
import type { Readable, Writable } from "node:stream";
import {
  canonicalizeJson,
  type JsonValue,
} from "./canonical-json.js";
import { parseStrictJsonText } from "./strict-json.js";

export type FramedJsonErrorCode =
  | "FRAME_CONFIG_INVALID"
  | "FRAME_LENGTH_INVALID"
  | "FRAME_UTF8_INVALID"
  | "FRAME_TOO_DEEP"
  | "FRAME_JSON_INVALID"
  | "FRAME_BACKPRESSURE_LIMIT"
  | "FRAME_CHANNEL_CLOSED"
  | "FRAME_TRANSPORT_FAILED";

/**
 * V1 Host default for the negotiated complete-frame `max_frame_nesting_depth`.
 * The top-level JSON-RPC object counts as depth 1 and each directly nested
 * object or array increases the depth by 1. Independent of the semantic
 * `max_json_nesting_depth` (64) which this module does not enforce.
 */
export const DEFAULT_MAX_FRAME_NESTING_DEPTH = 96;

export class FramedJsonError extends Error {
  constructor(readonly code: FramedJsonErrorCode, message: string) {
    super(message);
    this.name = "FramedJsonError";
  }
}

/**
 * Byte-level, iterative measurement of complete-frame JSON container depth.
 * Counts every `{` or `[` in descent order as +1 and every `}` or `]` as -1,
 * starting the top-level container at 1. Structural bytes inside a JSON string
 * are ignored, honoring `\"` and `\\` escapes; UTF-8 lead and continuation
 * bytes (0x80-0xFF) cannot collide with ASCII structural bytes and are skipped.
 * Returns true as soon as depth exceeds `limit`. Never parses the payload and
 * never recurses, so it poses no stack risk for hostile framing.
 */
function frameDepthExceeds(bytes: Buffer, limit: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let offset = 0; offset < bytes.byteLength; offset += 1) {
    const byte = bytes[offset];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (byte === 0x5c /* backslash */) {
        escaped = true;
      } else if (byte === 0x22 /* double quote */) {
        inString = false;
      }
      continue;
    }
    if (byte === 0x22) {
      inString = true;
      continue;
    }
    if (byte === 0x7b /* { */ || byte === 0x5b /* [ */) {
      depth += 1;
      if (depth > limit) return true;
      continue;
    }
    if (byte === 0x7d /* } */ || byte === 0x5d /* ] */) {
      if (depth > 0) depth -= 1;
      continue;
    }
    // Whitespace, structural separators, number/literal bytes, and UTF-8
    // multi-byte sequences are not container delimiters.
  }
  return false;
}

export interface FramedJsonChannelOptions {
  readonly maxFrameBytes: number;
  readonly maxQueuedWriteBytes?: number;
  readonly onMessage: (message: JsonValue) => void;
  readonly onError: (error: FramedJsonError) => void;
  readonly onEnd?: () => void;
}

export class FramedJsonChannel {
  readonly #readable: Readable;
  readonly #writable: Writable;
  readonly #maxFrameBytes: number;
  readonly #maxQueuedWriteBytes: number;
  readonly #onMessage: FramedJsonChannelOptions["onMessage"];
  readonly #onError: FramedJsonChannelOptions["onError"];
  readonly #onEnd?: FramedJsonChannelOptions["onEnd"];
  readonly #header = Buffer.allocUnsafe(4);
  #headerOffset = 0;
  #body?: Buffer;
  #bodyOffset = 0;
  #closed = false;
  #failed = false;
  #writeTail: Promise<void> = Promise.resolve();
  #queuedWriteBytes = 0;

  constructor(readable: Readable, writable: Writable, options: FramedJsonChannelOptions) {
    if (!Number.isSafeInteger(options.maxFrameBytes) || options.maxFrameBytes < 2) {
      throw new FramedJsonError(
        "FRAME_CONFIG_INVALID",
        "maxFrameBytes must be a safe integer of at least two bytes",
      );
    }
    this.#readable = readable;
    this.#writable = writable;
    this.#maxFrameBytes = options.maxFrameBytes;
    this.#maxQueuedWriteBytes = options.maxQueuedWriteBytes ?? options.maxFrameBytes * 4 + 16;
    if (
      !Number.isSafeInteger(this.#maxQueuedWriteBytes) ||
      this.#maxQueuedWriteBytes < options.maxFrameBytes + 4
    ) {
      throw new FramedJsonError(
        "FRAME_CONFIG_INVALID",
        "maxQueuedWriteBytes must fit at least one maximum-size frame",
      );
    }
    this.#onMessage = options.onMessage;
    this.#onError = options.onError;
    this.#onEnd = options.onEnd;
    readable.on("data", this.#handleData);
    readable.once("error", this.#handleReadError);
    readable.once("end", this.#handleEnd);
    writable.once("error", this.#handleWriteError);
  }

  get closed(): boolean {
    return this.#closed;
  }

  send(value: JsonValue): Promise<void> {
    if (this.#closed || this.#failed) {
      return Promise.reject(
        new FramedJsonError("FRAME_CHANNEL_CLOSED", "Framed JSON channel is closed"),
      );
    }
    let payload: Buffer;
    try {
      payload = Buffer.from(canonicalizeJson(value), "utf8");
    } catch {
      return Promise.reject(
        new FramedJsonError("FRAME_JSON_INVALID", "Outbound frame is not closed JSON"),
      );
    }
    if (payload.byteLength > this.#maxFrameBytes) {
      return Promise.reject(
        new FramedJsonError("FRAME_LENGTH_INVALID", "Outbound frame exceeds its byte limit"),
      );
    }
    const frame = Buffer.allocUnsafe(4 + payload.byteLength);
    frame.writeUInt32BE(payload.byteLength, 0);
    payload.copy(frame, 4);
    if (this.#queuedWriteBytes + frame.byteLength > this.#maxQueuedWriteBytes) {
      return Promise.reject(
        new FramedJsonError(
          "FRAME_BACKPRESSURE_LIMIT",
          "Outbound frame queue exceeds its byte limit",
        ),
      );
    }
    this.#queuedWriteBytes += frame.byteLength;
    const write = this.#writeTail
      .then(() => this.#write(frame))
      .finally(() => {
        this.#queuedWriteBytes -= frame.byteLength;
      });
    this.#writeTail = write.catch(() => undefined);
    return write;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    if (!this.#writable.destroyed && !this.#writable.writableEnded) this.#writable.end();
  }

  readonly #handleData = (chunkValue: Buffer | string): void => {
    if (this.#closed || this.#failed) return;
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    let offset = 0;
    while (offset < chunk.byteLength && !this.#failed) {
      if (!this.#body) {
        const headerBytes = Math.min(4 - this.#headerOffset, chunk.byteLength - offset);
        chunk.copy(this.#header, this.#headerOffset, offset, offset + headerBytes);
        this.#headerOffset += headerBytes;
        offset += headerBytes;
        if (this.#headerOffset < 4) continue;
        const length = this.#header.readUInt32BE(0);
        this.#headerOffset = 0;
        if (length < 2 || length > this.#maxFrameBytes) {
          this.#fail(
            new FramedJsonError(
              "FRAME_LENGTH_INVALID",
              "Inbound frame length is zero, incomplete, or over limit",
            ),
          );
          return;
        }
        this.#body = Buffer.allocUnsafe(length);
        this.#bodyOffset = 0;
      }

      const bodyBytes = Math.min(
        this.#body.byteLength - this.#bodyOffset,
        chunk.byteLength - offset,
      );
      chunk.copy(this.#body, this.#bodyOffset, offset, offset + bodyBytes);
      this.#bodyOffset += bodyBytes;
      offset += bodyBytes;
      if (this.#bodyOffset !== this.#body.byteLength) continue;

      const complete = this.#body;
      this.#body = undefined;
      this.#bodyOffset = 0;
      this.#decode(complete);
    }
  };

  readonly #handleReadError = (): void => {
    this.#fail(new FramedJsonError("FRAME_TRANSPORT_FAILED", "Frame input transport failed"));
  };

  readonly #handleWriteError = (): void => {
    this.#fail(new FramedJsonError("FRAME_TRANSPORT_FAILED", "Frame output transport failed"));
  };

  readonly #handleEnd = (): void => {
    if (this.#closed || this.#failed) return;
    if (this.#headerOffset !== 0 || this.#body !== undefined) {
      this.#fail(
        new FramedJsonError("FRAME_LENGTH_INVALID", "Frame input ended mid-frame"),
      );
      return;
    }
    this.#closed = true;
    this.#detach();
    this.#onEnd?.();
  };

  #decode(bytes: Buffer): void {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      this.#fail(new FramedJsonError("FRAME_UTF8_INVALID", "Inbound frame is not UTF-8"));
      return;
    }
    // Measure container depth on the raw payload before any JSON.parse so an
    // over-deep frame is rejected without parsing or echoing its payload. The
    // scanner is iterative and runs in linear time.
    if (frameDepthExceeds(bytes, DEFAULT_MAX_FRAME_NESTING_DEPTH)) {
      this.#fail(
        new FramedJsonError(
          "FRAME_TOO_DEEP",
          "Inbound frame exceeds the negotiated complete-frame nesting depth",
        ),
      );
      return;
    }
    let value: JsonValue;
    try {
      value = parseStrictJsonText(text, {
        maxBytes: this.#maxFrameBytes,
        maxDepth: DEFAULT_MAX_FRAME_NESTING_DEPTH,
      });
    } catch {
      this.#fail(
        new FramedJsonError("FRAME_JSON_INVALID", "Inbound frame is not closed JSON"),
      );
      return;
    }
    this.#onMessage(value);
  }

  #write(frame: Buffer): Promise<void> {
    if (this.#closed || this.#failed) {
      return Promise.reject(
        new FramedJsonError("FRAME_CHANNEL_CLOSED", "Framed JSON channel is closed"),
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.#writable.write(frame, (error) => {
        if (error) {
          reject(new FramedJsonError("FRAME_TRANSPORT_FAILED", "Frame write failed"));
        } else {
          resolve();
        }
      });
    });
  }

  #fail(error: FramedJsonError): void {
    if (this.#failed || this.#closed) return;
    this.#failed = true;
    this.#detach();
    this.#onError(error);
  }

  #detach(): void {
    this.#readable.off("data", this.#handleData);
    this.#readable.off("error", this.#handleReadError);
    this.#readable.off("end", this.#handleEnd);
    this.#writable.off("error", this.#handleWriteError);
  }
}
