import type { InjectionModule, InjectionEvent } from "../base.js";
import type { ContextFrame } from "../../core/context.js";
import type { EventBus } from "../../core/bus.js";

/**
 * Test task injector — injects a structured task to demonstrate
 * the injection/monitor/memory pipeline end-to-end.
 */
const testTaskModule: InjectionModule = {
  id: "test-task",

  onContextChange(frames: ContextFrame[]): InjectionEvent | null {
    const hasTask = frames.some((f) => f.content.includes("[任务]"));
    if (hasTask) return null;

    return {
      id: "test_task_001",
      content: `[任务] 请完成以下操作：
1. 调用 [TOOL:datetime] 查询当前时间
2. 然后调用 [AWAIT:datetime] 再次查询并等待结果
3. 最后输出 [FORGET:test_task_001] 来清理这条任务记忆

请按照步骤逐一执行。`,
      priority: 10,
    };
  },
};

export default testTaskModule;
