import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  assertJsonValue,
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import { defaultDollyRuntimeDirectories } from "./runtime-bootstrap.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The durable prepared-turn and approval journal slice of the LLM extension
 * (roadmap WS5). It records, before any provider or effectful call, that a
 * turn was prepared, and it records every approval decision. Entries are
 * append-only: once persisted they are never modified or removed in place.
 * The journal is deterministic given the same append order, the same caller
 * inputs, and the same injected clock: only the entry timestamps come from
 * the clock, and every other byte of the journal is a pure function of the
 * appended records.
 *
 * A turn is keyed, per spec §4.2, by its module job; a retry of the same
 * module job finds the journal with `findPreparedTurnsForModuleJob` and reuses
 * a known terminal provider response and tool results instead of calling the
 * model again merely because the run changed.
 */

/**
 * Caller-controlled content of one prepared turn entry. The turn is prepared
 * before the first external call: it freezes the module job key, the run, the
 * starting conversation revision, the exact input Deliveries, the model
 * operation snapshot identity, and the turn budgets.
 */
export interface PreparedTurnInput {
  /** Stable identifier of the prepared turn (reused across retries). */
  readonly turnId: string;
  /** Module job that will execute this turn (spec 4.2 journal key). */
  readonly moduleJobId: string;
  /** Run that prepared the turn; a retry changes the run but not the turn. */
  readonly runId: string;
  /** Starting conversation revision this turn reconciles against. */
  readonly conversationRevision: number;
  /** Exact input Delivery identifiers consumed by this turn. */
  readonly inputDeliveryIds: readonly string[];
  /** Frozen model operation snapshot identity this turn plans to use. */
  readonly modelSnapshotId: string;
  /** Core Activation this preparation belongs to (fixed across attempts). */
  readonly activationId: string;
  /** Immutable attempt counter this prepared record belongs to. */
  readonly attempt: number;
  /** Lease epoch under which this record was prepared. */
  readonly leaseEpoch: number;
  /** Turn budget: maximum provider request count. */
  readonly maxRequests: number;
  /** Turn budget: maximum approval decision count. */
  readonly maxApprovals: number;
  /** Turn budget: maximum tool call count. */
  readonly maxToolCalls: number;
}

/** One durable prepared turn entry. */
export interface PreparedTurnRecord extends PreparedTurnInput {
  readonly kind: "prepared-turn";
  /** Wall-clock timestamp stamped by the journal when the entry was appended. */
  readonly recordedAt: string;
}

/** Caller-controlled content of one approval decision entry. */
export interface ApprovalDecisionInput {
  /** Stable identifier of this decision. */
  readonly decisionId: string;
  /** The prepared turn this decision concerns. */
  readonly turnId: string;
  /** The specific approval request (for example a tool call) being decided. */
  readonly requestId: string;
  /** Whether the request was approved. */
  readonly decision: "granted" | "denied";
  /** Approval policy revision that produced this decision. */
  readonly policyRevision: string;
}

/** One durable approval decision entry. */
export interface ApprovalDecisionRecord extends ApprovalDecisionInput {
  readonly kind: "approval-decision";
  /** Wall-clock timestamp stamped by the journal when the entry was appended. */
  readonly decidedAt: string;
}

export type LLMTurnJournalEntry = PreparedTurnRecord | ApprovalDecisionRecord;

/** Result of one guarded journal rotation. */
export interface LLMTurnJournalRotation {
  /** False when the journal was already empty and nothing needed archiving. */
  readonly rotated: boolean;
  /** Entries moved into the archive segment by this rotation. */
  readonly archivedEntries: number;
  /** Path of the archive segment, or null when nothing was rotated. */
  readonly archivePath: string | null;
  /** Entries still in the active journal after rotation. */
  readonly activeEntries: number;
}

/**
 * Minimal typed API of the durable prepared-turn and approval journal:
 * append a prepared turn, append an approval decision, read every entry back
 * in append order, and rotate the journal under a data-loss guard.
 *
 * An append that would exceed the configured byte limit is refused
 * (`LLM_TURN_JOURNAL_LIMIT_EXCEEDED`); callers must rotate before appending
 * more. Rotation never drops entries: it durably archives the active entries
 * into a deterministic segment file before resetting the active journal.
 */
export interface LLMTurnJournal {
  appendPreparedTurn(input: PreparedTurnInput): void;
  appendApprovalDecision(input: ApprovalDecisionInput): void;
  list(): readonly LLMTurnJournalEntry[];
  rotate(): LLMTurnJournalRotation;
}

export type LLMTurnJournalErrorCode =
  | "LLM_TURN_INVALID"
  | "LLM_TURN_JOURNAL_DOCUMENT_INVALID"
  | "LLM_TURN_JOURNAL_LIMIT_EXCEEDED"
  | "LLM_TURN_JOURNAL_LOCKED"
  | "LLM_TURN_JOURNAL_IO_FAILED"
  | "LLM_TURN_JOURNAL_CLOCK_INVALID";

export class LLMTurnJournalError extends Error {
  constructor(
    readonly code: LLMTurnJournalErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "LLMTurnJournalError";
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function assertIdentifier(value: unknown, field: string): void {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new LLMTurnJournalError("LLM_TURN_INVALID", `${field} is invalid`);
  }
}

function assertNonNegativeSafeInteger(
  value: unknown,
  field: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new LLMTurnJournalError(
      "LLM_TURN_INVALID",
      `${field} must be a non-negative safe integer`,
    );
  }
}

function assertCanonicalTimestamp(value: unknown, field: string): void {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP_PATTERN.test(value)) {
    throw new LLMTurnJournalError(
      "LLM_TURN_INVALID",
      `${field} must be a canonical UTC timestamp`,
    );
  }
}

function assertPreparedTurnFields(value: Record<string, unknown>): void {
  assertIdentifier(value.turnId, "Prepared turn turnId");
  assertIdentifier(value.moduleJobId, "Prepared turn moduleJobId");
  assertIdentifier(value.runId, "Prepared turn runId");
  assertIdentifier(value.modelSnapshotId, "Prepared turn modelSnapshotId");
  assertIdentifier(value.activationId, "Prepared turn activationId");
  assertNonNegativeSafeInteger(value.attempt, "Prepared turn attempt");
  assertNonNegativeSafeInteger(value.leaseEpoch, "Prepared turn leaseEpoch");
  assertNonNegativeSafeInteger(
    value.conversationRevision,
    "Prepared turn conversationRevision",
  );
  assertNonNegativeSafeInteger(value.maxRequests, "Prepared turn maxRequests");
  assertNonNegativeSafeInteger(value.maxApprovals, "Prepared turn maxApprovals");
  assertNonNegativeSafeInteger(value.maxToolCalls, "Prepared turn maxToolCalls");
  if (!Array.isArray(value.inputDeliveryIds)) {
    throw new LLMTurnJournalError("LLM_TURN_INVALID", "Prepared turn inputDeliveryIds is invalid");
  }
  for (const deliveryId of value.inputDeliveryIds) {
    assertIdentifier(deliveryId, "Prepared turn inputDeliveryId");
  }
}

/** Validates caller-supplied content of a prepared turn before stamping. */
export function assertPreparedTurnInput(value: unknown): asserts value is PreparedTurnInput {
  try {
    assertJsonValue(value);
  } catch {
    throw new LLMTurnJournalError("LLM_TURN_INVALID", "Prepared turn input is not JSON data");
  }
  const expectedKeys = [
    "activationId",
    "attempt",
    "conversationRevision",
    "inputDeliveryIds",
    "leaseEpoch",
    "maxApprovals",
    "maxRequests",
    "maxToolCalls",
    "modelSnapshotId",
    "moduleJobId",
    "runId",
    "turnId",
  ];
  if (!isPlainRecord(value) || !exactKeys(value, expectedKeys)) {
    throw new LLMTurnJournalError("LLM_TURN_INVALID", "Prepared turn input is invalid");
  }
  assertPreparedTurnFields(value);
}

/** Validates one complete prepared turn entry, including its timestamp. */
export function assertPreparedTurnRecord(value: unknown): asserts value is PreparedTurnRecord {
  if (!isPlainRecord(value) || value.kind !== "prepared-turn" || !exactKeys(value, [
    "activationId",
    "attempt",
    "conversationRevision",
    "inputDeliveryIds",
    "kind",
    "leaseEpoch",
    "maxApprovals",
    "maxRequests",
    "maxToolCalls",
    "modelSnapshotId",
    "moduleJobId",
    "recordedAt",
    "runId",
    "turnId",
  ])) {
    throw new LLMTurnJournalError("LLM_TURN_INVALID", "Prepared turn record is invalid");
  }
  assertPreparedTurnFields(value);
  assertCanonicalTimestamp(value.recordedAt, "Prepared turn recordedAt");
}

function assertApprovalDecisionFields(value: Record<string, unknown>): void {
  assertIdentifier(value.decisionId, "Approval decision decisionId");
  assertIdentifier(value.turnId, "Approval decision turnId");
  assertIdentifier(value.requestId, "Approval decision requestId");
  assertIdentifier(value.policyRevision, "Approval decision policyRevision");
  if (value.decision !== "granted" && value.decision !== "denied") {
    throw new LLMTurnJournalError("LLM_TURN_INVALID", "Approval decision decision is invalid");
  }
}

/** Validates caller-supplied content of an approval decision before stamping. */
export function assertApprovalDecisionInput(
  value: unknown,
): asserts value is ApprovalDecisionInput {
  try {
    assertJsonValue(value);
  } catch {
    throw new LLMTurnJournalError("LLM_TURN_INVALID", "Approval decision input is not JSON data");
  }
  const expectedKeys = [
    "decision",
    "decisionId",
    "policyRevision",
    "requestId",
    "turnId",
  ];
  if (!isPlainRecord(value) || !exactKeys(value, expectedKeys)) {
    throw new LLMTurnJournalError("LLM_TURN_INVALID", "Approval decision input is invalid");
  }
  assertApprovalDecisionFields(value);
}

/** Validates one complete approval decision entry, including its timestamp. */
export function assertApprovalDecisionRecord(
  value: unknown,
): asserts value is ApprovalDecisionRecord {
  if (!isPlainRecord(value) || value.kind !== "approval-decision" || !exactKeys(value, [
    "decidedAt",
    "decision",
    "decisionId",
    "kind",
    "policyRevision",
    "requestId",
    "turnId",
  ])) {
    throw new LLMTurnJournalError("LLM_TURN_INVALID", "Approval decision record is invalid");
  }
  assertApprovalDecisionFields(value);
  assertCanonicalTimestamp(value.decidedAt, "Approval decision decidedAt");
}

/** Validates one complete journal entry of either kind. */
export function assertLLMTurnJournalEntry(
  value: unknown,
): asserts value is LLMTurnJournalEntry {
  if (!isPlainRecord(value) || typeof value.kind !== "string") {
    throw new LLMTurnJournalError("LLM_TURN_INVALID", "Turn journal entry is invalid");
  }
  if (value.kind === "prepared-turn") {
    assertPreparedTurnRecord(value);
    return;
  }
  if (value.kind === "approval-decision") {
    assertApprovalDecisionRecord(value);
    return;
  }
  throw new LLMTurnJournalError("LLM_TURN_INVALID", "Turn journal entry kind is invalid");
}

export interface ResolveTurnJournalStateDirectoryOptions {
  /** Path of the instance configuration file (needed for relative state directories). */
  readonly configPath?: string;
  /** Instance identifier used when no state directory is configured. */
  readonly instanceId?: string;
  /** Configured instance state directory, mirroring the instance config field. */
  readonly stateDirectory?: string | null;
  /** Root under which per-instance state directories default. */
  readonly defaultStateRoot?: string;
}

/**
 * Locates the instance state directory from the established configuration
 * conventions: an absolute configured `stateDirectory` is used as-is, a
 * relative one resolves against the configuration file directory, and an
 * absent (or explicitly null) `stateDirectory` falls back to
 * `<defaultStateRoot>/<instanceId>`. This mirrors `InstanceConfigStore`.
 */
export function resolveTurnJournalStateDirectory(
  options: ResolveTurnJournalStateDirectoryOptions,
): string {
  const configured = options.stateDirectory;
  if (configured !== undefined && configured !== null && configured !== "") {
    if (!isAbsolute(configured)) {
      if (options.configPath === undefined) {
        throw new TypeError(
          "A relative instance state directory requires the configuration file path",
        );
      }
      return resolve(dirname(options.configPath), configured);
    }
    return resolve(configured);
  }
  const instanceId = options.instanceId;
  if (instanceId === undefined || !ID_PATTERN.test(instanceId)) {
    throw new TypeError(
      "Resolving the instance state directory without a configured path requires an instanceId",
    );
  }
  const root = options.defaultStateRoot ?? defaultDollyRuntimeDirectories().defaultStateRoot;
  return resolve(root, instanceId);
}

/**
 * The journal file path inside an instance state directory, sibling of the
 * other instance state files (`core-state.json`, `module-result-commits.json`).
 */
export function llmTurnJournalPath(stateDirectory: string): string {
  return join(stateDirectory, "llm-turn-journal.json");
}

/** Makes one appended entry immutable before it is persisted. */
export function immutableLLMTurnJournalEntry(
  entry: LLMTurnJournalEntry,
): LLMTurnJournalEntry {
  assertLLMTurnJournalEntry(entry);
  return deepFreeze(
    cloneJson(entry as unknown as JsonValue) as unknown as LLMTurnJournalEntry,
  );
}

/**
 * Returns every prepared-turn record for the exact module job, in append
 * order, from a journal entry list. Per spec §4.2 the turn journal is keyed by
 * `moduleJobId`: a retry of the same module job must find its journal entries
 * and reuse a known terminal provider response and tool results instead of
 * calling the model again merely because `runId` changed. The last returned
 * record is the latest (highest) prepared attempt for the job.
 *
 * The lookup is pure: it reads only the `moduleJobId` field of each entry,
 * returns a fresh array, and never mutates the list. A `moduleJobId` that is
 * not a valid journal identifier fails fast with `LLM_TURN_INVALID`, matching
 * every other journal identity check.
 */
export function findPreparedTurnsForModuleJob(
  entries: readonly LLMTurnJournalEntry[],
  moduleJobId: string,
): readonly PreparedTurnRecord[] {
  assertIdentifier(moduleJobId, "findPreparedTurnsForModuleJob moduleJobId");
  const records: PreparedTurnRecord[] = [];
  for (const entry of entries) {
    if (entry.kind === "prepared-turn" && entry.moduleJobId === moduleJobId) {
      records.push(entry);
    }
  }
  return records;
}