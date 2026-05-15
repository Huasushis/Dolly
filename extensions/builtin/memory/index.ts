import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import type { DollyModule, ModuleContext } from "../../../src/modules/base.js";
import type { BlockChange, BlockMutation } from "../../../src/blocks/index.js";
import { MemoryStore } from "../../../src/memory/store.js";
import { LLMClient } from "../../../src/core/llm-client.js";

let store: MemoryStore;
let client: LLMClient;
let idleTimer: NodeJS.Timeout | null = null;
let idleMinutes = 60;

const memoryModule: DollyModule = {
  id: "builtin/memory",

  async init(ctx: ModuleContext) {
    const cfg = (ctx.config as any)["builtin/memory"] ?? (ctx.config as any)._llm_memory;
    client = new LLMClient(cfg ?? { api_key: "", base_url: "https://api.deepseek.com", model: "deepseek-chat" });
    const memPath = resolve(ctx.storagePath, "memory-store");
    if (!existsSync(memPath)) mkdirSync(memPath, { recursive: true });
    store = new MemoryStore(memPath, client);
    idleMinutes = cfg?.idle_minutes ?? (ctx.config as any).memory?.idle_minutes ?? 60;
    resetTimer();
  },

  systemPrompt(): string {
    return `你可以请求检索相关记忆：
\`\`\`json
{"recall":"hard"}
\`\`\`
hard 深度回忆（5天5段），soft 轻量（1天1段），默认不检索。`;
  },

  async onBlocksChanged(ctx: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    const mutations: BlockMutation[] = [];
    // Log all changes
    for (const ch of changes) {
      store.appendLog(ch.type, { type: ch.block.type, content: ch.block.content.slice(0, 200) });
    }
    // Recall on new message blocks
    for (const ch of changes) {
      if (ch.type !== "added" || ch.block.type !== "message") continue;
      const rm = ch.block.content.match(/\{"recall":"(hard|soft)"\}/);
      const [rd, rs] = rm?.[1] === "hard" ? [5,5] : rm?.[1] === "soft" ? [1,1] : [3,3];
      const recalled = store.recall(ch.block.content, rd, rs);
      for (const seg of recalled) {
        const already = ctx.getBlocks().some((b) => b.type === "memory" && b.content.includes(seg.slice(0, 50)));
        if (!already) {
          mutations.push({
            action: "insert", priority: 90,
            block: { type: "memory", content: `[记忆] ${seg}`, meta: { source: "memory", notify: false }, created: Date.now() },
          });
        }
      }
    }
    resetTimer();
    return mutations;
  },
};

function resetTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    // Summarization handled internally by store when idle
  }, idleMinutes * 60 * 1000);
}

export function getStore() { return store; }
export default memoryModule;
