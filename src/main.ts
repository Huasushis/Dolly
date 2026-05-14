import { config as loadEnv } from "dotenv"; loadEnv();
import { createInterface } from "readline";
import { resolve as pathResolve } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { loadConfig } from "./config.js";
import { ContextManager } from "./core/context.js";
import { EventBus } from "./core/bus.js";
import { LockManager } from "./core/lock.js";
import { ModuleRegistry } from "./modules/registry.js";
import { start, stop, status } from "./daemon/index.js";
import { startRelay, cleanupRelay } from "./daemon/attach.js";
import { getSpeakHistory, replayHistory } from "../extensions/builtin/console/index.js";
import { resetThinking } from "../extensions/builtin/llm/index.js";
import { handleMcpCall } from "../extensions/builtin/mcp/index.js";
import type { ModuleContext } from "./modules/base.js";

const L = { mcp: (s: string) => process.stderr.write(`\x1b[33m  ⚡\x1b[0m ${s}\n`) };

const cmd = process.argv[2] ?? "run";
const nameArg = process.argv.find((a) => a.startsWith("--name="));
const instanceName = nameArg ? nameArg.split("=")[1] : "default";

if (cmd === "help" || cmd === "--help") {
  console.log("Usage: dolly [run|start|stop|status|reload] [--name=xxx]");
  console.log("  run      前台运行");
  console.log("  start    后台启动");
  console.log("  stop     停止实例");
  console.log("  status   查看状态");
  console.log("  reload   重载扩展 (--ext=<id>)");
  process.exit(0);
}
if (cmd === "start") { start(instanceName); process.exit(0); }
if (cmd === "stop") { stop(instanceName); process.exit(0); }
if (cmd === "status") { status(instanceName); process.exit(0); }
if (cmd !== "run") { console.log("Usage: dolly [run|start|stop|status] [--name=xxx]"); process.exit(1); }

async function main() {
  const config = loadConfig();
  const bus = new EventBus();
  const lock = new LockManager();
  const context = new ContextManager(config.context);

  const profileDir = pathResolve(import.meta.dirname!, "..", ".dolly", "profiles", instanceName);
  if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });

  const ctx: ModuleContext = {
    getBlocks: () => context.getBlocks(),
    getBlock: (id) => context.getBlock(id),
    estimateTokens: () => context.estimateTokens(),
    config: { ...config.modules, _llm_main: config.llm.main, _llm_guard: config.llm.guard, _llm_memory: config.llm.memory },
    emit: (event, payload) => bus.emit(event, payload),
    log: (_op, _detail) => {}, // handled by memory extension
    lock,
    setSystemPrompt: (_text) => {}, // handled by registry
    storagePath: "",
  };

  const profileExtsDir = pathResolve(profileDir, "exts");
  const registry = new ModuleRegistry(ctx, bus, pathResolve(import.meta.dirname!, "..", "extensions"), profileExtsDir);
  await registry.discover();
  await registry.loadFromConfig(config.modules.enabled);

  const persona = (config as any).agent?.persona ?? "";
  const bg = (config as any).agent?.background ?? "";
  context.setSystemPrompt([persona, bg, registry.buildSystemPrompt()].filter(Boolean).join("\n\n"));

  // Profile restore — drain changeQueue after so modules don't see old blocks as new
  const profileFile = pathResolve(profileDir, "context.json");
  if (existsSync(profileFile)) {
    try { const saved = JSON.parse(readFileSync(profileFile, "utf-8")); for (const b of (saved.blocks ?? [])) context.addBlock(b.type, b.content, b.meta); } catch {}
    context.applyMutations([]); // drain — restored blocks are context, not new events
  }

  // Events
  bus.on("forget.requested", (p: any) => context.removeBlock(p.blockId));
  // Capture reasoning for memory summary (add then immediately remove)
  bus.on("reasoning.captured", (p: any) => {
    const block = context.addBlock("reasoning", p.content, { source: "llm", notify: false });
    context.removeBlock(block.id);
  });
  // Midnight check every 10 min
  // Midnight check: trigger memory summary + reset deep thinking
  let midnightTimer = setInterval(() => {
    const h = new Date().getHours(), m = new Date().getMinutes();
    if (h === 3 && m < 10) {
      bus.emit("midnight.tick", {});
      resetThinking();
    }
  }, 10 * 60 * 1000);
  bus.on("tool.call_requested", async (p: any) => {
    L.mcp(p.tool_name);
    let result: unknown;
    try { result = await handleMcpCall(p.tool_name.startsWith("mcp.") ? p.tool_name.slice(4) : p.tool_name, p.params); }
    catch { result = p.tool_name === "datetime" ? { datetime: new Date().toISOString() } : { error: `unknown tool: ${p.tool_name}` }; }
    context.addBlock("tool_result", JSON.stringify(result), { tool: p.tool_name, blocking: p.blocking, source: "mcp", decay_rate: 0.5 });
    if (p.blocking) await cascade();
  });

  // Cascade
  async function cascade() {
    let changes = context.applyMutations([]);
    for (let i = 0; i < 3; i++) {
      const mutations = await registry.pushChanges(changes);
      if (mutations.length === 0) break;
      changes = context.applyMutations(mutations);
      if (changes.length === 0) break;
    }
  }

  // Input handler
  async function handleInput(line: string) {
    if (line === "/reload") { await registry.reloadAll(); return; }
    const reloadExt = line.match(/^\/reload\s+--ext=(\S+)/);
    if (reloadExt) { await registry.reload(reloadExt[1]); return; }
    if (line === "/list") {
      for (const e of registry.listAll()) process.stderr.write(`  ${e.enabled ? "✅" : "⬜"} ${e.id}${e.loaded ? "" : " (未加载)"}\n`);
      return;
    }
    const enableExt = line.match(/^\/enable\s+(\S+)/);
    if (enableExt) { await registry.enable(enableExt[1]); return; }
    const disableExt = line.match(/^\/disable\s+(\S+)/);
    if (disableExt) { registry.disable(disableExt[1]); return; }
    context.addBlock("message", line);
    await cascade();
  }

  // Save helper
  const saveProfile = () => {
    const blocks = context.getBlocks().filter((b) => b.type !== "system");
    writeFileSync(profileFile, JSON.stringify({ blocks, savedAt: Date.now() }, null, 2));
  };

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) { process.exit(1); }
    shuttingDown = true;
    saveProfile();
    rl.close();
    cleanupRelay(instanceName);
    relay.close();
    clearInterval(midnightTimer);
  }
  process.on("SIGINT", () => { shutdown(); });
  process.on("SIGTERM", () => { shutdown(); });

  process.stderr.write(`  Instance: ${instanceName}\n  Modules: ${registry.list().join(", ")}\n  Ready.\n\n`);
  replayHistory(); // show previous speak after banner

  // Relay (attach)
  const relay = startRelay(instanceName, (socket) => {
    for (const line of getSpeakHistory()) socket.write(line + "\n");
    const rl = createInterface({ input: socket, output: socket });
    (async () => { for await (const line of rl) { if (line.trim()) await handleInput(line.trim()); } })();
    socket.on("close", () => rl.close());
  });

  // Stdin
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  process.stdout.write("> ");
  for await (const line of rl) {
    if (line.trim()) await handleInput(line.trim());
    process.stdout.write("> ");
  }
  rl.close();
  cleanupRelay(instanceName);
  relay.close();
  clearInterval(midnightTimer);
  saveProfile();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
