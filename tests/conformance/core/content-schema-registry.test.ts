import { describe, expect, it } from "vitest";
import { BlockStore } from "../../../src/core/block-store.js";
import {
  canonicalJsonDigest,
  type JsonValue,
} from "../../../src/core/canonical-json.js";
import {
  ContentSchemaRegistrationError,
  ContentSchemaRegistrationSet,
  type ContentSchemaModule,
  type ContentSchemaRegistrationInput,
} from "../../../src/core/content-schema-registry.js";
import { ReservedContentSchemaPolicy } from "../../../src/core/reserved-content-schema.js";

const NOW = "2026-08-10T11:00:00.000Z";
const NOTE_VALIDATOR = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: {
    text: { type: "string", minLength: 1, maxLength: 64 },
  },
} as const;

const MODULES: readonly ContentSchemaModule[] = [
  {
    moduleId: "writer-a",
    extensionId: "acme.agent",
    packageVersion: "1.0.0",
    moduleKind: "writer",
  },
  {
    moduleId: "reader-a",
    extensionId: "acme.agent",
    packageVersion: "1.0.0",
    moduleKind: "reader",
  },
  {
    moduleId: "other-writer",
    extensionId: "other.agent",
    packageVersion: "1.0.0",
    moduleKind: "writer",
  },
];

function registration(
  overrides: Partial<ContentSchemaRegistrationInput> = {},
): ContentSchemaRegistrationInput {
  return {
    source: "extension-package",
    schema: "acme.agent.note/1",
    producer: {
      extensionId: "acme.agent",
      packageVersion: "1.0.0",
      moduleKind: "writer",
    },
    validator: NOTE_VALIDATOR,
    validatorDigest: canonicalJsonDigest(NOTE_VALIDATOR),
    maxValueBytes: 256,
    containsCoreReferences: false,
    ...overrides,
  } as ContentSchemaRegistrationInput;
}

function registry(
  registrations: readonly ContentSchemaRegistrationInput[] = [registration()],
): ContentSchemaRegistrationSet {
  return new ContentSchemaRegistrationSet({
    modules: MODULES,
    registrations,
    maxRegisteredValueBytes: 1024,
  });
}

function proposal(schema: string, value: JsonValue) {
  return {
    payload: {
      schema: "dolly.content/1",
      value: { items: [{ type: "data", schema, value }] },
    },
  } as const;
}

function blockHarness(contentSchemas: ContentSchemaRegistrationSet) {
  let issued = 0;
  const blocks = new BlockStore({
    nextBlockId: () => `block-${(issued += 1)}`,
    now: () => NOW,
    contentSchemas,
  });
  return { blocks, issued: () => issued };
}

describe("content schema registration set", () => {
  it("permits the registered publisher and validates the pinned value", () => {
    const harness = blockHarness(registry());
    const block = harness.blocks.commit(
      proposal("acme.agent.note/1", { text: "hello" }),
      { kind: "module", id: "writer-a" },
    );

    expect(block.id).toBe("block-1");
    expect(harness.issued()).toBe(1);
  });

  it("derives ownership instead of accepting an asserted foreign namespace", () => {
    expect(() => registry([registration({ schema: "other.agent.note/1" })]))
      .toThrowError(expect.objectContaining({ code: "SCHEMA_NAME_NOT_OWNED" }));
  });

  it("rejects malformed names, unknown sources, and extra authority fields", () => {
    expect(() => registry([registration({ schema: "acme/1" })]))
      .toThrowError(expect.objectContaining({ code: "SCHEMA_NAME_INVALID" }));
    expect(() => registry([{
      ...registration(),
      source: "package-or-deployment",
    } as unknown as ContentSchemaRegistrationInput])).toThrowError(
      expect.objectContaining({ code: "SCHEMA_REGISTRATION_INVALID" }),
    );
    expect(() => registry([{
      ...registration(),
      trusted: true,
    } as unknown as ContentSchemaRegistrationInput])).toThrowError(
      expect.objectContaining({ code: "SCHEMA_REGISTRATION_INVALID" }),
    );
  });

  it("never lets an Extension package claim the reserved namespace", () => {
    expect(() => registry([registration({ schema: "dolly.agent.note/1" })]))
      .toThrowError(expect.objectContaining({ code: "SCHEMA_NAME_RESERVED" }));
  });

  it("lets only deployment configuration name a reserved producer", () => {
    const reserved = registration({
      source: "deployment",
      schema: "dolly.agent.note/1",
    });
    const harness = blockHarness(registry([reserved]));

    expect(() => harness.blocks.commit(
      proposal("dolly.agent.unregistered/1", { text: "no grant" }),
      { kind: "module", id: "writer-a" },
    )).toThrowError(expect.objectContaining({ code: "BLOCK_RESERVED_SCHEMA_FORBIDDEN" }));
    expect(harness.issued()).toBe(0);

    expect(harness.blocks.commit(
      proposal("dolly.agent.note/1", { text: "host granted" }),
      { kind: "module", id: "writer-a" },
    ).id).toBe("block-1");
  });

  it("binds production to package version and Module role", () => {
    const harness = blockHarness(registry());
    for (const moduleId of ["reader-a", "other-writer"]) {
      expect(() => harness.blocks.commit(
        proposal("acme.agent.note/1", { text: "forged" }),
        { kind: "module", id: moduleId },
      )).toThrowError(expect.objectContaining({ code: "BLOCK_RESERVED_SCHEMA_FORBIDDEN" }));
    }
    expect(harness.issued()).toBe(0);
  });

  it("rejects conflicting Module-role registrations in either order", () => {
    const reader = registration({
      producer: {
        extensionId: "acme.agent",
        packageVersion: "1.0.0",
        moduleKind: "reader",
      },
    });
    for (const registrations of [
      [registration(), reader],
      [reader, registration()],
    ]) {
      expect(() => registry(registrations)).toThrowError(
        expect.objectContaining({ code: "SCHEMA_REGISTRATION_CONFLICT" }),
      );
    }
  });

  it("deduplicates only byte-equivalent declarations", () => {
    expect(registry([registration(), registration()]).snapshot()).toHaveLength(1);
  });

  it("rejects validator drift and invalid validators", () => {
    expect(() => registry([registration({
      validatorDigest: `sha256:${"0".repeat(64)}`,
    })])).toThrowError(expect.objectContaining({ code: "SCHEMA_VALIDATOR_DRIFT" }));
    expect(() => registry([registration({
      validator: { type: "object" },
      validatorDigest: canonicalJsonDigest({ type: "object" }),
    })])).toThrowError(expect.objectContaining({ code: "SCHEMA_VALIDATOR_INVALID" }));
  });

  it("refuses invalid values and byte overflows before Block allocation", () => {
    const invalidHarness = blockHarness(registry());
    expect(() => invalidHarness.blocks.commit(
      proposal("acme.agent.note/1", { text: "", extra: true }),
      { kind: "module", id: "writer-a" },
    )).toThrowError(expect.objectContaining({ code: "SCHEMA_VALUE_INVALID" }));
    expect(invalidHarness.issued()).toBe(0);

    const boundedHarness = blockHarness(registry([registration({ maxValueBytes: 12 })]));
    expect(() => boundedHarness.blocks.commit(
      proposal("acme.agent.note/1", { text: "long enough" }),
      { kind: "module", id: "writer-a" },
    )).toThrowError(expect.objectContaining({ code: "SCHEMA_VALUE_LIMIT_EXCEEDED" }));
    expect(boundedHarness.issued()).toBe(0);
  });

  it("leaves an unregistered non-reserved Extension name opaque", () => {
    const harness = blockHarness(registry([]));
    expect(harness.blocks.commit(
      proposal("vendor.opaque/1", { arbitrary: [1, 2, 3] }),
      { kind: "module", id: "other-writer" },
    ).id).toBe("block-1");
  });

  it("rejects registrations that claim unsupported embedded Core references", () => {
    expect(() => registry([{
      ...registration(),
      containsCoreReferences: true,
    } as unknown as ContentSchemaRegistrationInput])).toThrowError(
      expect.objectContaining({ code: "SCHEMA_REGISTRATION_INVALID" }),
    );
  });

  it("does not accept unrelated or duplicate Module identities", () => {
    expect(() => new ContentSchemaRegistrationSet({
      modules: MODULES,
      registrations: [registration({
        producer: {
          extensionId: "missing.agent",
          packageVersion: "1.0.0",
          moduleKind: "writer",
        },
        schema: "missing.agent.note/1",
      })],
      maxRegisteredValueBytes: 1024,
    })).toThrowError(expect.objectContaining({ code: "SCHEMA_REGISTRATION_INVALID" }));
    expect(() => new ContentSchemaRegistrationSet({
      modules: [...MODULES, MODULES[0]!],
      registrations: [],
      maxRegisteredValueBytes: 1024,
    })).toThrowError(expect.objectContaining({ code: "SCHEMA_REGISTRATION_CONFLICT" }));
  });

  it("does not combine the complete set with the interim reserved policy", () => {
    expect(() => new BlockStore({
      nextBlockId: () => "block-1",
      now: () => NOW,
      contentSchemas: registry(),
      reservedContentSchemas: new ReservedContentSchemaPolicy(),
    })).toThrow(/cannot combine/u);
  });

  it("reports a closed, deterministic metadata snapshot", () => {
    const snapshot = registry().snapshot();
    expect(snapshot).toEqual([
      expect.objectContaining({
        source: "extension-package",
        schema: "acme.agent.note/1",
        validatorDigest: canonicalJsonDigest(NOTE_VALIDATOR),
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("validate");
    expect(Object.isFrozen(snapshot[0])).toBe(true);
  });

  it("surfaces registration errors as typed failures", () => {
    expect(() => registry([registration({ maxValueBytes: 2048 })])).toThrowError(
      expect.any(ContentSchemaRegistrationError),
    );
  });
});
