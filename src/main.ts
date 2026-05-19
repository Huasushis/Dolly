import { config as loadEnv } from "dotenv"; loadEnv();
import { createInterface } from "readline";
import { resolve as pathResolve } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { loadConfig } from "./config.js";
import { ContextManager } from "./core/context.js";
import { EventBus } from "./core/bus.js";
import { LockManager } from "./core/lock.js";
import { ModuleRegistry } from "./modules/registry.js";
import { start, stop, status, isRunning, pidFile } from "./daemon/index.js";
import { startRelay, cleanupRelay, attachClient, waitForPort } from "./daemon/attach.js";
import { getSpeakHistory } from "../extensions/builtin/console/index.js";
import { resetThinking } from "../extensions/builtin/llm/index.js";
import { resetRecall, runMidnight } from "../extensions/builtin/memory/index.js";
import { handleMcpCall } from "../extensions/builtin/mcp/index.js";
import type { ModuleContext } from "./modules/base.js";

const L = { mcp: (s: string) => process.stderr.write(`\x1b[33m  ⚡\x1b[0m ${s}\n`) };

const cmd = process.argv[2] ?? "run";
const nameArg = process.argv.find((a) => a.startsWith("--name="));
const instanceName = nameArg ? nameArg.split("=")[1] : "default";
const isDaemonMode = process.argv.includes("--daemon");

if (cmd === "help" || cmd === "--help") {
  console.log("Usage: dolly [start|stop|status] [--name=xxx]");
  console.log("  start    后台启动 daemon");
  console.log("  stop     停止 daemon");
  console.log("  status   查看状态");
  console.log("  console  连接交互式终端 (extension: builtin/console)");
  process.exit(0);
}
if (cmd === "start") { start(instanceName); process.exit(0); }
if (cmd === "stop") { stop(instanceName); process.exit(0); }
if (cmd === "status") { status(instanceName); process.exit(0); }

// ── Client mode (dolly console / dolly <ext> <args>) ──────────────
if (!isDaemonMode) {
  if (!isRunning(instanceName)) {
    process.stderr.write(`Starting daemon for "${instanceName}"...\n`);
    start(instanceName);
    await waitForPort(instanceName);
  }
  process.stderr.write(`Connected to "${instanceName}". Type /exit to quit, Ctrl-C to exit.\n\n`);
  attachClient(instanceName); // exits via socket.on("close") → process.exit(0)
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
    saveState: (_data) => {},
    loadState: () => null,
  };

  const profileExtsDir = pathResolve(profileDir, "exts");
  const registry = new ModuleRegistry(ctx, bus, pathResolve(import.meta.dirname!, "..", "extensions"), profileExtsDir);
  await registry.discover();
  await registry.loadFromConfig(config.modules.enabled);

  // System prompt: persona + module prompts, no static background
  const persona = (config as any).agent?.persona ?? "";
  context.setSystemPrompt([persona, registry.buildSystemPrompt()].filter(Boolean).join("\n\n"));

  // Profile restore (preserving original block identity)
  const profileFile = pathResolve(profileDir, "context.json");
  if (existsSync(profileFile)) {
    try {
      const saved = JSON.parse(readFileSync(profileFile, "utf-8"));
      for (const b of (saved.blocks ?? [])) context.restoreBlock(b);
    } catch {}
    context.applyMutations([]);
  }

  // ── Framework-native: forget scanning ──
  // Scan ALL new blocks for {"forget":"ID"} and remove target blocks
  function scanForget(changes: import("./blocks/index.js").BlockChange[]) {
    const re = /```json\s*\n([\s\S]*?)```/g;
    for (const ch of changes) {
      if (ch.type !== "added") continue;
      let m;
      while ((m = re.exec(ch.block.content))) {
        try {
          const obj = JSON.parse(m[1].trim());
          if (obj?.forget) context.removeBlock(obj.forget as string);
        } catch {}
      }
    }
  }

  // ── Bus: reasoning capture (add to log only, not context) ──
  bus.on("reasoning.captured", (p: any) => {
    const block = context.addBlock("inner", p.content, { source: "llm", subtype: "reasoning" });
    context.removeBlock(block.id); // log only, not context
  });

  // ── Bus: tool calls ──
  bus.on("tool.call_requested", async (p: any) => {
    L.mcp(p.tool_name);
    const unlock = await lock.acquire("mcp", 0);
    try {
      let result: unknown;
      try { result = await handleMcpCall(p.tool_name.startsWith("mcp.") ? p.tool_name.slice(4) : p.tool_name, p.params); }
      catch { result = { error: `unknown tool: ${p.tool_name}` }; }
      context.addBlock("outer", JSON.stringify(result), { source: "mcp", subtype: "tool_result", tool: p.tool_name, decay_rate: 0.5 });
    } finally { unlock(); }
    await cascade();
  });

  // ── Midnight timer ──
  let midnightRan = false;
  let midnightTimer = setInterval(async () => {
    const h = new Date().getHours(), m = new Date().getMinutes();
    if (h === 3 && m < 10) {
      if (midnightRan) return;
      midnightRan = true;
      resetThinking();
      resetRecall();
      bus.emit("midnight.tick", {});
      // Run full midnight pipeline: summarize + background + mskill
      try {
        const mutations = await runMidnight();
        if (mutations.length > 0) context.applyMutations(mutations);
        saveProfile();
      } catch (e: any) { process.stderr.write(`[midnight] ${e.message}\n`); }
    }
    if (h === 3 && m >= 10) midnightRan = false;
  }, 10 * 60 * 1000);

  // ── Cascade ──
  async function cascade() {
    // Pre-cascade: force decay if over hard threshold
    if (context.estimateTokens() > config.context.max_tokens * 0.95) {
      context.decayCheck();
    }
    let changes = context.applyMutations([]);
    for (let i = 0; i < 3; i++) {
      scanForget(changes); // framework scans for forget commands
      const mutations = await registry.pushChanges(changes);
      if (mutations.length === 0) break;
      changes = context.applyMutations(mutations);
      if (changes.length === 0) break;
    }
    saveProfile();
  }

  // ── Input handler ──
  async function handleInput(line: string) {
    // Try structured JSON command: {"cmd":"ext","args":[...]}
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.cmd === "string") {
        const extName = obj.cmd;
        const extArgs: string[] = obj.args ?? [];
        // Route to extension via relay's response socket (handled per-command)
        if (extName === "console") {
          context.addBlock("outer", extArgs.join(" "), { source: "console" });
          await cascade();
        } else {
          await registry.dispatchCli(extName, extArgs);
        }
        return;
      }
    } catch {}
    // Legacy text commands
    if (line === "/reload") { await registry.reloadAll(); return; }
    const reloadExt = line.match(/^\/reload\s+--ext=(\S+)/);
    if (reloadExt) { await registry.reload(reloadExt[1]); return; }
    const enableExt = line.match(/^\/enable\s+(\S+)/);
    if (enableExt) { await registry.enable(enableExt[1]); return; }
    const disableExt = line.match(/^\/disable\s+(\S+)/);
    if (disableExt) { registry.disable(disableExt[1]); return; }
    // Raw text → outer block
    context.addBlock("outer", line, { source: "console" });
    await cascade();
  }

  const saveProfile = () => {
    const blocks = context.getBlocks().filter((b) => b.type !== "system");
    writeFileSync(profileFile, JSON.stringify({ blocks, savedAt: Date.now() }, null, 2));
  };

  writeFileSync(pidFile(instanceName), String(process.pid));

  // ── Relay + speak broadcast ──
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
      socket.end();
    })();
    socket.on("close", () => { clients.delete(socket); rl.close(); });
  });

  // Call onStart on all modules after restore
  await registry.dispatchStart();

  process.stderr.write(`  Daemon: ${instanceName}\n  Modules: ${registry.list().join(", ")}\n  Ready.\n`);

  async function shutdown() {
    await registry.dispatchStop();
    saveProfile();
    cleanupRelay(instanceName);
    relay.close();
    clearInterval(midnightTimer);
    process.exit(0);
  }
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => { shutdown(); });
    process.on("SIGTERM", () => { shutdown(); });
  });
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
