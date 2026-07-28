import type {
  ConsoleGateway,
  ConsoleGatewayAddress,
  ConsoleQueuedMessage,
} from "../../core/console-gateway.js";
import { assertJsonValue, type JsonValue } from "../../core/canonical-json.js";
import { consoleError } from "./errors.js";
import {
  parseExternalMessage,
  EXTERNAL_MESSAGE_TYPE,
  EXTERNAL_MESSAGE_VERSION,
  type ConsoleExternalMessage,
  type ExternalMessageLimits,
} from "./external-message.js";
import type { ConsoleAcceptanceReceipt, ConsoleDisplayItem, ConsoleSessionStore } from "./session-store.js";

/**
 * Browser transport binding.
 *
 * The transport itself is `src/core/console-gateway.ts`: it owns the loopback
 * listener, the single-use pairing code, the `HttpOnly` `SameSite=Strict`
 * cookie, exact `Origin` checks, the CSRF header, pre-parse body limits, and
 * WebSocket upgrade authentication. This binding deliberately terminates no
 * socket and re-implements no authentication — a second authenticating surface
 * is how the legacy prototype ended up with an unauthenticated cross-origin
 * WebSocket in the first place.
 *
 * What this file adds is the message layer: an authenticated queue entry
 * becomes a `dolly.console.external-message/1` envelope through exactly the
 * same validator the CLI uses.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

/**
 * `security-operations.md` section 3: loopback only by default, never an
 * unspecified address, and a bind failure stops rather than widening.
 */
export function assertLoopbackBinding(host: unknown): "127.0.0.1" | "::1" {
  if (typeof host !== "string" || !LOOPBACK_HOSTS.has(host)) {
    throw consoleError("BINDING_NOT_LOOPBACK", "Console must bind an explicit loopback address", {
      host: typeof host === "string" ? host : null,
    });
  }
  return host as "127.0.0.1" | "::1";
}

/**
 * Starts the gateway and verifies the address it actually bound.
 *
 * A bind failure propagates unchanged. There is no retry, no fallback host,
 * and no second attempt on a wider interface.
 */
export async function startLoopbackGateway(
  gateway: ConsoleGateway,
  host: unknown = "127.0.0.1",
): Promise<ConsoleGatewayAddress> {
  assertLoopbackBinding(host);
  const address = await gateway.start();
  if (!LOOPBACK_HOSTS.has(address.host)) {
    await gateway.stop();
    throw consoleError("BINDING_NOT_LOOPBACK", "Console gateway bound a non-loopback address", {
      host: address.host,
    });
  }
  return address;
}

/**
 * Host-owned binding from an accepted upload to the message that will carry it.
 *
 * The core gateway's enqueue schema is text-only today, so this port is where
 * the upload flow records the ordered grants for a `clientMessageId`. It is
 * keyed by session, which is what stops one session from attaching another
 * session's upload by quoting its identifier.
 */
export interface ConsoleAttachmentBinding {
  attachmentsFor(input: {
    readonly sessionId: string;
    readonly clientMessageId: string;
  }): readonly string[];
}

/**
 * Converts one authenticated gateway queue entry into the shared envelope.
 *
 * Everything the client supplied is revalidated here even though the gateway
 * already checked its own schema: the envelope is the contract both transports
 * share, so it may not be reachable by any path that skips its validator.
 */
export function externalMessageFromGatewayQueue(
  queued: ConsoleQueuedMessage,
  options: {
    readonly attachments?: readonly string[];
    readonly limits?: Partial<ExternalMessageLimits>;
  } = {},
): ConsoleExternalMessage {
  const attachments = options.attachments ?? [];
  return parseExternalMessage(
    {
      version: EXTERNAL_MESSAGE_VERSION,
      type: EXTERNAL_MESSAGE_TYPE,
      operationId: queued.operationId,
      clientMessageId: queued.clientMessageId,
      routeAlias: queued.routeAlias,
      text: queued.text,
      ...(attachments.length === 0
        ? {}
        : { attachments: attachments.map((uploadGrantId) => ({ uploadGrantId })) }),
    },
    options.limits,
  );
}

export interface ConsoleHttpChannelOptions {
  readonly gateway: ConsoleGateway;
  readonly store: ConsoleSessionStore;
  readonly attachments?: ConsoleAttachmentBinding;
  readonly messageLimits?: Partial<ExternalMessageLimits>;
}

export interface IngestedMessage {
  readonly message: ConsoleExternalMessage;
  readonly receipt: ConsoleAcceptanceReceipt;
}

export class ConsoleHttpChannel {
  readonly #gateway: ConsoleGateway;
  readonly #store: ConsoleSessionStore;
  readonly #attachments: ConsoleAttachmentBinding | undefined;
  readonly #messageLimits: Partial<ExternalMessageLimits> | undefined;
  /** Per-session high-water mark over the gateway queue. Never global. */
  readonly #ingested = new Map<string, Set<string>>();
  /** Per-session display publication cursor. Never global. */
  readonly #published = new Map<string, bigint>();

  constructor(options: ConsoleHttpChannelOptions) {
    this.#gateway = options.gateway;
    this.#store = options.store;
    this.#attachments = options.attachments;
    this.#messageLimits = options.messageLimits;
  }

  /**
   * Drains the gateway's authenticated queue for one session into the store.
   * Re-running it is idempotent because acceptance is keyed by the session's
   * own operation and client message identifiers.
   */
  ingest(input: {
    readonly sessionId: string;
    readonly principalId: string;
  }): readonly IngestedMessage[] {
    let seen = this.#ingested.get(input.sessionId);
    if (!seen) {
      seen = new Set();
      this.#ingested.set(input.sessionId, seen);
    }
    const accepted: IngestedMessage[] = [];
    for (const queued of this.#gateway.listQueuedMessages(input.sessionId)) {
      if (queued.sessionId !== input.sessionId) {
        // The gateway scopes its queue by session already; disagreeing here
        // would mean host state was crossed, which must never be papered over.
        throw consoleError("SESSION_SCOPE_DENIED", "Gateway queue entry names another session");
      }
      if (seen.has(queued.externalMessageId)) continue;
      const message = externalMessageFromGatewayQueue(queued, {
        attachments:
          this.#attachments?.attachmentsFor({
            sessionId: input.sessionId,
            clientMessageId: queued.clientMessageId,
          }) ?? [],
        ...(this.#messageLimits === undefined ? {} : { limits: this.#messageLimits }),
      });
      const receipt = this.#store.acceptMessage({
        sessionId: input.sessionId,
        principalId: input.principalId,
        message,
      });
      seen.add(queued.externalMessageId);
      accepted.push({ message, receipt });
    }
    return accepted;
  }

  /**
   * Pushes this session's own new display items over its own WebSockets. The
   * gateway's `publishToSession` is already session-scoped; the cursor here
   * makes sure a reconnecting client is not replayed items it already has.
   */
  publishDisplay(input: {
    readonly sessionId: string;
    readonly principalId: string;
  }): readonly ConsoleDisplayItem[] {
    const after = this.#published.get(input.sessionId) ?? 0n;
    const pending = this.#store.listDisplay({
      sessionId: input.sessionId,
      principalId: input.principalId,
      afterSequence: after.toString(10),
    });
    for (const item of pending) {
      assertJsonValue(item);
      this.#gateway.publishToSession(input.sessionId, item as unknown as JsonValue);
      this.#published.set(input.sessionId, BigInt(item.displaySequence));
    }
    return pending;
  }
}
