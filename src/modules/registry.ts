import { resolve } from "path";
import { existsSync } from "fs";
import { pathToFileURL } from "url";
import type { DollyModule, ModuleContext } from "./base.js";
import type { BlockChange, BlockMutation } from "../blocks/index.js";
import type { EventBus } from "../core/bus.js";

export class ModuleRegistry {
  private modules = new Map<string, DollyModule>();
  private instances = new Set<string>();
  private promptFragments = new Map<string, string>();
  private enabledList: string[] = [];
  private available: string[] = []; // all found in extensions/

  constructor(
    private ctx: ModuleContext,
    private bus: EventBus,
    private extensionsDir: string,
  ) {
    ctx.setSystemPrompt = (text: string) => {
      const lastId = this._lastLoadedId;
      if (lastId) this.promptFragments.set(lastId, text);
    };
  }

  private _lastLoadedId = "";

  /** Scan extensions dir for available modules */
  async discover(): Promise<string[]> {
    const { readdirSync, existsSync } = await import("fs");
    const dir = this.extensionsDir;
    if (!existsSync(dir)) return [];
    this.available = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    return this.available;
  }

  async loadFromConfig(enabled: string[]): Promise<void> {
    this.enabledList = enabled;
    for (const path of enabled) {
      await this.load(resolve(this.extensionsDir, path));
    }
  }

  isEnabled(id: string): boolean { return this.enabledList.includes(id); }

  async enable(id: string): Promise<void> {
    if (this.enabledList.includes(id)) return;
    this.enabledList.push(id);
    await this.load(resolve(this.extensionsDir, id));
  }

  disable(id: string): void {
    this.enabledList = this.enabledList.filter((e) => e !== id);
    this.unload(id);
  }

  listAll(): Array<{ id: string; enabled: boolean; loaded: boolean }> {
    return this.available.map((id) => ({
      id, enabled: this.enabledList.includes(id), loaded: this.modules.has(id),
    }));
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
