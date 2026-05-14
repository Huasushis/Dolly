import type { DollyModule, ModuleContext } from "../../../src/modules/base.js";
import type { BlockChange, BlockMutation } from "../../../src/blocks/index.js";

/** Console module — display only. stdin handled by main.ts. */
const consoleModule: DollyModule = {
  id: "builtin/console",

  async onBlocksChanged(_c: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    for (const ch of changes) {
      if (ch.type === "added" && ch.block.type === "response") {
        const text = ch.block.content.replace(/```json[\s\S]*?```/g, "").trim();
        if (text) process.stdout.write(text + "\n");
      }
    }
    return [];
  },
};

export default consoleModule;
