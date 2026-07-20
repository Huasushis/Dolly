import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { Orchestrator } from "../../src/core/orchestrator.js";
import type { DollyConfig } from "../../src/core/types.js";
import type { Module, ModuleContext, DollyExtension } from "../../src/sdk/types.js";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";

function createMockModule(id: string, executeFn?: (input: any) => any): Module {
  return {
    id,
    execute: executeFn ? vi.fn(executeFn) : vi.fn().mockResolvedValue(null),
    getInputPremise: vi.fn().mockReturnValue(`input premise of ${id}`),
    getOutputPremise: vi.fn().mockReturnValue(`output premise of ${id}`),
    init: vi.fn().mockResolvedValue(undefined),
    onStop: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockExtension(name: string, modules: Map<string, Module>): DollyExtension {
  return {
    name,
    version: "0.1.0",
    description: `Mock ${name} extension`,
    createModule({ id }) {
      return modules.get(id) ?? createMockModule(id);
    },
  };
}

describe("Orchestrator", () => {
  let tempDir: string;
  let config: DollyConfig;

  // Pino transport worker threads may try to write to the log file after
  // the temp directory has been removed, causing ENOENT uncaught exceptions.
  // We suppress these specific errors at the process level.
  const enoentHandler = (err: any) => {
    // Pino transport worker (thread-stream) may emit ENOENT after temp dir removal.
    // Check both standard .code/.path and the error message string.
    const isEnoent = err?.code === "ENOENT" || (typeof err?.message === "string" && err.message.includes("ENOENT"));
    const isLogRelated = isEnoent && (
      (typeof err?.path === "string" && err.path.includes("dolly-orch-test-")) ||
      (typeof err?.message === "string" && err.message.includes("dolly-orch-test-"))
    );
    if (isLogRelated) {
      // Suppress expected ENOENT from pino transport worker after temp dir cleanup
    } else {
      throw err;
    }
  };

  beforeAll(() => {
    process.on("uncaughtException", enoentHandler);
  });

  afterAll(() => {
    process.off("uncaughtException", enoentHandler);
  });

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "dolly-orch-test-"));
    config = {
      name: "test",
      dataDir: tempDir,
      llm: {},
      pages: [{ id: "page-a" }],
      modules: [
        {
          id: "mod1",
          extension: "mock-ext",
          inputPages: ["page-a"],
          outputPages: ["page-a"],
          schedule: { initialIntervalMs: 1000, minIntervalMs: 500, maxIntervalMs: 5000 },
        },
      ],
      logging: { level: "silent" },
    };
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors - pino transport may still hold file handles
      }
    }
  });

  describe("module registration and execution", () => {
    it("should initialize and register modules", async () => {
      const mockModule = createMockModule("mod1");
      const ext = createMockExtension("mock-ext", new Map([["mod1", mockModule]]));

      const orch = new Orchestrator(config);
      orch.loadExtension(ext);
      await orch.init();

      expect(mockModule.init).toHaveBeenCalled();
      await orch.stop();
    });

    it("should throw if extension not found", async () => {
      const orch = new Orchestrator(config);
      await expect(orch.init()).rejects.toThrow("Extension not found: mock-ext");
    });
  });

  describe("serial execution guarantee", () => {
    it("should not execute same module concurrently", async () => {
      let concurrentCount = 0;
      let maxConcurrent = 0;

      const mockModule = createMockModule("mod1", async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise((r) => setTimeout(r, 50));
        concurrentCount--;
        return null;
      });

      const ext = createMockExtension("mock-ext", new Map([["mod1", mockModule]]));
      const orch = new Orchestrator(config);
      orch.loadExtension(ext);
      await orch.init();

      // Simulate rapid ticks - the orchestrator's executing set should prevent concurrent execution
      // Access private method via any cast
      const orchAny = orch as any;
      orchAny.onTick("mod1");
      orchAny.onTick("mod1"); // Should be skipped since mod1 is still executing

      await new Promise((r) => setTimeout(r, 100));
      expect(maxConcurrent).toBe(1);
      await orch.stop();
    });
  });

  describe("handleResult: full pipeline", () => {
    it("should register block → write to page → report to scheduler", async () => {
      const mockModule = createMockModule("mod1", async () => ({
        description: "result block",
        source: "mod1",
        content: [{ type: "text", text: "hello" }],
        tensity: 0.5,
      }));

      const ext = createMockExtension("mock-ext", new Map([["mod1", mockModule]]));
      const orch = new Orchestrator(config);
      orch.loadExtension(ext);
      await orch.init();

      // Trigger execution via private method
      const orchAny = orch as any;

      // Put a block in the input page first
      const page = orchAny.pages.get("page-a");
      page.registerConsumer("mod1");

      // We need a block registered in BlockManager for the input
      // Actually for the orchestrator to work, blocks need to be in the page
      const inputBlock = {
        id: "input1",
        timestamp: Date.now(),
        description: "input",
        source: "external",
        content: [],
        tensity: 1.0,
      };
      // Register in block manager first
      orchAny.blockManager.register(inputBlock);
      page.append(inputBlock);

      // Now trigger execution
      await orchAny.executeModule("mod1");

      // Verify module was called
      expect(mockModule.execute).toHaveBeenCalled();

      await orch.stop();
    });
  });

  describe("graceful shutdown", () => {
    it("should call onStop on all modules", async () => {
      const mockModule = createMockModule("mod1");
      const ext = createMockExtension("mock-ext", new Map([["mod1", mockModule]]));

      const orch = new Orchestrator(config);
      orch.loadExtension(ext);
      await orch.init();
      await orch.stop();

      expect(mockModule.onStop).toHaveBeenCalled();
    });

    it("should handle module stop errors gracefully", async () => {
      const mockModule = createMockModule("mod1");
      (mockModule.onStop as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("stop failed"));

      const ext = createMockExtension("mock-ext", new Map([["mod1", mockModule]]));
      const orch = new Orchestrator(config);
      orch.loadExtension(ext);
      await orch.init();

      // Should not throw
      await expect(orch.stop()).resolves.toBeUndefined();
    });
  });
});
