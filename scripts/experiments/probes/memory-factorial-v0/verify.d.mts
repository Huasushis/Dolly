import type { ArtifactBundle, ValidationResult } from "./types.d.mts";

export interface VerifyOptions {
  enforceFrozenHashes?: boolean;
}
export function verifyBundle(
  bundle: ArtifactBundle,
  options?: VerifyOptions,
): ValidationResult;
export function readArtifactDirectory(directory: string): {
  bundle: ArtifactBundle;
  exactErrors: string[];
};
export function verifyArtifactDirectory(
  directory: string,
  options?: VerifyOptions,
): ValidationResult;
