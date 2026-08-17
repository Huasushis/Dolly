/**
 * NDJSON (newline-delimited JSON-RPC) transport over a stdio child process.
 *
 * MCP `2025-06-18` stdio framing is one JSON-RPC message per line terminated
 * by `\n`. This is deliberately NOT the Dolly Extension `FramedJsonChannel`
 * (4-byte big-endian length prefix), which is a different protocol.
 *
 * This module owns only the byte<->message boundary. Protocol semantics
 * (request/response correlation, lifecycle) live in `session.ts`.
 */

import type { ChildProcess } from "node:child_process";
import { assertJsonValue, type JsonValue } from "../canonical-json.js";

/** A parsed JSON-RPC message envelope as a `JsonValue`. */
export type JsonRpcMessage = JsonValue;

/** A writer that serializes one message as a single NDJSON line to the child's
 * stdin. */
export interface StdioMessageWriter {
  /** Serializes `message` with `JSON.stringify` and writes it followed by
   * `\n`. Throws if the child's stdin is no longer writable. */
  write(message: JsonValue): void;
  /** Closes the child's stdin. */
  close(): void;
}

/** A reader that resolves with the next complete NDJSON line's parsed JSON
 * value, or rejects on malformed JSON or stream end. */
export interface StdioMessageReader {
  /** Waits for the next complete line. Resolves with the parsed `JsonValue`.
   * Rejects with `StdioReadError` if the line is not valid JSON, if the stream
   * ends before a full line, or if the child exits. */
  read(): Promise<JsonValue>;
  /** Stops listening. After this, pending `read()` promises reject. */
  stop(): void;
}

/** Error from `StdioMessageReader.read()` on malformed input or stream end. */
export class StdioReadError extends Error {
  constructor(
    readonly kind: "malformed" | "closed" | "exit",
    message: string,
  ) {
    super(message);
    this.name = "StdioReadError";
  }
}

/** Creates a writer over the child's stdin. */
export function createStdioWriter(child: ChildProcess): StdioMessageWriter {
  const stdin = child.stdin;
  if (stdin === null) {
    throw new Error("child has no stdin (stdio must include a pipe for fd 0)");
  }
  return {
    write(message: JsonValue): void {
      if (stdin.destroyed || !stdin.writable) {
        throw new Error("child stdin is not writable");
      }
      stdin.write(`${JSON.stringify(message)}\n`);
    },
    close(): void {
      if (!stdin.destroyed) {
        stdin.end();
      }
    },
  };
}

/**
 * Creates a reader over the child's stdout. The reader buffers partial lines
 * and resolves one `read()` per complete newline-terminated line. It asserts
 * each parsed value is a `JsonValue`.
 *
 * The reader attaches its listeners immediately so lines arriving before the
 * first `read()` are buffered.
 */
export function createStdioReader(child: ChildProcess): StdioMessageReader {
  const stdout = child.stdout;
  if (stdout === null) {
    throw new Error("child has no stdout (stdio must include a pipe for fd 1)");
  }
  stdout.setEncoding("utf8");

  let buffer = "";
  let closed = false;
  let exited = false;
  const lineQueue: string[] = [];
  const waiters: Array<{
    resolve: (value: JsonValue) => void;
    reject: (error: StdioReadError) => void;
  }> = [];

  function drainOrReject(error: StdioReadError): void {
    while (waiters.length > 0) {
      const waiter = waiters.shift()!;
      waiter.reject(error);
    }
  }

  function processBuffer(): void {
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      lineQueue.push(line);
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        const next = lineQueue.shift()!;
        deliver(waiter, next);
      }
    }
  }

  function deliver(
    waiter: { resolve: (value: JsonValue) => void; reject: (error: StdioReadError) => void },
    line: string,
  ): void {
    if (line.trim() === "") {
      // Skip blank lines (e.g. trailing newline) and serve the next line.
      // We do not expect blank lines in well-formed MCP traffic, but
      // skipping is safer than rejecting.
      // However, there is no "next line" available synchronously here, so
      // re-queue the waiter to wait for the next line.
      waiters.unshift(waiter);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      assertJsonValue(parsed);
      waiter.resolve(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      waiter.reject(new StdioReadError("malformed", `malformed JSON line: ${message}`));
    }
  }

  const onData = (chunk: string): void => {
    buffer += chunk;
    processBuffer();
  };
  const onEnd = (): void => {
    closed = true;
    if (buffer.length > 0 && buffer.trim() !== "") {
      // A trailing line without newline: deliver it if a waiter exists.
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        const last = buffer;
        buffer = "";
        deliver(waiter, last);
      }
    }
    // Any remaining waiters reject: stream ended.
    drainOrReject(new StdioReadError("closed", "stdout stream ended before a complete line"));
  };
  const onError = (): void => {
    drainOrReject(new StdioReadError("closed", "stdout stream error"));
  };
  const onExit = (): void => {
    exited = true;
    // If the stream is still open, the 'end' event will fire shortly. Only
    // reject if there are pending waiters and the stream has already ended
    // or will not deliver more data.
    if (closed) {
      drainOrReject(new StdioReadError("exit", "child exited before a complete line"));
    }
  };

  stdout.on("data", onData);
  stdout.on("end", onEnd);
  stdout.on("error", onError);
  child.on("exit", onExit);

  return {
    read(): Promise<JsonValue> {
      return new Promise<JsonValue>((resolve, reject) => {
        if (exited && lineQueue.length === 0) {
          reject(new StdioReadError("exit", "child exited before a complete line"));
          return;
        }
        const next = lineQueue.shift();
        if (next !== undefined) {
          deliver({ resolve, reject }, next);
        } else {
          waiters.push({ resolve, reject });
        }
      });
    },
    stop(): void {
      closed = true;
      drainOrReject(new StdioReadError("closed", "reader stopped"));
      stdout.removeListener("data", onData);
      stdout.removeListener("end", onEnd);
      stdout.removeListener("error", onError);
      child.removeListener("exit", onExit);
    },
  };
}
