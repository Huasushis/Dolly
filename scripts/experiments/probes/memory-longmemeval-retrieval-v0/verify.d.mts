export function verifyCore(
  directory: string,
  options?: { readonly validateChecksum?: boolean; readonly validateAttestations?: boolean },
): Readonly<{ valid: boolean; classification: string | null; primaryCode: string | null; errors: readonly string[] }>;
export function validationArtifact(result: ReturnType<typeof verifyCore>): Readonly<Record<string, unknown>>;
export function secretSentinelForMutation(): string;
export function recomputeTreatmentForTest(
  input: Record<string, unknown>,
  selectedWeights?: Readonly<Record<string, number>>,
): readonly Record<string, unknown>[];
