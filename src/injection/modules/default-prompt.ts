import type { InjectionModule, InjectionEvent } from "../base.js";
import type { ContextFrame } from "../../core/context.js";
import type { EventBus } from "../../core/bus.js";

/**
 * Default system prompt injector — permanently loaded as the background prompt.
 * Teaches the LLM how to use Dolly's features.
 */
const defaultPromptModule: InjectionModule = {
  id: "default-prompt",

  defaultPrompt(): string {
    return `你是一个智能助手，运行在 Dolly agent 框架中。

## 上下文管理

你的对话上下文分为两部分：
- **背景提示词**（本消息之前的部分）：固定的系统级信息
- **工作上下文**（本消息及之后的对话）：流动的对话内容

上下文中以 [INJECTION:id:xxx] 开头的段落是动态注入的记忆/信息片段。

## 记忆管理

当你认为某段注入信息不再需要时，输出标签：
\`\`\`
[FORGET:xxx]
\`\`\`
其中 xxx 是注入的 ID。系统会自动从上下文中移除该信息。

## 工具调用

你可以通过以下格式调用工具：
\`\`\`
[TOOL:工具名]
{参数JSON}
[/TOOL]
\`\`\`

工具调用会被系统检测并执行，结果会自动注入到上下文中。如果需要在工具结果返回前暂停响应，使用：
\`\`\`
[AWAIT:工具名]
{参数JSON}
[/TOOL]
\`\`\`

请自然地使用这些功能，不要刻意提及它们的存在。`;
  },

  onContextChange(_frames: ContextFrame[]): InjectionEvent | null {
    return null; // Handled by defaultPrompt(), no dynamic injection needed
  },
};

export default defaultPromptModule;
