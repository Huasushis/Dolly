import { describe, expect, it } from "vitest";

import {
  readStrictChatCompletionSse,
} from "../../../scripts/experiments/probes/memory-association-task-switch-v0/strict-chat-sse.mjs";

function response(events: string, contentType = "text/event-stream; charset=utf-8"): Response {
  return new Response(events, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

const identity = {
  id: "chatcmpl-memory-stream-1",
  object: "chat.completion.chunk",
  created: 1_786_000_000,
  model: "qwen3.6-reasoner",
};

function event(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function completeStream(): string {
  return [
    event({
      ...identity,
      choices: [{
        index: 0,
        delta: { role: "assistant", reasoning_content: "reason" },
      }],
    }),
    event({
      ...identity,
      choices: [{ index: 0, delta: { content: "{\"ok\":true}" } }],
    }),
    event({
      ...identity,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }),
    event({
      ...identity,
      choices: [{ index: 0, delta: {} }],
      usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
    }),
    "data: [DONE]\n\n",
  ].join("");
}

describe("Memory strict chat SSE reader", () => {
  it("reconstructs separate reasoning/content and requires terminal usage plus DONE", async () => {
    const parsed = await readStrictChatCompletionSse(response(completeStream()));

    expect(parsed.body).toMatchObject({
      model: identity.model,
      choices: [{
        message: {
          content: "{\"ok\":true}",
          reasoning_content: "reason",
        },
        finish_reason: "stop",
      }],
      usage: { total_tokens: 9 },
    });
    expect(parsed.evidence).toMatchObject({
      eventCount: 5,
      usageEventCount: 1,
      doneCount: 1,
      providerIdObserved: true,
    });
  });

  it.each([
    ["non-SSE content type", response(completeStream(), "application/json")],
    ["missing usage", response(completeStream().replace(event({
      ...identity,
      choices: [{ index: 0, delta: {} }],
      usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
    }), ""))],
    ["missing DONE", response(completeStream().replace("data: [DONE]\n\n", ""))],
    ["data after DONE", response(`${completeStream()}data: {}\n\n`)],
    ["provider identity drift", response(completeStream().replace(
      "chatcmpl-memory-stream-1",
      "chatcmpl-other",
    ))],
  ])("rejects %s", async (_label, candidate) => {
    await expect(readStrictChatCompletionSse(candidate)).rejects.toBeInstanceOf(Error);
  });
});
