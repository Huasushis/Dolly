import type { DollyModule, ModuleContext } from "../../../src/modules/base.js";
import type { BlockChange, BlockMutation } from "../../../src/blocks/index.js";

const speakHistory: string[] = [];
const MAX_HISTORY = 200;

const consoleModule: DollyModule = {
  id: "builtin/console",

  async onBlocksChanged(_c: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    for (const ch of changes) {
      if (ch.type === "added" && ch.block.type === "response") {
        const text = ch.block.content.replace(/```json[\s\S]*?```/g, "").trim();
        if (text) {
          speakHistory.push(text);
          if (speakHistory.length > MAX_HISTORY) speakHistory.shift();
          process.stdout.write(text + "\n");
        }
      }
    }
    return [];
  },
};

/** Get recent speak history (for attach replay) */
export function getSpeakHistory(): string[] { return [...speakHistory]; }

export default consoleModule;
