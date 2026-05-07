import type { InjectionModule, InjectionEvent } from "../base.js";
import type { ContextFrame } from "../../core/context.js";
import type { EventBus } from "../../core/bus.js";
import { LLMClient } from "../../core/llm-client.js";

interface SkillDef {
  name: string;
  triggers: string;
  prompt: string;
}

const builtinSkills: SkillDef[] = [
  {
    name: "code-review",
    triggers: "用户要求审查代码、检查代码质量、review PR",
    prompt: "用户要求进行代码审查。请：1) 检查逻辑正确性 2) 安全性审查 3) 性能评估 4) 代码风格改善建议。以结构化格式输出。",
  },
  {
    name: "summarize",
    triggers: "用户要求总结、摘要、概括一段内容或对话",
    prompt: "用户要求进行总结。请提取核心要点，以简洁的列表形式输出，每个要点一句话。保留关键数据和结论。",
  },
];

class SkillInjector implements InjectionModule {
  id = "skill";

  private guardClient: LLMClient | null = null;
  private skills: SkillDef[] = [];
  private seenTriggers = new Set<string>();
  private mcpTools: Array<{ name: string; description: string }> = [];
  private toolsInjected = false;

  setup(bus: EventBus): void {
    this.skills = [...builtinSkills];
  }

  setGuardClient(client: LLMClient): void {
    this.guardClient = client;
  }

  setMcpTools(tools: Array<{ name: string; description: string }>): void {
    this.mcpTools = tools;
    this.toolsInjected = false; // re-inject on next context change
  }

  headContent(): string {
    return `工具调用协议：
- 调用工具：[TOOL:工具名]\n{参数JSON}\n[/TOOL]
- 等待结果：[AWAIT:工具名]\n{参数JSON}\n[/TOOL]
- 格式参考：{"key": "value"}（标准 JSON）

记忆管理：
- 当某段注入信息不再需要时，输出 [FORGET:xxx]（xxx 为注入ID）

请自然地使用这些功能，不要刻意提及机制的存在。`;
  }

  onContextChange(frames: ContextFrame[]): InjectionEvent | null {
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

    // Skill trigger detection
    if (!this.guardClient || this.skills.length === 0) return null;
    const recentText = frames.slice(-8).map((f) => f.content).join("\n");

    // Quick keyword pre-filter before calling guard LLM
    for (const skill of this.skills) {
      if (this.seenTriggers.has(skill.name)) continue;
      const triggered = this.keywordPreFilter(skill, recentText);
      if (!triggered) continue;

      return {
        id: `skill_${skill.name}`,
        content: `[技能:${skill.name}]\n${skill.prompt}`,
        priority: 20,
      };
    }

    return null;
  }

  /** Fast keyword filter to avoid unnecessary LLM calls */
  private keywordPreFilter(skill: SkillDef, text: string): boolean {
    const keywords = skill.triggers.split(/[、，,]/);
    return keywords.some((kw) => text.includes(kw.trim()));
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
