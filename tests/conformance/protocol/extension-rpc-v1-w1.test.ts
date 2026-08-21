import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  createSchemaBundle,
  specRootFromModuleUrl,
} from "../../../src/schema-bundle/index.js";
import {
  createExtensionRpcV1Registry,
  loadExtensionRpcV1RegistryFile,
  ExtensionRpcV1RegistryError,
} from "../../../src/core/extension-rpc-v1/registry.js";
import {
  createExtensionRpcV1Validator,
} from "../../../src/core/extension-rpc-v1/validator.js";
import { FramedJsonChannel } from "../../../src/core/framed-json-channel.js";

/**
 * Extension RPC v1 W1 vertical slice (first no-effect method:
 * `extension.initialize`).
 *
 * Pins: fragment-aware schema validation; registry load/resolve by exact
 * method name and direction; wire `extension.initialize` params / success
 * result / error.data validation; the TST-PROTO-002 depth dispositions
 * (request params depth 65 rejected before any handler/backend, retryable
 * false, outcome not_applied, connection reusable; invalid initialize result
 * or error.data never trusted/delivered — severity: never trusted or
 * delivered — synthesized local PROTOCOL_INVALID_RESPONSE, outcome unknown,
 * protocol violation recorded, connection closed without reuse; frame depth
 * 97 unchanged); private 3.0 handshake authority untouched.
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
const SHA = (char: string): string => `sha256:${char.repeat(64)}`;
const TIMESTAMP = "2026-01-01T00:00:00.000000Z";

const OFFERED_LIMITS: Record<string, unknown> = {
  max_frame_bytes: 4_194_304,
  max_frame_nesting_depth: 96,
  max_json_nesting_depth: 64,
  max_outstanding_host_requests: 16,
  max_outstanding_extension_requests: 16,
  max_queued_outbound_bytes: 16 << 20,
  max_requests_per_second: 32,
  max_notifications_per_second: 32,
};

function validInitializeRequest(): Record<string, unknown> {
  return {
    worker_epoch: UUID,
    extension_alias: "fixture-alias",
    extension_generation: 1,
    expected_extension_id: "com.example.fixture",
    expected_extension_version: "1.0.0",
    expected_package_digest: SHA("a"),
    config_revision: 1,
    extension_config: {},
    extension_config_digest: SHA("b"),
    extension_config_schema_digest: SHA("c"),
    offered_protocols: [{ major: 1, minor: 0 }],
    offered_limits: { ...OFFERED_LIMITS },
    granted_host_services: [],
    expected_modules: [],
    storage_handles: [],
    host: {
      implementation: "dolly",
      implementation_version: "1.0.0",
      spec_version: "0.1.0-draft",
      supported_sdk_abis: ["ts"],
    },
    deadline: TIMESTAMP,
  };
}

function validInitializeResult(): Record<string, unknown> {
  return {
    extension_id: "com.example.fixture",
    extension_version: "1.0.0",
    package_digest: SHA("a"),
    worker_epoch: UUID,
    extension_generation: 1,
    config_revision: 1,
    extension_config_digest: SHA("b"),
    extension_config_schema_digest: SHA("c"),
    selected_protocol: { major: 1, minor: 0 },
    effective_limits: { ...OFFERED_LIMITS },
    supported_module_types: ["fixture"],
    state_schemas: [1],
    sdk_abi: "ts",
    ledger_bindings: [],
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

/**
 * The value root at depth 1; a value with `containers` nested containers
 * sits at container depth `containers`.
 */
function nestValue(containers: number): unknown {
  let v: unknown = 0;
  for (let i = 0; i < containers; i += 1) v = { k: v };
  return v;
}

describe("extension RPC v1 registry load and exact resolution", () => {
  it("loads the registry file and freezes the semantic-depth policy", () => {
    expect(REGISTRY.schema).toBe("dolly.extension-rpc-registry/v1");
    expect(REGISTRY.protocol).toEqual({ major: 1, minor: 0 });
    expect(REGISTRY.semanticDepth).toEqual({
      max_json_nesting_depth: 64,
      root_depth: 1,
      rpc_envelope_counted: false,
      declared_schema_roots: [
        "request_params",
        "notification_params",
        "success_result",
        "error_data",
      ],
    });
  });

  it("resolves a request by exact method name", () => {
    const row = REGISTRY.resolve("extension.initialize", "request");
    expect(row.method).toBe("extension.initialize");
    expect(row.caller).toBe("host");
    expect(row.params_schema).toBe(
      "https://dolly.example/spec/0.1/schemas/extension-initialize-request.schema.json",
    );
  });

  it("resolves notifications by exact method name", () => {
    const row = REGISTRY.resolve("host.log.emit", "notification");
    expect(row.method).toBe("host.log.emit");
    expect(row.caller).toBe("extension");
  });

  it("rejects a method in the wrong direction", () => {
    try {
      REGISTRY.resolve("extension.initialize", "notification");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ExtensionRpcV1RegistryError);
      expect((error as ExtensionRpcV1RegistryError).code).toBe("RPC_METHOD_DIRECTION_MISMATCH");
    }
  });

  it("rejects an unknown method name", () => {
    try {
      REGISTRY.resolve("extension.instantiate", "request");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ExtensionRpcV1RegistryError);
      expect((error as ExtensionRpcV1RegistryError).code).toBe("RPC_METHOD_NOT_FOUND");
    }
  });

  it("matches the exact method name, not a prefix or a variant", () => {
    for (const bogus of ["extension.initialize!", "extension.initialize extra", "extension.initializee"]) {
      for (const direction of ["request", "notification"] as const) {
        try {
          REGISTRY.resolve(bogus, direction);
          expect.unreachable();
        } catch (error) {
          expect((error as ExtensionRpcV1RegistryError).code).toBe("RPC_METHOD_NOT_FOUND");
        }
      }
    }
  });

  it("rejects structurally invalid registry documents at load time", () => {
    expect(() => createExtensionRpcV1Registry({ schema: "nope" })).toThrow(
      ExtensionRpcV1RegistryError,
    );
  });
});

describe("wire extension.initialize params validation (request side)", () => {
  it("accepts a conforming initialize request params value", () => {
    const decision = VALIDATOR.validateRequestParams("extension.initialize", validInitializeRequest());
    expect(decision).toEqual({ accepted: true });
  });

  it("accepts initialize request params at the semantic depth ceiling (depth 64)", () => {
    const request = validInitializeRequest();
    request.extension_config = nestValue(63); // member at root depth 2 + 62 nested = 64
    const decision = VALIDATOR.validateRequestParams("extension.initialize", request);
    expect(decision).toEqual({ accepted: true });
  });

  it("rejects initialize request params nested to depth 65 before any handler or backend", () => {
    const request = validInitializeRequest();
    request.extension_config = nestValue(64); // member at root depth 2 + 63 nested = 65
    const decision = VALIDATOR.validateRequestParams("extension.initialize", request);
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

  it("rejects schema-nonconforming initialize params with -32602 invalid params", () => {
    const request = validInitializeRequest();
    request.expected_package_digest = "sha256:GG";
    const decision = VALIDATOR.validateRequestParams("extension.initialize", request);
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.jsonrpc_error).toBe(-32602);
      expect(decision.error.name).toBe("RPC_INVALID_PARAMS");
      expect(decision.connection_reusable).toBe(true);
    }
  });

  it("does not know a request-direction check that is a notification", () => {
    try {
      VALIDATOR.validateRequestParams("host.log.emit", {});
      expect.unreachable();
    } catch (error) {
      expect((error as ExtensionRpcV1RegistryError).code).toBe("RPC_METHOD_DIRECTION_MISMATCH");
    }
  });
});

describe("wire extension.initialize response validation (result / error.data)", () => {
  it("accepts a conforming initialize success result", () => {
    const decision = VALIDATOR.validateSuccessResult("extension.initialize", validInitializeResult());
    expect(decision).toEqual({ accepted: true });
  });

  it("does not deliver a depth-65 initialize result; local PROTOCOL_INVALID_RESPONSE/unknown; closes and records violation", () => {
    const decision = VALIDATOR.validateSuccessResult("extension.initialize", nestValue(65));
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

  it("does not deliver a schema-nonconforming initialize result; same closed disposition", () => {
    const result = validInitializeResult();
    result.extension_id = "";
    const decision = VALIDATOR.validateSuccessResult("extension.initialize", result);
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.local_error.name).toBe("PROTOCOL_INVALID_RESPONSE");
      expect(decision.local_error.outcome).toBe("unknown");
      expect(decision.result_delivered).toBe(false);
      expect(decision.connection_reusable).toBe(false);
      expect(decision.replay_permitted).toBe(false);
      expect(decision.new_identity_permitted).toBe(false);
    }
  });

  it("accepts conforming initialize error.data", () => {
    const decision = VALIDATOR.validateErrorData("extension.initialize", validErrorData());
    expect(decision).toEqual({ accepted: true });
  });

  it("never trusts nor delivers a depth-65 initialize error.data; local PROTOCOL_INVALID_RESPONSE/unknown", () => {
    const decision = VALIDATOR.validateErrorData("extension.initialize", nestValue(65));
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.promote).toBe(false);
      expect(decision.local_error.name).toBe("PROTOCOL_INVALID_RESPONSE");
      expect(decision.local_error.retryable).toBe(false);
      expect(decision.local_error.outcome).toBe("unknown");
      expect(decision.connection_reusable).toBe(false);
      expect(decision.protocol_violation).toBe(true);
    }
  });

  it("never trusts a schema-nonconforming error.data (missing required member)", () => {
    const decision = VALIDATOR.validateErrorData("extension.initialize", {
      code: "ACTIVATION_STALE_LEASE",
      retryable: false,
      message: "x",
    });
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.promote).toBe(false);
      expect(decision.connection_reusable).toBe(false);
    }
  });

  it("does not validate results or error.data for unregistered methods", () => {
    try {
      VALIDATOR.validateSuccessResult("nonexistent.method", {});
      expect.unreachable();
    } catch (error) {
      expect((error as ExtensionRpcV1RegistryError).code).toBe("RPC_METHOD_NOT_FOUND");
    }
  });
});

describe("TST-PROTO-002 isolated depth cases (request/notification/responses)", () => {
  it("request: root over limit -> -32602 RPC_INVALID_PARAMS, false/not_applied, reusable", () => {
    const request = validInitializeRequest();
    request.extension_config = nestValue(64);
    const d = VALIDATOR.validateRequestParams("extension.initialize", request);
    expect(d.accepted).toBe(false);
    if (!d.accepted) {
      expect(d.jsonrpc_error).toBe(-32602);
      expect(d.error.name).toBe("RPC_INVALID_PARAMS");
    }
  });

  it("notification: root over limit -> local diagnostic, no wire response, reusable", () => {
    const d = VALIDATOR.validateNotificationParams("host.log.emit", nestValue(65));
    expect(d.accepted).toBe(false);
    if (!d.accepted) {
      expect(d.wire_response).toBe(false);
      expect(d.error.name).toBe("RPC_INVALID_PARAMS");
      expect(d.error.retryable).toBe(false);
      expect(d.error.outcome).toBe("not_applied");
      expect(d.method_handler_invocations).toBe(0);
      expect(d.backend_dispatches).toBe(0);
      expect(d.connection_reusable).toBe(true);
    }
  });

  it("notification: conforming params accepted", () => {
    const d = VALIDATOR.validateNotificationParams("host.log.emit", {
      event_id: UUID,
      module_id: "mod-a",
      level: "info",
      message: "hi",
      fields: {},
      observed_at: TIMESTAMP,
    });
    expect(d).toEqual({ accepted: true });
  });

  it("success result: root over limit -> PROTOCOL_INVALID_RESPONSE unknown, closes", () => {
    const d = VALIDATOR.validateSuccessResult("extension.initialize", nestValue(65));
    expect(d.accepted).toBe(false);
    if (!d.accepted) {
      expect(d.local_error.name).toBe("PROTOCOL_INVALID_RESPONSE");
      expect(d.local_error.outcome).toBe("unknown");
      expect(d.connection_reusable).toBe(false);
    }
  });

  it("error data: root over limit -> PROTOCOL_INVALID_RESPONSE unknown, closes", () => {
    const d = VALIDATOR.validateErrorData("extension.initialize", nestValue(65));
    expect(d.accepted).toBe(false);
    if (!d.accepted) {
      expect(d.local_error.name).toBe("PROTOCOL_INVALID_RESPONSE");
      expect(d.local_error.outcome).toBe("unknown");
      expect(d.connection_reusable).toBe(false);
    }
  });

  it("frame depth 97 behavior is unchanged: FRAME_TOO_DEEP, latched, not reusable", async () => {
    const inbound = new PassThrough();
    const outbound = new PassThrough();
    const messages: unknown[] = [];
    const errors: { code: string }[] = [];
    const channel = new FramedJsonChannel(inbound, outbound, {
      maxFrameBytes: 64 * 1024,
      onMessage: (message) => messages.push(message),
      onError: (error) => errors.push(error),
    });
    const text = "[".repeat(97) + "1" + "]".repeat(97);
    const payload = Buffer.from(text, "utf8");
    const bytes = Buffer.allocUnsafe(4 + payload.byteLength);
    bytes.writeUInt32BE(payload.byteLength, 0);
    payload.copy(bytes, 4);
    inbound.write(bytes);
    expect(messages).toEqual([]);
    expect(errors.map((e) => e.code)).toEqual(["FRAME_TOO_DEEP"]);
    expect(outbound.readableLength).toBe(0);
    const late = Buffer.from(
      '{"jsonrpc":"2.0","id":"late","method":"extension.ping","params":{}}',
      "utf8",
    );
    const lateBytes = Buffer.allocUnsafe(4 + late.byteLength);
    lateBytes.writeUInt32BE(late.byteLength, 0);
    late.copy(lateBytes, 4);
    inbound.write(lateBytes);
    expect(messages).toEqual([]);
    expect(outbound.readableLength).toBe(0);
    await expect(
      channel.send({ jsonrpc: "2.0", id: "s", method: "extension.ping", params: {} }),
    ).rejects.toMatchObject({ code: "FRAME_CHANNEL_CLOSED" });
    channel.close();
  });
});
