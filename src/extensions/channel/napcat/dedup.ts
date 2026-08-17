/**
 * Account-scoped inbound event deduplication.
 *
 * OneBot events carry no universal durable event ID or replay token, so a
 * reconnect can re-deliver the same event. napcatqq.md §5 requires message IDs
 * to deduplicate within the account; this registry key is the account-scoped
 * external message ID only. Registration is bounded by a fixed capacity and
 * evicts the oldest entry first, so memory cannot grow without limit.
 */

export interface InboundEventKey {
  readonly account: string;
  readonly external_message_id: string;
}

export type InboundRegistration =
  | { readonly kind: "new"; readonly key: InboundEventKey }
  | { readonly kind: "duplicate"; readonly key: InboundEventKey };

export class InboundDedupRegistry {
  readonly #capacity: number;
  #seen = new Map<string, true>();

  constructor(capacity = 100_000) {
    this.#capacity = capacity;
  }

  /** Registers the event key, returning duplicate when it was already known. */
  register(key: InboundEventKey): InboundRegistration {
    const composite = `${key.account}\0${key.external_message_id}`;
    if (this.#seen.has(composite)) {
      return { kind: "duplicate", key };
    }
    this.#seen.set(composite, true);
    if (this.#seen.size > this.#capacity) {
      const oldest = this.#seen.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    return { kind: "new", key };
  }
}
