/**
 * Time & civil-calendar helpers for the alarm domain slice.
 *
 * All stored instants are UTC (Core six-digit `YYYY-MM-DDTHH:MM:SS.uuuuuuZ`
 * form). Civil times are only ever a calendar interpretation input; they carry
 * no offset of their own. Every function is deterministic and pure, with no
 * host-locale dependence: calendars, dates, and offsets are computed
 * explicitly, never via the ambient system timezone.
 */
import { alarmError } from "./errors.js";

export interface CivilTime {
  readonly year: number;
  readonly month: number; // 1..12
  readonly day: number; // 1..31
  readonly hour: number; // 0..23
  readonly minute: number; // 0..59
  readonly second: number; // 0..59
}

/** Microseconds since the Unix epoch, UTC. Always a safe integer here. */
export type UsInstant = number;

const US_PER_SECOND = 1_000_000;

function range(
  value: number,
  min: number,
  max: number,
  label: string,
): asserts value is number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw alarmError("INVALID_SCHEDULE", `${label} must be an integer in [${min}, ${max}]`, {
      field: label,
      value,
    });
  }
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export function assertCivilDate(
  year: number,
  month: number,
  day: number,
  label = "date",
): void {
  range(month, 1, 12, `${label}.month`);
  range(day, 1, daysInMonth(year, month), `${label}.day`);
  if (year < 1 || year > 9999) {
    throw alarmError("INVALID_SCHEDULE", `${label}.year must be in [1, 9999]`, { field: label });
  }
}

/** Civil time expressed as microseconds since the epoch, as if UTC. */
export function civilToUs(civil: CivilTime): UsInstant {
  return Date.UTC(
    civil.year,
    civil.month - 1,
    civil.day,
    civil.hour,
    civil.minute,
    civil.second,
  ) * 1000; // milliseconds to microseconds
}

function pad(number: number, width: number): string {
  return String(number).padStart(width, "0");
}

/** Canonical Core UTC instant with six-digit microseconds. */
export function formatUtcIso6(us: UsInstant): string {
  const wholeSeconds = Math.floor(us / US_PER_SECOND);
  const microseconds = us - wholeSeconds * US_PER_SECOND;
  const d = new Date(wholeSeconds * 1000);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const da = d.getUTCDate();
  const h = d.getUTCHours();
  const mi = d.getUTCMinutes();
  const s = d.getUTCSeconds();
  return `${pad(y, 4)}-${pad(mo, 2)}-${pad(da, 2)}T${pad(h, 2)}:${pad(mi, 2)}:${pad(s, 2)}.${pad(microseconds, 6)}Z`;
}

const RFC3339_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * Parse an RFC3339 timestamp that carries an explicit `Z` or numeric offset.
 * Per the Alarm spec, input without an offset, a leap second, or an invalid
 * calendar date is rejected rather than interpreted with a default zone.
 */
export function parseUtcTimestampUs(text: string, label = "timestamp"): UsInstant {
  const match = RFC3339_WITH_OFFSET.exec(text);
  if (match === null) {
    throw alarmError(
      "INVALID_SCHEDULE",
      `${label} must be an RFC3339 timestamp with an explicit Z or numeric offset`,
      { field: label, value: text },
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (second === 60) {
    throw alarmError("INVALID_SCHEDULE", `${label} must not contain a leap second`, {
      field: label,
      value: text,
    });
  }
  const fraction = match[7] ?? "";
  const microseconds = fraction === "" ? 0 : Number(fraction.padEnd(6, "0"));
  const zone = match[8]!;
  let offsetUs = 0;
  if (zone !== "Z" && zone !== "z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4, 6));
    if (hours > 23 || minutes > 59) {
      throw alarmError("INVALID_SCHEDULE", `${label} offset is out of range`, {
        field: label,
        value: text,
      });
    }
    offsetUs = sign * (hours * 3600 + minutes * 60) * US_PER_SECOND;
  }
  range(hour, 0, 23, `${label}.hour`);
  range(minute, 0, 59, `${label}.minute`);
  range(second, 0, 59, `${label}.second`);
  assertCivilDate(year, month, day, label);
  return civilToUs({ year, month, day, hour, minute, second }) + microseconds - offsetUs;
}

/** Canonical `YYYY-MM-DD` for a civil date. */
export function formatDateOnly(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse a `YYYY-MM-DD` calendar date and validate it, no timezone applied. */
export function parseLocalDate(text: string): Omit<CivilTime, "hour" | "minute" | "second"> {
  const match = LOCAL_DATE_PATTERN.exec(text);
  if (match === null) {
    throw alarmError("INVALID_SCHEDULE", "local date must be YYYY-MM-DD", { value: text });
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  assertCivilDate(year, month, day, "local date");
  return { year, month, day };
}
