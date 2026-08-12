import type { ExtensionSessionIdentity } from "../extension-capability.js";
import { FileCoreStateStore } from "../file-core-state-store.js";
import type {
  ModelInvocationContext,
  ModelMediaResolutionRequest,
  ModelMediaResolver,
} from "../model-provider-broker.js";
import {
  createDeliveredModelMediaResolver,
  DeliveredModelMediaResolverError,
} from "./delivered-model-media-resolver.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface FileCoreActiveRunModelMediaResolverOptions {
  /** The exact FileCore state used by Scheduler, submissions, and Media. */
  readonly core: FileCoreStateStore;
  /** Host-derived installed Extension identity; never Extension input. */
  readonly extensionId: string;
  readonly instanceId: string;
  readonly moduleId: string;
  /** Returns the current Host session for this exact persisted process. */
  readonly sessionForProcess: (
    processGenerationId: string,
  ) => ExtensionSessionIdentity | null;
  readonly now: () => string;
}

interface ResolvedActiveRun {
  readonly session: ExtensionSessionIdentity;
  readonly claim: {
    readonly moduleJobId: string;
    readonly runId: string;
    readonly blockGroups: ReturnType<
      FileCoreStateStore["deliveries"]["inspectClaimInput"]
    >["blockGroups"];
  };
  readonly processGenerationId: string;
}

function denied(): DeliveredModelMediaResolverError {
  return new DeliveredModelMediaResolverError(
    "Model Media is not authorized for the active persisted Module Run",
  );
}

function resolveActiveRun(
  options: FileCoreActiveRunModelMediaResolverOptions,
  context: ModelInvocationContext,
): ResolvedActiveRun | null {
  if (
    context.instanceId !== options.instanceId ||
    context.moduleId !== options.moduleId ||
    typeof context.moduleGenerationId !== "string" ||
    typeof context.moduleJobId !== "string" ||
    typeof context.runId !== "string" ||
    context.attempt === undefined ||
    typeof context.sessionId !== "string"
  ) {
    return null;
  }
  const moduleGenerationId = context.moduleGenerationId;
  const moduleJobId = context.moduleJobId;
  const runId = context.runId;
  const attempt = context.attempt;
  const sessionId = context.sessionId;
  const active = options.core.deliveries.listActiveClaims().find(
    (candidate) =>
      candidate.consumerId === options.moduleId &&
      candidate.moduleJobId === moduleJobId &&
      candidate.runId === runId &&
      candidate.attempt === attempt &&
      candidate.moduleGenerationId === moduleGenerationId,
  );
  if (!active) return null;
  const submission = options.core.getModuleSubmissionRecord(runId);
  if (
    !submission ||
    submission.moduleJobId !== active.moduleJobId ||
    submission.claimToken !== active.claimToken ||
    submission.runId !== active.runId ||
    submission.attempt !== active.attempt ||
    submission.moduleGenerationId !== active.moduleGenerationId
  ) {
    return null;
  }
  const process = options.core.getModuleProcessRecord(submission.processGenerationId);
  if (
    !process ||
    process.state !== "running" ||
    process.instanceId !== options.instanceId ||
    process.moduleId !== options.moduleId ||
    process.moduleGenerationId !== moduleGenerationId ||
    process.processGenerationId !== submission.processGenerationId
  ) {
    return null;
  }
  let session: ExtensionSessionIdentity | null;
  try {
    session = options.sessionForProcess(process.processGenerationId);
  } catch {
    return null;
  }
  if (
    !session ||
    session.extensionId !== options.extensionId ||
    session.instanceId !== options.instanceId ||
    session.processGenerationId !== process.processGenerationId ||
    session.sessionId !== sessionId ||
    session.moduleId !== options.moduleId ||
    session.moduleGenerationId !== moduleGenerationId
  ) {
    return null;
  }
  let input: ReturnType<FileCoreStateStore["deliveries"]["inspectClaimInput"]>;
  try {
    input = options.core.deliveries.inspectClaimInput(active);
  } catch {
    return null;
  }
  return {
    session,
    claim: {
      moduleJobId: active.moduleJobId,
      runId: active.runId,
      blockGroups: input.blockGroups,
    },
    processGenerationId: process.processGenerationId,
  };
}

/**
 * Resolves model Media only from the exact active Claim, submission, running
 * process record, and FileCore Media store that Scheduler is currently using.
 *
 * The returned port is Host-only. A Module can submit a delivered immutable
 * Media reference through model-operation/v3, but cannot construct or replace
 * this resolver or any of its persisted authority.
 */
export function createFileCoreActiveRunModelMediaResolver(
  options: FileCoreActiveRunModelMediaResolverOptions,
): ModelMediaResolver {
  if (!(options.core instanceof FileCoreStateStore) || options.core.media === undefined) {
    throw new TypeError("A Media-enabled FileCore state store is required");
  }
  for (const [label, value] of [
    ["extensionId", options.extensionId],
    ["instanceId", options.instanceId],
    ["moduleId", options.moduleId],
  ] as const) {
    if (!ID_PATTERN.test(value)) throw new TypeError(`${label} is not a valid identifier`);
  }
  if (typeof options.now !== "function") throw new TypeError("now must be a function");
  if (typeof options.sessionForProcess !== "function") {
    throw new TypeError("sessionForProcess must be a Host-owned function");
  }
  const core = options.core;
  const resolverPort: ModelMediaResolver = {
    async resolve(
      request: ModelMediaResolutionRequest,
      callOptions: { readonly signal?: AbortSignal },
    ) {
      const initial = resolveActiveRun(options, request.context);
      if (!initial) throw denied();
      const resolver = createDeliveredModelMediaResolver({
        claim: initial.claim,
        session: initial.session,
        source: core.media!,
        isActiveRun: (context) => {
          const current = resolveActiveRun(options, context);
          return current?.processGenerationId === initial.processGenerationId;
        },
        now: options.now,
      });
      return resolver.resolve(request, callOptions);
    },
  };
  return Object.freeze(resolverPort);
}
