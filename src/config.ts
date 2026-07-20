import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { z } from "zod";
import type { DollyConfig, ModuleConfig, ScheduleConfig } from "./core/types.js";

// ── Zod Schemas ──────────────────────────────────────────────────

const LLMProviderSchema = z.object({
  base_url: z.string(),
  api_key: z.string(),
  model: z.string(),
});

const ScheduleSchema = z.object({
  initialIntervalMs: z.number().optional(),
  minIntervalMs: z.number().optional(),
  maxIntervalMs: z.number().optional(),
});

const ModuleSchema = z.object({
  id: z.string(),
  extension: z.string(),
  inputPages: z.array(z.string()),
  outputPages: z.array(z.string()),
  schedule: ScheduleSchema.optional(),
  config: z.record(z.any()).optional(),
});

const ConfigSchema = z.object({
  name: z.string().default("default"),
  dataDir: z.string().default(".dolly/profiles/default"),
  llm: z.record(LLMProviderSchema).default({}),
  pages: z.array(z.object({ id: z.string() })).default([]),
  modules: z.array(ModuleSchema).default([]),
  logging: z.object({ level: z.string().default("info") }).default({}),
});

// ── Defaults ─────────────────────────────────────────────────────

const DEFAULT_SCHEDULE: ScheduleConfig = {
  initialIntervalMs: 2000,
  minIntervalMs: 500,
  maxIntervalMs: 60000,
};

// ── Env var replacement ─────────────────────────────────────────

function replaceEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$(\w+)/g, (_, name) => process.env[name] ?? "");
  }
  if (Array.isArray(obj)) return obj.map(replaceEnvVars);
  if (obj !== null && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, replaceEnvVars(v)])
    );
  }
  return obj;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Load and validate a Dolly config file.
 * @param configPath  Path to JSON config (default: ./dolly.json)
 */
export function loadConfig(configPath?: string): DollyConfig {
  const path = resolve(configPath ?? "dolly.json");
  if (!existsSync(path)) throw new Error(`Config not found: ${path}`);

  const raw = JSON.parse(readFileSync(path, "utf-8"));
  const withEnv = replaceEnvVars(raw);
  const parsed = ConfigSchema.parse(withEnv);

  // Fill schedule defaults for each module
  const modules: ModuleConfig[] = parsed.modules.map((m) => ({
    ...m,
    schedule: {
      initialIntervalMs: m.schedule?.initialIntervalMs ?? DEFAULT_SCHEDULE.initialIntervalMs,
      minIntervalMs: m.schedule?.minIntervalMs ?? DEFAULT_SCHEDULE.minIntervalMs,
      maxIntervalMs: m.schedule?.maxIntervalMs ?? DEFAULT_SCHEDULE.maxIntervalMs,
    },
  }));

  return {
    name: parsed.name,
    dataDir: resolve(parsed.dataDir),
    llm: parsed.llm,
    pages: parsed.pages,
    modules,
    logging: parsed.logging,
  };
}

/**
 * Resolve profile data directory to an absolute path.
 */
export function configToProfileDir(_configPath: string, dataDir: string): string {
  return resolve(dataDir);
}
