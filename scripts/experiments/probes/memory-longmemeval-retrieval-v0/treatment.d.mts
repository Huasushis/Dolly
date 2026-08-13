export const CONDITION_ORDER: readonly [
  "content",
  "recurrence-no-position",
  "repeated-adjacent-position",
  "shuffled-position",
];

export const ASSOCIATION_WEIGHTS: readonly [0.25, 0.5, 1, 2];

export interface LongMemEvalTreatmentInput {
  readonly question_id: string;
  readonly question: string;
  readonly sessions: readonly {
    readonly session_id: string;
    readonly messages: readonly {
      readonly role: string;
      readonly content: string;
    }[];
  }[];
}

export interface TreatmentRankingEntry {
  readonly rank: number;
  readonly sessionId: string;
  readonly score: number;
  readonly contentScore: number;
  readonly associationScore: number;
}

export interface TreatmentResult {
  readonly schemaVersion: "memory-longmemeval-retrieval/treatment-result-v4";
  readonly questionId: string;
  readonly conditions: readonly {
    readonly conditionId: string;
    readonly variants: readonly {
      readonly weight: number;
      readonly ranking: readonly TreatmentRankingEntry[];
      readonly returnedRawSessionBytes: number;
    }[];
    readonly cost: {
      readonly buildMilliseconds: number;
      readonly queryMilliseconds: number;
      readonly edgeCount: number;
      readonly edgeBytes: number;
      readonly corpusRawSessionBytes: number;
    };
  }[];
  readonly totalMilliseconds: number;
}

export function tokenize(value: string): readonly string[];

export function evaluateTreatmentQuestion(
  input: LongMemEvalTreatmentInput,
  selectedWeights?: Readonly<Record<string, number>>,
): TreatmentResult;
