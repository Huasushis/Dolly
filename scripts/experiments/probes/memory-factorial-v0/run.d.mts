import type { ArtifactBundle } from "./types.d.mts";

export const REPOSITORY_ROOT: string;
export interface FreezeOptions {
  runId?: string;
  frozenAt?: string;
  enforceRegisteredHashes?: boolean;
  enforceProtocolHash?: boolean;
}
export function prepareFreeze(options?: FreezeOptions): Record<string, unknown>;
export function createArtifactBundle(options?: FreezeOptions): ArtifactBundle;
export function bundleDigest(bundle: ArtifactBundle): string;
export function writeArtifactBundle(
  outputDirectory: string,
  options?: FreezeOptions,
): { outputDirectory: string; bundleDigest: string; cases: number };
