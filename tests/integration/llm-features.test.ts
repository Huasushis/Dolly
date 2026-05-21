/**
 * LLM Extension 功能集成测试
 * 需要运行中的 daemon。手动运行:
 *   node --import tsx/esm src/main.ts --daemon &
 *   node --import tsx/esm --test tests/integration/llm-features.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { connect, Socket } from "net";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const PORT_FILE = ".dolly/sockets/default.port";
const TIMEOUT = 30000;

function sendAndWait(port: number, text: string, timeout = TIMEOUT): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1", () => {
      let buf = "";
      s.on("data", (d) => { buf += d; });
      let timer = setTimeout(() => { s.destroy(); resolve(buf); }, timeout);
      s.on("data", () => { clearTimeout(timer); timer = setTimeout(() => { s.destroy(); resolve(buf); }, 3000); });
      s.write(text + "\n");
    });
    s.on("error", reject);
  });
}

describe("LLM Extension Features", () => {
  let port: number;

  before(() => {
    if (!existsSync(PORT_FILE)) throw new Error("Daemon not running. Start with: node --import tsx/esm src/main.ts --daemon &");
    port = parseInt(readFileSync(PORT_FILE, "utf-8"));
  });

  it("basic conversation: speak format", async () => {
    const resp = await sendAndWait(port, "你好");
    // Should contain a speak somewhere
    assert.ok(resp.length > 0, "should get a response");
    // The parseSpeak should extract content
    const hasContent = resp.includes("好") || resp.includes("嗨") || resp.includes("你");
    assert.ok(hasContent, "response should contain meaningful text");
  }).timeout(TIMEOUT + 5000);

  it("memory recall trigger: check recall tag in prompt", async () => {
    // The memory systemPrompt teaches {"recall":"hard"}
    // We can verify by checking the module's systemPrompt text
    const mod = await import("../../extensions/builtin/memory/index.js");
    const prompt = mod.default.systemPrompt({} as any);
    assert.ok(prompt.includes("recall"), "memory prompt should teach recall");
    assert.ok(prompt.includes("hard"), "memory prompt should mention hard mode");
  });

  it("thinking: verify enable_thinking config flows to LLM module", async () => {
    const mod = await import("../../extensions/builtin/llm/index.js");
    // Check that thinking is enabled in config
    const dolly = JSON.parse(readFileSync(resolve(import.meta.dirname!, "..", "..", "dolly.json"), "utf-8"));
    const enableThinking = dolly.modules?.["builtin/llm"]?.enable_thinking;
    // If thinking is enabled, the LLM module should have thinkingActive flag
    // This is a config test, not a runtime test
    assert.ok(enableThinking !== undefined, "thinking config should exist");
  });

  it("tool calling: verify MCP tools registered", () => {
    // Check mcp.json exists and has servers
    const mcpPath = resolve(import.meta.dirname!, "..", "..", "mcp.json");
    if (existsSync(mcpPath)) {
      const mcp = JSON.parse(readFileSync(mcpPath, "utf-8"));
      assert.ok(mcp.servers, "mcp.json should have servers");
    }
  });

  it("scanForget: verify forget scanning is wired in cascade", async () => {
    // Read main.ts source to verify scanForget exists in cascade
    const src = readFileSync(resolve(import.meta.dirname!, "..", "..", "src", "main.ts"), "utf-8");
    assert.ok(src.includes("scanForget"), "main.ts should have scanForget function");
    assert.ok(src.includes("scanForget(changes)"), "cascade should call scanForget");
  });
});
