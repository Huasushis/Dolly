/**
 * Type declarations for the independent stdlib verifier.
 * These declarations are maintained by hand to match the .mjs implementation
 * exactly; they exist so strict-mode typechecking of the conformance tests
 * (`tsc --noEmit`) does not degrade imports of this module to `any`.
 */

export const BOOTSTRAP_SEED: number;
export const BOOTSTRAP_ROWS: number;
export const LOWER_BOUND_INDEX: number;
export const CHECKSUM_FILES: readonly string[];
export const SPLIT_DEVELOPMENT: "development";
export const SPLIT_EVALUATION: "evaluation";
export const DATASET_QUESTION_COUNT: 500;
export const SPLIT_DEVELOPMENT_COUNT: 147;
export const SPLIT_EVALUATION_COUNT: 353;
export const COST_P95_INDEX_RULE: string;
export const KNOWLEDGE_UPDATE_MARGIN: 0.02;
export const COST_P95_LIMIT: 2;
export const REPOSITORY_ROOT: string;
export const SOURCE_FINGERPRINT_PATHS: readonly string[];

export function costRatioP95(ratios: readonly number[]): number;
export function costRatioForRow(row: {
  readonly coverage: { readonly coveredNormalizedBytes: number };
  readonly canonicalFeatureBytes: number;
}): number;
export function recomputeSourceHash(): string;

export interface ExpectedMutation {
  readonly mutationId: string;
  readonly expectedCode: string;
}

export const EXPECTED_MUTATIONS: readonly ExpectedMutation[];

export interface VerificationResult {
  valid: boolean;
  code?: string;
  message?: string;
}

export function verifyCore(
  directory: string,
  options?: {
    readonly validateChecksum?: boolean;
    readonly validateAttestations?: boolean;
    readonly referencePath?: string;
  },
): VerificationResult;
