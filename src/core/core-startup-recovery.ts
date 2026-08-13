import { canonicalJsonDigest, deepFreeze } from "./canonical-json.js";
import {
  type ClaimDescriptor,
  type DeliveryClaimIdentity,
  type DeliveryStore,
} from "./delivery-store.js";
import {
  ModuleResultCommitError,
  type ModuleResultCommitCoordinator,
  type ModuleResultCommitRecord,
  type ModuleResultCommitRepository,
  type DeferredModuleResultCommit,
} from "./module-result-commit.js";
import {
  type ModuleProcessRecord,
  type ModuleProcessStoppedRecordWriter,
  type ModuleSubmissionRecord,
} from "./module-process-records.js";

export type CoreStartupRecoveryErrorCode =
  | "STARTUP_ACTIVE_CLAIM_UNRESOLVED"
  /**
   * Startup could not confirm that the exact Claim became released and its
   * matching submission record disappeared in the same Core-state update.
   */
  | "STARTUP_CLAIM_RELEASE_UNCONFIRMED"
  | "STARTUP_JOURNAL_CLAIM_INCONSISTENT"
  | "STARTUP_MODULE_RECORD_INCONSISTENT"
  | "STARTUP_MODULE_PROCESS_UNPROVEN";

export class CoreStartupRecoveryError extends Error {
  constructor(readonly code: CoreStartupRecoveryErrorCode, message: string) {
    super(message);
    this.name = "CoreStartupRecoveryError";
  }
}

/**
 * Proof that one old Module control group can no longer contain a running
 * process. Architecture Decision Record 0009 accepts `populated 0` within the
 * same Linux boot, a missing path that still carries the record's non-reused
 * process-generation identifier, or a changed boot identifier. A Core process
 * identifier is never proof.
 */
export type ModuleProcessStopProof =
  | {
      readonly proven: true;
      readonly evidence: "populated-zero" | "missing-path" | "changed-boot-identifier";
      /**
       * Digest of the process generation, control-group path, Linux boot, and
       * Core service invocation from the exact process record proved stopped.
       */
      readonly recordIdentityDigest: string;
    }
  | { readonly proven: false; readonly reason: string };

export interface ModuleProcessStopProver {
  proveStopped(record: ModuleProcessRecord): Promise<ModuleProcessStopProof>;
}

/** Identifies the immutable process-record fields a stop proof must echo. */
export function moduleProcessStopProofIdentityDigest(
  record: ModuleProcessRecord,
): string {
  return canonicalJsonDigest({
    processGenerationId: record.processGenerationId,
    moduleCgroupPath: record.moduleCgroupPath,
    bootId: record.bootId,
    serviceInvocationId: record.serviceInvocationId,
  });
}

/**
 * Durable evidence about every external effect a submitted Run could have
 * caused. `no-effect` proves the operation never crossed its effect boundary,
 * `retry-safe` proves repeating it cannot add a second effect, and `terminal`
 * proves only that a final outcome is durably recorded. A terminal outcome
 * does not make repeating the operation safe without a separate durable
 * idempotency contract, which Dolly does not currently have. `unknown` and
 * `terminal` therefore keep the exact Claim active for audited operator action.
 */
export type ExternalEffectEvidence =
  | { readonly kind: "no-effect" | "retry-safe" | "terminal" }
  | { readonly kind: "unknown"; readonly reason: string };

export interface ExternalEffectEvidenceSource {
  inspectRunEffects(
    submission: ModuleSubmissionRecord,
  ): Promise<ExternalEffectEvidence>;
}

export interface ReleasedClaimReport {
  readonly moduleJobId: string;
  readonly claimToken: string;
  readonly runId: string;
  readonly attempt: number;
  readonly moduleGenerationId: string;
  /**
   * `never-authorized-to-send` means version 18 persisted the active Claim
   * without a Module submission record or a migration marker for unknown
   * history. Under that format's invariant, no Extension process-protocol send
   * was durably authorized for the Run.
   *
   * `no-external-effect` is reserved for a future process-record version that
   * binds the declaration to its validated configuration and enforcement
   * boundary. Version 1 declarations never authorize this disposition.
   * `external-effects-safe-to-retry` follows persistent evidence that the
   * submitted Run caused no effect or that retrying cannot add another effect.
   * `prepared-run-was-never-send-eligible` is carried only by submission v2:
   * its unique Host dispatch boundary was never durably entered.
   */
  readonly reason:
    | "never-authorized-to-send"
    | "prepared-run-was-never-send-eligible"
    | "no-external-effect"
    | "external-effects-safe-to-retry";
}

export interface UnknownOutcomeClaimReport {
  readonly moduleJobId: string;
  readonly claimToken: string;
  readonly runId: string;
  readonly attempt: number;
  readonly moduleGenerationId: string;
  readonly reason: string;
}

export interface CoreStartupRecoveryReport {
  readonly recoveredCommits: readonly ModuleResultCommitRecord[];
  /** Results are durable and known; only their output admission awaits capacity. */
  readonly deferredCommits: readonly DeferredModuleResultCommit[];
  /** One-use proof that deferred results passed old-process recovery for this store. */
  readonly handoff: CoreStartupRecoveryHandoff;
  readonly releasedClaims: readonly ReleasedClaimReport[];
  readonly unknownOutcomeClaims: readonly UnknownOutcomeClaimReport[];
  readonly stoppedProcessGenerationIds: readonly string[];
  /** Process records collected because nothing references them any more. */
  readonly collectedRecords: {
    readonly processRecords: number;
  };
}

export interface CoreStartupRecoveryHandoff {
  readonly schemaVersion: "dolly.core-startup-recovery-handoff/1";
}

class VerifiedCoreStartupRecoveryHandoff implements CoreStartupRecoveryHandoff {
  readonly schemaVersion = "dolly.core-startup-recovery-handoff/1" as const;
  readonly #deliveries: CoreStartupRecoveryOptions["deliveries"];
  readonly #commits: ModuleResultCommitCoordinator;
  readonly #moduleRecords: CoreStartupStateStore | undefined;
  readonly #processStopProver: ModuleProcessStopProver | undefined;
  readonly #deferredCommits: readonly DeferredModuleResultCommit[];
  #consumed = false;

  constructor(
    deliveries: CoreStartupRecoveryOptions["deliveries"],
    commits: ModuleResultCommitCoordinator,
    moduleRecords: CoreStartupStateStore | undefined,
    processStopProver: ModuleProcessStopProver | undefined,
    deferredCommits: readonly DeferredModuleResultCommit[],
  ) {
    this.#deliveries = deliveries;
    this.#commits = commits;
    this.#moduleRecords = moduleRecords;
    this.#processStopProver = processStopProver;
    this.#deferredCommits = deferredCommits;
  }

  consume(
    deliveries: CoreStartupRecoveryOptions["deliveries"],
    repository: ModuleResultCommitRepository,
    moduleRecords: CoreStartupStateStore,
    processStopProver?: ModuleProcessStopProver,
  ): readonly DeferredModuleResultCommit[] {
    if (this.#consumed) {
      throw new TypeError("Core startup recovery handoff was already consumed");
    }
    if (
      deliveries !== this.#deliveries ||
      !this.#commits.usesRepository(repository) ||
      moduleRecords !== this.#moduleRecords ||
      (
        processStopProver !== undefined &&
        processStopProver !== this.#processStopProver
      )
    ) {
      throw new TypeError(
        "Core startup recovery handoff is not bound to this Core store and result repository, its Module record store, and stop prover",
      );
    }
    this.#consumed = true;
    return this.#deferredCommits;
  }
}

/** Consumes the one-use startup proof after exact Core/repository identity checks. */
export function consumeCoreStartupRecoveryHandoff(input: {
  readonly handoff: CoreStartupRecoveryHandoff;
  readonly deliveries: CoreStartupRecoveryOptions["deliveries"];
  readonly repository: ModuleResultCommitRepository;
  readonly moduleRecords: CoreStartupStateStore;
  /** When supplied, requires exact identity with the prover used by recovery. */
  readonly processStopProver?: ModuleProcessStopProver;
}): readonly DeferredModuleResultCommit[] {
  if (!(input.handoff instanceof VerifiedCoreStartupRecoveryHandoff)) {
    throw new TypeError("Core startup recovery handoff is not authentic");
  }
  return input.handoff.consume(
    input.deliveries,
    input.repository,
    input.moduleRecords,
    input.processStopProver,
  );
}

/**
 * The Core-state store that startup uses to read and update Module records and
 * the exact terminal state of a Delivery Claim in the same update.
 * `FileCoreStateStore` satisfies this interface.
 */
export interface CoreStartupStateStore {
  listModuleProcessRecords(): readonly ModuleProcessRecord[];
  listModuleSubmissionRecords(): readonly ModuleSubmissionRecord[];
  /** Returns the store's stable immutable object for the current record version. */
  getModuleProcessRecord(processGenerationId: string): ModuleProcessRecord | undefined;
  getModuleSubmissionRecord(runId: string): ModuleSubmissionRecord | undefined;
  /**
   * Lists the complete five-field identities of migrated active Claims whose
   * submission history cannot be determined.
   */
  listActiveClaimsWithUnknownSubmissionHistory():
    readonly DeliveryClaimIdentity[];
  /**
   * Checks all five identity fields against that same persisted collection.
   */
  hasActiveClaimWithUnknownSubmissionHistory(
    identity: DeliveryClaimIdentity,
  ): boolean;
  updateModuleProcessRecordState(
    processGenerationId: string,
    state: "running" | "stopping",
    failureCode?: string,
  ): ModuleProcessRecord;
  /**
   * Releases the exact active Claim and removes its matching submission record
   * in the same Core-state update.
   */
  releaseDeliveryClaim(
    identity: DeliveryClaimIdentity,
  ): "released" | "already-released";
  /** Collects one stopped process record that nothing references any more. */
  removeModuleProcessRecord(processGenerationId: string): void;
  /** Persists related process-record removals as one Core-state revision. */
  runAtomicUpdate<Operation extends () => unknown>(
    operation: Operation &
      ([ReturnType<Operation>] extends [never]
        ? unknown
        : ReturnType<Operation> extends PromiseLike<unknown>
          ? never
          : ReturnType<Operation> extends void
            ? unknown
            : never),
  ): void;
}

export interface CoreStartupRecoveryOptions {
  readonly deliveries: Pick<DeliveryStore, "inspectClaim" | "listActiveClaims">;
  readonly commits: ModuleResultCommitCoordinator;
  readonly moduleRecords?: CoreStartupStateStore;
  /** Store-bound capability held only by this stop-proof coordinator. */
  readonly stoppedRecordWriter?: ModuleProcessStoppedRecordWriter;
  readonly processStopProver?: ModuleProcessStopProver;
  /**
   * Evidence for a future process-record version that proves the external-
   * effect declaration's configuration provenance. Version 1 `none` and
   * `core-capabilities-only` records are rejected before this source is
   * consulted.
   */
  readonly externalEffectEvidence?: ExternalEffectEvidenceSource;
}

function hasExactlyProperties(
  value: unknown,
  properties: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const ownProperties = Reflect.ownKeys(value);
  return (
    ownProperties.length === properties.length &&
    ownProperties.every(
      (property) =>
        typeof property === "string" && properties.includes(property),
    )
  );
}

function isAcceptedProcessStopProof(
  value: unknown,
): value is Extract<ModuleProcessStopProof, { readonly proven: true }> {
  return (
    hasExactlyProperties(value, [
      "proven",
      "evidence",
      "recordIdentityDigest",
    ]) &&
    value.proven === true &&
    typeof value.recordIdentityDigest === "string" &&
    (value.evidence === "populated-zero" ||
      value.evidence === "missing-path" ||
      value.evidence === "changed-boot-identifier")
  );
}

function isRejectedProcessStopProof(
  value: unknown,
): value is Extract<ModuleProcessStopProof, { readonly proven: false }> {
  return (
    hasExactlyProperties(value, ["proven", "reason"]) &&
    value.proven === false &&
    typeof value.reason === "string"
  );
}

export function isExternalEffectEvidence(
  value: unknown,
): value is ExternalEffectEvidence {
  if (
    hasExactlyProperties(value, ["kind"]) &&
    (value.kind === "no-effect" ||
      value.kind === "retry-safe" ||
      value.kind === "terminal")
  ) {
    return true;
  }
  return (
    hasExactlyProperties(value, ["kind", "reason"]) &&
    value.kind === "unknown" &&
    typeof value.reason === "string"
  );
}

function claimIdentity(claim: ClaimDescriptor): DeliveryClaimIdentity {
  return {
    moduleJobId: claim.moduleJobId,
    claimToken: claim.claimToken,
    runId: claim.runId,
    attempt: claim.attempt,
    moduleGenerationId: claim.moduleGenerationId,
  };
}

const DELIVERY_CLAIM_IDENTITY_FIELDS = [
  "moduleJobId",
  "claimToken",
  "runId",
  "attempt",
  "moduleGenerationId",
] as const;

function isDeliveryClaimIdentity(value: unknown): value is DeliveryClaimIdentity {
  return (
    hasExactlyProperties(value, DELIVERY_CLAIM_IDENTITY_FIELDS) &&
    typeof value.moduleJobId === "string" &&
    typeof value.claimToken === "string" &&
    typeof value.runId === "string" &&
    Number.isSafeInteger(value.attempt) &&
    (value.attempt as number) >= 1 &&
    typeof value.moduleGenerationId === "string"
  );
}

function hasSameClaimIdentity(
  left: DeliveryClaimIdentity,
  right: DeliveryClaimIdentity,
): boolean {
  return (
    left.moduleJobId === right.moduleJobId &&
    left.claimToken === right.claimToken &&
    left.runId === right.runId &&
    left.attempt === right.attempt &&
    left.moduleGenerationId === right.moduleGenerationId
  );
}

/**
 * Startup reconciliation in the order required by Architecture Decision
 * Record 0009: prove old Module processes stopped, validate one complete
 * Core-state update, recover the result-commit journal, reread Core state,
 * and only then decide each remaining active Claim from durable process,
 * submission, and external-effect evidence.
 */
/**
 * Chooses which Module records no longer describe anything Core can act on.
 *
 * A submission record must always match an active Claim and therefore has no
 * later collection phase. A process record is collectable only when it is
 * stopped, no submission record references its process generation, and no
 * active Claim belongs to its Module generation.
 *
 * The three process-record conditions overlap on every state reachable through
 * `recover()`: an operator-visible unknown outcome keeps both a Claim and its
 * submission record. This selection is exported as a pure function so tests
 * can independently prove both conditions that retain a process record.
 *
 * Over-collection is the dangerous direction: a record removed here is evidence
 * an operator needs to resolve an unknown outcome, and nothing recreates it.
 */
export function selectCollectableModuleRecords(input: {
  readonly activeClaims: readonly {
    readonly runId: string;
    readonly moduleGenerationId: string;
  }[];
  readonly processRecords: readonly ModuleProcessRecord[];
  readonly submissionRecords: readonly ModuleSubmissionRecord[];
}): {
  readonly processRecords: readonly ModuleProcessRecord[];
} {
  const activeGenerations = new Set<string>();
  for (const claim of input.activeClaims) {
    activeGenerations.add(claim.moduleGenerationId);
  }

  const referencedProcessGenerations = new Set(
    input.submissionRecords.map((record) => record.processGenerationId),
  );
  const processRecords = input.processRecords.filter(
    (record) =>
      record.state === "stopped" &&
      !referencedProcessGenerations.has(record.processGenerationId) &&
      !activeGenerations.has(record.moduleGenerationId),
  );
  return { processRecords };
}

export class CoreStartupRecovery {
  readonly #deliveries: Pick<DeliveryStore, "inspectClaim" | "listActiveClaims">;
  readonly #commits: ModuleResultCommitCoordinator;
  readonly #moduleRecords: CoreStartupStateStore | undefined;
  readonly #stoppedRecordWriter: ModuleProcessStoppedRecordWriter | undefined;
  readonly #processStopProver: ModuleProcessStopProver | undefined;
  readonly #externalEffectEvidence: ExternalEffectEvidenceSource | undefined;

  constructor(options: CoreStartupRecoveryOptions) {
    this.#deliveries = options.deliveries;
    this.#commits = options.commits;
    this.#moduleRecords = options.moduleRecords;
    this.#stoppedRecordWriter = options.stoppedRecordWriter;
    this.#processStopProver = options.processStopProver;
    this.#externalEffectEvidence = options.externalEffectEvidence;
  }

  async recover(): Promise<CoreStartupRecoveryReport> {
    const stoppedProcessGenerationIds = await this.#proveOldProcessesStopped();
    this.#assertRecordsLinkToClaims();

    let recoveredCommits: readonly ModuleResultCommitRecord[];
    let deferredCommits: readonly DeferredModuleResultCommit[];
    try {
      const resultRecovery = await this.#commits.recoverAll();
      recoveredCommits = resultRecovery.recoveredCommits;
      deferredCommits = resultRecovery.deferredCommits;
    } catch (error) {
      if (error instanceof ModuleResultCommitError) {
        switch (error.code) {
          case "MODULE_JOB_ID_INVALID":
          case "MODULE_JOB_RESULT_CONFLICT":
          case "MODULE_JOB_CLAIM_NOT_ACTIVE":
          case "MODULE_JOB_SOURCE_MISMATCH":
          case "MODULE_JOB_OUTPUT_INVALID":
          case "MODULE_RESULT_COMMIT_RECORD_MISSING":
          case "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT":
          case "MODULE_RESULT_PERSISTED_STATE_CONFLICT":
            throw new CoreStartupRecoveryError(
              "STARTUP_JOURNAL_CLAIM_INCONSISTENT",
              `Module result journal recovery failed with ${error.code}: ${error.message}`,
            );
          default:
            throw error;
        }
      }
      throw error;
    }

    const releasedClaims: ReleasedClaimReport[] = [];
    const unknownOutcomeClaims: UnknownOutcomeClaimReport[] = [];
    const unresolvedClaims: Array<
      DeliveryClaimIdentity & {
        readonly kind: "outcome-unknown" | "retry-safety-unproven";
        readonly reason: string;
      }
    > = [];
    const deferredModuleJobIds = new Set(
      deferredCommits.map((entry) => entry.record.moduleJobId),
    );
    this.#assertDeferredCommitProcesses(
      deferredCommits,
      new Set(stoppedProcessGenerationIds),
    );
    for (const claim of this.#deliveries.listActiveClaims()) {
      if (this.#commits.inspect(claim.moduleJobId) !== null) {
        if (deferredModuleJobIds.has(claim.moduleJobId)) continue;
        throw new CoreStartupRecoveryError(
          "STARTUP_JOURNAL_CLAIM_INCONSISTENT",
          `Module job ${claim.moduleJobId} still has an active claim after journal recovery`,
        );
      }
      const disposition = await this.#decideClaim(claim);
      if (disposition.kind === "release") {
        const records = this.#moduleRecords;
        if (!records) {
          throw new CoreStartupRecoveryError(
            "STARTUP_CLAIM_RELEASE_UNCONFIRMED",
            `Active Claim ${claim.runId} cannot be released without its Core-state record store`,
          );
        }
        this.#releaseClaimAndConfirm(claim, records);
        releasedClaims.push({ ...claimIdentity(claim), reason: disposition.reason });
      } else {
        const entry = {
          ...claimIdentity(claim),
          reason: disposition.reason,
        };
        unresolvedClaims.push({ ...entry, kind: disposition.kind });
        if (disposition.kind === "outcome-unknown") {
          unknownOutcomeClaims.push(entry);
        }
      }
    }

    const collectedRecords = this.#collectTerminalRecords();

    if (unresolvedClaims.length > 0) {
      const detail = unresolvedClaims
        .map(
          (entry) =>
            `${entry.moduleJobId}/${entry.runId} [${
              entry.kind === "retry-safety-unproven"
                ? "external-effect retry safety unproven"
                : "outcome unknown"
            }]: ${entry.reason}`,
        )
        .join("; ");
      throw new CoreStartupRecoveryError(
        "STARTUP_ACTIVE_CLAIM_UNRESOLVED",
        `${unresolvedClaims.length} active Delivery Claim${
          unresolvedClaims.length === 1 ? "" : "s"
        } remain unresolved and require audited operator action (${detail})`,
      );
    }

    return deepFreeze({
      recoveredCommits: [...recoveredCommits],
      deferredCommits: [...deferredCommits],
      handoff: new VerifiedCoreStartupRecoveryHandoff(
        this.#deliveries,
        this.#commits,
        this.#moduleRecords,
        this.#processStopProver,
        deferredCommits,
      ),
      releasedClaims,
      unknownOutcomeClaims,
      stoppedProcessGenerationIds,
      collectedRecords,
    });
  }

  #assertDeferredCommitProcesses(
    deferredCommits: readonly DeferredModuleResultCommit[],
    stoppedProcessGenerationIds: ReadonlySet<string>,
  ): void {
    if (deferredCommits.length === 0) return;
    const records = this.#moduleRecords;
    if (!records) {
      throw new CoreStartupRecoveryError(
        "STARTUP_MODULE_RECORD_INCONSISTENT",
        "Deferred Module results require durable process and submission records",
      );
    }
    const deferredModuleIds = new Set<string>();
    for (const deferred of deferredCommits) {
      const record = deferred.record;
      if (
        record.source.kind !== "module" ||
        deferredModuleIds.has(record.source.id)
      ) {
        throw new CoreStartupRecoveryError(
          "STARTUP_MODULE_RECORD_INCONSISTENT",
          "A Module cannot have more than one active result awaiting output capacity during startup recovery",
        );
      }
      deferredModuleIds.add(record.source.id);
      const claim = this.#deliveries.inspectClaim({
        moduleJobId: record.moduleJobId,
        claimToken: record.claimToken,
        runId: record.runId,
        attempt: record.attempt,
        moduleGenerationId: record.moduleGenerationId,
      });
      const submission = records.getModuleSubmissionRecord(record.runId);
      const processRecord = submission === undefined
        ? undefined
        : records.getModuleProcessRecord(submission.processGenerationId);
      if (
        claim.status !== "active" ||
        claim.consumerId !== record.source.id ||
        submission === undefined ||
        processRecord === undefined ||
        processRecord.state !== "stopped" ||
        !stoppedProcessGenerationIds.has(processRecord.processGenerationId) ||
        processRecord.moduleId !== record.source.id ||
        processRecord.moduleGenerationId !== record.moduleGenerationId
      ) {
        throw new CoreStartupRecoveryError(
          "STARTUP_MODULE_RECORD_INCONSISTENT",
          `Deferred Module result ${record.moduleJobId} is not bound to its stopped process`,
        );
      }
    }
  }

  /**
   * Releases one Claim through the Core-state boundary, then confirms the
   * exact terminal state through the same Delivery store startup is reading.
   */
  #releaseClaimAndConfirm(
    claim: ClaimDescriptor,
    records: CoreStartupStateStore,
  ): void {
    const identity = claimIdentity(claim);
    let result: unknown;
    let releaseThrew = false;
    try {
      result = records.releaseDeliveryClaim(identity);
    } catch {
      releaseThrew = true;
    }

    let persisted: ClaimDescriptor | undefined;
    try {
      persisted = this.#deliveries.inspectClaim(identity);
    } catch {
      // The stable recovery error below is more useful than exposing which
      // storage callback failed first.
    }
    if (
      !releaseThrew &&
      result !== "released" &&
      result !== "already-released"
    ) {
      throw new CoreStartupRecoveryError(
        "STARTUP_CLAIM_RELEASE_UNCONFIRMED",
        `Release of active Claim ${claim.runId} did not complete synchronously`,
      );
    }
    if (!persisted) {
      throw new CoreStartupRecoveryError(
        "STARTUP_CLAIM_RELEASE_UNCONFIRMED",
        `Release of active Claim ${claim.runId} could not be confirmed in the Delivery store used by startup`,
      );
    }
    if (
      persisted.moduleJobId !== claim.moduleJobId ||
      persisted.consumerId !== claim.consumerId ||
      persisted.claimToken !== claim.claimToken ||
      persisted.runId !== claim.runId ||
      persisted.attempt !== claim.attempt ||
      persisted.moduleGenerationId !== claim.moduleGenerationId ||
      persisted.status !== "released"
    ) {
      throw new CoreStartupRecoveryError(
        "STARTUP_CLAIM_RELEASE_UNCONFIRMED",
        `Release of active Claim ${claim.runId} was not persisted in the Delivery store used by startup`,
      );
    }
    let submission: ModuleSubmissionRecord | undefined;
    try {
      submission = records.getModuleSubmissionRecord(claim.runId);
    } catch {
      throw new CoreStartupRecoveryError(
        "STARTUP_CLAIM_RELEASE_UNCONFIRMED",
        `Submission-record removal for released Claim ${claim.runId} could not be confirmed`,
      );
    }
    if (submission !== undefined) {
      throw new CoreStartupRecoveryError(
        "STARTUP_CLAIM_RELEASE_UNCONFIRMED",
        `Released Claim ${claim.runId} still has a Module submission record`,
      );
    }
    let hasUnknownSubmissionHistory: unknown;
    try {
      hasUnknownSubmissionHistory =
        records.hasActiveClaimWithUnknownSubmissionHistory(identity);
    } catch {
      throw new CoreStartupRecoveryError(
        "STARTUP_CLAIM_RELEASE_UNCONFIRMED",
        `Unknown submission-history removal for released Claim ${claim.runId} could not be confirmed`,
      );
    }
    if (hasUnknownSubmissionHistory !== false) {
      throw new CoreStartupRecoveryError(
        "STARTUP_CLAIM_RELEASE_UNCONFIRMED",
        `Released Claim ${claim.runId} still has unknown submission history`,
      );
    }
    if (releaseThrew) {
      // The durable states are authoritative when the callback throws after
      // its synchronous Core-state update completed.
      return;
    }
  }

  /**
   * Collects Module records that no longer describe anything Core can act on.
   *
   * A stopped process record is collectable once no submission record
   * references it and no active Claim belongs to its Module generation.
   *
   * Records are kept while anything still needs them: a Claim preserved as an
   * unknown outcome keeps its whole Module generation's records, because an
   * operator resolving it needs the evidence they carry.
   */
  #collectTerminalRecords(): { processRecords: number } {
    const records = this.#moduleRecords;
    if (!records) return { processRecords: 0 };

    const { processRecords: collectableProcessRecords } = selectCollectableModuleRecords({
      activeClaims: this.#deliveries.listActiveClaims(),
      processRecords: records.listModuleProcessRecords(),
      submissionRecords: records.listModuleSubmissionRecords(),
    });

    if (collectableProcessRecords.length === 0) {
      return { processRecords: 0 };
    }
    records.runAtomicUpdate(() => {
      for (const record of collectableProcessRecords) {
        records.removeModuleProcessRecord(record.processGenerationId);
      }
    });
    return {
      processRecords: collectableProcessRecords.length,
    };
  }

  /**
   * Re-proves every old Module process record, including records already
   * labelled stopped. Version 17 did not persist the authority that produced
   * that label, so trusting it across startup would preserve historical
   * proofless writes. A non-terminal record additionally needs the separately
   * distributed stopped-record writer before its state can change.
   */
  async #proveOldProcessesStopped(): Promise<readonly string[]> {
    const records = this.#moduleRecords?.listModuleProcessRecords() ?? [];
    const stopped: string[] = [];
    for (const record of records) {
      if (!this.#processStopProver) {
        throw new CoreStartupRecoveryError(
          "STARTUP_MODULE_PROCESS_UNPROVEN",
          `Module process record ${record.processGenerationId} is ${record.state} and no fresh stop proof is available`,
        );
      }
      let pendingProof: unknown;
      try {
        pendingProof = this.#processStopProver.proveStopped(record);
      } catch {
        throw new CoreStartupRecoveryError(
          "STARTUP_MODULE_PROCESS_UNPROVEN",
          `Module control group stop prover failed for process generation ${record.processGenerationId}`,
        );
      }
      if (!(pendingProof instanceof Promise)) {
        throw new CoreStartupRecoveryError(
          "STARTUP_MODULE_PROCESS_UNPROVEN",
          `Module control group stop prover returned an invalid result for process generation ${record.processGenerationId}`,
        );
      }
      let proof: unknown;
      try {
        proof = await pendingProof;
      } catch {
        throw new CoreStartupRecoveryError(
          "STARTUP_MODULE_PROCESS_UNPROVEN",
          `Module control group stop prover failed for process generation ${record.processGenerationId}`,
        );
      }
      if (isRejectedProcessStopProof(proof)) {
        throw new CoreStartupRecoveryError(
          "STARTUP_MODULE_PROCESS_UNPROVEN",
          `Module control group for process generation ${record.processGenerationId} could not be proven empty: ${proof.reason}`,
        );
      }
      if (!isAcceptedProcessStopProof(proof)) {
        throw new CoreStartupRecoveryError(
          "STARTUP_MODULE_PROCESS_UNPROVEN",
          `Module control group stop prover returned an invalid result for process generation ${record.processGenerationId}`,
        );
      }
      if (
        proof.recordIdentityDigest !==
        moduleProcessStopProofIdentityDigest(record)
      ) {
        throw new CoreStartupRecoveryError(
          "STARTUP_MODULE_PROCESS_UNPROVEN",
          `Module control group stop proof does not match process generation ${record.processGenerationId}`,
        );
      }
      if (record.state !== "stopped") {
        if (!this.#stoppedRecordWriter) {
          throw new CoreStartupRecoveryError(
            "STARTUP_MODULE_PROCESS_UNPROVEN",
            `Module process record ${record.processGenerationId} is ${record.state} and startup does not hold its store-bound stopped-record writer`,
          );
        }
        const current = this.#moduleRecords!.getModuleProcessRecord(
          record.processGenerationId,
        );
        if (
          current === undefined ||
          moduleProcessStopProofIdentityDigest(current) !==
            moduleProcessStopProofIdentityDigest(record) ||
          !this.#stoppedRecordWriter.isBoundTo(current)
        ) {
          throw new CoreStartupRecoveryError(
            "STARTUP_MODULE_PROCESS_UNPROVEN",
            `The stopped-record writer is not bound to process generation ${record.processGenerationId} in the startup recovery store`,
          );
        }
        try {
          this.#stoppedRecordWriter.writeStopped(record.processGenerationId);
        } catch {
          throw new CoreStartupRecoveryError(
            "STARTUP_MODULE_PROCESS_UNPROVEN",
            `Module process record ${record.processGenerationId} could not be durably marked stopped after its proof`,
          );
        }
        const persisted = this.#moduleRecords!.getModuleProcessRecord(
          record.processGenerationId,
        );
        if (
          persisted?.state !== "stopped" ||
          moduleProcessStopProofIdentityDigest(persisted) !==
            moduleProcessStopProofIdentityDigest(record)
        ) {
          throw new CoreStartupRecoveryError(
            "STARTUP_MODULE_PROCESS_UNPROVEN",
            `The stopped-record writer did not update process generation ${record.processGenerationId} in the startup recovery store`,
          );
        }
      }
      stopped.push(record.processGenerationId);
    }
    return stopped;
  }

  /**
   * Rejects a Core-state update whose Module records cannot be linked to the
   * Claims in that same update. A submission record without its exact active
   * Claim, including one whose Claim is already terminal, is a fail-closed
   * recovery error.
   */
  #assertRecordsLinkToClaims(): void {
    if (!this.#moduleRecords) return;
    const records = this.#moduleRecords;
    const activeClaims = new Map(
      this.#deliveries.listActiveClaims().map((claim) => [claim.runId, claim]),
    );
    let submissions: unknown;
    let unknownSubmissionHistory: unknown;
    try {
      submissions = records.listModuleSubmissionRecords();
      unknownSubmissionHistory =
        records.listActiveClaimsWithUnknownSubmissionHistory();
    } catch {
      throw new CoreStartupRecoveryError(
        "STARTUP_MODULE_RECORD_INCONSISTENT",
        "Core-state Module record collections could not be read",
      );
    }
    if (!Array.isArray(submissions) || !Array.isArray(unknownSubmissionHistory)) {
      throw new CoreStartupRecoveryError(
        "STARTUP_MODULE_RECORD_INCONSISTENT",
        "Core-state Module record collections must be arrays",
      );
    }

    const submittedRunIds = new Set<string>();
    for (const submission of submissions as readonly ModuleSubmissionRecord[]) {
      const claim = activeClaims.get(submission.runId);
      if (!claim) {
        throw new CoreStartupRecoveryError(
          "STARTUP_MODULE_RECORD_INCONSISTENT",
          `Module submission record for Run ${submission.runId} has no matching active Claim`,
        );
      }
      if (
        claim.moduleJobId !== submission.moduleJobId ||
        claim.claimToken !== submission.claimToken ||
        claim.attempt !== submission.attempt ||
        claim.moduleGenerationId !== submission.moduleGenerationId
      ) {
        throw new CoreStartupRecoveryError(
          "STARTUP_MODULE_RECORD_INCONSISTENT",
          `Module submission record for Run ${submission.runId} does not match its active Claim identity`,
        );
      }
      submittedRunIds.add(submission.runId);
    }

    const unknownHistoryByRunId = new Map<string, DeliveryClaimIdentity>();
    for (const candidate of unknownSubmissionHistory) {
      if (!isDeliveryClaimIdentity(candidate)) {
        throw new CoreStartupRecoveryError(
          "STARTUP_MODULE_RECORD_INCONSISTENT",
          "An unknown submission-history entry must contain exactly the five Delivery Claim identity fields",
        );
      }
      if (unknownHistoryByRunId.has(candidate.runId)) {
        throw new CoreStartupRecoveryError(
          "STARTUP_MODULE_RECORD_INCONSISTENT",
          `Unknown submission history contains more than one entry for Run ${candidate.runId}`,
        );
      }
      const claim = activeClaims.get(candidate.runId);
      if (!claim || !hasSameClaimIdentity(candidate, claimIdentity(claim))) {
        throw new CoreStartupRecoveryError(
          "STARTUP_MODULE_RECORD_INCONSISTENT",
          `Unknown submission history for Run ${candidate.runId} does not match its exact active Claim identity`,
        );
      }
      if (submittedRunIds.has(candidate.runId)) {
        throw new CoreStartupRecoveryError(
          "STARTUP_MODULE_RECORD_INCONSISTENT",
          `Run ${candidate.runId} cannot have both a Module submission record and unknown submission history`,
        );
      }
      unknownHistoryByRunId.set(candidate.runId, candidate);
    }

    for (const claim of activeClaims.values()) {
      const identity = claimIdentity(claim);
      let queried: unknown;
      try {
        queried =
          records.hasActiveClaimWithUnknownSubmissionHistory(identity);
      } catch {
        throw new CoreStartupRecoveryError(
          "STARTUP_MODULE_RECORD_INCONSISTENT",
          `Unknown submission history for Run ${claim.runId} could not be queried`,
        );
      }
      if (
        typeof queried !== "boolean" ||
        queried !== unknownHistoryByRunId.has(claim.runId)
      ) {
        throw new CoreStartupRecoveryError(
          "STARTUP_MODULE_RECORD_INCONSISTENT",
          `Unknown submission-history list and exact query disagree for Run ${claim.runId}`,
        );
      }
    }
  }

  async #decideClaim(
    claim: ClaimDescriptor,
  ): Promise<
    | { kind: "release"; reason: ReleasedClaimReport["reason"] }
    | { kind: "outcome-unknown"; reason: string }
    | { kind: "retry-safety-unproven"; reason: string }
  > {
    if (!this.#moduleRecords) {
      return {
        kind: "outcome-unknown",
        reason: "no durable Module process or submission record is available",
      };
    }
    const submission = this.#moduleRecords.getModuleSubmissionRecord(claim.runId);
    if (!submission) {
      let hasUnknownSubmissionHistory: unknown;
      try {
        hasUnknownSubmissionHistory =
          this.#moduleRecords.hasActiveClaimWithUnknownSubmissionHistory(
            claimIdentity(claim),
          );
      } catch {
        throw new CoreStartupRecoveryError(
          "STARTUP_MODULE_RECORD_INCONSISTENT",
          `Unknown submission history for Run ${claim.runId} could not be queried`,
        );
      }
      if (hasUnknownSubmissionHistory !== true) {
        if (hasUnknownSubmissionHistory !== false) {
          throw new CoreStartupRecoveryError(
            "STARTUP_MODULE_RECORD_INCONSISTENT",
            `Unknown submission-history query returned an invalid result for Run ${claim.runId}`,
          );
        }
        return { kind: "release", reason: "never-authorized-to-send" };
      }
      return {
        kind: "outcome-unknown",
        reason:
          "migration from an older Core-state version cannot prove whether the missing Module submission record was never written or was removed separately",
      };
    }
    const processRecord = this.#moduleRecords.getModuleProcessRecord(
      submission.processGenerationId,
    );
    if (!processRecord) {
      return {
        kind: "outcome-unknown",
        reason: "no Module process record matches this Claim's submission record",
      };
    }
    if (processRecord.state !== "stopped") {
      return {
        kind: "outcome-unknown",
        reason: `matching Module process record is ${processRecord.state}`,
      };
    }
    if (
      submission.schemaVersion === "dolly.module-submission-record/2" &&
      submission.dispatchState === "prepared"
    ) {
      return {
        kind: "release",
        reason: "prepared-run-was-never-send-eligible",
      };
    }
    if (processRecord.declaredExternalEffects === "unrestricted") {
      return {
        kind: "outcome-unknown",
        reason:
          "the process boundary is unrestricted, so ambient effects are not excluded",
      };
    }
    if (
      processRecord.schemaVersion === "dolly.module-process-record/1"
    ) {
      return {
        kind: "outcome-unknown",
        reason:
          `the version 1 process record has no configuration provenance for its ${processRecord.declaredExternalEffects} external-effect declaration`,
      };
    }
    if (processRecord.declaredExternalEffects === "none") {
      return { kind: "release", reason: "no-external-effect" };
    }
    if (!this.#externalEffectEvidence) {
      return {
        kind: "outcome-unknown",
        reason: "the Run was submitted and no external-effect evidence source is available",
      };
    }
    let pendingEvidence: unknown;
    try {
      pendingEvidence = this.#externalEffectEvidence.inspectRunEffects(submission);
    } catch {
      return {
        kind: "outcome-unknown",
        reason: "the external-effect evidence source failed",
      };
    }
    if (!(pendingEvidence instanceof Promise)) {
      return {
        kind: "outcome-unknown",
        reason: "the external-effect evidence source returned an invalid result",
      };
    }
    let evidence: unknown;
    try {
      evidence = await pendingEvidence;
    } catch {
      return {
        kind: "outcome-unknown",
        reason: "the external-effect evidence source failed",
      };
    }
    if (!isExternalEffectEvidence(evidence)) {
      return {
        kind: "outcome-unknown",
        reason: "the external-effect evidence source returned an invalid result",
      };
    }
    if (evidence.kind === "unknown") {
      return { kind: "outcome-unknown", reason: evidence.reason };
    }
    if (evidence.kind === "terminal") {
      return {
        kind: "retry-safety-unproven",
        reason:
          "the external effect has a durable terminal outcome, but no durable idempotency contract proves that repeating the Run is safe",
      };
    }
    return { kind: "release", reason: "external-effects-safe-to-retry" };
  }

}
