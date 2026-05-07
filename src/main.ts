import { createInterface } from "readline";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { loadConfig } from "./config.js";
import { EventBus } from "./core/bus.js";
import { ContextManager } from "./core/context.js";
import { LLMClient } from "./core/llm-client.js";
import { InjectionRegistry } from "./injection/registry.js";
import { MonitorRegistry } from "./monitor/registry.js";
import { ShortTermMemory } from "./memory/short-term.js";
import { LongTermMemory } from "./memory/long-term.js";
import { McpManager } from "./mcp/manager.js";
import skillModule from "./injection/modules/skill.js";
import type { InjectionEvent } from "./injection/base.js";
import type { ContextFrame } from "./core/context.js";

// ── Log helpers ──────────────────────────────────────────
const L = {
  inject:   (s: string) => process.stderr.write(`\x1b[35m  ◀ 注入\x1b[0m ${s}\n`),
  monitor:  (s: string) => process.stderr.write(`\x1b[36m  ▶ 监控\x1b[0m ${s}\n`),
  mcp:      (s: string) => process.stderr.write(`\x1b[33m  ⚡MCP\x1b[0m ${s}\n`),
  memory:   (s: string) => process.stderr.write(`\x1b[34m  ● 记忆\x1b[0m ${s}\n`),
  ctx:      (s: string) => process.stderr.write(`\x1b[2m  ◇ 上下文\x1b[0m ${s}\n`),
  tool:     (s: string) => process.stderr.write(`\x1b[32m  ◆ 工具\x1b[0m ${s}\n`),
  llm:      (s: string) => process.stderr.write(`\x1b[90m  → LLM\x1b[0m ${s}\n`),
  system:   (s: string) => process.stderr.write(`\x1b[90m  ~ ${s}\x1b[0m\n`),
};

class Dolly {
  private bus = new EventBus();
  private config = loadConfig();
  private context: ContextManager;
  private llm: LLMClient;
  private injections: InjectionRegistry;
  private monitors: MonitorRegistry;
  private shortTerm: ShortTermMemory;
  private longTerm: LongTermMemory;
  private mcp!: McpManager;
  private running = false;
  private dailyLog: ContextFrame[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly IDLE_MS = 60 * 60 * 1000;

  constructor() {
    this.context = new ContextManager(this.config.context, this.bus);
    this.llm = new LLMClient(this.config.main_llm, this.bus);
    this.injections = new InjectionRegistry(this.bus, this.config.injection_modules);
    this.monitors = new MonitorRegistry(this.bus, this.config.monitor_modules);
    this.shortTerm = new ShortTermMemory(this.bus);
    this.longTerm = new LongTermMemory(this.config.long_term_memory_path, this.config.memory_llm);

    const guardClient = new LLMClient(this.config.guard_llm);
    skillModule.setGuardClient(guardClient);
    this.mcp = new McpManager(this.bus);

    this.bus.on("injection.removed", (p) => {
      const removed = this.context.removeByInjectionId(p.injection_id);
      L.memory(`FORGET 移除 ${p.injection_id} (${removed} 帧)`);
    });

    this.bus.on("context.near_capacity", (p) => {
      L.ctx(`容量告警 ${(p.ratio * 100).toFixed(0)}% (${p.token_count} tokens)，触发压缩`);
      const injections = this.injections.handleEvent("context.near_capacity", p);
      for (const inj of injections) this.applyInjection(inj);
    });

    this.bus.on("tool.call_requested", (p) => {
      L.tool(`收到调用: ${p.tool_name}(${JSON.stringify(p.params).slice(0, 80)})`);
      this.handleToolCall(p.tool_name, p.params);
    });

    this.bus.on("tool.result", (p) => {
      L.tool(`结果: ${p.tool_name} → ${JSON.stringify(p.result).slice(0, 100)}`);
    });
  }

  async start(): Promise<void> {
    await this.injections.ready();
    await this.monitors.ready();

    L.system(`注入器: ${this.injections.listModules().map(m=>m.id).join(", ")}`);
    L.system(`监控器: ${this.monitors.listModules().map(m=>m.id).join(", ")}`);

    // Head
    const headContent = this.injections.collectHeadContent();
    for (const [id, content] of headContent) {
      this.context.setHead(id, content);
    }
    L.ctx(`Head 初始化: ${headContent.size} 条目, ${this.context.buildHeadPrompt().length} 字符`);

    const dirs = [...new Set(
      [...this.config.injection_modules, ...this.config.monitor_modules]
        .map((p) => p.replace(/[/\\][^/\\]+$/, ""))
    )];
    this.injections.startWatcher(dirs);
    this.monitors.startWatcher(dirs);

    // MCP servers from mcp.json
    try {
      const mcpConfigPath = resolve(import.meta.dirname!, "..", "mcp.json");
      if (existsSync(mcpConfigPath)) {
        const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
        for (const [name, cfg] of Object.entries(mcpConfig.servers || {}) as any) {
          try {
            const tools = await this.mcp.connect({ name, command: cfg.command, args: cfg.args, env: cfg.env });
            L.mcp(`${name}: ${tools.length} 工具`);
          } catch (e: any) {
            L.mcp(`${name}: ${e.message}`);
          }
        }
      }
    } catch {} // mcp.json optional

    const allTools = this.mcp.getTools();
    skillModule.setMcpTools(allTools.map((t) => ({ name: t.name, description: t.description })));

    L.system(`就绪。直接打字，Ctrl+C 退出。`);
    process.stderr.write("\n");

    this.running = true;
    this.resetIdleTimer();
    this.run();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.autoSummarize(), this.IDLE_MS);
  }

  private async autoSummarize(): Promise<void> {
    if (this.dailyLog.length === 0) return;
    L.memory(`空闲——自动总结 ${this.dailyLog.length} 条日志...`);
    try {
      this.longTerm.archiveDay(this.dailyLog);
      const entries = await this.longTerm.summarize(this.dailyLog);
      L.memory(`总结完成: ${entries.length} 条长期记忆`);
      this.dailyLog = [];
    } catch { L.memory(`总结失败`); }
  }

  private async run(): Promise<void> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for await (const line of rl) {
      if (!this.running) break;
      const text = line.trim();
      if (!text) continue;
      this.resetIdleTimer();
      process.stderr.write(`\n══════ ${new Date().toLocaleTimeString()} ══════\n`);
      await this.flow(text);
    }
    rl.close();
  }

  async flow(text: string): Promise<string> {
    // 1. User text → body
    L.llm(`收到文本 (${text.length} 字符)`);
    this.context.addFrame(text);

    // 2. Injection cascade: keep checking until no more injections
    let rounds = 0;
    while (rounds < 5) {
      const body = this.context.getBody();
      const pending = await this.injections.getPending(body);
      if (pending.length === 0) break;
      L.inject(`第 ${rounds + 1} 轮: ${pending.length} 个注入`);
      for (const inj of pending) {
        L.inject(`  ${inj.id} (P${inj.priority}): ${inj.content.slice(0, 60)}...`);
        this.applyInjection(inj);
      }
      rounds++;
    }

    // 3. Long-term memory
    const ltr = this.longTerm.injectRelevant(text, 2);
    if (ltr.length > 0) {
      L.memory(`长期记忆检索: ${ltr.length} 条匹配`);
      for (const inj of ltr) {
        this.context.addFrame(inj.content, { injection_id: inj.id });
        this.shortTerm.track({
          id: inj.id, content: inj.content, relevance_score: 0.5,
          created_at: Date.now() / 1000, last_accessed: Date.now() / 1000,
        });
      }
    }

    // 4. Build → LLM
    const messages = this.context.buildMessages();
    const tokens = this.context.estimateTokens();
    L.ctx(`${tokens.count} tokens (${(tokens.ratio*100).toFixed(0)}%), ${this.context.getBody().length} 帧`);
    L.llm(`调用 API...`);

    let fullResponse = "";
    let blocked = false;

    try {
      for await (const chunk of this.llm.chatStream(messages)) {
        fullResponse += chunk;

        const actions = this.monitors.processOutput(chunk, fullResponse);
        for (const action of actions) {
          if (action.action !== "pass") {
            L.monitor(`${action.action} ${action.injection_id || ""} ${action.payload?.slice(0, 50) || ""}`);
          }
          switch (action.action) {
            case "block": blocked = true; break;
            case "inject":
              if (action.payload) {
                this.applyInjection({
                  id: action.injection_id ?? `mon_${Date.now()}`,
                  content: action.payload, priority: 50,
                });
              }
              break;
            case "remove":
              if (action.injection_id) {
                this.context.removeByInjectionId(action.injection_id);
              }
              break;
          }
        }
        if (blocked) break;
      }
    } catch (err: any) {
      process.stderr.write(`\x1b[31m  ✕ LLM 错误: ${err.message}\x1b[0m\n`);
    }

    L.llm(`响应完成 (${fullResponse.length} 字符)`);

    // 5. Response → body
    this.context.addFrame(fullResponse);

    // 6. Archive
    this.dailyLog.push(
      { id: "", content: text, timestamp: Date.now() / 1000, pinned: false },
      { id: "", content: fullResponse, timestamp: Date.now() / 1000, pinned: false }
    );

    return fullResponse;
  }

  private applyInjection(inj: InjectionEvent): void {
    this.context.addFrame(
      `[注入:${inj.id}] ${inj.content}`,
      { injection_id: inj.id, pinned: inj.priority === 0 }
    );
    this.shortTerm.track({
      id: inj.id, content: inj.content,
      relevance_score: 1.0 - inj.priority / 200,
      created_at: Date.now() / 1000, last_accessed: Date.now() / 1000,
    });
  }

  private async handleToolCall(name: string, params: Record<string, unknown>): Promise<void> {
    let result: unknown;
    if (name.startsWith("mcp.")) {
      result = await this.mcp.callTool(name.slice(4), params);
    } else {
      switch (name) {
        case "datetime":
          result = { datetime: new Date().toISOString() };
          break;
        case "search_memory":
          result = this.longTerm.search((params.query as string) ?? "", 3);
          break;
        default:
          result = { error: `unknown tool: ${name}` };
      }
    }
    this.bus.emit("tool.result", { tool_name: name, result });
    this.applyInjection({
      id: `tool_${name}_${Date.now()}`,
      content: JSON.stringify(result),
      priority: 30,
    });
  }

  async shutdown(): Promise<void> {
    this.running = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.dailyLog.length > 0) {
      L.memory(`保存会话日志 (${this.dailyLog.length} 条)...`);
      this.longTerm.archiveDay(this.dailyLog);
      try { await this.longTerm.summarize(this.dailyLog); } catch {}
    }
    await this.mcp.disconnectAll();
    this.injections.stopWatcher();
    this.monitors.stopWatcher();
    L.system("关闭");
  }
}

const dolly = new Dolly();
dolly.start().catch((err) => console.error("Fatal:", err));

process.on("SIGINT", async () => { await dolly.shutdown(); process.exit(0); });
process.on("SIGTERM", async () => { await dolly.shutdown(); process.exit(0); });
