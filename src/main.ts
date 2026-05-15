import { config as loadEnv } from "dotenv"; loadEnv();
import { createInterface } from "readline";
import { resolve as pathResolve } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { loadConfig } from "./config.js";
import { ContextManager } from "./core/context.js";
import { EventBus } from "./core/bus.js";
import { LockManager } from "./core/lock.js";
import { ModuleRegistry } from "./modules/registry.js";
import { start, stop, status, isRunning } from "./daemon/index.js";
import { startRelay, cleanupRelay, attachClient, waitForPort } from "./daemon/attach.js";
import { getSpeakHistory } from "../extensions/builtin/console/index.js";
import { resetThinking } from "../extensions/builtin/llm/index.js";
import { resetRecall } from "../extensions/builtin/memory/index.js";
import { handleMcpCall } from "../extensions/builtin/mcp/index.js";
import type { ModuleContext } from "./modules/base.js";

const L = { mcp: (s: string) => process.stderr.write(`\x1b[33m  ⚡\x1b[0m ${s}\n`) };

const cmd = process.argv[2] ?? "run";
const nameArg = process.argv.find((a) => a.startsWith("--name="));
const instanceName = nameArg ? nameArg.split("=")[1] : "default";
const isDaemonMode = process.argv.includes("--daemon");

if (cmd === "help" || cmd === "--help") {
  console.log("Usage: dolly [run|start|stop|status] [--name=xxx]");
  console.log("  run      连接到实例（自动启动 daemon）");
  console.log("  start    后台启动 daemon");
  console.log("  stop     停止 daemon");
  console.log("  status   查看状态");
  process.exit(0);
}
if (cmd === "start") { start(instanceName); process.exit(0); }
if (cmd === "stop") { stop(instanceName); process.exit(0); }
if (cmd === "status") { status(instanceName); process.exit(0); }

// ── Client mode (dolly run) ──────────────────────────────────────
if (!isDaemonMode) {
  if (!isRunning(instanceName)) {
    process.stderr.write(`Starting daemon for "${instanceName}"...\n`);
    start(instanceName);
    await waitForPort(instanceName);
  }
  process.stderr.write(`Connected to "${instanceName}". Type /exit to quit, Ctrl-C to exit.\n\n`);
  attachClient(instanceName); // blocks via active socket, exits on close
  process.exit(0);
}

// ── Daemon mode (internal, --daemon flag) ────────────────────────

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
    config: config.modules,
    emit: (event, payload) => bus.emit(event, payload),
    log: (_op, _detail) => {},
    lock,
    setSystemPrompt: (_text) => {},
    storagePath: profileDir,
  };

  const profileExtsDir = pathResolve(profileDir, "exts");
  const registry = new ModuleRegistry(ctx, bus, pathResolve(import.meta.dirname!, "..", "extensions"), profileExtsDir);
  await registry.discover();
  await registry.loadFromConfig(config.modules.enabled);

  const persona = (config as any).agent?.persona ?? "";
  const bg = (config as any).agent?.background ?? "";
  context.setSystemPrompt([persona, bg, registry.buildSystemPrompt()].filter(Boolean).join("\n\n"));

  // Profile restore
  const profileFile = pathResolve(profileDir, "context.json");
  if (existsSync(profileFile)) {
    try { const saved = JSON.parse(readFileSync(profileFile, "utf-8")); for (const b of (saved.blocks ?? [])) context.addBlock(b.type, b.content, b.meta); } catch {}
    context.applyMutations([]);
  }

  // Events
  bus.on("forget.requested", (p: any) => context.removeBlock(p.blockId));
  bus.on("reasoning.captured", (p: any) => {
    const block = context.addBlock("reasoning", p.content, { source: "llm", notify: false });
    context.removeBlock(block.id);
  });

  let midnightTimer = setInterval(() => {
    const h = new Date().getHours(), m = new Date().getMinutes();
    if (h === 3 && m < 10) { bus.emit("midnight.tick", {}); resetThinking(); resetRecall(); }
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
    saveProfile();
  }

  // Input handler
  async function handleInput(line: string) {
    if (line === "/reload") { await registry.reloadAll(); return; }
    const reloadExt = line.match(/^\/reload\s+--ext=(\S+)/);
    if (reloadExt) { await registry.reload(reloadExt[1]); return; }
    const enableExt = line.match(/^\/enable\s+(\S+)/);
    if (enableExt) { await registry.enable(enableExt[1]); return; }
    const disableExt = line.match(/^\/disable\s+(\S+)/);
    if (disableExt) { registry.disable(disableExt[1]); return; }
    context.addBlock("message", line);
    await cascade();
  }

  const saveProfile = () => {
    const blocks = context.getBlocks().filter((b) => b.type !== "system");
    writeFileSync(profileFile, JSON.stringify({ blocks, savedAt: Date.now() }, null, 2));
  };

  // Daemon: relay handles all I/O. Broadcast speaks to all connected clients.
  const clients = new Set<any>();
  bus.on("speak", (p: any) => {
    const line = p.text + "\n";
    for (const s of clients) { try { s.write(line); } catch {} }
  });

  const relay = startRelay(instanceName, (socket) => {
    clients.add(socket);
    for (const line of getSpeakHistory()) socket.write(line + "\n");
    const rl = createInterface({ input: socket, output: socket });
    (async () => {
      for await (const line of rl) {
        if (line.trim() === "/exit") { socket.end(); break; }
        if (line.trim()) await handleInput(line.trim());
      }
    })();
    socket.on("close", () => { clients.delete(socket); rl.close(); });
  });

  process.stderr.write(`  Daemon: ${instanceName}\n  Modules: ${registry.list().join(", ")}\n  Ready.\n`);

  // Keep alive until SIGTERM
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      saveProfile();
      cleanupRelay(instanceName);
      relay.close();
      clearInterval(midnightTimer);
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      saveProfile();
      cleanupRelay(instanceName);
      relay.close();
      clearInterval(midnightTimer);
      process.exit(0);
    });
  });
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
