import { resolve } from "path";
import { existsSync, readFileSync, readdirSync } from "fs";
import { pathToFileURL } from "url";
import type { DollyModule, ModuleContext } from "./base.js";
import type { BlockChange, BlockMutation } from "../blocks/index.js";
import type { ContextManager } from "../core/context.js";
import type { EventBus } from "../core/bus.js";

export class ModuleRegistry {
  private modules = new Map<string, DollyModule>();
  private instances = new Set<string>(); // loaded module dirs
  private heartbeats = new Map<string, NodeJS.Timeout>();

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
      if (instance.heartbeatInterval && instance.heartbeatInterval > 0) {
        const timer = setInterval(
          () => this.runHeartbeat(instance),
          instance.heartbeatInterval! * 1000
        );
        this.heartbeats.set(instance.id, timer);
      }
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

  private async runHeartbeat(mod: DollyModule): Promise<void> {
    if (!mod.onHeartbeat) return;
    try {
      const m = await mod.onHeartbeat(this.ctx);
      if (m.length > 0) {
        // Heartbeat mutations go through the context
        this.ctx.getBlocks(); // ensure context access
      }
    } catch (err) {
      console.error(`[ModuleRegistry] ${mod.id} heartbeat error:`, err);
    }
  }

  list(): string[] {
    return Array.from(this.modules.keys());
  }

  /** Hot-reload a module */
  async reload(id: string): Promise<void> {
    const mod = this.modules.get(id);
    if (!mod) return;
    if (this.heartbeats.has(id)) {
      clearInterval(this.heartbeats.get(id)!);
      this.heartbeats.delete(id);
    }
    this.modules.delete(id);
    // Find and reload from extensions dir
    for (const dir of this.instances) {
      if (dir.endsWith(id) || dir.includes(`/${id}`)) {
        this.instances.delete(dir);
        await this.load(dir);
        break;
      }
    }
  }
}
