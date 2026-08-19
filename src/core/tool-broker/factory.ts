/**
 * Factory for `startToolBrokerServer`: spawns the child and constructs a
 * `ToolBrokerSession` bound to it.
 *
 * The `spawn` and `now` functions are injected so tests can supply a fake
 * child and deterministic clock. In the product runtime (a later gate) the
 * real `node:child_process.spawn` and `Date.now` are used; this slice never
 * imports them directly so the handshake is fully deterministic under test.
 */

import type { ChildProcess } from "node:child_process";
import { ToolBrokerSession } from "./session.js";
import type {
  NowFn,
  PrepareResult,
  SpawnFn,
  ToolBrokerServerConfig,
  ToolBrokerServerOptions,
  ToolBrokerServerState,
} from "./types.js";
/** The broker server handle returned by `startToolBrokerServer`. It owns one
 * generation session. */
export interface ToolBrokerServer {
  /** Current lifecycle state. */
  readonly state: ToolBrokerServerState;
  /** The configured server ID. */
  readonly toolServerId: string;
  /** The generation number assigned to this start. */
  readonly toolServerGeneration: number;
  /** Drives the handshake to completion. See `ToolBrokerSession.prepare`. */
  prepare(): Promise<PrepareResult>;
  /** Sends a serialized post-handshake ping request and waits for the exact
   * correlated response. Rejects on protocol violation, timeout, child exit,
   * or when the generation is not `Ready`. */
  ping(): Promise<void>;
  /** Stops the generation and tears down the child. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Starts a Tool Broker server generation: spawns the stdio child and returns
 * a handle. The handshake and discovery are driven by calling `prepare()`.
 *
 * `generation` starts at 1 and increments per server ID. In this single-start
 * slice every `startToolBrokerServer` call gets generation 1 unless
 * `options.generation` pins one (for proving catalog pinning against a stale
 * generation); the monotonic counter across restarts is a later gate (spec
 * section 4) because this slice owns only one start per handle.
 */
export function startToolBrokerServer(
  config: ToolBrokerServerConfig,
  options: ToolBrokerServerOptions,
): ToolBrokerServer {
  // The `now` injection is accepted for deterministic clock plumbing. This
  // slice's timeout uses `setTimeout` with the configured `startupTimeoutMs`,
  // which does not require `now`; retaining the parameter keeps the DI seam
  // stable for the later gate that measures elapsed time explicitly.
  void options.now;

  const child: ChildProcess = options.spawn(config.transport.command, config.transport.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: config.transport.env,
    windowsHide: true,
  });

  const session = new ToolBrokerSession(config, options.generation ?? 1, child);

  return {
    get state(): ToolBrokerServerState {
      return session.state;
    },
    get toolServerId(): string {
      return session.toolServerId;
    },
    get toolServerGeneration(): number {
      return session.toolServerGeneration;
    },
    prepare: () => session.prepare(),
    ping: () => session.ping(),
    stop: () => session.stop(),
  };
}
