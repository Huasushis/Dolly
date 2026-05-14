import { config as loadEnv } from "dotenv"; loadEnv();
import { createInterface } from "readline";
import { resolve as pathResolve } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { loadConfig } from "./config.js";
import { ContextManager } from "./core/context.js";
import { EventBus } from "./core/bus.js";
import { LockManager } from "./core/lock.js";
import { ModuleRegistry } from "./modules/registry.js";
import { MemoryStore } from "./memory/store.js";
import { LLMClient } from "./core/llm-client.js";
import { start, stop, status } from "./daemon/index.js";
import { startRelay, cleanupRelay } from "./daemon/attach.js";
import { handleMcpCall } from "../extensions/builtin/mcp/index.js";
import { extractKeywords } from "./memory/nlp.js";
import type { ModuleContext } from "./modules/base.js";

const L = {
  inject: (s: string) => process.stderr.write(`\x1b[35m  ◀\x1b[0m ${s}\n`),
  mcp:   (s: string) => process.stderr.write(`\x1b[33m  ⚡\x1b[0m ${s}\n`),
  mem:   (s: string) => process.stderr.write(`\x1b[34m  ●\x1b[0m ${s}\n`),
  sleep: (s: string) => process.stderr.write(`\x1b[36m  ~ SLEEP\x1b[0m ${s}\n`),
};

const cmd = process.argv[2] ?? "run";
const nameArg = process.argv.find((a) => a.startsWith("--name="));
const instanceName = nameArg ? nameArg.split("=")[1] : "default";

if (cmd === "start") { start(instanceName); process.exit(0); }
if (cmd === "stop") { stop(instanceName); process.exit(0); }
if (cmd === "status") { status(instanceName); process.exit(0); }
if (cmd !== "run") { console.log("Usage: dolly [run|start|stop|status] [--name=xxx]"); process.exit(1); }

async function run() {
  const config = loadConfig();
  const bus = new EventBus();
  const lock = new LockManager();
  const context = new ContextManager(config.context);
  const memoryClient = new LLMClient(config.llm.memory);
  const profileDir = pathResolve(import.meta.dirname!, "..", ".dolly", "profiles", instanceName);
  if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });
  const memory = new MemoryStore(pathResolve(profileDir, "memory"), memoryClient);

  const ctx: ModuleContext = {
    getBlocks: () => context.getBlocks(),
    getBlock: (id) => context.getBlock(id),
    estimateTokens: () => context.estimateTokens(),
    config: { ...config.modules, _llm_main: config.llm.main, _llm_guard: config.llm.guard, _llm_memory: config.llm.memory },
    emit: (event, payload) => bus.emit(event, payload),
    log: (op, detail) => { memory.appendLog(op, detail); },
    lock,
    storagePath: "",
  };

  const registry = new ModuleRegistry(ctx, bus, pathResolve(import.meta.dirname!, "..", "extensions"));
  await registry.loadFromConfig(config.modules.enabled);

  const persona = (config as any).agent?.persona ?? "";
  const bg = (config as any).agent?.background ?? "";
  context.setSystemPrompt([persona, bg, registry.buildSystemPrompt()].filter(Boolean).join("\n\n"));

  // Profile restore (run with --name restores previous context)
  const profileFile = pathResolve(profileDir, "context.json");
  if (existsSync(profileFile)) {
    try { const saved = JSON.parse(readFileSync(profileFile, "utf-8")); for (const b of (saved.blocks ?? [])) context.addBlock(b.type, b.content, b.meta); } catch {}
  }

  // Events
  bus.on("forget.requested", (p: any) => context.removeBlock(p.blockId));
  bus.on("tool.call_requested", async (p: any) => {
    L.mcp(p.tool_name);
    let result: unknown;
    try { result = await handleMcpCall(p.tool_name.startsWith("mcp.") ? p.tool_name.slice(4) : p.tool_name, p.params); }
    catch { result = p.tool_name === "datetime" ? { datetime: new Date().toISOString() } : { error: `unknown tool: ${p.tool_name}` }; }
    context.addBlock("tool_result", JSON.stringify(result), { tool: p.tool_name, blocking: p.blocking });
    if (p.blocking) await cascade(context, registry, memory);
  });

  process.stderr.write(`  Modules: ${registry.list().join(", ")}\n  Ready.\n\n`);

  // ── Sleep cycle ─────────────────────────────────────────
  let sleeping = false;
  let idleTimer: NodeJS.Timeout | null = null;
  let midnightTimer: NodeJS.Timeout | null = null;
  const sleepStateFile = pathResolve(import.meta.dirname!, "..", config.memory.path, "sleep_state.json");

  const sleepCycle = async (fullDay = false) => {
    if (sleeping) return;
    sleeping = true;
    L.sleep(`开始 (${fullDay ? "全量" : "增量"})...`);
    const blocks = context.getBlocks();

    // 1. Summarize
    if (blocks.length > 2) {
      L.mem(`${fullDay ? "全量" : "增量"}总结...`);
      try { await memory.summarize(blocks, fullDay); } catch {}
    }

    // 2-3. Recall: search day summaries → drill daily logs → inject segments
    const allText = blocks.map((b) => b.content).join("\n");
    const recalled = memory.recall(allText.slice(-5000), 3, 3);
    for (const seg of recalled) {
      context.addBlock("memory", `[记忆] ${seg}`, { notify: false });
    }
    if (recalled.length > 0) L.mem(`注入 ${recalled.length} 段记忆`);

    // 4. Skill auto-creation (guard_llm)
    const autoSkills = (config as any).memory?.sleep?.auto_create_skills ?? true;
    if (autoSkills) {
      L.sleep("评估 skill 创建...");
      try { await autoCreateSkill(allText, config, memoryClient); } catch {}
    }

    // Write sleep state
    try { writeFileSync(sleepStateFile, JSON.stringify({ lastSleep: Date.now(), entries: memory.hasEntriesForToday() })); } catch {}
    L.sleep("完成");
    sleeping = false;
  };

  // Auto skill creation helper
  async function autoCreateSkill(dayText: string, cfg: any, llm: LLMClient) {
    // Step 1: Evaluate
    const evalResp = await llm.chat([{ role: "user", content: "回顾今天的经历。是否学到了可复用的新能力或流程？仅回复 yes 或 no。" }]);
    if (!evalResp.trim().toLowerCase().startsWith("yes")) { L.sleep("无需创建 skill"); return; }

    // Step 2: Generate description
    const descResp = await llm.chat([{ role: "user", content: "描述这个新能力：它做什么？什么场景下应该触发？用第三人称，2-3句话。" }]);
    const description = descResp.trim();
    if (!description || description.length < 10) { L.sleep("描述太短，跳过"); return; }

    // Step 3: NLP search existing learned skills
    const learnedDir = pathResolve(import.meta.dirname!, "..", "extensions", "builtin", "skill", "skills", "learned");
    const existing: Array<{name: string; description: string}> = [];
    if (existsSync(learnedDir)) {
      const { readdirSync: rd } = await import("fs");
      for (const entry of rd(learnedDir)) {
        const md = pathResolve(learnedDir, entry, "SKILL.md");
        if (existsSync(md)) {
          try {
            const raw = readFileSync(md, "utf-8");
            const m = raw.match(/^---\n([\s\S]*?)\n---/);
            if (m) {
              const fm: Record<string,string> = {};
              for (const line of m[1].split("\n")) {
                const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
                if (kv) fm[kv[1]] = kv[2].trim();
              }
              if (fm.name && fm.description) existing.push({name: fm.name, description: fm.description});
            }
          } catch {}
        }
      }
    }

    // Step 4: Decide new/modify/discard
    let decision: string;
    if (existing.length > 0) {
      const existingStr = existing.map((e) => `- ${e.name}: ${e.description}`).join("\n");
      decision = (await llm.chat([{ role: "user", content: `已有skills:\n${existingStr}\n\n新能力: ${description}\n\n新建(new)、修改已有(modify <name>)还是放弃(discard)？` }])).trim();
    } else {
      decision = "new";
    }

    let finalMd: string;
    if (decision.toLowerCase().startsWith("new")) {
      finalMd = (await llm.chat([{ role: "user", content: `创建 SKILL.md。YAML frontmatter 只含 name+description。body 用祈使句。不要创建README等无关文件。只保留AI需要的信息。\n\n能力: ${description}\n\n输出完整 SKILL.md：` }])).trim();
    } else if (decision.toLowerCase().startsWith("modify")) {
      const targetName = decision.split(/\s+/)[1] || existing[0]?.name;
      const targetMd = pathResolve(learnedDir, targetName, "SKILL.md");
      if (!existsSync(targetMd)) { L.sleep(`找不到 ${targetName}，放弃`); return; }
      const oldContent = readFileSync(targetMd, "utf-8");
      finalMd = (await llm.chat([{ role: "user", content: `修改以下 SKILL.md，融入新内容。保持原有有效部分，只更新/扩展。\n\n${oldContent}\n\n新场景: ${description}\n\n输出完整的新 SKILL.md：` }])).trim();
    } else {
      L.sleep("决策: discard"); return;
    }

    if (!finalMd || !finalMd.includes("---")) { L.sleep("生成的 SKILL.md 无效，跳过"); return; }

    // Extract name from frontmatter
    const nameMatch = finalMd.match(/^---\n[\s\S]*?name:\s*(\S+)[\s\S]*?\n---/);
    if (!nameMatch) { L.sleep("无法解析 skill 名称"); return; }
    const skillName = nameMatch[1];

    // Write
    const skillDir = pathResolve(learnedDir, skillName);
    if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true });
    writeFileSync(pathResolve(skillDir, "SKILL.md"), finalMd, "utf-8");
    L.sleep(`创建 skill: ${skillName}`);
  }

  // Idle trigger
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(sleepCycle, config.memory.idle_minutes * 60 * 1000);
  };
  resetIdle();

  // Midnight check every 10 min
  midnightTimer = setInterval(() => {
    const h = new Date().getHours();
    const m = new Date().getMinutes();
    if (h === 3 && m < 10 && !sleeping) sleepCycle(true);
  }, 10 * 60 * 1000);

  // ── Main loop ──────────────────────────────────────────
  const relay = startRelay(instanceName, (socket) => {
    const rl = createInterface({ input: socket, output: socket });
    (async () => {
      for await (const line of rl) {
        if (!line.trim()) continue;
        resetIdle();
        const rm = line.match(/{"recall":"(hard|soft)"}/);
        const [rd, rs] = rm?.[1] === "hard" ? [5,5] : rm?.[1] === "soft" ? [1,1] : [3,3];
        const recalled = memory.recall(line.trim(), rd, rs);
        for (const seg of recalled) {
          context.addBlock("memory", `[记忆] ${seg}`, { notify: false });
        }
        context.addBlock("message", line.trim());
        await cascade(context, registry, memory);
      }
    })();
    socket.on("close", () => rl.close());
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for await (const line of rl) {
    if (!line.trim()) continue;
    resetIdle();
    // Parse recall tag for memory depth
    const recallMatch = line.match(/\{"recall":"(hard|soft)"\}/);
    const recallLevel = recallMatch?.[1] ?? "medium";
    const [days, segs] = recallLevel === "hard" ? [5,5] : recallLevel === "soft" ? [1,1] : [3,3];
    const recalled = memory.recall(line.trim(), days, segs);
    for (const seg of recalled) {
      // 去重：检查上下文是否已有相同内容
      const already = context.getBlocks().some((b) => b.type === "memory" && b.content.includes(seg.slice(0, 50)));
      if (!already) context.addBlock("memory", `[记忆] ${seg}`, { notify: false });
    }
    context.addBlock("message", line.trim());
    await cascade(context, registry, memory);
  }
  rl.close();
  if (idleTimer) clearTimeout(idleTimer);
  if (midnightTimer) clearInterval(midnightTimer);
  cleanupRelay(instanceName);
  relay.close();
}

async function cascade(
  context: ContextManager,
  registry: ModuleRegistry,
  memory: MemoryStore,
): Promise<void> {
  const changes = context.applyMutations([]);
  for (let i = 0; i < 3; i++) {
    const mutations = await registry.pushChanges(changes);
    if (mutations.length === 0) break;
    const newChanges = context.applyMutations(mutations);
    for (const e of context.getLog()) memory.appendLog(e.op, e.detail);
    if (newChanges.length === 0) break;
  }
}

run().catch((err) => { console.error("Fatal:", err); process.exit(1); });
