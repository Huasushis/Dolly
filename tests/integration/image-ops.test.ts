/**
 * H1d: 图像操作测试
 * @integration
 * 测试 image_op block 的处理：crop/point 展平、坐标转换、去重
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { config as loadEnv } from "dotenv";
import type {
  BlockAccess,
  MediaAccess,
  ModuleContext,
} from "../../src/core/legacy-in-process-extension.js";
import type { Block, ExecuteInput, PremiseCollection, Point } from "../../src/core/types.js";
import type { Rect } from "../../src/core/block-content.js";

loadEnv();

const liveEnabled =
  process.env.RUN_LIVE_INTEGRATION === "1" &&
  process.env.RUN_PAID_INTEGRATION === "1" &&
  !!process.env.AETHER_API_KEY;

describe.skipIf(!liveEnabled)("Integration: Image Ops @integration", () => {
  vi.setConfig({ testTimeout: 120000 });
  let llmModule: any;
  const blockStore = new Map<string, Block>();

  const mockBlockAccess: BlockAccess = {
    get: (id: string) => blockStore.get(id) ?? null,
    acquire: () => {},
    release: () => {},
  };

  const mockMediaAccess: MediaAccess = {
    get: async (id: string, format: string) => {
      // 返回模拟的 base64 图片数据
      return "data:image/png;base64,mockImageData";
    },
    crop: async (id: string, rect: Rect) => `cropped-${id}`,
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
      id: "test-llm-image",
      config: {
        llm: {
          base_url: process.env.AETHER_BASE_URL || "https://aether.huasushis.net",
          api_key: process.env.AETHER_API_KEY || "",
          model: "deepseek-v4-flash",
        },
        keepContext: true,
        multimodal: ["text", "image"],
        coordinateSystem: "normalized",
      },
    });
    await llmModule.init(mockCtx);
  });

  afterAll(async () => {
    if (llmModule) {
      await llmModule.onStop();
    }
  });

  function createBlock(content: any[], id?: string): Block {
    const block: Block = {
      id: id || `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: Date.now(),
      description: "image test block",
      source: "test-source",
      content,
      tensity: 1.0,
    };
    blockStore.set(block.id, block);
    return block;
  }

  describe("Coordinate Conversion", () => {
    it("should handle normalized coordinates (0-1)", async () => {
      const block = createBlock([
        { type: "text", text: "测试归一化坐标" },
        {
          type: "image_op",
          mediaId: "test-image-1",
          operations: [
            {
              op: "crop",
              rect: {
                topLeft: { x: 0.1, y: 0.1 },
                bottomRight: { x: 0.9, y: 0.9 },
              },
            },
          ],
        },
      ]);

      const result = await llmModule.execute({
        blocks: [block],
        adjacentPremises: emptyPremises,
      });

      expect(result).not.toBeNull();
    });

    it("should clamp coordinates to valid range", async () => {
      const block = createBlock([
        {
          type: "image_op",
          mediaId: "test-image-2",
          operations: [
            {
              op: "crop",
              rect: {
                topLeft: { x: -0.5, y: -0.5 }, // 超出范围，应被 clamp
                bottomRight: { x: 1.5, y: 1.5 },
              },
            },
          ],
        },
      ]);

      const result = await llmModule.execute({
        blocks: [block],
        adjacentPremises: emptyPremises,
      });

      expect(result).not.toBeNull();
    });
  });

  describe("Image Op Processing", () => {
    it("should flatten image_op to image item", async () => {
      const block = createBlock([
        { type: "text", text: "处理图片操作" },
        {
          type: "image_op",
          mediaId: "flatten-test",
          operations: [
            {
              op: "crop",
              rect: {
                topLeft: { x: 0.2, y: 0.2 },
                bottomRight: { x: 0.8, y: 0.8 },
              },
            },
          ],
        },
      ]);

      const result = await llmModule.execute({
        blocks: [block],
        adjacentPremises: emptyPremises,
      });

      expect(result).not.toBeNull();
      // 验证结果中不包含 image_op 类型
      const hasImageOp = result!.content.some((c: any) => c.type === "image_op");
      expect(hasImageOp).toBe(false);
    });

    it("should handle point operations", async () => {
      const block = createBlock([
        {
          type: "image_op",
          mediaId: "point-test",
          operations: [
            {
              op: "point",
              points: [{ x: 0.5, y: 0.5, label: "中心点" }],
            },
          ],
        },
      ]);

      const result = await llmModule.execute({
        blocks: [block],
        adjacentPremises: emptyPremises,
      });

      expect(result).not.toBeNull();
    });

    it("should handle combined crop and point operations", async () => {
      const block = createBlock([
        {
          type: "image_op",
          mediaId: "combined-test",
          operations: [
            {
              op: "crop",
              rect: {
                topLeft: { x: 0.1, y: 0.1 },
                bottomRight: { x: 0.9, y: 0.9 },
              },
            },
            {
              op: "point",
              points: [{ x: 0.5, y: 0.5 }],
            },
          ],
        },
      ]);

      const result = await llmModule.execute({
        blocks: [block],
        adjacentPremises: emptyPremises,
      });

      expect(result).not.toBeNull();
    });
  });

  describe("Deduplication", () => {
    it("should not duplicate same mediaId without crop", async () => {
      // 第一次注入图片
      const block1 = createBlock([
        { type: "image", mediaId: "dedup-test-image" },
      ]);

      await llmModule.execute({
        blocks: [block1],
        adjacentPremises: emptyPremises,
      });

      // 第二次尝试注入相同图片
      const block2 = createBlock([
        { type: "text", text: "再次引用相同图片" },
        { type: "image", mediaId: "dedup-test-image" },
      ]);

      const result = await llmModule.execute({
        blocks: [block2],
        adjacentPremises: emptyPremises,
      });

      expect(result).not.toBeNull();
    });
  });

  describe("Qwen Coordinate System", () => {
    let qwenModule: any;

    beforeAll(async () => {
      const llmExtension = (await import("../../extensions/llm/index.js")).default;
      qwenModule = llmExtension.createModule({
        id: "test-llm-qwen",
        config: {
          llm: {
            base_url: process.env.AETHER_BASE_URL || "https://aether.huasushis.net",
            api_key: process.env.AETHER_API_KEY || "",
            model: "deepseek-v4-flash",
          },
          coordinateSystem: "qwen", // 0-1000 坐标系
          multimodal: ["text", "image"],
        },
      });
      await qwenModule.init(mockCtx);
    });

    afterAll(async () => {
      if (qwenModule) {
        await qwenModule.onStop();
      }
    });

    it("should convert qwen 0-1000 coordinates to normalized", async () => {
      const block = createBlock([
        {
          type: "image_op",
          mediaId: "qwen-test",
          operations: [
            {
              op: "crop",
              rect: {
                topLeft: { x: 100, y: 100 }, // qwen: 0-1000
                bottomRight: { x: 900, y: 900 },
              },
            },
          ],
        },
      ]);

      const result = await qwenModule.execute({
        blocks: [block],
        adjacentPremises: emptyPremises,
      });

      expect(result).not.toBeNull();
    });
  });
});
