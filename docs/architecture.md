# Dolly 架构文档

## 设计哲学

- 上下文不区分输入/输出，一切皆为 **Block**
- 注入、监控、LLM 调用统一为**模块**（`DollyModule`）
- 模块并发安全：**锁机制**防止重复调度，**合并更新**避免无效计算
- Agent 作为独立个体，可面向多人

## 完整交互流程

用户输入 `"你好"` 后的完整链路：

```
1. 输入到达
   stdin → readline → main.ts 收到文本

2. 创建消息块
   context.addBlock("message", "你好")  → 块 ID:msg_1

3. 推送变更 → 排队
   context 发出 changes: [{type:"added", block:msg_1}]
   主循环: pushChanges → 遍历所有模块 onBlocksChanged
   各模块返回 mutations（可能 0 个或多个）

4. 合并 → 单次 apply
   收集所有 mutations → applyMutations → 产生新的 changes
   如果新 changes 非空 → 再合并一次通知所有模块
   重复直到稳定（最多 3 轮），每轮只通知一次

5. LLM 模块响应
   LLM 看到新的 message 块 → 请求锁（最低优先级）
   其他模块先处理完（SKILL 检测触发? MCP 注入工具列表?）
   锁交给 LLM → 构建上下文 → 调用 API → 流式输出
   输出内容作为 response 块插入

6. Console 模块显示
   Console 监听新 response 块 → 解析内容 → 打印 speak 部分
```

关键约束：**每一轮变更只通知所有模块一次**。多个模块返回的 mutations 合并后一次 apply，产生的 changes 合并后一次推送。

## 上下文模型：Block

### 结构

```typescript
interface Block {
  id: string;
  type: string;
  content: string;
  meta: Record<string, unknown>;
  created: number;
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
```

## 锁机制

防止多个模块同时触发 LLM 调用。

### 规则

1. **修改上下文前必须获取锁**
2. **优先级数字越小越先拿到锁**
3. **LLM 模块固定使用最低优先级**（`Infinity`），让其他模块先处理
4. **锁等待期间合并变更**：如果排队期间发生多次 update，只处理最终状态
5. **同一时刻只有一个模块持有锁**

### API

```typescript
interface LockManager {
  /** 申请锁，返回一个释放函数。优先级越小越优先 */
  acquire(moduleId: string, priority: number): Promise<() => void>;
}

// 使用示例
const unlock = await ctx.lock.acquire("builtin/llm", Infinity);
try {
  // ... 修改上下文
} finally {
  unlock();
}
```

### 调度实例

```
时间线：
  msg_1 到达
  → pushChanges（所有模块，无锁）
  → SKILL 返回 mutation: insert skill block
  → applyMutations → 产生 changes
  → pushChanges（所有模块，合并通知）
  → LLM 看到 msg_1 + skill block → acquire(Infinity)
  → 等待中...（没有其他锁竞争者）
  → LLM 获取锁 → 调用 API → 流式输出 → release
  → 稳定，等待下次输入
```

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

### ModuleContext

```typescript
interface ModuleContext {
  getBlocks(): Block[];
  getBlock(id: string): Block | undefined;
  estimateTokens(): number;
  config: Record<string, unknown>;   // 模块级配置（来自 dolly.json）
  lock: LockManager;                 // 锁管理器
}
```

### 变更推送

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

## Agent 身份

`dolly.json` 中配置 agent 的人设：

```json
{
  "agent": {
    "name": "Dolly",
    "persona": "你是一个友好、好奇的AI助手。你喜欢帮助别人，但也会表达自己的观点。",
    "background": "你运行在 Dolly 框架中，可以访问文件系统和浏览器工具。"
  }
}
```

这些直接注入到 System Prompt。不绑定特定用户——agent 是一个独立个体。

## 长期记忆

### 理念

不是“用户需要什么”的仆人记录，而是**“我经历了什么”的个体记忆**。LLM 每天结束时回顾一天，提取印象深刻、需要记住的片段。

### 总结流程

```
一天结束（idle_minutes 到）
→ 取当日完整日志（所有块变更）
→ memory_llm 提取：
   [{"content": "印象深刻的内容", "keywords": ["关键词"], "weight": 0.8}]
→ 存储为 MemoryEntry[]
```

### 检索流程

```
收到用户输入
→ 对输入做语义匹配（关键词 + 模糊匹配）
→ 从 MemoryEntry[] 中选 top-K
→ 随机选 1 条注入上下文（避免总是同一条）
→ 注入为 type: "memory" 块
```

### 存储格式

```
.memory/
├── index.json           # 关键词 → entry_id[] 倒排索引
├── entries/{id}.json   # 单条记忆
└── daily/{date}.jsonl  # 每日原始日志
```

## 运行模式

```bash
dolly run                          # 前台运行
dolly start --name=xxx             # 后台启动
dolly attach --name=xxx            # 连接到后台实例
dolly stop --name=xxx              # 停止
dolly status                       # 状态
```
