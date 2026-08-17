/**
 * Public seam of the deterministic alarm extension slice.
 *
 * This is the closed alarm domain/action seam the integration slices (storage,
 * delivery, runtime wiring) will build on. Everything here is pure,
 * deterministic, and host-locale independent; nothing is wired to product
 * runtime or delivery.
 */
export { AlarmError, alarmError } from "./errors.js";
export type { AlarmErrorCode } from "./errors.js";
export { timezoneFixtureId } from "./actions.js";
export {
  orderRecordsForList,
  compareRecordsForList,
  normalizeCreate,
  ALARM_EXTENSION_ID,
} from "./actions.js";
export type {
  AlarmRecord,
  CreateResult,
  CreateAction,
  CreateInput,
  FrozenAlarmConfig,
  RawSchedule,
  RawDelivery,
  MisfirePolicy,
} from "./actions.js";
export {
  evaluateCronDay,
  createOccurrenceId,
  DEFAULT_DST_GAP_POLICY,
  DEFAULT_DST_FOLD_POLICY,
} from "./scheduler.js";
export type { AlarmOccurrence, CronDayEvaluation, DstGapPolicy, DstFoldPolicy } from "./scheduler.js";
export { parseCronExpression, fieldMatches, matchesDay } from "./cron.js";
export type { CronFields, CronField, CronRange } from "./cron.js";
export {
  parseUtcTimestampUs,
  parseLocalDate,
  formatUtcIso6,
  formatDateOnly,
} from "./time.js";
export type { CivilTime, UsInstant } from "./time.js";
export { lookupZone, resolveCivilInZone, shiftByGapUs, zoneOffsetMinutesAt } from "./tzdata.js";
export type { ZoneFixture, ResolvedCivil, ZoneTransition } from "./tzdata.js";
