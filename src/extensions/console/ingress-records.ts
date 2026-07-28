import { canonicalJsonDigest, deepFreeze } from "../../core/canonical-json.js";
import type { ConsoleExternalMessage } from "./external-message.js";

/**
 * The private ingress message record of `console-extension.md` section 5.2.
 *
 * It is host-owned gateway state, never Block payload. It keeps the mapping
 * from an accepted external message to the Media the upload flow resolved for
 * it, so the frozen snapshot stays pure: rebuilding the proposal from a
 * snapshot performs no lookup and can never observe a later Media state.
 */
export interface ConsoleResolvedMediaOccurrence {
  /**
   * Resolved server-side from the message's upload grant. The client never
   * supplies this value, which is why an echoed Block only ever gives a client
   * back an identifier it could not have invented.
   */
  readonly mediaId: string;
}

export interface ConsoleAcceptedMessage {
  readonly schemaVersion: "dolly.console.accepted-message/1";
  readonly externalMessageId: string;
  readonly sessionId: string;
  /** Monotonic within one session queue; decimal so it stays canonical JSON. */
  readonly acceptanceSequence: string;
  readonly acceptedAt: string;
  readonly message: ConsoleExternalMessage;
  /** One entry per attachment occurrence, in the client's ordering. */
  readonly media: readonly ConsoleResolvedMediaOccurrence[];
  readonly messageDigest: string;
}

export interface ConsoleIngressSnapshot {
  readonly schemaVersion: "dolly.console.ingress-snapshot/1";
  readonly sessionId: string;
  readonly routeAlias: string;
  readonly routeRevision: string;
  readonly limitRevision: string;
  readonly messages: readonly ConsoleAcceptedMessage[];
  readonly hasMoreAtFreeze: boolean;
  readonly snapshotDigest: string;
}

export function acceptedMessageRecord(
  parts: Omit<ConsoleAcceptedMessage, "schemaVersion" | "messageDigest"> & {
    readonly messageDigest: string;
  },
): ConsoleAcceptedMessage {
  const record: ConsoleAcceptedMessage = {
    schemaVersion: "dolly.console.accepted-message/1",
    externalMessageId: parts.externalMessageId,
    sessionId: parts.sessionId,
    acceptanceSequence: parts.acceptanceSequence,
    acceptedAt: parts.acceptedAt,
    message: parts.message,
    media: parts.media.map((occurrence) => ({ mediaId: occurrence.mediaId })),
    messageDigest: parts.messageDigest,
  };
  return deepFreeze(record);
}

/**
 * The snapshot digest covers exactly what a retry must reproduce: the ordered
 * messages, their Media occurrences, the route and limit revision, and whether
 * more work was pending at freeze. It excludes wall-clock values that a later
 * attempt cannot reproduce.
 */
export function ingressSnapshotDigest(
  parts: Omit<ConsoleIngressSnapshot, "schemaVersion" | "snapshotDigest">,
): string {
  return canonicalJsonDigest({
    sessionId: parts.sessionId,
    routeAlias: parts.routeAlias,
    routeRevision: parts.routeRevision,
    limitRevision: parts.limitRevision,
    hasMoreAtFreeze: parts.hasMoreAtFreeze,
    messages: parts.messages.map((accepted) => ({
      externalMessageId: accepted.externalMessageId,
      acceptanceSequence: accepted.acceptanceSequence,
      messageDigest: accepted.messageDigest,
      media: accepted.media.map((occurrence) => occurrence.mediaId),
    })),
  });
}
