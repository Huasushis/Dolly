import { describe, expect, it } from "vitest";
import { createServer } from "node:http";

import {
  buildAetherChatRequest,
  callAetherChat,
} from "../../../scripts/experiments/probes/multimodal-input-v0/aether-client.mjs";

const configuration = {
  baseUrl: new URL("http://127.0.0.1:1/v1/"),
  apiKey: "test-only-key",
};

const body = {
  model: "qwen3.6-27b",
  messages: [{ role: "user", content: "test" }],
  thinking: { type: "disabled" },
  stream: true,
  stream_options: { include_usage: true },
};

describe("multimodal Aether strict-stream contract", () => {
  it("sends the closed streaming profile and reconstructs one strict SSE result", async () => {
    let receivedBody: Record<string, unknown> | undefined;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const identity = {
          id: "stream-test-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "qwen3.6-27b",
        };
        const events = [
          { ...identity, choices: [{ index: 0, delta: { role: "assistant", content: "{\"ok\":true}" }, finish_reason: null, logprobs: null }] },
          { ...identity, choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }] },
          { ...identity, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ];
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server address missing");
    try {
      const request = buildAetherChatRequest([{ role: "user", content: "test" }], 800);
      const result = await callAetherChat({
        baseUrl: new URL(`http://127.0.0.1:${address.port}/v1/`),
        apiKey: "test-only-key",
      }, request);
      expect(receivedBody).toEqual(request);
      expect(result).toMatchObject({
        response: {
          status: 200,
          finishReason: "stop",
          message: { content: "{\"ok\":true}", reasoningObserved: false },
        },
        streamEvidence: { usageEventCount: 1, doneCount: 1 },
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each([
    ["non-stream request", { ...body, stream: false }],
    ["missing terminal usage", { ...body, stream_options: undefined }],
    ["wrong thinking policy", { ...body, thinking: { type: "enabled" } }],
    ["legacy thinking switch", { ...body, enable_thinking: false }],
  ])("rejects %s before network", async (_label, candidate) => {
    await expect(callAetherChat(configuration, candidate)).rejects.toMatchObject({
      code: "AETHER_STREAM_PROFILE_REQUIRED",
    });
  });
});
