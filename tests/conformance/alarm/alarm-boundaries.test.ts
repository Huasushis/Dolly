/**
 * Focused unit tests for the closed alarm domain/action seam: entry-point
 * validation, unknown inputs, and pure normalization helpers.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateCronDay,
  normalizeCreate,
  orderRecordsForList,
  type AlarmRecord,
  type CreateInput,
  type FrozenAlarmConfig,
} from "../../../src/extensions/alarm/index.js";

const ZONE = "America/New_York-2025a";
const ALARM_ID = "019535d4-6f00-7a2c-9b31-8e11d2345000";
const ACTION_ID = "019535d4-6f00-7a2c-9b31-8e11d2345000";

const CONFIG: FrozenAlarmConfig = {
  default_timezone: "America/New_York",
  default_misfire_policy: "skip",
  default_dst_gap_policy: "shift_by_gap",
  default_dst_fold_policy: "earlier",
  tzdb_revision: "2025a",
};

type Writable<T> = { -readonly [K in keyof T]: T[K] extends object ? Writable<T[K]> : T[K] };

function baseInput(): Writable<CreateInput> {
  return {
    alarm_id: ALARM_ID,
    action: {
      action_id: ACTION_ID,
      name: "org.dolly.alarm.create",
      arguments: {
        title: "Daily test alarm",
        schedule: { kind: "cron_v1", expression: "30 9 * * *", timezone: "America/New_York" },
        delivery: { mode: "once" },
        enabled: true,
      },
    },
    config: CONFIG,
    nowUs: Date.UTC(2025, 10, 2, 5, 30, 0) * 1000, // virtual clock
  };
}

function day(expression: string, localDate: string, opts: { gap?: "shift_by_gap" | "skip"; fold?: "earlier" | "later" | "both" } = {}) {
  return evaluateCronDay({
    expression,
    timezone: ZONE,
    dstGapPolicy: opts.gap ?? "shift_by_gap",
    dstFoldPolicy: opts.fold ?? "earlier",
    alarmId: ALARM_ID,
    alarmRevision: 4,
    localDate,
  });
}

describe("DST fold at 2025-11-02 01:30 (America/New_York-2025a)", () => {
  const FOLD = "30 1 2 11 *"; // 01:30, day 2 month 11
  it("earlier fires the first instant with ordinal 0", () => {
    const { occurrences } = day(FOLD, "2025-11-02", { fold: "earlier" });
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.utc).toBe("2025-11-02T05:30:00.000000Z");
    expect(occurrences[0]!.fold_ordinal).toBe(0);
  });
  it("later fires the second instant with ordinal 1", () => {
    const { occurrences } = day(FOLD, "2025-11-02", { fold: "later" });
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.utc).toBe("2025-11-02T06:30:00.000000Z");
    expect(occurrences[0]!.fold_ordinal).toBe(1);
  });
  it("both fires two distinct occurrences ascending", () => {
    const { occurrences } = day(FOLD, "2025-11-02", { fold: "both" });
    expect(occurrences).toHaveLength(2);
    expect(occurrences[0]!.utc).toBe("2025-11-02T05:30:00.000000Z");
    expect(occurrences[1]!.utc).toBe("2025-11-02T06:30:00.000000Z");
  });
});

describe("DST gap at 2025-03-09 02:30 (America/New_York-2025a)", () => {
  const GAP = "30 2 9 3 *"; // 02:30, day 9 month 3
  it("shift_by_gap adds the exact gap duration", () => {
    const { occurrences } = day(GAP, "2025-03-09", { gap: "shift_by_gap" });
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.utc).toBe("2025-03-09T07:30:00.000000Z");
    expect(occurrences[0]!.fold_ordinal).toBe(0);
  });
  it("skip yields no occurrence", () => {
    const { occurrences } = day(GAP, "2025-03-09", { gap: "skip" });
    expect(occurrences).toHaveLength(0);
  });
});

describe("typed failures", () => {
  it("unknown zone -> NONEXISTENT_TIMEZONE", () => {
    expect(() =>
      evaluateCronDay({
        expression: "30 1 2 11 *",
        timezone: "Europe/Nope-0000x",
        alarmId: ALARM_ID,
        alarmRevision: 4,
        localDate: "2025-11-02",
      }),
    ).toThrowError(expect.objectContaining({ code: "NONEXISTENT_TIMEZONE" }));
  });

  it("invalid cron (six fields) -> INVALID_SCHEDULE", () => {
    expect(() =>
      evaluateCronDay({
        expression: "0 0 1 1 * 0",
        timezone: ZONE,
        alarmId: ALARM_ID,
        alarmRevision: 1,
        localDate: "2025-11-02",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_SCHEDULE" }));
  });

  it("impossible date -> INVALID_SCHEDULE", () => {
    expect(() => day("30 1 2 11 *", "2025-02-29")).toThrowError(
      expect.objectContaining({ code: "INVALID_SCHEDULE" }),
    );
  });

  it("once (non-existent) timestamp without offset -> INVALID_SCHEDULE", () => {
    const input = baseInput();
    input.action.arguments.schedule = { kind: "once", at: "2025-11-02T01:30:00" };
    expect(() => normalizeCreate(input)).toThrowError(
      expect.objectContaining({ code: "INVALID_SCHEDULE" }),
    );
  });

  it("leap-second timestamp -> INVALID_SCHEDULE", () => {
    const input = baseInput();
    input.action.arguments.schedule = { kind: "once", at: "2025-11-02T01:30:60Z" };
    expect(() => normalizeCreate(input)).toThrowError(
      expect.objectContaining({ code: "INVALID_SCHEDULE" }),
    );
  });

  it("repeat_interval_seconds out of range -> REPEAT_INTERVAL", () => {
    const input = baseInput();
    input.action.arguments.delivery = { mode: "repeat_until_acknowledged", repeat_interval_seconds: 0 };
    expect(() => normalizeCreate(input)).toThrowError(
      expect.objectContaining({ code: "REPEAT_INTERVAL" }),
    );
  });
});

describe("normalizeCreate materialization", () => {
  const input = baseInput();

  it("is idempotent: same virtual clock yields byte-identical records", () => {
    const first = normalizeCreate(baseInput());
    const second = normalizeCreate(baseInput());
    expect(JSON.stringify(first.record)).toBe(JSON.stringify(second.record));
    expect(first.record).toEqual(second.record);
  });

  it("records durable schedule, policies, and a concrete next occurrence", () => {
    const record = normalizeCreate(input).record;
    expect(record.alarm_id).toBe(ALARM_ID);
    expect(record.revision).toBe(1);
    expect(record.schedule).toEqual({
      kind: "cron_v1",
      expression: "30 9 * * *",
      timezone: "America/New_York",
    });
    expect(record.misfire_policy).toBe("skip");
    expect(record.dst_gap_policy).toBe("shift_by_gap");
    expect(record.dst_fold_policy).toBe("earlier");
    expect(record.created_at).toBe("2025-11-02T05:30:00.000000Z");
    // 09:30 on 2025-11-02 is after the 02:00 fall-back, so it is EST
    // (09:30 + 05:00 = 14:30Z), the first occurrence after the virtual clock.
    expect(record.next_occurrence).toBe("2025-11-02T14:30:00.000000Z");
  });

  it("nulls next_occurrence when the once instant is past", () => {
    const past = baseInput();
    past.action.arguments.schedule = { kind: "once", at: "2025-01-01T00:00:00Z" };
    const record = normalizeCreate(past).record;
    expect(record.next_occurrence).toBeNull();
    expect(record.schedule).toEqual({ kind: "once", at: "2025-01-01T00:00:00.000000Z" });
  });

  it("normalizes an offset timestamp to canonical core instant", () => {
    const shifted = baseInput();
    shifted.action.arguments.schedule = { kind: "once", at: "2025-11-02T07:30:00+02:00" };
    const record = normalizeCreate(shifted).record;
    expect(record.schedule).toEqual({ kind: "once", at: "2025-11-02T05:30:00.000000Z" });
  });
});

describe("deterministic list ordering", () => {
  function makeRecord(alarmId: string, next: string | null): AlarmRecord {
    return {
      alarm_id: alarmId,
      revision: 1,
      title: "x",
      schedule: { kind: "cron_v1", expression: "0 0 * * *", timezone: "America/New_York" },
      delivery: { mode: "once" },
      misfire_policy: "skip",
      dst_gap_policy: "shift_by_gap",
      dst_fold_policy: "earlier",
      enabled: true,
      created_at: "2025-01-01T00:00:00.000000Z",
      next_occurrence: next,
      tzdb_revision: "2025a",
    };
  }

  it("orders ascending, nulls last, bytewise alarm_id tie-break", () => {
    const late = makeRecord("019535d4-6f00-7a2c-9b31-8e11d2345001", "2025-12-31T00:00:00.000000Z");
    const nullB = makeRecord("019535d4-6f00-7a2c-9b31-8e11d2345002", null);
    const nullA = makeRecord("019525d4-6f00-7a2c-9b31-8e11d2345003", null);
    const early = makeRecord("019545d4-6f00-7a2c-9b31-8e11d2345004", "2025-01-01T00:00:00.000000Z");
    const ordered = orderRecordsForList([late, nullB, nullA, early]);
    expect(ordered.map((r) => r.alarm_id)).toEqual([
      "019545d4-6f00-7a2c-9b31-8e11d2345004",
      "019535d4-6f00-7a2c-9b31-8e11d2345001",
      "019525d4-6f00-7a2c-9b31-8e11d2345003",
      "019535d4-6f00-7a2c-9b31-8e11d2345002",
    ]);
  });

  it("breaks equal next_occurrence on bytewise alarm_id", () => {
    const higher = makeRecord("019535d4-6f00-7a2c-9b31-8e11d2345010", "2025-06-01T00:00:00.000000Z");
    const lower = makeRecord("019535d4-6f00-7a2c-9b31-8e11d2345009", "2025-06-01T00:00:00.000000Z");
    const ordered = orderRecordsForList([higher, lower]);
    expect(ordered[0]!.alarm_id).toBe("019535d4-6f00-7a2c-9b31-8e11d2345009");
  });
});
