import { watch } from "chokidar";
import { resolve, dirname } from "path";
import { pathToFileURL } from "url";
import type { EventBus } from "../core/bus.js";
import type { MonitorModule, MonitorAction } from "./base.js";

interface RegisteredModule {
  module: MonitorModule;
  path: string;
}

export class MonitorRegistry {
  private modules: Map<string, RegisteredModule> = new Map();
  private watcher?: ReturnType<typeof watch>;

  private initPromise: Promise<void>;

  constructor(
    private bus: EventBus,
    modulePaths: string[]
  ) {
    this.initPromise = Promise.all(modulePaths.map((p) => this.load(p))).then(() => {});
  }

  async ready(): Promise<void> {
    await this.initPromise;
  }

  async load(path: string): Promise<string | null> {
    try {
      const resolved = resolve(path);
      const mod = await import(pathToFileURL(resolved).href);
      const instance: MonitorModule = mod.default ?? mod;

      if (this.modules.has(instance.id)) {
        this.unload(instance.id);
      }

      instance.setup?.(this.bus);
      this.modules.set(instance.id, { module: instance, path: resolved });
      return instance.id;
    } catch (err) {
      console.error(`[MonitorRegistry] Failed to load ${path}:`, err);
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

  processOutput(chunk: string, fullResponse: string): MonitorAction[] {
    const actions: MonitorAction[] = [];
    for (const { module } of this.modules.values()) {
      if (module.onOutput) {
        const result = module.onOutput(chunk, fullResponse);
        if (result) {
          actions.push(result);
          if (module.blocking && result.action === "block") {
            break;
          }
        }
      }
    }
    return actions;
  }

  hasBlocking(): boolean {
    for (const { module } of this.modules.values()) {
      if (module.blocking) return true;
    }
    return false;
  }

  listModules(): Array<{ id: string; path: string }> {
    return Array.from(this.modules.entries()).map(([id, reg]) => ({
      id,
      path: reg.path,
    }));
  }

  startWatcher(dirs: string[]): void {
    this.watcher = watch(dirs, { ignoreInitial: true });
    this.watcher.on("change", (filePath) => {
      for (const [id, reg] of this.modules) {
        if (filePath.startsWith(dirname(reg.path))) {
          this.reload(id);
          break;
        }
      }
    });
  }

  stopWatcher(): void {
    this.watcher?.close();
  }
}
