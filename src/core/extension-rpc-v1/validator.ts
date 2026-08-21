/**
 * Extension RPC v1 message validator (validator.ts) — W1 wiring for the
 * first no-effect method (`extension.initialize`).
 *
 * The validator sits at the protocol boundary and produces one closed
 * disposition per message root, using the registry's exact method contracts
 * and the schema bundle's fragment-aware validation:
 *
 * - request `params` over the negotiated semantic depth limit (<= 64) or
 *   failing the method params schema is `-32602` `RPC_INVALID_PARAMS` with
 *   `retryable: false`, `outcome: not_applied`, zero handler/backend
 *   invocations, and a reusable connection;
 * - notification `params` failing the same checks produces the same local
 *   diagnostic with no JSON-RPC response and a reusable connection;
 * - a successful response `result` failing its schema or depth is never
 *   delivered: the caller observes the synthesized local
 *   `PROTOCOL_INVALID_RESPONSE` error with `outcome: unknown`, records a
 *   protocol violation, and the connection is closed (not reusable, no
 *   automatic replay, no fresh semantic identity);
 * - an `error.data` failing the common error schema is never trusted or
 *   delivered, and is closed under the same local
 *   `PROTOCOL_INVALID_RESPONSE` disposition.
 *
 * The private 3.0 handshake (`dolly.initialize` etc.) remains defined by the
 * extension-process-host and is untouched by this slice.
 */

import type { SchemaBundle } from "../../schema-bundle/index.js";
import {
  type ExtensionRpcV1Notification,
  type ExtensionRpcV1RequestMethod,
  type ExtensionRpcV1Registry,
  ExtensionRpcV1RegistryError,
} from "./registry.js";

export type ExtensionRpcV1ParamsError = Readonly<{
  readonly name: "RPC_INVALID_PARAMS";
  readonly retryable: false;
  readonly outcome: "not_applied";
  readonly details: Readonly<{ readonly error_name: "invalid_params"; readonly message: string }>;
}>;

export type ExtensionRpcV1ResponseError = Readonly<{
  readonly name: "PROTOCOL_INVALID_RESPONSE";
  readonly retryable: false;
  readonly outcome: "unknown";
  readonly details: Readonly<{ readonly error_name: "invalid_response"; readonly message: string }>;
}>;

export type ExtensionRpcV1ParamsDisposition =
  | { readonly accepted: true }
  | Readonly<{
      readonly accepted: false;
      readonly jsonrpc_error: -32602;
      readonly error: ExtensionRpcV1ParamsError;
      readonly method_handler_invocations: 0;
      readonly backend_dispatches: 0;
      readonly connection_reusable: true;
    }>;

export type ExtensionRpcV1NotificationDisposition =
  | { readonly accepted: true }
  | Readonly<{
      readonly accepted: false;
      readonly wire_response: false;
      readonly error: ExtensionRpcV1ParamsError;
      readonly method_handler_invocations: 0;
      readonly backend_dispatches: 0;
      readonly connection_reusable: true;
    }>;

export type ExtensionRpcV1ResponseDisposition =
  | { readonly accepted: true }
  | Readonly<{
      readonly accepted: false;
      readonly local_error: ExtensionRpcV1ResponseError;
      readonly result_delivered: false;
      readonly connection_reusable: false;
      readonly replay_permitted: false;
      readonly new_identity_permitted: false;
      readonly protocol_violation: true;
    }>;

export type ExtensionRpcV1ErrorDataDisposition =
  | { readonly accepted: true }
  | Readonly<{
      readonly accepted: false;
      readonly promote: false;
      readonly local_error: ExtensionRpcV1ResponseError;
      readonly connection_reusable: false;
      readonly protocol_violation: true;
    }>;

export type ExtensionRpcV1ProtocolViolation = Readonly<{
  readonly code: "PROTOCOL_INVALID_RESPONSE";
  readonly method: string;
  readonly root: "success_result" | "error_data";
}>;

export interface ExtensionRpcV1ValidatorOptions {
  readonly registry: ExtensionRpcV1Registry;
  readonly schemaBundle: SchemaBundle;
  /**
   * Negotiated semantic root depth limit. The registry caps this at 64 and
   * the RPC envelope is never counted; a caller cannot negotiate above it.
   * Defaults to the registry's `max_json_nesting_depth`.
   */
  readonly maxJsonNestingDepth?: number;
  /** Observer called exactly once per recorded protocol violation. */
  readonly onProtocolViolation?: (violation: ExtensionRpcV1ProtocolViolation) => void;
}

export interface ExtensionRpcV1Validator {
  /** Validates a request method's `params` root before handler/backend dispatch. */
  validateRequestParams(method: string, params: unknown): ExtensionRpcV1ParamsDisposition;
  /** Validates a notification method's `params` root; never returns a wire response. */
  validateNotificationParams(method: string, params: unknown): ExtensionRpcV1NotificationDisposition;
  /** Validates a successful response's `result` root before delivery. */
  validateSuccessResult(method: string, result: unknown): ExtensionRpcV1ResponseDisposition;
  /** Validates a Dolly error response's `error.data` root; the peer error is never promoted. */
  validateErrorData(method: string, data: unknown): ExtensionRpcV1ErrorDataDisposition;
  /** Every protocol violation recorded since construction, in order. */
  readonly protocolViolations: readonly ExtensionRpcV1ProtocolViolation[];
}

/**
 * Returns the greatest container depth of `value`, where the root container
 * has depth 1 and a primitive root has depth 0 — the semantic-root rule used
 * by TST-PROTO-002. Iterative with a cycle guard so hostile nesting can
 * never overflow the call stack.
 */
function semanticRootDepth(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  let maxDepth = 0;
  const stack: Array<[unknown, number]> = [[value, 1]];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const [current, depth] = stack.pop() as [unknown, number];
    if (depth > maxDepth) maxDepth = depth;
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const child of current) {
        if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
      }
    } else {
      for (const key of Object.keys(current)) {
        const child = (current as Record<string, unknown>)[key];
        if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
      }
    }
  }
  return maxDepth;
}

export function createExtensionRpcV1Validator(
  options: ExtensionRpcV1ValidatorOptions,
): ExtensionRpcV1Validator {
  const { registry, schemaBundle } = options;
  const maxJsonNestingDepth =
    options.maxJsonNestingDepth ?? registry.semanticDepth.max_json_nesting_depth;
  const registryLimit = registry.semanticDepth.max_json_nesting_depth;
  if (
    !Number.isSafeInteger(maxJsonNestingDepth) ||
    maxJsonNestingDepth < 1 ||
    maxJsonNestingDepth > 64 ||
    maxJsonNestingDepth > registryLimit
  ) {
    throw new ExtensionRpcV1RegistryError(
      "RPC_REGISTRY_INVALID",
      `Negotiated semantic depth must be an integer in 1..${registryLimit}`,
    );
  }

  const onProtocolViolation = options.onProtocolViolation;
  const protocolViolations: ExtensionRpcV1ProtocolViolation[] = [];

  function recordViolation(
    method: string,
    root: "success_result" | "error_data",
  ): void {
    const violation: ExtensionRpcV1ProtocolViolation = Object.freeze({
      code: "PROTOCOL_INVALID_RESPONSE",
      method,
      root,
    });
    protocolViolations.push(violation);
    onProtocolViolation?.(violation);
  }

  const invalidParams: ExtensionRpcV1ParamsError = Object.freeze({
    name: "RPC_INVALID_PARAMS",
    retryable: false,
    outcome: "not_applied",
    details: Object.freeze({ error_name: "invalid_params", message: "params fail the method contract or its semantic depth limit" }),
  });

  function resolveRequest(method: string): ExtensionRpcV1RequestMethod {
    try {
      return registry.resolve(method, "request") as ExtensionRpcV1RequestMethod;
    } catch (error) {
      if (error instanceof ExtensionRpcV1RegistryError) throw error;
      throw new ExtensionRpcV1RegistryError(
        "RPC_METHOD_NOT_FOUND",
        `Extension RPC v1 request method is not registered: ${method}`,
      );
    }
  }

  return Object.freeze({
    protocolViolations,
    validateRequestParams(method: string, params: unknown): ExtensionRpcV1ParamsDisposition {
      const contract = resolveRequest(method);
      if (semanticRootDepth(params) > maxJsonNestingDepth ||
          !schemaBundle.validate(contract.params_schema, params).valid) {
        return Object.freeze({
          accepted: false,
          jsonrpc_error: -32602,
          error: invalidParams,
          method_handler_invocations: 0,
          backend_dispatches: 0,
          connection_reusable: true,
        });
      }
      return Object.freeze({ accepted: true });
    },
    validateNotificationParams(method: string, params: unknown): ExtensionRpcV1NotificationDisposition {
      // Resolve (throws on unknown method or request-direction).
      const notification = registry.resolve(method, "notification") as ExtensionRpcV1Notification;
      if (semanticRootDepth(params) > maxJsonNestingDepth ||
          !schemaBundle.validate(notification.params_schema, params).valid) {
        return Object.freeze({
          accepted: false,
          wire_response: false,
          error: invalidParams,
          method_handler_invocations: 0,
          backend_dispatches: 0,
          connection_reusable: true,
        });
      }
      return Object.freeze({ accepted: true });
    },
    validateSuccessResult(method: string, result: unknown): ExtensionRpcV1ResponseDisposition {
      const contract = resolveRequest(method);
      if (semanticRootDepth(result) > maxJsonNestingDepth ||
          !schemaBundle.validate(contract.result_schema, result).valid) {
        recordViolation(method, "success_result");
        const local_error: ExtensionRpcV1ResponseError = Object.freeze({
          name: "PROTOCOL_INVALID_RESPONSE",
          retryable: false,
          outcome: "unknown",
          details: Object.freeze({ error_name: "invalid_response", message: "success result fails the method result schema or its semantic depth limit" }),
        });
        return Object.freeze({
          accepted: false,
          local_error,
          result_delivered: false,
          connection_reusable: false,
          replay_permitted: false,
          new_identity_permitted: false,
          protocol_violation: true,
        });
      }
      return Object.freeze({ accepted: true });
    },
    validateErrorData(method: string, data: unknown): ExtensionRpcV1ErrorDataDisposition {
      resolveRequest(method);
      const errorSchema = registry.errorDataSchema;
      if (semanticRootDepth(data) > maxJsonNestingDepth ||
          !schemaBundle.validate(errorSchema, data).valid) {
        recordViolation(method, "error_data");
        const local_error: ExtensionRpcV1ResponseError = Object.freeze({
          name: "PROTOCOL_INVALID_RESPONSE",
          retryable: false,
          outcome: "unknown",
          details: Object.freeze({ error_name: "invalid_response", message: "error.data fails the common error schema or its semantic depth limit" }),
        });
        return Object.freeze({
          accepted: false,
          promote: false,
          local_error,
          connection_reusable: false,
          protocol_violation: true,
        });
      }
      return Object.freeze({ accepted: true });
    },
  });
}
