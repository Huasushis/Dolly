import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { createServer, Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { DollyModule, ModuleContext } from "../../../src/modules/base.js";
import type { BlockChange, BlockMutation } from "../../../src/blocks/index.js";

interface ChatEntry { type: "user" | "speak"; text: string }
const chatHistory: ChatEntry[] = [];
const MAX_HISTORY = 200;
let storageFile = "";
let httpServer: Server | null = null;
let wss: WebSocketServer | null = null;
const wsClients = new Set<WebSocket>();
const tcpClients = new Set<any>();

const consoleModule: DollyModule = {
  id: "builtin/console",

  async init(ctx: ModuleContext) {
    storageFile = resolve(ctx.storagePath, "chat_history.json");
    if (!existsSync(ctx.storagePath)) mkdirSync(ctx.storagePath, { recursive: true });
    if (existsSync(storageFile)) {
      try {
        const saved = JSON.parse(readFileSync(storageFile, "utf-8"));
        for (const s of (saved.history ?? [])) {
          if (typeof s === "object" && s.type) chatHistory.push(s);
          else if (typeof s === "string") chatHistory.push(s.startsWith("> ") ? { type: "user", text: s.slice(2) } : { type: "speak", text: s });
        }
      } catch {}
    }

    // Send speak history to new relay clients and track them for broadcast
    ctx.on("client.connected", (p: any) => {
      tcpClients.add(p.socket);
      p.socket.on("close", () => tcpClients.delete(p.socket));
      for (const entry of chatHistory) { try { p.socket.write((entry.type === "user" ? "> " : "") + entry.text + "\n"); } catch {} }
    });

    // Start HTTP + WebSocket server
    const port = (ctx.config as any)["builtin/console"]?.port ?? 8080;
    try {
      const htmlPath = resolve(import.meta.dirname!, "web", "index.html");
      const html = existsSync(htmlPath) ? readFileSync(htmlPath, "utf-8") : "<h1>Dolly Console</h1>";

      httpServer = createServer((_req, res) => {
        const url = _req.url || "/";
        if (url === "/history") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ history: chatHistory }));
        } else {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        }
      });

      wss = new WebSocketServer({ server: httpServer });
      (wss as any).on?.("error", () => {}); // suppress WS errors on port conflict
      wss.on("connection", (ws) => {
        wsClients.add(ws);
        ws.send(JSON.stringify({ type: "status", text: "connected" }));
        ws.on("message", (data) => {
          try {
            const obj = JSON.parse(data.toString());
            if (obj.type === "input" && obj.text) {
              ctx.emit("console.input", { text: obj.text });
            }
          } catch {}
        });
        ws.on("close", () => wsClients.delete(ws));
      });

      httpServer.on("error", (err: any) => {
        if (err.code === "EADDRINUSE") {
          process.stderr.write(`[console] port ${port} busy, HTTP server skipped\n`);
          try { httpServer?.close(); } catch {}
          httpServer = null;
          wss = null;
        }
      });
      httpServer.listen(port, "0.0.0.0", () => {
        const addr = httpServer!.address() as any;
        process.stderr.write(`[console] Web UI: http://localhost:${addr?.port ?? port}\n`);
      });
    } catch (err: any) {
      process.stderr.write(`[console] HTTP server: ${err.message}\n`);
    }
  },

  systemPrompt(): string {
    return `你必须用 {"speak":"..."} 格式说话。不是建议，是必须。不放在 {"speak":"..."} 里面的内容用户完全看不到。
正确：{"speak":"你好"}
错误：你好（这样用户看不到）`;
  },

  async onStop(_c: ModuleContext) {
    if (storageFile) {
      try { writeFileSync(storageFile, JSON.stringify({ history: chatHistory })); } catch {}
    }
  },

  async handleCli(args: string[], _c: ModuleContext) {
    if (args[0] === "history") for (const s of chatHistory) process.stdout.write(s + "\n");
    else if (args[0] === "clear") { chatHistory.length = 0; process.stdout.write("cleared\n"); }
  },

  async onBlocksChanged(c: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    for (const ch of changes) {
      if (ch.type !== "added") continue;
      // Save outer blocks as user messages
      if (ch.block.type === "outer") {
        const text = ch.block.content;
        if (text.trim()) {
          chatHistory.push({ type: "user", text });
          if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
        }
      }
      // Parse inner blocks for speak output
      if (ch.block.type === "inner") {
        const speaks = parseSpeak(ch.block.content);
        for (const s of speaks) {
          chatHistory.push({ type: "speak", text: s });
          if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
          c.emit("speak", { text: s });
          for (const ws of wsClients) { try { ws.send(JSON.stringify({ type: "speak", text: s })); } catch {} }
          for (const s of tcpClients) { try { s.write(s + "\n"); } catch {} }
        }
      }
      if (storageFile && (ch.block.type === "inner" || ch.block.type === "outer")) {
        try { writeFileSync(storageFile, JSON.stringify({ history: chatHistory })); } catch {}
      }
    }
    return [];
  },
};

function parseSpeak(text: string): string[] {
  const results: string[] = [];
  // Primary: fenced JSON ```json\n{"speak":"..."}\n```
  const re = /```json\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && typeof obj.speak === "string") results.push(obj.speak);
    } catch {}
  }
  // Fallback: raw JSON {"speak":"..."} without fenced block (LLM sometimes skips fences)
  if (results.length === 0) {
    const jsonRe = /\{"speak"\s*:\s*"((?:[^"\\]|\\.)*)"\}/g;
    let jm;
    while ((jm = jsonRe.exec(text))) {
      try { results.push(JSON.parse(`{"speak":"${jm[1]}"}`).speak); } catch {}
    }
  }
  return results;
}

consoleModule.cliInfo = [
  { cmd: "console", sub: "", desc: "交互式终端" },
  { cmd: "console", sub: "history", desc: "显示 speak 历史" },
  { cmd: "console", sub: "clear", desc: "清除 speak 历史" },
];

export default consoleModule;
