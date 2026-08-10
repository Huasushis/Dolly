/**
 * Durable effect evidence.
 *
 * Architecture Decision Record 0009 requires an effect intent to be persisted
 * with a stable idempotency key before the input/output, and states that an
 * in-memory duplicate map is not restart evidence. These tests fix the one
 * question the journal exists to answer: after a crash, did any effect of this
 * Run cross its boundary, and is its outcome known?
 *
 * The safety rule is one-sided. Until the product binds this journal to the
 * product code path that authorizes every external effect, an absent record
 * cannot prove that no effect was authorized. Every state that is not provably
 * safe answers `unknown`, which preserves the Claim.
 */
import { describe, expect, it } from "vitest";
import {
  EffectIntentError,
  EffectIntentJournal,
  type EffectIntentRecord,
  type EffectIntentStore,
} from "../../../src/core/capabilities/effect-intent-journal.js";
import type { DeliveryClaimIdentity } from "../../../src/core/delivery-store.js";
import type { ModuleSubmissionRecord } from "../../../src/core/module-process-records.js";

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
    compareAndSet(expected, replacement) {
      const index = records.findIndex(
        (existing) =>
          existing.moduleJobId === replacement.moduleJobId &&
          existing.idempotencyKey === replacement.idempotencyKey &&
          existing.runId === replacement.runId &&
          existing.attempt === replacement.attempt &&
          existing.claimToken === replacement.claimToken &&
          existing.moduleGenerationId === replacement.moduleGenerationId,
      );
      if (expected === undefined) {
        if (index >= 0) return false;
        records.push(replacement);
        return true;
      }
      if (
        index < 0 ||
        JSON.stringify(records[index]) !== JSON.stringify(expected)
      ) {
        return false;
      }
      records[index] = replacement;
      return true;
    },
  };
}

function claim(
  overrides: Partial<DeliveryClaimIdentity> = {},
): DeliveryClaimIdentity {
  return {
    moduleJobId: "module-job-1",
    runId: "run-1",
    attempt: 1,
    claimToken: "claim-token-1",
    moduleGenerationId: "module-generation-1",
    ...overrides,
  };
}

function submission(
  overrides: Partial<ModuleSubmissionRecord> = {},
): ModuleSubmissionRecord {
  return {
    schemaVersion: "dolly.module-submission-record/1",
    ...claim(),
    processGenerationId: "process-generation-1",
    inputDigest: `sha256:${"f".repeat(64)}`,
    createdAt: NOW,
    ...overrides,
  };
}

function intent(overrides: Record<string, unknown> = {}) {
  return {
    ...claim(),
    idempotencyKey: "module-job-1:send-message",
    capabilityType: "outbound-http",
    operation: "post",
    intent: { url: "https://example.invalid/messages" },
    ...overrides,
  } as Parameters<EffectIntentJournal["recordIntent"]>[0];
}

describe("effect intent record protocol", () => {
  it("keeps a Run unknown when no exact intent is recorded", () => {
    const journal = new EffectIntentJournal({ store: store(), now: () => NOW });
    const evidence = journal.evidenceForRun(claim());
    expect(evidence.kind).toBe("unknown");
    if (evidence.kind !== "unknown") throw new Error("expected an unknown outcome");
    expect(evidence.reason).toContain("No exact effect intent is recorded");
  });

  it("reports an unknown outcome when the intent survives a crash unsettled", () => {
    const backing = store();
    const journal = new EffectIntentJournal({ store: backing, now: () => NOW });
    journal.recordIntent(intent());

    // The crash: a fresh journal over the same durable records, with nothing
    // carried over in memory.
    const afterRestart = new EffectIntentJournal({ store: backing, now: () => LATER });
    const evidence = afterRestart.evidenceForRun(claim());
    expect(evidence.kind).toBe("unknown");
    if (evidence.kind !== "unknown") throw new Error("expected an unknown outcome");
    expect(evidence.reason).toContain("outbound-http/post");
  });

  it("keeps a Run unknown even when every recorded intent is settled as no-effect", () => {
    const backing = store();
    const journal = new EffectIntentJournal({ store: backing, now: () => NOW });
    journal.recordIntent(intent());
    journal.recordIntent(intent({ idempotencyKey: "module-job-1:store-result" }));
    journal.recordOutcome(claim(), "module-job-1:send-message", {
      kind: "no-effect",
      detail: "the request was refused before it was sent",
    });
    journal.recordOutcome(claim(), "module-job-1:store-result", {
      kind: "no-effect",
      detail: "the write was refused before it started",
    });

    expect(
      new EffectIntentJournal({ store: backing, now: () => LATER }).evidenceForRun(
        claim(),
      ).kind,
    ).toBe("unknown");
  });

  it("does not let one recorded no-effect exclude another unrecorded effect", () => {
    const journal = new EffectIntentJournal({ store: store(), now: () => NOW });
    journal.recordIntent(intent());
    journal.recordOutcome(claim(), "module-job-1:send-message", {
      kind: "no-effect",
      detail: "the recorded request was refused before it was sent",
    });

    // The journal has no Run-level completeness record. This one safe
    // operation therefore cannot prove that no other operation occurred.
    const evidence = journal.evidenceForRun(claim());
    expect(evidence.kind).toBe("unknown");
  });

  it("reports a terminal outcome once every intent has a durable result", () => {
    const backing = store();
    const journal = new EffectIntentJournal({ store: backing, now: () => NOW });
    journal.recordIntent(intent());
    journal.recordOutcome(claim(), "module-job-1:send-message", {
      kind: "terminal",
      resultDigest: `sha256:${"a".repeat(64)}`,
    });

    expect(
      new EffectIntentJournal({ store: backing, now: () => LATER }).evidenceForRun(
        claim(),
      ),
    ).toEqual({ kind: "terminal" });
  });

  it("keeps a Run unknown when any one of several intents is unsettled", () => {
    const backing = store();
    const journal = new EffectIntentJournal({ store: backing, now: () => NOW });
    journal.recordIntent(intent());
    journal.recordIntent(intent({ idempotencyKey: "module-job-1:store-result" }));
    journal.recordOutcome(claim(), "module-job-1:send-message", {
      kind: "terminal",
      resultDigest: `sha256:${"b".repeat(64)}`,
    });

    // One settled effect does not make the Run safe while another is open.
    const evidence = journal.evidenceForRun(claim());
    expect(evidence.kind).toBe("unknown");
  });

  it("keeps a Run unknown when a provider reported an unknown result", () => {
    const backing = store();
    const journal = new EffectIntentJournal({ store: backing, now: () => NOW });
    journal.recordIntent(intent());
    journal.recordOutcome(claim(), "module-job-1:send-message", {
      kind: "unknown",
      reason: "the response was lost after the request was accepted",
    });

    const evidence = journal.evidenceForRun(claim());
    expect(evidence.kind).toBe("unknown");
    if (evidence.kind !== "unknown") throw new Error("expected an unknown outcome");
    expect(evidence.reason).toContain("response was lost");
  });

  it.each([
    ["claim token", { claimToken: "foreign-claim-token" }],
    ["attempt", { attempt: 2 }],
    ["Module generation", { moduleGenerationId: "module-generation-2" }],
  ] satisfies ReadonlyArray<
    readonly [string, Partial<DeliveryClaimIdentity>]
  >)(
    "does not use evidence from a foreign %s with the same Module job and Run",
    (_field, foreignIdentity) => {
      const backing = store();
      const journal = new EffectIntentJournal({ store: backing, now: () => NOW });
      journal.recordIntent(intent());
      journal.recordOutcome(claim(), "module-job-1:send-message", {
        kind: "terminal",
        resultDigest: `sha256:${"9".repeat(64)}`,
      });

      const foreignClaim = claim(foreignIdentity);
      expect(foreignClaim.moduleJobId).toBe("module-job-1");
      expect(foreignClaim.runId).toBe("run-1");
      expect(journal.listForRun(foreignClaim)).toEqual([]);
      expect(journal.evidenceForRun(foreignClaim).kind).toBe("unknown");
      expect(journal.evidenceForRun(claim())).toEqual({ kind: "terminal" });
    },
  );

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

  it("records one stable effect separately for a retry Run", () => {
    const backing = store();
    const journal = new EffectIntentJournal({ store: backing, now: () => NOW });
    const first = journal.recordIntent(intent());
    const retryIdentity = claim({
      runId: "run-2",
      attempt: 2,
      claimToken: "claim-token-2",
      moduleGenerationId: "module-generation-2",
    });
    const retry = journal.recordIntent(intent({ ...retryIdentity }));

    expect(backing.records).toHaveLength(2);
    expect(first.idempotencyKey).toBe(retry.idempotencyKey);
    expect(first.intentDigest).toBe(retry.intentDigest);
    expect(journal.listForRun(claim())).toEqual([first]);
    expect(journal.listForRun(retryIdentity)).toEqual([retry]);

    journal.recordOutcome(claim(), first.idempotencyKey, {
      kind: "terminal",
      resultDigest: `sha256:${"8".repeat(64)}`,
    });
    expect(journal.evidenceForRun(claim())).toEqual({ kind: "terminal" });
    expect(journal.evidenceForRun(retryIdentity).kind).toBe("unknown");
  });

  it("still refuses a different intent under a stable key in a retry Run", () => {
    const journal = new EffectIntentJournal({ store: store(), now: () => NOW });
    journal.recordIntent(intent());
    expect(() => journal.recordIntent(intent({
      runId: "run-2",
      attempt: 2,
      claimToken: "claim-token-2",
      intent: { url: "https://elsewhere.invalid/" },
    }))).toThrowError(
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
    expect(first.schemaVersion).toBe("dolly.effect-intent/2");
    expect(backing.records).toHaveLength(1);
  });

  it("refuses an outcome for an intent that was never recorded", () => {
    const journal = new EffectIntentJournal({ store: store(), now: () => NOW });
    expect(() =>
      journal.recordOutcome(claim(), "never-recorded", {
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
      journal.recordOutcome(claim(), "module-job-1:send-message", {
        kind: "terminal",
        resultDigest: "not-a-digest",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<EffectIntentError>>({
        code: "EFFECT_INTENT_OUTCOME_INVALID",
      }),
    );
    expect(() =>
      journal.recordOutcome(claim(), "module-job-1:send-message", {
        kind: "unknown",
        reason: "",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<EffectIntentError>>({
        code: "EFFECT_INTENT_OUTCOME_INVALID",
      }),
    );
  });

  it("refuses to rewrite a terminal outcome as no-effect", () => {
    const journal = new EffectIntentJournal({ store: store(), now: () => NOW });
    journal.recordIntent(intent());
    journal.recordOutcome(claim(), "module-job-1:send-message", {
      kind: "terminal",
      resultDigest: `sha256:${"c".repeat(64)}`,
    });

    expect(() =>
      journal.recordOutcome(claim(), "module-job-1:send-message", {
        kind: "no-effect",
        detail: "a contradictory later report",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<EffectIntentError>>({
        code: "EFFECT_INTENT_CONFLICT",
      }),
    );
  });

  it("refuses to rewrite a no-effect outcome as terminal", () => {
    const journal = new EffectIntentJournal({ store: store(), now: () => NOW });
    journal.recordIntent(intent());
    journal.recordOutcome(claim(), "module-job-1:send-message", {
      kind: "no-effect",
      detail: "the operation did not cross its effect boundary",
    });

    expect(() =>
      journal.recordOutcome(claim(), "module-job-1:send-message", {
        kind: "terminal",
        resultDigest: `sha256:${"d".repeat(64)}`,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<EffectIntentError>>({
        code: "EFFECT_INTENT_CONFLICT",
      }),
    );
  });

  it.each([
    [
      "no-effect",
      {
        kind: "no-effect",
        detail: "the provider later proved that it refused the operation",
      },
      "unknown",
    ],
    [
      "terminal",
      {
        kind: "terminal",
        resultDigest: `sha256:${"e".repeat(64)}`,
      },
      "terminal",
    ],
  ] as const)(
    "allows an unknown outcome to converge to %s and accepts the same final outcome again",
    (_kind, finalOutcome, expectedEvidenceKind) => {
      const backing = store();
      const journal = new EffectIntentJournal({ store: backing, now: () => NOW });
      journal.recordIntent(intent());
      journal.recordOutcome(claim(), "module-job-1:send-message", {
        kind: "unknown",
        reason: "the first response was inconclusive",
      });

      const first = journal.recordOutcome(
        claim(),
        "module-job-1:send-message",
        finalOutcome,
      );
      const second = journal.recordOutcome(
        claim(),
        "module-job-1:send-message",
        finalOutcome,
      );

      expect(second).toBe(first);
      expect(backing.records).toHaveLength(1);
      expect(journal.evidenceForRun(claim()).kind).toBe(expectedEvidenceKind);
    },
  );

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
    const unsettled = await source.inspectRunEffects(submission());
    expect(unsettled.kind).toBe("unknown");

    journal.recordOutcome(claim(), "module-job-1:send-message", {
      kind: "no-effect",
      detail: "the provider refused the request before it was sent",
    });
    const settled = await source.inspectRunEffects(submission());
    expect(settled.kind).toBe("unknown");
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
