<p align="center">
  <h1 align="center">Dolly</h1>
  <p align="center">
    通用可扩展 AI Agent 框架。Block 上下文 · 统一模块 · 多开守护进程。
    <br/>
    <a href="docs/"><strong>浏览文档 »</strong></a>
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
  <img src="https://img.shields.io/badge/node-%3E%3D22-green" alt="Node">
  <img src="https://img.shields.io/badge/typescript-5.6-blue" alt="TypeScript">
</p>

<details open>
<summary>目录</summary>

- [关于](#关于)
- [快速开始](#快速开始)
- [特性](#特性)
- [架构](#架构)
- [CLI 用法](#cli-用法)
- [项目结构](#项目结构)
- [配置](#配置)
- [编写扩展](#编写扩展)
- [测试清单](#测试清单)
- [路线图](#路线图)
- [贡献](#贡献)
- [许可](#许可)
</details>

## 关于

Dolly 是一个**可扩展的通用 AI Agent 框架**，对标 OpenClaw / Hermes。它不绑定任何特定 LLM 或工具生态，而是提供一套极简的抽象——**Block 上下文 + 统一模块**——来构建任意形态的 AI agent。

**核心理念：**
- 上下文不区分输入/输出，一切皆为 **Block**
- 注入、监控、LLM 调用统一为 **模块**，每个模块是一个独立文件夹
- MCP、SKILL 作为内置模块提供，用户可自由扩展

## 快速开始

**前置条件：** Node.js ≥ 22，pnpm

```bash
# 1. 安装
git clone https://github.com/Huasushis/Dolly.git
cd Dolly
pnpm install

# 2. 配置
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY=sk-xxx

# 3. 运行（前台）
pnpm start
```

启动后直接打字回车。Ctrl+C 退出。

```bash
# 后台启动 / 管理
node --import tsx src/main.ts start              # 启动守护进程
node --import tsx src/main.ts start --name=agent2  # 多开
node --import tsx src/main.ts stop               # 停止
node --import tsx src/main.ts status             # 查看状态
```

## 特性

| 特性 | 说明 |
|---|---|
| 🧱 Block 上下文 | 所有信息统一为 `{id, type, content, meta}` 块，ID/TYPE 头部 + JSON 体 |
| 🔌 统一模块 | 注入/监控/LLM 合一，`onBlocksChanged` 推送变更，返回 `BlockMutation` |
| 🛠 MCP 原生集成 | `mcp.json` 配置 server，LLM 用 fenced JSON 调用，自动路由 |
| 🎯 SKILL 语义触发 | `extensions/builtin/skill/skills/*.json` 定义技能，guard_llm 语义检测 |
| 🧠 三层记忆 | 即时上下文 + 短期(FORGET) + 长期(空闲自动总结) |
| 📦 热加载扩展 | `extensions/` 下每个模块一个文件夹，chokidar 监听热重载 |
| 🔄 多开守护进程 | `start/stop/status` 命令行，`--name` 多实例，独立 PID |
| 📝 JSON 工具协议 | LLM 用 fenced JSON `{"tool":"name","params":{}}` 调用工具，无脆弱标签 |

## 架构

```
User Input → Block → ModulePush → LLM Module → API Call → Stream → JSON Parse
                              ↑                                    ↓
                         SKILL Module ← block changes ← Tool Result ← MCP Module
                              ↓
                        Memory Store (.memory/)
```

- **Block**：`[ID:xxx][TYPE:xxx][TIME:xxx]\ncontent`，JSON-like 序列化
- **Module**：`onBlocksChanged(changes)` → `BlockMutation[]`（insert/delete/update）
- **MCP**：`mcp.json` → stdio JSON-RPC → 工具发现 → `{"tool":"mcp.fs.read_file"}`
- **SKILL**：`skills/*.json` → guard_llm 语义匹配 → 注入 skill 块

详见 [架构文档](docs/ARCHITECTURE.md)。

## CLI 用法

```bash
# 前台（交互式）
pnpm start

# 后台守护进程
node --import tsx src/main.ts start                # 启动
node --import tsx src/main.ts start --name=agent2  # 多开（独立 profile）
node --import tsx src/main.ts stop                 # 停止
node --import tsx src/main.ts stop --name=agent2 -f  # 强制停止
node --import tsx src/main.ts status               # 查看状态
node --import tsx src/main.ts status --all          # 所有实例
```

## 项目结构

```
Dolly/
├── dolly.json              # 项目配置（含模块级配置）
├── mcp.json                # MCP server 列表
├── .env                    # API keys
├── docs/                   # 文档
│   ├── ARCHITECTURE.md     #   架构设计
│   ├── MODULES.md          #   模块开发指南
│   └── CONFIG.md           #   配置参考
├── src/
│   ├── main.ts             # 入口 + CLI 路由
│   ├── daemon/index.ts     # 守护进程（start/stop/status）
│   ├── core/               # 上下文管理器、事件总线、LLM 客户端
│   ├── blocks/index.ts     # Block 类型 + 序列化
│   ├── modules/            # 模块基类 + 注册表
│   └── memory/store.ts     # 记忆存储（JSONL 日志 + 关键词索引）
├── extensions/
│   └── builtin/            # 内置模块
│       ├── llm/            #   LLM 调用模块
│       │   ├── dolly.json  #   模块清单
│       │   └── index.ts    #   模块代码
│       ├── skill/          #   SKILL 语义触发模块
│       │   ├── dolly.json
│       │   ├── index.ts
│       │   └── skills/     #   用户 SKILL 定义（*.json）
│       └── mcp/            #   MCP 集成模块
│           ├── dolly.json
│           └── index.ts
├── .dolly/                 # 运行时数据（PID、profile、日志）
└── .memory/                # 长期记忆存储
```

## 配置

### dolly.json

```json
{
  "name": "my-agent",
  "llm": {
    "main":  { "api_key_env": "DEEPSEEK_API_KEY", "base_url": "https://api.deepseek.com", "model": "deepseek-chat" },
    "memory":{ "api_key_env": "DEEPSEEK_API_KEY", "base_url": "https://api.deepseek.com", "model": "deepseek-chat" },
    "guard": { "api_key_env": "DEEPSEEK_API_KEY", "base_url": "https://api.deepseek.com", "model": "deepseek-chat" }
  },
  "context": { "max_tokens": 32768, "compression_threshold": 0.8 },
  "modules": {
    "enabled": ["builtin/llm", "builtin/skill", "builtin/mcp"],
    "builtin/skill": { "max_skills": 10 },
    "builtin/mcp": { "timeout": 30000 }
  },
  "memory": { "path": ".memory", "auto_summarize": true, "idle_minutes": 60 },
  "daemon": { "pid_dir": ".dolly/daemons", "log_dir": ".dolly/logs" }
}
```

`modules` 下可用 `"模块id": { ... }` 传递模块级配置，注入到 `ModuleContext.config`。

### mcp.json

```json
{
  "servers": {
    "fs": { "command": "node", "args": ["node_modules/@modelcontextprotocol/server-filesystem/dist/index.js", "."] }
  }
}
```

## 编写扩展

每个扩展是一个文件夹，包含 `dolly.json`（清单）+ `index.ts`（代码）：

```
extensions/my-ext/
├── dolly.json          # {"name":"my-ext","version":"0.1.0"}
└── index.ts            # export default { id, init?, onBlocksChanged?, systemPrompt? }
```

```typescript
// index.ts — 最小示例
import type { DollyModule } from "../../src/modules/base.js";

const myExt: DollyModule = {
  id: "my-ext",
  async onBlocksChanged(ctx, changes) {
    const mutations = [];
    for (const c of changes) {
      if (c.type === "added" && c.block.type === "message") {
        mutations.push({ action: "insert", priority: 50, block: { type: "injection", content: "Hello!", meta: {}, created: Date.now() } });
      }
    }
    return mutations;
  },
};
export default myExt;
```

放入 `extensions/`，在 `dolly.json` 的 `modules.enabled` 中添加 `"my-ext"` 即生效。

## 测试清单

每次修改后应验证：

| 类别 | 测试项 | 预期 |
|------|--------|------|
| LLM | 基本对话 | LLM 正常回复，1 轮 cascade 停止 |
| LLM | fenced JSON 工具调用 | `{"tool":"datetime"}` 被检测，结果注入 |
| MCP | 连接 MCP server | 启动日志显示工具数量 |
| MCP | 调用 MCP 工具 | `{"tool":"read_file","params":{"path":"..."}}` 正确执行 |
| MCP | await 模式 | `"await":true` 时 LLM 等待结果后继续 |
| SKILL | 语义触发 | guard_llm 判断触发条件，注入 skill 块 |
| SKILL | 不误触发 | 无关话题不触发任何 SKILL |
| 记忆 | daily log 写入 | `.memory/daily/YYYY-MM-DD.jsonl` 记录所有操作 |
| 记忆 | FORGET 移除 | `{"forget":"block_id"}` 正确移除指定块 |
| 记忆 | 长期总结 | 空闲时 memory_llm 生成总结条目 |
| CLI | start/stop/status | 命令正常执行 |
| CLI | 多开 | 不同 --name 独立 PID 和 profile |

## 路线图

- [x] Block 上下文 + 统一模块
- [x] MCP 集成（stdlib JSON-RPC）
- [x] SKILL 语义触发（guard_llm）
- [x] 三层记忆（即时/短期/长期）
- [x] 守护进程（start/stop/status）
- [x] 热加载扩展
- [ ] `dolly` CLI 命令（全局安装）
- [ ] 上下文持久化 + 恢复
- [ ] 多开 profile 隔离
- [ ] Console 作为独立 extension
- [ ] LLM 输出结构化（speak/think/tool 分离）

## 贡献

```bash
git clone https://github.com/Huasushis/Dolly.git
cd Dolly
pnpm install
pnpm typecheck    # 类型检查
pnpm start        # 前台测试
```

Fork → Branch → 修改 → `pnpm typecheck` → PR。

## 许可

MIT © 2026 陈鑫
