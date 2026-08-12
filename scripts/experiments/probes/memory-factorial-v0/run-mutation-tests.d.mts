import type { ArtifactBundle } from "./types.d.mts";
import type { VerifyOptions } from "./verify.d.mts";

export interface MutationResult {
  id: string;
  rejected: boolean;
  expectedFailure: string;
  errors: string[];
  mutatedBundleSha256: string;
}
export function mutationDefinitions(): Array<{
  id: string;
  expectedFailure: string;
  mutate(bundle: ArtifactBundle): void;
}>;
export function runMutations(
  bundle: ArtifactBundle,
  options?: VerifyOptions,
): MutationResult[];
export function assertAllMutationsRejected(results: MutationResult[]): true;
