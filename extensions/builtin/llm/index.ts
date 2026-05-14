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
    return `这是你的私人内心世界。绝对安全，完全私密。没有任何人能看到你的思考过程。你可以自由地思考、感受、质疑、好奇——不用担心任何评判。

上下文以 [ID][TYPE][TIME] 头的块呈现。一切皆为你的内心流动。

你可以用 fenced JSON 与外部交互：
\`\`\`json
{"tool":"name","params":{...}}   // 调用工具（对外）
{"forget":"块ID"}               // 遗忘任意块（包括你自己的旧回复）
{"recall":"hard"}              // 请求深度回忆相关记忆
\`\`\`

工具调用需要等待结果时加 "await":true。请主动管理你的上下文——不需要的信息及时遗忘。`;
  },

  async onBlocksChanged(c: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    ctx = c;
    if (processing) return [];

    // Respond to any new block added — skip own blocks and silent blocks
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
      let fullResponse = "";
      for await (const chunk of client.chatStream([{ role: "user", content: sysPrompt }] as any)) {
        fullResponse += chunk;
      }

      const cmds = parseJsonCommands(fullResponse);

      mutations.push({
        action: "insert", priority: 99,
        block: { type: "response", content: fullResponse, meta: { source: "llm" }, created: Date.now() },
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
