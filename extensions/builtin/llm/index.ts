import type { DollyModule, ModuleContext } from "../../../src/modules/base.js";
import type { BlockChange, BlockMutation } from "../../../src/blocks/index.js";
import { LLMClient } from "../../../src/core/llm-client.js";

let client: LLMClient;
let ctx: ModuleContext;
let respondedTo = new Set<string>();
let processing = false;

/** Extract fenced JSON commands from LLM response */
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

/** Strip JSON fences from text for display */
function stripFences(text: string): string {
  return text.replace(/```json\s*\n[\s\S]*?```/g, "").trim();
}

const llmModule: DollyModule = {
  id: "builtin/llm",

  async init(c: ModuleContext) {
    ctx = c;
    const cfg = (c.config as any)._llm_main;
    client = new LLMClient(cfg ?? { api_key: "", base_url: "https://api.deepseek.com", model: "deepseek-chat" });
    ctx = c;
  },

  systemPrompt(): string {
    return `你是 Dolly 框架中的 AI 助手。上下文以带 [ID][TYPE][TIME] 头的块呈现。
TYPE:message 是用户消息，TYPE:injection 是系统注入，TYPE:tool_result 是工具结果。

需要调用工具时，输出一个 fenced JSON 块（不要用 [] 标签）：
\`\`\`json
{"tool": "工具名", "params": { ... }}
\`\`\`

需要等待结果时加 "await": true：
\`\`\`json
{"tool": "工具名", "params": { ... }, "await": true}
\`\`\`

需要移除某段注入时：
\`\`\`json
{"forget": "块ID"}
\`\`\`

JSON 块之外的内容是你的自然语言回复。请自然地使用这些功能。`;
  },

  async onBlocksChanged(c: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    ctx = c;
    const mutations: BlockMutation[] = [];
    if (processing) return mutations;

    const newMessages = changes.filter(
      (ch) => ch.type === "added" && ch.block.type === "message" && !respondedTo.has(ch.block.id)
    );
    if (newMessages.length === 0) return mutations;
    for (const m of newMessages) respondedTo.add(m.block.id);

    processing = true;

    const blocks = ctx.getBlocks();
    const serialized = blocks.map((b) =>
      `[ID:${b.id}][TYPE:${b.type}][TIME:${Math.floor(b.created / 1000)}]\n${b.content}`
    ).join("\n\n");

    const sysPrompt = `你是 Dolly 框架中的 AI 助手。\n\n上下文块（[ID][TYPE][TIME] 头 + 内容）：\n${serialized}\n\n需要工具时输出 fenced JSON：\n\`\`\`json\n{"tool":"name","params":{}}\n\`\`\`\n需要等待加 "await":true。移除注入用 {"forget":"ID"}。`;

    try {
      let fullResponse = "";
      for await (const chunk of client.chatStream([{ role: "user", content: sysPrompt }] as any)) {
        fullResponse += chunk;
        process.stdout.write(chunk);
      }
      process.stdout.write("\n");

      // Parse JSON commands
      const cmds = parseJsonCommands(fullResponse);
      for (const cmd of cmds) {
        if (cmd.forget) {
          mutations.push({ action: "delete", blockId: cmd.forget as string });
        } else if (cmd.tool) {
          ctx.emit("tool.call_requested", {
            tool_name: cmd.tool,
            params: cmd.params ?? {},
            blocking: cmd.await === true,
          });
        }
      }

      // Display text (sans fences)
      const displayText = stripFences(fullResponse);

      mutations.push({
        action: "insert", priority: 99,
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
