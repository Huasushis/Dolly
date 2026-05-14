import { resolve } from "path";
import { existsSync } from "fs";
import { pathToFileURL } from "url";
import type { DollyModule, ModuleContext } from "./base.js";
import type { BlockChange, BlockMutation } from "../blocks/index.js";
import type { EventBus } from "../core/bus.js";

export class ModuleRegistry {
  private modules = new Map<string, DollyModule>();
  private instances = new Set<string>();
  private promptFragments = new Map<string, string>(); // moduleId → prompt fragment

  constructor(
    private ctx: ModuleContext,
    private bus: EventBus,
    private extensionsDir: string,
  ) {
    // Give ctx a per-module setSystemPrompt
    ctx.setSystemPrompt = (text: string) => {
      // Called from within init() — we track by last-loaded module
      const lastId = this._lastLoadedId;
      if (lastId) {
        this.promptFragments.set(lastId, text);
      }
    };
  }

  private _lastLoadedId = "";

  async loadFromConfig(enabled: string[]): Promise<void> {
    for (const path of enabled) {
      await this.load(resolve(this.extensionsDir, path));
    }
  }

  async load(dir: string): Promise<void> {
    if (this.instances.has(dir)) return;
    if (!existsSync(dir)) return;

    const mainFile = resolve(dir, "index.ts");
    if (!existsSync(mainFile)) return;

    try {
      const mod = await import(pathToFileURL(mainFile).href);
      const instance: DollyModule = mod.default ?? mod;
      this.modules.set(instance.id, instance);
      this.instances.add(dir);
      if (!this.ctx._storageSet) {
        this.ctx.storagePath = resolve(dir, "data");
      }
      // Load static systemPrompt if the module has one
      if (instance.systemPrompt) {
        const sp = instance.systemPrompt(this.ctx);
        if (sp) this.promptFragments.set(instance.id, sp);
      }
      this._lastLoadedId = instance.id;
      if (instance.init) await instance.init(this.ctx);
      this._lastLoadedId = "";
    } catch (err) {
      console.error(`[ModuleRegistry] Failed to load ${dir}:`, err);
    }
  }

  unload(id: string): void {
    this.modules.delete(id);
    this.promptFragments.delete(id);
    for (const dir of this.instances) {
      if (dir.endsWith(`/${id}`) || dir.endsWith(`\\${id}`)) {
        this.instances.delete(dir);
        break;
      }
    }
  }

  async reload(id: string): Promise<void> {
    const dir = [...this.instances].find((d) => d.endsWith(`/${id}`) || d.endsWith(`\\${id}`));
    this.unload(id);
    if (dir) await this.load(dir);
  }

  async reloadAll(): Promise<void> {
    const ids = [...this.modules.keys()];
    for (const id of ids) await this.reload(id);
  }

  enable(id: string): void {
    const dir = resolve(this.extensionsDir, id);
    this.load(dir);
  }

  buildSystemPrompt(): string {
    return [...this.promptFragments.values()].filter(Boolean).join("\n\n");
  }

  async pushChanges(changes: BlockChange[]): Promise<BlockMutation[]> {
    const allMutations: BlockMutation[] = [];
    for (const mod of this.modules.values()) {
      if (mod.onBlocksChanged) {
        try {
          const m = await mod.onBlocksChanged(this.ctx, changes);
          allMutations.push(...m);
        } catch (err) {
          console.error(`[ModuleRegistry] ${mod.id} onBlocksChanged error:`, err);
        }
      }
    }
    return allMutations;
  }

  list(): string[] { return Array.from(this.modules.keys()); }
  has(id: string): boolean { return this.modules.has(id); }
}
