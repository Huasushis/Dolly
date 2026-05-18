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
let seenTriggers = new Set<string>();  // cleared at midnight

const skillModule: DollyModule = {
  id: "builtin/skill",

  async init(c: ModuleContext) {
    ctx = c;
    const cfg = (c.config as any)["builtin/skill"] ?? {};
    guardClient = new LLMClient(cfg);
    loadSkills();
  },

  async onBlocksChanged(c: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    ctx = c;

    // Only trigger on new outer blocks (external input)
    const newMsgs = changes.filter((ch) => ch.type === "added" && ch.block.type === "outer");
    if (newMsgs.length === 0 || skills.length === 0) return [];

    const mutations: BlockMutation[] = [];
    const recentText = ctx.getBlocks().slice(-8).map((b) => b.content).join("\n").slice(-2000);

    // Batch guard: one LLM call for all unmatched skills
    const candidates = skills.filter((s) => !seenTriggers.has(s.name));
    if (candidates.length === 0) return [];

    try {
      const skillList = candidates.map((s, i) => `${i}: ${s.name} — ${s.description}`).join("\n");
      const resp = await guardClient.chat([
        { role: "user", content: `判断以下对话触发了哪些技能（可能零个或多个）。只回复匹配的序号（逗号分隔），不匹配则回复 none。

技能：
${skillList}

上下文：
${recentText}` },
      ]);
      const hits = resp.trim();
      if (hits.toLowerCase() === "none") return mutations;

      const indices = hits.split(/[,，\s]+/).map((s) => parseInt(s.trim())).filter((n) => !isNaN(n) && n >= 0 && n < candidates.length);
      for (const idx of indices) {
        const skill = candidates[idx];
        const already = ctx.getBlocks().some((b) => b.type === "inner" && b.meta?.skill === skill.name);
        if (!already) {
          seenTriggers.add(skill.name);
          mutations.push({
            action: "insert", priority: 20,
            block: { type: "inner", content: skill.body, meta: { source: "skill", subtype: "skill", skill: skill.name }, created: Date.now() },
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

function loadSkills() {
  skills = [];
  // Built-in skills
  loadSkillsDir(resolve(import.meta.dirname!, "skills"));
  // Configurable directories from dolly.json modules.builtin/skill.skills_dirs
  const cfg = (ctx.config as any)["builtin/skill"] ?? {};
  const dirs: string[] = cfg.skills_dirs ?? ["./skills", "~/.dolly/skills"];
  for (const d of dirs) {
    const expanded = d.startsWith("~") ? resolve(process.env.HOME || process.env.USERPROFILE || "", d.slice(1)) : resolve(d);
    loadSkillsDir(expanded);
  }
}

export function clearSeenTriggers() { seenTriggers = new Set(); }
export function getSkills() { return skills; }
export default skillModule;
