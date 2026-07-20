import { defineExtension } from "../../src/sdk/index.js";
import type { Module, ModuleContext, RawBlock, ExecuteInput } from "../../src/sdk/index.js";
import { join } from "path";

/** A single skill entry stored in memory and on disk. */
interface SkillEntry {
  name: string;
  description: string;
  body: string;
  updatedAt: number;
}

/** Shape of the persisted JSON file per skill. */
interface SkillFile {
  name: string;
  description: string;
  body: string;
  updatedAt: number;
}

/** Race a promise against a timeout (ms). */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); res(v); },
      (e) => { clearTimeout(timer); rej(e); },
    );
  });
}

export default defineExtension({
  name: "skill",
  version: "0.3.0",
  description: "Skill registry with persistent CRUD (passive query only)",
  createModule({ id, config }) {
    return new SkillModule(id, config);
  },
});

class SkillModule implements Module {
  id: string;
  private skills: Map<string, SkillEntry> = new Map();
  private syncIntervalMs: number;
  private fileTimeoutMs: number;
  private lastSync: number = 0;
  private storageDir: string = "";
  private ctx: ModuleContext | null = null;
  private fs: (typeof import("fs/promises")) | null = null;

  constructor(id: string, config: Record<string, any>) {
    this.id = id;
    this.syncIntervalMs = (config.sync_interval_ms as number | undefined) ?? 30_000;
    this.fileTimeoutMs = (config.file_timeout_ms as number | undefined) ?? 5_000;
  }

  async init(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    this.storageDir = join(ctx.storagePath, "skills");

    // Lazy-load fs/promises to avoid blocking startup
    this.fs = await import("fs/promises");

    // Ensure storage directory exists
    await withTimeout(
      this.fs.mkdir(this.storageDir, { recursive: true }),
      this.fileTimeoutMs,
      `mkdir(${this.storageDir})`,
    );

    await this.syncFromDisk();
  }

  async execute(_input: ExecuteInput): Promise<RawBlock | null> {
    // Periodic sync to pick up external file changes (hot-reload)
    if (Date.now() - this.lastSync > this.syncIntervalMs) {
      await this.syncFromDisk();
    }
    // Skill module is a passive registry — never intercepts user input
    return null;
  }

  getInputPremise(): string {
    return "";
  }

  getOutputPremise(): string {
    const count = this.skills.size;
    if (count === 0) {
      return "Skill module loaded. No skills registered.";
    }
    return `Skill module loaded (${count} skill(s) available). Query via listSkills() or getSkill(name).`;
  }

  async onStop(): Promise<void> {
    // no-op
  }

  // ---- Public CRUD API ----

  /** Register a new skill. Rejects if a skill with the same name already exists. */
  addSkill(name: string, description: string, body: string): Promise<void> {
    if (this.skills.has(name)) {
      return Promise.reject(new Error(`Skill "${name}" already exists. Use updateSkill() to modify it.`));
    }
    const entry: SkillEntry = { name, description, body, updatedAt: Date.now() };
    this.skills.set(name, entry);
    return this.persistSkill(entry);
  }

  /** Get a skill's full body content by name. Rejects if not found. */
  getSkill(name: string): Promise<string> {
    const entry = this.skills.get(name);
    if (!entry) {
      const available = Array.from(this.skills.keys()).join(", ") || "(none)";
      return Promise.reject(
        new Error(`Skill "${name}" not found. Available skills: ${available}`),
      );
    }
    return Promise.resolve(entry.body);
  }

  /** Update an existing skill. Rejects if the skill does not exist. */
  updateSkill(name: string, updates: { description?: string; body?: string }): Promise<void> {
    const entry = this.skills.get(name);
    if (!entry) {
      return Promise.reject(new Error(`Skill "${name}" not found. Cannot update.`));
    }
    if (updates.description !== undefined) entry.description = updates.description;
    if (updates.body !== undefined) entry.body = updates.body;
    entry.updatedAt = Date.now();
    return this.persistSkill(entry);
  }

  /** Delete a skill by name. Rejects if the skill does not exist. */
  deleteSkill(name: string): Promise<void> {
    if (!this.skills.has(name)) {
      return Promise.reject(new Error(`Skill "${name}" not found. Cannot delete.`));
    }
    this.skills.delete(name);
    return this.removeSkillFile(name);
  }

  /** List all registered skills (name + description). */
  listSkills(): Array<{ name: string; description: string }> {
    return Array.from(this.skills.values()).map(({ name, description }) => ({ name, description }));
  }

  // ---- Private: persistence ----

  private async persistSkill(entry: SkillEntry): Promise<void> {
    if (!this.fs) return;
    const filePath = join(this.storageDir, `${entry.name}.json`);
    const data: SkillFile = {
      name: entry.name,
      description: entry.description,
      body: entry.body,
      updatedAt: entry.updatedAt,
    };
    try {
      await withTimeout(
        this.fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8"),
        this.fileTimeoutMs,
        `writeFile(${filePath})`,
      );
    } catch (err) {
      this.ctx?.logger.warn({ filePath, err }, "Failed to persist skill");
    }
  }

  private async removeSkillFile(name: string): Promise<void> {
    if (!this.fs) return;
    const filePath = join(this.storageDir, `${name}.json`);
    try {
      await withTimeout(
        this.fs.unlink(filePath),
        this.fileTimeoutMs,
        `unlink(${filePath})`,
      );
    } catch {
      // File may not exist — ignore
    }
  }

  /** Load all .json skill files from disk into memory. */
  private async syncFromDisk(): Promise<void> {
    if (!this.fs) return;
    try {
      const files = await withTimeout(
        this.fs.readdir(this.storageDir),
        this.fileTimeoutMs,
        `readdir(${this.storageDir})`,
      );

      const seen = new Set<string>();
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const name = file.slice(0, -5); // strip .json
        seen.add(name);
        const filePath = join(this.storageDir, file);
        try {
          const raw = await withTimeout(
            this.fs.readFile(filePath, "utf-8"),
            this.fileTimeoutMs,
            `readFile(${filePath})`,
          );
          const data: SkillFile = JSON.parse(raw);
          this.skills.set(name, {
            name: data.name ?? name,
            description: data.description ?? "",
            body: data.body ?? "",
            updatedAt: data.updatedAt ?? 0,
          });
        } catch (err) {
          this.ctx?.logger.warn({ filePath, err }, "Failed to load skill from disk");
        }
      }

      // Remove in-memory skills whose files were deleted externally
      for (const name of this.skills.keys()) {
        if (!seen.has(name)) {
          this.skills.delete(name);
        }
      }
    } catch (err) {
      this.ctx?.logger.warn({ err }, "Failed to sync skills from disk");
    }

    this.lastSync = Date.now();
    this.ctx?.logger.info({ skillCount: this.skills.size }, "Skills synced from disk");
  }
}
