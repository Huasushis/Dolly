# Dolly

通用可扩展 AI Agent 框架。核心理念：上下文由 Block 构成，一切是 Module。

## 快速开始

```bash
git clone https://github.com/Huasushis/Dolly.git
cd Dolly
pnpm install
cp .env.example .env          # 编辑填入 DEEPSEEK_API_KEY
pnpm typecheck                # 类型检查
node --import tsx/esm bin/dolly.js start   # 后台启动
node --import tsx/esm bin/dolly.js console # 交互终端
```

## 设计

整个上下文是 AI 的**内心世界**。块只有两种：

- `inner` — 内部：思考、回忆、skill 注入、背景压缩
- `outer` — 外部：用户消息、工具结果、监听器输入

框架只定义 `pinned` / `source` / `decay_rate` 三个 meta 键。细化分类由各 extension 通过 `meta.subtype` 自行管理。

### 核心模块

| 模块 | 职责 |
|------|------|
| `builtin/console` | speak 解析、历史缓冲、Web 控制台 (HTTP+WS) |
| `builtin/llm` | LLM 调用、思维引导、forget/thinking 教学 |
| `builtin/memory` | daily log、三步总结、记忆召回、午夜流水线（background + mskill） |
| `builtin/skill` | SKILL.md 批量 guard 检测、技能注入 |
| `builtin/mcp` | MCP 工具连接、调用、重连 |

## CLI

```bash
# 框架命令
dolly serve [--config=<p>]                 # 前台运行（日志可见，Ctrl-C 退出）
dolly serve --daemon [--config=<p>]        # 后台启动
dolly start [--config=<p>]                 # 后台启动（= serve --daemon）
dolly stop [--name=<n>] [-f]              # 停止 daemon
dolly status [--name=<n>]                  # 查看状态
dolly help                                 # 动态帮助（含所有 extension 命令）

# Extension 命令
dolly console                              # 交互终端 + Web UI (http://localhost:8080)
dolly console history                      # 查看 speak 历史
dolly console clear                        # 清除历史
dolly memory midnight                      # 强制执行午夜总结
dolly memory recall <query>                # 搜索记忆
dolly memory search <query>                # 搜索日总结
dolly skill reload                         # 重载 skills
dolly skill list                           # 列出 skills
dolly mcp reload                           # 重连 MCP
dolly mcp list                             # 列出工具
dolly enable <id>                          # 启用扩展
dolly disable <id>                         # 禁用扩展
dolly reload [--ext=<id>]                  # 重载扩展
```

所有命令支持 `--name=xxx`（多开）、`--config=<path>`（指定配置）。

## 配置

### dolly.json

```json
{
  "agent": { "name": "Dolly", "persona": "你是 Dolly，一个普通人类..." },
  "context": { "max_tokens": 131072, "compression_threshold": 0.8, "decay_rate": 0.1, "protect_window_min": 10 },
  "modules": {
    "enabled": ["builtin/console", "builtin/llm", "builtin/memory", "builtin/skill", "builtin/mcp"],
    "builtin/llm": { "api_key_env": "DEEPSEEK_API_KEY", "base_url": "https://api.deepseek.com", "model": "deepseek-chat", "enable_thinking": true },
    "builtin/memory": { "api_key_env": "DEEPSEEK_API_KEY", "base_url": "https://api.deepseek.com", "model": "deepseek-chat", "idle_minutes": 60, "enable_thinking": true },
    "builtin/skill": { "skills_dirs": ["./skills", "~/.dolly/skills"] },
    "builtin/console": { "port": 8080 },
    "builtin/mcp": {}
  }
}
```

Background 不是配置项——由 memory 每天凌晨压缩上下文生成，作为 pinned inner 块。

### mcp.json

```json
{
  "servers": {
    "fs": { "command": "node", "args": ["node_modules/@modelcontextprotocol/server-filesystem/dist/index.js", "."] }
  }
}
```

## 开发扩展

```typescript
import type { DollyModule } from "../../src/modules/base.js";

const myExt: DollyModule = {
  id: "my-ext",
  async init(ctx) {},
  systemPrompt(): string { return "注入到 AI 的提示词"; },
  async onBlocksChanged(ctx, changes) {
    const mutations = [];
    for (const c of changes) {
      if (c.type === "added" && c.block.type === "outer") {
        mutations.push({
          action: "insert", priority: 50,
          block: { type: "inner", content: "...", meta: { source: "my-ext", subtype: "my-type" }, created: Date.now() },
        });
      }
    }
    return mutations;
  },
  async onStop(ctx) { ctx.saveState({ key: "value" }); },
  async onStart(ctx) { const s = ctx.loadState(); },
  async handleCli(args, ctx) { process.stdout.write(`my-ext: ${args}\n`); },
  cliInfo: [{ cmd: "my-ext", sub: "", desc: "我的命令" }],
};
export default myExt;
```

详见 [文档](docs/).

## 许可

MIT
