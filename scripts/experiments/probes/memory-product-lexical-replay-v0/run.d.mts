/**
 * Type declarations for the gold-blind formal runner.
 * These declarations are maintained by hand to match the .mjs implementation
 * exactly; they exist so strict-mode typechecking of the conformance tests
 * (`tsc --noEmit`) does not degrade imports of this module to `any`.
 */

export const REPOSITORY_ROOT: string;
export const RUN_ID_PATTERN: RegExp;
export const SOURCE_FINGERPRINT_PATHS: readonly string[];
export const CHECKSUM_FILES: readonly string[];

export interface FormalMessage {
  readonly role: string;
  readonly content: string;
}

export interface FormalSession {
  readonly session_id: string;
  readonly messages: readonly FormalMessage[];
}

/** Gold-blind case input accepted by `processCase`. */
export interface FormalCaseInput {
  readonly question_id: string;
  readonly question: string;
  readonly sessions: readonly FormalSession[];
}

/** Gold-blind projection row with the bound case digest. */
export interface FormalProjectionRow extends FormalCaseInput {
  readonly caseSha256: string;
}

export interface FormalCoverage {
  readonly normalizedInputBytes: number;
  readonly coveredNormalizedBytes: number;
  readonly uncoveredNormalizedBytes: number;
  readonly truncatedItems: number;
  readonly skippedItemsByReason: Record<string, number>;
  readonly complete: boolean;
}

export interface FormalTerminalJobs {
  readonly pending: number;
  readonly running: number;
  readonly retryable: number;
  readonly succeeded: number;
  readonly skipped: number;
  readonly permanentFailure: number;
  readonly cancelled: number;
  readonly outstandingLeases: number;
  readonly maxObservedConcurrency: number;
}

export interface FormalGeneration {
  readonly generationId: string;
  readonly algorithmId: string;
  readonly algorithmVersion: string;
}

export interface FormalQuerySnapshot {
  readonly mode: string;
  readonly limit: number;
  readonly contextExpansion: number;
  readonly generation: FormalGeneration;
  readonly channelSent: readonly string[];
}

export interface FormalTreatmentOkRow {
  readonly questionId: string;
  readonly caseSha256: string;
  readonly state: "ok";
  readonly coverage: FormalCoverage;
  readonly terminalJobs: FormalTerminalJobs;
  readonly limit: number;
  readonly queries: readonly FormalQuerySnapshot[];
  readonly recordCount: number;
  readonly featureCount: number;
  readonly canonicalRecordBytes: number;
  readonly canonicalFeatureBytes: number;
}

export interface FormalFailure {
  readonly kind: string;
  readonly reason: string;
}

export interface FormalTreatmentFailedRow {
  readonly questionId: string;
  readonly caseSha256: string;
  readonly state: "failed";
  readonly failure: FormalFailure;
}

export type FormalTreatmentRow = FormalTreatmentOkRow | FormalTreatmentFailedRow;

export interface FormalRankingRow {
  readonly questionId: string;
  readonly rank: number;
  readonly recordId: string;
  readonly sourceBlockId: string;
  readonly sessionId: string;
  readonly rawBm25: number;
  readonly caseSha256: string;
}

export interface ProcessedCase {
  readonly row: FormalTreatmentRow;
  readonly rankings: readonly FormalRankingRow[];
}

export interface Accounting {
  readonly complete: number;
  readonly failed: number;
  readonly notStarted: number;
}

export interface FormalRunResult {
  readonly directory: string;
  readonly runId: string;
  readonly accounting: Accounting;
}

export function parseCanonicalJsonLines<T = Record<string, unknown>>(bytes: string): T[];

export function verifyReferenceInventory(referenceRun: string): Set<string>;

export function processCase(
  input: FormalCaseInput,
  limit?: number,
): Promise<ProcessedCase>;

export function runFormal(
  casesPath: string,
  runDir: string,
  options?: {
    readonly maxWorkers?: number;
    readonly resume?: boolean;
    readonly onProgress?: (accounting: Accounting) => void;
  },
): Promise<FormalRunResult>;
