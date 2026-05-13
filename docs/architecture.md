# Dolly 架构文档 v2

## 设计哲学

Dolly 是**通用基础 agent 框架**。对标 OpenClaw / Hermes，但更简化：

- 上下文只分两层：**置顶 System 块** + **内容块序列**
- 不区分输入/输出，一切皆为块
- 注入、监控、LLM 调用统一为**模块**
- 模块通过**推送上下文变更**和**提交块变更**来工作

## 上下文模型：块

### 块结构

```typescript
interface Block {
  id: string;           // 唯一 ID
  type: string;         // 块类型（可自定义）
  content: string;      // 块内容
  meta: Record<string, unknown>;  // 元数据
  created: number;      // 创建时间戳
}
```

### 序列化格式

上下文块在发给 LLM 前序列化为 JSON-like 文本：

```
[ID:abc123][TYPE:message][TIME:1700000000]
{"content": "实际文本内容", "from": "user"}

[ID:def456][TYPE:tool_result][TIME:1700000001]
{"tool": "datetime", "result": {"datetime": "2026-05-07T..."}}

[ID:ghi789][TYPE:injection][TIME:1700000002]
{"source": "skill.code-review", "text": "请审查代码..."}
```

每块有 `[ID:xxx][TYPE:xxx][TIME:xxx]` 头部，后跟 JSON 体。LLM 可以理解这种格式。

### 上下文组成

```
┌─────────────────────────────────┐
│  System Prompt (置顶，来自模块)    │
├─────────────────────────────────┤
│  Block 1                        │
│  Block 2                        │
│  Block 3                        │
│  ...                            │
└─────────────────────────────────┘
```

## 模块系统

### 统一模块接口

注入、监控、LLM 合并为统一的 `DollyModule`：

```typescript
interface DollyModule {
  id: string;

  /** 初始化时调用 */
  init?(ctx: ModuleContext): Promise<void>;

  /** 上下文块变更时推送 */
  onBlocksChanged?(ctx: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]>;

  /** 可选：提供 System Prompt 片段 */
  systemPrompt?(ctx: ModuleContext): string;

  /** 可选：定时心跳（秒） */
  heartbeatInterval?: number;
  onHeartbeat?(ctx: ModuleContext): Promise<BlockMutation[]>;
}
```

### 块变更推送

每次有块新增/删除/修改时，向所有模块推送 `BlockChange[]`：

```typescript
interface BlockChange {
  type: "added" | "removed" | "modified";
  block: Block;
}
```

### 块变更

模块返回 `BlockMutation[]` 来变更上下文：

```typescript
type BlockMutation =
  | { action: "insert"; block: Omit<Block, "id">; priority: number }
  | { action: "delete"; blockId: string }
  | { action: "update"; blockId: string; content?: string; meta?: Record<string, unknown> }
```

### LLM 触发

当有新的 `type: "message"` 块加入时触发 LLM 调用。LLM 输出作为新块（`type: "response"`）插入。

## 内置模块

### builtin/llm

LLM 调用模块。监听新 message 块 → 构建上下文 → 调用 DeepSeek API → 流式输出 → 插入 response 块。

同时负责检测 LLM 输出中的 `[FORGET:id]` 和 `[TOOL:name]...[AWAIT:name]` 标签。

### builtin/skill

SKILL 兼容模块。配置位于 `extensions/builtin/skill/`：
- `skills/` 目录 — SKILL 定义文件（YAML/JSON）
- 使用 guard_llm 语义检测触发条件
- 触发时插入 `type: "skill"` 块

### builtin/mcp

MCP 兼容模块。配置位于项目根 `mcp.json`。
- 启动 MCP server（stdio JSON-RPC）
- 发现工具列表
- 检测 LLM 输出中的 `[TOOL:mcp.*]` → 转发工具调用 → 结果作为块插入

## 记忆系统

### 短期记忆

由 `builtin/skill` 模块管理。LLM 通过 `[FORGET:id]` 标签移除不再需要的块。

### 长期记忆

每日总结机制：
1. **完整日志**：所有块变更记录为不可变日志（`.memory/daily/YYYY-MM-DD.jsonl`）
2. **自动总结**：空闲时用 memory_llm 提取关键信息
3. **索引存储**：关键词倒排索引 + JSON 条目文件
4. **按需检索**：上下文出现相关关键词时自动检索注入

### 日志格式

```
{"op":"insert","block":{...},"time":1700000000}
{"op":"delete","blockId":"abc","time":1700000001}
{"op":"update","blockId":"def","changes":{...},"time":1700000002}
```

日志中**不真正删除**，只记录操作。

## 项目结构

```
Dolly/
├── dolly.json              # 项目配置
├── mcp.json                # MCP server 配置
├── .env                    # API keys
├── docs/                   # 文档
│   ├── ARCHITECTURE.md
│   ├── MODULES.md          # 模块开发指南
│   └── CONFIG.md           # 配置参考
├── src/
│   ├── main.ts             # 入口
│   ├── daemon/             # 守护进程（start/stop/status）
│   ├── core/
│   │   ├── context.ts      # 块上下文管理
│   │   ├── bus.ts          # 事件总线
│   │   └── llm-client.ts   # LLM API 封装
│   ├── modules/            # 模块注册表 + 基类
│   ├── blocks/             # 块类型定义 + 序列化
│   │   └── index.ts
│   └── memory/             # 记忆系统
│       ├── short-term.ts
│       └── long-term.ts
├── extensions/
│   ├── builtin/            # 内置模块
│   │   ├── llm/            #   LLM 模块
│   │   ├── skill/          #   SKILL 模块
│   │   │   └── skills/     #     用户 SKILL 定义
│   │   └── mcp/            #   MCP 模块
│   └── <user-extensions>/  # 用户扩展（每个一个文件夹）
└── .memory/                # 长期记忆数据
```

## 运行模式

### 前台

```bash
dolly run              # 前台运行
```

### 后台（Daemon）

```bash
dolly start            # 启动守护进程
dolly start --name=agent2  # 多开：指定名称
dolly stop             # 停止
dolly stop --name=agent2
dolly status           # 查看状态
dolly status --all     # 查看所有实例
```
