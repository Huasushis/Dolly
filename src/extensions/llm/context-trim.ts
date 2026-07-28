/**
 * Deterministic context trimming.
 *
 * Contract: `docs/spec/llm-extension.md` sections 3.2 and 4.1 — "Context
 * eviction removes whole units. It MUST NOT leave an orphan tool call, tool
 * result, reasoning replay segment, media annotation, or attachment. Stable
 * ordering and the exact context-policy version are part of the conversation
 * revision."
 *
 * ## Why this is not tensity-weighted random eviction
 *
 * `docs/research/open-research-questions.md` section 4 analyses the proposed
 * "evict at random with weight 1/tensity" rule and reports four findings that
 * disqualify it as a default:
 *
 * 1. The proportional-lifetime claim needs a fixed retained set. Eviction
 *    preferentially removes low-tensity Blocks, the retained set drifts toward
 *    higher tensity, and the normalizing sum falls, so there is no setting of
 *    tensity that yields a fixed absolute lifetime. "Tensity 1.0 lasts about a
 *    day" is therefore not answerable as a constant (section 4.2).
 * 2. Eviction is triggered by bytes, not by Block count, and the rule ignores
 *    unit size, so large units are evicted far too rarely for the space they
 *    hold (section 4.2).
 * 3. Removing an arbitrary middle unit breaks tool-call and tool-result
 *    pairing, reasoning replay, and referential coherence (section 4.4).
 * 4. Removing from the middle invalidates the provider prefix cache on nearly
 *    every turn (section 4.4).
 *
 * Section 4.10 also disqualifies any policy with a nonzero structural-validity
 * failure rate before accuracy is even considered, and the gating verdict
 * requires experiment H2-A to run before any code reads tensity for eviction.
 * So the default here is section 4.7's minimal baseline: recency-ordered
 * eviction of whole units from the oldest end, with a protected recent window.
 * It is reproducible, explainable from the unit list alone, structurally valid
 * by construction, and only ever removes an oldest prefix, which keeps prefix
 * cache invalidation rare.
 *
 * The policy is an interface so that a summarizing compactor, a MemGPT-style
 * pager, or an experimental scorer can replace it. Any replacement must still
 * return a total order over the evictable units, which is what makes the
 * assembler able to prove it can always reach a fitting request or fail with a
 * typed error.
 */

import {
  ContextAssemblyError,
  type ContextNotice,
  type ConversationUnit,
} from "./context-types.js";
import { marker, markerFields } from "./untrusted-text.js";

export interface ContextTrimPolicy {
  /** Recorded in the assembly report; part of the conversation revision. */
  readonly policyId: string;
  /**
   * Returns the identifiers of the evictable units in the exact order they are
   * given up. It MUST be a permutation of every evictable unit: the assembler
   * rejects anything else, because a policy that withholds a unit could make an
   * otherwise-satisfiable request fail.
   */
  order(units: readonly ConversationUnit[]): readonly string[];
}

export interface RecentWindowTrimOptions {
  /**
   * How many of the newest evictable units are surrendered last. Protection is
   * a preference, not a wall: when nothing else is left, the window is given up
   * too, oldest first, so the current input can still be delivered.
   */
  readonly protectedRecentUnits?: number;
}

export const RECENT_WINDOW_POLICY_ID = "dolly.llm.context-trim.recent-window/1";

export function recentWindowTrimPolicy(
  options: RecentWindowTrimOptions = {},
): ContextTrimPolicy {
  const protectedRecentUnits = options.protectedRecentUnits ?? 4;
  if (!Number.isSafeInteger(protectedRecentUnits) || protectedRecentUnits < 0) {
    throw new ContextAssemblyError(
      "CONTEXT_LIMIT_INVALID",
      "protectedRecentUnits must be a non-negative safe integer",
      {},
    );
  }
  return {
    policyId: RECENT_WINDOW_POLICY_ID,
    order(units) {
      const evictable = units.filter((unit) => unit.kind === "history");
      const protectedFrom = Math.max(0, evictable.length - protectedRecentUnits);
      const unprotected = evictable.slice(0, protectedFrom);
      const recent = evictable.slice(protectedFrom);
      return [...unprotected, ...recent].map((unit) => unit.unitId);
    },
  };
}

/**
 * Validates that a policy returned a total order over the evictable units.
 *
 * A pluggable policy is deployment-owned code, not trusted input, so its output
 * is checked rather than assumed.
 */
export function validateTrimOrder(
  units: readonly ConversationUnit[],
  order: readonly string[],
  policyId: string,
): void {
  const evictable = units.filter((unit) => unit.kind === "history").map((unit) => unit.unitId);
  const expected = new Set(evictable);
  const seen = new Set<string>();
  for (const unitId of order) {
    if (!expected.has(unitId)) {
      throw new ContextAssemblyError(
        "CONTEXT_TRIM_POLICY_INVALID",
        "The trim policy returned a unit that is not evictable",
        { policyId, unitId },
      );
    }
    if (seen.has(unitId)) {
      throw new ContextAssemblyError(
        "CONTEXT_TRIM_POLICY_INVALID",
        "The trim policy returned a duplicate unit",
        { policyId, unitId },
      );
    }
    seen.add(unitId);
  }
  if (seen.size !== expected.size) {
    throw new ContextAssemblyError(
      "CONTEXT_TRIM_POLICY_INVALID",
      "The trim policy did not order every evictable unit",
      { policyId, ordered: seen.size, evictable: expected.size },
    );
  }
}

const MAX_LISTED_IDENTIFIERS = 8;

function listIdentifiers(identifiers: readonly string[]): string {
  if (identifiers.length <= MAX_LISTED_IDENTIFIERS) return identifiers.join(",");
  return `${identifiers.slice(0, MAX_LISTED_IDENTIFIERS).join(",")},+${
    identifiers.length - MAX_LISTED_IDENTIFIERS
  }-more`;
}

/**
 * Renders the visible placeholder left where units were removed.
 *
 * The removed span is named, not hidden. A model that is told "three earlier
 * units were removed here" can say it does not know; a model handed a silently
 * shortened transcript will instead answer as though nothing was missing.
 */
export function renderTrimNotice(
  fenceToken: string,
  removed: readonly ConversationUnit[],
  policyId: string,
): string {
  const blockIds = removed.flatMap((unit) => unit.blockIds);
  return [
    marker(
      fenceToken,
      markerFields([
        ["context-trimmed", String(removed.length)],
        ["policy", policyId],
        ...(blockIds.length === 0
          ? []
          : ([["blocks", listIdentifiers(blockIds)]] as const)),
      ]),
    ),
    `${removed.length} earlier conversation unit(s) were removed here to fit this` +
      " request's context budget. Their content is not available to you now. Do not" +
      " assume they were never said, and do not reconstruct them from memory; ask" +
      " for anything you need from them.",
  ].join("\n");
}

export function trimNotices(removed: readonly ConversationUnit[]): readonly ContextNotice[] {
  return removed.map((unit) => ({
    code: "UNIT_EVICTED" as const,
    subject: unit.unitId,
    reason: "context-budget",
  }));
}
