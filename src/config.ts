import { resolve } from "path";
import { existsSync, readFileSync } from "fs";

export interface LLMConfig {
  api_key: string; base_url: string; model: string; enable_thinking?: boolean;
}

export interface DollyConfig {
  name: string;
  context: { max_tokens: number; compression_threshold: number; decay_rate?: number; protect_window_min?: number; max_background_chars?: number };
  modules: { enabled: string[]; [name: string]: any };
  daemon: { pid_dir: string; log_dir: string };
}

function resolveLLM(rawCfg: any, envKeyEnv: string): LLMConfig {
  const envKey = (key: string) => process.env[key] ?? "";
  return {
    api_key: envKey(rawCfg?.api_key_env ?? envKeyEnv),
    base_url: rawCfg?.base_url ?? "https://api.deepseek.com",
    model: rawCfg?.model ?? "deepseek-chat",
    enable_thinking: rawCfg?.enable_thinking,
  };
}

export function loadConfig(): DollyConfig {
  const configPath = resolve(import.meta.dirname!, "..", "dolly.json");
  if (!existsSync(configPath)) throw new Error(`dolly.json not found at ${configPath}`);

  const raw = JSON.parse(readFileSync(configPath, "utf-8"));

  // Legacy top-level llm → inject into module configs if not already there
  if (raw.llm) {
    if (raw.llm.main && !raw.modules?.["builtin/llm"]?.model) {
      raw.modules ??= {};
      raw.modules["builtin/llm"] = { ...raw.llm.main, ...raw.modules["builtin/llm"] };
      raw.modules["builtin/memory"] = { ...raw.llm.memory, ...raw.modules["builtin/memory"] };
    }
  }

  return {
    name: raw.name ?? "dolly",
    context: {
      max_tokens: raw.context?.max_tokens ?? 32768,
      compression_threshold: raw.context?.compression_threshold ?? 0.8,
      decay_rate: raw.context?.decay_rate,
      protect_window_min: raw.context?.protect_window_min,
      max_background_chars: raw.context?.max_background_chars,
    },
    modules: { enabled: raw.modules?.enabled ?? ["builtin/llm", "builtin/skill", "builtin/mcp"], ...raw.modules },
    daemon: { pid_dir: raw.daemon?.pid_dir ?? ".dolly/daemons", log_dir: raw.daemon?.log_dir ?? ".dolly/logs" },
  };
}
