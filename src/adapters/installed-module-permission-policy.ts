import type { JsonValue } from "../core/canonical-json.js";
import type { ExtensionProcessHost } from "../core/extension-process-host.js";
import type { InstalledExtensionModule } from "../core/installed-extension-module.js";
import type {
  ModelInvocationBudgets,
} from "../core/model-provider-broker.js";
import type { DescriptorRef } from "../core/model-provider-descriptor.js";
import {
  createModelOperationCapabilityV2,
  type ChatModelBrokerPort,
  type ModelOperationLimits,
  type ModelOutputContractKind,
} from "../core/provider-capabilities/index.js";

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

export interface InstalledModulePermissionPolicyRegistryOptions {
  readonly policies: readonly InstalledStrictStreamingChatPolicy[];
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
  readonly capabilities: readonly {
    readonly capabilityType: "model-operation";
    readonly capabilityVersion: "v2";
    readonly policyId: string;
    readonly streaming: "required";
  }[];
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

function immutablePolicy(
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
    reasoningPolicies: Object.freeze([...new Set(policy.reasoningPolicies)]),
    roles: Object.freeze([...new Set(policy.roles)]),
    limits: Object.freeze({ ...policy.limits }),
  });
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
  readonly #policies: readonly InstalledStrictStreamingChatPolicy[];
  readonly #now: () => number;
  readonly #nextRequestId: (() => string) | undefined;
  readonly #configuredHosts = new WeakSet<ExtensionProcessHost>();

  constructor(
    token: symbol,
    snapshot: InstalledModulePermissionPolicySetupSnapshot,
    policies: readonly InstalledStrictStreamingChatPolicy[],
    now: () => number,
    nextRequestId: (() => string) | undefined,
  ) {
    if (token !== SETUP_TOKEN) {
      throw new TypeError("Installed Module permission setup must come from its Host registry");
    }
    this.snapshot = Object.freeze({
      ...snapshot,
      policyIds: Object.freeze([...snapshot.policyIds]),
      capabilities: Object.freeze(snapshot.capabilities.map((entry) => Object.freeze({ ...entry }))),
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
    this.#configuredHosts.add(host);
    for (const policy of this.#policies) {
      const nowMs = this.#now();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new TypeError("Installed model policy clock is invalid");
      }
      const expiresMs = nowMs + policy.capabilityLifetimeMs;
      if (!Number.isSafeInteger(expiresMs) || expiresMs > 8_640_000_000_000_000) {
        throw new TypeError("Installed model capability expiry is outside the safe time range");
      }
      const definition = createModelOperationCapabilityV2({
        descriptor: policy.descriptor,
        ownerScope: policy.ownerScope,
        budgets: policy.budgets,
        executionScope: "active-run",
        expiresAt: new Date(expiresMs).toISOString(),
        now: () => new Date(this.#now()).toISOString(),
        chat: policy.chat,
        operations: ["chat"],
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
      });
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
  readonly #policies = new Map<string, InstalledStrictStreamingChatPolicy>();
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
        capabilities: policies.map((policy) => ({
          capabilityType: "model-operation",
          capabilityVersion: "v2",
          policyId: policy.policyId,
          streaming: "required",
        })),
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
