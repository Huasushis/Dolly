import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "../../../src/core/canonical-json.js";
import {
  ExtensionCapabilityAuthority,
  type ExtensionCapabilityHandle,
  type ExtensionSessionIdentity,
} from "../../../src/core/extension-capability.js";
import {
  createToolInvocationCapability,
  createToolInvocationCapabilityV2,
  type ToolInvocationCapabilityOptions,
  type ToolInvocationRunBinding,
  type ToolPolicySessionPort,
  type ToolRegistryView,
} from "../../../src/core/provider-capabilities/index.js";
import {
  InMemoryToolJournalRepository,
  ToolPolicySession,
  ToolRegistry,
  type ToolApprovalProvider,
  type ToolDescriptor,
  type ToolExecutor,
  type ToolTurnBudget,
} from "../../../src/core/tool-policy.js";

const NOW = "2026-07-26T00:00:00.000Z";
const EXPIRES_AT = "2026-07-27T00:00:00.000Z";
const IDENTITY: ExtensionSessionIdentity = {
  extensionId: "com.example.llm",
  instanceId: "instance-a",
  processGenerationId: "process-generation-a",
  sessionId: "session-a",
  moduleId: "module-a",
  moduleGenerationId: "module-generation-a",
};
const EXECUTION_SCOPE = { moduleJobId: "module-job-a", runId: "run-a" } as const;

const readTool: ToolDescriptor = {
  toolId: "notes.read",
  wireName: "read_note",
  description: "Read one note",
  argumentSchema: {
    type: "object",
    properties: { key: { type: "string", maxBytes: 32 } },
    required: ["key"],
    additionalProperties: false,
    maxProperties: 1,
  },
  resultSchema: {
    type: "object",
    properties: { value: { type: "string", maxBytes: 64 } },
    required: ["value"],
    additionalProperties: false,
    maxProperties: 1,
  },
  effectClass: "read",
  resourceScope: "notes",
  approval: "never",
  idempotency: "effect-key",
  outcomeQuery: "supported",
  parallel: "safe",
  deadlineMs: 1_000,
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
  deadlineMs: 1_000,
  maxArgumentBytes: 256,
  maxResultBytes: 64,
};

const BUDGET: ToolTurnBudget = {
  maxRounds: 3,
  maxCalls: 8,
  maxCallsPerRound: 4,
  maxApprovals: 3,
  maxCallBytes: 512,
};

interface HarnessOptions {
  readonly registry?: ToolRegistry;
  readonly repository?: InMemoryToolJournalRepository;
  readonly approval?: ToolApprovalProvider;
  readonly executor?: ToolExecutor;
  readonly budget?: ToolTurnBudget;
  readonly policy?: ToolPolicySessionPort;
  readonly registryView?: ToolRegistryView;
  readonly overrides?: Partial<ToolInvocationCapabilityOptions>;
}

function createHarness(options: HarnessOptions = {}) {
  let handleSeed = 0;
  const authority = new ExtensionCapabilityAuthority({
    now: () => NOW,
    nextHandle: () => Buffer.alloc(32, (handleSeed += 1)).toString("base64url"),
  });
  const session = authority.openSession(IDENTITY);
  const registry = options.registry ?? new ToolRegistry([readTool, hiddenTool], [readTool.toolId]);
  const approval =
    options.approval ??
    ({ decide: vi.fn().mockResolvedValue({ decision: "approved", code: "APPROVED" }) } as
      ToolApprovalProvider);
  const executor =
    options.executor ??
    ({
      execute: vi.fn().mockResolvedValue({ status: "succeeded", content: { value: "ok" } }),
    } as ToolExecutor);
  const budget = options.budget ?? BUDGET;
  const policy =
    options.policy ??
    new ToolPolicySession({
      moduleJobId: EXECUTION_SCOPE.moduleJobId,
      registry,
      repository: options.repository ?? new InMemoryToolJournalRepository(),
      approval,
      executor,
      budget,
      approvalPolicyRevision: "policy-1",
    });
  const definition = createToolInvocationCapability({
    policy,
    registry: options.registryView ?? registry,
    budget,
    executionScope: EXECUTION_SCOPE,
    expiresAt: EXPIRES_AT,
    approvalPolicyRevision: "policy-1",
    ...(options.overrides ?? {}),
  } as ToolInvocationCapabilityOptions);
  const handle: ExtensionCapabilityHandle = session.issue(definition.grant, definition.handler);
  return {
    authority,
    session,
    handle,
    approval,
    executor,
    grant: definition.grant,
    invoke(operation: string, argumentsValue: unknown): Promise<JsonValue> {
      return session.invoke({
        handle,
        operation,
        arguments: argumentsValue as JsonValue,
        moduleJobId: EXECUTION_SCOPE.moduleJobId,
        runId: EXECUTION_SCOPE.runId,
      });
    },
  };
}

function createV2Binding(options: {
  readonly moduleJobId: string;
  readonly registry: ToolRegistry;
  readonly executor?: ToolExecutor;
  readonly budget?: ToolTurnBudget;
}): ToolInvocationRunBinding {
  const budget = options.budget ?? BUDGET;
  return {
    registry: options.registry,
    budget,
    policy: new ToolPolicySession({
      moduleJobId: options.moduleJobId,
      registry: options.registry,
      repository: new InMemoryToolJournalRepository(),
      approval: { decide: vi.fn().mockResolvedValue({ decision: "approved", code: "APPROVED" }) },
      executor:
        options.executor ??
        ({
          execute: vi.fn().mockResolvedValue({ status: "succeeded", content: { value: "ok" } }),
        } as ToolExecutor),
      budget,
      approvalPolicyRevision: "policy-1",
    }),
  };
}

function results(round: JsonValue): [string, string, string][] {
  return (round as { results: { status: string; code: string; effectSlot: string }[] }).results.map(
    (entry) => [entry.status, entry.code, entry.effectSlot],
  );
}

describe("Extension tool invocation capability", () => {
  it("exposes only the per-session allowlist and refuses extension-supplied tools", async () => {
    const harness = createHarness();

    const view = await harness.invoke("list-tools", {});
    expect(view).toMatchObject({
      schemaVersion: "dolly.tool-registry-view/1",
      moduleJobId: "module-job-a",
    });
    expect((view as { tools: { name: string }[] }).tools.map((tool) => tool.name)).toEqual([
      "read_note",
    ]);
    expect(harness.grant.resourceScope).toMatchObject({ toolWireNames: ["read_note"] });

    for (const forged of [
      { roundIndex: 1, calls: [], tools: [{ name: "shell", parameters: {} }] },
      { roundIndex: 1, calls: [], approved: true },
      { roundIndex: 1, calls: [], approvalPolicyRevision: "policy-2" },
    ]) {
      await expect(harness.invoke("execute-round", forged)).rejects.toMatchObject({
        code: "CAPABILITY_ARGUMENT_INVALID",
      });
    }

    // A tool that exists in the catalogue but is not selected is refused as an
    // honest terminal result inside a complete round.
    const round = await harness.invoke("execute-round", {
      roundIndex: 1,
      calls: [
        { callId: "call-1", name: "hidden_note", argumentsJson: JSON.stringify({ key: "a" }) },
        { callId: "call-2", name: "read_note", argumentsJson: JSON.stringify({ key: "a" }) },
      ],
    });
    expect(results(round)).toEqual([
      ["denied", "TOOL_NOT_ALLOWED", "round-1-call-1"],
      ["succeeded", "OK", "round-1-call-2"],
    ]);
    expect(harness.executor.execute).toHaveBeenCalledTimes(1);
  });

  it("keeps approval on the host path and binds it to the exact slot", async () => {
    const decide = vi
      .fn()
      .mockResolvedValueOnce({ decision: "denied", code: "HUMAN_DENIED" })
      .mockResolvedValueOnce({ decision: "approved", code: "HUMAN_APPROVED" });
    const execute = vi.fn().mockResolvedValue({ status: "succeeded", content: { delivered: true } });
    const harness = createHarness({
      registry: new ToolRegistry([sendTool], [sendTool.toolId]),
      approval: { decide },
      executor: { execute },
    });

    const denied = await harness.invoke("execute-round", {
      roundIndex: 1,
      calls: [
        {
          callId: "call-1",
          name: "send_message",
          argumentsJson: JSON.stringify({ recipient: "alice", text: "hello" }),
        },
      ],
    });
    expect(results(denied)).toEqual([["denied", "HUMAN_DENIED", "round-1-call-1"]]);
    expect(execute).not.toHaveBeenCalled();

    const approved = await harness.invoke("execute-round", {
      roundIndex: 2,
      calls: [
        {
          callId: "call-2",
          name: "send_message",
          argumentsJson: JSON.stringify({ recipient: "alice", text: "hello" }),
        },
      ],
    });
    expect(results(approved)).toEqual([["succeeded", "OK", "round-2-call-1"]]);
    expect(decide).toHaveBeenLastCalledWith(
      expect.objectContaining({
        moduleJobId: "module-job-a",
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
        arguments: { recipient: "alice", text: "hello" },
      }),
    );
  });

  it("rejects malformed arguments, closed-schema violations, and duplicate call identities", async () => {
    const harness = createHarness();

    const round = await harness.invoke("execute-round", {
      roundIndex: 1,
      calls: [
        { callId: "call-json", name: "read_note", argumentsJson: "{" },
        {
          callId: "call-schema",
          name: "read_note",
          argumentsJson: JSON.stringify({ key: "a", extra: true }),
        },
        { callId: "call-ok", name: "read_note", argumentsJson: JSON.stringify({ key: "a" }) },
      ],
    });
    expect(results(round)).toEqual([
      ["invalid-arguments", "TOOL_ARGUMENT_JSON_INVALID", "round-1-call-1"],
      ["invalid-arguments", "TOOL_ARGUMENT_SCHEMA_INVALID", "round-1-call-2"],
      ["succeeded", "OK", "round-1-call-3"],
    ]);
    // Never an assumed `{}`: only the well-formed call reached the executor.
    expect(harness.executor.execute).toHaveBeenCalledTimes(1);
    expect(
      (harness.executor.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0].arguments,
    ).toEqual({ key: "a" });

    await expect(
      harness.invoke("execute-round", {
        roundIndex: 2,
        calls: [
          { callId: "same", name: "read_note", argumentsJson: JSON.stringify({ key: "a" }) },
          { callId: "same", name: "read_note", argumentsJson: JSON.stringify({ key: "b" }) },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_ARGUMENT_INVALID",
      details: { reason: "TOOL_ROUND_INVALID" },
    });
    await expect(
      harness.invoke("execute-round", {
        roundIndex: 3,
        calls: [{ callId: "call-x", name: "read_note", argumentsJson: 17 }],
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
  });

  it("refuses a registry whose wire names collide", () => {
    const colliding: ToolRegistryView = {
      resolveWireName: () => readTool,
      providerDefinitions: () => [
        { name: "read_note", description: "a", parameters: readTool.argumentSchema },
        { name: "read_note", description: "b", parameters: readTool.argumentSchema },
      ],
    };
    expect(() =>
      createToolInvocationCapability({
        policy: { executeRound: vi.fn() } as unknown as ToolPolicySessionPort,
        registry: colliding,
        budget: BUDGET,
        executionScope: EXECUTION_SCOPE,
        expiresAt: EXPIRES_AT,
        approvalPolicyRevision: "policy-1",
      }),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_CONFIG_INVALID" }));

    const unresolvable: ToolRegistryView = {
      resolveWireName: () => null,
      providerDefinitions: () => [
        { name: "read_note", description: "a", parameters: readTool.argumentSchema },
      ],
    };
    expect(() =>
      createToolInvocationCapability({
        policy: { executeRound: vi.fn() } as unknown as ToolPolicySessionPort,
        registry: unresolvable,
        budget: BUDGET,
        executionScope: EXECUTION_SCOPE,
        expiresAt: EXPIRES_AT,
        approvalPolicyRevision: "policy-1",
      }),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_CONFIG_INVALID" }));
  });

  it("bounds rounds and calls before any effect runs", async () => {
    const harness = createHarness({
      budget: { maxRounds: 2, maxCalls: 2, maxCallsPerRound: 2, maxApprovals: 1, maxCallBytes: 512 },
    });

    await expect(
      harness.invoke("execute-round", {
        roundIndex: 3,
        calls: [{ callId: "call-1", name: "read_note", argumentsJson: '{"key":"a"}' }],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_QUOTA_EXCEEDED",
      details: { limit: "maxRounds", allowed: 2 },
    });
    expect(harness.executor.execute).not.toHaveBeenCalled();

    await harness.invoke("execute-round", {
      roundIndex: 1,
      calls: [
        { callId: "call-1", name: "read_note", argumentsJson: '{"key":"a"}' },
        { callId: "call-2", name: "read_note", argumentsJson: '{"key":"b"}' },
      ],
    });
    await expect(
      harness.invoke("execute-round", {
        roundIndex: 2,
        calls: [{ callId: "call-3", name: "read_note", argumentsJson: '{"key":"c"}' }],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_QUOTA_EXCEEDED",
      details: { reason: "TOOL_BUDGET_EXHAUSTED" },
    });
    expect(harness.executor.execute).toHaveBeenCalledTimes(2);
  });

  it("freezes continuation after an uncertain effect and never replays it", async () => {
    const repository = new InMemoryToolJournalRepository();
    const execute = vi.fn().mockRejectedValue(new Error("transport lost after send"));
    const decide = vi.fn().mockResolvedValue({ decision: "approved", code: "APPROVED" });
    const registry = new ToolRegistry([sendTool, readTool], [sendTool.toolId, readTool.toolId]);
    const harness = createHarness({ registry, repository, approval: { decide }, executor: { execute } });
    const calls = [
      {
        callId: "call-1",
        name: "send_message",
        argumentsJson: JSON.stringify({ recipient: "alice", text: "hello" }),
      },
      { callId: "call-2", name: "read_note", argumentsJson: JSON.stringify({ key: "later" }) },
    ];

    const uncertain = await harness.invoke("execute-round", { roundIndex: 1, calls });
    expect(uncertain).toMatchObject({ state: "outcome-unknown", canContinue: false });
    expect(results(uncertain)).toEqual([
      ["outcome-unknown", "TOOL_EFFECT_UNCERTAIN", "round-1-call-1"],
      ["cancelled", "ROUND_BLOCKED_BY_UNKNOWN_OUTCOME", "round-1-call-2"],
    ]);
    expect(execute).toHaveBeenCalledTimes(1);

    // A new round is blocked: continuing past an uncertain effect is a
    // decision this handle has no authority to make.
    await expect(
      harness.invoke("execute-round", {
        roundIndex: 2,
        calls: [{ callId: "call-3", name: "read_note", argumentsJson: '{"key":"a"}' }],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
      details: { reason: "TOOL_ROUND_BLOCKED_BY_UNKNOWN_OUTCOME", blockedAtRound: 1 },
    });

    // Reconciling the recorded round replays the journal, not the effect.
    const replay = await harness.invoke("execute-round", {
      roundIndex: 1,
      calls: calls.map((call, index) => ({ ...call, callId: `replacement-${index + 1}` })),
    });
    expect(replay).toMatchObject({ state: "outcome-unknown", canContinue: false });
    expect(
      (replay as { results: { callId: string }[] }).results.map((entry) => entry.callId),
    ).toEqual(["replacement-1", "replacement-2"]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("refuses a round result that is incomplete or belongs to another Module job", async () => {
    const incomplete = createHarness({
      policy: {
        executeRound: vi.fn(async () => ({
          moduleJobId: EXECUTION_SCOPE.moduleJobId,
          roundIndex: 1,
          state: "complete" as const,
          canContinue: true,
          results: [
            {
              providerCallId: "call-1",
              wireName: "read_note",
              effectSlot: "round-1-call-1",
              status: "succeeded" as const,
              code: "OK",
            },
          ],
        })),
      },
    });
    await expect(
      incomplete.invoke("execute-round", {
        roundIndex: 1,
        calls: [
          { callId: "call-1", name: "read_note", argumentsJson: '{"key":"a"}' },
          { callId: "call-2", name: "read_note", argumentsJson: '{"key":"b"}' },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_RESULT_INVALID",
      details: { reason: "TOOL_ROUND_INCOMPLETE" },
    });

    const foreign = createHarness({
      policy: {
        executeRound: vi.fn(async () => ({
          moduleJobId: "module-job-other",
          roundIndex: 1,
          state: "complete" as const,
          canContinue: true,
          results: [
            {
              providerCallId: "call-1",
              wireName: "read_note",
              effectSlot: "round-1-call-1",
              status: "succeeded" as const,
              code: "OK",
            },
          ],
        })),
      },
    });
    await expect(
      foreign.invoke("execute-round", {
        roundIndex: 1,
        calls: [{ callId: "call-1", name: "read_note", argumentsJson: '{"key":"a"}' }],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_SCOPE_MISMATCH",
      details: { reason: "TOOL_ROUND_SCOPE_MISMATCH" },
    });
  });

  it("rejects a handle used from another session, another job, or after revocation", async () => {
    const harness = createHarness();
    const other = harness.authority.openSession({ ...IDENTITY, sessionId: "session-b" });
    const call = {
      roundIndex: 1,
      calls: [{ callId: "call-1", name: "read_note", argumentsJson: '{"key":"a"}' }],
    };

    await expect(
      other.invoke({
        handle: harness.handle,
        operation: "execute-round",
        arguments: call,
        moduleJobId: EXECUTION_SCOPE.moduleJobId,
        runId: EXECUTION_SCOPE.runId,
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    await expect(
      harness.session.invoke({
        handle: harness.handle,
        operation: "execute-round",
        arguments: call,
        moduleJobId: "module-job-b",
        runId: EXECUTION_SCOPE.runId,
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_SCOPE_MISMATCH" });
    await expect(harness.invoke("shell", {})).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });

    expect(harness.session.revoke(harness.handle)).toBe("revoked");
    await expect(harness.invoke("execute-round", call)).rejects.toMatchObject({
      code: "CAPABILITY_REVOKED",
    });
    expect(harness.executor.execute).not.toHaveBeenCalled();
  });
});

describe("Extension tool invocation capability version two", () => {
  it("publishes the complete selected tool contract without internal authority fields", async () => {
    const registry = new ToolRegistry([readTool, hiddenTool], [readTool.toolId]);
    const binding = createV2Binding({ moduleJobId: EXECUTION_SCOPE.moduleJobId, registry });
    const authority = new ExtensionCapabilityAuthority({ now: () => NOW });
    const session = authority.openSession(IDENTITY);
    const definition = createToolInvocationCapabilityV2({
      executionScope: EXECUTION_SCOPE,
      binding,
      expiresAt: EXPIRES_AT,
    });
    const handle = session.issue(definition.grant, definition.handler);

    const view = await session.invoke({
      handle,
      operation: "list-tools",
      arguments: {},
      ...EXECUTION_SCOPE,
    });

    expect(view).toEqual({
      schemaVersion: "dolly.tool-registry-view/2",
      moduleJobId: "module-job-a",
      registryDigest: registry.snapshot().registryDigest,
      budget: BUDGET,
      tools: [
        {
          name: "read_note",
          description: "Read one note",
          schemaDialect: "dolly.tool-value-schema/1",
          argumentSchema: readTool.argumentSchema,
          successResultSchema: readTool.resultSchema,
          effectClass: "read",
          approval: "never",
          idempotency: "effect-key",
          outcomeQuery: "supported",
          parallel: "safe",
          limits: {
            deadlineMs: 1_000,
            maxArgumentBytes: 128,
            maxResultBytes: 128,
          },
        },
      ],
    });
    expect(JSON.stringify(view)).not.toContain("notes.read");
    expect(JSON.stringify(view)).not.toContain("resourceScope");
    expect(definition.grant).toMatchObject({
      capabilityVersion: "v2",
      resourceScope: {
        schemaVersion: "dolly.capability-scope.tool-invocation/2",
        registryDigest: registry.snapshot().registryDigest,
        toolWireNames: ["read_note"],
      },
    });

    const hidden = await session.invoke({
      handle,
      operation: "execute-round",
      arguments: {
        roundIndex: 1,
        calls: [
          { callId: "call-hidden", name: "hidden_note", argumentsJson: '{"key":"a"}' },
        ],
      },
      ...EXECUTION_SCOPE,
    });
    expect(results(hidden)).toEqual([
      ["denied", "TOOL_NOT_ALLOWED", "round-1-call-1"],
    ]);
  });

  it("rejects an advertised registry that differs from the executing policy", () => {
    const advertised = new ToolRegistry([readTool], [readTool.toolId]);
    const changedResultTool: ToolDescriptor = {
      ...readTool,
      resultSchema: {
        type: "object",
        properties: { value: { type: "string", maxBytes: 63 } },
        required: ["value"],
        additionalProperties: false,
        maxProperties: 1,
      },
    };
    const executing = new ToolRegistry([changedResultTool], [changedResultTool.toolId]);
    const executingBinding = createV2Binding({
      moduleJobId: EXECUTION_SCOPE.moduleJobId,
      registry: executing,
    });

    expect(() =>
      createToolInvocationCapabilityV2({
        executionScope: EXECUTION_SCOPE,
        binding: { ...executingBinding, registry: advertised },
        expiresAt: EXPIRES_AT,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CAPABILITY_CONFIG_INVALID",
        message: "Tool policy and advertised registry use different descriptors",
      }),
    );

    const foreignJob = createV2Binding({ moduleJobId: "module-job-other", registry: advertised });
    expect(() =>
      createToolInvocationCapabilityV2({
        executionScope: EXECUTION_SCOPE,
        binding: foreignJob,
        expiresAt: EXPIRES_AT,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CAPABILITY_CONFIG_INVALID",
        message: "Tool policy belongs to another Module job",
      }),
    );
  });

  it("changes the binding digest when executable schema, policy, limit, or scope changes", () => {
    const baseline = new ToolRegistry([readTool], [readTool.toolId]).snapshot().registryDigest;
    const variants: readonly ToolDescriptor[] = [
      {
        ...readTool,
        argumentSchema: {
          ...readTool.argumentSchema,
          properties: { key: { type: "string", maxBytes: 31 } },
        },
      },
      {
        ...readTool,
        resultSchema: { type: "string", maxBytes: 64 },
      },
      {
        ...readTool,
        effectClass: "write",
        approval: "required",
      },
      { ...readTool, maxResultBytes: 127 },
      { ...readTool, resourceScope: "notes-other" },
    ];

    for (const descriptor of variants) {
      expect(new ToolRegistry([descriptor], [descriptor.toolId]).snapshot().registryDigest).not.toBe(
        baseline,
      );
    }
  });

  it("resolves and freezes one host-owned binding per active Module job", async () => {
    const secondTool: ToolDescriptor = {
      ...readTool,
      toolId: "notes.second",
      wireName: "read_second",
      description: "Read the second note store",
    };
    const registryA = new ToolRegistry([readTool], [readTool.toolId]);
    const registryB = new ToolRegistry([secondTool], [secondTool.toolId]);
    const executeA = vi.fn().mockResolvedValue({ status: "succeeded", content: { value: "a" } });
    const executeB = vi.fn().mockResolvedValue({ status: "succeeded", content: { value: "b" } });
    const bindingA = createV2Binding({
      moduleJobId: "module-job-a",
      registry: registryA,
      executor: { execute: executeA },
    });
    const bindingB = createV2Binding({
      moduleJobId: "module-job-b",
      registry: registryB,
      executor: { execute: executeB },
    });
    const resolveRun = vi.fn((context: { moduleJobId: string }) =>
      context.moduleJobId === "module-job-a" ? bindingA : bindingB,
    );
    const authority = new ExtensionCapabilityAuthority({ now: () => NOW });
    const session = authority.openSession(IDENTITY);
    const definition = createToolInvocationCapabilityV2({
      executionScope: "active-run",
      resolveRun,
      expiresAt: EXPIRES_AT,
    });
    const handle = session.issue(definition.grant, definition.handler);
    const invoke = (
      moduleJobId: string,
      runId: string,
      operation: "list-tools" | "execute-round",
      argumentsValue: JsonValue,
      attempt = 1,
    ) =>
      session.invoke({
        handle,
        operation,
        arguments: argumentsValue,
        moduleJobId,
        runId,
        attempt,
        deadline: "2026-07-26T00:01:00.000Z",
      });

    const viewA = await invoke("module-job-a", "run-a", "list-tools", {});
    const viewB = await invoke("module-job-b", "run-b", "list-tools", {});
    const retryViewA = await invoke("module-job-a", "run-a-retry", "list-tools", {}, 2);
    expect((viewA as { registryDigest: string }).registryDigest).toBe(
      registryA.snapshot().registryDigest,
    );
    expect((viewB as { registryDigest: string }).registryDigest).toBe(
      registryB.snapshot().registryDigest,
    );
    expect((retryViewA as { registryDigest: string }).registryDigest).toBe(
      registryA.snapshot().registryDigest,
    );
    expect(resolveRun).toHaveBeenCalledTimes(2);
    expect(resolveRun).toHaveBeenNthCalledWith(1, {
      moduleJobId: "module-job-a",
      runId: "run-a",
      attempt: 1,
      deadline: "2026-07-26T00:01:00.000Z",
    });

    await invoke("module-job-a", "run-a", "execute-round", {
      roundIndex: 1,
      calls: [{ callId: "call-a", name: "read_note", argumentsJson: '{"key":"a"}' }],
    });
    await invoke("module-job-b", "run-b", "execute-round", {
      roundIndex: 1,
      calls: [{ callId: "call-b", name: "read_second", argumentsJson: '{"key":"b"}' }],
    });
    expect(executeA).toHaveBeenCalledOnce();
    expect(executeB).toHaveBeenCalledOnce();

    await expect(
      session.invoke({
        handle,
        operation: "list-tools",
        arguments: {},
        moduleJobId: "module-job-c",
        runId: "run-c",
        deadline: "2026-07-26T00:01:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_SCOPE_MISMATCH" });
  });
});
