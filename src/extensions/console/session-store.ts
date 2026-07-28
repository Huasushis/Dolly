import type { SourceIdentity } from "../../core/block-store.js";
import { deepFreeze } from "../../core/canonical-json.js";
import { consoleError } from "./errors.js";
import {
  externalMessageDigest,
  type ConsoleExternalMessage,
} from "./external-message.js";
import { acceptedMessageRecord, type ConsoleAcceptedMessage } from "./ingress-records.js";
import { freezeIngressSnapshot, type ConsoleBatchLimits } from "./ingress-snapshot.js";
import type { ConsoleIngressSnapshot } from "./ingress-records.js";
import { resolveAttachmentMedia, type UploadGrantResolver } from "./media-contract.js";
import { DISPLAY_ITEM_SCHEMA, type ConsolePresentationItem } from "./presentation.js";

/**
 * Session-scoped ingress and display state.
 *
 * This is the direct answer to SEC-002. The legacy prototype kept one mutable
 * global transcript and pushed every event to every connected socket, so any
 * authenticated (in practice, any) client saw everything. Here nothing is
 * stored outside a session record except the route table and a per-route
 * preparation ordinal, both of which are authorization/topology state that
 * contains no message content. `console-extension.md` section 6.2 states the
 * rule this class enforces: display state is scoped by session, route
 * revision, and frozen membership, and a new session must choose its start
 * explicitly rather than inherit somebody else's cursor.
 */

export type ConsoleSessionState = "active" | "closed" | "revoked";

export type ConsoleRouteVisibility = "private" | "shared";

/** The route's Core consumer start policy, distinct from a display cursor. */
export type ConsoleConsumerStart =
  | { readonly kind: "from-now" }
  | { readonly kind: "from-checkpoint"; readonly checkpoint: string; readonly authorizedBy: string };

export interface ConsoleRoute {
  readonly alias: string;
  readonly revision: string;
  readonly visibility: ConsoleRouteVisibility;
  readonly allowedPrincipals: readonly string[];
  readonly consumerStart: ConsoleConsumerStart;
}

/**
 * Where a new session's display stream begins. There is no default: section
 * 4.3 requires the choice to be explicit, and the only alternative to
 * `from-now` is resuming a session the same principal already owned.
 */
export type ConsoleDisplayStart =
  | { readonly kind: "from-now" }
  | {
      readonly kind: "from-session-resume";
      readonly priorSessionId: string;
      readonly authorizedBy: string;
    };

export interface ConsoleDisplayItem {
  readonly schemaVersion: typeof DISPLAY_ITEM_SCHEMA;
  readonly displaySequence: string;
  readonly blockId: string;
  readonly deliveryIds: readonly string[];
  readonly source: SourceIdentity;
  readonly createdAt: string;
  readonly presentation: readonly ConsolePresentationItem[];
  /** True when this session's own committed ingress message produced the Block. */
  readonly selfEcho: boolean;
  /** Route-local preparation ordinal, used to prove start-policy filtering. */
  readonly preparationOrdinal: string;
}

export interface ConsoleAcceptanceReceipt {
  readonly externalMessageId: string;
  readonly acceptanceSequence: string;
  /**
   * This store is in-memory, so it declares `volatile` durability and never
   * reports a queue acceptance as restart-safe (section 3.1).
   */
  readonly disposition: "queued-volatile";
  readonly acceptedAt: string;
}

export interface ConsoleSessionLimits {
  readonly maxQueuedMessagesPerSession: number;
  readonly maxRetainedDisplayItemsPerSession: number;
}

export const DEFAULT_SESSION_LIMITS: ConsoleSessionLimits = deepFreeze({
  maxQueuedMessagesPerSession: 256,
  maxRetainedDisplayItemsPerSession: 512,
});

export interface ConsoleSessionStoreOptions {
  readonly now: () => string;
  readonly nextId: (kind: "external-message" | "display") => string;
  readonly uploadGrants?: UploadGrantResolver;
  readonly limits?: Partial<ConsoleSessionLimits>;
  readonly batchLimits?: Partial<ConsoleBatchLimits>;
}

interface Receipt {
  readonly digest: string;
  readonly receipt: ConsoleAcceptanceReceipt;
}

interface SessionRecord {
  readonly sessionId: string;
  readonly principalId: string;
  readonly routeAlias: string;
  readonly routeRevision: string;
  readonly displayStart: ConsoleDisplayStart;
  state: ConsoleSessionState;
  readonly queue: ConsoleAcceptedMessage[];
  readonly byOperation: Map<string, Receipt>;
  readonly byClientMessage: Map<string, Receipt>;
  nextAcceptance: bigint;
  readonly display: ConsoleDisplayItem[];
  nextDisplaySequence: bigint;
  ackThrough: bigint;
  readonly ackOperations: Map<string, string>;
  /** Terminal disposition per external message, for status queries. */
  readonly terminal: Map<string, "committed" | "failed">;
  /** Block IDs this session's own committed ingress produced, for §6.3. */
  readonly selfEchoBlockIds: Set<string>;
  /** Preparation ordinals at or below this one predate the session. */
  readonly joinedAtOrdinal: bigint;
}

function routeKey(alias: string, revision: string): string {
  return `${alias}\0${revision}`;
}

function decimal(value: bigint): string {
  return value.toString(10);
}

function parseDecimal(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) {
    throw consoleError("DISPLAY_ACK_INVALID", `${label} must be a decimal sequence`);
  }
  return BigInt(value);
}

export class ConsoleSessionStore {
  readonly #now: () => string;
  readonly #nextId: ConsoleSessionStoreOptions["nextId"];
  readonly #uploadGrants: UploadGrantResolver | undefined;
  readonly #limits: ConsoleSessionLimits;
  readonly #batchLimits: Partial<ConsoleBatchLimits> | undefined;
  readonly #routes = new Map<string, ConsoleRoute>();
  readonly #sessions = new Map<string, SessionRecord>();
  /** Route-local preparation ordinal. Topology state, never message content. */
  readonly #routeFrontier = new Map<string, bigint>();

  constructor(options: ConsoleSessionStoreOptions) {
    this.#now = options.now;
    this.#nextId = options.nextId;
    this.#uploadGrants = options.uploadGrants;
    this.#limits = deepFreeze({ ...DEFAULT_SESSION_LIMITS, ...(options.limits ?? {}) });
    this.#batchLimits = options.batchLimits;
  }

  registerRoute(route: ConsoleRoute): ConsoleRoute {
    if (route.allowedPrincipals.length === 0) {
      throw consoleError("ROUTE_UNAVAILABLE", "A route needs at least one allowed principal");
    }
    // Section 4.3: an older Core checkpoint is an explicit private-route
    // creation policy. A shared route can never start behind its members.
    if (route.consumerStart.kind === "from-checkpoint" && route.visibility !== "private") {
      throw consoleError(
        "ROUTE_DENIED",
        "Only a private route may start from an explicit Core checkpoint",
        { routeAlias: route.alias },
      );
    }
    const frozen = deepFreeze({
      alias: route.alias,
      revision: route.revision,
      visibility: route.visibility,
      allowedPrincipals: [...route.allowedPrincipals],
      consumerStart: route.consumerStart,
    });
    this.#routes.set(routeKey(route.alias, route.revision), frozen);
    if (!this.#routeFrontier.has(routeKey(route.alias, route.revision))) {
      this.#routeFrontier.set(routeKey(route.alias, route.revision), 0n);
    }
    return frozen;
  }

  #requireRoute(alias: string, revision: string, principalId: string): ConsoleRoute {
    const route = this.#routes.get(routeKey(alias, revision));
    if (!route) {
      throw consoleError("ROUTE_UNAVAILABLE", "Route revision is not registered", {
        routeAlias: alias,
      });
    }
    if (!route.allowedPrincipals.includes(principalId)) {
      throw consoleError("ROUTE_DENIED", "Route is not authorized for this principal", {
        routeAlias: alias,
      });
    }
    return route;
  }

  /**
   * Opens a session. `displayStart` is mandatory: a missing value fails with
   * `DISPLAY_START_REQUIRED` instead of quietly defaulting, because the
   * defaulted behaviour is exactly what leaked history in the legacy console.
   */
  openSession(input: {
    readonly sessionId: string;
    readonly principalId: string;
    readonly routeAlias: string;
    readonly routeRevision: string;
    readonly displayStart?: ConsoleDisplayStart;
  }): void {
    if (this.#sessions.has(input.sessionId)) {
      throw consoleError("SESSION_SCOPE_DENIED", "Session identifier is already in use");
    }
    const route = this.#requireRoute(input.routeAlias, input.routeRevision, input.principalId);
    const start = input.displayStart;
    if (!start || (start.kind !== "from-now" && start.kind !== "from-session-resume")) {
      throw consoleError(
        "DISPLAY_START_REQUIRED",
        "A new session must choose its display start explicitly",
      );
    }

    let inherited: readonly ConsoleDisplayItem[] = [];
    let joinedAtOrdinal = this.#routeFrontier.get(routeKey(route.alias, route.revision)) ?? 0n;
    if (start.kind === "from-session-resume") {
      const prior = this.#sessions.get(start.priorSessionId);
      if (!prior) {
        throw consoleError("SESSION_UNKNOWN", "The session to resume does not exist");
      }
      if (prior.principalId !== input.principalId) {
        // The whole point of the resume path is that it can only ever reach
        // the same principal's own retained items.
        throw consoleError(
          "SESSION_SCOPE_DENIED",
          "A session may only be resumed by the principal that owned it",
        );
      }
      if (prior.state === "revoked") {
        throw consoleError("SESSION_REVOKED", "A revoked session cannot be resumed");
      }
      if (route.visibility !== "private") {
        throw consoleError(
          "ROUTE_DENIED",
          "Resume of a retained display window is a private-route policy",
          { routeAlias: route.alias },
        );
      }
      inherited = prior.display.filter(
        (item) => BigInt(item.displaySequence) > prior.ackThrough,
      );
      joinedAtOrdinal = prior.joinedAtOrdinal;
    }

    const record: SessionRecord = {
      sessionId: input.sessionId,
      principalId: input.principalId,
      routeAlias: route.alias,
      routeRevision: route.revision,
      displayStart: start,
      state: "active",
      queue: [],
      byOperation: new Map(),
      byClientMessage: new Map(),
      nextAcceptance: 1n,
      display: [],
      nextDisplaySequence: 1n,
      ackThrough: 0n,
      ackOperations: new Map(),
      terminal: new Map(),
      selfEchoBlockIds: new Set(),
      joinedAtOrdinal,
    };
    this.#sessions.set(input.sessionId, record);
    for (const item of inherited) {
      this.#appendOne(record, {
        blockId: item.blockId,
        deliveryIds: item.deliveryIds,
        source: item.source,
        createdAt: item.createdAt,
        presentation: item.presentation,
        preparationOrdinal: item.preparationOrdinal,
      });
    }
  }

  /**
   * Every read is authorized against the session's own principal. A caller
   * holding session B's identity cannot name session A here.
   */
  #requireSession(sessionId: string, principalId: string): SessionRecord {
    const session = this.#sessions.get(sessionId);
    if (!session) throw consoleError("SESSION_UNKNOWN", "Session does not exist");
    if (session.principalId !== principalId) {
      throw consoleError("SESSION_SCOPE_DENIED", "Session belongs to another principal");
    }
    if (session.state === "revoked") {
      throw consoleError("SESSION_REVOKED", "Session authority was revoked");
    }
    return session;
  }

  #requireActive(sessionId: string, principalId: string): SessionRecord {
    const session = this.#requireSession(sessionId, principalId);
    if (session.state !== "active") {
      throw consoleError("SESSION_UNKNOWN", "Session is no longer active");
    }
    return session;
  }

  routeOf(sessionId: string, principalId: string): ConsoleRoute {
    const session = this.#requireSession(sessionId, principalId);
    return this.#routes.get(routeKey(session.routeAlias, session.routeRevision))!;
  }

  /**
   * Accepts one validated external message into this session's queue.
   *
   * Attachments are resolved here, once, against the session that owns the
   * grant. That is the only place a `mediaId` enters Console state, so a
   * frozen snapshot is pure and a client can never name a Media directly.
   */
  acceptMessage(input: {
    readonly sessionId: string;
    readonly principalId: string;
    readonly message: ConsoleExternalMessage;
  }): ConsoleAcceptanceReceipt {
    const session = this.#requireActive(input.sessionId, input.principalId);
    const route = this.#routes.get(routeKey(session.routeAlias, session.routeRevision))!;
    if (input.message.routeAlias !== route.alias) {
      throw consoleError("ROUTE_DENIED", "Message names a route this session is not bound to", {
        routeAlias: input.message.routeAlias,
      });
    }

    const digest = externalMessageDigest(input.message);
    const existing =
      session.byOperation.get(input.message.operationId) ??
      session.byClientMessage.get(input.message.clientMessageId);
    if (existing) {
      if (existing.digest !== digest) {
        throw consoleError(
          "IDEMPOTENCY_CONFLICT",
          "Operation or client message identity was reused with different input",
        );
      }
      return existing.receipt;
    }
    if (session.queue.length >= this.#limits.maxQueuedMessagesPerSession) {
      throw consoleError("QUEUE_FULL", "Session message queue is full", {
        limit: this.#limits.maxQueuedMessagesPerSession,
      });
    }

    const media = input.message.attachments.map((attachment) => ({
      mediaId: resolveAttachmentMedia(this.#uploadGrants, {
        sessionId: session.sessionId,
        uploadGrantId: attachment.uploadGrantId,
      }),
    }));

    const acceptedAt = this.#now();
    const accepted = acceptedMessageRecord({
      externalMessageId: this.#nextId("external-message"),
      sessionId: session.sessionId,
      acceptanceSequence: decimal(session.nextAcceptance),
      acceptedAt,
      message: input.message,
      media,
      messageDigest: digest,
    });
    session.nextAcceptance += 1n;
    session.queue.push(accepted);

    const receipt: ConsoleAcceptanceReceipt = deepFreeze({
      externalMessageId: accepted.externalMessageId,
      acceptanceSequence: accepted.acceptanceSequence,
      disposition: "queued-volatile" as const,
      acceptedAt,
    });
    const stored: Receipt = { digest, receipt };
    session.byOperation.set(input.message.operationId, stored);
    session.byClientMessage.set(input.message.clientMessageId, stored);
    return receipt;
  }

  pendingMessages(sessionId: string, principalId: string): readonly ConsoleAcceptedMessage[] {
    return [...this.#requireSession(sessionId, principalId).queue];
  }

  /** Freezes the largest eligible prefix of this session's own queue. */
  freezeSnapshot(input: {
    readonly sessionId: string;
    readonly principalId: string;
    readonly limitRevision: string;
  }): ConsoleIngressSnapshot {
    const session = this.#requireSession(input.sessionId, input.principalId);
    return freezeIngressSnapshot({
      sessionId: session.sessionId,
      routeAlias: session.routeAlias,
      routeRevision: session.routeRevision,
      limitRevision: input.limitRevision,
      pending: session.queue,
      ...(this.#batchLimits === undefined ? {} : { limits: this.#batchLimits }),
    });
  }

  /**
   * Records the committed Block for a frozen snapshot and retires its queue
   * entries. The mapping stays in this session's record; it is never written
   * into Block content, so a later self-echo is reconciled from host state.
   */
  recordIngressCommit(input: {
    readonly sessionId: string;
    readonly principalId: string;
    readonly snapshot: ConsoleIngressSnapshot;
    readonly blockId: string;
  }): void {
    const session = this.#requireSession(input.sessionId, input.principalId);
    if (input.snapshot.sessionId !== session.sessionId) {
      throw consoleError("SESSION_SCOPE_DENIED", "Snapshot belongs to another session");
    }
    const committed = new Set(
      input.snapshot.messages.map((message) => message.externalMessageId),
    );
    let index = 0;
    while (index < session.queue.length) {
      const queued = session.queue[index]!;
      if (committed.has(queued.externalMessageId)) {
        session.terminal.set(queued.externalMessageId, "committed");
        session.queue.splice(index, 1);
        continue;
      }
      index += 1;
    }
    session.selfEchoBlockIds.add(input.blockId);
  }

  /**
   * Terminally fails one message and advances the frontier past it.
   *
   * Section 5.3 requires an individually oversized message to receive a
   * terminal result, release only its own resources, and leave the next valid
   * message eligible. Its idempotency receipts stay, so replaying the original
   * enqueue key returns the original receipt rather than re-arming the work.
   */
  terminallyFailMessage(input: {
    readonly sessionId: string;
    readonly principalId: string;
    readonly externalMessageId: string;
  }): void {
    const session = this.#requireSession(input.sessionId, input.principalId);
    const index = session.queue.findIndex(
      (queued) => queued.externalMessageId === input.externalMessageId,
    );
    if (index < 0) {
      throw consoleError("MESSAGE_INVALID", "No pending message with that identifier", {
        externalMessageId: input.externalMessageId,
      });
    }
    session.queue.splice(index, 1);
    session.terminal.set(input.externalMessageId, "failed");
  }

  messageStatus(input: {
    readonly sessionId: string;
    readonly principalId: string;
    readonly externalMessageId: string;
  }): "queued" | "committed" | "failed" | "unknown" {
    const session = this.#requireSession(input.sessionId, input.principalId);
    const terminal = session.terminal.get(input.externalMessageId);
    if (terminal) return terminal;
    return session.queue.some((queued) => queued.externalMessageId === input.externalMessageId)
      ? "queued"
      : "unknown";
  }

  /**
   * Reserves the next route-local preparation ordinal.
   *
   * The frontier moves at preparation time, not at activation. That is what
   * makes `from-now` exact: a session opened while a batch is still in
   * `prepared` state records a `joinedAtOrdinal` at or above that batch and can
   * never be handed it, which is the "a session joining later is not inserted"
   * rule of section 4.2. A retired preparation therefore leaves a gap in the
   * internal order and consumes no client sequence, as section 6.1 requires.
   */
  reservePreparationOrdinal(alias: string, revision: string): string {
    const key = routeKey(alias, revision);
    const next = (this.#routeFrontier.get(key) ?? 0n) + 1n;
    this.#routeFrontier.set(key, next);
    return decimal(next);
  }

  preparationFrontier(alias: string, revision: string): string {
    return decimal(this.#routeFrontier.get(routeKey(alias, revision)) ?? 0n);
  }

  /** Sessions currently eligible for a shared-route membership snapshot. */
  eligibleMembers(alias: string, revision: string): readonly string[] {
    const members: string[] = [];
    for (const session of this.#sessions.values()) {
      if (session.state !== "active") continue;
      if (session.routeAlias !== alias || session.routeRevision !== revision) continue;
      members.push(session.sessionId);
    }
    return members.sort();
  }

  #appendOne(
    session: SessionRecord,
    item: {
      readonly blockId: string;
      readonly deliveryIds: readonly string[];
      readonly source: SourceIdentity;
      readonly createdAt: string;
      readonly presentation: readonly ConsolePresentationItem[];
      readonly preparationOrdinal: string;
    },
  ): ConsoleDisplayItem {
    if (session.display.length >= this.#limits.maxRetainedDisplayItemsPerSession) {
      throw consoleError("BACKPRESSURE", "Unacknowledged display backlog is full", {
        sessionId: session.sessionId,
      });
    }
    const displayItem: ConsoleDisplayItem = deepFreeze({
      schemaVersion: DISPLAY_ITEM_SCHEMA,
      displaySequence: decimal(session.nextDisplaySequence),
      blockId: item.blockId,
      deliveryIds: [...item.deliveryIds],
      source: { kind: item.source.kind, id: item.source.id },
      createdAt: item.createdAt,
      presentation: item.presentation,
      // Section 6.3: deduplication is scoped to this session. Another session
      // seeing the same Block is a legitimate independent occurrence.
      selfEcho: session.selfEchoBlockIds.has(item.blockId),
      preparationOrdinal: item.preparationOrdinal,
    });
    session.nextDisplaySequence += 1n;
    session.display.push(displayItem);
    return displayItem;
  }

  /**
   * Activates one prepared display batch for one member. Sequences are
   * contiguous per session and are only assigned here, after the caller has
   * proven the Module job committed.
   */
  appendDisplayItems(input: {
    readonly sessionId: string;
    readonly preparationOrdinal: string;
    readonly items: readonly {
      readonly blockId: string;
      readonly deliveryIds: readonly string[];
      readonly source: SourceIdentity;
      readonly createdAt: string;
      readonly presentation: readonly ConsolePresentationItem[];
    }[];
  }): readonly ConsoleDisplayItem[] {
    const session = this.#sessions.get(input.sessionId);
    if (!session) throw consoleError("SESSION_UNKNOWN", "Session does not exist");
    if (session.state !== "active") {
      throw consoleError("SESSION_UNKNOWN", "Session is no longer active");
    }
    if (BigInt(input.preparationOrdinal) <= session.joinedAtOrdinal) {
      throw consoleError(
        "DISPLAY_START_REQUIRED",
        "This preparation predates the session's chosen display start",
        { sessionId: input.sessionId },
      );
    }
    return input.items.map((item) =>
      this.#appendOne(session, { ...item, preparationOrdinal: input.preparationOrdinal }),
    );
  }

  listDisplay(input: {
    readonly sessionId: string;
    readonly principalId: string;
    readonly afterSequence?: string;
  }): readonly ConsoleDisplayItem[] {
    const session = this.#requireSession(input.sessionId, input.principalId);
    const after =
      input.afterSequence === undefined ? 0n : parseDecimal(input.afterSequence, "afterSequence");
    return session.display.filter((item) => BigInt(item.displaySequence) > after);
  }

  displayCursor(sessionId: string, principalId: string): string {
    return decimal(this.#requireSession(sessionId, principalId).ackThrough);
  }

  /**
   * Contiguous display acknowledgement from section 6.5. Repeating the current
   * value is idempotent, a lower value is a no-op, and a future or never-issued
   * value fails visibly instead of creating a gap.
   */
  ackDisplay(input: {
    readonly sessionId: string;
    readonly principalId: string;
    readonly operationId: string;
    readonly ackThrough: string;
  }): { readonly ackThrough: string } {
    const session = this.#requireActive(input.sessionId, input.principalId);
    const requested = parseDecimal(input.ackThrough, "ackThrough");
    const replay = session.ackOperations.get(input.operationId);
    if (replay !== undefined) {
      if (replay !== input.ackThrough) {
        throw consoleError(
          "DISPLAY_ACK_INVALID",
          "Acknowledgement operation was reused with a different cursor",
        );
      }
      return { ackThrough: decimal(session.ackThrough) };
    }
    const highestIssued = session.nextDisplaySequence - 1n;
    if (requested > highestIssued) {
      throw consoleError("DISPLAY_ACK_INVALID", "Acknowledgement names an unissued sequence", {
        highestIssued: decimal(highestIssued),
      });
    }
    session.ackOperations.set(input.operationId, input.ackThrough);
    if (requested > session.ackThrough) {
      session.ackThrough = requested;
      // Fully covered items are released; nothing is retained globally.
      let index = 0;
      while (index < session.display.length) {
        if (BigInt(session.display[index]!.displaySequence) <= session.ackThrough) {
          session.display.splice(index, 1);
          continue;
        }
        index += 1;
      }
    }
    return { ackThrough: decimal(session.ackThrough) };
  }

  closeSession(sessionId: string, principalId: string): void {
    const session = this.#requireSession(sessionId, principalId);
    session.state = "closed";
  }

  /**
   * Revocation is an authority decision, so it is not principal-checked: the
   * host revokes, the principal does not. It terminally cancels queued work
   * and retires this session's display state only.
   */
  revokeSession(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) throw consoleError("SESSION_UNKNOWN", "Session does not exist");
    session.state = "revoked";
    session.queue.length = 0;
    session.display.length = 0;
  }

  sessionState(sessionId: string): ConsoleSessionState | null {
    return this.#sessions.get(sessionId)?.state ?? null;
  }
}
