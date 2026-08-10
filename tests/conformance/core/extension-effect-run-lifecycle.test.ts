import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createExtensionEffectJournalLifecycle } from "../../../src/adapters/extension-effect-run-lifecycle.js";
import { EffectIntentJournal } from "../../../src/core/capabilities/effect-intent-journal.js";
import { FileEffectIntentStore } from "../../../src/core/capabilities/file-effect-intent-store.js";
import type { DeliveryClaimIdentity } from "../../../src/core/delivery-store.js";
import type { ExtensionCapabilityEffectInvocation } from "../../../src/core/extension-process-host.js";
import type { ModuleSubmissionRecord } from "../../../src/core/module-process-records.js";

const NOW = "2026-08-10T03:00:00.000Z";

function claim(): DeliveryClaimIdentity {
  return {
    moduleJobId: "module-job-effect-lifecycle",
    runId: "run-effect-lifecycle",
    attempt: 1,
    claimToken: "claim-effect-lifecycle",
    moduleGenerationId: "module-generation-effect-lifecycle",
  };
}

function submission(): ModuleSubmissionRecord {
  return {
    schemaVersion: "dolly.module-submission-record/1",
    ...claim(),
    processGenerationId: "process-generation-effect-lifecycle",
    inputDigest: `sha256:${"a".repeat(64)}`,
    createdAt: NOW,
  };
}

function invocation(
  overrides: Partial<ExtensionCapabilityEffectInvocation> = {},
): ExtensionCapabilityEffectInvocation {
  return {
    identity: claim(),
    capabilityType: "model-operation",
    capabilityVersion: "v2",
    operation: "chat",
    arguments: { privatePrompt: "must-not-be-persisted" },
    idempotencyKey: "module-job-effect-lifecycle:model-call-1",
    ...overrides,
  };
}

function scratchTest(
  run: (root: string) => void | Promise<void>,
): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-extension-effect-lifecycle-"));
    try {
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

describe("Extension effect Run lifecycle", () => {
  it("persists a terminal invocation without storing arguments or results", scratchTest(async (root) => {
    const path = join(root, "effect-intents.json");
    const journal = new EffectIntentJournal({
      store: new FileEffectIntentStore({ path }),
      now: () => NOW,
    });
    const lifecycle = createExtensionEffectJournalLifecycle({
      journal,
      getModuleSubmissionRecord: () => submission(),
    });
    expect(lifecycle.resolveRunIdentity({
      moduleJobId: claim().moduleJobId,
      runId: claim().runId,
      attempt: claim().attempt,
      moduleGenerationId: claim().moduleGenerationId,
      processGenerationId: submission().processGenerationId,
    })).toEqual(claim());
    lifecycle.openRun(claim());
    const execute = vi.fn().mockResolvedValue({ privateResult: "also-not-persisted" });
    await expect(lifecycle.invokeCapability(invocation(), execute)).resolves.toEqual({
      privateResult: "also-not-persisted",
    });
    lifecycle.closeRun(claim());

    expect(execute).toHaveBeenCalledOnce();
    expect(journal.evidenceForRun(claim())).toEqual({ kind: "terminal" });
    const persisted = readFileSync(path, "utf8");
    expect(persisted).not.toContain("must-not-be-persisted");
    expect(persisted).not.toContain("also-not-persisted");
  }));

  it("does not cross the handler boundary without a stable idempotency key", scratchTest(async (root) => {
    const journal = new EffectIntentJournal({
      store: new FileEffectIntentStore({ path: join(root, "effect-intents.json") }),
      now: () => NOW,
    });
    const lifecycle = createExtensionEffectJournalLifecycle({
      journal,
      getModuleSubmissionRecord: () => submission(),
    });
    lifecycle.openRun(claim());
    const execute = vi.fn().mockResolvedValue({ unsafe: true });
    await expect(
      lifecycle.invokeCapability(invocation({ idempotencyKey: undefined }), execute),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    lifecycle.closeRun(claim());

    expect(execute).not.toHaveBeenCalled();
    expect(journal.evidenceForRun(claim())).toEqual({ kind: "no-effect" });
  }));

  it("keeps a rejected arbitrary handler outcome unknown", scratchTest(async (root) => {
    const journal = new EffectIntentJournal({
      store: new FileEffectIntentStore({ path: join(root, "effect-intents.json") }),
      now: () => NOW,
    });
    const lifecycle = createExtensionEffectJournalLifecycle({
      journal,
      getModuleSubmissionRecord: () => submission(),
    });
    lifecycle.openRun(claim());
    await expect(
      lifecycle.invokeCapability(
        invocation(),
        vi.fn().mockRejectedValue(new Error("provider outcome is unknown")),
      ),
    ).rejects.toThrow("provider outcome is unknown");
    lifecycle.closeRun(claim());

    expect(journal.evidenceForRun(claim()).kind).toBe("unknown");
  }));
});
