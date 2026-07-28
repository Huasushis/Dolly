import { isIP } from "node:net";
import { deepFreeze, type JsonValue } from "./canonical-json.js";

export type NetworkHeaderValue = string | readonly string[] | undefined;

export interface NetworkRequestMetadata {
  readonly peerAddress: string;
  readonly encrypted: boolean;
  readonly host: NetworkHeaderValue;
  readonly origin?: NetworkHeaderValue;
  readonly forwarded?: NetworkHeaderValue;
  readonly xForwardedProto?: NetworkHeaderValue;
  readonly xForwardedHost?: NetworkHeaderValue;
  readonly xForwardedFor?: NetworkHeaderValue;
}

export interface LocalExposureConfig {
  readonly mode: "local";
  readonly listenHost?: "127.0.0.1" | "::1";
  readonly listenPort: number;
  readonly scheme?: "http" | "https";
}

export interface ReverseProxyExposureConfig {
  readonly mode: "reverse-proxy";
  readonly listenHost: string;
  readonly listenPort: number;
  readonly trustedProxyAddresses: readonly string[];
  readonly externalOrigins: readonly string[];
}

export type NetworkExposureConfig = LocalExposureConfig | ReverseProxyExposureConfig;

export interface NetworkRequestContext {
  readonly mode: NetworkExposureConfig["mode"];
  readonly effectiveOrigin: string;
  readonly clientAddress: string;
  readonly peerAddress: string;
  readonly viaTrustedProxy: boolean;
}

export interface NetworkListenerEndpoint {
  readonly kind: "http" | "https";
  readonly address: string;
}

export type NetworkExposureErrorCode =
  | "EXPOSURE_CONFIG_INVALID"
  | "EXPOSURE_PEER_DENIED"
  | "EXPOSURE_HOST_DENIED"
  | "EXPOSURE_ORIGIN_DENIED"
  | "EXPOSURE_FORWARDED_DENIED"
  | "EXPOSURE_FORWARDED_CONFLICT"
  | "EXPOSURE_HTTPS_REQUIRED";

export class NetworkExposureError extends Error {
  constructor(
    readonly code: NetworkExposureErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "NetworkExposureError";
  }
}

interface ForwardedAuthority {
  readonly proto: string;
  readonly host: string;
  readonly clientAddress: string;
}

function canonicalIp(value: string, label: string): string {
  let candidate = value.trim();
  if (candidate.startsWith("[") && candidate.endsWith("]")) {
    candidate = candidate.slice(1, -1);
  }
  if (candidate.includes("%") || isIP(candidate) === 0) {
    throw new NetworkExposureError(
      "EXPOSURE_CONFIG_INVALID",
      `${label} must be an IP literal without a zone identifier`,
    );
  }
  if (isIP(candidate) === 4) {
    return candidate
      .split(".")
      .map((octet) => String(Number(octet)))
      .join(".");
  }
  const parsed = new URL(`http://[${candidate}]/`);
  return parsed.hostname.slice(1, -1).toLowerCase();
}

function isLoopback(address: string): boolean {
  if (address === "::1" || address === "::ffff:7f00:1") return true;
  if (isIP(address) !== 4) return false;
  return Number(address.split(".")[0]) === 127;
}

function isPrivateUpstream(address: string): boolean {
  if (isLoopback(address)) return true;
  if (isIP(address) === 4) {
    const [first, second] = address.split(".").map(Number);
    return (
      first === 10 ||
      (first === 172 && second! >= 16 && second! <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  const firstGroup = Number.parseInt(address.split(":")[0] || "0", 16);
  return (firstGroup & 0xfe00) === 0xfc00 || (firstGroup & 0xffc0) === 0xfe80;
}

function assertPort(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new NetworkExposureError(
      "EXPOSURE_CONFIG_INVALID",
      "listenPort must be an integer between 0 and 65535",
    );
  }
}

function hostLiteral(address: string): string {
  return isIP(address) === 6 ? `[${address}]` : address;
}

function canonicalOrigin(value: string, expectedScheme?: "http" | "https"): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new NetworkExposureError(
      "EXPOSURE_CONFIG_INVALID",
      "Configured origin is not a valid URL",
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    (expectedScheme !== undefined && parsed.protocol !== `${expectedScheme}:`) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new NetworkExposureError(
      "EXPOSURE_CONFIG_INVALID",
      "Configured origin must be a credential-free HTTP(S) origin",
    );
  }
  return parsed.origin.toLowerCase();
}

function singleHeader(
  value: NetworkHeaderValue,
  label: string,
  required: boolean,
): string | undefined {
  if (value === undefined) {
    if (required) {
      throw new NetworkExposureError(
        "EXPOSURE_HOST_DENIED",
        `${label} header is required`,
      );
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new NetworkExposureError(
        "EXPOSURE_FORWARDED_CONFLICT",
        `${label} must occur exactly once`,
      );
    }
    value = value[0];
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048 ||
    /[\r\n\u0000]/u.test(value)
  ) {
    throw new NetworkExposureError(
      "EXPOSURE_FORWARDED_DENIED",
      `${label} header is invalid`,
    );
  }
  return value.trim();
}

function canonicalAuthority(value: string, scheme: "http" | "https"): string {
  if (/[@/?#\\]/u.test(value)) {
    throw new NetworkExposureError(
      "EXPOSURE_HOST_DENIED",
      "Host authority contains forbidden characters",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(`${scheme}://${value}`);
  } catch {
    throw new NetworkExposureError("EXPOSURE_HOST_DENIED", "Host authority is invalid");
  }
  if (parsed.hostname.length === 0 || parsed.pathname !== "/") {
    throw new NetworkExposureError("EXPOSURE_HOST_DENIED", "Host authority is invalid");
  }
  return parsed.host.toLowerCase();
}

function parseForwardedHeader(value: string): ForwardedAuthority {
  if (value.includes(",") || value.includes('"')) {
    throw new NetworkExposureError(
      "EXPOSURE_FORWARDED_DENIED",
      "Forwarded must contain one unquoted proxy hop",
    );
  }
  const members = new Map<string, string>();
  for (const rawMember of value.split(";")) {
    const separator = rawMember.indexOf("=");
    if (separator <= 0) {
      throw new NetworkExposureError(
        "EXPOSURE_FORWARDED_DENIED",
        "Forwarded contains a malformed member",
      );
    }
    const key = rawMember.slice(0, separator).trim().toLowerCase();
    const memberValue = rawMember.slice(separator + 1).trim();
    if (!/^[a-z]+$/u.test(key) || memberValue.length === 0 || members.has(key)) {
      throw new NetworkExposureError(
        "EXPOSURE_FORWARDED_DENIED",
        "Forwarded contains a duplicate or invalid member",
      );
    }
    members.set(key, memberValue);
  }
  const proto = members.get("proto");
  const host = members.get("host");
  const client = members.get("for");
  if (proto === undefined || host === undefined || client === undefined) {
    throw new NetworkExposureError(
      "EXPOSURE_FORWARDED_DENIED",
      "Forwarded must include proto, host, and for",
    );
  }
  return {
    proto: proto.toLowerCase(),
    host: canonicalAuthority(host, proto.toLowerCase() === "https" ? "https" : "http"),
    clientAddress: canonicalIp(client, "Forwarded for"),
  };
}

function parseXForwarded(
  protoValue: NetworkHeaderValue,
  hostValue: NetworkHeaderValue,
  forValue: NetworkHeaderValue,
): ForwardedAuthority | undefined {
  const present = [protoValue, hostValue, forValue].filter((value) => value !== undefined).length;
  if (present === 0) return undefined;
  if (present !== 3) {
    throw new NetworkExposureError(
      "EXPOSURE_FORWARDED_DENIED",
      "X-Forwarded-Proto, X-Forwarded-Host, and X-Forwarded-For must be supplied together",
    );
  }
  const proto = singleHeader(protoValue, "X-Forwarded-Proto", true)!.toLowerCase();
  const host = singleHeader(hostValue, "X-Forwarded-Host", true)!;
  const client = singleHeader(forValue, "X-Forwarded-For", true)!;
  if (proto.includes(",") || host.includes(",") || client.includes(",")) {
    throw new NetworkExposureError(
      "EXPOSURE_FORWARDED_DENIED",
      "Only one trusted proxy hop is supported",
    );
  }
  return {
    proto,
    host: canonicalAuthority(host, proto === "https" ? "https" : "http"),
    clientAddress: canonicalIp(client, "X-Forwarded-For"),
  };
}

function forwardedEqual(left: ForwardedAuthority, right: ForwardedAuthority): boolean {
  return (
    left.proto === right.proto &&
    left.host === right.host &&
    left.clientAddress === right.clientAddress
  );
}

export class NetworkExposurePolicy {
  readonly #config: NetworkExposureConfig;
  readonly #listenAddress: string;
  readonly #trustedProxyAddresses: ReadonlySet<string>;
  readonly #externalOrigins: ReadonlySet<string>;

  constructor(config: NetworkExposureConfig) {
    assertPort(config.listenPort);
    if (config.mode === "local") {
      const listenHost = config.listenHost ?? "127.0.0.1";
      this.#listenAddress = canonicalIp(listenHost, "listenHost");
      if (!isLoopback(this.#listenAddress)) {
        throw new NetworkExposureError(
          "EXPOSURE_CONFIG_INVALID",
          "Local mode must bind an explicit loopback address",
        );
      }
      this.#config = deepFreeze({
        mode: "local",
        listenHost,
        listenPort: config.listenPort,
        scheme: config.scheme ?? "http",
      }) as LocalExposureConfig;
      this.#trustedProxyAddresses = new Set();
      this.#externalOrigins = new Set();
      return;
    }

    this.#listenAddress = canonicalIp(config.listenHost, "listenHost");
    if (!isPrivateUpstream(this.#listenAddress)) {
      throw new NetworkExposureError(
        "EXPOSURE_CONFIG_INVALID",
        "Reverse-proxy upstream must bind a loopback or private IP literal",
      );
    }
    if (
      config.trustedProxyAddresses.length < 1 ||
      config.trustedProxyAddresses.length > 32 ||
      config.externalOrigins.length < 1 ||
      config.externalOrigins.length > 32
    ) {
      throw new NetworkExposureError(
        "EXPOSURE_CONFIG_INVALID",
        "Reverse-proxy mode requires 1-32 trusted proxies and external origins",
      );
    }
    const trustedProxyAddresses = config.trustedProxyAddresses.map((address) =>
      canonicalIp(address, "trustedProxyAddresses"),
    );
    const externalOrigins = config.externalOrigins.map((origin) =>
      canonicalOrigin(origin, "https"),
    );
    if (
      new Set(trustedProxyAddresses).size !== trustedProxyAddresses.length ||
      new Set(externalOrigins).size !== externalOrigins.length
    ) {
      throw new NetworkExposureError(
        "EXPOSURE_CONFIG_INVALID",
        "Trusted proxies and external origins must not contain duplicates",
      );
    }
    this.#config = deepFreeze({
      mode: "reverse-proxy",
      listenHost: this.#listenAddress,
      listenPort: config.listenPort,
      trustedProxyAddresses,
      externalOrigins,
    }) as ReverseProxyExposureConfig;
    this.#trustedProxyAddresses = new Set(trustedProxyAddresses);
    this.#externalOrigins = new Set(externalOrigins);
  }

  get listenAddress(): Readonly<{ host: string; port: number }> {
    return Object.freeze({ host: this.#listenAddress, port: this.#config.listenPort });
  }

  validateListenerEndpoint(endpoint: NetworkListenerEndpoint): void {
    const expectedKind =
      this.#config.mode === "local" ? (this.#config.scheme ?? "http") : "http";
    if (endpoint.kind !== expectedKind) {
      throw new NetworkExposureError(
        "EXPOSURE_CONFIG_INVALID",
        "Readiness endpoint scheme does not match the configured listener",
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(endpoint.address);
    } catch {
      throw new NetworkExposureError(
        "EXPOSURE_CONFIG_INVALID",
        "Readiness endpoint is not a valid URL",
      );
    }
    if (
      parsed.protocol !== `${expectedKind}:` ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new NetworkExposureError(
        "EXPOSURE_CONFIG_INVALID",
        "Readiness endpoint is not a listener origin",
      );
    }
    const actualHost = canonicalIp(parsed.hostname, "readiness endpoint host");
    const actualPort = Number(parsed.port || (expectedKind === "http" ? 80 : 443));
    if (
      actualHost !== this.#listenAddress ||
      !Number.isSafeInteger(actualPort) ||
      actualPort < 1 ||
      actualPort > 65_535 ||
      (this.#config.listenPort !== 0 && actualPort !== this.#config.listenPort)
    ) {
      throw new NetworkExposureError(
        "EXPOSURE_CONFIG_INVALID",
        "Readiness endpoint does not match the configured listener",
      );
    }
  }

  withBoundPort(boundPort: number): NetworkExposurePolicy {
    assertPort(boundPort);
    if (boundPort === 0) {
      throw new NetworkExposureError(
        "EXPOSURE_CONFIG_INVALID",
        "A bound request policy requires the actual non-zero listener port",
      );
    }
    if (this.#config.mode === "local") {
      return new NetworkExposurePolicy({ ...this.#config, listenPort: boundPort });
    }
    return new NetworkExposurePolicy({ ...this.#config, listenPort: boundPort });
  }

  validateRequest(
    request: NetworkRequestMetadata,
    options: { readonly requireOrigin: boolean },
  ): NetworkRequestContext {
    if (this.#config.listenPort === 0) {
      throw new NetworkExposureError(
        "EXPOSURE_CONFIG_INVALID",
        "Request validation requires a policy rebound to the actual listener port",
      );
    }
    const peerAddress = canonicalIp(request.peerAddress, "peerAddress");
    const host = singleHeader(request.host, "Host", true)!;
    const origin = singleHeader(request.origin, "Origin", options.requireOrigin);
    const forwarded = singleHeader(request.forwarded, "Forwarded", false);
    const xForwarded = parseXForwarded(
      request.xForwardedProto,
      request.xForwardedHost,
      request.xForwardedFor,
    );

    if (this.#config.mode === "local") {
      if (!isLoopback(peerAddress)) {
        throw new NetworkExposureError(
          "EXPOSURE_PEER_DENIED",
          "Local mode accepts only loopback peers",
        );
      }
      if (forwarded !== undefined || xForwarded !== undefined) {
        throw new NetworkExposureError(
          "EXPOSURE_FORWARDED_DENIED",
          "Local mode rejects all forwarding headers",
        );
      }
      const scheme = this.#config.scheme ?? "http";
      if (request.encrypted !== (scheme === "https")) {
        throw new NetworkExposureError(
          "EXPOSURE_HTTPS_REQUIRED",
          "Transport encryption does not match the configured local scheme",
        );
      }
      const configuredAuthority = `${hostLiteral(this.#listenAddress)}:${this.#config.listenPort}`;
      const expectedAuthority = canonicalAuthority(configuredAuthority, scheme);
      if (canonicalAuthority(host, scheme) !== expectedAuthority) {
        throw new NetworkExposureError(
          "EXPOSURE_HOST_DENIED",
          "Host does not match the bound loopback endpoint",
        );
      }
      const effectiveOrigin = canonicalOrigin(`${scheme}://${configuredAuthority}`, scheme);
      if (origin !== undefined && canonicalOrigin(origin, scheme) !== effectiveOrigin) {
        throw new NetworkExposureError(
          "EXPOSURE_ORIGIN_DENIED",
          "Origin does not match the bound loopback endpoint",
        );
      }
      return deepFreeze({
        mode: "local",
        effectiveOrigin,
        clientAddress: peerAddress,
        peerAddress,
        viaTrustedProxy: false,
      });
    }

    if (!this.#trustedProxyAddresses.has(peerAddress)) {
      throw new NetworkExposureError(
        "EXPOSURE_PEER_DENIED",
        "Forwarding headers are accepted only from a configured proxy IP",
      );
    }
    const configuredDirectAuthority = `${hostLiteral(this.#listenAddress)}:${this.#config.listenPort}`;
    const directAuthority = canonicalAuthority(configuredDirectAuthority, "http");
    if (canonicalAuthority(host, "http") !== directAuthority) {
      throw new NetworkExposureError(
        "EXPOSURE_HOST_DENIED",
        "Proxy upstream Host does not match the configured listener",
      );
    }
    const standardForwarded = forwarded === undefined ? undefined : parseForwardedHeader(forwarded);
    if (!standardForwarded && !xForwarded) {
      throw new NetworkExposureError(
        "EXPOSURE_FORWARDED_DENIED",
        "Reverse-proxy mode requires authenticated forwarding metadata",
      );
    }
    if (standardForwarded && xForwarded && !forwardedEqual(standardForwarded, xForwarded)) {
      throw new NetworkExposureError(
        "EXPOSURE_FORWARDED_CONFLICT",
        "Forwarded and X-Forwarded-* headers disagree",
      );
    }
    const authority = standardForwarded ?? xForwarded!;
    if (authority.proto !== "https") {
      throw new NetworkExposureError(
        "EXPOSURE_HTTPS_REQUIRED",
        "The external request must use HTTPS",
      );
    }
    const effectiveOrigin = canonicalOrigin(`https://${authority.host}`, "https");
    if (!this.#externalOrigins.has(effectiveOrigin)) {
      throw new NetworkExposureError(
        "EXPOSURE_HOST_DENIED",
        "Forwarded host is not an allowed external origin",
      );
    }
    if (origin !== undefined && canonicalOrigin(origin, "https") !== effectiveOrigin) {
      throw new NetworkExposureError(
        "EXPOSURE_ORIGIN_DENIED",
        "Browser Origin does not match the forwarded external origin",
      );
    }
    return deepFreeze({
      mode: "reverse-proxy",
      effectiveOrigin,
      clientAddress: authority.clientAddress,
      peerAddress,
      viaTrustedProxy: true,
    });
  }
}
