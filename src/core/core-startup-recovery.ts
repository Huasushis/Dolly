import { deepFreeze } from "./canonical-json.js";
import {
  type ClaimDescriptor,
  type DeliveryStore,
} from "./delivery-store.js";
import {
  type ModuleResultCommitCoordinator,
  type ModuleResultCommitRecord,
} from "./module-result-commit.js";
import {
  type ModuleProcessRecord,
  type ModuleSubmissionRecord,
} from "./module-process-records.js";

export type CoreStartupRecoveryErrorCode =
  | "STARTUP_ACTIVE_CLAIM_UNRESOLVED"
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
    }
  | { readonly proven: false; readonly reason: string };

export interface ModuleProcessStopProver {
  proveStopped(record: ModuleProcessRecord): Promise<ModuleProcessStopProof>;
}

/**
 * Durable evidence about every external effect a submitted Run could have
 * caused. `no-effect` proves the operation never crossed its effect boundary,
 * `retry-safe` proves repeating it cannot add a second effect, and `terminal`
 * proves a durably recorded final outcome. `unknown` keeps the exact Claim
 * active for audited operator action.
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
  readonly reason: "never-submitted" | "no-external-effect" | "effect-evidence-safe";
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
  readonly releasedClaims: readonly ReleasedClaimReport[];
  readonly unknownOutcomeClaims: readonly UnknownOutcomeClaimReport[];
  readonly stoppedProcessGenerationIds: readonly string[];
  /** Module records collected because nothing references them any more. */
  readonly collectedRecords: {
    readonly submissionRecords: number;
    readonly processRecords: number;
  };
}

/**
 * The durable Module record view for one complete Core-state update, plus the
 * transitions startup may apply to it. `FileCoreStateStore` satisfies this
 * interface; startup never reads these records from a second file.
 */
export interface ModuleRecordStore {
  listModuleProcessRecords(): readonly ModuleProcessRecord[];
  listModuleSubmissionRecords(): readonly ModuleSubmissionRecord[];
  getModuleProcessRecord(processGenerationId: string): ModuleProcessRecord | undefined;
  getModuleSubmissionRecord(runId: string): ModuleSubmissionRecord | undefined;
  updateModuleProcessRecordState(
    processGenerationId: string,
    state: "starting" | "running" | "stopping" | "stopped",
    failureCode?: string,
  ): ModuleProcessRecord;
  removeModuleSubmissionRecord(runId: string): void;
  /** Collects one stopped process record that nothing references any more. */
  removeModuleProcessRecord(processGenerationId: string): void;
  /**
   * Applies the callback's changes as one Core-state update so a Claim and
   * its Module records become terminal together.
   */
  runAtomicUpdate<T>(operation: () => T): T;
}

export interface CoreStartupRecoveryOptions {
  readonly deliveries: DeliveryStore;
  readonly commits: ModuleResultCommitCoordinator;
  readonly moduleRecords?: ModuleRecordStore;
  readonly processStopProver?: ModuleProcessStopProver;
  readonly externalEffectEvidence?: ExternalEffectEvidenceSource;
}

function claimIdentity(claim: ClaimDescriptor): {
  moduleJobId: string;
  claimToken: string;
  runId: string;
  attempt: number;
  moduleGenerationId: string;
} {
  return {
    moduleJobId: claim.moduleJobId,
    claimToken: claim.claimToken,
    runId: claim.runId,
    attempt: claim.attempt,
    moduleGenerationId: claim.moduleGenerationId,
  };
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
 * A submission record whose Claim is gone belongs to a Run that already
 * reached a terminal state through an evidence-checked path. A process record
 * is collectable only when it is stopped, no active Claim's submission record
 * references its process generation, and no active Claim belongs to its Module
 * generation.
 *
 * The three process-record conditions overlap on every state reachable through
 * `recover()`: an operator-visible unknown outcome keeps both a Claim and its
 * submission record, so two conditions retain the same record and removing any
 * one of them changes nothing observable. That redundancy is deliberate, but it
 * means a test driven only through `recover()` cannot show which condition did
 * the retaining. This selection is therefore exported as a pure function, so a
 * test can build a record set in which each condition is the only thing
 * standing between a record and collection.
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
  readonly submissionRecords: readonly ModuleSubmissionRecord[];
  readonly processRecords: readonly ModuleProcessRecord[];
} {
  const activeRunIds = new Set<string>();
  const activeGenerations = new Set<string>();
  for (const claim of input.activeClaims) {
    activeRunIds.add(claim.runId);
    activeGenerations.add(claim.moduleGenerationId);
  }

  const submissionRecords = input.submissionRecords.filter(
    (record) => !activeRunIds.has(record.runId),
  );
  const referencedProcessGenerations = new Set(
    input.submissionRecords
      .filter((record) => activeRunIds.has(record.runId))
      .map((record) => record.processGenerationId),
  );
  const processRecords = input.processRecords.filter(
    (record) =>
      record.state === "stopped" &&
      !referencedProcessGenerations.has(record.processGenerationId) &&
      !activeGenerations.has(record.moduleGenerationId),
  );
  return { submissionRecords, processRecords };
}

export class CoreStartupRecovery {
  readonly #deliveries: DeliveryStore;
  readonly #commits: ModuleResultCommitCoordinator;
  readonly #moduleRecords: ModuleRecordStore | undefined;
  readonly #processStopProver: ModuleProcessStopProver | undefined;
  readonly #externalEffectEvidence: ExternalEffectEvidenceSource | undefined;

  constructor(options: CoreStartupRecoveryOptions) {
    this.#deliveries = options.deliveries;
    this.#commits = options.commits;
    this.#moduleRecords = options.moduleRecords;
    this.#processStopProver = options.processStopProver;
    this.#externalEffectEvidence = options.externalEffectEvidence;
  }

  async recover(): Promise<CoreStartupRecoveryReport> {
    const stoppedProcessGenerationIds = await this.#proveOldProcessesStopped();
    this.#assertRecordsLinkToClaims();

    const recoveredCommits = await this.#commits.recoverAll();

    const releasedClaims: ReleasedClaimReport[] = [];
    const unknownOutcomeClaims: UnknownOutcomeClaimReport[] = [];
    for (const claim of this.#deliveries.listActiveClaims()) {
      if (this.#commits.inspect(claim.moduleJobId) !== null) {
        throw new CoreStartupRecoveryError(
          "STARTUP_JOURNAL_CLAIM_INCONSISTENT",
          `Module job ${claim.moduleJobId} still has an active claim after journal recovery`,
        );
      }
      const disposition = await this.#decideClaim(claim);
      if (disposition.kind === "release") {
        // The Claim and its submission record become terminal in one
        // Core-state update, so recovery can never see one without the other.
        const records = this.#moduleRecords;
        const releaseClaim = (): void => {
          this.#deliveries.releaseClaim(claimIdentity(claim));
          if (records?.getModuleSubmissionRecord(claim.runId)) {
            records.removeModuleSubmissionRecord(claim.runId);
          }
        };
        if (records) records.runAtomicUpdate(releaseClaim);
        else releaseClaim();
        releasedClaims.push({ ...claimIdentity(claim), reason: disposition.reason });
      } else {
        unknownOutcomeClaims.push({
          ...claimIdentity(claim),
          reason: disposition.reason,
        });
      }
    }

    const collectedRecords = this.#collectTerminalRecords();

    if (unknownOutcomeClaims.length > 0) {
      const detail = unknownOutcomeClaims
        .map((entry) => `${entry.moduleJobId}/${entry.runId}: ${entry.reason}`)
        .join("; ");
      throw new CoreStartupRecoveryError(
        "STARTUP_ACTIVE_CLAIM_UNRESOLVED",
        `${unknownOutcomeClaims.length} active Delivery Claim${
          unknownOutcomeClaims.length === 1 ? "" : "s"
        } remain with an unknown outcome and require audited operator action (${detail})`,
      );
    }

    return deepFreeze({
      recoveredCommits: [...recoveredCommits],
      releasedClaims,
      unknownOutcomeClaims,
      stoppedProcessGenerationIds,
      collectedRecords,
    });
  }

  /**
   * Collects Module records that no longer describe anything Core can act on.
   *
   * A submission record whose Claim is gone belongs to a Run that already
   * reached a terminal state through an evidence-checked path. A stopped
   * process record is collectable once no submission record references it and
   * no active Claim belongs to its Module generation. Both are removed in one
   * Core-state update so a partial collection cannot be observed.
   *
   * Records are kept while anything still needs them: a Claim preserved as an
   * unknown outcome keeps its whole Module generation's records, because an
   * operator resolving it needs the evidence they carry.
   */
  #collectTerminalRecords(): { submissionRecords: number; processRecords: number } {
    const records = this.#moduleRecords;
    if (!records) return { submissionRecords: 0, processRecords: 0 };

    const {
      submissionRecords: collectableSubmissions,
      processRecords: collectableProcessRecords,
    } = selectCollectableModuleRecords({
      activeClaims: this.#deliveries.listActiveClaims(),
      processRecords: records.listModuleProcessRecords(),
      submissionRecords: records.listModuleSubmissionRecords(),
    });

    if (collectableSubmissions.length === 0 && collectableProcessRecords.length === 0) {
      return { submissionRecords: 0, processRecords: 0 };
    }
    records.runAtomicUpdate(() => {
      for (const record of collectableSubmissions) {
        records.removeModuleSubmissionRecord(record.runId);
      }
      for (const record of collectableProcessRecords) {
        records.removeModuleProcessRecord(record.processGenerationId);
      }
    });
    return {
      submissionRecords: collectableSubmissions.length,
      processRecords: collectableProcessRecords.length,
    };
  }

  /**
   * Marks every old Module process record stopped, but only after the prover
   * supplies one of the accepted proofs. Without a prover, a record that is
   * not already stopped blocks startup rather than being assumed dead.
   */
  async #proveOldProcessesStopped(): Promise<readonly string[]> {
    const records = this.#moduleRecords?.listModuleProcessRecords() ?? [];
    const stopped: string[] = [];
    for (const record of records) {
      if (record.state === "stopped") continue;
      if (!this.#processStopProver) {
        throw new CoreStartupRecoveryError(
          "STARTUP_MODULE_PROCESS_UNPROVEN",
          `Module process record ${record.processGenerationId} is ${record.state} and no stop proof is available`,
        );
      }
      const proof = await this.#processStopProver.proveStopped(record);
      if (!proof.proven) {
        throw new CoreStartupRecoveryError(
          "STARTUP_MODULE_PROCESS_UNPROVEN",
          `Module control group for process generation ${record.processGenerationId} could not be proven empty: ${proof.reason}`,
        );
      }
      this.#moduleRecords!.updateModuleProcessRecordState(
        record.processGenerationId,
        "stopped",
      );
      stopped.push(record.processGenerationId);
    }
    return stopped;
  }

  /**
   * Rejects a Core-state update whose Module records cannot be linked to the
   * Claims in that same update: a submission record without its exact active
   * Claim, or an identity mismatch, is a fail-closed recovery error.
   */
  #assertRecordsLinkToClaims(): void {
    if (!this.#moduleRecords) return;
    const activeClaims = new Map(
      this.#deliveries.listActiveClaims().map((claim) => [claim.runId, claim]),
    );
    for (const submission of this.#moduleRecords.listModuleSubmissionRecords()) {
      const claim = activeClaims.get(submission.runId);
      if (!claim) {
        // A submission record whose Claim is gone describes a Run that already
        // reached a terminal state through an evidence-checked path: it was
        // committed, acknowledged, or released. The record has no remaining
        // purpose, so it is collected rather than treated as an inconsistency.
        //
        // Requiring a committed result here instead would make recovery depend
        // on the result-commit journal never deleting anything. That coupling
        // is not written down anywhere and would turn every historical record
        // into a startup failure the moment the journal gains a retention or
        // cleanup policy. `#collectTerminalRecords` removes it after the
        // remaining Claims have been decided.
        continue;
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
    }
  }

  async #decideClaim(
    claim: ClaimDescriptor,
  ): Promise<
    | { kind: "release"; reason: ReleasedClaimReport["reason"] }
    | { kind: "unknown"; reason: string }
  > {
    if (!this.#moduleRecords) {
      return {
        kind: "unknown",
        reason: "no durable Module process or submission record is available",
      };
    }
    const submission = this.#moduleRecords.getModuleSubmissionRecord(claim.runId);
    if (!submission) {
      // Without a submission record there is no link from this Claim to one
      // exact process record, and one Module generation may legitimately have
      // several start attempts. What Architecture Decision Record 0009 step 5
      // actually requires is that no process of that generation can still be
      // running, so every process record of the generation must be stopped.
      const generationRecords = this.#moduleRecords
        .listModuleProcessRecords()
        .filter((record) => record.moduleGenerationId === claim.moduleGenerationId);
      if (generationRecords.length === 0) {
        return {
          kind: "unknown",
          reason: "no Module process record matches this Claim",
        };
      }
      const running = generationRecords.filter((record) => record.state !== "stopped");
      if (running.length > 0) {
        return {
          kind: "unknown",
          reason: `${running.length} Module process record${
            running.length === 1 ? " is" : "s are"
          } not stopped for this Claim's Module generation`,
        };
      }
      // Core never received durable authority to send this Run, and every old
      // Module control group of that generation is proven empty, so the exact
      // Claim is safe to release for a later attempt.
      return { kind: "release", reason: "never-submitted" };
    }
    const processRecord = this.#moduleRecords.getModuleProcessRecord(
      submission.processGenerationId,
    );
    if (!processRecord) {
      return {
        kind: "unknown",
        reason: "no Module process record matches this Claim's submission record",
      };
    }
    if (processRecord.state !== "stopped") {
      return {
        kind: "unknown",
        reason: `matching Module process record is ${processRecord.state}`,
      };
    }
    if (processRecord.declaredExternalEffects === "none") {
      return { kind: "release", reason: "no-external-effect" };
    }
    if (!this.#externalEffectEvidence) {
      return {
        kind: "unknown",
        reason: "the Run was submitted and no external-effect evidence source is available",
      };
    }
    const evidence = await this.#externalEffectEvidence.inspectRunEffects(submission);
    if (evidence.kind === "unknown") {
      return { kind: "unknown", reason: evidence.reason };
    }
    return { kind: "release", reason: "effect-evidence-safe" };
  }

}
