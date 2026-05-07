import { watch } from "chokidar";
import { resolve, dirname } from "path";
import { pathToFileURL } from "url";
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

  private initPromise: Promise<void>;

  constructor(
    private bus: EventBus,
    modulePaths: string[]
  ) {
    this.initPromise = Promise.all(modulePaths.map((p) => this.load(p))).then(() => {});
  }

  /** Wait for all initial modules to finish loading */
  async ready(): Promise<void> {
    await this.initPromise;
  }

  async load(path: string): Promise<string | null> {
    try {
      const resolved = resolve(path);
      const mod = await import(pathToFileURL(resolved).href);
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
    this.unload(id);
    return this.load(existing.path);
  }

  async getPending(frames: ContextFrame[]): Promise<InjectionEvent[]> {
    const pending: InjectionEvent[] = [];
    for (const { module } of this.modules.values()) {
      if (module.onContextChange) {
        const result = await module.onContextChange(frames);
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

  /** Collect initial head content from all modules */
  collectHeadContent(): Map<string, string> {
    const head = new Map<string, string>();
    for (const { module } of this.modules.values()) {
      if (module.headContent) {
        const content = module.headContent();
        if (content.trim()) head.set(module.id, content);
      }
    }
    return head;
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
