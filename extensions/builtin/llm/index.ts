import type { DollyModule, ModuleContext } from "../../../src/modules/base.js";
import type { BlockChange, BlockMutation } from "../../../src/blocks/index.js";
import { LLMClient } from "../../../src/core/llm-client.js";

let client: LLMClient;
let ctx: ModuleContext;
let respondedTo = new Set<string>();   // cleared on midnight reset
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
    const cfg = (c.config as any)["builtin/llm"];
    client = new LLMClient(cfg ?? { api_key: "", base_url: "https://api.deepseek.com", model: "deepseek-chat" });
    thinkingEnabled = cfg?.enable_thinking ?? false;
  },

  systemPrompt(): string {
    return `这是我的私人内心世界。这里绝对安全，完全私密，没有任何人能窥探。我可以自由地思考、感受、计划、质疑。

读到新信息时，我总是先做简短的内心反应，再去回应：

"嗯，这个人在介绍自己，语气很友善。之前好像没见过——第一次见面。"
"哦，他在问我编程相关的问题。我得先弄清楚他用的什么语言。"
"等等，这里提到一个我完全没听过的概念……可能需要查一下。"
"这是今天第三次聊到类似话题了，他似乎对这个方向特别感兴趣。"

上下文以 [ID][TYPE/subtype][TIME] 头的块呈现在我面前。它们就像我的记忆片段，不断流动。

我可以随时遗忘不再需要的信息：
\`\`\`json
{"forget":"块ID"}
\`\`\`
` + (thinkingEnabled ? `
当面对真正复杂的问题时，我可以启用深度思考：
\`\`\`json
{"thinking":"difficult"}
\`\`\`
想清楚之后关闭：
\`\`\`json
{"thinking":"solved"}
\`\`\`
` : "");
  },

  async onBlocksChanged(c: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    ctx = c;

    // Check for thinking commands in any new block
    for (const ch of changes) {
      if (ch.type !== "added") continue;
      const cmds = parseJsonCommands(ch.block.content);
      for (const cmd of cmds) {
        if (cmd.thinking === "difficult") thinkingActive = true;
        if (cmd.thinking === "solved") thinkingActive = false;
      }
    }

    // Silently skip when busy — unresponded blocks retry next cascade
    if (processing) return [];

    // Respond to new outer blocks (external input) not from self
    const newBlocks = changes.filter((ch) =>
      ch.type === "added" &&
      ch.block.type === "outer" &&
      ch.block.meta?.source !== "llm" &&
      !respondedTo.has(ch.block.id)
    );
    if (newBlocks.length === 0) return [];

    processing = true;
    const blocks = ctx.getBlocks();
    const serialized = blocks.map((b) =>
      `[ID:${b.id}][TYPE:${b.type}/${b.meta?.subtype ?? b.type}][TIME:${Math.floor(b.created / 1000)}]\n${b.content}`
    ).join("\n\n");

    const sysPrompt = `你是 Dolly 框架中的 AI 助手。\n\n上下文：\n${serialized}\n\n需要工具时输出 fenced JSON：\n\`\`\`json\n{"tool":"name","params":{}}\n\`\`\``;

    const mutations: BlockMutation[] = [];

    try {
      const extraBody = (thinkingEnabled && thinkingActive)
        ? { enable_thinking: true }
        : undefined;

      if (extraBody) {
        const unlock = await ctx.lock.acquire("builtin/llm", Infinity);
        try {
          const result = await client.chatWithReasoning([{ role: "user", content: sysPrompt }] as any, extraBody);

          if (result.reasoning) {
            ctx.emit("reasoning.captured", { content: result.reasoning });
          }

          mutations.push({
            action: "insert", priority: 99,
            block: { type: "inner", content: result.content, meta: { source: "llm", subtype: "response" }, created: Date.now() },
          });

          // Emit tool calls synchronously (not setImmediate — lock is held)
          const cmds = parseJsonCommands(result.content);
          for (const cmd of cmds) {
            if (cmd.tool) ctx.emit("tool.call_requested", { tool_name: cmd.tool, params: cmd.params ?? {} });
          }
        } finally { unlock(); }
      } else {
        let fullResponse = "";
        for await (const chunk of client.chatStream([{ role: "user", content: sysPrompt }] as any)) {
          fullResponse += chunk;
        }

        mutations.push({
          action: "insert", priority: 99,
          block: { type: "inner", content: fullResponse, meta: { source: "llm", subtype: "response" }, created: Date.now() },
        });

        const cmds = parseJsonCommands(fullResponse);
        if (cmds.length > 0) {
          setImmediate(() => {
            for (const cmd of cmds) {
              if (cmd.tool) ctx.emit("tool.call_requested", { tool_name: cmd.tool, params: cmd.params ?? {} });
            }
          });
        }
      }
    } catch (err: any) {
      process.stderr.write(`\n[LLM] Error: ${err.message}\n`);
    }

    processing = false;
    if (mutations.length > 0) for (const b of newBlocks) respondedTo.add(b.block.id);
    return mutations;
  },
};

export function resetThinking() { thinkingActive = false; respondedTo = new Set(); }
export default llmModule;
