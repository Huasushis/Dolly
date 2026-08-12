import { describe, expect, it } from "vitest";

import { readStrictOpenAiToolSse } from "../../../scripts/experiments/probes/strict-openai-tool-sse.mjs";

const identity = {
  id: "chatcmpl-tool-stream-1",
  object: "chat.completion.chunk",
  created: 1_786_000_001,
  model: "qwen3.6-reasoner",
};

function event(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function response(events: string): Response {
  return new Response(events, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function completeToolStream(): string {
  return [
    event({
      ...identity,
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          reasoning_content: "plan",
          tool_calls: [{
            index: 0,
            id: "call-1",
            type: "function",
            function: { name: "read_configuration", arguments: "{" },
          }],
        },
      }],
    }),
    event({
      ...identity,
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] },
      }],
    }),
    event({
      ...identity,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    }),
    event({
      ...identity,
      choices: [{ index: 0, delta: {} }],
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
    }),
    "data: [DONE]\n\n",
  ].join("");
}

describe("strict OpenAI-compatible tool-call SSE", () => {
  it("reconstructs fragmented tool arguments and terminal usage", async () => {
    const parsed = await readStrictOpenAiToolSse(response(completeToolStream()));
    expect(parsed.body).toMatchObject({
      choices: [{
        message: {
          reasoning_content: "plan",
          tool_calls: [{
            id: "call-1",
            function: { name: "read_configuration", arguments: "{}" },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { total_tokens: 11 },
    });
    expect(parsed.evidence).toMatchObject({
      toolCallCount: 1,
      usageEventCount: 1,
      doneCount: 1,
    });
  });

  it.each([
    ["missing usage", completeToolStream().replace(event({
      ...identity,
      choices: [{ index: 0, delta: {} }],
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
    }), "")],
    ["missing DONE", completeToolStream().replace("data: [DONE]\n\n", "")],
    ["data after DONE", `${completeToolStream()}data: {}\n\n`],
    ["changed tool id", completeToolStream().replace(
      "function\":{\"arguments\":\"}\"}",
      "id\":\"call-2\",\"function\":{\"arguments\":\"}\"}",
    )],
    ["incomplete arguments", completeToolStream().replace(
      "function\":{\"arguments\":\"}\"}",
      "function\":{\"arguments\":\"\"}",
    )],
  ])("rejects %s", async (_label, candidate) => {
    await expect(readStrictOpenAiToolSse(response(candidate))).rejects.toBeInstanceOf(Error);
  });
});
