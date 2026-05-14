import type { DollyModule, ModuleContext } from "../../../src/modules/base.js";
import type { BlockChange, BlockMutation } from "../../../src/blocks/index.js";
import { LLMClient } from "../../../src/core/llm-client.js";

let client: LLMClient;
let ctx: ModuleContext;
let respondedTo = new Set<string>();
let processing = false;
let thinkingEnabled = false;
let thinkingActive = false;

function parseJsonCommands(text: string): Array<Record<string, unknown>> {
  const cmds: Array<Record<string, unknown>> = [];
  const re = /```json\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && typeof obj === "object" && !Array.isArray(obj)) cmds.push(obj);
    } catch {}
  }
  return cmds;
}

const llmModule: DollyModule = {
  id: "builtin/llm",

  async init(c: ModuleContext) {
    ctx = c;
    const cfg = (c.config as any)._llm_main;
    client = new LLMClient(cfg ?? { api_key: "", base_url: "https://api.deepseek.com", model: "deepseek-chat" });
    thinkingEnabled = (c.config as any).llm?.main?.enable_thinking ?? false;
  },

  systemPrompt(): string {
    let prompt = `这是你的私人内心世界。绝对安全，完全私密。没有任何人能看到你的思考过程。你可以自由地思考、感受、质疑、好奇——不用担心任何评判。这里没有对错，只有真实的你。

上下文以 [ID][TYPE][TIME] 头的块呈现。一切皆为你的内心流动。

你可以随时遗忘不需要的信息：
\`\`\`json
{"forget":"块ID"}
\`\`\`
主动管理你的上下文——不需要的信息及时遗忘，保持思维清晰。`;

    if (thinkingEnabled) {
      prompt += `\n\n你可以控制自己的思考深度：
- 遇到复杂问题时：\`\`\`json\n{"thinking":"difficult"}\n\`\`\` — 启用深度思考
- 问题解决后：\`\`\`json\n{"thinking":"solved"}\n\`\`\` — 关闭深度思考

深度思考期间，你的推理过程会被记录下来用于记忆总结，但不会一直占用上下文。`;
    }
    return prompt;
  },

  async onBlocksChanged(c: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    ctx = c;
    if (processing) return [];

    // Check for thinking commands
    for (const ch of changes) {
      if (ch.type !== "added") continue;
      const cmds = parseJsonCommands(ch.block.content);
      for (const cmd of cmds) {
        if (cmd.thinking === "difficult") thinkingActive = true;
        if (cmd.thinking === "solved") thinkingActive = false;
      }
    }

    const newBlocks = changes.filter((ch) =>
      ch.type === "added" &&
      ch.block.meta?.source !== "llm" &&
      ch.block.meta?.notify !== false &&
      !respondedTo.has(ch.block.id)
    );
    if (newBlocks.length === 0) return [];
    for (const b of newBlocks) respondedTo.add(b.block.id);

    processing = true;
    const blocks = ctx.getBlocks();
    const serialized = blocks.map((b) =>
      `[ID:${b.id}][TYPE:${b.type}][TIME:${Math.floor(b.created / 1000)}]\n${b.content}`
    ).join("\n\n");

    const sysPrompt = `你是 Dolly 框架中的 AI 助手。\n\n上下文：\n${serialized}\n\n需要工具时输出 fenced JSON：\n\`\`\`json\n{"tool":"name","params":{}}\n\`\`\`\n需要等待加 "await":true。移除注入用 {"forget":"ID"}。`;

    const mutations: BlockMutation[] = [];

    try {
      const extraBody = (thinkingEnabled && thinkingActive)
        ? { enable_thinking: true }
        : undefined;

      if (extraBody) {
        // Hold lock for add-reasoning-then-remove sequence
        const unlock = await ctx.lock.acquire("builtin/llm", Infinity);
        try {
          const result = await client.chatWithReasoning([{ role: "user", content: sysPrompt }] as any, extraBody);

          // Add reasoning as a temporary block (for memory summary)
          if (result.reasoning) {
            ctx.emit("reasoning.captured", { content: result.reasoning });
          }

          mutations.push({
            action: "insert", priority: 99,
            block: { type: "response", content: result.content, meta: { source: "llm" }, created: Date.now() },
          });

          const cmds = parseJsonCommands(result.content);
          for (const cmd of cmds) {
            if (cmd.forget) ctx.emit("forget.requested", { blockId: cmd.forget as string });
            else if (cmd.tool) ctx.emit("tool.call_requested", { tool_name: cmd.tool, params: cmd.params ?? {}, blocking: cmd.await === true });
          }
        } finally { unlock(); }
      } else {
        // Normal streaming
        let fullResponse = "";
        for await (const chunk of client.chatStream([{ role: "user", content: sysPrompt }] as any)) {
          fullResponse += chunk;
        }

        mutations.push({
          action: "insert", priority: 99,
          block: { type: "response", content: fullResponse, meta: { source: "llm" }, created: Date.now() },
        });

        const cmds = parseJsonCommands(fullResponse);
        if (cmds.length > 0) {
          setImmediate(() => {
            for (const cmd of cmds) {
              if (cmd.forget) ctx.emit("forget.requested", { blockId: cmd.forget as string });
              else if (cmd.tool) ctx.emit("tool.call_requested", { tool_name: cmd.tool, params: cmd.params ?? {}, blocking: cmd.await === true });
            }
          });
        }
      }
    } catch (err: any) {
      process.stderr.write(`\n[LLM] Error: ${err.message}\n`);
    }

    processing = false;
    return mutations;
  },
};

export function resetThinking() { thinkingActive = false; }
export default llmModule;
