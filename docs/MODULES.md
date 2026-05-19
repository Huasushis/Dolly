# Dolly 模块开发指南

## 概念

Dolly 框架模拟 AI 的内心世界。所有上下文只有三种块：`system`（系统 prompt）、`inner`（AI 内部产生）、`outer`（外部输入）。细化分类由每个 extension 通过 `meta.subtype` 自行定义。

模块是扩展单元，放在 `extensions/` 下：

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
    // 启动时调用。ctx.storagePath 指向 profiles/<name>/exts/<id>/
    // ctx.config 包含 dolly.json modules.<id> 的已解析配置
  },

  systemPrompt(): string {
    return "注入到 AI system prompt 的内容";
  },

  async onBlocksChanged(ctx: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    // 上下文有新块时调用。只处理需要自己的情况
    // 累计更新原则：一次处理所有未处理块，返回单批 mutations
    const mutations: BlockMutation[] = [];

    for (const ch of changes) {
      if (ch.type === "added" && ch.block.type === "outer") {
        mutations.push({
          action: "insert",
          priority: 50,
          block: {
            type: "inner",
            content: "我的内部回应",
            meta: { source: "my-ext", subtype: "my-type" },
            created: Date.now(),
          },
        });
      }
    }
    return mutations;
  },

  // 可选：生命周期
  async onStop(ctx: ModuleContext) { ctx.saveState({ key: "value" }); },
  async onStart(ctx: ModuleContext) { const s = ctx.loadState(); },

  // 可选：CLI 命令（dolly myext <args...>）
  async handleCli(args: string[], ctx: ModuleContext) {
    process.stdout.write(`Received: ${args.join(" ")}\n`);
  },
};

export default myExt;
```

## API

### ModuleContext

```typescript
interface ModuleContext {
  getBlocks(): Block[];                           // 所有块（只读副本）
  getBlock(id: string): Block | undefined;        // 按 ID 查找
  estimateTokens(): number;                       // 粗略 token 估算
  config: Record<string, unknown>;                // dolly.json modules.<id> 已解析配置
  emit(event: string, payload: unknown): void;    // 发事件到 EventBus
  lock: LockManager;                              // 优先级 async 互斥锁
  setSystemPrompt(text: string): void;            // 设置自己的 System Prompt 片段
  storagePath: string;                            // profiles/<name>/exts/<id>/ 的路径
  saveState(data: Record<string, unknown>): void; // 存到 storagePath/save.json
  loadState(): Record<string, unknown> | null;    // 读 save.json
}
```

### DollyModule

```typescript
interface DollyModule {
  id: string;
  init?(ctx: ModuleContext): Promise<void>;
  onBlocksChanged?(ctx: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]>;
  systemPrompt?(ctx: ModuleContext): string;
  onStop?(ctx: ModuleContext): Promise<void>;      // daemon 关闭前调用
  onStart?(ctx: ModuleContext): Promise<void>;     // profile 恢复后调用
  handleCli?(args: string[], ctx: ModuleContext): Promise<void>;  // dolly <ext> <args...>
}
```

### Block

```typescript
interface Block {
  id: string;                     // UUID，自动生成
  type: string;                   // "system" | "inner" | "outer"
  content: string;
  meta: Record<string, unknown>;  // 框架：pinned, source, decay_rate
  created: number;                // Date.now() 毫秒时间戳
}
```

### Block Type 约定

| type | 含义 | 例子 |
|------|------|------|
| `system` | 系统 prompt，唯一 pinned 块 | — |
| `inner` | AI 内部——思考、回应、注入、记忆 | LLM 回应、skill 注入、memory 召回、background |
| `outer` | 外部——用户输入、MCP 结果、监听器收到的新消息 | 用户打字、MCP 返回数据 |

细化分类通过 `meta.subtype`：LLM 设 `"response"`、skill 设 `"skill"`、memory 设 `"memory"`、background 设 `"background"`。

### Block.meta

**框架原生（3 个）：**

| 键 | 说明 |
|----|------|
| `pinned` | `true` → 永不遗忘（decay 跳过） |
| `source` | 创建者 extension ID，用于自过滤 |
| `decay_rate` | 每块独立遗忘速率/小时，默认 0.1 |

**Extension 自定义（示例）：**

| 键 | 所属 | 说明 |
|----|------|------|
| `subtype` | 任意 | 细化分类 |
| `skill` | skill | 触发注入的 skill 名 |
| `tool` | MCP | 工具名 |

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
  | { action: "update"; blockId: string; content?: string; meta?: Record<string, unknown> };
```

`priority` 越小越靠前：background=5, skill=20, memory=85, LLM response=99。

### LockManager

```typescript
interface LockManager {
  acquire(moduleId: string, priority: number): Promise<() => void>;
  // 拿到锁后返回 unlock 函数。不释放锁 = 阻塞等待
}
```

## 框架原生机制

### Forget

**任何** block 的 content 中含 `{"forget":"ID"}` 时，框架在 cascade 中自动扫描并删除目标块。
Extension **不需要**自己实现 forget——只需要教 AI 使用 forget 语法（在 systemPrompt 中）。

### Cascade 循环

```
ContextManager.applyMutations() → BlockChange[]
  → ModuleRegistry.pushChanges(changes) → BlockMutation[]
    → ContextManager.applyMutations(mutations) → BlockChange[]
  → 最多 3 轮
```

### 注入与监听解耦

Extension 不只可以在 `onBlocksChanged` 中注入。任何时间都可以通过 ctx.emit 触发 cascade 或直接操作（如定时器、webhook 监听）。

### 累计更新原则

Extension 在一次 `onBlocksChanged` 调用中应一次性处理所有未处理块，返回**一批** mutations。避免每个块单独处理导致多次注入和递归 cascade。

### 不必要则不注入

只在条件满足时才注入（skill 只在触发时、memory 只在有相关记忆且相似度高于阈值时）。不是每次 cascade 都必须注入。

## EventBus 事件

| 事件 | 发出者 | 消费者 | payload |
|------|--------|--------|---------|
| `speak` | console | relay | `{ text: string }` |
| `tool.call_requested` | llm | main.ts | `{ tool_name, params }` |
| `reasoning.captured` | llm | main.ts | `{ content: string }` |
| `midnight.tick` | main.ts timer | memory | `{}` |

## CLI 命令

框架原生命令：`dolly start/stop/status`。

Extension 通过 `handleCli(args, ctx)` 注册自己的命令：
- `dolly console` → 交互式终端（console extension）
- `dolly memory midnight` → 强制执行午夜流水线
- `dolly memory recall <q>` → 搜索记忆
- `dolly skill reload` / `dolly skill list` → skill 管理
- `dolly mcp reload` / `dolly mcp list` → MCP 管理

## 本地存储

每个 extension 通过 `ctx.storagePath` 获得独立目录：

```
.dolly/profiles/<name>/exts/<module-id>/
```

例如：
- `builtin/console` → `exts/builtin/console/speak_history.json`
- `builtin/memory` → `exts/builtin/memory/memory-store/`（daily/entries/index）
- `builtin/memory/mskills/` → 自动生成的 skill

## dolly.json 配置

```json
{
  "modules": {
    "enabled": ["builtin/llm", "builtin/memory", "my-ext"],
    "my-ext": { "custom_option": "value" }
  }
}
```

`my-ext` 下的配置经过 env var 解析后传入 `ctx.config["my-ext"]`。
