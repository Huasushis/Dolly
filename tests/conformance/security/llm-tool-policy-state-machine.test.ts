import { describe, expect, it, vi } from "vitest";
import {
  InMemoryToolJournalRepository,
  ToolPolicyError,
  ToolPolicySession,
  ToolRegistry,
  type ToolApprovalProvider,
  type ToolDescriptor,
  type ToolExecutor,
  type ToolRoundJournalRecord,
  type ToolTurnBudget,
} from "../../../src/core/tool-policy.js";

const argumentSchema = {
  type: "object",
  properties: {
    key: { type: "string", maxBytes: 32 },
  },
  required: ["key"],
  additionalProperties: false,
  maxProperties: 1,
} as const;

const readResultSchema = {
  type: "object",
  properties: {
    value: { type: "string", maxBytes: 64 },
  },
  required: ["value"],
  additionalProperties: false,
  maxProperties: 1,
} as const;

const readTool: ToolDescriptor = {
  toolId: "notes.read",
  wireName: "read_note",
  description: "Read one note",
  argumentSchema,
  resultSchema: readResultSchema,
  effectClass: "read",
  resourceScope: "notes",
  approval: "never",
  idempotency: "effect-key",
  outcomeQuery: "supported",
  parallel: "safe",
  deadlineMs: 1000,
  maxArgumentBytes: 128,
  maxResultBytes: 128,
};

const hiddenTool: ToolDescriptor = {
  ...readTool,
  toolId: "notes.hidden",
  wireName: "hidden_note",
};

const sendTool: ToolDescriptor = {
  toolId: "messages.send",
  wireName: "send_message",
  description: "Send one external message",
  argumentSchema: {
    type: "object",
    properties: {
      recipient: { type: "string", maxBytes: 32 },
      text: { type: "string", minBytes: 1, maxBytes: 128 },
    },
    required: ["recipient", "text"],
    additionalProperties: false,
    maxProperties: 2,
  },
  resultSchema: {
    type: "object",
    properties: { delivered: { type: "boolean" } },
    required: ["delivered"],
    additionalProperties: false,
    maxProperties: 1,
  },
  effectClass: "external-communication",
  resourceScope: "messages",
  approval: "required",
  idempotency: "effect-key",
  outcomeQuery: "supported",
  parallel: "serial",
  deadlineMs: 1000,
  maxArgumentBytes: 256,
  maxResultBytes: 64,
};

const budget: ToolTurnBudget = {
  maxRounds: 4,
  maxCalls: 10,
  maxCallsPerRound: 5,
  maxApprovals: 3,
  maxCallBytes: 512,
};

function session(options: {
  readonly registry: ToolRegistry;
  readonly repository?: InMemoryToolJournalRepository;
  readonly approval?: ToolApprovalProvider;
  readonly executor?: ToolExecutor;
  readonly budget?: ToolTurnBudget;
}) {
  return new ToolPolicySession({
    moduleJobId: "module-job-1",
    registry: options.registry,
    repository: options.repository ?? new InMemoryToolJournalRepository(),
    approval:
      options.approval ??
      ({ decide: vi.fn().mockResolvedValue({ decision: "denied", code: "DENIED" }) } as ToolApprovalProvider),
    executor:
      options.executor ??
      ({
        execute: vi.fn().mockResolvedValue({
          status: "succeeded",
          content: { value: "ok" },
        }),
      } as ToolExecutor),
    budget: options.budget ?? budget,
    approvalPolicyRevision: "policy-1",
  });
}

describe("SEC-003 LLM tool policy state machine", () => {
  it("rejects tool round version 1 and the processingId field", () => {
    const repository = new InMemoryToolJournalRepository();
    const current: ToolRoundJournalRecord = {
      schemaVersion: "dolly.tool-round/2",
      moduleJobId: "module-job-1",
      roundIndex: 1,
      roundDigest: `sha256:${"1".repeat(64)}`,
      state: "reserved",
      revision: 1,
      effects: [],
    };
    expect(() => repository.reserveRound({
      ...current,
      schemaVersion: "dolly.tool-round/1",
    } as unknown as ToolRoundJournalRecord)).toThrowError(
      expect.objectContaining<Partial<ToolPolicyError>>({ code: "TOOL_ROUND_INVALID" }),
    );
    const { moduleJobId, ...withoutModuleJobId } = current;
    expect(() => repository.reserveRound({
      ...withoutModuleJobId,
      processingId: moduleJobId,
    } as unknown as ToolRoundJournalRecord)).toThrowError(
      expect.objectContaining<Partial<ToolPolicyError>>({ code: "TOOL_ROUND_INVALID" }),
    );
  });

  it("exposes only selected tools and terminally rejects malformed calls", async () => {
    const registry = new ToolRegistry([readTool, hiddenTool], [readTool.toolId]);
    const execute = vi.fn().mockResolvedValue({
      status: "succeeded",
      content: { value: "found" },
    });
    const runner = session({ registry, executor: { execute } });

    expect(registry.providerDefinitions().map((tool) => tool.name)).toEqual(["read_note"]);
    const result = await runner.executeRound({
      roundIndex: 1,
      calls: [
        { providerCallId: "call-hidden", wireName: "hidden_note", argumentsJson: "{}" },
        { providerCallId: "call-json", wireName: "read_note", argumentsJson: "{" },
        {
          providerCallId: "call-schema",
          wireName: "read_note",
          argumentsJson: JSON.stringify({ key: "a", extra: true }),
        },
        {
          providerCallId: "call-valid",
          wireName: "read_note",
          argumentsJson: JSON.stringify({ key: "a" }),
        },
      ],
    });

    expect(result.state).toBe("complete");
    expect(result.canContinue).toBe(true);
    expect(result.results.map((entry) => [entry.status, entry.code])).toEqual([
      ["denied", "TOOL_NOT_ALLOWED"],
      ["invalid-arguments", "TOOL_ARGUMENT_JSON_INVALID"],
      ["invalid-arguments", "TOOL_ARGUMENT_SCHEMA_INVALID"],
      ["succeeded", "OK"],
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0].arguments).toEqual({ key: "a" });
  });

  it("binds dangerous-effect approval to the exact tool, arguments, and slot", async () => {
    const registry = new ToolRegistry([sendTool], [sendTool.toolId]);
    const decide = vi
      .fn()
      .mockResolvedValueOnce({ decision: "denied", code: "HUMAN_DENIED" })
      .mockResolvedValueOnce({ decision: "approved", code: "HUMAN_APPROVED" });
    const execute = vi.fn().mockResolvedValue({
      status: "succeeded",
      content: { delivered: true },
    });
    const runner = session({
      registry,
      approval: { decide },
      executor: { execute },
    });

    const denied = await runner.executeRound({
      roundIndex: 1,
      calls: [
        {
          providerCallId: "call-1",
          wireName: "send_message",
          argumentsJson: JSON.stringify({ recipient: "alice", text: "hello" }),
        },
      ],
    });
    expect(denied.results[0]).toMatchObject({
      status: "denied",
      code: "HUMAN_DENIED",
      effectSlot: "round-1-call-1",
    });
    expect(execute).not.toHaveBeenCalled();

    const approved = await runner.executeRound({
      roundIndex: 2,
      calls: [
        {
          providerCallId: "call-2",
          wireName: "send_message",
          argumentsJson: JSON.stringify({ recipient: "alice", text: "approved" }),
        },
      ],
    });
    expect(approved.results[0]).toMatchObject({ status: "succeeded", code: "OK" });
    expect(decide).toHaveBeenLastCalledWith(
      expect.objectContaining({
        moduleJobId: "module-job-1",
        effectSlot: "round-2-call-1",
        toolId: "messages.send",
        effectClass: "external-communication",
        resourceScope: "messages",
        policyRevision: "policy-1",
        argumentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        effectSlot: "round-2-call-1",
        effectKey: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        arguments: { recipient: "alice", text: "approved" },
      }),
    );
  });

  it("enforces round, call, approval, and envelope budgets before effects", async () => {
    const registry = new ToolRegistry([readTool, sendTool], [readTool.toolId, sendTool.toolId]);
    const execute = vi.fn().mockResolvedValue({
      status: "succeeded",
      content: { delivered: true },
    });
    const decide = vi.fn().mockResolvedValue({ decision: "approved", code: "APPROVED" });
    const runner = session({
      registry,
      approval: { decide },
      executor: { execute },
      budget: {
        maxRounds: 1,
        maxCalls: 2,
        maxCallsPerRound: 2,
        maxApprovals: 1,
        maxCallBytes: 256,
      },
    });
    const result = await runner.executeRound({
      roundIndex: 1,
      calls: [
        {
          providerCallId: "call-1",
          wireName: "send_message",
          argumentsJson: JSON.stringify({ recipient: "a", text: "one" }),
        },
        {
          providerCallId: "call-2",
          wireName: "send_message",
          argumentsJson: JSON.stringify({ recipient: "b", text: "two" }),
        },
      ],
    });
    expect(result.results.map((entry) => entry.code)).toEqual([
      "OK",
      "APPROVAL_BUDGET_EXHAUSTED",
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledTimes(1);

    await expect(
      runner.executeRound({
        roundIndex: 2,
        calls: [
          { providerCallId: "call-3", wireName: "read_note", argumentsJson: '{"key":"a"}' },
        ],
      }),
    ).rejects.toMatchObject({ code: "TOOL_BUDGET_EXHAUSTED" });
    await expect(
      runner.executeRound({
        roundIndex: 1,
        calls: [
          {
            providerCallId: "call-large",
            wireName: "read_note",
            argumentsJson: JSON.stringify({ key: "x".repeat(300) }),
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ToolPolicyError);
  });

  it("freezes an uncertain effect and never blindly repeats it", async () => {
    const registry = new ToolRegistry([sendTool, readTool], [sendTool.toolId, readTool.toolId]);
    const repository = new InMemoryToolJournalRepository();
    const execute = vi.fn().mockRejectedValue(new Error("transport lost after send"));
    const first = session({
      registry,
      repository,
      approval: {
        decide: vi.fn().mockResolvedValue({ decision: "approved", code: "APPROVED" }),
      },
      executor: { execute },
    });
    const calls = [
      {
        providerCallId: "provider-call-a",
        wireName: "send_message",
        argumentsJson: JSON.stringify({ recipient: "alice", text: "hello" }),
      },
      {
        providerCallId: "provider-call-b",
        wireName: "read_note",
        argumentsJson: JSON.stringify({ key: "later" }),
      },
    ];
    const uncertain = await first.executeRound({ roundIndex: 1, calls });
    expect(uncertain).toMatchObject({ state: "outcome-unknown", canContinue: false });
    expect(uncertain.results.map((entry) => [entry.status, entry.code])).toEqual([
      ["outcome-unknown", "TOOL_EFFECT_UNCERTAIN"],
      ["cancelled", "ROUND_BLOCKED_BY_UNKNOWN_OUTCOME"],
    ]);
    expect(execute).toHaveBeenCalledTimes(1);

    const recovered = session({
      registry,
      repository,
      approval: {
        decide: vi.fn(() => {
          throw new Error("approval must not run during replay");
        }),
      },
      executor: {
        execute: vi.fn(() => {
          throw new Error("effect must not run during replay");
        }),
      },
    });
    const replay = await recovered.executeRound({
      roundIndex: 1,
      calls: calls.map((call, index) => ({
        ...call,
        providerCallId: `replacement-call-${index + 1}`,
      })),
    });
    expect(replay.state).toBe("outcome-unknown");
    expect(replay.results.map((entry) => entry.providerCallId)).toEqual([
      "replacement-call-1",
      "replacement-call-2",
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate mappings and duplicate provider call IDs", async () => {
    expect(
      () =>
        new ToolRegistry(
          [readTool, { ...hiddenTool, wireName: readTool.wireName }],
          [readTool.toolId],
        ),
    ).toThrowError(expect.objectContaining({ code: "TOOL_REGISTRY_INVALID" }));
    expect(
      () =>
        new ToolRegistry(
          [{ ...sendTool, approval: "never" }],
          [sendTool.toolId],
        ),
    ).toThrowError(expect.objectContaining({ code: "TOOL_REGISTRY_INVALID" }));

    const runner = session({ registry: new ToolRegistry([readTool], [readTool.toolId]) });
    await expect(
      runner.executeRound({
        roundIndex: 1,
        calls: [
          { providerCallId: "duplicate", wireName: "read_note", argumentsJson: '{"key":"a"}' },
          { providerCallId: "duplicate", wireName: "read_note", argumentsJson: '{"key":"b"}' },
        ],
      }),
    ).rejects.toMatchObject({ code: "TOOL_ROUND_INVALID" });
  });
});
