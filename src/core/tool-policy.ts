import {
  assertJsonValue,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  cloneJson,
  deepFreeze,
  type JsonPrimitive,
  type JsonValue,
} from "./canonical-json.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WIRE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

export type ToolEffectClass =
  | "read"
  | "external-communication"
  | "write"
  | "destructive"
  | "administrative";

export type ToolValueSchema =
  | {
      readonly type: "string";
      readonly minBytes?: number;
      readonly maxBytes: number;
      readonly enum?: readonly string[];
    }
  | {
      readonly type: "number";
      readonly minimum?: number;
      readonly maximum?: number;
    }
  | {
      readonly type: "integer";
      readonly minimum?: number;
      readonly maximum?: number;
    }
  | { readonly type: "boolean" }
  | { readonly type: "null" }
  | {
      readonly type: "array";
      readonly items: ToolValueSchema;
      readonly maxItems: number;
    }
  | {
      readonly type: "object";
      readonly properties: Readonly<Record<string, ToolValueSchema>>;
      readonly required?: readonly string[];
      readonly additionalProperties: false;
      readonly maxProperties: number;
    }
  | {
      readonly type: "enum";
      readonly values: readonly JsonPrimitive[];
    };

export interface ToolDescriptor {
  readonly toolId: string;
  readonly wireName: string;
  readonly description: string;
  readonly argumentSchema: Extract<ToolValueSchema, { type: "object" }>;
  readonly resultSchema: ToolValueSchema;
  readonly effectClass: ToolEffectClass;
  readonly resourceScope: string;
  readonly approval: "never" | "required";
  readonly idempotency: "none" | "effect-key";
  readonly outcomeQuery: "none" | "supported";
  readonly parallel: "serial" | "safe";
  readonly deadlineMs: number;
  readonly maxArgumentBytes: number;
  readonly maxResultBytes: number;
}

export interface ProviderToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolValueSchema;
}

export interface ToolCallRequest {
  readonly providerCallId: string;
  readonly wireName: string;
  readonly argumentsJson: string;
}

export type ToolCallTerminalStatus =
  | "succeeded"
  | "denied"
  | "invalid-arguments"
  | "failed"
  | "cancelled"
  | "outcome-unknown";

export interface ToolCallTerminalResult {
  readonly providerCallId: string;
  readonly wireName: string;
  readonly effectSlot: string;
  readonly status: ToolCallTerminalStatus;
  readonly code: string;
  readonly content?: JsonValue;
}

export interface ToolRoundResult {
  readonly moduleJobId: string;
  readonly roundIndex: number;
  readonly state: "complete" | "failed" | "cancelled" | "outcome-unknown";
  readonly canContinue: boolean;
  readonly results: readonly ToolCallTerminalResult[];
}

export interface ToolTurnBudget {
  readonly maxRounds: number;
  readonly maxCalls: number;
  readonly maxCallsPerRound: number;
  readonly maxApprovals: number;
  readonly maxCallBytes: number;
}

export interface ToolApprovalRequest {
  readonly moduleJobId: string;
  readonly effectSlot: string;
  readonly toolId: string;
  readonly argumentDigest: string;
  readonly effectClass: ToolEffectClass;
  readonly resourceScope: string;
  readonly policyRevision: string;
}

export interface ToolApprovalProvider {
  decide(
    request: ToolApprovalRequest,
  ): Promise<{ readonly decision: "approved" | "denied"; readonly code: string }>;
}

export interface ToolExecutionRequest {
  readonly moduleJobId: string;
  readonly effectSlot: string;
  readonly effectKey: string;
  readonly toolId: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}

export type ToolExecutionOutcome =
  | { readonly status: "succeeded"; readonly content: JsonValue }
  | { readonly status: "failed"; readonly code: string }
  | { readonly status: "outcome-unknown"; readonly code: string };

export interface ToolExecutor {
  execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome>;
}

interface NormalizedToolCall {
  readonly wireName: string;
  readonly effectSlot: string;
  readonly argumentDigest: string;
  readonly toolId?: string;
  readonly arguments?: Readonly<Record<string, JsonValue>>;
  readonly initialResult?: Omit<ToolCallTerminalResult, "providerCallId">;
}

interface ToolEffectJournalRecord {
  readonly wireName: string;
  readonly effectSlot: string;
  readonly argumentDigest: string;
  readonly toolId?: string;
  readonly arguments?: Readonly<Record<string, JsonValue>>;
  readonly providerCallId: string;
  readonly status: "reserved" | "terminal";
  readonly result?: Omit<ToolCallTerminalResult, "providerCallId">;
}

export interface ToolRoundJournalRecord {
  readonly schemaVersion: "dolly.tool-round/2";
  readonly moduleJobId: string;
  readonly roundIndex: number;
  readonly roundDigest: string;
  readonly state: "reserved" | "complete" | "failed" | "cancelled" | "outcome-unknown";
  readonly revision: number;
  readonly effects: readonly ToolEffectJournalRecord[];
}

export interface ToolJournalRepository {
  reserveRound(record: ToolRoundJournalRecord): "created" | "already-exists";
  getRound(moduleJobId: string, roundIndex: number): ToolRoundJournalRecord | null;
  compareAndSet(
    moduleJobId: string,
    roundIndex: number,
    expectedRevision: number,
    next: ToolRoundJournalRecord,
  ): boolean;
  listRounds(moduleJobId: string): readonly ToolRoundJournalRecord[];
}

export type ToolPolicyErrorCode =
  | "TOOL_REGISTRY_INVALID"
  | "TOOL_ROUND_INVALID"
  | "TOOL_ROUND_CONFLICT"
  | "TOOL_BUDGET_EXHAUSTED"
  | "TOOL_JOURNAL_CONFLICT";

export class ToolPolicyError extends Error {
  constructor(
    readonly code: ToolPolicyErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "ToolPolicyError";
  }
}

function assertId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new ToolPolicyError("TOOL_REGISTRY_INVALID", `${label} is not valid`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ToolPolicyError("TOOL_REGISTRY_INVALID", `${label} must be positive`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ToolPolicyError("TOOL_REGISTRY_INVALID", `${label} must be non-negative`);
  }
}

function frozenJson<T>(value: T): T {
  assertJsonValue(value);
  return deepFreeze(cloneJson(value as unknown as JsonValue)) as unknown as T;
}

function validateSchemaDefinition(schema: ToolValueSchema, path: string, depth = 0): void {
  if (depth > 16) throw new ToolPolicyError("TOOL_REGISTRY_INVALID", `${path} is too deep`);
  if (schema.type === "string") {
    assertPositiveInteger(schema.maxBytes, `${path}.maxBytes`);
    if (
      schema.minBytes !== undefined &&
      (!Number.isSafeInteger(schema.minBytes) ||
        schema.minBytes < 0 ||
        schema.minBytes > schema.maxBytes)
    ) {
      throw new ToolPolicyError("TOOL_REGISTRY_INVALID", `${path}.minBytes is invalid`);
    }
    if (schema.enum && (schema.enum.length === 0 || new Set(schema.enum).size !== schema.enum.length)) {
      throw new ToolPolicyError("TOOL_REGISTRY_INVALID", `${path}.enum is invalid`);
    }
    return;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (schema.minimum !== undefined && !Number.isFinite(schema.minimum)) {
      throw new ToolPolicyError("TOOL_REGISTRY_INVALID", `${path}.minimum is invalid`);
    }
    if (schema.maximum !== undefined && !Number.isFinite(schema.maximum)) {
      throw new ToolPolicyError("TOOL_REGISTRY_INVALID", `${path}.maximum is invalid`);
    }
    if (
      schema.minimum !== undefined &&
      schema.maximum !== undefined &&
      schema.minimum > schema.maximum
    ) {
      throw new ToolPolicyError("TOOL_REGISTRY_INVALID", `${path} bounds are inverted`);
    }
    return;
  }
  if (schema.type === "boolean" || schema.type === "null") return;
  if (schema.type === "enum") {
    if (schema.values.length === 0) {
      throw new ToolPolicyError("TOOL_REGISTRY_INVALID", `${path}.values is empty`);
    }
    assertJsonValue(schema.values);
    const unique = new Set(schema.values.map((value) => canonicalJsonDigest(value)));
    if (unique.size !== schema.values.length) {
      throw new ToolPolicyError("TOOL_REGISTRY_INVALID", `${path}.values has duplicates`);
    }
    return;
  }
  if (schema.type === "array") {
    assertNonNegativeInteger(schema.maxItems, `${path}.maxItems`);
    validateSchemaDefinition(schema.items, `${path}.items`, depth + 1);
    return;
  }
  if (schema.additionalProperties !== false) {
    throw new ToolPolicyError("TOOL_REGISTRY_INVALID", `${path} must be closed`);
  }
  assertNonNegativeInteger(schema.maxProperties, `${path}.maxProperties`);
  const keys = Object.keys(schema.properties);
  if (keys.length > schema.maxProperties) {
    throw new ToolPolicyError("TOOL_REGISTRY_INVALID", `${path} has too many properties`);
  }
  for (const [key, child] of Object.entries(schema.properties)) {
    if (!WIRE_NAME_PATTERN.test(key)) {
      throw new ToolPolicyError("TOOL_REGISTRY_INVALID", `${path} property name is invalid`);
    }
    validateSchemaDefinition(child, `${path}.${key}`, depth + 1);
  }
  const required = schema.required ?? [];
  if (new Set(required).size !== required.length || required.some((key) => !(key in schema.properties))) {
    throw new ToolPolicyError("TOOL_REGISTRY_INVALID", `${path}.required is invalid`);
  }
}

function validateValue(
  value: unknown,
  schema: ToolValueSchema,
  path: string,
  depth = 0,
): JsonValue {
  if (depth > 16) throw new Error(`${path} exceeds schema depth`);
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`${path} must be a string`);
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes < (schema.minBytes ?? 0) || bytes > schema.maxBytes) {
      throw new Error(`${path} string size is invalid`);
    }
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} is not enumerated`);
    return value;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      Object.is(value, -0) ||
      (schema.type === "integer" && !Number.isSafeInteger(value)) ||
      (schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum)
    ) {
      throw new Error(`${path} number is invalid`);
    }
    return value;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${path} must be boolean`);
    return value;
  }
  if (schema.type === "null") {
    if (value !== null) throw new Error(`${path} must be null`);
    return null;
  }
  if (schema.type === "enum") {
    assertJsonValue(value);
    const digest = canonicalJsonDigest(value);
    if (!schema.values.some((candidate) => canonicalJsonDigest(candidate) === digest)) {
      throw new Error(`${path} is not enumerated`);
    }
    return cloneJson(value);
  }
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length > schema.maxItems) {
      throw new Error(`${path} array size is invalid`);
    }
    return value.map((item, index) =>
      validateValue(item, schema.items, `${path}[${index}]`, depth + 1),
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must be a plain object`);
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.length > schema.maxProperties || keys.some((key) => !(key in schema.properties))) {
    throw new Error(`${path} contains unknown or excess properties`);
  }
  for (const required of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(candidate, required)) {
      throw new Error(`${path}.${required} is required`);
    }
  }
  const result: Record<string, JsonValue> = {};
  for (const key of keys.sort()) {
    result[key] = validateValue(candidate[key], schema.properties[key]!, `${path}.${key}`, depth + 1);
  }
  return result;
}

function terminalResult(
  wireName: string,
  effectSlot: string,
  status: ToolCallTerminalStatus,
  code: string,
  content?: JsonValue,
): Omit<ToolCallTerminalResult, "providerCallId"> {
  return deepFreeze({
    wireName,
    effectSlot,
    status,
    code,
    ...(content === undefined ? {} : { content: cloneJson(content) }),
  });
}

function immutableRound(record: ToolRoundJournalRecord): ToolRoundJournalRecord {
  return frozenJson(record);
}

function assertToolRoundJournalRecord(record: ToolRoundJournalRecord): void {
  try {
    assertJsonValue(record);
  } catch {
    throw new ToolPolicyError("TOOL_ROUND_INVALID", "Tool round journal record is not JSON data");
  }
  const expectedKeys = [
    "effects",
    "moduleJobId",
    "revision",
    "roundDigest",
    "roundIndex",
    "schemaVersion",
    "state",
  ];
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.getPrototypeOf(record) !== Object.prototype ||
    Object.keys(record).sort().join(",") !== expectedKeys.sort().join(",") ||
    record.schemaVersion !== "dolly.tool-round/2" ||
    !ID_PATTERN.test(record.moduleJobId) ||
    !Number.isSafeInteger(record.roundIndex) ||
    record.roundIndex <= 0 ||
    !/^sha256:[0-9a-f]{64}$/.test(record.roundDigest) ||
    !Number.isSafeInteger(record.revision) ||
    record.revision <= 0 ||
    !Array.isArray(record.effects) ||
    (record.state !== "reserved" &&
      record.state !== "complete" &&
      record.state !== "failed" &&
      record.state !== "cancelled" &&
      record.state !== "outcome-unknown")
  ) {
    throw new ToolPolicyError("TOOL_ROUND_INVALID", "Tool round journal record is invalid");
  }
}

export class InMemoryToolJournalRepository implements ToolJournalRepository {
  readonly #rounds = new Map<string, ToolRoundJournalRecord>();

  reserveRound(record: ToolRoundJournalRecord): "created" | "already-exists" {
    assertToolRoundJournalRecord(record);
    const key = this.#key(record.moduleJobId, record.roundIndex);
    if (this.#rounds.has(key)) return "already-exists";
    if (record.revision !== 1 || record.state !== "reserved") {
      throw new ToolPolicyError("TOOL_JOURNAL_CONFLICT", "New tool round is invalid");
    }
    this.#rounds.set(key, immutableRound(record));
    return "created";
  }

  getRound(moduleJobId: string, roundIndex: number): ToolRoundJournalRecord | null {
    return this.#rounds.get(this.#key(moduleJobId, roundIndex)) ?? null;
  }

  compareAndSet(
    moduleJobId: string,
    roundIndex: number,
    expectedRevision: number,
    next: ToolRoundJournalRecord,
  ): boolean {
    assertToolRoundJournalRecord(next);
    const key = this.#key(moduleJobId, roundIndex);
    const current = this.#rounds.get(key);
    if (!current || current.revision !== expectedRevision) return false;
    if (
      next.moduleJobId !== moduleJobId ||
      next.roundIndex !== roundIndex ||
      next.roundDigest !== current.roundDigest ||
      next.revision !== expectedRevision + 1 ||
      current.state !== "reserved" ||
      next.effects.length !== current.effects.length
    ) {
      throw new ToolPolicyError("TOOL_JOURNAL_CONFLICT", "Invalid tool journal transition");
    }
    for (let index = 0; index < current.effects.length; index += 1) {
      const before = current.effects[index]!;
      const after = next.effects[index]!;
      if (
        before.effectSlot !== after.effectSlot ||
        before.argumentDigest !== after.argumentDigest ||
        before.wireName !== after.wireName ||
        before.toolId !== after.toolId ||
        (before.status === "terminal" && canonicalJsonDigest(before) !== canonicalJsonDigest(after))
      ) {
        throw new ToolPolicyError("TOOL_JOURNAL_CONFLICT", "Tool effect identity changed");
      }
    }
    this.#rounds.set(key, immutableRound(next));
    return true;
  }

  listRounds(moduleJobId: string): readonly ToolRoundJournalRecord[] {
    return [...this.#rounds.values()]
      .filter((round) => round.moduleJobId === moduleJobId)
      .sort((left, right) => left.roundIndex - right.roundIndex);
  }

  #key(moduleJobId: string, roundIndex: number): string {
    return `${moduleJobId}:${roundIndex}`;
  }
}

export class ToolRegistry {
  readonly #byId = new Map<string, ToolDescriptor>();
  readonly #byWireName = new Map<string, ToolDescriptor>();

  constructor(descriptors: readonly ToolDescriptor[], selectedToolIds: readonly string[]) {
    if (new Set(selectedToolIds).size !== selectedToolIds.length) {
      throw new ToolPolicyError("TOOL_REGISTRY_INVALID", "Tool allowlist has duplicates");
    }
    const all = new Map<string, ToolDescriptor>();
    const allWireNames = new Set<string>();
    for (const descriptorInput of descriptors) {
      assertId(descriptorInput.toolId, "toolId");
      if (!WIRE_NAME_PATTERN.test(descriptorInput.wireName)) {
        throw new ToolPolicyError("TOOL_REGISTRY_INVALID", "Tool wire name is invalid");
      }
      if (all.has(descriptorInput.toolId) || allWireNames.has(descriptorInput.wireName)) {
        throw new ToolPolicyError("TOOL_REGISTRY_INVALID", "Tool ID or wire name is duplicated");
      }
      assertId(descriptorInput.resourceScope, "resourceScope");
      assertPositiveInteger(descriptorInput.deadlineMs, "deadlineMs");
      assertPositiveInteger(descriptorInput.maxArgumentBytes, "maxArgumentBytes");
      assertPositiveInteger(descriptorInput.maxResultBytes, "maxResultBytes");
      validateSchemaDefinition(descriptorInput.argumentSchema, `${descriptorInput.toolId}.arguments`);
      validateSchemaDefinition(descriptorInput.resultSchema, `${descriptorInput.toolId}.result`);
      try {
        assertJsonValue(descriptorInput.argumentSchema);
        assertJsonValue(descriptorInput.resultSchema);
        assertJsonValue(descriptorInput.description);
      } catch {
        throw new ToolPolicyError("TOOL_REGISTRY_INVALID", "Tool schema is not closed JSON");
      }
      if (Buffer.byteLength(descriptorInput.description, "utf8") > 4096) {
        throw new ToolPolicyError("TOOL_REGISTRY_INVALID", "Tool description is too large");
      }
      if (
        !["read", "external-communication", "write", "destructive", "administrative"].includes(
          descriptorInput.effectClass,
        ) ||
        !["never", "required"].includes(descriptorInput.approval) ||
        !["none", "effect-key"].includes(descriptorInput.idempotency) ||
        !["none", "supported"].includes(descriptorInput.outcomeQuery) ||
        !["serial", "safe"].includes(descriptorInput.parallel)
      ) {
        throw new ToolPolicyError("TOOL_REGISTRY_INVALID", "Tool policy enum is invalid");
      }
      if (descriptorInput.effectClass !== "read" && descriptorInput.approval !== "required") {
        throw new ToolPolicyError(
          "TOOL_REGISTRY_INVALID",
          `Effectful tool ${descriptorInput.toolId} requires approval`,
        );
      }
      const descriptor = deepFreeze({
        ...descriptorInput,
        argumentSchema: cloneJson(descriptorInput.argumentSchema as unknown as JsonValue),
        resultSchema: cloneJson(descriptorInput.resultSchema as unknown as JsonValue),
      }) as unknown as ToolDescriptor;
      all.set(descriptor.toolId, descriptor);
      allWireNames.add(descriptor.wireName);
    }
    for (const toolId of selectedToolIds) {
      const descriptor = all.get(toolId);
      if (!descriptor) {
        throw new ToolPolicyError("TOOL_REGISTRY_INVALID", `Allowlisted tool ${toolId} is absent`);
      }
      this.#byId.set(toolId, descriptor);
      this.#byWireName.set(descriptor.wireName, descriptor);
    }
  }

  resolveWireName(wireName: string): ToolDescriptor | null {
    return this.#byWireName.get(wireName) ?? null;
  }

  providerDefinitions(): readonly ProviderToolDefinition[] {
    return [...this.#byId.values()].map((descriptor) =>
      deepFreeze({
        name: descriptor.wireName,
        description: descriptor.description,
        parameters: descriptor.argumentSchema,
      }),
    );
  }
}

export interface ToolPolicySessionOptions {
  readonly moduleJobId: string;
  readonly registry: ToolRegistry;
  readonly repository: ToolJournalRepository;
  readonly approval: ToolApprovalProvider;
  readonly executor: ToolExecutor;
  readonly budget: ToolTurnBudget;
  readonly approvalPolicyRevision: string;
}

export class ToolPolicySession {
  readonly #moduleJobId: string;
  readonly #registry: ToolRegistry;
  readonly #repository: ToolJournalRepository;
  readonly #approval: ToolApprovalProvider;
  readonly #executor: ToolExecutor;
  readonly #budget: ToolTurnBudget;
  readonly #approvalPolicyRevision: string;
  #approvalCount = 0;

  constructor(options: ToolPolicySessionOptions) {
    assertId(options.moduleJobId, "moduleJobId");
    assertId(options.approvalPolicyRevision, "approvalPolicyRevision");
    assertPositiveInteger(options.budget.maxRounds, "maxRounds");
    assertPositiveInteger(options.budget.maxCalls, "maxCalls");
    assertPositiveInteger(options.budget.maxCallsPerRound, "maxCallsPerRound");
    assertNonNegativeInteger(options.budget.maxApprovals, "maxApprovals");
    assertPositiveInteger(options.budget.maxCallBytes, "maxCallBytes");
    this.#moduleJobId = options.moduleJobId;
    this.#registry = options.registry;
    this.#repository = options.repository;
    this.#approval = options.approval;
    this.#executor = options.executor;
    this.#budget = deepFreeze({ ...options.budget });
    this.#approvalPolicyRevision = options.approvalPolicyRevision;
  }

  async executeRound(input: {
    readonly roundIndex: number;
    readonly calls: readonly ToolCallRequest[];
    readonly signal?: AbortSignal;
  }): Promise<ToolRoundResult> {
    if (!Number.isSafeInteger(input.roundIndex) || input.roundIndex <= 0) {
      throw new ToolPolicyError("TOOL_ROUND_INVALID", "roundIndex must be positive");
    }
    if (input.roundIndex > this.#budget.maxRounds) {
      throw new ToolPolicyError("TOOL_BUDGET_EXHAUSTED", "Tool round budget is exhausted");
    }
    if (input.calls.length === 0 || input.calls.length > this.#budget.maxCallsPerRound) {
      throw new ToolPolicyError("TOOL_BUDGET_EXHAUSTED", "Tool calls per round are exhausted");
    }
    const ids = new Set<string>();
    for (const call of input.calls) {
      const envelopeBytes =
        Buffer.byteLength(call.providerCallId, "utf8") +
        Buffer.byteLength(call.wireName, "utf8") +
        Buffer.byteLength(call.argumentsJson, "utf8");
      if (envelopeBytes > this.#budget.maxCallBytes) {
        throw new ToolPolicyError("TOOL_BUDGET_EXHAUSTED", "Tool call envelope is too large");
      }
      assertId(call.providerCallId, "providerCallId");
      if (ids.has(call.providerCallId)) {
        throw new ToolPolicyError("TOOL_ROUND_INVALID", "Provider tool call IDs are duplicated");
      }
      ids.add(call.providerCallId);
    }
    const priorCalls = this.#repository
      .listRounds(this.#moduleJobId)
      .reduce((count, round) => count + round.effects.length, 0);
    const existing = this.#repository.getRound(this.#moduleJobId, input.roundIndex);
    if (!existing && priorCalls + input.calls.length > this.#budget.maxCalls) {
      throw new ToolPolicyError("TOOL_BUDGET_EXHAUSTED", "Total tool call budget is exhausted");
    }

    const normalized = input.calls.map((call, index) => this.#normalizeCall(call, input.roundIndex, index));
    const roundDigest = canonicalJsonDigest(
      normalized.map((call) => ({
        wireName: call.wireName,
        argumentDigest: call.argumentDigest,
        effectSlot: call.effectSlot,
      })),
    );
    let record = existing;
    if (record) {
      if (record.roundDigest !== roundDigest) {
        throw new ToolPolicyError("TOOL_ROUND_CONFLICT", "Tool round was replayed with other calls");
      }
    } else {
      const effects: ToolEffectJournalRecord[] = normalized.map((call, index) => {
        const { initialResult, ...identity } = call;
        return {
          ...identity,
          providerCallId: input.calls[index]!.providerCallId,
          status: initialResult === undefined ? "reserved" : "terminal",
          ...(initialResult === undefined ? {} : { result: initialResult }),
        };
      });
      const prepared = immutableRound({
        schemaVersion: "dolly.tool-round/2",
        moduleJobId: this.#moduleJobId,
        roundIndex: input.roundIndex,
        roundDigest,
        state: "reserved",
        revision: 1,
        effects,
      });
      const reserved = this.#repository.reserveRound(prepared);
      record =
        reserved === "created"
          ? prepared
          : this.#repository.getRound(this.#moduleJobId, input.roundIndex)!;
      if (record.roundDigest !== roundDigest) {
        throw new ToolPolicyError("TOOL_ROUND_CONFLICT", "Concurrent tool round conflicts");
      }
    }

    if (record.state !== "reserved") return this.#publicResult(record, input.calls);
    for (let index = 0; index < record.effects.length; index += 1) {
      record = this.#repository.getRound(this.#moduleJobId, input.roundIndex)!;
      const effect = record.effects[index]!;
      if (effect.status === "terminal") continue;
      const descriptor = this.#registry.resolveWireName(effect.wireName)!;
      let result: Omit<ToolCallTerminalResult, "providerCallId">;
      if (input.signal?.aborted) {
        result = terminalResult(effect.wireName, effect.effectSlot, "cancelled", "TURN_CANCELLED");
      } else if (descriptor.approval === "required") {
        if (this.#approvalCount >= this.#budget.maxApprovals) {
          result = terminalResult(
            effect.wireName,
            effect.effectSlot,
            "denied",
            "APPROVAL_BUDGET_EXHAUSTED",
          );
        } else {
          this.#approvalCount += 1;
          const decision = await this.#approval.decide({
            moduleJobId: this.#moduleJobId,
            effectSlot: effect.effectSlot,
            toolId: descriptor.toolId,
            argumentDigest: effect.argumentDigest,
            effectClass: descriptor.effectClass,
            resourceScope: descriptor.resourceScope,
            policyRevision: this.#approvalPolicyRevision,
          });
          if (
            (decision.decision !== "approved" && decision.decision !== "denied") ||
            !ID_PATTERN.test(decision.code)
          ) {
            result = terminalResult(
              effect.wireName,
              effect.effectSlot,
              "denied",
              "APPROVAL_RESPONSE_INVALID",
            );
          } else {
            result =
              decision.decision === "denied"
                ? terminalResult(effect.wireName, effect.effectSlot, "denied", decision.code)
                : await this.#invoke(descriptor, effect, input.signal);
          }
        }
      } else {
        result = await this.#invoke(descriptor, effect, input.signal);
      }
      record = this.#commitEffect(record, index, result);
      if (result.status === "outcome-unknown" || result.status === "cancelled") {
        for (let later = index + 1; later < record.effects.length; later += 1) {
          if (record.effects[later]!.status === "reserved") {
            record = this.#commitEffect(
              record,
              later,
              terminalResult(
                record.effects[later]!.wireName,
                record.effects[later]!.effectSlot,
                "cancelled",
                result.status === "outcome-unknown"
                  ? "ROUND_BLOCKED_BY_UNKNOWN_OUTCOME"
                  : "TURN_CANCELLED",
              ),
            );
          }
        }
        break;
      }
    }

    record = this.#repository.getRound(this.#moduleJobId, input.roundIndex)!;
    if (record.state === "reserved") {
      const results = record.effects.map((effect) => effect.result!);
      const state = results.some((result) => result.status === "outcome-unknown")
        ? "outcome-unknown"
        : results.some((result) => result.status === "cancelled")
          ? "cancelled"
          : "complete";
      const final = immutableRound({
        ...record,
        state,
        revision: record.revision + 1,
      });
      if (!this.#repository.compareAndSet(
        this.#moduleJobId,
        input.roundIndex,
        record.revision,
        final,
      )) {
        record = this.#repository.getRound(this.#moduleJobId, input.roundIndex)!;
      } else {
        record = final;
      }
    }
    return this.#publicResult(record, input.calls);
  }

  #normalizeCall(
    call: ToolCallRequest,
    roundIndex: number,
    callIndex: number,
  ): NormalizedToolCall {
    const effectSlot = `round-${roundIndex}-call-${callIndex + 1}`;
    const descriptor = this.#registry.resolveWireName(call.wireName);
    if (!descriptor) {
      return {
        wireName: call.wireName,
        effectSlot,
        argumentDigest: canonicalJsonDigest(call.argumentsJson),
        initialResult: terminalResult(
          call.wireName,
          effectSlot,
          "denied",
          "TOOL_NOT_ALLOWED",
        ),
      };
    }
    if (Buffer.byteLength(call.argumentsJson, "utf8") > descriptor.maxArgumentBytes) {
      return {
        wireName: call.wireName,
        effectSlot,
        argumentDigest: canonicalJsonDigest(call.argumentsJson),
        toolId: descriptor.toolId,
        initialResult: terminalResult(
          call.wireName,
          effectSlot,
          "invalid-arguments",
          "TOOL_ARGUMENT_LIMIT",
        ),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.argumentsJson);
    } catch {
      return {
        wireName: call.wireName,
        effectSlot,
        argumentDigest: canonicalJsonDigest(call.argumentsJson),
        toolId: descriptor.toolId,
        initialResult: terminalResult(
          call.wireName,
          effectSlot,
          "invalid-arguments",
          "TOOL_ARGUMENT_JSON_INVALID",
        ),
      };
    }
    try {
      const argumentsValue = validateValue(parsed, descriptor.argumentSchema, "$.arguments") as Readonly<
        Record<string, JsonValue>
      >;
      const argumentsFrozen = frozenJson(argumentsValue);
      return {
        wireName: call.wireName,
        effectSlot,
        argumentDigest: canonicalJsonDigest(argumentsFrozen),
        toolId: descriptor.toolId,
        arguments: argumentsFrozen,
      };
    } catch {
      return {
        wireName: call.wireName,
        effectSlot,
        argumentDigest: canonicalJsonDigest(call.argumentsJson),
        toolId: descriptor.toolId,
        initialResult: terminalResult(
          call.wireName,
          effectSlot,
          "invalid-arguments",
          "TOOL_ARGUMENT_SCHEMA_INVALID",
        ),
      };
    }
  }

  async #invoke(
    descriptor: ToolDescriptor,
    effect: ToolEffectJournalRecord,
    parentSignal?: AbortSignal,
  ): Promise<Omit<ToolCallTerminalResult, "providerCallId">> {
    const controller = new AbortController();
    const abort = () => controller.abort(parentSignal?.reason);
    if (parentSignal) parentSignal.addEventListener("abort", abort, { once: true });
    if (parentSignal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error("tool deadline")), descriptor.deadlineMs);
    try {
      const outcome = await this.#executor.execute({
        moduleJobId: this.#moduleJobId,
        effectSlot: effect.effectSlot,
        effectKey: canonicalJsonDigest([this.#moduleJobId, effect.effectSlot]),
        toolId: descriptor.toolId,
        arguments: effect.arguments!,
        deadlineMs: descriptor.deadlineMs,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        return terminalResult(
          effect.wireName,
          effect.effectSlot,
          descriptor.effectClass === "read" ? "cancelled" : "outcome-unknown",
          descriptor.effectClass === "read" ? "TOOL_CANCELLED" : "TOOL_EFFECT_UNCERTAIN",
        );
      }
      if (outcome.status === "failed" || outcome.status === "outcome-unknown") {
        assertId(outcome.code, "tool outcome code");
        return terminalResult(
          effect.wireName,
          effect.effectSlot,
          outcome.status,
          outcome.code,
        );
      }
      let content: JsonValue;
      try {
        content = validateValue(outcome.content, descriptor.resultSchema, "$.result");
      } catch {
        return terminalResult(
          effect.wireName,
          effect.effectSlot,
          "failed",
          "TOOL_RESULT_SCHEMA_INVALID",
        );
      }
      if (canonicalJsonByteLength(content) > descriptor.maxResultBytes) {
        return terminalResult(
          effect.wireName,
          effect.effectSlot,
          "failed",
          "TOOL_RESULT_LIMIT",
        );
      }
      return terminalResult(effect.wireName, effect.effectSlot, "succeeded", "OK", content);
    } catch {
      return terminalResult(
        effect.wireName,
        effect.effectSlot,
        descriptor.effectClass === "read" ? "failed" : "outcome-unknown",
        descriptor.effectClass === "read" ? "TOOL_EXECUTION_FAILED" : "TOOL_EFFECT_UNCERTAIN",
      );
    } finally {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener("abort", abort);
    }
  }

  #commitEffect(
    record: ToolRoundJournalRecord,
    index: number,
    result: Omit<ToolCallTerminalResult, "providerCallId">,
  ): ToolRoundJournalRecord {
    const effects = record.effects.map((effect, effectIndex) =>
      effectIndex === index ? { ...effect, status: "terminal" as const, result } : effect,
    );
    const next = immutableRound({
      ...record,
      revision: record.revision + 1,
      effects,
    });
    if (!this.#repository.compareAndSet(
      this.#moduleJobId,
      record.roundIndex,
      record.revision,
      next,
    )) {
      const current = this.#repository.getRound(this.#moduleJobId, record.roundIndex)!;
      const committed = current.effects[index]!;
      if (committed.status !== "terminal" || canonicalJsonDigest(committed.result) !== canonicalJsonDigest(result)) {
        throw new ToolPolicyError("TOOL_JOURNAL_CONFLICT", "Concurrent tool result conflicts");
      }
      return current;
    }
    return next;
  }

  #publicResult(
    record: ToolRoundJournalRecord,
    calls: readonly ToolCallRequest[],
  ): ToolRoundResult {
    const results = record.effects.map((effect, index) => ({
      providerCallId: calls[index]!.providerCallId,
      ...effect.result!,
    }));
    return deepFreeze({
      moduleJobId: record.moduleJobId,
      roundIndex: record.roundIndex,
      state: record.state === "reserved" ? "failed" : record.state,
      canContinue: record.state === "complete",
      results,
    });
  }
}
