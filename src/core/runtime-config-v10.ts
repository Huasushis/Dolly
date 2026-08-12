import { deepFreeze, type JsonValue } from "./canonical-json.js";
import {
  RuntimeConfigError,
  validateDollyInstanceConfig,
  type DollyInstanceConfig,
  type DollyLogLevel,
  type DollyMediaConfig,
  type DollyModuleActivation,
  type DollyModuleConfigurationReference,
  type DollyModuleTimeouts,
  type DollyPageConfig,
} from "./runtime-config.js";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DECIMAL_SEQUENCE_PATTERN = /^(0|[1-9][0-9]*)$/u;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_CONFIGURED_MODULES = 1_024;
const MAX_CLAIM_COUNT = 10_000;
const MAX_CONFIGURED_BYTES = 1_024 * 1_024 * 1_024;
const MAX_MODULE_FRAME_BYTES = 64 * 1_024 * 1_024;
const MODULE_FRAME_OVERHEAD_BYTES = 4 * 1_024;

export type DollyInputConnectionStartV10 =
  | "from-head"
  | "from-now"
  | Readonly<{ checkpoint: string }>;

export interface DollyInputConnectionV10 {
  readonly pageId: string;
  readonly start: DollyInputConnectionStartV10;
}

export interface DollyModuleClaimLimitsV10 {
  readonly baselineCount: number;
  readonly baselineBytes: number;
  readonly maxCount: number;
  readonly maxBytes: number;
}

export interface DollyModuleMailboxLimitsV10 {
  readonly maxResidentCount: number;
  readonly maxResidentBytes: number;
}

export interface DollyLinuxProcessExecutionV10 {
  readonly kind: "linux-process";
  readonly isolation: "process" | "sandbox";
  readonly limits: Readonly<{
    memoryMaxBytes: number;
    maxTasks: number;
    cpuQuotaMicros: number;
    cpuPeriodMicros: number;
    maxOpenFiles: number;
  }>;
}

export interface DollyPermissionPolicyReferenceV10 {
  readonly policyId: string;
  readonly revision: string;
}

export interface DollySchedulerConfigV10 {
  readonly pollIntervalMs: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly maxConcurrentModules: number;
  readonly backpressureAction:
    | "pause-upstream"
    | "delay-upstream"
    | "reject-upstream-run";
  readonly downstreamRecheckMs: number;
  readonly noProgressAfterMs: number;
  readonly retryJitterBasisPoints: 0;
  readonly lowWatermarkBasisPoints: number;
  readonly policy: Readonly<{ kind: "fixed" }>;
  readonly policyFailureAction: "quarantine";
}

export interface DollyModuleLimitsV10 {
  readonly claim: DollyModuleClaimLimitsV10;
  readonly mailbox: DollyModuleMailboxLimitsV10;
  readonly sourceRequestMaxBytes: number | null;
  readonly maxInputBytes: number;
  readonly maxResultBytes: number;
  readonly maxFrameBytes: number;
  readonly maxRunsPerGeneration: number;
  readonly maxGenerations: number;
}

export interface DollyModuleConfigV10 {
  readonly moduleId: string;
  readonly extensionId: string;
  readonly packageVersion: string;
  readonly moduleKind: string;
  readonly configurationReference: DollyModuleConfigurationReference;
  readonly permissionPolicyReferences: readonly DollyPermissionPolicyReferenceV10[];
  readonly inputConnections: readonly DollyInputConnectionV10[];
  readonly outputPageIds: readonly string[];
  readonly activation: DollyModuleActivation;
  readonly declaredExternalEffects: "none" | "core-capabilities-only";
  readonly execution: DollyLinuxProcessExecutionV10;
  readonly limits: DollyModuleLimitsV10;
  readonly timeouts: DollyModuleTimeouts;
}

export interface DollyCoreLimitsV10 {
  readonly maxFailedAttempts: number;
  readonly maxStateBytes: number;
  readonly maxModuleResultCommitJournalBytes: number;
  readonly maxRegisteredContentValueBytes: number;
}

export interface DollyInstanceConfigV10Draft {
  readonly schemaVersion: "dolly.instance/10";
  readonly instanceId: string;
  readonly displayName: string;
  readonly stateDirectory: string | null;
  readonly core: Readonly<{
    limits: DollyCoreLimitsV10;
    media: DollyMediaConfig;
    scheduler: DollySchedulerConfigV10;
  }>;
  readonly pages: readonly DollyPageConfig[];
  readonly modules: readonly DollyModuleConfigV10[];
  readonly logging: Readonly<{ level: DollyLogLevel }>;
}

export interface DollyInstanceV10ModuleMigrationInput {
  readonly moduleId: string;
  readonly claimBaseline: Readonly<{ count: number; bytes: number }>;
  readonly mailbox: DollyModuleMailboxLimitsV10;
  readonly sourceRequestMaxBytes: number | null;
  readonly execution: DollyLinuxProcessExecutionV10;
  readonly declaredExternalEffects: "none" | "core-capabilities-only";
  readonly permissionPolicyReferences: readonly DollyPermissionPolicyReferenceV10[];
}

export interface DollyInstanceV10MigrationInput {
  readonly schemaVersion: "dolly.instance-v10-migration-input/1";
  readonly expectedSourceRevision: string;
  readonly maxRegisteredContentValueBytes: number;
  readonly scheduler: DollySchedulerConfigV10;
  readonly modules: readonly DollyInstanceV10ModuleMigrationInput[];
}

/**
 * One version-9 document and the configuration revision returned by the same
 * configuration-store read. Keeping them together prevents a migration plan
 * from attaching an old document to a newer expected revision.
 */
export interface DollyInstanceConfigV9Snapshot {
  readonly document: DollyInstanceConfig;
  readonly configRevision: string;
}

export interface DollyInstanceV10MigrationPlan {
  readonly schemaVersion: "dolly.instance-v10-migration-plan/1";
  readonly sourceSchemaVersion: "dolly.instance/9";
  readonly expectedSourceRevision: string;
  readonly document: DollyInstanceConfigV10Draft;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw invalid(`${label} must be an object`);
  }
  const expected = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !expected.has(key)).sort();
  if (unexpected.length > 0) {
    throw invalid(`${label} contains unknown fields: ${unexpected.join(", ")}`);
  }
  const missing = keys.filter((key) => !(key in value));
  if (missing.length > 0) {
    throw invalid(`${label} is missing fields: ${missing.join(", ")}`);
  }
}

function invalid(message: string, topology = false): RuntimeConfigError {
  return new RuntimeConfigError(
    topology ? "RUNTIME_CONFIG_TOPOLOGY_INVALID" : "RUNTIME_CONFIG_INVALID",
    message,
  );
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw invalid(`${label} is not a valid identifier`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw invalid(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalid(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function uniqueIdentifiers(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw invalid(`${label} must be an array with at most ${maximum} entries`);
  }
  const values = value.map((candidate, index) => identifier(candidate, `${label}[${index}]`));
  if (new Set(values).size !== values.length) {
    throw invalid(`${label} contains duplicates`);
  }
  return values;
}

function validateStart(value: unknown, label: string): DollyInputConnectionStartV10 {
  if (value === "from-head" || value === "from-now") return value;
  exactObject(value, ["checkpoint"], label);
  if (
    typeof value.checkpoint !== "string" ||
    !DECIMAL_SEQUENCE_PATTERN.test(value.checkpoint)
  ) {
    throw invalid(`${label}.checkpoint must be a canonical decimal sequence`);
  }
  return { checkpoint: value.checkpoint };
}

function validateScheduler(value: unknown): DollySchedulerConfigV10 {
  exactObject(value, [
    "pollIntervalMs",
    "retryBaseMs",
    "retryMaxMs",
    "maxConcurrentModules",
    "backpressureAction",
    "downstreamRecheckMs",
    "noProgressAfterMs",
    "retryJitterBasisPoints",
    "lowWatermarkBasisPoints",
    "policy",
    "policyFailureAction",
  ], "core.scheduler");
  exactObject(value.policy, ["kind"], "core.scheduler.policy");
  if (value.policy.kind !== "fixed") {
    throw invalid("core.scheduler.policy.kind must be fixed in version 10");
  }
  if (value.policyFailureAction !== "quarantine") {
    throw invalid("core.scheduler.policyFailureAction must be quarantine in version 10");
  }
  if (value.retryJitterBasisPoints !== 0) {
    throw invalid("core.scheduler.retryJitterBasisPoints must be zero in version 10");
  }
  const backpressureActions = new Set([
    "pause-upstream",
    "delay-upstream",
    "reject-upstream-run",
  ]);
  if (typeof value.backpressureAction !== "string" || !backpressureActions.has(value.backpressureAction)) {
    throw invalid("core.scheduler.backpressureAction is unsupported");
  }
  const scheduler: DollySchedulerConfigV10 = {
    pollIntervalMs: integer(value.pollIntervalMs, "core.scheduler.pollIntervalMs", 1, 60_000),
    retryBaseMs: integer(value.retryBaseMs, "core.scheduler.retryBaseMs", 1, 3_600_000),
    retryMaxMs: integer(value.retryMaxMs, "core.scheduler.retryMaxMs", 1, 86_400_000),
    maxConcurrentModules: integer(
      value.maxConcurrentModules,
      "core.scheduler.maxConcurrentModules",
      1,
      MAX_CONFIGURED_MODULES,
    ),
    backpressureAction: value.backpressureAction as DollySchedulerConfigV10["backpressureAction"],
    downstreamRecheckMs: integer(
      value.downstreamRecheckMs,
      "core.scheduler.downstreamRecheckMs",
      1,
      MAX_TIMER_DELAY_MS,
    ),
    noProgressAfterMs: integer(
      value.noProgressAfterMs,
      "core.scheduler.noProgressAfterMs",
      1,
      MAX_TIMER_DELAY_MS,
    ),
    retryJitterBasisPoints: 0,
    lowWatermarkBasisPoints: integer(
      value.lowWatermarkBasisPoints,
      "core.scheduler.lowWatermarkBasisPoints",
      1,
      10_000,
    ),
    policy: { kind: "fixed" },
    policyFailureAction: "quarantine",
  };
  if (scheduler.retryMaxMs < scheduler.retryBaseMs) {
    throw invalid("core.scheduler.retryMaxMs must be no smaller than retryBaseMs");
  }
  return scheduler;
}

function validatePermissionReferences(
  value: unknown,
  label: string,
): DollyPermissionPolicyReferenceV10[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw invalid(`${label} must be an array with at most 256 entries`);
  }
  const references = value.map((candidate, index) => {
    exactObject(candidate, ["policyId", "revision"], `${label}[${index}]`);
    return {
      policyId: identifier(candidate.policyId, `${label}[${index}].policyId`),
      revision: digest(candidate.revision, `${label}[${index}].revision`),
    };
  });
  const ids = references.map((reference) => reference.policyId);
  if (new Set(ids).size !== ids.length) {
    throw invalid(`${label} contains duplicate policyId values`);
  }
  return references;
}

function validateExecution(value: unknown, label: string): DollyLinuxProcessExecutionV10 {
  exactObject(value, ["kind", "isolation", "limits"], label);
  if (value.kind !== "linux-process") {
    throw invalid(`${label}.kind is unsupported`);
  }
  if (value.isolation !== "process" && value.isolation !== "sandbox") {
    throw invalid(`${label}.isolation is unsupported`);
  }
  exactObject(value.limits, [
    "memoryMaxBytes",
    "maxTasks",
    "cpuQuotaMicros",
    "cpuPeriodMicros",
    "maxOpenFiles",
  ], `${label}.limits`);
  const memoryMaxBytes = integer(
    value.limits.memoryMaxBytes,
    `${label}.limits.memoryMaxBytes`,
    1,
  );
  if (memoryMaxBytes % 4_096 !== 0) {
    throw invalid(`${label}.limits.memoryMaxBytes must be aligned to 4096 bytes`);
  }
  return {
    kind: "linux-process",
    isolation: value.isolation,
    limits: {
      memoryMaxBytes,
      maxTasks: integer(value.limits.maxTasks, `${label}.limits.maxTasks`, 1),
      cpuQuotaMicros: integer(
        value.limits.cpuQuotaMicros,
        `${label}.limits.cpuQuotaMicros`,
        1,
      ),
      cpuPeriodMicros: integer(
        value.limits.cpuPeriodMicros,
        `${label}.limits.cpuPeriodMicros`,
        1_000,
        1_000_000,
      ),
      maxOpenFiles: integer(
        value.limits.maxOpenFiles,
        `${label}.limits.maxOpenFiles`,
        16,
        1_048_576,
      ),
    },
  };
}

interface ParsedModuleShape {
  readonly raw: Record<string, unknown>;
  readonly policyReferences: readonly DollyPermissionPolicyReferenceV10[];
  readonly inputConnections: readonly DollyInputConnectionV10[];
  readonly outputPageIds: readonly string[];
  readonly execution: DollyLinuxProcessExecutionV10;
  readonly declaredExternalEffects: "none" | "core-capabilities-only";
  readonly claim: DollyModuleClaimLimitsV10;
  readonly mailbox: DollyModuleMailboxLimitsV10;
  readonly sourceRequestMaxBytes: number | null;
}

function parseModuleShape(value: unknown, index: number): ParsedModuleShape {
  const label = `modules[${index}]`;
  exactObject(value, [
    "moduleId",
    "extensionId",
    "packageVersion",
    "moduleKind",
    "configurationReference",
    "permissionPolicyReferences",
    "inputConnections",
    "outputPageIds",
    "activation",
    "declaredExternalEffects",
    "execution",
    "limits",
    "timeouts",
  ], label);
  exactObject(value.configurationReference, [
    "configId",
    "revision",
    "configVersion",
  ], `${label}.configurationReference`);
  exactObject(value.limits, [
    "claim",
    "mailbox",
    "sourceRequestMaxBytes",
    "maxInputBytes",
    "maxResultBytes",
    "maxFrameBytes",
    "maxRunsPerGeneration",
    "maxGenerations",
  ], `${label}.limits`);
  exactObject(value.limits.claim, [
    "baselineCount",
    "baselineBytes",
    "maxCount",
    "maxBytes",
  ], `${label}.limits.claim`);
  const claim: DollyModuleClaimLimitsV10 = {
    baselineCount: integer(
      value.limits.claim.baselineCount,
      `${label}.limits.claim.baselineCount`,
      1,
      MAX_CLAIM_COUNT,
    ),
    baselineBytes: integer(
      value.limits.claim.baselineBytes,
      `${label}.limits.claim.baselineBytes`,
      1,
      MAX_CONFIGURED_BYTES,
    ),
    maxCount: integer(
      value.limits.claim.maxCount,
      `${label}.limits.claim.maxCount`,
      1,
      MAX_CLAIM_COUNT,
    ),
    maxBytes: integer(
      value.limits.claim.maxBytes,
      `${label}.limits.claim.maxBytes`,
      256,
      MAX_CONFIGURED_BYTES,
    ),
  };
  if (claim.baselineCount > claim.maxCount || claim.baselineBytes > claim.maxBytes) {
    throw invalid(`${label}.limits.claim baseline exceeds its hard maximum`);
  }
  exactObject(value.limits.mailbox, [
    "maxResidentCount",
    "maxResidentBytes",
  ], `${label}.limits.mailbox`);
  const mailbox = {
    maxResidentCount: integer(
      value.limits.mailbox.maxResidentCount,
      `${label}.limits.mailbox.maxResidentCount`,
      1,
    ),
    maxResidentBytes: integer(
      value.limits.mailbox.maxResidentBytes,
      `${label}.limits.mailbox.maxResidentBytes`,
      1,
      MAX_CONFIGURED_BYTES,
    ),
  };
  const policyReferences = validatePermissionReferences(
    value.permissionPolicyReferences,
    `${label}.permissionPolicyReferences`,
  );
  if (!Array.isArray(value.inputConnections) || value.inputConnections.length > 64) {
    throw invalid(`${label}.inputConnections must be an array with at most 64 entries`);
  }
  const inputConnections = value.inputConnections.map((candidate, connectionIndex) => {
    const connectionLabel = `${label}.inputConnections[${connectionIndex}]`;
    exactObject(candidate, ["pageId", "start"], connectionLabel);
    return {
      pageId: identifier(candidate.pageId, `${connectionLabel}.pageId`),
      start: validateStart(candidate.start, `${connectionLabel}.start`),
    };
  });
  if (new Set(inputConnections.map((connection) => connection.pageId)).size !== inputConnections.length) {
    throw invalid(`${label}.inputConnections contains duplicate Page identifiers`);
  }
  const outputPageIds = uniqueIdentifiers(value.outputPageIds, `${label}.outputPageIds`, 64);
  const declaredExternalEffects = value.declaredExternalEffects;
  if (declaredExternalEffects !== "none" && declaredExternalEffects !== "core-capabilities-only") {
    throw invalid(`${label}.declaredExternalEffects is unsupported`);
  }
  if (declaredExternalEffects === "none" && policyReferences.length !== 0) {
    throw invalid(`${label} declaring no external effects cannot reference permission policies`);
  }
  const maxInputBytes = integer(
    value.limits.maxInputBytes,
    `${label}.limits.maxInputBytes`,
    256,
    MAX_MODULE_FRAME_BYTES - MODULE_FRAME_OVERHEAD_BYTES,
  );
  const sourceRequestMaxBytes = value.limits.sourceRequestMaxBytes === null
    ? null
    : integer(
        value.limits.sourceRequestMaxBytes,
        `${label}.limits.sourceRequestMaxBytes`,
        1,
        MAX_CONFIGURED_BYTES,
      );
  if (
    sourceRequestMaxBytes !== null &&
    (sourceRequestMaxBytes > maxInputBytes || sourceRequestMaxBytes > mailbox.maxResidentBytes)
  ) {
    throw invalid(
      `${label}.limits.sourceRequestMaxBytes exceeds its input or mailbox byte limit`,
    );
  }
  return {
    raw: value,
    policyReferences,
    inputConnections,
    outputPageIds,
    execution: validateExecution(value.execution, `${label}.execution`),
    declaredExternalEffects,
    claim,
    mailbox,
    sourceRequestMaxBytes,
  };
}

function projectedModuleForV9(module: ParsedModuleShape): JsonValue {
  const source = isPlainObject(module.raw.activation) && module.raw.activation.kind === "source";
  return {
    moduleId: module.raw.moduleId as JsonValue,
    extensionId: module.raw.extensionId as JsonValue,
    packageVersion: module.raw.packageVersion as JsonValue,
    moduleKind: module.raw.moduleKind as JsonValue,
    isolation: module.execution.isolation,
    configurationReference: module.raw.configurationReference as JsonValue,
    permissionPolicyIds: module.policyReferences.map((reference) => reference.policyId),
    inputPageIds: module.inputConnections.map((connection) => connection.pageId),
    outputPageIds: [...module.outputPageIds],
    subscriptionStart: "from-head",
    activation: module.raw.activation as JsonValue,
    limits: {
      claim: source ? null : {
        maxCount: module.claim.maxCount,
        maxBytes: module.claim.maxBytes,
      },
      maxInputBytes: module.raw.limits && isPlainObject(module.raw.limits)
        ? module.raw.limits.maxInputBytes as JsonValue
        : null,
      maxResultBytes: module.raw.limits && isPlainObject(module.raw.limits)
        ? module.raw.limits.maxResultBytes as JsonValue
        : null,
      maxFrameBytes: module.raw.limits && isPlainObject(module.raw.limits)
        ? module.raw.limits.maxFrameBytes as JsonValue
        : null,
      maxRunsPerGeneration: module.raw.limits && isPlainObject(module.raw.limits)
        ? module.raw.limits.maxRunsPerGeneration as JsonValue
        : null,
      maxGenerations: module.raw.limits && isPlainObject(module.raw.limits)
        ? module.raw.limits.maxGenerations as JsonValue
        : null,
    },
    timeouts: module.raw.timeouts as JsonValue,
  };
}

/**
 * Validates the complete reserved version-10 document without registering it
 * as the product instance schema. Product bootstrap remains version 9 only.
 */
export function validateDollyInstanceConfigV10Draft(value: JsonValue): DollyInstanceConfigV10Draft {
  exactObject(value, [
    "schemaVersion",
    "instanceId",
    "displayName",
    "stateDirectory",
    "core",
    "pages",
    "modules",
    "logging",
  ], "configuration");
  if (value.schemaVersion !== "dolly.instance/10") {
    throw invalid("Configuration schemaVersion must be dolly.instance/10");
  }
  exactObject(value.core, ["limits", "media", "scheduler"], "core");
  exactObject(value.core.limits, [
    "maxFailedAttempts",
    "maxStateBytes",
    "maxModuleResultCommitJournalBytes",
    "maxRegisteredContentValueBytes",
  ], "core.limits");
  const maxRegisteredContentValueBytes = integer(
    value.core.limits.maxRegisteredContentValueBytes,
    "core.limits.maxRegisteredContentValueBytes",
    1,
    MAX_CONFIGURED_BYTES,
  );
  const scheduler = validateScheduler(value.core.scheduler);
  if (!Array.isArray(value.modules) || value.modules.length > MAX_CONFIGURED_MODULES) {
    throw invalid(`modules must be an array with at most ${MAX_CONFIGURED_MODULES} entries`);
  }
  const parsedModules = value.modules.map(parseModuleShape);
  const projected = validateDollyInstanceConfig({
    schemaVersion: "dolly.instance/9",
    instanceId: value.instanceId,
    displayName: value.displayName,
    stateDirectory: value.stateDirectory,
    core: {
      limits: {
        maxFailedAttempts: value.core.limits.maxFailedAttempts,
        maxStateBytes: value.core.limits.maxStateBytes,
        maxModuleResultCommitJournalBytes:
          value.core.limits.maxModuleResultCommitJournalBytes,
      },
      media: value.core.media,
      scheduler: {
        pollIntervalMs: scheduler.pollIntervalMs,
        retryBaseMs: scheduler.retryBaseMs,
        retryMaxMs: scheduler.retryMaxMs,
      },
    },
    pages: value.pages,
    modules: parsedModules.map(projectedModuleForV9),
    logging: value.logging,
  } as unknown as JsonValue);

  const modules = parsedModules.map((parsed, index): DollyModuleConfigV10 => {
    const common = projected.modules[index]!;
    const source = common.activation.kind === "source";
    if (source) {
      if (parsed.inputConnections.length !== 0) {
        throw invalid(`Source Module ${common.moduleId} cannot have input connections`, true);
      }
      if (parsed.claim.baselineCount !== 1 || parsed.claim.maxCount !== 1) {
        throw invalid(`Source Module ${common.moduleId} Claim counts must both equal one`);
      }
      if (parsed.claim.maxBytes !== common.limits.maxInputBytes) {
        throw invalid(
          `Source Module ${common.moduleId} Claim maxBytes must equal maxInputBytes`,
        );
      }
      if (parsed.sourceRequestMaxBytes === null) {
        throw invalid(`Source Module ${common.moduleId} requires sourceRequestMaxBytes`);
      }
    } else {
      if (parsed.inputConnections.length === 0) {
        throw invalid(`Non-source Module ${common.moduleId} requires an input connection`, true);
      }
      if (parsed.sourceRequestMaxBytes !== null) {
        throw invalid(`Non-source Module ${common.moduleId} requires sourceRequestMaxBytes null`);
      }
    }
    return {
      moduleId: common.moduleId,
      extensionId: common.extensionId,
      packageVersion: common.packageVersion,
      moduleKind: common.moduleKind,
      configurationReference: common.configurationReference,
      permissionPolicyReferences: parsed.policyReferences,
      inputConnections: parsed.inputConnections,
      outputPageIds: parsed.outputPageIds,
      activation: common.activation,
      declaredExternalEffects: parsed.declaredExternalEffects,
      execution: parsed.execution,
      limits: {
        claim: parsed.claim,
        mailbox: parsed.mailbox,
        sourceRequestMaxBytes: parsed.sourceRequestMaxBytes,
        maxInputBytes: common.limits.maxInputBytes,
        maxResultBytes: common.limits.maxResultBytes,
        maxFrameBytes: common.limits.maxFrameBytes,
        maxRunsPerGeneration: common.limits.maxRunsPerGeneration,
        maxGenerations: common.limits.maxGenerations,
      },
      timeouts: common.timeouts,
    };
  });

  // One accepted result broadcasts one Block to every configured output Page.
  // If a consumer subscribes to more than one of those Pages it receives one
  // Delivery per Page, so an empty mailbox must fit the full multiplicity.
  for (const producer of modules) {
    for (const consumer of modules) {
      const consumerPages = new Set(
        consumer.inputConnections.map((connection) => connection.pageId),
      );
      const multiplicity = producer.outputPageIds.filter((pageId) =>
        consumerPages.has(pageId)
      ).length;
      if (multiplicity === 0) continue;
      const requiredBytes = producer.limits.maxResultBytes * multiplicity;
      if (!Number.isSafeInteger(requiredBytes)) {
        throw invalid(
          `Output from Module ${producer.moduleId} has an unsafe mailbox byte projection`,
          true,
        );
      }
      if (
        consumer.limits.mailbox.maxResidentCount < multiplicity ||
        consumer.limits.mailbox.maxResidentBytes < requiredBytes
      ) {
        throw invalid(
          `Module ${consumer.moduleId} mailbox cannot hold one maximum result from ${producer.moduleId} across ${multiplicity} input connections`,
          true,
        );
      }
    }
  }

  return deepFreeze({
    schemaVersion: "dolly.instance/10",
    instanceId: projected.instanceId,
    displayName: projected.displayName,
    stateDirectory: projected.stateDirectory,
    core: {
      limits: {
        ...projected.core.limits,
        maxRegisteredContentValueBytes,
      },
      media: projected.core.media,
      scheduler,
    },
    pages: projected.pages,
    modules,
    logging: projected.logging,
  });
}

function validateMigrationModule(
  value: unknown,
  index: number,
): DollyInstanceV10ModuleMigrationInput {
  const label = `migration.modules[${index}]`;
  exactObject(value, [
    "moduleId",
    "claimBaseline",
    "mailbox",
    "sourceRequestMaxBytes",
    "execution",
    "declaredExternalEffects",
    "permissionPolicyReferences",
  ], label);
  exactObject(value.claimBaseline, ["count", "bytes"], `${label}.claimBaseline`);
  exactObject(value.mailbox, ["maxResidentCount", "maxResidentBytes"], `${label}.mailbox`);
  if (value.declaredExternalEffects !== "none" && value.declaredExternalEffects !== "core-capabilities-only") {
    throw invalid(`${label}.declaredExternalEffects is unsupported`);
  }
  return {
    moduleId: identifier(value.moduleId, `${label}.moduleId`),
    claimBaseline: {
      count: integer(value.claimBaseline.count, `${label}.claimBaseline.count`, 1, MAX_CLAIM_COUNT),
      bytes: integer(value.claimBaseline.bytes, `${label}.claimBaseline.bytes`, 1, MAX_CONFIGURED_BYTES),
    },
    mailbox: {
      maxResidentCount: integer(
        value.mailbox.maxResidentCount,
        `${label}.mailbox.maxResidentCount`,
        1,
      ),
      maxResidentBytes: integer(
        value.mailbox.maxResidentBytes,
        `${label}.mailbox.maxResidentBytes`,
        1,
        MAX_CONFIGURED_BYTES,
      ),
    },
    sourceRequestMaxBytes: value.sourceRequestMaxBytes === null
      ? null
      : integer(
          value.sourceRequestMaxBytes,
          `${label}.sourceRequestMaxBytes`,
          1,
          MAX_CONFIGURED_BYTES,
        ),
    execution: validateExecution(value.execution, `${label}.execution`),
    declaredExternalEffects: value.declaredExternalEffects,
    permissionPolicyReferences: validatePermissionReferences(
      value.permissionPolicyReferences,
      `${label}.permissionPolicyReferences`,
    ),
  };
}

/**
 * Builds a side-effect-free migration plan. Persisting it still requires an
 * instance configuration store to recheck `expectedSourceRevision` and commit
 * a new revision atomically.
 */
export function planDollyInstanceConfigV10Migration(
  source: DollyInstanceConfigV9Snapshot,
  input: JsonValue,
): DollyInstanceV10MigrationPlan {
  const validatedSource = validateDollyInstanceConfig(source.document as JsonValue);
  const sourceRevision = digest(
    source.configRevision,
    "source.configRevision",
  );
  exactObject(input, [
    "schemaVersion",
    "expectedSourceRevision",
    "maxRegisteredContentValueBytes",
    "scheduler",
    "modules",
  ], "migration");
  if (input.schemaVersion !== "dolly.instance-v10-migration-input/1") {
    throw invalid("migration.schemaVersion is unsupported");
  }
  const expectedSourceRevision = digest(
    input.expectedSourceRevision,
    "migration.expectedSourceRevision",
  );
  if (sourceRevision !== expectedSourceRevision) {
    throw invalid("migration.expectedSourceRevision does not match the source snapshot");
  }
  const maxRegisteredContentValueBytes = integer(
    input.maxRegisteredContentValueBytes,
    "migration.maxRegisteredContentValueBytes",
    1,
    MAX_CONFIGURED_BYTES,
  );
  const scheduler = validateScheduler(input.scheduler);
  if (!Array.isArray(input.modules) || input.modules.length > MAX_CONFIGURED_MODULES) {
    throw invalid(`migration.modules must have at most ${MAX_CONFIGURED_MODULES} entries`);
  }
  const migrationModules = input.modules.map(validateMigrationModule);
  const migrationIds = migrationModules.map((module) => module.moduleId);
  if (new Set(migrationIds).size !== migrationIds.length) {
    throw invalid("migration.modules contains duplicate Module identifiers");
  }
  const configuredIds = validatedSource.modules.map((module) => module.moduleId);
  const missing = configuredIds.filter((moduleId) => !migrationIds.includes(moduleId));
  const extra = migrationIds.filter((moduleId) => !configuredIds.includes(moduleId));
  if (missing.length > 0 || extra.length > 0) {
    throw invalid(
      `migration Module set does not match configuration; missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}`,
    );
  }
  const migrationById = new Map(migrationModules.map((module) => [module.moduleId, module]));
  const document = validateDollyInstanceConfigV10Draft({
    schemaVersion: "dolly.instance/10",
    instanceId: validatedSource.instanceId,
    displayName: validatedSource.displayName,
    stateDirectory: validatedSource.stateDirectory,
    core: {
      limits: {
        ...validatedSource.core.limits,
        maxRegisteredContentValueBytes,
      },
      media: validatedSource.core.media,
      scheduler,
    },
    pages: validatedSource.pages,
    modules: validatedSource.modules.map((module) => {
      const migration = migrationById.get(module.moduleId)!;
      if (migration.execution.isolation !== module.isolation) {
        throw invalid(
          `migration execution isolation for Module ${module.moduleId} does not match version 9`,
        );
      }
      const policyIds = migration.permissionPolicyReferences.map((reference) => reference.policyId);
      if (
        policyIds.length !== module.permissionPolicyIds.length ||
        policyIds.some((policyId, index) => policyId !== module.permissionPolicyIds[index])
      ) {
        throw invalid(
          `migration permission policy references for Module ${module.moduleId} do not match version 9 order`,
        );
      }
      const sourceModule = module.activation.kind === "source";
      const maxClaimCount = sourceModule ? 1 : module.limits.claim!.maxCount;
      const maxClaimBytes = sourceModule
        ? module.limits.maxInputBytes
        : module.limits.claim!.maxBytes;
      if (migration.claimBaseline.count > maxClaimCount || migration.claimBaseline.bytes > maxClaimBytes) {
        throw invalid(`migration Claim baseline exceeds Module ${module.moduleId} maximum`);
      }
      return {
        moduleId: module.moduleId,
        extensionId: module.extensionId,
        packageVersion: module.packageVersion,
        moduleKind: module.moduleKind,
        configurationReference: module.configurationReference,
        permissionPolicyReferences: migration.permissionPolicyReferences,
        inputConnections: module.inputPageIds.map((pageId) => ({
          pageId,
          start: module.subscriptionStart,
        })),
        outputPageIds: module.outputPageIds,
        activation: module.activation,
        declaredExternalEffects: migration.declaredExternalEffects,
        execution: migration.execution,
        limits: {
          claim: {
            baselineCount: sourceModule ? 1 : migration.claimBaseline.count,
            baselineBytes: migration.claimBaseline.bytes,
            maxCount: maxClaimCount,
            maxBytes: maxClaimBytes,
          },
          mailbox: migration.mailbox,
          sourceRequestMaxBytes: migration.sourceRequestMaxBytes,
          maxInputBytes: module.limits.maxInputBytes,
          maxResultBytes: module.limits.maxResultBytes,
          maxFrameBytes: module.limits.maxFrameBytes,
          maxRunsPerGeneration: module.limits.maxRunsPerGeneration,
          maxGenerations: module.limits.maxGenerations,
        },
        timeouts: module.timeouts,
      };
    }),
    logging: validatedSource.logging,
  } as unknown as JsonValue);
  return deepFreeze({
    schemaVersion: "dolly.instance-v10-migration-plan/1",
    sourceSchemaVersion: "dolly.instance/9",
    expectedSourceRevision,
    document,
  });
}
