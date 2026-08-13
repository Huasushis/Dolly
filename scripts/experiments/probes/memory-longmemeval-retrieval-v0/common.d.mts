export interface AdaptedLongMemEvalRow {
  readonly questionId: string;
  readonly questionType: string;
  readonly input: {
    readonly question_id: string;
    readonly question: string;
    readonly sessions: readonly {
      readonly session_id: string;
      readonly messages: readonly { readonly role: string; readonly content: string }[];
    }[];
  };
  readonly inputSha256: string;
  readonly goldSessionIds: readonly string[];
  readonly suppliedSessionCount: number;
  readonly retainedSessionCount: number;
}

export function readAndAdaptDataset(repositoryRoot: string): readonly AdaptedLongMemEvalRow[];
export function createSplit(rows: readonly AdaptedLongMemEvalRow[]): Readonly<{
  rows: readonly Record<string, unknown>[];
  development: readonly Record<string, unknown>[];
  evaluation: readonly Record<string, unknown>[];
  splitByQuestion: ReadonlyMap<string, Record<string, unknown>>;
}>;
