import type { InjectionModule, InjectionEvent } from "../base.js";
import type { ContextFrame } from "../../core/context.js";
import type { EventBus } from "../../core/bus.js";
import type { LLMConfig } from "../../config.js";
import { LLMClient } from "../../core/llm-client.js";

interface SkillDef {
  name: string;
  /** Natural language description of when this skill should trigger */
  triggers: string;
  /** Prompt to inject when triggered */
  prompt: string;
}

/** Built-in skills */
const builtinSkills: SkillDef[] = [
  {
    name: "code-review",
    triggers: "用户要求审查代码、检查代码质量、review PR",
    prompt: "用户要求进行代码审查。请按照以下流程进行：1) 检查逻辑正确性 2) 安全性审查 3) 性能评估 4) 代码风格。以结构化格式给出审查意见。",
  },
];

/**
 * SKILL injection module.
 * 1. Injects head content teaching LLM about [TOOL]/[AWAIT]/[FORGET]
 * 2. Watches context for skill triggers using guard_llm
 * 3. Injects skill prompt when triggered
 */
class SkillInjector implements InjectionModule {
  id = "skill";

  private guardClient: LLMClient | null = null;
  private skills: SkillDef[] = [];
  private seenTriggers = new Set<string>();

  setup(bus: EventBus): void {
    // guardClient must be injected by main.ts
    this.skills = [...builtinSkills];
  }

  setGuardClient(client: LLMClient): void {
    this.guardClient = client;
  }

  headContent(): string {
    return `工具调用：
- 调用工具：[TOOL:工具名]\n{参数JSON}\n[/TOOL]
- 需要等待结果的工具：[AWAIT:工具名]\n{参数JSON}\n[/TOOL]

记忆管理：
- 当某段注入信息不再需要时，输出 [FORGET:xxx]（xxx 为注入ID），系统会自动移除。

请自然使用这些功能，不必刻意提及它们的存在。`;
  }

  async onContextChange(frames: ContextFrame[]): Promise<InjectionEvent | null> {
    if (!this.guardClient || this.skills.length === 0) return null;

    // Combine recent context as a single text for guard LLM
    const recentText = frames.slice(-10).map((f) => f.content).join("\n");

    for (const skill of this.skills) {
      if (this.seenTriggers.has(skill.name)) continue;

      const triggered = await this.checkTrigger(skill, recentText);
      if (triggered) {
        this.seenTriggers.add(skill.name);
        return {
          id: `skill_${skill.name}`,
          content: `[技能:${skill.name}]\n${skill.prompt}`,
          priority: 20,
        };
      }
    }
    return null;
  }

  private async checkTrigger(skill: SkillDef, text: string): Promise<boolean> {
    if (!this.guardClient) return false;
    try {
      const resp = await this.guardClient.chat([
        {
          role: "user",
          content: `以下文本是否触发了"${skill.triggers}"这个条件？仅回复 yes 或 no。\n\n文本：${text.slice(-2000)}`,
        },
      ]);
      return resp.trim().toLowerCase().startsWith("yes");
    } catch {
      return false;
    }
  }
}

export default new SkillInjector();
