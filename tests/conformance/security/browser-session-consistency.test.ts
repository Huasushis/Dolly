/**
 * One set of browser-session invariants, enforced against every implementation
 * that has one.
 *
 * Dolly currently ships two independent pairing/session/CSRF implementations:
 * `ConsoleGateway` (`src/core/console-gateway.ts`), which serves the Console
 * extension's external chat surface, and `AdminHttpServer` with
 * `AdminSessionStore` (`src/daemon/console/`), which serves the management
 * console. They exist separately because the management surface could not be
 * added to `ConsoleGateway` without editing a shipped core module, and the
 * shared extraction waits on the Console contract being accepted.
 *
 * Two copies of security code is exactly the shape of defect that gets fixed in
 * one place and shipped from the other. This suite is the guard until they are
 * merged: every invariant below is parameterized over both subjects, and both
 * must pass. A fix applied to one implementation and not the other fails here.
 *
 * Where the two legitimately differ — an exact status code for a refusal that
 * one reports as 400 and the other as 403 — the assertion pins the *security*
 * outcome instead: the request is refused with a client error **and** the
 * operation produced no effect. `effectCount` makes that falsifiable rather
 * than a weakened check.
 *
 * `security-operations.md` Sections 4.1, 4.2, 4.3, and 14 items 3 and 4 own
 * these rules.
 */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ConsoleGateway } from "../../../src/core/console-gateway.js";
import { AdminHttpServer } from "../../../src/daemon/console/admin-http-server.js";
import { AdminSessionStore } from "../../../src/daemon/console/admin-sessions.js";
import {
  createConsoleHarness,
  rawHttpRequest,
  type ConsoleHarness,
} from "../operations/fixtures/console-operations-harness.js";

const START = "2026-07-25T00:00:00.000Z";
const PAIRING_LIFETIME_MS = 60_000;
const SESSION_IDLE_MS = 60_000;
const MAX_PAIRING_ATTEMPTS = 5;

interface SessionSubject {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly authority: string;
  readonly origin: string;
  readonly cookieName: string;
  readonly csrfHeader: string;
  /** Path of the same-origin bootstrap exchange. */
  readonly pairPath: string;
  /** A route that requires an authenticated session but no CSRF token. */
  readonly readPath: string;
  /** A route that requires an authenticated session and a CSRF token. */
  readonly mutatingPath: string;
  /** A fresh body for the mutating route; identities must not repeat. */
  nextMutatingBody(): unknown;
  /** Status the mutating route returns when it is accepted. */
  readonly mutatingSuccessStatus: number;
  issuePairingCode(): string;
  /**
   * Tells the subject which session a successful exchange created, so an
   * implementation whose effects are keyed by session can count them.
   */
  recordSession(sessionId: string): void;
  /** Observable side effects the mutating route has produced so far. */
  effectCount(): number;
  setNow(value: string): void;
  stop(): Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];
const harnesses: ConsoleHarness[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const harness of harnesses.splice(0)) harness.dispose();
});

function deterministicSecrets() {
  let counter = 0;
  return (kind: string): string =>
    createHash("sha256")
      .update(`${kind}:${(counter += 1)}`)
      .digest("base64url");
}

async function consoleGatewaySubject(): Promise<SessionSubject> {
  let now = START;
  let ids = 0;
  let operations = 0;
  const nextSecret = deterministicSecrets();
  const gateway = new ConsoleGateway({
    host: "127.0.0.1",
    port: 0,
    now: () => now,
    nextId: (kind) => `${kind}-${(ids += 1)}`,
    nextSecret: (kind) => nextSecret(kind),
    limits: {
      pairingCodeLifetimeMs: PAIRING_LIFETIME_MS,
      sessionIdleMs: SESSION_IDLE_MS,
      maxPairingAttemptsPerWindow: MAX_PAIRING_ATTEMPTS,
      pairingAttemptWindowMs: 60_000,
    },
  });
  const address = await gateway.start();
  cleanups.push(() => gateway.stop());
  const sessionIds = new Set<string>();
  return {
    name: "core ConsoleGateway",
    host: "127.0.0.1",
    port: address.port,
    authority: new URL(address.origin).host,
    origin: address.origin,
    cookieName: "dolly_console_session",
    csrfHeader: "x-dolly-csrf",
    pairPath: "/v1/session/pair",
    readPath: "/v1/session",
    mutatingPath: "/v1/messages",
    mutatingSuccessStatus: 202,
    nextMutatingBody() {
      operations += 1;
      return {
        version: "1",
        type: "message.enqueue",
        operationId: `operation-${operations}`,
        clientMessageId: `client-${operations}`,
        routeAlias: "private",
        text: "hello",
      };
    },
    issuePairingCode: () =>
      gateway.issuePairingCode({ principalId: "operator", routeAliases: ["private"] }).code,
    recordSession: (sessionId) => sessionIds.add(sessionId),
    effectCount: () =>
      [...sessionIds].reduce(
        (total, sessionId) => total + gateway.listQueuedMessages(sessionId).length,
        0,
      ),
    setNow(value) {
      now = value;
    },
    stop: () => gateway.stop(),
  };
}

async function adminConsoleSubject(): Promise<SessionSubject> {
  let now = START;
  let ids = 0;
  let operations = 0;
  const nextSecret = deterministicSecrets();
  const harness = createConsoleHarness();
  harnesses.push(harness);
  const sessions = new AdminSessionStore({
    now: () => now,
    nextId: () => `session-${(ids += 1)}`,
    nextSecret: (kind) => nextSecret(kind),
    limits: {
      pairingCodeLifetimeMs: PAIRING_LIFETIME_MS,
      sessionIdleMs: SESSION_IDLE_MS,
      maxPairingAttemptsPerWindow: MAX_PAIRING_ATTEMPTS,
      pairingAttemptWindowMs: 60_000,
    },
  });
  const server = new AdminHttpServer({
    operations: harness.operations,
    sessions,
    now: () => now,
    // The store-level pairing limiter is the one under test; keep the
    // transport limiter out of its way so both subjects refuse at the same
    // attempt.
    limits: { authenticationRequestsPerMinute: 1_000 },
  });
  const address = await server.start();
  cleanups.push(() => server.stop());
  return {
    name: "daemon AdminHttpServer",
    host: address.host,
    port: address.port,
    authority: new URL(server.origin!).host,
    origin: server.origin!,
    cookieName: "dolly_admin_session",
    csrfHeader: "x-dolly-csrf",
    pairPath: "/v1/admin/session",
    readPath: "/v1/admin/instances",
    mutatingPath: `/v1/admin/instances/${harness.instanceId}/stop`,
    mutatingSuccessStatus: 200,
    nextMutatingBody() {
      operations += 1;
      return { operationId: `operation-${operations}` };
    },
    issuePairingCode: () => server.issuePairingCode("operator").code,
    // Effects here are keyed by instance, not by session, so the session
    // identifier is recorded and unused.
    recordSession: () => undefined,
    effectCount: () => harness.lifecycle.stops.length,
    setNow(value) {
      now = value;
    },
    stop: () => server.stop(),
  };
}

const SUBJECTS: readonly { name: string; create: () => Promise<SessionSubject> }[] = [
  { name: "core ConsoleGateway", create: consoleGatewaySubject },
  { name: "daemon AdminHttpServer", create: adminConsoleSubject },
];

interface PairedSession {
  readonly cookie: string;
  readonly cookieValue: string;
  readonly csrfToken: string;
  readonly body: string;
  readonly code: string;
}

async function redeem(
  subject: SessionSubject,
  code: string,
  overrides: { readonly origin?: string; readonly host?: string } = {},
) {
  return rawHttpRequest({
    host: subject.host,
    port: subject.port,
    path: subject.pairPath,
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: overrides.host ?? subject.authority,
      origin: overrides.origin ?? subject.origin,
    },
    body: JSON.stringify({ code }),
  });
}

async function pair(subject: SessionSubject): Promise<PairedSession> {
  const code = subject.issuePairingCode();
  const response = await redeem(subject, code);
  expect(response.status).toBe(201);
  const setCookie = response.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);
  const cookie = cookieHeader.split(";", 1)[0]!;
  const grant = JSON.parse(response.text) as { sessionId: string; csrfToken: string };
  subject.recordSession(grant.sessionId);
  return {
    cookie,
    cookieValue: cookie.slice(cookie.indexOf("=") + 1),
    csrfToken: grant.csrfToken,
    body: response.text,
    code,
  };
}

function mutate(
  subject: SessionSubject,
  session: Pick<PairedSession, "cookie" | "csrfToken">,
  overrides: {
    readonly cookie?: string | null;
    readonly csrf?: string | null;
    readonly origin?: string;
  } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: subject.authority,
    origin: overrides.origin ?? subject.origin,
  };
  const cookie = overrides.cookie === undefined ? session.cookie : overrides.cookie;
  if (cookie !== null) headers.cookie = cookie;
  const csrf = overrides.csrf === undefined ? session.csrfToken : overrides.csrf;
  if (csrf !== null) headers[subject.csrfHeader] = csrf;
  return rawHttpRequest({
    host: subject.host,
    port: subject.port,
    path: subject.mutatingPath,
    method: "POST",
    headers,
    body: JSON.stringify(subject.nextMutatingBody()),
  });
}

function read(subject: SessionSubject, cookie: string | null) {
  return rawHttpRequest({
    host: subject.host,
    port: subject.port,
    path: subject.readPath,
    headers: {
      host: subject.authority,
      ...(cookie === null ? {} : { cookie }),
    },
  });
}

describe.each(SUBJECTS)("BROWSER-SESSION invariants: $name", ({ create }) => {
  it("consumes a pairing code exactly once", async () => {
    const subject = await create();
    const code = subject.issuePairingCode();

    const first = await redeem(subject, code);
    expect(first.status).toBe(201);

    const replay = await redeem(subject, code);
    expect(replay.status).toBe(401);
  });

  it("expires a pairing code that is not redeemed in time", async () => {
    const subject = await create();
    const code = subject.issuePairingCode();
    subject.setNow(new Date(Date.parse(START) + PAIRING_LIFETIME_MS + 1_000).toISOString());

    const response = await redeem(subject, code);
    expect(response.status).toBe(401);
  });

  it("rate limits repeated pairing attempts from one address", async () => {
    const subject = await create();
    const wrongCode = "Z".repeat(43);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < MAX_PAIRING_ATTEMPTS + 3; attempt += 1) {
      statuses.push((await redeem(subject, wrongCode)).status);
    }
    expect(statuses.slice(0, MAX_PAIRING_ATTEMPTS)).toEqual(
      new Array(MAX_PAIRING_ATTEMPTS).fill(401),
    );
    expect(statuses.slice(MAX_PAIRING_ATTEMPTS)).toEqual([429, 429, 429]);
  });

  it("returns an HttpOnly SameSite=Strict cookie and leaks no credential in the body", async () => {
    const subject = await create();
    const session = await pair(subject);

    expect(session.cookie.startsWith(`${subject.cookieName}=`)).toBe(true);
    expect(session.cookieValue.length).toBeGreaterThanOrEqual(43);
    expect(session.body).not.toContain(session.code);
    expect(session.body).not.toContain(session.cookieValue);

    const raw = await redeem(subject, subject.issuePairingCode());
    const setCookie = String(
      Array.isArray(raw.headers["set-cookie"])
        ? raw.headers["set-cookie"][0]
        : raw.headers["set-cookie"],
    );
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
  });

  it("refuses the bootstrap exchange from a foreign origin or a rebinding host", async () => {
    const subject = await create();

    const foreignOrigin = await redeem(subject, subject.issuePairingCode(), {
      origin: "https://attacker.example",
    });
    expect(foreignOrigin.status).toBeGreaterThanOrEqual(400);
    expect(foreignOrigin.status).toBeLessThan(500);
    expect(foreignOrigin.headers["set-cookie"]).toBeUndefined();

    const rebindingHost = await redeem(subject, subject.issuePairingCode(), {
      host: `attacker.example:${subject.port}`,
    });
    expect(rebindingHost.status).toBeGreaterThanOrEqual(400);
    expect(rebindingHost.status).toBeLessThan(500);
    expect(rebindingHost.headers["set-cookie"]).toBeUndefined();
  });

  it("requires an authenticated session on a private read route", async () => {
    const subject = await create();

    expect((await read(subject, null)).status).toBe(401);
    expect((await read(subject, `${subject.cookieName}=${"Q".repeat(43)}`)).status).toBe(401);

    const session = await pair(subject);
    expect((await read(subject, session.cookie)).status).toBe(200);

    // The CSRF token is not a session credential and must not authenticate.
    expect(
      (await read(subject, `${subject.cookieName}=${session.csrfToken}`)).status,
    ).toBe(401);
  });

  it("requires the CSRF token on a state-changing route and applies no effect without it", async () => {
    const subject = await create();
    const session = await pair(subject);
    expect(subject.effectCount()).toBe(0);

    expect((await mutate(subject, session, { csrf: null })).status).toBe(403);
    expect(subject.effectCount()).toBe(0);

    expect((await mutate(subject, session, { csrf: "Y".repeat(43) })).status).toBe(403);
    expect(subject.effectCount()).toBe(0);

    // The same request with the real token proves the refusals above were the
    // CSRF check and not an unrelated failure.
    const accepted = await mutate(subject, session);
    expect(accepted.status).toBe(subject.mutatingSuccessStatus);
    expect(subject.effectCount()).toBe(1);
  });

  it("refuses a state-changing request from a foreign origin even with valid credentials", async () => {
    const subject = await create();
    const session = await pair(subject);

    const refused = await mutate(subject, session, { origin: "https://attacker.example" });
    expect(refused.status).toBe(403);
    expect(subject.effectCount()).toBe(0);

    const accepted = await mutate(subject, session);
    expect(accepted.status).toBe(subject.mutatingSuccessStatus);
    expect(subject.effectCount()).toBe(1);
  });

  it("refuses a state-changing request with no session at all", async () => {
    const subject = await create();
    const session = await pair(subject);

    const refused = await mutate(subject, session, { cookie: null });
    expect(refused.status).toBe(401);
    expect(subject.effectCount()).toBe(0);
  });

  it("invalidates a session after its idle bound", async () => {
    const subject = await create();
    const session = await pair(subject);
    expect((await read(subject, session.cookie)).status).toBe(200);

    subject.setNow(new Date(Date.parse(START) + SESSION_IDLE_MS + 1_000).toISOString());
    expect((await read(subject, session.cookie)).status).toBe(401);
    expect((await mutate(subject, session)).status).toBe(401);
    expect(subject.effectCount()).toBe(0);
  });

  it("accepts no query parameters, so no credential can be logged from a URL", async () => {
    const subject = await create();
    const session = await pair(subject);

    const response = await rawHttpRequest({
      host: subject.host,
      port: subject.port,
      path: `${subject.readPath}?token=${session.csrfToken}`,
      headers: { host: subject.authority, cookie: session.cookie },
    });
    expect(response.status).toBe(400);
  });

  it("ships the restrictive browser headers on success and on refusal", async () => {
    const subject = await create();
    const session = await pair(subject);

    const responses = [
      await read(subject, session.cookie),
      await read(subject, null),
      await rawHttpRequest({
        host: subject.host,
        port: subject.port,
        path: "/v1/definitely-not-a-route",
        headers: { host: subject.authority },
      }),
    ];
    for (const response of responses) {
      const csp = String(response.headers["content-security-policy"]);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("never returns a stack trace or a filesystem path in an error body", async () => {
    const subject = await create();
    const session = await pair(subject);

    const responses = [
      await read(subject, null),
      await mutate(subject, session, { csrf: null }),
      await rawHttpRequest({
        host: subject.host,
        port: subject.port,
        path: subject.mutatingPath,
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: subject.authority,
          origin: subject.origin,
          cookie: session.cookie,
          [subject.csrfHeader]: session.csrfToken,
        },
        body: "{not json",
      }),
    ];
    for (const response of responses) {
      expect(response.text).not.toMatch(/\s+at\s+\w+/u);
      expect(response.text).not.toContain("node_modules");
      expect(response.text.toLowerCase()).not.toContain("e:\\");
      expect(response.text).not.toContain(session.cookieValue);
    }
  });

  it("binds the CSRF token to its own session", async () => {
    const subject = await create();
    const first = await pair(subject);
    const second = await pair(subject);

    // A CSRF token that belongs to another live session must not authorize a
    // request made with this session's cookie. Both implementations store the
    // token per session, and this is the assertion that keeps them that way.
    const forward = await mutate(subject, { cookie: first.cookie, csrfToken: second.csrfToken });
    expect(forward.status).toBe(403);
    expect(subject.effectCount()).toBe(0);

    const backward = await mutate(subject, { cookie: second.cookie, csrfToken: first.csrfToken });
    expect(backward.status).toBe(403);
    expect(subject.effectCount()).toBe(0);

    // Each session's own pair still works, so the refusals above were the
    // binding and not some unrelated breakage of the second session.
    expect((await mutate(subject, first)).status).toBe(subject.mutatingSuccessStatus);
    expect((await mutate(subject, second)).status).toBe(subject.mutatingSuccessStatus);
    expect(subject.effectCount()).toBe(2);
  });

  it("issues fresh, distinct credentials for every authentication", async () => {
    const subject = await create();
    const first = await pair(subject);
    const second = await pair(subject);

    // Section 4.1 requires session identifiers to rotate on authentication, so
    // a second exchange must not hand back the first session's credentials.
    expect(first.cookieValue).not.toBe(second.cookieValue);
    expect(first.csrfToken).not.toBe(second.csrfToken);
    // The two credentials of one session are separate secrets, so learning the
    // readable one does not yield the HttpOnly one.
    expect(first.cookieValue).not.toBe(first.csrfToken);
    expect(second.cookieValue).not.toBe(second.csrfToken);
    // Nor is either derived from the pairing code that created the session.
    expect(first.cookieValue).not.toBe(first.code);
    expect(first.csrfToken).not.toBe(first.code);
  });
});

describe("BROWSER-SESSION coverage", () => {
  it("runs against every shipped browser-session implementation", () => {
    // A third implementation added without being registered here would keep
    // its own copy of these rules untested; this is the reminder.
    expect(SUBJECTS.map((subject) => subject.name)).toEqual([
      "core ConsoleGateway",
      "daemon AdminHttpServer",
    ]);
  });
});
