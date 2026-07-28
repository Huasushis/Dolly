/**
 * The one control-plane operation layer both editing interfaces call.
 *
 * `instance-topology.md` Section 5.2 requires the command-line interface (CLI)
 * to call the same control-plane operations as the graphical editor, and
 * Section 5.3 forbids the editor from holding a privileged channel, a private
 * operation, or an unvalidated write path. Every method here is therefore
 * transport-free: the Hypertext Transfer Protocol (HTTP) surface and the CLI
 * module are two thin adapters over this class, and neither of them contains
 * validation, planning, compare-and-swap, or audit logic of its own.
 *
 * Authentication and authorization happen in the adapter that has an identity
 * to authenticate — the HTTP surface authenticates a browser session, and the
 * CLI adapter runs under the operating-system account that already owns the
 * installation. Both pass a `ConsoleActor` in, because Section 11 records the
 * interface as an attribute of the actor and never as a different event.
 */

import { deepFreeze, type JsonValue } from "../../core/canonical-json.js";
import {
  InstanceConfigError,
  type InstanceConfigStore,
  type LoadedInstanceConfig,
} from "../../core/instance-config-store.js";
import type { DollyInstanceConfig } from "../../core/runtime-config.js";
import type { DaemonInstanceReport } from "../daemon-instance-manager.js";
import type { RegisteredInstance } from "../instance-registry.js";
import {
  buildConsoleAuditEvent,
  type ConsoleActor,
  type ConsoleAuditSink,
} from "./console-audit.js";
import type { InstanceObligationSource } from "./instance-obligations.js";
import {
  ConsoleOperationError,
  type ConsoleOperationErrorCode,
} from "./operation-catalog.js";
import {
  buildTopologyCandidate,
  computeTopologyPlan,
  firstRejectedEntry,
  type TopologyChangePlan,
  type TopologySubmission,
} from "./topology-revision.js";
import {
  assertUnknownOutcomeDisposition,
  buildForcedReleaseWarning,
  type PreservedUnknownOutcomeClaim,
  type UnknownOutcomeClaimStore,
  type UnknownOutcomeDisposition,
  type UnknownOutcomeDispositionOutcome,
} from "./unknown-outcome.js";

const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;

/** The lifecycle surface this layer needs; `DaemonInstanceManager` satisfies it. */
export interface InstanceLifecycleControl {
  listRegisteredInstances(): readonly RegisteredInstance[];
  listInstances(): Promise<readonly DaemonInstanceReport[]>;
  describeInstance(instanceId: string): Promise<DaemonInstanceReport>;
  startInstance(instanceId: string, operationId: string): Promise<DaemonInstanceReport>;
  stopInstance(instanceId: string, operationId: string): Promise<DaemonInstanceReport>;
}

export interface ConsoleOperationsOptions {
  readonly lifecycle: InstanceLifecycleControl;
  readonly configStore: InstanceConfigStore<DollyInstanceConfig>;
  readonly obligations: InstanceObligationSource;
  readonly unknownOutcomeClaims: (instanceId: string) => UnknownOutcomeClaimStore;
  /**
   * The revision the runtime has actually applied, or `null` when nothing is
   * applied because the instance is stopped. Section 9.3 requires the expected,
   * desired, and effective revisions to stay distinguishable.
   */
  readonly effectiveRevision?: (instanceId: string) => Promise<string | null>;
  readonly audit?: ConsoleAuditSink;
  readonly now?: () => string;
}

export interface InstanceConfigurationView {
  readonly instanceId: string;
  readonly configPath: string;
  readonly expectedRevision: string;
  readonly desiredRevision: string;
  readonly effectiveRevision: string | null;
  readonly revisionsDiverged: boolean;
  readonly document: JsonValue;
}

export interface TopologyCommitResult {
  readonly instanceId: string;
  readonly plan: TopologyChangePlan;
  readonly expectedRevision: string;
  readonly newRevision: string;
  readonly desiredRevision: string;
  readonly effectiveRevision: string | null;
  readonly revisionsDiverged: boolean;
}

export interface UnknownOutcomeDispositionResult {
  readonly instanceId: string;
  readonly claimToken: string;
  readonly disposition: UnknownOutcomeDisposition;
  readonly outcome: UnknownOutcomeDispositionOutcome;
  readonly evidenceDigest: string;
}

export interface TopologyCommitRequest extends TopologySubmission {
  readonly operationId: string;
  readonly actor: ConsoleActor;
  readonly confirmedPlanDigest?: string;
}

export interface UnknownOutcomeDispositionRequestInput {
  readonly instanceId: string;
  readonly claimToken: string;
  readonly disposition: unknown;
  readonly operationId: string;
  readonly actor: ConsoleActor;
  readonly acknowledgedWarningDigest?: string;
}

export class ConsoleOperations {
  readonly #options: ConsoleOperationsOptions;
  readonly #now: () => string;

  constructor(options: ConsoleOperationsOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  listInstances(): Promise<readonly DaemonInstanceReport[]> {
    return this.#options.lifecycle.listInstances();
  }

  describeInstance(instanceId: string): Promise<DaemonInstanceReport> {
    this.#requireRegistered(instanceId);
    return this.#options.lifecycle.describeInstance(instanceId);
  }

  async startInstance(input: {
    readonly instanceId: string;
    readonly operationId: string;
    readonly actor: ConsoleActor;
  }): Promise<DaemonInstanceReport> {
    const instance = this.#requireRegistered(input.instanceId);
    assertOperationId(input.operationId);
    try {
      const report = await this.#options.lifecycle.startInstance(
        input.instanceId,
        input.operationId,
      );
      this.#audit({
        eventType: "console.instance.start",
        result: "succeeded",
        operationId: input.operationId,
        instanceId: input.instanceId,
        actor: input.actor,
        configRevision: instance.desiredConfigRevision,
        details: { status: report.status },
      });
      return report;
    } catch (error) {
      this.#audit({
        eventType: "console.instance.start",
        result: "failed",
        operationId: input.operationId,
        instanceId: input.instanceId,
        actor: input.actor,
        configRevision: instance.desiredConfigRevision,
        details: { failureCode: errorCode(error) },
      });
      throw asOperationError(error);
    }
  }

  async stopInstance(input: {
    readonly instanceId: string;
    readonly operationId: string;
    readonly actor: ConsoleActor;
  }): Promise<DaemonInstanceReport> {
    const instance = this.#requireRegistered(input.instanceId);
    assertOperationId(input.operationId);
    try {
      const report = await this.#options.lifecycle.stopInstance(
        input.instanceId,
        input.operationId,
      );
      this.#audit({
        eventType: "console.instance.stop",
        result: "succeeded",
        operationId: input.operationId,
        instanceId: input.instanceId,
        actor: input.actor,
        configRevision: instance.desiredConfigRevision,
        details: { status: report.status },
      });
      return report;
    } catch (error) {
      this.#audit({
        eventType: "console.instance.stop",
        result: "failed",
        operationId: input.operationId,
        instanceId: input.instanceId,
        actor: input.actor,
        configRevision: instance.desiredConfigRevision,
        details: { failureCode: errorCode(error) },
      });
      throw asOperationError(error);
    }
  }

  async readConfiguration(instanceId: string): Promise<InstanceConfigurationView> {
    const loaded = this.#loadConfiguration(instanceId);
    const desiredRevision = this.#requireRegistered(instanceId).desiredConfigRevision;
    const effectiveRevision = await this.#effectiveRevision(instanceId);
    return deepFreeze({
      instanceId,
      configPath: loaded.configPath,
      expectedRevision: loaded.configRevision,
      desiredRevision,
      effectiveRevision,
      revisionsDiverged: effectiveRevision !== null && effectiveRevision !== desiredRevision,
      document: loaded.redactedDocument,
    }) as InstanceConfigurationView;
  }

  /** Steps 2 to 4 of the Section 5.1 pipeline, with nothing committed. */
  async planTopologyRevision(submission: TopologySubmission): Promise<TopologyChangePlan> {
    const { loaded, obligations } = await this.#prepare(submission);
    const candidate = buildTopologyCandidate(loaded.document, submission, obligations);
    return computeTopologyPlan({
      current: loaded.document,
      candidate,
      obligations,
      expectedRevision: submission.expectedRevision,
      dispositions: submission.dispositions ?? [],
      modulePrivateStorage: submission.modulePrivateStorage ?? [],
    });
  }

  /**
   * Steps 2 to 7 of the pipeline. The plan is recomputed here rather than
   * trusted from the caller, because obligations change while an operator reads
   * a screen; a confirmation that names a different plan is refused.
   */
  async commitTopologyRevision(request: TopologyCommitRequest): Promise<TopologyCommitResult> {
    assertOperationId(request.operationId);
    const { loaded, obligations } = await this.#prepare(request);
    const candidate = buildTopologyCandidate(loaded.document, request, obligations);
    const plan = computeTopologyPlan({
      current: loaded.document,
      candidate,
      obligations,
      expectedRevision: request.expectedRevision,
      dispositions: request.dispositions ?? [],
      modulePrivateStorage: request.modulePrivateStorage ?? [],
    });

    const refuse = (code: ConsoleOperationErrorCode, message: string, details: JsonValue): never => {
      this.#audit({
        eventType: "console.topology.commit",
        result: "refused",
        operationId: request.operationId,
        instanceId: request.instanceId,
        actor: request.actor,
        configRevision: request.expectedRevision,
        details: { failureCode: code, planDigest: plan.planDigest },
      });
      throw new ConsoleOperationError(code, message, { plan, ...(details as object) });
    };

    const rejected = firstRejectedEntry(plan);
    if (rejected) {
      refuse(
        rejected.errorCode ?? "TOPOLOGY_PLAN_REJECTED",
        `${rejected.element}: ${rejected.detail}`,
        { element: rejected.element } as unknown as JsonValue,
      );
    }
    if (request.confirmedPlanDigest === undefined) {
      if (plan.requiresConfirmation) {
        refuse(
          "TOPOLOGY_CONFIRMATION_REQUIRED",
          "The plan contains a breaking entry, which requires an explicit confirmation naming this exact plan",
          { planDigest: plan.planDigest } as unknown as JsonValue,
        );
      }
    } else if (request.confirmedPlanDigest !== plan.planDigest) {
      refuse(
        "TOPOLOGY_PLAN_STALE",
        "The obligations changed between planning and confirmation; re-read the plan and confirm it again",
        {
          confirmedPlanDigest: request.confirmedPlanDigest,
          currentPlanDigest: plan.planDigest,
        } as unknown as JsonValue,
      );
    }

    let committed: LoadedInstanceConfig<DollyInstanceConfig>;
    try {
      committed = this.#options.configStore.update(
        loaded.configPath,
        request.expectedRevision,
        () => candidate.document,
      );
    } catch (error) {
      if (error instanceof InstanceConfigError && error.code === "CONFIG_REVISION_CONFLICT") {
        const current = this.#options.configStore.inspect(loaded.configPath);
        this.#audit({
          eventType: "console.topology.commit",
          result: "refused",
          operationId: request.operationId,
          instanceId: request.instanceId,
          actor: request.actor,
          configRevision: request.expectedRevision,
          details: {
            failureCode: "CONFIG_REVISION_CONFLICT",
            currentRevision: current.configRevision,
          },
        });
        throw new ConsoleOperationError(
          "CONFIG_REVISION_CONFLICT",
          "The stored configuration revision is no longer the expected revision; re-read, re-plan, and resubmit",
          {
            expectedRevision: request.expectedRevision,
            currentRevision: current.configRevision,
          },
        );
      }
      this.#audit({
        eventType: "console.topology.commit",
        result: "failed",
        operationId: request.operationId,
        instanceId: request.instanceId,
        actor: request.actor,
        configRevision: request.expectedRevision,
        details: { failureCode: errorCode(error) },
      });
      throw asOperationError(error);
    }

    this.#audit({
      eventType: "console.topology.commit",
      result: "succeeded",
      operationId: request.operationId,
      instanceId: request.instanceId,
      actor: request.actor,
      configRevision: request.expectedRevision,
      newConfigRevision: committed.configRevision,
      details: {
        planDigest: plan.planDigest,
        evidenceSource: plan.evidenceSource,
        entries: plan.entries.map((entry) => ({
          element: entry.element,
          operation: entry.operation,
          classification: entry.classification,
          ...(entry.disposition === undefined ? {} : { disposition: entry.disposition }),
          ...(entry.obligations === undefined ? {} : { obligations: entry.obligations }),
        })) as unknown as JsonValue,
      },
    });

    const effectiveRevision = await this.#effectiveRevision(request.instanceId);
    return deepFreeze({
      instanceId: request.instanceId,
      plan,
      expectedRevision: request.expectedRevision,
      newRevision: committed.configRevision,
      desiredRevision: committed.configRevision,
      effectiveRevision,
      revisionsDiverged:
        effectiveRevision !== null && effectiveRevision !== committed.configRevision,
    }) as TopologyCommitResult;
  }

  listUnknownOutcomeClaims(instanceId: string): Promise<readonly PreservedUnknownOutcomeClaim[]> {
    this.#requireRegistered(instanceId);
    return this.#options.unknownOutcomeClaims(instanceId).listPreservedClaims();
  }

  /**
   * Section 13.1 in order: identify the Claim and its evidence, refuse a forced
   * release that carries no acknowledged warning, refuse a confirmation that
   * names different evidence, emit the audit event, and only then apply.
   */
  async disposeUnknownOutcomeClaim(
    input: UnknownOutcomeDispositionRequestInput,
  ): Promise<UnknownOutcomeDispositionResult> {
    const instance = this.#requireRegistered(input.instanceId);
    assertOperationId(input.operationId);
    const disposition = assertUnknownOutcomeDisposition(input.disposition);
    const store = this.#options.unknownOutcomeClaims(input.instanceId);
    const claims = await store.listPreservedClaims();
    const claim = claims.find((entry) => entry.identity.claimToken === input.claimToken);
    if (!claim) {
      throw new ConsoleOperationError(
        "UNKNOWN_OUTCOME_CLAIM_NOT_FOUND",
        "No Claim preserved as an unknown outcome carries this claim token",
        { claimToken: input.claimToken },
      );
    }

    if (disposition === "release") {
      const warning = buildForcedReleaseWarning(claim);
      if (input.acknowledgedWarningDigest === undefined) {
        this.#audit({
          eventType: "console.claim.unknown-outcome.warning-issued",
          result: "refused",
          operationId: input.operationId,
          instanceId: input.instanceId,
          actor: input.actor,
          configRevision: instance.desiredConfigRevision,
          moduleGenerationId: claim.identity.moduleGenerationId,
          details: {
            claimToken: claim.identity.claimToken,
            evidenceDigest: claim.evidenceDigest,
            acknowledgementDigest: warning.acknowledgementDigest,
          },
        });
        throw new ConsoleOperationError(
          "UNKNOWN_OUTCOME_WARNING_REQUIRED",
          warning.consequence,
          { warning },
        );
      }
      if (input.acknowledgedWarningDigest !== warning.acknowledgementDigest) {
        throw new ConsoleOperationError(
          "UNKNOWN_OUTCOME_EVIDENCE_STALE",
          "The acknowledged warning does not describe the evidence Core holds now; re-read the Claim and confirm the current warning",
          {
            acknowledgedWarningDigest: input.acknowledgedWarningDigest,
            currentAcknowledgementDigest: warning.acknowledgementDigest,
          },
        );
      }
    }

    const reasonCode =
      disposition === "release" ? "operator-forced-release" : "operator-dead-letter";

    // The audit event is written before the disposition is applied, so a crash
    // between the two leaves evidence that the decision was taken rather than a
    // silently applied change.
    this.#audit({
      eventType: "console.claim.unknown-outcome.disposition",
      result: "succeeded",
      operationId: input.operationId,
      instanceId: input.instanceId,
      actor: input.actor,
      configRevision: instance.desiredConfigRevision,
      moduleGenerationId: claim.identity.moduleGenerationId,
      details: {
        disposition,
        forced: disposition === "release",
        claimToken: claim.identity.claimToken,
        moduleJobId: claim.identity.moduleJobId,
        runId: claim.identity.runId,
        attempt: claim.identity.attempt,
        moduleId: claim.moduleId,
        evidenceDigest: claim.evidenceDigest,
        evidence: claim.evidence as unknown as JsonValue,
        ...(disposition === "release"
          ? {
              warning:
                "A forced release can repeat an external effect that already completed, because Core cannot prove it did not happen",
            }
          : {}),
      },
    });

    const outcome = await store.applyDisposition({
      identity: claim.identity,
      disposition,
      reasonCode,
    });
    return deepFreeze({
      instanceId: input.instanceId,
      claimToken: claim.identity.claimToken,
      disposition,
      outcome,
      evidenceDigest: claim.evidenceDigest,
    }) as UnknownOutcomeDispositionResult;
  }

  async #prepare(submission: TopologySubmission): Promise<{
    loaded: LoadedInstanceConfig<DollyInstanceConfig>;
    obligations: Awaited<ReturnType<InstanceObligationSource["readObligations"]>>;
  }> {
    if (!REVISION_PATTERN.test(submission.expectedRevision)) {
      throw new ConsoleOperationError(
        "ADMIN_REQUEST_INVALID",
        "expectedRevision must be a lowercase sha256 digest",
      );
    }
    const loaded = this.#loadConfiguration(submission.instanceId);
    if (loaded.configRevision !== submission.expectedRevision) {
      throw new ConsoleOperationError(
        "CONFIG_REVISION_CONFLICT",
        "The stored configuration revision is no longer the expected revision; re-read and re-plan before submitting",
        {
          expectedRevision: submission.expectedRevision,
          currentRevision: loaded.configRevision,
        },
      );
    }
    const obligations = await this.#options.obligations.readObligations(submission.instanceId);
    return { loaded, obligations };
  }

  #loadConfiguration(instanceId: string): LoadedInstanceConfig<DollyInstanceConfig> {
    const instance = this.#requireRegistered(instanceId);
    let loaded: LoadedInstanceConfig<DollyInstanceConfig>;
    try {
      loaded = this.#options.configStore.inspect(instance.configPath);
    } catch (error) {
      throw asOperationError(error);
    }
    if (loaded.instanceId !== instanceId) {
      // Section 10.1: an operation binds to one exact instance identifier, and
      // a path, port, or display name is never an identity.
      throw new ConsoleOperationError(
        "ADMIN_INSTANCE_MISMATCH",
        "The registered configuration no longer carries the requested instanceId",
        { requested: instanceId, found: loaded.instanceId },
      );
    }
    return loaded;
  }

  #requireRegistered(instanceId: string): RegisteredInstance {
    if (typeof instanceId !== "string" || !INSTANCE_ID_PATTERN.test(instanceId)) {
      throw new ConsoleOperationError(
        "ADMIN_REQUEST_INVALID",
        "instanceId must be a lowercase UUIDv4",
      );
    }
    const instance = this.#options.lifecycle
      .listRegisteredInstances()
      .find((candidate) => candidate.instanceId === instanceId);
    if (!instance) {
      throw new ConsoleOperationError(
        "ADMIN_INSTANCE_NOT_FOUND",
        "No instance with this identifier is registered on this machine",
        { instanceId },
      );
    }
    return instance;
  }

  async #effectiveRevision(instanceId: string): Promise<string | null> {
    const source = this.#options.effectiveRevision;
    if (!source) return null;
    return source(instanceId);
  }

  #audit(input: Parameters<typeof buildConsoleAuditEvent>[1]): void {
    const sink = this.#options.audit;
    if (!sink) return;
    sink(buildConsoleAuditEvent(this.#now, input));
  }
}

function assertOperationId(value: string): void {
  if (typeof value !== "string" || !OPERATION_ID_PATTERN.test(value)) {
    throw new ConsoleOperationError(
      "ADMIN_REQUEST_INVALID",
      "operationId is not a valid identifier",
    );
  }
}

function errorCode(error: unknown): string {
  if (error instanceof ConsoleOperationError) return error.code;
  const candidate = (error as { code?: unknown } | null)?.code;
  return typeof candidate === "string" ? candidate : "UNKNOWN";
}

function asOperationError(error: unknown): ConsoleOperationError {
  if (error instanceof ConsoleOperationError) return error;
  if (error instanceof InstanceConfigError) {
    return new ConsoleOperationError(
      error.code === "CONFIG_REVISION_CONFLICT"
        ? "CONFIG_REVISION_CONFLICT"
        : error.code === "CONFIG_DOCUMENT_INVALID"
          ? "RUNTIME_CONFIG_INVALID"
          : "ADMIN_OPERATION_FAILED",
      error.message,
      { cause: error.code },
    );
  }
  return new ConsoleOperationError(
    "ADMIN_OPERATION_FAILED",
    error instanceof Error ? error.message : "The operation failed",
    { cause: errorCode(error) },
  );
}
