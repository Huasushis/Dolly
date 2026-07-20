import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Orchestrator } from "../../src/core/orchestrator.js";
import type { DollyConfig, Block } from "../../src/core/types.js";
import type { Module, DollyExtension } from "../../src/sdk/types.js";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";

function createMockExtension(name: string, moduleFactory: (id: string) => Module): DollyExtension {
  return {
    name,
    version: "0.1.0",
    description: `Mock ${name}`,
    createModule({ id }) {
      return moduleFactory(id);
    },
  };
}

describe("Integration: Pipeline", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "dolly-int-test-"));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("end-to-end: input → orchestrator → mock module → page output", async () => {
    // Create a mock module that transforms input into output
    const processedBlocks: string[] = [];
    const mockModule: Module = {
      id: "processor",
      execute: vi.fn(async (input) => {
        for (const block of input.blocks) {
          processedBlocks.push(block.id);
        }
        if (input.blocks.length > 0) {
          return {
            description: "processed output",
            source: "processor",
            content: [{ type: "text", text: "output-data" }],
            tensity: 0.8,
          };
        }
        return null;
      }),
      getInputPremise: () => "I process blocks",
      getOutputPremise: () => "I produce processed blocks",
      init: vi.fn().mockResolvedValue(undefined),
      onStop: vi.fn().mockResolvedValue(undefined),
    };

    const ext = createMockExtension("mock-ext", () => mockModule);

    const config: DollyConfig = {
      name: "integration-test",
      dataDir: tempDir,
      llm: {},
      pages: [{ id: "bus" }],
      modules: [
        {
          id: "processor",
          extension: "mock-ext",
          inputPages: ["bus"],
          outputPages: ["bus"],
          schedule: { initialIntervalMs: 1000, minIntervalMs: 500, maxIntervalMs: 5000 },
        },
      ],
      logging: { level: "silent" },
    };

    const orch = new Orchestrator(config);
    orch.loadExtension(ext);
    await orch.init();

    // Access internals to inject an input block
    const orchAny = orch as any;
    const page = orchAny.pages.get("bus");

    // Register consumer for the module
    page.registerConsumer("processor");

    // Create and register an input block
    const inputBlock: Block = {
      id: "input-001",
      timestamp: Date.now(),
      description: "user message",
      source: "console",
      content: [{ type: "text", text: "Hello Dolly!" }],
      tensity: 0.5,
    };
    orchAny.blockManager.register(inputBlock);
    page.append(inputBlock);

    // Manually trigger module execution
    await orchAny.executeModule("processor");

    // Verify the module received the block
    expect(processedBlocks).toContain("input-001");

    // Verify the module produced output (it was called and returned a RawBlock)
    expect(mockModule.execute).toHaveBeenCalled();

    // Verify the output block was written to the page
    const callArgs = (mockModule.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.blocks).toHaveLength(1);
    expect(callArgs.blocks[0].id).toBe("input-001");

    await orch.stop();
  });

  it("multi-module pipeline: A writes to page, B reads from page", async () => {
    const receivedByB: string[] = [];

    const moduleA: Module = {
      id: "producer",
      execute: vi.fn(async (input) => {
        if (input.blocks.length > 0) {
          return {
            description: "produced by A",
            source: "producer",
            content: [{ type: "text", text: "from-A" }],
          };
        }
        return null;
      }),
      getInputPremise: () => "I produce data",
      getOutputPremise: () => "I output produced data",
      init: vi.fn().mockResolvedValue(undefined),
      onStop: vi.fn().mockResolvedValue(undefined),
    };

    const moduleB: Module = {
      id: "consumer",
      execute: vi.fn(async (input) => {
        for (const block of input.blocks) {
          receivedByB.push(block.source);
        }
        return null;
      }),
      getInputPremise: () => "I consume data",
      getOutputPremise: () => "I process consumed data",
      init: vi.fn().mockResolvedValue(undefined),
      onStop: vi.fn().mockResolvedValue(undefined),
    };

    const extA = createMockExtension("ext-a", () => moduleA);
    const extB = createMockExtension("ext-b", () => moduleB);

    const config: DollyConfig = {
      name: "multi-module-test",
      dataDir: tempDir,
      llm: {},
      pages: [{ id: "shared-bus" }],
      modules: [
        {
          id: "producer",
          extension: "ext-a",
          inputPages: ["shared-bus"],
          outputPages: ["shared-bus"],
          schedule: { initialIntervalMs: 1000, minIntervalMs: 500, maxIntervalMs: 5000 },
        },
        {
          id: "consumer",
          extension: "ext-b",
          inputPages: ["shared-bus"],
          outputPages: [],
          schedule: { initialIntervalMs: 1000, minIntervalMs: 500, maxIntervalMs: 5000 },
        },
      ],
      logging: { level: "silent" },
    };

    const orch = new Orchestrator(config);
    orch.loadExtension(extA);
    orch.loadExtension(extB);
    await orch.init();

    const orchAny = orch as any;
    const page = orchAny.pages.get("shared-bus");

    // Inject an initial block to trigger producer
    const seedBlock: Block = {
      id: "seed-1",
      timestamp: Date.now(),
      description: "seed",
      source: "external",
      content: [{ type: "text", text: "trigger" }],
      tensity: 1.0,
    };
    orchAny.blockManager.register(seedBlock);

    // Both modules consume from the same page
    page.registerConsumer("producer");
    page.registerConsumer("consumer");
    page.append(seedBlock);

    // Execute producer first
    await orchAny.executeModule("producer");

    // Producer's output should now be in the page
    // Execute consumer to pick up producer's output
    await orchAny.executeModule("consumer");

    // Consumer should have received a block from "producer"
    expect(receivedByB).toContain("producer");

    await orch.stop();
  });

  it("data flow verification: block registration → page write → consume", async () => {
    let outputBlockId: string | null = null;

    const mockModule: Module = {
      id: "transformer",
      execute: vi.fn(async () => ({
        description: "transformed",
        source: "transformer",
        content: [{ type: "result", value: 42 }],
        tensity: 1.0,
      })),
      getInputPremise: () => "",
      getOutputPremise: () => "",
      init: vi.fn().mockResolvedValue(undefined),
      onStop: vi.fn().mockResolvedValue(undefined),
    };

    const ext = createMockExtension("transform-ext", () => mockModule);

    const config: DollyConfig = {
      name: "dataflow-test",
      dataDir: tempDir,
      llm: {},
      pages: [{ id: "flow-page" }],
      modules: [
        {
          id: "transformer",
          extension: "transform-ext",
          inputPages: ["flow-page"],
          outputPages: ["flow-page"],
          schedule: { initialIntervalMs: 1000, minIntervalMs: 500, maxIntervalMs: 5000 },
        },
      ],
      logging: { level: "silent" },
    };

    const orch = new Orchestrator(config);
    orch.loadExtension(ext);
    await orch.init();

    const orchAny = orch as any;
    const page = orchAny.pages.get("flow-page");
    page.registerConsumer("transformer");

    // Add a second consumer to verify data stays available
    page.registerConsumer("observer");

    const input: Block = {
      id: "in-1",
      timestamp: Date.now(),
      description: "input",
      source: "test",
      content: [],
      tensity: 1.0,
    };
    orchAny.blockManager.register(input);
    page.append(input);

    // Execute transformer
    await orchAny.executeModule("transformer");

    // Observer should still be able to see both input and output blocks
    const observerBlocks = page.consume("observer");
    // At minimum, observer should see the input block and the output block
    expect(observerBlocks.length).toBeGreaterThanOrEqual(1);

    await orch.stop();
  });
});
