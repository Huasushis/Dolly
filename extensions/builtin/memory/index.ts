import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import type { DollyModule, ModuleContext } from "../../../src/modules/base.js";
import type { BlockChange, BlockMutation } from "../../../src/blocks/index.js";
import { MemoryStore } from "../../../src/memory/store.js";
import { LLMClient } from "../../../src/core/llm-client.js";

let store: MemoryStore;
let client: LLMClient;
let ctx: ModuleContext;
let idleTimer: NodeJS.Timeout | null = null;
let idleMinutes = 60;
let recallMode: "hard" | "soft" | "default" = "default";

function recallDepth(): [number, number] {
  if (recallMode === "hard") return [5, 5];
  if (recallMode === "soft") return [1, 1];
  return [3, 2];
}

const memoryModule: DollyModule = {
  id: "builtin/memory",

  async init(c: ModuleContext) {
    ctx = c;
    const cfg = (c.config as any)["builtin/memory"];
    client = new LLMClient(cfg ?? { api_key: "", base_url: "https://api.deepseek.com", model: "deepseek-chat" });
    const memPath = resolve(ctx.storagePath, "memory-store");
    if (!existsSync(memPath)) mkdirSync(memPath, { recursive: true });
    store = new MemoryStore(memPath, client);
    idleMinutes = cfg?.idle_minutes ?? 60;
    resetTimer();
  },

  systemPrompt(): string {
    return `每次对话时，系统会自动注入相关记忆。你可以调节回忆深度：
\`\`\`json
{"recall":"hard"}
\`\`\`
hard 深度回忆（5天5段，持续生效直到改变或凌晨重置）
soft 轻量回忆（1天1段，同上）`;
  },

  async onBlocksChanged(c: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    ctx = c;
    const mutations: BlockMutation[] = [];

    // Log all changes
    for (const ch of changes) {
      store.appendLog(ch.type, { type: ch.block.type, content: ch.block.content.slice(0, 200) });
    }

    // Check for recall mode changes in any new block
    for (const ch of changes) {
      if (ch.type !== "added") continue;
      const re = /```json\s*\n([\s\S]*?)```/g;
      let m;
      while ((m = re.exec(ch.block.content))) {
        try {
          const obj = JSON.parse(m[1].trim());
          if (obj?.recall === "hard") recallMode = "hard";
          if (obj?.recall === "soft") recallMode = "soft";
        } catch {}
      }
    }

    // Collect all new outer blocks (messages), batch recall once
    const newMessages = changes.filter((ch) => ch.type === "added" && ch.block.type === "outer");
    if (newMessages.length === 0) { resetTimer(); return mutations; }

    const queryText = newMessages.map((ch) => ch.block.content).join("\n");
    const rm = queryText.match(/\{"recall":"(hard|soft)"\}/);
    const [rd, rs] = rm?.[1] === "hard" ? [5,5] : rm?.[1] === "soft" ? [1,1] : recallDepth();
    const recalled = store.recall(queryText, rd, rs);

    // Inject summaries + segments (deduped, similarity-filtered already by store)
    for (const r of recalled) {
      if (r.summary) {
        const summaryKey = `summary:${r.day}`;
        const hasSummary = ctx.getBlocks().some((b) => b.type === "inner" && b.content.includes(summaryKey));
        if (!hasSummary) {
          mutations.push({
            action: "insert", priority: 85,
            block: { type: "inner", content: `[记忆 ${r.day}] ${r.summary}`, meta: { source: "memory", subtype: "memory" }, created: Date.now() },
          });
        }
      }
      for (const seg of r.segments) {
        const already = ctx.getBlocks().some((b) => b.type === "inner" && b.content.includes(seg.slice(0, 50)));
        if (!already) {
          mutations.push({
            action: "insert", priority: 90,
            block: { type: "inner", content: `[记忆 ${r.day}] ${seg}`, meta: { source: "memory", subtype: "memory" }, created: Date.now() },
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
    // Incremental summarization during idle
    const blocks = ctx.getBlocks();
    await store.summarize(blocks, false);
  }, idleMinutes * 60 * 1000);
}

export function getStore() { return store; }
export function resetRecall() { recallMode = "default"; }
export default memoryModule;
