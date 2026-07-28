import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { deepFreeze, type JsonValue } from "./canonical-json.js";

export interface ResolvedNetworkAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface SecureDnsResolver {
  resolve(hostname: string): Promise<readonly ResolvedNetworkAddress[]>;
}

export interface PinnedTransportRequest {
  readonly url: URL;
  readonly address: ResolvedNetworkAddress;
  readonly connectTimeoutMs: number;
  readonly headerTimeoutMs: number;
  readonly totalTimeoutMs: number;
}

export interface PinnedTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly connectedAddress: string;
  readonly body: AsyncIterable<Uint8Array>;
  abort(reason?: Error): void;
}

export interface PinnedHttpsTransport {
  request(input: PinnedTransportRequest): Promise<PinnedTransportResponse>;
}

export interface SecureRemoteFetchPolicy {
  readonly allowedHosts: readonly string[];
  readonly allowAnyPublicHost?: boolean;
  readonly allowedPorts?: readonly number[];
  readonly maxUrlBytes: number;
  readonly maxRedirects: number;
  readonly maxBytes: number;
  readonly connectTimeoutMs: number;
  readonly headerTimeoutMs: number;
  readonly totalTimeoutMs: number;
}

export interface SecureRemoteFetchResult {
  readonly bytes: Uint8Array;
  readonly contentType?: string;
  readonly finalOrigin: string;
  readonly redirects: number;
}

export type SecureRemoteFetchErrorCode =
  | "REMOTE_URL_INVALID"
  | "REMOTE_DESTINATION_DENIED"
  | "REMOTE_DNS_EMPTY"
  | "REMOTE_DNS_FAILED"
  | "REMOTE_ADDRESS_DENIED"
  | "REMOTE_ADDRESS_MISMATCH"
  | "REMOTE_REDIRECT_INVALID"
  | "REMOTE_REDIRECT_LIMIT"
  | "REMOTE_RESPONSE_INVALID"
  | "REMOTE_TRANSPORT_FAILED"
  | "REMOTE_SIZE_LIMIT";

export class SecureRemoteFetchError extends Error {
  constructor(
    readonly code: SecureRemoteFetchErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "SecureRemoteFetchError";
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function normalizeHostname(value: string): string {
  const hostname = value
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (hostname.length === 0) {
    throw new SecureRemoteFetchError("REMOTE_URL_INVALID", "URL hostname is empty");
  }
  return hostname;
}

function parseIpv4(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function ipv4InPrefix(address: number, base: number, bits: number): boolean {
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (base & mask);
}

function parseIpv6(addressInput: string): bigint | null {
  let address = addressInput.toLowerCase();
  if (address.startsWith("[") && address.endsWith("]")) {
    address = address.slice(1, -1);
  }
  if (address.includes("%")) return null;

  const ipv4Tail = address.match(/(?:^|:)([0-9]+(?:\.[0-9]+){3})$/)?.[1];
  if (ipv4Tail) {
    const ipv4 = parseIpv4(ipv4Tail);
    if (ipv4 === null) return null;
    const high = ((ipv4 >>> 16) & 0xffff).toString(16);
    const low = (ipv4 & 0xffff).toString(16);
    address = `${address.slice(0, -ipv4Tail.length)}${high}:${low}`;
  }

  if ((address.match(/::/g) ?? []).length > 1) return null;
  const [leftText, rightText] = address.split("::");
  const left = leftText ? leftText.split(":") : [];
  const right = rightText === undefined || rightText === "" ? [] : rightText.split(":");
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const omitted = 8 - left.length - right.length;
  if (rightText === undefined ? omitted !== 0 : omitted < 1) return null;
  const groups = [...left, ...Array.from({ length: omitted }, () => "0"), ...right];
  if (groups.length !== 8) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function ipv6InPrefix(address: bigint, base: bigint, bits: number): boolean {
  if (bits === 0) return true;
  const shift = BigInt(128 - bits);
  return address >> shift === base >> shift;
}

const IPV4_DENY: readonly [number, number][] = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0586300, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
];

export function isPublicNetworkAddress(addressInput: string): boolean {
  const address = addressInput.replace(/^\[|\]$/g, "");
  const family = isIP(address);
  if (family === 4) {
    const parsed = parseIpv4(address);
    return parsed !== null && !IPV4_DENY.some(([base, bits]) => ipv4InPrefix(parsed, base, bits));
  }
  if (family !== 6) return false;
  const parsed = parseIpv6(address);
  if (parsed === null) return false;

  const mappedBase = 0xffff00000000n;
  if (ipv6InPrefix(parsed, mappedBase, 96)) {
    const mapped = Number(parsed & 0xffffffffn);
    return !IPV4_DENY.some(([base, bits]) => ipv4InPrefix(mapped, base, bits));
  }

  const globalBase = 0x20000000000000000000000000000000n;
  if (!ipv6InPrefix(parsed, globalBase, 3)) return false;
  const documentationBase = 0x20010db8000000000000000000000000n;
  return !ipv6InPrefix(parsed, documentationBase, 32);
}

export function sameNetworkAddress(left: string, right: string): boolean {
  const left4 = parseIpv4(left);
  const right4 = parseIpv4(right);
  const left6 = parseIpv6(left);
  const right6 = parseIpv6(right);
  const mappedBase = 0xffff00000000n;
  const comparable = (ipv4: number | null, ipv6: bigint | null) => {
    if (ipv4 !== null) return { family: 4 as const, value: BigInt(ipv4) };
    if (ipv6 !== null && ipv6InPrefix(ipv6, mappedBase, 96)) {
      return { family: 4 as const, value: ipv6 & 0xffffffffn };
    }
    return ipv6 === null ? null : { family: 6 as const, value: ipv6 };
  };
  const normalizedLeft = comparable(left4, left6);
  const normalizedRight = comparable(right4, right6);
  return (
    normalizedLeft !== null &&
    normalizedRight !== null &&
    normalizedLeft.family === normalizedRight.family &&
    normalizedLeft.value === normalizedRight.value
  );
}

function normalizedPolicy(policy: SecureRemoteFetchPolicy): SecureRemoteFetchPolicy {
  assertPositiveInteger(policy.maxUrlBytes, "maxUrlBytes");
  assertNonNegativeInteger(policy.maxRedirects, "maxRedirects");
  assertPositiveInteger(policy.maxBytes, "maxBytes");
  assertPositiveInteger(policy.connectTimeoutMs, "connectTimeoutMs");
  assertPositiveInteger(policy.headerTimeoutMs, "headerTimeoutMs");
  assertPositiveInteger(policy.totalTimeoutMs, "totalTimeoutMs");
  if (policy.connectTimeoutMs > policy.totalTimeoutMs || policy.headerTimeoutMs > policy.totalTimeoutMs) {
    throw new TypeError("Connect/header timeouts cannot exceed totalTimeoutMs");
  }
  const allowedHosts = [...new Set(policy.allowedHosts.map(normalizeHostname))].sort();
  const allowedPorts = [...new Set(policy.allowedPorts ?? [])].sort((a, b) => a - b);
  for (const port of allowedPorts) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || port === 443) {
      throw new TypeError("allowedPorts must contain unique non-default TCP ports");
    }
  }
  if (!policy.allowAnyPublicHost && allowedHosts.length === 0) {
    throw new TypeError("Remote fetch policy must allow an exact host or all public hosts");
  }
  return deepFreeze({
    allowedHosts,
    allowAnyPublicHost: policy.allowAnyPublicHost === true,
    allowedPorts,
    maxUrlBytes: policy.maxUrlBytes,
    maxRedirects: policy.maxRedirects,
    maxBytes: policy.maxBytes,
    connectTimeoutMs: policy.connectTimeoutMs,
    headerTimeoutMs: policy.headerTimeoutMs,
    totalTimeoutMs: policy.totalTimeoutMs,
  });
}

export class NodeDnsResolver implements SecureDnsResolver {
  async resolve(hostname: string): Promise<readonly ResolvedNetworkAddress[]> {
    const records = await dnsLookup(hostname, { all: true, verbatim: true });
    return records.map((record) => {
      if (record.family !== 4 && record.family !== 6) {
        throw new Error("DNS resolver returned an unsupported address family");
      }
      return { address: record.address, family: record.family };
    });
  }
}

export async function resolvePinnedPublicAddress(
  resolver: SecureDnsResolver,
  hostnameInput: string,
): Promise<ResolvedNetworkAddress> {
  const hostname = normalizeHostname(hostnameInput);
  const literal = hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(literal);
  let records: readonly ResolvedNetworkAddress[];
  if (literalFamily === 4 || literalFamily === 6) {
    records = [{ address: literal, family: literalFamily }];
  } else {
    try {
      records = await resolver.resolve(hostname);
    } catch {
      throw new SecureRemoteFetchError(
        "REMOTE_DNS_FAILED",
        "Remote hostname resolution failed",
        { hostname },
      );
    }
  }
  if (records.length === 0) {
    throw new SecureRemoteFetchError(
      "REMOTE_DNS_EMPTY",
      "Remote hostname resolved to no addresses",
      { hostname },
    );
  }
  for (const record of records) {
    if (isIP(record.address) !== record.family || !isPublicNetworkAddress(record.address)) {
      throw new SecureRemoteFetchError(
        "REMOTE_ADDRESS_DENIED",
        "Remote hostname resolved to a non-public address",
        { hostname },
      );
    }
  }
  return [...records].sort((left, right) => {
    if (left.family !== right.family) return left.family - right.family;
    return left.address < right.address ? -1 : left.address > right.address ? 1 : 0;
  })[0]!;
}

function flattenedHeaders(headers: NodeJS.Dict<string | string[]>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result[name.toLowerCase()] = value;
    else if (Array.isArray(value)) result[name.toLowerCase()] = value.join(", ");
  }
  return result;
}

export class NodePinnedHttpsTransport implements PinnedHttpsTransport {
  request(input: PinnedTransportRequest): Promise<PinnedTransportResponse> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const totalTimer = setTimeout(() => {
        controller.abort(new Error("Remote fetch total timeout"));
      }, input.totalTimeoutMs);
      const headerTimer = setTimeout(() => {
        controller.abort(new Error("Remote fetch response-header timeout"));
      }, input.headerTimeoutMs);

      const options: RequestOptions = {
        protocol: "https:",
        hostname: input.url.hostname,
        port: input.url.port || 443,
        path: `${input.url.pathname}${input.url.search}`,
        method: "GET",
        headers: { accept: "*/*", "user-agent": "Dolly-Media-Ingress/1" },
        signal: controller.signal,
        servername: input.url.hostname.replace(/^\[|\]$/g, ""),
        lookup: (_hostname, _options, callback) => {
          callback(null, input.address.address, input.address.family);
        },
      };
      const request = httpsRequest(options, (response) => {
        clearTimeout(headerTimer);
        const connectedAddress = response.socket.remoteAddress ?? "";
        const body = (async function* () {
          try {
            for await (const chunk of response) {
              yield typeof chunk === "string" ? Buffer.from(chunk) : Uint8Array.from(chunk);
            }
          } finally {
            clearTimeout(totalTimer);
          }
        })();
        resolve({
          status: response.statusCode ?? 0,
          headers: flattenedHeaders(response.headers),
          connectedAddress,
          body,
          abort: (reason) => {
            response.destroy(reason);
            clearTimeout(totalTimer);
          },
        });
      });
      request.once("socket", (socket) => {
        const connectTimer = setTimeout(() => {
          request.destroy(new Error("Remote fetch connect timeout"));
        }, input.connectTimeoutMs);
        socket.once("secureConnect", () => clearTimeout(connectTimer));
        socket.once("close", () => clearTimeout(connectTimer));
      });
      request.once("error", (error) => {
        clearTimeout(headerTimer);
        clearTimeout(totalTimer);
        reject(error);
      });
      request.end();
    });
  }
}

export class SecureRemoteFetcher {
  readonly #resolver: SecureDnsResolver;
  readonly #transport: PinnedHttpsTransport;

  constructor(options: {
    readonly resolver: SecureDnsResolver;
    readonly transport: PinnedHttpsTransport;
  }) {
    this.#resolver = options.resolver;
    this.#transport = options.transport;
  }

  async fetch(
    urlInput: string,
    policyInput: SecureRemoteFetchPolicy,
  ): Promise<SecureRemoteFetchResult> {
    const policy = normalizedPolicy(policyInput);
    let current = this.#parseAndAuthorizeUrl(urlInput, policy);
    let redirects = 0;

    for (;;) {
      const address = await this.#resolvePublicAddress(current.hostname);
      let response: PinnedTransportResponse;
      try {
        response = await this.#transport.request({
          url: current,
          address,
          connectTimeoutMs: policy.connectTimeoutMs,
          headerTimeoutMs: policy.headerTimeoutMs,
          totalTimeoutMs: policy.totalTimeoutMs,
        });
      } catch {
        throw new SecureRemoteFetchError(
          "REMOTE_TRANSPORT_FAILED",
          "Remote HTTPS request failed",
          { hostname: normalizeHostname(current.hostname) },
        );
      }
      if (!sameNetworkAddress(response.connectedAddress, address.address)) {
        response.abort();
        throw new SecureRemoteFetchError(
          "REMOTE_ADDRESS_MISMATCH",
          "Remote connection did not use the approved DNS address",
          { hostname: normalizeHostname(current.hostname) },
        );
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        response.abort();
        if (redirects >= policy.maxRedirects) {
          throw new SecureRemoteFetchError(
            "REMOTE_REDIRECT_LIMIT",
            "Remote response exceeded the redirect limit",
          );
        }
        const location = response.headers.location;
        if (!location) {
          throw new SecureRemoteFetchError(
            "REMOTE_REDIRECT_INVALID",
            "Redirect response omitted Location",
          );
        }
        let redirected: URL;
        try {
          redirected = new URL(location, current);
        } catch {
          throw new SecureRemoteFetchError(
            "REMOTE_REDIRECT_INVALID",
            "Redirect Location is not a valid URL",
          );
        }
        current = this.#parseAndAuthorizeUrl(redirected.href, policy);
        redirects += 1;
        continue;
      }

      if (response.status < 200 || response.status > 299) {
        response.abort();
        throw new SecureRemoteFetchError(
          "REMOTE_RESPONSE_INVALID",
          `Remote server returned HTTP ${response.status}`,
          { status: response.status },
        );
      }
      const contentLength = response.headers["content-length"];
      if (
        contentLength !== undefined &&
        (!/^(0|[1-9][0-9]*)$/.test(contentLength) || Number(contentLength) > policy.maxBytes)
      ) {
        response.abort();
        throw new SecureRemoteFetchError(
          "REMOTE_SIZE_LIMIT",
          "Remote Content-Length exceeds the byte limit",
          { maxBytes: policy.maxBytes },
        );
      }

      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      try {
        for await (const chunk of response.body) {
          if (!(chunk instanceof Uint8Array)) {
            throw new SecureRemoteFetchError(
              "REMOTE_RESPONSE_INVALID",
              "Remote transport returned a non-byte body chunk",
            );
          }
          byteLength += chunk.byteLength;
          if (byteLength > policy.maxBytes) {
            throw new SecureRemoteFetchError(
              "REMOTE_SIZE_LIMIT",
              "Remote response exceeded the byte limit",
              { maxBytes: policy.maxBytes },
            );
          }
          chunks.push(Uint8Array.from(chunk));
        }
      } catch (error) {
        response.abort(error instanceof Error ? error : undefined);
        if (error instanceof SecureRemoteFetchError) throw error;
        throw new SecureRemoteFetchError(
          "REMOTE_TRANSPORT_FAILED",
          "Remote response stream failed",
          { hostname: normalizeHostname(current.hostname) },
        );
      }
      if (byteLength === 0) {
        throw new SecureRemoteFetchError(
          "REMOTE_RESPONSE_INVALID",
          "Remote response body is empty",
        );
      }
      const bytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return Object.freeze({
        bytes,
        ...(response.headers["content-type"] === undefined
          ? {}
          : { contentType: response.headers["content-type"].split(";", 1)[0]!.trim() }),
        finalOrigin: current.origin,
        redirects,
      });
    }
  }

  #parseAndAuthorizeUrl(urlInput: string, policy: SecureRemoteFetchPolicy): URL {
    if (
      typeof urlInput !== "string" ||
      urlInput.length === 0 ||
      Buffer.byteLength(urlInput, "utf8") > policy.maxUrlBytes
    ) {
      throw new SecureRemoteFetchError(
        "REMOTE_URL_INVALID",
        "Remote URL is empty or exceeds its byte limit",
      );
    }
    let url: URL;
    try {
      url = new URL(urlInput);
    } catch {
      throw new SecureRemoteFetchError("REMOTE_URL_INVALID", "Remote URL is invalid");
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      throw new SecureRemoteFetchError(
        "REMOTE_URL_INVALID",
        "Remote URL must be HTTPS without credentials or a fragment",
      );
    }
    const hostname = normalizeHostname(url.hostname);
    if (!policy.allowAnyPublicHost && !policy.allowedHosts.includes(hostname)) {
      throw new SecureRemoteFetchError(
        "REMOTE_DESTINATION_DENIED",
        "Remote hostname is outside the capability allowlist",
        { hostname },
      );
    }
    const port = url.port === "" ? 443 : Number(url.port);
    if (port !== 443 && !(policy.allowedPorts ?? []).includes(port)) {
      throw new SecureRemoteFetchError(
        "REMOTE_DESTINATION_DENIED",
        "Remote TCP port is outside the capability allowlist",
        { hostname, port },
      );
    }
    return url;
  }

  async #resolvePublicAddress(hostnameInput: string): Promise<ResolvedNetworkAddress> {
    return resolvePinnedPublicAddress(this.#resolver, hostnameInput);
  }
}
