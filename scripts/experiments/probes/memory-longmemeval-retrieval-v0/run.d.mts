export const REPOSITORY_ROOT: string;
export const REQUIRED_SOURCE_PATHS: readonly string[];
export const CHECKSUM_FILES: readonly string[];

export function prepareFreeze(options?: {
  readonly runId?: string;
  readonly frozenAt?: string;
  readonly enforceCleanSources?: boolean;
}): Readonly<Record<string, unknown>>;

export function writeFormalRun(
  outputDirectory: string,
  options?: { readonly runId?: string },
): Promise<Readonly<{ outputDirectory: string; runId: string }>>;
