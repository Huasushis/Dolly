/**
 * The one topology pipeline both editing interfaces use.
 *
 * `instance-topology.md` Section 5.1 fixes the order — authenticate, build a
 * complete candidate, validate, plan, confirm, compare-and-swap, audit, apply —
 * and forbids any interface from skipping, reordering, or privately extending
 * it. Sections 5.4 and 5.5 then make equivalence testable: the same logical
 * change submitted through the command-line interface (CLI) and through the
 * graphical editor must produce identical canonical JavaScript Object Notation
 * (JSON) bytes and therefore the same revision.
 *
 * This module owns the two halves that make that true:
 *
 * - `buildTopologyCandidate` turns a proposal into one complete
 *   `dolly.instance/9` document with a deterministic element order, so neither
 *   interface can introduce an ordering difference; and
 * - `computeTopologyPlan` derives every entry's classification from the change
 *   and the current runtime obligations alone, never from operator intent or
 *   from which interface asked.
 *
 * Validation itself is delegated to `validateDollyInstanceConfig`, the single
 * whole-document validator Section 6.8 requires.
 */

import { canonicalJsonDigest, cloneJson, deepFreeze, type JsonValue } from "../../core/canonical-json.js";
import {
  RuntimeConfigError,
  validateDollyInstanceConfig,
  type DollyInstanceConfig,
  type DollyModuleConfig,
} from "../../core/runtime-config.js";
import {
  pageObligationTotals,
  type InstanceObligations,
  type ModuleRuntimeObligation,
} from "./instance-obligations.js";
import { ConsoleOperationError, type ConsoleOperationErrorCode } from "./operation-catalog.js";

export type TopologyStartPosition =
  | "from-head"
  | "from-now"
  | { readonly checkpoint: string };

export interface TopologyStartPositionChoice {
  readonly moduleId: string;
  readonly pageId: string;
  readonly start: TopologyStartPosition;
}

export type ObligationDisposition = "drain" | "dead-letter";

export interface TopologyDispositionChoice {
  readonly pageId: string;
  /** Omitted when the disposition covers every consumer of a removed Page. */
  readonly moduleId?: string;
  readonly disposition: ObligationDisposition;
}

export interface ModulePrivateStorageDecision {
  readonly moduleId: string;
  readonly decision: "retain" | "delete";
}

export interface TopologyProposal {
  readonly pages: readonly JsonValue[];
  readonly modules: readonly JsonValue[];
}

export interface TopologySubmission {
  readonly instanceId: string;
  readonly expectedRevision: string;
  readonly proposal: TopologyProposal;
  readonly startPositions?: readonly TopologyStartPositionChoice[];
  readonly dispositions?: readonly TopologyDispositionChoice[];
  readonly modulePrivateStorage?: readonly ModulePrivateStorageDecision[];
}

export type TopologyChangeClassification =
  | "informational"
  | "hot"
  | "generation-restart"
  | "breaking"
  | "rejected";

export interface TopologyPlanEntry {
  readonly element: string;
  readonly operation: string;
  readonly classification: TopologyChangeClassification;
  readonly detail: string;
  readonly obligations?: Readonly<Record<string, number>>;
  readonly disposition?: ObligationDisposition;
  readonly errorCode?: ConsoleOperationErrorCode;
}

export interface TopologyChangePlan {
  readonly schemaVersion: "dolly.topology-plan/1";
  readonly instanceId: string;
  readonly expectedRevision: string;
  readonly candidateRevision: string;
  readonly evidenceSource: InstanceObligations["evidenceSource"];
  readonly entries: readonly TopologyPlanEntry[];
  readonly requiresConfirmation: boolean;
  readonly rejected: boolean;
  /** Digest of every field above, so a confirmation names one exact plan. */
  readonly planDigest: string;
}

const ISOLATION_STRENGTH: Readonly<Record<string, number>> = Object.freeze({
  none: 0,
  process: 1,
  sandbox: 2,
});

function invalid(message: string, details: Record<string, unknown> = {}): ConsoleOperationError {
  return new ConsoleOperationError("ADMIN_REQUEST_INVALID", message, details);
}

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sortedStrings(value: JsonValue | undefined): JsonValue | undefined {
  if (!Array.isArray(value)) return value;
  if (!value.every((entry) => typeof entry === "string")) return value;
  // Duplicates are preserved deliberately: `instance-topology.md` Section 6.4
  // requires a repeated Page in one list to be rejected by the validator, not
  // silently deduplicated by a normalizer.
  return [...(value as string[])].sort();
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function startPositionKey(moduleId: string, pageId: string): string {
  return `${moduleId}\0${pageId}`;
}

function describeStart(start: TopologyStartPosition): string {
  return typeof start === "string" ? start : `checkpoint:${start.checkpoint}`;
}

function assertStartPosition(value: unknown, label: string): TopologyStartPosition {
  if (value === "from-head" || value === "from-now") return value;
  if (isPlainObject(value) && typeof value.checkpoint === "string" && value.checkpoint.length > 0) {
    return { checkpoint: value.checkpoint };
  }
  throw invalid(`${label} must be "from-head", "from-now", or {"checkpoint": "..."}`);
}

/** Parses the untrusted proposal shape without duplicating field validation. */
export function parseTopologyProposal(value: unknown): TopologyProposal {
  if (!isPlainObject(value)) throw invalid("proposal must be an object");
  const unexpected = Object.keys(value).filter((key) => key !== "pages" && key !== "modules");
  if (unexpected.length > 0) {
    throw invalid(`proposal contains unknown fields: ${unexpected.sort().join(", ")}`);
  }
  if (!Array.isArray(value.pages)) throw invalid("proposal.pages must be an array");
  if (!Array.isArray(value.modules)) throw invalid("proposal.modules must be an array");
  for (const [index, module] of value.modules.entries()) {
    if (isPlainObject(module) && "subscriptionStart" in module) {
      throw invalid(
        `proposal.modules[${index}] must not carry subscriptionStart; every new subscription supplies an explicit start position through startPositions`,
      );
    }
  }
  return deepFreeze({
    pages: cloneJson(value.pages as JsonValue[]),
    modules: cloneJson(value.modules as JsonValue[]),
  }) as TopologyProposal;
}

export function parseStartPositions(value: unknown): readonly TopologyStartPositionChoice[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid("startPositions must be an array");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) throw invalid(`startPositions[${index}] must be an object`);
    const moduleId = stringField(entry.moduleId);
    const pageId = stringField(entry.pageId);
    if (moduleId === undefined || pageId === undefined) {
      throw invalid(`startPositions[${index}] requires moduleId and pageId`);
    }
    const key = startPositionKey(moduleId, pageId);
    if (seen.has(key)) {
      throw invalid(`startPositions names ${moduleId}/${pageId} more than once`);
    }
    seen.add(key);
    return {
      moduleId,
      pageId,
      start: assertStartPosition(entry.start, `startPositions[${index}].start`),
    };
  });
}

export function parseDispositions(value: unknown): readonly TopologyDispositionChoice[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid("dispositions must be an array");
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) throw invalid(`dispositions[${index}] must be an object`);
    const pageId = stringField(entry.pageId);
    const disposition = entry.disposition;
    if (pageId === undefined) throw invalid(`dispositions[${index}] requires pageId`);
    if (disposition !== "drain" && disposition !== "dead-letter") {
      throw invalid(
        `dispositions[${index}].disposition must be "drain" or "dead-letter"; discarding obligations without a record does not exist`,
      );
    }
    const moduleId = stringField(entry.moduleId);
    return moduleId === undefined
      ? { pageId, disposition }
      : { pageId, moduleId, disposition };
  });
}

export function parseModulePrivateStorage(
  value: unknown,
): readonly ModulePrivateStorageDecision[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid("modulePrivateStorage must be an array");
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) throw invalid(`modulePrivateStorage[${index}] must be an object`);
    const moduleId = stringField(entry.moduleId);
    if (moduleId === undefined) throw invalid(`modulePrivateStorage[${index}] requires moduleId`);
    if (entry.decision !== "retain" && entry.decision !== "delete") {
      throw invalid(`modulePrivateStorage[${index}].decision must be "retain" or "delete"`);
    }
    return { moduleId, decision: entry.decision };
  });
}

export interface TopologyCandidate {
  readonly document: DollyInstanceConfig;
  readonly revision: string;
  /** Every input connection this candidate creates that did not exist before. */
  readonly newSubscriptions: readonly { readonly moduleId: string; readonly pageId: string }[];
}

/**
 * Builds one complete candidate document from the current revision and a
 * proposal. Element order is fixed here — Pages by `pageId`, Modules by
 * `moduleId`, and every identifier list sorted — so two interfaces expressing
 * the same logical change cannot produce different bytes.
 */
export function buildTopologyCandidate(
  current: Readonly<DollyInstanceConfig>,
  submission: Pick<TopologySubmission, "proposal" | "startPositions">,
  obligations: InstanceObligations,
): TopologyCandidate {
  const startChoices = new Map<string, TopologyStartPosition>(
    (submission.startPositions ?? []).map((choice) => [
      startPositionKey(choice.moduleId, choice.pageId),
      choice.start,
    ]),
  );
  const currentModules = new Map(current.modules.map((module) => [module.moduleId, module]));

  const pages = [...submission.proposal.pages].sort(comparePagesById);
  const proposalModules = [...submission.proposal.modules].sort(compareModulesById);

  const newSubscriptions: { moduleId: string; pageId: string }[] = [];
  const modules = proposalModules.map((raw) => {
    if (!isPlainObject(raw)) return raw;
    const moduleId = stringField(raw.moduleId);
    const inputs = sortedStrings(raw.inputPageIds);
    const normalized: Record<string, JsonValue> = {
      ...raw,
      ...(inputs === undefined ? {} : { inputPageIds: inputs }),
      ...(sortedStrings(raw.outputPageIds) === undefined
        ? {}
        : { outputPageIds: sortedStrings(raw.outputPageIds)! }),
      ...(sortedStrings(raw.permissionPolicyIds) === undefined
        ? {}
        : { permissionPolicyIds: sortedStrings(raw.permissionPolicyIds)! }),
    };
    if (moduleId === undefined || !Array.isArray(inputs)) {
      // The whole-document validator produces the exact error for this shape.
      return normalized as JsonValue;
    }
    const existing = currentModules.get(moduleId);
    const previousInputs = new Set(existing?.inputPageIds ?? []);
    const inputPageIds = inputs as string[];
    const added = inputPageIds.filter((pageId) => !previousInputs.has(pageId));
    for (const pageId of added) newSubscriptions.push({ moduleId, pageId });
    normalized.subscriptionStart = resolveSubscriptionStart({
      moduleId,
      inputPageIds,
      addedPageIds: added,
      retainedPageIds: inputPageIds.filter((pageId) => previousInputs.has(pageId)),
      existing,
      startChoices,
      obligations,
    });
    return normalized as JsonValue;
  });

  let document: DollyInstanceConfig;
  try {
    document = validateDollyInstanceConfig({
      ...(cloneJson(current as unknown as JsonValue) as Record<string, JsonValue>),
      pages: pages as JsonValue[],
      modules: modules as JsonValue[],
    });
  } catch (error) {
    if (error instanceof RuntimeConfigError) {
      throw new ConsoleOperationError(error.code, error.message);
    }
    throw error;
  }

  return deepFreeze({
    document,
    revision: canonicalJsonDigest(document),
    newSubscriptions: newSubscriptions.sort((left, right) =>
      left.moduleId === right.moduleId
        ? compareStrings(left.pageId, right.pageId)
        : compareStrings(left.moduleId, right.moduleId),
    ),
  }) as TopologyCandidate;
}

function resolveSubscriptionStart(input: {
  readonly moduleId: string;
  readonly inputPageIds: readonly string[];
  readonly addedPageIds: readonly string[];
  readonly retainedPageIds: readonly string[];
  readonly existing: DollyModuleConfig | undefined;
  readonly startChoices: ReadonlyMap<string, TopologyStartPosition>;
  readonly obligations: InstanceObligations;
}): JsonValue {
  const { moduleId, addedPageIds, retainedPageIds, existing, startChoices } = input;

  if (input.inputPageIds.length === 0) {
    // A Module with no input connections has no subscription, so no start
    // position exists to choose. The schema still requires the field; keeping
    // the stored value, or `from-now` for a new Module, sets a field that
    // governs nothing rather than defaulting a real subscription.
    return existing?.subscriptionStart ?? "from-now";
  }

  const chosen: { pageId: string; start: TopologyStartPosition }[] = [];
  const missing: string[] = [];
  for (const pageId of addedPageIds) {
    const start = startChoices.get(startPositionKey(moduleId, pageId));
    if (start === undefined) missing.push(pageId);
    else chosen.push({ pageId, start });
  }
  if (missing.length > 0) {
    throw new ConsoleOperationError(
      "TOPOLOGY_START_POSITION_REQUIRED",
      `Module ${moduleId} creates ${missing.length} subscription(s) with no explicit start position: ${missing.sort().join(", ")}`,
      { moduleId, pageIds: [...missing].sort() },
    );
  }

  const resolved: string[] = [];
  for (const entry of chosen) {
    if (typeof entry.start !== "string") {
      const frontier = input.obligations.pages.find((page) => page.pageId === entry.pageId);
      if (!frontier || !frontier.retainedDeliveryIds.includes(entry.start.checkpoint)) {
        throw new ConsoleOperationError(
          "TOPOLOGY_CHECKPOINT_UNAVAILABLE",
          `Checkpoint ${entry.start.checkpoint} is older than the retention frontier of Page ${entry.pageId}`,
          { moduleId, pageId: entry.pageId, checkpoint: entry.start.checkpoint },
        );
      }
      throw new ConsoleOperationError(
        "TOPOLOGY_START_POSITION_UNSUPPORTED",
        `Instance schema dolly.instance/9 carries one subscriptionStart per Module and cannot express the checkpoint start requested for ${moduleId}/${entry.pageId}`,
        { moduleId, pageId: entry.pageId },
      );
    }
    resolved.push(entry.start);
  }

  const distinct = [...new Set(resolved)];
  const stored = existing?.subscriptionStart;
  if (retainedPageIds.length > 0 && stored !== undefined) {
    const conflicting = distinct.filter((value) => value !== stored);
    if (conflicting.length > 0) {
      throw new ConsoleOperationError(
        "TOPOLOGY_START_POSITION_CONFLICT",
        `Module ${moduleId} keeps subscriptions started ${stored}; schema dolly.instance/9 cannot also record ${conflicting.sort().join(", ")} for its new connections`,
        { moduleId, stored, requested: conflicting.sort() },
      );
    }
    return stored;
  }
  if (distinct.length > 1) {
    throw new ConsoleOperationError(
      "TOPOLOGY_START_POSITION_CONFLICT",
      `Module ${moduleId} requested several different start positions (${distinct.sort().join(", ")}) but schema dolly.instance/9 records one per Module`,
      { moduleId, requested: distinct.sort() },
    );
  }
  return distinct[0] ?? stored ?? "from-now";
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePagesById(left: JsonValue, right: JsonValue): number {
  const leftId = isPlainObject(left) ? stringField(left.pageId) : undefined;
  const rightId = isPlainObject(right) ? stringField(right.pageId) : undefined;
  if (leftId === undefined || rightId === undefined) return 0;
  return compareStrings(leftId, rightId);
}

function compareModulesById(left: JsonValue, right: JsonValue): number {
  const leftId = isPlainObject(left) ? stringField(left.moduleId) : undefined;
  const rightId = isPlainObject(right) ? stringField(right.moduleId) : undefined;
  if (leftId === undefined || rightId === undefined) return 0;
  return compareStrings(leftId, rightId);
}

export interface TopologyPlanInput {
  readonly current: Readonly<DollyInstanceConfig>;
  readonly candidate: TopologyCandidate;
  readonly obligations: InstanceObligations;
  readonly expectedRevision: string;
  readonly dispositions: readonly TopologyDispositionChoice[];
  readonly modulePrivateStorage: readonly ModulePrivateStorageDecision[];
}

/**
 * Compares the candidate with the currently effective revision and the current
 * runtime obligations. Every classification follows from those two inputs
 * alone, so the same change against the same state always receives the same
 * classification through either interface.
 */
export function computeTopologyPlan(input: TopologyPlanInput): TopologyChangePlan {
  const { current, candidate, obligations } = input;
  const entries: TopologyPlanEntry[] = [];

  const currentPages = new Set(current.pages.map((page) => page.pageId));
  const candidatePages = new Set(candidate.document.pages.map((page) => page.pageId));
  const currentModules = new Map(current.modules.map((module) => [module.moduleId, module]));
  const candidateModules = new Map(
    candidate.document.modules.map((module) => [module.moduleId, module]),
  );
  const moduleObligations = new Map(
    obligations.modules.map((module) => [module.moduleId, module]),
  );
  const contractOwned = new Map(
    obligations.contractOwnedModules.map((entry) => [entry.moduleId, entry]),
  );
  const storageDecisions = new Map(
    input.modulePrivateStorage.map((entry) => [entry.moduleId, entry.decision]),
  );

  const dispositionFor = (pageId: string, moduleId?: string): ObligationDisposition | undefined =>
    input.dispositions.find(
      (entry) =>
        entry.pageId === pageId &&
        (entry.moduleId === undefined || entry.moduleId === moduleId),
    )?.disposition;

  const connectedInCandidate = (pageId: string): boolean =>
    candidate.document.modules.some(
      (module) => module.inputPageIds.includes(pageId) || module.outputPageIds.includes(pageId),
    );

  for (const pageId of [...candidatePages].sort()) {
    if (currentPages.has(pageId)) continue;
    entries.push({
      element: `page:${pageId}`,
      operation: "page.add",
      classification: "hot",
      detail: "A new Page starts empty and has no consumers until a connection is added",
    });
    if (!connectedInCandidate(pageId)) {
      entries.push({
        element: `page:${pageId}`,
        operation: "page.isolated",
        classification: "informational",
        detail: "The Page has no connection in this revision, which is a valid intermediate state",
      });
    }
  }

  for (const pageId of [...currentPages].sort()) {
    if (candidatePages.has(pageId)) continue;
    entries.push(planPageRemoval(pageId, obligations, dispositionFor(pageId)));
  }

  for (const moduleId of [...candidateModules.keys()].sort()) {
    const proposed = candidateModules.get(moduleId)!;
    const existing = currentModules.get(moduleId);
    if (!existing) {
      entries.push({
        element: `module:${moduleId}`,
        operation: "module.add",
        classification: obligations.moduleExecutionEnabled ? "generation-restart" : "rejected",
        detail: obligations.moduleExecutionEnabled
          ? "The new Module reaches READY through the normal lifecycle"
          : "Module execution is disabled in this build, so no Module generation can start",
        ...(obligations.moduleExecutionEnabled
          ? {}
          : { errorCode: "TOPOLOGY_CAPABILITY_DISABLED" as const }),
      });
      for (const pageId of proposed.inputPageIds) {
        entries.push(planInputConnectionAdded(moduleId, pageId, proposed, obligations));
      }
      if (proposed.inputPageIds.some((pageId) => proposed.outputPageIds.includes(pageId))) {
        entries.push(selfConnectionFinding(moduleId));
      }
      continue;
    }
    entries.push(
      ...planExistingModule({
        existing,
        proposed,
        obligations,
        moduleObligation: moduleObligations.get(moduleId),
        contractOwner: contractOwned.get(moduleId),
        dispositionFor,
      }),
    );
  }

  for (const moduleId of [...currentModules.keys()].sort()) {
    if (candidateModules.has(moduleId)) continue;
    entries.push(
      ...planModuleRemoval({
        existing: currentModules.get(moduleId)!,
        moduleObligation: moduleObligations.get(moduleId),
        obligations,
        storageDecision: storageDecisions.get(moduleId),
        dispositionFor,
      }),
    );
  }

  const rejected = entries.some((entry) => entry.classification === "rejected");
  const requiresConfirmation = entries.some((entry) => entry.classification === "breaking");
  const body = {
    schemaVersion: "dolly.topology-plan/1" as const,
    instanceId: current.instanceId,
    expectedRevision: input.expectedRevision,
    candidateRevision: candidate.revision,
    evidenceSource: obligations.evidenceSource,
    entries,
    requiresConfirmation,
    rejected,
  };
  return deepFreeze({
    ...body,
    planDigest: canonicalJsonDigest(body as unknown as JsonValue),
  }) as TopologyChangePlan;
}

function planPageRemoval(
  pageId: string,
  obligations: InstanceObligations,
  disposition: ObligationDisposition | undefined,
): TopologyPlanEntry {
  const totals = pageObligationTotals(obligations, pageId);
  const unknownOutcomeHolders = obligations.modules.filter(
    (module) =>
      module.claimedPageIds.includes(pageId) && module.unknownOutcomeClaimTokens.length > 0,
  );
  const claimHolders = obligations.modules.filter((module) =>
    module.claimedPageIds.includes(pageId),
  );
  const counts = {
    pendingDeliveries: totals.pendingDeliveries,
    claimedDeliveries: totals.claimedDeliveries,
    deadLetterRecords: totals.deadLetterRecords,
    activeClaims: claimHolders.reduce(
      (total, module) => total + module.activeClaimTokens.length,
      0,
    ),
  };

  if (unknownOutcomeHolders.length > 0) {
    return {
      element: `page:${pageId}`,
      operation: "page.remove",
      classification: "rejected",
      detail: `A Claim preserved as an unknown outcome covers a Delivery from this Page; resolve it through the audited operator flow first (${unknownOutcomeHolders
        .map((module) => module.moduleId)
        .sort()
        .join(", ")})`,
      obligations: counts,
      errorCode: "TOPOLOGY_UNKNOWN_OUTCOME_PRESENT",
    };
  }
  if (counts.activeClaims > 0) {
    return {
      element: `page:${pageId}`,
      operation: "page.remove",
      classification: "rejected",
      detail: `${counts.activeClaims} active Claim(s) cover Deliveries from this Page`,
      obligations: counts,
      errorCode: "TOPOLOGY_PAGE_HAS_OBLIGATIONS",
    };
  }
  const outstanding =
    counts.pendingDeliveries + counts.claimedDeliveries + counts.deadLetterRecords;
  if (outstanding === 0) {
    return {
      element: `page:${pageId}`,
      operation: "page.remove",
      classification: "hot",
      detail: "The Page carries no pending Delivery, Claim, or dead-letter record",
      obligations: counts,
    };
  }
  if (disposition === undefined) {
    return {
      element: `page:${pageId}`,
      operation: "page.remove",
      classification: "rejected",
      detail: `Removing this Page retires ${counts.pendingDeliveries} pending Delivery(s) and ${counts.deadLetterRecords} dead-letter record(s); choose drain or dead-letter first`,
      obligations: counts,
      errorCode: "TOPOLOGY_PAGE_HAS_OBLIGATIONS",
    };
  }
  return {
    element: `page:${pageId}`,
    operation: "page.remove",
    classification: "breaking",
    detail: `Retires ${counts.pendingDeliveries} pending Delivery(s) under the ${disposition} disposition`,
    obligations: counts,
    disposition,
  };
}

function planInputConnectionAdded(
  moduleId: string,
  pageId: string,
  proposed: DollyModuleConfig,
  obligations: InstanceObligations,
): TopologyPlanEntry {
  const frontier = obligations.pages.find((page) => page.pageId === pageId);
  const replaysHistory = proposed.subscriptionStart === "from-head";
  return {
    element: `connection:${moduleId}<-${pageId}`,
    operation: "connection.addInput",
    classification: replaysHistory ? "breaking" : "hot",
    detail: replaysHistory
      ? `The subscription starts from-head and makes ${frontier?.replayableDeliveries ?? 0} retained Delivery(s) immediately pending`
      : "The subscription starts from-now and replays no history",
    obligations: {
      immediatelyPendingDeliveries: replaysHistory ? (frontier?.replayableDeliveries ?? 0) : 0,
      immediatelyPendingBytes: replaysHistory ? (frontier?.replayableBytes ?? 0) : 0,
    },
  };
}

function planExistingModule(input: {
  readonly existing: DollyModuleConfig;
  readonly proposed: DollyModuleConfig;
  readonly obligations: InstanceObligations;
  readonly moduleObligation: ModuleRuntimeObligation | undefined;
  readonly contractOwner: { readonly owningContract: string; readonly operation: string } | undefined;
  readonly dispositionFor: (pageId: string, moduleId?: string) => ObligationDisposition | undefined;
}): readonly TopologyPlanEntry[] {
  const { existing, proposed, obligations, moduleObligation, contractOwner } = input;
  const moduleId = existing.moduleId;
  const entries: TopologyPlanEntry[] = [];

  const addedInputs = proposed.inputPageIds.filter((page) => !existing.inputPageIds.includes(page));
  const removedInputs = existing.inputPageIds.filter(
    (page) => !proposed.inputPageIds.includes(page),
  );
  const addedOutputs = proposed.outputPageIds.filter(
    (page) => !existing.outputPageIds.includes(page),
  );
  const removedOutputs = existing.outputPageIds.filter(
    (page) => !proposed.outputPageIds.includes(page),
  );
  const connectionsChanged =
    addedInputs.length + removedInputs.length + addedOutputs.length + removedOutputs.length > 0;

  if (connectionsChanged && contractOwner) {
    entries.push({
      element: `module:${moduleId}`,
      operation: "connection.edit",
      classification: "rejected",
      detail: `The Page set of this Module is bound by ${contractOwner.owningContract}; use ${contractOwner.operation} instead`,
      errorCode: "TOPOLOGY_OWNED_BY_ANOTHER_CONTRACT",
    });
    return entries;
  }

  for (const pageId of addedInputs) {
    entries.push(planInputConnectionAdded(moduleId, pageId, proposed, obligations));
  }
  for (const pageId of removedInputs) {
    entries.push(
      planInputConnectionRemoved(moduleId, pageId, obligations, input.dispositionFor(pageId, moduleId)),
    );
  }
  for (const pageId of addedOutputs) {
    entries.push({
      element: `connection:${moduleId}->${pageId}`,
      operation: "connection.addOutput",
      classification: "hot",
      detail:
        "The new output Page takes effect for the next Module job; an in-flight job keeps the output set it was created with",
    });
  }
  for (const pageId of removedOutputs) {
    entries.push({
      element: `connection:${moduleId}->${pageId}`,
      operation: "connection.removeOutput",
      classification: "hot",
      detail: "Deliveries already appended remain and are not retracted",
    });
  }
  if (
    proposed.inputPageIds.some((pageId) => proposed.outputPageIds.includes(pageId)) &&
    !existing.inputPageIds.some((pageId) => existing.outputPageIds.includes(pageId))
  ) {
    entries.push(selfConnectionFinding(moduleId));
  }

  const restartFields = describeRestartFields(existing, proposed);
  if (restartFields.length > 0) {
    const broadens = weakensBoundary(existing, proposed);
    entries.push({
      element: `module:${moduleId}`,
      operation: "module.change",
      classification: obligations.moduleExecutionEnabled
        ? broadens
          ? "breaking"
          : "generation-restart"
        : "rejected",
      detail: obligations.moduleExecutionEnabled
        ? `${restartFields.join(", ")} changed, which stops the current generation and starts a new one${
            broadens ? "; the Module gains authority it did not have" : ""
          }`
        : `${restartFields.join(", ")} changed, but Module execution is disabled in this build`,
      ...(obligations.moduleExecutionEnabled
        ? {}
        : { errorCode: "TOPOLOGY_CAPABILITY_DISABLED" as const }),
    });
    if (
      obligations.moduleExecutionEnabled &&
      moduleObligation &&
      moduleObligation.unknownOutcomeClaimTokens.length > 0
    ) {
      entries.push({
        element: `module:${moduleId}`,
        operation: "module.change",
        classification: "rejected",
        detail:
          "The Module holds a Claim preserved as an unknown outcome, which a restart must not launder",
        errorCode: "TOPOLOGY_UNKNOWN_OUTCOME_PRESENT",
      });
    } else if (
      obligations.moduleExecutionEnabled &&
      moduleObligation &&
      !moduleObligation.generationTerminationProven
    ) {
      entries.push({
        element: `module:${moduleId}`,
        operation: "module.change",
        classification: "rejected",
        detail: "The current Module generation is not proven terminated",
        errorCode: "TOPOLOGY_MODULE_BUSY",
      });
    }
  }
  return entries;
}

/**
 * Section 6.3: a newly created self-connection is reported so an operator is
 * not surprised, and it is never refused. The runtime does not filter a
 * Module's own Blocks out of its input.
 */
function selfConnectionFinding(moduleId: string): TopologyPlanEntry {
  return {
    element: `module:${moduleId}`,
    operation: "connection.selfConnected",
    classification: "informational",
    detail:
      "An output Page of this Module is also one of its input Pages; the Module receives the Blocks it produced",
  };
}

function planInputConnectionRemoved(
  moduleId: string,
  pageId: string,
  obligations: InstanceObligations,
  disposition: ObligationDisposition | undefined,
): TopologyPlanEntry {
  const module = obligations.modules.find((entry) => entry.moduleId === moduleId);
  const consumer = obligations.pageConsumers.find(
    (entry) => entry.pageId === pageId && entry.consumerId === module?.consumerId,
  );
  const counts = {
    pendingDeliveries: consumer?.pendingDeliveries ?? 0,
    claimedDeliveries: consumer?.claimedDeliveries ?? 0,
    deadLetterRecords: consumer?.deadLetterRecords ?? 0,
  };
  const element = `connection:${moduleId}<-${pageId}`;
  if (module && module.claimedPageIds.includes(pageId)) {
    const unknown = module.unknownOutcomeClaimTokens.length > 0;
    return {
      element,
      operation: "connection.removeInput",
      classification: "rejected",
      detail: unknown
        ? "The Module holds a Claim preserved as an unknown outcome covering a Delivery from this Page"
        : "The Module holds an active Claim covering a Delivery from this Page",
      obligations: counts,
      errorCode: unknown ? "TOPOLOGY_UNKNOWN_OUTCOME_PRESENT" : "TOPOLOGY_MODULE_BUSY",
    };
  }
  const outstanding = counts.pendingDeliveries + counts.deadLetterRecords;
  if (outstanding > 0 && disposition === undefined) {
    return {
      element,
      operation: "connection.removeInput",
      classification: "rejected",
      detail: `Removing this consumer retires ${counts.pendingDeliveries} pending Delivery(s); choose drain or dead-letter`,
      obligations: counts,
      errorCode: "TOPOLOGY_DISPOSITION_REQUIRED",
    };
  }
  return {
    element,
    operation: "connection.removeInput",
    classification: "breaking",
    detail:
      "Consumer removal retires this subscription; re-adding it later creates a new subscription that needs a fresh explicit start position",
    obligations: counts,
    ...(disposition === undefined ? {} : { disposition }),
  };
}

function planModuleRemoval(input: {
  readonly existing: DollyModuleConfig;
  readonly moduleObligation: ModuleRuntimeObligation | undefined;
  readonly obligations: InstanceObligations;
  readonly storageDecision: "retain" | "delete" | undefined;
  readonly dispositionFor: (pageId: string, moduleId?: string) => ObligationDisposition | undefined;
}): readonly TopologyPlanEntry[] {
  const moduleId = input.existing.moduleId;
  const element = `module:${moduleId}`;
  const runtime = input.moduleObligation;

  if (runtime && runtime.unknownOutcomeClaimTokens.length > 0) {
    return [
      {
        element,
        operation: "module.remove",
        classification: "rejected",
        detail: `The Module holds ${runtime.unknownOutcomeClaimTokens.length} Claim(s) preserved as unknown outcomes; removal is not one of the dispositions that flow offers`,
        errorCode: "TOPOLOGY_UNKNOWN_OUTCOME_PRESENT",
      },
    ];
  }
  if (runtime && (runtime.activeClaimTokens.length > 0 || !runtime.generationTerminationProven)) {
    return [
      {
        element,
        operation: "module.remove",
        classification: "rejected",
        detail:
          runtime.activeClaimTokens.length > 0
            ? `The Module holds ${runtime.activeClaimTokens.length} active Claim(s)`
            : "The Module generation is not proven terminated",
        errorCode: "TOPOLOGY_MODULE_BUSY",
      },
    ];
  }
  if (input.storageDecision === undefined) {
    return [
      {
        element,
        operation: "module.remove",
        classification: "rejected",
        detail:
          "Removal must state explicitly whether the Module-private storage namespace keyed by this moduleId is retained or deleted",
        errorCode: "TOPOLOGY_STORAGE_DECISION_REQUIRED",
      },
    ];
  }

  const entries: TopologyPlanEntry[] = [];
  for (const pageId of input.existing.inputPageIds) {
    entries.push(
      planInputConnectionRemoved(moduleId, pageId, input.obligations, input.dispositionFor(pageId, moduleId)),
    );
  }
  entries.push({
    element,
    operation: "module.remove",
    classification: "breaking",
    detail: `Module-private storage for ${moduleId} is ${input.storageDecision === "delete" ? "deleted, which is not reversible" : "retained for a later Module with the same identifier"}`,
  });
  return entries;
}

type RestartSensitiveField =
  | "extensionId"
  | "packageVersion"
  | "moduleKind"
  | "isolation"
  | "configurationReference"
  | "permissionPolicyIds"
  | "activation"
  | "limits"
  | "timeouts";

function describeRestartFields(
  existing: DollyModuleConfig,
  proposed: DollyModuleConfig,
): readonly string[] {
  const changed: string[] = [];
  const compare = (field: RestartSensitiveField): void => {
    if (
      canonicalJsonDigest(existing[field] as JsonValue) !==
      canonicalJsonDigest(proposed[field] as JsonValue)
    ) {
      changed.push(field);
    }
  };
  compare("extensionId");
  compare("packageVersion");
  compare("moduleKind");
  compare("isolation");
  compare("configurationReference");
  compare("permissionPolicyIds");
  compare("activation");
  compare("limits");
  compare("timeouts");
  return changed.sort();
}

function weakensBoundary(existing: DollyModuleConfig, proposed: DollyModuleConfig): boolean {
  const before = ISOLATION_STRENGTH[existing.isolation] ?? 0;
  const after = ISOLATION_STRENGTH[proposed.isolation] ?? 0;
  if (after < before) return true;
  const granted = new Set(existing.permissionPolicyIds);
  return proposed.permissionPolicyIds.some((policyId) => !granted.has(policyId));
}

/** The first entry that blocks a commit, or `undefined` when none does. */
export function firstRejectedEntry(plan: TopologyChangePlan): TopologyPlanEntry | undefined {
  return plan.entries.find((entry) => entry.classification === "rejected");
}
