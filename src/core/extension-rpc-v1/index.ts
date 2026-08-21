/**
 * Public surface of the Extension RPC v1 validation slice (W1).
 *
 * Loads the frozen `extension-rpc-v1.registry.json` method authority,
 * resolves methods by exact name and direction, and validates the four
 * semantic schema roots (request params, notification params, success
 * result, Dolly error data) with the closed TST-PROTO-002 depth and schema
 * dispositions. It does not modify the private 3.0 extension handshake.
 */

export {
  ExtensionRpcV1RegistryError,
  createExtensionRpcV1Registry,
  loadExtensionRpcV1RegistryFile,
  type ExtensionRpcV1Direction,
  type ExtensionRpcV1Notification,
  type ExtensionRpcV1Registry,
  type ExtensionRpcV1RegistryErrorCode,
  type ExtensionRpcV1RequestMethod,
  type ExtensionRpcV1SemanticDepthPolicy,
  type ExtensionRpcV1SemanticRoot,
} from "./registry.js";

export {
  createExtensionRpcV1Validator,
  type ExtensionRpcV1ErrorDataDisposition,
  type ExtensionRpcV1NotificationDisposition,
  type ExtensionRpcV1ParamsDisposition,
  type ExtensionRpcV1ParamsError,
  type ExtensionRpcV1ProtocolViolation,
  type ExtensionRpcV1ResponseDisposition,
  type ExtensionRpcV1ResponseError,
  type ExtensionRpcV1Validator,
  type ExtensionRpcV1ValidatorOptions,
} from "./validator.js";
