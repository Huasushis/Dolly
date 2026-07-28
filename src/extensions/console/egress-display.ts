import type { Rect } from "../../core/block-content.js";
import { canonicalJsonDigest, deepFreeze } from "../../core/canonical-json.js";
import type { ReactiveModuleInput } from "../../core/reactive-module-input.js";
import { consoleError } from "./errors.js";
import {
  authorizeDeliveredMediaDisplay,
  deriveDeliveredMediaScope,
  type DeliveredMediaEntry,
} from "./media-contract.js";
import { presentBlock, type ConsolePresentationItem } from "./presentation.js";
import type { ConsoleDisplayItem, ConsoleSessionStore } from "./session-store.js";

/**
 * The egress sink role.
 *
 * Section 6.1 fixes three properties this module implements: a successful
 * egress execution returns no BlockProposal, the member list is frozen before
 * preparation and never recomputed, and prepared records stay invisible to
 * clients until the Module job outcome proves the result committed.
 */

export interface EgressPreparedBlock {
  readonly blockId: string;
  readonly deliveryIds: readonly string[];
  readonly occurrenceCount: number;
  readonly presentation: readonly ConsolePresentationItem[];
}

export interface EgressDisplayHandoffRecord {
  readonly schemaVersion: "dolly.console.display-handoff/1";
  readonly instanceId: string;
  readonly moduleJobId: string;
  readonly sessionId: string;
  readonly routeAlias: string;
  readonly routeRevision: string;
  readonly membershipSnapshotId: string;
  readonly preparationOrdinal: string;
  readonly inputDigest: string;
  readonly blocks: readonly EgressPreparedBlock[];
  readonly state: "prepared" | "activated" | "retired";
}

interface PreparationRecord {
  readonly instanceId: string;
  readonly moduleJobId: string;
  readonly routeAlias: string;
  readonly routeRevision: string;
  readonly inputDigest: string;
  readonly membershipSnapshotId: string;
  readonly membership: readonly string[];
  readonly preparationOrdinal: string;
  readonly blocks: readonly EgressPreparedBlock[];
  readonly mediaScope: ReadonlyMap<string, DeliveredMediaEntry>;
  readonly sourceByBlockId: ReadonlyMap<string, { kind: "module" | "external" | "system"; id: string }>;
  readonly createdAtByBlockId: ReadonlyMap<string, string>;
  state: "prepared" | "activated" | "retired";
}

function preparationKey(instanceId: string, moduleJobId: string): string {
  return `${instanceId} ${moduleJobId}`;
}

/**
 * Rejects any output from an egress execution.
 *
 * The role validator runs before acknowledgement, so an accidental input/output
 * Page overlap cannot create output recursion: the proposal is refused, not
 * silently dropped.
 */
export function assertEgressResultHasNoProposal(result: unknown): void {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw consoleError("RESULT_INVALID", "Egress result must be an object");
  }
  const record = result as Record<string, unknown>;
  for (const forbidden of ["proposal", "blockProposal", "moduleDescription", "retentionChanges"]) {
    if (record[forbidden] !== undefined) {
      throw consoleError("RESULT_INVALID", "Egress role must return no Block output", {
        field: forbidden,
      });
    }
  }
}

export interface PrepareDisplayInput {
  readonly instanceId: string;
  readonly moduleJobId: string;
  readonly routeAlias: string;
  readonly routeRevision: string;
  readonly input: ReactiveModuleInput;
  /**
   * A lossy route may record a terminal `not-presented` outcome instead of
   * failing when no member is eligible. It must be configured, never inferred.
   */
  readonly lossy?: boolean;
}

export type PrepareDisplayOutcome =
  | { readonly kind: "prepared"; readonly records: readonly EgressDisplayHandoffRecord[] }
  | { readonly kind: "not-presented"; readonly reason: "no-eligible-member" };

export class ConsoleEgressCoordinator {
  readonly #store: ConsoleSessionStore;
  readonly #preparations = new Map<string, PreparationRecord>();
  readonly #nextMembershipId: () => string;

  constructor(options: {
    readonly store: ConsoleSessionStore;
    readonly nextMembershipSnapshotId: () => string;
  }) {
    this.#store = options.store;
    this.#nextMembershipId = options.nextMembershipSnapshotId;
  }

  /**
   * Prepares one immutable display handoff record per frozen member.
   *
   * A retry of the same Module job reuses the same membership snapshot and the
   * same preparation ordinal, so a session that joined in between is not
   * inserted. A different input digest under the same Module job is a visible
   * conflict rather than a silent re-preparation.
   */
  prepare(input: PrepareDisplayInput): PrepareDisplayOutcome {
    const key = preparationKey(input.instanceId, input.moduleJobId);
    const inputDigest = canonicalJsonDigest(input.input);
    const existing = this.#preparations.get(key);
    if (existing) {
      if (
        existing.inputDigest !== inputDigest ||
        existing.routeAlias !== input.routeAlias ||
        existing.routeRevision !== input.routeRevision
      ) {
        throw consoleError(
          "DISPLAY_PREPARATION_CONFLICT",
          "This Module job was already prepared with a different input or route",
          { moduleJobId: input.moduleJobId },
        );
      }
      if (existing.state === "retired") {
        throw consoleError(
          "DISPLAY_PREPARATION_CONFLICT",
          "This Module job's preparation was already retired",
          { moduleJobId: input.moduleJobId },
        );
      }
      return { kind: "prepared", records: this.#records(existing) };
    }

    const membership = this.#store.eligibleMembers(input.routeAlias, input.routeRevision);
    if (membership.length === 0) {
      if (input.lossy === true) return { kind: "not-presented", reason: "no-eligible-member" };
      throw consoleError("BACKPRESSURE", "No eligible route member can receive this batch", {
        routeAlias: input.routeAlias,
      });
    }

    const groups = input.input.blockGroups.map((group) => ({
      block: group.block,
      deliveryIds: group.deliveryIds,
    }));
    const blocks: EgressPreparedBlock[] = input.input.blockGroups.map((group) => ({
      blockId: group.block.id,
      deliveryIds: [...group.deliveryIds],
      occurrenceCount: group.occurrenceCount,
      presentation: presentBlock(group.block),
    }));

    const record: PreparationRecord = {
      instanceId: input.instanceId,
      moduleJobId: input.moduleJobId,
      routeAlias: input.routeAlias,
      routeRevision: input.routeRevision,
      inputDigest,
      membershipSnapshotId: this.#nextMembershipId(),
      membership: [...membership],
      preparationOrdinal: this.#store.reservePreparationOrdinal(
        input.routeAlias,
        input.routeRevision,
      ),
      blocks,
      mediaScope: deriveDeliveredMediaScope(groups),
      sourceByBlockId: new Map(
        input.input.blockGroups.map((group) => [
          group.block.id,
          { kind: group.block.source.kind, id: group.block.source.id },
        ]),
      ),
      createdAtByBlockId: new Map(
        input.input.blockGroups.map((group) => [group.block.id, group.block.createdAt]),
      ),
      state: "prepared",
    };
    this.#preparations.set(key, record);
    return { kind: "prepared", records: this.#records(record) };
  }

  #records(record: PreparationRecord): readonly EgressDisplayHandoffRecord[] {
    return record.membership.map((sessionId) =>
      deepFreeze({
        schemaVersion: "dolly.console.display-handoff/1" as const,
        instanceId: record.instanceId,
        moduleJobId: record.moduleJobId,
        sessionId,
        routeAlias: record.routeAlias,
        routeRevision: record.routeRevision,
        membershipSnapshotId: record.membershipSnapshotId,
        preparationOrdinal: record.preparationOrdinal,
        inputDigest: record.inputDigest,
        blocks: record.blocks,
        state: record.state,
      }),
    );
  }

  #requirePreparation(instanceId: string, moduleJobId: string): PreparationRecord {
    const record = this.#preparations.get(preparationKey(instanceId, moduleJobId));
    if (!record) {
      throw consoleError("DISPLAY_PREPARATION_CONFLICT", "No preparation exists for this Module job", {
        moduleJobId,
      });
    }
    return record;
  }

  /**
   * Activates every prepared record after the Module job outcome proved the
   * exact no-Block result committed. Activation is idempotent: replaying it
   * returns the sequences already assigned rather than appending twice.
   */
  activate(input: {
    readonly instanceId: string;
    readonly moduleJobId: string;
  }): ReadonlyMap<string, readonly ConsoleDisplayItem[]> {
    const record = this.#requirePreparation(input.instanceId, input.moduleJobId);
    if (record.state === "retired") {
      throw consoleError("DISPLAY_PREPARATION_CONFLICT", "A retired preparation cannot activate", {
        moduleJobId: input.moduleJobId,
      });
    }
    const activated = new Map<string, readonly ConsoleDisplayItem[]>();
    if (record.state === "activated") return activated;

    for (const sessionId of record.membership) {
      const items = this.#store.appendDisplayItems({
        sessionId,
        preparationOrdinal: record.preparationOrdinal,
        items: record.blocks.map((block) => ({
          blockId: block.blockId,
          deliveryIds: block.deliveryIds,
          source: record.sourceByBlockId.get(block.blockId)!,
          createdAt: record.createdAtByBlockId.get(block.blockId)!,
          presentation: block.presentation,
        })),
      });
      activated.set(sessionId, items);
    }
    record.state = "activated";
    return activated;
  }

  /** Terminal non-commit disposition: prepared records never become visible. */
  retire(input: { readonly instanceId: string; readonly moduleJobId: string }): void {
    const record = this.#requirePreparation(input.instanceId, input.moduleJobId);
    if (record.state === "activated") {
      throw consoleError(
        "DISPLAY_PREPARATION_CONFLICT",
        "An activated preparation cannot be retired",
        { moduleJobId: input.moduleJobId },
      );
    }
    record.state = "retired";
  }

  /**
   * The only way this extension may reach Media bytes for display.
   *
   * The identifier is checked against the scope derived from the Blocks the
   * host actually delivered to this Module job. A guessed identifier, one that
   * only appeared in text, and one from another Module job all fail here.
   */
  authorizeMediaDisplay(input: {
    readonly instanceId: string;
    readonly moduleJobId: string;
    readonly sessionId: string;
    readonly mediaId: string;
    readonly crop?: Rect;
  }): DeliveredMediaEntry {
    const record = this.#requirePreparation(input.instanceId, input.moduleJobId);
    if (!record.membership.includes(input.sessionId)) {
      throw consoleError("SESSION_SCOPE_DENIED", "Session is not a frozen member of this batch", {
        moduleJobId: input.moduleJobId,
      });
    }
    return authorizeDeliveredMediaDisplay(record.mediaScope, {
      mediaId: input.mediaId,
      ...(input.crop === undefined ? {} : { crop: input.crop }),
    });
  }
}
