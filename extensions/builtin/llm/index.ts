import type { DollyModule, ModuleContext } from "../../../src/modules/base.js";
import type { BlockChange, BlockMutation } from "../../../src/blocks/index.js";
import { LLMClient } from "../../../src/core/llm-client.js";

let client: LLMClient;
let ctx: ModuleContext;
let respondedTo = new Set<string>();
let processing = false;

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
  },

  systemPrompt(): string {
    return `你是 Dolly 框架中的 AI 助手。上下文以 [ID][TYPE][TIME] 头的块呈现。
TYPE:message 是用户消息，TYPE:injection 是系统注入，TYPE:tool_result 是工具结果。

需要调用工具时输出 fenced JSON：
\`\`\`json
{"tool":"name","params":{...}}
\`\`\`
需要等待结果时加 "await":true。移除注入用 {"forget":"ID"}。`;
  },

  async onBlocksChanged(c: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    ctx = c;
    if (processing) return [];

    // Respond to any new block added (extensions can set meta.notify=false to skip)
    const newBlocks = changes.filter((ch) =>
      ch.type === "added" &&
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
      let fullResponse = "";
      for await (const chunk of client.chatStream([{ role: "user", content: sysPrompt }] as any)) {
        fullResponse += chunk;
      }

      const cmds = parseJsonCommands(fullResponse);

      mutations.push({
        action: "insert", priority: 99,
        block: { type: "response", content: fullResponse, meta: {}, created: Date.now() },
      });

      // Defer tool calls to next tick so we release `processing` first
      if (cmds.length > 0) {
        setImmediate(() => {
          for (const cmd of cmds) {
            if (cmd.forget) {
              // Mutations are already returned, need to emit for main handler
              ctx.emit("forget.requested", { blockId: cmd.forget as string });
            } else if (cmd.tool) {
              ctx.emit("tool.call_requested", {
                tool_name: cmd.tool,
                params: cmd.params ?? {},
                blocking: cmd.await === true,
              });
            }
          }
        });
      }
    } catch (err: any) {
      process.stderr.write(`\n[LLM] Error: ${err.message}\n`);
    }

    processing = false;
    return mutations;
  },
};

export default llmModule;
