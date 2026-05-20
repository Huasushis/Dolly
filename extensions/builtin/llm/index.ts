import type { DollyModule, ModuleContext } from "../../../src/modules/base.js";
import type { BlockChange, BlockMutation } from "../../../src/blocks/index.js";
import { LLMClient } from "../../../src/core/llm-client.js";

let client: LLMClient;
let ctx: ModuleContext;
let respondedTo = new Set<string>();   // cleared on midnight reset
let processing = false;
let pendingQueue: BlockChange[] = [];
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
    if (thinkingEnabled) {
      c.setSystemPrompt(`深度思考：
\`\`\`json
{"thinking":"difficult"}
\`\`\`
关闭：
\`\`\`json
{"thinking":"solved"}
\`\`\``);
    }
    c.on("midnight.tick", () => { thinkingActive = false; respondedTo = new Set(); });
  },

  // Inner world is framework-default (see main.ts). LLM just calls the API.
  systemPrompt(): string { return ""; },

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

    // Queue pending changes when busy — they will be processed when current LLM call finishes
    if (processing) { pendingQueue.push(...changes); return []; }

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
    // Separate system block from working context
    const sysBlock = blocks.find(b => b.type === "system");
    const workingBlocks = blocks.filter(b => b.type !== "system");
    const serialized = workingBlocks.map((b) =>
      `[ID:${b.id}][TYPE:${b.type}/${b.meta?.subtype ?? b.type}][TIME:${Math.floor(b.created / 1000)}]\n${b.content}`
    ).join("\n\n");

    const sysPrompt = sysBlock?.content ?? "";
    const userPrompt = `上下文：\n${serialized}`;

    const mutations: BlockMutation[] = [];

    try {
      const extraBody = (thinkingEnabled && thinkingActive)
        ? { enable_thinking: true }
        : undefined;

      if (extraBody) {
        const unlock = await ctx.lock.acquire("builtin/llm", Infinity);
        try {
          const result = await client.chatWithReasoning([{ role: "system", content: sysPrompt }, { role: "user", content: userPrompt }] as any, extraBody);

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
        for await (const chunk of client.chatStream([{ role: "system", content: sysPrompt }, { role: "user", content: userPrompt }] as any)) {
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

    // Drain pending queue: insert a trigger block so next cascade picks them up
    if (pendingQueue.length > 0) {
      mutations.push({
        action: "insert", priority: 99,
        block: { type: "inner", content: "", meta: { source: "llm", subtype: "_retrigger" }, created: Date.now() },
      });
      pendingQueue = [];
    }

    return mutations;
  },
};

llmModule.cliInfo = [];
export default llmModule;
