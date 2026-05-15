# Dolly 架构文档

## 设计哲学

- 上下文不区分输入/输出，一切皆为 **Block**
- 整个上下文是 AI 的**内心世界**——默认即为 think，只有 `speak` 和工具调用对外
- 注入、监控、LLM 统一为**模块**（`DollyModule`），**LLM 就是一个 extension**

## 内心世界

```
┌─────────────────────────┐
│ System Prompt (各模块注入) │
├─────────────────────────┤
│ Background (AI 自述)      │  长度受限，每天凌晨 memory_llm 更新
├─────────────────────────┤
│ Working Context (Block流) │  一切——message/response/tool/skill
│   内心独白 (默认)          │  只有 speak 块展示给用户
│   {"speak":"..."} (对外)  │  {"tool":"name"} (对外交互)
│   {"forget":"id"}        │  {"recall":"hard/soft"}
└─────────────────────────┘
```

## 上下文模型：Block

### 结构

```typescript
interface Block {
  id: string;
  type: string;
  content: string;
  meta: Record<string, unknown>;  // source, notify, decay_rate, recall_level...
  created: number;
}
```

### 关键 meta 字段

| 字段 | 说明 |
|------|------|
| `source` | 创建者 extension ID，用于防自响应 |
| `notify` | `false` 时不触发 LLM |
| `decay_rate` | 遗忘速率（/小时），默认 0.1。MCP 输出 0.5 |
| `pinned` | 永不遗忘 |

### 序列化格式

```
[ID:abc][TYPE:message][TIME:1700000000]
用户输入的内容

[ID:def][TYPE:tool_result][TIME:1700000001]
{"result": "..."}
```

role 仅在 OpenAI API 边界拼合。

## 模块系统

### 统一接口

```typescript
interface DollyModule {
  id: string;
  init?(ctx: ModuleContext): Promise<void>;
  onBlocksChanged?(ctx: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]>;
  systemPrompt?(ctx: ModuleContext): string;
}
```

### 防自响应

每个 extension 创建的块必须加 `meta.source = ownId`。`onBlocksChanged` 中必须过滤 `ch.block.meta?.source === ownId`。

### BlockMutation

```typescript
type BlockMutation =
  | { action: "insert"; block: Omit<Block, "id">; priority: number }  // 插入新块，priority 越小越靠前
  | { action: "delete"; blockId: string }                              // 按 ID 删除块
  | { action: "update"; blockId: string; content?: string; meta?: Record<string, unknown> }  // 更新块内容/meta
```

## 记忆系统

### 日总结 + 日志钻取

- **总结**：每天一段话（`DaySummary`），memory_llm 提取印象+认知+情绪权重
- **think 反思**：总结前先反思情绪强度（0.1-1.0，不分正负）
- **检索**：`recall()` → search day summaries（bigram+TF-IDF+余弦）→ drill daily JSONL → 提取相关片段
- **recall 标签**：`{"recall":"hard"}` 或 `{"recall":"soft"}` 控制检索深度

### 上下文遗忘

指数衰减：`P(forget) = 1 - e^(-rate * age_hours)`

- **软阈值 0.8**：加权随机删 1 个块
- **硬阈值 0.95**：强制循环删至 0.8 以下
- **保护窗口**：10 分钟内的块永不删除
- 不同扩展可设不同 `decay_rate`

## 进程模型

```
dolly run (客户端) ──pipe──→ relay socket ──→ daemon (服务器)
                                ↑
                          web UI / API (未来)
```

- **daemon** 持久运行：MCP 连接、LLM 调用、上下文、记忆全在此。`stdin` 忽略，所有 I/O 通过 relay socket
- **console（dolly run）** 只是客户端投影：自动启动 daemon（如果没在跑），通过 socket 转发输入/接收输出
- daemon 停止时自动保存 profile。每次 cascade 后也自动保存

## Profile 与多开

```
.dolly/profiles/<name>/
├── context.json             # 每次 cascade 后自动保存
├── exts/                    # 各扩展存储目录
│   └── builtin-memory/
│       ├── index.json
│       ├── entries/{day}.json
│       └── daily/{day}.jsonl
└── ...
```

## Fenced JSON 协议

所有对外交互通过 fenced JSON：

```json
{"speak":"对用户说的话"}        // Console 模块解析，展示给用户
{"tool":"name","params":{}}   // 工具调用，MCP 模块处理
{"forget":"块ID"}              // 遗忘指定块
{"recall":"hard"}             // 请求深度记忆检索
```

## 内置模块

| 模块 | 职责 | systemPrompt |
|------|------|-------------|
| builtin/console | speak 显示 + 历史缓冲 | 教 LLM 用 `{"speak":"..."}` |
| builtin/llm | API 调用 + 流式输出 + thinking | 第一人称内心世界 + forget |
| builtin/skill | 语义触发 + 去重 | — |
| builtin/mcp | MCP 工具连接 + 调用 | 可用工具列表 + tool 用法 |
| builtin/memory | daily log + 总结 + 检索 | recall 标签使用 |
| builtin/mcp | MCP server 连接 + 工具路由 | 及时遗忘 MCP 输出 |
