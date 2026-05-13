import type { DollyModule, ModuleContext } from "../../../src/modules/base.js";
import type { BlockChange, BlockMutation } from "../../../src/blocks/index.js";
import { LLMClient } from "../../../src/core/llm-client.js";

let client: LLMClient;
let ctx: ModuleContext;
let processing = false;
let respondedTo = new Set<string>();

function parseTools(text: string): { type: "tool" | "await" | "forget"; name: string; params: any }[] {
  const results: any[] = [];
  // [TOOL:name]...[TOOL] or [/AWAIT]
  const toolRe = /\[(TOOL|AWAIT):([^\]]+)\]\s*\n?([\s\S]*?)\[\/(?:TOOL|AWAIT)\]/g;
  let m;
  while ((m = toolRe.exec(text))) {
    let params: any = {};
    try { params = JSON.parse(m[3].trim()); } catch { params = { raw: m[3].trim() }; }
    results.push({ type: m[1] === "AWAIT" ? "await" : "tool", name: m[2].trim(), params });
  }
  // [FORGET:id]
  const forgetRe = /\[FORGET:([^\]]+)\]/g;
  while ((m = forgetRe.exec(text))) {
    results.push({ type: "forget", name: m[1].trim(), params: {} });
  }
  return results;
}

const llmModule: DollyModule = {
  id: "builtin/llm",
  heartbeatInterval: 0,

  async init(c: ModuleContext) {
    ctx = c;
    const cfg = (c.config as any).llm?.main ?? (c.config as any)._llm_main;
    client = new LLMClient(cfg ?? { api_key: "", base_url: "https://api.deepseek.com", model: "deepseek-chat" });
  },

  systemPrompt(): string {
    return `你是一个在 Dolly 框架中运行的智能助手。

上下文中每个段落以 [ID:xxx][TYPE:xxx][TIME:xxx] 开头，后跟内容。
- TYPE:message 是用户消息
- TYPE:injection 是系统注入的信息
- TYPE:tool_result 是工具返回结果

你可以使用以下标签：
- [FORGET:id] 来移除不再需要的注入块
- [TOOL:工具名]\\n{参数JSON}\\n[/TOOL] 调用工具（不等待）
- [AWAIT:工具名]\\n{参数JSON}\\n[/TOOL] 调用工具（等待结果）

请自然地使用这些功能。`;
  },

  async onBlocksChanged(c: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    ctx = c;
    const mutations: BlockMutation[] = [];
    if (processing) return mutations;

    // Only respond to new message blocks we haven't seen
    const newMessages = changes.filter((ch) =>
      ch.type === "added" && ch.block.type === "message" && !respondedTo.has(ch.block.id)
    );
    if (newMessages.length === 0) return mutations;
    for (const m of newMessages) respondedTo.add(m.block.id);

    processing = true;
    const blocks = ctx.getBlocks();
    const serialized = blocks.map((b) => {
      const head = `[ID:${b.id}][TYPE:${b.type}][TIME:${Math.floor(b.created / 1000)}]`;
      return head + "\n" + b.content;
    }).join("\n\n");

    const systemPrompt = `你是一个在 Dolly 框架中运行的智能助手。每条消息以 [ID:xxx][TYPE:xxx] 开头。TYPE:message 是用户输入。请用自然语言回复。\n\n可用工具：[TOOL:datetime] 查询时间。需要结果时用 [AWAIT:datetime]`;

    const msgs = [
      { role: "system", content: systemPrompt },
      { role: "user", content: serialized },
    ];

    try {
      let fullResponse = "";
      for await (const chunk of client.chatStream(msgs as any)) {
        fullResponse += chunk;
        process.stdout.write(chunk);
      }
      process.stdout.write("\n");

      // Parse tools from response
      const tools = parseTools(fullResponse);
      for (const tool of tools) {
        if (tool.type === "forget") {
          mutations.push({ action: "delete", blockId: tool.name });
        } else {
          // Emit tool call for MCP module to handle
          ctx.emit("tool.call_requested", { tool_name: tool.name, params: tool.params, blocking: tool.type === "await" });
        }
      }

      // Add response as a block
      mutations.push({
        action: "insert",
        priority: 99,
        block: { type: "response", content: fullResponse, meta: {}, created: Date.now() },
      });
    } catch (err: any) {
      process.stderr.write(`\n[LLM] Error: ${err.message}\n`);
    }

    processing = false;
    return mutations;
  },
};

export default llmModule;
