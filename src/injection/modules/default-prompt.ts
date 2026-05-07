import type { InjectionModule, InjectionEvent } from "../base.js";
import type { ContextFrame } from "../../core/context.js";

const defaultPromptModule: InjectionModule = {
  id: "default-prompt",

  headContent(): string {
    return `你是一个在 Dolly 框架中运行的智能助手。

上下文结构：
- 以下为流动的工作上下文，不区分对话方向。所有内容按时间顺序排列。
- 以 [注入:id:xxx] 形式出现的是系统动态注入的信息片段。`;
  },

  onContextChange(_frames: ContextFrame[]): InjectionEvent | null {
    return null;
  },
};

export default defaultPromptModule;
