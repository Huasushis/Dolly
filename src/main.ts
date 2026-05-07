import { createInterface } from "readline";
import { loadConfig } from "./config.js";
import { EventBus } from "./core/bus.js";
import { ContextManager } from "./core/context.js";
import { LLMClient } from "./core/llm-client.js";
import { InjectionRegistry } from "./injection/registry.js";
import { MonitorRegistry } from "./monitor/registry.js";
import { ShortTermMemory } from "./memory/short-term.js";
import { LongTermMemory } from "./memory/long-term.js";
import skillModule from "./injection/modules/skill.js";
import type { InjectionEvent } from "./injection/base.js";
import type { ContextFrame } from "./core/context.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

class Dolly {
  private bus = new EventBus();
  private config = loadConfig();
  private context: ContextManager;
  private llm: LLMClient;
  private injections: InjectionRegistry;
  private monitors: MonitorRegistry;
  private shortTerm: ShortTermMemory;
  private longTerm: LongTermMemory;
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

    // Inject guard LLM into skill module for trigger detection
    const guardClient = new LLMClient(this.config.guard_llm);
    skillModule.setGuardClient(guardClient);

    this.bus.on("injection.removed", (p) => {
      this.context.removeByInjectionId(p.injection_id);
    });

    this.bus.on("context.near_capacity", (p) => {
      const injections = this.injections.handleEvent("context.near_capacity", p);
      for (const inj of injections) this.applyInjection(inj);
    });

    this.bus.on("tool.call_requested", (p) => {
      this.handleToolCall(p.tool_name, p.params);
    });
  }

  async start(): Promise<void> {
    // Initialize head from all injection modules' headContent()
    const headContent = this.injections.collectHeadContent();
    for (const [injectorId, content] of headContent) {
      this.context.setHead(injectorId, content);
    }

    const dirs = [...new Set(
      [...this.config.injection_modules, ...this.config.monitor_modules]
        .map((p) => p.replace(/[/\\][^/\\]+$/, ""))
    )];
    this.injections.startWatcher(dirs);
    this.monitors.startWatcher(dirs);

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
    try {
      this.longTerm.archiveDay(this.dailyLog);
      const entries = await this.longTerm.summarize(this.dailyLog);
      this.dailyLog = [];
    } catch {}
  }

  private async run(): Promise<void> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for await (const line of rl) {
      if (!this.running) break;
      const text = line.trim();
      if (!text) continue;
      this.resetIdleTimer();
      await this.flow(text);
    }
    rl.close();
  }

  /** Text enters the context. No command. No role. Just flow. */
  async flow(text: string): Promise<string> {
    // Text enters the body
    this.context.addFrame(text);

    // Injection modules react to context change (may be async for guard_llm checks)
    const body = this.context.getBody();
    const pending = await this.injections.getPending(body);
    for (const inj of pending) this.applyInjection(inj);

    // Long-term memory retrieval → body injection
    const ltr = this.longTerm.injectRelevant(text, 2);
    for (const inj of ltr) {
      const id = this.context.addFrame(inj.content, { injection_id: inj.id });
      this.shortTerm.track({
        id: inj.id, content: inj.content, relevance_score: 0.5,
        created_at: Date.now() / 1000, last_accessed: Date.now() / 1000,
      });
    }

    // Build messages → LLM stream
    const messages = this.context.buildMessages();
    let fullResponse = "";
    let blocked = false;

    try {
      for await (const chunk of this.llm.chatStream(messages)) {
        fullResponse += chunk;
        // Monitors process each output chunk
        const actions = this.monitors.processOutput(chunk, fullResponse);
        for (const action of actions) {
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
      process.stderr.write(`\n${dim(err.message)}\n`);
    }

    // Response flows back into body
    this.context.addFrame(fullResponse);

    // Archive to daily log
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
      this.longTerm.archiveDay(this.dailyLog);
      try { await this.longTerm.summarize(this.dailyLog); } catch {}
    }
    this.injections.stopWatcher();
    this.monitors.stopWatcher();
  }
}

const dolly = new Dolly();
dolly.start().catch((err) => console.error("Fatal:", err));

process.on("SIGINT", async () => { await dolly.shutdown(); process.exit(0); });
process.on("SIGTERM", async () => { await dolly.shutdown(); process.exit(0); });
