import { deepFreeze } from "../../core/canonical-json.js";
import { consoleError } from "./errors.js";
import { measureIngressProposalBytes } from "./ingress-proposal.js";
import {
  ingressSnapshotDigest,
  type ConsoleAcceptedMessage,
  type ConsoleIngressSnapshot,
} from "./ingress-records.js";

export interface ConsoleBatchLimits {
  readonly maxMessagesPerSnapshot: number;
  readonly maxProposalBytes: number;
  readonly maxMediaOccurrencesPerSnapshot: number;
}

export const DEFAULT_BATCH_LIMITS: ConsoleBatchLimits = deepFreeze({
  maxMessagesPerSnapshot: 32,
  maxProposalBytes: 256 * 1024,
  maxMediaOccurrencesPerSnapshot: 64,
});

export interface FreezeIngressSnapshotInput {
  readonly sessionId: string;
  readonly routeAlias: string;
  readonly routeRevision: string;
  readonly limitRevision: string;
  /** Pending messages, already ordered by server acceptance sequence. */
  readonly pending: readonly ConsoleAcceptedMessage[];
  readonly limits?: Partial<ConsoleBatchLimits>;
}

function resolveBatchLimits(input: Partial<ConsoleBatchLimits> | undefined): ConsoleBatchLimits {
  const limits = { ...DEFAULT_BATCH_LIMITS, ...(input ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw consoleError("MESSAGE_INVALID", `Console batch limit ${name} must be positive`);
    }
  }
  return deepFreeze(limits);
}

/**
 * Deterministic largest-prefix batching from `console-extension.md` section 5.3.
 *
 * The batch is the longest prefix of the pending queue, in acceptance order,
 * that fits every limit. It never samples, reorders, or lets a later small
 * message overtake an earlier large one, and it measures the exact canonical
 * proposed-Block bytes rather than an estimate, because the same number has to
 * hold when the proposal is recomposed on a retry.
 *
 * A message that cannot fit an otherwise empty batch is a terminal
 * `CLAIM_ITEM_OVERSIZE` for that message alone. The caller releases only that
 * message and advances the frontier, so one oversized item cannot stall the
 * queue behind it.
 */
export function freezeIngressSnapshot(input: FreezeIngressSnapshotInput): ConsoleIngressSnapshot {
  const limits = resolveBatchLimits(input.limits);
  if (input.pending.length === 0) {
    throw consoleError("MESSAGE_INVALID", "Cannot freeze a snapshot with no pending messages");
  }

  const batch: ConsoleAcceptedMessage[] = [];
  let mediaOccurrences = 0;
  for (const candidate of input.pending) {
    if (batch.length >= limits.maxMessagesPerSnapshot) break;
    if (mediaOccurrences + candidate.media.length > limits.maxMediaOccurrencesPerSnapshot) {
      if (batch.length === 0) {
        throw consoleError(
          "CLAIM_ITEM_OVERSIZE",
          "One message alone exceeds the Media occurrence limit",
          { externalMessageId: candidate.externalMessageId },
        );
      }
      break;
    }
    const trial = [...batch, candidate];
    if (measureIngressProposalBytes(trial) > limits.maxProposalBytes) {
      if (batch.length === 0) {
        throw consoleError(
          "CLAIM_ITEM_OVERSIZE",
          "One message alone exceeds the proposed Block byte limit",
          { externalMessageId: candidate.externalMessageId },
        );
      }
      break;
    }
    batch.push(candidate);
    mediaOccurrences += candidate.media.length;
  }

  const parts = {
    sessionId: input.sessionId,
    routeAlias: input.routeAlias,
    routeRevision: input.routeRevision,
    limitRevision: input.limitRevision,
    messages: batch as readonly ConsoleAcceptedMessage[],
    hasMoreAtFreeze: batch.length < input.pending.length,
  };
  const snapshot: ConsoleIngressSnapshot = {
    schemaVersion: "dolly.console.ingress-snapshot/1",
    ...parts,
    snapshotDigest: ingressSnapshotDigest(parts),
  };
  return deepFreeze(snapshot);
}
