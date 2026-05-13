import OpenAI from "openai";

export interface LLMConfig { api_key: string; base_url: string; model: string; }

export class LLMClient {
  private client: OpenAI;
  private model: string;

  constructor(config: LLMConfig) {
    this.client = new OpenAI({ apiKey: config.api_key, baseURL: config.base_url });
    this.model = config.model;
  }

  async chat(messages: Array<{ role: string; content: string }>): Promise<string> {
    const resp = await this.client.chat.completions.create({
      model: this.model, messages: messages as any, temperature: 0.7,
    });
    return resp.choices[0]?.message?.content ?? "";
  }

  async *chatStream(messages: Array<{ role: string; content: string }>): AsyncGenerator<string, string, unknown> {
    const stream = await this.client.chat.completions.create({
      model: this.model, messages: messages as any, temperature: 0.7, stream: true,
    });
    let full = "";
    for await (const chunk of stream) {
      const delta = (chunk.choices[0]?.delta as any)?.content;
      if (delta) { full += delta; yield delta; }
    }
    return full;
  }
}
