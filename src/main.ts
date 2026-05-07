import { createInterface } from "readline";
import { loadConfig } from "./config.js";
import { EventBus } from "./core/bus.js";
import { ContextManager } from "./core/context.js";
import { LLMClient } from "./core/llm-client.js";
import { InjectionRegistry } from "./injection/registry.js";
import { MonitorRegistry } from "./monitor/registry.js";
import { ShortTermMemory } from "./memory/short-term.js";
import { LongTermMemory } from "./memory/long-term.js";
import type { InjectionEvent } from "./injection/base.js";
import type { ContextFrame } from "./core/context.js";

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

  constructor() {
    this.context = new ContextManager(this.config.context, this.bus);
    this.llm = new LLMClient(this.config.main_llm, this.bus);
    this.injections = new InjectionRegistry(this.bus, this.config.injection_modules);
    this.monitors = new MonitorRegistry(this.bus, this.config.monitor_modules);
    this.shortTerm = new ShortTermMemory(this.bus);
    this.longTerm = new LongTermMemory(
      this.config.long_term_memory_path,
      this.config.aux_llm
    );

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Handle tool calls from monitor
    this.bus.on("tool.call_requested", (payload) => {
      this.handleToolCall(payload.tool_name, payload.params);
    });

    // Handle compression from context manager
    this.bus.on("context.near_capacity", (_payload) => {
      const injections = this.injections.handleEvent("context.near_capacity", _payload);
      for (const inj of injections) {
        this.applyInjection(inj);
      }
    });

    // Handle injection removals
    this.bus.on("injection.removed", (payload) => {
      this.context.removeByInjectionId(payload.injection_id);
    });

    // Archive daily log on shutdown
    this.bus.on("system.shutdown", () => {
      this.archiveDailyLog();
    });
  }

  async start(): Promise<void> {
    // Build background prompt from all injection modules' defaultPrompt
    let backgroundPrompt = this.injections.getDefaultPrompt();
    this.context.setBackgroundPrompt(backgroundPrompt);

    // Load long-term memory relevant to current session
    const ltrInjections = this.longTerm.injectRelevant("current session context");
    for (const inj of ltrInjections) {
      this.context.addFrame({
        role: "injection",
        content: inj.content,
        injection_id: inj.id,
        pinned: false,
      });
    }

    // Start hot-reload watchers
    const moduleDirs = [...new Set(
      [...this.config.injection_modules, ...this.config.monitor_modules]
        .map((p) => p.replace(/[/\\][^/\\]+$/, ""))
    )];
    this.injections.startWatcher(moduleDirs);
    this.monitors.startWatcher(moduleDirs);

    this.running = true;
    console.log("Dolly agent started. Type /quit to exit, /summarize to archive memory.\n");

    await this.repl();
  }

  private async repl(): Promise<void> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "> ",
    });

    rl.prompt();

    for await (const line of rl) {
      if (!this.running) break;

      const input = line.trim();
      if (!input) {
        rl.prompt();
        continue;
      }

      // Built-in commands
      if (input === "/quit") {
        await this.shutdown();
        break;
      }

      if (input === "/summarize") {
        await this.archiveAndSummarize();
        rl.prompt();
        continue;
      }

      if (input === "/modules") {
        this.printModules();
        rl.prompt();
        continue;
      }

      if (input === "/memory") {
        this.printMemory();
        rl.prompt();
        continue;
      }

      await this.processInput(input);
      rl.prompt();
    }

    rl.close();
  }

  async processInput(userInput: string): Promise<string> {
    // 1. Add user input to context
    this.context.addFrame({
      role: "user",
      content: userInput,
      pinned: false,
    });

    // 2. Collect pending injections
    const frames = this.context.getFrames();
    const pending = this.injections.getPending(frames);

    // 3. Apply injections to context
    for (const inj of pending) {
      this.applyInjection(inj);
    }

    // 4. Search long-term memory for relevant context
    const ltrResults = this.longTerm.injectRelevant(userInput, 2);
    for (const inj of ltrResults) {
      this.context.addFrame({
        role: "injection",
        content: inj.content,
        injection_id: inj.id,
        pinned: false,
      });
      this.shortTerm.track({
        id: inj.id,
        content: inj.content,
        relevance_score: 0.5,
        created_at: Date.now() / 1000,
        last_accessed: Date.now() / 1000,
      });
    }

    // 5. Build messages and stream LLM response
    const messages = this.context.buildMessages();

    process.stdout.write("\n");

    let fullResponse = "";
    let blocked = false;
    let blockedText = "";

    try {
      for await (const chunk of this.llm.chatStream(messages)) {
        fullResponse += chunk;

        // Run monitors on the chunk
        const actions = this.monitors.processOutput(chunk, fullResponse);

        for (const action of actions) {
          switch (action.action) {
            case "block":
              blocked = true;
              if (action.payload) blockedText = action.payload;
              break;
            case "inject":
              if (action.payload) {
                const injEvent: InjectionEvent = {
                  id: action.injection_id ?? `mon_${Date.now()}`,
                  content: action.payload,
                  target: "working",
                  priority: 50,
                };
                this.applyInjection(injEvent);
              }
              break;
            case "remove":
              if (action.injection_id) {
                this.context.removeByInjectionId(action.injection_id);
              }
              break;
            case "pass":
            default:
              break;
          }
        }

        // If any monitor is blocking, pause processing
        if (blocked) break;
      }
    } catch (err) {
      console.error("\n[LLM Error]", err);
    }

    process.stdout.write("\n");

    // 6. Add assistant response to context
    const displayResponse = blocked ? blockedText : fullResponse;
    this.context.addFrame({
      role: "assistant",
      content: fullResponse, // Store full response regardless
      pinned: false,
    });

    // 7. If blocked, wait for tool result then re-run
    if (blocked) {
      process.stdout.write(`[工具调用执行中...]\n`);
    }

    // 8. Log to daily archive
    this.dailyLog.push(
      { role: "user", content: userInput, id: "", timestamp: Date.now() / 1000, distance_from_end: 0, pinned: false },
      { role: "assistant", content: fullResponse, id: "", timestamp: Date.now() / 1000, distance_from_end: 0, pinned: false }
    );

    return fullResponse;
  }

  private applyInjection(inj: InjectionEvent): void {
    if (inj.target === "background") {
      // Append to background prompt (modifies frame[0])
      const frames = this.context.getFrames();
      if (frames.length > 0 && frames[0].role === "system") {
        frames[0].content += `\n\n${inj.content}`;
      }
    } else {
      this.context.addFrame({
        role: "injection",
        content: `[INJECTION:id:${inj.id}] ${inj.content}`,
        injection_id: inj.id,
        pinned: inj.priority === 0, // Priority 0 = system-level, pinned
      });
    }

    // Track in short-term memory
    this.shortTerm.track({
      id: inj.id,
      content: inj.content,
      relevance_score: 1.0 - inj.priority / 200,
      created_at: Date.now() / 1000,
      last_accessed: Date.now() / 1000,
    });
  }

  private async handleToolCall(
    toolName: string,
    params: Record<string, unknown>
  ): Promise<void> {
    // Basic tool dispatch — extensible via external tool definitions
    let result: unknown;

    switch (toolName) {
      case "echo":
        result = params;
        break;
      case "datetime":
        result = { datetime: new Date().toISOString() };
        break;
      case "search_memory":
        result = this.longTerm.search(
          (params.query as string) ?? ""
        );
        break;
      default:
        result = { error: `Unknown tool: ${toolName}` };
    }

    // Inject tool result
    const resultInjection: InjectionEvent = {
      id: `tool_${toolName}_${Date.now()}`,
      content: `[TOOL_RESULT:${toolName}] ${JSON.stringify(result, null, 2)}`,
      target: "working",
      priority: 30,
    };
    this.applyInjection(resultInjection);
    this.bus.emit("tool.result", { tool_name: toolName, result });
  }

  private async archiveDailyLog(): Promise<void> {
    if (this.dailyLog.length === 0) return;

    this.longTerm.archiveDay(this.dailyLog);
    console.log(`[Memory] Archived ${this.dailyLog.length} frames to daily log.`);

    // Summarize asynchronously
    try {
      const entries = await this.longTerm.summarize(this.dailyLog);
      console.log(`[Memory] Summarized into ${entries.length} long-term entries.`);
    } catch {
      console.log("[Memory] Summarization skipped (API may not be available).");
    }
  }

  private async archiveAndSummarize(): Promise<void> {
    await this.archiveDailyLog();
    this.dailyLog = [];
  }

  private printModules(): void {
    console.log("\n=== Injection Modules ===");
    for (const m of this.injections.listModules()) {
      console.log(`  ${m.id} → ${m.path}`);
    }
    console.log("\n=== Monitor Modules ===");
    for (const m of this.monitors.listModules()) {
      console.log(`  ${m.id} → ${m.path}`);
    }
    console.log();
  }

  private printMemory(): void {
    const active = this.shortTerm.getActive();
    console.log(`\n=== Short-term Memory (${active.length} active) ===`);
    for (const e of active) {
      console.log(`  [${e.id}] score=${e.relevance_score.toFixed(2)}: ${e.content.slice(0, 80)}...`);
    }
    console.log();
  }

  async shutdown(): Promise<void> {
    this.running = false;
    this.bus.emit("system.shutdown", {});
    this.injections.stopWatcher();
    this.monitors.stopWatcher();
    console.log("Dolly shut down.");
  }
}

// Entry point
const dolly = new Dolly();
dolly.start().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
