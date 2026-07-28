/**
 * H5a: LLM Extension 独立测试
 * 不需要完整 Dolly 框架，使用 Mock 依赖
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  BlockAccess,
  MediaAccess,
  ModuleContext,
} from "../../src/core/legacy-in-process-extension.js";
import type { Block, ExecuteInput, PremiseCollection, RawBlock } from "../../src/core/types.js";

// Mock OpenAI
vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    description: "Test response",
                    content: [{ type: "text", text: "Hello from mock LLM" }],
                    tensity: 0.8,
                  }),
                },
              },
            ],
          }),
        },
      };
      embeddings = {
        create: vi.fn().mockResolvedValue({
          data: [{ embedding: new Array(1536).fill(0.1) }],
        }),
      };
    },
  };
});

describe("LLM Extension Standalone", () => {
  let llmModule: any;
  let mockCtx: ModuleContext;
  const blockStore = new Map<string, Block>();

  const mockBlockAccess: BlockAccess = {
    get: (id: string) => blockStore.get(id) ?? null,
    acquire: () => {},
    release: () => {},
  };

  const mockMediaAccess: MediaAccess = {
    get: vi.fn().mockResolvedValue("data:image/png;base64,mock"),
    crop: vi.fn().mockResolvedValue("cropped-id"),
  };

  const emptyPremises: PremiseCollection = { upstream: [], downstream: [] };

  beforeEach(async () => {
    vi.clearAllMocks();
    blockStore.clear();

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

    const llmExtension = (await import("../../extensions/llm/index.js")).default;
    llmModule = llmExtension.createModule({
      id: "standalone-llm",
      config: {
        llm: {
          base_url: "http://mock-api",
          api_key: "mock-key",
          model: "mock-model",
        },
        keepContext: true,
      },
    });
    await llmModule.init(mockCtx);
  });

  function createBlock(text: string, source = "user"): Block {
    const block: Block = {
      id: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: Date.now(),
      description: "test block",
      source,
      content: [{ type: "text", text }],
      tensity: 1.0,
    };
    blockStore.set(block.id, block);
    return block;
  }

  describe("execute()", () => {
    it("should return RawBlock format", async () => {
      const block = createBlock("Hello");
      const result = await llmModule.execute({
        blocks: [block],
        adjacentPremises: emptyPremises,
      });

      expect(result).not.toBeNull();
      expect(result).toHaveProperty("description");
      expect(result).toHaveProperty("content");
      expect(result).toHaveProperty("source");
      expect(Array.isArray(result!.content)).toBe(true);
    });

    it("should return null for empty blocks", async () => {
      const result = await llmModule.execute({
        blocks: [],
        adjacentPremises: emptyPremises,
      });

      expect(result).toBeNull();
    });

    it("should set source to module id", async () => {
      const block = createBlock("Test");
      const result = await llmModule.execute({
        blocks: [block],
        adjacentPremises: emptyPremises,
      });

      expect(result!.source).toBe("standalone-llm");
    });
  });

  describe("JSON parsing", () => {
    it("should parse valid JSON response", async () => {
      const block = createBlock("Parse test");
      const result = await llmModule.execute({
        blocks: [block],
        adjacentPremises: emptyPremises,
      });

      expect(result).not.toBeNull();
      expect(result!.description).toBe("Test response");
    });

    it("should handle content array format", async () => {
      const block = createBlock("Content test");
      const result = await llmModule.execute({
        blocks: [block],
        adjacentPremises: emptyPremises,
      });

      expect(Array.isArray(result!.content)).toBe(true);
      expect(result!.content[0]).toHaveProperty("type", "text");
    });
  });

  describe("formatBlockContent", () => {
    it("should format text content", async () => {
      const block = createBlock("Simple text");
      const result = await llmModule.execute({
        blocks: [block],
        adjacentPremises: emptyPremises,
      });

      expect(result).not.toBeNull();
    });

    it("should handle forward references", async () => {
      const refBlock = createBlock("Referenced content");
      refBlock.id = "ref-001";
      blockStore.set("ref-001", refBlock);

      const block: Block = {
        id: "forward-test",
        timestamp: Date.now(),
        description: "forward test",
        source: "user",
        content: [
          { type: "text", text: "Before forward" },
          { type: "forward", blockId: "ref-001" },
        ],
        tensity: 1.0,
      };
      blockStore.set(block.id, block);

      const result = await llmModule.execute({
        blocks: [block],
        adjacentPremises: emptyPremises,
      });

      expect(result).not.toBeNull();
    });
  });

  describe("premise", () => {
    it("should return input premise", () => {
      const premise = llmModule.getInputPremise();
      expect(typeof premise).toBe("string");
      expect(premise.length).toBeGreaterThan(0);
    });

    it("should return output premise", () => {
      const premise = llmModule.getOutputPremise();
      expect(typeof premise).toBe("string");
      expect(premise.length).toBeGreaterThan(0);
    });
  });
});
