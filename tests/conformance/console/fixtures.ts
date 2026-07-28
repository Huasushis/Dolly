import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { WebSocket } from "ws";
import {
  ConsoleGateway,
  type ConsoleGatewayAddress,
  type ConsoleGatewayLimits,
} from "../../../src/core/console-gateway.js";
import type { Block, BlockPayload } from "../../../src/core/block-store.js";
import type { JsonValue } from "../../../src/core/canonical-json.js";
import {
  ConsoleSessionStore,
  type ConsoleSessionStoreOptions,
} from "../../../src/extensions/console/index.js";
import type {
  UploadGrantResolution,
  UploadGrantResolver,
} from "../../../src/extensions/console/index.js";

export const WS_PROTOCOL = "dolly.console.v1";
export const FIXED_NOW = "2026-07-26T00:00:00.000Z";

/**
 * A deterministic upload flow. A grant belongs to exactly one session, which
 * is what makes the cross-session reuse case fail rather than resolve.
 */
export class FakeUploadGrants implements UploadGrantResolver {
  readonly #grants = new Map<string, { sessionId: string; mediaId: string; available: boolean }>();

  issue(input: {
    readonly uploadGrantId: string;
    readonly sessionId: string;
    readonly mediaId: string;
    readonly available?: boolean;
  }): string {
    this.#grants.set(input.uploadGrantId, {
      sessionId: input.sessionId,
      mediaId: input.mediaId,
      available: input.available ?? true,
    });
    return input.uploadGrantId;
  }

  resolve(input: {
    readonly sessionId: string;
    readonly uploadGrantId: string;
  }): UploadGrantResolution | null {
    const grant = this.#grants.get(input.uploadGrantId);
    if (!grant || grant.sessionId !== input.sessionId) return null;
    return { mediaId: grant.mediaId, available: grant.available };
  }
}

export interface StoreHarness {
  readonly store: ConsoleSessionStore;
  readonly grants: FakeUploadGrants;
  setNow(value: string): void;
}

export function createStoreHarness(
  overrides: Partial<Omit<ConsoleSessionStoreOptions, "now" | "nextId">> = {},
): StoreHarness {
  let now = FIXED_NOW;
  let counter = 0;
  const grants = new FakeUploadGrants();
  const store = new ConsoleSessionStore({
    now: () => now,
    nextId: (kind) => `${kind}-${(counter += 1)}`,
    uploadGrants: grants,
    ...overrides,
  });
  return {
    store,
    grants,
    setNow(value: string) {
      now = value;
    },
  };
}

export interface GatewayHarness {
  readonly gateway: ConsoleGateway;
  setNow(value: string): void;
}

export function createGatewayHarness(
  limits: Partial<ConsoleGatewayLimits> = {},
  port = 0,
): GatewayHarness {
  let now = FIXED_NOW;
  let id = 0;
  let secret = 0;
  const gateway = new ConsoleGateway({
    host: "127.0.0.1",
    port,
    now: () => now,
    nextId: (kind) => `gateway-${kind}-${(id += 1)}`,
    nextSecret: (kind) =>
      createHash("sha256")
        .update(`${kind}:${(secret += 1)}`)
        .digest("base64url"),
    limits: {
      maxJsonBytes: 4096,
      maxTextBytes: 1024,
      maxWebSocketMessageBytes: 512,
      sessionIdleMs: 600_000,
      pairingCodeLifetimeMs: 600_000,
      ...limits,
    },
  });
  return {
    gateway,
    setNow(value: string) {
      now = value;
    },
  };
}

export interface BrowserSession {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly sessionId: string;
}

export async function pairBrowserSession(
  gateway: ConsoleGateway,
  origin: string,
  principalId: string,
  routeAliases: readonly string[],
): Promise<BrowserSession> {
  const pairing = gateway.issuePairingCode({ principalId, routeAliases: [...routeAliases] });
  const response = await fetch(`${origin}/v1/session/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ code: pairing.code }),
  });
  if (response.status !== 201) {
    throw new Error(`Pairing failed with status ${response.status}`);
  }
  const body = (await response.json()) as { sessionId: string; csrfToken: string };
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Pairing returned no session cookie");
  return {
    cookie: setCookie.split(";", 1)[0]!,
    csrfToken: body.csrfToken,
    sessionId: body.sessionId,
  };
}

export async function postMessage(
  address: ConsoleGatewayAddress,
  session: BrowserSession,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${address.origin}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: address.origin,
      cookie: session.cookie,
      "x-dolly-csrf": session.csrfToken,
    },
    body: JSON.stringify(body),
  });
}

export function enqueueBody(input: {
  readonly operationId: string;
  readonly clientMessageId: string;
  readonly routeAlias: string;
  readonly text: string;
}): Record<string, unknown> {
  return {
    version: "1",
    type: "message.enqueue",
    operationId: input.operationId,
    clientMessageId: input.clientMessageId,
    routeAlias: input.routeAlias,
    text: input.text,
  };
}

/** A raw request so a body may violate `Content-Length` or framing on purpose. */
export async function rawRequest(input: {
  readonly port: number;
  readonly path: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: input.port,
        path: input.path,
        method: input.method ?? "GET",
        headers: input.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    if (input.body !== undefined) request.write(input.body);
    request.end();
  });
}

export async function rejectedWebSocket(
  url: string,
  options: { readonly origin: string; readonly cookie?: string },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, WS_PROTOCOL, {
      headers: {
        origin: options.origin,
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      },
    });
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.on("open", () => {
      socket.terminate();
      reject(new Error("WebSocket unexpectedly completed its handshake"));
    });
    socket.on("error", () => {
      // The rejected upgrade surfaces through `unexpected-response` above.
    });
  });
}

export async function openWebSocket(
  origin: string,
  cookie: string,
): Promise<{ socket: WebSocket; ready: Record<string, unknown> }> {
  const url = `${origin.replace(/^http:/, "ws:")}/v1/events`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, WS_PROTOCOL, { headers: { origin, cookie } });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebSocket ready timeout"));
    }, 5000);
    socket.once("message", (data) => {
      clearTimeout(timeout);
      resolve({ socket, ready: JSON.parse(data.toString()) as Record<string, unknown> });
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

let blockCounter = 0;

export function makeBlock(input: {
  readonly id?: string;
  readonly payload: BlockPayload;
  readonly source?: Block["source"];
  readonly createdAt?: string;
}): Block {
  blockCounter += 1;
  return {
    schemaVersion: "dolly.block/2",
    id: input.id ?? `block-${blockCounter}`,
    sequence: String(blockCounter),
    source: input.source ?? { kind: "module", id: "module-writer" },
    createdAt: input.createdAt ?? FIXED_NOW,
    payload: input.payload,
  };
}

export function contentBlock(items: JsonValue[], id?: string): Block {
  return makeBlock({
    ...(id === undefined ? {} : { id }),
    payload: { schema: "dolly.content/1", value: { items } },
  });
}
