/**
 * Content-item `schema` names that Core reserves for one authorized producer.
 *
 * `console-extension.md` Section 15.1 item 8 requires
 * `dolly.console.message-boundary/1` to be produced only by the Console
 * ingress publisher. The message stream those boundaries structure is fed to a
 * language model, so any Extension able to emit one can inject conversation
 * structure that the model will read as the host's own framing. That makes the
 * check a Core obligation: an Extension asked to police itself has already been
 * given the authority the rule exists to withhold.
 *
 * This module is deliberately **not** a schema registry. The reserved-name list
 * below is a closed constant compiled into Core; nothing can register a new
 * reserved name, claim one at runtime, or supply its own validator. The general
 * registry — publisher authorization, pinned validator digests, and reserved
 * name collisions failing before Module start — is a separate, larger
 * contract. A candidate immutable registration set and Block commit check now
 * exist, but no package manifest or startup builder supplies their provenance;
 * they are not a product replacement for this interim policy yet.
 *
 * The policy is fail-closed. A deployment that names no producer for a reserved
 * schema authorizes nobody, so forgetting to configure the grant denies the
 * name to everyone rather than opening it to everyone.
 */

import type { BlockContentItem } from "./block-content.js";

/** The Console ingress message boundary, the only reserved name today. */
export const CONSOLE_MESSAGE_BOUNDARY_SCHEMA = "dolly.console.message-boundary/1";

/**
 * Every reserved content-item schema name. Closed on purpose: a name that is
 * not listed here is ordinary Extension data and is never restricted.
 */
export const RESERVED_CONTENT_SCHEMAS: readonly string[] = Object.freeze([
  CONSOLE_MESSAGE_BOUNDARY_SCHEMA,
]);

/**
 * The structural shape of a Block source. Declared here rather than imported so
 * that `block-store.ts` can depend on this module without a cycle;
 * `SourceIdentity` satisfies it.
 */
export interface ContentProducerIdentity {
  readonly kind: string;
  readonly id: string;
}

export interface ReservedContentSchemaGrant {
  readonly schema: string;
  readonly producer: ContentProducerIdentity;
}

export interface ReservedContentSchemaViolation {
  readonly schema: string;
  readonly itemIndex: number;
}

function assertProducer(value: unknown): ContentProducerIdentity {
  if (value === null || typeof value !== "object") {
    throw new TypeError("A reserved content schema grant requires a producer identity");
  }
  const producer = value as { kind?: unknown; id?: unknown };
  if (
    typeof producer.kind !== "string" ||
    producer.kind.length === 0 ||
    typeof producer.id !== "string" ||
    producer.id.length === 0
  ) {
    throw new TypeError("A reserved content schema producer needs a non-empty kind and id");
  }
  return { kind: producer.kind, id: producer.id };
}

/**
 * The set of reserved-name grants a deployment has made. Constructed once and
 * handed to `BlockStore`; it holds no mutable state and authorizes nothing it
 * was not explicitly given.
 */
export class ReservedContentSchemaPolicy {
  readonly #producers: ReadonlyMap<string, ContentProducerIdentity>;

  constructor(grants: readonly ReservedContentSchemaGrant[] = []) {
    const producers = new Map<string, ContentProducerIdentity>();
    for (const grant of grants) {
      if (!RESERVED_CONTENT_SCHEMAS.includes(grant.schema)) {
        // Granting a name Core does not reserve would be the first half of a
        // registry, and it would silently do nothing.
        throw new TypeError(
          `${grant.schema} is not a reserved content schema, so it cannot be granted a producer`,
        );
      }
      if (producers.has(grant.schema)) {
        throw new TypeError(`Reserved content schema ${grant.schema} was granted twice`);
      }
      producers.set(grant.schema, assertProducer(grant.producer));
    }
    this.#producers = producers;
  }

  isReserved(schema: string): boolean {
    return RESERVED_CONTENT_SCHEMAS.includes(schema);
  }

  /** True only for the exact producer identity this schema was granted to. */
  authorizes(schema: string, source: ContentProducerIdentity): boolean {
    const producer = this.#producers.get(schema);
    if (producer === undefined) return false;
    return producer.kind === source.kind && producer.id === source.id;
  }
}

/**
 * Reports the first content item whose reserved schema `source` may not emit,
 * or `null` when every item is permitted.
 *
 * An absent policy authorizes nothing, so the caller does not have to decide
 * what an unconfigured deployment means.
 */
export function findReservedSchemaViolation(
  items: readonly BlockContentItem[],
  source: ContentProducerIdentity,
  policy?: ReservedContentSchemaPolicy,
): ReservedContentSchemaViolation | null {
  for (const [itemIndex, item] of items.entries()) {
    if (item.type !== "data") continue;
    if (!RESERVED_CONTENT_SCHEMAS.includes(item.schema)) continue;
    if (policy?.authorizes(item.schema, source) === true) continue;
    return { schema: item.schema, itemIndex };
  }
  return null;
}
