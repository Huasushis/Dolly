/**
 * Durable effect evidence.
 *
 * Architecture Decision Record 0009 requires an effect intent to be persisted
 * with a stable idempotency key before the input/output, and states that an
 * in-memory duplicate map is not restart evidence. These tests fix the one
 * question the journal exists to answer: after a crash, did any effect of this
 * Run cross its boundary, and is its outcome known?
 *
 * The safety rule is one-sided. Absence of a record means no effect was ever
 * authorized, and that is sound only because the intent is written first. Every
 * state that is not provably safe answers `unknown`, which preserves the Claim.
 */
import { describe, expect, it } from "vitest";
import {
  EffectIntentError,
  EffectIntentJournal,
  type EffectIntentRecord,
  type EffectIntentStore,
} from "../../../src/core/capabilities/effect-intent-journal.js";

const NOW = "2026-07-26T00:00:00.000Z";
const LATER = "2026-07-26T00:00:05.000Z";

/**
 * A store whose contents can be handed to a fresh journal, which is what a
 * Core restart looks like from the journal's point of view.
 */
function store(): EffectIntentStore & { readonly records: EffectIntentRecord[] } {
  const records: EffectIntentRecord[] = [];
  return {
    records,
    list: () => records,
    put(record) {
      const index = records.findIndex(
        (existing) =>
          existing.moduleJobId === record.moduleJobId &&
          existing.idempotencyKey === record.idempotencyKey,
      );
      if (index >= 0) records[index] = record;
      else records.push(record);
    },
  };
}

function intent(overrides: Record<string, unknown> = {}) {
  return {
    moduleJobId: "module-job-1",
    runId: "run-1",
    attempt: 1,
    claimToken: "claim-token-1",
    idempotencyKey: "module-job-1:send-message",
    capabilityType: "outbound-http",
    operation: "post",
    intent: { url: "https://example.invalid/messages" },
    ...overrides,
  } as Parameters<EffectIntentJournal["recordIntent"]>[0];
}

describe("durable effect intent journal", () => {
  it("treats a Run with no recorded intent as having caused no effect", () => {
    const journal = new EffectIntentJournal({ store: store(), now: () => NOW });
    expect(journal.evidenceForRun("module-job-1", "run-1")).toEqual({ kind: "no-effect" });
  });

  it("reports an unknown outcome when the intent survives a crash unsettled", () => {
    const backing = store();
    const journal = new EffectIntentJournal({ store: backing, now: () => NOW });
    journal.recordIntent(intent());

    // The crash: a fresh journal over the same durable records, with nothing
    // carried over in memory.
    const afterRestart = new EffectIntentJournal({ store: backing, now: () => LATER });
    const evidence = afterRestart.evidenceForRun("module-job-1", "run-1");
    expect(evidence.kind).toBe("unknown");
    if (evidence.kind !== "unknown") throw new Error("expected an unknown outcome");
    expect(evidence.reason).toContain("outbound-http/post");
  });

  it("reports no effect once every intent is settled as no-effect", () => {
    const backing = store();
    const journal = new EffectIntentJournal({ store: backing, now: () => NOW });
    journal.recordIntent(intent());
    journal.recordOutcome("module-job-1", "module-job-1:send-message", {
      kind: "no-effect",
      detail: "the request was refused before it was sent",
    });

    expect(
      new EffectIntentJournal({ store: backing, now: () => LATER }).evidenceForRun(
        "module-job-1",
        "run-1",
      ),
    ).toEqual({ kind: "no-effect" });
  });

  it("reports a terminal outcome once every intent has a durable result", () => {
    const backing = store();
    const journal = new EffectIntentJournal({ store: backing, now: () => NOW });
    journal.recordIntent(intent());
    journal.recordOutcome("module-job-1", "module-job-1:send-message", {
      kind: "terminal",
      resultDigest: `sha256:${"a".repeat(64)}`,
    });

    expect(
      new EffectIntentJournal({ store: backing, now: () => LATER }).evidenceForRun(
        "module-job-1",
        "run-1",
      ),
    ).toEqual({ kind: "terminal" });
  });

  it("keeps a Run unknown when any one of several intents is unsettled", () => {
    const backing = store();
    const journal = new EffectIntentJournal({ store: backing, now: () => NOW });
    journal.recordIntent(intent());
    journal.recordIntent(intent({ idempotencyKey: "module-job-1:store-result" }));
    journal.recordOutcome("module-job-1", "module-job-1:send-message", {
      kind: "terminal",
      resultDigest: `sha256:${"b".repeat(64)}`,
    });

    // One settled effect does not make the Run safe while another is open.
    const evidence = journal.evidenceForRun("module-job-1", "run-1");
    expect(evidence.kind).toBe("unknown");
  });

  it("keeps a Run unknown when a provider reported an unknown result", () => {
    const backing = store();
    const journal = new EffectIntentJournal({ store: backing, now: () => NOW });
    journal.recordIntent(intent());
    journal.recordOutcome("module-job-1", "module-job-1:send-message", {
      kind: "unknown",
      reason: "the response was lost after the request was accepted",
    });

    const evidence = journal.evidenceForRun("module-job-1", "run-1");
    expect(evidence.kind).toBe("unknown");
    if (evidence.kind !== "unknown") throw new Error("expected an unknown outcome");
    expect(evidence.reason).toContain("response was lost");
  });

  it("keeps evidence linked to the exact Run, not to the Module job alone", () => {
    const backing = store();
    const journal = new EffectIntentJournal({ store: backing, now: () => NOW });
    journal.recordIntent(intent());

    // A retry keeps the Module job identifier and receives a new Run. The
    // earlier Run's unresolved effect must not make the retry look unsafe, and
    // must not disappear either.
    expect(journal.evidenceForRun("module-job-1", "run-2")).toEqual({ kind: "no-effect" });
    expect(journal.evidenceForRun("module-job-1", "run-1").kind).toBe("unknown");
  });

  it("refuses to reuse one idempotency key for a different effect", () => {
    const journal = new EffectIntentJournal({ store: store(), now: () => NOW });
    journal.recordIntent(intent());

    expect(() =>
      journal.recordIntent(intent({ intent: { url: "https://elsewhere.invalid/" } })),
    ).toThrowError(
      expect.objectContaining<Partial<EffectIntentError>>({
        code: "EFFECT_INTENT_CONFLICT",
      }),
    );
  });

  it("returns the existing record when the same effect is recorded again", () => {
    const backing = store();
    const journal = new EffectIntentJournal({ store: backing, now: () => NOW });
    const first = journal.recordIntent(intent());
    const second = journal.recordIntent(intent());
    expect(second).toEqual(first);
    expect(backing.records).toHaveLength(1);
  });

  it("refuses an outcome for an intent that was never recorded", () => {
    const journal = new EffectIntentJournal({ store: store(), now: () => NOW });
    expect(() =>
      journal.recordOutcome("module-job-1", "never-recorded", {
        kind: "no-effect",
        detail: "nothing happened",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<EffectIntentError>>({
        code: "EFFECT_INTENT_NOT_FOUND",
      }),
    );
  });

  it("refuses a terminal outcome without a result digest and an empty reason", () => {
    const journal = new EffectIntentJournal({ store: store(), now: () => NOW });
    journal.recordIntent(intent());
    expect(() =>
      journal.recordOutcome("module-job-1", "module-job-1:send-message", {
        kind: "terminal",
        resultDigest: "not-a-digest",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<EffectIntentError>>({
        code: "EFFECT_INTENT_OUTCOME_INVALID",
      }),
    );
    expect(() =>
      journal.recordOutcome("module-job-1", "module-job-1:send-message", {
        kind: "unknown",
        reason: "",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<EffectIntentError>>({
        code: "EFFECT_INTENT_OUTCOME_INVALID",
      }),
    );
  });

  it("drives startup recovery through the evidence source it exposes", async () => {
    const { effectIntentEvidenceSource } = await import(
      "../../../src/core/capabilities/effect-intent-journal.js"
    );
    const backing = store();
    const journal = new EffectIntentJournal({ store: backing, now: () => NOW });
    journal.recordIntent(intent());
    const source = effectIntentEvidenceSource(journal);

    // Unsettled: recovery must be told the outcome is unknown, which is what
    // makes it preserve the Claim instead of releasing or retrying it.
    const unsettled = await source.inspectRunEffects({
      moduleJobId: "module-job-1",
      runId: "run-1",
    });
    expect(unsettled.kind).toBe("unknown");

    journal.recordOutcome("module-job-1", "module-job-1:send-message", {
      kind: "no-effect",
      detail: "the provider refused the request before it was sent",
    });
    const settled = await source.inspectRunEffects({
      moduleJobId: "module-job-1",
      runId: "run-1",
    });
    expect(settled).toEqual({ kind: "no-effect" });
  });

  it("stores no argument values, response payload, or credential", () => {
    const backing = store();
    const journal = new EffectIntentJournal({ store: backing, now: () => NOW });
    journal.recordIntent(
      intent({
        intent: {
          url: "https://example.invalid/messages",
          authorization: "Bearer super-secret-token",
          body: "user content that must not be journalled",
        },
      }),
    );

    const serialized = JSON.stringify(backing.records);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("user content");
    expect(serialized).not.toContain("example.invalid");
    // The digest still distinguishes a different intent under the same key.
    expect(backing.records[0]!.intentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
