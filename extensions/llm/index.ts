import {
  defineExtension,
  type BlockAccess,
  type Module,
  type ModuleContext,
} from "../../src/core/legacy-in-process-extension.js";
import type { RawBlock, Block, ExecuteInput, PremiseCollection, Rect, Point, CoordinateSystem } from "../../src/core/types.js";
import OpenAI from "openai";
import { FRAMEWORK_PROMPT, GUIDANCE_PROMPT, DEFAULT_INPUT_PREMISE, DEFAULT_OUTPUT_PREMISE } from "./prompts.js";

// ─── Config types ────────────────────────────────────────────────────────────

interface LLMProviderConfig {
  base_url: string;
  api_key: string;
  model: string;
}

interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Coordinate system re-exported from core types for config convenience */
type LLMCoordinateSystem = CoordinateSystem;

interface LLMModuleConfig {
  /** Provider key (string) referencing instance config, or inline provider config */
  llm: string | LLMProviderConfig;
  /** Custom system prompt (functional positioning, no persona) */
  systemPrompt?: string;
  /** Retain conversation context across execute calls */
  keepContext?: boolean;
  /** Max context entries to keep (default 20) */
  maxContextEntries?: number;
  /** Supported modalities: "text" | "image" | "audio" | "video" */
  multimodal?: string[];
  /** Max images per context window (default 5) */
  maxImagesPerContext?: number;
  /** MCP server configurations */
  mcpServers?: Record<string, MCPServerConfig>;
  /** Enable thinking / reasoning mode */
  enableThinking?: boolean;
  /** Thinking provider: "deepseek" (top-level) | "qwen" (extra_body) */
  thinkingProvider?: "deepseek" | "qwen";
  /** Reasoning effort level (default "medium") */
  reasoningEffort?: "low" | "medium" | "high";
  /** Hour (0-23) to reset thinking intensity daily (default 4) */
  thinkingResetHour?: number;
  /** Correction model config for JSON retry (defaults to same model without thinking) */
  correctionModel?: string | LLMProviderConfig;
  /** Custom premise overrides */
  premise?: { input?: string; output?: string };
  /** Max depth for recursive forward-block expansion (default 2) */
  forwardExpandDepth?: number;
  /** Enabled tool ids (e.g. ["thinking_control"]) */
  tools?: string[];
  /** Coordinate system for vision bounding boxes */
  coordinateSystem?: LLMCoordinateSystem;
}

// ─── Internal types ──────────────────────────────────────────────────────────

/** A tracked context entry mapping a Block to its messages in the internal array */
interface ContextEntry {
  blockId: string;
  role: "user" | "assistant";
  /** Indices into this.messages occupied by this entry */
  messageIndices: number[];
  tensity: number;
  repeatCount: number;
  /** Whether this entry contains tool_calls */
  hasToolCalls: boolean;
}

/** Internal message with optional reasoning_content (DeepSeek/Qwen) */
interface InternalMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAI.ChatCompletionContentPart[] | null;
  reasoning_content?: string;
  tool_calls?: OpenAI.ChatCompletionMessageToolCall[];
  tool_call_id?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const THINKING_CONTROL_TOOL: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "set_reasoning_effort",
    description: "Adjust your own reasoning effort level for subsequent turns.",
    parameters: {
      type: "object",
      properties: {
        effort: { type: "string", enum: ["low", "medium", "high"], description: "Reasoning effort level." },
      },
      required: ["effort"],
    },
  },
};

// ─── Extension definition ────────────────────────────────────────────────────

export default defineExtension({
  name: "llm",
  version: "0.2.0",
  description: "LLM thinking module with multimodal, tool, and MCP support",
  createModule({ id, config }) {
    return new LLMModule(id, config as LLMModuleConfig);
  },
});

// ─── Module implementation ───────────────────────────────────────────────────

class LLMModule implements Module {
  readonly id: string;
  private config: LLMModuleConfig;
  private client: OpenAI | null = null;
  private correctionClient: OpenAI | null = null;
  private correctionModel = "";
  private model = "deepseek-chat";
  private ctx: ModuleContext | null = null;

  /** Internal OpenAI messages array (single source of truth for context) */
  private messages: InternalMessage[] = [];
  /** Tracked context entries for eviction */
  private contextEntries: ContextEntry[] = [];
  /** Current reasoning effort */
  private reasoningEffort: "low" | "medium" | "high" = "medium";
  /** Last thinking reset timestamp */
  private lastThinkingReset = Date.now();
  /** Image count in current context */
  private imageCount = 0;
  /** MCP tool definitions discovered at init */
  private mcpTools: OpenAI.ChatCompletionTool[] = [];
  /** MCP clients for cleanup */
  private mcpClients: Array<{ close(): Promise<void>; callTool(args: any): Promise<any> }> = [];
  /** MCP server name order for lookup */
  private mcpServerNames: string[] = [];
  /** Pending tool images to inject as user message after turn */
  private pendingToolImages: Array<{ mediaId: string; description: string }> = [];
  /** D4: Pending processed image refs to inject after turn */
  private pendingImageRefs: Array<{ mediaId: string; crop?: Rect; point?: Point; pointLabel?: string }> = [];

  constructor(id: string, config: LLMModuleConfig) {
    this.id = id;
    this.config = config;
    this.reasoningEffort = config.reasoningEffort ?? "medium";
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async init(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    const provider = this.resolveProvider(ctx);
    this.model = provider.model;
    // Ensure base_url ends with /v1 for OpenAI SDK compatibility
    const normalizeUrl = (url: string) => url.endsWith('/v1') ? url : url + '/v1';
    this.client = new OpenAI({ baseURL: normalizeUrl(provider.base_url), apiKey: provider.api_key });

    // Correction model: same provider without thinking, or explicit config
    const correctionProvider = this.config.correctionModel
      ? (typeof this.config.correctionModel === "string"
        ? this.resolveProviderByKey(ctx, this.config.correctionModel)
        : this.config.correctionModel)
      : provider;
    this.correctionModel = correctionProvider.model;
    this.correctionClient = new OpenAI({ baseURL: normalizeUrl(correctionProvider.base_url), apiKey: correctionProvider.api_key });

    if (this.config.mcpServers) await this.connectMCPServers();
    ctx.logger.info?.(`LLMModule [${this.id}] initialised — model=${this.model}`);
  }

  async onStop(): Promise<void> {
    this.messages = [];
    this.contextEntries = [];
    this.client = null;
    this.correctionClient = null;
    for (const c of this.mcpClients) await c.close().catch(() => {});
    this.mcpClients = [];
    this.mcpTools = [];
  }

  // ── core execute ─────────────────────────────────────────────────────────

  async execute(input: ExecuteInput): Promise<RawBlock | null> {
    if (input.blocks.length === 0) return null;
    if (!this.client) { this.ctx?.logger.error?.("LLMModule: client not initialised"); return null; }

    this.checkThinkingReset(); // B7
    const systemPrompt = this.buildSystemPrompt(input.adjacentPremises);
    this.ingestBlocks(input.blocks);
    const apiMessages = this.buildAPIMessages(systemPrompt);

    // Resolve media placeholders (async)
    await this.resolveMediaPlaceholders(apiMessages);

    const tools = this.buildToolsList();

    try {
      const raw = await this.callWithRetry(apiMessages, tools);
      if (this.config.keepContext) this.maybeEvictContext();
      return raw;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ctx?.logger.error?.(`LLMModule [${this.id}] call failed: ${msg}`);
      return null;
    }
  }

  // ── LLM call with retry (B4) ────────────────────────────────────────────

  private async callWithRetry(
    apiMessages: OpenAI.ChatCompletionMessageParam[],
    tools: OpenAI.ChatCompletionTool[] | undefined,
  ): Promise<RawBlock | null> {
    const response = await this.createCompletion(this.client!, this.model, apiMessages, tools, true);
    const message = response.choices[0]?.message;
    if (!message) return null;

    // Handle tool_calls loop
    if (message.tool_calls && message.tool_calls.length > 0) {
      return this.handleToolCalls(message, apiMessages, tools);
    }

    const content = message.content;
    if (!content) return null;

    const raw = this.parseResponse(content);

    // B4: JSON parse failure → retry with correction model (no thinking)
    if (!raw && this.correctionClient) {
      const corrected = await this.retryWithCorrection(apiMessages);
      if (corrected) return corrected;
    }

    // D3/D4: Process image_op items and inject results
    if (raw && raw.content.some((item: any) => item?.type === "image_op")) {
      raw.content = this.processImageOps(raw.content);
      if (this.pendingImageRefs.length > 0) {
        if (this.config.keepContext) this.pushAssistantMessage(message, raw);
        this.injectPendingImages(apiMessages);
        // Continue conversation so LLM can see the processed images
        const contResp = await this.createCompletion(this.client!, this.model, apiMessages, tools, true);
        const contMsg = contResp.choices[0]?.message;
        if (contMsg?.content) {
          const finalRaw = this.parseResponse(contMsg.content);
          if (this.config.keepContext) this.pushAssistantMessage(contMsg, finalRaw);
          return finalRaw ?? raw;
        }
        if (this.config.keepContext && !contMsg?.content) this.pushAssistantMessage(message, raw);
        return raw;
      }
    }

    if (this.config.keepContext) this.pushAssistantMessage(message, raw);

    return raw ?? { description: "Plain text response", source: this.id, content: [{ type: "text", text: content }] };
  }

  private async createCompletion(
    client: OpenAI, model: string,
    messages: OpenAI.ChatCompletionMessageParam[],
    tools: OpenAI.ChatCompletionTool[] | undefined,
    useThinking: boolean,
  ): Promise<OpenAI.ChatCompletion> {
    const params: Record<string, unknown> = { model, messages };

    if (tools && tools.length > 0) {
      params.tools = tools;
      // DeepSeek supports tool_choice even in thinking mode (V3.2+)
      params.tool_choice = "auto";
    }

    // Thinking parameters — provider-specific
    if (useThinking && this.config.enableThinking) {
      const tp = this.config.thinkingProvider ?? "deepseek";
      if (tp === "deepseek") {
        // DeepSeek: top-level thinking param
        params.thinking = { type: "enabled" };
      } else if (tp === "qwen") {
        // Qwen: via extra_body
        params.extra_body = { enable_thinking: true, preserve_thinking: true };
      }
    }

    return client.chat.completions.create(params as any);
  }

  /** B4: Retry with correction model (no thinking, no tools) */
  private async retryWithCorrection(apiMessages: OpenAI.ChatCompletionMessageParam[]): Promise<RawBlock | null> {
    if (!this.correctionClient) return null;
    try {
      const response = await this.createCompletion(this.correctionClient, this.correctionModel, apiMessages, undefined, false);
      const content = response.choices[0]?.message?.content;
      if (!content) return null;
      return this.parseResponse(content);
    } catch { return null; }
  }

  /** Handle tool_calls: execute tools, feed results back, loop until content */
  private async handleToolCalls(
    message: OpenAI.ChatCompletionMessage,
    apiMessages: OpenAI.ChatCompletionMessageParam[],
    tools: OpenAI.ChatCompletionTool[] | undefined,
  ): Promise<RawBlock | null> {
    const toolCalls = message.tool_calls!;

    // Store assistant tool_call message in context (with reasoning_content — B1)
    if (this.config.keepContext) {
      this.messages.push({
        role: "assistant", content: message.content,
        reasoning_content: (message as any).reasoning_content,
        tool_calls: toolCalls,
      });
    }

    // Build assistant message for API (must include reasoning_content for tool_call turns)
    const assistantMsg: any = { role: "assistant", content: message.content, tool_calls: toolCalls };
    if ((message as any).reasoning_content) assistantMsg.reasoning_content = (message as any).reasoning_content;
    apiMessages.push(assistantMsg);

    // Execute each tool and add results
    for (const tc of toolCalls) {
      const result = await this.executeToolCall(tc);
      const toolMsg: OpenAI.ChatCompletionMessageParam = { role: "tool", tool_call_id: tc.id, content: result } as any;
      apiMessages.push(toolMsg);
      if (this.config.keepContext) {
        this.messages.push({ role: "tool", content: result, tool_call_id: tc.id });
      }
    }

    // B8: Tool images — always inject as user message (no provider supports image in tool role)
    this.injectPendingToolImages(apiMessages);

    // Continue conversation
    const response = await this.createCompletion(this.client!, this.model, apiMessages, tools, true);
    const finalMsg = response.choices[0]?.message;
    if (!finalMsg) return null;

    if (finalMsg.tool_calls && finalMsg.tool_calls.length > 0) {
      return this.handleToolCalls(finalMsg, apiMessages, tools);
    }

    const content = finalMsg.content;
    if (!content) return null;
    if (this.config.keepContext) this.pushAssistantMessage(finalMsg, this.parseResponse(content));

    return this.parseResponse(content) ?? {
      description: "Plain text response", source: this.id, content: [{ type: "text", text: content }],
    };
  }

  private async executeToolCall(tc: OpenAI.ChatCompletionMessageToolCall): Promise<string> {
    const fnName = tc.function.name;
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* empty */ }

    // B9: Built-in thinking control
    if (fnName === "set_reasoning_effort") {
      const effort = args.effort as string;
      if (["low", "medium", "high"].includes(effort)) {
        this.reasoningEffort = effort as "low" | "medium" | "high";
        return JSON.stringify({ success: true, reasoning_effort: effort });
      }
      return JSON.stringify({ success: false, error: "Invalid effort value" });
    }

    // MCP tools
    const mcpResult = await this.executeMCPTool(fnName, args);
    if (mcpResult !== null) return mcpResult;

    return JSON.stringify({ error: `Unknown tool: ${fnName}` });
  }

  // ── MCP integration (B3) ────────────────────────────────────────────────

  private async connectMCPServers(): Promise<void> {
    const servers = this.config.mcpServers!;
    for (const [name, serverConfig] of Object.entries(servers)) {
      try {
        const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
        const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

        const transport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args ?? [],
          env: serverConfig.env as Record<string, string> | undefined,
        });

        const client = new Client({ name: `dolly-llm-${this.id}`, version: "0.2.0" });
        await client.connect(transport);
        this.mcpClients.push(client as any);
        this.mcpServerNames.push(name);

        const { tools } = await client.listTools();
        for (const tool of tools) {
          this.mcpTools.push({
            type: "function",
            function: {
              name: `mcp_${name}_${tool.name}`,
              description: tool.description ?? "",
              parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
            },
          });
        }
        this.ctx?.logger.info?.(`LLMModule [${this.id}] MCP "${name}" connected, ${tools.length} tools`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.ctx?.logger.error?.(`LLMModule [${this.id}] MCP "${name}" failed: ${msg}`);
      }
    }
  }

  private async executeMCPTool(fnName: string, args: Record<string, unknown>): Promise<string | null> {
    const match = fnName.match(/^mcp_(.+?)_(.+)$/);
    if (!match) return null;
    const [, serverName, toolName] = match;
    const idx = this.mcpServerNames.indexOf(serverName);
    if (idx < 0 || idx >= this.mcpClients.length) return null;
    try {
      const result = await this.mcpClients[idx].callTool({ name: toolName, arguments: args });
      const content = (result as any)?.content;
      if (Array.isArray(content)) return JSON.stringify(content.map((c: any) => c.text ?? c));
      return JSON.stringify(result);
    } catch (err: unknown) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── premise ──────────────────────────────────────────────────────────────

  getInputPremise(): string { return this.config.premise?.input ?? DEFAULT_INPUT_PREMISE; }
  getOutputPremise(): string { return this.config.premise?.output ?? DEFAULT_OUTPUT_PREMISE; }

  // ── prompt construction ──────────────────────────────────────────────────

  private buildSystemPrompt(premises: PremiseCollection): string {
    const parts: string[] = [FRAMEWORK_PROMPT];
    if (this.config.systemPrompt) parts.push(this.config.systemPrompt);

    // B2: Declare multimodal capability boundaries
    const modalities = this.config.multimodal ?? ["text"];
    if (modalities.includes("image")) parts.push("你可以接收和理解图片内容。");
    if (modalities.includes("audio")) parts.push("你可以接收音频内容（转录为文本）。");
    if (modalities.includes("video")) parts.push("你可以接收视频内容（关键帧切片）。");
    if (!modalities.includes("image")) parts.push("注意：当前不支持图片理解，图片内容将以占位符呈现。");

    for (const up of premises.upstream) parts.push(`[上游模块 "${up.moduleId}"] 输出: ${up.outputPremise}`);
    for (const down of premises.downstream) parts.push(`[下游模块 "${down.moduleId}"] 输入: ${down.inputPremise}`);
    parts.push(GUIDANCE_PROMPT);
    return parts.join("\n\n");
  }

  // ── context ingestion (B5) ──────────────────────────────────────────────

  private ingestBlocks(blocks: Block[]): void {
    if (!this.config.keepContext) {
      this.messages = [];
      this.contextEntries = [];
      this.imageCount = 0;
    }

    for (const block of blocks) {
      const role: "user" | "assistant" = block.source === this.id ? "assistant" : "user";
      const expanded = this.expandForwards(block, 0);
      const content = this.formatBlockContent(expanded);
      const msgIndex = this.messages.length;
      this.messages.push({ role, content });
      this.imageCount += this.countImagesInContent(content);

      this.contextEntries.push({
        blockId: block.id, role,
        messageIndices: [msgIndex],
        tensity: block.tensity ?? 1.0,
        repeatCount: block.repeat_count ?? 0,
        hasToolCalls: false,
      });

      // B5: Acquire block reference to prevent premature GC by BlockManager
      this.ctx?.blocks.acquire(block.id);
    }
  }

  private pushAssistantMessage(message: OpenAI.ChatCompletionMessage, raw: RawBlock | null): void {
    const msgIndex = this.messages.length;
    const msg: InternalMessage = { role: "assistant", content: message.content };
    // B1: Store reasoning_content only for tool_call turns
    if (message.tool_calls && message.tool_calls.length > 0) {
      msg.reasoning_content = (message as any).reasoning_content;
      msg.tool_calls = message.tool_calls;
    }
    this.messages.push(msg);
    this.contextEntries.push({
      blockId: `self_${Date.now()}`, role: "assistant",
      messageIndices: [msgIndex],
      tensity: raw?.tensity ?? 1.0, repeatCount: 0,
      hasToolCalls: !!(message.tool_calls && message.tool_calls.length > 0),
    });
  }

  // ── message construction for API ────────────────────────────────────────

  private buildAPIMessages(systemPrompt: string): OpenAI.ChatCompletionMessageParam[] {
    const apiMessages: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt }];

    for (const msg of this.messages) {
      apiMessages.push(this.toAPIMessage(msg));
    }

    // Inject current date at the start of first user message to prevent date hallucination
    this.injectDate(apiMessages);
    // Enforce strict user/assistant alternation (DeepSeek requirement)
    this.enforceAlternation(apiMessages);
    // B6: Ensure first message after system is not assistant
    this.ensureUserAfterSystem(apiMessages);

    return apiMessages;
  }

  /** Inject current date into first user message to anchor LLM's date awareness */
  private injectDate(messages: OpenAI.ChatCompletionMessageParam[]): void {
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const prefix = `当前日期: ${dateStr}\n`;
    for (let i = 1; i < messages.length; i++) {
      const msg = messages[i] as any;
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          msg.content = prefix + msg.content;
        } else if (Array.isArray(msg.content) && msg.content.length > 0 && msg.content[0].type === "text") {
          msg.content[0].text = prefix + msg.content[0].text;
        }
        break;
      }
    }
  }

  private toAPIMessage(msg: InternalMessage): OpenAI.ChatCompletionMessageParam {
    const base: any = { role: msg.role, content: msg.content };
    // B1: reasoning_content must be sent back for tool_call turns
    if (msg.reasoning_content && msg.tool_calls) base.reasoning_content = msg.reasoning_content;
    if (msg.tool_calls) base.tool_calls = msg.tool_calls;
    if (msg.tool_call_id) base.tool_call_id = msg.tool_call_id;
    return base as OpenAI.ChatCompletionMessageParam;
  }

  /**
   * Enforce strict user/assistant alternation.
   * DeepSeek does NOT support consecutive same-role messages (tool messages exempt).
   * Merge consecutive same-role messages by joining content with newline.
   */
  private enforceAlternation(messages: OpenAI.ChatCompletionMessageParam[]): void {
    if (messages.length <= 2) return;
    let i = 1; // skip system at [0]
    while (i < messages.length) {
      const cur = messages[i] as any;
      // Skip tool messages and assistant messages with tool_calls (they pair with tool responses)
      if (cur.role === "tool" || (cur.role === "assistant" && cur.tool_calls)) { i++; continue; }

      // Look ahead: merge consecutive same-role (user/user or assistant/assistant)
      let j = i + 1;
      while (j < messages.length) {
        const next = messages[j] as any;
        if (next.role === "tool" || (next.role === "assistant" && next.tool_calls)) break;
        if (next.role !== cur.role) break;
        j++;
      }

      if (j > i + 1) {
        // Merge messages[i..j-1] into one
        const mergedContent: string[] = [];
        for (let k = i; k < j; k++) {
          const c = (messages[k] as any).content;
          if (typeof c === "string") mergedContent.push(c);
          else if (Array.isArray(c)) mergedContent.push(c.map((p: any) => p.text ?? "").join("\n"));
        }
        (messages[i] as any).content = mergedContent.join("\n");
        messages.splice(i + 1, j - i - 1);
      }
      i++;
    }
  }

  /** B6: If first message after system is assistant, insert empty user */
  private ensureUserAfterSystem(messages: OpenAI.ChatCompletionMessageParam[]): void {
    if (messages.length < 2) return;
    if (messages[1] && (messages[1] as any).role === "assistant") {
      messages.splice(1, 0, { role: "user", content: "" });
    }
  }

  // ── context eviction (B5) ───────────────────────────────────────────────

  private maybeEvictContext(): void {
    const max = this.config.maxContextEntries ?? 20;
    const threshold = Math.floor(max * 0.8);
    if (this.contextEntries.length <= threshold) return;

    const target = Math.floor(max * 0.6);
    while (this.contextEntries.length > target) {
      const idx = this.selectEvictionCandidate();
      if (idx < 0) break;
      this.evictEntry(idx);
    }
  }

  /** Select candidate using 1/effectiveTensity weighted probability */
  private selectEvictionCandidate(): number {
    if (this.contextEntries.length === 0) return -1;
    const weights = this.contextEntries.map((e) => {
      // repeat_count adjusted via concave function ln
      const effective = e.tensity * (1 + Math.log(1 + e.repeatCount));
      return 1 / Math.max(effective, 0.01);
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let rand = Math.random() * total;
    for (let i = 0; i < weights.length; i++) {
      rand -= weights[i];
      if (rand <= 0) return i;
    }
    return this.contextEntries.length - 1;
  }

  private evictEntry(idx: number): void {
    const entry = this.contextEntries[idx];
    this.ctx?.blocks.release(entry.blockId);

    for (const msgIdx of entry.messageIndices) {
      if (msgIdx < this.messages.length) {
        const msg = this.messages[msgIdx];
        // Remove associated tool responses if this had tool_calls
        if (msg?.tool_calls) {
          const ids = new Set(msg.tool_calls.map((tc) => tc.id));
          for (let i = 0; i < this.messages.length; i++) {
            if (this.messages[i]?.role === "tool" && ids.has(this.messages[i].tool_call_id!)) {
              this.messages[i] = null as any;
            }
          }
        }
        this.messages[msgIdx] = null as any;
      }
    }
    this.contextEntries.splice(idx, 1);
    this.compactMessages();
    this.cleanOrphanedToolMessages();
  }

  private compactMessages(): void {
    const oldToNew = new Map<number, number>();
    const compacted: InternalMessage[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i] !== null) { oldToNew.set(i, compacted.length); compacted.push(this.messages[i]); }
    }
    this.messages = compacted;
    for (const entry of this.contextEntries) {
      entry.messageIndices = entry.messageIndices.map((o) => oldToNew.get(o)).filter((v): v is number => v !== undefined);
    }
    this.imageCount = 0;
    for (const msg of this.messages) this.imageCount += this.countImagesInContent(msg.content);
  }

  private cleanOrphanedToolMessages(): void {
    const knownIds = new Set<string>();
    for (const msg of this.messages) {
      if (msg?.tool_calls) for (const tc of msg.tool_calls) knownIds.add(tc.id);
    }
    let changed = false;
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (msg?.role === "tool" && msg.tool_call_id && !knownIds.has(msg.tool_call_id)) {
        this.messages[i] = null as any;
        changed = true;
      }
    }
    if (changed) this.compactMessages();
  }

  // ── forward expansion ────────────────────────────────────────────────────

  private expandForwards(block: Block, depth: number): Block {
    const maxDepth = this.config.forwardExpandDepth ?? 2;
    if (depth >= maxDepth) return block;
    const blockAccess: BlockAccess | undefined = this.ctx?.blocks;
    if (!blockAccess) return block;

    let changed = false;
    const expandedContent: any[] = [];
    for (const item of block.content) {
      if (item && typeof item === "object" && typeof item.blockId === "string" && item.type === "forward") {
        const referenced = blockAccess.get(item.blockId);
        if (referenced) {
          const nested = this.expandForwards(referenced, depth + 1);
          expandedContent.push({
            type: "forward_expanded", forwardBlockId: referenced.id,
            _description: referenced.description, _content: nested.content,
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

  // ── content formatting (B2: multimodal) ─────────────────────────────────

  private formatBlockContent(block: Block): string | OpenAI.ChatCompletionContentPart[] {
    const modalities = this.config.multimodal ?? ["text"];
    const maxImages = this.config.maxImagesPerContext ?? 5;
    const imageParts: OpenAI.ChatCompletionContentPart[] = [];
    const textParts: string[] = [];
    let localImgCount = 0;

    if (block.description) textParts.push(`[${block.description}]`);

    for (const item of block.content) {
      if (!item || typeof item !== "object") { textParts.push(String(item)); continue; }
      switch (item.type) {
        case "text": textParts.push(item.text ?? ""); break;
        case "image": {
          const mediaId = item.mediaId ?? item._mediaId ?? item.id;
          if (modalities.includes("image") && mediaId && this.imageCount + localImgCount < maxImages) {
            imageParts.push({ type: "image_url", image_url: { url: `__MEDIA__:${mediaId}` } });
            localImgCount++;
          } else {
            textParts.push(`[图片 id:${mediaId ?? "?"}]`);
          }
          break;
        }
        case "audio": // TODO: fun-asr transcription
          textParts.push(`[音频 id:${item.mediaId ?? item._mediaId ?? "?"}]`); break;
        case "video": // TODO: ffmpeg slice extraction
          textParts.push(`[视频 id:${item.mediaId ?? item._mediaId ?? "?"}]`); break;
        case "forward":
          textParts.push(`[引用 block:${item.blockId ?? item._forwardBlockId ?? "?"}]`); break;
        case "forward_expanded":
          textParts.push(`[引用 block:${item.forwardBlockId ?? item._forwardBlockId} — ${item._description ?? ""}]\n` +
            this.formatInlineContent(item._content ?? [])); break;
        default: textParts.push(`[${item.type ?? "unknown"}]`);
      }
    }

    if (imageParts.length === 0) return textParts.join("\n");
    const result: OpenAI.ChatCompletionContentPart[] = [];
    if (textParts.length > 0) result.push({ type: "text", text: textParts.join("\n") });
    result.push(...imageParts);
    return result;
  }

  /** Resolve __MEDIA__ placeholders to base64 data URIs */
  private async resolveMediaPlaceholders(messages: OpenAI.ChatCompletionMessageParam[]): Promise<void> {
    if (!this.ctx?.media) return;
    for (const msg of messages) {
      const content = (msg as any).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part.type === "image_url" && typeof part.image_url?.url === "string" && part.image_url.url.startsWith("__MEDIA__:")) {
          const mediaId = part.image_url.url.slice("__MEDIA__:".length);
          try {
            part.image_url.url = await this.ctx.media.get(mediaId, "base64") as string;
          } catch {
            part.type = "text"; part.text = `[图片加载失败 id:${mediaId}]`; delete part.image_url;
          }
        }
      }
    }
  }

  private formatInlineContent(content: any[]): string {
    const parts: string[] = [];
    for (const item of content) {
      if (item?.type === "text") parts.push(item.text ?? "");
      else if (item?.type) parts.push(`[${item.type}]`);
    }
    return parts.join("\n");
  }

  private countImagesInContent(content: string | OpenAI.ChatCompletionContentPart[] | null): number {
    if (!content || typeof content === "string") return 0;
    if (Array.isArray(content)) return content.filter((p) => p.type === "image_url").length;
    return 0;
  }

  // ── tools (B9 + MCP) ────────────────────────────────────────────────────

  private buildToolsList(): OpenAI.ChatCompletionTool[] | undefined {
    const tools: OpenAI.ChatCompletionTool[] = [];
    if (this.config.tools?.includes("thinking_control") && this.config.enableThinking) {
      tools.push(THINKING_CONTROL_TOOL);
    }
    tools.push(...this.mcpTools);
    return tools.length > 0 ? tools : undefined;
  }

  // ── B8: tool role image → always inject as user message ─────────────────

  private injectPendingToolImages(apiMessages: OpenAI.ChatCompletionMessageParam[]): void {
    if (this.pendingToolImages.length === 0) return;
    // No major provider (OpenAI/DeepSeek/Qwen) supports image_url in tool role.
    // Always inject as user message after the tool turn.
    const refs = this.pendingToolImages.map((img) => `[工具输出图片: ${img.description}]`).join("\n");
    apiMessages.push({ role: "user", content: `工具执行结果包含以下图片：\n${refs}` });
    this.pendingToolImages = [];
  }

  // ── D3: image_op processing (deal_with_image) ────────────────────────────

  /**
   * Process image_op items in content: validate coordinates, convert coordinate
   * system, flatten to { type: "image", mediaId, crop?, point? }.
   * - crop and point validated separately (crop first, then point)
   * - New crop clears previous point
   * - point overwrites previous point
   */
  private processImageOps(content: any[]): any[] {
    const result: any[] = [];
    this.pendingImageRefs = [];

    for (const item of content) {
      if (item?.type !== "image_op") {
        result.push(item);
        continue;
      }

      const mediaId = item.mediaId;
      if (!mediaId || typeof mediaId !== "string") {
        this.ctx?.logger.warn?.(`LLMModule [${this.id}] image_op missing mediaId, skipped`);
        continue;
      }

      const operations: any[] = Array.isArray(item.operations) ? item.operations : [];
      let crop: Rect | undefined;
      let point: Point | undefined;
      let pointLabel: string | undefined;

      for (const op of operations) {
        if (op?.op === "crop") {
          // D3: Validate crop first
          const validatedCrop = this.validateAndConvertCrop(op.rect);
          if (validatedCrop) {
            crop = validatedCrop;
            // New crop clears old point
            point = undefined;
            pointLabel = undefined;
          }
        } else if (op?.op === "point") {
          // D3: Validate point second
          const points: any[] = Array.isArray(op.points) ? op.points : [];
          if (points.length > 0) {
            const validatedPoint = this.validateAndConvertPoint(points[0]);
            if (validatedPoint) {
              // point overwrites previous point
              point = validatedPoint;
              pointLabel = validatedPoint.label ?? op.label;
            }
          }
        }
      }

      // Flatten to image DataItem
      const imageItem: any = { type: "image", mediaId };
      if (crop) imageItem.crop = crop;
      if (point) imageItem.point = point;
      if (pointLabel) imageItem.pointLabel = pointLabel;
      result.push(imageItem);

      // Track for D4 injection
      this.pendingImageRefs.push({ mediaId, crop, point, pointLabel });
    }

    return result;
  }

  /** D3: Validate and convert crop rect based on coordinateSystem */
  private validateAndConvertCrop(rect: any): Rect | null {
    if (!rect) return null;
    const coordSys = this.config.coordinateSystem ?? "normalized";

    let topLeft: { x: number; y: number };
    let bottomRight: { x: number; y: number };

    if (coordSys === "qwen") {
      // Qwen VL: 0-1000 → normalized 0-1.0
      const tl = rect.topLeft ?? { x: rect.x, y: rect.y };
      const br = rect.bottomRight ?? { x: rect.x2, y: rect.y2 };
      if (!tl || !br) return null;
      topLeft = { x: this.clamp01(tl.x / 1000), y: this.clamp01(tl.y / 1000) };
      bottomRight = { x: this.clamp01(br.x / 1000), y: this.clamp01(br.y / 1000) };
    } else if (coordSys === "pixel") {
      // Pixel: need image dimensions from media metadata
      const tl = rect.topLeft ?? { x: rect.x, y: rect.y };
      const br = rect.bottomRight ?? { x: rect.x2, y: rect.y2 };
      if (!tl || !br) return null;
      // Without dimensions we cannot normalise; store as-is clamped
      topLeft = { x: Math.max(0, tl.x), y: Math.max(0, tl.y) };
      bottomRight = { x: Math.max(0, br.x), y: Math.max(0, br.y) };
      // Note: pixel coords will be normalised during crop execution via MediaManager
      return { topLeft, bottomRight };
    } else {
      // normalized: 0-1.0 (text LLM default)
      const tl = rect.topLeft ?? { x: rect.x, y: rect.y };
      const br = rect.bottomRight ?? { x: rect.x2, y: rect.y2 };
      if (!tl || !br) return null;
      topLeft = { x: this.clamp01(tl.x), y: this.clamp01(tl.y) };
      bottomRight = { x: this.clamp01(br.x), y: this.clamp01(br.y) };
    }

    // Validate: topLeft must be above-left of bottomRight
    if (topLeft.x >= bottomRight.x || topLeft.y >= bottomRight.y) {
      this.ctx?.logger.warn?.(`LLMModule [${this.id}] invalid crop rect: topLeft >= bottomRight`);
      return null;
    }

    return { topLeft, bottomRight };
  }

  /** D3: Validate and convert a single point based on coordinateSystem */
  private validateAndConvertPoint(pt: any): Point | null {
    if (!pt || typeof pt.x !== "number" || typeof pt.y !== "number") return null;
    const coordSys = this.config.coordinateSystem ?? "normalized";

    let x: number, y: number;
    if (coordSys === "qwen") {
      x = this.clamp01(pt.x / 1000);
      y = this.clamp01(pt.y / 1000);
    } else if (coordSys === "pixel") {
      // Pixel coords stored as-is; normalisation deferred to consumer
      x = Math.max(0, pt.x);
      y = Math.max(0, pt.y);
    } else {
      x = this.clamp01(pt.x);
      y = this.clamp01(pt.y);
    }

    return { x, y, label: typeof pt.label === "string" ? pt.label : undefined };
  }

  private clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
  }

  // ── D4: Image re-insertion with deduplication ────────────────────────────

  /**
   * Inject processed images as user message after current turn.
   * Deduplication: if same mediaId+crop already exists in context, only add text reference.
   */
  private injectPendingImages(apiMessages: OpenAI.ChatCompletionMessageParam[]): void {
    if (this.pendingImageRefs.length === 0) return;

    const modalities = this.config.multimodal ?? ["text"];
    const maxImages = this.config.maxImagesPerContext ?? 5;
    const contentParts: OpenAI.ChatCompletionContentPart[] = [];
    const textRefs: string[] = [];

    for (const ref of this.pendingImageRefs) {
      // D4 dedup: check if same image (mediaId + crop) already in context
      if (this.isImageDuplicate(ref)) {
        textRefs.push(`[图片已存在: ${ref.mediaId}${ref.crop ? " (裁剪)" : ""}]`);
        continue;
      }

      if (modalities.includes("image") && this.imageCount < maxImages) {
        contentParts.push({
          type: "image_url",
          image_url: { url: `__MEDIA__:${ref.mediaId}` },
        });
        this.imageCount++;
        if (ref.point) {
          textRefs.push(`[标注点: (${ref.point.x.toFixed(2)}, ${ref.point.y.toFixed(2)})${ref.pointLabel ? ` "${ref.pointLabel}"` : ""}]`);
        }
      } else {
        textRefs.push(`[图片: ${ref.mediaId}${ref.crop ? " (裁剪区域)" : ""}]`);
      }
    }

    if (contentParts.length === 0 && textRefs.length === 0) {
      this.pendingImageRefs = [];
      return;
    }

    if (contentParts.length > 0) {
      const parts: OpenAI.ChatCompletionContentPart[] = [];
      if (textRefs.length > 0) parts.push({ type: "text", text: `图片处理结果：\n${textRefs.join("\n")}` });
      else parts.push({ type: "text", text: "图片处理结果：" });
      parts.push(...contentParts);
      apiMessages.push({ role: "user", content: parts } as any);
      if (this.config.keepContext) {
        this.messages.push({ role: "user", content: parts });
      }
    } else {
      const text = `图片处理结果：\n${textRefs.join("\n")}`;
      apiMessages.push({ role: "user", content: text });
      if (this.config.keepContext) {
        this.messages.push({ role: "user", content: text });
      }
    }

    this.pendingImageRefs = [];
  }

  /** D4: Check if an image with same mediaId and crop already exists in context */
  private isImageDuplicate(ref: { mediaId: string; crop?: Rect }): boolean {
    for (const msg of this.messages) {
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const part of msg.content) {
        if ((part as any)?.type !== "image_url") continue;
        const url = (part as any).image_url?.url ?? "";
        if (!url.startsWith("__MEDIA__:")) continue;
        const existingId = url.slice("__MEDIA__:".length);
        if (existingId === ref.mediaId) {
          // Same mediaId — check crop equality
          // For simplicity, if no crop on new ref, it's a dup of the full image
          if (!ref.crop) return true;
          // If crop specified, we consider it unique (different crop = different visual)
          // A more thorough check would compare crop rects, but mediaId+crop presence suffices
        }
      }
    }
    return false;
  }

  // ── B7: thinking reset ──────────────────────────────────────────────────

  private checkThinkingReset(): void {
    const resetHour = this.config.thinkingResetHour ?? 4;
    const now = new Date();
    const todayReset = new Date(now);
    todayReset.setHours(resetHour, 0, 0, 0);
    if (now >= todayReset && this.lastThinkingReset < todayReset.getTime()) {
      this.reasoningEffort = this.config.reasoningEffort ?? "medium";
      this.lastThinkingReset = Date.now();
      this.ctx?.logger.info?.(`LLMModule [${this.id}] thinking effort reset to "${this.reasoningEffort}"`);
    }
  }

  // ── response parsing ─────────────────────────────────────────────────────

  private parseResponse(content: string): RawBlock | null {
    const direct = this.tryParseBlock(content);
    if (direct) return direct;
    const fenceMatch = content.match(/```json\s*([\s\S]*?)```/);
    if (fenceMatch) {
      const fenced = this.tryParseBlock(fenceMatch[1].trim());
      if (fenced) return fenced;
    }
    return null;
  }

  private tryParseBlock(text: string): RawBlock | null {
    try {
      const parsed = JSON.parse(text);
      if (parsed && Array.isArray(parsed.content)) {
        return {
          description: typeof parsed.description === "string" ? parsed.description : "",
          source: this.id, content: parsed.content,
          tensity: typeof parsed.tensity === "number" ? parsed.tensity : undefined,
        };
      }
    } catch { /* not valid JSON */ }
    return null;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private resolveProvider(ctx: ModuleContext): LLMProviderConfig {
    const { llm } = this.config;
    if (llm && typeof llm === "object") return llm;
    if (typeof llm === "string") return this.resolveProviderByKey(ctx, llm);
    throw new Error(`LLMModule [${this.id}]: missing or invalid "llm" config`);
  }

  private resolveProviderByKey(ctx: ModuleContext, key: string): LLMProviderConfig {
    const instanceLlms = ctx.config?.llm as Record<string, LLMProviderConfig> | undefined;
    const resolved = instanceLlms?.[key];
    if (resolved) return resolved;
    throw new Error(`LLMModule [${this.id}]: provider key "${key}" not found in instance config`);
  }
}
