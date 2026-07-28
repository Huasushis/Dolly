/**
 * The management console's Hypertext Transfer Protocol (HTTP) surface.
 *
 * This module is an adapter, not a second implementation. Every route maps one
 * request onto exactly one `ConsoleOperations` method, so the graphical editor
 * cannot reach a validation, planning, commit, or audit path the command-line
 * interface (CLI) lacks — `instance-topology.md` Sections 5.3 and 5.4.
 *
 * The security controls it does own come from `security-operations.md`:
 *
 * - Section 3: the listener binds exactly one loopback literal through
 *   `bindLoopbackServer`, which attempts the bind once and never retries on a
 *   wider interface. An unspecified address is refused, not normalized.
 * - Section 4.1: every route except the constant liveness result and the
 *   bootstrap pairing exchange requires an authenticated session.
 * - Section 4.2: `NetworkExposurePolicy` enforces the exact loopback `Host`,
 *   the exact same-origin allowlist, a loopback peer, and the refusal of every
 *   forwarding header; state-changing requests additionally require the CSRF
 *   token.
 * - Section 4.3: a restrictive Content Security Policy and the sniffing,
 *   framing, and referrer headers are set on every response, including errors.
 * - Section 4.4: each route carries a finite body limit that is enforced
 *   before any parsing or buffering, plus header and request timeouts and rate
 *   limits for authentication, configuration mutation, and module control.
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { deepFreeze, type JsonValue } from "../../core/canonical-json.js";
import { NetworkExposureError, NetworkExposurePolicy } from "../../core/network-exposure.js";
import { assertDaemonListenHost, type DaemonListenHost } from "../daemon-config.js";
import { bindLoopbackServer, type BoundLoopbackAddress } from "../loopback-listener.js";
import {
  ADMIN_SESSION_COOKIE,
  AdminSessionError,
  AdminSessionStore,
  type AdminPairingHandle,
  type AdminSession,
} from "./admin-sessions.js";
import type { ConsoleActor } from "./console-audit.js";
import type { ConsoleOperations } from "./console-operations.js";
import {
  CONSOLE_OPERATION_CATALOG,
  CONSOLE_OPERATION_CATALOG_VERSION,
  ConsoleOperationError,
  consoleErrorStatus,
  describeExposure,
  type ConsoleOperationDeclaration,
} from "./operation-catalog.js";
import {
  parseDispositions,
  parseModulePrivateStorage,
  parseStartPositions,
  parseTopologyProposal,
} from "./topology-revision.js";

const INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** The Section 4.4 baseline. Operators may tune finite values, never remove them. */
export interface AdminHttpLimits {
  readonly maxJsonBytes: number;
  readonly maxSmallJsonBytes: number;
  readonly headerTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly maxHeadersCount: number;
  readonly authenticationRequestsPerMinute: number;
  readonly configurationMutationsPerMinute: number;
  readonly moduleControlRequestsPerMinute: number;
  readonly readRequestsPerMinute: number;
}

export const DEFAULT_ADMIN_HTTP_LIMITS: AdminHttpLimits = deepFreeze({
  maxJsonBytes: 1024 * 1024,
  maxSmallJsonBytes: 8 * 1024,
  headerTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  maxHeadersCount: 64,
  authenticationRequestsPerMinute: 10,
  configurationMutationsPerMinute: 30,
  moduleControlRequestsPerMinute: 30,
  readRequestsPerMinute: 120,
}) as AdminHttpLimits;

type RateLimitCategory =
  | "authentication"
  | "configuration-mutation"
  | "module-control"
  | "read";

interface RouteContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly params: Readonly<Record<string, string>>;
  readonly session: AdminSession | null;
  readonly actor: ConsoleActor;
  readJson(): Promise<unknown>;
}

interface AdminRoute {
  readonly method: "GET" | "POST" | "DELETE";
  readonly segments: readonly string[];
  /** The catalog operation this route exposes, or `null` for surface routes. */
  readonly operation: string | null;
  readonly authenticated: boolean;
  readonly csrf: boolean;
  readonly requireOrigin: boolean;
  readonly maxBodyBytes: number;
  readonly rateLimit: RateLimitCategory | null;
  readonly successStatus: number;
  handle(context: RouteContext): Promise<JsonValue>;
}

class AdminHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AdminHttpError";
  }
}

export interface AdminHttpServerOptions {
  readonly operations: ConsoleOperations;
  readonly sessions?: AdminSessionStore;
  readonly host?: DaemonListenHost;
  readonly port?: number;
  readonly limits?: Partial<AdminHttpLimits>;
  readonly now?: () => string;
  readonly nextId?: (kind: "session") => string;
  readonly nextSecret?: (kind: "pairing" | "session" | "csrf") => string;
}

function socketReject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export class AdminHttpServer {
  readonly #operations: ConsoleOperations;
  readonly #sessions: AdminSessionStore;
  readonly #host: DaemonListenHost;
  readonly #port: number;
  readonly #limits: AdminHttpLimits;
  readonly #now: () => string;
  readonly #routes: readonly AdminRoute[];
  readonly #rateBuckets = new Map<string, { windowStartedAt: number; count: number }>();
  #server: Server | null = null;
  #address: BoundLoopbackAddress | null = null;
  #policy: NetworkExposurePolicy | null = null;
  #origin: string | null = null;

  constructor(options: AdminHttpServerOptions) {
    const host = options.host ?? "127.0.0.1";
    // An unspecified address never reaches the network stack: it is refused
    // here, before a listener exists to widen.
    assertDaemonListenHost(host);
    this.#host = host;
    this.#port = options.port ?? 0;
    this.#operations = options.operations;
    this.#now = options.now ?? (() => new Date().toISOString());
    const limits = { ...DEFAULT_ADMIN_HTTP_LIMITS, ...(options.limits ?? {}) };
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`Admin HTTP limit ${name} must be a positive safe integer`);
      }
    }
    if (limits.maxJsonBytes > DEFAULT_ADMIN_HTTP_LIMITS.maxJsonBytes) {
      throw new TypeError(
        "maxJsonBytes must not exceed the 1 MiB administrative JSON baseline",
      );
    }
    this.#limits = deepFreeze(limits);
    this.#sessions =
      options.sessions ??
      new AdminSessionStore({
        now: this.#now,
        nextId: options.nextId ?? (() => `session-${randomUUID()}`),
        nextSecret: options.nextSecret ?? (() => randomBytes(32).toString("base64url")),
      });
    this.#routes = this.#buildRoutes();
  }

  get address(): BoundLoopbackAddress | null {
    return this.#address;
  }

  get origin(): string | null {
    return this.#origin;
  }

  get sessions(): AdminSessionStore {
    return this.#sessions;
  }

  /** The operations this exposure actually routes, for the parity comparison. */
  exposedOperations(): readonly ConsoleOperationDeclaration[] {
    return describeExposure(
      this.#routes
        .map((route) => route.operation)
        .filter((operation): operation is string => operation !== null),
    );
  }

  /**
   * Routes that carry no catalog operation and are therefore exempt from the
   * command-line parity comparison.
   *
   * The exemption criterion is narrow: a surface route may only report liveness,
   * carry the browser's own session lifecycle, or return a static listing of
   * operations that are each independently reachable. Anything an operator can
   * *do* belongs in the catalog and needs a command-line equivalent, because a
   * headless server has no other way to reach it. A conformance test pins this
   * set so a route that does real work cannot join it silently.
   */
  surfaceRoutes(): readonly string[] {
    return Object.freeze(
      this.#routes
        .filter((route) => route.operation === null)
        .map((route) => `${route.method} /${route.segments.join("/")}`)
        .sort(),
    );
  }

  issuePairingCode(principalId: string): AdminPairingHandle {
    return this.#sessions.issuePairingCode(principalId);
  }

  async start(): Promise<BoundLoopbackAddress> {
    if (this.#server) throw new Error("The admin HTTP server is already started");
    const server = createServer(
      {
        // Node evaluates `headersTimeout` and `requestTimeout` only when this
        // sweep runs, and its 30-second default would make a 10-second header
        // timeout arrive up to 30 seconds late. Half the shorter limit keeps
        // the configured bound meaningful without a busy sweep.
        connectionsCheckingInterval: Math.max(
          250,
          Math.floor(
            Math.min(this.#limits.headerTimeoutMs, this.#limits.requestTimeoutMs) / 2,
          ),
        ),
      },
      (request, response) => {
        void this.#dispatch(request, response).catch((error) => {
          this.#writeError(response, error);
        });
      },
    );
    server.headersTimeout = this.#limits.headerTimeoutMs;
    server.requestTimeout = this.#limits.requestTimeoutMs;
    server.maxHeadersCount = this.#limits.maxHeadersCount;
    // The console has no WebSocket surface, so every upgrade is refused rather
    // than left to a default handler.
    server.on("upgrade", (_request, socket) => socketReject(socket, 404, "Not Found"));
    server.on("clientError", (error: NodeJS.ErrnoException, socket) => {
      // A malformed or timed-out client is answered with a stable status and
      // closed. No stack trace and no host path reach the socket.
      const timedOut = error.code === "ERR_HTTP_REQUEST_TIMEOUT";
      socketReject(socket, timedOut ? 408 : 400, timedOut ? "Request Timeout" : "Bad Request");
    });

    let address: BoundLoopbackAddress;
    try {
      address = await bindLoopbackServer(server, { host: this.#host, port: this.#port });
    } catch (error) {
      // The listener never opened, so there is nothing to close cleanly and,
      // more importantly, no second address to try.
      server.close(() => undefined);
      this.#server = null;
      throw error;
    }
    this.#server = server;
    this.#address = address;
    this.#policy = new NetworkExposurePolicy({
      mode: "local",
      listenHost: address.host,
      listenPort: address.port,
    });
    const authority = address.host.includes(":") ? `[${address.host}]` : address.host;
    this.#origin = `http://${authority}:${address.port}`;
    return address;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = null;
    this.#address = null;
    this.#policy = null;
    this.#origin = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections?.();
    });
  }

  async #dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    response.setHeader("X-Dolly-Request-Id", requestId);
    this.#securityHeaders(response);

    const policy = this.#policy;
    if (!policy) throw new AdminHttpError(503, "NOT_LISTENING", "The console is not listening");

    const url = new URL(request.url ?? "/", this.#origin ?? "http://127.0.0.1");
    if (url.search !== "") {
      // Section 4.1 keeps credentials out of query strings; the surface accepts
      // no query parameters at all so none can be logged.
      throw new AdminHttpError(400, "QUERY_DENIED", "Query parameters are not accepted");
    }
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
    const route = this.#matchRoute(request.method ?? "GET", segments);
    if (!route) throw new AdminHttpError(404, "NOT_FOUND", "The route does not exist");

    try {
      policy.validateRequest(
        {
          peerAddress: request.socket.remoteAddress ?? "",
          encrypted: false,
          host: request.headers.host,
          origin: request.headers.origin,
          forwarded: request.headers.forwarded,
          xForwardedProto: request.headers["x-forwarded-proto"],
          xForwardedHost: request.headers["x-forwarded-host"],
          xForwardedFor: request.headers["x-forwarded-for"],
        },
        { requireOrigin: route.requireOrigin },
      );
    } catch (error) {
      if (error instanceof NetworkExposureError) {
        throw new AdminHttpError(403, error.code, "The request was refused by the exposure policy");
      }
      throw error;
    }

    const params = this.#extractParams(route, segments);
    let session: AdminSession | null = null;
    if (route.authenticated) {
      session = this.#sessions.authenticate(request.headers.cookie);
      if (route.csrf) this.#sessions.requireCsrf(request.headers["x-dolly-csrf"], session);
    }
    if (route.rateLimit) {
      this.#consumeRateLimit(
        route.rateLimit,
        session?.sessionId ?? request.socket.remoteAddress ?? "unknown",
      );
    }

    const actor: ConsoleActor = session
      ? { principalId: session.principalId, sessionId: session.sessionId, interface: "graphical" }
      : { principalId: "unauthenticated", interface: "graphical" };

    const body = await route.handle({
      request,
      response,
      params,
      session,
      actor,
      readJson: () => this.#readJson(request, route.maxBodyBytes),
    });
    this.#writeJson(response, route.successStatus, body);
  }

  #matchRoute(method: string, segments: readonly string[]): AdminRoute | undefined {
    return this.#routes.find((route) => {
      if (route.method !== method) return false;
      if (route.segments.length !== segments.length) return false;
      return route.segments.every(
        (segment, index) => segment.startsWith(":") || segment === segments[index],
      );
    });
  }

  #extractParams(route: AdminRoute, segments: readonly string[]): Record<string, string> {
    const params: Record<string, string> = {};
    route.segments.forEach((segment, index) => {
      if (!segment.startsWith(":")) return;
      const name = segment.slice(1);
      const value = segments[index] ?? "";
      if (name === "instanceId" && !INSTANCE_ID_PATTERN.test(value)) {
        throw new AdminHttpError(400, "ADMIN_REQUEST_INVALID", "instanceId is not a UUIDv4");
      }
      params[name] = value;
    });
    return params;
  }

  #buildRoutes(): readonly AdminRoute[] {
    const small = this.#limitsForSmallBody();
    const routes: AdminRoute[] = [
      {
        method: "GET",
        segments: ["v1", "admin", "health"],
        operation: null,
        authenticated: false,
        csrf: false,
        requireOrigin: false,
        maxBodyBytes: 0,
        rateLimit: null,
        successStatus: 200,
        // Section 4.1: an unauthenticated health endpoint reveals no
        // configuration and returns a constant liveness result.
        handle: async () => ({ status: "ok" }),
      },
      {
        method: "POST",
        segments: ["v1", "admin", "session"],
        operation: null,
        authenticated: false,
        csrf: false,
        requireOrigin: true,
        maxBodyBytes: small,
        rateLimit: "authentication",
        successStatus: 201,
        handle: async (context) => {
          const body = assertObject(await context.readJson(), ["code"]);
          const grant = this.#sessions.redeem({
            code: body.code,
            remoteAddress: context.request.socket.remoteAddress ?? "unknown",
          });
          const maxAge = Math.floor(this.#sessions.limits.sessionIdleMs / 1000);
          context.response.setHeader(
            "Set-Cookie",
            `${ADMIN_SESSION_COOKIE}=${grant.sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`,
          );
          return {
            version: "1",
            sessionId: grant.session.sessionId,
            csrfToken: grant.csrfToken,
            expiresAfterIdleMs: this.#sessions.limits.sessionIdleMs,
          };
        },
      },
      {
        method: "DELETE",
        segments: ["v1", "admin", "session"],
        operation: null,
        authenticated: true,
        csrf: true,
        requireOrigin: true,
        maxBodyBytes: 0,
        rateLimit: "authentication",
        successStatus: 200,
        handle: async (context) => ({
          revoked: this.#sessions.revoke(context.session!.sessionId),
        }),
      },
      {
        method: "GET",
        segments: ["v1", "admin", "operations"],
        operation: null,
        authenticated: true,
        csrf: false,
        requireOrigin: false,
        maxBodyBytes: 0,
        rateLimit: "read",
        successStatus: 200,
        handle: async () => ({
          catalogVersion: CONSOLE_OPERATION_CATALOG_VERSION,
          operations: CONSOLE_OPERATION_CATALOG as unknown as JsonValue,
        }),
      },
      {
        method: "GET",
        segments: ["v1", "admin", "instances"],
        operation: "instance.list",
        authenticated: true,
        csrf: false,
        requireOrigin: false,
        maxBodyBytes: 0,
        rateLimit: "read",
        successStatus: 200,
        handle: async () => ({
          instances: (await this.#operations.listInstances()) as unknown as JsonValue,
        }),
      },
      {
        method: "GET",
        segments: ["v1", "admin", "instances", ":instanceId"],
        operation: "instance.describe",
        authenticated: true,
        csrf: false,
        requireOrigin: false,
        maxBodyBytes: 0,
        rateLimit: "read",
        successStatus: 200,
        handle: async (context) =>
          (await this.#operations.describeInstance(
            context.params.instanceId!,
          )) as unknown as JsonValue,
      },
      {
        method: "GET",
        segments: ["v1", "admin", "instances", ":instanceId", "config"],
        operation: "config.read",
        authenticated: true,
        csrf: false,
        requireOrigin: false,
        maxBodyBytes: 0,
        rateLimit: "read",
        successStatus: 200,
        handle: async (context) =>
          (await this.#operations.readConfiguration(
            context.params.instanceId!,
          )) as unknown as JsonValue,
      },
      {
        method: "POST",
        segments: ["v1", "admin", "instances", ":instanceId", "start"],
        operation: "instance.start",
        authenticated: true,
        csrf: true,
        requireOrigin: true,
        maxBodyBytes: small,
        rateLimit: "module-control",
        successStatus: 200,
        handle: async (context) => {
          const body = assertObject(await context.readJson(), ["operationId"]);
          return (await this.#operations.startInstance({
            instanceId: context.params.instanceId!,
            operationId: requireString(body.operationId, "operationId"),
            actor: context.actor,
          })) as unknown as JsonValue;
        },
      },
      {
        method: "POST",
        segments: ["v1", "admin", "instances", ":instanceId", "stop"],
        operation: "instance.stop",
        authenticated: true,
        csrf: true,
        requireOrigin: true,
        maxBodyBytes: small,
        rateLimit: "module-control",
        successStatus: 200,
        handle: async (context) => {
          const body = assertObject(await context.readJson(), ["operationId"]);
          return (await this.#operations.stopInstance({
            instanceId: context.params.instanceId!,
            operationId: requireString(body.operationId, "operationId"),
            actor: context.actor,
          })) as unknown as JsonValue;
        },
      },
      {
        method: "POST",
        segments: ["v1", "admin", "instances", ":instanceId", "topology", "plan"],
        operation: "topology.plan",
        authenticated: true,
        csrf: true,
        requireOrigin: true,
        maxBodyBytes: this.#limits.maxJsonBytes,
        rateLimit: "configuration-mutation",
        successStatus: 200,
        handle: async (context) => {
          const body = assertObject(await context.readJson(), [
            "expectedRevision",
            "proposal",
            "startPositions",
            "dispositions",
            "modulePrivateStorage",
          ]);
          return (await this.#operations.planTopologyRevision({
            instanceId: context.params.instanceId!,
            expectedRevision: requireString(body.expectedRevision, "expectedRevision"),
            proposal: parseTopologyProposal(body.proposal),
            startPositions: parseStartPositions(body.startPositions),
            dispositions: parseDispositions(body.dispositions),
            modulePrivateStorage: parseModulePrivateStorage(body.modulePrivateStorage),
          })) as unknown as JsonValue;
        },
      },
      {
        method: "POST",
        segments: ["v1", "admin", "instances", ":instanceId", "topology", "commit"],
        operation: "topology.commit",
        authenticated: true,
        csrf: true,
        requireOrigin: true,
        maxBodyBytes: this.#limits.maxJsonBytes,
        rateLimit: "configuration-mutation",
        successStatus: 200,
        handle: async (context) => {
          const body = assertObject(await context.readJson(), [
            "expectedRevision",
            "proposal",
            "startPositions",
            "dispositions",
            "modulePrivateStorage",
            "confirmedPlanDigest",
            "operationId",
          ]);
          return (await this.#operations.commitTopologyRevision({
            instanceId: context.params.instanceId!,
            expectedRevision: requireString(body.expectedRevision, "expectedRevision"),
            proposal: parseTopologyProposal(body.proposal),
            startPositions: parseStartPositions(body.startPositions),
            dispositions: parseDispositions(body.dispositions),
            modulePrivateStorage: parseModulePrivateStorage(body.modulePrivateStorage),
            operationId: requireString(body.operationId, "operationId"),
            actor: context.actor,
            ...(body.confirmedPlanDigest === undefined
              ? {}
              : {
                  confirmedPlanDigest: requireString(
                    body.confirmedPlanDigest,
                    "confirmedPlanDigest",
                  ),
                }),
          })) as unknown as JsonValue;
        },
      },
      {
        method: "GET",
        segments: ["v1", "admin", "instances", ":instanceId", "claims", "unknown-outcome"],
        operation: "claim.listUnknownOutcomes",
        authenticated: true,
        csrf: false,
        requireOrigin: false,
        maxBodyBytes: 0,
        rateLimit: "read",
        successStatus: 200,
        handle: async (context) => ({
          claims: (await this.#operations.listUnknownOutcomeClaims(
            context.params.instanceId!,
          )) as unknown as JsonValue,
        }),
      },
      {
        method: "POST",
        segments: [
          "v1",
          "admin",
          "instances",
          ":instanceId",
          "claims",
          "unknown-outcome",
          "disposition",
        ],
        operation: "claim.disposeUnknownOutcome",
        authenticated: true,
        csrf: true,
        requireOrigin: true,
        maxBodyBytes: small,
        rateLimit: "configuration-mutation",
        successStatus: 200,
        handle: async (context) => {
          const body = assertObject(await context.readJson(), [
            "claimToken",
            "disposition",
            "operationId",
            "acknowledgedWarningDigest",
          ]);
          return (await this.#operations.disposeUnknownOutcomeClaim({
            instanceId: context.params.instanceId!,
            claimToken: requireString(body.claimToken, "claimToken"),
            disposition: body.disposition,
            operationId: requireString(body.operationId, "operationId"),
            actor: context.actor,
            ...(body.acknowledgedWarningDigest === undefined
              ? {}
              : {
                  acknowledgedWarningDigest: requireString(
                    body.acknowledgedWarningDigest,
                    "acknowledgedWarningDigest",
                  ),
                }),
          })) as unknown as JsonValue;
        },
      },
    ];
    return deepFreeze(routes) as readonly AdminRoute[];
  }

  #limitsForSmallBody(): number {
    return Math.min(this.#limits.maxSmallJsonBytes, this.#limits.maxJsonBytes);
  }

  /**
   * Reads one JSON body under a finite limit. The declared `Content-Length` is
   * checked before a single byte is read, and a chunked body is abandoned the
   * moment it crosses the limit, so nothing oversized is ever buffered or
   * handed to the parser.
   */
  async #readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
    if (maxBytes <= 0) {
      throw new AdminHttpError(400, "BODY_NOT_ACCEPTED", "This route accepts no request body");
    }
    const contentType = request.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      throw new AdminHttpError(
        415,
        "CONTENT_TYPE_REQUIRED",
        "Content-Type must be application/json",
      );
    }
    const declared = request.headers["content-length"];
    if (declared !== undefined) {
      if (Array.isArray(declared) || !/^(0|[1-9][0-9]*)$/u.test(declared)) {
        throw new AdminHttpError(400, "ADMIN_REQUEST_INVALID", "Content-Length is invalid");
      }
      if (Number(declared) > maxBytes) {
        throw new AdminHttpError(413, "BODY_LIMIT", "The JSON request body is too large");
      }
    }
    const chunks: Buffer[] = [];
    let byteLength = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk, "utf8")
          : Buffer.from(chunk as Uint8Array);
      byteLength += bytes.byteLength;
      if (byteLength > maxBytes) {
        throw new AdminHttpError(413, "BODY_LIMIT", "The JSON request body is too large");
      }
      chunks.push(bytes);
    }
    try {
      return JSON.parse(Buffer.concat(chunks, byteLength).toString("utf8"));
    } catch {
      throw new AdminHttpError(400, "INVALID_JSON", "The JSON request body is invalid");
    }
  }

  #consumeRateLimit(category: RateLimitCategory, subject: string): void {
    const ceiling = {
      authentication: this.#limits.authenticationRequestsPerMinute,
      "configuration-mutation": this.#limits.configurationMutationsPerMinute,
      "module-control": this.#limits.moduleControlRequestsPerMinute,
      read: this.#limits.readRequestsPerMinute,
    }[category];
    const key = `${category}:${subject}`;
    const now = Date.parse(this.#now());
    const existing = this.#rateBuckets.get(key);
    const bucket =
      !existing || now - existing.windowStartedAt >= 60_000
        ? { windowStartedAt: now, count: 0 }
        : existing;
    bucket.count += 1;
    this.#rateBuckets.set(key, bucket);
    if (bucket.count > ceiling) {
      throw new AdminHttpError(429, "RATE_LIMITED", `Too many ${category} requests`);
    }
  }

  #securityHeaders(response: ServerResponse): void {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
  }

  #writeJson(response: ServerResponse, status: number, body: JsonValue): void {
    if (response.headersSent || response.destroyed) return;
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
  }

  #writeError(response: ServerResponse, error: unknown): void {
    if (response.headersSent || response.destroyed) return;
    this.#securityHeaders(response);
    // A body-limit rejection never read the request, so the connection is
    // closed rather than reused for a half-consumed stream.
    response.setHeader("Connection", "close");
    const { status, code, message, details } = describeError(error);
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({
        error: {
          code,
          message,
          ...(details === undefined ? {} : { details }),
        },
      }),
    );
  }
}

function describeError(error: unknown): {
  status: number;
  code: string;
  message: string;
  details?: JsonValue;
} {
  if (error instanceof AdminHttpError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof AdminSessionError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof ConsoleOperationError) {
    let details: JsonValue | undefined;
    try {
      details = JSON.parse(JSON.stringify(error.details)) as JsonValue;
    } catch {
      details = undefined;
    }
    return {
      status: consoleErrorStatus(error.code),
      code: error.code,
      message: error.message,
      ...(details === undefined ? {} : { details }),
    };
  }
  // Section 11: a public error response carries a stable code, never a stack
  // trace or a host path.
  return { status: 500, code: "INTERNAL_ERROR", message: "The request failed" };
}

function assertObject(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AdminHttpError(400, "ADMIN_REQUEST_INVALID", "The JSON body must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AdminHttpError(400, "ADMIN_REQUEST_INVALID", "The JSON body must be a plain object");
  }
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new AdminHttpError(
      400,
      "ADMIN_REQUEST_INVALID",
      `The JSON body contains unknown fields: ${unexpected.sort().join(", ")}`,
    );
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AdminHttpError(400, "ADMIN_REQUEST_INVALID", `${label} must be a non-empty string`);
  }
  return value;
}
