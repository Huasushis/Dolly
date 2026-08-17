/**
 * Type declarations for the gold-blind synthetic runner.
 * These declarations are maintained by hand to match the .mjs implementation
 * exactly; they exist so strict-mode typechecking of the conformance tests
 * (`tsc --noEmit`) does not degrade imports of this module to `any`.
 */

export const REPOSITORY_ROOT: string;
export const EXPERIMENT_ID: "memory-product-lexical-replay-v0";
export const EXPERIMENT_VERSION: 1;
export const QUERY_LIMIT: 10;
export const SYNTHETIC_RUN_ID: "synthetic-foundation";
export const COMMAND_TEXT: string;

export const SYNTHETIC_CASES: readonly SyntheticCase[];

export interface SyntheticMessage {
  readonly role: string;
  readonly content: string;
}

export interface SyntheticSession {
  readonly session_id: string;
  readonly messages: readonly SyntheticMessage[];
}

export interface SyntheticCase {
  readonly question_id: string;
  readonly question: string;
  readonly sessions: readonly SyntheticSession[];
}

export interface ProjectionRow {
  readonly question_id: string;
  readonly question: string;
  readonly sessions: readonly SyntheticSession[];
  readonly caseSha256: string;
}

export interface Coverage {
  readonly normalizedInputBytes: number;
  readonly coveredNormalizedBytes: number;
  readonly uncoveredNormalizedBytes: number;
  readonly truncatedItems: number;
  readonly skippedItemsByReason: Record<string, number>;
  readonly complete: boolean;
}

export interface TerminalJobs {
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

export interface Generation {
  readonly generationId: string;
  readonly algorithmId: string;
  readonly algorithmVersion: string;
}

export interface QuerySnapshot {
  readonly mode: string;
  readonly limit: number;
  readonly contextExpansion: number;
  readonly generation: Generation;
  readonly channelSent: readonly string[];
}

export interface TreatmentOkRow {
  readonly questionId: string;
  readonly caseSha256: string;
  readonly state: "ok";
  readonly coverage: Coverage;
  readonly terminalJobs: TerminalJobs;
  readonly limit: number;
  readonly queries: readonly QuerySnapshot[];
  readonly recordCount: number;
  readonly featureCount: number;
  readonly canonicalRecordBytes: number;
  readonly canonicalFeatureBytes: number;
}

export interface TreatmentFailedRow {
  readonly questionId: string;
  readonly caseSha256: string;
  readonly state: "failed";
  readonly failure: { readonly kind: string; readonly reason: string };
}

export type TreatmentRow = TreatmentOkRow | TreatmentFailedRow;

export interface ProductLexicalRankingEntry {
  readonly rank: number;
  readonly recordId: string;
  readonly sourceBlockId: string;
  readonly sessionId: string;
  readonly rawBm25: number;
}

export interface ProductLexicalResult {
  readonly effectiveMode: string;
  readonly lexicalGeneration: Generation;
  readonly channelIds: readonly string[];
  readonly extractionCoverage: Coverage;
  readonly terminalJobAccounting: TerminalJobs;
  readonly recordCount: number;
  readonly featureCount: number;
  readonly canonicalRecordBytes: number;
  readonly canonicalFeatureBytes: number;
  readonly ranking: readonly ProductLexicalRankingEntry[];
}

export interface RankingRow {
  readonly questionId: string;
  readonly rank: number;
  readonly recordId: string;
  readonly sourceBlockId: string;
  readonly sessionId: string;
  readonly rawBm25: number;
  readonly caseSha256: string;
}

export interface ProductRowsResult {
  readonly rows: readonly (TreatmentOkRow | TreatmentFailedRow)[];
  readonly rawResults: readonly (ProductLexicalResult | null)[];
}

export function sha256hex(value: string): string;
export function canonicalJson(value: unknown): string;
export function caseDigest(row: SyntheticCase): string;
export function projectionRow(row: SyntheticCase): ProjectionRow;
export function writeExclusive(entryPath: string, bytes: string): void;
export function productRows(
  cases: readonly SyntheticCase[],
  limit?: number,
): Promise<ProductRowsResult>;
export function rankingRowsFrom(
  rows: readonly (TreatmentOkRow | TreatmentFailedRow)[],
  rawResults: readonly (ProductLexicalResult | null)[],
): RankingRow[];
export function writeSyntheticBundle(
  outputDirectory: string,
  options?: {
    readonly cases?: readonly SyntheticCase[];
    readonly limit?: number;
    readonly runId?: string;
  },
): Promise<string>;
