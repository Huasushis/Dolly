import { readFileSync } from "node:fs";

import type { SourceIdentity } from "../../core/block-store.js";
import type { JsonValue } from "../../core/canonical-json.js";
import {
  ConsoleGateway,
  type ConsoleClientApplication,
  type ConsoleDisplayResumeRequest,
  type ConsoleDisplayResumeResult,
  type ConsoleGatewayAddress,
  type ConsoleGatewayLimits,
  type ConsoleGatewayOptions,
  type ConsoleSessionChangeEvent,
  type PairingCodeHandle,
} from "../../core/console-gateway.js";
import { ConsoleExtensionError, consoleError } from "./errors.js";
import {
  ConsoleHttpChannel,
  startLoopbackGateway,
  type IngestedMessage,
} from "./http-channel.js";
import type { ConsolePresentationItem } from "./presentation.js";
import {
  ConsoleSessionStore,
  type ConsoleDisplayItem,
  type ConsoleRoute,
  type ConsoleSessionLimits,
  type ConsoleSessionState,
} from "./session-store.js";

export interface ConsoleWebChannelDisplayInput {
  readonly blockId: string;
  readonly deliveryIds: readonly string[];
  readonly source: SourceIdentity;
  readonly createdAt: string;
  readonly presentation: readonly ConsolePresentationItem[];
}

export interface ConsoleWebChannelOptions {
  readonly host?: "127.0.0.1" | "::1";
  readonly port?: number;
  readonly routes: readonly ConsoleRoute[];
  readonly now: () => string;
  readonly nextId: (
    kind: "session" | "event" | "message" | "external-message" | "display",
  ) => string;
  readonly nextSecret: ConsoleGatewayOptions["nextSecret"];
  /** Override for the static client application; defaults to the `web/` assets. */
  readonly application?: ConsoleClientApplication;
  readonly limits?: {
    readonly gateway?: Partial<ConsoleGatewayLimits>;
    readonly session?: Partial<ConsoleSessionLimits>;
  };
}

/**
 * Loads the static client application shipped next to this module. Paths are
 * resolved against the module location, so the same call works from source
 * (tsx) and from the compiled tree; the build copies `web/` via
 * `copy-runtime-assets`.
 */
export function loadConsoleClientApplication(): ConsoleClientApplication {
  const read = (name: string): string =>
    readFileSync(new URL(`./web/${name}`, import.meta.url), "utf8");
  return { html: read("index.html"), script: read("app.js"), styles: read("styles.css") };
}

/**
 * The console web channel: the assembled, browser-facing surface of the
 * Console extension on one loopback origin.
 *
 * Responsibilities, matching `docs/spec/console-extension.md` sections 3-4:
 * the host-owned `ConsoleGateway` enforces pairing authentication, session
 * cookies, CSRF, exact-origin and Host checks, and all flow limits; the
 * `ConsoleSessionStore` holds each session's ingress queue and bounded
 * display window; the static client application is served from the same
 * trusted origin. Session isolation here is structural: every store lookup is
 * keyed by the session identity the gateway already authenticated, and
 * display publication targets one session — there is no cross-session
 * broadcast anywhere in the composition.
 *
 * This class is deliberately not a Module: ingress acceptance and display
 * activation are host-driven, and the Module-bound parts (source activation,
 * egress preparation with membership sequencing) stay in
 * `ingress-proposal.ts` and `egress-display.ts`.
 */
export class ConsoleWebChannel {
  readonly #host: "127.0.0.1" | "::1";
  readonly #gateway: ConsoleGateway;
  readonly #store: ConsoleSessionStore;
  readonly #channel: ConsoleHttpChannel;
  readonly #routes = new Map<string, ConsoleRoute>();
  readonly #sessions = new Map<string, { principalId: string; routeAlias: string }>();
  #address: ConsoleGatewayAddress | null = null;

  constructor(options: ConsoleWebChannelOptions) {
    this.#host = options.host ?? "127.0.0.1";
    if (options.routes.length === 0) {
      throw consoleError("ROUTE_UNAVAILABLE", "The web channel needs at least one route");
    }
    this.#store = new ConsoleSessionStore({
      now: options.now,
      nextId: options.nextId,
      limits: options.limits?.session,
    });
    for (const input of options.routes) {
      if (this.#routes.has(input.alias)) {
        throw consoleError("ROUTE_DENIED", "Route aliases must be unique per channel", {
          routeAlias: input.alias,
        });
      }
      this.#routes.set(input.alias, this.#store.registerRoute(input));
    }
    this.#gateway = new ConsoleGateway({
      host: this.#host,
      port: options.port,
      now: options.now,
      nextId: options.nextId,
      nextSecret: options.nextSecret,
      limits: options.limits?.gateway,
      clientApplication: options.application ?? loadConsoleClientApplication(),
      onSessionChange: (event) => this.#sessionChanged(event),
      resolveDisplayResume: (input) => this.#resume(input),
    });
    this.#channel = new ConsoleHttpChannel({
      gateway: this.#gateway,
      store: this.#store,
    });
  }

  async start(): Promise<ConsoleGatewayAddress> {
    this.#address = await startLoopbackGateway(this.#gateway, this.#host);
    return this.#address;
  }

  async stop(): Promise<void> {
    // Gateway stop permanently closes its sessions and notifies us for each
    // one; anything still tracked afterwards is closed defensively below.
    await this.#gateway.stop();
    for (const [sessionId, tracked] of this.#sessions) {
      try {
        this.#store.closeSession(sessionId, tracked.principalId);
      } catch (error) {
        if (!(error instanceof ConsoleExtensionError && error.code === "SESSION_UNKNOWN")) {
          throw error;
        }
      }
    }
    this.#sessions.clear();
    this.#address = null;
  }

  address(): ConsoleGatewayAddress {
    if (!this.#address) throw new Error("Console web channel is not started");
    return this.#address;
  }

  /** Transport/security enforcement surface (session lookup, queues, events). */
  get gateway(): ConsoleGateway {
    return this.#gateway;
  }

  /** Session-scoped queues and the bounded display window. */
  get store(): ConsoleSessionStore {
    return this.#store;
  }

  /**
   * Issues a single-use pairing code binding one principal to one route. The
   * host decides how the code reaches the operator (e.g. a trusted CLI); the
   * code is a credential and must never be logged or placed in a URL.
   */
  issuePairingCode(input: { principalId: string; routeAlias: string }): PairingCodeHandle {
    const route = this.#routes.get(input.routeAlias);
    if (!route) {
      throw consoleError("ROUTE_UNAVAILABLE", "Route alias is not registered on this channel", {
        routeAlias: input.routeAlias,
      });
    }
    if (!route.allowedPrincipals.includes(input.principalId)) {
      throw consoleError("ROUTE_DENIED", "Principal is not authorized for this route", {
        routeAlias: input.routeAlias,
      });
    }
    return this.#gateway.issuePairingCode({
      principalId: input.principalId,
      routeAliases: [input.routeAlias],
    });
  }

  /**
   * Moves this session's queued browser input from the volatile gateway queue
   * into the session-scoped store queue (spec 5.2/5.3). The remaining path —
   * lease as a Blocks record and activation by the installed source Module —
   * stays with the host that runs the Core.
   */
  ingestSession(sessionId: string): readonly IngestedMessage[] {
    const tracked = this.#requireTracked(sessionId);
    return this.#channel.ingest({ sessionId, principalId: tracked.principalId });
  }

  /**
   * Host-side activation of already-committed delivery results: appends the
   * presentation items to the session's bounded display window, per section
   * 6.1, and publishes live display events to that session only. Callers must
   * have established causation committed receipt coverage upstream (in the
   * Module-bound path this is `ConsoleEgressCoordinator.commitDisplay`).
   */
  appendDisplay(
    sessionId: string,
    items: readonly ConsoleWebChannelDisplayInput[],
  ): readonly ConsoleDisplayItem[] {
    const tracked = this.#requireTracked(sessionId);
    const route = this.#store.routeOf(sessionId, tracked.principalId);
    const preparationOrdinal = this.#store.reservePreparationOrdinal(
      route.alias,
      route.revision,
    );
    const appended = this.#store.appendDisplayItems({
      sessionId,
      preparationOrdinal,
      items: [...items],
    });
    this.#channel.publishDisplay({ sessionId, principalId: tracked.principalId });
    return appended;
  }

  /** Contiguous display acknowledgement from section 6.5, on the session's behalf. */
  ackDisplay(
    sessionId: string,
    input: { operationId: string; ackThrough: string },
  ): { readonly ackThrough: string } {
    const tracked = this.#requireTracked(sessionId);
    return this.#store.ackDisplay({
      sessionId,
      principalId: tracked.principalId,
      operationId: input.operationId,
      ackThrough: input.ackThrough,
    });
  }

  /**
   * Bounded replay for a reconnecting client, scoped to the authenticated
   * session (spec 4.3, 6.2). Acknowledged-and-released items are never
   * recreated; a cursor beneath the retained window reports `truncated` so
   * the client can show the gap honestly instead of faking continuity.
   */
  #resume(input: ConsoleDisplayResumeRequest): ConsoleDisplayResumeResult {
    const tracked = this.#sessions.get(input.sessionId);
    if (!tracked || tracked.principalId !== input.principalId) {
      return { kind: "unavailable" };
    }
    let watermark: { readonly oldestRetained: string | null; readonly newestIssued: string };
    let items: readonly ConsoleDisplayItem[];
    try {
      watermark = this.#store.displayWatermark(input.sessionId, input.principalId);
      items = this.#store.listDisplay({
        sessionId: input.sessionId,
        principalId: input.principalId,
        afterSequence: input.afterSequence,
      });
    } catch (error) {
      if (error instanceof ConsoleExtensionError && error.code === "SESSION_UNKNOWN") {
        return { kind: "unavailable" };
      }
      throw error;
    }
    const after = BigInt(input.afterSequence);
    const newest = BigInt(watermark.newestIssued);
    if (after > newest) {
      return { kind: "cursor-invalid" };
    }
    const oldest = watermark.oldestRetained === null ? null : BigInt(watermark.oldestRetained);
    const truncated = newest > after && (oldest === null || oldest > after + 1n);
    return { kind: "resume", items: items as unknown as JsonValue[], truncated };
  }

  #sessionChanged(event: ConsoleSessionChangeEvent): void {
    if (event.type === "opened") {
      // Pairings issued through this composition bind exactly one route alias
      // (issuePairingCode enforces this), so the session scope is unambiguous.
      const routeAlias = event.routeAliases[0]!;
      const route = this.#routes.get(routeAlias);
      if (!route) {
        throw consoleError("ROUTE_UNAVAILABLE", "Paired route alias is not registered", {
          routeAlias,
        });
      }
      this.#store.openSession({
        sessionId: event.sessionId,
        principalId: event.principalId,
        routeAlias,
        routeRevision: route.revision,
        displayStart: { kind: "from-now" },
      });
      this.#sessions.set(event.sessionId, {
        principalId: event.principalId,
        routeAlias,
      });
      return;
    }
    this.#sessions.delete(event.sessionId);
    try {
      this.#store.closeSession(event.sessionId, event.principalId);
    } catch (error) {
      // A pairing that rolled back mid-flight was never opened in the store.
      if (!(error instanceof ConsoleExtensionError && error.code === "SESSION_UNKNOWN")) {
        throw error;
      }
    }
  }

  #requireTracked(sessionId: string): { principalId: string; routeAlias: string } {
    const tracked = this.#sessions.get(sessionId);
    if (!tracked) {
      throw consoleError("SESSION_UNKNOWN", "Session does not exist or is closed", {
        sessionId,
      });
    }
    return tracked;
  }
}
