import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLLMTurnJournal } from "../../../src/core/file-llm-turn-journal.js";
import {
  findPreparedTurnsForModuleJob,
  LLMTurnJournalError,
  llmTurnJournalPath,
  resolveTurnJournalStateDirectory,
  type ApprovalDecisionInput,
  type PreparedTurnInput,
  type PreparedTurnRecord,
} from "../../../src/core/llm-turn-journal.js";
import { withSynchronousCrossProcessLock } from "../../../src/core/synchronous-cross-process-lock.js";

const NOW = "2026-08-14T00:00:00.000Z";

function preparedTurnInput(overrides: Partial<PreparedTurnInput> = {}): PreparedTurnInput {
  return {
    turnId: "turn-1",
    moduleJobId: "module-job-1",
    runId: "run-1",
    conversationRevision: 3,
    inputDeliveryIds: ["delivery-a", "delivery-b"],
    modelSnapshotId: "model-snapshot-1",
    activationId: "activation-1",
    attempt: 1,
    leaseEpoch: 1,
    maxRequests: 8,
    maxApprovals: 1,
    maxToolCalls: 4,
    ...overrides,
  };
}

function approvalDecisionInput(
  overrides: Partial<ApprovalDecisionInput> = {},
): ApprovalDecisionInput {
  return {
    decisionId: "decision-1",
    turnId: "turn-1",
    requestId: "tool-call-1",
    decision: "granted",
    policyRevision: "policy-1",
    ...overrides,
  };
}

describe("durable prepared-turn and approval journal", () => {
  let root: string;
  let stateDirectory: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-llm-turn-journal-"));
    stateDirectory = resolve(root, "state");
    path = llmTurnJournalPath(stateDirectory);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("round-trips a prepared turn and an approval decision under the instance state directory", () => {
    const journal = new FileLLMTurnJournal({ path, now: () => NOW });
    const turn = preparedTurnInput();
    const approval = approvalDecisionInput();

    journal.appendPreparedTurn(turn);
    journal.appendApprovalDecision(approval);

    expect(existsSync(path)).toBe(true);
    expect(journal.list()).toEqual([
      { ...turn, kind: "prepared-turn", recordedAt: NOW },
      { ...approval, kind: "approval-decision", decidedAt: NOW },
    ]);
  });

  it("reopening after write preserves every recorded entry", () => {
    const first = new FileLLMTurnJournal({ path, now: () => NOW });
    first.appendPreparedTurn(preparedTurnInput());
    first.appendApprovalDecision(approvalDecisionInput());

    const second = new FileLLMTurnJournal({ path, now: () => NOW });
    expect(second.list()).toEqual(first.list());

    second.appendApprovalDecision(approvalDecisionInput({ decisionId: "decision-2" }));
    const third = new FileLLMTurnJournal({ path, now: () => NOW });
    expect(third.list()).toHaveLength(3);
    expect(third.list()[2]).toMatchObject({
      kind: "approval-decision",
      decisionId: "decision-2",
      decision: "granted",
    });
  });

  it("produces identical journal bytes for the same events and clock", () => {
    const otherRoot = mkdtempSync(join(tmpdir(), "dolly-llm-turn-journal-other-"));
    try {
      const otherPath = llmTurnJournalPath(resolve(otherRoot, "state"));
      const left = new FileLLMTurnJournal({ path, now: () => NOW });
      const right = new FileLLMTurnJournal({ path: otherPath, now: () => NOW });
      for (let turn = 1; turn <= 3; turn += 1) {
        left.appendPreparedTurn(preparedTurnInput({ turnId: `turn-${turn}` }));
        right.appendPreparedTurn(preparedTurnInput({ turnId: `turn-${turn}` }));
      }
      left.appendApprovalDecision(approvalDecisionInput());
      right.appendApprovalDecision(approvalDecisionInput());

      expect(readFileSync(path, "utf8")).toBe(readFileSync(otherPath, "utf8"));
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("rejects invalid appended inputs and a non-canonical injected clock", () => {
    const journal = new FileLLMTurnJournal({ path, now: () => NOW });
    expect(() => journal.appendPreparedTurn(preparedTurnInput({ moduleJobId: "bad id" }))).toThrowError(
      expect.objectContaining<Partial<LLMTurnJournalError>>({ code: "LLM_TURN_INVALID" }),
    );
    expect(() =>
      journal.appendPreparedTurn(preparedTurnInput({ maxRequests: -1 })),
    ).toThrowError(
      expect.objectContaining<Partial<LLMTurnJournalError>>({ code: "LLM_TURN_INVALID" }),
    );
    expect(() => journal.appendApprovalDecision(approvalDecisionInput({ decision: "maybe" as "granted" }))).toThrowError(
      expect.objectContaining<Partial<LLMTurnJournalError>>({ code: "LLM_TURN_INVALID" }),
    );
    expect(() =>
      journal.appendPreparedTurn({
        ...preparedTurnInput(),
        unexpectedField: "forbidden",
      } as unknown as PreparedTurnInput),
    ).toThrowError(
      expect.objectContaining<Partial<LLMTurnJournalError>>({ code: "LLM_TURN_INVALID" }),
    );

    const badClock = new FileLLMTurnJournal({ path: llmTurnJournalPath(resolve(root, "bad-clock")), now: () => "not-a-timestamp" });
    expect(() => badClock.appendPreparedTurn(preparedTurnInput())).toThrowError(
      expect.objectContaining<Partial<LLMTurnJournalError>>({
        code: "LLM_TURN_JOURNAL_CLOCK_INVALID",
      }),
    );
  });

  it("fixes attempt identity: activation, attempt, and lease epoch round-trip across reopen", () => {
    const journal = new FileLLMTurnJournal({ path, now: () => NOW });
    journal.appendPreparedTurn(
      preparedTurnInput({ activationId: "activation-9", attempt: 2, leaseEpoch: 3 }),
    );
    expect(new FileLLMTurnJournal({ path, now: () => NOW }).list()).toEqual([
      {
        ...preparedTurnInput({ activationId: "activation-9", attempt: 2, leaseEpoch: 3 }),
        kind: "prepared-turn",
        recordedAt: NOW,
      },
    ]);
  });

  it("retains the same turnId on distinct attempts as separate append-only records", () => {
    const journal = new FileLLMTurnJournal({ path, now: () => NOW });
    journal.appendPreparedTurn(preparedTurnInput({ attempt: 1, leaseEpoch: 1 }));
    journal.appendPreparedTurn(preparedTurnInput({ attempt: 2, leaseEpoch: 2 }));
    const records = journal.list() as readonly PreparedTurnRecord[];
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ turnId: "turn-1", activationId: "activation-1", attempt: 1, leaseEpoch: 1 });
    expect(records[1]).toMatchObject({ turnId: "turn-1", activationId: "activation-1", attempt: 2, leaseEpoch: 2 });
  });

  it("rejects prepared turns with missing or malformed attempt identity", () => {
    const journal = new FileLLMTurnJournal({ path, now: () => NOW });
    const missingActivation = { ...preparedTurnInput() } as Record<string, unknown>;
    delete missingActivation.activationId;
    expect(() =>
      journal.appendPreparedTurn(missingActivation as unknown as PreparedTurnInput),
    ).toThrowError(
      expect.objectContaining<Partial<LLMTurnJournalError>>({ code: "LLM_TURN_INVALID" }),
    );
    expect(() =>
      journal.appendPreparedTurn(preparedTurnInput({ activationId: "bad id" })),
    ).toThrowError(
      expect.objectContaining<Partial<LLMTurnJournalError>>({ code: "LLM_TURN_INVALID" }),
    );
    expect(() =>
      journal.appendPreparedTurn(preparedTurnInput({ attempt: -1 })),
    ).toThrowError(
      expect.objectContaining<Partial<LLMTurnJournalError>>({ code: "LLM_TURN_INVALID" }),
    );
    expect(() =>
      journal.appendPreparedTurn(preparedTurnInput({ leaseEpoch: 1.5 })),
    ).toThrowError(
      expect.objectContaining<Partial<LLMTurnJournalError>>({ code: "LLM_TURN_INVALID" }),
    );
  });

  it("fails closed on a v1 journal document that was never shipped", () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      '{"schemaVersion":"dolly.llm-turn-journal/1","rotation":0,"sequence":0,"entries":[]}',
      "utf8",
    );
    expect(() => new FileLLMTurnJournal({ path })).toThrowError(
      expect.objectContaining<Partial<LLMTurnJournalError>>({
        code: "LLM_TURN_JOURNAL_DOCUMENT_INVALID",
      }),
    );
  });

  it("refuses appends beyond the byte limit without losing prior records", () => {
    const journal = new FileLLMTurnJournal({ path, maxBytes: 1_024, now: () => NOW });
    journal.appendPreparedTurn(preparedTurnInput());
    journal.appendApprovalDecision(approvalDecisionInput());
    const before = journal.list();

    expect(() =>
      journal.appendPreparedTurn(preparedTurnInput({
        turnId: "overflowing",
        inputDeliveryIds: Array.from({ length: 40 }, (_unused, index) => `delivery-${index}`),
      })),
    ).toThrowError(
      expect.objectContaining<Partial<LLMTurnJournalError>>({
        code: "LLM_TURN_JOURNAL_LIMIT_EXCEEDED",
      }),
    );
    expect(new FileLLMTurnJournal({ path, maxBytes: 1_024, now: () => NOW }).list()).toEqual(before);
  });

  it("rotates under guard: archives durable entries and resets the active journal", () => {
    const journal = new FileLLMTurnJournal({ path, now: () => NOW });
    journal.appendPreparedTurn(preparedTurnInput());
    journal.appendApprovalDecision(approvalDecisionInput());

    const rotation = journal.rotate();
    expect(rotation).toMatchObject({
      rotated: true,
      archivedEntries: 2,
      activeEntries: 0,
    });
    expect(rotation.archivePath).not.toBeNull();

    expect(new FileLLMTurnJournal({ path, now: () => NOW }).list()).toEqual([]);
    const archive = new FileLLMTurnJournal({ path: rotation.archivePath!, now: () => NOW });
    expect(archive.list()).toHaveLength(2);

    journal.appendPreparedTurn(preparedTurnInput({ turnId: "turn-after-rotate" }));
    expect(journal.list()).toMatchObject([{ kind: "prepared-turn", turnId: "turn-after-rotate" }]);
    expect(new FileLLMTurnJournal({ path: rotation.archivePath!, now: () => NOW }).list()).toHaveLength(2);
  });

  it("treats rotating an empty journal as a no-op", () => {
    const journal = new FileLLMTurnJournal({ path, now: () => NOW });
    expect(journal.rotate()).toEqual({
      rotated: false,
      archivedEntries: 0,
      archivePath: null,
      activeEntries: 0,
    });
  });

  it("fails closed on corrupted, oversized, or symlinked journal files", () => {
    const journal = new FileLLMTurnJournal({ path, now: () => NOW });
    journal.appendPreparedTurn(preparedTurnInput());

    writeFileSync(path, '{"schemaVersion":"dolly.llm-turn-journal/1","rotation":1,"rotation":2,"sequence":1,"entries":[]}', "utf8");
    expect(() => new FileLLMTurnJournal({ path })).toThrowError(
      expect.objectContaining<Partial<LLMTurnJournalError>>({
        code: "LLM_TURN_JOURNAL_DOCUMENT_INVALID",
      }),
    );

    writeFileSync(path, '{"schemaVersion":"dolly.llm-turn-journal/1","rotation":0,"sequence":2,"entries":[]}', "utf8");
    expect(() => new FileLLMTurnJournal({ path })).toThrowError(
      expect.objectContaining<Partial<LLMTurnJournalError>>({
        code: "LLM_TURN_JOURNAL_DOCUMENT_INVALID",
      }),
    );

    writeFileSync(path, "x".repeat(2_048));
    expect(() => new FileLLMTurnJournal({ path, maxBytes: 1_024 })).toThrowError(
      expect.objectContaining<Partial<LLMTurnJournalError>>({
        code: "LLM_TURN_JOURNAL_LIMIT_EXCEEDED",
      }),
    );

    const target = resolve(root, "target");
    writeFileSync(target, "{}");
    rmSync(path);
    symlinkSync(target, path);
    expect(() => new FileLLMTurnJournal({ path })).toThrowError(
      expect.objectContaining<Partial<LLMTurnJournalError>>({ code: "LLM_TURN_JOURNAL_IO_FAILED" }),
    );
  });

  it("serializes writers with an explicit lock and re-reads before appending", () => {
    const journal = new FileLLMTurnJournal({ path, now: () => NOW });
    withSynchronousCrossProcessLock({ resourceId: `${path}.lock` }, () => {
      expect(() => journal.appendPreparedTurn(preparedTurnInput())).toThrowError(
        expect.objectContaining<Partial<LLMTurnJournalError>>({
          code: "LLM_TURN_JOURNAL_LOCKED",
        }),
      );
    });
    journal.appendPreparedTurn(preparedTurnInput());
    expect(journal.list()).toHaveLength(1);
  });

  it("locates the journal under the instance state directory from configuration conventions", () => {
    const absolute = resolveTurnJournalStateDirectory({
      stateDirectory: resolve(root, "absolute-state"),
    });
    expect(absolute).toBe(resolve(root, "absolute-state"));

    const relative = resolveTurnJournalStateDirectory({
      configPath: join(root, "instance.json"),
      stateDirectory: "relative-state",
    });
    expect(relative).toBe(join(root, "relative-state"));

    const fallback = resolveTurnJournalStateDirectory({
      instanceId: "turn-instance",
      defaultStateRoot: join(root, "instances"),
    });
    expect(fallback).toBe(join(root, "instances", "turn-instance"));

    expect(() => resolveTurnJournalStateDirectory({})).toThrowError(TypeError);
    expect(() =>
      resolveTurnJournalStateDirectory({ stateDirectory: "relative-without-config" }),
    ).toThrowError(TypeError);

    const located = resolveTurnJournalStateDirectory({
      stateDirectory: resolve(root, "located-state"),
    });
    const journal = new FileLLMTurnJournal({ path: llmTurnJournalPath(located), now: () => NOW });
    journal.appendPreparedTurn(preparedTurnInput());
    expect(readFileSync(llmTurnJournalPath(located), "utf8")).toContain("prepared-turn");
  });

  it("finds a module job's prepared turns by the spec 4.2 idempotency key in append order", () => {
    const journal = new FileLLMTurnJournal({ path, now: () => NOW });
    journal.appendPreparedTurn(
      preparedTurnInput({ turnId: "turn-a-1", moduleJobId: "module-job-a", attempt: 1, leaseEpoch: 1 }),
    );
    journal.appendPreparedTurn(
      preparedTurnInput({ turnId: "turn-b-1", moduleJobId: "module-job-b", attempt: 1, leaseEpoch: 1 }),
    );
    journal.appendPreparedTurn(
      preparedTurnInput({ turnId: "turn-a-2", moduleJobId: "module-job-a", attempt: 2, leaseEpoch: 2 }),
    );
    journal.appendApprovalDecision(
      approvalDecisionInput({ decisionId: "decision-a", turnId: "turn-a-2" }),
    );

    const forA = findPreparedTurnsForModuleJob(journal.list(), "module-job-a");
    expect(forA.map((record) => record.turnId)).toEqual(["turn-a-1", "turn-a-2"]);
    expect(forA.every((record) => record.kind === "prepared-turn")).toBe(true);
    expect(forA[forA.length - 1]).toMatchObject({
      moduleJobId: "module-job-a",
      turnId: "turn-a-2",
      attempt: 2,
      leaseEpoch: 2,
    });

    const forB = findPreparedTurnsForModuleJob(journal.list(), "module-job-b");
    expect(forB.map((record) => record.turnId)).toEqual(["turn-b-1"]);
  });

  it("returns an empty list for a module job with no prepared turn", () => {
    const journal = new FileLLMTurnJournal({ path, now: () => NOW });
    journal.appendPreparedTurn(preparedTurnInput());
    expect(findPreparedTurnsForModuleJob(journal.list(), "module-job-missing")).toEqual([]);
  });

  it("rejects an invalid moduleJobId argument to the spec lookup", () => {
    const journal = new FileLLMTurnJournal({ path, now: () => NOW });
    journal.appendPreparedTurn(preparedTurnInput());
    expect(() => findPreparedTurnsForModuleJob(journal.list(), "not a module job id")).toThrowError(
      expect.objectContaining<Partial<LLMTurnJournalError>>({ code: "LLM_TURN_INVALID" }),
    );
  });

  it("returns a fresh array that leaves the journal entries untouched", () => {
    const journal = new FileLLMTurnJournal({ path, now: () => NOW });
    journal.appendPreparedTurn(
      preparedTurnInput({ moduleJobId: "module-job-m", attempt: 1, leaseEpoch: 1 }),
    );
    const before = journal.list();
    const records = findPreparedTurnsForModuleJob(before, "module-job-m");
    expect(records).not.toBe(before);
    expect(records).toEqual(before);
    expect(journal.list()).toEqual(before);
  });

  it("lets a retry of the same module job find its durable prepared turn across reopen", () => {
    const first = new FileLLMTurnJournal({ path, now: () => NOW });
    first.appendPreparedTurn(
      preparedTurnInput({ turnId: "turn-retry", moduleJobId: "module-job-retry", attempt: 1, leaseEpoch: 1 }),
    );

    const rewriter = new FileLLMTurnJournal({ path, now: () => NOW });
    const records = findPreparedTurnsForModuleJob(rewriter.list(), "module-job-retry");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "prepared-turn",
      moduleJobId: "module-job-retry",
      turnId: "turn-retry",
      attempt: 1,
      leaseEpoch: 1,
      recordedAt: NOW,
    });
  });
});