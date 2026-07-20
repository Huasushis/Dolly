import { defineExtension } from "../../src/sdk/index.js";
import type { Module, ModuleContext, DollyExtension } from "../../src/sdk/types.js";
import type { RawBlock, ExecuteInput } from "../../src/core/types.js";
import { WebSocketServer, WebSocket } from "ws";

/** 待处理的用户输入 */
interface PendingInput {
  text: string;
  images?: string[];
}

/** WebSocket 消息协议 */
interface WsIncomingMessage {
  type: "user_input";
  text?: string;
  images?: string[];
}

class ConsoleModule implements Module {
  id: string;
  private wss: WebSocketServer | null = null;
  private pendingInputs: PendingInput[] = [];
  private port: number;
  private clients: Set<WebSocket> = new Set();
  private ctx: ModuleContext | null = null;
  private messageHistory: Array<{ direction: string; payload: unknown }> = [];
  private historyLimit: number;

  constructor(id: string, config: Record<string, unknown>) {
    this.id = id;
    this.port = (config.port as number) ?? 3000;
    this.historyLimit = (config.historyLimit as number) ?? 100;
  }

  async init(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    this.wss = new WebSocketServer({ port: this.port });

    this.wss.on("connection", (ws: WebSocket) => {
      this.clients.add(ws);
      ctx.logger.info(`Console: client connected (total: ${this.clients.size})`);

      // 发送历史消息
      ws.send(JSON.stringify({ type: "history", messages: this.messageHistory }));

      ws.on("message", (data: Buffer | string) => {
        try {
          const msg = JSON.parse(data.toString()) as WsIncomingMessage;
          if (msg.type === "user_input" && msg.text) {
            this.pendingInputs.push({
              text: msg.text,
              images: msg.images,
            });
            this.pushHistory("incoming", msg);
            ctx.logger.info(`Console: user input queued: "${msg.text.slice(0, 50)}"`);
          }
        } catch {
          ctx.logger.warn("Console: invalid JSON from client");
        }
      });

      ws.on("close", () => {
        this.clients.delete(ws);
        ctx.logger.info(`Console: client disconnected (total: ${this.clients.size})`);
      });
    });

    ctx.logger.info(`Console WebSocket server listening on port ${this.port}`);
  }

  async execute(input: ExecuteInput): Promise<RawBlock | null> {
    // 1. 将输入 blocks 中非自身来源的内容推送给 WebSocket 客户端
    for (const block of input.blocks) {
      if (block.source === this.id) continue;

      const hasDisplayable = block.content.some(
        (item: { type?: string }) => item.type === "text" || item.type === "image",
      );
      if (!hasDisplayable) continue;

      const payload = {
        type: "incoming",
        source: block.source,
        content: block.content,
      };

      this.pushHistory("outgoing", payload);
      this.broadcast(payload);
    }

    // 2. 从待发送队列取出一条用户输入作为返回值
    const pending = this.pendingInputs.shift();
    if (!pending) return null;

    const content: Array<Record<string, unknown>> = [
      { type: "text", text: pending.text },
    ];

    if (pending.images) {
      for (const img of pending.images) {
        content.push({ type: "image", base64: img });
      }
    }

    return {
      description: `User input: ${pending.text.slice(0, 50)}`,
      source: this.id,
      content,
    };
  }

  getInputPremise(): string {
    return "I receive text messages and optional images from external users via WebSocket.";
  }

  getOutputPremise(): string {
    return (
      "I forward displayable content to connected WebSocket clients. " +
      'To display text to users, include { type: "text", text: "..." } in your output block content.'
    );
  }

  async onStop(): Promise<void> {
    if (this.wss) {
      // 关闭所有客户端连接
      for (const ws of this.clients) {
        ws.close();
      }
      this.clients.clear();

      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      this.wss = null;
    }
  }

  // ---- private helpers ----

  private broadcast(payload: unknown): void {
    const raw = JSON.stringify(payload);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(raw);
      }
    }
  }

  private pushHistory(direction: string, payload: unknown): void {
    this.messageHistory.push({ direction, payload });
    if (this.messageHistory.length > this.historyLimit) {
      this.messageHistory.shift();
    }
  }
}

// ---- Extension 定义 ----

const consoleExtension: DollyExtension = {
  name: "console",
  version: "0.1.0",
  description: "Web chat interface for external communication via WebSocket",

  createModule({ id, config }: { id: string; config: Record<string, unknown> }): Module {
    return new ConsoleModule(id, config);
  },
};

export default defineExtension(consoleExtension);
