import { isIP } from "node:net";
import { deepFreeze, isJsonObject, type JsonValue } from "../canonical-json.js";
import {
  assertClosedArguments,
  assertHostIdentifier,
  assertPositiveLimit,
  capabilityArgumentError,
  optionalString,
  readField,
  requireString,
  resolveExecutionScope,
  type ExtensionCapabilityDefinition,
} from "../capabilities/capability-support.js";
import {
  ExtensionCapabilityError,
  type ExtensionCapabilityGrant,
  type ExtensionCapabilityInvocationContext,
  type ExtensionExecutionScope,
} from "../extension-capability.js";
import type { ModelSecretLease, ModelSecretResolver } from "../model-provider-broker.js";
import {
  SecureRemoteFetchError,
  resolvePinnedPublicAddress,
  sameNetworkAddress,
  type ResolvedNetworkAddress,
  type SecureDnsResolver,
} from "../secure-remote-fetch.js";
import {
  OutboundHttpTransportError,
  type OutboundHttpTransport,
  type OutboundHttpTransportResponse,
} from "./outbound-http-transport.js";

export const OUTBOUND_HTTP_CAPABILITY_TYPE = "outbound-http";
export const OUTBOUND_HTTP_CAPABILITY_VERSION = "v1";

export type OutboundHttpOperation = "request" | "describe";
export type OutboundHttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

const HTTP_OPERATIONS: readonly OutboundHttpOperation[] = ["request", "describe"];
const METHODS: readonly OutboundHttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const BODYLESS_METHODS: readonly OutboundHttpMethod[] = ["GET", "HEAD"];
const REDIRECT_STATUS: readonly number[] = [301, 302, 303, 307, 308];

/**
 * Header names an extension may never set, whatever the host allowlisted.
 *
 * Each one either carries authority the host owns (`authorization`, `cookie`),
 * re-targets the request behind the validated destination (`host`, the
 * forwarding family), or lets a request smuggle a second message past the
 * length and encoding bounds this capability enforces.
 */
const FORBIDDEN_REQUEST_HEADERS: readonly string[] = [
  "authorization",
  "proxy-authorization",
  "proxy-connection",
  "cookie",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "accept-encoding",
  "via",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
];

const DEFAULT_RESPONSE_HEADER_ALLOWLIST: readonly string[] = [
  "content-type",
  "content-length",
  "date",
  "etag",
  "last-modified",
  "retry-after",
];

const HEADER_NAME_PATTERN = /^[a-z0-9][a-z0-9!#$%&'*+.^_`|~-]{0,63}$/u;

export type OutboundHttpDenialReason =
  | "HTTP_URL_INVALID"
  | "HTTP_SCHEME_DENIED"
  | "HTTP_HOST_DENIED"
  | "HTTP_PORT_DENIED"
  | "HTTP_PATH_DENIED"
  | "HTTP_METHOD_DENIED"
  | "HTTP_HEADER_DENIED"
  | "HTTP_BODY_NOT_ALLOWED"
  | "HTTP_REQUEST_LIMIT"
  | "HTTP_RESPONSE_LIMIT"
  | "HTTP_REDIRECT_DENIED"
  | "HTTP_REDIRECT_LIMIT"
  | "HTTP_REDIRECT_INVALID"
  | "HTTP_CROSS_HOST_REDIRECT_DENIED"
  | "HTTP_DNS_FAILED"
  | "HTTP_DNS_EMPTY"
  | "HTTP_ADDRESS_DENIED"
  | "HTTP_ADDRESS_MISMATCH"
  | "HTTP_CREDENTIAL_UNAVAILABLE"
  | "HTTP_CREDENTIAL_ECHOED"
  | "HTTP_TRANSPORT_FAILED"
  | "HTTP_RESPONSE_INVALID";

export interface OutboundHttpDestinationPolicy {
  readonly networkScope: "public" | "loopback";
  /** Exact hostnames; no wildcard, no suffix match. */
  readonly allowedHosts: readonly string[];
  /** Explicit TCP ports; defaults to the scheme default for the public scope. */
  readonly allowedPorts?: readonly number[];
  readonly allowedMethods?: readonly OutboundHttpMethod[];
  /** Exact path or path prefix; a prefix matches only on a segment boundary. */
  readonly allowedPathPrefixes: readonly string[];
  readonly allowQuery?: boolean;
}

export interface OutboundHttpRedirectPolicy {
  readonly mode: "deny" | "same-host";
  readonly maxRedirects: number;
}

export type OutboundHttpCredentialBinding =
  | { readonly kind: "none" }
  | {
      readonly kind: "bearer-secret";
      /** Stable non-secret name of a deployment-owned secret binding. */
      readonly secretRef: string;
      readonly secretRevision: string;
    };

export interface OutboundHttpLimits {
  readonly maxUrlBytes: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxRequestHeaders: number;
  readonly maxRequestHeaderBytes: number;
  readonly maxResponseHeaderBytes: number;
  readonly connectTimeoutMs: number;
  readonly headerTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxInvocations: number;
  readonly maxArgumentBytes: number;
}

export const DEFAULT_OUTBOUND_HTTP_LIMITS: OutboundHttpLimits = deepFreeze({
  maxUrlBytes: 2_048,
  maxRequestBytes: 64 * 1_024,
  maxResponseBytes: 256 * 1_024,
  maxRequestHeaders: 16,
  maxRequestHeaderBytes: 4_096,
  maxResponseHeaderBytes: 16 * 1_024,
  connectTimeoutMs: 5_000,
  headerTimeoutMs: 10_000,
  totalTimeoutMs: 30_000,
  maxInvocations: 64,
  maxArgumentBytes: 128 * 1_024,
});

/**
 * One non-secret audit line per outbound attempt.
 *
 * It records where the host let the request go and how it ended. It carries no
 * credential, no request or response body, and no header values.
 */
export interface OutboundHttpAuditRecord {
  readonly schemaVersion: "dolly.outbound-http-audit/1";
  readonly moduleJobId: string;
  readonly runId: string;
  readonly method: string;
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly redirects: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly authentication: "none" | "host-attached";
  readonly outcome: "succeeded" | "denied" | "failed";
  readonly status?: number;
  readonly reason?: OutboundHttpDenialReason;
}

export interface OutboundHttpAuditSink {
  append(record: OutboundHttpAuditRecord): void;
}

export interface OutboundHttpCapabilityOptions {
  readonly destination: OutboundHttpDestinationPolicy;
  readonly redirects: OutboundHttpRedirectPolicy;
  readonly credential: OutboundHttpCredentialBinding;
  /** Resolves a secret binding into a short-lived lease the host attaches. */
  readonly secrets?: ModelSecretResolver;
  readonly transport: OutboundHttpTransport;
  readonly resolver: SecureDnsResolver;
  readonly executionScope: ExtensionExecutionScope;
  readonly expiresAt: string;
  readonly operations?: readonly OutboundHttpOperation[];
  readonly limits?: Partial<OutboundHttpLimits>;
  /** Header names an extension may set; forbidden names are rejected here. */
  readonly requestHeaderAllowlist?: readonly string[];
  /** Header names returned to the extension; everything else is dropped. */
  readonly responseHeaderAllowlist?: readonly string[];
  /** Host-owned headers merged under the extension's allowlisted headers. */
  readonly defaultRequestHeaders?: Readonly<Record<string, string>>;
  readonly audit?: OutboundHttpAuditSink;
  readonly maxConcurrentInvocations?: number;
  readonly requireIdempotencyKey?: boolean;
}

class OutboundHttpDenial extends Error {
  constructor(
    readonly reason: OutboundHttpDenialReason,
    readonly capabilityCode: ExtensionCapabilityError["code"],
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "OutboundHttpDenial";
  }

  toCapabilityError(): ExtensionCapabilityError {
    return new ExtensionCapabilityError(this.capabilityCode, this.message, {
      reason: this.reason,
      ...this.details,
    });
  }
}

function denied(
  reason: OutboundHttpDenialReason,
  message: string,
  details: Readonly<Record<string, JsonValue>> = {},
): OutboundHttpDenial {
  return new OutboundHttpDenial(reason, "CAPABILITY_DENIED", message, details);
}

function quota(
  reason: OutboundHttpDenialReason,
  message: string,
  details: Readonly<Record<string, JsonValue>> = {},
): OutboundHttpDenial {
  return new OutboundHttpDenial(reason, "CAPABILITY_QUOTA_EXCEEDED", message, details);
}

function dependencyFailure(
  reason: OutboundHttpDenialReason,
  message: string,
  details: Readonly<Record<string, JsonValue>> = {},
): OutboundHttpDenial {
  return new OutboundHttpDenial(reason, "CAPABILITY_DEPENDENCY_FAILED", message, details);
}

function configError(message: string): ExtensionCapabilityError {
  return new ExtensionCapabilityError("CAPABILITY_CONFIG_INVALID", message);
}

function normalizeHostname(value: string): string {
  const hostname = value
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  if (hostname.length === 0) {
    throw denied("HTTP_URL_INVALID", "Outbound URL hostname is empty");
  }
  return hostname;
}

function loopbackIpv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/u.test(part) || Number(part) > 255) return false;
  }
  return Number(parts[0]) === 127;
}

/** True only for 127.0.0.0/8, `::1`, and the IPv4-mapped forms of those. */
export function isLoopbackNetworkAddress(value: string): boolean {
  const address = value.replace(/^\[|\]$/gu, "");
  const family = isIP(address);
  if (family === 4) return loopbackIpv4(address);
  if (family !== 6) return false;
  if (sameNetworkAddress(address, "::1")) return true;
  const mapped = /^::ffff:([0-9]+(?:\.[0-9]+){3})$/iu.exec(address);
  return mapped === null ? false : loopbackIpv4(mapped[1]!);
}

function resolveLimits(overrides: Partial<OutboundHttpLimits> | undefined): OutboundHttpLimits {
  const limits = { ...DEFAULT_OUTBOUND_HTTP_LIMITS, ...(overrides ?? {}) };
  for (const [label, value] of Object.entries(limits)) {
    assertPositiveLimit(value, `outbound http ${label}`);
  }
  if (limits.connectTimeoutMs > limits.totalTimeoutMs || limits.headerTimeoutMs > limits.totalTimeoutMs) {
    throw configError("Outbound HTTP connect/header timeouts cannot exceed totalTimeoutMs");
  }
  return deepFreeze(limits);
}

function sortedAddresses(
  records: readonly ResolvedNetworkAddress[],
): readonly ResolvedNetworkAddress[] {
  return [...records].sort((left, right) => {
    if (left.family !== right.family) return left.family - right.family;
    return left.address < right.address ? -1 : left.address > right.address ? 1 : 0;
  });
}

/**
 * Builds the endpoint-scoped outbound HTTP capability.
 *
 * Section 6.1 of `extension-process-protocol.md` requires a network capability
 * to constrain scheme, destination, port, redirect policy, DNS resolution,
 * request size, response size, and the allowed authentication binding, and to
 * revalidate redirects and DNS changes. Each hop here re-runs the full
 * destination check, re-resolves the name, re-validates every returned address,
 * and connects to the address it just validated, so neither a redirect nor a
 * changed record can move the request to a destination the grant never named.
 * The credential is resolved and attached by the host on each hop and is never
 * part of a handle, an argument, a result, or an audit record.
 */
export function createOutboundHttpCapability(
  options: OutboundHttpCapabilityOptions,
): ExtensionCapabilityDefinition {
  const limits = resolveLimits(options.limits);
  const moduleJobId = assertHostIdentifier(options.executionScope.moduleJobId, "moduleJobId");
  const runId = assertHostIdentifier(options.executionScope.runId, "runId");

  const networkScope = options.destination.networkScope;
  if (networkScope !== "public" && networkScope !== "loopback") {
    throw configError("Outbound HTTP networkScope must be public or loopback");
  }
  const scheme = networkScope === "public" ? "https:" : "http:";
  const defaultPort = networkScope === "public" ? 443 : 80;

  const allowedHosts = [
    ...new Set(
      options.destination.allowedHosts.map((host) => {
        if (typeof host !== "string" || host.trim().length === 0) {
          throw configError("Outbound HTTP allowedHosts contains an empty hostname");
        }
        return host.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
      }),
    ),
  ].sort();
  if (allowedHosts.length === 0) {
    throw configError("Outbound HTTP requires at least one exact allowed host");
  }
  const configuredPorts = options.destination.allowedPorts ?? [];
  for (const port of configuredPorts) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw configError("Outbound HTTP allowedPorts must contain valid TCP ports");
    }
  }
  const allowedPorts = [...new Set(configuredPorts.length === 0 ? [defaultPort] : configuredPorts)]
    .sort((left, right) => left - right);
  const allowedMethods: OutboundHttpMethod[] = [];
  for (const method of new Set((options.destination.allowedMethods ?? ["GET"]) as readonly string[])) {
    if (!(METHODS as readonly string[]).includes(method)) {
      throw configError(`Outbound HTTP method ${String(method)} is not supported`);
    }
    allowedMethods.push(method as OutboundHttpMethod);
  }
  const allowedPathPrefixes = [...new Set(options.destination.allowedPathPrefixes)];
  if (allowedPathPrefixes.length === 0) {
    throw configError("Outbound HTTP requires at least one allowed path prefix");
  }
  for (const prefix of allowedPathPrefixes) {
    if (typeof prefix !== "string" || !prefix.startsWith("/")) {
      throw configError("Outbound HTTP path prefixes must be absolute paths");
    }
  }
  const allowQuery = options.destination.allowQuery === true;

  if (options.redirects.mode !== "deny" && options.redirects.mode !== "same-host") {
    throw configError("Outbound HTTP redirect mode must be deny or same-host");
  }
  if (!Number.isSafeInteger(options.redirects.maxRedirects) || options.redirects.maxRedirects < 0) {
    throw configError("Outbound HTTP maxRedirects must be a non-negative safe integer");
  }
  const redirectPolicy = deepFreeze({ ...options.redirects });

  const credential = options.credential;
  if (credential.kind !== "none" && credential.kind !== "bearer-secret") {
    throw configError("Outbound HTTP credential binding is unsupported");
  }
  if (credential.kind === "bearer-secret") {
    assertHostIdentifier(credential.secretRef, "credential.secretRef");
    assertHostIdentifier(credential.secretRevision, "credential.secretRevision");
    if (!options.secrets) {
      throw configError("A secret-bound outbound HTTP capability requires a secret resolver");
    }
  }

  const requestHeaderAllowlist = [
    ...new Set((options.requestHeaderAllowlist ?? []).map((name) => name.toLowerCase())),
  ].sort();
  for (const name of requestHeaderAllowlist) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw configError(`Outbound HTTP request header ${name} is not a valid header name`);
    }
    if (FORBIDDEN_REQUEST_HEADERS.includes(name)) {
      // Allowlisting one of these would hand the extension either the host's
      // authentication slot or a way to re-target the validated destination.
      throw configError(`Outbound HTTP request header ${name} can never be extension-controlled`);
    }
  }
  const responseHeaderAllowlist = [
    ...new Set(
      (options.responseHeaderAllowlist ?? DEFAULT_RESPONSE_HEADER_ALLOWLIST).map((name) =>
        name.toLowerCase(),
      ),
    ),
  ].sort();
  for (const name of responseHeaderAllowlist) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw configError(`Outbound HTTP response header ${name} is not a valid header name`);
    }
  }
  const defaultRequestHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.defaultRequestHeaders ?? {})) {
    const lowered = name.toLowerCase();
    if (!HEADER_NAME_PATTERN.test(lowered) || FORBIDDEN_REQUEST_HEADERS.includes(lowered)) {
      throw configError(`Outbound HTTP default header ${lowered} is not settable`);
    }
    if (typeof value !== "string" || /[\r\n]/u.test(value)) {
      throw configError(`Outbound HTTP default header ${lowered} has an invalid value`);
    }
    defaultRequestHeaders[lowered] = value;
  }

  const operations = [...new Set(options.operations ?? HTTP_OPERATIONS)];
  if (operations.length === 0) {
    throw configError("An outbound HTTP capability requires at least one operation");
  }
  for (const operation of operations) {
    if (!HTTP_OPERATIONS.includes(operation)) {
      throw configError(`Outbound HTTP does not define the operation ${String(operation)}`);
    }
  }
  const enabled = new Set<OutboundHttpOperation>(operations);

  const grant: ExtensionCapabilityGrant = {
    capabilityType: OUTBOUND_HTTP_CAPABILITY_TYPE,
    capabilityVersion: OUTBOUND_HTTP_CAPABILITY_VERSION,
    operations,
    resourceScope: {
      schemaVersion: "dolly.capability-scope.outbound-http/1",
      moduleJobId,
      networkScope,
      scheme,
      allowedHosts: [...allowedHosts],
      allowedPorts: [...allowedPorts],
      allowedMethods: [...allowedMethods].sort(),
      allowedPathPrefixes: [...allowedPathPrefixes].sort(),
      allowQuery,
      redirects: { mode: redirectPolicy.mode, maxRedirects: redirectPolicy.maxRedirects },
      // The binding is named, never valued: the scope records that the host
      // will authenticate, not what it will authenticate with.
      authentication:
        credential.kind === "none"
          ? { kind: "none" }
          : { kind: "bearer-secret", secretRef: credential.secretRef },
      requestHeaderAllowlist: [...requestHeaderAllowlist],
      responseHeaderAllowlist: [...responseHeaderAllowlist],
      limits: { ...limits },
    },
    expiresAt: options.expiresAt,
    maxInvocations: limits.maxInvocations,
    maxConcurrentInvocations: options.maxConcurrentInvocations ?? 2,
    maxArgumentBytes: limits.maxArgumentBytes,
    // Base64 expands by 4/3; the remainder covers the envelope and headers.
    maxResultBytes:
      Math.ceil(limits.maxResponseBytes / 3) * 4 + limits.maxResponseHeaderBytes + 4_096,
    executionScope: { moduleJobId, runId },
    ...(options.requireIdempotencyKey === true ? { requireIdempotencyKey: true } : {}),
  };

  const authorizeUrl = (candidate: string): URL => {
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new OutboundHttpDenial(
        "HTTP_URL_INVALID",
        "CAPABILITY_ARGUMENT_INVALID",
        "Outbound URL must be a non-empty string",
      );
    }
    if (Buffer.byteLength(candidate, "utf8") > limits.maxUrlBytes) {
      throw quota("HTTP_URL_INVALID", "Outbound URL exceeds its byte limit", {
        maxUrlBytes: limits.maxUrlBytes,
      });
    }
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new OutboundHttpDenial(
        "HTTP_URL_INVALID",
        "CAPABILITY_ARGUMENT_INVALID",
        "Outbound URL is not a valid absolute URL",
      );
    }
    if (url.username !== "" || url.password !== "" || url.hash !== "") {
      throw new OutboundHttpDenial(
        "HTTP_URL_INVALID",
        "CAPABILITY_ARGUMENT_INVALID",
        "Outbound URL must carry no credentials and no fragment",
      );
    }
    if (url.protocol !== scheme) {
      throw denied("HTTP_SCHEME_DENIED", "Outbound URL scheme is outside the grant", {
        scheme: url.protocol,
      });
    }
    const hostname = normalizeHostname(url.hostname);
    if (!allowedHosts.includes(hostname)) {
      // The extension named this destination; the grant did not. An
      // extension-supplied endpoint is a request, never an authority.
      throw denied("HTTP_HOST_DENIED", "Outbound host is outside the grant allowlist", {
        host: hostname,
      });
    }
    const port = url.port === "" ? defaultPort : Number(url.port);
    if (!allowedPorts.includes(port)) {
      throw denied("HTTP_PORT_DENIED", "Outbound TCP port is outside the grant allowlist", {
        port,
      });
    }
    if (!allowQuery && url.search !== "") {
      throw denied("HTTP_PATH_DENIED", "This grant does not allow a query string");
    }
    const path = url.pathname;
    const permitted = allowedPathPrefixes.some(
      (prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
    );
    if (!permitted) {
      throw denied("HTTP_PATH_DENIED", "Outbound path is outside the grant allowlist", { path });
    }
    return url;
  };

  const resolveAddress = async (hostnameInput: string): Promise<ResolvedNetworkAddress> => {
    const hostname = normalizeHostname(hostnameInput);
    if (networkScope === "public") {
      try {
        return await resolvePinnedPublicAddress(options.resolver, hostname);
      } catch (error) {
        if (error instanceof SecureRemoteFetchError && error.code === "REMOTE_ADDRESS_DENIED") {
          throw denied("HTTP_ADDRESS_DENIED", "Destination resolved to a non-public address");
        }
        if (error instanceof SecureRemoteFetchError && error.code === "REMOTE_DNS_EMPTY") {
          throw dependencyFailure("HTTP_DNS_EMPTY", "Destination resolved to no address");
        }
        throw dependencyFailure("HTTP_DNS_FAILED", "Destination name resolution failed");
      }
    }
    const literal = hostname.replace(/^\[|\]$/gu, "");
    const family = isIP(literal);
    let records: readonly ResolvedNetworkAddress[];
    if (family === 4 || family === 6) {
      records = [{ address: literal, family }];
    } else {
      try {
        records = await options.resolver.resolve(hostname);
      } catch {
        throw dependencyFailure("HTTP_DNS_FAILED", "Destination name resolution failed");
      }
    }
    if (records.length === 0) {
      throw dependencyFailure("HTTP_DNS_EMPTY", "Destination resolved to no address");
    }
    for (const record of records) {
      // Every record must satisfy the scope. A name that mixes an in-scope
      // record with an out-of-scope one is refused rather than filtered, so a
      // later resolution cannot quietly select the address we rejected.
      if (isIP(record.address) !== record.family || !isLoopbackNetworkAddress(record.address)) {
        throw denied("HTTP_ADDRESS_DENIED", "Destination resolved outside the loopback scope");
      }
    }
    return sortedAddresses(records)[0]!;
  };

  const readRequestHeaders = (value: JsonValue | undefined): Readonly<Record<string, string>> => {
    if (value === undefined) return {};
    if (!isJsonObject(value)) {
      throw capabilityArgumentError("http.request.headers must be a JSON object when present");
    }
    const names = Object.keys(value);
    if (names.length > limits.maxRequestHeaders) {
      throw quota("HTTP_HEADER_DENIED", "Outbound request header count exceeds its limit", {
        maxRequestHeaders: limits.maxRequestHeaders,
      });
    }
    const headers: Record<string, string> = {};
    let headerBytes = 0;
    for (const name of names) {
      const lowered = name.toLowerCase();
      if (!HEADER_NAME_PATTERN.test(lowered) || FORBIDDEN_REQUEST_HEADERS.includes(lowered)) {
        throw denied("HTTP_HEADER_DENIED", "Outbound request header is not extension-settable", {
          header: lowered,
        });
      }
      if (!requestHeaderAllowlist.includes(lowered)) {
        throw denied("HTTP_HEADER_DENIED", "Outbound request header is outside the grant", {
          header: lowered,
        });
      }
      const headerValue = value[name];
      if (typeof headerValue !== "string" || /[\r\n ]/u.test(headerValue)) {
        throw capabilityArgumentError(`http.request.headers.${lowered} must be a single-line string`);
      }
      headerBytes += Buffer.byteLength(lowered, "utf8") + Buffer.byteLength(headerValue, "utf8");
      if (headerBytes > limits.maxRequestHeaderBytes) {
        throw quota("HTTP_HEADER_DENIED", "Outbound request headers exceed their byte limit", {
          maxRequestHeaderBytes: limits.maxRequestHeaderBytes,
        });
      }
      headers[lowered] = headerValue;
    }
    return headers;
  };

  const readBody = (
    parsed: Readonly<Record<string, JsonValue>>,
    method: OutboundHttpMethod,
  ): Uint8Array | undefined => {
    const body = readField(parsed, "body");
    if (body === undefined) return undefined;
    if (typeof body !== "string") {
      throw capabilityArgumentError("http.request.body must be a string when present");
    }
    if (BODYLESS_METHODS.includes(method)) {
      throw denied("HTTP_BODY_NOT_ALLOWED", "This HTTP method cannot carry a request body", {
        method,
      });
    }
    const bytes = Buffer.from(body, "utf8");
    // Checked before any transport work so an oversized body is never
    // buffered into a socket and never reaches the destination.
    if (bytes.byteLength > limits.maxRequestBytes) {
      throw quota("HTTP_REQUEST_LIMIT", "Outbound request body exceeds its byte limit", {
        maxRequestBytes: limits.maxRequestBytes,
      });
    }
    return bytes;
  };

  const readResponseBody = async (
    response: OutboundHttpTransportResponse,
  ): Promise<Uint8Array> => {
    const contentLength = response.headers["content-length"];
    if (contentLength !== undefined) {
      if (!/^(0|[1-9][0-9]*)$/u.test(contentLength)) {
        response.abort();
        throw denied("HTTP_RESPONSE_INVALID", "Response Content-Length is malformed");
      }
      // Refused on the declared length, before a single body byte is read.
      if (Number(contentLength) > limits.maxResponseBytes) {
        response.abort();
        throw quota("HTTP_RESPONSE_LIMIT", "Response Content-Length exceeds its byte limit", {
          maxResponseBytes: limits.maxResponseBytes,
        });
      }
    }
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
      for await (const chunk of response.body) {
        if (!(chunk instanceof Uint8Array)) {
          throw denied("HTTP_RESPONSE_INVALID", "Response transport produced a non-byte chunk");
        }
        byteLength += chunk.byteLength;
        if (byteLength > limits.maxResponseBytes) {
          throw quota("HTTP_RESPONSE_LIMIT", "Response body exceeds its byte limit", {
            maxResponseBytes: limits.maxResponseBytes,
          });
        }
        chunks.push(chunk);
      }
    } catch (error) {
      response.abort(error instanceof Error ? error : undefined);
      if (error instanceof OutboundHttpDenial) throw error;
      throw dependencyFailure("HTTP_TRANSPORT_FAILED", "Response stream failed");
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  };

  const acquireSecret = async (): Promise<ModelSecretLease | undefined> => {
    if (credential.kind !== "bearer-secret") return undefined;
    let lease: ModelSecretLease;
    try {
      lease = await options.secrets!.resolve(credential.secretRef, credential.secretRevision);
    } catch {
      throw dependencyFailure(
        "HTTP_CREDENTIAL_UNAVAILABLE",
        "The bound secret could not be resolved",
      );
    }
    if (
      typeof lease.value !== "string" ||
      lease.value.length === 0 ||
      /[\r\n]/u.test(lease.value)
    ) {
      void Promise.resolve(lease.release()).catch(() => undefined);
      throw dependencyFailure(
        "HTTP_CREDENTIAL_UNAVAILABLE",
        "The bound secret is not a usable header credential",
      );
    }
    return lease;
  };

  const handler = async (
    argumentsValue: JsonValue,
    context: ExtensionCapabilityInvocationContext,
  ): Promise<JsonValue> => {
    const operation = context.operation as OutboundHttpOperation;
    if (!enabled.has(operation)) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_DENIED",
        "This handle does not authorize the operation",
        { reason: "HTTP_METHOD_DENIED" },
      );
    }
    const scope = resolveExecutionScope({ moduleJobId, runId }, context);

    if (operation === "describe") {
      assertClosedArguments(argumentsValue, [], "http.describe");
      return {
        schemaVersion: "dolly.outbound-http-description/1",
        networkScope,
        scheme,
        allowedHosts: [...allowedHosts],
        allowedPorts: [...allowedPorts],
        allowedMethods: [...allowedMethods].sort(),
        allowedPathPrefixes: [...allowedPathPrefixes].sort(),
        allowQuery,
        redirects: { mode: redirectPolicy.mode, maxRedirects: redirectPolicy.maxRedirects },
        // Whether the host authenticates, never how.
        authenticated: credential.kind !== "none",
        requestHeaderAllowlist: [...requestHeaderAllowlist],
        limits: {
          maxUrlBytes: limits.maxUrlBytes,
          maxRequestBytes: limits.maxRequestBytes,
          maxResponseBytes: limits.maxResponseBytes,
          maxRequestHeaders: limits.maxRequestHeaders,
          totalTimeoutMs: limits.totalTimeoutMs,
        },
      };
    }

    const parsed = assertClosedArguments(
      argumentsValue,
      ["url", "method", "headers", "body"],
      "http.request",
    );
    let audit: {
      method: string;
      host: string;
      port: number;
      path: string;
      requestBytes: number;
      responseBytes: number;
      redirects: number;
      status?: number;
    } = {
      method: "",
      host: "",
      port: 0,
      path: "",
      requestBytes: 0,
      responseBytes: 0,
      redirects: 0,
    };
    const emit = (
      outcome: OutboundHttpAuditRecord["outcome"],
      reason?: OutboundHttpDenialReason,
    ): void => {
      if (!options.audit) return;
      options.audit.append(
        deepFreeze({
          schemaVersion: "dolly.outbound-http-audit/1",
          moduleJobId: scope.moduleJobId,
          runId: scope.runId,
          method: audit.method,
          host: audit.host,
          port: audit.port,
          path: audit.path,
          redirects: audit.redirects,
          requestBytes: audit.requestBytes,
          responseBytes: audit.responseBytes,
          authentication: credential.kind === "none" ? "none" : "host-attached",
          outcome,
          ...(audit.status === undefined ? {} : { status: audit.status }),
          ...(reason === undefined ? {} : { reason }),
        }) as OutboundHttpAuditRecord,
      );
    };

    let lease: ModelSecretLease | undefined;
    try {
      const methodInput = optionalString(parsed, "method", "http.request") ?? "GET";
      const method = methodInput.toUpperCase() as OutboundHttpMethod;
      if (!METHODS.includes(method) || !allowedMethods.includes(method)) {
        throw denied("HTTP_METHOD_DENIED", "Outbound HTTP method is outside the grant", {
          method: methodInput,
        });
      }
      const extensionHeaders = readRequestHeaders(readField(parsed, "headers"));
      const body = readBody(parsed, method);
      let current = authorizeUrl(requireString(parsed, "url", "http.request"));
      audit = {
        method,
        host: normalizeHostname(current.hostname),
        port: current.port === "" ? defaultPort : Number(current.port),
        path: current.pathname,
        requestBytes: body?.byteLength ?? 0,
        responseBytes: 0,
        redirects: 0,
      };

      lease = await acquireSecret();
      const secretValue = lease?.value;
      let redirects = 0;

      for (;;) {
        // Every hop resolves the current name again and revalidates the
        // records; the connection is then pinned to that exact address.
        const address = await resolveAddress(current.hostname);
        const headers: Record<string, string> = {
          ...defaultRequestHeaders,
          ...extensionHeaders,
          accept: extensionHeaders.accept ?? defaultRequestHeaders.accept ?? "*/*",
          "accept-encoding": "identity",
        };
        if (secretValue !== undefined) headers.authorization = `Bearer ${secretValue}`;

        let response: OutboundHttpTransportResponse;
        try {
          response = await options.transport.request({
            url: current,
            address,
            method,
            headers: deepFreeze(headers),
            ...(body === undefined ? {} : { body }),
            connectTimeoutMs: limits.connectTimeoutMs,
            headerTimeoutMs: limits.headerTimeoutMs,
            totalTimeoutMs: limits.totalTimeoutMs,
            maxResponseHeaderBytes: limits.maxResponseHeaderBytes,
            signal: context.signal,
          });
        } catch (error) {
          throw dependencyFailure(
            "HTTP_TRANSPORT_FAILED",
            "Outbound HTTP request failed",
            error instanceof OutboundHttpTransportError ? { outcome: error.outcome } : {},
          );
        }
        if (!sameNetworkAddress(response.connectedAddress, address.address)) {
          response.abort();
          throw denied(
            "HTTP_ADDRESS_MISMATCH",
            "The connection did not use the validated address",
          );
        }
        if (
          !Number.isSafeInteger(response.status) ||
          response.status < 100 ||
          response.status > 599
        ) {
          response.abort();
          throw denied("HTTP_RESPONSE_INVALID", "Response status is invalid");
        }
        audit.status = response.status;

        if (REDIRECT_STATUS.includes(response.status)) {
          response.abort();
          if (redirectPolicy.mode === "deny") {
            throw denied("HTTP_REDIRECT_DENIED", "This grant does not follow redirects", {
              status: response.status,
            });
          }
          if (body !== undefined) {
            throw denied(
              "HTTP_REDIRECT_DENIED",
              "A request that carries a body is never replayed to a redirect target",
              { status: response.status },
            );
          }
          if (redirects >= redirectPolicy.maxRedirects) {
            throw denied("HTTP_REDIRECT_LIMIT", "Response exceeded the redirect limit", {
              maxRedirects: redirectPolicy.maxRedirects,
            });
          }
          const location = response.headers.location;
          if (location === undefined || location.length === 0) {
            throw denied("HTTP_REDIRECT_INVALID", "Redirect response omitted Location");
          }
          let target: URL;
          try {
            target = new URL(location, current);
          } catch {
            throw denied("HTTP_REDIRECT_INVALID", "Redirect Location is not a valid URL");
          }
          // The target passes the same destination policy as the first hop,
          // and may not leave the host the extension was authorized to reach.
          const next = authorizeUrl(target.href);
          if (normalizeHostname(next.hostname) !== normalizeHostname(current.hostname)) {
            throw denied(
              "HTTP_CROSS_HOST_REDIRECT_DENIED",
              "This grant does not follow a redirect to another host",
              { host: normalizeHostname(next.hostname) },
            );
          }
          current = next;
          redirects += 1;
          audit.redirects = redirects;
          audit.path = current.pathname;
          continue;
        }

        const bytes = await readResponseBody(response);
        audit.responseBytes = bytes.byteLength;
        const responseHeaders: Record<string, string> = {};
        for (const name of responseHeaderAllowlist) {
          const value = response.headers[name];
          if (value !== undefined) responseHeaders[name] = value;
        }
        if (secretValue !== undefined) {
          const echoed =
            Object.values(responseHeaders).some((value) => value.includes(secretValue)) ||
            Buffer.from(bytes).includes(Buffer.from(secretValue, "utf8"));
          if (echoed) {
            // Returning this response would hand the extension the credential
            // the host attached on its behalf.
            throw denied(
              "HTTP_CREDENTIAL_ECHOED",
              "The response reflected the host-attached credential",
            );
          }
        }
        emit("succeeded");
        return {
          schemaVersion: "dolly.outbound-http-response/1",
          status: response.status,
          headers: responseHeaders,
          redirects,
          finalUrl: current.href,
          byteLength: bytes.byteLength,
          bodyBase64: Buffer.from(bytes).toString("base64"),
        };
      }
    } catch (error) {
      if (error instanceof OutboundHttpDenial) {
        emit(error.capabilityCode === "CAPABILITY_DEPENDENCY_FAILED" ? "failed" : "denied", error.reason);
        throw error.toCapabilityError();
      }
      emit("denied");
      throw error;
    } finally {
      if (lease) {
        try {
          void Promise.resolve(lease.release()).catch(() => undefined);
        } catch {
          // A lease cleanup failure never surfaces secret-manager detail.
        }
      }
    }
  };

  return { grant, handler };
}
