import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { resolve } from "path";

loadEnv();

const llmConfigSchema = z.object({
  api_key: z.string(),
  base_url: z.string().default("https://api.deepseek.com"),
  model: z.string().default("deepseek-chat"),
});

const contextConfigSchema = z.object({
  max_tokens: z.number().default(32768),
  compression_threshold: z.number().default(0.8),
});

const dollyConfigSchema = z.object({
  main_llm: llmConfigSchema.default(() => ({
    api_key: process.env.DEEPSEEK_API_KEY ?? "",
    base_url: "https://api.deepseek.com",
    model: "deepseek-chat",
  })),
  aux_llm: llmConfigSchema.default(() => ({
    api_key: process.env.DEEPSEEK_API_KEY ?? "",
    base_url: "https://api.deepseek.com",
    model: "deepseek-chat",
  })),
  context: contextConfigSchema.default({ max_tokens: 32768, compression_threshold: 0.8 }),
  injection_modules: z.array(z.string()).default(() => [
    resolve(import.meta.dirname, "injection/modules/default-prompt.ts"),
    resolve(import.meta.dirname, "injection/modules/compression.ts"),
  ]),
  monitor_modules: z.array(z.string()).default(() => [
    resolve(import.meta.dirname, "monitor/modules/stdout.ts"),
    resolve(import.meta.dirname, "monitor/modules/forget-detector.ts"),
  ]),
  long_term_memory_path: z.string().default(() => resolve(import.meta.dirname, "..", ".memory")),
});

export type LLMConfig = z.infer<typeof llmConfigSchema>;
export type ContextConfig = z.infer<typeof contextConfigSchema>;
export type DollyConfig = z.infer<typeof dollyConfigSchema>;

export function loadConfig(): DollyConfig {
  return dollyConfigSchema.parse({});
}
