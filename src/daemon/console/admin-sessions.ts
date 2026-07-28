/**
 * Bootstrap pairing and browser sessions for the management console.
 *
 * `security-operations.md` Section 4.1 fixes the baseline local bootstrap flow:
 * an in-memory, single-use pairing code shown only by an interactive command,
 * submitted in a same-origin `POST` to a loopback-only endpoint, expiring
 * within a short bounded interval, invalidated after one success, limited to a
 * small number of rate-limited attempts, and never written to a uniform
 * resource locator (URL), browser storage, configuration, or routine log. The
 * successful exchange returns an `HttpOnly`, `SameSite=Strict` cookie plus the
 * cross-site request forgery (CSRF) token.
 *
 * Only digests of the pairing code, the session token, and the CSRF token are
 * kept, and every comparison is constant time, so neither this store nor a
 * timing observation can reconstruct a credential.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { deepFreeze } from "../../core/canonical-json.js";

const SECRET_PATTERN = /^[A-Za-z0-9_-]{43,512}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export const ADMIN_SESSION_COOKIE = "dolly_admin_session";

export interface AdminSessionLimits {
  readonly maxPairingAttemptsPerWindow: number;
  readonly pairingAttemptWindowMs: number;
  readonly pairingCodeLifetimeMs: number;
  readonly sessionIdleMs: number;
  readonly maxActiveSessions: number;
}

export const DEFAULT_ADMIN_SESSION_LIMITS: AdminSessionLimits = deepFreeze({
  maxPairingAttemptsPerWindow: 5,
  pairingAttemptWindowMs: 60_000,
  pairingCodeLifetimeMs: 120_000,
  sessionIdleMs: 30 * 60_000,
  maxActiveSessions: 8,
}) as AdminSessionLimits;

export type AdminSessionErrorCode =
  | "AUTH_REQUIRED"
  | "SESSION_INVALID"
  | "CSRF_DENIED"
  | "PAIRING_DENIED"
  | "PAIRING_EXPIRED"
  | "PAIRING_RATE_LIMITED"
  | "SESSION_LIMIT_REACHED";

export class AdminSessionError extends Error {
  constructor(
    readonly code: AdminSessionErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AdminSessionError";
  }
}

export interface AdminSession {
  readonly sessionId: string;
  readonly principalId: string;
  readonly createdAt: string;
}

export interface AdminPairingHandle {
  readonly code: string;
  readonly expiresAt: string;
}

export interface AdminSessionGrant {
  readonly session: AdminSession;
  readonly sessionToken: string;
  readonly csrfToken: string;
}

export interface AdminSessionStoreOptions {
  readonly now: () => string;
  readonly nextId: (kind: "session") => string;
  readonly nextSecret: (kind: "pairing" | "session" | "csrf") => string;
  readonly limits?: Partial<AdminSessionLimits>;
}

interface PairingRecord {
  readonly codeDigest: string;
  readonly principalId: string;
  readonly expiresAt: string;
}

interface SessionRecord {
  readonly sessionId: string;
  readonly principalId: string;
  readonly tokenDigest: string;
  readonly csrfDigest: string;
  readonly createdAt: string;
  lastSeenAt: string;
}

interface AttemptBucket {
  windowStartedAt: number;
  attempts: number;
}

function digestSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function secretMatches(value: string, digest: string): boolean {
  const actual = Buffer.from(digestSecret(value), "hex");
  const expected = Buffer.from(digest, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function parseCookieHeader(header: string | undefined): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const segment of header.split(";")) {
    const index = segment.indexOf("=");
    if (index <= 0) continue;
    const name = segment.slice(0, index).trim();
    const value = segment.slice(index + 1).trim();
    // A duplicated cookie name is ambiguous, so nothing is trusted from it.
    if (cookies.has(name)) return new Map();
    cookies.set(name, value);
  }
  return cookies;
}

export class AdminSessionStore {
  readonly #now: () => string;
  readonly #nextId: AdminSessionStoreOptions["nextId"];
  readonly #nextSecret: AdminSessionStoreOptions["nextSecret"];
  readonly #limits: AdminSessionLimits;
  readonly #pairings = new Map<string, PairingRecord>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #sessionByTokenDigest = new Map<string, string>();
  readonly #attempts = new Map<string, AttemptBucket>();

  constructor(options: AdminSessionStoreOptions) {
    this.#now = options.now;
    this.#nextId = options.nextId;
    this.#nextSecret = options.nextSecret;
    const limits = { ...DEFAULT_ADMIN_SESSION_LIMITS, ...(options.limits ?? {}) };
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`Admin session limit ${name} must be a positive safe integer`);
      }
    }
    this.#limits = deepFreeze(limits);
  }

  get limits(): AdminSessionLimits {
    return this.#limits;
  }

  get activeSessionCount(): number {
    return this.#sessions.size;
  }

  /** Issues a single-use bootstrap code. The caller shows it interactively. */
  issuePairingCode(principalId: string): AdminPairingHandle {
    if (!ID_PATTERN.test(principalId)) {
      throw new TypeError("principalId is not a valid identifier");
    }
    const code = this.#nextSecret("pairing");
    if (!SECRET_PATTERN.test(code)) {
      throw new TypeError("A pairing code must be 43-512 base64url characters");
    }
    const codeDigest = digestSecret(code);
    if (this.#pairings.has(codeDigest)) {
      throw new Error("The pairing code generator returned a duplicate");
    }
    const expiresAt = new Date(
      this.#instant() + this.#limits.pairingCodeLifetimeMs,
    ).toISOString();
    this.#pairings.set(codeDigest, deepFreeze({ codeDigest, principalId, expiresAt }));
    return deepFreeze({ code, expiresAt });
  }

  /** Exchanges a code for a session. The code is consumed either way. */
  redeem(input: { readonly code: unknown; readonly remoteAddress: string }): AdminSessionGrant {
    this.#consumeAttempt(input.remoteAddress);
    if (typeof input.code !== "string" || !SECRET_PATTERN.test(input.code)) {
      throw new AdminSessionError("PAIRING_DENIED", 401, "The pairing code is invalid");
    }
    const codeDigest = digestSecret(input.code);
    const pairing = this.#pairings.get(codeDigest);
    if (!pairing || !secretMatches(input.code, pairing.codeDigest)) {
      throw new AdminSessionError("PAIRING_DENIED", 401, "The pairing code is invalid");
    }
    this.#pairings.delete(codeDigest);
    if (Date.parse(pairing.expiresAt) <= this.#instant()) {
      throw new AdminSessionError("PAIRING_EXPIRED", 401, "The pairing code has expired");
    }
    this.#expireIdleSessions();
    if (this.#sessions.size >= this.#limits.maxActiveSessions) {
      throw new AdminSessionError(
        "SESSION_LIMIT_REACHED",
        429,
        "The console already has its maximum number of active sessions",
      );
    }

    const sessionId = this.#nextId("session");
    if (!ID_PATTERN.test(sessionId)) throw new Error("An invalid session identifier was generated");
    const sessionToken = this.#nextSecret("session");
    const csrfToken = this.#nextSecret("csrf");
    if (!SECRET_PATTERN.test(sessionToken) || !SECRET_PATTERN.test(csrfToken)) {
      throw new Error("A session secret must be 43-512 base64url characters");
    }
    const tokenDigest = digestSecret(sessionToken);
    if (this.#sessionByTokenDigest.has(tokenDigest)) {
      throw new Error("The session token generator returned a duplicate");
    }
    const now = new Date(this.#instant()).toISOString();
    const record: SessionRecord = {
      sessionId,
      principalId: pairing.principalId,
      tokenDigest,
      csrfDigest: digestSecret(csrfToken),
      createdAt: now,
      lastSeenAt: now,
    };
    this.#sessions.set(sessionId, record);
    this.#sessionByTokenDigest.set(tokenDigest, sessionId);
    return deepFreeze({
      session: { sessionId, principalId: record.principalId, createdAt: now },
      sessionToken,
      csrfToken,
    }) as AdminSessionGrant;
  }

  authenticate(cookieHeader: string | undefined): AdminSession {
    const token = parseCookieHeader(cookieHeader).get(ADMIN_SESSION_COOKIE);
    if (token === undefined || !SECRET_PATTERN.test(token)) {
      throw new AdminSessionError("AUTH_REQUIRED", 401, "Authentication is required");
    }
    const sessionId = this.#sessionByTokenDigest.get(digestSecret(token));
    const record = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
    if (!record || !secretMatches(token, record.tokenDigest) || this.#isExpired(record)) {
      if (record) this.#revokeRecord(record);
      throw new AdminSessionError("SESSION_INVALID", 401, "The session is invalid or expired");
    }
    record.lastSeenAt = new Date(this.#instant()).toISOString();
    return deepFreeze({
      sessionId: record.sessionId,
      principalId: record.principalId,
      createdAt: record.createdAt,
    }) as AdminSession;
  }

  requireCsrf(headerValue: unknown, session: AdminSession): void {
    const record = this.#sessions.get(session.sessionId);
    if (
      !record ||
      typeof headerValue !== "string" ||
      !SECRET_PATTERN.test(headerValue) ||
      !secretMatches(headerValue, record.csrfDigest)
    ) {
      throw new AdminSessionError("CSRF_DENIED", 403, "The CSRF token is missing or invalid");
    }
  }

  revoke(sessionId: string): boolean {
    const record = this.#sessions.get(sessionId);
    if (!record) return false;
    this.#revokeRecord(record);
    return true;
  }

  #revokeRecord(record: SessionRecord): void {
    this.#sessions.delete(record.sessionId);
    this.#sessionByTokenDigest.delete(record.tokenDigest);
  }

  #expireIdleSessions(): void {
    for (const record of [...this.#sessions.values()]) {
      if (this.#isExpired(record)) this.#revokeRecord(record);
    }
  }

  #isExpired(record: SessionRecord): boolean {
    return this.#instant() - Date.parse(record.lastSeenAt) >= this.#limits.sessionIdleMs;
  }

  #consumeAttempt(remoteAddress: string): void {
    const now = this.#instant();
    const existing = this.#attempts.get(remoteAddress);
    const bucket =
      !existing || now - existing.windowStartedAt >= this.#limits.pairingAttemptWindowMs
        ? { windowStartedAt: now, attempts: 0 }
        : existing;
    bucket.attempts += 1;
    this.#attempts.set(remoteAddress, bucket);
    if (bucket.attempts > this.#limits.maxPairingAttemptsPerWindow) {
      throw new AdminSessionError(
        "PAIRING_RATE_LIMITED",
        429,
        "Pairing attempts from this address are rate limited",
      );
    }
  }

  #instant(): number {
    const parsed = Date.parse(this.#now());
    if (!Number.isFinite(parsed)) throw new TypeError("The console clock returned an invalid time");
    return parsed;
  }
}
