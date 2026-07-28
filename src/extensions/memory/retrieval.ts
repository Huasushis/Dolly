import { canonicalJsonDigest, deepFreeze, isJsonObject, type JsonValue } from "../../core/canonical-json.js";
import { assertCompatibleVectorSpaces, type MemoryVectorSpace } from "./embedding-capability.js";
import { memoryError } from "./errors.js";
import { lexicalTokens } from "./extraction.js";
import {
  LEXICAL_ALGORITHM_ID,
  LEXICAL_ALGORITHM_PARAMETERS,
  LEXICAL_ALGORITHM_VERSION,
  VECTOR_ALGORITHM_ID,
  VECTOR_ALGORITHM_VERSION,
  type IndexGeneration,
} from "./index-generation.js";
import type { FeatureRecord, MemoryRecord } from "./records.js";
import type { CoverageState, MemoryStoreSession } from "./store.js";

/**
 * The retrieval contract from `docs/spec/memory-extension.md` §10.
 *
 * Two rules shape every type here. A score belongs to one named channel bound
 * to one index generation, and a rank is reported beside that score and never
 * in place of it (§10.3). A threshold is a typed rule bound to an exact
 * channel, metric, generation, profile digest, direction, and value; there is
 * no representable `threshold: 0.3` with no score meaning.
 */

export type ScoreDirection = "higher-is-better" | "lower-is-better";
export type ScoreChannelKind = "lexical" | "vector" | "fusion";

export interface ScoreChannel {
  readonly channelId: string;
  readonly kind: ScoreChannelKind;
  readonly algorithmId: string;
  readonly algorithmVersion: string;
  /** The generation whose scale this channel's raw values live on. */
  readonly generationId: string | null;
  readonly metric: string;
  readonly direction: ScoreDirection;
  readonly range?: { readonly min: number; readonly max: number };
  readonly calibrationId?: string;
}

export interface ChannelScore {
  readonly channelId: string;
  readonly raw: number;
  /** Rank within this channel. Reported beside the raw value, never instead. */
  readonly rank: number;
}

export const LEXICAL_CHANNEL_ID = "lexical.bm25";
export const VECTOR_CHANNEL_ID = "vector.nearest-neighbour";
export const FUSION_CHANNEL_ID = "fusion.rrf";

export function lexicalChannel(generation: IndexGeneration): ScoreChannel {
  return deepFreeze({
    channelId: LEXICAL_CHANNEL_ID,
    kind: "lexical" as const,
    algorithmId: LEXICAL_ALGORITHM_ID,
    algorithmVersion: LEXICAL_ALGORITHM_VERSION,
    generationId: generation.generationId,
    metric: "bm25",
    direction: "higher-is-better" as const,
  });
}

export function vectorChannel(generation: IndexGeneration): ScoreChannel {
  const metric = generation.vectorSpace?.metric;
  if (!metric) {
    throw memoryError("MEMORY_VECTOR_UNAVAILABLE", "Vector channel requires a vector generation");
  }
  const lowerIsBetter = metric.kind === "euclidean";
  return deepFreeze({
    channelId: VECTOR_CHANNEL_ID,
    kind: "vector" as const,
    algorithmId: VECTOR_ALGORITHM_ID,
    algorithmVersion: VECTOR_ALGORITHM_VERSION,
    generationId: generation.generationId,
    metric: metric.kind === "declared" ? metric.semanticsId : metric.kind,
    direction: (lowerIsBetter ? "lower-is-better" : "higher-is-better") as ScoreDirection,
    ...(metric.kind === "cosine" ? { range: { min: -1, max: 1 } } : {}),
  });
}

export interface FusionProfile {
  readonly profileId: "dolly.memory.fusion.rrf/1";
  readonly version: string;
  /** Ordered component channel identities. Order is part of the identity. */
  readonly componentChannelIds: readonly string[];
  readonly candidateDepth: Readonly<Record<string, number>>;
  readonly weights: Readonly<Record<string, number>>;
  readonly rrfConstant: number;
  readonly missingChannelPolicy: "omit-component" | "fail";
  readonly duplicateCollapse: "by-record";
  readonly tieBreak: "core-sequence-then-record-id";
}

export const DEFAULT_FUSION_PROFILE: FusionProfile = deepFreeze({
  profileId: "dolly.memory.fusion.rrf/1" as const,
  version: "1",
  componentChannelIds: [LEXICAL_CHANNEL_ID, VECTOR_CHANNEL_ID],
  candidateDepth: { [LEXICAL_CHANNEL_ID]: 64, [VECTOR_CHANNEL_ID]: 64 },
  weights: { [LEXICAL_CHANNEL_ID]: 1, [VECTOR_CHANNEL_ID]: 1 },
  rrfConstant: 60,
  missingChannelPolicy: "omit-component" as const,
  duplicateCollapse: "by-record" as const,
  tieBreak: "core-sequence-then-record-id" as const,
});

export function fusionProfileDigest(profile: FusionProfile): string {
  return canonicalJsonDigest({
    profileId: profile.profileId,
    version: profile.version,
    componentChannelIds: [...profile.componentChannelIds],
    candidateDepth: { ...profile.candidateDepth },
    weights: { ...profile.weights },
    rrfConstant: profile.rrfConstant,
    missingChannelPolicy: profile.missingChannelPolicy,
    duplicateCollapse: profile.duplicateCollapse,
    tieBreak: profile.tieBreak,
  });
}

export function fusionChannel(profile: FusionProfile): ScoreChannel {
  const maxWeight = Object.values(profile.weights).reduce((total, value) => total + value, 0);
  return deepFreeze({
    channelId: FUSION_CHANNEL_ID,
    kind: "fusion" as const,
    algorithmId: profile.profileId,
    algorithmVersion: profile.version,
    // A fusion score lives on no single generation's scale, which is exactly
    // why §9.4 forbids merging raw component numbers.
    generationId: null,
    metric: "reciprocal-rank-fusion",
    direction: "higher-is-better" as const,
    range: { min: 0, max: maxWeight / (profile.rrfConstant + 1) },
  });
}

export interface ThresholdRule {
  readonly channelId: string;
  readonly generationId: string | null;
  readonly metric: string;
  readonly direction: ScoreDirection;
  readonly value: number;
  /** The fusion or calibration profile the rule was frozen against. */
  readonly profileDigest: string | null;
}

export interface ThresholdProfile {
  readonly profileId: string;
  readonly version: string;
  readonly rules: readonly ThresholdRule[];
}

export function thresholdProfileDigest(profile: ThresholdProfile): string {
  return canonicalJsonDigest({
    profileId: profile.profileId,
    version: profile.version,
    rules: profile.rules.map((rule) => ({ ...rule })),
  });
}

/**
 * §10.3: a rule may only be applied to the exact channel, generation, metric,
 * and profile it was frozen against. A hybrid or vector threshold can never be
 * reinterpreted as a lexical threshold during degraded mode.
 */
function assertRuleMatchesChannel(rule: ThresholdRule, channel: ScoreChannel): void {
  if (
    rule.channelId !== channel.channelId ||
    rule.generationId !== channel.generationId ||
    rule.metric !== channel.metric ||
    rule.direction !== channel.direction
  ) {
    throw memoryError(
      "MEMORY_THRESHOLD_CHANNEL_INVALID",
      "A threshold rule does not match the score channel it was applied to",
      { rule: rule.channelId, channel: channel.channelId },
    );
  }
}

function passesThreshold(rule: ThresholdRule, raw: number): boolean {
  return rule.direction === "higher-is-better" ? raw >= rule.value : raw <= rule.value;
}

export type RetrievalMode = "lexical" | "vector" | "hybrid";

export interface MemoryQueryLimits {
  readonly maxQueryTextBytes: number;
  readonly maxResults: number;
  readonly maxContextRecords: number;
  readonly maxMediaInputs: number;
  readonly maxExcerptBytes: number;
}

export const DEFAULT_QUERY_LIMITS: MemoryQueryLimits = deepFreeze({
  maxQueryTextBytes: 4_096,
  maxResults: 20,
  maxContextRecords: 4,
  maxMediaInputs: 4,
  maxExcerptBytes: 512,
});

export interface MemoryQuery {
  readonly requestId: string;
  readonly text?: string;
  /** Indices of authorized `media-reference` items in the same Block (§10.1). */
  readonly mediaItemIndices: readonly number[];
  readonly mode: RetrievalMode;
  readonly limit: number;
  readonly contextExpansion: number;
}

const QUERY_FIELDS = [
  "requestId",
  "text",
  "mediaItemIndices",
  "mode",
  "limit",
  "contextExpansion",
] as const;

/**
 * Parses the closed `dolly.memory.query/1` value.
 *
 * The schema is closed, so a model-authored or user-authored query that adds
 * `ownerScopeId`, `namespace`, `retentionScopeKind`, `sessionId`, `pageId`, or
 * any other field is rejected rather than partially honoured. §4.1 supplies
 * every namespace component from runtime authority, and there is no parameter
 * on this function through which a payload could offer one.
 */
export function parseMemoryQuery(
  value: JsonValue,
  limits: MemoryQueryLimits = DEFAULT_QUERY_LIMITS,
): MemoryQuery {
  if (!isJsonObject(value)) {
    throw memoryError("MEMORY_QUERY_INVALID", "A Memory query must be a JSON object");
  }
  for (const key of Object.keys(value)) {
    if (!(QUERY_FIELDS as readonly string[]).includes(key)) {
      throw memoryError("MEMORY_QUERY_INVALID", "A Memory query carries an unknown field", {
        field: key,
      });
    }
  }
  const requestId = value.requestId;
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) {
    throw memoryError("MEMORY_QUERY_INVALID", "requestId is invalid");
  }
  let text: string | undefined;
  if (value.text !== undefined) {
    if (typeof value.text !== "string") {
      throw memoryError("MEMORY_QUERY_INVALID", "text must be a string when present");
    }
    if (Buffer.byteLength(value.text, "utf8") > limits.maxQueryTextBytes) {
      throw memoryError("MEMORY_LIMIT_EXCEEDED", "Query text exceeds its byte limit", {
        limit: "maxQueryTextBytes",
        allowed: limits.maxQueryTextBytes,
      });
    }
    text = value.text;
  }
  const mediaItemIndices: number[] = [];
  if (value.mediaItemIndices !== undefined) {
    if (!Array.isArray(value.mediaItemIndices)) {
      throw memoryError("MEMORY_QUERY_INVALID", "mediaItemIndices must be an array when present");
    }
    if (value.mediaItemIndices.length > limits.maxMediaInputs) {
      throw memoryError("MEMORY_LIMIT_EXCEEDED", "Query media input count exceeds its limit", {
        limit: "maxMediaInputs",
        allowed: limits.maxMediaInputs,
      });
    }
    for (const candidate of value.mediaItemIndices) {
      if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
        throw memoryError("MEMORY_QUERY_INVALID", "mediaItemIndices must be item indices");
      }
      mediaItemIndices.push(candidate);
    }
  }
  const mode = value.mode;
  if (mode !== "lexical" && mode !== "vector" && mode !== "hybrid") {
    throw memoryError("MEMORY_QUERY_INVALID", "mode is not a baseline retrieval mode");
  }
  const limit = value.limit ?? limits.maxResults;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) {
    throw memoryError("MEMORY_QUERY_INVALID", "limit must be a positive safe integer");
  }
  if (limit > limits.maxResults) {
    throw memoryError("MEMORY_LIMIT_EXCEEDED", "Query limit exceeds its bound", {
      limit: "maxResults",
      allowed: limits.maxResults,
    });
  }
  const contextExpansion = value.contextExpansion ?? 0;
  if (
    typeof contextExpansion !== "number" ||
    !Number.isSafeInteger(contextExpansion) ||
    contextExpansion < 0
  ) {
    throw memoryError("MEMORY_QUERY_INVALID", "contextExpansion must be a non-negative integer");
  }
  if (contextExpansion > limits.maxContextRecords) {
    throw memoryError("MEMORY_LIMIT_EXCEEDED", "Context expansion exceeds its bound", {
      limit: "maxContextRecords",
      allowed: limits.maxContextRecords,
    });
  }
  if (text === undefined && mediaItemIndices.length === 0) {
    throw memoryError("MEMORY_QUERY_INVALID", "A query needs query text or a media input");
  }
  return deepFreeze({
    requestId,
    ...(text === undefined ? {} : { text }),
    mediaItemIndices,
    mode,
    limit,
    contextExpansion,
  });
}

export interface RetrievalSnapshot {
  readonly namespaceKey: string;
  readonly lexicalGenerationId: string;
  readonly vectorGenerationIds: readonly string[];
  readonly channelIds: readonly string[];
  readonly fusionProfileDigest: string | null;
  readonly thresholdProfileDigest: string;
  readonly corpusRevision: number;
  readonly tombstoneRevision: number;
  readonly coverage: readonly CoverageState[];
  readonly readLeaseId: string;
  readonly readLeaseExpiresAtTick: number;
}

/**
 * A bounded read lease over the exact generations and revisions a query
 * observes (§5.4). It is fenced by Module generation and query run and is
 * released on every terminal path; an expired lease is reconciled rather than
 * silently extended.
 */
export class IndexReadLease {
  readonly leaseId: string;
  readonly moduleGeneration: number;
  readonly queryRunId: string;
  readonly generationIds: readonly string[];
  readonly expiresAtTick: number;
  #released = false;

  constructor(options: {
    readonly leaseId: string;
    readonly moduleGeneration: number;
    readonly queryRunId: string;
    readonly generationIds: readonly string[];
    readonly expiresAtTick: number;
  }) {
    this.leaseId = options.leaseId;
    this.moduleGeneration = options.moduleGeneration;
    this.queryRunId = options.queryRunId;
    this.generationIds = [...options.generationIds];
    this.expiresAtTick = options.expiresAtTick;
  }

  get released(): boolean {
    return this.#released;
  }

  assertLive(tick: number, moduleGeneration: number): void {
    if (this.#released) {
      throw memoryError("MEMORY_JOB_STATE_INVALID", "Index read lease is already released");
    }
    if (tick > this.expiresAtTick) {
      throw memoryError("MEMORY_LIMIT_EXCEEDED", "Index read lease expired", {
        limit: "readLeaseTicks",
        allowed: this.expiresAtTick,
      });
    }
    if (moduleGeneration !== this.moduleGeneration) {
      throw memoryError("MEMORY_GENERATION_FENCED", "Index read lease is fenced");
    }
  }

  /** Idempotent. Releasing twice is not an error on a terminal path. */
  release(): void {
    this.#released = true;
  }
}

export interface FeatureProvenance {
  readonly kind: FeatureRecord["kind"];
  readonly sourceModality: string;
  readonly generationId: string;
  readonly pipelineId: string;
  readonly pipelineVersion: string;
  readonly endpointId?: string;
  readonly modelId?: string;
  readonly descriptorDigest?: string;
  readonly vectorSpaceId?: string;
}

export interface ContextRecord {
  readonly recordId: string;
  readonly sourceBlockId: string;
  readonly coreSequence: number;
  readonly excerpt: string;
  /** Context is labelled separately and never inherits the match's score. */
  readonly label: "adjacent-context";
}

export interface RetrievalMatch {
  readonly recordId: string;
  readonly sourceBlockId: string;
  readonly sourcePageId: string;
  readonly coreSequence: number;
  readonly excerpt: string;
  readonly excerptTruncated: boolean;
  readonly rank: number;
  readonly scores: readonly ChannelScore[];
  readonly provenance: readonly FeatureProvenance[];
  readonly context: readonly ContextRecord[];
}

export type RetrievalNoticeCode =
  | "VECTOR_UNAVAILABLE_DEGRADED_LEXICAL"
  | "COMPONENT_CHANNEL_MISSING"
  | "CONTEXT_TRUNCATED"
  | "RESULT_TRUNCATED";

export interface RetrievalResult {
  readonly requestId: string;
  readonly status: "ok" | "no-match";
  readonly mode: RetrievalMode;
  readonly effectiveMode: RetrievalMode;
  readonly snapshot: RetrievalSnapshot;
  readonly channels: readonly ScoreChannel[];
  readonly matches: readonly RetrievalMatch[];
  readonly notices: readonly { readonly code: RetrievalNoticeCode; readonly channelId?: string }[];
}

interface Candidate {
  readonly record: MemoryRecord;
  readonly features: readonly FeatureRecord[];
}

function bm25Scores(
  candidates: readonly Candidate[],
  generation: IndexGeneration,
  queryText: string,
): ReadonlyMap<string, number> {
  const terms = lexicalTokens(queryText);
  const scores = new Map<string, number>();
  if (terms.length === 0) return scores;
  const docs = candidates
    .map((candidate) => {
      const lexical = candidate.features.find(
        (feature) =>
          feature.kind === "lexical" && feature.generationId === generation.generationId,
      );
      return lexical?.tokens === undefined
        ? undefined
        : { recordId: candidate.record.recordId, tokens: lexical.tokens };
    })
    .filter((entry): entry is { recordId: string; tokens: readonly string[] } => entry !== undefined);
  if (docs.length === 0) return scores;
  const totalLength = docs.reduce((total, doc) => total + doc.tokens.length, 0);
  const averageLength = totalLength / docs.length;
  const { k1, b } = LEXICAL_ALGORITHM_PARAMETERS;
  const documentFrequency = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc.tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  for (const doc of docs) {
    let score = 0;
    for (const term of terms) {
      const frequency = doc.tokens.filter((token) => token === term).length;
      if (frequency === 0) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      const denominator =
        frequency + k1 * (1 - b + (b * doc.tokens.length) / (averageLength || 1));
      score += idf * ((frequency * (k1 + 1)) / denominator);
    }
    if (score > 0) scores.set(doc.recordId, score);
  }
  return scores;
}

function vectorScores(
  candidates: readonly Candidate[],
  generation: IndexGeneration,
  queryVector: readonly number[],
): ReadonlyMap<string, number> {
  const scores = new Map<string, number>();
  const metric = generation.vectorSpace!.metric;
  for (const candidate of candidates) {
    const feature = candidate.features.find(
      (entry) => entry.vector !== undefined && entry.generationId === generation.generationId,
    );
    if (!feature?.vector) continue;
    if (feature.vector.length !== queryVector.length) {
      throw memoryError(
        "MEMORY_VECTOR_SPACE_INCOMPATIBLE",
        "Stored vector and query vector have different dimensions",
        { recordId: candidate.record.recordId },
      );
    }
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    let squared = 0;
    for (let index = 0; index < queryVector.length; index += 1) {
      const left = queryVector[index]!;
      const right = feature.vector[index]!;
      dot += left * right;
      leftNorm += left * left;
      rightNorm += right * right;
      squared += (left - right) * (left - right);
    }
    if (metric.kind === "euclidean") {
      scores.set(candidate.record.recordId, Math.sqrt(squared));
    } else if (metric.kind === "dot-product") {
      scores.set(candidate.record.recordId, dot);
    } else if (metric.kind === "cosine") {
      const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
      scores.set(candidate.record.recordId, denominator === 0 ? 0 : dot / denominator);
    } else {
      throw memoryError(
        "MEMORY_GENERATION_INCOMPATIBLE",
        "This generation declares a metric the baseline cannot compute",
        { metric: metric.semanticsId },
      );
    }
  }
  return scores;
}

function rankOf(
  scores: ReadonlyMap<string, number>,
  direction: ScoreDirection,
  candidates: readonly Candidate[],
): ReadonlyMap<string, number> {
  const byRecord = new Map(candidates.map((candidate) => [candidate.record.recordId, candidate]));
  const ordered = [...scores.entries()].sort((left, right) => {
    if (left[1] !== right[1]) {
      return direction === "higher-is-better" ? right[1] - left[1] : left[1] - right[1];
    }
    // Declared stable tie-break: source sequence, then record ID (§10.4).
    const leftRecord = byRecord.get(left[0])!.record;
    const rightRecord = byRecord.get(right[0])!.record;
    if (leftRecord.coreSequence !== rightRecord.coreSequence) {
      return leftRecord.coreSequence - rightRecord.coreSequence;
    }
    return left[0] < right[0] ? -1 : 1;
  });
  return new Map(ordered.map(([recordId], index) => [recordId, index + 1]));
}

function excerpt(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

export interface RetrieveOptions {
  readonly session: MemoryStoreSession;
  readonly query: MemoryQuery;
  readonly lease: IndexReadLease;
  readonly tick: number;
  readonly moduleGeneration: number;
  readonly lexicalGeneration: IndexGeneration;
  readonly vectorGeneration?: IndexGeneration;
  readonly queryVector?: { readonly vector: readonly number[]; readonly vectorSpace: MemoryVectorSpace };
  readonly fusionProfile?: FusionProfile;
  readonly thresholdProfile: ThresholdProfile;
  /** §10.2: a separately configured lexical profile used only when degraded. */
  readonly degradedLexicalThresholdProfile?: ThresholdProfile;
  readonly degradedMode?: "lexical";
  /** §6.1 step 4 and §7: every source Block in the current input batch. */
  readonly excludedSourceBlockIds?: readonly string[];
  readonly tombstonedLineages?: ReadonlySet<string>;
  readonly limits?: MemoryQueryLimits;
}

/**
 * Runs one bounded query against the pinned snapshot.
 *
 * Namespace, Page, tombstone, generation, and current-batch filtering all
 * happen before selection (§10.4). Nothing is fetched broadly and filtered for
 * display afterwards.
 */
export function retrieve(options: RetrieveOptions): RetrievalResult {
  const limits = options.limits ?? DEFAULT_QUERY_LIMITS;
  options.lease.assertLive(options.tick, options.moduleGeneration);
  const session = options.session;
  const namespace = session.namespace;
  const excluded = new Set(options.excludedSourceBlockIds ?? []);
  const tombstoned = options.tombstonedLineages ?? new Set<string>();

  const notices: { code: RetrievalNoticeCode; channelId?: string }[] = [];
  let effectiveMode = options.query.mode;
  let vectorGeneration = options.vectorGeneration;

  if (options.query.mode !== "lexical") {
    const usable =
      vectorGeneration !== undefined &&
      options.queryVector !== undefined &&
      options.lease.generationIds.includes(vectorGeneration.generationId);
    if (!usable) {
      if (options.degradedMode !== "lexical") {
        throw memoryError(
          "MEMORY_VECTOR_UNAVAILABLE",
          "Vector retrieval is unavailable and no degraded policy is configured",
          { mode: options.query.mode },
        );
      }
      effectiveMode = "lexical";
      vectorGeneration = undefined;
      notices.push({ code: "VECTOR_UNAVAILABLE_DEGRADED_LEXICAL" });
    }
  }

  const thresholdProfile =
    effectiveMode === options.query.mode
      ? options.thresholdProfile
      : (options.degradedLexicalThresholdProfile ??
        (() => {
          throw memoryError(
            "MEMORY_THRESHOLD_CHANNEL_INVALID",
            "Degraded lexical retrieval requires its own lexical threshold profile",
          );
        })());

  if (vectorGeneration && options.queryVector) {
    assertCompatibleVectorSpaces(
      vectorGeneration.vectorSpace!,
      options.queryVector.vectorSpace,
      "query vector",
    );
  }

  const candidates: Candidate[] = [];
  const features = session.features();
  for (const record of session.records()) {
    if (record.namespaceKey !== namespace.namespaceKey) continue;
    if (record.inputPageId !== namespace.inputPageId) continue;
    if (excluded.has(record.sourceBlockId)) continue;
    if (tombstoned.has(`block:${record.sourceBlockId}`)) continue;
    if (record.extractorId !== options.lexicalGeneration.extractorId) continue;
    if (record.extractorVersion !== options.lexicalGeneration.extractorVersion) continue;
    candidates.push({
      record,
      features: features.filter((feature) => feature.recordId === record.recordId),
    });
  }

  const channels: ScoreChannel[] = [];
  const channelScores = new Map<string, ReadonlyMap<string, number>>();
  const channelRanks = new Map<string, ReadonlyMap<string, number>>();

  const queryText = options.query.text ?? "";
  if (effectiveMode === "lexical" || effectiveMode === "hybrid") {
    const channel = lexicalChannel(options.lexicalGeneration);
    const scores = bm25Scores(candidates, options.lexicalGeneration, queryText);
    channels.push(channel);
    channelScores.set(channel.channelId, scores);
    channelRanks.set(channel.channelId, rankOf(scores, channel.direction, candidates));
  }
  if (vectorGeneration && options.queryVector) {
    const channel = vectorChannel(vectorGeneration);
    const scores = vectorScores(candidates, vectorGeneration, options.queryVector.vector);
    channels.push(channel);
    channelScores.set(channel.channelId, scores);
    channelRanks.set(channel.channelId, rankOf(scores, channel.direction, candidates));
  }

  let orderingChannel: ScoreChannel;
  if (effectiveMode === "hybrid") {
    const profile = options.fusionProfile ?? DEFAULT_FUSION_PROFILE;
    const present = profile.componentChannelIds.filter((channelId) =>
      channels.some((channel) => channel.channelId === channelId),
    );
    const missing = profile.componentChannelIds.filter(
      (channelId) => !present.includes(channelId),
    );
    if (missing.length > 0) {
      if (profile.missingChannelPolicy === "fail") {
        throw memoryError(
          "MEMORY_THRESHOLD_CHANNEL_INVALID",
          "A fusion component channel is missing and the profile requires it",
          { channelId: missing[0]! },
        );
      }
      for (const channelId of missing) {
        notices.push({ code: "COMPONENT_CHANNEL_MISSING", channelId });
      }
    }
    const fused = new Map<string, number>();
    for (const channelId of present) {
      const ranks = channelRanks.get(channelId)!;
      const depth = profile.candidateDepth[channelId] ?? 0;
      const weight = profile.weights[channelId] ?? 0;
      for (const [recordId, rank] of ranks) {
        if (rank > depth) continue;
        // Reciprocal-rank fusion is a declared, versioned algorithm over ranks.
        // The component raw scores are never added together (§10.2).
        fused.set(recordId, (fused.get(recordId) ?? 0) + weight / (profile.rrfConstant + rank));
      }
    }
    orderingChannel = fusionChannel(profile);
    channels.push(orderingChannel);
    channelScores.set(orderingChannel.channelId, fused);
    channelRanks.set(
      orderingChannel.channelId,
      rankOf(fused, orderingChannel.direction, candidates),
    );
  } else if (effectiveMode === "vector") {
    orderingChannel = channels.find((channel) => channel.kind === "vector")!;
  } else {
    orderingChannel = channels.find((channel) => channel.kind === "lexical")!;
  }

  for (const rule of thresholdProfile.rules) {
    const channel = channels.find((candidate) => candidate.channelId === rule.channelId);
    if (!channel) {
      throw memoryError(
        "MEMORY_THRESHOLD_CHANNEL_INVALID",
        "A threshold names a score channel this result does not carry",
        { channelId: rule.channelId },
      );
    }
    assertRuleMatchesChannel(rule, channel);
  }

  const orderingScores = channelScores.get(orderingChannel.channelId)!;
  const orderingRanks = channelRanks.get(orderingChannel.channelId)!;
  const survivors = [...orderingScores.entries()].filter(([recordId, raw]) => {
    for (const rule of thresholdProfile.rules) {
      const channel = channels.find((candidate) => candidate.channelId === rule.channelId)!;
      const scores = channelScores.get(channel.channelId)!;
      const value = channel.channelId === orderingChannel.channelId ? raw : scores.get(recordId);
      // A record with no score on a thresholded channel has not passed it.
      if (value === undefined || !passesThreshold(rule, value)) return false;
    }
    return true;
  });

  const byRecordId = new Map(candidates.map((candidate) => [candidate.record.recordId, candidate]));
  const ordered = survivors
    .sort((left, right) => orderingRanks.get(left[0])! - orderingRanks.get(right[0])!)
    .slice(0, options.query.limit);
  if (ordered.length < survivors.length) notices.push({ code: "RESULT_TRUNCATED" });

  const matches: RetrievalMatch[] = ordered.map(([recordId], index) => {
    const candidate = byRecordId.get(recordId)!;
    const body = excerpt(candidate.record.text, limits.maxExcerptBytes);
    const scores: ChannelScore[] = channels
      .map((channel) => {
        const raw = channelScores.get(channel.channelId)!.get(recordId);
        if (raw === undefined) return undefined;
        return {
          channelId: channel.channelId,
          raw,
          rank: channelRanks.get(channel.channelId)!.get(recordId)!,
        };
      })
      .filter((score): score is ChannelScore => score !== undefined);
    return {
      recordId,
      sourceBlockId: candidate.record.sourceBlockId,
      sourcePageId: candidate.record.sourcePageId,
      coreSequence: candidate.record.coreSequence,
      excerpt: body.text,
      excerptTruncated: body.truncated,
      rank: index + 1,
      scores,
      provenance: candidate.features.map((feature) => ({
        kind: feature.kind,
        sourceModality: feature.sourceModality,
        generationId: feature.generationId,
        pipelineId: feature.pipelineId,
        pipelineVersion: feature.pipelineVersion,
        ...(feature.endpointId === undefined ? {} : { endpointId: feature.endpointId }),
        ...(feature.modelId === undefined ? {} : { modelId: feature.modelId }),
        ...(feature.descriptorDigest === undefined
          ? {}
          : { descriptorDigest: feature.descriptorDigest }),
        ...(feature.vectorSpace === undefined
          ? {}
          : { vectorSpaceId: feature.vectorSpace.vectorSpaceId }),
      })),
      context: expandContext(candidate, candidates, options.query.contextExpansion, limits),
    };
  });

  const snapshot: RetrievalSnapshot = deepFreeze({
    namespaceKey: namespace.namespaceKey,
    lexicalGenerationId: options.lexicalGeneration.generationId,
    vectorGenerationIds: vectorGeneration ? [vectorGeneration.generationId] : [],
    channelIds: channels.map((channel) => channel.channelId),
    fusionProfileDigest:
      effectiveMode === "hybrid"
        ? fusionProfileDigest(options.fusionProfile ?? DEFAULT_FUSION_PROFILE)
        : null,
    thresholdProfileDigest: thresholdProfileDigest(thresholdProfile),
    corpusRevision: session.revisions().corpusRevision,
    tombstoneRevision: session.revisions().tombstoneRevision,
    coverage: [session.coverage(namespace.inputPageId)],
    readLeaseId: options.lease.leaseId,
    readLeaseExpiresAtTick: options.lease.expiresAtTick,
  });

  return deepFreeze({
    requestId: options.query.requestId,
    status: matches.length === 0 ? ("no-match" as const) : ("ok" as const),
    mode: options.query.mode,
    effectiveMode,
    snapshot,
    channels,
    matches,
    notices,
  });
}

/**
 * §10.4: adjacent context comes from committed records in the same namespace
 * and Page, is labelled separately, does not inherit the match's score, and
 * obeys its own record limit.
 */
function expandContext(
  match: Candidate,
  candidates: readonly Candidate[],
  requested: number,
  limits: MemoryQueryLimits,
): readonly ContextRecord[] {
  if (requested <= 0) return [];
  const bound = Math.min(requested, limits.maxContextRecords);
  const samePage = candidates
    .filter(
      (candidate) =>
        candidate.record.sourcePageId === match.record.sourcePageId &&
        candidate.record.recordId !== match.record.recordId,
    )
    .sort((left, right) => {
      if (left.record.coreSequence !== right.record.coreSequence) {
        return left.record.coreSequence - right.record.coreSequence;
      }
      return left.record.recordId < right.record.recordId ? -1 : 1;
    });
  const before = samePage
    .filter((candidate) => candidate.record.coreSequence < match.record.coreSequence)
    .slice(-Math.ceil(bound / 2));
  const after = samePage
    .filter((candidate) => candidate.record.coreSequence > match.record.coreSequence)
    .slice(0, bound - before.length);
  return [...before, ...after].map((candidate) => ({
    recordId: candidate.record.recordId,
    sourceBlockId: candidate.record.sourceBlockId,
    coreSequence: candidate.record.coreSequence,
    excerpt: excerpt(candidate.record.text, limits.maxExcerptBytes).text,
    label: "adjacent-context" as const,
  }));
}
