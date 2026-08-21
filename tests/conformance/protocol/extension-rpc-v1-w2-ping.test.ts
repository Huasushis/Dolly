import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  createSchemaBundle,
  specRootFromModuleUrl,
} from "../../../src/schema-bundle/index.js";
import {
  createExtensionRpcV1Registry,
  loadExtensionRpcV1RegistryFile,
  ExtensionRpcV1RegistryError,
  type ExtensionRpcV1RequestMethod,
} from "../../../src/core/extension-rpc-v1/registry.js";
import {
  createExtensionRpcV1Validator,
} from "../../../src/core/extension-rpc-v1/validator.js";

/**
 * Extension RPC v1 W2 (test-only): `extension.ping` through the same generic
 * validator and frozen registry as W1, with no source changes.
 *
 * Pins the closed dispositions for the read-only liveness probe:
 * - exact request-direction resolution and wrong-direction rejection
 *   (registry and validator both reject `extension.ping` as a notification);
 * - conforming params / success result / error.data are accepted;
 * - the depth budget is exercised on the roots where it is constructible:
 *   request params beyond depth 65 reject as -32602 `RPC_INVALID_PARAMS`
 *   with `retryable: false`, `outcome: not_applied`, zero handler/backend
 *   invocations and a reusable connection; success result beyond depth 65 or
 *   with a non-`alive` state, and error.data beyond depth 65, are never
 *   trusted or delivered (local `PROTOCOL_INVALID_RESPONSE`, `outcome:
 *   unknown`, connection closed, violation recorded, no promotion);
 * - the schema-valid depth-64 acceptance boundary is reachable on the
 *   `error.data` root (`details` admits nested containers) and is pinned
 *   here; ExtensionPingParams/ExtensionPingResult are flat
 *   (`additionalProperties: false`, primitive members only), so a
 *   schema-conforming ping params or result cannot exceed container depth 1
 *   and `missing sent_at` is the params-side schema rejection.
 */

const SPEC_DIR = specRootFromModuleUrl(import.meta.url);
const SCHEMAS_DIR = join(SPEC_DIR, "schemas");
const PROTOCOL_DIR = join(SPEC_DIR, "protocol");
const REGISTRY_PATH = join(PROTOCOL_DIR, "extension-rpc-v1.registry.json");

const BUNDLE = createSchemaBundle({ schemasDir: SCHEMAS_DIR });
const REGISTRY = loadExtensionRpcV1RegistryFile(REGISTRY_PATH);
const VALIDATOR = createExtensionRpcV1Validator({
  registry: REGISTRY,
  schemaBundle: BUNDLE,
});

const UUID = "0198ab31-6c44-7e8a-b2bb-000000000001";
const TIMESTAMP = "2026-01-01T00:00:00.000000Z";

function nestValue(containers: number): unknown {
  let v: unknown = 0;
  for (let i = 0; i < containers; i += 1) v = { k: v };
  return v;
}

function validPingParams(): Record<string, unknown> {
  return {
    operation_id: UUID,
    worker_epoch: "0198ab31-6c44-7e8a-b2bb-000000000002",
    extension_generation: 7,
    sent_at: TIMESTAMP,
    deadline: TIMESTAMP,
  };
}

function validPingResult(): Record<string, unknown> {
  return {
    operation_id: UUID,
    worker_epoch: "0198ab31-6c44-7e8a-b2bb-000000000002",
    extension_generation: 7,
    state: "alive",
    received_at: TIMESTAMP,
  };
}

function validErrorData(): Record<string, unknown> {
  return {
    code: "ACTIVATION_STALE_LEASE",
    retryable: false,
    outcome: "unknown",
    message: "stale lease",
    details: {},
  };
}

describe("extension RPC v1 registry: exact extension.ping request direction", () => {
  it("resolves extension.ping as a request with caller host and ping contracts", () => {
    // resolve() returns the request/notification union; the request callers
    // must be narrowed to the request shape to read request-only members.
    const row = REGISTRY.resolve("extension.ping", "request") as ExtensionRpcV1RequestMethod;
    expect(row.method).toBe("extension.ping");
    expect(row.caller).toBe("host");
    expect(row.params_schema).toBe(
      "https://dolly.example/spec/0.1/schemas/extension-lifecycle-rpc.schema.json#/$defs/ExtensionPingParams",
    );
    expect(row.result_schema).toBe(
      "https://dolly.example/spec/0.1/schemas/extension-lifecycle-rpc.schema.json#/$defs/ExtensionPingResult",
    );
    expect(row.state_changing).toBe(false);
    expect(row.reconciliation).toEqual({ kind: "read_retry", method: null });
    expect(row.unknown_policy).toBe("read_retry");
    expect(row.deadline).toEqual({ kind: "params_pointer", pointer: "/deadline" });
    expect(row.operation_identity).toEqual({
      scope: "extension_process",
      pointers: ["/operation_id"],
    });
  });

  it("rejects extension.ping in the notification direction (RPC_METHOD_DIRECTION_MISMATCH)", () => {
    try {
      REGISTRY.resolve("extension.ping", "notification");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ExtensionRpcV1RegistryError);
      expect((error as ExtensionRpcV1RegistryError).code).toBe("RPC_METHOD_DIRECTION_MISMATCH");
    }
  });

  it("validator refuses to validate extension.ping notification params (wrong direction)", () => {
    try {
      VALIDATOR.validateNotificationParams("extension.ping", validPingParams());
      expect.unreachable();
    } catch (error) {
      expect((error as ExtensionRpcV1RegistryError).code).toBe("RPC_METHOD_DIRECTION_MISMATCH");
    }
  });
});

describe("wire extension.ping params validation (request side)", () => {
  it("accepts conforming ping params", () => {
    const decision = VALIDATOR.validateRequestParams("extension.ping", validPingParams());
    expect(decision).toEqual({ accepted: true });
  });

  it("rejects ping params missing sent_at as -32602 RPC_INVALID_PARAMS, not applied, reusable", () => {
    const params = validPingParams();
    delete params.sent_at;
    const decision = VALIDATOR.validateRequestParams("extension.ping", params);
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.jsonrpc_error).toBe(-32602);
      expect(decision.error.name).toBe("RPC_INVALID_PARAMS");
      expect(decision.error.retryable).toBe(false);
      expect(decision.error.outcome).toBe("not_applied");
      expect(decision.error.details).toEqual(expect.objectContaining({ error_name: "invalid_params" }));
      expect(decision.method_handler_invocations).toBe(0);
      expect(decision.backend_dispatches).toBe(0);
      expect(decision.connection_reusable).toBe(true);
    }
  });

  it("rejects ping params nested to depth 65 before any handler or backend, reusable", () => {
    const params = { ...validPingParams(), extra: nestValue(64) };
    const decision = VALIDATOR.validateRequestParams("extension.ping", params);
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.jsonrpc_error).toBe(-32602);
      expect(decision.error.name).toBe("RPC_INVALID_PARAMS");
      expect(decision.error.retryable).toBe(false);
      expect(decision.error.outcome).toBe("not_applied");
      expect(decision.method_handler_invocations).toBe(0);
      expect(decision.backend_dispatches).toBe(0);
      expect(decision.connection_reusable).toBe(true);
    }
  });

});

describe("wire extension.ping response validation (result / error.data)", () => {
  it("accepts a conforming ping success result (state alive)", () => {
    const decision = VALIDATOR.validateSuccessResult("extension.ping", validPingResult());
    expect(decision).toEqual({ accepted: true });
  });

  it("does not deliver a depth-65 ping result; local PROTOCOL_INVALID_RESPONSE/unknown; closes and records violation", () => {
    const decision = VALIDATOR.validateSuccessResult("extension.ping", {
      ...validPingResult(),
      extra: nestValue(64),
    });
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.local_error).toEqual({
        name: "PROTOCOL_INVALID_RESPONSE",
        retryable: false,
        outcome: "unknown",
        details: expect.objectContaining({ error_name: "invalid_response" }),
      });
      expect(decision.result_delivered).toBe(false);
      expect(decision.connection_reusable).toBe(false);
      expect(decision.replay_permitted).toBe(false);
      expect(decision.new_identity_permitted).toBe(false);
      expect(decision.protocol_violation).toBe(true);
    }
    expect(VALIDATOR.protocolViolations.map((v) => v.code)).toContain("PROTOCOL_INVALID_RESPONSE");
  });

  it("does not deliver a dead-state ping result; same closed disposition", () => {
    const decision = VALIDATOR.validateSuccessResult("extension.ping", {
      ...validPingResult(),
      state: "dead",
    });
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.local_error.name).toBe("PROTOCOL_INVALID_RESPONSE");
      expect(decision.local_error.outcome).toBe("unknown");
      expect(decision.result_delivered).toBe(false);
      expect(decision.connection_reusable).toBe(false);
      expect(decision.replay_permitted).toBe(false);
      expect(decision.new_identity_permitted).toBe(false);
      expect(decision.protocol_violation).toBe(true);
    }
  });

  it("accepts conforming ping error.data", () => {
    const decision = VALIDATOR.validateErrorData("extension.ping", validErrorData());
    expect(decision).toEqual({ accepted: true });
  });

  it("accepts error.data at the semantic depth ceiling (depth 64)", () => {
    const decision = VALIDATOR.validateErrorData("extension.ping", {
      ...validErrorData(),
      details: nestValue(63), // root error data at depth 1 + 63 nested = 64
    });
    expect(decision).toEqual({ accepted: true });
  });

  it("never trusts nor delivers depth-65 error.data; promote false, local PROTOCOL_INVALID_RESPONSE/unknown, closed", () => {
    const decision = VALIDATOR.validateErrorData("extension.ping", {
      ...validErrorData(),
      details: nestValue(64), // root error data at depth 1 + 64 nested = 65
    });
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.promote).toBe(false);
      expect(decision.local_error.name).toBe("PROTOCOL_INVALID_RESPONSE");
      expect(decision.local_error.retryable).toBe(false);
      expect(decision.local_error.outcome).toBe("unknown");
      expect(decision.connection_reusable).toBe(false);
      expect(decision.protocol_violation).toBe(true);
    }
    expect(VALIDATOR.protocolViolations.filter((v) => v.root === "error_data").length).toBeGreaterThan(0);
  });

  it("never trusts schema-nonconforming ping error.data (missing details)", () => {
    const decision = VALIDATOR.validateErrorData("extension.ping", {
      code: "ACTIVATION_STALE_LEASE",
      retryable: false,
      outcome: "unknown",
      message: "stale lease",
    });
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.promote).toBe(false);
      expect(decision.connection_reusable).toBe(false);
    }
  });
});

