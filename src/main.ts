import { config as loadEnv } from "dotenv"; loadEnv();
import { createInterface } from "readline";
import { resolve as pathResolve } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { loadConfig } from "./config.js";
import { ContextManager } from "./core/context.js";
import { EventBus } from "./core/bus.js";
import { LockManager } from "./core/lock.js";
import { ModuleRegistry } from "./modules/registry.js";
import { MemoryStore } from "./memory/store.js";
import { LLMClient } from "./core/llm-client.js";
import { start, stop, status } from "./daemon/index.js";
import { startRelay, cleanupRelay } from "./daemon/attach.js";
import { getSpeakHistory } from "../extensions/builtin/console/index.js";
import { handleMcpCall } from "../extensions/builtin/mcp/index.js";
import type { ModuleContext } from "./modules/base.js";

const L = {
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

async function main() {
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

  // Profile restore
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
    context.addBlock("tool_result", JSON.stringify(result), { tool: p.tool_name, blocking: p.blocking, source: "mcp", decay_rate: 0.5 });
    if (p.blocking) await cascade();
  });

  // Cascade function
  async function cascade() {
    let changes = context.applyMutations([]);
    for (let i = 0; i < 3; i++) {
      const mutations = await registry.pushChanges(changes);
      if (mutations.length === 0) break;
      changes = context.applyMutations(mutations);
      for (const e of context.getLog()) memory.appendLog(e.op, e.detail);
      if (changes.length === 0) break;
    }
  }

  // Recall helper
  function recallParams(line: string): [number, number] {
    const m = line.match(/\{"recall":"(hard|soft)"\}/);
    return m?.[1] === "hard" ? [5,5] : m?.[1] === "soft" ? [1,1] : [3,3];
  }

  // Input handler
  async function handleInput(line: string) {
    resetIdle();
    const [rd, rs] = recallParams(line);
    const recalled = memory.recall(line, rd, rs);
    for (const seg of recalled) {
      const already = context.getBlocks().some((b) => b.type === "memory" && b.content.includes(seg.slice(0, 50)));
      if (!already) context.addBlock("memory", `[记忆] ${seg}`, { notify: false });
    }
    context.addBlock("message", line);
    await cascade();
  }

  // Sleep
  let sleeping = false;
  let idleTimer: NodeJS.Timeout | null = null;
  let midnightTimer: NodeJS.Timeout | null = null;

  const sleepCycle = async (fullDay = false) => {
    if (sleeping) return; sleeping = true;
    L.sleep(`${fullDay ? "全量" : "增量"}...`);
    const blocks = context.getBlocks();
    if (blocks.length > 2) { try { await memory.summarize(blocks, fullDay); } catch {} }
    const allText = blocks.map((b) => b.content).join("\n");
    const recalled = memory.recall(allText.slice(-5000), 3, 3);
    for (const seg of recalled) {
      const already = context.getBlocks().some((b) => b.type === "memory" && b.content.includes(seg.slice(0, 50)));
      if (!already) context.addBlock("memory", `[记忆] ${seg}`, { notify: false });
    }
    // Background update (fullDay only)
    if (fullDay) {
      try {
        const maxChars = config.context.max_background_chars ?? 2000;
        const oldBg = context.getBackground();
        const combined = oldBg + "\n\n" + allText.slice(-6000);
        const bgPrompt = `以下是你的自述和今天的经历。请更新自述（不超过${maxChars}字符）。记录你认识的人、学到的方法、对事物的评价和认知。\n\n${combined.slice(-12000)}`;
        const newBg = (await memoryClient.chat([{ role: "user", content: bgPrompt }])).trim().slice(0, maxChars);
        context.setBackground(newBg);
        L.sleep("Background 已更新");
      } catch {}
    }
    sleeping = false;
  };

  const resetIdle = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(sleepCycle, config.memory.idle_minutes * 60 * 1000); };
  resetIdle();
  midnightTimer = setInterval(() => { const h = new Date().getHours(), m = new Date().getMinutes(); if (h === 3 && m < 10 && !sleeping) sleepCycle(true); }, 10 * 60 * 1000);

  process.stderr.write(`  Modules: ${registry.list().join(", ")}\n  Ready.\n\n`);

  // Relay (attach)
  const relay = startRelay(instanceName, (socket) => {
    // Replay history
    for (const line of getSpeakHistory()) { socket.write(line + "\n"); }
    const rl = createInterface({ input: socket, output: socket });
    (async () => { for await (const line of rl) { if (line.trim()) await handleInput(line.trim()); } })();
    socket.on("close", () => rl.close());
  });

  // Stdin
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for await (const line of rl) { if (line.trim()) await handleInput(line.trim()); }
  rl.close();
  if (idleTimer) clearTimeout(idleTimer);
  if (midnightTimer) clearInterval(midnightTimer);
  cleanupRelay(instanceName);
  relay.close();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
