/**
 * Stable alarm error taxonomy from the Alarm Extension specification §8.
 *
 * The codes are the fixed, wire-stable set the specification says MUST exist;
 * this slice throws only the subset it can reach (invalid schedule, nonexistent
 * timezone, iteration bound, repeat interval). Alarm-, occurrence-, and
 * schedule-specific diagnostic fields belong in `details`.
 */
import type { JsonValue } from "../../core/canonical-json.js";

export type AlarmErrorCode =
  | "INVALID_SCHEDULE"
  | "NONEXISTENT_TIMEZONE"
  | "REVISION_CONFLICT"
  | "ITERATION_BOUND"
  | "ALARM_LIMIT"
  | "REPEAT_INTERVAL"
  | "OCCURRENCE_NOT_FOUND"
  | "ALREADY_ACKNOWLEDGED"
  | "DATABASE_UNAVAILABLE"
  | "CLOCK_UNAVAILABLE"
  | "RUNTIME_OUTCOME_UNKNOWN";

export class AlarmError extends Error {
  constructor(
    readonly code: AlarmErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "AlarmError";
  }
}

export function alarmError(
  code: AlarmErrorCode,
  message: string,
  details: Readonly<Record<string, JsonValue>> = {},
): AlarmError {
  return new AlarmError(code, message, details);
}
