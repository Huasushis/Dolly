import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { ResolvedNetworkAddress } from "../secure-remote-fetch.js";

export interface OutboundHttpTransportRequest {
  readonly url: URL;
  /** The address the host validated; the connection MUST use exactly this. */
  readonly address: ResolvedNetworkAddress;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly connectTimeoutMs: number;
  readonly headerTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxResponseHeaderBytes: number;
  readonly signal: AbortSignal;
}

export interface OutboundHttpTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** The peer address the socket actually connected to. */
  readonly connectedAddress: string;
  readonly body: AsyncIterable<Uint8Array>;
  abort(reason?: Error): void;
}

export interface OutboundHttpTransport {
  request(input: OutboundHttpTransportRequest): Promise<OutboundHttpTransportResponse>;
}

/**
 * Whether the request may already have reached the destination.
 *
 * A capability that performed a non-idempotent request cannot claim the effect
 * did not happen once the bytes were flushed, so the outcome travels with the
 * failure instead of being guessed by the caller.
 */
export class OutboundHttpTransportError extends Error {
  constructor(
    readonly outcome: "not-sent" | "sent-or-unknown",
    message = "Outbound HTTP transport failed",
  ) {
    super(message);
    this.name = "OutboundHttpTransportError";
  }
}

function flattenedHeaders(headers: NodeJS.Dict<string | string[]>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result[name.toLowerCase()] = value;
    else if (Array.isArray(value)) result[name.toLowerCase()] = value.join(", ");
  }
  return result;
}

/**
 * The production transport for endpoint-scoped outbound HTTP.
 *
 * Every connection is pinned to the address the capability already validated:
 * the `lookup` hook returns that address instead of consulting the resolver
 * again, which is what closes the window between a policy check and the
 * connect for a name whose records change. The transport also refuses the
 * ambient conveniences that would widen the grant — no shared or proxied
 * agent, no keep-alive pool across destinations, and no negotiated content
 * encoding — and leaves certificate verification on the platform trust store.
 */
export class NodeOutboundHttpTransport implements OutboundHttpTransport {
  request(input: OutboundHttpTransportRequest): Promise<OutboundHttpTransportResponse> {
    return new Promise((resolve, reject) => {
      const secure = input.url.protocol === "https:";
      const hostname = input.url.hostname.replace(/^\[|\]$/gu, "");
      let settled = false;
      let flushed = false;
      const timers = new Set<NodeJS.Timeout>();
      const clearTimers = (): void => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
      };
      const track = (timer: NodeJS.Timeout): NodeJS.Timeout => {
        timers.add(timer);
        return timer;
      };

      const options: RequestOptions = {
        protocol: input.url.protocol,
        hostname: input.url.hostname,
        port: input.url.port || (secure ? 443 : 80),
        path: `${input.url.pathname}${input.url.search}`,
        method: input.method,
        headers: { ...input.headers },
        agent: false,
        maxHeaderSize: input.maxResponseHeaderBytes,
        signal: input.signal,
        // Node 20 and later ask the hook for every candidate address and
        // reject the single-address answer with ERR_INVALID_IP_ADDRESS, so the
        // pin has to satisfy both shapes or it silently stops pinning.
        lookup: (_hostname, lookupOptions, callback) => {
          const pinned = { address: input.address.address, family: input.address.family };
          if ((lookupOptions as { all?: boolean }).all === true) {
            callback(null, [pinned]);
            return;
          }
          callback(null, pinned.address, pinned.family);
        },
        ...(secure
          ? {
              minVersion: "TLSv1.2" as const,
              ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
            }
          : {}),
      };

      const requestFactory = secure ? httpsRequest : httpRequest;
      const request = requestFactory(options, (response) => {
        clearTimeout(headerTimer);
        timers.delete(headerTimer);
        const connectedAddress = response.socket.remoteAddress ?? "";
        const body = (async function* () {
          try {
            for await (const chunk of response) {
              yield typeof chunk === "string" ? Buffer.from(chunk) : Uint8Array.from(chunk);
            }
          } finally {
            clearTimers();
          }
        })();
        if (settled) {
          response.destroy();
          return;
        }
        settled = true;
        resolve({
          status: response.statusCode ?? 0,
          headers: flattenedHeaders(response.headers),
          connectedAddress,
          body,
          abort: (reason) => {
            clearTimers();
            response.destroy(reason);
            request.destroy(reason);
          },
        });
      });

      track(
        setTimeout(() => {
          request.destroy(new Error("Outbound HTTP total timeout"));
        }, input.totalTimeoutMs),
      );
      const headerTimer = track(
        setTimeout(() => {
          request.destroy(new Error("Outbound HTTP response-header timeout"));
        }, input.headerTimeoutMs),
      );

      request.once("socket", (socket) => {
        const connectTimer = track(
          setTimeout(() => {
            request.destroy(new Error("Outbound HTTP connect timeout"));
          }, input.connectTimeoutMs),
        );
        const settleConnect = (): void => {
          clearTimeout(connectTimer);
          timers.delete(connectTimer);
        };
        socket.once(secure ? "secureConnect" : "connect", settleConnect);
        socket.once("close", settleConnect);
      });
      request.once("finish", () => {
        flushed = true;
      });
      request.once("error", () => {
        if (settled) return;
        settled = true;
        clearTimers();
        reject(
          new OutboundHttpTransportError(
            flushed ? "sent-or-unknown" : "not-sent",
            "Outbound HTTP request failed",
          ),
        );
      });

      if (input.body === undefined) request.end();
      else request.end(Buffer.from(input.body));
    });
  }
}
