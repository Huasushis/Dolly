import {
  parseBlockContent,
  type BlockContentItem,
} from "../../core/block-content.js";
import type { BlockProposal } from "../../core/block-store.js";
import {
  assertJsonValue,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  type JsonValue,
} from "../../core/canonical-json.js";
import { consoleError } from "./errors.js";
import { MESSAGE_BOUNDARY_SCHEMA } from "./external-message.js";
import type { ConsoleAcceptedMessage, ConsoleIngressSnapshot } from "./ingress-records.js";

export const BLOCK_CONTENT_SCHEMA = "dolly.content/1" as const;

/**
 * The exact boundary item committed for every message.
 *
 * It carries no identifiers at all. Section 5.5 is explicit that no session,
 * route, sequence, Module job, Delivery, or client message identifier may enter
 * a content item, so a consumer that wants provenance must ask the host rather
 * than read it out of the Block.
 */
export function messageBoundaryItem(): BlockContentItem {
  return { type: "data", schema: MESSAGE_BOUNDARY_SCHEMA, value: {} };
}

/**
 * Encodes accepted messages as ordered `dolly.content/1` items.
 *
 * Per message, in order: one boundary item, the exact text bytes when text is
 * present, then one `media-reference` item per attachment occurrence. Two
 * occurrences of the same Media stay two items — the reference graph collapses
 * the duplicate dependency edge, the content array does not.
 */
export function ingressContentItems(
  messages: readonly ConsoleAcceptedMessage[],
): readonly BlockContentItem[] {
  const items: BlockContentItem[] = [];
  for (const accepted of messages) {
    items.push(messageBoundaryItem());
    if (accepted.message.text !== undefined) {
      items.push({ type: "text", text: accepted.message.text, format: "plain" });
    }
    for (const occurrence of accepted.media) {
      items.push({ type: "media-reference", mediaId: occurrence.mediaId });
    }
  }
  return items;
}

function proposalFor(messages: readonly ConsoleAcceptedMessage[]): BlockProposal {
  const items = ingressContentItems(messages);
  if (items.length === 0) {
    throw consoleError("RESULT_INVALID", "An ingress proposal needs at least one content item");
  }
  // The Core validator is the authority on the content format. Running it here
  // means a malformed item fails inside the Console instead of at commit.
  const content = parseBlockContent({ items });
  const value = { items: content.items };
  assertJsonValue(value);
  return { payload: { schema: BLOCK_CONTENT_SCHEMA, value: value as unknown as JsonValue } };
}

/** Exact canonical proposed-Block bytes, which is what section 5.3 budgets. */
export function measureIngressProposalBytes(
  messages: readonly ConsoleAcceptedMessage[],
): number {
  return canonicalJsonByteLength(proposalFor(messages));
}

/**
 * Builds the single BlockProposal for one frozen snapshot.
 *
 * The result carries no summary: section 5.5 requires the BlockProposal
 * summary to be absent so nothing outside the exact recomposition can vary
 * between attempts.
 */
export function buildIngressProposal(snapshot: ConsoleIngressSnapshot): BlockProposal {
  if (snapshot.messages.length === 0) {
    throw consoleError("RESULT_INVALID", "A dispatched ingress snapshot is never empty");
  }
  return proposalFor(snapshot.messages);
}

export interface IngressProposalVerification {
  readonly expectedDigest: string;
  readonly actualDigest: string;
}

/**
 * Faithfulness check from section 5.5.
 *
 * The host recomposes the expected proposal from the frozen snapshot and
 * requires canonical equality. Changed text, a missing or extra boundary, a
 * reordered or substituted Media occurrence, an added summary, and an added
 * optional field all differ canonically, so one comparison covers them and no
 * field-by-field allowlist can drift away from it.
 */
export function verifyIngressProposal(
  snapshot: ConsoleIngressSnapshot,
  proposal: unknown,
): IngressProposalVerification {
  const expected = buildIngressProposal(snapshot);
  const expectedDigest = canonicalJsonDigest(expected);
  let actualDigest: string;
  try {
    actualDigest = canonicalJsonDigest(proposal);
  } catch {
    throw consoleError("RESULT_INVALID", "Module result is not canonical JSON");
  }
  if (actualDigest !== expectedDigest) {
    throw consoleError("RESULT_INVALID", "Module result is not the faithful ingress proposal", {
      expectedDigest,
      actualDigest,
    });
  }
  return { expectedDigest, actualDigest };
}
