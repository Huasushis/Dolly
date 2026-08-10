import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import { FileToolJournalRepository } from "../../../src/core/file-tool-journal-repository.js";
import {
  ToolPolicySession,
  ToolRegistry,
  type ToolDescriptor,
  type ToolExecutor,
  type ToolJournalRepository,
  type ToolRoundJournalRecord,
} from "../../../src/core/tool-policy.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scratchParent = resolve(repositoryRoot, "..", ".tmp");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratch(name: string): string {
  mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(scratchParent, `dolly-tool-journal-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

const readTool: ToolDescriptor = {
  toolId: "storage.read",
  wireName: "storage_read",
  description: "Read one private value",
  argumentSchema: {
    type: "object",
    properties: { key: { type: "string", maxBytes: 64 } },
    required: ["key"],
    additionalProperties: false,
    maxProperties: 1,
  },
  resultSchema: {
    type: "object",
    properties: { value: { type: "string", maxBytes: 128 } },
    required: ["value"],
    additionalProperties: false,
    maxProperties: 1,
  },
  effectClass: "read",
  resourceScope: "private-storage",
  approval: "never",
  idempotency: "effect-key",
  outcomeQuery: "supported",
  parallel: "safe",
  deadlineMs: 1_000,
  maxArgumentBytes: 256,
  maxResultBytes: 256,
};

const calls = [{
  providerCallId: "provider-call-1",
  wireName: "storage_read",
  argumentsJson: JSON.stringify({ key: "deployment-note" }),
}] as const;

function session(
  repository: ToolJournalRepository,
  executor: ToolExecutor,
  descriptor: ToolDescriptor = readTool,
  approvalPolicyRevision = "policy-1",
): ToolPolicySession {
  return new ToolPolicySession({
    moduleJobId: "module-job-1",
    registry: new ToolRegistry([descriptor], [descriptor.toolId]),
    repository,
    approval: {
      decide: async () => ({ decision: "denied", code: "APPROVAL_NOT_USED" }),
    },
    executor,
    budget: {
      maxRounds: 2,
      maxCalls: 2,
      maxCallsPerRound: 1,
      maxApprovals: 0,
      maxCallBytes: 1_024,
    },
    approvalPolicyRevision,
  });
}

function reservedRound(
  moduleJobId = "module-job-1",
  roundIndex = 1,
): ToolRoundJournalRecord {
  const effect = {
    wireName: "storage_read",
    effectSlot: `round-${roundIndex}-call-1`,
    argumentDigest: canonicalJsonDigest({ key: "deployment-note" }),
    toolId: "storage.read",
    arguments: { key: "deployment-note" },
    providerCallId: `provider-call-${roundIndex}`,
    status: "reserved" as const,
  };
  return {
    schemaVersion: "dolly.tool-round/3",
    moduleJobId,
    registryDigest: `sha256:${"2".repeat(64)}`,
    approvalPolicyRevision: "policy-1",
    roundIndex,
    roundDigest: canonicalJsonDigest([{
      wireName: effect.wireName,
      argumentDigest: effect.argumentDigest,
      effectSlot: effect.effectSlot,
    }]),
    state: "reserved",
    revision: 1,
    effects: [effect],
  };
}

function terminalRound(current: ToolRoundJournalRecord): ToolRoundJournalRecord {
  const effect = current.effects[0]!;
  return {
    ...current,
    revision: current.revision + 1,
    state: "complete",
    effects: [{
      ...effect,
      status: "terminal",
      result: {
        wireName: effect.wireName,
        effectSlot: effect.effectSlot,
        status: "succeeded",
        code: "OK",
        content: { value: "EMBER-7421" },
      },
    }],
  };
}

describe("File tool journal repository", () => {
  it("reopens a completed read round without executing the tool again", async () => {
    const root = scratch("replay");
    const path = join(root, "tool-rounds.json");
    const firstExecutor = vi.fn().mockResolvedValue({
      status: "succeeded",
      content: { value: "EMBER-7421" },
    });
    const first = session(
      new FileToolJournalRepository({ path }),
      { execute: firstExecutor },
    );

    const completed = await first.executeRound({ roundIndex: 1, calls });
    expect(completed).toMatchObject({
      state: "complete",
      results: [{ status: "succeeded", content: { value: "EMBER-7421" } }],
    });
    expect(firstExecutor).toHaveBeenCalledOnce();

    const reopened = new FileToolJournalRepository({ path });
    const unexpectedExecutor = vi.fn();
    const replayed = await session(reopened, { execute: unexpectedExecutor }).executeRound({
      roundIndex: 1,
      calls,
    });
    expect(replayed).toEqual(completed);
    expect(unexpectedExecutor).not.toHaveBeenCalled();
    expect(reopened.listRounds("module-job-1")).toHaveLength(1);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("re-correlates replay responses but rejects registry or approval-policy drift", async () => {
    const path = join(scratch("binding"), "tool-rounds.json");
    const repository = new FileToolJournalRepository({ path });
    await session(repository, {
      execute: vi.fn().mockResolvedValue({
        status: "succeeded",
        content: { value: "EMBER-7421" },
      }),
    }).executeRound({ roundIndex: 1, calls });

    const replayExecutor = vi.fn();
    await expect(session(repository, { execute: replayExecutor }).executeRound({
      roundIndex: 1,
      calls: [{ ...calls[0], providerCallId: "provider-call-other" }],
    })).resolves.toMatchObject({
      results: [{ providerCallId: "provider-call-other", status: "succeeded" }],
    });
    expect(replayExecutor).not.toHaveBeenCalled();

    const changed = { ...readTool, description: "Changed after the Run" };
    await expect(session(repository, { execute: vi.fn() }, changed).executeRound({
      roundIndex: 2,
      calls: [{ ...calls[0], providerCallId: "provider-call-2" }],
    })).rejects.toMatchObject({ code: "TOOL_ROUND_CONFLICT" });
    await expect(session(
      repository,
      { execute: vi.fn() },
      readTool,
      "policy-2",
    ).executeRound({
      roundIndex: 2,
      calls: [{ ...calls[0], providerCallId: "provider-call-2" }],
    })).rejects.toMatchObject({ code: "TOOL_ROUND_CONFLICT" });
  });

  it("serializes compare-and-set writers and freezes every effect identity field", () => {
    const path = join(scratch("cas"), "tool-rounds.json");
    const first = new FileToolJournalRepository({ path });
    const second = new FileToolJournalRepository({ path });
    const initial = reservedRound();
    expect(first.reserveRound(initial)).toBe("created");
    expect(second.reserveRound(initial)).toBe("already-exists");

    expect(() => first.compareAndSet("module-job-1", 1, 1, {
      ...terminalRound(initial),
      effects: [{
        ...terminalRound(initial).effects[0]!,
        providerCallId: "provider-call-forged",
      }],
    })).toThrowError(expect.objectContaining({ code: "TOOL_JOURNAL_CONFLICT" }));
    expect(() => first.compareAndSet("module-job-1", 1, 1, {
      ...terminalRound(initial),
      roundDigest: canonicalJsonDigest([{
        wireName: initial.effects[0]!.wireName,
        argumentDigest: canonicalJsonDigest({ key: "another-note" }),
        effectSlot: initial.effects[0]!.effectSlot,
      }]),
      effects: [{
        ...terminalRound(initial).effects[0]!,
        arguments: { key: "another-note" },
        argumentDigest: canonicalJsonDigest({ key: "another-note" }),
      }],
    })).toThrowError(expect.objectContaining({ code: "TOOL_JOURNAL_CONFLICT" }));

    const terminal = terminalRound(initial);
    expect(first.compareAndSet("module-job-1", 1, 1, terminal)).toBe(true);
    expect(second.compareAndSet("module-job-1", 1, 1, terminal)).toBe(false);
    expect(new FileToolJournalRepository({ path }).getRound("module-job-1", 1))
      .toEqual(terminal);
  });

  it("rejects strict-JSON, digest, result, duplicate, and size corruption", () => {
    const root = scratch("corruption");
    const path = join(root, "tool-rounds.json");
    const repository = new FileToolJournalRepository({ path });
    repository.reserveRound(reservedRound());
    const original = JSON.parse(readFileSync(path, "utf8"));
    const mutations: unknown[] = [
      { ...original, extra: true },
      {
        ...original,
        rounds: [{ ...original.rounds[0], registryDigest: `sha256:${"z".repeat(64)}` }],
      },
      { ...original, rounds: [...original.rounds, original.rounds[0]] },
      {
        ...original,
        rounds: [{
          ...original.rounds[0],
          effects: [{ ...original.rounds[0].effects[0], argumentDigest: `sha256:${"e".repeat(64)}` }],
        }],
      },
    ];
    for (const mutation of mutations) {
      writeFileSync(path, `${JSON.stringify(mutation)}\n`, "utf8");
      expect(() => new FileToolJournalRepository({ path })).toThrowError(
        expect.objectContaining({ code: "TOOL_JOURNAL_DOCUMENT_INVALID" }),
      );
    }

    writeFileSync(path, '{"schemaVersion":"dolly.tool-journal-repository/1","revision":1,"revision":2,"rounds":[]}\n');
    expect(() => new FileToolJournalRepository({ path })).toThrowError(
      expect.objectContaining({ code: "TOOL_JOURNAL_DOCUMENT_INVALID" }),
    );
    writeFileSync(path, "x".repeat(2_048));
    expect(() => new FileToolJournalRepository({ path, maxBytes: 1_024 })).toThrowError(
      expect.objectContaining({ code: "TOOL_JOURNAL_LIMIT_EXCEEDED" }),
    );
  });

  it.skipIf(process.platform === "win32")("refuses a symbolic-link repository file", () => {
    const root = scratch("symlink");
    const target = join(root, "target.json");
    const path = join(root, "tool-rounds.json");
    writeFileSync(target, "{}\n", { mode: 0o600 });
    symlinkSync(target, path);
    expect(() => new FileToolJournalRepository({ path })).toThrowError(
      expect.objectContaining({ code: "TOOL_JOURNAL_IO_FAILED" }),
    );
  });
});
