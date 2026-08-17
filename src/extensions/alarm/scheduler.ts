/**
 * Deterministic occurrence evaluation for the alarm domain slice.
 *
 * `evaluateCronDay` computes the ordered occurrence set for one civil date
 * from a fixed (alarm revision, tzdb fixture, cron expression, policies)
 * tuple — REQ-ALARM-001. It is pure and uses a configured iteration bound.
 *
 * Occurrence identity is the canonical `sha256:` digest of the UTF-8 JCS bytes
 * of the spec section 4 tuple `["dolly.alarm.occurrence/v1", alarm_id,
 * alarm_revision, scheduled_utc_instant, fold_ordinal]`, so identities are
 * stable across restart and competing schedulers.
 */
import { createHash } from "node:crypto";
import { canonicalBytes } from "../../schema-bundle/index.js";
import { alarmError } from "./errors.js";
import { parseCronExpression, fieldMatches, matchesDay } from "./cron.js";
import {
  formatUtcIso6,
  parseLocalDate,
  type CivilTime,
  type UsInstant,
} from "./time.js";
import { lookupZone, resolveCivilInZone, shiftByGapUs, type ZoneFixture } from "./tzdata.js";

export type DstGapPolicy = "shift_by_gap" | "skip";
export type DstFoldPolicy = "earlier" | "later" | "both";

export const DEFAULT_DST_GAP_POLICY: DstGapPolicy = "shift_by_gap";
export const DEFAULT_DST_FOLD_POLICY: DstFoldPolicy = "earlier";

const DEFAULT_ITERATION_BOUND = 24 * 60;

export interface AlarmOccurrence {
  /** Canonical Core UTC instant, six digits. */
  utc: string;
  /** Microseconds since the epoch, UTC, for programmatic use. */
  scheduledUs: UsInstant;
  /** 0 for unambiguous or earlier; 1 for the later instant of a fold. */
  fold_ordinal: 0 | 1;
  /** `sha256:` digest of the spec section 4 identity tuple. */
  occurrence_id: string;
}

export interface CronDayEvaluation {
  readonly occurrences: readonly AlarmOccurrence[];
}

export interface CronDayEvaluationInput {
  readonly expression: string;
  /** tzdb fixture identifier, e.g. `America/New_York-2025a`. */
  readonly timezone: string;
  readonly dstGapPolicy?: DstGapPolicy;
  readonly dstFoldPolicy?: DstFoldPolicy;
  readonly alarmId: string;
  readonly alarmRevision: number;
  /** Civil `YYYY-MM-DD` to evaluate. */
  readonly localDate: string;
  readonly iterationBound?: number;
}

function buildOccurrence(
  alarmId: string,
  alarmRevision: number,
  scheduledUs: UsInstant,
  foldOrdinal: 0 | 1,
): AlarmOccurrence {
  return {
    utc: formatUtcIso6(scheduledUs),
    scheduledUs,
    fold_ordinal: foldOrdinal,
    occurrence_id: createOccurrenceId({
      alarmId,
      alarmRevision,
      scheduledUs,
      foldOrdinal,
    }),
  };
}

export function createOccurrenceId(input: {
  readonly alarmId: string;
  readonly alarmRevision: number;
  readonly scheduledUs: UsInstant;
  readonly foldOrdinal: 0 | 1;
}): string {
  const tuple = [
    "dolly.alarm.occurrence/v1",
    input.alarmId,
    input.alarmRevision,
    formatUtcIso6(input.scheduledUs),
    input.foldOrdinal,
  ];
  const bytes = canonicalBytes(tuple);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${digest}`;
}

export function evaluateCronDay(input: CronDayEvaluationInput): CronDayEvaluation {
  const zone = lookupZone(input.timezone);
  const fields = parseCronExpression(input.expression);
  const day = parseLocalDate(input.localDate);
  const foldPolicy = input.dstFoldPolicy ?? DEFAULT_DST_FOLD_POLICY;
  const gapPolicy = input.dstGapPolicy ?? DEFAULT_DST_GAP_POLICY;
  const bound = input.iterationBound ?? DEFAULT_ITERATION_BOUND;

  const occurrences: AlarmOccurrence[] = [];
  let probes = 0;
  for (let hour = 0; hour < 24; hour += 1) {
    if (!fieldMatches(fields.hour, hour)) continue;
    for (let minute = 0; minute < 60; minute += 1) {
      if (!fieldMatches(fields.minute, minute)) continue;
      probes += 1;
      if (probes > bound) {
        throw alarmError("ITERATION_BOUND", "cron day evaluation exceeded its iteration bound", {
          bound,
          expression: input.expression,
        });
      }
      const civil: CivilTime = {
        year: day.year,
        month: day.month,
        day: day.day,
        hour,
        minute,
        second: 0,
      };
      if (!matchesDay(fields, civil)) continue;
      collectForCivilTime(zone, civil, gapPolicy, foldPolicy, input, occurrences);
    }
  }
  occurrences.sort((a, b) => a.scheduledUs - b.scheduledUs);
  return { occurrences };
}

function collectForCivilTime(
  zone: ZoneFixture,
  civil: CivilTime,
  gapPolicy: DstGapPolicy,
  foldPolicy: DstFoldPolicy,
  input: CronDayEvaluationInput,
  occurrences: AlarmOccurrence[],
): void {
  const resolved = resolveCivilInZone(zone, civil);
  if (resolved.length > 0) {
    if (foldPolicy === "both") {
      for (const entry of resolved) {
        occurrences.push(
          buildOccurrence(input.alarmId, input.alarmRevision, entry.us, entry.foldOrdinal),
        );
      }
      return;
    }
    const entry = foldPolicy === "later" ? resolved[resolved.length - 1]! : resolved[0]!;
    occurrences.push(
      buildOccurrence(input.alarmId, input.alarmRevision, entry.us, entry.foldOrdinal),
    );
    return;
  }
  if (gapPolicy === "skip") return;
  const shiftedUs = shiftByGapUs(zone, civil);
  if (shiftedUs !== null) {
    occurrences.push(
      buildOccurrence(input.alarmId, input.alarmRevision, shiftedUs, 0),
    );
  }
}
