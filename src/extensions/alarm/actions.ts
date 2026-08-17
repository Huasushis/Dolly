/**
 * Alarm create/list domain seam (pure, storage-free slice).
 *
 * `normalizeCreate` materializes a durable AlarmRecord from a committed create
 * action, the frozen extension config, and a virtual clock value — never from
 * the host clock. The same committed inputs always yield the byte-same logical
 * record, which is the spec's idempotent-create property at the domain seam;
 * actual persistence and replay against stored records belong to a later
 * integration slice. `next_occurrence` is computed deterministically from the
 * schedule and `nowUs`, with no delivery logic. `compareRecordsForList` gives
 * the deterministic (ascending, nulls last, alarm_id tie-break) order the
 * list result must be emitted in.
 *
 * Stable failures: malformed schedule/timestamp => `INVALID_SCHEDULE`, unknown
 * timezone => `NONEXISTENT_TIMEZONE`, out-of-range repeat interval =>
 * `REPEAT_INTERVAL`.
 */
import { alarmError, type AlarmErrorCode } from "./errors.js";
import {
  evaluateCronDay,
  type DstGapPolicy,
  type DstFoldPolicy,
} from "./scheduler.js";
import {
  formatDateOnly,
  formatUtcIso6,
  parseUtcTimestampUs,
  type UsInstant,
} from "./time.js";
import { lookupZone } from "./tzdata.js";
import { parseCronExpression } from "./cron.js";

export const ALARM_EXTENSION_ID = "org.dolly.alarm";
const ALARM_CREATE_ACTION_NAME = "org.dolly.alarm.create";

export type MisfirePolicy = "skip" | "fire_once" | "catch_up";

const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TITLE_MAX_LENGTH = 256;
const REPEAT_MIN_SECONDS = 1;
const REPEAT_MAX_SECONDS = 31_557_600; // one year in seconds
const INTERVAL_MAX_SECONDS = 31_557_600;
const SEARCH_AHEAD_DAYS = 366;
const US_PER_SECOND = 1_000_000;

export interface FrozenAlarmConfig {
  readonly default_timezone: string;
  readonly default_misfire_policy: MisfirePolicy;
  readonly default_dst_gap_policy: DstGapPolicy;
  readonly default_dst_fold_policy: DstFoldPolicy;
  readonly tzdb_revision: string;
}

export type RawSchedule =
  | { readonly kind: "once"; readonly at: string }
  | { readonly kind: "interval"; readonly every_seconds: number; readonly anchor: string }
  | { readonly kind: "cron_v1"; readonly expression: string; readonly timezone?: string };

export type RawDelivery =
  | { readonly mode: "once" }
  | { readonly mode: "repeat_until_acknowledged"; readonly repeat_interval_seconds: number };

export interface CreateAction {
  readonly action_id: string;
  readonly name: string;
  readonly arguments: {
    readonly title: string;
    readonly schedule: RawSchedule;
    readonly delivery: RawDelivery;
    readonly enabled: boolean;
    readonly misfire_policy?: MisfirePolicy;
    readonly dst_gap_policy?: DstGapPolicy;
    readonly dst_fold_policy?: DstFoldPolicy;
  };
}

export interface CreateInput {
  readonly alarm_id: string;
  readonly action: CreateAction;
  readonly config: FrozenAlarmConfig;
  /** Virtual clock: microseconds since the Unix epoch. */
  readonly nowUs: UsInstant;
}

export interface AlarmRecord {
  readonly alarm_id: string;
  readonly revision: number;
  readonly title: string;
  readonly schedule: {
    readonly kind: "once" | "interval" | "cron_v1";
    readonly at?: string;
    readonly every_seconds?: number;
    readonly anchor?: string;
    readonly expression?: string;
    readonly timezone?: string;
  };
  readonly delivery: RawDelivery;
  readonly misfire_policy: MisfirePolicy;
  readonly dst_gap_policy: DstGapPolicy;
  readonly dst_fold_policy: DstFoldPolicy;
  readonly enabled: boolean;
  readonly created_at: string;
  /** Earliest occurrence after the virtual clock; null when none exists. */
  readonly next_occurrence: string | null;
  readonly tzdb_revision: string;
}

export interface CreateResult {
  readonly schema: "dolly.alarm.create-result/v1";
  readonly record: AlarmRecord;
}

const MISFIRE_POLICIES: readonly MisfirePolicy[] = ["skip", "fire_once", "catch_up"];
const GAP_POLICIES: readonly DstGapPolicy[] = ["shift_by_gap", "skip"];
const FOLD_POLICIES: readonly DstFoldPolicy[] = ["earlier", "later", "both"];

function requireOneOf<T extends string>(
  value: T,
  allowed: readonly T[],
  label: string,
  code: AlarmErrorCode,
): void {
  if (!allowed.includes(value)) {
    throw alarmError(code, `${label} must be one of: ${allowed.join(", ")}`, {
      field: label,
      value,
    });
  }
}

function requireUuidV7(value: string, label: string): void {
  if (!UUIDV7_PATTERN.test(value)) {
    throw alarmError("INVALID_SCHEDULE", `${label} must be a UUIDv7`, { field: label, value });
  }
}

function requireRange(
  value: number,
  min: number,
  max: number,
  label: string,
  code: AlarmErrorCode,
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw alarmError(code, `${label} must be an integer in [${min}, ${max}]`, {
      field: label,
      value,
    });
  }
  return value;
}

/** tzdb fixture id for a zone at a given revision, e.g. `America/New_York-2025a`. */
export function timezoneFixtureId(timezone: string, revision: string): string {
  return `${timezone}-${revision}`;
}

function materializeCronNextOccurrence(
  expression: string,
  timezone: string,
  gapPolicy: DstGapPolicy,
  foldPolicy: DstFoldPolicy,
  alarmId: string,
  nowUs: UsInstant,
): string | null {
  const day = new Date(Math.floor(nowUs / US_PER_SECOND) * 1000);
  for (let offset = 0; offset <= SEARCH_AHEAD_DAYS; offset += 1) {
    const probe = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + offset));
    const localDate = formatDateOnly(
      probe.getUTCFullYear(),
      probe.getUTCMonth() + 1,
      probe.getUTCDate(),
    );
    const evaluation = evaluateCronDay({
      expression,
      timezone,
      dstGapPolicy: gapPolicy,
      dstFoldPolicy: foldPolicy,
      alarmId,
      alarmRevision: 1,
      localDate,
    });
    for (const occurrence of evaluation.occurrences) {
      if (occurrence.scheduledUs > nowUs) return occurrence.utc;
    }
  }
  return null;
}

function normalizeDelivery(delivery: RawDelivery): RawDelivery {
  if (delivery.mode === "once") return { mode: "once" };
  requireRange(
    delivery.repeat_interval_seconds,
    REPEAT_MIN_SECONDS,
    REPEAT_MAX_SECONDS,
    "repeat_interval_seconds",
    "REPEAT_INTERVAL",
  );
  return { ...delivery, repeat_interval_seconds: delivery.repeat_interval_seconds };
}

function normalizeSchedule(
  schedule: RawSchedule,
  config: FrozenAlarmConfig,
  alarmId: string,
  nowUs: UsInstant,
  gapPolicy: DstGapPolicy,
  foldPolicy: DstFoldPolicy,
): { readonly shape: AlarmRecord["schedule"]; readonly next_occurrence: string | null } {
  if (schedule.kind === "once") {
    const atUs = parseUtcTimestampUs(schedule.at, "schedule.at");
    return {
      shape: { kind: "once", at: formatUtcIso6(atUs) },
      next_occurrence: atUs > nowUs ? formatUtcIso6(atUs) : null,
    };
  }
  if (schedule.kind === "interval") {
    requireRange(schedule.every_seconds, 1, INTERVAL_MAX_SECONDS, "schedule.every_seconds", "INVALID_SCHEDULE");
    const anchorUs = parseUtcTimestampUs(schedule.anchor, "schedule.anchor");
    let nextUs = anchorUs;
    if (nextUs <= nowUs) {
      const durationUs = schedule.every_seconds * US_PER_SECOND;
      const steps = Math.floor((nowUs - anchorUs) / durationUs) + 1;
      nextUs = anchorUs + steps * durationUs;
    }
    return {
      shape: { kind: "interval", every_seconds: schedule.every_seconds, anchor: formatUtcIso6(anchorUs) },
      next_occurrence: formatUtcIso6(nextUs),
    };
  }
  // cron_v1
  parseCronExpression(schedule.expression);
  const timezone = schedule.timezone ?? config.default_timezone;
  const zoneFixtureId = timezoneFixtureId(timezone, config.tzdb_revision);
  void lookupZone(zoneFixtureId); // typed NONEXISTENT_TIMEZONE on unknown
  const next = materializeCronNextOccurrence(
    schedule.expression,
    zoneFixtureId,
    gapPolicy,
    foldPolicy,
    alarmId,
    nowUs,
  );
  return {
    shape: { kind: "cron_v1", expression: schedule.expression, timezone },
    next_occurrence: next,
  };
}

export function normalizeCreate(input: CreateInput): CreateResult {
  const { action } = input;
  if (action.name !== ALARM_CREATE_ACTION_NAME) {
    throw alarmError("INVALID_SCHEDULE", "action name is not the alarm create action", {
      field: "name",
      value: action.name,
    });
  }
  requireUuidV7(input.alarm_id, "alarm_id");
  requireUuidV7(action.action_id, "action_id");
  const title = action.arguments.title;
  if (typeof title !== "string" || title.length === 0 || title.length > TITLE_MAX_LENGTH) {
    throw alarmError("INVALID_SCHEDULE", "title must be a nonempty string of at most 256 characters", {
      field: "title",
    });
  }
  if (typeof action.arguments.enabled !== "boolean") {
    throw alarmError("INVALID_SCHEDULE", "enabled must be a boolean", { field: "enabled" });
  }

  const gapPolicy = action.arguments.dst_gap_policy ?? input.config.default_dst_gap_policy;
  const foldPolicy = action.arguments.dst_fold_policy ?? input.config.default_dst_fold_policy;
  const misfirePolicy = action.arguments.misfire_policy ?? input.config.default_misfire_policy;
  requireOneOf(gapPolicy, GAP_POLICIES, "dst_gap_policy", "INVALID_SCHEDULE");
  requireOneOf(foldPolicy, FOLD_POLICIES, "dst_fold_policy", "INVALID_SCHEDULE");
  requireOneOf(misfirePolicy, MISFIRE_POLICIES, "misfire_policy", "INVALID_SCHEDULE");

  const delivery = normalizeDelivery(action.arguments.delivery);
  const { shape, next_occurrence } = normalizeSchedule(
    action.arguments.schedule,
    input.config,
    input.alarm_id,
    input.nowUs,
    gapPolicy,
    foldPolicy,
  );

  const record: AlarmRecord = {
    alarm_id: input.alarm_id,
    revision: 1,
    title,
    schedule: shape,
    delivery,
    misfire_policy: misfirePolicy,
    dst_gap_policy: gapPolicy,
    dst_fold_policy: foldPolicy,
    enabled: action.arguments.enabled,
    created_at: formatUtcIso6(input.nowUs),
    next_occurrence,
    tzdb_revision: input.config.tzdb_revision,
  };

  return { schema: "dolly.alarm.create-result/v1", record };
}

/**
 * Ascending, nulls-last, alarm_id tie-break ordering for emitted lists and the
 * Runtime validator's check. Null next_occurrence sorts after every timestamp;
 * equal timestamps break on bytewise alarm_id.
 */
export function compareRecordsForList(a: AlarmRecord, b: AlarmRecord): number {
  const aNull = a.next_occurrence === null;
  const bNull = b.next_occurrence === null;
  if (aNull && bNull) return compareAlarmIds(a, b);
  if (aNull) return 1;
  if (bNull) return -1;
  const aUs = parseUtcTimestampUs(a.next_occurrence, "record.next_occurrence");
  const bUs = parseUtcTimestampUs(b.next_occurrence, "record.next_occurrence");
  if (aUs !== bUs) return aUs < bUs ? -1 : 1;
  return compareAlarmIds(a, b);
}

function compareAlarmIds(a: AlarmRecord, b: AlarmRecord): number {
  const x = a.alarm_id;
  const y = b.alarm_id;
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

export function orderRecordsForList(records: readonly AlarmRecord[]): AlarmRecord[] {
  return [...records].sort(compareRecordsForList);
}
