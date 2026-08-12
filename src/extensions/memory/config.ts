import { deepFreeze, isJsonObject, type JsonValue } from "../../core/canonical-json.js";
import { memoryError } from "./errors.js";

/**
 * The baseline configuration contract from `docs/spec/memory-extension.md` §15,
 * and the research classification from §14.
 *
 * The provider-independent defaults below are the ones §15 lists: session
 * scope, one input Page per Module, allowlisted text extraction, lexical
 * retrieval, media policy `skip`, features-only retention, no source
 * references, no automatic recall, and every experimental mechanism disabled.
 */

/**
 * Every mechanism §14 classifies as research.
 *
 * `docs/research/open-research-questions.md` §4 and §5 explain why the two
 * headline proposals are not baseline: tensity has no workload-independent time
 * scale and its predictive validity (H2-A) has never been measured, and the
 * proposed retrieval tiers (trajectory shape matching, part-of-speech deletion)
 * are labelled Hypothesis with no evidence either way. §14.3 requires a
 * preregistered comparison and an accepted ADR before any of them ships.
 */
export const RESEARCH_MECHANISMS = deepFreeze([
  "dailyOrWindowedSummaries",
  "memoryOwnedSkills",
  "longLivedAbstractThinkingPrompt",
  "tensityRanking",
  "tensityRetention",
  "randomOrInverseWeightedForgetting",
  "emotionOrDesireExtraction",
  "emotionTriggeredRecall",
  "newMemoryBoost",
  "inDayBoost",
  "accessCountBoost",
  "positiveFeedbackBoost",
  "trajectoryOrSequenceShapeMatching",
  "partOfSpeechRemoval",
  "relationPatternEmbeddings",
  "conceptAnalogyOrAssociativeBridges",
  "mmrOrSerendipityOptimization",
  "llmSelectedSalienceOrSynthesis",
] as const);

export type ResearchMechanism = (typeof RESEARCH_MECHANISMS)[number];

export type MemoryResearchToggles = Readonly<Record<ResearchMechanism, boolean>>;

export const RESEARCH_DISABLED: MemoryResearchToggles = deepFreeze(
  Object.fromEntries(RESEARCH_MECHANISMS.map((name) => [name, false])),
) as MemoryResearchToggles;

/**
 * §14: every research mechanism is disabled by default. The baseline does not
 * implement any of them, so enabling one fails visibly here rather than being
 * accepted and silently ignored — a silently ignored toggle would let a
 * deployment believe an unevaluated mechanism was running.
 */
export function assertResearchDisabled(toggles: MemoryResearchToggles): void {
  const enabled = RESEARCH_MECHANISMS.filter((name) => toggles[name] === true);
  if (enabled.length > 0) {
    throw memoryError(
      "MEMORY_RESEARCH_NOT_IMPLEMENTED",
      "This mechanism is classified as research and is not implemented by the baseline",
      { mechanisms: [...enabled] },
    );
  }
}

export type RetentionScopeConfig =
  | { readonly kind: "session" }
  | { readonly kind: "owner-long-term"; readonly memorySpaceId: string };

export type RetrievalModeConfig = "lexical" | "vector" | "hybrid";

export type SourceRetentionMode = "features-only" | "retain-source-block";

export interface MemoryBaselineConfig {
  readonly schemaVersion: "dolly.memory-config/1";
  readonly retentionScope: RetentionScopeConfig;
  /** §4.2: the baseline topology is one input Page per Memory Module. */
  readonly inputPagesPerModule: 1;
  readonly allowlistedExtractors: readonly { readonly id: string; readonly version: string }[];
  readonly retrievalMode: RetrievalModeConfig;
  readonly mediaPolicyByModality: Readonly<Record<string, "skip" | "native-embedding" | "derived-text" | "metadata-only">>;
  readonly sourceRetentionMode: SourceRetentionMode;
  readonly includeSourceRefs: boolean;
  readonly automaticRecall: { readonly enabled: boolean };
  readonly degradedMode: "lexical" | "fail";
  readonly hasEmbeddingDescriptor: boolean;
  readonly research: MemoryResearchToggles;
}

export const PROVIDER_INDEPENDENT_DEFAULTS: MemoryBaselineConfig = deepFreeze({
  schemaVersion: "dolly.memory-config/1" as const,
  retentionScope: { kind: "session" as const },
  inputPagesPerModule: 1 as const,
  allowlistedExtractors: [{ id: "dolly.memory.text-content", version: "1" }],
  retrievalMode: "lexical" as const,
  mediaPolicyByModality: {},
  sourceRetentionMode: "features-only" as const,
  includeSourceRefs: false,
  automaticRecall: { enabled: false },
  degradedMode: "fail" as const,
  hasEmbeddingDescriptor: false,
  research: RESEARCH_DISABLED,
});

const CONFIG_FIELDS = [
  "schemaVersion",
  "retentionScope",
  "inputPagesPerModule",
  "allowlistedExtractors",
  "retrievalMode",
  "mediaPolicyByModality",
  "sourceRetentionMode",
  "includeSourceRefs",
  "automaticRecall",
  "degradedMode",
  "hasEmbeddingDescriptor",
  "research",
] as const;

/**
 * Validates one configuration document.
 *
 * §15: selecting vector or hybrid retrieval without a compatible embedding
 * descriptor is a configuration error unless `degradedMode: lexical` is
 * explicitly selected, and selecting native image embedding against a
 * text-only descriptor is an error rather than a reason to substitute OCR, a
 * caption, or a mock.
 */
export function validateMemoryConfig(value: JsonValue): MemoryBaselineConfig {
  if (!isJsonObject(value)) {
    throw memoryError("MEMORY_CONFIG_INVALID", "Memory configuration must be a JSON object");
  }
  for (const key of Object.keys(value)) {
    if (!(CONFIG_FIELDS as readonly string[]).includes(key)) {
      throw memoryError("MEMORY_CONFIG_INVALID", "Unknown Memory configuration field", {
        field: key,
      });
    }
  }
  if (value.schemaVersion !== "dolly.memory-config/1") {
    throw memoryError("MEMORY_CONFIG_INVALID", "Unsupported Memory configuration version");
  }
  if (value.automaticRecall !== undefined) {
    if (
      !isJsonObject(value.automaticRecall) ||
      Object.keys(value.automaticRecall).length !== 1 ||
      value.automaticRecall.enabled !== false
    ) {
      throw memoryError(
        "MEMORY_CONFIG_INVALID",
        "Automatic Memory recall is not implemented and must remain disabled",
      );
    }
  }
  const merged: MemoryBaselineConfig = {
    ...PROVIDER_INDEPENDENT_DEFAULTS,
    ...(value as unknown as Partial<MemoryBaselineConfig>),
    research: {
      ...RESEARCH_DISABLED,
      ...((value.research as unknown as Partial<MemoryResearchToggles>) ?? {}),
    },
  };
  if (merged.inputPagesPerModule !== 1) {
    throw memoryError(
      "MEMORY_CONFIG_INVALID",
      "The baseline topology is one input Page per Memory Module",
    );
  }
  if (merged.allowlistedExtractors.length === 0) {
    throw memoryError(
      "MEMORY_CONFIG_INVALID",
      "At least one allowlisted extractor is required; unknown schemas are never indexed",
    );
  }
  if (
    merged.retrievalMode !== "lexical" &&
    !merged.hasEmbeddingDescriptor &&
    merged.degradedMode !== "lexical"
  ) {
    throw memoryError(
      "MEMORY_CONFIG_INVALID",
      "Vector or hybrid retrieval requires an embedding descriptor or an explicit lexical degraded mode",
      { retrievalMode: merged.retrievalMode },
    );
  }
  for (const [modality, policy] of Object.entries(merged.mediaPolicyByModality)) {
    if (
      policy !== "skip" &&
      policy !== "native-embedding" &&
      policy !== "derived-text" &&
      policy !== "metadata-only"
    ) {
      throw memoryError("MEMORY_CONFIG_INVALID", "Unsupported media policy", { modality });
    }
    if (policy === "native-embedding" && !merged.hasEmbeddingDescriptor) {
      throw memoryError(
        "MEMORY_CONFIG_INVALID",
        "Native media embedding requires an embedding descriptor",
        { modality },
      );
    }
  }
  assertResearchDisabled(merged.research);
  return deepFreeze(merged);
}
