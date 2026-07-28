/**
 * Two durable journals the fixed interruption matrix needs and that Dolly Core
 * does not ship an implementation of yet.
 *
 * Protocol version 3 names fourteen durable boundaries. Twelve of them are
 * written by code that already exists: `FileCoreStateStore` for the Claim, the
 * Module process record and the Module submission record,
 * `FileModuleResultCommitRepository` and `ModuleResultCommitCoordinator` for
 * the result commit, the Block, the output Deliveries and the acknowledgement,
 * and `linux-module-process-lifecycle` for the process record's closure.
 *
 * Two are not:
 *
 *   * boundary 8, "each capability request start and completion". Core has a
 *     real capability authority (`extension-capability.ts`) but its idempotency
 *     evidence lives in memory, which Architecture Decision Record 0009
 *     explicitly refuses to accept as restart evidence.
 *   * boundary 9, "Extension result receipt persistence". Core holds a received
 *     result in memory until the result commit is prepared.
 *
 * `core-startup-recovery.ts` has the seam for the first of these — it takes an
 * `ExternalEffectEvidenceSource` — and ships no implementation of it. So the
 * experiment supplies one. That is stated plainly rather than hidden: these
 * two journals are the experiment's own code, and a case that passes only
 * because of them proves something about this file, not about Core. Every
 * other boundary is the shipped implementation.
 *
 * The write discipline is the one the shipped Core-state writer uses: write to
 * a temporary file, synchronise it, rename it over the target, then synchronise
 * the parent directory. Appends are `O_APPEND` writes followed by `fsync`, so a
 * reader after a crash sees whole lines that were durable before the crash.
 */
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";

function appendDurableLine(path: string, value: unknown): void {
  const descriptor = openSync(path, "a");
  try {
    writeSync(descriptor, `${JSON.stringify(value)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readLines(path: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const records: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A partially written final line is exactly what a crash leaves behind.
      // It is not evidence of anything, so it is dropped rather than repaired.
    }
  }
  return records;
}

export interface CapabilityEffectIntent {
  readonly kind: "intent";
  readonly runId: string;
  readonly moduleJobId: string;
  readonly invocationId: string;
  readonly capabilityType: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  /** Whether repeating this operation could add a second external effect. */
  readonly externallyVisible: boolean;
  readonly at: string;
}

export interface CapabilityEffectOutcome {
  readonly kind: "outcome";
  readonly runId: string;
  readonly invocationId: string;
  readonly status: "succeeded" | "failed";
  readonly at: string;
}

export type CapabilityEffectEntry = CapabilityEffectIntent | CapabilityEffectOutcome;

/**
 * Durable capability effect-intent and outcome evidence.
 *
 * The intent is written before the effect can happen and the outcome after it
 * is known, so an invocation with an intent and no outcome is exactly the case
 * ADR 0009 calls unknown: the effect may or may not have happened, and no
 * amount of in-memory state can decide it after a restart.
 */
export class CapabilityEffectJournal {
  constructor(private readonly path: string) {}

  recordIntent(intent: Omit<CapabilityEffectIntent, "kind" | "at">): void {
    appendDurableLine(this.path, {
      kind: "intent",
      ...intent,
      at: new Date().toISOString(),
    } satisfies CapabilityEffectIntent);
  }

  recordOutcome(outcome: Omit<CapabilityEffectOutcome, "kind" | "at">): void {
    appendDurableLine(this.path, {
      kind: "outcome",
      ...outcome,
      at: new Date().toISOString(),
    } satisfies CapabilityEffectOutcome);
  }

  entries(): readonly CapabilityEffectEntry[] {
    return readLines(this.path) as CapabilityEffectEntry[];
  }

  /**
   * Externally visible capability invocations of one Run that have an intent
   * and no outcome. Each one makes that Run's external effect unknown.
   */
  unresolvedInvocations(runId: string): readonly string[] {
    const intents = new Map<string, CapabilityEffectIntent>();
    const resolved = new Set<string>();
    for (const entry of this.entries()) {
      if (entry.runId !== runId) continue;
      if (entry.kind === "intent") intents.set(entry.invocationId, entry);
      else resolved.add(entry.invocationId);
    }
    return [...intents.values()]
      .filter((intent) => intent.externallyVisible && !resolved.has(intent.invocationId))
      .map((intent) => intent.invocationId);
  }
}

export interface ExtensionResultReceipt {
  readonly runId: string;
  readonly moduleJobId: string;
  readonly attempt: number;
  readonly resultDigest: string;
  readonly outputCount: number;
  readonly at: string;
}

/** Durable evidence that one Extension result frame was received by Core. */
export class ExtensionResultReceiptJournal {
  constructor(private readonly path: string) {}

  record(receipt: Omit<ExtensionResultReceipt, "at">): void {
    appendDurableLine(this.path, { ...receipt, at: new Date().toISOString() });
  }

  entries(): readonly ExtensionResultReceipt[] {
    return readLines(this.path) as ExtensionResultReceipt[];
  }

  has(runId: string): boolean {
    return this.entries().some((receipt) => receipt.runId === runId);
  }
}

/** The external effects a capability handler actually performed, in order. */
export class ExternalEffectLog {
  constructor(private readonly path: string) {}

  append(entry: Record<string, unknown>): void {
    appendDurableLine(this.path, { ...entry, at: new Date().toISOString() });
  }

  entries(): readonly Record<string, unknown>[] {
    return readLines(this.path) as Record<string, unknown>[];
  }
}
