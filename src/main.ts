import { config as loadEnv } from "dotenv"; loadEnv();
import { createInterface } from "readline";
import { resolve as pathResolve } from "path";
import { loadConfig } from "./config.js";
import { ContextManager } from "./core/context.js";
import { EventBus } from "./core/bus.js";
import { LockManager } from "./core/lock.js";
import { ModuleRegistry } from "./modules/registry.js";
import { MemoryStore } from "./memory/store.js";
import { LLMClient } from "./core/llm-client.js";
import { start, stop, status } from "./daemon/index.js";
import { handleMcpCall } from "../extensions/builtin/mcp/index.js";
import type { ModuleContext } from "./modules/base.js";

const L = {
  inject: (s: string) => process.stderr.write(`\x1b[35m  ◀\x1b[0m ${s}\n`),
  mcp: (s: string) => process.stderr.write(`\x1b[33m  ⚡\x1b[0m ${s}\n`),
  mem: (s: string) => process.stderr.write(`\x1b[34m  ●\x1b[0m ${s}\n`),
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
  const memory = new MemoryStore(pathResolve(import.meta.dirname!, "..", config.memory.path), memoryClient);

  const ctx: ModuleContext = {
    getBlocks: () => context.getBlocks(),
    getBlock: (id) => context.getBlock(id),
    estimateTokens: () => context.estimateTokens(),
    config: { ...config.modules, _llm_main: config.llm.main, _llm_guard: config.llm.guard, _llm_memory: config.llm.memory },
    emit: (event, payload) => bus.emit(event, payload),
    log: (op, detail) => { memory.appendLog(op, detail); },
    lock,
  };

  const registry = new ModuleRegistry(ctx, bus, pathResolve(import.meta.dirname!, "..", "extensions"));
  await registry.loadFromConfig(config.modules.enabled);

  const persona = (config as any).agent?.persona ?? "";
  const bg = (config as any).agent?.background ?? "";
  context.setSystemPrompt([persona, bg, registry.buildSystemPrompt()].filter(Boolean).join("\n\n"));

  // FORGET handling
  bus.on("forget.requested", (p: any) => {
    context.removeBlock(p.blockId);
  });

  // Tool calls → MCP or built-in
  bus.on("tool.call_requested", async (p: any) => {
    L.mcp(p.tool_name);
    let result: unknown;
    try { result = await handleMcpCall(p.tool_name.startsWith("mcp.") ? p.tool_name.slice(4) : p.tool_name, p.params); }
    catch { result = p.tool_name === "datetime" ? { datetime: new Date().toISOString() } : { error: `unknown tool: ${p.tool_name}` }; }
    context.addBlock("tool_result", JSON.stringify(result), { tool: p.tool_name, blocking: p.blocking });
    if (p.blocking) {
      await cascade(context, registry, memory, context.applyMutations([]));
    }
  });

  process.stderr.write(`  Modules: ${registry.list().join(", ")}\n  Ready.\n\n`);

  // Idle
  let idleTimer: NodeJS.Timeout | null = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      const blocks = context.getBlocks();
      if (blocks.length > 2) { L.mem(`Summarizing...`); try { await memory.summarize(blocks); } catch {} }
    }, config.memory.idle_minutes * 60 * 1000);
  };
  resetIdle();

  // Stdin → message blocks
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for await (const line of rl) {
    if (!line.trim()) continue;
    resetIdle();
    context.addBlock("message", line.trim());
    await cascade(context, registry, memory, context.applyMutations([]));
  }
  rl.close();
  if (idleTimer) clearTimeout(idleTimer);
}

async function cascade(
  context: ContextManager,
  registry: ModuleRegistry,
  memory: MemoryStore,
  changes: any[]
): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const mutations = await registry.pushChanges(changes);
    if (mutations.length === 0) break;
    L.inject(`round ${i + 1}: ${mutations.length} mutations`);
    const newChanges = context.applyMutations(mutations);
    for (const e of context.getLog()) memory.appendLog(e.op, e.detail);
    if (newChanges.length === 0) break;
    changes = newChanges;
  }
}

run().catch((err) => { console.error("Fatal:", err); process.exit(1); });
process.on("SIGINT", () => { process.exit(0); });
