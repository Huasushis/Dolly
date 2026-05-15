import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import type { DollyModule, ModuleContext } from "../../../src/modules/base.js";
import type { BlockChange, BlockMutation } from "../../../src/blocks/index.js";
import { LLMClient } from "../../../src/core/llm-client.js";

interface SkillDef {
  name: string;
  description: string;
  body: string;
}

let ctx: ModuleContext;
let guardClient: LLMClient;
let skills: SkillDef[] = [];
let triggered = new Set<string>();

const skillModule: DollyModule = {
  id: "builtin/skill",

  async init(c: ModuleContext) {
    ctx = c;
    // Reuse main LLM config for guard detection (cheap yes/no calls)
    const llmCfg = (c.config as any)["builtin/llm"] ?? { api_key: "", base_url: "https://api.deepseek.com", model: "deepseek-chat" };
    guardClient = new LLMClient(llmCfg);
    loadSkills(c);
  },

  async onBlocksChanged(c: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    ctx = c;
    if (skills.length === 0) return [];

    const newMsgs = changes.filter((ch) => ch.type === "added" && ch.block.type === "message");
    if (newMsgs.length === 0) return [];

    const mutations: BlockMutation[] = [];
    const recentText = ctx.getBlocks().slice(-8).map((b) => b.content).join("\n").slice(-2000);

    // Batch: one LLM call checks all unmatched skills at once
    const candidates = skills.filter((s) => !triggered.has(s.name));
    if (candidates.length === 0) return [];

    try {
      const skillList = candidates.map((s, i) => `${i}: ${s.name} — ${s.description}`).join("\n");
      const resp = await guardClient.chat([
        { role: "user", content: `下面是一段对话上下文和一系列技能描述。判断哪些技能当前被触发（可能有零个、一个或多个）。只回复匹配的技能序号（逗号分隔），不匹配则回复 none。

技能：
${skillList}

上下文：
${recentText}` },
      ]);
      const hits = resp.trim();
      if (hits.toLowerCase() === "none") return [];

      const indices = hits.split(/[,，\s]+/).map((s) => parseInt(s.trim())).filter((n) => !isNaN(n) && n >= 0 && n < candidates.length);
      for (const idx of indices) {
        const skill = candidates[idx];
        const already = ctx.getBlocks().some((b) => b.type === "skill" && b.meta?.skill === skill.name);
        if (!already) {
          triggered.add(skill.name);
          mutations.push({
            action: "insert", priority: 20,
            block: { type: "skill", content: skill.body, meta: { skill: skill.name, source: "skill" }, created: Date.now() },
          });
        }
      }
    } catch {}

    return mutations;
  },
};

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

function loadSkills(c: ModuleContext) {
  const cfg = (c.config as any)["builtin/skill"] ?? {};

  // Built-in skills (always loaded)
  loadSkillsDir(resolve(import.meta.dirname!, "skills"));

  // Configurable directories from dolly.json modules.builtin/skill.skills_dirs
  const dirs: string[] = cfg.skills_dirs ?? [];
  for (const d of dirs) {
    const expanded = d.startsWith("~") ? resolve(process.env.HOME || process.env.USERPROFILE || "", d.slice(1)) : resolve(d);
    loadSkillsDir(expanded);
  }
}

export function setMcpTools(_tools: string[]) {} // deprecated, kept for compat
export function getSkills() { return skills; }
export default skillModule;
