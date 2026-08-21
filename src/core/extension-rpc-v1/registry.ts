/**
 * Extension RPC v1 method registry (registry.ts).
 *
 * Loads the machine-readable `extension-rpc-v1.registry.json` authority and
 * resolves a method contract by its exact method name and direction
 * (request or notification). Resolution is exact: a sibling method with a
 * different spelling or the same name in the other direction is rejected,
 * because the wire protocol (01-wire-protocol.md §4.1) freezes one caller
 * and one schema contract per method.
 *
 * The registry is the authority for the semantic-depth policy as well:
 * `semanticDepth` freezes request params, notification params, success
 * result, and Dolly error data as four independent schema roots, with
 * `max_json_nesting_depth` capped at 64 and the RPC envelope uncounted.
 */

import { readFileSync } from "node:fs";

export type ExtensionRpcV1Direction = "request" | "notification";

export type ExtensionRpcV1SemanticRoot =
  | "request_params"
  | "notification_params"
  | "success_result"
  | "error_data";

export interface ExtensionRpcV1SemanticDepthPolicy {
  readonly max_json_nesting_depth: number;
  readonly root_depth: number;
  readonly rpc_envelope_counted: boolean;
  readonly declared_schema_roots: readonly ExtensionRpcV1SemanticRoot[];
}

export interface ExtensionRpcV1RequestMethod {
  readonly method: string;
  readonly caller: "host" | "extension";
  readonly params_schema: string;
  readonly result_schema: string;
  readonly deadline: { readonly kind: string; readonly pointer: string | null };
  readonly operation_identity: {
    readonly scope: string;
    readonly pointers: readonly string[];
  };
  readonly reconciliation: { readonly kind: string; readonly method: string | null };
  readonly unknown_policy: string;
  readonly state_changing: boolean;
}

export interface ExtensionRpcV1Notification {
  readonly method: string;
  readonly caller: "host" | "extension" | "either";
  readonly params_schema: string;
  readonly loss_policy: string;
}

export type ExtensionRpcV1RegistryErrorCode =
  | "RPC_REGISTRY_INVALID"
  | "RPC_METHOD_NOT_FOUND"
  | "RPC_METHOD_DIRECTION_MISMATCH";

export class ExtensionRpcV1RegistryError extends TypeError {
  constructor(
    readonly code: ExtensionRpcV1RegistryErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ExtensionRpcV1RegistryError";
  }
}

export interface ExtensionRpcV1Registry {
  readonly schema: string;
  readonly protocol: { readonly major: number; readonly minor: number };
  readonly semanticDepth: ExtensionRpcV1SemanticDepthPolicy;
  readonly errorDataSchema: string;
  readonly requests: readonly ExtensionRpcV1RequestMethod[];
  readonly notifications: readonly ExtensionRpcV1Notification[];
  /** Exact method resolution in one direction. */
  resolve(
    method: string,
    direction: ExtensionRpcV1Direction,
  ): ExtensionRpcV1RequestMethod | ExtensionRpcV1Notification;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ExtensionRpcV1RegistryError(
      "RPC_REGISTRY_INVALID",
      `Extension RPC v1 registry ${label} must be a plain object`,
    );
  }
}

const SEMANTIC_ROOTS: readonly ExtensionRpcV1SemanticRoot[] = [
  "request_params",
  "notification_params",
  "success_result",
  "error_data",
];

/**
 * Parses and freezes an extension-rpc-v1 registry document. Structural
 * validation is closed so a malformed or unknown registry can never back a
 * method resolution; the spec schema conformance for the shipped file is
 * separately exercised by the spec validator (`validate_schemas.mjs`).
 */
export function createExtensionRpcV1Registry(
  document: unknown,
): ExtensionRpcV1Registry {
  assertRecord(document, "document");
  const { schema, protocol, semantic_depth, error_data_schema, requests, notifications } = document;
  if (schema !== "dolly.extension-rpc-registry/v1") {
    throw new ExtensionRpcV1RegistryError(
      "RPC_REGISTRY_INVALID",
      "Extension RPC v1 registry schema identifier is unknown",
    );
  }
  assertRecord(protocol, "protocol");
  if (protocol.major !== 1 || protocol.minor !== 0) {
    throw new ExtensionRpcV1RegistryError(
      "RPC_REGISTRY_INVALID",
      "Extension RPC v1 registry protocol version is unsupported",
    );
  }
  if (!isPlainObject(semantic_depth)) {
    throw new ExtensionRpcV1RegistryError(
      "RPC_REGISTRY_INVALID",
      "Extension RPC v1 registry semantic_depth must be an object",
    );
  }
  const maxJsonNestingDepth = semantic_depth.max_json_nesting_depth;
  if (
    typeof maxJsonNestingDepth !== "number" ||
    !Number.isSafeInteger(maxJsonNestingDepth) ||
    maxJsonNestingDepth < 1 ||
    maxJsonNestingDepth > 64
  ) {
    throw new ExtensionRpcV1RegistryError(
      "RPC_REGISTRY_INVALID",
      "Extension RPC v1 semantic max_json_nesting_depth must be an integer in 1..64",
    );
  }
  if (semantic_depth.root_depth !== 1 || semantic_depth.rpc_envelope_counted !== false) {
    throw new ExtensionRpcV1RegistryError(
      "RPC_REGISTRY_INVALID",
      "Extension RPC v1 semantic roots are uncounted with root depth 1",
    );
  }
  const declaredRoots = semantic_depth.declared_schema_roots;
  if (
    !Array.isArray(declaredRoots) ||
    declaredRoots.length !== SEMANTIC_ROOTS.length ||
    declaredRoots.some((root) => !SEMANTIC_ROOTS.includes(root as ExtensionRpcV1SemanticRoot))
  ) {
    throw new ExtensionRpcV1RegistryError(
      "RPC_REGISTRY_INVALID",
      "Extension RPC v1 semantic_depth must declare exactly the four schema roots",
    );
  }
  if (typeof error_data_schema !== "string" || error_data_schema.length === 0) {
    throw new ExtensionRpcV1RegistryError(
      "RPC_REGISTRY_INVALID",
      "Extension RPC v1 error_data_schema must be a non-empty URI string",
    );
  }
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new ExtensionRpcV1RegistryError(
      "RPC_REGISTRY_INVALID",
      "Extension RPC v1 registry must declare at least one request method",
    );
  }
  if (!Array.isArray(notifications)) {
    throw new ExtensionRpcV1RegistryError(
      "RPC_REGISTRY_INVALID",
      "Extension RPC v1 registry notifications must be an array",
    );
  }

  const requestMethods: ExtensionRpcV1RequestMethod[] = requests.map((row, index) => {
    assertRecord(row, `request[${index}]`);
    const { method, caller, params_schema, result_schema, deadline, operation_identity, reconciliation, unknown_policy, state_changing } = row;
    if (typeof method !== "string" || method.length === 0) {
      throw new ExtensionRpcV1RegistryError(
        "RPC_REGISTRY_INVALID",
        `Extension RPC v1 request[${index}] method name is invalid`,
      );
    }
    if (caller !== "host" && caller !== "extension") {
      throw new ExtensionRpcV1RegistryError(
        "RPC_REGISTRY_INVALID",
        `Extension RPC v1 request ${method} caller must be host or extension`,
      );
    }
    if (typeof params_schema !== "string" || params_schema.length === 0 ||
        typeof result_schema !== "string" || result_schema.length === 0) {
      throw new ExtensionRpcV1RegistryError(
        "RPC_REGISTRY_INVALID",
        `Extension RPC v1 request ${method} must declare params and result schemas`,
      );
    }
    assertRecord(deadline, `request ${method} deadline`);
    assertRecord(operation_identity, `request ${method} operation_identity`);
    assertRecord(reconciliation, `request ${method} reconciliation`);
    if (typeof unknown_policy !== "string" || typeof state_changing !== "boolean") {
      throw new ExtensionRpcV1RegistryError(
        "RPC_REGISTRY_INVALID",
        `Extension RPC v1 request ${method} unknown_policy/state_changing are invalid`,
      );
    }
    return Object.freeze({
      method,
      caller,
      params_schema,
      result_schema,
      deadline: Object.freeze({
        kind: typeof deadline.kind === "string" ? deadline.kind : "",
        pointer: deadline.pointer === null || deadline.pointer === undefined ? null : String(deadline.pointer),
      }),
      operation_identity: Object.freeze({
        scope: typeof operation_identity.scope === "string" ? operation_identity.scope : "",
        pointers: Object.freeze(Array.isArray(operation_identity.pointers)
          ? operation_identity.pointers.map(String)
          : []),
      }),
      reconciliation: Object.freeze({
        kind: typeof reconciliation.kind === "string" ? reconciliation.kind : "",
        method: reconciliation.method === null || reconciliation.method === undefined ? null : String(reconciliation.method),
      }),
      unknown_policy,
      state_changing,
    });
  });

  const requestNames = new Set<string>();
  for (const row of requestMethods) {
    if (requestNames.has(row.method)) {
      throw new ExtensionRpcV1RegistryError(
        "RPC_REGISTRY_INVALID",
        `Extension RPC v1 registry declares duplicate request method ${row.method}`,
      );
    }
    requestNames.add(row.method);
  }

  const notificationMethods: ExtensionRpcV1Notification[] = notifications.map((row, index) => {
    assertRecord(row, `notification[${index}]`);
    const { method, caller, params_schema, loss_policy } = row;
    if (typeof method !== "string" || method.length === 0) {
      throw new ExtensionRpcV1RegistryError(
        "RPC_REGISTRY_INVALID",
        `Extension RPC v1 notification[${index}] method name is invalid`,
      );
    }
    if (caller !== "host" && caller !== "extension" && caller !== "either") {
      throw new ExtensionRpcV1RegistryError(
        "RPC_REGISTRY_INVALID",
        `Extension RPC v1 notification ${method} caller is unknown`,
      );
    }
    if (typeof params_schema !== "string" || params_schema.length === 0) {
      throw new ExtensionRpcV1RegistryError(
        "RPC_REGISTRY_INVALID",
        `Extension RPC v1 notification ${method} must declare a params schema`,
      );
    }
    return Object.freeze({
      method,
      caller,
      params_schema,
      loss_policy: String(loss_policy),
    });
  });

  const seenNotifications = new Set<string>();
  for (const row of notificationMethods) {
    if (seenNotifications.has(row.method)) {
      throw new ExtensionRpcV1RegistryError(
        "RPC_REGISTRY_INVALID",
        `Extension RPC v1 registry declares duplicate notification method ${row.method}`,
      );
    }
    seenNotifications.add(row.method);
  }

  const semanticDepth = Object.freeze({
    max_json_nesting_depth: maxJsonNestingDepth,
    root_depth: 1,
    rpc_envelope_counted: false,
    declared_schema_roots: Object.freeze(SEMANTIC_ROOTS.filter(
      (root) => (declaredRoots as unknown[]).includes(root),
    )),
  });

  return Object.freeze({
    schema,
    protocol: Object.freeze({ major: 1, minor: 0 }),
    semanticDepth,
    errorDataSchema: error_data_schema,
    requests: Object.freeze(requestMethods),
    notifications: Object.freeze(notificationMethods),
    resolve(method: string, direction: ExtensionRpcV1Direction) {
      if (direction === "request") {
        const row = requestMethods.find((candidate) => candidate.method === method);
        if (row !== undefined) return row;
        const notification = notificationMethods.find((candidate) => candidate.method === method);
        if (notification !== undefined) {
          throw new ExtensionRpcV1RegistryError(
            "RPC_METHOD_DIRECTION_MISMATCH",
            `${method} is registered as a notification, not a request`,
          );
        }
        throw new ExtensionRpcV1RegistryError(
          "RPC_METHOD_NOT_FOUND",
          `Extension RPC v1 request method is not registered: ${method}`,
        );
      }
      const notification = notificationMethods.find((candidate) => candidate.method === method);
      if (notification !== undefined) return notification;
      const row = requestMethods.find((candidate) => candidate.method === method);
      if (row !== undefined) {
        throw new ExtensionRpcV1RegistryError(
          "RPC_METHOD_DIRECTION_MISMATCH",
          `${method} is registered as a request, not a notification`,
        );
      }
      throw new ExtensionRpcV1RegistryError(
        "RPC_METHOD_NOT_FOUND",
        `Extension RPC v1 notification method is not registered: ${method}`,
      );
    },
  });
}

/**
 * Loads and parses the `extension-rpc-v1.registry.json` file at `path`.
 * Fails closed on unreadable, non-JSON, or structurally invalid content.
 */
export function loadExtensionRpcV1RegistryFile(path: string): ExtensionRpcV1Registry {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ExtensionRpcV1RegistryError(
      "RPC_REGISTRY_INVALID",
      `Cannot read extension RPC v1 registry: ${path}`,
      { cause: error },
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new ExtensionRpcV1RegistryError(
      "RPC_REGISTRY_INVALID",
      `Extension RPC v1 registry is not valid JSON: ${path}`,
      { cause: error },
    );
  }
  return createExtensionRpcV1Registry(document);
}
