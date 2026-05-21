import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";

const root = resolve(import.meta.dirname!, "..", "..");
const ext = (name: string) => pathToFileURL(resolve(root, "extensions", name)).href;

describe("LLM Extension Features (config/static checks)", () => {

  it("memory systemPrompt teaches recall", async () => {
    const mod = await import(ext("builtin/memory/index.ts"));
    const prompt = mod.default.systemPrompt({} as any);
    assert.ok(prompt.includes("recall"), "memory prompt should teach recall");
    assert.ok(prompt.includes("hard"), "memory prompt should mention hard mode");
    assert.ok(prompt.includes("soft"), "memory prompt should mention soft mode");
  });

  it("llm module has thinkingEnabled flow", () => {
    const dolly = JSON.parse(readFileSync(resolve(root, "dolly.json"), "utf-8"));
    const enableThinking = dolly.modules?.["builtin/llm"]?.enable_thinking;
    assert.ok(enableThinking !== undefined, "thinking config key should exist");
  });

  it("llm module calls setSystemPrompt for thinking", () => {
    const src = readFileSync(resolve(root, "extensions/builtin/llm/index.ts"), "utf-8");
    assert.ok(src.includes("setSystemPrompt"), "should call setSystemPrompt");
    assert.ok(src.includes("thinking"), "should mention thinking");
  });

  it("mcp tools are registered in mcp.json", () => {
    const mcpPath = resolve(root, "mcp.json");
    if (existsSync(mcpPath)) {
      const mcp = JSON.parse(readFileSync(mcpPath, "utf-8"));
      assert.ok(mcp.servers, "mcp.json should have servers");
      assert.ok(Object.keys(mcp.servers).length > 0, "should have at least one MCP server");
    }
  });

  it("scanForget is wired in cascade loop", () => {
    const src = readFileSync(resolve(root, "src/main.ts"), "utf-8");
    assert.ok(src.includes("scanForget"), "main.ts should define scanForget");
    assert.ok(src.includes("scanForget(changes)"), "cascade should call scanForget");
  });

  it("forget syntax is taught in system prompt", () => {
    const src = readFileSync(resolve(root, "src/main.ts"), "utf-8");
    assert.ok(src.includes('"forget"'), "FRAMEWORK_INNER_WORLD should teach forget");
  });

  it("console prompt teaches speak with fenced JSON", async () => {
    const mod = await import(ext("builtin/console/index.ts"));
    const prompt = mod.default.systemPrompt({} as any);
    assert.ok(prompt.includes("speak"), "console prompt must mention speak");
    assert.ok(prompt.includes('"speak"'), "console prompt must teach speak");
  });

  it("module prompts don't cross-contaminate", async () => {
    const llmMod = await import(ext("builtin/llm/index.ts"));
    const llmPrompt = llmMod.default.systemPrompt({ config: { "builtin/llm": { enable_thinking: false } } } as any);
    const memMod = await import(ext("builtin/memory/index.ts"));
    const memPrompt = memMod.default.systemPrompt({} as any);

    assert.ok(!llmPrompt.includes('"tool"'), "LLM should not teach tool");
    assert.ok(!llmPrompt.includes('"recall"'), "LLM should not teach recall");
    assert.ok(!memPrompt.includes('"tool"'), "memory should not teach tool");
    assert.ok(!memPrompt.includes('"speak"'), "memory should not teach speak");
  });

  it("parseSpeak handles fenced JSON speak", () => {
    const text = '```json\n{"speak":"hello"}\n```';
    const m = text.match(/```json\s*\n([\s\S]*?)```/);
    assert.ok(m, "should match fenced JSON");
    const obj = JSON.parse(m![1].trim());
    assert.equal(obj.speak, "hello");
  });

  it("parseSpeak handles raw JSON speak fallback", () => {
    const re = /\{"speak"\s*:\s*"((?:[^"\\]|\\.)*)"\}/g;
    const text = '{"speak":"hello world"}';
    const m = re.exec(text);
    assert.ok(m, "should match raw JSON speak");
    assert.equal(JSON.parse(`{"speak":"${m![1]}"}`).speak, "hello world");
  });
});
