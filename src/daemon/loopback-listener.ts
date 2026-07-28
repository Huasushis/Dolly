/**
 * Loopback-only listener binding for the daemon's management endpoint.
 *
 * `security-operations.md` Section 3 requires the daemon to bind a loopback
 * address deliberately, forbids an unspecified address as a fallback, and
 * requires a bind failure to stop startup instead of retrying on a wider
 * interface. This module is the single place a daemon listener reaches the
 * network stack, so a failed bind has no second attempt to fall back to.
 */

import type { Server } from "node:net";
import { assertDaemonListenHost, type DaemonListenHost } from "./daemon-config.js";

export interface BoundLoopbackAddress {
  readonly host: DaemonListenHost;
  readonly port: number;
}

export type DaemonListenErrorCode =
  | "DAEMON_LISTEN_ADDRESS_FORBIDDEN"
  | "DAEMON_LISTEN_BIND_FAILED"
  | "DAEMON_LISTEN_ADDRESS_UNEXPECTED";

export class DaemonListenError extends Error {
  constructor(
    readonly code: DaemonListenErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "DaemonListenError";
  }
}

function normalizeBoundHost(address: string): string {
  // Node reports an IPv4-mapped IPv6 loopback for some stacks; both forms name
  // the same loopback interface.
  return address === "::ffff:127.0.0.1" ? "127.0.0.1" : address;
}

/**
 * Binds `server` to exactly one loopback address. The listen attempt is made
 * once: any failure is reported to the caller so startup can stop, and no
 * other address is tried.
 */
export async function bindLoopbackServer(
  server: Server,
  request: { readonly host: unknown; readonly port: unknown },
): Promise<BoundLoopbackAddress> {
  assertDaemonListenHost(request.host);
  const host = request.host;
  const port = request.port;
  if (!Number.isSafeInteger(port) || (port as number) < 0 || (port as number) > 65_535) {
    throw new DaemonListenError(
      "DAEMON_LISTEN_ADDRESS_FORBIDDEN",
      "A daemon listener port must be an integer between 0 and 65535",
    );
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    let settled = false;
    const onError = (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      server.removeListener("listening", onListening);
      rejectListen(
        new DaemonListenError(
          "DAEMON_LISTEN_BIND_FAILED",
          `Could not bind the daemon listener to ${host}:${String(port)}; startup stops rather than widening the interface`,
          { host, port: port as number, cause: error.code ?? error.name },
        ),
      );
    };
    const onListening = () => {
      if (settled) return;
      settled = true;
      server.removeListener("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port: port as number, exclusive: true });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new DaemonListenError(
      "DAEMON_LISTEN_ADDRESS_UNEXPECTED",
      "The daemon listener did not report an Internet Protocol address",
    );
  }
  if (normalizeBoundHost(address.address) !== host) {
    throw new DaemonListenError(
      "DAEMON_LISTEN_ADDRESS_UNEXPECTED",
      `The daemon listener bound ${address.address} instead of the requested ${host}`,
      { requested: host, bound: address.address },
    );
  }
  return Object.freeze({ host, port: address.port });
}
