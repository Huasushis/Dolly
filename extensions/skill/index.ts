import {
  defineExtension,
  type ExecuteInput,
  type Module,
  type ModuleContext,
  type RawBlock,
} from "../../src/core/legacy-in-process-extension.js";
import { join, resolve } from "path";
import { watch, type FSWatcher } from "chokidar";

/** A single skill entry loaded from SKILL.md. */
interface SkillEntry {
  name: string;
  description: string;
  body: string;
  filePath: string;
}

/**
 * Parse a SKILL.md file content.
 * Expected format:
 * ---
 * name: xxx
 * description: xxx
 * ---
 * <markdown body>
 */
function parseSkillMd(content: string, filePath: string): SkillEntry | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = match[2].trim();

  let name = "";
  let description = "";
  for (const line of frontmatter.split(/\r?\n/)) {
    const kv = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (kv) {
      const key = kv[1].toLowerCase();
      if (key === "name") name = kv[2].trim();
      else if (key === "description") description = kv[2].trim();
    }
  }

  if (!name) return null;
  return { name, description, body, filePath };
}

export default defineExtension({
  name: "skill",
  version: "0.4.0",
  description: "Skill registry: reads SKILL.md files, passive query only",
  createModule({ id, config }) {
    return new SkillModule(id, config);
  },
});

class SkillModule implements Module {
  id: string;
  private skills: Map<string, SkillEntry> = new Map();
  private skillsDir: string = "";
  private ctx: ModuleContext | null = null;
  private fs: (typeof import("fs/promises")) | null = null;
  private watcher: FSWatcher | null = null;
  private lifecycle: "new" | "initializing" | "running" | "stopping" | "stopped" = "new";
  private syncChain: Promise<void> = Promise.resolve();

  constructor(id: string, config: Record<string, any>) {
    this.id = id;
    this.skillsDir = (config.skillsDir as string | undefined) ?? "";
  }

  async init(ctx: ModuleContext): Promise<void> {
    if (this.lifecycle !== "new") {
      throw new Error(`Skill module cannot initialize from state ${this.lifecycle}`);
    }
    this.lifecycle = "initializing";
    this.ctx = ctx;
    if (!this.skillsDir) {
      this.skillsDir = join(ctx.storagePath, "skills");
    }
    this.skillsDir = resolve(this.skillsDir);

    this.fs = await import("fs/promises");
    await this.fs.mkdir(this.skillsDir, { recursive: true });

    try {
      await this.syncFromDisk();
      await this.startWatcher();
      this.lifecycle = "running";
    } catch (error) {
      await this.watcher?.close();
      this.watcher = null;
      this.lifecycle = "stopped";
      throw error;
    }
  }

  async execute(_input: ExecuteInput): Promise<RawBlock | null> {
    return null;
  }

  getInputPremise(): string {
    return "";
  }

  getOutputPremise(): string {
    if (this.skills.size === 0) {
      return "Skill module loaded. No skills registered.";
    }
    const entries = Array.from(this.skills.values())
      .map((s) => `${s.name}(${s.description})`)
      .join(", ");
    return `可用技能: ${entries}`;
  }

  async onStop(): Promise<void> {
    if (this.lifecycle === "stopped") return;
    this.lifecycle = "stopping";
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    await this.syncChain;
    this.ctx = null;
    this.lifecycle = "stopped";
  }

  // ---- Public query API ----

  getSkill(name: string): Promise<string> {
    const entry = this.skills.get(name);
    if (!entry) {
      const available = Array.from(this.skills.keys()).join(", ") || "(none)";
      return Promise.reject(
        new Error(`Skill "${name}" not found. Available: ${available}`),
      );
    }
    return Promise.resolve(entry.body);
  }

  listSkills(): Array<{ name: string; description: string; filePath: string }> {
    return Array.from(this.skills.values()).map(({ name, description, filePath }) => ({
      name,
      description,
      filePath,
    }));
  }

  async refresh(): Promise<void> {
    if (this.lifecycle !== "running") {
      throw new Error(`Skill module cannot refresh from state ${this.lifecycle}`);
    }
    await this.queueSync();
  }

  // ---- Private ----

  private async startWatcher(): Promise<void> {
    this.watcher = watch(this.skillsDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 1,
    });

    const resync = () => void this.queueSync();

    this.watcher.on("add", resync);
    this.watcher.on("change", resync);
    this.watcher.on("unlink", resync);
    this.watcher.on("addDir", resync);
    this.watcher.on("unlinkDir", resync);
    this.watcher.on("error", (err) => {
      this.ctx?.logger.warn({ err }, "Skill watcher failed");
    });

    await new Promise<void>((resolveReady, rejectReady) => {
      const watcher = this.watcher!;
      const onReady = () => {
        watcher.off("error", onInitialError);
        resolveReady();
      };
      const onInitialError = (error: unknown) => {
        watcher.off("ready", onReady);
        rejectReady(error);
      };
      watcher.once("ready", onReady);
      watcher.once("error", onInitialError);
    });
  }

  private queueSync(): Promise<void> {
    if (this.lifecycle === "stopping" || this.lifecycle === "stopped") {
      return Promise.resolve();
    }
    const next = this.syncChain.then(() => this.syncFromDisk());
    this.syncChain = next.catch((err) => {
      this.ctx?.logger.warn({ err }, "Skill watcher resync failed");
    });
    return next;
  }

  /** Scan skillsDir for SKILL.md files (in subdirectories) and load them. */
  private async syncFromDisk(): Promise<void> {
    if (!this.fs) return;
    try {
      const entries = await this.fs.readdir(this.skillsDir, { withFileTypes: true });
      const seen = new Set<string>();

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMdPath = join(this.skillsDir, entry.name, "SKILL.md");
        try {
          const content = await this.fs.readFile(skillMdPath, "utf-8");
          const parsed = parseSkillMd(content, skillMdPath);
          if (parsed) {
            seen.add(parsed.name);
            this.skills.set(parsed.name, parsed);
          }
        } catch {
          // SKILL.md not found in this subdirectory — skip
        }
      }

      // Remove skills whose directories/files were deleted
      for (const name of this.skills.keys()) {
        if (!seen.has(name)) {
          this.skills.delete(name);
        }
      }
    } catch (err) {
      this.ctx?.logger.warn({ err }, "Failed to sync skills from disk");
    }

    this.ctx?.logger.info({ skillCount: this.skills.size }, "Skills synced from disk");
  }
}
