import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import type { DollyModule, ModuleContext } from "../../../src/modules/base.js";
import type { BlockChange, BlockMutation } from "../../../src/blocks/index.js";
import { LLMClient } from "../../../src/core/llm-client.js";

interface SkillDef { name: string; triggers: string; prompt: string; }

let ctx: ModuleContext;
let guardClient: LLMClient;
let skills: SkillDef[] = [];
let seenTriggers = new Set<string>();
let toolsInjected = false;
let mcpToolNames: string[] = [];

const skillModule: DollyModule = {
  id: "builtin/skill",

  async init(c: ModuleContext) {
    ctx = c;
    const cfg = (c.config as any).llm?.guard ?? (c.config as any)._llm_guard;
    guardClient = new LLMClient(cfg ?? { api_key: "", base_url: "https://api.deepseek.com", model: "deepseek-chat" });
    loadSkills();
  },

  systemPrompt(): string {
    return `工具调用：用 [TOOL:name]\\n{params}\\n[/TOOL] 或 [AWAIT:name]\\n{params}\\n[/TOOL]（需要结果时）。FORGET 用 [FORGET:id]。`;
  },

  async onBlocksChanged(c: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    ctx = c;
    const mutations: BlockMutation[] = [];

    // Inject MCP tools list on first block change
    if (!toolsInjected && mcpToolNames.length > 0) {
      toolsInjected = true;
      mutations.push({
        action: "insert", priority: 5,
        block: { type: "injection", content: `可用 MCP 工具: ${mcpToolNames.join(", ")}`, meta: { source: "skill" }, created: Date.now() },
      });
    }

    // Guard LLM skill trigger detection
    if (skills.length === 0) return mutations;
    const recentText = ctx.getBlocks().slice(-8).map((b) => b.content).join("\n");

    for (const skill of skills) {
      if (seenTriggers.has(skill.name)) continue;
      try {
        const resp = await guardClient.chat([
          { role: "user", content: `判断：用户是否在${skill.triggers}？仅回复 yes 或 no。\n\n${recentText.slice(-1000)}` },
        ]);
        if (resp.trim().toLowerCase().startsWith("yes")) {
          seenTriggers.add(skill.name);
          mutations.push({
            action: "insert", priority: 20,
            block: { type: "skill", content: skill.prompt, meta: { skill: skill.name }, created: Date.now() },
          });
        }
      } catch {}
    }

    return mutations;
  },
};

function loadSkills() {
  const dir = resolve(import.meta.dirname!, "skills");
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const def = JSON.parse(readFileSync(resolve(dir, file), "utf-8"));
      if (def.name && def.triggers && def.prompt) skills.push(def);
    } catch {}
  }
}

export function setMcpTools(tools: string[]) { mcpToolNames = tools; toolsInjected = false; }

export default skillModule;
