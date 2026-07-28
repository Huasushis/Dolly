/**
 * H1c: Forward block 展开测试
 * @integration
 * 测试 LLM extension 的 forward 引用展开功能
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { config as loadEnv } from "dotenv";
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
  !!process.env.AETHER_API_KEY;

describe.skipIf(!liveEnabled)("Integration: Forward Expand @integration", () => {
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
    config: {},
  };

  const emptyPremises: PremiseCollection = { upstream: [], downstream: [] };

  beforeAll(async () => {
    const llmExtension = (await import("../../extensions/llm/index.js")).default;
    llmModule = llmExtension.createModule({
      id: "test-llm-forward",
      config: {
        llm: {
          base_url: process.env.AETHER_BASE_URL || "https://aether.huasushis.net",
          api_key: process.env.AETHER_API_KEY || "",
          model: "deepseek-v4-flash",
        },
        keepContext: true,
        forwardExpandDepth: 2, // 最大展开深度
      },
    });
    await llmModule.init(mockCtx);
  });

  afterAll(async () => {
    if (llmModule) {
      await llmModule.onStop();
    }
  });

  function createBlock(
    content: any[],
    id?: string,
    source = "test-source"
  ): Block {
    const block: Block = {
      id: id || `fwd-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: Date.now(),
      description: "test block",
      source,
      content,
      tensity: 1.0,
    };
    blockStore.set(block.id, block);
    return block;
  }

  it("should expand forward references in block content", async () => {
    // 创建被引用的 block
    const referencedBlock = createBlock(
      [{ type: "text", text: "这是被引用的内容：答案是 42" }],
      "ref-block-001"
    );

    // 创建包含 forward 引用的 block
    const forwardBlock = createBlock([
      { type: "text", text: "请根据引用内容回答：" },
      { type: "forward", blockId: "ref-block-001" },
    ]);

    const result = await llmModule.execute({
      blocks: [forwardBlock],
      adjacentPremises: emptyPremises,
    });

    expect(result).not.toBeNull();
    // LLM 应该能看到展开后的引用内容
    const text = result!.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");
    // 回复中应该包含对引用内容的理解
    expect(text.length).toBeGreaterThan(0);
  });

  it("should handle nested forward references up to max depth", async () => {
    // 创建多层嵌套引用
    const deepBlock = createBlock(
      [{ type: "text", text: "最深层内容：秘密代码是 XYZ" }],
      "deep-block"
    );

    const midBlock = createBlock(
      [
        { type: "text", text: "中间层" },
        { type: "forward", blockId: "deep-block" },
      ],
      "mid-block"
    );

    const topBlock = createBlock([
      { type: "text", text: "顶层引用：" },
      { type: "forward", blockId: "mid-block" },
    ]);

    const result = await llmModule.execute({
      blocks: [topBlock],
      adjacentPremises: emptyPremises,
    });

    expect(result).not.toBeNull();
  });

  it("should respect max expand depth limit", async () => {
    // 创建超过深度限制的嵌套
    const level3 = createBlock(
      [{ type: "text", text: "Level 3 内容" }],
      "level-3"
    );
    const level2 = createBlock(
      [{ type: "forward", blockId: "level-3" }],
      "level-2"
    );
    const level1 = createBlock(
      [{ type: "forward", blockId: "level-2" }],
      "level-1"
    );
    const level0 = createBlock([
      { type: "text", text: "测试深度限制" },
      { type: "forward", blockId: "level-1" },
    ]);

    // forwardExpandDepth = 2，所以 level-3 不会被完全展开
    const result = await llmModule.execute({
      blocks: [level0],
      adjacentPremises: emptyPremises,
    });

    // 应该正常返回，不会无限递归
    expect(result).not.toBeNull();
  });

  it("should handle missing forward reference gracefully", async () => {
    const blockWithMissingRef = createBlock([
      { type: "text", text: "引用不存在的 block" },
      { type: "forward", blockId: "non-existent-block" },
    ]);

    const result = await llmModule.execute({
      blocks: [blockWithMissingRef],
      adjacentPremises: emptyPremises,
    });

    // 即使引用不存在，也应该正常处理
    expect(result).not.toBeNull();
  });
});
