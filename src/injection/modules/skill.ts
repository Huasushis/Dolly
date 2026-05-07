import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import type { InjectionModule, InjectionEvent } from "../base.js";
import type { ContextFrame } from "../../core/context.js";
import type { EventBus } from "../../core/bus.js";
import { LLMClient } from "../../core/llm-client.js";

interface SkillDef {
  name: string;
  triggers: string;
  prompt: string;
}

class SkillInjector implements InjectionModule {
  id = "skill";

  private guardClient: LLMClient | null = null;
  private skills: SkillDef[] = [];
  private seenTriggers = new Set<string>();
  private mcpTools: Array<{ name: string; description: string }> = [];
  private toolsInjected = false;

  setup(_bus: EventBus): void {
    this.loadSkills();
  }

  setGuardClient(client: LLMClient): void {
    this.guardClient = client;
  }

  setMcpTools(tools: Array<{ name: string; description: string }>): void {
    this.mcpTools = tools;
    this.toolsInjected = false;
  }

  /** Load skill definitions from extensions/skills/*.json */
  private loadSkills(): void {
    const dir = resolve(import.meta.dirname!, "..", "..", "..", "extensions", "skills");
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = readFileSync(resolve(dir, file), "utf-8");
        const def = JSON.parse(raw);
        if (def.name && def.triggers && def.prompt) {
          this.skills.push(def);
        }
      } catch {}
    }
  }

  headContent(): string {
    return `工具调用协议：
- 不等待结果：[TOOL:工具名]\n{参数JSON}\n[/TOOL]
- 需要结果时务必用：[AWAIT:工具名]\n{参数JSON}\n[/TOOL]
  注意：读取文件、查询数据等需要结果的操作用 AWAIT。仅通知类用 TOOL。

记忆管理：
- 当注入信息不再需要时输出 [FORGET:xxx]

请自然地使用，不提及机制本身。`;
  }

  async onContextChange(frames: ContextFrame[]): Promise<InjectionEvent | null> {
    // Inject MCP tool list on first call
    if (!this.toolsInjected && this.mcpTools.length > 0) {
      this.toolsInjected = true;
      const toolList = this.mcpTools
        .map((t) => `  - [TOOL:mcp.${t.name}] ${t.description || t.name}`)
        .join("\n");
      return {
        id: "skill_mcp_tools",
        content: `[可用 MCP 工具]\n通过 [TOOL:mcp.工具名] 调用：\n${toolList}`,
        priority: 5,
      };
    }

    // Skill trigger detection via guard_llm
    if (!this.guardClient || this.skills.length === 0) return null;
    const recentText = frames.slice(-8).map((f) => f.content).join("\n");

    for (const skill of this.skills) {
      if (this.seenTriggers.has(skill.name)) continue;
      const triggered = await this.checkTrigger(skill, recentText);
      if (!triggered) continue;

      this.seenTriggers.add(skill.name);
      return {
        id: `skill_${skill.name}`,
        content: `[技能:${skill.name}]\n${skill.prompt}`,
        priority: 20,
      };
    }

    return null;
  }

  private async checkTrigger(skill: SkillDef, text: string): Promise<boolean> {
    if (!this.guardClient) return false;
    try {
      const resp = await this.guardClient.chat([
        { role: "user", content: `以下文本是否触发了"${skill.triggers}"？仅回复 yes 或 no。\n\n${text.slice(-1500)}` },
      ]);
      return resp.trim().toLowerCase().startsWith("yes");
    } catch { return false; }
  }
}

export default new SkillInjector();
