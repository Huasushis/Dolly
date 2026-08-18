/**
 * Conformance tests for the effective-config shallow overlay normalizer.
 *
 * The authoritative inputs are the imported vectors `TST-CONFIG-003` and
 * `TST-CONFIG-004` in `dolly-spec/test-vectors/config/` (kind `config`,
 * command `NormalizeEffectiveConfig`). TST-CONFIG-003 pins the exact overlay
 * result and JCS digest (REQ-CFG-003/004); TST-CONFIG-004 pins the 1,024-member
 * resolved-ceiling rejection before any revision commit or Module activation
 * (REQ-CFG-003/005, control-plane §1.1). Shallow overlay, no recursive merge,
 * no input mutation, closed JSON validation.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EFFECTIVE_CONFIG_MAX_PROPERTIES,
  EffectiveConfigError,
  normalizeEffectiveConfig,
} from "../../../src/core/effective-config.js";

const CONFIG_VECTOR_DIR = resolve(import.meta.dirname, "../../../dolly-spec/test-vectors/config");
const CONFIG_VECTOR_FILES: Record<string, string> = {
  "TST-CONFIG-003": "TST-CONFIG-003-effective-config-overlay.json",
  "TST-CONFIG-004": "TST-CONFIG-004-effective-config-property-ceiling.json",
};

/** An assertion from a config vector's `expected.assertions` list. */
export interface ConfigVectorAssertion {
  path: string;
  op: "equals" | "absent" | string;
  value: unknown;
}

/** One emitted event from a vector's `expected.emitted` list. */
export interface ConfigVectorEmission {
  event: string;
  reason?: string;
}

/** The envelope shared by config test vectors. */
export interface ConfigVector {
  test_id: string;
  initial: Record<string, unknown>;
  stimulus: Record<string, unknown>;
  expected: {
    outcome: string;
    assertions: ReadonlyArray<ConfigVectorAssertion>;
    emitted: ReadonlyArray<ConfigVectorEmission>;
    crash_label: null;
  };
}

function readConfigVector(testId: "TST-CONFIG-003" | "TST-CONFIG-004"): ConfigVector {
  const file = CONFIG_VECTOR_FILES[testId]!;
  return JSON.parse(readFileSync(resolve(CONFIG_VECTOR_DIR, file), "utf8")) as ConfigVector;
}

function resolvePath(cursor: unknown, segments: readonly string[]): unknown {
  let current = cursor;
  for (const segment of segments) {
    if (!isPlainObject(current)) {
      throw new Error(`path disappeared at ${segment}`);
    }
    current = current[segment];
  }
  return current;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Applies one vector assertion (`equals` resolves the path; `absent` requires the path to be missing). */
function applyAssertion(document: unknown, assertion: { path: string; op: string; value: unknown }): void {
  const segments = assertion.path.split("/").filter(Boolean);
  if (assertion.op === "absent") {
    let cursor: unknown = document;
    for (let index = 0; index < segments.length - 1; index += 1) {
      if (!isPlainObject(cursor)) throw new Error(`absent path ${assertion.path} already missing at ${segments[index]}`);
      cursor = cursor[segments[index]!];
    }
    const last = segments[segments.length - 1]!;
    if (isPlainObject(cursor) && last in cursor) {
      throw new Error(`absent path ${assertion.path} was present: ${JSON.stringify(cursor[last])}`);
    }
    return;
  }
  if (assertion.op !== "equals") {
    throw new Error(`unsupported assertion op ${assertion.op}`);
  }
  expect(resolvePath(document, segments), assertion.path).toEqual(assertion.value);
}

describe("TST-CONFIG-003 effective-config overlay", () => {
  it("resolves the exact shallow overlay and JCS digest from the vector", () => {
    const vector = readConfigVector("TST-CONFIG-003");
    const frozenExtension = JSON.parse(JSON.stringify(vector.initial.extension_config)) as Record<string, unknown>;
    const frozenModule = JSON.parse(JSON.stringify(vector.initial.module_config)) as Record<string, unknown>;

    const result = normalizeEffectiveConfig(vector.initial.extension_config, vector.initial.module_config);

    // Every asserted path of the imported vector holds verbatim.
    const document: Record<string, unknown> = {
      effective_config: result.effectiveConfig,
      effective_config_digest: result.digest,
      effective_config_schema_digest: vector.initial.module_schema_bundle_digest,
    };
    for (const assertion of vector.expected.assertions) {
      applyAssertion(document, assertion);
    }

    // Shallow overlay proof: module replaces `cache`/`tags`/`nullable` entirely,
    // inherited value survives, no recursive merge, no array concatenation.
    const overlay = result.effectiveConfig;
    expect(overlay.cache).toEqual({ module: true });
    expect(overlay.tags).toEqual(["module"]);
    expect(overlay.nullable).toBeNull();
    expect(overlay.inherited).toBe(1);

    // Inputs are not mutated by normalization.
    expect(vector.initial.extension_config).toEqual(frozenExtension);
    expect(vector.initial.module_config).toEqual(frozenModule);
    expect(vector.initial.extension_config).toHaveProperty("cache.shared", true);
    expect(vector.initial.extension_config).toHaveProperty("tags", ["base", "shared"]);
    expect(vector.initial.module_config).toHaveProperty("cache.module", true);
  });
});

describe("TST-CONFIG-004 effective-config property ceiling", () => {
  it("rejects an overlay whose resolved top-level member count exceeds 1,024", () => {
    const vector = readConfigVector("TST-CONFIG-004");
    expect(vector.expected.crash_label).toBeNull();
    expect(vector.expected.outcome).toBe("candidate_rejected_before_revision_commit");

    const extensionConfig: Record<string, unknown> = {};
    for (let index = 0; index < 1024; index += 1) extensionConfig[`extension-key-${index}`] = index;
    const moduleConfig: Record<string, unknown> = { "module-key": true };
    // Sources individually valid (each at its own ceiling), disjoint → 1025 resolved.
    expect(Object.keys(extensionConfig)).toHaveLength(1024);
    expect(Object.keys(moduleConfig)).toHaveLength(1);

    let rejected: EffectiveConfigError | null = null;
    try {
      normalizeEffectiveConfig(extensionConfig, moduleConfig);
    } catch (error) {
      rejected = error instanceof EffectiveConfigError ? error : null;
    }
    expect(rejected).not.toBeNull();
    expect(rejected!.code).toBe("EFFECTIVE_CONFIG_MAX_PROPERTIES");
    expect(vector.expected.emitted[0]!.reason).toBe("effective_config_max_properties");
    expect(vector.expected.emitted[0]!.event).toBe("ConfigurationCandidateRejected");
  });

  it("accepts exactly 1,024 resolved members (overlap does not double-count)", () => {
    const extensionConfig: Record<string, unknown> = {};
    for (let index = 0; index < 1024; index += 1) extensionConfig[`key-${index}`] = index;
    // Overlap alone keeps the resolved count at 1,024.
    const moduleConfig: Record<string, unknown> = { "key-0": "overridden" };
    const result = normalizeEffectiveConfig(extensionConfig, moduleConfig);
    expect(Object.keys(result.effectiveConfig)).toHaveLength(EFFECTIVE_CONFIG_MAX_PROPERTIES);
    expect(result.effectiveConfig["key-0"]).toBe("overridden");
    expect(result.effectiveConfig["key-1023"]).toBe(1023);
    for (let index = 1; index < 1024; index += 1) {
      expect(result.effectiveConfig[`key-${index}`]).toBe(index);
    }
  });

  it("rejects 1,025 resolved members from sources within their individual ceilings", () => {
    const extensionConfig: Record<string, unknown> = {};
    for (let index = 0; index < 1024; index += 1) extensionConfig[`key-${index}`] = index;
    const moduleConfig: Record<string, unknown> = {};
    for (let index = 1024; index < 1025; index += 1) moduleConfig[`key-${index}`] = true;
    expect(() => normalizeEffectiveConfig(extensionConfig, moduleConfig)).toThrowError(
      expect.objectContaining({ name: "EffectiveConfigError", code: "EFFECTIVE_CONFIG_MAX_PROPERTIES" }),
    );
  });
});

describe("effective-config closed validation", () => {
  const valid = { a: 1 };

  it("fails closed when either source is not a JSON object", () => {
    for (const bad of [[], "config", 7, null, undefined, true]) {
      expect(() => normalizeEffectiveConfig(bad as unknown, valid), `extension=${String(bad)}`).toThrowError(EffectiveConfigError);
      expect(() => normalizeEffectiveConfig(valid, bad as unknown), `module=${String(bad)}`).toThrowError(EffectiveConfigError);
    }
    for (const [extension, module, label] of [
      [[], { b: 2 }, "array extension"],
      [{ a: 1 }, ["module"], "array module"],
    ] as const) {
      try {
        normalizeEffectiveConfig(extension as unknown, module as unknown);
        throw new Error(`expected failure for ${label}`);
      } catch (error) {
        expect(error).toBeInstanceOf(EffectiveConfigError);
        expect((error as EffectiveConfigError).code).toBe("EFFECTIVE_CONFIG_SOURCE_INVALID");
      }
    }
  });

  it("fails closed on JSON-unsafe values without coercing or truncating", () => {
    const cyclicValue = (): Record<string, unknown> => {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value;
    };
    const invalidExtensionSources = [
      { nan: Number.NaN },
      { negZero: -0 },
      { infinity: Number.POSITIVE_INFINITY },
      { undefinedValue: undefined },
      { functionValue: () => 1 },
      { bigintValue: 1n },
      { classValue: new Map() },
      { deep: cyclicValue() },
      { loneSurrogate: "\ud800" },
    ];
    for (const source of invalidExtensionSources) {
      expect(() => normalizeEffectiveConfig(source, { b: 2 }), "extension source").toThrowError(EffectiveConfigError);
    }
    for (const source of [{ b: 2, unsafe: new Date() }, { cyclic: cyclicValue() }]) {
      expect(() => normalizeEffectiveConfig({ a: 1 }, source), "module source").toThrowError(EffectiveConfigError);
    }
  });

  it("does not mutate inputs under the error-free path and resolves deterministic members", () => {
    const extension = { cache: { shared: true }, inherited: 1 };
    const module = { cache: { module: true }, inserted: 2 };
    const frozenExtension = structuredClone(extension);
    const frozenModule = structuredClone(module);
    const result = normalizeEffectiveConfig(extension, module);
    expect(extension).toEqual(frozenExtension);
    expect(module).toEqual(frozenModule);
    expect(result.effectiveConfig.inserted).toBe(2);
    expect(result.effectiveConfig.inherited).toBe(1);
  });
});

describe("effective-config no reference aliasing", () => {
  function expectDeepFrozen(value: unknown, label: string): void {
    if (value === null || typeof value !== "object") return;
    expect(Object.isFrozen(value), `${label} depth`).toBe(true);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      expectDeepFrozen(child, `${label}.${key}`);
    }
  }

  it("returns inherited nested objects and arrays as deep copies, not references to the Extension object", () => {
    const extension = { nested: { shared: true }, arr: [1, 2], inherited: 1 };
    const module = { cache: { module: true } };
    const result = normalizeEffectiveConfig(extension, module);

    expect(result.effectiveConfig.nested).toEqual({ shared: true });
    expect(result.effectiveConfig.nested).not.toBe(extension.nested);
    expect(result.effectiveConfig.arr).toEqual([1, 2]);
    expect(result.effectiveConfig.arr).not.toBe(extension.arr);
    expect(Object.isExtensible(extension.nested)).toBe(true);
    expectDeepFrozen(result.effectiveConfig, "effectiveConfig");
  });

  it("returns overridden nested objects and arrays as deep copies, not references to the Module object", () => {
    const extension = { base: 1, nested: { shared: true }, arr: [1, 2] };
    const module = { nested: { module: true }, arr: [3, 4] };
    const result = normalizeEffectiveConfig(extension, module);

    expect(result.effectiveConfig.nested).toEqual({ module: true });
    expect(result.effectiveConfig.nested).not.toBe(module.nested);
    expect(result.effectiveConfig.arr).toEqual([3, 4]);
    expect(result.effectiveConfig.arr).not.toBe(module.arr);
    // The Module's original nested value is untouched.
    expect(module.nested).toEqual({ module: true });
    expect(Object.isExtensible(module.nested)).toBe(true);
    expectDeepFrozen(result.effectiveConfig, "effectiveConfig");
  });

  it("binds the digest to immutable bytes: mutation cannot alter the effective result", () => {
    const extension = { nested: { shared: true }, arr: [1, 2], inherited: 1 };
    const module = { cache: { module: true } };
    const result = normalizeEffectiveConfig(extension, module);
    const snapshotDigest = result.digest;
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Attempting to mutate the returned config must fail (frozen deep copy).
    expect(() => {
      (result.effectiveConfig.nested as Record<string, unknown>).shared = false;
    }).toThrowError(TypeError);
    expect(() => {
      (result.effectiveConfig.arr as unknown[]).push(3);
    }).toThrowError(TypeError);

    // Mutating the live Extension source afterwards cannot change the snapshot
    // or its digest; the next normalization is independent.
    extension.nested.shared = false;
    extension.arr.push(3);
    expect(result.effectiveConfig.nested).toEqual({ shared: true });
    expect(result.effectiveConfig.arr).toEqual([1, 2]);
    expect(result.effectiveConfig.nested).toHaveProperty("shared", true);
    expect(result.digest).toBe(snapshotDigest);
  });

  it("keeps sibling normalizations independent: overrides never flow back into defaults or each other", () => {
    const extension = { shared_limit: 10, nested: { base: "e" } };
    const module = { nested: { base: "m" } };
    const first = normalizeEffectiveConfig(extension, module);
    const second = normalizeEffectiveConfig({ ...extension }, { ...module });

    // Result objects are distinct deep copies — not the same reference.
    expect(first.effectiveConfig).not.toBe(second.effectiveConfig);
    expect(first.effectiveConfig.nested).not.toBe(second.effectiveConfig.nested);
    // Both calls agree on value and digest.
    expect(first).toEqual(second);

    // Upstream defaults and the first call's Module override remain unchanged.
    expect(extension).toEqual({ shared_limit: 10, nested: { base: "e" } });
    expect(module).toEqual({ nested: { base: "m" } });
    // Second normalization is unaffected by the first result's frozen state.
    expect(second.effectiveConfig.nested).toEqual({ base: "m" });
    // Extension-level value is preserved by the overlay for both.
    for (const call of [first, second]) {
      expect(call.effectiveConfig.shared_limit).toBe(10);
      expect(call.effectiveConfig.nested).toEqual({ base: "m" });
    }
  });
});
