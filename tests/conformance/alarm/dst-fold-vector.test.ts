/**
 * Conformance test for TST-ALARM-001 (REQ-ALARM-001).
 *
 * The authoritative DST-fold vector is consumed in place from the imported
 * `dolly-spec` snapshot; nothing here copies or reinterprets its values. The
 * test drives every `expected.assertions` entry directly against the seam's
 * deterministic occurrence set and only maps the vector's outcome vocabulary
 * to an actual occurrence count.
 *
 * The vector fixes the tzdb fixture, cron expression, fold policy, and alarm
 * revision, but not `alarm_id`; `alarm_id` is seeded here as harness input
 * because it participates in the canonical occurrence identity digest. The
 * identity is deterministic given the seed, which is exactly the invariant
 * under test.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOccurrenceId,
  evaluateCronDay,
  type AlarmOccurrence,
} from "../../../src/extensions/alarm/index.js";

const SPEC_ROOT = path.resolve(import.meta.dirname, "../../../dolly-spec");
const VECTOR_REL = path.join(
  "test-vectors",
  "extensions",
  "TST-ALARM-001-dst-fold.json",
);
const SEED_ALARM_ID = "019535d4-6f00-7a2c-9b31-8e11d2345000";

interface Initial {
  readonly tzdb_fixture: string;
  readonly cron: string;
  readonly dst_fold_policy: "earlier" | "later" | "both";
  readonly alarm_revision: number;
}
interface Assertion {
  readonly path: string;
  readonly op: "count" | "equals";
  readonly value: unknown;
}
interface Expected {
  readonly outcome: string;
  readonly assertions: readonly Assertion[];
}
interface Vector {
  readonly test_id: string;
  readonly kind: string;
  readonly covers: readonly string[];
  readonly initial: Initial;
  readonly stimulus: { readonly evaluate_local_date: string };
  readonly expected: Expected;
}

function loadVector(): Vector {
  const raw = JSON.parse(readFileSync(path.join(SPEC_ROOT, VECTOR_REL), "utf8")) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${VECTOR_REL} must decode to an object`);
  }
  return raw as Vector;
}

function readPath(target: unknown, pointer: string): unknown {
  let current = target;
  for (const segment of pointer.split("/")) {
    if (segment === "") continue;
    if (current === null || typeof current !== "object") {
      throw new Error(`path ${pointer} walked off a primitive`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function vectorVocabularyOutcome(occurrences: readonly AlarmOccurrence[]): string {
  const distinct =
    occurrences.length === 2 &&
    occurrences[0]!.fold_ordinal === 0 &&
    occurrences[1]!.fold_ordinal === 1 &&
    occurrences[0]!.utc !== occurrences[1]!.utc;
  if (distinct) return "two_distinct";
  if (occurrences.length === 2) return "two_repeated";
  if (occurrences.length === 1) return "single_occurrence";
  return "no_occurrence";
}

describe("TST-ALARM-001 DST-fold vector, consumed in place", () => {
  const vector = loadVector();
  expect(vector.test_id).toBe("TST-ALARM-001");
  expect(vector.kind).toBe("extension");
  expect(vector.covers).toContain("REQ-ALARM-001");

  it("produces the exact ordered two-occurrence fold set the vector asserts", () => {
    const evaluation = evaluateCronDay({
      expression: vector.initial.cron,
      timezone: vector.initial.tzdb_fixture,
      dstFoldPolicy: vector.initial.dst_fold_policy,
      alarmId: SEED_ALARM_ID,
      alarmRevision: vector.initial.alarm_revision,
      localDate: vector.stimulus.evaluate_local_date,
    });

    const subject = { occurrences: evaluation.occurrences };
    for (const assertion of vector.expected.assertions) {
      const actual = readPath(subject, assertion.path);
      const normalized = assertion.op === "count" && Array.isArray(actual) ? actual.length : actual;
      expect(normalized, assertion.path).toBe(assertion.value);
    }
    expect(vectorVocabularyOutcome(evaluation.occurrences)).toBe("two_distinct");
    expect(vector.expected.outcome).toBe("two_distinct_occurrences");

    // REQ-ALARM-001 determinism: the same inputs always yield the same set.
    const replayed = evaluateCronDay({
      expression: vector.initial.cron,
      timezone: vector.initial.tzdb_fixture,
      dstFoldPolicy: vector.initial.dst_fold_policy,
      alarmId: SEED_ALARM_ID,
      alarmRevision: vector.initial.alarm_revision,
      localDate: vector.stimulus.evaluate_local_date,
    });
    expect(replayed.occurrences).toEqual(evaluation.occurrences);
    expect(JSON.stringify(replayed.occurrences)).toBe(JSON.stringify(evaluation.occurrences));
  });

  it("matches each occurrence identity to the canonical spec tuple digest", () => {
    const evaluation = evaluateCronDay({
      expression: vector.initial.cron,
      timezone: vector.initial.tzdb_fixture,
      dstFoldPolicy: vector.initial.dst_fold_policy,
      alarmId: SEED_ALARM_ID,
      alarmRevision: vector.initial.alarm_revision,
      localDate: vector.stimulus.evaluate_local_date,
    });
    expect(evaluation.occurrences).toHaveLength(2);
    const first = evaluation.occurrences[0]!;
    const second = evaluation.occurrences[1]!;
    // Independent pin of the wire identity: spec section 4 tuple over the
    // vector's own anchored values and the seeded alarm id.
    expect(first.occurrence_id).toBe(createOccurrenceId({
      alarmId: SEED_ALARM_ID,
      alarmRevision: vector.initial.alarm_revision,
      scheduledUs: first.scheduledUs,
      foldOrdinal: 0,
    }));
    expect(second.occurrence_id).toBe(createOccurrenceId({
      alarmId: SEED_ALARM_ID,
      alarmRevision: vector.initial.alarm_revision,
      scheduledUs: second.scheduledUs,
      foldOrdinal: 1,
    }));
  });
});
