import {
  assertJsonValue,
  canonicalJsonDigest,
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import type { BlockProposal } from "./block-store.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,512}$/;

export type MemoryRetentionScopeKind = "session" | "owner-long-term";
export type MemoryCapabilityMode = "index" | "query" | "delete" | "export";

export interface MemoryNamespace {
  readonly schemaVersion: "dolly.memory-namespace/1";
  readonly instanceId: string;
  readonly ownerScopeId: string;
  readonly memoryModuleInstanceId: string;
  readonly inputPageId: string;
  readonly retentionScopeKind: MemoryRetentionScopeKind;
  readonly retentionScopeId: string;
}

export interface MemoryCapabilityHandle {
  readonly token: string;
}

export interface MemoryCapabilityRequest {
  readonly namespace: MemoryNamespace;
  readonly authorizedSessionId: string;
  readonly modes: readonly MemoryCapabilityMode[];
  readonly expiresAt?: string;
}

interface MemoryCapabilityGrant extends MemoryCapabilityRequest {
  readonly token: string;
}

export interface MemoryRecord {
  readonly schemaVersion: "dolly.memory-record/2";
  readonly recordId: string;
  readonly namespace: MemoryNamespace;
  readonly sourceBlockId: string;
  readonly sourceBlockSequence: string;
  readonly sourcePageId: string;
  readonly sourceDeliveryId: string;
  readonly originatingSessionId: string;
  readonly moduleJobId: string;
  readonly text: string;
  readonly createdAt: string;
}

export interface MemoryRecallItem {
  readonly recordId: string;
  readonly sourceBlockId: string;
  readonly sourceBlockSequence: string;
  readonly text: string;
  readonly score: number;
}

export interface MemoryRecall {
  readonly schemaVersion: "dolly.memory-recall/1";
  readonly trustClass: "untrusted-memory";
  readonly queryDigest: string;
  readonly results: readonly MemoryRecallItem[];
}

export interface MemoryRepository {
  putOnce(
    effectId: string,
    inputDigest: string,
    record: MemoryRecord,
  ): MemoryRecord;
  list(namespace: MemoryNamespace): readonly MemoryRecord[];
}

interface MemoryPutEffect {
  readonly inputDigest: string;
  readonly record: MemoryRecord;
}

export type MemoryStoreErrorCode =
  | "MEMORY_ID_INVALID"
  | "MEMORY_RECORD_INVALID"
  | "MEMORY_NAMESPACE_INVALID"
  | "MEMORY_CAPABILITY_INVALID"
  | "MEMORY_CAPABILITY_DENIED"
  | "MEMORY_CAPABILITY_EXPIRED"
  | "MEMORY_EFFECT_CONFLICT"
  | "MEMORY_LIMIT_EXCEEDED";

export class MemoryStoreError extends Error {
  constructor(
    readonly code: MemoryStoreErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "MemoryStoreError";
  }
}

function assertId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new MemoryStoreError("MEMORY_ID_INVALID", `${label} is not a valid identifier`);
  }
}

function canonicalTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new MemoryStoreError("MEMORY_ID_INVALID", "Runtime clock returned invalid time");
  }
  return new Date(timestamp).toISOString();
}

function validateNamespace(namespace: MemoryNamespace): MemoryNamespace {
  if (
    namespace === null ||
    typeof namespace !== "object" ||
    Array.isArray(namespace) ||
    Object.getPrototypeOf(namespace) !== Object.prototype ||
    Object.keys(namespace).sort().join(",") !==
      [
        "inputPageId",
        "instanceId",
        "memoryModuleInstanceId",
        "ownerScopeId",
        "retentionScopeId",
        "retentionScopeKind",
        "schemaVersion",
      ].sort().join(",")
  ) {
    throw new MemoryStoreError("MEMORY_NAMESPACE_INVALID", "Memory namespace must be closed");
  }
  if (namespace.schemaVersion !== "dolly.memory-namespace/1") {
    throw new MemoryStoreError("MEMORY_NAMESPACE_INVALID", "Memory namespace version is invalid");
  }
  assertId(namespace.instanceId, "instanceId");
  assertId(namespace.ownerScopeId, "ownerScopeId");
  assertId(namespace.memoryModuleInstanceId, "memoryModuleInstanceId");
  assertId(namespace.inputPageId, "inputPageId");
  assertId(namespace.retentionScopeId, "retentionScopeId");
  if (
    namespace.retentionScopeKind !== "session" &&
    namespace.retentionScopeKind !== "owner-long-term"
  ) {
    throw new MemoryStoreError("MEMORY_NAMESPACE_INVALID", "Retention scope kind is invalid");
  }
  return deepFreeze({ ...namespace });
}

function namespaceDigest(namespace: MemoryNamespace): string {
  return canonicalJsonDigest(namespace);
}

function validateMemoryRecord(record: MemoryRecord): MemoryRecord {
  try {
    assertJsonValue(record);
  } catch {
    throw new MemoryStoreError("MEMORY_RECORD_INVALID", "Memory record is not JSON data");
  }
  const expectedKeys = [
    "createdAt",
    "moduleJobId",
    "namespace",
    "originatingSessionId",
    "recordId",
    "schemaVersion",
    "sourceBlockId",
    "sourceBlockSequence",
    "sourceDeliveryId",
    "sourcePageId",
    "text",
  ];
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.getPrototypeOf(record) !== Object.prototype ||
    Object.keys(record).sort().join(",") !== expectedKeys.sort().join(",") ||
    record.schemaVersion !== "dolly.memory-record/2" ||
    !/^[1-9][0-9]*$/.test(record.sourceBlockSequence) ||
    typeof record.text !== "string" ||
    record.text.length === 0 ||
    canonicalTime(record.createdAt) !== record.createdAt
  ) {
    throw new MemoryStoreError("MEMORY_RECORD_INVALID", "Memory record is invalid");
  }
  for (const [label, value] of [
    ["recordId", record.recordId],
    ["sourceBlockId", record.sourceBlockId],
    ["sourcePageId", record.sourcePageId],
    ["sourceDeliveryId", record.sourceDeliveryId],
    ["originatingSessionId", record.originatingSessionId],
    ["moduleJobId", record.moduleJobId],
  ] as const) {
    if (!ID_PATTERN.test(value)) {
      throw new MemoryStoreError("MEMORY_RECORD_INVALID", `${label} is not valid`);
    }
  }
  return deepFreeze({
    ...record,
    namespace: validateNamespace(record.namespace),
  });
}

export class InMemoryMemoryRepository implements MemoryRepository {
  readonly #effects = new Map<string, MemoryPutEffect>();
  readonly #records = new Map<string, MemoryRecord>();

  putOnce(effectId: string, inputDigest: string, record: MemoryRecord): MemoryRecord {
    assertId(effectId, "effectId");
    const immutable = validateMemoryRecord(record);
    const existing = this.#effects.get(effectId);
    if (existing) {
      if (existing.inputDigest !== inputDigest) {
        throw new MemoryStoreError(
          "MEMORY_EFFECT_CONFLICT",
          `Memory effect ${effectId} was reused with another input`,
        );
      }
      return existing.record;
    }
    if (this.#records.has(immutable.recordId)) {
      throw new MemoryStoreError(
        "MEMORY_EFFECT_CONFLICT",
        `Memory record ${immutable.recordId} already exists`,
      );
    }
    this.#records.set(immutable.recordId, immutable);
    this.#effects.set(effectId, deepFreeze({ inputDigest, record: immutable }));
    return immutable;
  }

  list(namespace: MemoryNamespace): readonly MemoryRecord[] {
    const digest = namespaceDigest(namespace);
    return [...this.#records.values()].filter(
      (record) => namespaceDigest(record.namespace) === digest,
    );
  }
}

export class MemoryNamespaceAuthority {
  readonly #grants = new Map<string, MemoryCapabilityGrant>();
  readonly #nextToken: () => string;
  readonly #now: () => string;

  constructor(options: { readonly nextToken: () => string; readonly now: () => string }) {
    this.#nextToken = options.nextToken;
    this.#now = options.now;
  }

  issue(request: MemoryCapabilityRequest): MemoryCapabilityHandle {
    const namespace = validateNamespace(request.namespace);
    assertId(request.authorizedSessionId, "authorizedSessionId");
    if (
      namespace.retentionScopeKind === "session" &&
      namespace.retentionScopeId !== request.authorizedSessionId
    ) {
      throw new MemoryStoreError(
        "MEMORY_NAMESPACE_INVALID",
        "A session namespace must use the authenticated session as retention scope",
      );
    }
    if (request.modes.length === 0 || new Set(request.modes).size !== request.modes.length) {
      throw new MemoryStoreError(
        "MEMORY_CAPABILITY_INVALID",
        "Memory capability modes must be non-empty and unique",
      );
    }
    const allowedModes: readonly MemoryCapabilityMode[] = ["index", "query", "delete", "export"];
    if (request.modes.some((mode) => !allowedModes.includes(mode))) {
      throw new MemoryStoreError(
        "MEMORY_CAPABILITY_INVALID",
        "Memory capability mode is invalid",
      );
    }
    const expiresAt =
      request.expiresAt === undefined ? undefined : canonicalTime(request.expiresAt);
    if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(canonicalTime(this.#now()))) {
      throw new MemoryStoreError(
        "MEMORY_CAPABILITY_INVALID",
        "Memory capability expiry must be in the future",
      );
    }
    const token = this.#nextToken();
    if (!TOKEN_PATTERN.test(token) || this.#grants.has(token)) {
      throw new MemoryStoreError(
        "MEMORY_CAPABILITY_INVALID",
        "Memory capability token is invalid or duplicated",
      );
    }
    this.#grants.set(
      token,
      deepFreeze({
        token,
        namespace,
        authorizedSessionId: request.authorizedSessionId,
        modes: [...request.modes],
        ...(expiresAt === undefined ? {} : { expiresAt }),
      }),
    );
    return deepFreeze({ token });
  }

  revoke(token: string): "revoked" | "absent" {
    return this.#grants.delete(token) ? "revoked" : "absent";
  }

  authorize(handle: MemoryCapabilityHandle, mode: MemoryCapabilityMode): MemoryCapabilityGrant {
    if (!TOKEN_PATTERN.test(handle.token)) {
      throw new MemoryStoreError("MEMORY_CAPABILITY_DENIED", "Memory capability is invalid");
    }
    const grant = this.#grants.get(handle.token);
    if (!grant || !grant.modes.includes(mode)) {
      throw new MemoryStoreError("MEMORY_CAPABILITY_DENIED", "Memory capability is denied");
    }
    if (
      grant.expiresAt !== undefined &&
      Date.parse(grant.expiresAt) <= Date.parse(canonicalTime(this.#now()))
    ) {
      throw new MemoryStoreError("MEMORY_CAPABILITY_EXPIRED", "Memory capability has expired");
    }
    return grant;
  }
}

export interface MemoryServiceOptions {
  readonly authority: MemoryNamespaceAuthority;
  readonly repository: MemoryRepository;
  readonly nextRecordId: () => string;
  readonly now: () => string;
  readonly maxTextBytes: number;
  readonly maxQueryBytes: number;
  readonly maxResults: number;
}

export interface IndexMemoryTextRequest {
  readonly capability: MemoryCapabilityHandle;
  readonly effectId: string;
  readonly moduleJobId: string;
  readonly sourceBlockId: string;
  readonly sourceBlockSequence: string;
  readonly sourcePageId: string;
  readonly sourceDeliveryId: string;
  readonly originatingSessionId: string;
  readonly text: string;
}

export class MemoryService {
  readonly #authority: MemoryNamespaceAuthority;
  readonly #repository: MemoryRepository;
  readonly #nextRecordId: () => string;
  readonly #now: () => string;
  readonly #maxTextBytes: number;
  readonly #maxQueryBytes: number;
  readonly #maxResults: number;

  constructor(options: MemoryServiceOptions) {
    for (const [name, value] of [
      ["maxTextBytes", options.maxTextBytes],
      ["maxQueryBytes", options.maxQueryBytes],
      ["maxResults", options.maxResults],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer`);
      }
    }
    this.#authority = options.authority;
    this.#repository = options.repository;
    this.#nextRecordId = options.nextRecordId;
    this.#now = options.now;
    this.#maxTextBytes = options.maxTextBytes;
    this.#maxQueryBytes = options.maxQueryBytes;
    this.#maxResults = options.maxResults;
  }

  indexText(request: IndexMemoryTextRequest): MemoryRecord {
    const grant = this.#authority.authorize(request.capability, "index");
    for (const [label, value] of [
      ["effectId", request.effectId],
      ["moduleJobId", request.moduleJobId],
      ["sourceBlockId", request.sourceBlockId],
      ["sourcePageId", request.sourcePageId],
      ["sourceDeliveryId", request.sourceDeliveryId],
      ["originatingSessionId", request.originatingSessionId],
    ] as const) {
      assertId(value, label);
    }
    if (!/^[1-9][0-9]*$/.test(request.sourceBlockSequence)) {
      throw new MemoryStoreError("MEMORY_ID_INVALID", "sourceBlockSequence is invalid");
    }
    if (
      request.sourcePageId !== grant.namespace.inputPageId ||
      request.originatingSessionId !== grant.authorizedSessionId
    ) {
      throw new MemoryStoreError(
        "MEMORY_CAPABILITY_DENIED",
        "Source Page or session does not match the runtime capability",
      );
    }
    if (
      typeof request.text !== "string" ||
      request.text.length === 0 ||
      Buffer.byteLength(request.text, "utf8") > this.#maxTextBytes
    ) {
      throw new MemoryStoreError(
        "MEMORY_LIMIT_EXCEEDED",
        "Memory text is empty or exceeds its limit",
      );
    }
    const inputDigest = canonicalJsonDigest({
      namespace: grant.namespace,
      effectId: request.effectId,
      moduleJobId: request.moduleJobId,
      sourceBlockId: request.sourceBlockId,
      sourceBlockSequence: request.sourceBlockSequence,
      sourcePageId: request.sourcePageId,
      sourceDeliveryId: request.sourceDeliveryId,
      originatingSessionId: request.originatingSessionId,
      text: request.text,
    });
    const recordId = this.#nextRecordId();
    assertId(recordId, "recordId");
    const record = deepFreeze({
      schemaVersion: "dolly.memory-record/2" as const,
      recordId,
      namespace: grant.namespace,
      sourceBlockId: request.sourceBlockId,
      sourceBlockSequence: request.sourceBlockSequence,
      sourcePageId: request.sourcePageId,
      sourceDeliveryId: request.sourceDeliveryId,
      originatingSessionId: request.originatingSessionId,
      moduleJobId: request.moduleJobId,
      text: request.text,
      createdAt: canonicalTime(this.#now()),
    });
    const repositoryEffectId = canonicalJsonDigest([
      "memory-index",
      grant.namespace,
      request.effectId,
    ]);
    return this.#repository.putOnce(repositoryEffectId, inputDigest, record);
  }

  query(
    capability: MemoryCapabilityHandle,
    query: string,
    limit: number,
  ): MemoryRecall {
    const grant = this.#authority.authorize(capability, "query");
    if (
      typeof query !== "string" ||
      query.length === 0 ||
      Buffer.byteLength(query, "utf8") > this.#maxQueryBytes
    ) {
      throw new MemoryStoreError(
        "MEMORY_LIMIT_EXCEEDED",
        "Memory query is empty or exceeds its limit",
      );
    }
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > this.#maxResults) {
      throw new MemoryStoreError("MEMORY_LIMIT_EXCEEDED", "Memory result limit is invalid");
    }
    const terms = [...new Set(query.toLocaleLowerCase("en-US").split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
    const records = this.#repository.list(grant.namespace);
    const results = records
      .map((record): MemoryRecallItem => {
        const text = record.text.toLocaleLowerCase("en-US");
        const hits = terms.reduce((count, term) => count + (text.includes(term) ? 1 : 0), 0);
        return {
          recordId: record.recordId,
          sourceBlockId: record.sourceBlockId,
          sourceBlockSequence: record.sourceBlockSequence,
          text: record.text,
          score: terms.length === 0 ? 0 : hits / terms.length,
        };
      })
      .filter((result) => result.score > 0)
      .sort((left, right) => {
        if (left.score !== right.score) return right.score - left.score;
        const leftSequence = BigInt(left.sourceBlockSequence);
        const rightSequence = BigInt(right.sourceBlockSequence);
        if (leftSequence !== rightSequence) return leftSequence < rightSequence ? -1 : 1;
        return left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0;
      })
      .slice(0, limit)
      .map((result) => deepFreeze({ ...result }));
    return deepFreeze({
      schemaVersion: "dolly.memory-recall/1" as const,
      trustClass: "untrusted-memory" as const,
      queryDigest: canonicalJsonDigest(query),
      results,
    });
  }

  recallBlockProposal(recall: MemoryRecall): BlockProposal {
    if (recall.schemaVersion !== "dolly.memory-recall/1" || recall.trustClass !== "untrusted-memory") {
      throw new MemoryStoreError("MEMORY_NAMESPACE_INVALID", "Memory recall envelope is invalid");
    }
    try {
      assertJsonValue(recall);
    } catch {
      throw new MemoryStoreError("MEMORY_NAMESPACE_INVALID", "Memory recall is not closed JSON");
    }
    return deepFreeze({
      summary: "Untrusted memory recall context",
      payload: {
        schema: "dolly.memory-recall/1",
        value: cloneJson(recall as unknown as JsonValue),
      },
    }) as BlockProposal;
  }
}
