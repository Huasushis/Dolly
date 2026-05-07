# Dolly

多智能体协同网络的 **base agent 原型**。核心理念：不严格区分输入和输出，上下文仅分为 Background Prompt（固定首栏）和流动的工作上下文。所有功能——工具调用、记忆管理、Skill 触发——通过**注入/监控对偶系统**实现。

## 快速开始

```bash
pnpm install
cp .env.example .env   # 编辑填入 DEEPSEEK_API_KEY
pnpm dev               # 启动（热加载模式）
```

启动后直接打字回车。没有提示符，没有命令。Ctrl+C 退出。

## 核心概念

### 上下文模型：Head + Body

不设 role 标签。只有两个抽象层：

| 层 | 说明 |
|---|---|
| **Head** | 每个注入器维护的可变描述对象，拼合为 Background Prompt |
| **Body** | 纯文本流，按时间顺序排列。一切内容通过此流流动 |

role 概念仅在 OpenAI API 边界临时拼合，Dolly 内部完全不知道 `user`/`assistant` 的区别。

### 注入系统（Injection）

向上下文中插入内容。注入器在每次上下文变化时被调用。

```
触发条件 → 注入器.onContextChange() → 返回 InjectionEvent → 插入 Body
```

- 每个注入有唯一 ID，可被后续引用和移除
- **注入不影响当前输出流**——它在下一次 LLM 调用之前生效。如需中断当前输出，那是监控器的职责

### 监控系统（Monitor）

注入的对偶。对 LLM 输出的每个 chunk 进行检测。

```
LLM 输出流 → 监控器.onOutput() → 返回 MonitorAction → 执行操作
```

MonitorAction 类型：
- `pass` — 放行，不做任何事
- `block` — 阻塞输出流（如工具调用需等待结果）
- `inject` — 触发一次注入
- `remove` — 按 injection_id 移除上下文帧

### 优先级

每个 `InjectionEvent` 有 `priority` 字段（数字越小优先级越高）。注入前按 priority 升序排列。约定：

| priority | 含义 |
|---|---|
| 0 | 系统级（如 pinned 帧） |
| 10-30 | 高优先级任务/工具结果 |
| 50 | 常规注入 |
| 100 | 低优先级（如压缩） |

### 记忆系统

三层结构：

| 层级 | 存储 | 管理 |
|---|---|---|
| 即时上下文 | Body 中 | 直接存在于上下文窗口 |
| 短期记忆 | 注入片段（有编号） | AI 通过 `[FORGET:id]` 标签移除 |
| 长期记忆 | JSON + 关键词索引 | 空闲时 aux LLM 自动总结，按需检索注入 |

### 工具调用协议

纯文本标签，不依赖 function calling API：

```
[TOOL:工具名]           ← 非阻塞
{参数JSON}
[/TOOL]

[AWAIT:工具名]          ← 阻塞，等待结果注入后继续
{参数JSON}
[/TOOL]

[FORGET:注入ID]         ← 移除某段注入记忆
```

## 项目结构

```
src/
  main.ts                 # 入口，编排器
  config.ts               # 配置（三个 LLM 配置 + 模块路径）
  core/
    context.ts            # Head + Body 上下文管理
    bus.ts                # EventBus 事件总线
    llm-client.ts         # DeepSeek API 封装（OpenAI 格式）
  injection/
    base.ts               # InjectionModule 接口
    registry.ts           # 模块注册 + 热加载
    modules/
      default-prompt.ts   # 基础身份提示词
      skill.ts            # SKILL 包装器 + guard_llm 触发检测
      compression.ts      # 概率性随机遗忘
      test-task.ts        # 测试用任务注入器
  monitor/
    base.ts               # MonitorModule 接口
    registry.ts           # 模块注册 + 热加载
    modules/
      stdout.ts           # 输出到终端
      tool-call.ts        # 工具调用检测
      forget-detector.ts  # FORGET 标签检测
      mcp.ts              # MCP 工具调用转发
  memory/
    short-term.ts         # 短期记忆（注入生命周期）
    long-term.ts          # 长期记忆（日志→总结→索引→检索）
```

## 配置

`.env` 中配置 API key：

```
DEEPSEEK_API_KEY=sk-xxx
```

`src/config.ts` 中配置三个 LLM：
- `main_llm` — 主 agent 推理
- `memory_llm` — 长期记忆总结
- `guard_llm` — SKILL 触发条件检测

## 编写注入器

实现 `InjectionModule` 接口：

```typescript
interface InjectionModule {
  id: string;
  headContent?(): string;                              // 注入到 Background Prompt
  onContextChange?(frames: ContextFrame[]): InjectionEvent | null;  // 上下文变化时触发
  onEvent?(event: string, payload: any): InjectionEvent | null;     // 事件触发
  setup?(bus: EventBus): void;                         // 初始化
}
```

示例——注入一个任务：

```typescript
const myTask: InjectionModule = {
  id: "my-task",
  onContextChange(frames) {
    if (frames.some(f => f.content.includes("[任务]"))) return null;
    return { id: "task_001", content: "[任务] 请做某事", priority: 10 };
  },
};
export default myTask;
```

放到 `src/injection/modules/`，在 `config.ts` 的 `injection_modules` 中注册路径即可。

## 编写监控器

实现 `MonitorModule` 接口：

```typescript
interface MonitorModule {
  id: string;
  blocking?: boolean;     // 是否可阻塞输出流
  onOutput?(text: string, fullResponse: string): MonitorAction | null;
  setup?(bus: EventBus): void;
}
```

放到 `src/monitor/modules/`，在 `config.ts` 的 `monitor_modules` 中注册。
