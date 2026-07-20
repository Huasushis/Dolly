import { defineExtension } from "../../src/sdk/index.js";
import type { Module, ModuleContext, BlockAccess } from "../../src/sdk/types.js";
import type { RawBlock, Block, ExecuteInput, PremiseCollection } from "../../src/core/types.js";
import OpenAI from "openai";

// ─── Config types ────────────────────────────────────────────────────────────

interface LLMProviderConfig {
  base_url: string;
  api_key: string;
  model: string;
}

interface LLMModuleConfig {
  /** Provider key (string) referencing instance config, or inline provider config */
  llm: string | LLMProviderConfig;
  /** Custom system prompt (functional positioning, no persona) */
  systemPrompt?: string;
  /** Retain conversation context across execute calls */
  keepContext?: boolean;
  /** Max context entries to keep (default 20) */
  maxContextEntries?: number;
  /** Supported modalities — first version: text only */
  multimodal?: string[];
  /** MCP server config — TODO: not implemented in v1 */
  mcpServers?: Record<string, unknown>;
  /** Enable thinking / reasoning mode (e.g. DeepSeek) — TODO: v1 stub */
  enableThinking?: boolean;
  /** Custom premise overrides */
  premise?: { input?: string; output?: string };
  /** Max depth for recursive forward-block expansion (default 2) */
  forwardExpandDepth?: number;
  /** Enabled tool ids — TODO: not implemented in v1 */
  tools?: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const FRAMEWORK_PROMPT = [
  "你运行在一个信息处理系统中。你接收到的信息以 Block 形式呈现，",
  "每个 Block 包含 id（唯一标识）、source（来源模块）、content（数据项数组）。",
  "content 数组中的每个元素有一个 type 字段（如 text、image、forward 等）。",
  "",
  "你的回应也必须以 JSON Block 格式返回，结构如下：",
  '{ "description": "简要描述你做了什么", "content": [ { "type": "text", "text": "..." } ] }',
  "",
  "你可以在 content 中使用 forward 引用其他 Block：",
  '{ "type": "forward", "_forwardBlockId": "<目标block的id>" }',
  "",
  "请确保返回合法的 JSON。如有多个输出项，放在 content 数组中。",
].join("\n");

const GUIDANCE_PROMPT = "你应该主动思考、提出设问、尝试主导对话，而非被动等待指令。";

const DEFAULT_INPUT_PREMISE =
  "I process text and multimodal content, perform reasoning, and generate structured responses.";

const DEFAULT_OUTPUT_PREMISE =
  "I output reasoned responses as structured Block content, potentially referencing other blocks.";

// ─── Extension definition ────────────────────────────────────────────────────

export default defineExtension({
  name: "llm",
  version: "0.1.0",
  description: "LLM thinking module with multimodal and tool support",
  createModule({ id, config }) {
    return new LLMModule(id, config as LLMModuleConfig);
  },
});

// ─── Module implementation ───────────────────────────────────────────────────

class LLMModule implements Module {
  readonly id: string;
  private config: LLMModuleConfig;
  private client: OpenAI | null = null;
  private model = "deepseek-chat";
  private ctx: ModuleContext | null = null;

  /** Conversation history for keepContext mode */
  private history: Array<{ role: "user" | "assistant"; block: Block }> = [];

  constructor(id: string, config: LLMModuleConfig) {
    this.id = id;
    this.config = config;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async init(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    const provider = this.resolveProvider(ctx);
    this.model = provider.model;
    this.client = new OpenAI({
      baseURL: provider.base_url,
      apiKey: provider.api_key,
    });

    ctx.logger.info?.(`LLMModule [${this.id}] initialised — model=${this.model}`);
  }

  async onStop(): Promise<void> {
    this.history = [];
    this.client = null;
  }

  // ── core execute ─────────────────────────────────────────────────────────

  async execute(input: ExecuteInput): Promise<RawBlock | null> {
    if (input.blocks.length === 0) return null;
    if (!this.client) {
      this.ctx?.logger.error?.("LLMModule: client not initialised");
      return null;
    }

    const systemPrompt = this.buildSystemPrompt(input.adjacentPremises);
    const messages = this.buildMessages(systemPrompt, input.blocks);

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        // TODO: enableThinking → provider-specific params (e.g. extra_body.enable_thinking)
        // TODO: tool definitions from config.tools → OpenAI tools param
      });

      const content = response.choices[0]?.message?.content;
      if (!content) return null;

      const raw = this.parseResponse(content);

      // Update context history on success
      if (this.config.keepContext) {
        for (const block of input.blocks) {
          this.pushHistory("user", block);
        }
        if (raw) {
          // Build a pseudo-block for the assistant reply (id/timestamp filled by framework later)
          this.pushHistory("assistant", {
            id: "",
            timestamp: Date.now(),
            description: raw.description,
            source: this.id,
            content: raw.content,
            tensity: raw.tensity ?? 1.0,
          });
        }
      }

      return raw;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ctx?.logger.error?.(`LLMModule [${this.id}] call failed: ${msg}`);
      return null;
    }
  }

  // ── premise ──────────────────────────────────────────────────────────────

  getInputPremise(): string {
    return this.config.premise?.input ?? DEFAULT_INPUT_PREMISE;
  }

  getOutputPremise(): string {
    return this.config.premise?.output ?? DEFAULT_OUTPUT_PREMISE;
  }

  // ── prompt construction ──────────────────────────────────────────────────

  private buildSystemPrompt(premises: PremiseCollection): string {
    const parts: string[] = [FRAMEWORK_PROMPT];

    if (this.config.systemPrompt) {
      parts.push(this.config.systemPrompt);
    }

    for (const up of premises.upstream) {
      parts.push(`[上游模块 "${up.moduleId}"] 输出: ${up.outputPremise}`);
    }
    for (const down of premises.downstream) {
      parts.push(`[下游模块 "${down.moduleId}"] 输入: ${down.inputPremise}`);
    }

    parts.push(GUIDANCE_PROMPT);
    return parts.join("\n\n");
  }

  // ── message construction ─────────────────────────────────────────────────

  private buildMessages(
    systemPrompt: string,
    blocks: Block[],
  ): OpenAI.ChatCompletionMessageParam[] {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
    ];

    // Replay history (keepContext)
    if (this.config.keepContext) {
      for (const entry of this.history) {
        messages.push({
          role: entry.role,
          content: this.formatBlockContent(entry.block),
        });
      }
    }

    // Current input blocks (with forward expansion)
    for (const block of blocks) {
      const expanded = this.expandForwards(block, 0);
      const role = block.source === this.id ? "assistant" : "user";
      messages.push({
        role: role as "user" | "assistant",
        content: this.formatBlockContent(expanded),
      });
    }

    return messages;
  }

  // ── forward expansion ────────────────────────────────────────────────────

  /**
   * Recursively expand forward references in a block's content.
   * Uses ctx.blocks (BlockAccess) to resolve referenced blocks.
   */
  private expandForwards(block: Block, depth: number): Block {
    const maxDepth = this.config.forwardExpandDepth ?? 2;
    if (depth >= maxDepth) return block;

    const blockAccess: BlockAccess | undefined = this.ctx?.blocks;
    if (!blockAccess) return block;

    let changed = false;
    const expandedContent: any[] = [];

    for (const item of block.content) {
      if (
        item &&
        typeof item === "object" &&
        typeof item._forwardBlockId === "string"
      ) {
        const referenced = blockAccess.get(item._forwardBlockId);
        if (referenced) {
          // Inline the referenced block's content with a depth marker
          const nested = this.expandForwards(referenced, depth + 1);
          expandedContent.push({
            type: "forward_expanded",
            _forwardBlockId: referenced.id,
            _description: referenced.description,
            _content: nested.content,
          });
          changed = true;
          continue;
        }
      }
      expandedContent.push(item);
    }

    if (!changed) return block;
    return { ...block, content: expandedContent };
  }

  // ── content formatting ───────────────────────────────────────────────────

  /**
   * Convert a Block's content array into a plain-text representation
   * suitable for LLM consumption.
   * TODO: multimodal — image/audio/video items need provider-specific handling
   */
  private formatBlockContent(block: Block): string {
    const parts: string[] = [];

    if (block.description) {
      parts.push(`[${block.description}]`);
    }

    for (const item of block.content) {
      if (!item || typeof item !== "object") {
        parts.push(String(item));
        continue;
      }

      switch (item.type) {
        case "text":
          parts.push(item.text ?? "");
          break;
        case "image":
          // TODO: vision API — use base64/url content parts
          parts.push(`[图片 id:${item._mediaId ?? item.id ?? "?"}]`);
          break;
        case "audio":
          parts.push(`[音频 id:${item._mediaId ?? item.id ?? "?"}]`);
          break;
        case "video":
          parts.push(`[视频 id:${item._mediaId ?? item.id ?? "?"}]`);
          break;
        case "forward":
          parts.push(`[引用 block:${item._forwardBlockId ?? "?"}]`);
          break;
        case "forward_expanded":
          parts.push(
            `[引用 block:${item._forwardBlockId} — ${item._description ?? ""}]\n` +
              this.formatInlineContent(item._content ?? []),
          );
          break;
        default:
          parts.push(`[${item.type ?? "unknown"}]`);
      }
    }

    return parts.join("\n");
  }

  /** Format an inlined content array (for forward_expanded items) */
  private formatInlineContent(content: any[]): string {
    const parts: string[] = [];
    for (const item of content) {
      if (item?.type === "text") parts.push(item.text ?? "");
      else if (item?.type) parts.push(`[${item.type}]`);
    }
    return parts.join("\n");
  }

  // ── response parsing ─────────────────────────────────────────────────────

  /**
   * Parse the LLM's text response into a RawBlock.
   * Strategy:
   *   1. Try direct JSON.parse
   *   2. Try extracting fenced ```json ... ``` block
   *   3. Fall back to wrapping the raw text in a text content item
   */
  private parseResponse(content: string): RawBlock {
    // 1. Direct parse
    const direct = this.tryParseBlock(content);
    if (direct) return direct;

    // 2. Fenced JSON
    const fenceMatch = content.match(/```json\s*([\s\S]*?)```/);
    if (fenceMatch) {
      const fenced = this.tryParseBlock(fenceMatch[1].trim());
      if (fenced) return fenced;
    }

    // 3. Plain text fallback
    return {
      description: "Plain text response",
      source: this.id,
      content: [{ type: "text", text: content }],
    };
  }

  private tryParseBlock(text: string): RawBlock | null {
    try {
      const parsed = JSON.parse(text);
      if (parsed && Array.isArray(parsed.content)) {
        return {
          description: typeof parsed.description === "string" ? parsed.description : "",
          source: this.id,
          content: parsed.content,
          tensity: typeof parsed.tensity === "number" ? parsed.tensity : undefined,
        };
      }
    } catch {
      // not valid JSON
    }
    return null;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Resolve the LLM provider config from module config + instance context */
  private resolveProvider(ctx: ModuleContext): LLMProviderConfig {
    const { llm } = this.config;

    // Inline config object
    if (llm && typeof llm === "object") {
      return llm;
    }

    // String key → look up in instance-level config (ctx.config.llm)
    if (typeof llm === "string") {
      const instanceLlms = ctx.config?.llm as
        | Record<string, LLMProviderConfig>
        | undefined;
      const resolved = instanceLlms?.[llm];
      if (resolved) return resolved;
      throw new Error(
        `LLMModule [${this.id}]: provider key "${llm}" not found in instance config`,
      );
    }

    throw new Error(`LLMModule [${this.id}]: missing or invalid "llm" config`);
  }

  /** Push an entry to history, enforcing maxContextEntries */
  private pushHistory(role: "user" | "assistant", block: Block): void {
    const max = this.config.maxContextEntries ?? 20;
    this.history.push({ role, block });
    // Evict oldest entries when exceeding limit
    while (this.history.length > max) {
      this.history.shift();
    }
  }
}
