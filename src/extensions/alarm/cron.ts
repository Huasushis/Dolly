/**
 * `cron_v1` schedule parsing and matching.
 *
 * Per the Alarm spec, the five fields are `minute hour day_of_month month
 * day_of_week`. Allowed field grammar is `*`, comma lists, numeric ranges,
 * and positive steps; names, `L`, `W`, `#`, and seconds are forbidden. Day of
 * week is `0..6`, Sunday `0`. Matching occurs in local civil time; when both
 * day-of-month and day-of-week are restricted, a day matches when either
 * field matches (Vixie semantics); when either field is `*` the restricted
 * field must match.
 */
import { alarmError } from "./errors.js";
import { type CivilTime } from "./time.js";

export interface CronRange {
  readonly from: number;
  readonly to: number;
  readonly step: number;
}

export interface CronField {
  /** True only when the whole field is exactly `*`. */
  readonly isStar: boolean;
  readonly ranges: readonly CronRange[];
}

export interface CronFields {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

const FIELD_SPECS: readonly {
  readonly label: string;
  readonly min: number;
  readonly max: number;
}[] = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day_of_month", min: 1, max: 31 },
  { label: "month", min: 1, max: 12 },
  { label: "day_of_week", min: 0, max: 6 },
];

const FIELD_PATTERN = /^[0-9*,\/-]+$/;
const NUMBER_PATTERN = /^(\d+)$/;
const RANGE_PATTERN = /^(\d+)-(\d+)(?:\/(\d+))?$/;
const STAR_STEP_PATTERN = /^\*\/(\d+)$/;

function parseField(spec: string, label: string, min: number, max: number): CronField {
  if (spec === "") {
    throw alarmError("INVALID_SCHEDULE", `cron ${label} field is empty`, { field: label });
  }
  if (!FIELD_PATTERN.test(spec)) {
    throw alarmError(
      "INVALID_SCHEDULE",
      `cron ${label} field may only contain numbers, '*', '/', ',' and '-'`,
      { field: label, value: spec },
    );
  }
  const items = spec.split(",");
  const ranges: CronRange[] = [];
  for (const item of items) {
    if (item === "*") {
      ranges.push({ from: min, to: max, step: 1 });
      continue;
    }
    const simple = NUMBER_PATTERN.exec(item);
    if (simple !== null) {
      const value = Number(simple[1]);
      rangeCheck(value, label, min, max);
      ranges.push({ from: value, to: value, step: 1 });
      continue;
    }
    const starStep = STAR_STEP_PATTERN.exec(item);
    if (starStep !== null) {
      const step = Number(starStep[1]);
      if (step < 1) throw stepError(label, step);
      ranges.push({ from: min, to: max, step });
      continue;
    }
    const ranged = RANGE_PATTERN.exec(item);
    if (ranged !== null) {
      const from = Number(ranged[1]);
      const to = Number(ranged[2]);
      rangeCheck(from, label, min, max);
      rangeCheck(to, label, min, max);
      if (from > to) {
        throw alarmError("INVALID_SCHEDULE", `cron ${label} range start exceeds its end`, {
          field: label,
          value: item,
        });
      }
      const step = ranged[3] === undefined ? 1 : Number(ranged[3]);
      if (step < 1) throw stepError(label, step);
      ranges.push({ from, to, step });
      continue;
    }
    throw alarmError(
      "INVALID_SCHEDULE",
      `cron ${label} item is not a valid number, range, or stepped range`,
      { field: label, value: item },
    );
  }
  return { isStar: items.length === 1 && items[0] === "*", ranges };
}

function stepError(label: string, step: number): Error {
  return alarmError("INVALID_SCHEDULE", `cron ${label} step must be a positive integer`, {
    field: label,
    value: step,
  });
}

function rangeCheck(value: number, label: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw alarmError(
      "INVALID_SCHEDULE",
      `cron ${label} value must be an integer in [${min}, ${max}]`,
      { field: label, value },
    );
  }
}

export function parseCronExpression(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw alarmError(
      "INVALID_SCHEDULE",
      "cron_v1 expression must have exactly five fields (minute, hour, day_of_month, month, day_of_week)",
      { value: expression },
    );
  }
  if (!/^[0-9*,\/ -]+$/.test(expression)) {
    throw alarmError(
      "INVALID_SCHEDULE",
      "cron_v1 expression may only contain digits, '*', '/', ',', '-', and spaces",
      { value: expression },
    );
  }
  return {
    minute: parseField(fields[0]!, "minute", 0, 59),
    hour: parseField(fields[1]!, "hour", 0, 23),
    dayOfMonth: parseField(fields[2]!, "day_of_month", 1, 31),
    month: parseField(fields[3]!, "month", 1, 12),
    dayOfWeek: parseField(fields[4]!, "day_of_week", 0, 6),
  };
}

/** True when `value` lies inside one of the field's ranges on its step grid. */
export function fieldMatches(field: CronField, value: number): boolean {
  if (value < 0) return false;
  for (const rangeEntry of field.ranges) {
    if (value >= rangeEntry.from && value <= rangeEntry.to) {
      if ((value - rangeEntry.from) % rangeEntry.step === 0) return true;
    }
  }
  return false;
}

/**
 * Day match with Vixie DOM/DOW semantics: both restricted => either matches;
 * exactly one restricted => the restricted field must match; both unrestricted
 * => match. Day of week of the civil date.
 */
export function matchesDay(fields: CronFields, civil: CivilTime): boolean {
  const domMatch = fieldMatches(fields.dayOfMonth, civil.day);
  const dow = new Date(Date.UTC(civil.year, civil.month - 1, civil.day)).getUTCDay();
  const dowMatch = fieldMatches(fields.dayOfWeek, dow);
  const domStar = fields.dayOfMonth.isStar;
  const dowStar = fields.dayOfWeek.isStar;
  if (domStar && dowStar) return true;
  if (domStar) return dowMatch;
  if (dowStar) return domMatch;
  return domMatch || dowMatch;
}
