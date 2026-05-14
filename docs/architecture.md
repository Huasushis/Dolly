# Dolly 架构文档

## 设计哲学

- 上下文不区分输入/输出，一切皆为 **Block**
- 注入、监控、LLM 调用统一为**模块**（`DollyModule`）
- 模块通过推送上下文变更和提交块变更来工作
- MCP、SKILL 作为内置模块提供

## 上下文模型：Block

### 结构

```typescript
interface Block {
  id: string;           // 唯一 ID
  type: string;         // 块类型
  content: string;      // 内容
  meta: Record<string, unknown>;  // 元数据
  created: number;      // 时间戳
}
```

### 内置类型

| type | 用途 |
|------|------|
| `system` | 置顶 System Prompt |
| `message` | 用户/外部输入 |
| `response` | LLM 输出 |
| `tool_call` | 工具调用请求 |
| `tool_result` | 工具返回结果 |
| `injection` | 模块注入 |
| `skill` | SKILL 触发注入 |

### 序列化格式（发给 LLM）

```
[ID:abc][TYPE:message][TIME:1700000000]
用户输入的内容

[ID:def][TYPE:tool_result][TIME:1700000001]
{"result": "..."}

[ID:ghi][TYPE:injection][TIME:1700000002]
系统注入的信息
```

每块 `[ID][TYPE][TIME]` 头部 + 内容体。role 仅在 OpenAI API 边界拼合。

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

### 变更推送

当块被 added/removed/modified 时，向所有模块推送：

```typescript
interface BlockChange { type: "added" | "removed" | "modified"; block: Block; }
```

### 模块返回

```typescript
type BlockMutation =
  | { action: "insert"; block: Omit<Block, "id">; priority: number }
  | { action: "delete"; blockId: string }
  | { action: "update"; blockId: string; content?: string; meta?: Record<string, unknown> }
```

### LLM 触发

当有新的 `type: "message"` 块加入时触发 LLM。blocking 工具调用完成后通过 continuation message 再次触发。

## 内置模块

### builtin/llm

- 监听新 `message` 块 → 构建上下文 → 调用 LLM API → 流式输出
- 解析 fenced JSON 命令：`{"tool":"name","params":{}}` / `{"forget":"id"}`
- 返回 response 块

### builtin/skill

- 加载 `extensions/builtin/skill/skills/*.json`
- 上下文变化时用 `guard_llm` 语义检测触发条件
- 触发时插入 `type: "skill"` 块

### builtin/mcp

- 读取 `mcp.json`，启动各 MCP server（stdio JSON-RPC）
- 发现工具列表，通知 SKILL 模块
- 处理 `tool.call_requested` 事件，路由到对应 server

## 记忆系统

### 短期记忆

LLM 通过 `{"forget":"block_id"}` 移除不需要的注入块。

### 长期记忆

- **日志**：`.memory/daily/YYYY-MM-DD.jsonl` 记录所有块变更操作
- **总结**：空闲 `idle_minutes` 分钟后用 `memory_llm` 生成摘要
- **检索**：关键词倒排索引，按需查询

### 日志格式（JSONL）

```json
{"op":"insert","detail":{"type":"message","content":"你好"},"time":1700000000}
{"op":"delete","detail":{"id":"abc","type":"injection"},"time":1700000001}
```

日志中不真正删除，只记录操作。

## 运行模式

```bash
pnpm start                    # 前台运行
node --import tsx src/main.ts start --name=xxx  # 后台启动
node --import tsx src/main.ts stop              # 停止
node --import tsx src/main.ts status            # 状态
```
