import { config as loadEnv } from "dotenv"; loadEnv();
import { createInterface } from "readline";
import { resolve as pathResolve } from "path";
import { loadConfig } from "./config.js";
import { ContextManager } from "./core/context.js";
import { EventBus } from "./core/bus.js";
import { ModuleRegistry } from "./modules/registry.js";
import { MemoryStore } from "./memory/store.js";
import { LLMClient } from "./core/llm-client.js";
import { start, stop, status } from "./daemon/index.js";
import { handleMcpCall } from "../extensions/builtin/mcp/index.js";
import type { ModuleContext } from "./modules/base.js";

const L = {
  inject: (s: string) => process.stderr.write(`\x1b[35m  ◀\x1b[0m ${s}\n`),
  monitor: (s: string) => process.stderr.write(`\x1b[36m  ▶\x1b[0m ${s}\n`),
  mem: (s: string) => process.stderr.write(`\x1b[34m  ●\x1b[0m ${s}\n`),
  mcp: (s: string) => process.stderr.write(`\x1b[33m  ⚡\x1b[0m ${s}\n`),
  llm: (s: string) => process.stderr.write(`\x1b[90m  →\x1b[0m ${s}\n`),
};

const cmd = process.argv[2] ?? "run";
const nameFlag = process.argv.find((a) => a.startsWith("--name="));
const instanceName = nameFlag ? nameFlag.split("=")[1] : "default";

if (cmd === "start") { start(instanceName); process.exit(0); }
if (cmd === "stop") { stop(instanceName); process.exit(0); }
if (cmd === "status") { status(instanceName); process.exit(0); }
if (cmd !== "run") { console.log("Usage: dolly [run|start|stop|status] [--name=xxx]"); process.exit(1); }

// ── Run mode ──────────────────────────────────────────────
async function run() {
  const config = loadConfig();
  const bus = new EventBus();
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
  };

  const registry = new ModuleRegistry(ctx, bus, pathResolve(import.meta.dirname!, "..", "extensions"));
  await registry.loadFromConfig(config.modules.enabled);

  const sp = registry.buildSystemPrompt();
  context.setSystemPrompt(sp);

  // Tool call handling
  bus.on("tool.call_requested", async (p: any) => {
    L.mcp(`tool: ${p.tool_name}`);
    let result: unknown;
    if (p.tool_name.startsWith("mcp.")) {
      result = await handleMcpCall(p.tool_name.slice(4), p.params);
    } else if (p.tool_name === "datetime") {
      result = { datetime: new Date().toISOString() };
    } else {
      result = { error: `unknown tool: ${p.tool_name}` };
    }
    context.addBlock("tool_result", JSON.stringify(result), { tool: p.tool_name });
  });

  L.llm(`Modules: ${registry.list().join(", ")}`);
  L.llm(`Ready. Type and press Enter. Ctrl+C to exit.`);

  // Idle summarization timer
  let idleTimer: NodeJS.Timeout | null = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      const blocks = context.getBlocks();
      if (blocks.length > 2) {
        L.mem(`Idle — summarizing ${blocks.length} blocks...`);
        try { const entries = await memory.summarize(blocks); L.mem(`${entries.length} entries`); } catch {}
      }
    }, config.memory.idle_minutes * 60 * 1000);
  };

  // Input loop
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for await (const line of rl) {
    if (!line.trim()) continue;
    resetIdle();

    const block = context.addBlock("message", line.trim());
    const changes = context.applyMutations([]);
    const allChanges = [...changes];

    // Cascade: apply mutations until stable (max 3 rounds)
    for (let i = 0; i < 3; i++) {
      const mutations = await registry.pushChanges(allChanges);
      if (mutations.length === 0) break;
      L.inject(`round ${i + 1}: ${mutations.length} mutations`);
      const newChanges = context.applyMutations(mutations);
      if (newChanges.length === 0) break;
      allChanges.push(...newChanges);
    }
  }
  rl.close();

  if (idleTimer) clearTimeout(idleTimer);
}

run().catch((err) => { console.error("Fatal:", err); process.exit(1); });
