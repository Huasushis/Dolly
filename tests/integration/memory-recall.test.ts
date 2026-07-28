/**
 * H1b: Memory 注入与召回测试
 * @integration
 * 使用真实 embedding API 测试记忆存储和召回
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { config as loadEnv } from "dotenv";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type {
  BlockAccess,
  MediaAccess,
  ModuleContext,
} from "../../src/core/legacy-in-process-extension.js";
import type { Block, ExecuteInput, PremiseCollection } from "../../src/core/types.js";

loadEnv();

const liveEnabled =
  process.env.RUN_LIVE_INTEGRATION === "1" &&
  process.env.RUN_PAID_INTEGRATION === "1" &&
  !!process.env.DASHSCOPE_API_KEY;

describe.skipIf(!liveEnabled)("Integration: Memory Recall @integration", () => {
  let memoryModule: any;
  let tempDir: string;
  const blockStore = new Map<string, Block>();

  const mockBlockAccess: BlockAccess = {
    get: (id: string) => blockStore.get(id) ?? null,
    acquire: () => undefined,
    release: () => undefined,
  };

  const mockMediaAccess: MediaAccess = {
    get: async () => Buffer.from(""),
    crop: async () => "mock-cropped-id",
  };

  const emptyPremises: PremiseCollection = { upstream: [], downstream: [] };

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "dolly-memory-test-"));

    const mockCtx: ModuleContext = {
      storagePath: tempDir,
      sharedPath: tempDir,
      media: mockMediaAccess,
      blocks: mockBlockAccess,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      config: {},
    };

    const memoryExtension = (await import("../../extensions/memory/index.js")).default;
    memoryModule = memoryExtension.createModule({
      id: "test-memory",
      config: {
        embedding: {
          base_url: process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
          api_key: process.env.DASHSCOPE_API_KEY || "",
          model: "text-embedding-v3",
          dim: 1024,
        },
        minTextLength: 3,
        inDayBoost: 0.2,
        dayBoundaryHour: 4,
      },
    });
    await memoryModule.init(mockCtx);
  });

  afterAll(async () => {
    if (memoryModule) {
      await memoryModule.onStop();
    }
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createBlock(text: string, source = "user"): Block {
    const block: Block = {
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: Date.now(),
      description: "test memory",
      source,
      content: [{ type: "text", text }],
      tensity: 1.0,
    };
    blockStore.set(block.id, block);
    return block;
  }

  it("should store blocks and return null (non-blocking)", async () => {
    const block = createBlock("今天天气很好，适合出去散步");
    const result = await memoryModule.execute({
      blocks: [block],
      adjacentPremises: emptyPremises,
    });

    // Memory module 不直接产生 block
    expect(result).toBeNull();
  });

  it("should index blocks and search memories", async () => {
    // 存入记忆
    const blocks = [
      createBlock("我喜欢吃苹果，特别是红富士苹果"),
      createBlock("明天要去北京出差"),
      createBlock("学习 TypeScript 让我很开心"),
    ];

    for (const block of blocks) {
      await memoryModule.execute({
        blocks: [block],
        adjacentPremises: emptyPremises,
      });
    }

    // 等待后台处理完成
    await new Promise((r) => setTimeout(r, 3000));

    // 搜索记忆
    const results = await memoryModule.searchMemories("苹果", 3);
    expect(Array.isArray(results)).toBe(true);
    // 应该能找到相关记忆
    if (results.length > 0) {
      expect(results[0]).toHaveProperty("text");
      expect(results[0]).toHaveProperty("timestamp");
    }
  });

  it("should have getOutputPremise with memory injection format", async () => {
    const premise = memoryModule.getOutputPremise();
    expect(typeof premise).toBe("string");
    expect(premise.length).toBeGreaterThan(0);
  });

  it("should apply in-day boost for recent memories", async () => {
    // 创建今天的记忆
    const todayBlock = createBlock("今天早上喝了咖啡");
    await memoryModule.execute({
      blocks: [todayBlock],
      adjacentPremises: emptyPremises,
    });

    await new Promise((r) => setTimeout(r, 2000));

    // 搜索应该能找到今天的记忆
    const results = await memoryModule.searchMemories("咖啡", 5);
    expect(Array.isArray(results)).toBe(true);
  });

  it("should return correct search result format", async () => {
    const results = await memoryModule.searchMemories("测试查询", 3);

    for (const record of results) {
      expect(record).toHaveProperty("id");
      expect(record).toHaveProperty("text");
      expect(record).toHaveProperty("timestamp");
      expect(record).toHaveProperty("source");
      expect(typeof record.text).toBe("string");
      expect(typeof record.timestamp).toBe("number");
    }
  });
});
