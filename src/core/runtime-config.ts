import {
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import type { InstanceConfigSchema } from "./instance-config-store.js";

const INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MAX_MODULE_FRAME_BYTES = 64 * 1024 * 1024;
const MODULE_FRAME_OVERHEAD_BYTES = 4 * 1024;

export type DollyLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export type DollyModuleIsolation = "none" | "process" | "sandbox";

export interface DollyCoreLimits extends Readonly<Record<string, JsonValue>> {
  /** A retryable failed attempt is retried only while `failedAttemptCount` is below this value. */
  readonly maxFailedAttempts: number;
  readonly maxStateBytes: number;
  readonly maxModuleResultCommitJournalBytes: number;
}

export interface DollyDisabledMediaConfig extends Readonly<Record<string, JsonValue>> {
  readonly enabled: false;
}

/**
 * The `ingress` object limits temporary capabilities and concurrent operations
 * that authorize raw bytes entering Media storage. These limits are separate
 * from stored-byte limits because they bound authorization lifetime and
 * input/output (I/O) work. Configuration names ending in `Ms` use milliseconds.
 */
export interface DollyMediaIngressConfig extends Readonly<Record<string, JsonValue>> {
  readonly maxActiveCapabilities: number;
  readonly maxConcurrentOperations: number;
  readonly maxCapabilityLifetimeMs: number;
}

export interface DollyEnabledMediaConfig extends Readonly<Record<string, JsonValue>> {
  readonly enabled: true;
  readonly maxMediaBytes: number;
  readonly maxTotalMediaBytes: number;
  readonly maxRegistrationRecords: number;
  readonly maxStorageRecords: number;
  readonly maxProviderAccessRecords: number;
  readonly deletedRegistrationRetentionMs: number;
  readonly ingress: DollyMediaIngressConfig;
}

export type DollyMediaConfig = DollyDisabledMediaConfig | DollyEnabledMediaConfig;

export interface DollySchedulerConfig extends Readonly<Record<string, JsonValue>> {
  readonly pollIntervalMs: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
}

export interface DollyCoreConfig extends Readonly<Record<string, JsonValue>> {
  readonly limits: DollyCoreLimits;
  readonly media: DollyMediaConfig;
  readonly scheduler: DollySchedulerConfig;
}

export interface DollyPageConfig extends Readonly<Record<string, JsonValue>> {
  readonly pageId: string;
}

export interface DollyReactiveActivation extends Readonly<Record<string, JsonValue>> {
  readonly kind: "reactive";
}

export interface DollyPeriodicActivation extends Readonly<Record<string, JsonValue>> {
  readonly kind: "periodic";
  readonly periodMs: number;
  readonly allowEmptyInput: boolean;
}

export interface DollyPeriodicSourceActivation extends Readonly<Record<string, JsonValue>> {
  readonly kind: "source";
  readonly trigger: "periodic";
  readonly periodMs: number;
}

export interface DollyExternalSourceActivation extends Readonly<Record<string, JsonValue>> {
  readonly kind: "source";
  readonly trigger: "external";
}

export interface DollyManualSourceActivation extends Readonly<Record<string, JsonValue>> {
  readonly kind: "source";
  readonly trigger: "manual";
}

export type DollyModuleActivation =
  | DollyReactiveActivation
  | DollyPeriodicActivation
  | DollyPeriodicSourceActivation
  | DollyExternalSourceActivation
  | DollyManualSourceActivation;

export interface DollyModuleClaimLimits extends Readonly<Record<string, JsonValue>> {
  readonly maxCount: number;
  readonly maxBytes: number;
}

export interface DollyModuleLimits extends Readonly<Record<string, JsonValue>> {
  readonly claim: DollyModuleClaimLimits | null;
  readonly maxInputBytes: number;
  readonly maxResultBytes: number;
  readonly maxFrameBytes: number;
  readonly maxRunsPerGeneration: number;
  readonly maxGenerations: number;
}

export interface DollyModuleTimeouts extends Readonly<Record<string, JsonValue>> {
  readonly initializationTimeoutMs: number;
  readonly executionTimeoutMs: number;
  readonly cancellationGraceMs: number;
  readonly terminationTimeoutMs: number;
}

export interface DollyModuleConfigurationReference extends Readonly<Record<string, JsonValue>> {
  readonly configId: string;
  readonly revision: string;
  readonly configVersion: number;
}

export interface DollyModuleConfig extends Readonly<Record<string, JsonValue>> {
  readonly moduleId: string;
  readonly extensionId: string;
  readonly packageVersion: string;
  readonly moduleKind: string;
  readonly isolation: DollyModuleIsolation;
  readonly configurationReference: DollyModuleConfigurationReference;
  /** Persistent policy IDs. Session capability handles are created only at process startup. */
  readonly permissionPolicyIds: readonly string[];
  readonly inputPageIds: readonly string[];
  readonly outputPageIds: readonly string[];
  readonly subscriptionStart: "from-head" | "from-now";
  readonly activation: DollyModuleActivation;
  readonly limits: DollyModuleLimits;
  readonly timeouts: DollyModuleTimeouts;
}

export interface DollyLoggingConfig extends Readonly<Record<string, JsonValue>> {
  readonly level: DollyLogLevel;
}

export interface DollyInstanceConfig extends Readonly<Record<string, JsonValue>> {
  readonly schemaVersion: "dolly.instance/9";
  readonly instanceId: string;
  readonly displayName: string;
  readonly stateDirectory: string | null;
  readonly core: DollyCoreConfig;
  readonly pages: readonly DollyPageConfig[];
  readonly modules: readonly DollyModuleConfig[];
  readonly logging: DollyLoggingConfig;
}

type SameType<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
        (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type AssertType<Condition extends true> = Condition;
type MutableArray<Value> = Extract<Value, unknown[]>;

// Compile-time public contract checks. These aliases are erased from output.
type DollyConfigObjectReadonlyAssertions = [
  AssertType<SameType<DollyCoreLimits, Readonly<DollyCoreLimits>>>,
  AssertType<SameType<DollyDisabledMediaConfig, Readonly<DollyDisabledMediaConfig>>>,
  AssertType<SameType<DollyMediaIngressConfig, Readonly<DollyMediaIngressConfig>>>,
  AssertType<SameType<DollyEnabledMediaConfig, Readonly<DollyEnabledMediaConfig>>>,
  AssertType<SameType<DollySchedulerConfig, Readonly<DollySchedulerConfig>>>,
  AssertType<SameType<DollyCoreConfig, Readonly<DollyCoreConfig>>>,
  AssertType<SameType<DollyPageConfig, Readonly<DollyPageConfig>>>,
  AssertType<SameType<DollyReactiveActivation, Readonly<DollyReactiveActivation>>>,
  AssertType<SameType<DollyPeriodicActivation, Readonly<DollyPeriodicActivation>>>,
  AssertType<SameType<DollyPeriodicSourceActivation, Readonly<DollyPeriodicSourceActivation>>>,
  AssertType<SameType<DollyExternalSourceActivation, Readonly<DollyExternalSourceActivation>>>,
  AssertType<SameType<DollyManualSourceActivation, Readonly<DollyManualSourceActivation>>>,
  AssertType<SameType<DollyModuleClaimLimits, Readonly<DollyModuleClaimLimits>>>,
  AssertType<SameType<DollyModuleLimits, Readonly<DollyModuleLimits>>>,
  AssertType<SameType<DollyModuleTimeouts, Readonly<DollyModuleTimeouts>>>,
  AssertType<SameType<DollyModuleConfigurationReference, Readonly<DollyModuleConfigurationReference>>>,
  AssertType<SameType<DollyModuleConfig, Readonly<DollyModuleConfig>>>,
  AssertType<SameType<DollyLoggingConfig, Readonly<DollyLoggingConfig>>>,
  AssertType<SameType<DollyInstanceConfig, Readonly<DollyInstanceConfig>>>,
];
type DollyConfigArrayReadonlyAssertions = [
  AssertType<SameType<MutableArray<DollyInstanceConfig["pages"]>, never>>,
  AssertType<SameType<MutableArray<DollyInstanceConfig["modules"]>, never>>,
  AssertType<SameType<MutableArray<DollyModuleConfig["permissionPolicyIds"]>, never>>,
  AssertType<SameType<MutableArray<DollyModuleConfig["inputPageIds"]>, never>>,
  AssertType<SameType<MutableArray<DollyModuleConfig["outputPageIds"]>, never>>,
];

export type RuntimeConfigErrorCode =
  | "RUNTIME_CONFIG_INVALID"
  | "RUNTIME_CONFIG_TOPOLOGY_INVALID";

export class RuntimeConfigError extends TypeError {
  constructor(readonly code: RuntimeConfigErrorCode, message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function closed(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new RuntimeConfigError("RUNTIME_CONFIG_INVALID", `${label} must be an object`);
  }
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unexpected.length > 0) {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      `${label} contains unknown fields: ${unexpected.join(", ")}`,
    );
  }
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  closed(value, keys, label);
  const missing = keys.filter((key) => !(key in value));
  if (missing.length > 0) {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      `${label} is missing fields: ${missing.join(", ")}`,
    );
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      `${label} is not a valid identifier`,
    );
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      `${label} must be a lowercase SHA-256 digest`,
    );
  }
  return value;
}

function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      `${label} must be a positive safe integer no greater than ${maximum}`,
    );
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      `${label} must be a non-negative safe integer`,
    );
  }
  return value as number;
}

function boundedBytes(
  value: unknown,
  label: string,
  minimum: number,
  maximum = 1024 * 1024 * 1024,
): number {
  const bytes = positiveInteger(value, label, maximum);
  if (bytes < minimum) {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      `${label} must be at least ${minimum} bytes`,
    );
  }
  return bytes;
}

function uniqueIdentifiers(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      `${label} must be an array with at most ${maximum} entries`,
    );
  }
  const normalized = value.map((candidate, index) =>
    identifier(candidate, `${label}[${index}]`),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new RuntimeConfigError("RUNTIME_CONFIG_INVALID", `${label} contains duplicates`);
  }
  return normalized;
}

function validateCore(value: unknown): DollyCoreConfig {
  exactKeys(value, ["limits", "media", "scheduler"], "core");
  exactKeys(
    value.limits,
    ["maxFailedAttempts", "maxStateBytes", "maxModuleResultCommitJournalBytes"],
    "core.limits",
  );
  const limits: DollyCoreLimits = {
    maxFailedAttempts: positiveInteger(
      value.limits.maxFailedAttempts,
      "core.limits.maxFailedAttempts",
      1_000,
    ),
    maxStateBytes: boundedBytes(value.limits.maxStateBytes, "core.limits.maxStateBytes", 1024),
    maxModuleResultCommitJournalBytes: boundedBytes(
      value.limits.maxModuleResultCommitJournalBytes,
      "core.limits.maxModuleResultCommitJournalBytes",
      1024,
    ),
  };

  if (!isPlainObject(value.media) || typeof value.media.enabled !== "boolean") {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      "core.media.enabled must be boolean",
    );
  }
  let media: DollyMediaConfig;
  if (!value.media.enabled) {
    exactKeys(value.media, ["enabled"], "core.media");
    media = { enabled: false };
  } else {
    exactKeys(
      value.media,
      [
        "enabled",
        "maxMediaBytes",
        "maxTotalMediaBytes",
        "maxRegistrationRecords",
        "maxStorageRecords",
        "maxProviderAccessRecords",
        "deletedRegistrationRetentionMs",
        "ingress",
      ],
      "core.media",
    );
    exactKeys(
      value.media.ingress,
      [
        "maxActiveCapabilities",
        "maxConcurrentOperations",
        "maxCapabilityLifetimeMs",
      ],
      "core.media.ingress",
    );
    const maxMediaBytes = boundedBytes(
      value.media.maxMediaBytes,
      "core.media.maxMediaBytes",
      1,
    );
    const maxTotalMediaBytes = boundedBytes(
      value.media.maxTotalMediaBytes,
      "core.media.maxTotalMediaBytes",
      1,
    );
    if (maxTotalMediaBytes < maxMediaBytes) {
      throw new RuntimeConfigError(
        "RUNTIME_CONFIG_INVALID",
        "core.media.maxTotalMediaBytes must be greater than or equal to maxMediaBytes",
      );
    }
    media = {
      enabled: true,
      maxMediaBytes,
      maxTotalMediaBytes,
      maxRegistrationRecords: positiveInteger(
        value.media.maxRegistrationRecords,
        "core.media.maxRegistrationRecords",
      ),
      maxStorageRecords: positiveInteger(
        value.media.maxStorageRecords,
        "core.media.maxStorageRecords",
      ),
      maxProviderAccessRecords: positiveInteger(
        value.media.maxProviderAccessRecords,
        "core.media.maxProviderAccessRecords",
      ),
      deletedRegistrationRetentionMs: nonNegativeInteger(
        value.media.deletedRegistrationRetentionMs,
        "core.media.deletedRegistrationRetentionMs",
      ),
      ingress: {
        maxActiveCapabilities: positiveInteger(
          value.media.ingress.maxActiveCapabilities,
          "core.media.ingress.maxActiveCapabilities",
        ),
        maxConcurrentOperations: positiveInteger(
          value.media.ingress.maxConcurrentOperations,
          "core.media.ingress.maxConcurrentOperations",
        ),
        maxCapabilityLifetimeMs: positiveInteger(
          value.media.ingress.maxCapabilityLifetimeMs,
          "core.media.ingress.maxCapabilityLifetimeMs",
        ),
      },
    };
  }

  exactKeys(
    value.scheduler,
    ["pollIntervalMs", "retryBaseMs", "retryMaxMs"],
    "core.scheduler",
  );
  const scheduler: DollySchedulerConfig = {
    pollIntervalMs: positiveInteger(
      value.scheduler.pollIntervalMs,
      "core.scheduler.pollIntervalMs",
      60 * 1_000,
    ),
    retryBaseMs: positiveInteger(
      value.scheduler.retryBaseMs,
      "core.scheduler.retryBaseMs",
      60 * 60 * 1_000,
    ),
    retryMaxMs: positiveInteger(
      value.scheduler.retryMaxMs,
      "core.scheduler.retryMaxMs",
      24 * 60 * 60 * 1_000,
    ),
  };
  if (scheduler.retryMaxMs < scheduler.retryBaseMs) {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      "core.scheduler.retryMaxMs must be greater than or equal to retryBaseMs",
    );
  }

  return {
    limits,
    media,
    scheduler,
  };
}

function validateActivation(value: unknown, label: string): DollyModuleActivation {
  if (!isPlainObject(value) || typeof value.kind !== "string") {
    throw new RuntimeConfigError("RUNTIME_CONFIG_INVALID", `${label} is invalid`);
  }
  if (value.kind === "reactive") {
    exactKeys(value, ["kind"], label);
    return { kind: "reactive" };
  }
  if (value.kind === "periodic") {
    exactKeys(value, ["kind", "periodMs", "allowEmptyInput"], label);
    if (typeof value.allowEmptyInput !== "boolean") {
      throw new RuntimeConfigError(
        "RUNTIME_CONFIG_INVALID",
        `${label}.allowEmptyInput must be boolean`,
      );
    }
    return {
      kind: "periodic",
      periodMs: positiveInteger(value.periodMs, `${label}.periodMs`),
      allowEmptyInput: value.allowEmptyInput,
    };
  }
  if (value.kind === "source") {
    const trigger = value.trigger;
    if (trigger === "periodic") {
      exactKeys(value, ["kind", "trigger", "periodMs"], label);
      return {
        kind: "source",
        trigger,
        periodMs: positiveInteger(value.periodMs, `${label}.periodMs`),
      };
    }
    if (trigger === "external" || trigger === "manual") {
      exactKeys(value, ["kind", "trigger"], label);
      return { kind: "source", trigger };
    }
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      `${label}.trigger is unsupported`,
    );
  }
  throw new RuntimeConfigError("RUNTIME_CONFIG_INVALID", `${label}.kind is unsupported`);
}

function validateModule(value: unknown, index: number): DollyModuleConfig {
  const label = `modules[${index}]`;
  exactKeys(
    value,
    [
      "moduleId",
      "extensionId",
      "packageVersion",
      "moduleKind",
      "isolation",
      "configurationReference",
      "permissionPolicyIds",
      "inputPageIds",
      "outputPageIds",
      "subscriptionStart",
      "activation",
      "limits",
      "timeouts",
    ],
    label,
  );
  const isolation = value.isolation;
  if (
    isolation !== "none" &&
    isolation !== "process" &&
    isolation !== "sandbox"
  ) {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      `${label}.isolation is unsupported`,
    );
  }
  if (value.subscriptionStart !== "from-head" && value.subscriptionStart !== "from-now") {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      `${label}.subscriptionStart is unsupported`,
    );
  }
  const activation = validateActivation(value.activation, `${label}.activation`);
  exactKeys(
    value.limits,
    [
      "claim",
      "maxInputBytes",
      "maxResultBytes",
      "maxFrameBytes",
      "maxRunsPerGeneration",
      "maxGenerations",
    ],
    `${label}.limits`,
  );
  let claim: DollyModuleClaimLimits | null;
  if (activation.kind === "source") {
    if (value.limits.claim !== null) {
      throw new RuntimeConfigError(
        "RUNTIME_CONFIG_INVALID",
        `${label}.limits.claim must be null for a source Module`,
      );
    }
    claim = null;
  } else {
    exactKeys(value.limits.claim, ["maxCount", "maxBytes"], `${label}.limits.claim`);
    claim = {
      maxCount: positiveInteger(
        value.limits.claim.maxCount,
        `${label}.limits.claim.maxCount`,
        10_000,
      ),
      maxBytes: boundedBytes(
        value.limits.claim.maxBytes,
        `${label}.limits.claim.maxBytes`,
        256,
      ),
    };
  }
  const maxInputBytes = boundedBytes(
    value.limits.maxInputBytes,
    `${label}.limits.maxInputBytes`,
    256,
    MAX_MODULE_FRAME_BYTES - MODULE_FRAME_OVERHEAD_BYTES,
  );
  const maxResultBytes = boundedBytes(
    value.limits.maxResultBytes,
    `${label}.limits.maxResultBytes`,
    256,
    MAX_MODULE_FRAME_BYTES - MODULE_FRAME_OVERHEAD_BYTES,
  );
  const maxFrameBytes = boundedBytes(
    value.limits.maxFrameBytes,
    `${label}.limits.maxFrameBytes`,
    8 * 1024,
    MAX_MODULE_FRAME_BYTES,
  );
  if (
    maxFrameBytes < maxInputBytes + MODULE_FRAME_OVERHEAD_BYTES ||
    maxFrameBytes < maxResultBytes + MODULE_FRAME_OVERHEAD_BYTES
  ) {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      `${label}.limits.maxFrameBytes must leave ${MODULE_FRAME_OVERHEAD_BYTES} bytes for the protocol envelope`,
    );
  }
  exactKeys(
    value.timeouts,
    [
      "initializationTimeoutMs",
      "executionTimeoutMs",
      "cancellationGraceMs",
      "terminationTimeoutMs",
    ],
    `${label}.timeouts`,
  );
  const timeouts: DollyModuleTimeouts = {
    initializationTimeoutMs: positiveInteger(
      value.timeouts.initializationTimeoutMs,
      `${label}.timeouts.initializationTimeoutMs`,
      5 * 60 * 1_000,
    ),
    executionTimeoutMs: positiveInteger(
      value.timeouts.executionTimeoutMs,
      `${label}.timeouts.executionTimeoutMs`,
      24 * 60 * 60 * 1_000,
    ),
    cancellationGraceMs: positiveInteger(
      value.timeouts.cancellationGraceMs,
      `${label}.timeouts.cancellationGraceMs`,
      60 * 1_000,
    ),
    terminationTimeoutMs: positiveInteger(
      value.timeouts.terminationTimeoutMs,
      `${label}.timeouts.terminationTimeoutMs`,
      60 * 1_000,
    ),
  };
  exactKeys(
    value.configurationReference,
    ["configId", "revision", "configVersion"],
    `${label}.configurationReference`,
  );
  return {
    moduleId: identifier(value.moduleId, `${label}.moduleId`),
    extensionId: identifier(value.extensionId, `${label}.extensionId`),
    packageVersion: identifier(value.packageVersion, `${label}.packageVersion`),
    moduleKind: identifier(value.moduleKind, `${label}.moduleKind`),
    isolation,
    configurationReference: {
      configId: identifier(
        value.configurationReference.configId,
        `${label}.configurationReference.configId`,
      ),
      revision: digest(
        value.configurationReference.revision,
        `${label}.configurationReference.revision`,
      ),
      configVersion: positiveInteger(
        value.configurationReference.configVersion,
        `${label}.configurationReference.configVersion`,
        1_000_000,
      ),
    },
    permissionPolicyIds: uniqueIdentifiers(
      value.permissionPolicyIds,
      `${label}.permissionPolicyIds`,
      256,
    ),
    inputPageIds: uniqueIdentifiers(value.inputPageIds, `${label}.inputPageIds`, 64),
    outputPageIds: uniqueIdentifiers(value.outputPageIds, `${label}.outputPageIds`, 64),
    subscriptionStart: value.subscriptionStart,
    activation,
    limits: {
      claim,
      maxInputBytes,
      maxResultBytes,
      maxFrameBytes,
      maxRunsPerGeneration: positiveInteger(
        value.limits.maxRunsPerGeneration,
        `${label}.limits.maxRunsPerGeneration`,
      ),
      maxGenerations: positiveInteger(
        value.limits.maxGenerations,
        `${label}.limits.maxGenerations`,
      ),
    },
    timeouts,
  };
}

export function validateDollyInstanceConfig(value: JsonValue): DollyInstanceConfig {
  exactKeys(
    value,
    [
      "schemaVersion",
      "instanceId",
      "displayName",
      "stateDirectory",
      "core",
      "pages",
      "modules",
      "logging",
    ],
    "configuration",
  );
  if (value.schemaVersion !== "dolly.instance/9") {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      "Configuration schemaVersion is unsupported; legacy configuration requires explicit migration",
    );
  }
  if (typeof value.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(value.instanceId)) {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      "instanceId must be a lowercase UUIDv4",
    );
  }
  if (
    typeof value.displayName !== "string" ||
    value.displayName.trim().length === 0 ||
    Buffer.byteLength(value.displayName, "utf8") > 256
  ) {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      "displayName must contain between 1 and 256 UTF-8 bytes",
    );
  }
  if (
    value.stateDirectory !== null &&
    (typeof value.stateDirectory !== "string" || value.stateDirectory.length === 0)
  ) {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      "stateDirectory must be null or a non-empty path",
    );
  }

  if (!Array.isArray(value.pages) || value.pages.length === 0 || value.pages.length > 4_096) {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      "pages must contain between 1 and 4096 entries",
    );
  }
  const pages = value.pages.map((candidate, index): DollyPageConfig => {
    exactKeys(candidate, ["pageId"], `pages[${index}]`);
    return { pageId: identifier(candidate.pageId, `pages[${index}].pageId`) };
  });
  const pageIds = new Set(pages.map((page) => page.pageId));
  if (pageIds.size !== pages.length) {
    throw new RuntimeConfigError("RUNTIME_CONFIG_TOPOLOGY_INVALID", "Page IDs must be unique");
  }

  if (!Array.isArray(value.modules) || value.modules.length > 1_024) {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      "modules must be an array with at most 1024 entries",
    );
  }
  const modules = value.modules.map(validateModule);
  const moduleIds = new Set(modules.map((module) => module.moduleId));
  if (moduleIds.size !== modules.length) {
    throw new RuntimeConfigError("RUNTIME_CONFIG_TOPOLOGY_INVALID", "Module IDs must be unique");
  }
  for (const module of modules) {
    const missingPages = [...module.inputPageIds, ...module.outputPageIds]
      .filter((pageId) => !pageIds.has(pageId));
    if (missingPages.length > 0) {
      throw new RuntimeConfigError(
        "RUNTIME_CONFIG_TOPOLOGY_INVALID",
        `Module ${module.moduleId} references unknown Pages: ${[...new Set(missingPages)].join(", ")}`,
      );
    }
    if (module.activation.kind === "source" && module.inputPageIds.length !== 0) {
      throw new RuntimeConfigError(
        "RUNTIME_CONFIG_TOPOLOGY_INVALID",
        `Source Module ${module.moduleId} cannot have input Pages`,
      );
    }
    if (module.activation.kind !== "source" && module.inputPageIds.length === 0) {
      throw new RuntimeConfigError(
        "RUNTIME_CONFIG_TOPOLOGY_INVALID",
        `Non-source Module ${module.moduleId} requires at least one input Page`,
      );
    }
  }

  exactKeys(value.logging, ["level"], "logging");
  const logLevels: readonly DollyLogLevel[] = [
    "trace",
    "debug",
    "info",
    "warn",
    "error",
    "fatal",
  ];
  if (!logLevels.includes(value.logging.level as DollyLogLevel)) {
    throw new RuntimeConfigError("RUNTIME_CONFIG_INVALID", "logging.level is unsupported");
  }

  return deepFreeze({
    schemaVersion: "dolly.instance/9",
    instanceId: value.instanceId,
    displayName: value.displayName,
    stateDirectory: value.stateDirectory,
    core: validateCore(value.core),
    pages,
    modules,
    logging: { level: value.logging.level as DollyLogLevel },
  }) as DollyInstanceConfig;
}

export function createDefaultDollyInstanceConfig(
  instanceId: string,
  displayName = "Dolly",
): DollyInstanceConfig {
  return validateDollyInstanceConfig({
    schemaVersion: "dolly.instance/9",
    instanceId,
    displayName,
    stateDirectory: null,
    core: {
      limits: {
        maxFailedAttempts: 3,
        maxStateBytes: 64 * 1024 * 1024,
        maxModuleResultCommitJournalBytes: 16 * 1024 * 1024,
      },
      media: { enabled: false },
      scheduler: {
        pollIntervalMs: 100,
        retryBaseMs: 250,
        retryMaxMs: 30_000,
      },
    },
    pages: [{ pageId: "main" }],
    modules: [],
    logging: { level: "info" },
  });
}

export const dollyInstanceConfigSchema: InstanceConfigSchema<DollyInstanceConfig> = {
  schemaVersion: "dolly.instance/9",
  validate: validateDollyInstanceConfig,
  instanceId: (document) => document.instanceId,
  stateDirectory: (document) => document.stateDirectory ?? undefined,
  withInstanceId: (document, instanceId) =>
    validateDollyInstanceConfig({ ...cloneJson(document), instanceId }),
  redact: (document) => cloneJson(document),
};
