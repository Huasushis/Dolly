import { watch } from "chokidar";
import { resolve, dirname } from "path";
import type { ContextFrame } from "../core/context.js";
import type { EventBus } from "../core/bus.js";
import type { InjectionModule, InjectionEvent } from "./base.js";

interface RegisteredModule {
  module: InjectionModule;
  path: string;
}

export class InjectionRegistry {
  private modules: Map<string, RegisteredModule> = new Map();
  private watcher?: ReturnType<typeof watch>;
  private watcherActive = false;

  constructor(
    private bus: EventBus,
    modulePaths: string[]
  ) {
    for (const p of modulePaths) {
      this.load(p);
    }
  }

  async load(path: string): Promise<string | null> {
    try {
      const resolved = resolve(path);
      const mod = await import(resolved);
      const instance: InjectionModule = mod.default ?? mod;

      if (this.modules.has(instance.id)) {
        this.unload(instance.id);
      }

      instance.setup?.(this.bus);
      this.modules.set(instance.id, { module: instance, path: resolved });
      return instance.id;
    } catch (err) {
      console.error(`[InjectionRegistry] Failed to load ${path}:`, err);
      return null;
    }
  }

  unload(id: string): boolean {
    return this.modules.delete(id);
  }

  async reload(id: string): Promise<string | null> {
    const existing = this.modules.get(id);
    if (!existing) return null;

    // Bust import cache
    const cacheKey = resolve(existing.path);
    delete require.cache[require.resolve(cacheKey)];

    this.unload(id);
    return this.load(existing.path);
  }

  getPending(frames: ContextFrame[]): InjectionEvent[] {
    const pending: InjectionEvent[] = [];
    for (const { module } of this.modules.values()) {
      if (module.onContextChange) {
        const result = module.onContextChange(frames);
        if (result) pending.push(result);
      }
    }
    return pending.sort((a, b) => a.priority - b.priority);
  }

  handleEvent(eventName: string, payload: any): InjectionEvent[] {
    const pending: InjectionEvent[] = [];
    for (const { module } of this.modules.values()) {
      if (module.onEvent) {
        const result = module.onEvent(eventName as any, payload);
        if (result) pending.push(result);
      }
    }
    return pending.sort((a, b) => a.priority - b.priority);
  }

  getDefaultPrompt(): string {
    const prompts: string[] = [];
    for (const { module } of this.modules.values()) {
      if (module.defaultPrompt) {
        prompts.push(module.defaultPrompt());
      }
    }
    return prompts.join("\n\n");
  }

  listModules(): Array<{ id: string; path: string }> {
    return Array.from(this.modules.entries()).map(([id, reg]) => ({
      id,
      path: reg.path,
    }));
  }

  startWatcher(dirs: string[]): void {
    if (this.watcherActive) return;
    this.watcher = watch(dirs, { ignoreInitial: true });
    this.watcher.on("change", (filePath) => {
      for (const [id, reg] of this.modules) {
        if (filePath.startsWith(dirname(reg.path))) {
          this.reload(id);
          break;
        }
      }
    });
    this.watcherActive = true;
  }

  stopWatcher(): void {
    this.watcher?.close();
    this.watcherActive = false;
  }
}
