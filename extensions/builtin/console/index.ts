import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { DollyModule, ModuleContext } from "../../../src/modules/base.js";
import type { BlockChange, BlockMutation } from "../../../src/blocks/index.js";

const speakHistory: string[] = [];
const MAX_HISTORY = 200;
let storageFile = "";

const consoleModule: DollyModule = {
  id: "builtin/console",

  async init(ctx: ModuleContext) {
    storageFile = resolve(ctx.storagePath, "speak_history.json");
    if (existsSync(storageFile)) {
      try {
        const saved = JSON.parse(readFileSync(storageFile, "utf-8"));
        for (const s of (saved.history ?? [])) speakHistory.push(s);
      } catch {}
    }
  },

  systemPrompt(): string {
    return `当你需要向用户展示内容时，使用 fenced JSON：
\`\`\`json
{"speak":"你要对用户说的话"}
\`\`\`
speak 之外的一切都是你的内心独白——不会被显示。`;
  },

  async onBlocksChanged(c: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    for (const ch of changes) {
      if (ch.type !== "added") continue;
      // Only parse inner blocks (LLM responses, etc.)
      if (ch.block.type !== "inner") continue;
      const speaks = parseSpeak(ch.block.content);
      for (const s of speaks) {
        speakHistory.push(s);
        if (speakHistory.length > MAX_HISTORY) speakHistory.shift();
        c.emit("speak", { text: s });
      }
      if (storageFile && speaks.length > 0) {
        try { writeFileSync(storageFile, JSON.stringify({ history: speakHistory })); } catch {}
      }
    }
    return [];
  },
};

function parseSpeak(text: string): string[] {
  const results: string[] = [];
  const re = /```json\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && typeof obj.speak === "string") results.push(obj.speak);
    } catch {}
  }
  if (results.length === 0) {
    const cleaned = text.replace(/```json[\s\S]*?```/g, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim();
    if (cleaned) results.push(cleaned);
  }
  return results;
}

export function getSpeakHistory(): string[] { return [...speakHistory]; }
export default consoleModule;
