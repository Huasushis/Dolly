import { resolve } from "path";
import { existsSync, readFileSync, readdirSync } from "fs";
import { pathToFileURL } from "url";
import type { DollyModule, ModuleContext } from "./base.js";
import type { BlockChange, BlockMutation } from "../blocks/index.js";
import type { ContextManager } from "../core/context.js";
import type { EventBus } from "../core/bus.js";

export class ModuleRegistry {
  private modules = new Map<string, DollyModule>();
  private instances = new Set<string>();

  constructor(
    private ctx: ModuleContext,
    private bus: EventBus,
    private extensionsDir: string,
  ) {}

  /** Load modules from dolly.json enabled list */
  async loadFromConfig(enabled: string[]): Promise<void> {
    for (const path of enabled) {
      await this.load(resolve(this.extensionsDir, path));
    }
  }

  /** Load a single module directory */
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
      if (instance.init) await instance.init(this.ctx);
    } catch (err) {
      console.error(`[ModuleRegistry] Failed to load ${dir}:`, err);
    }
  }

  /** Collect system prompt from all modules */
  buildSystemPrompt(): string {
    const parts: string[] = [];
    for (const mod of this.modules.values()) {
      if (mod.systemPrompt) {
        const p = mod.systemPrompt(this.ctx);
        if (p) parts.push(p);
      }
    }
    return parts.join("\n\n");
  }

  /** Push block changes to all modules, collect mutations */
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

  list(): string[] {
    return Array.from(this.modules.keys());
  }

  /** Hot-reload a module */
  async reload(id: string): Promise<void> {
    this.modules.delete(id);
    for (const dir of this.instances) {
      if (dir.endsWith(id) || dir.includes(`/${id}`)) {
        this.instances.delete(dir);
        await this.load(dir);
        break;
      }
    }
  }
}
