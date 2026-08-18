/**
 * Type declarations for the deterministic finalizer and mutation harness.
 * These declarations are maintained by hand to match the .mjs implementation
 * exactly; they exist so strict-mode typechecking of the conformance tests
 * (`tsc --noEmit`) does not degrade imports of this module to `any`.
 */

export interface MutationEntry {
  readonly mutationId: string;
  readonly expectedCode: string;
  readonly code: string | null;
  readonly rejected: boolean;
}

export interface MutationSummary {
  readonly mutationCount: number;
  readonly allRejected: boolean;
  readonly entries: readonly MutationEntry[];
}

export interface FinalizeResult {
  readonly directory: string;
  readonly classification: string;
  readonly mutationSummary: MutationSummary;
}

export interface MutationObservation {
  readonly mutationId: string;
  readonly code: string | null;
  readonly rejected: boolean;
}

export function finalizeFormal(
  runDir: string,
  options: {
    readonly splitPath: string;
    readonly referencePath: string;
    readonly onMutation?: (observation: MutationObservation) => void;
  },
): Promise<FinalizeResult>;
