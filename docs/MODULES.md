# Dolly 模块开发指南

## 概念

模块是 Dolly 的扩展单元。每个模块是一个文件夹，放在 `extensions/` 下。

```
extensions/my-ext/
├── dolly.json          # 模块清单
└── index.ts            # 模块代码
```

## dolly.json

```json
{
  "name": "my-ext",
  "version": "0.1.0",
  "description": "我的扩展"
}
```

## index.ts

```typescript
import type { DollyModule, ModuleContext } from "../../src/modules/base.js";
import type { BlockChange, BlockMutation } from "../../src/blocks/index.js";

const myExt: DollyModule = {
  id: "my-ext",

  async init(ctx: ModuleContext) {
    // 启动时调用。ctx.storagePath 可读写本地文件
  },

  systemPrompt(ctx: ModuleContext): string {
    // 可选：注入到 System Prompt 的内容。模块卸载时自动移除
    return "你可以使用我的自定义功能。";
  },

  async onBlocksChanged(ctx: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    // 上下文有新块时调用。changes 是所有变更的数组（合并后）
    const mutations: BlockMutation[] = [];

    for (const ch of changes) {
      // ch.type: "added" | "removed" | "modified"
      // ch.block: Block 对象
      if (ch.type === "added" && ch.block.type === "message") {
        mutations.push({
          action: "insert",           // 插入新块
          priority: 50,               // 越小越靠前（LLM 响应 priority=99）
          block: {
            type: "injection",        // 块类型（任意字符串）
            content: "我看到了新消息",
            meta: { source: "my-ext" }, // 必须：标记来源，防止自响应
            created: Date.now(),
          },
        });
      }
    }
    return mutations;
  },
};

export default myExt;
```

## API

### ModuleContext

```typescript
interface ModuleContext {
  getBlocks(): Block[];                           // 获取所有块（只读副本）
  getBlock(id: string): Block | undefined;        // 按 ID 获取块
  estimateTokens(): number;                       // 估算当前 token 数
  config: Record<string, unknown>;                // 模块级配置（来自 dolly.json modules.<id>）
  emit(event: string, payload: unknown): void;    // 发送事件到 EventBus
  log(op: string, detail: unknown): void;         // 写入 daily log（JSONL）
  lock: LockManager;                              // 锁管理器，防止并发 LLM 调用
  setSystemPrompt(text: string): void;            // 修改自己的 System Prompt 片段
  storagePath: string;                            // 本地存储目录
}
```

### DollyModule

```typescript
interface DollyModule {
  id: string;                                     // 唯一标识，如 "builtin/mcp"
  init?(ctx: ModuleContext): Promise<void>;       // 初始化（加载时调用一次）
  onBlocksChanged?(ctx: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]>;  // 块变更时推送
  systemPrompt?(ctx: ModuleContext): string;      // 静态 System Prompt（可选，可被 setSystemPrompt 覆盖）
}
```

### Block

```typescript
interface Block {
  id: string;                     // 唯一 ID（自动生成）
  type: string;                   // 块类型。内置：system/message/response/tool_result/injection/skill/memory
  content: string;                // 块内容
  meta: Record<string, unknown>;  // 元数据。关键字段见下表
  created: number;                // 创建时间戳（毫秒）
}
```

### Block.meta 关键字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `source` | string | **必须**：创建者 ID，防自响应。LLM 模块跳过 `source==="llm"` 的块 |
| `notify` | boolean | `false` 时不触发 LLM 响应（静默块） |
| `decay_rate` | number | 遗忘速率/小时，默认 0.1。MCP 输出 0.5 |
| `pinned` | boolean | `true` 时永不遗忘 |

### BlockChange

```typescript
interface BlockChange {
  type: "added" | "removed" | "modified";  // 变更类型
  block: Block;                             // 变更的块
}
```

### BlockMutation

```typescript
type BlockMutation =
  | { action: "insert"; block: Omit<Block, "id">; priority: number }
      // 插入新块。priority 越小越靠前，LLM 用 99（最后）
  | { action: "delete"; blockId: string }
      // 按 ID 删除块
  | { action: "update"; blockId: string; content?: string; meta?: Record<string, unknown> }
      // 更新块的内容或 meta
```

### LockManager

```typescript
interface LockManager {
  acquire(moduleId: string, priority: number): Promise<() => void>;
  // priority 越小越优先。LLM 固定 Infinity（最低优先级）
}
```

## 防自响应

> **每个扩展创建的块必须设 `meta.source = ownId`。`onBlocksChanged` 中过滤 `ch.block.meta?.source === ownId`。**

## 管理命令（前台交互）

```
/list                    列出所有扩展及启用状态
/enable <id>             启用扩展
/disable <id>            禁用扩展
/reload                  重载全部已启用扩展
/reload --ext=<id>        重载指定扩展
```

## 本地存储

每个扩展通过 `ctx.storagePath` 获得独立目录：

```
profiles/<实例名>/exts/<模块id>/
```

例如 `builtin/console` 的存储路径：
```
.dolly/profiles/default/exts/builtin-console/speak_history.json
```

`builtin/memory` 的存储路径：
```
.dolly/profiles/default/exts/builtin-memory/
├── daily/{day}.jsonl     # 每日操作日志
├── entries/{day}.json    # 每日总结
└── index.json            # 关键词倒排索引
```

扩展可自由在此目录下读写文件。目录不会自动创建——扩展的 `init()` 中自行 `mkdir`。

```typescript
async init(ctx: ModuleContext) {
  if (!existsSync(ctx.storagePath)) mkdirSync(ctx.storagePath);
  const saved = readFileSync(resolve(ctx.storagePath, "state.json"), "utf-8");
}
```

## 已在 dolly.json 中注册

```json
{
  "modules": {
    "enabled": ["builtin/llm", "builtin/memory", "builtin/skill", "builtin/mcp", "my-ext"],
    "my-ext": { "custom_option": "value" }
  }
}
```

`my-ext` 下的配置传入 `ModuleContext.config`。
