/**
 * H1a: Console→LLM→Console 对话测试
 * @integration
 * 使用真实 API 进行 LLM 对话测试
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { config as loadEnv } from "dotenv";
import type {
  BlockAccess,
  MediaAccess,
  ModuleContext,
} from "../../src/core/legacy-in-process-extension.js";
import type { Block, ExecuteInput, PremiseCollection } from "../../src/core/types.js";

// 加载环境变量
loadEnv();

const liveEnabled =
  process.env.RUN_LIVE_INTEGRATION === "1" &&
  process.env.RUN_PAID_INTEGRATION === "1" &&
  !!process.env.AETHER_API_KEY;

describe.skipIf(!liveEnabled)("Integration: LLM Conversation @integration", () => {
  vi.setConfig({ testTimeout: 120000 });
  let llmModule: any;
  const blockStore = new Map<string, Block>();

  const mockBlockAccess: BlockAccess = {
    get: (id: string) => blockStore.get(id) ?? null,
    acquire: () => {},
    release: () => {},
  };

  const mockMediaAccess: MediaAccess = {
    get: async () => Buffer.from(""),
    crop: async () => "mock-cropped-id",
  };

  const mockCtx: ModuleContext = {
    storagePath: "./test-storage",
    sharedPath: "./test-shared",
    media: mockMediaAccess,
    blocks: mockBlockAccess,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    config: {
      llm: {
        aether: {
          base_url: process.env.AETHER_BASE_URL || "https://aether.huasushis.net",
          api_key: process.env.AETHER_API_KEY || "",
          model: "deepseek-v4-flash",
        },
      },
    },
  };

  const emptyPremises: PremiseCollection = { upstream: [], downstream: [] };

  beforeAll(async () => {
    // 动态导入 LLM extension
    const llmExtension = (await import("../../extensions/llm/index.js")).default;
    llmModule = llmExtension.createModule({
      id: "test-llm",
      config: {
        llm: {
          base_url: process.env.AETHER_BASE_URL || "https://aether.huasushis.net",
          api_key: process.env.AETHER_API_KEY || "",
          model: "deepseek-v4-flash",
        },
        keepContext: true,
        maxContextEntries: 10,
      },
    });
    await llmModule.init(mockCtx);
  });

  afterAll(async () => {
    if (llmModule) {
      await llmModule.onStop();
    }
  });

  function createInputBlock(text: string, id?: string): Block {
    const block: Block = {
      id: id || `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: Date.now(),
      description: "user input",
      source: "console",
      content: [{ type: "text", text }],
      tensity: 1.0,
    };
    blockStore.set(block.id, block);
    return block;
  }

  it("should return valid JSON Block format", async () => {
    const input = createInputBlock("你好，请简单介绍一下你自己");
    const executeInput: ExecuteInput = {
      blocks: [input],
      adjacentPremises: emptyPremises,
    };

    const result = await llmModule.execute(executeInput);

    expect(result).not.toBeNull();
    expect(result).toHaveProperty("description");
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("source");
    expect(Array.isArray(result!.content)).toBe(true);
    expect(typeof result!.description).toBe("string");
    expect(result!.source).toBe("test-llm");
  });

  it("should handle 3-round conversation with context continuity", async () => {
    // 第 1 轮：设定上下文
    const input1 = createInputBlock("请记住这个数字：42");
    const result1 = await llmModule.execute({
      blocks: [input1],
      adjacentPremises: emptyPremises,
    });
    expect(result1).not.toBeNull();

    // 第 2 轮：引用上下文
    const input2 = createInputBlock("我刚才让你记住的数字是什么？");
    const result2 = await llmModule.execute({
      blocks: [input2],
      adjacentPremises: emptyPremises,
    });
    expect(result2).not.toBeNull();
    // 验证回复中包含 42
    const text2 = result2!.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");
    expect(text2).toContain("42");

    // 第 3 轮：继续对话
    const input3 = createInputBlock("把这个数字乘以 2 是多少？");
    const result3 = await llmModule.execute({
      blocks: [input3],
      adjacentPremises: emptyPremises,
    });
    expect(result3).not.toBeNull();
    const text3 = result3!.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");
    expect(text3).toContain("84");
  });

  it("should have correct block content structure", async () => {
    const input = createInputBlock("说一句话测试");
    const result = await llmModule.execute({
      blocks: [input],
      adjacentPremises: emptyPremises,
    });

    expect(result).not.toBeNull();
    // 验证 content 数组中的元素格式
    for (const item of result!.content) {
      expect(item).toHaveProperty("type");
      if (item.type === "text") {
        expect(item).toHaveProperty("text");
        expect(typeof item.text).toBe("string");
      }
    }
  });
});
