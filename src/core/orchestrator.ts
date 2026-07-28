import { Mutex } from "async-mutex";
import { randomUUID } from "crypto";
import path from "path";
import type {
  Block,
  RawBlock,
  ModuleConfig,
  DollyConfig,
  PremiseCollection,
  ExecuteInput,
} from "./types.js";
import { Page } from "./page.js";
import { Scheduler } from "./scheduler.js";
import { BlockManager } from "./block-manager.js";
import { MediaManager } from "./media.js";
import { EventBus } from "./events.js";
import type {
  DollyExtension,
  LLMClient,
  Module,
  ModuleContext,
} from "./legacy-in-process-extension.js";
import { createLogger, type Logger } from "./logger.js";
import OpenAI from "openai";

export class Orchestrator {
  private pages: Map<string, Page> = new Map();
  private modules: Map<string, Module> = new Map();
  private moduleConfigs: Map<string, ModuleConfig> = new Map();
  private extensions: Map<string, DollyExtension> = new Map();
  private scheduler: Scheduler;
  private blockManager: BlockManager;
  private mediaManager: MediaManager;
  private eventBus: EventBus;
  private logger: Logger;
  private running: boolean = false;
  private stopPromise: Promise<void> | undefined;
  private executing: Set<string> = new Set();
  private pageLocks: Map<string, Mutex> = new Map();
  private config: DollyConfig;
  /**
   * Tracks which block IDs each module has already processed (across all rounds).
   * Used to compute repeat_count: when a block appears again in a module's input,
   * its repeat_count is incremented.
   */
  private processedBlocks: Map<string, Set<string>> = new Map();

  constructor(config: DollyConfig) {
    this.config = config;
    this.eventBus = new EventBus();
    this.logger = createLogger({
      level: config.logging.level,
      logDir: path.join(config.dataDir, "logs"),
    });
    // Read OSS config from environment variables (optional, degrades to local storage)
    const ossConfig = process.env.OSS_ACCESS_KEY_ID && process.env.OSS_ACCESS_KEY_SECRET
      ? {
          accessKeyId: process.env.OSS_ACCESS_KEY_ID,
          accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
          endpoint: process.env.OSS_ENDPOINT ?? "oss-cn-shanghai.aliyuncs.com",
          bucket: process.env.OSS_BUCKET ?? "mydolly",
        }
      : undefined;
    this.mediaManager = new MediaManager(path.join(config.dataDir, "media"), ossConfig);
    this.blockManager = new BlockManager(this.mediaManager);
    this.scheduler = new Scheduler(
          (moduleId) => this.onTick(moduleId),
          (moduleId) => this.onTimeout(moduleId),
        );
  }

  /** 加载并注册 extension */
  loadExtension(ext: DollyExtension): void {
    this.extensions.set(ext.name, ext);
  }

  /** 初始化：创建 Page、实例化 Module、注册到 Scheduler、设置拓扑 */
  async init(): Promise<void> {
    try {
      await this.initialize();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    // 1. 创建 Pages
    for (const pageConfig of this.config.pages) {
      this.pages.set(pageConfig.id, new Page(pageConfig.id));
    }

    // 2. 为每个 module 创建锁
    for (const pageConfig of this.config.pages) {
      this.pageLocks.set(pageConfig.id, new Mutex());
    }

    // 3. 实例化 Modules 并注册到 Scheduler
    for (const moduleConfig of this.config.modules) {
      const ext = this.extensions.get(moduleConfig.extension);
      if (!ext) {
        throw new Error(`Extension not found: ${moduleConfig.extension}`);
      }

      const module = ext.createModule({
        id: moduleConfig.id,
        config: moduleConfig.config ?? {},
        inputPages: moduleConfig.inputPages,
        outputPages: moduleConfig.outputPages,
        schedule: moduleConfig.schedule,
      });

      // G5: optionally provide an LLM client from the first configured provider
      let llmClient: LLMClient | undefined;
      const providerNames = Object.keys(this.config.llm);
      if (providerNames.length > 0) {
        const provider = this.config.llm[providerNames[0]];
        const openai = new OpenAI({ baseURL: provider.base_url, apiKey: provider.api_key });
        llmClient = {
          chat: (messages, options) =>
            openai.chat.completions.create({
              model: provider.model,
              messages: messages as any,
              ...options,
            }),
        };
      }

      // G1: storage paths grouped by extension name
      // Spec: <dataDir>/exts/<ext-name>/<module-id>/  +  <dataDir>/exts/<ext-name>/ (shared)
      const ctx: ModuleContext = {
        storagePath: path.join(this.config.dataDir, "exts", moduleConfig.extension, moduleConfig.id),
        sharedPath: path.join(this.config.dataDir, "exts", moduleConfig.extension),
        media: {
          get: (id, format) => this.mediaManager.get(id, format),
          crop: (id, rect) => this.mediaManager.crop(id, rect),
        },
        blocks: {
          get: (id) => this.blockManager.get(id),
          acquire: (id) => this.blockManager.acquire(id),
          release: (id) => this.blockManager.release(id),
        },
        llm: llmClient,
        logger: this.logger.child({ module: moduleConfig.id }),
        config: { ...(moduleConfig.config ?? {}), llm: this.config.llm },
      };

      await module.init(ctx);

      this.modules.set(moduleConfig.id, module);
      this.moduleConfigs.set(moduleConfig.id, moduleConfig);

      // 注册到 Scheduler
      this.scheduler.register({
        id: moduleConfig.id,
        config: moduleConfig.schedule as any,
      });
    }

    // 4. 设置拓扑
    for (const moduleConfig of this.config.modules) {
      const upstreamIds: string[] = [];

      for (const inputPageId of moduleConfig.inputPages) {
        // 找到所有向该 Page 写入的 module
        for (const otherConfig of this.config.modules) {
          if (
            otherConfig.id !== moduleConfig.id &&
            otherConfig.outputPages.includes(inputPageId)
          ) {
            if (!upstreamIds.includes(otherConfig.id)) {
              upstreamIds.push(otherConfig.id);
            }
          }
        }
      }

      this.scheduler.setTopology(moduleConfig.id, upstreamIds);
    }

    // 5. 为每个 module 注册 input page 的消费者
    for (const moduleConfig of this.config.modules) {
      for (const inputPageId of moduleConfig.inputPages) {
        const page = this.pages.get(inputPageId);
        if (page) {
          page.registerConsumer(moduleConfig.id);
        }
      }
    }

    this.logger.info("Orchestrator initialized");
  }

  /** 启动编排循环 */
  start(): void {
    this.scheduler.start();
    this.blockManager.startCleanup();
    this.mediaManager.startCleanup();
    this.running = true;
    this.logger.info("Orchestrator started");
  }

  /** 停止 */
  stop(): Promise<void> {
    this.stopPromise ??= this.performStop();
    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    this.running = false;
    this.scheduler.stop();
    this.blockManager.stop();
    this.mediaManager.stop();

    for (const [id, module] of this.modules) {
      try {
        await module.onStop();
      } catch (err) {
        this.logger.error({ err, moduleId: id }, "Error stopping module");
      }
    }

    this.logger.info("Orchestrator stopped");

    await this.logger.close();
  }

  /** Scheduler 的 onTick 回调 */
  private onTick(moduleId: string): void {
    // 如果该 module 还在执行上一轮，跳过
    if (this.executing.has(moduleId)) {
      this.scheduler.report({
        moduleId,
        executionTimeMs: 0,
        bufferEmpty: false,
      });
      return;
    }

    this.executing.add(moduleId);
    // fire-and-forget
    this.executeModule(moduleId).catch((err) => {
      this.logger.error({ err, moduleId }, "Unhandled error in executeModule");
      this.executing.delete(moduleId);
      this.scheduler.report({
        moduleId,
        executionTimeMs: 0,
        bufferEmpty: false,
      });
    });
  }

  /** Scheduler 安全超时回调：放弃卡住的执行，允许下一轮 tick 启动新执行 */
  private onTimeout(moduleId: string): void {
    this.logger.warn({ moduleId }, "Module execution timed out, abandoning current execution");
    this.executing.delete(moduleId);
  }

  /** 异步执行 module */
  private async executeModule(moduleId: string): Promise<void> {
    const module = this.modules.get(moduleId);
    const moduleConfig = this.moduleConfigs.get(moduleId);

    if (!module || !moduleConfig) {
      this.executing.delete(moduleId);
      return;
    }

    // 1. 从所有输入 Page 收集新 block
    const allBlocks: Block[] = [];
    for (const inputPageId of moduleConfig.inputPages) {
      const page = this.pages.get(inputPageId);
      if (page) {
        const blocks = page.consume(moduleId);
        allBlocks.push(...blocks);
      }
    }

    // 2. 合并（相同 id → repeat_count++）并追踪跨轮次重复
    const processed = this.processedBlocks.get(moduleId) ?? new Set<string>();
    const blockMap = new Map<string, Block>();
    for (const block of allBlocks) {
      const existing = blockMap.get(block.id);
      if (existing) {
        existing.repeat_count = (existing.repeat_count ?? 1) + 1;
      } else {
        // Cross-round repeat detection: if this module has seen this block before,
        // increment repeat_count to reflect how many times this module has processed it.
        const repeatCount = processed.has(block.id)
          ? (block.repeat_count ?? 1) + 1
          : (block.repeat_count ?? 1);
        blockMap.set(block.id, { ...block, repeat_count: repeatCount });
      }
    }
    // Record all block IDs this module has now processed
    for (const blockId of blockMap.keys()) {
      processed.add(blockId);
    }
    // Prevent unbounded growth: if Set exceeds capacity limit, rebuild
    // keeping only blocks still alive in BlockManager
    if (processed.size > 10000) {
      const pruned = new Set<string>();
      for (const id of processed) {
        if (this.blockManager.get(id)) {
          pruned.add(id);
        }
      }
      this.processedBlocks.set(moduleId, pruned);
    } else {
      this.processedBlocks.set(moduleId, processed);
    }

    const mergedBlocks = [...blockMap.values()];

    // 3. 对每个 block 调用 acquire
    for (const block of mergedBlocks) {
      this.blockManager.acquire(block.id);
    }

    // 4. 收集相邻 module 的 premise
    const adjacentPremises = this.collectAdjacentPremises(moduleId);

    // 5. 构建 ExecuteInput
    const input: ExecuteInput = {
      blocks: mergedBlocks,
      adjacentPremises,
    };

    // 6. 执行 module
    const startTime = Date.now();
    let rawBlock: RawBlock | null;

    try {
      rawBlock = await module.execute(input);
    } catch (err) {
      this.logger.error({ err, moduleId }, "Module execution failed");
      // 释放 acquired blocks
      for (const block of mergedBlocks) {
        this.blockManager.release(block.id);
      }
      this.executing.delete(moduleId);
      this.scheduler.report({
        moduleId,
        executionTimeMs: Date.now() - startTime,
        bufferEmpty: this.isBufferEmpty(moduleConfig),
      });
      return;
    }

    const executionTimeMs = Date.now() - startTime;

    // 7. 处理结果
    await this.handleResult(moduleId, rawBlock, executionTimeMs, mergedBlocks);
  }

  /** 处理 module 返回结果 */
  private async handleResult(
    moduleId: string,
    rawBlock: RawBlock | null,
    executionTimeMs: number,
    inputBlocks: Block[],
  ): Promise<void> {
    const moduleConfig = this.moduleConfigs.get(moduleId);

    if (rawBlock && rawBlock.content && Array.isArray(rawBlock.content)) {
      // a. 处理原始多媒体
      for (let i = 0; i < rawBlock.content.length; i++) {
        const item = rawBlock.content[i];
        if (item && typeof item === "object" && this.isRawMedia(item)) {
          try {
            const mediaId = await this.registerRawMedia(item);
            rawBlock.content[i] = { type: item.type, mediaId: mediaId };
          } catch (err) {
            this.logger.error({ err, moduleId }, "Failed to register media");
          }
        }
      }

      // b. 生成正式 Block
      const block: Block = {
        id: randomUUID().replace(/-/g, ""),
        timestamp: Date.now(),
        description: rawBlock.description,
        source: rawBlock.source,
        content: rawBlock.content,
        tensity: rawBlock.tensity ?? 1.0,
        extra_body: rawBlock.extra_body,
      };

      // c. 注册到 BlockManager
      this.blockManager.register(block);

      // d. 写入所有输出 Page（加锁）
      if (moduleConfig) {
        for (const outputPageId of moduleConfig.outputPages) {
          const page = this.pages.get(outputPageId);
          const lock = this.pageLocks.get(outputPageId);
          if (page && lock) {
            await lock.runExclusive(() => {
              page.append(block);
            });
          }
        }
      }

      this.eventBus.emit("block.created", block);
    }

    // 检查缓冲区是否为空
    const bufferEmpty = moduleConfig ? this.isBufferEmpty(moduleConfig) : true;

    // 报告给 Scheduler
    this.scheduler.report({ moduleId, executionTimeMs, bufferEmpty });

    // 释放所有输入 block 的引用
    for (const block of inputBlocks) {
      this.blockManager.release(block.id);
    }

    this.executing.delete(moduleId);
  }

  /** 收集某个 module 的相邻 premise */
  private collectAdjacentPremises(moduleId: string): PremiseCollection {
    const upstream: PremiseCollection["upstream"] = [];
    const downstream: PremiseCollection["downstream"] = [];

    // 获取上游（从 scheduler topology）
    const upstreamIds = this.scheduler.getTopology(moduleId);
    for (const upId of upstreamIds) {
      const upModule = this.modules.get(upId);
      if (upModule) {
        upstream.push({
          moduleId: upId,
          inputPremise: upModule.getInputPremise(),
          outputPremise: upModule.getOutputPremise(),
        });
      }
    }

    // 获取下游（找到所有将当前 module 作为上游的 module）
    for (const [otherId] of this.modules) {
      if (otherId === moduleId) continue;
      const otherUpstream = this.scheduler.getTopology(otherId);
      if (otherUpstream.includes(moduleId)) {
        const downModule = this.modules.get(otherId);
        if (downModule) {
          downstream.push({
            moduleId: otherId,
            inputPremise: downModule.getInputPremise(),
            outputPremise: downModule.getOutputPremise(),
          });
        }
      }
    }

    return { upstream, downstream };
  }

  /** 检查某 module 的输入缓冲区是否为空 */
  private isBufferEmpty(moduleConfig: ModuleConfig): boolean {
    for (const inputPageId of moduleConfig.inputPages) {
      const page = this.pages.get(inputPageId);
      if (page && page.blockCount > 0) return false;
    }
    return true;
  }

  /** 检查 content item 是否是原始多媒体（有 url/base64/file 但没有 mediaId） */
  private isRawMedia(item: any): boolean {
    if (item.mediaId) return false;
    return !!(item.url || item.base64 || item.file);
  }

  /** 注册原始多媒体到 MediaManager */
  private async registerRawMedia(item: any): Promise<string> {
    let source: string;
    if (item.url) {
      source = item.url;
    } else if (item.base64) {
      source = item.base64;
    } else if (item.file) {
      source = item.file;
    } else {
      throw new Error("No valid media source found");
    }

    const MIME_MAP: Record<string, string> = {
      image: "image/png",
      audio: "audio/mpeg",
      video: "video/mp4",
    };
    const mimeType = item.mimeType ?? MIME_MAP[item.type] ?? "application/octet-stream";
    return this.mediaManager.register(source, mimeType);
  }
}
