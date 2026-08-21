/**
 * Type declarations for the gold-aware formal analyzer.
 * These declarations are maintained by hand to match the .mjs implementation
 * exactly; they exist so strict-mode typechecking of the conformance tests
 * (`tsc --noEmit`) does not degrade imports of this module to `any`.
 */

export const BOOTSTRAP_SEED: number;
export const BOOTSTRAP_ROWS: number;
export const LOWER_BOUND_INDEX: number;
export const SPLIT_DEVELOPMENT: "development";
export const SPLIT_EVALUATION: "evaluation";
export const DATASET_QUESTION_COUNT: 500;
export const SPLIT_DEVELOPMENT_COUNT: 147;
export const SPLIT_EVALUATION_COUNT: 353;
export const COST_P95_INDEX_RULE: string;
export const KNOWLEDGE_UPDATE_MARGIN: 0.02;
export const COST_P95_LIMIT: 2;
export const ANALYSIS_KEYS: readonly string[];

export function costRatioP95(ratios: readonly number[]): number;
export function costRatioForRow(row: {
  readonly coverage: { readonly coveredNormalizedBytes: number };
  readonly canonicalFeatureBytes: number;
}): number;

export interface AnalysisGate {
  readonly gate: string;
  readonly passed: boolean;
}

export interface MetricTriple {
  readonly product: number;
  readonly reference: number;
  readonly delta: number;
  readonly lower95?: number;
}

export interface ErrorRates {
  readonly product: number;
  readonly reference: number;
  readonly difference: number;
}

export interface CostSummary {
  readonly p95: number;
  readonly perEvaluatedRow: number;
  readonly limit: number;
}

export interface AnalysisVerdict {
  readonly valid: boolean;
  readonly classification: string;
  readonly mutationCount: number;
  readonly allRejected: boolean;
}

export interface AnalysisRecord {
  classification: string;
  decisionGates: AnalysisGate[];
  primaryMetrics: {
    readonly ndcg10: MetricTriple;
    readonly recall10: MetricTriple;
    readonly hit10: MetricTriple;
  };
  diceScore: number;
  errorRates: ErrorRates;
  cost: CostSummary;
  metricGateFailures: number;
  duplicateOccupancy: number;
  discordantCases: string[];
  evaluationRows: number;
  mutationRejected: boolean | null;
  verifier: Record<string, unknown> | null;
  verdict: AnalysisVerdict | null;
}

export function parseCanonicalJsonLines<T = Record<string, unknown>>(bytes: string): T[];

export function xorshift32(seed: number): () => number;

export function pairedBootstrapLower95(orderedDifferences: readonly number[]): number;

export function analyzeFormal(
  runDirectory: string,
  options?: { readonly referencePath?: string; readonly cutoff?: number },
): AnalysisRecord;
