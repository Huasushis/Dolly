# Dolly 模块开发指南

## 模块概念

Dolly 的模块是注入器、监控器和工具的统一体。一个模块可以：
- 读取上下文块
- 在块变更时被推送通知
- 返回块变更（插入/删除/修改块）
- 提供 System Prompt 片段
- 设置心跳定时器

## 第一个模块

创建 `extensions/my-module/` 目录：

```
extensions/my-module/
├── dolly.json          # 模块清单
└── index.ts            # 模块代码
```

### dolly.json

```json
{
  "name": "my-module",
  "version": "0.1.0",
  "description": "我的模块",
  "main": "index.ts"
}
```

### index.ts

```typescript
import type { DollyModule, BlockChange, BlockMutation, ModuleContext } from "../../src/modules/base.js";

const myModule: DollyModule = {
  id: "my-module",

  async onBlocksChanged(ctx: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    const mutations: BlockMutation[] = [];

    for (const change of changes) {
      if (change.type === "added" && change.block.type === "message") {
        // 当有新消息时，插入一个响应块
        mutations.push({
          action: "insert",
          priority: 50,
          block: {
            type: "injection",
            content: `我看到了新消息: ${change.block.content.slice(0, 100)}`,
            meta: { source: "my-module" },
            created: Date.now(),
          },
        });
      }
    }

    return mutations;
  },
};

export default myModule;
```

## API 参考

### ModuleContext

```typescript
interface ModuleContext {
  /** 获取所有块 */
  getBlocks(): Block[];

  /** 获取特定块 */
  getBlock(id: string): Block | undefined;

  /** 估算 token 数 */
  estimateTokens(): number;

  /** 更新模块的 System Prompt 片段 */
  setSystemPrompt(text: string): void;

  /** 发送事件 */
  emit(event: string, payload: any): void;
}
```

### Block

```typescript
interface Block {
  id: string;
  type: string;
  content: string;
  meta: Record<string, unknown>;
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

### 内置块类型

| type | 用途 |
|------|------|
| `system` | System Prompt（置顶，不可删） |
| `message` | 用户输入 / 外部消息 |
| `response` | LLM 输出 |
| `tool_call` | 工具调用请求 |
| `tool_result` | 工具调用结果 |
| `injection` | 模块注入的内容 |
| `skill` | SKILL 触发内容 |
| `forget` | 遗忘标记 |

## 心跳

模块可以设置心跳定时器，用于定期检查：

```typescript
const myModule: DollyModule = {
  id: "my-module",
  heartbeatInterval: 60, // 每 60 秒

  async onHeartbeat(ctx: ModuleContext): Promise<BlockMutation[]> {
    // 检查是否需要做什么
    return [];
  },
};
```

## System Prompt

模块可以提供 System Prompt 片段，所有模块的片段拼接为完整的 System Prompt：

```typescript
const myModule: DollyModule = {
  id: "my-module",

  systemPrompt(ctx: ModuleContext): string {
    return `你可以使用以下自定义功能：...`;
  },
};
```
