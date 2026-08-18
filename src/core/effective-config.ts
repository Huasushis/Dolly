/**
 * Deterministic shallow overlay for a resolved Module effective configuration.
 *
 * Implements control-plane configuration §1.1 (`REQ-CFG-003`, `REQ-CFG-005`):
 * one deterministic, shallow overlay of the Extension-level object and the
 * Module object. Module top-level members replace or insert Extension members
 * in their entirety; there is no recursive object merge, arrays are replaced
 * (never concatenated), and JSON `null` is an ordinary replacement value, not a
 * delete instruction. Absent members inherit; present members always replace.
 *
 * Sources are never mutated. Both sources must be closed JSON objects (`JsonValue`
 * with object root); the resolved object is validated against the same profile
 * (no NaN, infinity, negative zero, `undefined`, functions, class instances,
 * cycles, or unpaired surrogates) before digesting. The digest is the JCS
 * (RFC 8785) SHA-256 of the resolved object via the existing canonical-json
 * layer, emitted as `sha256:<64 hex>`.
 */

import {
  assertJsonValue,
  canonicalJsonDigest,
  isJsonObject,
  type JsonValue,
} from "./canonical-json.js";

/** Maximum allowed top-level members of one resolved Module effective config. */
export const EFFECTIVE_CONFIG_MAX_PROPERTIES = 1024;

/** Failure codes for effective-config resolution. */
export type EffectiveConfigErrorCode =
  | "EFFECTIVE_CONFIG_SOURCE_INVALID"
  | "EFFECTIVE_CONFIG_MAX_PROPERTIES";

/** Error thrown when an effective config cannot be resolved per §1.1. */
export class EffectiveConfigError extends Error {
  readonly code: EffectiveConfigErrorCode;

  constructor(code: EffectiveConfigErrorCode, message: string) {
    super(message);
    this.name = "EffectiveConfigError";
    this.code = code;
  }
}

/**
 * The resolved Module effective object and its JCS digest. Effective child
 * values are shared by reference with the validated sources, which are never
 * mutated by this module; callers must treat the result as immutable to
 * preserve the digest contract.
 */
export interface EffectiveConfigOverlay {
  readonly effectiveConfig: Readonly<Record<string, JsonValue>>;
  readonly digest: string;
}

function assertSourceObject(
  value: unknown,
  path: string,
  label: string,
): asserts value is Readonly<Record<string, JsonValue>> {
  try {
    assertJsonValue(value, path);
  } catch (error) {
    if (error instanceof EffectiveConfigError) throw error;
    throw new EffectiveConfigError(
      "EFFECTIVE_CONFIG_SOURCE_INVALID",
      `${label} configuration is not closed JSON: ${(error as Error).message}`,
    );
  }
  if (!isJsonObject(value)) {
    throw new EffectiveConfigError(
      "EFFECTIVE_CONFIG_SOURCE_INVALID",
      `${label} configuration must be a JSON object`,
    );
  }
}

/**
 * Compute the shallow overlay `effective_config(m)` and its JCS digest.
 *
 * Overlay is a pure function of the two sources: extension members first, then
 * Module members replace or insert. Any resolved object above
 * {@link EFFECTIVE_CONFIG_MAX_PROPERTIES} members is rejected before return,
 * mirroring the candidate rejection that must precede revision commit.
 */
export function normalizeEffectiveConfig(
  extensionConfig: unknown,
  moduleConfig: unknown,
): EffectiveConfigOverlay {
  assertSourceObject(extensionConfig, "$.extension_config", "Extension");
  assertSourceObject(moduleConfig, "$.module_config", "Module");

  const overlay: Record<string, JsonValue> = {};
  for (const key of Object.keys(extensionConfig)) {
    overlay[key] = extensionConfig[key]!;
  }
  for (const key of Object.keys(moduleConfig)) {
    overlay[key] = moduleConfig[key]!;
  }

  const memberCount = Object.keys(overlay).length;
  if (memberCount > EFFECTIVE_CONFIG_MAX_PROPERTIES) {
    throw new EffectiveConfigError(
      "EFFECTIVE_CONFIG_MAX_PROPERTIES",
      `resolved effective_config has ${memberCount} top-level members, exceeding the ${EFFECTIVE_CONFIG_MAX_PROPERTIES} limit`,
    );
  }

  return { effectiveConfig: overlay, digest: canonicalJsonDigest(overlay) };
}
