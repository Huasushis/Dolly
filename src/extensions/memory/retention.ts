import { deepFreeze } from "../../core/canonical-json.js";
import { memoryError } from "./errors.js";
import type { MemoryRecord } from "./records.js";

/**
 * Baseline retention from `docs/spec/memory-extension.md` §11.4.
 *
 * The inputs are committed record order, storage quota, and user pins. They are
 * the complete set: `docs/research/open-research-questions.md` §4 shows that
 * tensity has no workload-independent time scale and that its predictive
 * validity has never been measured, so §11.4 excludes tensity, random inverse
 * weighting, emotion, access count, and "new memory" boosts from retention. The
 * signature below cannot express them — this function receives records and a
 * quota, and nothing else.
 */

export interface RetentionPolicy {
  readonly maxRecords: number;
  readonly maxTotalTextBytes: number;
  /** Explicit user pins. A pinned record is never evicted by quota. */
  readonly pinnedRecordIds: readonly string[];
}

export interface RetentionPlan {
  readonly evictedRecordIds: readonly string[];
  readonly retainedRecordIds: readonly string[];
  readonly retainedTextBytes: number;
  readonly quotaExceeded: boolean;
}

/**
 * Committed record order: source sequence, then record ID. This is the same
 * declared stable order retrieval uses for ties (§10.4), so a record's position
 * in the retention plan does not depend on map iteration order, wall-clock
 * time, or how the store happened to be replayed.
 */
function committedOrder(left: MemoryRecord, right: MemoryRecord): number {
  if (left.coreSequence !== right.coreSequence) return left.coreSequence - right.coreSequence;
  return left.recordId < right.recordId ? -1 : 1;
}

export function planRetention(
  records: readonly MemoryRecord[],
  policy: RetentionPolicy,
): RetentionPlan {
  for (const [label, value] of [
    ["maxRecords", policy.maxRecords],
    ["maxTotalTextBytes", policy.maxTotalTextBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw memoryError("MEMORY_CONFIG_INVALID", `${label} must be a positive safe integer`, {
        limit: label,
      });
    }
  }
  const pinned = new Set(policy.pinnedRecordIds);
  const ordered = [...records].sort(committedOrder);
  const retained: MemoryRecord[] = [];
  const evicted: string[] = [];

  // Newest first for the keep decision, so quota pressure evicts the oldest
  // committed records. Pins are kept regardless and still consume quota, which
  // is why the retained byte total is reported rather than assumed.
  for (const record of [...ordered].reverse()) {
    if (pinned.has(record.recordId)) {
      retained.push(record);
      continue;
    }
    const withRecord = retained.length + 1;
    const bytes =
      retained.reduce((total, kept) => total + Buffer.byteLength(kept.text, "utf8"), 0) +
      Buffer.byteLength(record.text, "utf8");
    if (withRecord > policy.maxRecords || bytes > policy.maxTotalTextBytes) {
      evicted.push(record.recordId);
      continue;
    }
    retained.push(record);
  }

  const retainedSorted = retained.sort(committedOrder);
  return deepFreeze({
    evictedRecordIds: evicted.sort(),
    retainedRecordIds: retainedSorted.map((record) => record.recordId),
    retainedTextBytes: retainedSorted.reduce(
      (total, record) => total + Buffer.byteLength(record.text, "utf8"),
      0,
    ),
    quotaExceeded: evicted.length > 0,
  });
}
