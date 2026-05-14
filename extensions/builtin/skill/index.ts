import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import type { DollyModule, ModuleContext } from "../../../src/modules/base.js";
import type { BlockChange, BlockMutation } from "../../../src/blocks/index.js";
import { LLMClient } from "../../../src/core/llm-client.js";

interface SkillDef {
  name: string;        // from frontmatter, must match dir name
  description: string; // when to use (also used for trigger detection)
  body: string;        // Markdown instructions
}

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
    const cfg = (c.config as any)._llm_guard;
    guardClient = new LLMClient(cfg ?? { api_key: "", base_url: "https://api.deepseek.com", model: "deepseek-chat" });
    loadSkills();
  },


  async onBlocksChanged(c: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    ctx = c;
    const mutations: BlockMutation[] = [];

    if (!toolsInjected && mcpToolNames.length > 0) {
      toolsInjected = true;
      mutations.push({
        action: "insert", priority: 5,
        block: { type: "injection", content: `可用 MCP 工具: ${mcpToolNames.join(", ")}`, meta: { source: "skill" }, created: Date.now() },
      });
    }

    if (skills.length === 0) return mutations;
    const recentText = ctx.getBlocks().slice(-8).map((b) => b.content).join("\n");

    for (const skill of skills) {
      if (seenTriggers.has(skill.name)) continue;
      try {
        const resp = await guardClient.chat([
          { role: "user", content: `判断：用户是否在${skill.description}？仅回复 yes 或 no。\n\n${recentText.slice(-1000)}` },
        ]);
        if (resp.trim().toLowerCase().startsWith("yes")) {
          // 去重：检查上下文中是否已有同名skill块
          const alreadyInContext = ctx.getBlocks().some(
            (b) => b.type === "skill" && b.meta?.skill === skill.name
          );
          if (!alreadyInContext) {
            seenTriggers.add(skill.name);
            mutations.push({
              action: "insert", priority: 20,
              block: { type: "skill", content: skill.body, meta: { skill: skill.name, source: "skill" }, created: Date.now() },
            });
          }
        }
      } catch {}
    }

    return mutations;
  },
};

/** Parse YAML frontmatter from SKILL.md */
function parseFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } | null {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { frontmatter: fm, body: match[2].trim() };
}

/** Load skills from subdirectories containing SKILL.md (Agent Skills standard) */
function loadSkillsDir(dir: string) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    const mdFile = resolve(full, "SKILL.md");
    if (!existsSync(mdFile)) continue;
    try {
      const raw = readFileSync(mdFile, "utf-8");
      const parsed = parseFrontmatter(raw);
      if (!parsed) continue;
      const { frontmatter, body } = parsed;
      if (frontmatter.name && frontmatter.description) {
        skills.push({ name: frontmatter.name, description: frontmatter.description, body });
      }
    } catch {}
  }
}

function loadSkills() {
  // Built-in skills
  loadSkillsDir(resolve(import.meta.dirname!, "skills"));
  // Project skills (npx skills add target)
  loadSkillsDir(resolve(import.meta.dirname!, "..", "..", "..", "skills"));
  // Global skills (~/.dolly/skills)
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home) loadSkillsDir(resolve(home, ".dolly", "skills"));
}

export function setMcpTools(tools: string[]) { mcpToolNames = tools; toolsInjected = false; }

export default skillModule;
