export type { ExtensionCapabilityDefinition } from "./capability-support.js";
export {
  escapeLogText,
  StructuralRedactor,
  type StructuralRedactionClass,
  type StructuralRedactionOptions,
} from "./structural-redaction.js";
export {
  createStructuredLogCapability,
  DEFAULT_STRUCTURED_LOG_LIMITS,
  STRUCTURED_LOG_CAPABILITY_TYPE,
  STRUCTURED_LOG_CAPABILITY_VERSION,
  type ExtensionLogLevel,
  type ExtensionLogOrigin,
  type ExtensionStructuredLogRecord,
  type ExtensionStructuredLogSink,
  type StructuredLogCapabilityLimits,
  type StructuredLogCapabilityOptions,
} from "./structured-log-capability.js";
export {
  createModulePrivateStorageCapability,
  createModulePrivateStorageCapabilityV2,
  DEFAULT_MODULE_PRIVATE_STORAGE_LIMITS,
  DEFAULT_MODULE_PRIVATE_STORAGE_LIMITS_V2,
  MODULE_PRIVATE_STORAGE_CAPABILITY_TYPE,
  MODULE_PRIVATE_STORAGE_CAPABILITY_VERSION,
  MODULE_PRIVATE_STORAGE_CAPABILITY_VERSION_V2,
  ModulePrivateStorageBackend,
  type ModulePrivateStorageBackendOptions,
  type ModulePrivateStorageCapabilityOptions,
  type ModulePrivateStorageCapabilityV2Options,
  type ModulePrivateStorageEntry,
  type ModulePrivateStorageLimits,
  type ModulePrivateStorageLimitsV2,
  type ModulePrivateStorageOperation,
} from "./module-private-storage-capability.js";
export {
  createDeliveredBlockReadCapability,
  DEFAULT_DELIVERED_BLOCK_READ_LIMITS,
  DELIVERED_BLOCK_READ_CAPABILITY_TYPE,
  DELIVERED_BLOCK_READ_CAPABILITY_VERSION,
  type DeliveredBlockClaim,
  type DeliveredBlockReadCapabilityOptions,
  type DeliveredBlockReadLimits,
  type DeliveredBlockReadOperation,
} from "./delivered-block-read-capability.js";
