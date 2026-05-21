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
    return `系统会自动注入相关记忆。当你面对一个你不确定的问题——特别是别人问你"你还记得吗？""我之前说过什么？"这类问题时——主动使用 recall 查找记忆：
\`\`\`json
{"recall":"hard"}
\`\`\`
hard 深度回忆（5天5段），soft 轻量回忆（1天1段）`;
  },

  async handleCli(args: string[], _c: ModuleContext) {
    if (args[0] === "midnight") {
      process.stderr.write("Forcing midnight pipeline...\n");
      const mutations = await _runMidnight();
      if (mutations.length > 0) ctx.emit("midnight.mutations", { mutations });
      process.stderr.write(`Midnight pipeline done: ${mutations.length} mutations\n`);
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
  process.stderr.write(`[midnight] summarizing ${blocks.length} blocks...\n`);
  const summary = await store.summarize(blocks, true);
  process.stderr.write(`[midnight] summarize returned: ${summary ? summary.day : 'null'}\n`);
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

  // Step 3: Generate mskills from today's lessons (multi-step with NLP dedup + thinking)
  const enableThinking = (ctx.config as any)["builtin/memory"]?.enable_thinking ?? false;
  const chat = (prompt: string) =>
    enableThinking ? client.chatWithReasoning([{ role: "user", content: prompt }]).then(r => r.content) : client.chat([{ role: "user", content: prompt }]);

  function parseFencedJson(text: string): Record<string, unknown> | null {
    const m = text.match(/```json\s*\n([\s\S]*?)```/);
    if (!m) return null;
    try { const o = JSON.parse(m[1].trim()); return o && typeof o === "object" && !Array.isArray(o) ? o as any : null; } catch { return null; }
  }
  function parseFencedJsonAll(text: string): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];
    const re = /```json\s*\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text))) {
      try { const o = JSON.parse(m[1].trim()); if (o && typeof o === "object" && !Array.isArray(o)) results.push(o); } catch {}
    }
    return results;
  }

  try {
    // 3a. List candidates: LLM proposes skill descriptions (structured JSON output)
    const candidatePrompt = `基于今天的收获与教训，列出你可能学到的新能力。只列出名称和一句话描述。最多 3 个。如果没有值得封装的能力，返回 {"candidates":[]}。

教训：\n${summary.lessons}

用 fenced JSON 输出：
\`\`\`json
{"candidates":[{"name":"英文短名","desc":"触发条件一句话"}]}
\`\`\``;
    const candidateResp = await chat(candidatePrompt);
    const candObj = parseFencedJson(candidateResp);
    const candList: Array<{ name: string; desc: string }> = (candObj?.candidates as any[])?.filter((c: any) => c.name && c.desc) ?? [];
    if (candList.length === 0) return mutations;

    // 3b. Load existing skills for NLP dedup
    const { readdirSync, existsSync: es2, readFileSync: rfs2 } = await import("fs");
    const { tokenize, tfVector, cosineSimilarity } = await import("../../../src/memory/nlp.js");
    const existingSkills: Array<{ name: string; desc: string; body: string; path: string }> = [];

    const mskillRoot = resolve(ctx.storagePath, "mskills");
    if (es2(mskillRoot)) {
      for (const entry of readdirSync(mskillRoot)) {
        const skillDir = resolve(mskillRoot, entry);
        const mdFile = resolve(skillDir, "SKILL.md");
        if (es2(mdFile)) {
          const raw = rfs2(mdFile, "utf-8");
          const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
          if (fmMatch) {
            const fm: Record<string, string> = {};
            for (const line of fmMatch[1].split("\n")) {
              const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
              if (kv) fm[kv[1]] = kv[2].trim();
            }
            existingSkills.push({ name: fm.name ?? entry, desc: fm.description ?? "", body: fmMatch[2].trim(), path: mdFile });
          }
        }
      }
    }
    const { writeFileSync: wfs, mkdirSync: mkdir } = await import("fs");

    // 3c. NLP dedup + AI decision per candidate
    for (const cand of candList) {
      const candVec = tfVector(tokenize(cand.name + " " + cand.desc));
      const similar = existingSkills
        .map((s) => ({ skill: s, score: cosineSimilarity(candVec, tfVector(tokenize(s.name + " " + s.desc))) }))
        .filter((s) => s.score > 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      if (similar.length === 0) {
        // 3d. Novel: generate full skill body
        const novelPrompt = `你学到一个新能力，创建为技能。用 fenced JSON 输出：\n\n名称：${cand.name}\n触发条件：${cand.desc}\n\n\`\`\`json\n{"body":"完整 markdown 技能内容"}\n\`\`\``;
        const bodyResp = await chat(novelPrompt);
        const bodyObj = parseFencedJson(bodyResp);
        const body = (bodyObj?.body as string) ?? bodyResp.trim();
        const skillName = cand.name.replace(/[^a-zA-Z0-9一-鿿_-]/g, "-").slice(0, 40);
        const mskillDir = resolve(ctx.storagePath, "mskills", skillName);
        if (!es2(mskillDir)) mkdir(mskillDir, { recursive: true });
        wfs(resolve(mskillDir, "SKILL.md"), `---\nname: ${skillName}\ndescription: ${cand.desc}\n---\n\n${body}`);
      } else {
        // 3e. Similar found: show full existing skill, AI decides via structured JSON
        const similarText = similar.map((s, i) =>
          `${i}: 相似度=${s.score.toFixed(2)}\n名称：${s.skill.name}\n描述：${s.skill.desc}\n完整内容：\n${s.skill.body}`
        ).join("\n\n---\n\n");

        const decidePrompt = `你学到：${cand.name} — ${cand.desc}\n\n发现以下相似技能（含完整内容）：\n${similarText}\n\n决定如何处理。用 fenced JSON 输出：\n\`\`\`json\n{"action":"create|modify|skip","modify_index":0,"body":"如果是 create 或 modify，输出完整 markdown body"}\n\`\`\``;
        const decisionResp = await chat(decidePrompt);
        const decObj = parseFencedJson(decisionResp);
        const action = (decObj?.action as string) ?? "skip";

        if (action === "modify") {
          const idx = (decObj?.modify_index as number) ?? 0;
          const target = similar[idx]?.skill;
          if (target && target.path) {
            const body = (decObj?.body as string);
            if (body) {
              wfs(target.path, `---\nname: ${target.name}\ndescription: ${target.desc}\n---\n\n${body}`);
            }
          }
        } else if (action === "create") {
          const body = (decObj?.body as string);
          if (body) {
            const skillName = cand.name.replace(/[^a-zA-Z0-9一-鿿_-]/g, "-").slice(0, 40);
            const mskillDir = resolve(ctx.storagePath, "mskills", skillName);
            if (!es2(mskillDir)) mkdir(mskillDir, { recursive: true });
            wfs(resolve(mskillDir, "SKILL.md"), `---\nname: ${skillName}\ndescription: ${cand.desc}\n---\n\n${body}`);
          }
        }
        // skip → do nothing
      }
    }
  } catch {}

  return mutations;
}

export default memoryModule;
