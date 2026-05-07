# Dolly 架构

## 核心理念

不区分输入/输出。上下文仅分为 **Head**（背景提示词）和 **Body**（纯文本流）。

## 系统组成

```
User text ──→ Body ──→ Injection check ──→ LLM ──→ Monitor check ──→ stdout
                 ↑                            │
                 └── Tool result ── EventBus ──┘
```

### Head + Body

- **Head**: 每个注入器维护一个可变的描述文本（`injector_id → content`），拼合为 LLM 的 system prompt。注入器可随时修改自己的 Head 条目。
- **Body**: `ContextFrame[]`，按时间顺序排列。没有 role 字段。一切内容——用户输入、LLM 输出、注入——都是 Body 的一帧。

role 概念仅在 `buildMessages()` 的 OpenAI API 边界拼合。

### 注入系统

注入器实现 `InjectionModule` 接口。每次上下文变化时，`InjectionRegistry.getPending()` 遍历所有注入器收集注入事件。注入只影响下一次 LLM 调用。

### 监控系统

监控器实现 `MonitorModule` 接口。LLM 输出流经每个 chunk 时，`MonitorRegistry.processOutput()` 遍历所有监控器收集动作。监控器可以 `block`（暂停输出）、`inject`（触发注入）、`remove`（移除帧）。

### EventBus

注入和监控通过 EventBus 解耦。关键事件：`llm.output_chunk`、`tool.call_requested`、`tool.result`、`context.near_capacity`、`injection.removed`、`memory.forget_tag`。

### 记忆系统

| 层级 | 实现 | 触发 |
|------|------|------|
| 即时上下文 | Body 中 | 直接存在 |
| 短期记忆 | 注入片段（有编号） | AI 输出 [FORGET:id] → 监控检测 → 移除 |
| 长期记忆 | JSON + 关键词索引 | 空闲时自动总结，按需检索注入 |

### MCP 集成

`mcp.json` 定义 MCP server 列表。`McpManager` 通过 stdio JSON-RPC 连接每个 server，发现工具列表。工具调用格式：`[TOOL:mcp.服务器名.工具名]`。
