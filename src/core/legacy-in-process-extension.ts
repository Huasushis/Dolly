/**
 * Deprecated interface for extensions loaded into the Dolly host process.
 *
 * It is retained only so the old orchestrator and its tests remain readable
 * during migration. It is not exported by the public SDK or included in the
 * package build because it exposes host paths and host-owned objects directly.
 * Compatibility names are unchanged for old source imports: LLM means large
 * language model, and CLI means command-line interface.
 */
import type { z } from "zod";
import type {
  Block,
  ExecuteInput,
  PremiseCollection,
  RawBlock,
  ScheduleConfig,
} from "./types.js";
import type { Rect } from "./block-content.js";

export interface MediaAccess {
  get(id: string, format: "buffer" | "base64" | "url"): Promise<Buffer | string>;
  /**
   * Crops use the shared versioned fixed-point `image_rect_v1` rectangle, the
   * same type the Block content pipeline and Media store use. The in-process
   * host delegates the conversion to the single shared materializer; it never
   * interprets the coordinates itself. (Legacy orchestrator path only.)
   */
  crop(id: string, rect: Rect): Promise<string>;
}

export interface BlockAccess {
  get(id: string): Block | null;
  acquire(id: string): void;
  release(id: string): void;
}

export type Logger = any;

export interface LLMClient {
  chat(
    messages: Array<{ role: string; content: any }>,
    options?: Record<string, any>,
  ): Promise<any>;
  chatStream?(
    messages: Array<{ role: string; content: any }>,
    options?: Record<string, any>,
  ): AsyncIterable<any>;
}

export interface ModuleContext {
  storagePath: string;
  sharedPath: string;
  media: MediaAccess;
  blocks: BlockAccess;
  llm?: LLMClient;
  logger: Logger;
  config: Record<string, any>;
}

export interface Module {
  id: string;
  execute(input: ExecuteInput): Promise<RawBlock | null>;
  getInputPremise(): string;
  getOutputPremise(): string;
  init(ctx: ModuleContext): Promise<void>;
  onStop(): Promise<void>;
}

export interface CliCommandSpec {
  name: string;
  description: string;
  handler: (args: string[], ctx: ModuleContext) => Promise<void>;
}

export interface DollyExtension {
  name: string;
  version: string;
  description: string;
  configSchema?: z.ZodSchema;
  createModule(config: {
    id: string;
    config: Record<string, any>;
    inputPages?: string[];
    outputPages?: string[];
    schedule?: Partial<ScheduleConfig>;
  }): Module;
  cliCommands?: CliCommandSpec[];
}

export interface ExtensionMetadata {
  name: string;
  version: string;
  description: string;
}

export enum LogLevel {
  DEBUG = "debug",
  INFO = "info",
  WARN = "warn",
  ERROR = "error",
}

export interface ExtensionLogger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  child(bindings: Record<string, unknown>): ExtensionLogger;
  setLevel(level: LogLevel): void;
}

export function defineExtension(spec: DollyExtension): DollyExtension {
  return spec;
}

export type { Block, ExecuteInput, PremiseCollection, RawBlock, Rect };
