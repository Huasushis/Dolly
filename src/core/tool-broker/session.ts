/**
 * Tool Broker session: the exact MCP `2025-06-18` initialize/initialized
 * handshake state machine over a stdio child.
 *
 * Lifecycle: `Preparing` -> `Ready` | `Quarantined` -> `Stopped`.
 *
 * The session sends `initialize` with a deterministic request id (starting at
 * 1), waits for the response, requires the response to select exactly
 * `2025-06-18`, then sends `notifications/initialized`. It MUST NOT fall
 * forward to another version. On any failure it quarantines the generation and
 * tears down the exact child.
 *
 * Out-of-order `notifications/initialized` before the initialize response does
 * not satisfy the response wait. A duplicate initialize response after the
 * first is ignored (the first response already settled the handshake).
 *
 * After a successful handshake the generation stays alive (stdin is not
 * closed) and the host may send exactly one post-handshake request at a time.
 * `ping()` sends a `ping` with the next monotonic id (2 on first call),
 * requires an exact-correlated closed result, and quarantines on any protocol
 * violation, timeout, or child exit during the request.
 */

import type { ChildProcess } from "node:child_process";
import {
  CLIENT_INFO,
  MCP_PROTOCOL_VERSION,
  type AdaptedToolBrokerServer,
  type PrepareResult,
  type StdioTransportConfig,
  type ToolBrokerErrorCode,
  type ToolBrokerServerConfig,
  type ToolBrokerServerState,
} from "./types.js";
import { deepFreeze, isJsonObject, type JsonValue } from "../canonical-json.js";
import { createStdioReader, createStdioWriter, StdioReadError, type StdioMessageReader, type StdioMessageWriter } from "./stdio-transport.js";

/** Bounded wall-clock wait for SIGTERM before escalating to SIGKILL, in ms. */
const TEARDOWN_GRACE_MS = 500;

/** Default bounded wall-clock wait for a post-handshake request response,
 * used when a `requestTimeoutMs` is not present on a directly-constructed
 * config (the same default `parseToolBrokerConfig` resolves). */
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

/**
 * Module-private identity store of every `PrepareResult` minted by
 * `prepare()`. `prepare()` is the sole producer of Ready evidence;
 * `adaptToolBrokerServer` requires the exact minted object so a forged,
 * copied, or spread result can never project generation authority.
 */
const MINTED_PREPARE_RESULTS = new WeakSet<object>();

/**
 * Registers a `PrepareResult` in the identity store and returns it. The result
 * is frozen before registration so the minted identity can never be mutated
 * into a forged state or altered generation: `adaptToolBrokerServer` reads
 * authority from the same frozen object it identity-checks.
 */
function mintPrepareResult(result: PrepareResult): PrepareResult {
  Object.freeze(result);
  MINTED_PREPARE_RESULTS.add(result);
  return result;
}

/** Permitted top-level fields of an initialize `result` object. */
const INITIALIZED_RESULT_KEYS = ["protocolVersion", "capabilities", "serverInfo", "_meta"] as const;
/** Permitted top-level fields of a JSON-RPC response envelope. */
const RESPONSE_ENVELOPE_KEYS = ["jsonrpc", "id", "result", "error", "_meta"] as const;
/** Validates an initialize response result object. Returns the protocolVersion
 * string on success; throws a `ToolBrokerSessionError` otherwise. */
function assertInitializeResult(result: JsonValue): string {
  if (!isJsonObject(result)) {
    throw new ToolBrokerSessionError("TOOL_BROKER_HANDSHAKE_MALFORMED", "initialize result is not an object");
  }
  // Reject unknown top-level fields in the result object (only protocolVersion,
  // capabilities, serverInfo, and optional _meta are permitted).
  for (const key of Object.keys(result)) {
    if (!(INITIALIZED_RESULT_KEYS as readonly string[]).includes(key)) {
      throw new ToolBrokerSessionError("TOOL_BROKER_HANDSHAKE_MALFORMED", `initialize result has unknown field "${key}"`);
    }
  }

  const { protocolVersion, capabilities, serverInfo } = result;
  if (typeof protocolVersion !== "string") {
    throw new ToolBrokerSessionError("TOOL_BROKER_HANDSHAKE_MALFORMED", "initialize result.protocolVersion is not a string");
  }
  if (capabilities === undefined || !isJsonObject(capabilities)) {
    throw new ToolBrokerSessionError("TOOL_BROKER_HANDSHAKE_MALFORMED", "initialize result.capabilities is not an object");
  }
  if (serverInfo === undefined || !isJsonObject(serverInfo)) {
    throw new ToolBrokerSessionError("TOOL_BROKER_HANDSHAKE_MALFORMED", "initialize result.serverInfo is not an object");
  }
  // serverInfo must have name and version strings.
  if (typeof (serverInfo as Record<string, unknown>).name !== "string" || typeof (serverInfo as Record<string, unknown>).version !== "string") {
    throw new ToolBrokerSessionError("TOOL_BROKER_HANDSHAKE_MALFORMED", "initialize result.serverInfo must have string name and version");
  }
  return protocolVersion;
}

/** Validates a JSON-RPC response envelope: must have jsonrpc "2.0", a numeric
 * id matching the expected id, and a `result` (not `error`). Returns the
 * `result` value. */
function assertResponseEnvelope(message: JsonValue, expectedId: number): JsonValue {
  if (!isJsonObject(message)) {
    throw new ToolBrokerSessionError("TOOL_BROKER_HANDSHAKE_MALFORMED", "response is not an object");
  }
  for (const key of Object.keys(message)) {
    if (!(RESPONSE_ENVELOPE_KEYS as readonly string[]).includes(key)) {
      throw new ToolBrokerSessionError("TOOL_BROKER_HANDSHAKE_MALFORMED", `response has unknown field "${key}"`);
    }
  }
  const id = (message as Record<string, unknown>).id;
  if (typeof id !== "number" || id !== expectedId) {
    throw new ToolBrokerSessionError("TOOL_BROKER_HANDSHAKE_MALFORMED", `response.id must be ${expectedId}`);
  }
  if ((message as Record<string, unknown>).error !== undefined) {
    throw new ToolBrokerSessionError("TOOL_BROKER_HANDSHAKE_MALFORMED", "initialize returned a JSON-RPC error");
  }
  if (!("result" in message)) {
    throw new ToolBrokerSessionError("TOOL_BROKER_HANDSHAKE_MALFORMED", "response has no result");
  }
  return (message as Record<string, unknown>).result as JsonValue;
}

/** Permitted top-level fields of a ping `result` object: a closed object
 * (nothing) or the optional `_meta` field. */
const PING_RESULT_KEYS = ["_meta"] as const;

/** Validates a ping response `result`: it must be an object with no fields
 * except the optional `_meta` (an object). Throws `ToolBrokerSessionError`
 * with `TOOL_BROKER_PROTOCOL_FAILURE` for an unknown field, a non-object
 * result, or a malformed `_meta`. */
function assertPingResult(result: JsonValue): void {
  if (!isJsonObject(result)) {
    throw new ToolBrokerSessionError("TOOL_BROKER_PROTOCOL_FAILURE", "ping result is not an object");
  }
  for (const key of Object.keys(result)) {
    if (!(PING_RESULT_KEYS as readonly string[]).includes(key)) {
      throw new ToolBrokerSessionError("TOOL_BROKER_PROTOCOL_FAILURE", `ping result has unknown field "${key}"`);
    }
  }
  const meta = result._meta;
  if (meta !== undefined && !isJsonObject(meta)) {
    throw new ToolBrokerSessionError("TOOL_BROKER_PROTOCOL_FAILURE", "ping result._meta must be an object");
  }
}

/** Internal error carrying a public `ToolBrokerErrorCode`. */
export class ToolBrokerSessionError extends Error {
  constructor(readonly code: ToolBrokerErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ToolBrokerSessionError";
  }
}

/** A single broker server generation session. Owns one child process and its
 * transport. Not reusable: after `prepare()` settles or `stop()` completes,
 * the session is terminal. */
export class ToolBrokerSession {
  #state: ToolBrokerServerState = "Preparing";
  #generation: number;
  #child: ChildProcess;
  #reader: StdioMessageReader;
  #writer: StdioMessageWriter;
  #config: ToolBrokerServerConfig;
  #nextRequestId = 1;
  #requestTimeoutMs: number;
  #pingInFlight = false;
  #stopped = false;
  #prepareSettled = false;
  #prepareResult: PrepareResult | undefined;
  #childExitObserved = false;

  constructor(
    config: ToolBrokerServerConfig,
    generation: number,
    child: ChildProcess,
  ) {
    this.#config = config;
    this.#generation = generation;
    this.#child = child;
    this.#reader = createStdioReader(child);
    this.#writer = createStdioWriter(child);
    this.#requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get state(): ToolBrokerServerState {
    return this.#state;
  }

  get toolServerId(): string {
    return this.#config.serverId;
  }

  get toolServerGeneration(): number {
    return this.#generation;
  }

  /**
   * Drives the handshake to completion. Returns a `Ready` result on success or
   * a `Quarantined` result with an error code on failure. After settling,
   * tears down the child if the result is not `Ready`. Idempotent: a second
   * call returns the first result.
   */
  async prepare(): Promise<PrepareResult> {
    if (this.#prepareResult !== undefined) {
      return this.#prepareResult;
    }
    if (this.#prepareSettled) {
      // Concurrent second call while the handshake is in flight: return a
      // minted, non-Ready current result instead of starting a second
      // handshake. `adaptToolBrokerServer` rejects it because the identity is
      // minted but not Ready.
      return this.#currentResult();
    }
    this.#prepareSettled = true;

    const initializeId = this.#nextRequestId;
    const initializeRequest: JsonValue = {
      jsonrpc: "2.0",
      id: initializeId,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_INFO.name, version: CLIENT_INFO.version },
      },
    };

    try {
      this.#writer.write(initializeRequest);
      // initialize consumed id 1; the next post-handshake request id is 2.
      this.#nextRequestId += 1;

      // Wait for the initialize response with a timeout. A child exit or
      // stream end before the response is a child-exited failure; a timeout
      // is a startup-timeout failure.
      const response = await this.#readResponseOrTimeout(initializeId);
      const result = assertResponseEnvelope(response, initializeId);
      const serverProtocolVersion = assertInitializeResult(result);

      if (serverProtocolVersion !== MCP_PROTOCOL_VERSION) {
        throw new ToolBrokerSessionError(
          "TOOL_BROKER_PROTOCOL_VERSION_MISMATCH",
          `server selected protocol version ${JSON.stringify(serverProtocolVersion)}, expected ${JSON.stringify(MCP_PROTOCOL_VERSION)}`,
        );
      }

      // Send notifications/initialized. No id, no params.
      const initializedNotification: JsonValue = {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      };
      this.#writer.write(initializedNotification);

      this.#state = "Ready";
      // Observe the child only from this point: a termination after a Ready
      // generation with no request in flight must not leave the state Ready
      // forever. The watcher is attached once; `exit` fires once per child.
      this.#installIdleExitWatcher();
      // Keep the generation alive: stdin stays open for post-handshake
      // requests (ping in this slice). The broker holds the child reference
      // for teardown; the child exits only when the host tears it down.
      // `this.#writer.close()` is intentionally NOT called here — closing
      // stdin would kill a well-behaved server that waits on fd 0.

      this.#prepareResult = mintPrepareResult({
        state: "Ready",
        toolServerId: this.#config.serverId,
        toolServerGeneration: this.#generation,
      });
      return this.#prepareResult;
    } catch (error) {
      this.#state = "Quarantined";
      const code = this.#errorCodeFrom(error);
      await this.#teardown();
      this.#prepareResult = mintPrepareResult({
        state: "Quarantined",
        toolServerId: this.#config.serverId,
        toolServerGeneration: this.#generation,
        errorCode: code,
      });
      return this.#prepareResult;
    }
  }

  /**
   * Maps a caught error to a public `ToolBrokerErrorCode`. `ToolBrokerSessionError`
   * carries its own code; a `StdioReadError` of kind `exit` or `closed` is a
   * child-exited failure; a `malformed` read is a malformed handshake; anything
   * else defaults to malformed.
   */
  #errorCodeFrom(error: unknown): ToolBrokerErrorCode {
    if (error instanceof ToolBrokerSessionError) {
      return error.code;
    }
    if (error instanceof StdioReadError) {
      return error.kind === "exit" || error.kind === "closed" ? "TOOL_BROKER_CHILD_EXITED" : "TOOL_BROKER_HANDSHAKE_MALFORMED";
    }
    return "TOOL_BROKER_HANDSHAKE_MALFORMED";
  }

  /**
   * Reads messages until the initialize response for `expectedId` arrives.
   * Rejects on timeout, child exit, stream end, malformed input, or any
   * notification arriving before the response (a version-foreign lifecycle
   * frame, per spec REQ-TOOL-008: "version-foreign lifecycle messages ...
   * are protocol failures"). A duplicate initialize response after the first
   * cannot reach here because `prepare` is idempotent.
   */
  async #readResponseOrTimeout(expectedId: number): Promise<JsonValue> {
    const deadline = this.#config.startupTimeoutMs;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new ToolBrokerSessionError("TOOL_BROKER_STARTUP_TIMEOUT", `initialize response not received within ${deadline}ms`));
      }, deadline).unref();
    });

    for (;;) {
      const message = await Promise.race<JsonValue>([this.#reader.read(), timeoutPromise]);

      if (!isJsonObject(message)) {
        throw new ToolBrokerSessionError("TOOL_BROKER_HANDSHAKE_MALFORMED", "received a non-object message");
      }
      const record = message as Record<string, unknown>;
      // A notification (has `method`, no `id`) arriving before the initialize
      // response is a version-foreign lifecycle frame: the server sent
      // `notifications/initialized` (or any other notification) out of order.
      // Per spec this is a protocol failure, not a completion signal.
      if (record.method !== undefined && record.id === undefined) {
        throw new ToolBrokerSessionError(
          "TOOL_BROKER_HANDSHAKE_MALFORMED",
          `received notification ${JSON.stringify(record.method)} before the initialize response`,
        );
      }
      // A response (has `id`). We only sent one request, so any response with
      // a matching numeric id is the initialize response.
      if (record.id !== undefined) {
        return message;
      }
      throw new ToolBrokerSessionError("TOOL_BROKER_HANDSHAKE_MALFORMED", "received a message that is neither a request response nor a notification");
    }
  }

  /**
   * Sends a `ping` request with the next monotonically increasing id and
   * waits for the exact correlated response, validating the result is closed
   * (with optional `_meta`). The server reply is correlated evidence only: it
   * never authorizes another request or a second ping — every ping carries its
   * own host-issued id. Exactly one request may be in flight at a time. On
   * timeout, protocol violation, or child exit, quarantines and tears the
   * child down before rejecting.
   */
  async ping(): Promise<void> {
    if (this.#state !== "Ready") {
      // Synchronous rejection: no frame, no teardown, state unchanged.
      throw new ToolBrokerSessionError("TOOL_BROKER_NOT_READY", `ping requires a Ready generation (state is ${this.#state})`);
    }
    if (this.#pingInFlight) {
      throw new ToolBrokerSessionError("TOOL_BROKER_PROTOCOL_FAILURE", "a request is already in flight");
    }
    this.#pingInFlight = true;
    const pingId = this.#nextRequestId;
    try {
      this.#writer.write({ jsonrpc: "2.0", id: pingId, method: "ping" } as JsonValue);
      // One request in flight; the next post-handshake request id is n + 1.
      this.#nextRequestId += 1;
      const result = await this.#readPingResponseOrTimeout(pingId);
      assertPingResult(result);
    } catch (error) {
      if (this.#stopped) {
        // A concurrent stop() already transitioned to Stopped and tore down;
        // the in-flight read was aborted by reader.stop(). Do not quarantine
        // or re-tear-down the terminal generation.
        throw error;
      }
      this.#state = "Quarantined";
      await this.#teardown();
      throw error;
    } finally {
      this.#pingInFlight = false;
    }
  }

  /**
   * Reads messages until the ping response for `requestId` arrives. Rejects
   * with `TOOL_BROKER_REQUEST_TIMEOUT` after `requestTimeoutMs` (timer is
   * unrefed and cleared on settlement), `TOOL_BROKER_CHILD_EXITED` on child
   * exit or stream end, or `TOOL_BROKER_PROTOCOL_FAILURE` on any violation:
   * wrong or non-numeric id, error envelope, notification-as-response,
   * unknown envelope key, non-object result, malformed line. A response can
   * settle exactly one request; anything after that settles nothing here.
   */
  async #readPingResponseOrTimeout(requestId: number): Promise<JsonValue> {
    const deadline = this.#requestTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ToolBrokerSessionError("TOOL_BROKER_REQUEST_TIMEOUT", `ping response not received within ${deadline}ms`));
      }, deadline);
      timer.unref();
    });

    try {
      for (;;) {
        let message: JsonValue;
        try {
          message = await Promise.race<JsonValue>([this.#reader.read(), timeoutPromise]);
        } catch (error) {
          if (error instanceof ToolBrokerSessionError) {
            // The request timeout, or a settled/aborted read: propagate.
            throw error;
          }
          if (error instanceof StdioReadError) {
            // exit/closed => the child left mid-request; a malformed line is
            // a post-handshake protocol failure.
            throw error.kind === "malformed"
              ? new ToolBrokerSessionError("TOOL_BROKER_PROTOCOL_FAILURE", `malformed line while awaiting ping response: ${error.message}`)
              : new ToolBrokerSessionError("TOOL_BROKER_CHILD_EXITED", `child exited while awaiting ping response: ${error.message}`);
          }
          throw new ToolBrokerSessionError("TOOL_BROKER_PROTOCOL_FAILURE", String(error));
        }

        if (!isJsonObject(message)) {
          throw new ToolBrokerSessionError("TOOL_BROKER_PROTOCOL_FAILURE", "ping response is not an object");
        }
        const record = message as Record<string, unknown>;
        // A notification (method present, id absent) while a request is in
        // flight can never complete a request: protocol failure.
        if (record.method !== undefined && record.id === undefined) {
          throw new ToolBrokerSessionError("TOOL_BROKER_PROTOCOL_FAILURE", `received notification ${JSON.stringify(record.method)} while a request is in flight`);
        }
        // A response (has `id`). `assertResponseEnvelope` enforces the exact
        // envelope (jsonrpc "2.0", numeric id === requestId, result present,
        // no error, no unknown top-level keys); remap its handshake-flavored
        // message to a post-handshake protocol failure.
        if (record.id !== undefined) {
          try {
            return assertResponseEnvelope(message, requestId);
          } catch (error) {
            if (error instanceof ToolBrokerSessionError) {
              throw new ToolBrokerSessionError("TOOL_BROKER_PROTOCOL_FAILURE", error.message);
            }
            throw error;
          }
        }
        throw new ToolBrokerSessionError("TOOL_BROKER_PROTOCOL_FAILURE", "received a message that is neither a response nor a notification");
      }
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Background observation of post-handshake child termination. Installed
   * exactly once when the session reaches `Ready`. If the child exits while
   * `Ready` and no request is in flight, transitions the generation to
   * `Quarantined` and runs the (idempotent, confirmed) teardown. Races
   * safely with `stop()`, the request timeout, protocol failure, and the
   * in-flight ping catch: a `Stopped` terminal state is never overwritten,
   * an in-flight ping owns its own quarantine/teardown, and termination is
   * handled exactly once.
   */
  #installIdleExitWatcher(): void {
    this.#child.once("exit", this.#onChildExit);
  }

  #onChildExit = (): void => {
    if (this.#stopped) {
      // stop() owns the terminal state; a late exit must not overwrite it.
      return;
    }
    if (this.#childExitObserved) {
      // Exactly-once: child termination must not run twice.
      return;
    }
    this.#childExitObserved = true;
    if (this.#pingInFlight) {
      // The in-flight ping read observes the exit and owns the quarantine
      // and teardown; do not double-teardown here.
      return;
    }
    this.#state = "Quarantined";
    // Fire-and-forget: `#teardown` is governed by `#stopped`, `#pingInFlight`,
    // and the exactly-once flag, so a concurrent stop() or ping catch cannot
    // be clobbered by this background transition. Teardown is idempotent.
    void this.#teardown();
  }

  /** Confirmed, idempotent teardown of the generation transport. */
  async #teardown(): Promise<void> {
    this.#reader.stop();
    this.#writer.close();
    await killChild(this.#child);
  }

  /**
   * Stops the generation: sends SIGTERM, waits up to `TEARDOWN_GRACE_MS` for
   * exit, then SIGKILL. Resolves only after the child is confirmed exited.
   * Idempotent.
   */
  async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#state = "Stopped";
    await this.#teardown();
  }

  #currentResult(): PrepareResult {
    // Concurrent-call path only: the handshake is still in flight or the
    // settle result was never retained, so a fresh minted object is returned.
    // `adaptToolBrokerServer` rejects these because they are either non-Ready
    // or the exact identity is minted but never Ready for projection.
    return mintPrepareResult(
      this.#state === "Ready"
        ? {
            state: "Ready",
            toolServerId: this.#config.serverId,
            toolServerGeneration: this.#generation,
          }
        : {
            state: "Quarantined",
            toolServerId: this.#config.serverId,
            toolServerGeneration: this.#generation,
          },
    );
  }
}

/** Tears down a child: first waits briefly for a natural exit (the child
 * typically exits when its stdin closes), then escalates to SIGTERM, then
 * SIGKILL. Resolves after the child is confirmed exited. Never rejects.
 *
 * A natural exit yields `exitCode !== null` (e.g. 0); a signal kill yields
 * `signalCode !== null` and `exitCode === null`. Waiting for the natural exit
 * first lets well-behaved servers exit cleanly. */
export async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return; // already exited
  }

  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  // Phase 1: wait briefly for a natural exit (stdin closed -> server exits).
  const naturalGrace = await Promise.race([
    exitPromise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), TEARDOWN_GRACE_MS).unref()),
  ]);
  if (naturalGrace) {
    return;
  }

  // Phase 2: SIGTERM.
  if (!child.killed) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already dead; fall through to await.
    }
  }

  const termGrace = await Promise.race([
    exitPromise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), TEARDOWN_GRACE_MS).unref()),
  ]);
  if (termGrace) {
    return;
  }

  // Phase 3: SIGKILL.
  try {
    child.kill("SIGKILL");
  } catch {
    // Already dead or not killable; ignore.
  }

  await exitPromise;
}

/**
 * Builds the frozen, reusable projection of a ready generation.
 *
 * Only the exact minted object returned by `prepare()` is accepted; a
 * caller-constructed or copied/spread result is rejected before any authority
 * is projected, so downstream consumers can trust that the generation fence
 * (`toolServerId`/`toolServerGeneration`) came from the host's own handshake.
 */
export function adaptToolBrokerServer(prepared: PrepareResult): AdaptedToolBrokerServer {
  if (typeof prepared !== "object" || prepared === null || !MINTED_PREPARE_RESULTS.has(prepared)) {
    throw new Error("adaptToolBrokerServer requires the exact PrepareResult returned by prepare()");
  }
  if (prepared.state !== "Ready") {
    throw new Error("adaptToolBrokerServer requires a Ready prepared result");
  }
  return deepFreeze({
    toolServerId: prepared.toolServerId,
    toolServerGeneration: prepared.toolServerGeneration,
    protocolVersion: MCP_PROTOCOL_VERSION,
  });
}

/** Type re-export so callers import from a single module. */
export type { StdioTransportConfig };
