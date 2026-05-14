import { resolve } from "path";
import { existsSync, readFileSync } from "fs";

export interface DollyConfig {
  name: string;
  llm: {
    main: { api_key: string; base_url: string; model: string };
    memory: { api_key: string; base_url: string; model: string };
    guard: { api_key: string; base_url: string; model: string };
  };
  context: { max_tokens: number; compression_threshold: number; decay_rate?: number; protect_window_min?: number; max_background_chars?: number };
  modules: { enabled: string[]; [name: string]: any };
  memory: { path: string; auto_summarize: boolean; idle_minutes: number };
  daemon: { pid_dir: string; log_dir: string };
}

export function loadConfig(): DollyConfig {
  const configPath = resolve(import.meta.dirname!, "..", "dolly.json");
  if (!existsSync(configPath)) throw new Error(`dolly.json not found at ${configPath}`);

  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  const envKey = (key: string) => process.env[key] ?? "";

  return {
    name: raw.name ?? "dolly",
    llm: {
      main: {
        api_key: envKey(raw.llm?.main?.api_key_env ?? "DEEPSEEK_API_KEY"),
        base_url: raw.llm?.main?.base_url ?? "https://api.deepseek.com",
        model: raw.llm?.main?.model ?? "deepseek-chat",
      },
      memory: {
        api_key: envKey(raw.llm?.memory?.api_key_env ?? "DEEPSEEK_API_KEY"),
        base_url: raw.llm?.memory?.base_url ?? "https://api.deepseek.com",
        model: raw.llm?.memory?.model ?? "deepseek-chat",
      },
      guard: {
        api_key: envKey(raw.llm?.guard?.api_key_env ?? "DEEPSEEK_API_KEY"),
        base_url: raw.llm?.guard?.base_url ?? "https://api.deepseek.com",
        model: raw.llm?.guard?.model ?? "deepseek-chat",
      },
    },
    context: {
      max_tokens: raw.context?.max_tokens ?? raw.llm?.main?.max_tokens ?? 32768,
      compression_threshold: raw.context?.compression_threshold ?? 0.8,
      decay_rate: raw.context?.decay_rate,
      protect_window_min: raw.context?.protect_window_min,
      max_background_chars: raw.context?.max_background_chars,
    },
    modules: { enabled: raw.modules?.enabled ?? ["builtin/llm", "builtin/skill", "builtin/mcp"], ...raw.modules },
    memory: { path: raw.memory?.path ?? ".memory", auto_summarize: raw.memory?.auto_summarize ?? true, idle_minutes: raw.memory?.idle_minutes ?? 60 },
    daemon: { pid_dir: raw.daemon?.pid_dir ?? ".dolly/daemons", log_dir: raw.daemon?.log_dir ?? ".dolly/logs" },
  };
}
