/**
 * Outbound idempotency registry keyed by `action_id`.
 *
 * channel.md §6 makes `action_id` the outbound idempotency key. A replay of an
 * already-dispatched action returns the prior outcome instead of re-dispatching,
 * so an unknown send is never blindly repeated and a confirmed send is never
 * sent twice. Each record stores only the compact outcome class, never payload,
 * tokens, or transport identifiers.
 */

export type PriorDispatch = "accepted" | "unknown" | "cancelled";

export class OutboundIdempotency {
  readonly #capacity: number;
  #records = new Map<string, PriorDispatch>();

  constructor(capacity = 10_000) {
    this.#capacity = capacity;
  }

  prior(actionId: string): PriorDispatch | null {
    return this.#records.get(actionId) ?? null;
  }

  record(actionId: string, outcome: PriorDispatch): void {
    if (this.#records.has(actionId)) return;
    this.#records.set(actionId, outcome);
    if (this.#records.size > this.#capacity) {
      const oldest = this.#records.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#records.delete(oldest);
    }
  }
}
