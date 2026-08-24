import {
  canonicalJsonDigest,
  canonicalizeJson,
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "../core/canonical-json.js";
import {
  assertStartupAuthorityPermissionContext,
  type StartupAuthorityPermission,
  type StartupAuthorityPermissionContext,
  type StartupAuthorityPolicyBinding,
} from "../core/startup-authority-premise.js";
import {
  RuntimeAuthorityDatabaseError,
  type PermissionPolicyDefinition,
} from "./storage/runtime-authority-database.js";
import type { VerifiedInstalledComponentOrigin } from "../core/installed-component-origin.js";
import {
  createModulePrivateStorageCapabilityV2,
  ModulePrivateStorageBackend,
  type ModulePrivateStorageLimitsV2,
  type ModulePrivateStorageOperation,
} from "../core/capabilities/module-private-storage-capability.js";
import type { ExtensionProcessHost } from "../core/extension-process-host.js";
import { FileToolJournalRepository } from "../core/file-tool-journal-repository.js";
import {
  assertReservedV10InstalledModulePlan,
  type InstalledExtensionModule,
  type ReservedV10InstalledModulePlan,
} from "../core/installed-extension-module.js";
import type {
  ChatModelBrokerOptions,
  ModelInvocationBudgets,
  ModelMediaResolver,
} from "../core/model-provider-broker.js";
import { ChatModelBroker } from "../core/model-provider-broker.js";
import {
  ModelDescriptorRegistry,
  type DescriptorRef,
} from "../core/model-provider-descriptor.js";
import { EndpointBindingRegistry } from "../core/model-provider-binding.js";
import {
  createModelOperationCapabilityV2,
  createModelOperationCapabilityV3,
  createToolInvocationCapabilityV2,
  DEFAULT_MODEL_OPERATION_LIMITS,
  type ChatModelBrokerPort,
  type ModelOperationLimits,
  type ModelOutputContractKind,
  type ToolInvocationV2Limits,
} from "../core/provider-capabilities/index.js";
import {
  resolveLlmModuleConfiguration,
  validateLlmModuleConfiguration,
} from "../extensions/llm/module-configuration.js";
import {
  ToolPolicySession,
  ToolRegistry,
  type ToolExecutor,
  type ToolTurnBudget,
} from "../core/tool-policy.js";

const POLICY_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,254}[A-Za-z0-9])?$/u;
const POLICY_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const setups = new WeakSet<InstalledModulePermissionPolicySetup>();
const SETUP_TOKEN = Symbol("installed-module-permission-policy-setup");
const RESERVED_V10_POLICY_SELECTIONS = new WeakMap<
  object,
  readonly InstalledModulePermissionPolicy[]
>();

/**
 * One operator-selected policy for chat generation. The ordinary meaning of
 * this record is deliberately narrow: it binds one policy identifier to one
 * reviewed model descriptor and finite budgets. It does not let an Extension
 * provide an endpoint, credential, schema, transport, or capability handler.
 */
export interface InstalledStrictStreamingChatPolicy {
  readonly kind: "strict-streaming-chat";
  readonly policyId: string;
  readonly descriptor: DescriptorRef;
  readonly ownerScope: string;
  readonly budgets: ModelInvocationBudgets;
  /** Text-only test policies may use an already reviewed Host broker port. */
  readonly chat?: ChatModelBrokerPort;
  /**
   * Product Broker dependencies. A Media policy omits the resolver: the
   * installed runtime injects its FileCore active-Run resolver when it creates
   * the broker, so an operator cannot substitute Extension-provided bytes.
   */
  readonly brokerOptions?: Omit<ChatModelBrokerOptions, "media">;
  readonly outputContracts: readonly ModelOutputContractKind[];
  /** Omitted for text-only v2; non-empty selects delivered-Media v3. */
  readonly mediaRequirementIds?: readonly string[];
  readonly reasoningPolicies: readonly ("default" | "prefer" | "require" | "disable")[];
  readonly roles: readonly string[];
  readonly limits: Partial<ModelOperationLimits> & {
    readonly maxInvocations: number;
    readonly maxInvocationsPerRun: number;
    readonly maxInvocationsPerWindow: number;
    readonly rateWindowMs: number;
  };
  readonly capabilityLifetimeMs: number;
  readonly maxConcurrentInvocations?: number;
}

/**
 * One operator-selected read-only tool set. The registry is the executable
 * source of truth for both the Extension-visible contract and Host-side
 * validation; the crash-recoverable journal keeps a Module job on the same
 * round history across process replacement. Effectful tools remain refused
 * until approval accounting and external-effect recovery are closed together.
 */
export interface InstalledRegisteredToolPolicy {
  readonly kind: "registered-tools";
  readonly policyId: string;
  readonly registry: ToolRegistry;
  readonly repository: FileToolJournalRepository;
  readonly executor: ToolExecutor;
  readonly budget: ToolTurnBudget;
  readonly approvalPolicyRevision: string;
  readonly limits: ToolInvocationV2Limits;
  readonly capabilityLifetimeMs: number;
  readonly maxConcurrentInvocations?: number;
}

/**
 * One Host-owned private-storage policy for a simple sourced task checkpoint.
 * The first candidate deliberately omits delete so an Agent cannot erase its
 * own recovery evidence through this permission.
 */
export interface InstalledModulePrivateStoragePolicy {
  readonly kind: "module-private-storage";
  readonly policyId: string;
  readonly backend: ModulePrivateStorageBackend;
  readonly operations: readonly Exclude<ModulePrivateStorageOperation, "delete">[];
  readonly limits: ModulePrivateStorageLimitsV2;
  readonly capabilityLifetimeMs: number;
  readonly maxConcurrentInvocations?: number;
}

export type InstalledModulePermissionPolicy =
  | InstalledStrictStreamingChatPolicy
  | InstalledRegisteredToolPolicy
  | InstalledModulePrivateStoragePolicy;

export interface InstalledModulePermissionPolicyRegistryOptions {
  readonly policies: readonly InstalledModulePermissionPolicy[];
  readonly now?: () => number;
  readonly nextRequestId?: () => string;
}

export interface ReservedV10InstalledPermissionPolicyRevision {
  readonly policyId: string;
  readonly revision: string;
  readonly policy: InstalledModulePermissionPolicy;
}

export interface ReservedV10InstalledPermissionPolicyRegistryOptions {
  readonly policies: readonly ReservedV10InstalledPermissionPolicyRevision[];
}

export interface ReservedV10InstalledPermissionPolicySelection {
  readonly snapshot: JsonValue;
  readonly selectionDigest: string;
}

/**
 * One fresh live backend binding resolved from the durable authority premise.
 * The public fields are the closed, versioned identity that a consumer may
 * audit; the private registry state retains the executable Host policy.
 */
export interface InstalledModulePermissionBinding {
  readonly schemaVersion: "dolly.installed-module-permission-binding/1";
  readonly daemonInstallationId: string;
  readonly instanceId: string;
  readonly controllerGenerationId: string;
  readonly configRevision: number;
  readonly configDigest: string;
  readonly premisesDigest: string;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly policyDefinitionDigest: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly bindingDigest: string;
  readonly definition: PermissionPolicyDefinition;
  readonly origin: VerifiedInstalledComponentOrigin;
}

interface InstalledModulePermissionBindingState {
  readonly registry: ReservedV10InstalledPermissionPolicyRegistry;
  readonly policy: InstalledModulePermissionPolicy;
  readonly permission: StartupAuthorityPermission;
  readonly binding: StartupAuthorityPolicyBinding;
}

const INSTALLED_MODULE_PERMISSION_BINDINGS = new WeakMap<
  object,
  InstalledModulePermissionBindingState
>();

export interface InstalledModulePermissionPolicySetupSnapshot {
  readonly instanceId: string;
  readonly moduleId: string;
  readonly extensionId: string;
  readonly packageDigest: string;
  readonly configurationRevision: string;
  readonly policyIds: readonly string[];
  readonly capabilities: readonly (
    | {
        readonly capabilityType: "model-operation";
        readonly capabilityVersion: "v2" | "v3";

        readonly policyId: string;
        readonly streaming: "required";
        readonly mediaRequirementIds?: readonly string[];
      }
    | {
        readonly capabilityType: "tool-invocation";
        readonly capabilityVersion: "v2";
        readonly policyId: string;
        readonly registryDigest: string;
        readonly toolWireNames: readonly string[];
        readonly effectPolicy: "read-only";
      }
    | {
        readonly capabilityType: "module-private-storage";
        readonly capabilityVersion: "v2";
        readonly policyId: string;
        readonly operations: readonly Exclude<ModulePrivateStorageOperation, "delete">[];
        readonly limits: Readonly<ModulePrivateStorageLimitsV2>;
        readonly effectPolicy: "persistent-storage";
      }
  )[];
}

function assertIdentifier(value: string, label: string): void {
  if (!POLICY_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a finite policy identifier`);
  }
}

function assertPolicyRevision(value: string, label: string): void {
  if (!POLICY_REVISION_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical SHA-256 revision`);
  }
}
function unavailable(message: string, cause?: unknown): RuntimeAuthorityDatabaseError {
  return new RuntimeAuthorityDatabaseError(
    "MODULE_ACTIVATION_POLICY_BINDING_UNAVAILABLE",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function sameCanonicalJson(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left as JsonValue) === canonicalizeJson(right as JsonValue);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertFiniteBudgets(budgets: ModelInvocationBudgets): void {
  for (const [label, value] of Object.entries(budgets)) {
    if (value === undefined) continue;
    if (typeof value === "number") {
      assertPositiveInteger(value, `budgets.${label}`);
      continue;
    }
    if (
      label !== "maxCost" ||
      typeof value !== "object" ||
      value === null ||
      typeof value.currency !== "string" ||
      value.currency.length === 0 ||
      typeof value.decimalAmount !== "string" ||
      value.decimalAmount.length === 0
    ) {
      throw new TypeError(`budgets.${label} is invalid`);
    }
  }
}

function immutableChatPolicy(
  policy: InstalledStrictStreamingChatPolicy,
): InstalledStrictStreamingChatPolicy {
  if (policy.kind !== "strict-streaming-chat") {
    throw new TypeError("Installed model permission policy kind is unsupported");
  }
  assertIdentifier(policy.policyId, "policyId");
  if (policy.descriptor.operation !== "chat-completion") {
    throw new TypeError("Installed strict-streaming policy requires a chat descriptor");
  }
  if (typeof policy.ownerScope !== "string" || policy.ownerScope.length === 0) {
    throw new TypeError("Installed model policy ownerScope must be non-empty");
  }
  if (policy.outputContracts.length === 0) {
    throw new TypeError("Installed model policy requires at least one output contract");
  }
  if (policy.reasoningPolicies.length === 0) {
    throw new TypeError("Installed model policy requires at least one reasoning policy");
  }
  const mediaRequirementIds = policy.mediaRequirementIds === undefined
    ? []
    : [...new Set(policy.mediaRequirementIds)];
  if (policy.mediaRequirementIds !== undefined && mediaRequirementIds.length === 0) {
    throw new TypeError("Installed model Media policy requires a non-empty requirement list");
  }
  for (const requirementId of mediaRequirementIds) {
    assertIdentifier(requirementId, "mediaRequirementId");
  }
  if (
    mediaRequirementIds.length > 0 &&
    (policy.budgets.maxMediaItems === undefined ||
      policy.budgets.maxResolvedMediaBytes === undefined)
  ) {
    throw new TypeError(
      "Installed model Media policy requires finite item and resolved-byte budgets",
    );
  }
  const hasDirectChat = typeof policy.chat?.invoke === "function";
  const hasBrokerOptions = policy.brokerOptions !== undefined;
  if (mediaRequirementIds.length === 0) {
    if (hasDirectChat === hasBrokerOptions) {
      throw new TypeError(
        "Installed text model policy requires exactly one direct chat port or product Broker options",
      );
    }
  } else if (policy.chat !== undefined || !hasBrokerOptions) {
    throw new TypeError(
      "Installed model Media policy requires product Broker options and cannot accept a prebuilt chat port",
    );
  }
  if (policy.brokerOptions !== undefined) {
    if (
      Object.getPrototypeOf(policy.brokerOptions.descriptors) !==
        ModelDescriptorRegistry.prototype ||
      Object.getPrototypeOf(policy.brokerOptions.bindings) !==
        EndpointBindingRegistry.prototype
    ) {
      throw new TypeError(
        "Installed model policy requires direct descriptor and endpoint-binding registries",
      );
    }
    policy.brokerOptions.descriptors.snapshot(policy.descriptor);
    policy.brokerOptions.bindings.snapshot(policy.descriptor);
  }
  if (policy.roles.length === 0) {
    throw new TypeError("Installed model policy requires at least one message role");
  }
  assertFiniteBudgets(policy.budgets);
  for (const [label, value] of Object.entries({
    capabilityLifetimeMs: policy.capabilityLifetimeMs,
    maxInvocations: policy.limits.maxInvocations,
    maxInvocationsPerRun: policy.limits.maxInvocationsPerRun,
    maxInvocationsPerWindow: policy.limits.maxInvocationsPerWindow,
    rateWindowMs: policy.limits.rateWindowMs,
  })) {
    assertPositiveInteger(value, label);
  }
  if (policy.limits.maxInvocationsPerRun > policy.limits.maxInvocations) {
    throw new TypeError("Installed model policy Run limit exceeds its process-session limit");
  }
  return Object.freeze({
    ...policy,
    budgets: Object.freeze({ ...policy.budgets }),
    outputContracts: Object.freeze([...new Set(policy.outputContracts)]),
    ...(mediaRequirementIds.length === 0
      ? {}
      : { mediaRequirementIds: Object.freeze(mediaRequirementIds) }),
    ...(policy.brokerOptions === undefined
      ? {}
      : { brokerOptions: Object.freeze({ ...policy.brokerOptions }) }),
    reasoningPolicies: Object.freeze([...new Set(policy.reasoningPolicies)]),
    roles: Object.freeze([...new Set(policy.roles)]),
    limits: Object.freeze({ ...policy.limits }),
  });
}

function immutableToolPolicy(
  policy: InstalledRegisteredToolPolicy,
): InstalledRegisteredToolPolicy {
  if (policy.kind !== "registered-tools") {
    throw new TypeError("Installed tool permission policy kind is unsupported");
  }
  assertIdentifier(policy.policyId, "policyId");
  if (!(policy.registry instanceof ToolRegistry)) {
    throw new TypeError("Installed tool policy requires one Host-owned ToolRegistry");
  }
  if (!(policy.repository instanceof FileToolJournalRepository)) {
    throw new TypeError("Installed tool policy requires one FileToolJournalRepository");
  }
  if (typeof policy.executor?.execute !== "function") {
    throw new TypeError("Installed tool policy executor is invalid");
  }
  assertIdentifier(policy.approvalPolicyRevision, "approvalPolicyRevision");
  for (const field of ["maxRounds", "maxCalls", "maxCallsPerRound", "maxCallBytes"] as const) {
    assertPositiveInteger(policy.budget[field], `budget.${field}`);
  }
  assertNonNegativeInteger(policy.budget.maxApprovals, "budget.maxApprovals");
  for (const [label, value] of Object.entries(policy.limits)) {
    assertPositiveInteger(value, `limits.${label}`);
  }
  assertPositiveInteger(policy.capabilityLifetimeMs, "capabilityLifetimeMs");
  if (policy.maxConcurrentInvocations !== undefined) {
    assertPositiveInteger(policy.maxConcurrentInvocations, "maxConcurrentInvocations");
  }
  const snapshot = policy.registry.snapshot();
  if (snapshot.tools.length === 0) {
    throw new TypeError("Installed tool policy requires at least one selected tool");
  }
  if (
    snapshot.tools.some((tool) => tool.effectClass !== "read" || tool.approval !== "never") ||
    policy.budget.maxApprovals !== 0
  ) {
    throw new TypeError(
      "Installed tool policy currently permits only read tools that never request approval",
    );
  }
  if (policy.budget.maxCallsPerRound > policy.limits.maxCallsPerRound) {
    throw new TypeError("Installed tool policy Run budget exceeds its calls-per-round limit");
  }
  if (policy.limits.maxInvocationsPerRun > policy.limits.maxInvocations) {
    throw new TypeError("Installed tool policy Run limit exceeds its process-session limit");
  }
  return Object.freeze({
    ...policy,
    budget: Object.freeze({ ...policy.budget }),
    limits: Object.freeze({ ...policy.limits }),
  });
}

function immutableStoragePolicy(
  policy: InstalledModulePrivateStoragePolicy,
): InstalledModulePrivateStoragePolicy {
  if (policy.kind !== "module-private-storage") {
    throw new TypeError("Installed private-storage permission policy kind is unsupported");
  }
  assertIdentifier(policy.policyId, "policyId");
  if (!(policy.backend instanceof ModulePrivateStorageBackend)) {
    throw new TypeError("Installed private-storage policy requires one Host-owned backend");
  }
  if (!Array.isArray(policy.operations) || policy.operations.length === 0) {
    throw new TypeError("Installed private-storage policy requires at least one operation");
  }
  const operations = [...new Set(policy.operations)];
  if (
    operations.some(
      (operation) => operation !== "get" && operation !== "list" && operation !== "set",
    )
  ) {
    throw new TypeError(
      "Installed private-storage policy currently permits only get, list, and set",
    );
  }
  const requiredLimitFields = [
    "maxKeyBytes",
    "maxValueBytes",
    "maxEntries",
    "maxTotalBytes",
    "maxListResults",
    "maxArgumentBytes",
    "maxResultBytes",
    "maxInvocations",
    "maxInvocationsPerRun",
  ] as const;
  if (
    Object.keys(policy.limits).length !== requiredLimitFields.length ||
    requiredLimitFields.some((field) => !Object.hasOwn(policy.limits, field))
  ) {
    throw new TypeError("Installed private-storage policy limits are incomplete or open");
  }
  for (const [label, value] of Object.entries(policy.limits)) {
    assertPositiveInteger(value, `limits.${label}`);
  }
  assertPositiveInteger(policy.capabilityLifetimeMs, "capabilityLifetimeMs");
  if (policy.maxConcurrentInvocations !== undefined) {
    assertPositiveInteger(policy.maxConcurrentInvocations, "maxConcurrentInvocations");
  }
  if (policy.limits.maxInvocationsPerRun > policy.limits.maxInvocations) {
    throw new TypeError(
      "Installed private-storage Run limit exceeds its process-session limit",
    );
  }
  return Object.freeze({
    ...policy,
    operations: Object.freeze(operations),
    limits: Object.freeze({ ...policy.limits }),
  });
}

function immutablePolicy(
  policy: InstalledModulePermissionPolicy,
): InstalledModulePermissionPolicy {
  return policy.kind === "strict-streaming-chat"
    ? immutableChatPolicy(policy)
    : policy.kind === "registered-tools"
      ? immutableToolPolicy(policy)
      : immutableStoragePolicy(policy);
}
type InstalledCapabilityModel =
  | {
      readonly capabilityType: "model-operation";
      readonly capabilityVersion: "v2" | "v3";
    }
  | {
      readonly capabilityType: "tool-invocation" | "module-private-storage";
      readonly capabilityVersion: "v2";
    };

function capabilityModelForPolicy(
  policy: InstalledModulePermissionPolicy,
): InstalledCapabilityModel {
  if (policy.kind === "strict-streaming-chat") {
    return {
      capabilityType: "model-operation",
      capabilityVersion: policy.mediaRequirementIds === undefined ? "v2" : "v3",
    };
  }
  return {
    capabilityType: policy.kind === "registered-tools"
      ? "tool-invocation"
      : "module-private-storage",
    capabilityVersion: "v2",
  };
}
function capabilityModelsForResolvedModule(
  resolved: InstalledExtensionModule,
  policies: readonly InstalledModulePermissionPolicy[],
): readonly InstalledCapabilityModel[] {
  const derived = policies.map(capabilityModelForPolicy);
  const manifest = resolved.installation.manifest;
  if (manifest.schemaVersion !== "dolly.extension-package/10") return derived;
  const packageModule = manifest.modules.find(
    (candidate) => candidate.moduleKind === resolved.module.moduleKind,
  );
  if (packageModule === undefined) {
    throw new TypeError(
      `Installed Module ${resolved.module.moduleKind} has no version-10 package declaration`,
    );
  }
  return policies.map((policy, index) => {
    const requests = manifest.requestedCapabilities.filter(
      (capability) =>
        capability.moduleKind === packageModule.moduleKind &&
        capability.policyId === policy.policyId,
    );
    if (requests.length !== 1) {
      throw new TypeError(
        `Installed Module permission policy ${policy.policyId} has no unique version-10 capability request`,
      );
    }
    const requested = requests[0]!;
    const expected = derived[index]!;
    if (
      requested.capabilityType !== expected.capabilityType ||
      requested.capabilityVersion !== expected.capabilityVersion
    ) {
      throw new TypeError(
        `Installed Module capability ${requested.capabilityType}/${requested.capabilityVersion} does not match Host policy ${expected.capabilityType}/${expected.capabilityVersion}`,
      );
    }
    return expected;
  });
}

function capabilityModelForReservedPlan(
  installed: ReservedV10InstalledModulePlan,
  policy: InstalledModulePermissionPolicy,
  reference: Readonly<{ readonly policyId: string; readonly revision: string }>,
): InstalledCapabilityModel {
  const expected = capabilityModelForPolicy(policy);
  const manifest = installed.installation.manifest;
  if (manifest.schemaVersion !== "dolly.extension-package/10") return expected;
  const packageModule = manifest.modules.find(
    (candidate) => candidate.moduleKind === installed.module.moduleKind,
  );
  if (packageModule === undefined) {
    throw new TypeError(
      `Reserved version-10 Module ${installed.module.moduleKind} has no package declaration`,
    );
  }
  const requests = manifest.requestedCapabilities.filter(
    (capability) =>
      capability.moduleKind === packageModule.moduleKind &&
      capability.policyId === reference.policyId &&
      capability.policyRevision === reference.revision,
  );
  if (requests.length !== 1) {
    throw new TypeError(
      `Reserved version-10 policy ${policy.policyId}@${reference.revision} has no unique capability request`,
    );
  }
  const requested = requests[0]!;
  if (
    requested.capabilityType !== expected.capabilityType ||
    requested.capabilityVersion !== expected.capabilityVersion
  ) {
    throw new TypeError(
      `Reserved version-10 capability ${requested.capabilityType}/${requested.capabilityVersion} does not match Host policy ${expected.capabilityType}/${expected.capabilityVersion}`,
    );
  }
  return expected;
}

function definitionForImmutablePolicy(
  policy: InstalledModulePermissionPolicy,
): JsonValue {
  if (policy.kind === "strict-streaming-chat") {
    const effectiveLimits = { ...DEFAULT_MODEL_OPERATION_LIMITS, ...policy.limits };
    return deepFreeze({
      schemaVersion: "dolly.installed-permission-policy-definition/1",
      kind: policy.kind,
      policyId: policy.policyId,
      descriptor: policy.descriptor as unknown as JsonValue,
      ownerScope: policy.ownerScope,
      budgets: policy.budgets as unknown as JsonValue,
      brokerBinding: policy.brokerOptions === undefined
        ? "reviewed-direct-port"
        : "descriptor-and-endpoint-registries",
      outputContracts: [...policy.outputContracts],
      mediaRequirementIds: [...(policy.mediaRequirementIds ?? [])],
      reasoningPolicies: [...policy.reasoningPolicies],
      roles: [...policy.roles],
      limits: effectiveLimits as unknown as JsonValue,
      capabilityLifetimeMs: policy.capabilityLifetimeMs,
      maxConcurrentInvocations: policy.maxConcurrentInvocations ?? 1,
    } satisfies JsonValue);
  }
  if (policy.kind === "registered-tools") {
    const registry = policy.registry.snapshot();
    return deepFreeze({
      schemaVersion: "dolly.installed-permission-policy-definition/1",
      kind: policy.kind,
      policyId: policy.policyId,
      registryDigest: registry.registryDigest,
      toolWireNames: registry.tools.map((tool) => tool.name),
      budget: policy.budget as unknown as JsonValue,
      approvalPolicyRevision: policy.approvalPolicyRevision,
      limits: policy.limits as unknown as JsonValue,
      capabilityLifetimeMs: policy.capabilityLifetimeMs,
      maxConcurrentInvocations: policy.maxConcurrentInvocations ?? 1,
    } satisfies JsonValue);
  }
  return deepFreeze({
    schemaVersion: "dolly.installed-permission-policy-definition/1",
    kind: policy.kind,
    policyId: policy.policyId,
    operations: [...policy.operations],
    limits: policy.limits as unknown as JsonValue,
    capabilityLifetimeMs: policy.capabilityLifetimeMs,
    maxConcurrentInvocations: policy.maxConcurrentInvocations ?? 1,
  } satisfies JsonValue);
}

/**
 * Canonical, secret-free definition of every policy field the capability
 * factory consumes. Live broker, executor, repository, and storage objects do
 * not enter this JSON definition; a live binding is minted only after the
 * versioned Runtime authority premise matches it exactly.
 */
export function reservedV10InstalledPermissionPolicyDefinition(
  supplied: InstalledModulePermissionPolicy,
): JsonValue {
  return definitionForImmutablePolicy(immutablePolicy(supplied));
}

export function reservedV10InstalledPermissionPolicyRevision(
  supplied: InstalledModulePermissionPolicy,
): string {
  return canonicalJsonDigest(
    reservedV10InstalledPermissionPolicyDefinition(supplied),
  );
}

function assertBindingAuthority(
  permission: StartupAuthorityPermission,
  context: StartupAuthorityPermissionContext,
): void {
  try {
    assertStartupAuthorityPermissionContext(permission, context);
  } catch (error) {
    if (
      error instanceof RuntimeAuthorityDatabaseError &&
      error.code !== "MODULE_ACTIVATION_PREMISES_INVALID" &&
      error.code !== "MODULE_ACTIVATION_POLICY_BINDING_UNAVAILABLE"
    ) {
      throw error;
    }
    throw unavailable(
      "installed permission binding is stale or belongs to a different Runtime authority",
      error,
    );
  }
}

function assertInstalledPlanMatchesAuthority(
  installed: ReservedV10InstalledModulePlan,
  context: StartupAuthorityPermissionContext,
): VerifiedInstalledComponentOrigin {
  const snapshot = context.database.readCurrentConfig();
  if (snapshot === null) {
    throw unavailable("installed permission binding has no current Runtime authority configuration");
  }
  const canonicalConfig = snapshot.canonicalConfig;
  if (
    canonicalConfig === null ||
    typeof canonicalConfig !== "object" ||
    Array.isArray(canonicalConfig)
  ) {
    throw unavailable("installed permission binding authority configuration is not an object");
  }
  const runtimeConfig = Reflect.get(canonicalConfig, "runtime_config");
  if (
    runtimeConfig === null ||
    typeof runtimeConfig !== "object" ||
    Array.isArray(runtimeConfig) ||
    typeof Reflect.get(runtimeConfig, "instanceId") !== "string"
  ) {
    throw unavailable("installed permission binding authority configuration has no valid instance");
  }
  if (installed.instanceId !== Reflect.get(runtimeConfig, "instanceId")) {
    throw unavailable(
      "installed permission binding plan instance does not match the current Runtime authority",
    );
  }
  if (canonicalJsonDigest(runtimeConfig as unknown as JsonValue) !== installed.instanceConfigurationDigest) {
    throw unavailable(
      "installed permission binding plan configuration digest does not match the current Runtime authority",
    );
  }
  const modules = Reflect.get(runtimeConfig, "modules");
  if (!Array.isArray(modules)) {
    throw unavailable("installed permission binding authority configuration has no module list");
  }
  const currentModule = modules.find((candidate) =>
    candidate !== null &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    Reflect.get(candidate, "moduleId") === installed.module.moduleId
  );
  if (currentModule === undefined || !sameCanonicalJson(currentModule, installed.module)) {
    throw unavailable(
      "installed permission binding plan module does not match the current Runtime authority",
    );
  }
  const reference = installed.module.configurationReference;
  if (
    installed.configuration.configId !== reference.configId ||
    installed.configuration.revision !== reference.revision ||
    installed.configuration.configVersion !== reference.configVersion ||
    installed.packageModule.moduleKind !== installed.module.moduleKind ||
    installed.installation.manifest.extensionId !== installed.module.extensionId ||
    installed.installation.manifest.packageVersion !== installed.module.packageVersion
  ) {
    throw unavailable(
      "installed permission binding plan installation or configuration linkage is not exact",
    );
  }
  const manifest = installed.installation.manifest;
  const origin = context.origins.resolve({
    extensionId: manifest.extensionId,
    packageVersion: manifest.packageVersion,
  });
  if (
    origin.component_id !== manifest.extensionId ||
    origin.component_digest !== installed.installation.packageDigest
  ) {
    throw unavailable(
      "installed permission binding package or manifest provenance does not match its canonical origin",
    );
  }
  return origin;
}

/**
 * Rechecks a live binding against the exact durable premise and live Host
 * context that produced it. A structural copy, reopened database, released
 * controller, changed authority revision, or replaced origin registry cannot
 * pass this boundary.
 */
export function assertInstalledModulePermissionBinding(
  value: unknown,
  context: StartupAuthorityPermissionContext,
): asserts value is InstalledModulePermissionBinding {
  if (value === null || typeof value !== "object") {
    throw unavailable("installed permission binding was not minted by the Host policy registry");
  }
  const state = INSTALLED_MODULE_PERMISSION_BINDINGS.get(value);
  if (state === undefined) {
    throw unavailable("installed permission binding was not minted by the Host policy registry");
  }
  assertBindingAuthority(state.permission, context);
  const binding = value as InstalledModulePermissionBinding;
  const identity = context.database.identity;
  if (
    binding.schemaVersion !== "dolly.installed-module-permission-binding/1" ||
    binding.daemonInstallationId !== identity.daemonInstallationId ||
    binding.instanceId !== identity.instanceId ||
    binding.controllerGenerationId !== state.permission.controllerGenerationId ||
    binding.configRevision !== state.permission.configRevision ||
    binding.configDigest !== state.permission.configDigest ||
    binding.premisesDigest !== state.permission.premisesDigest ||
    binding.policyId !== state.binding.policy_id ||
    binding.policyRevision !== state.binding.policy_revision ||
    binding.policyDefinitionDigest !== state.binding.policy_definition_digest ||
    binding.bindingId !== state.binding.binding_id ||
    binding.bindingRevision !== state.binding.binding_revision ||
    binding.bindingDigest !== state.binding.binding_digest ||
    binding.origin !== state.binding.origin ||
    !sameCanonicalJson(binding.definition, state.binding.definition)
  ) {
    throw unavailable("installed permission binding identity does not match its durable premise");
  }
  if (
    canonicalJsonDigest(binding.definition.definition) !==
      reservedV10InstalledPermissionPolicyRevision(state.policy)
  ) {
    throw unavailable("installed permission binding definition no longer matches its Host policy");
  }
}

function assertInstalledLlmConfigurationPolicyBinding(
  resolved: InstalledExtensionModule,
  policies: readonly InstalledModulePermissionPolicy[],
): void {
  const raw = resolved.configuration.configuration;
  const declaresLlmConfiguration =
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    Reflect.get(raw, "schemaVersion") === "dolly.llm.module-configuration/1";
  const isLlmModule =
    resolved.module.extensionId === "dolly.llm" &&
    resolved.module.moduleKind === "conversation";
  if (!isLlmModule) {
    if (declaresLlmConfiguration) {
      throw new TypeError(
        "The reserved LLM configuration schema requires the dolly.llm conversation Module",
      );
    }
    return;
  }
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  ) {
    throw new TypeError(
      "The dolly.llm conversation Module requires its closed LLM configuration",
    );
  }
  const configuration = validateLlmModuleConfiguration(raw as JsonValue);
  if (configuration.model.streamingPolicy !== "required") {
    throw new TypeError(
      "The installed LLM candidate currently requires strict streaming configuration",
    );
  }
  const modelPolicies = policies.filter(
    (policy): policy is InstalledStrictStreamingChatPolicy =>
      policy.kind === "strict-streaming-chat",
  );
  if (
    modelPolicies.length !== 1 ||
    modelPolicies[0]!.policyId !== configuration.model.permissionPolicyId
  ) {
    throw new TypeError(
      "Installed LLM configuration must select exactly its one Host model permission policy",
    );
  }
  const modelPolicy = modelPolicies[0]!;
  if (modelPolicy.brokerOptions === undefined) {
    throw new TypeError(
      "Installed LLM configuration requires a Host descriptor registry, not a prebuilt chat port",
    );
  }
  const descriptor = modelPolicy.brokerOptions.descriptors.snapshot(modelPolicy.descriptor);
  resolveLlmModuleConfiguration(configuration, descriptor);
  if (!modelPolicy.reasoningPolicies.includes(configuration.model.reasoningPolicy)) {
    throw new TypeError(
      "Installed LLM configuration reasoning policy exceeds its Host permission policy",
    );
  }
  if (!modelPolicy.outputContracts.includes(configuration.model.outputContract)) {
    throw new TypeError(
      "Installed LLM configuration output contract exceeds its Host permission policy",
    );
  }
  const budgets = modelPolicy.budgets;
  if (
    budgets.maxInputTokens === undefined ||
    configuration.context.tokenBudget.maxInputTokens > budgets.maxInputTokens ||
    budgets.maxOutputTokens === undefined ||
    configuration.turn.maxOutputTokens > budgets.maxOutputTokens ||
    configuration.context.limits.maxTotalBytes > budgets.maxInputBytes ||
    configuration.turn.maxOutputBytes > budgets.maxOutputBytes ||
    configuration.turn.maxWallTimeMs > budgets.maxWallTimeMs
  ) {
    throw new TypeError(
      "Installed LLM configuration exceeds its Host model invocation budgets",
    );
  }
  const limits = { ...DEFAULT_MODEL_OPERATION_LIMITS, ...modelPolicy.limits };
  if (
    configuration.context.limits.maxMessages > limits.maxMessages ||
    configuration.context.limits.maxTextItemBytes > limits.maxPartBytes ||
    configuration.turn.maxOutputBytes > limits.maxResultBytes ||
    configuration.turn.maxProviderCalls > limits.maxInvocationsPerRun
  ) {
    throw new TypeError(
      "Installed LLM configuration exceeds its Host model capability limits",
    );
  }
  const toolPolicies = policies.filter(
    (policy): policy is InstalledRegisteredToolPolicy => policy.kind === "registered-tools",
  );
  const configuredToolPolicyIds = [...configuration.tools.policyIds].sort();
  const selectedToolPolicyIds = toolPolicies.map((policy) => policy.policyId).sort();
  if (
    configuredToolPolicyIds.length !== selectedToolPolicyIds.length ||
    configuredToolPolicyIds.some((policyId, index) => policyId !== selectedToolPolicyIds[index])
  ) {
    throw new TypeError(
      "Installed LLM configuration tool policies do not match its Host tool grants",
    );
  }
  if (toolPolicies.length > 1) {
    throw new TypeError(
      "Installed LLM configuration version 1 supports at most one aggregate tool policy",
    );
  }
  const toolPolicy = toolPolicies[0];
  if (
    toolPolicy !== undefined &&
    (configuration.tools.limits.maxRounds > toolPolicy.budget.maxRounds ||
      configuration.tools.limits.maxCalls > toolPolicy.budget.maxCalls ||
      configuration.tools.limits.maxCallsPerRound > toolPolicy.budget.maxCallsPerRound ||
      configuration.tools.limits.maxApprovals > toolPolicy.budget.maxApprovals ||
      configuration.tools.limits.maxCallBytes > toolPolicy.budget.maxCallBytes)
  ) {
    throw new TypeError(
      "Installed LLM configuration exceeds its Host tool policy budget",
    );
  }
}

function sameSelection(
  setup: InstalledModulePermissionPolicySetup,
  resolved: InstalledExtensionModule,
): boolean {
  const snapshot = setup.snapshot;
  const reference = resolved.module.configurationReference;
  return (
    snapshot.instanceId === resolved.instanceId &&
    snapshot.moduleId === resolved.module.moduleId &&
    snapshot.extensionId === resolved.installation.manifest.extensionId &&
    snapshot.packageDigest === resolved.installation.packageDigest &&
    snapshot.configurationRevision === reference.revision &&
    JSON.stringify(snapshot.policyIds) ===
      JSON.stringify([...resolved.module.permissionPolicyIds].sort())
  );
}

/**
 * Frozen Host setup derived from one installed Module and its selected policy
 * identifiers. It may configure multiple replacement process generations, but
 * it issues fresh capability definitions into each Host before startup.
 */
export class InstalledModulePermissionPolicySetup {
  readonly snapshot: InstalledModulePermissionPolicySetupSnapshot;
  readonly #policies: readonly InstalledModulePermissionPolicy[];
  readonly #now: () => number;
  readonly #nextRequestId: (() => string) | undefined;
  readonly #modelMediaResolver: ModelMediaResolver | undefined;
  readonly #configuredHosts = new WeakSet<ExtensionProcessHost>();

  constructor(
    token: symbol,
    snapshot: InstalledModulePermissionPolicySetupSnapshot,
    policies: readonly InstalledModulePermissionPolicy[],
    now: () => number,
    nextRequestId: (() => string) | undefined,
    modelMediaResolver: ModelMediaResolver | undefined,
  ) {
    if (token !== SETUP_TOKEN) {
      throw new TypeError("Installed Module permission setup must come from its Host registry");
    }
    this.snapshot = Object.freeze({
      ...snapshot,
      policyIds: Object.freeze([...snapshot.policyIds]),
      capabilities: Object.freeze(snapshot.capabilities.map((entry) => Object.freeze({
        ...entry,
        ...(entry.capabilityType === "tool-invocation"
          ? { toolWireNames: Object.freeze([...entry.toolWireNames]) }
          : entry.capabilityType === "module-private-storage"
            ? {
                operations: Object.freeze([...entry.operations]),
                limits: Object.freeze({ ...entry.limits }),
              }
            : entry.mediaRequirementIds === undefined
              ? {}
              : {
                  mediaRequirementIds: Object.freeze([
                    ...entry.mediaRequirementIds,
                  ]),
                }
        ),
      }))),
    });
    this.#policies = Object.freeze([...policies]);
    this.#now = now;
    this.#nextRequestId = nextRequestId;
    this.#modelMediaResolver = modelMediaResolver;
    setups.add(this);
  }

  assertMatches(resolved: InstalledExtensionModule): void {
    if (!setups.has(this) || !sameSelection(this, resolved)) {
      throw new TypeError(
        "Installed Module permission setup does not match its package, configuration, and selected policies",
      );
    }
  }

  configureHost(host: ExtensionProcessHost): void {
    if (!setups.has(this)) {
      throw new TypeError("Installed Module permission setup is not registry-issued");
    }
    if (this.#configuredHosts.has(host)) {
      throw new TypeError("Installed Module permission setup already configured this Host");
    }
    const hostSnapshot = host.snapshot;
    if (
      hostSnapshot.state !== "created" ||
      hostSnapshot.instanceId !== this.snapshot.instanceId ||
      hostSnapshot.moduleId !== this.snapshot.moduleId ||
      hostSnapshot.extensionId !== this.snapshot.extensionId
    ) {
      throw new TypeError(
        "Installed Module permission setup does not match the created Extension Host",
      );
    }
    const definitions = this.#policies.map((policy, index) => {
      const capability = this.snapshot.capabilities[index];
      if (
        capability === undefined ||
        (policy.kind === "registered-tools" &&
          (capability.capabilityType !== "tool-invocation" ||
            capability.capabilityVersion !== "v2")) ||
        (policy.kind === "module-private-storage" &&
          (capability.capabilityType !== "module-private-storage" ||
            capability.capabilityVersion !== "v2")) ||
        (policy.kind === "strict-streaming-chat" &&
          (capability.capabilityType !== "model-operation" ||
            capability.capabilityVersion !==
              (policy.mediaRequirementIds === undefined ? "v2" : "v3")))
      ) {
        throw new TypeError("Installed capability grant is not bound to its Host policy");
      }
      const nowMs = this.#now();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new TypeError("Installed model policy clock is invalid");
      }
      const expiresMs = nowMs + policy.capabilityLifetimeMs;
      if (!Number.isSafeInteger(expiresMs) || expiresMs > 8_640_000_000_000_000) {
        throw new TypeError("Installed model capability expiry is outside the safe time range");
      }
      const expiresAt = new Date(expiresMs).toISOString();
      if (policy.kind === "registered-tools") {
        return createToolInvocationCapabilityV2({
          executionScope: "active-run",
          expiresAt,
          operations: ["list-tools", "execute-round"],
          limits: policy.limits,
          maxConcurrentInvocations: policy.maxConcurrentInvocations ?? 1,
          resolveRun: ({ moduleJobId }) => ({
            registry: policy.registry,
            budget: policy.budget,
            policy: new ToolPolicySession({
              moduleJobId,
              registry: policy.registry,
              repository: policy.repository,
              approval: {
                decide: async () => ({
                  decision: "denied" as const,
                  code: "read-only-policy",
                }),
              },
              executor: policy.executor,
              budget: policy.budget,
              approvalPolicyRevision: policy.approvalPolicyRevision,
            }),
          }),
        });
      }
      if (policy.kind === "module-private-storage") {
        return createModulePrivateStorageCapabilityV2({
          backend: policy.backend,
          instanceId: this.snapshot.instanceId,
          moduleId: this.snapshot.moduleId,
          operations: policy.operations,
          executionScope: "active-run",
          expiresAt,
          limits: policy.limits,
          maxConcurrentInvocations: policy.maxConcurrentInvocations ?? 1,
          requireIdempotencyKey: true,
        });
      }
      const chat = policy.brokerOptions === undefined
        ? policy.chat!
        : new ChatModelBroker({
            ...policy.brokerOptions,
            ...(policy.mediaRequirementIds === undefined
              ? {}
              : { media: this.#modelMediaResolver! }),
          });
      const modelOptions = {
        descriptor: policy.descriptor,
        ownerScope: policy.ownerScope,
        budgets: policy.budgets,
        executionScope: "active-run" as const,
        expiresAt,
        now: () => new Date(this.#now()).toISOString(),
        chat: { invoke: chat.invoke.bind(chat) },
        operations: ["chat", "describe"] as const,
        reasoningPolicies: policy.reasoningPolicies,
        allowStreaming: true,
        requireStreaming: true,
        roles: policy.roles,
        limits: policy.limits,
        maxConcurrentInvocations: policy.maxConcurrentInvocations ?? 1,
        requireIdempotencyKey: true,
        ...(this.#nextRequestId === undefined
          ? {}
          : { nextRequestId: this.#nextRequestId }),
        outputContracts: policy.outputContracts,
      };
      if (capability.capabilityVersion === "v2") {
        return createModelOperationCapabilityV2(modelOptions);
      }
      return createModelOperationCapabilityV3({
        ...modelOptions,
        mediaRequirementIds: policy.mediaRequirementIds!,
      });
    });
    this.#configuredHosts.add(host);
    for (const definition of definitions) {
      host.grantCapability(definition.grant, definition.handler);
    }
  }
}

/**
 * Immutable in-process registry for operator-provided policy implementations.
 * Persistence of those policy records is intentionally still outside this
 * candidate boundary; public Module bootstrap therefore remains refused.
 */
export class InstalledModulePermissionPolicyRegistry {
  readonly #policies = new Map<string, InstalledModulePermissionPolicy>();
  readonly #now: () => number;
  readonly #nextRequestId: (() => string) | undefined;

  constructor(options: InstalledModulePermissionPolicyRegistryOptions) {
    this.#now = options.now ?? Date.now;
    this.#nextRequestId = options.nextRequestId;
    for (const supplied of options.policies) {
      const policy = immutablePolicy(supplied);
      if (this.#policies.has(policy.policyId)) {
        throw new TypeError(`Duplicate installed Module permission policy ${policy.policyId}`);
      }
      this.#policies.set(policy.policyId, policy);
    }
  }

  setupFor(
    resolved: InstalledExtensionModule,
    options: { readonly modelMediaResolver?: ModelMediaResolver } = {},
  ): InstalledModulePermissionPolicySetup {
    const policyIds = [...resolved.module.permissionPolicyIds].sort();
    const policies = policyIds.map((policyId) => {
      const policy = this.#policies.get(policyId);
      if (policy === undefined) {
        throw new TypeError(`Installed Module permission policy ${policyId} is not registered`);
      }
      return policy;
    });
    const minimumCapabilityLifetimeMs =
      resolved.module.timeouts.initializationTimeoutMs * 2 +
      resolved.module.timeouts.executionTimeoutMs +
      1;
    if (!Number.isSafeInteger(minimumCapabilityLifetimeMs)) {
      throw new TypeError(
        "Installed Module initialization and execution timeouts exceed the capability time range",
      );
    }
    if (
      policies.some(
        (policy) => policy.capabilityLifetimeMs < minimumCapabilityLifetimeMs,
      )
    ) {
      throw new TypeError(
        "Installed Module capability lifetime must cover initialization and one full execution",
      );
    }
    assertInstalledLlmConfigurationPolicyBinding(resolved, policies);
    const capabilityModels = capabilityModelsForResolvedModule(resolved, policies);
    const reference = resolved.module.configurationReference;
    if (
      policies.some(
        (policy) =>
          policy.kind === "strict-streaming-chat" &&
          policy.mediaRequirementIds !== undefined,
      ) &&
      options.modelMediaResolver === undefined
    ) {
      throw new TypeError(
        "Installed model Media policy requires the FileCore active-Run Media resolver",
      );
    }
    return new InstalledModulePermissionPolicySetup(
      SETUP_TOKEN,
      {
        instanceId: resolved.instanceId,
        moduleId: resolved.module.moduleId,
        extensionId: resolved.installation.manifest.extensionId,
        packageDigest: resolved.installation.packageDigest,
        configurationRevision: reference.revision,
        policyIds,
        capabilities: policies.map((policy, index) => {
          const capabilityModel = capabilityModels[index]!;
          if (
            capabilityModel.capabilityType === "tool-invocation" &&
            policy.kind !== "registered-tools"
          ) {
            throw new TypeError("Installed tool capability model does not match its Host policy");
          }
          if (
            capabilityModel.capabilityType === "module-private-storage" &&
            policy.kind !== "module-private-storage"
          ) {
            throw new TypeError(
              "Installed private-storage capability model does not match its Host policy",
            );
          }
          if (
            capabilityModel.capabilityType === "model-operation" &&
            policy.kind !== "strict-streaming-chat"
          ) {
            throw new TypeError("Installed model capability model does not match its Host policy");
          }
          if (policy.kind === "registered-tools") {
            if (
              capabilityModel.capabilityType !== "tool-invocation" ||
              capabilityModel.capabilityVersion !== "v2"
            ) {
              throw new TypeError("Installed tool grant model is not bound to its request");
            }
            return {
              capabilityType: "tool-invocation" as const,
              capabilityVersion: "v2" as const,
              policyId: policy.policyId,
              registryDigest: policy.registry.snapshot().registryDigest,
              toolWireNames: policy.registry.snapshot().tools.map((tool) => tool.name),
              effectPolicy: "read-only" as const,
            };
          }
          if (policy.kind === "module-private-storage") {
            if (
              capabilityModel.capabilityType !== "module-private-storage" ||
              capabilityModel.capabilityVersion !== "v2"
            ) {
              throw new TypeError(
                "Installed private-storage grant model is not bound to its request",
              );
            }
            return {
              capabilityType: "module-private-storage" as const,
              capabilityVersion: "v2" as const,
              policyId: policy.policyId,
              operations: [...policy.operations],
              limits: { ...policy.limits },
              effectPolicy: "persistent-storage" as const,
            };
          }
          if (
            capabilityModel.capabilityType !== "model-operation" ||
            capabilityModel.capabilityVersion !==
              (policy.mediaRequirementIds === undefined ? "v2" : "v3")
          ) {
            throw new TypeError("Installed model grant model is not bound to its request");
          }
          if (capabilityModel.capabilityVersion === "v2") {
            return {
              capabilityType: "model-operation" as const,
              capabilityVersion: "v2" as const,
              policyId: policy.policyId,
              streaming: "required" as const,
            };
          }
          return {
            capabilityType: "model-operation" as const,
            capabilityVersion: "v3" as const,
            policyId: policy.policyId,
            streaming: "required" as const,
            mediaRequirementIds: [...policy.mediaRequirementIds!],
          };
        }),
      },
      policies,
      this.#now,
      this.#nextRequestId,
      options.modelMediaResolver,
    );
  }
}

/**
 * Resolves the exact versioned policy references in a resolver-minted v10
 * installed plan. Selection remains inert until a current StartupAuthority
 * permission and Runtime authority context resolveLiveBindingsFor together.
 */
export class ReservedV10InstalledPermissionPolicyRegistry {
  readonly #policies = new Map<string, InstalledModulePermissionPolicy>();

  constructor(options: ReservedV10InstalledPermissionPolicyRegistryOptions) {
    const optionKeys = Object.keys(options);
    if (optionKeys.length !== 1 || optionKeys[0] !== "policies") {
      throw new TypeError(
        "Reserved version-10 permission policy registry options must contain only policies",
      );
    }
    if (!Array.isArray(options.policies)) {
      throw new TypeError("Reserved version-10 permission policies must be an array");
    }
    for (const supplied of options.policies) {
      if (
        supplied === null ||
        typeof supplied !== "object" ||
        Array.isArray(supplied) ||
        Object.keys(supplied).sort().join(",") !== "policy,policyId,revision"
      ) {
        throw new TypeError(
          "Reserved version-10 permission policy revision must be a closed object",
        );
      }
      assertIdentifier(supplied.policyId, "policyId");
      assertPolicyRevision(supplied.revision, "revision");
      if (supplied.policy.policyId !== supplied.policyId) {
        throw new TypeError(
          "Reserved version-10 policy implementation does not match its policyId",
        );
      }
      const policy = immutablePolicy(supplied.policy);
      const derivedRevision = canonicalJsonDigest(definitionForImmutablePolicy(policy));
      if (supplied.revision !== derivedRevision) {
        throw new TypeError(
          `Reserved version-10 permission policy ${supplied.policyId} revision does not match its canonical definition`,
        );
      }
      const key = `${supplied.policyId}\u0000${supplied.revision}`;
      if (this.#policies.has(key)) {
        throw new TypeError(
          `Duplicate reserved version-10 permission policy ${supplied.policyId}@${supplied.revision}`,
        );
      }
      this.#policies.set(key, policy);
    }
  }

  resolveFor(
    installed: ReservedV10InstalledModulePlan,
  ): ReservedV10InstalledPermissionPolicySelection {
    assertReservedV10InstalledModulePlan(installed);
    const policies = installed.module.permissionPolicyReferences.map((reference) => {
      const policy = this.#policies.get(`${reference.policyId}\u0000${reference.revision}`);
      if (policy === undefined) {
        throw new TypeError(
          `Reserved version-10 permission policy ${reference.policyId}@${reference.revision} is not registered`,
        );
      }
      return policy;
    });
    const capabilityModels = policies.map((policy, index) =>
      capabilityModelForReservedPlan(
        installed,
        policy,
        installed.module.permissionPolicyReferences[index]!,
      )
    );
    const snapshot = deepFreeze({
      schemaVersion: "dolly.reserved-v10-permission-policy-selection/1",
      instanceId: installed.instanceId,
      moduleId: installed.module.moduleId,
      installedPlanDigest: installed.provenanceDigest,
      packageDigest: installed.installation.packageDigest,
      configurationDigest: installed.configuration.configurationDigest,
      policies: installed.module.permissionPolicyReferences.map((reference, index) => ({
        policyId: reference.policyId,
        revision: reference.revision,
        kind: policies[index]!.kind,
        capabilityType: capabilityModels[index]!.capabilityType,
        capabilityVersion: capabilityModels[index]!.capabilityVersion,
      })),
    } satisfies JsonValue);
    const selection = Object.freeze({
      snapshot,
      selectionDigest: canonicalJsonDigest(snapshot),
    });
    RESERVED_V10_POLICY_SELECTIONS.set(selection, Object.freeze(policies));
    return selection;
  }
  resolveLiveBindingsFor(
    installed: ReservedV10InstalledModulePlan,
    permission: StartupAuthorityPermission,
    context: StartupAuthorityPermissionContext,
  ): readonly InstalledModulePermissionBinding[] {
    assertReservedV10InstalledModulePlan(installed);
    assertBindingAuthority(permission, context);
    const installedOrigin = assertInstalledPlanMatchesAuthority(installed, context);
    const identity = context.database.identity;
    const seenReferences = new Set<string>();
    const liveBindings = installed.module.permissionPolicyReferences.map((reference) => {
      const referenceKey = `${reference.policyId}\u0000${reference.revision}`;
      if (seenReferences.has(referenceKey)) {
        throw unavailable(
          "installed Module permission references contain a duplicate persistent identity",
        );
      }
      seenReferences.add(referenceKey);
      const policy = this.#policies.get(referenceKey);
      if (policy === undefined) {
        throw unavailable(
          `installed Module permission policy ${reference.policyId}@${reference.revision} is not registered`,
        );
      }
      const expectedDefinition = reservedV10InstalledPermissionPolicyDefinition(policy);
      const matches = permission.policyBindings.filter((binding) =>
        binding.policy_id === reference.policyId &&
        binding.policy_definition_digest === binding.definition.definition_digest &&
        binding.definition.policy_id === policy.policyId &&
        canonicalJsonDigest(binding.definition.definition) === reference.revision &&
        sameCanonicalJson(binding.definition.definition, expectedDefinition)
      );
      if (matches.length !== 1) {
        throw unavailable(
          `persistent permission binding for ${reference.policyId}@${reference.revision} is missing or ambiguous`,
        );
      }
      const binding = matches[0]!;
      if (!sameCanonicalJson(binding.origin, installedOrigin)) {
        throw unavailable(
          `persistent permission binding for ${reference.policyId}@${reference.revision} does not name the installed plan origin`,
        );
      }
      const definition = deepFreeze({
        ...binding.definition,
        definition: cloneJson(binding.definition.definition),
        origin: cloneJson(binding.definition.origin as unknown as JsonValue),
      }) as unknown as PermissionPolicyDefinition;
      const liveBinding = Object.freeze({
        schemaVersion: "dolly.installed-module-permission-binding/1" as const,
        daemonInstallationId: identity.daemonInstallationId,
        instanceId: identity.instanceId,
        controllerGenerationId: permission.controllerGenerationId,
        configRevision: permission.configRevision,
        configDigest: permission.configDigest,
        premisesDigest: permission.premisesDigest,
        policyId: binding.policy_id,
        policyRevision: binding.policy_revision,
        policyDefinitionDigest: binding.policy_definition_digest,
        bindingId: binding.binding_id,
        bindingRevision: binding.binding_revision,
        bindingDigest: binding.binding_digest,
        definition,
        origin: binding.origin,
      });
      INSTALLED_MODULE_PERMISSION_BINDINGS.set(liveBinding, {
        registry: this,
        policy,
        permission,
        binding,
      });
      return liveBinding;
    });
    return Object.freeze(liveBindings);
  }

  assertLiveBinding(
    value: unknown,
    context: StartupAuthorityPermissionContext,
  ): asserts value is InstalledModulePermissionBinding {
    if (
      value === null ||
      typeof value !== "object" ||
      INSTALLED_MODULE_PERMISSION_BINDINGS.get(value)?.registry !== this
    ) {
      throw unavailable("installed permission binding belongs to a different Host policy registry");
    }
    assertInstalledModulePermissionBinding(value, context);
  }
}

/** Rejects copied or stale v10 definition selections at later candidate seams. */
export function assertReservedV10InstalledPermissionPolicySelection(
  selection: unknown,
  installed: ReservedV10InstalledModulePlan,
): asserts selection is ReservedV10InstalledPermissionPolicySelection {
  assertReservedV10InstalledModulePlan(installed);
  if (
    selection === null ||
    typeof selection !== "object" ||
    !RESERVED_V10_POLICY_SELECTIONS.has(selection)
  ) {
    throw new TypeError(
      "Reserved version-10 permission policy selection was not minted by its revision registry",
    );
  }
  const snapshot = (selection as ReservedV10InstalledPermissionPolicySelection).snapshot;
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot) ||
    Reflect.get(snapshot, "installedPlanDigest") !== installed.provenanceDigest
  ) {
    throw new TypeError(
      "Reserved version-10 permission policy selection does not match its installed Module plan",
    );
  }
}

/** A closed JSON projection suitable for audit records without endpoint or secret values. */
export function installedPermissionPolicyAuditProjection(
  setup: InstalledModulePermissionPolicySetup,
): JsonValue {
  return setup.snapshot as unknown as JsonValue;
}
