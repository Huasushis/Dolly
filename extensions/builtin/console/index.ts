import type { DollyModule, ModuleContext } from "../../../src/modules/base.js";
import type { BlockChange, BlockMutation } from "../../../src/blocks/index.js";

const speakHistory: string[] = [];
const MAX_HISTORY = 200;

const consoleModule: DollyModule = {
  id: "builtin/console",

  systemPrompt(): string {
    return `当你需要向用户展示内容时，使用 fenced JSON：
\`\`\`json
{"speak":"你要对用户说的话"}
\`\`\`
speak 之外的一切都是你的内心独白——不会被显示。`;
  },

  async onBlocksChanged(_c: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    for (const ch of changes) {
      if (ch.type === "added" && ch.block.type === "response") {
        // Extract speak blocks from response
        const speaks = parseSpeak(ch.block.content);
        for (const s of speaks) {
          speakHistory.push(s);
          if (speakHistory.length > MAX_HISTORY) speakHistory.shift();
          process.stdout.write(s + "\n");
        }
      }
    }
    return [];
  },
};

function parseSpeak(text: string): string[] {
  const results: string[] = [];
  const re = /```json\s*\n\{"speak":"([^"]+)"\}\s*```/g;
  let m;
  while ((m = re.exec(text))) {
    results.push(m[1]);
  }
  // Fallback: if no speak blocks, show non-JSON text
  if (results.length === 0) {
    const cleaned = text.replace(/```json[\s\S]*?```/g, "").trim();
    if (cleaned) results.push(cleaned);
  }
  return results;
}

export function getSpeakHistory(): string[] { return [...speakHistory]; }

export default consoleModule;
