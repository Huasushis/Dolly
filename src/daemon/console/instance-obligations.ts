/**
 * The runtime obligations a topology change plan is computed against.
 *
 * `instance-topology.md` Section 7.2 requires the plan to state the concrete
 * obligations involved — pending Delivery counts, active Claims, dead-letter
 * records, and the Module generations that will restart — and Section 10.4
 * requires the plan to say whether it was computed against live runtime state
 * or persisted state. Those obligations live inside one instance's Core, which
 * the daemon reaches through no implemented interprocess channel today, so this
 * module defines the port the planner depends on and one adapter over the
 * `DeliveryStore` snapshot that a co-hosted Core already produces.
 *
 * Nothing here decides anything. It only reports evidence.
 */

import { deepFreeze } from "../../core/canonical-json.js";
import type { DeliveryStoreSnapshot } from "../../core/delivery-store.js";

/** What one consumer still owes on one Page. */
export interface PageConsumerObligation {
  readonly pageId: string;
  readonly consumerId: string;
  readonly pendingDeliveries: number;
  readonly pendingBytes: number;
  readonly claimedDeliveries: number;
  readonly deadLetterRecords: number;
}

export interface ModuleRuntimeObligation {
  readonly moduleId: string;
  readonly consumerId: string;
  /** Claim tokens the Module currently holds, whatever their outcome. */
  readonly activeClaimTokens: readonly string[];
  /** The subset preserved as unknown outcomes under Section 13.1. */
  readonly unknownOutcomeClaimTokens: readonly string[];
  /** Pages covered by a Delivery inside one of those Claims. */
  readonly claimedPageIds: readonly string[];
  /**
   * False while the Module's current generation has not been proven
   * terminated, which forbids starting a replacement generation.
   */
  readonly generationTerminationProven: boolean;
}

export interface PageRetentionFrontier {
  readonly pageId: string;
  /** Delivery identifiers the Page still retains, oldest first. */
  readonly retainedDeliveryIds: readonly string[];
  /** What a `from-head` subscription would make immediately pending. */
  readonly replayableDeliveries: number;
  readonly replayableBytes: number;
}

/** A Module whose Page set is owned by a higher-level contract, Section 4.4. */
export interface ContractOwnedModule {
  readonly moduleId: string;
  readonly owningContract: string;
  readonly operation: string;
}

export interface InstanceObligations {
  /**
   * `live-runtime` when a running instance answered, `persisted-state` when the
   * evidence came from durable state of a stopped instance. Section 10.4
   * requires the plan to say which, because a Page that looks drainable offline
   * may still have obligations that startup recovery reveals.
   */
  readonly evidenceSource: "live-runtime" | "persisted-state";
  readonly pages: readonly PageRetentionFrontier[];
  readonly pageConsumers: readonly PageConsumerObligation[];
  readonly modules: readonly ModuleRuntimeObligation[];
  readonly contractOwnedModules: readonly ContractOwnedModule[];
  /**
   * Section 7.14: while Module execution is disabled, every plan entry that
   * would start or restart a Module generation is `rejected` with the disabled
   * capability named.
   */
  readonly moduleExecutionEnabled: boolean;
}

export interface InstanceObligationSource {
  readObligations(instanceId: string): Promise<InstanceObligations>;
}

const EMPTY: InstanceObligations = deepFreeze({
  evidenceSource: "persisted-state",
  pages: [],
  pageConsumers: [],
  modules: [],
  contractOwnedModules: [],
  moduleExecutionEnabled: false,
}) as InstanceObligations;

/**
 * Obligations for an instance that has no durable Delivery state at all. This
 * is the honest answer only when the caller has proven the state directory
 * holds nothing; it is never a substitute for evidence a caller could not
 * obtain.
 */
export function noRecordedObligations(
  overrides: Partial<InstanceObligations> = {},
): InstanceObligations {
  return deepFreeze({ ...EMPTY, ...overrides }) as InstanceObligations;
}

export interface DeliveryStoreObligationOptions {
  readonly evidenceSource: InstanceObligations["evidenceSource"];
  /**
   * Maps a configured `moduleId` onto the `consumerId` its subscriptions use.
   * Core does not yet host Modules, so no fixed derivation exists in the
   * repository; the caller states the mapping rather than this adapter guessing
   * one.
   */
  readonly consumerIdForModule: (moduleId: string) => string;
  readonly moduleIds: readonly string[];
  /** Claim tokens Core preserved as unknown outcomes, Section 13.1. */
  readonly unknownOutcomeClaimTokens?: readonly string[];
  /** Module identifiers whose current generation is proven terminated. */
  readonly provenTerminatedModuleIds?: readonly string[];
  readonly contractOwnedModules?: readonly ContractOwnedModule[];
  readonly moduleExecutionEnabled?: boolean;
}

/**
 * Derives obligations from one `DeliveryStore` snapshot. Every count comes from
 * a recorded obligation, never from an absence that could equally mean the
 * evidence was not read.
 */
export function deliveryStoreObligations(
  snapshot: DeliveryStoreSnapshot,
  options: DeliveryStoreObligationOptions,
): InstanceObligations {
  const unknownOutcome = new Set(options.unknownOutcomeClaimTokens ?? []);
  const proven = new Set(options.provenTerminatedModuleIds ?? []);

  const pages = snapshot.pages.map((page): PageRetentionFrontier => {
    const retained = page.deliveryIds;
    const states = retained
      .map((deliveryId) => snapshot.deliveries.find((entry) => entry.record.deliveryId === deliveryId))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    return {
      pageId: page.id,
      retainedDeliveryIds: [...retained],
      replayableDeliveries: states.length,
      replayableBytes: states.reduce((total, entry) => total + byteLength(entry.record), 0),
    };
  });

  const consumerCounts = new Map<string, {
    pendingDeliveries: number;
    pendingBytes: number;
    claimedDeliveries: number;
    deadLetterRecords: number;
  }>();
  const key = (pageId: string, consumerId: string): string => `${pageId}\0${consumerId}`;
  const bucket = (pageId: string, consumerId: string) => {
    const existing = consumerCounts.get(key(pageId, consumerId));
    if (existing) return existing;
    const created = {
      pendingDeliveries: 0,
      pendingBytes: 0,
      claimedDeliveries: 0,
      deadLetterRecords: 0,
    };
    consumerCounts.set(key(pageId, consumerId), created);
    return created;
  };

  for (const delivery of snapshot.deliveries) {
    for (const obligation of delivery.obligations) {
      const counts = bucket(delivery.record.pageId, obligation.consumerId);
      if (obligation.status === "pending") {
        counts.pendingDeliveries += 1;
        counts.pendingBytes += byteLength(delivery.record);
      } else if (obligation.status === "claimed") {
        counts.claimedDeliveries += 1;
      } else if (obligation.status === "dead-lettered") {
        counts.deadLetterRecords += 1;
      }
    }
  }

  const claimByToken = new Map(snapshot.claims.map((claim) => [claim.claimToken, claim]));
  const jobById = new Map(snapshot.moduleJobs.map((job) => [job.moduleJobId, job]));

  const modules = options.moduleIds.map((moduleId): ModuleRuntimeObligation => {
    const consumerId = options.consumerIdForModule(moduleId);
    const activeClaimTokens: string[] = [];
    const claimedPageIds = new Set<string>();
    for (const claim of snapshot.claims) {
      if (claim.status !== "active") continue;
      const job = jobById.get(claim.moduleJobId);
      if (!job || job.consumerId !== consumerId) continue;
      activeClaimTokens.push(claim.claimToken);
      for (const pageId of job.pageIds) claimedPageIds.add(pageId);
    }
    return {
      moduleId,
      consumerId,
      activeClaimTokens: activeClaimTokens.sort(),
      unknownOutcomeClaimTokens: activeClaimTokens
        .filter((token) => unknownOutcome.has(token) && claimByToken.has(token))
        .sort(),
      claimedPageIds: [...claimedPageIds].sort(),
      generationTerminationProven: proven.has(moduleId),
    };
  });

  const pageConsumers: PageConsumerObligation[] = [];
  for (const [composite, counts] of consumerCounts) {
    const [pageId, consumerId] = composite.split("\0") as [string, string];
    pageConsumers.push({ pageId, consumerId, ...counts });
  }
  pageConsumers.sort((left, right) =>
    left.pageId === right.pageId
      ? left.consumerId < right.consumerId
        ? -1
        : left.consumerId > right.consumerId
          ? 1
          : 0
      : left.pageId < right.pageId
        ? -1
        : 1,
  );

  return deepFreeze({
    evidenceSource: options.evidenceSource,
    pages,
    pageConsumers,
    modules,
    contractOwnedModules: [...(options.contractOwnedModules ?? [])],
    moduleExecutionEnabled: options.moduleExecutionEnabled ?? false,
  }) as InstanceObligations;
}

function byteLength(record: { readonly blockId: string; readonly deliveryId: string }): number {
  // The snapshot records identity, not payload size. Counting the recorded
  // identifiers keeps the reported figure derived from real state instead of an
  // invented constant; a Core that later exposes payload bytes replaces this.
  return Buffer.byteLength(record.blockId, "utf8") + Buffer.byteLength(record.deliveryId, "utf8");
}

/** Total obligations one Page still carries across every consumer. */
export function pageObligationTotals(
  obligations: InstanceObligations,
  pageId: string,
): { pendingDeliveries: number; claimedDeliveries: number; deadLetterRecords: number } {
  let pendingDeliveries = 0;
  let claimedDeliveries = 0;
  let deadLetterRecords = 0;
  for (const entry of obligations.pageConsumers) {
    if (entry.pageId !== pageId) continue;
    pendingDeliveries += entry.pendingDeliveries;
    claimedDeliveries += entry.claimedDeliveries;
    deadLetterRecords += entry.deadLetterRecords;
  }
  return { pendingDeliveries, claimedDeliveries, deadLetterRecords };
}
