/**
 * H5d: Console Extension 独立测试
 * Mock WebSocket server，测试消息收发
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import type {
  BlockAccess,
  MediaAccess,
  ModuleContext,
} from "../../src/core/legacy-in-process-extension.js";
import type { Block, PremiseCollection } from "../../src/core/types.js";

describe("Console Extension Standalone", () => {
  let consoleModule: any;
  let mockCtx: ModuleContext;
  const testPort = 3999; // 使用非标准端口避免冲突

  const mockBlockAccess: BlockAccess = {
    get: vi.fn().mockReturnValue(null),
    acquire: () => {},
    release: () => {},
  };

  const mockMediaAccess: MediaAccess = {
    get: vi.fn().mockResolvedValue(Buffer.from("")),
    crop: vi.fn().mockResolvedValue("cropped"),
  };

  const emptyPremises: PremiseCollection = { upstream: [], downstream: [] };

  beforeEach(async () => {
    vi.clearAllMocks();

    mockCtx = {
      storagePath: "./test-storage",
      sharedPath: "./test-shared",
      media: mockMediaAccess,
      blocks: mockBlockAccess,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      config: {},
    };

    const consoleExtension = (await import("../../extensions/console/index.js")).default;
    consoleModule = consoleExtension.createModule({
      id: "standalone-console",
      config: {
        port: testPort,
        historyLimit: 50,
      },
    });
    await consoleModule.init(mockCtx);
  });

  afterEach(async () => {
    if (consoleModule) {
      await consoleModule.onStop();
    }
  });

  function createBlock(content: any[], source = "external"): Block {
    return {
      id: `console-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: Date.now(),
      description: "test block",
      source,
      content,
      tensity: 1.0,
    };
  }

  describe("WebSocket connection", () => {
    it("should accept WebSocket connections", async () => {
      const ws = new WebSocket(`ws://localhost:${testPort}`);

      await new Promise<void>((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
        setTimeout(() => reject(new Error("Connection timeout")), 2000);
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it("should send history on connection", async () => {
      const ws = new WebSocket(`ws://localhost:${testPort}`);

      const historyMessage = await new Promise<any>((resolve, reject) => {
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "history") {
            resolve(msg);
          }
        });
        ws.on("error", reject);
        setTimeout(() => reject(new Error("Timeout")), 2000);
      });

      expect(historyMessage).toHaveProperty("type", "history");
      expect(historyMessage).toHaveProperty("messages");
      expect(Array.isArray(historyMessage.messages)).toBe(true);

      ws.close();
    });
  });

  describe("user input handling", () => {
    it("should queue user input from WebSocket", async () => {
      const ws = new WebSocket(`ws://localhost:${testPort}`);

      await new Promise<void>((resolve) => {
        ws.on("open", resolve);
      });

      // 发送用户输入
      ws.send(
        JSON.stringify({
          type: "user_input",
          text: "Hello from test",
        })
      );

      // 等待消息被处理
      await new Promise((r) => setTimeout(r, 100));

      // execute 应该返回用户输入
      const result = await consoleModule.execute({
        blocks: [],
        adjacentPremises: emptyPremises,
      });

      expect(result).not.toBeNull();
      expect(result!.content[0]).toHaveProperty("type", "text");
      expect(result!.content[0]).toHaveProperty("text", "Hello from test");

      ws.close();
    });

    it("should return null when no pending input", async () => {
      const result = await consoleModule.execute({
        blocks: [],
        adjacentPremises: emptyPremises,
      });

      expect(result).toBeNull();
    });

    it("should handle user input with images", async () => {
      const ws = new WebSocket(`ws://localhost:${testPort}`);

      await new Promise<void>((resolve) => {
        ws.on("open", resolve);
      });

      ws.send(
        JSON.stringify({
          type: "user_input",
          text: "Message with image",
          images: ["base64imagedata"],
        })
      );

      await new Promise((r) => setTimeout(r, 100));

      const result = await consoleModule.execute({
        blocks: [],
        adjacentPremises: emptyPremises,
      });

      expect(result).not.toBeNull();
      expect(result!.content.length).toBe(2);
      expect(result!.content[1]).toHaveProperty("type", "image");

      ws.close();
    });
  });

  describe("block broadcasting", () => {
    it("should broadcast displayable blocks to clients", async () => {
      const ws = new WebSocket(`ws://localhost:${testPort}`);

      await new Promise<void>((resolve) => {
        ws.on("open", resolve);
      });

      // 跳过 history 消息
      await new Promise((r) => setTimeout(r, 100));

      const receivedPromise = new Promise<any>((resolve) => {
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "incoming") {
            resolve(msg);
          }
        });
      });

      // 执行带有可显示内容的 block
      const block = createBlock([{ type: "text", text: "Broadcast test" }], "llm");
      await consoleModule.execute({
        blocks: [block],
        adjacentPremises: emptyPremises,
      });

      const received = await Promise.race([
        receivedPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 2000)),
      ]);

      expect(received).toHaveProperty("type", "incoming");
      expect(received).toHaveProperty("source", "llm");

      ws.close();
    });

    it("should not broadcast self-produced blocks", async () => {
      const ws = new WebSocket(`ws://localhost:${testPort}`);

      await new Promise<void>((resolve) => {
        ws.on("open", resolve);
      });

      await new Promise((r) => setTimeout(r, 100));

      let receivedIncoming = false;
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "incoming") {
          receivedIncoming = true;
        }
      });

      // 自身来源的 block 不应该被广播
      const selfBlock = createBlock(
        [{ type: "text", text: "Self block" }],
        "standalone-console"
      );
      await consoleModule.execute({
        blocks: [selfBlock],
        adjacentPremises: emptyPremises,
      });

      await new Promise((r) => setTimeout(r, 100));
      expect(receivedIncoming).toBe(false);

      ws.close();
    });
  });

  describe("premise", () => {
    it("should return input premise", () => {
      const premise = consoleModule.getInputPremise();
      expect(typeof premise).toBe("string");
      expect(premise).toContain("WebSocket");
    });

    it("should return output premise", () => {
      const premise = consoleModule.getOutputPremise();
      expect(typeof premise).toBe("string");
      expect(premise).toContain("WebSocket");
    });
  });

  describe("message format", () => {
    it("should create correct block from user input", async () => {
      const ws = new WebSocket(`ws://localhost:${testPort}`);

      await new Promise<void>((resolve) => {
        ws.on("open", resolve);
      });

      ws.send(
        JSON.stringify({
          type: "user_input",
          text: "Format test message",
        })
      );

      await new Promise((r) => setTimeout(r, 100));

      const result = await consoleModule.execute({
        blocks: [],
        adjacentPremises: emptyPremises,
      });

      expect(result).toHaveProperty("description");
      expect(result).toHaveProperty("source", "standalone-console");
      expect(result).toHaveProperty("content");
      expect(result!.description).toContain("Format test message");

      ws.close();
    });
  });
});
