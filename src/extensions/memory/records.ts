import { createHash } from "node:crypto";
import { deepFreeze, isJsonObject, type JsonValue } from "../../core/canonical-json.js";
import type { MemoryVectorSpace } from "./embedding-capability.js";
import { memoryError } from "./errors.js";
import type { MemoryNamespace } from "./namespace.js";

/**
 * The immutable baseline data model from `docs/spec/memory-extension.md` §5.1
 * to §5.3.
 *
 * Every record is frozen after construction. An extraction change produces a
 * new `recordId` because the extractor version and feature-plan digest are part
 * of the identity, so prior text and provenance are never mutated in place.
 */

export const MEMORY_RECORD_SCHEMA_VERSION = "dolly.memory-record/2";
const RECORD_DOMAIN = "dolly.memory-record-id/2";

export type FeatureKind = "lexical" | "native-embedding" | "derived-text-embedding";

export type FeatureStatus = "committed" | "skipped" | "permanent-failure";

export interface FeatureSkip {
  readonly kind: FeatureKind;
  readonly modality: string;
  /** Terminal, typed, and content-free. */
  readonly reason: string;
}

export interface MemoryRecord {
  readonly schemaVersion: typeof MEMORY_RECORD_SCHEMA_VERSION;
  readonly recordId: string;
  readonly namespaceKey: string;
  readonly instanceId: string;
  readonly ownerScopeId: string;
  readonly memoryModuleInstanceId: string;
  readonly inputPageId: string;
  readonly retentionScopeKind: string;
  readonly retentionScopeId: string;
  /** Provenance only. §5.1: this is not automatically a Core block reference. */
  readonly sourceBlockId: string;
  readonly coreSequence: number;
  readonly sourcePageId: string;
  readonly originatingSessionId: string;
  readonly payloadSchema: string;
  readonly extractorId: string;
  readonly extractorVersion: string;
  readonly segmentId: string;
  readonly segmentStartByte: number;
  readonly segmentEndByte: number;
  readonly text: string;
  readonly committedFeatureIds: readonly string[];
  readonly skippedFeatures: readonly FeatureSkip[];
  readonly featurePlanDigest: string;
  readonly creationModuleJobId: string;
  readonly coverageRevision: number;
  readonly deletionEpoch: number;
  /**
   * Opaque research annotations (§14). The baseline stores them when a research
   * harness supplies them and never reads them: no ranking, threshold,
   * retention, eviction, or coverage path in this package touches this field.
   * Invariant 12 is tested by comparing two corpora that differ only here.
   */
  readonly researchAnnotations?: JsonValue;
}

export function deriveRecordId(options: {
  readonly namespace: MemoryNamespace;
  readonly sourceBlockId: string;
  readonly extractorId: string;
  readonly extractorVersion: string;
  readonly segmentId: string;
  readonly featurePlanDigest: string;
  readonly deletionEpoch: number;
}): string {
  return createHash("sha256")
    .update(RECORD_DOMAIN, "utf8")
    .update(" ", "utf8")
    .update(options.namespace.namespaceKey, "utf8")
    .update(" ", "utf8")
    .update(options.sourceBlockId, "utf8")
    .update(" ", "utf8")
    .update(options.extractorId, "utf8")
    .update(" ", "utf8")
    .update(options.extractorVersion, "utf8")
    .update(" ", "utf8")
    .update(options.segmentId, "utf8")
    .update(" ", "utf8")
    .update(options.featurePlanDigest, "utf8")
    .update(" ", "utf8")
    .update(String(options.deletionEpoch), "utf8")
    .digest("hex");
}

type NamespaceFields =
  | "namespaceKey"
  | "instanceId"
  | "ownerScopeId"
  | "memoryModuleInstanceId"
  | "inputPageId"
  | "retentionScopeKind"
  | "retentionScopeId";

export function createMemoryRecord(
  input: Omit<MemoryRecord, "schemaVersion" | "recordId" | NamespaceFields> & {
    readonly namespace: MemoryNamespace;
  },
): MemoryRecord {
  const { namespace, ...rest } = input;
  const recordId = deriveRecordId({
    namespace,
    sourceBlockId: rest.sourceBlockId,
    extractorId: rest.extractorId,
    extractorVersion: rest.extractorVersion,
    segmentId: rest.segmentId,
    featurePlanDigest: rest.featurePlanDigest,
    deletionEpoch: rest.deletionEpoch,
  });
  return deepFreeze({
    schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
    recordId,
    namespaceKey: namespace.namespaceKey,
    instanceId: namespace.instanceId,
    ownerScopeId: namespace.ownerScopeId,
    memoryModuleInstanceId: namespace.memoryModuleInstanceId,
    inputPageId: namespace.inputPageId,
    retentionScopeKind: namespace.retentionScopeKind,
    retentionScopeId: namespace.retentionScopeId,
    ...rest,
  }) as MemoryRecord;
}

/**
 * §5.1: version 2 uses `moduleJobId`. A reader MUST reject version 1 and its
 * former field as `MEMORY_RECORD_INVALID` rather than accepting an alias, so
 * this never falls back to `jobId`, `job`, or a positional guess.
 */
export function parseMemoryRecord(value: JsonValue): MemoryRecord {
  if (!isJsonObject(value)) {
    throw memoryError("MEMORY_RECORD_INVALID", "A Memory record must be a JSON object");
  }
  if (value.schemaVersion !== MEMORY_RECORD_SCHEMA_VERSION) {
    throw memoryError("MEMORY_RECORD_INVALID", "Unsupported Memory record schema version", {
      schemaVersion: typeof value.schemaVersion === "string" ? value.schemaVersion : null,
      expected: MEMORY_RECORD_SCHEMA_VERSION,
    });
  }
  if (!("creationModuleJobId" in value)) {
    throw memoryError(
      "MEMORY_RECORD_INVALID",
      "A version 2 Memory record must carry creationModuleJobId",
    );
  }
  const requiredStrings = [
    "recordId",
    "namespaceKey",
    "instanceId",
    "ownerScopeId",
    "memoryModuleInstanceId",
    "inputPageId",
    "retentionScopeKind",
    "retentionScopeId",
    "sourceBlockId",
    "sourcePageId",
    "originatingSessionId",
    "payloadSchema",
    "extractorId",
    "extractorVersion",
    "segmentId",
    "text",
    "featurePlanDigest",
    "creationModuleJobId",
  ] as const;
  for (const field of requiredStrings) {
    if (typeof value[field] !== "string" || (value[field] as string).length === 0) {
      throw memoryError("MEMORY_RECORD_INVALID", `Memory record field ${field} is invalid`, {
        field,
      });
    }
  }
  const requiredIntegers = [
    "coreSequence",
    "segmentStartByte",
    "segmentEndByte",
    "coverageRevision",
    "deletionEpoch",
  ] as const;
  for (const field of requiredIntegers) {
    const candidate = value[field];
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
      throw memoryError("MEMORY_RECORD_INVALID", `Memory record field ${field} is invalid`, {
        field,
      });
    }
  }
  if (!Array.isArray(value.committedFeatureIds) || !Array.isArray(value.skippedFeatures)) {
    throw memoryError("MEMORY_RECORD_INVALID", "Memory record feature lists are invalid");
  }
  return deepFreeze(value as unknown as MemoryRecord);
}

export type OccurrenceState = "recorded" | "reused" | "tombstoned";

/**
 * §5.2: one idempotent record per accepted source Delivery. A repeated Delivery
 * of the same Block updates occurrence metadata; it never creates a second text
 * segment or vector. Occurrence count is observable evidence only.
 */
export interface OccurrenceRecord {
  readonly schemaVersion: "dolly.memory-occurrence/1";
  readonly occurrenceId: string;
  readonly namespaceKey: string;
  readonly deliveryId: string;
  readonly sourceBlockId: string;
  readonly sourcePageId: string;
  readonly pageSequence: number;
  readonly recordIds: readonly string[];
  readonly featureJobId: string | null;
  readonly state: OccurrenceState;
  readonly deletionEpoch: number;
  /** Advances only when this occurrence itself reaches a terminal state. */
  readonly terminal: boolean;
}

export function createOccurrenceRecord(input: {
  readonly namespace: MemoryNamespace;
  readonly deliveryId: string;
  readonly sourceBlockId: string;
  readonly sourcePageId: string;
  readonly pageSequence: number;
  readonly recordIds: readonly string[];
  readonly featureJobId: string | null;
  readonly state: OccurrenceState;
  readonly deletionEpoch: number;
  readonly terminal: boolean;
}): OccurrenceRecord {
  return deepFreeze({
    schemaVersion: "dolly.memory-occurrence/1" as const,
    occurrenceId: createHash("sha256")
      .update("dolly.memory-occurrence/1", "utf8")
      .update(" ", "utf8")
      .update(input.namespace.namespaceKey, "utf8")
      .update(" ", "utf8")
      .update(input.deliveryId, "utf8")
      .digest("hex"),
    namespaceKey: input.namespace.namespaceKey,
    deliveryId: input.deliveryId,
    sourceBlockId: input.sourceBlockId,
    sourcePageId: input.sourcePageId,
    pageSequence: input.pageSequence,
    recordIds: [...input.recordIds],
    featureJobId: input.featureJobId,
    state: input.state,
    deletionEpoch: input.deletionEpoch,
    terminal: input.terminal,
  });
}

/**
 * §5.3. Media-derived features carry the source Media identity and optional
 * crop, and deliberately carry no signed URL, object key, local path, or bytes.
 */
export interface FeatureRecord {
  readonly schemaVersion: "dolly.memory-feature/1";
  readonly featureId: string;
  readonly recordId: string;
  readonly namespaceKey: string;
  readonly kind: FeatureKind;
  readonly sourceModality: string;
  readonly pipelineId: string;
  readonly pipelineVersion: string;
  readonly generationId: string;
  readonly featureJobId: string;
  readonly status: FeatureStatus;
  /** Embedding features only. */
  readonly endpointId?: string;
  readonly modelId?: string;
  readonly adapterId?: string;
  readonly adapterVersion?: string;
  readonly descriptorVersion?: string;
  readonly descriptorDigest?: string;
  readonly vectorSpace?: MemoryVectorSpace;
  readonly vector?: readonly number[];
  /** Lexical features only. */
  readonly tokens?: readonly string[];
  /** Media-derived features only. */
  readonly sourceMediaId?: string;
  readonly sourceCrop?: {
    readonly topLeft: { readonly x: number; readonly y: number };
    readonly bottomRight: { readonly x: number; readonly y: number };
  };
  /** §8.3: derived assertions are labelled derived and never source truth. */
  readonly derivedText?: string;
  readonly derivedTextTransformationId?: string;
  readonly derivedTextTransformationVersion?: string;
}

export function createFeatureRecord(input: Omit<FeatureRecord, "schemaVersion" | "featureId">): FeatureRecord {
  const featureId = createHash("sha256")
    .update("dolly.memory-feature/1", "utf8")
    .update(" ", "utf8")
    .update(input.namespaceKey, "utf8")
    .update(" ", "utf8")
    .update(input.recordId, "utf8")
    .update(" ", "utf8")
    .update(input.kind, "utf8")
    .update(" ", "utf8")
    .update(input.sourceModality, "utf8")
    .update(" ", "utf8")
    .update(input.generationId, "utf8")
    .digest("hex");
  return deepFreeze({
    schemaVersion: "dolly.memory-feature/1" as const,
    featureId,
    ...input,
  });
}

/**
 * §13.2: a stored feature must never carry a byte payload, a signed URL, an
 * object key, or a local path. This is checked at commit rather than trusted,
 * because the caller that assembles a feature is the same code path that talks
 * to the media view.
 */
const FORBIDDEN_MEDIA_LOCATOR = /^(?:https?:|file:|data:|s3:|oss:|\/|[A-Za-z]:[\\/])/u;

export function assertFeatureRetainsNoMediaBytes(feature: FeatureRecord): void {
  const suspects: readonly (string | undefined)[] = [
    feature.sourceMediaId,
    feature.derivedText,
    feature.pipelineId,
  ];
  for (const candidate of suspects) {
    if (typeof candidate === "string" && FORBIDDEN_MEDIA_LOCATOR.test(candidate)) {
      throw memoryError(
        "MEMORY_RECORD_INVALID",
        "A Memory feature must not retain a media locator, path, or byte payload",
        { featureId: feature.featureId },
      );
    }
  }
}
