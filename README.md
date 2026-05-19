# Dolly

通用可扩展 AI Agent 框架。核心理念：上下文由 Block 构成，一切是 Module。

## 快速开始

```bash
pnpm install
cp .env.example .env   # 编辑填入 DEEPSEEK_API_KEY
pnpm typecheck
node --import tsx/esm bin/dolly.js start
node --import tsx/esm bin/dolly.js console
```

## 设计

整个上下文是 AI 的**内心世界**。块只有两种：

- `inner` — AI 内部产生（思考、回应、skill 注入、记忆召回）
- `outer` — 外部输入（用户消息、MCP 结果）

框架只定义 `pinned` / `source` / `decay_rate` 三个 meta 键。细化分类由 extension 通过 `meta.subtype` 自行管理。

### 核心扩展

- **builtin/console** — `speak` 解析、历史缓冲
- **builtin/llm** — LLM 调用、思维引导
- **builtin/memory** — 三步总结、记忆召回、午夜流水线（background + mskill）
- **builtin/skill** — SKILL.md 触发检测
- **builtin/mcp** — MCP 工具连接

详见 [架构文档](docs/ARCHITECTURE.md)。

## CLI

```bash
# 框架命令
dolly serve                        # 前台运行（日志可见）
dolly serve --daemon               # 后台启动 daemon
dolly start                        # = serve --daemon
dolly stop [-f]                    # 停止 daemon
dolly status                       # 查看状态
dolly help                         # 动态帮助（含 extension 命令）

# Extension 命令（连 daemon，自动启动）
dolly console                      # 交互式终端 + Web UI (http://localhost:8080)
dolly console history              # 查看 speak 历史
dolly memory midnight             # 强制执行午夜总结
dolly memory recall <q>           # 搜索记忆
dolly skill reload                # 重载 skills
dolly skill list                  # 列出 skills
dolly mcp reload                  # 重连 MCP
dolly enable <ext-id>             # 启用扩展
dolly disable <ext-id>            # 禁用扩展
dolly reload [--ext=<id>]         # 重载扩展
```

所有命令支持 `--name=xxx`、`--config=<path>`。

## 项目结构

```
Dolly/
├── dolly.json              # 项目配置
├── mcp.json                # MCP server 列表
├── docs/                   # ARCHITECTURE / MODULES / CONFIG
├── src/
│   ├── main.ts             # 编排器
│   ├── config.ts           # 配置加载
│   ├── daemon/             # start/stop/status + attach relay
│   ├── core/               # context / bus / lock
│   ├── blocks/index.ts     # Block 类型 + 序列化
│   ├── modules/            # base (接口) + registry
│   └── memory/             # store + nlp
├── extensions/
│   └── builtin/            # console / llm / memory / skill / mcp
└── .dolly/profiles/        # 实例数据（context/speak/memory）
```

## 配置

### dolly.json

```json
{
  "agent": { "name": "Dolly", "persona": "你是 Dolly，一个友好、好奇的 AI 助手。" },
  "context": { "max_tokens": 131072, "compression_threshold": 0.8, "decay_rate": 0.1, "protect_window_min": 10 },
  "modules": {
    "enabled": ["builtin/console", "builtin/llm", "builtin/memory", "builtin/skill", "builtin/mcp"],
    "builtin/llm": {
      "api_key_env": "DEEPSEEK_API_KEY",
      "base_url": "https://api.deepseek.com",
      "model": "deepseek-chat",
      "enable_thinking": true
    },
    "builtin/memory": {
      "api_key_env": "DEEPSEEK_API_KEY", "base_url": "https://api.deepseek.com", "model": "deepseek-chat",
      "idle_minutes": 60
    },
    "builtin/skill": { "skills_dirs": ["./skills", "~/.dolly/skills"] },
    "builtin/mcp": {}
  },
  "daemon": { "pid_dir": ".dolly/daemons" }
}
```

Background 不是配置项——由 memory 每天凌晨压缩上下文生成，作为 pinned inner 块。

详见 [配置文档](docs/CONFIG.md)。

## 编写扩展

每个扩展一个文件夹，含 `dolly.json` + `index.ts`：

```typescript
import type { DollyModule } from "../../src/modules/base.js";

const myExt: DollyModule = {
  id: "my-ext",
  async init(ctx) {},
  async onBlocksChanged(ctx, changes) {
    const mutations = [];
    for (const c of changes) {
      if (c.type === "added" && c.block.type === "outer") {
        mutations.push({
          action: "insert", priority: 50,
          block: { type: "inner", content: "我看到了新消息", meta: { source: "my-ext", subtype: "my-type" }, created: Date.now() },
        });
      }
    }
    return mutations;
  },
};
export default myExt;
```

详见 [模块开发指南](docs/MODULES.md)。

## 路线图

- [x] Block 上下文（system/inner/outer）
- [x] Cascade 编排 + 框架原生 Forget
- [x] MCP 集成 + 工具调用
- [x] 批量 guard skill 触发
- [x] 三步记忆总结 + 多级召回
- [x] 午夜流水线（background 压缩 + mskill 自生成）
- [x] 守护进程（start/stop/status）
- [x] Extension lifecycle（onStop/onStart）
- [x] extension CLI 命令（handleCli）
- [x] 指数衰减上下文遗忘
- [x] 多开 profile 隔离

## 许可

MIT
