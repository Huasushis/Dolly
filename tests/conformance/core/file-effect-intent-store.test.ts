import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EffectIntentError,
  EffectIntentJournal,
  type EffectIntentRecord,
} from "../../../src/core/capabilities/effect-intent-journal.js";
import { FileEffectIntentStore } from "../../../src/core/capabilities/file-effect-intent-store.js";
import type { DeliveryClaimIdentity } from "../../../src/core/delivery-store.js";

const NOW = "2026-08-10T00:00:00.000Z";
const LATER = "2026-08-10T00:00:05.000Z";

function claim(
  overrides: Partial<DeliveryClaimIdentity> = {},
): DeliveryClaimIdentity {
  return {
    moduleJobId: "module-job-file-effect",
    runId: "run-file-effect-1",
    attempt: 1,
    claimToken: "claim-file-effect-1",
    moduleGenerationId: "module-generation-file-effect-1",
    ...overrides,
  };
}

function intent(
  identity: DeliveryClaimIdentity = claim(),
): Parameters<EffectIntentJournal["recordIntent"]>[0] {
  return {
    ...identity,
    idempotencyKey: "module-job-file-effect:provider-call",
    capabilityType: "model-operation",
    operation: "chat",
    intent: {
      descriptorDigest: `sha256:${"a".repeat(64)}`,
      inputDigest: `sha256:${"b".repeat(64)}`,
    },
  };
}

function scratchTest(
  run: (root: string) => void | Promise<void>,
): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-file-effect-intent-"));
    try {
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

describe("file effect intent store", () => {
  it("survives restart when a no-effect record permits a retry Run", scratchTest((root) => {
    const path = join(root, "effect-intents.json");
    const store = new FileEffectIntentStore({ path });
    const journal = new EffectIntentJournal({ store, now: () => NOW });
    journal.openRun(claim());
    const first = journal.recordIntent(intent());
    journal.recordOutcome(claim(), first.idempotencyKey, {
      kind: "no-effect",
      detail: "the provider request was rejected before transmission",
    });
    journal.closeRun(claim());
    const retry = claim({
      runId: "run-file-effect-2",
      attempt: 2,
      claimToken: "claim-file-effect-2",
      moduleGenerationId: "module-generation-file-effect-2",
    });
    journal.openRun(retry);
    journal.recordIntent(intent(retry));

    const reopenedStore = new FileEffectIntentStore({ path });
    const reopened = new EffectIntentJournal({
      store: reopenedStore,
      now: () => LATER,
    });
    expect(reopenedStore.list()).toHaveLength(2);
    expect(reopened.evidenceForRun(claim())).toEqual({ kind: "no-effect" });
    expect(reopened.evidenceForRun(retry)).toMatchObject({ kind: "unknown" });
    expect(readFileSync(path, "utf8")).toMatch(
      /^\{"records":\[.*\],"revision":6,"runs":\[.*\],"schemaVersion":"dolly.effect-intent-store\/2"\}\n$/u,
    );
  }));

  it("atomically refuses a second unsettled stable effect in another Run", scratchTest((root) => {
    const path = join(root, "effect-intents.json");
    const firstStore = new FileEffectIntentStore({ path });
    const firstJournal = new EffectIntentJournal({ store: firstStore, now: () => NOW });
    firstJournal.openRun(claim());
    const first = firstJournal.recordIntent(intent());
    const retry = claim({
      runId: "run-file-effect-2",
      attempt: 2,
      claimToken: "claim-file-effect-2",
      moduleGenerationId: "module-generation-file-effect-2",
    });
    const secondStore = new FileEffectIntentStore({ path });
    const secondJournal = new EffectIntentJournal({ store: secondStore, now: () => LATER });
    secondJournal.openRun(retry);
    const retryRecord: EffectIntentRecord = {
      ...first,
      ...retry,
      outcome: { kind: "intended" },
      createdAt: LATER,
      updatedAt: LATER,
    };

    expect(() => secondStore.compareAndSet(undefined, retryRecord)).toThrowError(
      expect.objectContaining<Partial<EffectIntentError>>({
        code: "EFFECT_INTENT_CONFLICT",
      }),
    );
    expect(new FileEffectIntentStore({ path }).list()).toHaveLength(1);
  }));

  it("rejects a stale compare-and-set after another writer settles the record", scratchTest((root) => {
    const path = join(root, "effect-intents.json");
    const firstStore = new FileEffectIntentStore({ path });
    const journal = new EffectIntentJournal({ store: firstStore, now: () => NOW });
    journal.openRun(claim());
    const original = journal.recordIntent(intent());
    const secondStore = new FileEffectIntentStore({ path });
    journal.recordOutcome(claim(), original.idempotencyKey, {
      kind: "terminal",
      resultDigest: `sha256:${"d".repeat(64)}`,
    });
    const staleReplacement: EffectIntentRecord = {
      ...original,
      outcome: {
        kind: "no-effect",
        detail: "a stale writer claimed the provider was never called",
      },
      updatedAt: LATER,
    };
    expect(secondStore.compareAndSet(original, staleReplacement)).toBe(false);
    expect(new EffectIntentJournal({
      store: new FileEffectIntentStore({ path }),
      now: () => LATER,
    }).evidenceForRun(claim())).toEqual({ kind: "terminal" });
  }));

  it("refuses to insert a record that skipped the intended state", scratchTest((root) => {
    const store = new FileEffectIntentStore({ path: join(root, "effect-intents.json") });
    const journal = new EffectIntentJournal({ store, now: () => NOW });
    journal.openRun(claim());
    const intended = journal.recordIntent(intent());
    const otherRun = claim({
      runId: "run-file-effect-skipped",
      attempt: 2,
      claimToken: "claim-file-effect-skipped",
    });
    const invalid: EffectIntentRecord = {
      ...intended,
      ...otherRun,
      outcome: {
        kind: "terminal",
        resultDigest: `sha256:${"e".repeat(64)}`,
      },
    };
    expect(() => store.compareAndSet(undefined, invalid)).toThrowError(
      expect.objectContaining<Partial<EffectIntentError>>({
        code: "EFFECT_INTENT_CONFLICT",
      }),
    );
  }));

  it("refuses a different intent under one stable key across retry Runs", scratchTest((root) => {
    const store = new FileEffectIntentStore({ path: join(root, "effect-intents.json") });
    const journal = new EffectIntentJournal({ store, now: () => NOW });
    journal.openRun(claim());
    const first = journal.recordIntent(intent());
    const conflictingRun = claim({
      runId: "run-file-effect-conflict",
      attempt: 2,
      claimToken: "claim-file-effect-conflict",
    });
    const conflicting: EffectIntentRecord = {
      ...first,
      ...conflictingRun,
      intentDigest: `sha256:${"f".repeat(64)}`,
    };
    journal.openRun(conflictingRun);
    expect(() => store.compareAndSet(undefined, conflicting)).toThrowError(
      expect.objectContaining<Partial<EffectIntentError>>({
        code: "EFFECT_INTENT_CONFLICT",
      }),
    );
  }));

  it("rejects a strict-JSON mutation instead of ignoring duplicate fields", scratchTest((root) => {
    const path = join(root, "effect-intents.json");
    new FileEffectIntentStore({ path });
    writeFileSync(
      path,
      '{"schemaVersion":"dolly.effect-intent-store/2","revision":0,"revision":1,"records":[],"runs":[]}\n',
      "utf8",
    );
    expect(() => new FileEffectIntentStore({ path })).toThrowError(
      expect.objectContaining<Partial<EffectIntentError>>({
        code: "EFFECT_INTENT_DOCUMENT_INVALID",
      }),
    );
  }));

  it("refuses a symbolic-link repository path", scratchTest((root) => {
    const target = join(root, "target.json");
    new FileEffectIntentStore({ path: target });
    const link = join(root, "link.json");
    symlinkSync(target, link);
    expect(() => new FileEffectIntentStore({ path: link })).toThrowError(
      expect.objectContaining<Partial<EffectIntentError>>({
        code: "EFFECT_INTENT_IO_FAILED",
      }),
    );
  }));

  it("fails closed when the persisted document exceeds its byte limit", scratchTest((root) => {
    const path = join(root, "effect-intents.json");
    new FileEffectIntentStore({ path, maxBytes: 1_024 });
    writeFileSync(path, " ".repeat(1_025), "utf8");
    expect(() => new FileEffectIntentStore({ path, maxBytes: 1_024 })).toThrowError(
      expect.objectContaining<Partial<EffectIntentError>>({
        code: "EFFECT_INTENT_LIMIT_EXCEEDED",
      }),
    );
  }));

  it("proves a zero-effect Run only after capability admission is durably closed", scratchTest((root) => {
    const path = join(root, "effect-intents.json");
    const journal = new EffectIntentJournal({
      store: new FileEffectIntentStore({ path }),
      now: () => NOW,
    });
    journal.openRun(claim());
    expect(journal.evidenceForRun(claim()).kind).toBe("unknown");
    const closed = journal.closeRun(claim());
    expect(closed).toMatchObject({
      state: "closed",
      intentCount: 0,
    });

    const reopened = new EffectIntentJournal({
      store: new FileEffectIntentStore({ path }),
      now: () => LATER,
    });
    expect(reopened.evidenceForRun(claim())).toEqual({ kind: "no-effect" });
    expect(() => reopened.openRun(claim())).toThrowError(
      expect.objectContaining<Partial<EffectIntentError>>({
        code: "EFFECT_INTENT_CONFLICT",
      }),
    );
  }));

  it("freezes the complete no-effect intent set and rejects a late effect", scratchTest((root) => {
    const path = join(root, "effect-intents.json");
    const journal = new EffectIntentJournal({
      store: new FileEffectIntentStore({ path }),
      now: () => NOW,
    });
    journal.openRun(claim());
    journal.recordIntent(intent());
    journal.recordOutcome(claim(), "module-job-file-effect:provider-call", {
      kind: "no-effect",
      detail: "the provider request was rejected before transmission",
    });
    journal.closeRun(claim());
    expect(journal.evidenceForRun(claim())).toEqual({ kind: "no-effect" });
    expect(() =>
      journal.recordIntent({
        ...intent(),
        idempotencyKey: "module-job-file-effect:late-effect",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<EffectIntentError>>({
        code: "EFFECT_INTENT_CONFLICT",
      }),
    );
    expect(journal.evidenceForRun(claim())).toEqual({ kind: "no-effect" });
  }));

  it("rejects a document whose closed Run no longer matches its intent set", scratchTest((root) => {
    const path = join(root, "effect-intents.json");
    const journal = new EffectIntentJournal({
      store: new FileEffectIntentStore({ path }),
      now: () => NOW,
    });
    journal.openRun(claim());
    journal.recordIntent(intent());
    journal.recordOutcome(claim(), "module-job-file-effect:provider-call", {
      kind: "no-effect",
      detail: "the operation stopped before its effect boundary",
    });
    journal.closeRun(claim());

    const document = JSON.parse(readFileSync(path, "utf8")) as {
      runs: Array<{ intentCount: number }>;
    };
    document.runs[0]!.intentCount = 0;
    writeFileSync(path, `${JSON.stringify(document)}\n`, "utf8");
    expect(() => new FileEffectIntentStore({ path })).toThrowError(
      expect.objectContaining<Partial<EffectIntentError>>({
        code: "EFFECT_INTENT_DOCUMENT_INVALID",
      }),
    );
  }));

  it("refuses effects until the exact Run admission record exists", scratchTest((root) => {
    const store = new FileEffectIntentStore({ path: join(root, "effect-intents.json") });
    const journal = new EffectIntentJournal({ store, now: () => NOW });
    expect(() => journal.recordIntent(intent())).toThrowError(
      expect.objectContaining<Partial<EffectIntentError>>({
        code: "EFFECT_INTENT_CONFLICT",
      }),
    );
    expect(() => journal.closeRun(claim())).toThrowError(
      expect.objectContaining<Partial<EffectIntentError>>({
        code: "EFFECT_INTENT_NOT_FOUND",
      }),
    );
  }));
});
