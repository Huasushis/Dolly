/**
 * Type declarations for the independent stdlib-only verifier.
 * These declarations are maintained by hand to match the .mjs implementation
 * exactly; they exist so strict-mode typechecking of the conformance tests
 * (`tsc --noEmit`) does not degrade imports of this module to `any`.
 */

export const REPOSITORY_ROOT: string;
export const SECRET_SENTINEL: string;

export interface VerifyResult {
  readonly valid: boolean;
  readonly code: string | null;
  readonly message?: string;
  readonly directory: string;
}

export interface MutationDetail {
  readonly mutationId: string;
  readonly expectedCode: string;
  readonly actualCode: string;
  readonly changedFiles: readonly string[];
  readonly rejected: boolean;
  readonly codeMatched: boolean;
}

export interface MutationSummary {
  readonly mutations: number;
  readonly allRejected: boolean;
  readonly details: readonly MutationDetail[];
}

export function verifyCore(
  directory: string,
  options?: { readonly validateChecksum?: boolean },
): VerifyResult;
export function verifyBundle(directory: string): VerifyResult;
export function runMutationTests(runDirectory: string): MutationSummary;
