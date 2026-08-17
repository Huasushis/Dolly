/**
 * Type declarations for the gold-aware analyzer.
 * These declarations are maintained by hand to match the .mjs implementation
 * exactly; they exist so strict-mode typechecking of the conformance tests
 * (`tsc --noEmit`) does not degrade imports of this module to `any`.
 */
export function parseJsonLines<T = Record<string, unknown>>(bytes: string): T[];

export function canonicalJson(value: unknown): string;

export interface CaseMetrics {
  readonly hit: number;
  readonly recall: number;
  readonly ndcg: number;
}

export interface AnalyzedQuestion {
  readonly questionId: string;
  readonly caseSha256: string;
  readonly state: "ok" | "failed";
  readonly metrics: CaseMetrics;
  readonly duplicateOccupancy: number;
  readonly coverageComplete: boolean;
  readonly jobsTerminal: boolean;
  readonly failure: { readonly kind: string; readonly reason: string } | null;
}

export interface DecisionGate {
  readonly questionId: string;
  readonly gate: string;
  readonly passed: boolean;
}

export interface Analysis {
  decisionGates: DecisionGate[];
  classification: "pass" | "rejected";
  primaryMetrics: {
    readonly ndcg10: number;
    readonly recall10: number;
    readonly hit10: number;
    readonly referenceDeltas: null;
  };
  diceScore: null;
  errorRates: null;
  duplicateOccupancy: number;
  discordantCases: readonly unknown[];
  mutationRejected: null;
  verifier: null;
  verdict: null;
  cutoff: number;
  perQuestion: readonly AnalyzedQuestion[];
}

export function analyzeBundle(
  runDirectory: string,
  options?: { readonly cutoff?: number },
): Analysis;
