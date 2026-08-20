import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  assertJsonValue,
  canonicalJsonDigest,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43,512}$/;
const COOKIE_NAME = "dolly_console_session";
const WS_PROTOCOL = "dolly.console.v1";

export interface ConsoleGatewayLimits {
  readonly maxJsonBytes: number;
  readonly maxTextBytes: number;
  readonly maxQueuedMessagesPerSession: number;
  readonly maxWebSocketMessageBytes: number;
  readonly maxWebSocketsPerSession: number;
  readonly maxWebSocketBufferedBytes: number;
  readonly maxPairingAttemptsPerWindow: number;
  readonly pairingAttemptWindowMs: number;
  readonly pairingCodeLifetimeMs: number;
  readonly sessionIdleMs: number;
  readonly headerTimeoutMs: number;
  readonly requestTimeoutMs: number;
}

const DEFAULT_LIMITS: ConsoleGatewayLimits = {
  maxJsonBytes: 1024 * 1024,
  maxTextBytes: 64 * 1024,
  maxQueuedMessagesPerSession: 1000,
  maxWebSocketMessageBytes: 256 * 1024,
  maxWebSocketsPerSession: 4,
  maxWebSocketBufferedBytes: 512 * 1024,
  maxPairingAttemptsPerWindow: 5,
  pairingAttemptWindowMs: 60_000,
  pairingCodeLifetimeMs: 120_000,
  sessionIdleMs: 30 * 60_000,
  headerTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
};

export interface ConsoleGatewayOptions {
  readonly host?: "127.0.0.1" | "::1";
  readonly port?: number;
  readonly now: () => string;
  readonly nextId: (kind: "session" | "message" | "event") => string;
  readonly nextSecret: (kind: "pairing" | "session" | "csrf") => string;
  readonly limits?: Partial<ConsoleGatewayLimits>;
  /**
   * Static client application (HTML, script, styles) served on the same
   * trusted origin. The shell is inert: it carries no session data, and all
   * data paths remain authenticated. Scripts execute only from this origin.
   */
  readonly clientApplication?: ConsoleClientApplication;
  /**
   * Host notification of authenticated session lifecycle transitions. Fired
   * after a session is created by pairing and after it becomes permanently
   * closed (logout, idle expiry, revoke, or gateway stop).
   */
  readonly onSessionChange?: (event: ConsoleSessionChangeEvent) => void;
  /**
   * Host-owned bounded replay source. Called only for an already
   * authenticated session; the gateway never exposes cross-session display
   * state because the callback receives the authenticated session identity.
   */
  readonly resolveDisplayResume?: (
    input: ConsoleDisplayResumeRequest,
  ) => ConsoleDisplayResumeResult;
}

export interface ConsoleGatewayAddress {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
}

export interface ConsoleClientApplication {
  readonly html: string;
  readonly script: string;
  readonly styles: string;
}

export interface ConsoleSessionChangeEvent {
  readonly type: "opened" | "closed";
  readonly sessionId: string;
  readonly principalId: string;
  readonly routeAliases: readonly string[];
}

export interface ConsoleDisplayResumeRequest {
  readonly sessionId: string;
  readonly principalId: string;
  readonly afterSequence: string;
}

export type ConsoleDisplayResumeResult =
  | {
      readonly kind: "resume";
      readonly items: readonly JsonValue[];
      readonly truncated: boolean;
    }
  | { readonly kind: "cursor-invalid" }
  | { readonly kind: "unavailable" };

export interface PairingCodeRequest {
  readonly principalId: string;
  readonly routeAliases: readonly string[];
}

export interface PairingCodeHandle {
  readonly code: string;
  readonly expiresAt: string;
}

export interface ConsoleQueuedMessage {
  readonly schemaVersion: "dolly.console-queued-message/1";
  readonly externalMessageId: string;
  readonly sessionId: string;
  readonly routeAlias: string;
  readonly operationId: string;
  readonly clientMessageId: string;
  readonly sequence: string;
  readonly text: string;
  readonly acceptedAt: string;
}

interface PairingRecord {
  readonly codeDigest: string;
  readonly principalId: string;
  readonly routeAliases: readonly string[];
  readonly expiresAt: string;
}

interface SessionState {
  readonly sessionId: string;
  readonly principalId: string;
  readonly tokenDigest: string;
  readonly csrfToken: string;
  readonly csrfDigest: string;
  readonly routeAliases: ReadonlySet<string>;
  readonly queue: ConsoleQueuedMessage[];
  readonly operations: Map<string, { digest: string; message: ConsoleQueuedMessage }>;
  readonly clientMessages: Map<string, { digest: string; message: ConsoleQueuedMessage }>;
  readonly sockets: Set<WebSocket>;
  nextMessageSequence: bigint;
  nextEventSequence: bigint;
  lastSeenAt: string;
  closed: boolean;
}

interface PairingAttemptBucket {
  windowStartedAt: number;
  attempts: number;
}

class ConsoleHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConsoleHttpError";
  }
}

function canonicalTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError("Runtime clock returned an invalid time");
  return new Date(timestamp).toISOString();
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new ConsoleHttpError(400, "INVALID_REQUEST", `${label} is invalid`);
  }
}

function assertSecret(value: string, label: string): void {
  if (!SECRET_PATTERN.test(value)) {
    throw new TypeError(`${label} must be 43-512 base64url characters`);
  }
}

function digestSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function secretMatches(value: string, digest: string): boolean {
  const actual = Buffer.from(digestSecret(value), "hex");
  const expected = Buffer.from(digest, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function assertClosedObject(
  value: unknown,
  allowedKeys: readonly string[],
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConsoleHttpError(400, "INVALID_REQUEST", "JSON body must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ConsoleHttpError(400, "INVALID_REQUEST", "JSON body must be a plain object");
  }
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ConsoleHttpError(400, "INVALID_REQUEST", "JSON body has unknown fields");
  }
}

function normalizedLimits(input: Partial<ConsoleGatewayLimits>): ConsoleGatewayLimits {
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Console limit ${name} must be a positive safe integer`);
    }
  }
  return deepFreeze(limits);
}
function validateClientApplication(
  application: ConsoleClientApplication | undefined,
): ConsoleClientApplication | null {
  if (application === undefined) return null;
  for (const name of ["html", "script", "styles"] as const) {
    if (
      typeof application[name] !== "string" ||
      application[name].length === 0 ||
      application[name].length > 512 * 1024
    ) {
      throw new TypeError(
        `Console client application ${name} must be a non-empty string up to 512 KiB`,
      );
    }
  }
  return {
    html: application.html,
    script: application.script,
    styles: application.styles,
  };
}


function parseCookies(header: string | undefined): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const segment of header.split(";")) {
    const index = segment.indexOf("=");
    if (index <= 0) continue;
    const name = segment.slice(0, index).trim();
    const value = segment.slice(index + 1).trim();
    if (cookies.has(name)) return new Map();
    cookies.set(name, value);
  }
  return cookies;
}

function socketReject(socket: Duplex, status: number, reason: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

export class ConsoleGateway {
  readonly #host: "127.0.0.1" | "::1";
  readonly #port: number;
  readonly #now: () => string;
  readonly #nextId: ConsoleGatewayOptions["nextId"];
  readonly #nextSecret: ConsoleGatewayOptions["nextSecret"];
  readonly #limits: ConsoleGatewayLimits;
  readonly #pairings = new Map<string, PairingRecord>();
  readonly #sessions = new Map<string, SessionState>();
  readonly #clientApplication: ConsoleClientApplication | null;
  readonly #onSessionChange: ((event: ConsoleSessionChangeEvent) => void) | null;
  readonly #resolveDisplayResume:
    | ((input: ConsoleDisplayResumeRequest) => ConsoleDisplayResumeResult)
    | null;
  readonly #sessionByTokenDigest = new Map<string, string>();
  readonly #pairingAttempts = new Map<string, PairingAttemptBucket>();
  readonly #usedIds = new Set<string>();
  readonly #wss: WebSocketServer;
  #server: Server | null = null;
  #address: ConsoleGatewayAddress | null = null;

  constructor(options: ConsoleGatewayOptions) {
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 0;
    if (!Number.isSafeInteger(this.#port) || this.#port < 0 || this.#port > 65535) {
      throw new TypeError("Console port must be an integer between 0 and 65535");
    }
    this.#now = options.now;
    this.#nextId = options.nextId;
    this.#nextSecret = options.nextSecret;
    this.#limits = normalizedLimits(options.limits ?? {});
    this.#clientApplication = validateClientApplication(options.clientApplication);
    this.#onSessionChange = options.onSessionChange ?? null;
    this.#resolveDisplayResume = options.resolveDisplayResume ?? null;
    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.#limits.maxWebSocketMessageBytes,
      handleProtocols: (protocols) =>
        protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false,
    });
  }

  get address(): ConsoleGatewayAddress | null {
    return this.#address;
  }

  async start(): Promise<ConsoleGatewayAddress> {
    if (this.#server) throw new Error("Console gateway is already started");
    const server = createServer((request, response) => {
      void this.#handleRequest(request, response).catch((error) => {
        this.#writeError(response, error);
      });
    });
    server.headersTimeout = this.#limits.headerTimeoutMs;
    server.requestTimeout = this.#limits.requestTimeoutMs;
    server.maxHeadersCount = 64;
    server.on("upgrade", (request, socket, head) => {
      this.#handleUpgrade(request, socket, head);
    });
    server.on("clientError", (_error, socket) => {
      socketReject(socket, 400, "Bad Request");
    });
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        this.#server = null;
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.#port, this.#host);
    });
    const bound = server.address();
    if (!bound || typeof bound === "string") {
      await this.stop();
      throw new Error("Console gateway did not bind a TCP address");
    }
    const hostForUrl = bound.family === "IPv6" ? `[${bound.address}]` : bound.address;
    this.#address = deepFreeze({
      host: bound.address,
      port: bound.port,
      origin: `http://${hostForUrl}:${bound.port}`,
    });
    return this.#address;
  }

  issuePairingCode(request: PairingCodeRequest): PairingCodeHandle {
    assertId(request.principalId, "principalId");
    if (
      request.routeAliases.length === 0 ||
      new Set(request.routeAliases).size !== request.routeAliases.length
    ) {
      throw new TypeError("Pairing route aliases must be non-empty and unique");
    }
    for (const route of request.routeAliases) assertId(route, "routeAlias");
    const code = this.#nextSecret("pairing");
    assertSecret(code, "Pairing code");
    const codeDigest = digestSecret(code);
    if (this.#pairings.has(codeDigest)) throw new Error("Pairing code generator returned a duplicate");
    const now = Date.parse(canonicalTime(this.#now()));
    const expiresAt = new Date(now + this.#limits.pairingCodeLifetimeMs).toISOString();
    this.#pairings.set(
      codeDigest,
      deepFreeze({
        codeDigest,
        principalId: request.principalId,
        routeAliases: [...request.routeAliases],
        expiresAt,
      }),
    );
    return deepFreeze({ code, expiresAt });
  }

  listQueuedMessages(sessionId: string): readonly ConsoleQueuedMessage[] {
    assertId(sessionId, "sessionId");
    const session = this.#sessions.get(sessionId);
    return session ? [...session.queue] : [];
  }

  publishToSession(sessionId: string, payload: JsonValue): string {
    assertId(sessionId, "sessionId");
    assertJsonValue(payload);
    const session = this.#sessions.get(sessionId);
    if (!session || session.closed || this.#isExpired(session)) {
      throw new Error(`Console session ${sessionId} is unavailable`);
    }
    const eventId = this.#allocateId("event");
    const event = {
      version: "1",
      type: "display.event",
      eventId,
      sequence: session.nextEventSequence.toString(10),
      payload,
    };
    session.nextEventSequence += 1n;
    const serialized = JSON.stringify(event);
    for (const socket of session.sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (socket.bufferedAmount + Buffer.byteLength(serialized, "utf8") > this.#limits.maxWebSocketBufferedBytes) {
        socket.close(1013, "backpressure");
        continue;
      }
      socket.send(serialized);
    }
    return eventId;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = null;
    for (const session of this.#sessions.values()) {
      if (session.closed) continue;
      session.closed = true;
      for (const socket of session.sockets) socket.terminate();
      session.sockets.clear();
      this.#notifyClosed(session);
    }
    await new Promise<void>((resolve, reject) => {
      this.#wss.close(() => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    });
    this.#address = null;
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.#securityHeaders(response);
    const address = this.#requireAddress();
    if (request.headers.host !== new URL(address.origin).host) {
      throw new ConsoleHttpError(400, "HOST_DENIED", "Host header is not authorized");
    }
    const url = new URL(request.url ?? "/", address.origin);
    if (url.search !== "") {
      throw new ConsoleHttpError(400, "QUERY_DENIED", "Query parameters are not accepted");
    }

    if (request.method === "GET" && url.pathname === "/v1/health") {
      this.#writeJson(response, 200, { status: "ok" });
      return;
    }

    // The inert client shell is public; every data route below remains
    // authenticated. Assets are host-provided static strings, and the HTML
    // policy permits only same-origin script/style loads plus same-origin
    // fetch and WebSocket connections (console-extension.md section 13).
    if (this.#clientApplication && request.method === "GET") {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        this.#writeApplicationAsset(
          response,
          this.#clientApplication.html,
          "text/html; charset=utf-8",
        );
        return;
      }
      if (url.pathname === "/app.js") {
        this.#writeApplicationAsset(
          response,
          this.#clientApplication.script,
          "text/javascript; charset=utf-8",
        );
        return;
      }
      if (url.pathname === "/styles.css") {
        this.#writeApplicationAsset(
          response,
          this.#clientApplication.styles,
          "text/css; charset=utf-8",
        );
        return;
      }
    }
    // A path naming no route is closed before authentication, so the gateway
    // never reveals whether a session exists by status code (404 vs 401).
    // Only data routes under /v1/ reach the auth boundary below.
    if (!url.pathname.startsWith("/v1/")) {
      throw new ConsoleHttpError(404, "NOT_FOUND", "Route does not exist");
    }
    if (request.method === "POST" && url.pathname === "/v1/session/pair") {
      this.#requireOrigin(request);
      const body = await this.#readJson(request);
      assertClosedObject(body, ["code"]);
      if (typeof body.code !== "string") {
        throw new ConsoleHttpError(400, "INVALID_REQUEST", "Pairing code is required");
      }
      const result = this.#pair(request, body.code);
      response.setHeader(
        "Set-Cookie",
        `${COOKIE_NAME}=${result.sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.#limits.sessionIdleMs / 1000)}`,
      );
      this.#writeJson(response, 201, {
        version: "1",
        principalId: result.session.principalId,
        sessionId: result.session.sessionId,
        csrfToken: result.csrfToken,
        routeAliases: [...result.session.routeAliases],
        expiresAfterIdleMs: this.#limits.sessionIdleMs,
      });
      return;
    }

    const session = this.#authenticate(request);
    if (request.method === "GET" && url.pathname === "/v1/session") {
      this.#writeJson(response, 200, {
        version: "1",
        sessionId: session.sessionId,
        principalId: session.principalId,
        routeAliases: [...session.routeAliases],
        csrfToken: session.csrfToken,
        limits: {
          maxTextBytes: this.#limits.maxTextBytes,
          maxQueuedMessagesPerSession: this.#limits.maxQueuedMessagesPerSession,
          sessionIdleMs: this.#limits.sessionIdleMs,
        },
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/messages") {
      this.#writeJson(response, 200, {
        version: "1",
        messages: session.queue,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/messages") {
      this.#requireOrigin(request);
      this.#requireCsrf(request, session);
      const message = this.#enqueue(session, await this.#readJson(request));
      this.#writeJson(response, 202, {
        version: "1",
        disposition: "queued-volatile",
        externalMessageId: message.externalMessageId,
        sequence: message.sequence,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/session/close") {
      // Logout permanently closes the session; the structural parts
      // (consistent display state, bounded retention) are already satisfied
      // because a closed session can never be resumed (section 4.3).
      this.#requireOrigin(request);
      this.#requireCsrf(request, session);
      this.#closeSession(session);
      this.#writeJson(response, 200, { version: "1", type: "session.closed" });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/v1/display/since/")) {
      // Bounded display replay for reconnecting clients (sections 6.2 and
      // 8.1). The cursor rides in the path — never the query string — and
      // the host resolver receives only the authenticated session identity,
      // so one session can never name another session's display state.
      const resolver = this.#resolveDisplayResume;
      if (resolver === null) {
        throw new ConsoleHttpError(404, "NOT_FOUND", "Route does not exist");
      }
      const afterSequence = url.pathname.slice("/v1/display/since/".length);
      if (!/^(0|[1-9][0-9]{0,18})$/.test(afterSequence)) {
        throw new ConsoleHttpError(400, "INVALID_REQUEST", "Display cursor is invalid");
      }
      const result = resolver({
        sessionId: session.sessionId,
        principalId: session.principalId,
        afterSequence,
      });
      if (result.kind === "unavailable") {
        throw new ConsoleHttpError(404, "DISPLAY_UNAVAILABLE", "Display state does not exist");
      }
      if (result.kind === "cursor-invalid") {
        throw new ConsoleHttpError(409, "DISPLAY_CURSOR_INVALID", "Display cursor is invalid");
      }
      this.#writeJson(response, 200, {
        version: "1",
        type: "display.resume",
        afterSequence,
        truncated: result.truncated,
        items: result.items,
      });
      return;
    }
    throw new ConsoleHttpError(404, "NOT_FOUND", "Route does not exist");
  }

  #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      const address = this.#requireAddress();
      if (request.headers.host !== new URL(address.origin).host) {
        socketReject(socket, 400, "Bad Request");
        return;
      }
      const url = new URL(request.url ?? "/", address.origin);
      if (url.pathname !== "/v1/events" || url.search !== "") {
        socketReject(socket, 404, "Not Found");
        return;
      }
      if (request.headers.origin !== address.origin) {
        socketReject(socket, 403, "Forbidden");
        return;
      }
      const protocols = (request.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((entry) => entry.trim());
      if (!protocols.includes(WS_PROTOCOL)) {
        socketReject(socket, 400, "Bad Request");
        return;
      }
      const session = this.#authenticate(request);
      if (session.sockets.size >= this.#limits.maxWebSocketsPerSession) {
        socketReject(socket, 429, "Too Many Requests");
        return;
      }
      this.#wss.handleUpgrade(request, socket, head, (webSocket) => {
        session.sockets.add(webSocket);
        webSocket.on("close", () => session.sockets.delete(webSocket));
        webSocket.on("error", () => session.sockets.delete(webSocket));
        webSocket.on("message", () => {
          webSocket.close(1008, "event channel is server-to-client only");
        });
        webSocket.send(
          JSON.stringify({
            version: "1",
            type: "session.ready",
            sessionId: session.sessionId,
          }),
        );
      });
    } catch (error) {
      if (error instanceof ConsoleHttpError) {
        socketReject(socket, error.status, error.status === 401 ? "Unauthorized" : "Forbidden");
      } else {
        socketReject(socket, 500, "Internal Server Error");
      }
    }
  }

  #pair(
    request: IncomingMessage,
    code: string,
  ): { session: SessionState; sessionToken: string; csrfToken: string } {
    const remote = request.socket.remoteAddress ?? "unknown";
    this.#consumePairingAttempt(remote);
    const digest = digestSecret(code);
    const pairing = this.#pairings.get(digest);
    if (!pairing || !secretMatches(code, pairing.codeDigest)) {
      throw new ConsoleHttpError(401, "PAIRING_DENIED", "Pairing code is invalid");
    }
    if (Date.parse(pairing.expiresAt) <= Date.parse(canonicalTime(this.#now()))) {
      this.#pairings.delete(digest);
      throw new ConsoleHttpError(401, "PAIRING_EXPIRED", "Pairing code has expired");
    }
    this.#pairings.delete(digest);

    const sessionId = this.#allocateId("session");
    const sessionToken = this.#nextSecret("session");
    const csrfToken = this.#nextSecret("csrf");
    assertSecret(sessionToken, "Session token");
    assertSecret(csrfToken, "CSRF token");
    const tokenDigest = digestSecret(sessionToken);
    if (this.#sessionByTokenDigest.has(tokenDigest)) {
      throw new Error("Session token generator returned a duplicate");
    }
    const now = canonicalTime(this.#now());
    const session: SessionState = {
      sessionId,
      principalId: pairing.principalId,
      tokenDigest,
      csrfToken,
      csrfDigest: digestSecret(csrfToken),
      routeAliases: new Set(pairing.routeAliases),
      queue: [],
      operations: new Map(),
      clientMessages: new Map(),
      sockets: new Set(),
      nextMessageSequence: 1n,
      nextEventSequence: 1n,
      lastSeenAt: now,
      closed: false,
    };
    this.#sessions.set(sessionId, session);
    this.#sessionByTokenDigest.set(tokenDigest, sessionId);
    // The host binds external session state (store binding, display routes)
    // at this point. If the binding fails, the gateway session is rolled
    // back so no client credential can reference partial state.
    try {
      this.#emitSessionChange({
        type: "opened",
        sessionId,
        principalId: session.principalId,
        routeAliases: [...session.routeAliases],
      });
    } catch (error) {
      this.#closeSession(session);
      this.#sessions.delete(sessionId);
      throw error;
    }
    return { session, sessionToken, csrfToken };
  }

  #consumePairingAttempt(remote: string): void {
    const now = Date.parse(canonicalTime(this.#now()));
    const existing = this.#pairingAttempts.get(remote);
    const bucket =
      !existing || now - existing.windowStartedAt >= this.#limits.pairingAttemptWindowMs
        ? { windowStartedAt: now, attempts: 0 }
        : existing;
    bucket.attempts += 1;
    this.#pairingAttempts.set(remote, bucket);
    if (bucket.attempts > this.#limits.maxPairingAttemptsPerWindow) {
      throw new ConsoleHttpError(429, "PAIRING_RATE_LIMITED", "Pairing attempts are rate limited");
    }
  }

  #authenticate(request: IncomingMessage): SessionState {
    const token = parseCookies(request.headers.cookie).get(COOKIE_NAME);
    if (!token) throw new ConsoleHttpError(401, "AUTH_REQUIRED", "Authentication is required");
    const digest = digestSecret(token);
    const sessionId = this.#sessionByTokenDigest.get(digest);
    const session = sessionId ? this.#sessions.get(sessionId) : undefined;
    if (
      !session ||
      session.closed ||
      !secretMatches(token, session.tokenDigest) ||
      this.#isExpired(session)
    ) {
      if (session) this.#closeSession(session);
      throw new ConsoleHttpError(401, "SESSION_INVALID", "Session is invalid or expired");
    }
    session.lastSeenAt = canonicalTime(this.#now());
    return session;
  }

  #isExpired(session: SessionState): boolean {
    return (
      Date.parse(canonicalTime(this.#now())) - Date.parse(session.lastSeenAt) >=
      this.#limits.sessionIdleMs
    );
  }

  #closeSession(session: SessionState): void {
    session.closed = true;
    this.#sessionByTokenDigest.delete(session.tokenDigest);
    for (const socket of session.sockets) socket.close(1008, "session expired");
    session.sockets.clear();
    this.#notifyClosed(session);
  }

  #emitSessionChange(event: ConsoleSessionChangeEvent): void {
    this.#onSessionChange?.(deepFreeze(event));
  }

  /** Closed notifications are best-effort: the close already completed and a
   * failing host observer must not corrupt in-flight requests or stop(). */
  #notifyClosed(session: SessionState): void {
    try {
      this.#emitSessionChange({
        type: "closed",
        sessionId: session.sessionId,
        principalId: session.principalId,
        routeAliases: [...session.routeAliases],
      });
    } catch {
      // See method note.
    }
  }

  #writeApplicationAsset(
    response: ServerResponse,
    body: string,
    contentType: string,
  ): void {
    response.setHeader("Content-Type", contentType);
    if (contentType.startsWith("text/html")) {
      // The application page may load only its own origin's script and style
      // and connect only back to the same gateway — no inline script, no
      // third-party origin, no eval (console-extension.md section 13).
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; " +
          "connect-src 'self'; img-src 'self'; base-uri 'none'; " +
          "form-action 'self'; frame-ancestors 'none'",
      );
    }
    response.setHeader("Content-Length", Buffer.byteLength(body));
    response.writeHead(200);
    response.end(body);
  }

  #requireOrigin(request: IncomingMessage): void {
    if (request.headers.origin !== this.#requireAddress().origin) {
      throw new ConsoleHttpError(403, "ORIGIN_DENIED", "Origin is not authorized");
    }
  }

  #requireCsrf(request: IncomingMessage, session: SessionState): void {
    const value = request.headers["x-dolly-csrf"];
    if (typeof value !== "string" || !secretMatches(value, session.csrfDigest)) {
      throw new ConsoleHttpError(403, "CSRF_DENIED", "CSRF token is missing or invalid");
    }
  }

  #enqueue(session: SessionState, body: unknown): ConsoleQueuedMessage {
    assertClosedObject(body, [
      "version",
      "type",
      "operationId",
      "clientMessageId",
      "routeAlias",
      "text",
    ]);
    if (body.version !== "1" || body.type !== "message.enqueue") {
      throw new ConsoleHttpError(400, "VERSION_UNSUPPORTED", "Message schema is unsupported");
    }
    assertId(body.operationId, "operationId");
    assertId(body.clientMessageId, "clientMessageId");
    assertId(body.routeAlias, "routeAlias");
    if (!session.routeAliases.has(body.routeAlias)) {
      throw new ConsoleHttpError(403, "ROUTE_DENIED", "Route is not authorized for this session");
    }
    if (
      typeof body.text !== "string" ||
      body.text.length === 0 ||
      Buffer.byteLength(body.text, "utf8") > this.#limits.maxTextBytes
    ) {
      throw new ConsoleHttpError(400, "MESSAGE_LIMIT", "Message text is empty or too large");
    }
    const requestDigest = canonicalJsonDigest(body);
    const byOperation = session.operations.get(body.operationId);
    const byClientMessage = session.clientMessages.get(body.clientMessageId);
    for (const existing of [byOperation, byClientMessage]) {
      if (!existing) continue;
      if (existing.digest !== requestDigest) {
        throw new ConsoleHttpError(409, "IDEMPOTENCY_CONFLICT", "Message identity was reused");
      }
      return existing.message;
    }
    if (session.queue.length >= this.#limits.maxQueuedMessagesPerSession) {
      throw new ConsoleHttpError(429, "QUEUE_FULL", "Session message queue is full");
    }
    const message = deepFreeze({
      schemaVersion: "dolly.console-queued-message/1" as const,
      externalMessageId: this.#allocateId("message"),
      sessionId: session.sessionId,
      routeAlias: body.routeAlias,
      operationId: body.operationId,
      clientMessageId: body.clientMessageId,
      sequence: session.nextMessageSequence.toString(10),
      text: body.text,
      acceptedAt: canonicalTime(this.#now()),
    });
    session.nextMessageSequence += 1n;
    session.queue.push(message);
    const receipt = { digest: requestDigest, message };
    session.operations.set(message.operationId, receipt);
    session.clientMessages.set(message.clientMessageId, receipt);
    return message;
  }

  async #readJson(request: IncomingMessage): Promise<unknown> {
    const contentType = request.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      throw new ConsoleHttpError(415, "CONTENT_TYPE_REQUIRED", "Content-Type must be application/json");
    }
    const declaredLength = request.headers["content-length"];
    if (
      declaredLength !== undefined &&
      (!/^(0|[1-9][0-9]*)$/.test(declaredLength) ||
        Number(declaredLength) > this.#limits.maxJsonBytes)
    ) {
      throw new ConsoleHttpError(413, "BODY_LIMIT", "JSON request body is too large");
    }
    const chunks: Buffer[] = [];
    let byteLength = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += bytes.byteLength;
      if (byteLength > this.#limits.maxJsonBytes) {
        throw new ConsoleHttpError(413, "BODY_LIMIT", "JSON request body is too large");
      }
      chunks.push(bytes);
    }
    try {
      return JSON.parse(Buffer.concat(chunks, byteLength).toString("utf8"));
    } catch {
      throw new ConsoleHttpError(400, "INVALID_JSON", "JSON request body is invalid");
    }
  }

  #securityHeaders(response: ServerResponse): void {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
  }

  #writeJson(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent) return;
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
  }

  #writeError(response: ServerResponse, error: unknown): void {
    if (response.headersSent || response.destroyed) return;
    const status = error instanceof ConsoleHttpError ? error.status : 500;
    const code = error instanceof ConsoleHttpError ? error.code : "INTERNAL_ERROR";
    this.#securityHeaders(response);
    this.#writeJson(response, status, { error: { code } });
  }

  #allocateId(kind: Parameters<ConsoleGatewayOptions["nextId"]>[0]): string {
    const id = this.#nextId(kind);
    if (!ID_PATTERN.test(id)) throw new Error(`Runtime generated an invalid ${kind} ID`);
    if (this.#usedIds.has(id)) throw new Error(`Runtime generated duplicate ID ${id}`);
    this.#usedIds.add(id);
    return id;
  }

  #requireAddress(): ConsoleGatewayAddress {
    if (!this.#address) throw new Error("Console gateway is not listening");
    return this.#address;
  }
}
