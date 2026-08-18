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
  | "FRAME_JSON_INVALID"
  | "FRAME_BACKPRESSURE_LIMIT"
  | "FRAME_CHANNEL_CLOSED"
  | "FRAME_TRANSPORT_FAILED";

export class FramedJsonError extends Error {
  constructor(readonly code: FramedJsonErrorCode, message: string) {
    super(message);
    this.name = "FramedJsonError";
  }
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
    let value: JsonValue;
    try {
      value = parseStrictJsonText(text, {
        maxBytes: this.#maxFrameBytes,
        maxDepth: 96,
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
