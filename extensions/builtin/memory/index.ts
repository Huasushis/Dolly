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
    c.on("midnight.tick", async () => {
      recallMode = "default";
      const mutations = await _runMidnight();
      if (mutations.length > 0) c.emit("midnight.mutations", { mutations });
    });
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

  async handleCli(args: string[], _c: ModuleContext) {
    if (args[0] === "midnight") {
      process.stderr.write("Forcing midnight pipeline...\n");
      const blocks = ctx.getBlocks();
      const summary = await store.summarize(blocks, true);
      if (summary) process.stderr.write(`Summary done: ${summary.day}\n`);
    } else if (args[0] === "recall") {
      const query = args.slice(1).join(" ");
      const results = store.recall(query, 3, 3);
      for (const r of results) {
        process.stdout.write(`[${r.day}] ${r.summary.slice(0, 200)}\n`);
        for (const seg of r.segments) process.stdout.write(`  ${seg.slice(0, 100)}\n`);
      }
    } else if (args[0] === "search") {
      const query = args.slice(1).join(" ");
      const days = store.search(query, 5);
      for (const d of days) process.stdout.write(`${d.day}: ${d.summary.slice(0, 150)}\n`);
    }
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

memoryModule.cliInfo = [
  { cmd: "memory", sub: "midnight", desc: "强制执行午夜总结（总结+background+mskill）" },
  { cmd: "memory", sub: "recall <query>", desc: "搜索相关记忆片段" },
  { cmd: "memory", sub: "search <query>", desc: "搜索日总结" },
];

/** Full midnight pipeline: summarize day → generate background → generate mskills */
async function _runMidnight(): Promise<BlockMutation[]> {
  const mutations: BlockMutation[] = [];
  const blocks = ctx.getBlocks();

  // Step 0: Clean old memory blocks from context
  for (const b of blocks) {
    if (b.type === "inner" && b.meta?.source === "memory" && b.meta?.subtype === "memory") {
      mutations.push({ action: "delete", blockId: b.id });
    }
    if (b.type === "inner" && b.meta?.source === "skill" && !b.meta?.pinned) {
      // Stale skill blocks > 1 hour
      if (Date.now() - b.created > 3600000) mutations.push({ action: "delete", blockId: b.id });
    }
  }

  // Step 1: Summarize today
  const summary = await store.summarize(blocks, true);
  if (!summary) return mutations;

  // Step 2: Generate new background (compress entire context)
  try {
    const bgText = blocks.map((b) => `[${b.type}/${b.meta?.subtype ?? b.type}] ${b.content.slice(0, 300)}`).join("\n").slice(-15000);
    const bgPrompt = `压缩以下上下文。保留所有关键信息——人名、事实、决策、情绪、教训——但用更短的文字表达。不是写摘要，是做信息压缩：去掉冗余保留核心。如果上下文中已有 type=inner subtype=background 的块，把它和新内容合并压缩。限制 1500 字符。

上下文：
${bgText}`;
    const bgResp = await client.chat([{ role: "user", content: bgPrompt }]);
    const newBg = bgResp.trim().slice(0, 1500);
    if (newBg.length > 50) {
      // Remove old background blocks
      for (const b of blocks) {
        if (b.type === "inner" && b.meta?.subtype === "background" && b.meta?.source === "memory") {
          mutations.push({ action: "delete", blockId: b.id });
        }
      }
      mutations.push({
        action: "insert", priority: 5,
        block: { type: "inner", content: newBg, meta: { source: "memory", subtype: "background", pinned: true }, created: Date.now() },
      });
    }
  } catch {}

  // Step 3: Generate mskills from today's lessons
  try {
    const skillsPrompt = `基于今天的收获与教训，判断是否学到了可以复用的新能力。

教训：
${summary.lessons}

三步判断：
1. 列出今天可能学会的能力（最多3个）
2. 对每个能力判断：换个场景还能用吗？只能在这个场景用就淘汰
3. 对通过的判断：和已有技能重复吗？去重

最终输出通过的技能（0个或多个），格式：
skill_name: <英文短名>
skill_desc: <触发条件，一句话>
skill_body: <详细指令，markdown>

没有通过的就回复 none。`;
    const skillsResp = await client.chat([{ role: "user", content: skillsPrompt }]);
    if (!skillsResp.trim().toLowerCase().startsWith("none")) {
      const sections = skillsResp.split(/\n(?=skill_name:)/);
      const { writeFileSync: wfs, mkdirSync: mkdir, existsSync: es } = await import("fs");

      for (const sec of sections) {
        const nameMatch = sec.match(/skill_name:\s*(.+)/);
        const descMatch = sec.match(/skill_desc:\s*(.+)/);
        const bodyMatch = sec.match(/skill_body:\s*([\s\S]+)/);
        if (!nameMatch || !descMatch || !bodyMatch) continue;

        const skillName = nameMatch[1].trim().replace(/[^a-zA-Z0-9一-鿿_-]/g, "-").slice(0, 40);
        const mskillDir = resolve(ctx.storagePath, "mskills", skillName);
        if (!es(mskillDir)) mkdir(mskillDir, { recursive: true });
        const md = `---\nname: ${skillName}\ndescription: ${descMatch[1].trim()}\n---\n\n${bodyMatch[1].trim()}`;
        wfs(resolve(mskillDir, "SKILL.md"), md);
      }
    }
  } catch {}

  return mutations;
}

export default memoryModule;
