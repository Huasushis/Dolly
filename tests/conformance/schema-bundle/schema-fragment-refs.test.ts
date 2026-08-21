import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  createSchemaBundle,
  specRootFromModuleUrl,
} from "../../../src/schema-bundle/index.js";

/**
 * Fragment-aware schema validation (Extension RPC v1 W1 slice).
 *
 * The extension-rpc-v1.registry.json references params and result contracts
 * both as whole files and as Draft 2020-12 `$defs` fragments, e.g.
 * `extension-lifecycle-rpc.schema.json#/$defs/ExtensionPingParams`. The
 * schema bundle must validate a value directly against the pointed-to
 * sub-schema, preserving the base document as the `$ref` resolution root so
 * local references such as `host-operation-status.schema.json#/$defs/
 * OperationStatusParams` -> `#/$defs/TargetMethod` still resolve.
 */

const SPEC_DIR = specRootFromModuleUrl(import.meta.url);
const BUNDLE = createSchemaBundle({ schemasDir: join(SPEC_DIR, "schemas") });

const UUID = "0198ab31-6c44-7e8a-b2bb-000000000001";
const TIMESTAMP = "2026-01-01T00:00:00.000000Z";

function validPingParams(): Record<string, unknown> {
  return {
    operation_id: UUID,
    worker_epoch: "0198ab31-6c44-7e8a-b2bb-000000000002",
    extension_generation: 7,
    sent_at: TIMESTAMP,
    deadline: TIMESTAMP,
  };
}

describe("schema bundle fragment references (registry $defs resolution)", () => {
  it("resolves the base document id of a fragment reference", () => {
    expect(
      BUNDLE.resolveId(
        "extension-lifecycle-rpc.schema.json#/$defs/ExtensionPingParams",
      ),
    ).toBe("https://dolly.example/spec/0.1/schemas/extension-lifecycle-rpc.schema.json");
  });

  it("validates params against a $defs fragment (ExtensionPingParams)", () => {
    const result = BUNDLE.validate(
      "extension-lifecycle-rpc.schema.json#/$defs/ExtensionPingParams",
      validPingParams(),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects params missing a fragment-required member", () => {
    const params = validPingParams();
    delete params.deadline;
    const result = BUNDLE.validate(
      "extension-lifecycle-rpc.schema.json#/$defs/ExtensionPingParams",
      params,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === "SCHEMA_VALUE_INVALID")).toBe(true);
  });

  it("rejects a malformed cross-file value inside a fragment (common UuidV7)", () => {
    const params = validPingParams();
    params.operation_id = "not-a-uuid";
    const result = BUNDLE.validate(
      "extension-lifecycle-rpc.schema.json#/$defs/ExtensionPingParams",
      params,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === "SCHEMA_VALUE_INVALID")).toBe(true);
  });

  it("resolves local #/$defs references inside the selected fragment", () => {
    // host-operation-status OperationStatusParams references
    // #/$defs/TargetMethod; the base document must stay the $ref root.
    const params = {
      operation_id: UUID,
      module_id: "mod-a",
      target_operation_id: "0198ab31-6c44-7e8a-b2bb-000000000003",
      target_method: "host.model.invoke",
      deadline: TIMESTAMP,
    };
    const result = BUNDLE.validate(
      "host-operation-status.schema.json#/$defs/OperationStatusParams",
      params,
    );
    expect(result.valid).toBe(true);
  });

  it("rejects a local #/$defs reference value outside the closed enum", () => {
    const params = {
      operation_id: UUID,
      module_id: "mod-a",
      target_operation_id: "0198ab31-6c44-7e8a-b2bb-000000000003",
      target_method: "extension.initialize",
      deadline: TIMESTAMP,
    };
    const result = BUNDLE.validate(
      "host-operation-status.schema.json#/$defs/OperationStatusParams",
      params,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === "SCHEMA_VALUE_INVALID")).toBe(true);
  });

  it("treats an unknown base document as SCHEMA_NOT_FOUND, not a throw", () => {
    const result = BUNDLE.validate(
      "does-not-exist.schema.json#/$defs/X",
      { a: 1 },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe("SCHEMA_NOT_FOUND");
  });

  it("treats an unresolved fragment pointer as SCHEMA_NOT_FOUND, not a throw", () => {
    const result = BUNDLE.validate(
      "extension-lifecycle-rpc.schema.json#/$defs/NoSuchFragment",
      { a: 1 },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe("SCHEMA_NOT_FOUND");
  });

  it("rejects a non-canonical value before fragment schema validation (CORE_INVALID_JSON)", () => {
    const result = BUNDLE.validate(
      "extension-lifecycle-rpc.schema.json#/$defs/ExtensionPingParams",
      { operation_id: "bad\u0000", worker_epoch: "\ud800", extension_generation: 1, sent_at: TIMESTAMP, deadline: TIMESTAMP },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe("CORE_INVALID_JSON");
  });

  it("enforces the semantic root depth budget on a fragment-selected root", () => {
    function nestValue(depth: number): unknown {
      let v: unknown = 0;
      for (let i = 0; i < depth; i += 1) v = { k: v };
      return v;
    }
    // depth limit 64: 64 containers valid (root container at depth 1), 65
    // invalid. The PingParams schema rejects the extra member, but the depth
    // budget must fire first and is what distinguishes 64 from 65.
    const atLimit = { ...validPingParams(), extra: nestValue(63) };
    const overLimit = { ...validPingParams(), extra: nestValue(64) };
    const at = BUNDLE.validate(
      "extension-lifecycle-rpc.schema.json#/$defs/ExtensionPingParams",
      atLimit,
    );
    expect(at.errors.some((error) => error.code === "CORE_INVALID_JSON")).toBe(false);
    const over = BUNDLE.validate(
      "extension-lifecycle-rpc.schema.json#/$defs/ExtensionPingParams",
      overLimit,
    );
    expect(over.valid).toBe(false);
    expect(over.errors[0]?.code).toBe("CORE_INVALID_JSON");
  });
});
