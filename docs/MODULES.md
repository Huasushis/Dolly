# Dolly 模块开发指南

模块是 Dolly 的核心扩展单元。每个模块可以读取上下文、响应块变更、插入/删除/修改块。

## 模块结构

```
extensions/my-module/
├── dolly.json          # 模块清单
├── index.ts            # 模块代码
└── data/               # 本地存储（可选，框架传入 storagePath）
```

### dolly.json

```json
{
  "name": "my-module",
  "version": "0.1.0",
  "description": "我的模块"
}
```

### index.ts

```typescript
import type { DollyModule, ModuleContext } from "../../src/modules/base.js";
import type { BlockChange, BlockMutation } from "../../src/blocks/index.js";

const myModule: DollyModule = {
  id: "my-module",

  async init(ctx: ModuleContext): Promise<void> {
    // 初始化：读取本地存储、设置状态
    // ctx.storagePath → extensions/my-module/data/
  },

  async onBlocksChanged(ctx: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    const mutations: BlockMutation[] = [];

    for (const ch of changes) {
      // ch.type: "added" | "removed" | "modified"
      if (ch.type === "added" && ch.block.type === "message") {
        mutations.push({
          action: "insert",
          priority: 50,
          block: {
            type: "injection",
            content: "我看到了新消息",
            meta: { source: "my-module" },
            created: Date.now(),
          },
        });
      }
    }

    return mutations;
  },

  systemPrompt(ctx: ModuleContext): string {
    return "可选：注入到 System Prompt 的内容";
  },
};

export default myModule;
```

## API 参考

### ModuleContext

```typescript
interface ModuleContext {
  /** 所有块（只读副本） */
  getBlocks(): Block[];

  /** 按 ID 获取块 */
  getBlock(id: string): Block | undefined;

  /** 估算当前 token 数 */
  estimateTokens(): number;

  /** 模块级配置（来自 dolly.json modules.<id>） */
  config: Record<string, unknown>;

  /** 发送事件到 EventBus */
  emit(event: string, payload: unknown): void;

  /** 写入 daily log */
  log(op: string, detail: unknown): void;

  /** 锁管理器（防止并发 LLM 调用） */
  lock: LockManager;

  /** 模块本地存储路径。可不存在，模块自行创建 */
  storagePath: string;
}
```

### Block

```typescript
interface Block {
  id: string;
  type: string;
  content: string;
  meta: Record<string, unknown>;  // notify: false 可跳过 LLM 触发
  created: number;
}
```

### BlockChange

```typescript
interface BlockChange {
  type: "added" | "removed" | "modified";
  block: Block;
}
```

### BlockMutation

```typescript
type BlockMutation =
  | { action: "insert"; block: Omit<Block, "id">; priority: number }
  | { action: "delete"; blockId: string }
  | { action: "update"; blockId: string; content?: string; meta?: Record<string, unknown> }
```

### LockManager

```typescript
interface LockManager {
  /** 申请锁。priority 越小越优先。返回释放函数 */
  acquire(moduleId: string, priority: number): Promise<() => void>;
}
```

LLM 模块固定使用最低优先级（`Infinity`），让其他模块先处理。

### 内置块类型

| type | 用途 |
|------|------|
| `system` | System Prompt（置顶） |
| `message` | 用户/外部输入 |
| `response` | LLM 输出 |
| `tool_result` | 工具调用结果 |
| `injection` | 模块注入 |
| `skill` | SKILL 触发注入 |
| `memory` | 长期记忆注入 |

## 本地存储

每个模块通过 `ctx.storagePath` 获得独立目录（`extensions/<id>/data/`），可自由读写：

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

async init(ctx: ModuleContext) {
  if (!existsSync(ctx.storagePath)) mkdirSync(ctx.storagePath);
  const saved = readFileSync(ctx.storagePath + "/state.json", "utf-8");
  // ...
}
```

## 防自响应

> **每个 extension 创建的块必须加 `meta.source = ownId`。`onBlocksChanged` 中过滤 `ch.block.meta?.source === ownId`。**

示例：
```typescript
// 创建块时标记来源
block: { type: "response", content, meta: { source: "llm" }, created: Date.now() }

// onBlocksChanged 中过滤
const newBlocks = changes.filter((ch) =>
  ch.type === "added" && ch.block.meta?.source !== ownId
);
```

## 遗忘速率

每个块可设 `meta.decay_rate`（/小时），控制遗忘速度：
- 默认 0.1（半衰期 ~7 小时）
- MCP 工具输出 0.5（快速遗忘）
- 设为 0 永不遗忘（同 pinned）

## 静默块

不想触发 LLM 响应的块，设置 `meta.notify: false`：

```typescript
mutations.push({
  action: "insert", priority: 99,
  block: { type: "internal", content: "...", meta: { notify: false }, created: Date.now() },
});
```

## 在 dolly.json 中注册

```json
{
  "modules": {
    "enabled": ["builtin/llm", "builtin/skill", "builtin/mcp", "my-module"],
    "my-module": {
      "custom_option": "value"
    }
  }
}
```

`my-module` 下的配置对象直接传给 `ModuleContext.config`。放入 `extensions/`，在 `enabled` 列表中加入即可生效。
