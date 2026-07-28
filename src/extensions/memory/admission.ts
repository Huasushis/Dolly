import { createHash } from "node:crypto";
import { canonicalJsonDigest, deepFreeze } from "../../core/canonical-json.js";
import { memoryError } from "./errors.js";
import type { FeaturePlan } from "./feature-plan.js";
import { MEMORY_CONTROL_SCHEMAS, type MemorySourceBlock } from "./extraction.js";
import type {
  MemoryNamespace,
  RuntimeDeliveryContext,
  RuntimeMemoryIdentity,
} from "./namespace.js";
import { createOccurrenceRecord, type OccurrenceRecord } from "./records.js";
import type { AdmissionRecord, FeatureJobRecord, PlannedFeature } from "./store.js";

/**
 * The serialized half of indexing: `docs/spec/memory-extension.md` §5.5, §6.1
 * step 5, and §7.
 *
 * Preparation is pure and deterministic. It decides what may be indexed, what
 * is excluded, which durable jobs are needed, and which strong references the
 * Module result must request. It performs no extraction, no embedding, no
 * provider call, and no I/O, because §3 invariant 4 puts that work in the
 * registered background service.
 */

export type AdmissionExclusionReason =
  /** §7 The Block came from this Memory Module instance. */
  | "SELF_OUTPUT"
  /** §7 Every eligible item was a Memory query or recall control value. */
  | "MEMORY_CONTROL_ONLY"
  /** §8.1 No allowlisted extractor accepts the payload schema. */
  | "PAYLOAD_SCHEMA_NOT_ALLOWLISTED"
  /** §12.2 The lineage is tombstoned; the occurrence is terminal. */
  | "TOMBSTONED";

export interface DeliveredInput {
  readonly delivery: RuntimeDeliveryContext;
  readonly block: MemorySourceBlock;
}

export interface ModuleRetentionChange {
  readonly operation: "add" | "remove";
  readonly ownerKind: "module";
  readonly retentionKey: string;
  readonly targetBlockId: string;
}

export interface AdmissionExclusion {
  readonly deliveryId: string;
  readonly sourceBlockId: string;
  readonly reason: AdmissionExclusionReason;
}

export interface AdmissionPreparation {
  readonly admission: AdmissionRecord;
  readonly occurrences: readonly OccurrenceRecord[];
  readonly jobs: readonly FeatureJobRecord[];
  readonly retentionChanges: readonly ModuleRetentionChange[];
  readonly excluded: readonly AdmissionExclusion[];
}

/** The lineage a tombstone targets: one source Block and everything from it. */
export function sourceLineageKey(sourceBlockId: string): string {
  return `block:${sourceBlockId}`;
}

export function deriveAdmissionId(options: {
  readonly namespace: MemoryNamespace;
  readonly moduleJobId: string;
  readonly deliveryIds: readonly string[];
  readonly featurePlanDigest: string;
  readonly deletionEpoch: number;
}): string {
  return canonicalJsonDigest({
    domain: "dolly.memory-admission/1",
    namespaceKey: options.namespace.namespaceKey,
    moduleJobId: options.moduleJobId,
    deliveryIds: [...options.deliveryIds].sort(),
    featurePlanDigest: options.featurePlanDigest,
    deletionEpoch: options.deletionEpoch,
  });
}

/**
 * §5.5: the FeatureJob is cross-Delivery work keyed by the source Block, the
 * feature plan, and the deletion epoch. It deliberately does not include the
 * Module job or the Delivery, which is exactly why two Deliveries of one Block
 * converge on one job and one committed feature set.
 */
export function deriveFeatureJobId(options: {
  readonly namespace: MemoryNamespace;
  readonly sourceBlockId: string;
  readonly featurePlanDigest: string;
  readonly deletionEpoch: number;
}): string {
  return canonicalJsonDigest({
    domain: "dolly.memory-feature-job/1",
    namespaceKey: options.namespace.namespaceKey,
    sourceBlockId: options.sourceBlockId,
    featurePlanDigest: options.featurePlanDigest,
    deletionEpoch: options.deletionEpoch,
  });
}

export function deriveRetentionKey(admissionId: string, sourceBlockId: string): string {
  return createHash("sha256")
    .update("dolly.memory-retention-key/1", "utf8")
    .update(" ", "utf8")
    .update(admissionId, "utf8")
    .update(" ", "utf8")
    .update(sourceBlockId, "utf8")
    .digest("hex");
}

function plannedFeatures(plan: FeaturePlan): readonly PlannedFeature[] {
  const features: PlannedFeature[] = [{ kind: "lexical", modality: "text" }];
  if (plan.textEmbedding) features.push({ kind: "native-embedding", modality: "text" });
  if (features.length > plan.maxFeaturesPerRecord) {
    throw memoryError("MEMORY_LIMIT_EXCEEDED", "Planned feature set exceeds its limit", {
      limit: "maxFeaturesPerRecord",
      allowed: plan.maxFeaturesPerRecord,
    });
  }
  return features;
}

/**
 * Decides whether one Delivery may be indexed.
 *
 * The producing Module comes from core-authenticated Delivery metadata, never
 * from a payload field, so a Block cannot claim not to be self-output. §7 also
 * excludes every Memory query and recall control item; when a Block carries
 * nothing else, it produces a terminal occurrence and no job.
 */
function classify(
  input: DeliveredInput,
  namespace: MemoryNamespace,
  plan: FeaturePlan,
  acceptedPayloadSchemas: readonly string[],
  tombstonedLineages: ReadonlySet<string>,
): AdmissionExclusionReason | undefined {
  if (input.delivery.sourceModuleInstanceId === namespace.memoryModuleInstanceId) {
    return "SELF_OUTPUT";
  }
  if (tombstonedLineages.has(sourceLineageKey(input.delivery.sourceBlockId))) {
    return "TOMBSTONED";
  }
  if (!acceptedPayloadSchemas.includes(input.block.payloadSchema)) {
    return "PAYLOAD_SCHEMA_NOT_ALLOWLISTED";
  }
  const items = input.block.content.items;
  const eligible = items.some((item) => {
    if (item.type === "text") return true;
    if (item.type === "media-reference") {
      return plan.mediaPolicies.some((entry) => entry.policy.kind !== "skip");
    }
    return false;
  });
  const onlyControl =
    !eligible &&
    items.length > 0 &&
    items.every((item) => item.type === "data" && MEMORY_CONTROL_SCHEMAS.includes(item.schema));
  if (onlyControl) return "MEMORY_CONTROL_ONLY";
  if (!eligible) return "MEMORY_CONTROL_ONLY";
  return undefined;
}

export function prepareAdmission(options: {
  readonly namespace: MemoryNamespace;
  /**
   * The authenticated identity. §4.1 requires every record to store its
   * originating session even when the retention scope is `owner-long-term`,
   * where the session is not a namespace component.
   */
  readonly identity: RuntimeMemoryIdentity;
  readonly moduleJobId: string;
  readonly moduleGeneration: number;
  readonly inputs: readonly DeliveredInput[];
  readonly plan: FeaturePlan;
  readonly featurePlanDigest: string;
  readonly acceptedPayloadSchemas: readonly string[];
  readonly deletionEpoch: number;
  readonly tombstonedLineages?: ReadonlySet<string>;
  readonly maxAttempts: number;
  /**
   * The canonical digest of the immutable Module result. §5.5 binds the
   * admission to it so a result the Core rejected can never activate work.
   */
  readonly expectedResultDigest: string;
}): AdmissionPreparation {
  const tombstoned = options.tombstonedLineages ?? new Set<string>();
  const excludedInputs: { input: DeliveredInput; reason: AdmissionExclusionReason }[] = [];
  const admitted: DeliveredInput[] = [];
  for (const input of options.inputs) {
    const reason = classify(
      input,
      options.namespace,
      options.plan,
      options.acceptedPayloadSchemas,
      tombstoned,
    );
    if (reason) {
      excludedInputs.push({ input, reason });
      continue;
    }
    admitted.push(input);
  }
  const excluded: AdmissionExclusion[] = excludedInputs.map(({ input, reason }) => ({
    deliveryId: input.delivery.deliveryId,
    sourceBlockId: input.delivery.sourceBlockId,
    reason,
  }));

  const admissionId = deriveAdmissionId({
    namespace: options.namespace,
    moduleJobId: options.moduleJobId,
    deliveryIds: admitted.map((input) => input.delivery.deliveryId),
    featurePlanDigest: options.featurePlanDigest,
    deletionEpoch: options.deletionEpoch,
  });

  const jobsById = new Map<string, FeatureJobRecord>();
  const occurrences: OccurrenceRecord[] = [];
  const retentionChanges: ModuleRetentionChange[] = [];
  const retentionTargets = new Map<string, string>();

  for (const input of admitted) {
    const featureJobId = deriveFeatureJobId({
      namespace: options.namespace,
      sourceBlockId: input.delivery.sourceBlockId,
      featurePlanDigest: options.featurePlanDigest,
      deletionEpoch: options.deletionEpoch,
    });
    if (!jobsById.has(featureJobId)) {
      jobsById.set(featureJobId, {
        featureJobId,
        namespaceKey: options.namespace.namespaceKey,
        sourceBlockId: input.delivery.sourceBlockId,
        coreSequence: input.delivery.coreSequence,
        sourcePageId: input.delivery.inputPageId,
        originatingSessionId: options.identity.sessionId,
        payloadSchema: input.block.payloadSchema,
        creationModuleJobId: options.moduleJobId,
        featurePlanDigest: options.featurePlanDigest,
        deletionEpoch: options.deletionEpoch,
        plannedFeatures: plannedFeatures(options.plan),
        requiredByAdmissionIds: [admissionId],
        state: "pending",
        attempt: 0,
        maxAttempts: options.maxAttempts,
      });
    }
    occurrences.push(
      createOccurrenceRecord({
        namespace: options.namespace,
        deliveryId: input.delivery.deliveryId,
        sourceBlockId: input.delivery.sourceBlockId,
        sourcePageId: input.delivery.inputPageId,
        pageSequence: input.delivery.pageSequence,
        recordIds: [],
        featureJobId,
        state: "recorded",
        deletionEpoch: options.deletionEpoch,
        terminal: false,
      }),
    );
    // §11.2: one distinct stable retention key per source target, owned by the
    // admission. The Core commits it with the Module job result, so an
    // acknowledged Delivery can never be left without a source strong reference.
    const retentionKey = deriveRetentionKey(admissionId, input.delivery.sourceBlockId);
    if (!retentionTargets.has(retentionKey)) {
      retentionTargets.set(retentionKey, input.delivery.sourceBlockId);
      retentionChanges.push({
        operation: "add",
        ownerKind: "module",
        retentionKey,
        targetBlockId: input.delivery.sourceBlockId,
      });
    }
  }

  for (const { input, reason } of excludedInputs) {
    // An excluded Delivery still gets an occurrence and a terminal coverage
    // obligation (§5.4): the caller must be able to see that the Delivery was
    // observed and why it produced no vector, not merely that it is absent.
    occurrences.push(
      createOccurrenceRecord({
        namespace: options.namespace,
        deliveryId: input.delivery.deliveryId,
        sourceBlockId: input.delivery.sourceBlockId,
        sourcePageId: input.delivery.inputPageId,
        pageSequence: input.delivery.pageSequence,
        recordIds: [],
        featureJobId: null,
        state: reason === "TOMBSTONED" ? "tombstoned" : "recorded",
        deletionEpoch: options.deletionEpoch,
        terminal: true,
      }),
    );
  }

  const admission: AdmissionRecord = {
    admissionId,
    namespaceKey: options.namespace.namespaceKey,
    moduleJobId: options.moduleJobId,
    moduleGeneration: options.moduleGeneration,
    expectedResultDigest: options.expectedResultDigest,
    deliveryIds: admitted.map((input) => input.delivery.deliveryId),
    featureJobIds: [...jobsById.keys()].sort(),
    retentionTargets: [...retentionTargets.entries()]
      .map(([retentionKey, targetBlockId]) => ({ retentionKey, targetBlockId }))
      .sort((left, right) => (left.retentionKey < right.retentionKey ? -1 : 1)),
    sourceLineageKeys: [
      ...new Set(admitted.map((input) => sourceLineageKey(input.delivery.sourceBlockId))),
    ].sort(),
    featurePlanDigest: options.featurePlanDigest,
    deletionEpoch: options.deletionEpoch,
    state: "prepared",
  };

  return deepFreeze({
    admission,
    occurrences,
    jobs: [...jobsById.values()].sort((left, right) =>
      left.featureJobId < right.featureJobId ? -1 : 1,
    ),
    retentionChanges,
    excluded,
  });
}
