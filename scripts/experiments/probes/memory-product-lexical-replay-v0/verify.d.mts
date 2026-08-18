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
