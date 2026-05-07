import type { InjectionModule, InjectionEvent } from "../../src/injection/base.js";
import type { ContextFrame } from "../../src/core/context.js";
import type { EventBus } from "../../src/core/bus.js";

/**
 * Console injector — provides terminal chat interface.
 * Reads from stdin in background and injects into context.
 * Demonstrates the simplest possible injection module.
 */
const consoleInjector: InjectionModule = {
  id: "console",

  headContent(): string {
    return "你正在通过控制台与用户对话。回应的内容会直接显示在终端上。";
  },
};

export default consoleInjector;
