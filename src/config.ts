import { resolve } from "path";
import { existsSync, readFileSync } from "fs";

export interface LLMConfig {
  api_key: string; base_url: string; model: string; enable_thinking?: boolean;
}

export interface DollyConfig {
  name: string;
  context: { max_tokens: number; compression_threshold: number; decay_rate?: number; protect_window_min?: number };
  modules: { enabled: string[]; [name: string]: any };
  daemon: { pid_dir: string };
}

export function loadConfig(): DollyConfig {
  const configPath = process.env.DOLLY_CONFIG
    ? resolve(process.env.DOLLY_CONFIG)
    : resolve(import.meta.dirname!, "..", "dolly.json");
  if (!existsSync(configPath)) throw new Error(`Config not found: ${configPath}`);

  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  const envKey = (key: string) => process.env[key] ?? "";

  const modules: Record<string, any> = { ...raw.modules };

  // Resolve builtin/llm config
  const llmRaw = modules["builtin/llm"] ?? raw.llm?.main;
  modules["builtin/llm"] = {
    api_key: envKey(llmRaw?.api_key_env ?? "DEEPSEEK_API_KEY"),
    base_url: llmRaw?.base_url ?? "https://api.deepseek.com",
    model: llmRaw?.model ?? "deepseek-chat",
    enable_thinking: llmRaw?.enable_thinking ?? false,
  };

  // Resolve builtin/memory config
  const memRaw = modules["builtin/memory"] ?? raw.llm?.memory;
  modules["builtin/memory"] = {
    api_key: envKey(memRaw?.api_key_env ?? "DEEPSEEK_API_KEY"),
    base_url: memRaw?.base_url ?? "https://api.deepseek.com",
    model: memRaw?.model ?? "deepseek-chat",
    idle_minutes: memRaw?.idle_minutes ?? raw.memory?.idle_minutes ?? 60,
  };

  // Resolve builtin/skill config (guard llm reuses main config)
  const skillRaw = modules["builtin/skill"] ?? {};
  modules["builtin/skill"] = {
    api_key: envKey(skillRaw?.api_key_env ?? "DEEPSEEK_API_KEY"),
    base_url: skillRaw?.base_url ?? modules["builtin/llm"].base_url,
    model: skillRaw?.model ?? modules["builtin/llm"].model,
    skills_dirs: skillRaw?.skills_dirs ?? ["./skills", "~/.dolly/skills"],
  };

  return {
    name: raw.name ?? "dolly",
    context: {
      max_tokens: raw.context?.max_tokens ?? 32768,
      compression_threshold: raw.context?.compression_threshold ?? 0.8,
      decay_rate: raw.context?.decay_rate,
      protect_window_min: raw.context?.protect_window_min,
    },
    modules: { enabled: modules.enabled ?? raw.modules?.enabled ?? ["builtin/llm", "builtin/mcp"], ...modules },
    daemon: { pid_dir: raw.daemon?.pid_dir ?? ".dolly/daemons" },
  };
}
