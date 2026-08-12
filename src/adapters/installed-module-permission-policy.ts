import type { JsonValue } from "../core/canonical-json.js";
import {
  createModulePrivateStorageCapabilityV2,
  ModulePrivateStorageBackend,
  type ModulePrivateStorageLimitsV2,
  type ModulePrivateStorageOperation,
} from "../core/capabilities/module-private-storage-capability.js";
import type { ExtensionProcessHost } from "../core/extension-process-host.js";
import { FileToolJournalRepository } from "../core/file-tool-journal-repository.js";
import type { InstalledExtensionModule } from "../core/installed-extension-module.js";
import type {
  ModelInvocationBudgets,
} from "../core/model-provider-broker.js";
import type { DescriptorRef } from "../core/model-provider-descriptor.js";
import {
  createModelOperationCapabilityV2,
  createModelOperationCapabilityV3,
  createToolInvocationCapabilityV2,
  type ChatModelBrokerPort,
  type ModelOperationLimits,
  type ModelOutputContractKind,
  type ToolInvocationV2Limits,
} from "../core/provider-capabilities/index.js";
import {
  ToolPolicySession,
  ToolRegistry,
  type ToolExecutor,
  type ToolTurnBudget,
} from "../core/tool-policy.js";

const POLICY_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,254}[A-Za-z0-9])?$/u;
const setups = new WeakSet<InstalledModulePermissionPolicySetup>();
const SETUP_TOKEN = Symbol("installed-module-permission-policy-setup");

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
  readonly chat: ChatModelBrokerPort;
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
  readonly #configuredHosts = new WeakSet<ExtensionProcessHost>();

  constructor(
    token: symbol,
    snapshot: InstalledModulePermissionPolicySetupSnapshot,
    policies: readonly InstalledModulePermissionPolicy[],
    now: () => number,
    nextRequestId: (() => string) | undefined,
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
    const definitions = this.#policies.map((policy) => {
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
      const modelOptions = {
        descriptor: policy.descriptor,
        ownerScope: policy.ownerScope,
        budgets: policy.budgets,
        executionScope: "active-run" as const,
        expiresAt,
        now: () => new Date(this.#now()).toISOString(),
        chat: policy.chat,
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
      return policy.mediaRequirementIds === undefined
        ? createModelOperationCapabilityV2(modelOptions)
        : createModelOperationCapabilityV3({
            ...modelOptions,
            mediaRequirementIds: policy.mediaRequirementIds,
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

  setupFor(resolved: InstalledExtensionModule): InstalledModulePermissionPolicySetup {
    const policyIds = [...resolved.module.permissionPolicyIds].sort();
    const policies = policyIds.map((policyId) => {
      const policy = this.#policies.get(policyId);
      if (policy === undefined) {
        throw new TypeError(`Installed Module permission policy ${policyId} is not registered`);
      }
      return policy;
    });
    const reference = resolved.module.configurationReference;
    return new InstalledModulePermissionPolicySetup(
      SETUP_TOKEN,
      {
        instanceId: resolved.instanceId,
        moduleId: resolved.module.moduleId,
        extensionId: resolved.installation.manifest.extensionId,
        packageDigest: resolved.installation.packageDigest,
        configurationRevision: reference.revision,
        policyIds,
        capabilities: policies.map((policy) => {
          if (policy.kind === "registered-tools") {
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
            return {
              capabilityType: "module-private-storage" as const,
              capabilityVersion: "v2" as const,
              policyId: policy.policyId,
              operations: [...policy.operations],
              limits: { ...policy.limits },
              effectPolicy: "persistent-storage" as const,
            };
          }
          return {
            capabilityType: "model-operation" as const,
            capabilityVersion: policy.mediaRequirementIds === undefined
              ? "v2" as const
              : "v3" as const,
            policyId: policy.policyId,
            streaming: "required" as const,
            ...(policy.mediaRequirementIds === undefined
              ? {}
              : { mediaRequirementIds: [...policy.mediaRequirementIds] }),
          };
        }),
      },
      policies,
      this.#now,
      this.#nextRequestId,
    );
  }
}

/** A closed JSON projection suitable for audit records without endpoint or secret values. */
export function installedPermissionPolicyAuditProjection(
  setup: InstalledModulePermissionPolicySetup,
): JsonValue {
  return setup.snapshot as unknown as JsonValue;
}
