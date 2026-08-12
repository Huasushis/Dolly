import type {
  CaseMetrics,
  CaseRow,
  DecisionOutput,
  EvidenceEntry,
  Scenario,
} from "./types.d.mts";

export function runDeterministicReader(
  scenario: Scenario,
  evidence: EvidenceEntry[],
): DecisionOutput;
export function validateDecisionOutput(output: unknown): {
  valid: boolean;
  errors: string[];
};
export function scoreDecisionOutput(
  output: DecisionOutput,
  scenario: Scenario,
  evidence: EvidenceEntry[],
): CaseMetrics;
export function analyzeCases(cases: CaseRow[]): Record<string, unknown>;
export function makeCaseRow(
  scenario: Scenario,
  cellId: string,
  evidence: EvidenceEntry[],
  output: DecisionOutput,
): CaseRow;
export function actionOperations(): string[];
