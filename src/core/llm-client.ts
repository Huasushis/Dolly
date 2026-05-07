import OpenAI from "openai";
import type { LLMConfig } from "../config.js";
import type { EventBus } from "./bus.js";

export class LLMClient {
  private client: OpenAI;
  private model: string;

  constructor(
    config: LLMConfig,
    private bus?: EventBus
  ) {
    this.client = new OpenAI({
      apiKey: config.api_key,
      baseURL: config.base_url,
    });
    this.model = config.model;
  }

  async chat(messages: Array<{ role: string; content: string }>): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: messages as any,
      temperature: 0.7,
    });
    return response.choices[0]?.message?.content ?? "";
  }

  async *chatStream(
    messages: Array<{ role: string; content: string }>
  ): AsyncGenerator<string, string, unknown> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages as any,
      temperature: 0.7,
      stream: true,
    });

    let fullResponse = "";
    for await (const chunk of stream) {
      const delta = (chunk.choices[0]?.delta as any)?.content;
      if (delta) {
        fullResponse += delta;
        this.bus?.emit("llm.output_chunk", {
          text: delta,
          timestamp: Date.now() / 1000,
        });
        yield delta;
      }
    }
    this.bus?.emit("llm.response_done", { full_response: fullResponse });
    return fullResponse;
  }
}
