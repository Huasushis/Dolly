import type { Block, RawBlock, ExecuteInput, PremiseCollection, Rect } from "../core/types.js";

// Media 访问接口
export interface MediaAccess {
  get(id: string, format: "buffer" | "base64" | "url"): Promise<Buffer | string>;
  crop(id: string, rect: Rect): Promise<string>;
}

// Block 访问接口
export interface BlockAccess {
  get(id: string): Block | null;
}

// Logger（any 避免 SDK 依赖 pino）
export type Logger = any;

// LLM 客户端接口
export interface LLMClient {
  chat(messages: Array<{ role: string; content: any }>, options?: Record<string, any>): Promise<any>;
  chatStream?(messages: Array<{ role: string; content: any }>, options?: Record<string, any>): AsyncIterable<any>;
}

// Module 运行时上下文
export interface ModuleContext {
  storagePath: string;
  sharedPath: string;
  media: MediaAccess;
  blocks: BlockAccess;
  llm?: LLMClient;
  logger: Logger;
  config: Record<string, any>;
}

// Module 接口
export interface Module {
  id: string;
  execute(input: ExecuteInput): Promise<RawBlock | null>;
  getInputPremise(): string;
  getOutputPremise(): string;
  init(ctx: ModuleContext): Promise<void>;
  onStop(): Promise<void>;
}

// CLI 命令规格
export interface CliCommandSpec {
  name: string;
  description: string;
  handler: (args: string[], ctx: ModuleContext) => Promise<void>;
}

// Extension 定义
export interface DollyExtension {
  name: string;
  version: string;
  description: string;
  createModule(config: { id: string; config: Record<string, any> }): Module;
  cliCommands?: CliCommandSpec[];
}

// Extension 元数据（注册中心使用）
export interface ExtensionMetadata {
  name: string;
  version: string;
  description: string;
}

// Extension 专用日志等级枚举
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

// Extension 专用日志接口
export interface ExtensionLogger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  child(bindings: Record<string, unknown>): ExtensionLogger;
  setLevel(level: LogLevel): void;
}
