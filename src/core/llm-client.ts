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

  /** Stream chat. extraBody passed as extra_body to API. onReasoning called with collected reasoning after stream ends. */
  async *chatStream(
    messages: Array<{ role: string; content: string }>,
    extraBody?: Record<string, unknown>,
  ): AsyncGenerator<string, void, unknown> {
    const params: any = {
      model: this.model, messages: messages as any, temperature: 0.7, stream: true,
    };
    if (extraBody) params.extra_body = extraBody;

    const stream = await this.client.chat.completions.create(params) as any;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta as any;
      if (delta?.content) yield delta.content;
    }
  }

  /** Non-streaming call for when reasoning is needed */
  async chatWithReasoning(
    messages: Array<{ role: string; content: string }>,
    extraBody?: Record<string, unknown>,
  ): Promise<{ content: string; reasoning: string }> {
    const params: any = {
      model: this.model, messages: messages as any, temperature: 0.7,
    };
    if (extraBody) params.extra_body = extraBody;

    const resp = await this.client.chat.completions.create(params);
    const msg = resp.choices[0]?.message as any;
    return {
      content: msg?.content ?? "",
      reasoning: msg?.reasoning_content ?? "",
    };
  }
}
