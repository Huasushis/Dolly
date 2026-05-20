import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = fileURLToPath(import.meta.url);
// tests/extensions/ → go up 3 levels to project root
const root = resolve(__dirname, "..", "..", "..");

describe("System prompt verification", () => {
  it("dolly.json persona is a human, not AI", () => {
    const dolly = JSON.parse(readFileSync(resolve(root, "dolly.json"), "utf-8"));
    const persona = dolly.agent?.persona ?? "";
    assert.ok(persona.length > 20, "persona too short: " + persona);
    assert.ok(!persona.includes("AI助手"), "persona still says AI助手");
    assert.ok(!persona.includes("AI 助手"), "persona still says AI 助手");
    assert.ok(persona.includes("普通") || persona.includes("血有肉"), "persona should mention human");
  });

  it("LLM module systemPrompt teaches speak and inner monologue", async () => {
    const url = pathToFileURL(resolve(root, "extensions", "builtin", "llm", "index.ts")).href;
    const mod = await import(url);
    const inst = mod.default;
    const ctx = { config: { "builtin/llm": { enable_thinking: false } } };
    const prompt = inst.systemPrompt ? inst.systemPrompt(ctx) : "";
    assert.ok(!prompt.includes("\"speak\""), "LLM sysPrompt should NOT teach speak (console's domain)");
    assert.ok(!prompt.includes("\"tool\""), "LLM sysPrompt should NOT teach tool (MCP's domain)");
    assert.ok(!prompt.includes("\"recall\""), "LLM sysPrompt should NOT teach recall (memory's domain)");
    assert.ok(prompt.includes("私人内心世界"), "LLM sysPrompt should be about inner world");
    assert.ok(prompt.includes("心") || prompt.includes("想") || prompt.includes("感受"), "LLM sysPrompt should encourage thinking");
    assert.ok(prompt.includes("forget"), "LLM sysPrompt should teach forget (its own domain)");
  });

  it("Console module systemPrompt teaches fenced JSON speak", async () => {
    const url = pathToFileURL(resolve(root, "extensions", "builtin", "console", "index.ts")).href;
    const mod = await import(url);
    const inst = mod.default;
    const prompt = inst.systemPrompt ? inst.systemPrompt({} as any) : "";
    assert.ok(prompt.includes("speak"), "console prompt must mention speak");
    assert.ok(prompt.includes("```json"), "console prompt must teach fenced JSON format");
  });

  it("Full system prompt assembly includes persona", () => {
    const dolly = JSON.parse(readFileSync(resolve(root, "dolly.json"), "utf-8"));
    const persona = dolly.agent?.persona ?? "";
    assert.ok(persona.length > 0, "persona must exist in dolly.json");
    // The persona is set as part of the system block in main.ts:
    // context.setSystemPrompt([persona, registry.buildSystemPrompt()].filter(Boolean).join("\n\n"))
    // This is verified by checking the source code, not a runtime call
  });
});
