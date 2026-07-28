import { describe, expect, it } from "vitest";

import {
  ContextAssemblyError,
  RECENT_WINDOW_POLICY_ID,
  assembleConversationContext,
  recentWindowTrimPolicy,
} from "../../../src/extensions/llm/index.js";
import type {
  ContextTrimPolicy,
  ConversationUnit,
} from "../../../src/extensions/llm/index.js";
import { chatSnapshot, reactiveInput, renderedText, textBlock } from "./fixtures.js";

const FRAMEWORK = "Framework section for tests.";

function historyUnit(id: string, body: string): ConversationUnit {
  return {
    unitId: id,
    kind: "history",
    blockIds: [`blk-${id}`],
    messages: [{ role: "user", parts: [{ kind: "text", text: body }] }],
  };
}

function history(count: number, bodyBytes: number): ConversationUnit[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `h${index + 1}`;
    return historyUnit(id, `${id}-marker ${"a".repeat(bodyBytes)}`);
  });
}

function inputUnitsOf(units: readonly ConversationUnit[]): ConversationUnit[] {
  return units.filter((unit) => unit.kind === "input-block");
}

describe("recent-window trim policy", () => {
  it("orders unprotected units oldest first, then the protected window oldest first", () => {
    const units: ConversationUnit[] = [
      ...history(5, 8),
      {
        unitId: "input:b-1",
        kind: "input-block",
        blockIds: ["b-1"],
        messages: [{ role: "user", parts: [{ kind: "text", text: "current" }] }],
      },
    ];

    const order = recentWindowTrimPolicy({ protectedRecentUnits: 2 }).order(units);
    expect(order).toEqual(["h1", "h2", "h3", "h4", "h5"]);

    const noProtection = recentWindowTrimPolicy({ protectedRecentUnits: 0 }).order(units);
    expect(noProtection).toEqual(["h1", "h2", "h3", "h4", "h5"]);
  });

  it("never offers the current input batch for eviction", () => {
    const units: ConversationUnit[] = [
      historyUnit("h1", "old"),
      {
        unitId: "input:b-1",
        kind: "input-block",
        blockIds: ["b-1"],
        messages: [{ role: "user", parts: [{ kind: "text", text: "current" }] }],
      },
    ];

    expect(recentWindowTrimPolicy().order(units)).toEqual(["h1"]);
  });

  it("uses a stable policy identifier", () => {
    expect(recentWindowTrimPolicy().policyId).toBe(RECENT_WINDOW_POLICY_ID);
  });
});

describe("pluggable policy validation", () => {
  const base = {
    moduleId: "llm-main",
    descriptor: chatSnapshot(),
    input: reactiveInput([{ block: textBlock("b-1", "current input") }]),
    history: history(2, 8),
    systemPrompt: { frameworkText: FRAMEWORK },
  } as const;

  function policy(order: readonly string[]): ContextTrimPolicy {
    return { policyId: "test.policy/1", order: () => order };
  }

  it("rejects an order that names a unit which is not evictable", () => {
    try {
      assembleConversationContext({ ...base, trimPolicy: policy(["h1", "h2", "input:b-1"]) });
      expect.unreachable("the current input batch is not evictable");
    } catch (error) {
      expect((error as ContextAssemblyError).code).toBe("CONTEXT_TRIM_POLICY_INVALID");
      expect((error as ContextAssemblyError).details.unitId).toBe("input:b-1");
    }
  });

  it("rejects a duplicated unit", () => {
    try {
      assembleConversationContext({ ...base, trimPolicy: policy(["h1", "h1", "h2"]) });
      expect.unreachable("a duplicate makes the eviction sequence ambiguous");
    } catch (error) {
      expect((error as ContextAssemblyError).code).toBe("CONTEXT_TRIM_POLICY_INVALID");
    }
  });

  it("rejects an order that withholds an evictable unit", () => {
    try {
      assembleConversationContext({ ...base, trimPolicy: policy(["h1"]) });
      expect.unreachable("a withheld unit could make a satisfiable request fail");
    } catch (error) {
      expect((error as ContextAssemblyError).code).toBe("CONTEXT_TRIM_POLICY_INVALID");
      expect((error as ContextAssemblyError).details.evictable).toBe(2);
    }
  });
});

describe("deterministic trimming under budget", () => {
  const historyUnits = history(5, 2000);
  const request = {
    moduleId: "llm-main",
    descriptor: chatSnapshot(),
    input: reactiveInput([{ block: textBlock("b-current", "the newest question") }]),
    history: historyUnits,
    systemPrompt: { frameworkText: FRAMEWORK },
  } as const;

  const full = assembleConversationContext({
    ...request,
    limits: { maxTotalBytes: 256 * 1024, maxSystemPromptBytes: 8 * 1024 },
  });

  it("keeps everything when the budget is generous", () => {
    expect(full.report.evictedUnitIds).toEqual([]);
    expect(renderedText(full.messages)).toContain("h1-marker");
    expect(renderedText(full.messages)).not.toContain("context-trimmed");
  });

  it("removes whole units from the oldest end and leaves a visible placeholder", () => {
    const trimmed = assembleConversationContext({
      ...request,
      limits: {
        maxTotalBytes: full.report.totalBytes - 4500,
        maxSystemPromptBytes: 4 * 1024,
      },
    });

    const evicted = trimmed.report.evictedUnitIds;
    const order = recentWindowTrimPolicy().order([...historyUnits, ...inputUnitsOf(full.units)]);
    expect(evicted.length).toBeGreaterThan(0);
    expect(evicted.length).toBeLessThan(historyUnits.length);
    expect(evicted).toEqual(order.slice(0, evicted.length));

    const text = renderedText(trimmed.messages);
    for (const unitId of evicted) expect(text).not.toContain(`${unitId}-marker`);
    for (const unit of historyUnits) {
      if (!evicted.includes(unit.unitId)) expect(text).toContain(`${unit.unitId}-marker`);
    }

    expect(text).toContain(`[dolly#${trimmed.fenceToken} context-trimmed="${evicted.length}"`);
    expect(text).toContain(`policy="${RECENT_WINDOW_POLICY_ID}"`);
    expect(text).toContain(`blocks="${evicted.map((id) => `blk-${id}`).join(",")}"`);
    expect(text).toContain("were removed here to fit this");
    expect(text).toContain("the newest question");
    expect(trimmed.report.totalBytes).toBeLessThanOrEqual(full.report.totalBytes - 4500);
  });

  it("reaches the same decision every time", () => {
    const limits = {
      maxTotalBytes: full.report.totalBytes - 4500,
      maxSystemPromptBytes: 4 * 1024,
    };
    const first = assembleConversationContext({ ...request, limits });
    const second = assembleConversationContext({ ...request, limits });

    expect(second.report.evictedUnitIds).toEqual(first.report.evictedUnitIds);
    expect(second.messages).toEqual(first.messages);
  });

  it("gives up the protected window last, oldest first, and keeps the newest unit longest", () => {
    // The default window protects the four newest history units, so h1 goes
    // first as unprotected and h2..h4 are then surrendered from the oldest end
    // of the protected window. h5, the newest, is the last one standing.
    const trimmed = assembleConversationContext({
      ...request,
      limits: { maxTotalBytes: 4096, maxSystemPromptBytes: 3072 },
    });

    expect(trimmed.report.evictedUnitIds).toEqual(["h1", "h2", "h3", "h4"]);
    expect(trimmed.report.notices.filter((notice) => notice.code === "UNIT_EVICTED")).toHaveLength(
      4,
    );
    const text = renderedText(trimmed.messages);
    expect(text).toContain("h5-marker");
    expect(text).not.toContain("h4-marker");
    expect(text).toContain("the newest question");
  });

  it("emits one placeholder per contiguous removed span", () => {
    const middleOnly: ContextTrimPolicy = {
      policyId: "test.middle-first/1",
      order: () => ["h2", "h4", "h1", "h3", "h5"],
    };
    const trimmed = assembleConversationContext({
      ...request,
      trimPolicy: middleOnly,
      limits: { maxTotalBytes: full.report.totalBytes - 3000, maxSystemPromptBytes: 4 * 1024 },
    });

    expect(trimmed.report.evictedUnitIds).toEqual(["h2", "h4"]);
    const text = renderedText(trimmed.messages);
    expect(text.split('context-trimmed="1"').length - 1).toBe(2);
    expect(text).toContain('blocks="blk-h2"');
    expect(text).toContain('blocks="blk-h4"');
  });

  it("fails with a typed error when the current input cannot fit at all", () => {
    try {
      assembleConversationContext({
        moduleId: "llm-main",
        descriptor: chatSnapshot(),
        input: reactiveInput([{ block: textBlock("b-huge", "z".repeat(8192)) }]),
        history: history(2, 500),
        systemPrompt: { frameworkText: FRAMEWORK },
        limits: { maxTotalBytes: 4096, maxSystemPromptBytes: 3072 },
      });
      expect.unreachable("an input batch that cannot fit must fail before provider I/O");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextAssemblyError);
      expect((error as ContextAssemblyError).code).toBe("CONTEXT_INPUT_DOES_NOT_FIT");
      expect((error as ContextAssemblyError).details.maxTotalBytes).toBe(4096);
    }
  });

  it("trims on the message-count budget as well as the byte budget", () => {
    const trimmed = assembleConversationContext({
      ...request,
      limits: {
        maxTotalBytes: 256 * 1024,
        maxMessages: 3,
        maxSystemPromptBytes: 8 * 1024,
      },
    });

    expect(trimmed.messages.length).toBeLessThanOrEqual(3);
    expect(trimmed.report.evictedUnitIds).toEqual(["h1", "h2", "h3", "h4", "h5"]);
  });
});
