/**
 * Durable Module process and submission records stored in the Core-state
 * document.
 *
 * A Module process record describes one attempt to start one existing Module
 * generation. A Module submission record states that one existing Run may
 * have crossed the Extension process protocol. Both live inside the one
 * atomic Core-state document; neither is a separate repository or result
 * store. See `docs/spec/core-runtime.md` Section 7.7 and ADR 0009.
 *
 * The process-generation identifier, the systemd invocation identifier, the
 * Linux boot identifier, and the Module control-group path are validated with
 * the shared rules in `linux-identifier-formats.js`, so this validator accepts
 * exactly the values Core's control-group derivation and service-binding proof
 * can produce.
 */

import {
  CGROUP_V2_MOUNT_POINT,
  MODULE_CGROUP_NAME_PREFIX,
  PROCESS_GENERATION_ID_RULE,
  VERSION19_PROCESS_GENERATION_ID_RULE,
  isLinuxBootId,
  isModuleProcessGenerationId,
  isProcessGenerationId,
  isServiceInvocationId,
} from "./linux-identifier-formats.js";
import { isIdentityBoundModuleCgroupPath } from "./linux-module-cgroup-identity.js";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_FAILURE_CODE_LENGTH = 128;

export type ModuleProcessRecordState =
  | "starting"
  | "running"
  | "stopping"
  | "stopped";

/**
 * Describes which external-effect channels Core may rely on during recovery.
 * `unrestricted` means the process boundary does not prevent ambient file,
 * network, or subprocess effects, so no automatic retry is safe. Version 1
 * records bind neither `none` nor `core-capabilities-only` to a validated
 * configuration and enforcement boundary, so startup preserves both values
 * as unknown.
 */
export type DeclaredExternalEffects =
  | "unrestricted"
  | "none"
  | "core-capabilities-only";

/**
 * The durable declaration-provenance binding a version 2 Module process
 * record carries. `provenanceDigest` is the closed canonical digest of the
 * original WeakSet-authenticated provenance value; persisting the digest
 * lets Core recover the exact declaration without retaining the
 * adapter-owned value itself.
 */
export interface ModuleProcessDeclarationProvenance {
  readonly schemaVersion: "dolly.reserved-v10-module-process-provenance/1";
  readonly provenanceDigest: string;
}

export interface ModuleProcessRecord {
  readonly schemaVersion:
    | "dolly.module-process-record/1"
    | "dolly.module-process-record/2";
  readonly instanceId: string;
  readonly moduleId: string;
  readonly moduleGenerationId: string;
  readonly processGenerationId: string;
  readonly packageDigest: string;
  readonly configurationReference: {
    readonly configId: string;
    readonly revision: string;
    readonly configVersion: number;
  };
  readonly declaredExternalEffects: DeclaredExternalEffects;
  /**
   * Version 2 only. The durable binding the installed composition's
   * authority authenticated at allocation time. Version 1 records never
   * carry this field, and the validator refuses it on a version 1 record.
   */
  readonly declarationProvenance?: ModuleProcessDeclarationProvenance;
  readonly serviceInvocationId: string;
  readonly bootId: string;
  readonly moduleCgroupPath: string;
  readonly state: ModuleProcessRecordState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly diagnosticPid?: number;
  readonly failureCode?: string;
}

/**
 * The input from which the Core-state store allocates a starting Module
 * process record. The caller supplies every field except the process-generation
 * identifier and the derived control-group path: the store mints the version 19
 * identifier from its durable counter and binds the control-group path to that
 * identifier before appending and persisting the starting record atomically.
 */
export interface ModuleProcessStartingRecordInput {
  readonly schemaVersion:
    | "dolly.module-process-record/1"
    | "dolly.module-process-record/2";
  readonly instanceId: string;
  readonly moduleId: string;
  readonly moduleGenerationId: string;
  readonly packageDigest: string;
  readonly configurationReference: {
    readonly configId: string;
    readonly revision: string;
    readonly configVersion: number;
  };
  readonly declaredExternalEffects: DeclaredExternalEffects;
  /**
   * Version 2 only. The opaque, WeakSet-authenticated declaration-provenance
   * value minted by the installed extension Module executor. Core never
   * inspects the value; the store-bound authority reduces it to the durable
   * digest binding persisted on the record. Version 1 inputs must not carry
   * one.
   */
  readonly declarationProvenance?: unknown;
  readonly serviceInvocationId: string;
  readonly bootId: string;
  /** The delegated control-group root Core derives the record's path from. */
  readonly delegatedRootCgroupPath: string;
  /**
   * An optional caller-derived control-group path for the same generation.
   * Core always stores its own derivation; a supplied path must still be the
   * identity-bound derivation Core itself would produce, and is otherwise
   * refused before any state changes.
   */
  readonly moduleCgroupPath?: string;
  readonly state: "starting";
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Narrow authority to persist the terminal state of a Module process record.
 * Ordinary record stores do not expose this operation: product composition
 * gives the capability only to coordinators that first prove the whole
 * process group has stopped.
 */
export interface ModuleProcessStoppedRecordWriter {
  /** Rejects product composition that pairs this authority with another Core store. */
  isStoreBoundTo(store: unknown): boolean;
  /** Uses the store's stable current-record identity to reject another store. */
  isBoundTo(record: ModuleProcessRecord): boolean;
  writeStopped(
    processGenerationId: string,
    failureCode?: string,
  ): ModuleProcessRecord;
}

/**
 * A Core-owned, store-bound authenticator slot for version 2 Module process
 * record declaration provenance. The installed composition supplies an
 * implementation bound to one Core-state store; the store's starting-record
 * allocator invokes its `verify` to reduce a WeakSet-authenticated provenance
 * value to the durable binding persisted on the record. A store without a
 * bound authority refuses every version 2 allocation, so Core never imports
 * adapters and never accepts provenance it cannot authenticate.
 */
export interface ModuleProcessDeclarationProvenanceAuthority {
  /** Rejects composition that pairs this authority with another Core store. */
  isStoreBoundTo(store: unknown): boolean;
  /**
   * Authenticates the starting input's declaration provenance and returns the
   * durable binding. Throws when the value is forged, copied, foreign-store,
   * or inconsistent with the input's identity, package, or configuration.
   */
  verify(
    input: ModuleProcessStartingRecordInput,
  ): ModuleProcessDeclarationProvenance;
}

export interface ModuleSubmissionRecord {
  readonly schemaVersion:
    | "dolly.module-submission-record/1"
    | "dolly.module-submission-record/2";
  readonly moduleJobId: string;
  readonly claimToken: string;
  readonly runId: string;
  readonly attempt: number;
  readonly moduleGenerationId: string;
  readonly processGenerationId: string;
  readonly inputDigest: string;
  readonly createdAt: string;
  /** Required and closed by the validator for version 2; forbidden for v1. */
  readonly dispatchState?: "prepared" | "send-possible";
}

export type ModuleProcessRecordErrorCode =
  | "MODULE_PROCESS_RECORD_INVALID"
  | "MODULE_PROCESS_RECORD_CONFLICT"
  | "MODULE_PROCESS_RECORD_NOT_FOUND"
  | "MODULE_PROCESS_RECORD_STATE_INVALID"
  | "MODULE_PROCESS_STOP_PROOF_REQUIRED"
  | "MODULE_PROCESS_RECORD_IN_USE"
  /**
   * The process-generation identifier was submitted by the caller although
   * the Core-state store alone allocates identifiers in the version 19
   * identity domain (and, after migration to `dolly.core-state/19`, every
   * new process generation).
   */
  | "MODULE_PROCESS_RECORD_ALLOCATION_REQUIRED"
  /**
   * A version 2 starting record requires a store-bound
   * `ModuleProcessDeclarationProvenanceAuthority`; without one the store
   * refuses every version 2 allocation so it cannot authenticate provenance.
   */
  | "MODULE_PROCESS_RECORD_DECLARATION_PROVENANCE_REQUIRED"
  /**
   * The store cannot allocate version 19 identifiers because the Core-state
   * document has not been explicitly migrated to `dolly.core-state/19`.
   */
  | "MODULE_PROCESS_RECORD_IDENTITY_MIGRATION_REQUIRED"
  | "MODULE_SUBMISSION_RECORD_INVALID"
  | "MODULE_SUBMISSION_RECORD_CONFLICT"
  | "MODULE_SUBMISSION_RECORD_NOT_FOUND"
  | "MODULE_SUBMISSION_RECORD_STATE_INVALID"
  | "MODULE_SUBMISSION_RECORD_UNAUTHORIZED"
  /**
   * An older Core-state format cannot prove whether this Claim's submission
   * record ever existed, so Dolly must not submit it again or make it terminal
   * through an ordinary acknowledgement, negative acknowledgement, or release.
   */
  | "MODULE_CLAIM_SUBMISSION_HISTORY_UNKNOWN";

export class ModuleProcessRecordError extends Error {
  constructor(readonly code: ModuleProcessRecordErrorCode, message: string) {
    super(message);
    this.name = "ModuleProcessRecordError";
  }
}

function fail(code: ModuleProcessRecordErrorCode, message: string): never {
  throw new ModuleProcessRecordError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint < 0x20 || codePoint === 0x7f) return false;
  }
  return true;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function assertClosedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: ModuleProcessRecordErrorCode,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(code, `${label} contains the unknown field "${key}"`);
    }
  }
}

export function assertValidModuleProcessRecord(
  value: unknown,
): asserts value is ModuleProcessRecord {
  const code = "MODULE_PROCESS_RECORD_INVALID";
  if (!isPlainObject(value)) fail(code, "Module process record must be an object");
  assertClosedKeys(
    value,
    [
      "schemaVersion",
      "instanceId",
      "moduleId",
      "moduleGenerationId",
      "processGenerationId",
      "packageDigest",
      "configurationReference",
      "declaredExternalEffects",
      "declarationProvenance",
      "serviceInvocationId",
      "bootId",
      "moduleCgroupPath",
      "state",
      "createdAt",
      "updatedAt",
      "diagnosticPid",
      "failureCode",
    ],
    code,
    "Module process record",
  );
  if (value.schemaVersion === "dolly.module-process-record/2") {
    const provenance = value.declarationProvenance;
    if (provenance === undefined) {
      fail(
        code,
        "Module process record declarationProvenance is required for schema version 2",
      );
    }
    if (
      provenance === null ||
      typeof provenance !== "object" ||
      Array.isArray(provenance)
    ) {
      fail(code, "Module process record declarationProvenance must be an object");
    }
    const provenanceRecord = provenance as Record<string, unknown>;
    assertClosedKeys(
      provenanceRecord,
      ["schemaVersion", "provenanceDigest"],
      code,
      "Module process record declarationProvenance",
    );
    if (
      provenanceRecord.schemaVersion !==
      "dolly.reserved-v10-module-process-provenance/1"
    ) {
      fail(code, "Module process record declarationProvenance schema version is not supported");
    }
    if (
      typeof provenanceRecord.provenanceDigest !== "string" ||
      !DIGEST_PATTERN.test(provenanceRecord.provenanceDigest)
    ) {
      fail(code, "Module process record declarationProvenance provenanceDigest must be a sha256 digest");
    }
  } else if (value.schemaVersion !== "dolly.module-process-record/1") {
    fail(code, "Module process record schema version is not supported");
  } else if (value.declarationProvenance !== undefined) {
    fail(
      code,
      "Module process record declarationProvenance requires schema version 2",
    );
  }
  for (const field of ["instanceId", "moduleId", "moduleGenerationId"] as const) {
    if (!isIdentifier(value[field])) {
      fail(code, `Module process record field "${field}" must be an identifier`);
    }
  }
  if (!isModuleProcessGenerationId(value.processGenerationId)) {
    fail(
      code,
      `Module process record processGenerationId ${PROCESS_GENERATION_ID_RULE}, or ${VERSION19_PROCESS_GENERATION_ID_RULE}`,
    );
  }
  if (!isServiceInvocationId(value.serviceInvocationId)) {
    fail(
      code,
      "Module process record serviceInvocationId must be the 32 lower-case hexadecimal digits systemd reports as InvocationID",
    );
  }
  if (!isLinuxBootId(value.bootId)) {
    fail(
      code,
      "Module process record bootId must be a lower-case Linux boot identifier in universally unique identifier form",
    );
  }
  if (typeof value.packageDigest !== "string" || !DIGEST_PATTERN.test(value.packageDigest)) {
    fail(code, "Module process record packageDigest must be a sha256 digest");
  }
  const reference = value.configurationReference;
  if (!isPlainObject(reference)) {
    fail(code, "Module process record configurationReference must be an object");
  }
  assertClosedKeys(
    reference,
    ["configId", "revision", "configVersion"],
    code,
    "Module process record configurationReference",
  );
  if (!isIdentifier(reference.configId)) {
    fail(code, "Module process record configId must be an identifier");
  }
  if (typeof reference.revision !== "string" || !DIGEST_PATTERN.test(reference.revision)) {
    fail(code, "Module process record configuration revision must be a sha256 digest");
  }
  if (!Number.isSafeInteger(reference.configVersion) || (reference.configVersion as number) < 1) {
    fail(code, "Module process record configVersion must be a positive integer");
  }
  if (
    value.declaredExternalEffects !== "unrestricted" &&
    value.declaredExternalEffects !== "none" &&
    value.declaredExternalEffects !== "core-capabilities-only"
  ) {
    fail(code, "Module process record declaredExternalEffects value is not supported");
  }
  if (!isIdentityBoundModuleCgroupPath(value.moduleCgroupPath, {
    instanceId: value.instanceId as string,
    moduleId: value.moduleId as string,
    processGenerationId: value.processGenerationId as string,
  })) {
    fail(
      code,
      `Module process record moduleCgroupPath must be a Core-derived Module control-group path below ${CGROUP_V2_MOUNT_POINT} whose directory name is "${MODULE_CGROUP_NAME_PREFIX}${value.processGenerationId}-" followed by the 64-digit identity digest`,
    );
  }
  if (
    value.state !== "starting" &&
    value.state !== "running" &&
    value.state !== "stopping" &&
    value.state !== "stopped"
  ) {
    fail(code, "Module process record state is not supported");
  }
  if (!isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.updatedAt)) {
    fail(code, "Module process record timestamps must be canonical ISO 8601 UTC");
  }
  if (
    value.diagnosticPid !== undefined &&
    (!Number.isSafeInteger(value.diagnosticPid) || (value.diagnosticPid as number) < 1)
  ) {
    fail(code, "Module process record diagnosticPid must be a positive integer");
  }
  if (
    value.failureCode !== undefined &&
    (!isIdentifier(value.failureCode) ||
      (value.failureCode as string).length > MAX_FAILURE_CODE_LENGTH)
  ) {
    fail(code, "Module process record failureCode must be a bounded identifier");
  }
}

export function assertValidModuleSubmissionRecord(
  value: unknown,
): asserts value is ModuleSubmissionRecord {
  const code = "MODULE_SUBMISSION_RECORD_INVALID";
  if (!isPlainObject(value)) fail(code, "Module submission record must be an object");
  const commonKeys = [
      "schemaVersion",
      "moduleJobId",
      "claimToken",
      "runId",
      "attempt",
      "moduleGenerationId",
      "processGenerationId",
      "inputDigest",
      "createdAt",
    ] as const;
  if (
    value.schemaVersion !== "dolly.module-submission-record/1" &&
    value.schemaVersion !== "dolly.module-submission-record/2"
  ) {
    fail(code, "Module submission record schema version is not supported");
  }
  assertClosedKeys(
    value,
    value.schemaVersion === "dolly.module-submission-record/2"
      ? [...commonKeys, "dispatchState"]
      : commonKeys,
    code,
    "Module submission record",
  );
  if (
    value.schemaVersion === "dolly.module-submission-record/2" &&
    value.dispatchState !== "prepared" &&
    value.dispatchState !== "send-possible"
  ) {
    fail(code, "Module submission record dispatchState is not supported");
  }
  for (const field of [
    "moduleJobId",
    "claimToken",
    "runId",
    "moduleGenerationId",
  ] as const) {
    if (!isIdentifier(value[field])) {
      fail(code, `Module submission record field "${field}" must be an identifier`);
    }
  }
  if (!isModuleProcessGenerationId(value.processGenerationId)) {
    fail(
      code,
      `Module submission record processGenerationId ${PROCESS_GENERATION_ID_RULE}, or ${VERSION19_PROCESS_GENERATION_ID_RULE}`,
    );
  }
  if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1) {
    fail(code, "Module submission record attempt must be a positive integer");
  }
  if (typeof value.inputDigest !== "string" || !DIGEST_PATTERN.test(value.inputDigest)) {
    fail(code, "Module submission record inputDigest must be a sha256 digest");
  }
  if (!isIsoTimestamp(value.createdAt)) {
    fail(code, "Module submission record createdAt must be canonical ISO 8601 UTC");
  }
}

const PROCESS_STATE_TRANSITIONS: Readonly<
  Record<ModuleProcessRecordState, readonly ModuleProcessRecordState[]>
> = {
  starting: ["running", "stopping", "stopped"],
  running: ["stopping", "stopped"],
  stopping: ["stopped"],
  stopped: [],
};

export function canTransitionModuleProcessRecordState(
  from: ModuleProcessRecordState,
  to: ModuleProcessRecordState,
): boolean {
  return PROCESS_STATE_TRANSITIONS[from].includes(to);
}

/**
 * The identity of the one changing Module slot a process record occupies:
 * instance, Module, Module generation. `stopped` is the only terminal state,
 * so Core may hold at most one non-terminal record per tuple; every other
 * record for the same tuple is retained stopped history.
 */
function moduleProcessTupleKey(record: ModuleProcessRecord): string {
  // Identifiers can never contain a NUL (isIdentifier rejects code points
  // below 0x20), so the separator cannot appear inside a tuple member.
  return `${record.instanceId}\u0000${record.moduleId}\u0000${record.moduleGenerationId}`;
}

/**
 * Rejects any pair of non-terminal Module process records that share one
 * (instance, Module, Module-generation) tuple. This is the single shared
 * implementation of that invariant: the file-backed store enforces it at
 * append, and persisted-document validation enforces it on every load.
 */
export function assertNonTerminalModuleProcessTuplesUnique(
  records: readonly ModuleProcessRecord[],
): void {
  const nonTerminalTuples = new Set<string>();
  for (const record of records) {
    if (record.state === "stopped") continue;
    const tupleKey = moduleProcessTupleKey(record);
    if (nonTerminalTuples.has(tupleKey)) {
      fail(
        "MODULE_PROCESS_RECORD_CONFLICT",
        `Multiple non-terminal Module process records exist for instance "${record.instanceId}", Module "${record.moduleId}", Module generation "${record.moduleGenerationId}"`,
      );
    }
    nonTerminalTuples.add(tupleKey);
  }
}

/**
 * Validates the cross-record rules that hold inside one Core-state document:
 * unique identity keys, at most one non-terminal process record per Module
 * generation tuple, and every submission record referring to a process
 * record with the same Module generation. Claim linkage is validated by
 * startup reconciliation, which owns the Delivery view.
 */
export function assertModuleRecordCollectionsConsistent(
  processRecords: readonly ModuleProcessRecord[],
  submissionRecords: readonly ModuleSubmissionRecord[],
): void {
  const byProcessGeneration = new Map<string, ModuleProcessRecord>();
  for (const record of processRecords) {
    if (byProcessGeneration.has(record.processGenerationId)) {
      fail(
        "MODULE_PROCESS_RECORD_CONFLICT",
        `Duplicate Module process record for process generation "${record.processGenerationId}"`,
      );
    }
    byProcessGeneration.set(record.processGenerationId, record);
  }
  assertNonTerminalModuleProcessTuplesUnique(processRecords);
  const seenRuns = new Set<string>();
  for (const submission of submissionRecords) {
    if (seenRuns.has(submission.runId)) {
      fail(
        "MODULE_SUBMISSION_RECORD_CONFLICT",
        `Duplicate Module submission record for Run "${submission.runId}"`,
      );
    }
    seenRuns.add(submission.runId);
    const processRecord = byProcessGeneration.get(submission.processGenerationId);
    if (!processRecord) {
      fail(
        "MODULE_SUBMISSION_RECORD_INVALID",
        `Module submission record for Run "${submission.runId}" has no matching process record`,
      );
    }
    if (processRecord.moduleGenerationId !== submission.moduleGenerationId) {
      fail(
        "MODULE_SUBMISSION_RECORD_INVALID",
        `Module submission record for Run "${submission.runId}" does not match its process record generation`,
      );
    }
  }
}
