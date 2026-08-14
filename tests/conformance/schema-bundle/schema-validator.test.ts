import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AnySchema } from "ajv";
import {
  createSchemaBundle,
  SchemaBundleError,
  specRootFromModuleUrl,
  DEFAULT_MAX_JSON_NESTING_DEPTH,
} from "../../../src/schema-bundle/index.js";

/**
 * Schema-bundle validator conformance for Dolly Core v1.
 *
 * Loads the spec's `schemas/` corpus, validates real fixture payloads, and
 * exercises cross-schema `$ref` resolution + Core-profile pre-validation.
 */

const SPEC_DIR = specRootFromModuleUrl(import.meta.url);
const SCHEMAS_DIR = join(SPEC_DIR, "schemas");
const TEST_VECTORS_DIR = join(SPEC_DIR, "test-vectors");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

const bundle = createSchemaBundle({ schemasDir: SCHEMAS_DIR });

describe("schema bundle loading", () => {
  it("loads all *.schema.json files and registers them by $id", () => {
    const ids = bundle.schemaIds;
    const schemaFiles = readdirSync(SCHEMAS_DIR).filter((n) => n.endsWith(".schema.json"));
    expect(ids.length).toBe(schemaFiles.length);
    expect(ids.every((id) => id.startsWith("https://dolly.example/spec/0.1/schemas/"))).toBe(true);
  });

  it("resolves schema names by full $id, filename, and short name", () => {
    expect(bundle.resolveId("error.schema.json")).toBe(
      "https://dolly.example/spec/0.1/schemas/error.schema.json",
    );
    expect(bundle.resolveId("error")).toBe(
      "https://dolly.example/spec/0.1/schemas/error.schema.json",
    );
    expect(bundle.resolveId("https://dolly.example/spec/0.1/schemas/error.schema.json")).toBe(
      "https://dolly.example/spec/0.1/schemas/error.schema.json",
    );
  });

  it("rejects an unknown schema name", () => {
    expect(() => bundle.resolveId("nonexistent")).toThrow(SchemaBundleError);
    expect(() => bundle.resolveId("nonexistent")).toThrow(
      expect.objectContaining({ code: "SCHEMA_NOT_FOUND" }),
    );
  });
});

describe("cross-schema $ref resolution", () => {
  it("validates an error envelope with a valid UUIDv7 correlation_id", () => {
    const validError = {
      code: "CORE_INVALID_JSON",
      retryable: false,
      outcome: "not_applied",
      message: "duplicate key",
      correlation_id: "0198ab31-6c44-7e8a-b2bb-000000000221",
      details: {},
    };
    expect(bundle.validate("error", validError).valid).toBe(true);
  });

  it("rejects an error envelope with a malformed correlation_id (cross-$ref to common#UuidV7)", () => {
    const badError = {
      code: "CORE_INVALID_JSON",
      retryable: false,
      outcome: "not_applied",
      message: "duplicate key",
      correlation_id: "not-a-uuid",
      details: {},
    };
    const result = bundle.validate("error", badError);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "SCHEMA_VALUE_INVALID")).toBe(true);
  });
});

describe("additionalProperties: false enforcement", () => {
  it("rejects unknown members on the error schema", () => {
    const errorWithExtra = {
      code: "CORE_INVALID_JSON",
      retryable: false,
      outcome: "not_applied",
      message: "x",
      details: {},
      unknown_extra_field: true,
    };
    const result = bundle.validate("error", errorWithExtra);
    expect(result.valid).toBe(false);
  });
});

describe("Core-profile pre-validation", () => {
  it("rejects -0 with CORE_INVALID_JSON before reaching AJV", () => {
    const result = bundle.validate("error", {
      code: "CORE_INVALID_JSON",
      retryable: false,
      outcome: "not_applied",
      message: "x",
      details: { bad: -0 },
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe("CORE_INVALID_JSON");
  });

  it("rejects a lone surrogate in a string with CORE_INVALID_JSON", () => {
    const result = bundle.validate("error", {
      code: "CORE_INVALID_JSON",
      retryable: false,
      outcome: "not_applied",
      message: "\ud800",
      details: {},
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe("CORE_INVALID_JSON");
  });
});

describe("fixture payload validation", () => {
  it("validates the text-hello block-draft fixture value against block-draft.schema.json", () => {
    const fixture = readJson(
      join(TEST_VECTORS_DIR, "fixtures", "text-hello.json"),
    ) as { value: unknown };
    const result = bundle.validate("block-draft", fixture.value);
    expect(result.valid).toBe(true);
  });

  it("rejects a block-draft missing required 'parts'", () => {
    const result = bundle.validate("block-draft", {
      schema: "dolly.block-draft/v1",
      actions: [],
    });
    expect(result.valid).toBe(false);
  });
});

describe("TST-CORE vector envelope validation", () => {
  // The vector envelope schema lives in test-vectors/ alongside the vectors.
  // Load it into a dedicated bundle (schemas/ + the vector schema) and verify
  // every TST-CORE-### vector conforms to the envelope contract.
  const vectorSchemaPath = join(TEST_VECTORS_DIR, "vector.schema.json");
  const fixtureSchemaPath = join(TEST_VECTORS_DIR, "fixture.schema.json");

  // Build a bundle that includes both the spec schemas and the vector/fixture
  // schemas so their full-$id cross-references resolve.
  const combinedBundle = createSchemaBundle({ schemasDir: SCHEMAS_DIR });
  // The vector/fixture schemas reference schemas/ by absolute $id, which are
  // already registered in combinedBundle. Register them too:
  const vectorSchema = readJson(vectorSchemaPath);
  const fixtureSchema = readJson(fixtureSchemaPath);
  combinedBundle.ajv.addSchema(vectorSchema as AnySchema);
  combinedBundle.ajv.addSchema(fixtureSchema as AnySchema);

  const coreVectors = readdirSync(join(TEST_VECTORS_DIR, "core")).filter((n) =>
    n.startsWith("TST-CORE-"),
  );

  it.each(coreVectors.map((name) => [name]))(
    "validates vector envelope: %s",
    (name) => {
      const vector = readJson(join(TEST_VECTORS_DIR, "core", name));
      const fn = combinedBundle.ajv.getSchema(
        "https://dolly.example/spec/0.1/test-vectors/vector.schema.json",
      );
      expect(fn, `vector schema not found for ${name}`).toBeDefined();
      const valid = fn!(vector);
      expect(valid, JSON.stringify(combinedBundle.ajv.errors, null, 2)).toBe(true);
    },
  );

  it("validates all config vector envelopes", () => {
    const configVectors = readdirSync(join(TEST_VECTORS_DIR, "config")).filter((n) =>
      n.startsWith("TST-CONFIG-"),
    );
    for (const name of configVectors) {
      const vector = readJson(join(TEST_VECTORS_DIR, "config", name));
      const fn = combinedBundle.ajv.getSchema(
        "https://dolly.example/spec/0.1/test-vectors/vector.schema.json",
      );
      expect(fn!(vector), `config vector ${name} failed envelope validation`).toBe(true);
    }
  });
});

describe("assertValid throws on failure", () => {
  it("throws SchemaBundleError with the first error code", () => {
    expect(() => bundle.assertValid("error", { code: "bad" })).toThrow(SchemaBundleError);
    expect(() => bundle.assertValid("error", { code: "bad" })).toThrow(
      expect.objectContaining({ code: "SCHEMA_VALUE_INVALID" }),
    );
  });

  it("does not throw for valid input", () => {
    expect(() =>
      bundle.assertValid("error", {
        code: "CORE_INVALID_JSON",
        retryable: false,
        outcome: "not_applied",
        message: "ok",
        details: {},
      }),
    ).not.toThrow();
  });
});

describe("validate never-throws contract", () => {
  it("returns SCHEMA_NOT_FOUND for an unknown schema name instead of throwing", () => {
    const result = bundle.validate("nonexistent", { a: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.code).toBe("SCHEMA_NOT_FOUND");
    expect(result.errors[0]).toBeInstanceOf(SchemaBundleError);
  });

  it("returns SCHEMA_NOT_FOUND for a name that resolves to an uncompiled schema", () => {
    // A name with the .schema.json suffix that does not match any loaded file
    // must also surface as SCHEMA_NOT_FOUND, not throw.
    const result = bundle.validate("does-not-exist.schema.json", { a: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe("SCHEMA_NOT_FOUND");
  });
});

describe("duplicate $id rejection at load time", () => {
  it("rejects two schema files with the same $id deterministically", () => {
    const dir = mkdtempSync(join(tmpdir(), "dolly-dup-id-"));
    const $id = "https://dolly.example/spec/0.1/schemas/dup.schema.json";
    const schemaA = { $schema: "https://json-schema.org/draft/2020-12/schema", $id, type: "object" };
    const schemaB = { $schema: "https://json-schema.org/draft/2020-12/schema", $id, type: "string" };
    writeFileSync(join(dir, "a.schema.json"), JSON.stringify(schemaA));
    writeFileSync(join(dir, "b.schema.json"), JSON.stringify(schemaB));
    // Capture the thrown error and assert its contract directly. Vitest's
    // `.toThrow()` matcher accepts an Error subclass or an
    // `expect.objectContaining({ ... })` shape, but NOT a bare string/promise
    // matcher such as `expect.stringContaining(...)`, so asserting the message
    // that way silently never matched. Assert all three facets on one captured
    // instance instead.
    let thrown: unknown;
    try {
      createSchemaBundle({ schemasDir: dir });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SchemaBundleError);
    expect((thrown as SchemaBundleError).code).toBe("SCHEMA_INVALID");
    expect((thrown as SchemaBundleError).message).toContain("Duplicate $id");
    // The collision message names both the offending $id and both file paths
    // so the failure is explicit rather than a silent shadow registration.
    expect((thrown as SchemaBundleError).message).toContain($id);
    expect((thrown as SchemaBundleError).message).toContain("a.schema.json");
    expect((thrown as SchemaBundleError).message).toContain("b.schema.json");
  });
});

describe("value-level nesting-depth budget in validate", () => {
  // The nesting-depth budget (DEFAULT_MAX_JSON_NESTING_DEPTH = 64) is enforced
  // by assertCanonicalJsonValue over the WHOLE value passed to validate(), not
  // just the embedded `details` field. The error document itself is one object
  // { code, retryable, outcome, message, details }, so that enclosing object
  // contributes one nesting level. assertValueDepth enters the root at depth 0,
  // recurses into each member at depth 1, and a `details` chain of N objects
  // therefore bottoms out at depth 1 + N. For the whole document to sit
  // exactly at the 64-level ceiling, `details` must be N = 63 deep (the
  // innermost `details` object is reached at depth 64; its leaf is a primitive
  // and does not count). Building `details` at 64 makes the document 65 deep
  // and is rejected — which is why the boundary must be measured on the whole
  // document, not on `details` in isolation.
  function nestValue(depth: number): unknown {
    let v: unknown = 0;
    for (let i = 0; i < depth; i += 1) v = { k: v };
    return v;
  }

  it("rejects a document whose total depth exceeds 64 with CORE_INVALID_JSON", () => {
    // details at depth 64 → whole error document is depth 65 (1 enclosing
    // object + 64 nested objects) → exceeds the 64-level budget.
    const result = bundle.validate("error", {
      code: "CORE_INVALID_JSON",
      retryable: false,
      outcome: "not_applied",
      message: "deep",
      details: nestValue(DEFAULT_MAX_JSON_NESTING_DEPTH),
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe("CORE_INVALID_JSON");
  });

  it("admits a document whose total depth is exactly 64", () => {
    // details at depth 63 → whole error document is depth 64 (1 enclosing
    // object + 63 nested objects), sitting exactly at the ceiling. The value
    // is canonical-safe; the error schema may reject it for other reasons
    // (details shape), but it must NOT be rejected as CORE_INVALID_JSON.
    const result = bundle.validate("error", {
      code: "CORE_INVALID_JSON",
      retryable: false,
      outcome: "not_applied",
      message: "deep",
      details: nestValue(DEFAULT_MAX_JSON_NESTING_DEPTH - 1),
    });
    expect(result.errors.some((e) => e.code === "CORE_INVALID_JSON")).toBe(false);
  });
});
