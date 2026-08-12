export const PREREGISTRATION_PATH: string;

export function validateMemoryFactorialPreregistration(
  path?: string,
  options?: { enforceProtocolHash?: boolean },
): {
  valid: boolean;
  errors: readonly string[];
  preregistration: Record<string, any>;
};
