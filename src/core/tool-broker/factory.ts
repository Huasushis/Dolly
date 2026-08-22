/**
 * Factory for `startToolBrokerServer`: constructs a `ToolBrokerSession`
 * bound to the spawned child.
 *
 * The spawn target never comes from the config: the frozen v1 stdio config
 * names only a relative package member (`transport.executable`) plus its
 * digests. On every generation start the Host resolves the immutable
 * installed package and hashes the selected file (spec section 4); that
 * resolution is carried in a separate `HostResolvedExecutablePremise`. The
 * factory requires the exact minted config object, requires the premise to
 * echo the configured package/executable identity exactly, and only then
 * spawns `premise.executablePath` through the injected `spawn` DI. If the
 * config is not from admission, or the premise identity does not match, it
 * rejects with `TOOL_BROKER_CONFIG_INVALID` before any spawn/fs/network/
 * backend call.
 *
 * The package resolver that mints a real premise is a later gate; until it
 * lands, tests mint premises that echo the configured identity verbatim.
 */

import type { ChildProcess } from "node:child_process";
import {
  ToolBrokerConfigError,
  type HostResolvedExecutablePremise,
  type NowFn,
  type PrepareResult,
  type SpawnFn,
  type ToolBrokerServerConfig,
  type ToolBrokerServerOptions,
  type ToolBrokerServerState,
} from "./types.js";
import { assertParsedToolBrokerServerConfig } from "./config.js";
import { ToolBrokerSession } from "./session.js";
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
 * Starts a Tool Broker server generation: spawns the stdio child named by the
 * Host-resolved premise and returns a handle. The handshake and discovery are
 * driven by calling `prepare()`.
 *
 * `config` MUST be the exact object returned from `parseToolBrokerConfig`'s
 * `servers[serverId]` — an unparsed or copied object is rejected before any
 * spawn. `premise` MUST echo the configured `package_id`, `package_version`,
 * `package_digest`, `executable`, and `executable_digest`; a mismatch is
 * rejected with `TOOL_BROKER_CONFIG_INVALID` before any spawn.
 *
 * `generation` starts at 1 and increments per server ID. In this single-start
 * slice every `startToolBrokerServer` call gets generation 1 unless
 * `options.generation` pins one (for proving catalog pinning against a stale
 * generation); the monotonic counter across restarts is a later gate (spec
 * section 4) because this slice owns only one start per handle.
 */
export function startToolBrokerServer(
  config: ToolBrokerServerConfig,
  premise: HostResolvedExecutablePremise,
  options: ToolBrokerServerOptions,
): ToolBrokerServer {
  // The `now` injection is accepted for deterministic clock plumbing. This
  // slice's timeout uses `setTimeout` with the configured
  // `limits.startup_timeout_ms`, which does not require `now`; retaining the
  // parameter keeps the DI seam stable for the later gate that measures
  // elapsed time explicitly.
  void options.now;

  assertParsedToolBrokerServerConfig(config);
  assertPremiseMatches(config, premise);

  const child: ChildProcess = options.spawn(premise.executablePath, config.transport.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: config.transport.secret_bindings,
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

/** Rejects with `TOOL_BROKER_CONFIG_INVALID` unless the premise is the exact
 * package/executable identity of the config; the config never supplies a
 * spawn target. */
function assertPremiseMatches(config: ToolBrokerServerConfig, premise: HostResolvedExecutablePremise): void {
  const configured = config.transport;
  const mismatches: string[] = [];
  if (premise.package_id !== configured.package_id) mismatches.push("package_id");
  if (premise.package_version !== configured.package_version) mismatches.push("package_version");
  if (premise.package_digest !== configured.package_digest) mismatches.push("package_digest");
  if (premise.executable !== configured.executable) mismatches.push("executable");
  if (premise.executable_digest !== configured.executable_digest) mismatches.push("executable_digest");
  if (mismatches.length > 0) {
    throw new ToolBrokerConfigError(
      "TOOL_BROKER_CONFIG_INVALID",
      `premise does not echo the configured identity for ${mismatches.join(", ")}`,
    );
  }
  if (typeof premise.executablePath !== "string" || premise.executablePath.length === 0) {
    throw new ToolBrokerConfigError(
      "TOOL_BROKER_CONFIG_INVALID",
      "premise executablePath must be a non-empty host-resolved path",
    );
  }
}
