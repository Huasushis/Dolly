import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import {
  ModelHttpTransportError,
  type ModelHttpTransport,
  type ModelHttpTransportRequest,
  type ModelHttpTransportResponse,
} from "./model-provider-broker.js";
import {
  NodeDnsResolver,
  resolvePinnedPublicAddress,
  sameNetworkAddress,
  type ResolvedNetworkAddress,
  type SecureDnsResolver,
} from "./secure-remote-fetch.js";

const DEFAULT_MAX_HEADER_BYTES = 32 * 1024;

function flattenedHeaders(headers: NodeJS.Dict<string | string[]>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result[name.toLowerCase()] = value;
    else if (Array.isArray(value)) result[name.toLowerCase()] = value.join(", ");
  }
  return result;
}

function providerRequestId(headers: Readonly<Record<string, string>>): string | undefined {
  for (const name of ["x-request-id", "request-id", "x-amzn-requestid"] as const) {
    const value = headers[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

function assertTransportRequest(input: ModelHttpTransportRequest): void {
  if (
    input.method !== "POST" ||
    !(input.body instanceof Uint8Array) ||
    input.body.byteLength === 0 ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    !Number.isSafeInteger(input.maxResponseBytes) ||
    input.maxResponseBytes <= 0 ||
    input.url.username !== "" ||
    input.url.password !== "" ||
    input.url.search !== "" ||
    input.url.hash !== ""
  ) {
    throw new ModelHttpTransportError("not-accepted", "Model HTTP request is invalid");
  }
  if (input.networkScope === "public") {
    if (input.url.protocol !== "https:") {
      throw new ModelHttpTransportError(
        "not-accepted",
        "The public network scope requires HTTPS",
      );
    }
    return;
  }
  const hostname = normalizedHostname(input.url);
  if (
    input.networkScope !== "loopback" ||
    input.url.protocol !== "http:" ||
    input.url.port === "" ||
    (hostname !== "127.0.0.1" && hostname !== "::1")
  ) {
    throw new ModelHttpTransportError("not-accepted", "Loopback network scope mismatch");
  }
}

export interface NodeModelHttpTransportOptions {
  readonly resolver?: SecureDnsResolver;
  readonly maxHeaderBytes?: number;
}

/** @internal Exported only so the Node callback shape remains directly falsifiable. */
export function createPinnedModelLookup(
  address: ResolvedNetworkAddress,
): NonNullable<RequestOptions["lookup"]> {
  return (_hostname, lookupOptions, callback) => {
    const pinned = { address: address.address, family: address.family };
    if ((lookupOptions as { all?: boolean }).all === true) {
      callback(null, [pinned]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

export class NodeModelHttpTransport implements ModelHttpTransport {
  readonly #resolver: SecureDnsResolver;
  readonly #maxHeaderBytes: number;

  constructor(options: NodeModelHttpTransportOptions = {}) {
    this.#resolver = options.resolver ?? new NodeDnsResolver();
    this.#maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
    if (!Number.isSafeInteger(this.#maxHeaderBytes) || this.#maxHeaderBytes < 1024) {
      throw new TypeError("maxHeaderBytes must be a safe integer of at least 1024");
    }
  }

  async dispatch(input: ModelHttpTransportRequest): Promise<ModelHttpTransportResponse> {
    assertTransportRequest(input);
    let address: ResolvedNetworkAddress;
    if (input.networkScope === "public") {
      try {
        address = await resolvePinnedPublicAddress(this.#resolver, input.url.hostname);
      } catch {
        throw new ModelHttpTransportError(
          "not-accepted",
          "Model endpoint DNS policy rejected the destination",
        );
      }
    } else {
      const hostname = normalizedHostname(input.url);
      address = { address: hostname, family: hostname === "::1" ? 6 : 4 };
    }
    return this.#request(input, address);
  }

  #request(
    input: ModelHttpTransportRequest,
    address: ResolvedNetworkAddress,
  ): Promise<ModelHttpTransportResponse> {
    return new Promise((resolve, reject) => {
      let finished = false;
      let settled = false;
      const hostname = normalizedHostname(input.url);
      const options: RequestOptions = {
        protocol: input.url.protocol,
        hostname: input.url.hostname,
        port: input.url.port || (input.networkScope === "public" ? 443 : undefined),
        path: input.url.pathname,
        method: input.method,
        headers: { ...input.headers, "content-length": String(input.body.byteLength) },
        signal: input.signal,
        agent: false,
        maxHeaderSize: this.#maxHeaderBytes,
        lookup: createPinnedModelLookup(address),
        ...(input.networkScope === "public"
          ? {
              minVersion: "TLSv1.2" as const,
              ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
            }
          : {}),
      };
      const requestFactory = input.networkScope === "public" ? httpsRequest : httpRequest;
      const request = requestFactory(options, (response) => {
        const connectedAddress = response.socket.remoteAddress ?? "";
        if (!sameNetworkAddress(connectedAddress, address.address)) {
          response.destroy();
          if (!settled) {
            settled = true;
            reject(
              new ModelHttpTransportError(
                "accepted-or-unknown",
                "Model connection did not use the approved address",
              ),
            );
          }
          return;
        }
        const headers = flattenedHeaders(response.headers);
        const body = (async function* () {
          for await (const chunk of response) {
            yield typeof chunk === "string" ? Buffer.from(chunk) : Uint8Array.from(chunk);
          }
        })();
        if (!settled) {
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            headers,
            ...(providerRequestId(headers) === undefined
              ? {}
              : { providerRequestId: providerRequestId(headers) }),
            body,
            abort: (reason) => {
              response.destroy(reason);
              request.destroy(reason);
            },
          });
        }
      });
      request.once("finish", () => {
        finished = true;
      });
      request.once("error", () => {
        if (settled) return;
        settled = true;
        reject(
          new ModelHttpTransportError(
            finished ? "accepted-or-unknown" : "not-accepted",
            "Model HTTP transport failed",
          ),
        );
      });
      request.setTimeout(input.timeoutMs, () => {
        request.destroy(new Error("Model HTTP transport timeout"));
      });
      request.end(Buffer.from(input.body));
    });
  }
}
