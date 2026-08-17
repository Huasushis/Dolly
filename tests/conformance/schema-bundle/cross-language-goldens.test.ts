import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CanonicalJsonError,
  canonicalJsonDigest,
  parseCanonicalJsonBytes,
} from "../../../src/schema-bundle/index.js";

/**
 * Fixture-path self-consistency evidence mirroring the Rust
 * `crates/dolly-schema/tests/cross_language_goldens.rs` suite.
 *
 * The authoritative fixtures are consumed in place from the imported
 * `dolly-spec` snapshot; they are never copied or edited here. Each declared
 * `effective_config_digest` / `manifest_digest` is recomputed with the product
 * TypeScript canonicalizer and must match the bytes baked into the fixture.
 */

const SPEC_ROOT = path.resolve(import.meta.dirname, "../../../dolly-spec");

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function readFixtureTestVector(rel: string): Record<string, unknown> {
  const parsed = parseCanonicalJsonBytes(
    readFileSync(path.join(SPEC_ROOT, rel)),
    { maxBytes: 2 * 1024 * 1024, maxDepth: 128 },
  );
  return assertObject(parsed, `fixture ${rel}`);
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

describe("fixture-path effective-config digest self-consistency", () => {
  it("TST-CORE-016 baked-in legacy and current effective_config digests match recomputed JCS digests", () => {
    const vector = readFixtureTestVector(
      "test-vectors/core/TST-CORE-016-frozen-effective-config-generation.json",
    );
    const initial = assertObject(vector.initial, "initial");
    const activationManifest = assertObject(
      assertObject(initial.activation, "activation").manifest,
      "activation.manifest",
    );

    const legacyDeclared = assertString(
      activationManifest.effective_config_digest,
      "effective_config_digest",
    );
    expect(legacyDeclared).toMatch(DIGEST_PATTERN);
    expect(canonicalJsonDigest(activationManifest.effective_config)).toBe(legacyDeclared);

    const current = assertObject(initial.current_module_config, "current_module_config");

    const currentDeclared = assertString(current.effective_config_digest, "effective_config_digest");
    expect(currentDeclared).toMatch(DIGEST_PATTERN);
    expect(canonicalJsonDigest(current.effective_config)).toBe(currentDeclared);

    expect(legacyDeclared).not.toBe(currentDeclared);
  });

  it("protocol valid-module-activate effective_config and manifest digests match recomputed values", () => {
    const manifest = assertObject(
      assertObject(
        assertObject(
          readFixtureTestVector("protocol/examples/valid-module-activate.json"),
          "fixture",
        ).params,
        "params",
      ).manifest,
      "manifest",
    );

    const configDigest = assertString(manifest.effective_config_digest, "effective_config_digest");
    expect(configDigest).toMatch(DIGEST_PATTERN);
    expect(canonicalJsonDigest(manifest.effective_config)).toBe(configDigest);

    // manifest_digest omits its own field exactly as the spec requires.
    const declaredManifestDigest = assertString(manifest.manifest_digest, "manifest_digest");
    expect(declaredManifestDigest).toMatch(DIGEST_PATTERN);
    const withoutDigest: Record<string, unknown> = { ...manifest };
    delete withoutDigest.manifest_digest;
    expect(canonicalJsonDigest(withoutDigest)).toBe(declaredManifestDigest);
  });

  it("protocol invalid-duplicate-key is rejected as a malformed representation (authoritative fixture)", () => {
    expect(() =>
      readFixtureTestVector("protocol/examples/invalid-duplicate-key.txt"),
    ).toThrowError(CanonicalJsonError);
  });
});
