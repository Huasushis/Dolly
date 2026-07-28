/**
 * Dolly Memory extension — product baseline.
 *
 * Scope
 * -----
 * This package implements the minimal product baseline of
 * `docs/spec/memory-extension.md`: runtime-authenticated namespace isolation
 * (§4), deterministic allowlisted extraction and immutable records (§5, §8.1),
 * bounded recoverable background indexing (§6), lexical/vector/hybrid retrieval
 * with honest score channels and typed thresholds (§10), and descriptor-declared
 * embedding capability (§9).
 *
 * Deliberately not implemented
 * ----------------------------
 * These are absences by decision, not gaps left for later.
 *
 * 1. Every mechanism §14 classifies as research. `config.ts` enumerates them in
 *    `RESEARCH_MECHANISMS`, defaults all of them to false, and makes enabling
 *    one fail with `MEMORY_RESEARCH_NOT_IMPLEMENTED` rather than accepting a
 *    toggle that does nothing. That list includes daily and windowed summaries,
 *    memory-owned skills, a long-lived abstract-thinking prompt, tensity-based
 *    ranking or retention, emotion extraction and emotion-triggered recall,
 *    new-memory/in-day/access-count/positive-feedback boosts, trajectory and
 *    sequence-shape matching, part-of-speech removal and relation-pattern
 *    embeddings, concept analogy, MMR/serendipity, and LLM-selected salience or
 *    synthesis. `docs/research/open-research-questions.md` §4 and §5 record why:
 *    tensity has no workload-independent time scale and its predictive validity
 *    (H2-A) has never been measured, and the proposed retrieval tiers are
 *    labelled Hypothesis with no supporting evidence.
 * 2. Automatic recall. §10.1 makes it optional and disabled by default; only
 *    explicit `dolly.memory.query/1` payloads produce a recall Block here.
 * 3. Reranking (§10.2), which the baseline does not require and which
 *    `open-research-questions.md` §5.2 shows degrades past a candidate depth.
 * 4. Native media embedding, OCR/caption/transcription derived text, and
 *    metadata-only media features. The media policy is parsed, validated
 *    against the descriptor, and honoured by recording a visible terminal skip;
 *    nothing substitutes a text vector, a byte hash, a zero vector, or a mock.
 * 5. Raw-media retention (§8.2), model migration and reindexing (§9.4, §12.3),
 *    and physical purge after a tombstone (§12.2). The tombstone, deletion
 *    epoch, and admission recheck exist; the backfill sequence does not.
 * 6. Production wiring. Nothing here is registered with `runtime-bootstrap.ts`
 *    or the Extension process host. The store, block reader, media modality
 *    resolver, embedding operation, clock, and lease identifiers are all
 *    injected, so the conformance suite runs with fakes and no network.
 *
 * Trust
 * -----
 * Recalled text is untrusted user-derived data (§13.1). It leaves this package
 * only inside a `dolly.memory.recall/1` data item in an ordinary Block, marked
 * `trustClass: "untrusted-user-derived"`. `memoryModuleDescription()` is a
 * constant and cannot come to contain a recalled record.
 */

export { MemoryError, memoryError, type MemoryErrorCode } from "./errors.js";

export {
  assertNamespaceAuthorized,
  assertSameNamespace,
  authenticateDelivery,
  authenticateIdentity,
  authenticateNamespace,
  namespaceScopedKey,
  type MemoryAuthorization,
  type MemoryNamespace,
  type MemoryOperation,
  type OwnerLongTermGrant,
  type RetentionScopeKind,
  type RetentionScopeSelection,
  type RuntimeDeliveryContext,
  type RuntimeMemoryIdentity,
} from "./namespace.js";

export {
  DOLLY_CONTENT_TEXT_EXTRACTOR_CONTRACT,
  LEXICAL_ANALYZER_ID,
  LEXICAL_ANALYZER_VERSION,
  MEMORY_CONTROL_SCHEMAS,
  MEMORY_QUERY_SCHEMA,
  MEMORY_RECALL_SCHEMA,
  createTextContentExtractor,
  deriveSegmentId,
  lexicalTokens,
  normalizeExtractedText,
  type ExtractedSegment,
  type ExtractionResult,
  type ExtractionSkip,
  type ExtractionSkipReason,
  type MediaCandidate,
  type MemorySourceBlock,
  type TextExtractor,
  type TextExtractorContract,
} from "./extraction.js";

export {
  assertCompatibleVectorSpaces,
  assertModalitiesComparable,
  assertModalitySupported,
  resolveMemoryEmbeddingCapability,
  validateEmbeddingOutcomes,
  vectorSpaceKey,
  type MemoryEmbeddingCapability,
  type MemoryEmbeddingItem,
  type MemoryEmbeddingOperation,
  type MemoryEmbeddingOutcome,
  type MemoryVectorSpace,
} from "./embedding-capability.js";

export {
  DEFAULT_MAX_FEATURES_PER_RECORD,
  DEFAULT_MAX_SEGMENTS_PER_BLOCK,
  createFeaturePlan,
  featurePlanDigest,
  planMediaFeature,
  type FeaturePlan,
  type FeaturePlanInput,
  type MediaFeatureDecision,
  type MediaModalityPolicy,
  type TextEmbeddingPlan,
} from "./feature-plan.js";

export {
  LEXICAL_ALGORITHM_ID,
  LEXICAL_ALGORITHM_PARAMETERS,
  LEXICAL_ALGORITHM_VERSION,
  VECTOR_ALGORITHM_ID,
  VECTOR_ALGORITHM_VERSION,
  assertComparableRawScores,
  assertGenerationAccepts,
  deriveLexicalGeneration,
  deriveVectorGeneration,
  type DescriptorIdentity,
  type IndexGeneration,
  type MemoryIndexKind,
} from "./index-generation.js";

export {
  MEMORY_RECORD_SCHEMA_VERSION,
  assertFeatureRetainsNoMediaBytes,
  createFeatureRecord,
  createMemoryRecord,
  createOccurrenceRecord,
  deriveRecordId,
  parseMemoryRecord,
  type FeatureKind,
  type FeatureRecord,
  type FeatureSkip,
  type FeatureStatus,
  type MemoryRecord,
  type OccurrenceRecord,
  type OccurrenceState,
} from "./records.js";

export {
  DEFAULT_MEMORY_STORE_LIMITS,
  InMemoryMemoryJournal,
  MemoryStore,
  MemoryStoreSession,
  TERMINAL_JOB_STATES,
  eventNamespaceKey,
  type AdmissionRecord,
  type AdmissionState,
  type CoverageState,
  type DeliveryOutcome,
  type FeatureJobRecord,
  type FeatureJobState,
  type MemoryEvent,
  type MemoryJournal,
  type MemoryStoreLimits,
  type PlannedFeature,
  type TombstoneRecord,
} from "./store.js";

export {
  deriveAdmissionId,
  deriveFeatureJobId,
  deriveRetentionKey,
  prepareAdmission,
  sourceLineageKey,
  type AdmissionExclusion,
  type AdmissionExclusionReason,
  type AdmissionPreparation,
  type DeliveredInput,
  type ModuleRetentionChange,
} from "./admission.js";

export {
  DEFAULT_BACKGROUND_INDEXER_LIMITS,
  MemoryBackgroundIndexer,
  type ActivationRequest,
  type BackgroundIndexerLimits,
  type BackgroundIndexerOptions,
  type IndexerReport,
  type MemoryBlockLease,
  type MemoryBlockReader,
  type MemoryMediaModalityResolver,
} from "./background-indexer.js";

export {
  DEFAULT_FUSION_PROFILE,
  DEFAULT_QUERY_LIMITS,
  FUSION_CHANNEL_ID,
  IndexReadLease,
  LEXICAL_CHANNEL_ID,
  VECTOR_CHANNEL_ID,
  fusionChannel,
  fusionProfileDigest,
  lexicalChannel,
  parseMemoryQuery,
  retrieve,
  thresholdProfileDigest,
  vectorChannel,
  type ChannelScore,
  type ContextRecord,
  type FeatureProvenance,
  type FusionProfile,
  type MemoryQuery,
  type MemoryQueryLimits,
  type RetrievalMatch,
  type RetrievalMode,
  type RetrievalNoticeCode,
  type RetrievalResult,
  type RetrievalSnapshot,
  type ScoreChannel,
  type ScoreChannelKind,
  type ScoreDirection,
  type ThresholdProfile,
  type ThresholdRule,
} from "./retrieval.js";

export {
  DEFAULT_ACTION_LIMITS,
  applyActivationRequest,
  memoryModuleDescription,
  runMemoryModuleAction,
  type MemoryActionLimits,
  type MemoryActionOptions,
  type MemoryActionResult,
  type MemoryBlockProposal,
  type QueryOutcome,
  type QueryStatus,
} from "./module-action.js";

export {
  PROVIDER_INDEPENDENT_DEFAULTS,
  RESEARCH_DISABLED,
  RESEARCH_MECHANISMS,
  assertResearchDisabled,
  validateMemoryConfig,
  type MemoryBaselineConfig,
  type MemoryResearchToggles,
  type ResearchMechanism,
  type RetentionScopeConfig,
  type RetrievalModeConfig,
  type SourceRetentionMode,
} from "./config.js";

export {
  planRetention,
  type RetentionPlan,
  type RetentionPolicy,
} from "./retention.js";
