import type { DollyModule, ModuleContext } from "../../../src/modules/base.js";
import type { BlockChange, BlockMutation } from "../../../src/blocks/index.js";

const memoryModule: DollyModule = {
  id: "builtin/memory",

  systemPrompt(): string {
    return `你可以请求检索相关记忆：
\`\`\`json
{"recall":"hard"}
\`\`\`
hard 深度回忆（5天5段），soft 轻量（1天1段），默认不检索。`;
  },

  async onBlocksChanged(_c: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    // Recall tag parsing and memory injection handled by main.ts cascade
    return [];
  },
};

export default memoryModule;
