# Dolly 架构文档

## 设计哲学

- 框架模拟 AI 的**内心世界**。上下文只有 `inner`（内）和 `outer`（外）两种块
- 第一人称视角：inner = "我想的/我记得的/我学会的"，outer = "我看到的/我听到的"
- 一切是 Block，一切是 Module。LLM 就是 extension，role 只在 API 边界拼
- 框架不可见——不生成内容、不调工具、不替 extension 组 prompt

## 内心世界

```
┌─────────────────────────┐
│ System Prompt (各模块注入) │  agent.persona + 各 extension 的 systemPrompt
├─────────────────────────┤
│ Working Context (Block流) │
│   type: inner (内部)      │  LLM response / skill 注入 / memory 召回 / background / reasoning
│   type: outer (外部)      │  用户输入 / MCP 结果 / 外部监听器
│                          │
│   {"speak":"..."} (对外)  │  console 解析后显示 + relay 广播
│   {"tool":"name"} (对外)  │  MCP 模块处理
│   {"forget":"ID"} (框架)  │  框架原生扫描执行
└─────────────────────────┘
```

Background 是 memory extension 维护的 pinned inner 块（subtype=background），每天凌晨压缩整个上下文更新。

## 上下文模型：Block

```typescript
interface Block {
  id: string;                     // UUID
  type: string;                   // "system" | "inner" | "outer"
  content: string;
  meta: Record<string, unknown>;  // pinned, source, decay_rate (框架) + 自定义
  created: number;
}
```

### 框架原生 meta（只有 3 个）

| 键 | 说明 |
|--- |------|
| `pinned` | true → 永不遗忘 |
| `source` | 创建者 extension ID |
| `decay_rate` | 遗忘速率/小时 |

### Extension 自定义 meta（示例）

| 键 | 所属 | 说明 |
|----|------|------|
| `subtype` | 任意 | 细化分类（response/skill/memory/background/tool_result） |
| `skill` | skill | 触发注入的 skill 名 |
| `tool` | MCP | 工具名 |

### 序列化格式

```
[ID:abc][TYPE:inner/response][TIME:1700000000]
LLM 回应的内容

[ID:def][TYPE:outer/tool_result][TIME:1700000001]
{"result": "..."}
```

## 进程模型

```
dolly console (客户端) ──TCP──→ relay socket ──→ daemon (服务器)
dolly memory midnight ──TCP──→                    ↑
dolly skill reload  ──TCP──→                future: web UI / API
```

- **daemon** 持久运行：MCP 连接、LLM 调用、上下文、记忆。stdin 忽略，所有 I/O 通过 relay socket
- **CLI 客户端** 连接 daemon 发送结构化 JSON 命令 `{"cmd":"ext","args":[...]}`
- 框架原生命令：`dolly start/stop/status`

## 模块系统

### ModuleRegistry

发现、加载、卸载、lifecycle dispatch、system prompt 组装、cascade push、CLI 路由。

### DollyModule 接口

```typescript
interface DollyModule {
  id: string;
  init?(ctx: ModuleContext): Promise<void>;
  onBlocksChanged?(ctx: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]>;
  systemPrompt?(ctx: ModuleContext): string;
  onStop?(ctx: ModuleContext): Promise<void>;
  onStart?(ctx: ModuleContext): Promise<void>;
  handleCli?(args: string[], ctx: ModuleContext): Promise<void>;
}
```

### Cascade 循环（唯一编排机制）

```
applyMutations() → BlockChange[]
  → pushChanges(changes) → BlockMutation[]
    → applyMutations(mutations) → BlockChange[]
  → 最多 3 轮
```

每轮之间框架扫描 forget、pre-cascade 检查 token 硬阈值。

## 框架核心组件

| 组件 | 职责 |
|------|------|
| ContextManager | Block CRUD、token 估算、指数衰减、applyMutations、restoreBlock |
| EventBus | emit/on/off 事件路由 |
| LockManager | 优先级 async 互斥锁 |
| ModuleRegistry | 模块生命周期、prompt 组装、cascade dispatch、CLI 路由 |
| config.ts | 加载 dolly.json、env var 解析 |
| blocks/index.ts | Block 类型、序列化、BlockChange/BlockMutation |

LLMClient 是 **extension 共享工具**，不是框架核心。框架不持有、不调用。

## 内置模块

| 模块 | 职责 | systemPrompt |
|------|------|-------------|
| builtin/console | speak 解析 + 历史缓冲 + relay 广播 | `{"speak":"..."}` 用法 |
| builtin/llm | 响应 outer 块、调用 LLM、思考引导 | 第一人称内心世界 + 独白例子 + forget/thinking |
| builtin/memory | daily log、3步总结、auto-recall、午夜流水线（background+mskill） | `{"recall":"hard/soft"}` 用法 |
| builtin/skill | 批量 guard 检测、SKILL.md 加载（含 mskill）、注入 skill 块 | — |
| builtin/mcp | MCP 连接、工具调用、工具列表注入 | 工具列表 + `{"tool":"name","params":{}}` |

## Forget 机制

**框架原生**。cascade 中扫描所有新 block 的 fenced JSON，匹配 `{"forget":"ID"}` → 直接 removeBlock → 产生 "removed" BlockChange 通知所有 extension。不依赖 LLM extension。

## 指数衰减遗忘

`P(forget) = 1 - exp(-rate * age_hours)`

- 软阈值 0.8：加权随机删 1 个块
- 硬阈值 0.95：强制循环删至 0.8 以下
- 保护窗口：10 分钟内的块永不删除
- 每块可设不同 decay_rate

## Profile 与多开

```
.dolly/profiles/<name>/
├── context.json             # 每次 cascade 后自动保存
├── exts/                    # 各扩展存储目录
│   ├── builtin/console/     # speak_history.json
│   ├── builtin/memory/      # memory-store/ + mskills/
│   └── ...
└── ...
```

## Fenced JSON 协议

```json
{"speak":"对用户说的话"}       // Console 解析，relay 广播
{"tool":"name","params":{}}  // MCP 工具调用
{"forget":"块ID"}            // 框架原生，任何块内都生效
{"recall":"hard"}           // Memory 深度召回
{"thinking":"difficult"}    // LLM 深度思考开启
{"thinking":"solved"}       // LLM 深度思考关闭
```

## CLI

```bash
dolly start [--name=xxx]     # 后台启动 daemon
dolly stop [--name=xxx]      # 停止 daemon
dolly status                 # 查看状态
dolly console [--name=xxx]   # 交互式终端
dolly memory midnight        # 强制执行午夜流水线
dolly memory recall <query>  # 搜索记忆
dolly skill reload           # 重载 skills
dolly skill list             # 列出 skills
dolly mcp reload             # 重载 MCP 连接
dolly mcp list               # 列出 MCP 工具
```
