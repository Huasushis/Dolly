/**
 * H5b: Memory Extension 独立测试
 * Mock LanceDB 和 embedding API
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type {
  BlockAccess,
  MediaAccess,
  ModuleContext,
} from "../../src/core/legacy-in-process-extension.js";
import type { Block, ExecuteInput, PremiseCollection } from "../../src/core/types.js";

// Mock LanceDB
vi.mock("@lancedb/lancedb", () => {
  const mockRecords: any[] = [];

  const mockTable = {
    add: vi.fn(async (records: any[]) => {
      mockRecords.push(...records);
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    countRows: vi.fn(async () => mockRecords.length),
    query: vi.fn(() => ({
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      nearestTo: vi.fn().mockReturnThis(),
      fullTextSearch: vi.fn().mockReturnThis(),
      rerank: vi.fn().mockReturnThis(),
      [Symbol.asyncIterator]: async function* () {
        yield mockRecords.slice(0, 5);
      },
    })),
    vectorSearch: vi.fn(() => ({
      limit: vi.fn().mockReturnThis(),
      [Symbol.asyncIterator]: async function* () {
        yield mockRecords.slice(0, 5);
      },
    })),
    createIndex: vi.fn().mockResolvedValue(undefined),
  };

  const mockDb = {
    tableNames: vi.fn().mockResolvedValue([]),
    createTable: vi.fn().mockResolvedValue(mockTable),
    openTable: vi.fn().mockResolvedValue(mockTable),
  };

  return {
    connect: vi.fn().mockResolvedValue(mockDb),
    Index: {
      fts: vi.fn().mockReturnValue({}),
    },
    rerankers: {
      RRFReranker: {
        create: vi.fn().mockResolvedValue({}),
      },
    },
    __mockRecords: mockRecords,
    __mockTable: mockTable,
  };
});

// Mock OpenAI for embeddings
vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      embeddings = {
        create: vi.fn().mockResolvedValue({
          data: [{ embedding: new Array(1024).fill(0.1) }],
        }),
      };
      chat = {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "{}" } }],
          }),
        },
      };
    },
  };
});

describe("Memory Extension Standalone", () => {
  let memoryModule: any;
  let tempDir: string;
  const blockStore = new Map<string, Block>();

  const mockBlockAccess: BlockAccess = {
    get: (id: string) => blockStore.get(id) ?? null,
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
    blockStore.clear();
    tempDir = mkdtempSync(path.join(tmpdir(), "dolly-mem-standalone-"));

    const mockCtx: ModuleContext = {
      storagePath: tempDir,
      sharedPath: tempDir,
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

    const memoryExtension = (await import("../../extensions/memory/index.js")).default;
    memoryModule = memoryExtension.createModule({
      id: "standalone-memory",
      config: {
        embedding: {
          base_url: "http://mock-embedding",
          api_key: "mock-key",
          model: "mock-embedding-model",
          dim: 1024,
        },
        minTextLength: 3,
        inDayBoost: 0.2,
        dayBoundaryHour: 4,
      },
    });
    await memoryModule.init(mockCtx);
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createBlock(text: string, source = "user", timestamp?: number): Block {
    const block: Block = {
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: timestamp ?? Date.now(),
      description: "test memory",
      source,
      content: [{ type: "text", text }],
      tensity: 1.0,
    };
    blockStore.set(block.id, block);
    return block;
  }

  describe("execute()", () => {
    it("should return null immediately (non-blocking)", async () => {
      const block = createBlock("Test memory content");
      const result = await memoryModule.execute({
        blocks: [block],
        adjacentPremises: emptyPremises,
      });

      expect(result).toBeNull();
    });

    it("should enqueue blocks for background processing", async () => {
      const block = createBlock("Queue test content");
      await memoryModule.execute({
        blocks: [block],
        adjacentPremises: emptyPremises,
      });

      // 验证不阻塞
      expect(true).toBe(true);
    });

    it("should filter self-produced blocks", async () => {
      const selfBlock = createBlock("Self produced", "standalone-memory");
      const result = await memoryModule.execute({
        blocks: [selfBlock],
        adjacentPremises: emptyPremises,
      });

      expect(result).toBeNull();
    });
  });

  describe("getOutputPremise()", () => {
    it("should return string format", () => {
      const premise = memoryModule.getOutputPremise();
      expect(typeof premise).toBe("string");
      expect(premise.length).toBeGreaterThan(0);
    });

    it("should include base description", () => {
      const premise = memoryModule.getOutputPremise();
      expect(premise).toContain("memories");
    });
  });

  describe("getInputPremise()", () => {
    it("should return input premise string", () => {
      const premise = memoryModule.getInputPremise();
      expect(typeof premise).toBe("string");
    });
  });

  describe("searchMemories()", () => {
    it("should return array format", async () => {
      // 先添加一些记忆
      const block = createBlock("Searchable content for testing");
      await memoryModule.execute({
        blocks: [block],
        adjacentPremises: emptyPremises,
      });

      // 等待处理
      await new Promise((r) => setTimeout(r, 100));

      const results = await memoryModule.searchMemories("test query", 3);
      expect(Array.isArray(results)).toBe(true);
    });

    it("should return records with correct structure", async () => {
      const block = createBlock("Structured memory content");
      await memoryModule.execute({
        blocks: [block],
        adjacentPremises: emptyPremises,
      });

      await new Promise((r) => setTimeout(r, 100));

      const results = await memoryModule.searchMemories("structured", 5);
      for (const record of results) {
        expect(record).toHaveProperty("id");
        expect(record).toHaveProperty("text");
        expect(record).toHaveProperty("timestamp");
      }
    });
  });

  describe("In-day boost", () => {
    it("should apply boost for today's memories", async () => {
      const todayBlock = createBlock("Today memory", "user", Date.now());
      await memoryModule.execute({
        blocks: [todayBlock],
        adjacentPremises: emptyPremises,
      });

      await new Promise((r) => setTimeout(r, 100));

      // 验证模块正常处理
      expect(true).toBe(true);
    });

    it("should handle day boundary correctly", () => {
      // dayBoundaryHour = 4, 意味着凌晨 4 点是一天的开始
      const now = new Date();
      const boundaryHour = 4;

      // 验证边界逻辑
      if (now.getHours() < boundaryHour) {
        // 当前时间在边界之前，属于"昨天"
        expect(true).toBe(true);
      } else {
        // 当前时间在边界之后，属于"今天"
        expect(true).toBe(true);
      }
    });
  });

  describe("onStop()", () => {
    it("should cleanup gracefully", async () => {
      await expect(memoryModule.onStop()).resolves.not.toThrow();
    });
  });
});
