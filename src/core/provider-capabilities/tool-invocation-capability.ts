import {
  canonicalJsonByteLength,
  canonicalJsonDigest,
  deepFreeze,
  type JsonValue,
} from "../canonical-json.js";
import {
  assertClosedArguments,
  assertHostIdentifier,
  assertPositiveLimit,
  capabilityArgumentError,
  capabilityQuotaError,
  readField,
  requireString,
  resolveExecutionScope,
  type ExtensionCapabilityDefinition,
} from "../capabilities/capability-support.js";
import {
  ExtensionCapabilityError,
  type ExtensionCapabilityGrant,
  type ExtensionCapabilityInvocationContext,
  type ExtensionExecutionScope,
} from "../extension-capability.js";
import {
  ToolRegistry,
  ToolPolicyError,
  type ProviderToolDefinition,
  type ToolCallRequest,
  type ToolDescriptor,
  type ToolRegistrySnapshot,
  type ToolRoundResult,
  type ToolTurnBudget,
} from "../tool-policy.js";

export const TOOL_INVOCATION_CAPABILITY_TYPE = "tool-invocation";
export const TOOL_INVOCATION_CAPABILITY_VERSION = "v1";
export const TOOL_INVOCATION_CAPABILITY_VERSION_V2 = "v2";

export type ToolInvocationOperation = "list-tools" | "execute-round";

const TOOL_OPERATIONS: readonly ToolInvocationOperation[] = ["list-tools", "execute-round"];

/**
 * The refusal reasons this capability adds on top of the tool policy state
 * machine's own terminal results. A refusal here means the round never
 * started; a denial inside a round is an honest tool result instead.
 */
export type ToolInvocationDenialReason =
  | "TOOL_OPERATION_DENIED"
  | "TOOL_ROUND_BLOCKED_BY_UNKNOWN_OUTCOME"
  | "TOOL_ROUND_INVALID"
  | "TOOL_ROUND_CONFLICT"
  | "TOOL_BUDGET_EXHAUSTED"
  | "TOOL_JOURNAL_CONFLICT"
  | "TOOL_ROUND_INCOMPLETE"
  | "TOOL_ROUND_SCOPE_MISMATCH";

/**
 * The part of `ToolRegistry` this capability reads. The narrower structural
 * type keeps the capability from holding registry mutation authority and lets
 * a host pass an already-selected per-request view.
 */
export interface ToolRegistryView {
  resolveWireName(wireName: string): ToolDescriptor | null;
  providerDefinitions(): readonly ProviderToolDefinition[];
}

/** The part of `ToolPolicySession` this capability drives. */
export interface ToolPolicySessionPort {
  executeRound(input: {
    readonly roundIndex: number;
    readonly calls: readonly ToolCallRequest[];
    readonly signal?: AbortSignal;
  }): Promise<ToolRoundResult>;
}

export interface ToolRegistrySnapshotView extends ToolRegistryView {
  snapshot(): ToolRegistrySnapshot;
}

export interface ToolPolicySessionV2Port extends ToolPolicySessionPort {
  readonly moduleJobId: string;
  readonly registryDigest: string;
}

export interface ToolInvocationLimits {
  readonly maxCallsPerRound: number;
  readonly maxArgumentBytes: number;
  readonly maxResultBytes: number;
  readonly maxInvocations: number;
}

export const DEFAULT_TOOL_INVOCATION_LIMITS: ToolInvocationLimits = deepFreeze({
  maxCallsPerRound: 8,
  maxArgumentBytes: 64 * 1_024,
  maxResultBytes: 128 * 1_024,
  maxInvocations: 64,
});

export interface ToolInvocationV2Limits extends ToolInvocationLimits {
  readonly maxInvocationsPerRun: number;
}

export const DEFAULT_TOOL_INVOCATION_V2_LIMITS: ToolInvocationV2Limits = deepFreeze({
  ...DEFAULT_TOOL_INVOCATION_LIMITS,
  maxInvocationsPerRun: 16,
});

export interface ToolInvocationCapabilityOptions {
  /** The host-owned tool policy session for exactly this Module job. */
  readonly policy: ToolPolicySessionPort;
  /** The tools selected for this Module, session, and request. */
  readonly registry: ToolRegistryView;
  /** Bounds the state machine already enforces; mirrored into the grant scope. */
  readonly budget: ToolTurnBudget;
  readonly executionScope: ExtensionExecutionScope;
  readonly expiresAt: string;
  readonly approvalPolicyRevision: string;
  readonly operations?: readonly ToolInvocationOperation[];
  readonly limits?: Partial<ToolInvocationLimits>;
  readonly maxConcurrentInvocations?: number;
}

export interface ToolInvocationRunBinding {
  readonly policy: ToolPolicySessionV2Port;
  readonly registry: ToolRegistrySnapshotView;
  readonly budget: ToolTurnBudget;
}

export interface ToolInvocationActiveRunContext {
  readonly moduleJobId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly deadline: string;
}

interface ToolInvocationCapabilityV2CommonOptions {
  readonly expiresAt: string;
  readonly operations?: readonly ToolInvocationOperation[];
  readonly limits?: Partial<ToolInvocationV2Limits>;
  readonly maxConcurrentInvocations?: number;
}

export type ToolInvocationCapabilityV2Options = ToolInvocationCapabilityV2CommonOptions &
  (
    | {
        readonly executionScope: ExtensionExecutionScope;
        readonly binding: ToolInvocationRunBinding;
        readonly resolveRun?: never;
      }
    | {
        readonly executionScope: "active-run";
        readonly binding?: never;
        readonly resolveRun: (
          context: ToolInvocationActiveRunContext,
        ) => ToolInvocationRunBinding;
      }
  );

function toolDenied(
  reason: ToolInvocationDenialReason,
  message: string,
  details: Readonly<Record<string, JsonValue>> = {},
): ExtensionCapabilityError {
  return new ExtensionCapabilityError("CAPABILITY_DENIED", message, { reason, ...details });
}

function configError(message: string): ExtensionCapabilityError {
  return new ExtensionCapabilityError("CAPABILITY_CONFIG_INVALID", message);
}

function resolveLimits(overrides: Partial<ToolInvocationLimits> | undefined): ToolInvocationLimits {
  const limits = { ...DEFAULT_TOOL_INVOCATION_LIMITS, ...(overrides ?? {}) };
  for (const [label, value] of Object.entries(limits)) {
    assertPositiveLimit(value, `tool invocation ${label}`);
  }
  return deepFreeze(limits);
}

function resolveV2Limits(
  overrides: Partial<ToolInvocationV2Limits> | undefined,
): ToolInvocationV2Limits {
  const limits = { ...DEFAULT_TOOL_INVOCATION_V2_LIMITS, ...(overrides ?? {}) };
  for (const [label, value] of Object.entries(limits)) {
    assertPositiveLimit(value, `tool invocation ${label}`);
  }
  return deepFreeze(limits);
}

function validateBudget(budget: ToolTurnBudget): ToolTurnBudget {
  for (const field of ["maxRounds", "maxCalls", "maxCallsPerRound", "maxCallBytes"] as const) {
    assertPositiveLimit(budget[field], `tool budget ${field}`);
  }
  if (!Number.isSafeInteger(budget.maxApprovals) || budget.maxApprovals < 0) {
    throw configError("tool budget maxApprovals must be a non-negative safe integer");
  }
  return deepFreeze({ ...budget });
}

function validateOperations(
  requested: readonly ToolInvocationOperation[] | undefined,
): readonly ToolInvocationOperation[] {
  const operations = [...new Set(requested ?? TOOL_OPERATIONS)];
  if (operations.length === 0) {
    throw configError("A tool invocation capability requires at least one operation");
  }
  for (const operation of operations) {
    if (!TOOL_OPERATIONS.includes(operation)) {
      throw configError(`Tool invocation does not define the operation ${String(operation)}`);
    }
  }
  return operations;
}

function readToolCalls(
  value: JsonValue,
  limits: Pick<ToolInvocationLimits, "maxCallsPerRound">,
): readonly ToolCallRequest[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw capabilityArgumentError("tool.execute-round.calls must be a non-empty array");
  }
  if (value.length > limits.maxCallsPerRound) {
    throw capabilityQuotaError("maxCallsPerRound", limits.maxCallsPerRound);
  }
  return value.map((call, index) => {
    const label = `tool.execute-round.calls[${index}]`;
    const parsed = assertClosedArguments(
      call as JsonValue,
      ["callId", "name", "argumentsJson"],
      label,
    );
    const callId = requireString(parsed, "callId", label);
    const name = requireString(parsed, "name", label);
    const argumentsJson = requireString(parsed, "argumentsJson", label);
    return { providerCallId: callId, wireName: name, argumentsJson };
  });
}

/**
 * Translates a tool policy failure into a typed capability error.
 *
 * The state machine's own code travels in `details.reason` so an extension can
 * tell an exhausted budget from a replayed round without the host inventing a
 * second, parallel error vocabulary.
 */
function translatePolicyError(error: ToolPolicyError): ExtensionCapabilityError {
  const details = { reason: error.code } as const;
  switch (error.code) {
    case "TOOL_BUDGET_EXHAUSTED":
      return new ExtensionCapabilityError(
        "CAPABILITY_QUOTA_EXCEEDED",
        "Tool round budget is exhausted",
        details,
      );
    case "TOOL_ROUND_CONFLICT":
    case "TOOL_JOURNAL_CONFLICT":
      return new ExtensionCapabilityError(
        "CAPABILITY_SCOPE_MISMATCH",
        "Tool round conflicts with the durable journal",
        details,
      );
    default:
      return new ExtensionCapabilityError(
        "CAPABILITY_ARGUMENT_INVALID",
        "Tool round request is invalid",
        details,
      );
  }
}

/**
 * Builds the registered-tool invocation capability.
 *
 * Section 6 of `extension-process-protocol.md` requires registered tool
 * invocation to be its own grant, and Section 8 of `llm-extension.md` owns the
 * turn semantics. This capability therefore adds no second state machine: it
 * binds one already-constructed tool policy session to one capability session
 * and one Module job, exposes only the per-session allowlist, and enforces the
 * boundary rules a transport-level handle must not be able to bypass — no
 * extension-supplied tool definition, no extension-supplied approval, and no
 * automatic continuation past an uncertain effect.
 */
export function createToolInvocationCapability(
  options: ToolInvocationCapabilityOptions,
): ExtensionCapabilityDefinition {
  const limits = resolveLimits(options.limits);
  const moduleJobId = assertHostIdentifier(options.executionScope.moduleJobId, "moduleJobId");
  const runId = assertHostIdentifier(options.executionScope.runId, "runId");
  const approvalPolicyRevision = assertHostIdentifier(
    options.approvalPolicyRevision,
    "approvalPolicyRevision",
  );
  const operations = validateOperations(options.operations);
  const enabled = new Set<ToolInvocationOperation>(operations);
  const budget = validateBudget(options.budget);

  // The exposed allowlist is fixed when the handle is issued. A registry that
  // cannot produce an unambiguous wire-name mapping is a host wiring defect,
  // not something to resolve later with a delimiter-dependent parse.
  const definitions = options.registry.providerDefinitions();
  const exposedNames = definitions.map((definition) => definition.name);
  if (new Set(exposedNames).size !== exposedNames.length) {
    throw configError("Tool registry exposes a duplicated wire name");
  }
  for (const definition of definitions) {
    if (options.registry.resolveWireName(definition.name) === null) {
      throw configError(`Tool registry cannot resolve its own wire name ${definition.name}`);
    }
  }

  const grant: ExtensionCapabilityGrant = {
    capabilityType: TOOL_INVOCATION_CAPABILITY_TYPE,
    capabilityVersion: TOOL_INVOCATION_CAPABILITY_VERSION,
    operations,
    resourceScope: {
      schemaVersion: "dolly.capability-scope.tool-invocation/1",
      moduleJobId,
      approvalPolicyRevision,
      toolWireNames: [...exposedNames].sort(),
      budget: { ...budget },
      limits: { ...limits },
    },
    expiresAt: options.expiresAt,
    maxInvocations: limits.maxInvocations,
    maxConcurrentInvocations: options.maxConcurrentInvocations ?? 1,
    maxArgumentBytes: limits.maxArgumentBytes,
    maxResultBytes: limits.maxResultBytes,
    executionScope: { moduleJobId, runId },
  };

  /** The round whose uncertain effect froze automatic continuation. */
  let blockedAtRound: number | null = null;

  const handler = async (
    argumentsValue: JsonValue,
    context: ExtensionCapabilityInvocationContext,
  ): Promise<JsonValue> => {
    const operation = context.operation as ToolInvocationOperation;
    if (!enabled.has(operation)) {
      throw toolDenied("TOOL_OPERATION_DENIED", "This handle does not authorize the operation");
    }
    const scope = resolveExecutionScope({ moduleJobId, runId }, context);

    if (operation === "list-tools") {
      assertClosedArguments(argumentsValue, [], "tool.list-tools");
      const result: JsonValue = {
        schemaVersion: "dolly.tool-registry-view/1",
        moduleJobId: scope.moduleJobId,
        tools: definitions.map((definition) => ({
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters as unknown as JsonValue,
        })),
      };
      if (canonicalJsonByteLength(result) > limits.maxResultBytes) {
        throw capabilityQuotaError("maxResultBytes", limits.maxResultBytes);
      }
      return result;
    }

    const parsed = assertClosedArguments(
      argumentsValue,
      ["roundIndex", "calls"],
      "tool.execute-round",
    );
    const roundIndex = readField(parsed, "roundIndex");
    if (
      typeof roundIndex !== "number" ||
      !Number.isSafeInteger(roundIndex) ||
      roundIndex <= 0
    ) {
      throw capabilityArgumentError("tool.execute-round.roundIndex must be a positive integer");
    }
    if (roundIndex > budget.maxRounds) {
      throw capabilityQuotaError("maxRounds", budget.maxRounds);
    }
    if (blockedAtRound !== null && roundIndex !== blockedAtRound) {
      // Section 8.2: an uncertain effect blocks automatic continuation. Only
      // reconciliation of the recorded round is still reachable; a new round
      // requires a decision this capability has no authority to make.
      throw toolDenied(
        "TOOL_ROUND_BLOCKED_BY_UNKNOWN_OUTCOME",
        "An uncertain tool effect blocks further rounds",
        { blockedAtRound },
      );
    }
    // The argument payload stays an opaque string here: the registry owns
    // parsing and closed-schema validation, and a malformed payload must
    // reach it as a typed terminal result rather than an assumed `{}`.
    const calls = readToolCalls(readField(parsed, "calls") ?? null, limits);

    let round: ToolRoundResult;
    try {
      round = await options.policy.executeRound({
        roundIndex,
        calls,
        signal: context.signal,
      });
    } catch (error) {
      if (error instanceof ToolPolicyError) throw translatePolicyError(error);
      throw new ExtensionCapabilityError(
        "CAPABILITY_DEPENDENCY_FAILED",
        "Tool policy session failed",
      );
    }

    if (round.moduleJobId !== scope.moduleJobId || round.roundIndex !== roundIndex) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_SCOPE_MISMATCH",
        "Tool round result belongs to another Module job or round",
        { reason: "TOOL_ROUND_SCOPE_MISMATCH" },
      );
    }
    // A provider continuation may only be assembled from a complete round:
    // exactly one terminal result per accepted call, no orphan, no duplicate.
    const returnedIds = round.results.map((entry) => entry.providerCallId);
    if (
      round.results.length !== calls.length ||
      new Set(returnedIds).size !== returnedIds.length ||
      calls.some((call, index) => returnedIds[index] !== call.providerCallId)
    ) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_RESULT_INVALID",
        "Tool round did not return exactly one terminal result per call",
        { reason: "TOOL_ROUND_INCOMPLETE" },
      );
    }
    if (round.state === "outcome-unknown") blockedAtRound = roundIndex;

    const result: JsonValue = {
      schemaVersion: "dolly.tool-round-result/1",
      moduleJobId: round.moduleJobId,
      roundIndex: round.roundIndex,
      state: round.state,
      canContinue: round.canContinue,
      results: round.results.map((entry) => ({
        callId: entry.providerCallId,
        name: entry.wireName,
        effectSlot: entry.effectSlot,
        status: entry.status,
        code: entry.code,
        ...(entry.content === undefined ? {} : { content: entry.content }),
      })),
    };
    if (canonicalJsonByteLength(result) > limits.maxResultBytes) {
      throw capabilityQuotaError("maxResultBytes", limits.maxResultBytes);
    }
    return result;
  };

  return { grant, handler };
}

interface ValidatedToolInvocationRunBinding {
  readonly policy: ToolPolicySessionV2Port;
  readonly registry: ToolRegistrySnapshotView;
  readonly budget: ToolTurnBudget;
  readonly snapshot: ToolRegistrySnapshot;
}

function validateRunBinding(
  binding: ToolInvocationRunBinding,
  limits: ToolInvocationV2Limits,
  moduleJobId: string,
): ValidatedToolInvocationRunBinding {
  const budget = validateBudget(binding.budget);
  if (binding.policy.moduleJobId !== moduleJobId) {
    throw configError("Tool policy belongs to another Module job");
  }
  if (budget.maxCallsPerRound > limits.maxCallsPerRound) {
    throw configError("Run tool budget exceeds the capability calls-per-round limit");
  }
  const snapshot = binding.registry.snapshot();
  if (
    snapshot.schemaVersion !== "dolly.tool-registry-snapshot/1" ||
    !/^sha256:[0-9a-f]{64}$/.test(snapshot.registryDigest) ||
    !Array.isArray(snapshot.tools)
  ) {
    throw configError("Tool registry snapshot is invalid");
  }
  const descriptors: ToolDescriptor[] = [];
  const names = new Set<string>();
  for (const tool of snapshot.tools) {
    if (names.has(tool.name)) throw configError("Tool registry snapshot has duplicate names");
    names.add(tool.name);
    const descriptor = binding.registry.resolveWireName(tool.name);
    if (!descriptor) {
      throw configError(`Tool registry cannot resolve its snapshot name ${tool.name}`);
    }
    descriptors.push(descriptor);
  }
  const rebuilt = new ToolRegistry(
    descriptors,
    descriptors.map((descriptor) => descriptor.toolId),
  ).snapshot();
  if (
    rebuilt.registryDigest !== snapshot.registryDigest ||
    canonicalJsonDigest(rebuilt as unknown as JsonValue) !==
      canonicalJsonDigest(snapshot as unknown as JsonValue)
  ) {
    throw configError("Tool registry snapshot does not match its executable descriptors");
  }
  if (binding.policy.registryDigest !== snapshot.registryDigest) {
    throw configError("Tool policy and advertised registry use different descriptors");
  }
  return { policy: binding.policy, registry: binding.registry, budget, snapshot };
}

/**
 * Builds the version-two registered-tool capability.
 *
 * Unlike version one, a single handle may explicitly follow the Host's
 * verified active Run. The Host resolves and freezes one registry/policy
 * binding per Module job; retry Runs reuse that binding instead of receiving a
 * fresh effect journal or a different advertised contract.
 */
export function createToolInvocationCapabilityV2(
  options: ToolInvocationCapabilityV2Options,
): ExtensionCapabilityDefinition {
  const limits = resolveV2Limits(options.limits);
  const operations = validateOperations(options.operations);
  const enabled = new Set<ToolInvocationOperation>(operations);
  const grantScope =
    options.executionScope === "active-run"
      ? undefined
      : {
          moduleJobId: assertHostIdentifier(options.executionScope.moduleJobId, "moduleJobId"),
          runId: assertHostIdentifier(options.executionScope.runId, "runId"),
        };
  const fixedBinding =
    options.executionScope === "active-run"
      ? undefined
      : validateRunBinding(options.binding, limits, grantScope!.moduleJobId);

  const grant: ExtensionCapabilityGrant = {
    capabilityType: TOOL_INVOCATION_CAPABILITY_TYPE,
    capabilityVersion: TOOL_INVOCATION_CAPABILITY_VERSION_V2,
    operations,
    resourceScope: {
      schemaVersion: "dolly.capability-scope.tool-invocation/2",
      ...(grantScope === undefined
        ? { executionScope: "active-run" }
        : {
            moduleJobId: grantScope.moduleJobId,
            registryDigest: fixedBinding!.snapshot.registryDigest,
            toolWireNames: fixedBinding!.snapshot.tools.map((tool) => tool.name),
            budget: { ...fixedBinding!.budget },
          }),
      limits: { ...limits },
    },
    expiresAt: options.expiresAt,
    maxInvocations: limits.maxInvocations,
    maxConcurrentInvocations: options.maxConcurrentInvocations ?? 1,
    maxArgumentBytes: limits.maxArgumentBytes,
    maxResultBytes: limits.maxResultBytes,
    ...(grantScope === undefined ? {} : { executionScope: grantScope }),
  };

  const bindingsByJob = new Map<string, ValidatedToolInvocationRunBinding>();
  if (fixedBinding && grantScope) bindingsByJob.set(grantScope.moduleJobId, fixedBinding);
  const invocationsByRun = new Map<string, number>();
  const blockedRoundByJob = new Map<string, number>();

  const resolveBinding = (
    context: ExtensionCapabilityInvocationContext,
  ): {
    readonly scope: ExtensionExecutionScope;
    readonly binding: ValidatedToolInvocationRunBinding;
  } => {
    const scope = resolveExecutionScope(grantScope, context);
    const cached = bindingsByJob.get(scope.moduleJobId);
    if (cached) return { scope, binding: cached };
    if (options.executionScope !== "active-run") {
      throw new ExtensionCapabilityError(
        "CAPABILITY_SCOPE_MISMATCH",
        "Tool invocation binding is absent for its fixed Module job",
      );
    }
    const attempt = context.attempt;
    const deadline = context.deadline;
    if (!Number.isSafeInteger(attempt) || attempt === undefined || attempt <= 0) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_SCOPE_MISMATCH",
        "Tool invocation requires the host-verified active Run attempt",
      );
    }
    if (deadline === undefined || !Number.isFinite(Date.parse(deadline))) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_SCOPE_MISMATCH",
        "Tool invocation requires the host-verified active Run deadline",
      );
    }
    let resolved: ToolInvocationRunBinding;
    try {
      resolved = options.resolveRun({
        moduleJobId: scope.moduleJobId,
        runId: scope.runId,
        attempt,
        deadline: new Date(Date.parse(deadline)).toISOString(),
      });
    } catch (error) {
      if (error instanceof ExtensionCapabilityError) throw error;
      throw new ExtensionCapabilityError(
        "CAPABILITY_DEPENDENCY_FAILED",
        "Host could not resolve the active Run tool policy",
      );
    }
    const binding = validateRunBinding(resolved, limits, scope.moduleJobId);
    bindingsByJob.set(scope.moduleJobId, binding);
    return { scope, binding };
  };

  const consumeRunInvocation = (scope: ExtensionExecutionScope): void => {
    const key = `${scope.moduleJobId}\u0000${scope.runId}`;
    const used = invocationsByRun.get(key) ?? 0;
    if (used >= limits.maxInvocationsPerRun) {
      throw capabilityQuotaError("maxInvocationsPerRun", limits.maxInvocationsPerRun);
    }
    invocationsByRun.set(key, used + 1);
  };

  const handler = async (
    argumentsValue: JsonValue,
    context: ExtensionCapabilityInvocationContext,
  ): Promise<JsonValue> => {
    const operation = context.operation as ToolInvocationOperation;
    if (!enabled.has(operation)) {
      throw toolDenied("TOOL_OPERATION_DENIED", "This handle does not authorize the operation");
    }
    const { scope, binding } = resolveBinding(context);
    consumeRunInvocation(scope);

    if (operation === "list-tools") {
      assertClosedArguments(argumentsValue, [], "tool.list-tools");
      const result: JsonValue = {
        schemaVersion: "dolly.tool-registry-view/2",
        moduleJobId: scope.moduleJobId,
        registryDigest: binding.snapshot.registryDigest,
        budget: { ...binding.budget },
        tools: binding.snapshot.tools as unknown as JsonValue,
      };
      if (canonicalJsonByteLength(result) > limits.maxResultBytes) {
        throw capabilityQuotaError("maxResultBytes", limits.maxResultBytes);
      }
      return result;
    }

    const parsed = assertClosedArguments(
      argumentsValue,
      ["roundIndex", "calls"],
      "tool.execute-round",
    );
    const roundIndex = readField(parsed, "roundIndex");
    if (
      typeof roundIndex !== "number" ||
      !Number.isSafeInteger(roundIndex) ||
      roundIndex <= 0
    ) {
      throw capabilityArgumentError("tool.execute-round.roundIndex must be a positive integer");
    }
    if (roundIndex > binding.budget.maxRounds) {
      throw capabilityQuotaError("maxRounds", binding.budget.maxRounds);
    }
    const blockedAtRound = blockedRoundByJob.get(scope.moduleJobId);
    if (blockedAtRound !== undefined && roundIndex !== blockedAtRound) {
      throw toolDenied(
        "TOOL_ROUND_BLOCKED_BY_UNKNOWN_OUTCOME",
        "An uncertain tool effect blocks further rounds",
        { blockedAtRound },
      );
    }
    const calls = readToolCalls(readField(parsed, "calls") ?? null, limits);

    let round: ToolRoundResult;
    try {
      round = await binding.policy.executeRound({
        roundIndex,
        calls,
        signal: context.signal,
      });
    } catch (error) {
      if (error instanceof ToolPolicyError) throw translatePolicyError(error);
      throw new ExtensionCapabilityError(
        "CAPABILITY_DEPENDENCY_FAILED",
        "Tool policy session failed",
      );
    }
    if (round.moduleJobId !== scope.moduleJobId || round.roundIndex !== roundIndex) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_SCOPE_MISMATCH",
        "Tool round result belongs to another Module job or round",
        { reason: "TOOL_ROUND_SCOPE_MISMATCH" },
      );
    }
    const returnedIds = round.results.map((entry) => entry.providerCallId);
    if (
      round.results.length !== calls.length ||
      new Set(returnedIds).size !== returnedIds.length ||
      calls.some((call, index) => returnedIds[index] !== call.providerCallId)
    ) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_RESULT_INVALID",
        "Tool round did not return exactly one terminal result per call",
        { reason: "TOOL_ROUND_INCOMPLETE" },
      );
    }
    if (round.state === "outcome-unknown") {
      blockedRoundByJob.set(scope.moduleJobId, roundIndex);
    }

    const result: JsonValue = {
      schemaVersion: "dolly.tool-round-result/2",
      moduleJobId: round.moduleJobId,
      registryDigest: binding.snapshot.registryDigest,
      roundIndex: round.roundIndex,
      state: round.state,
      canContinue: round.canContinue,
      results: round.results.map((entry) => ({
        callId: entry.providerCallId,
        name: entry.wireName,
        effectSlot: entry.effectSlot,
        status: entry.status,
        code: entry.code,
        ...(entry.content === undefined ? {} : { content: entry.content }),
      })),
    };
    if (canonicalJsonByteLength(result) > limits.maxResultBytes) {
      throw capabilityQuotaError("maxResultBytes", limits.maxResultBytes);
    }
    return result;
  };

  return { grant, handler };
}
