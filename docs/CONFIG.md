# Dolly 配置参考

## dolly.json

```json
{
  "name": "dolly",
  "agent": {
    "name": "Dolly",
    "persona": "你是 Dolly，一个友好的 AI 助手...",
    "background": "Dolly 是一个通用可扩展 AI Agent 框架..."
  },
  "context": {
    "max_tokens": 131072,
    "compression_threshold": 0.8,
    "decay_rate": 0.1,
    "protect_window_min": 10,
    "max_background_chars": 2000
  },
  "modules": {
    "enabled": ["builtin/console", "builtin/llm", "builtin/memory", "builtin/skill", "builtin/mcp"],
    "builtin/llm": {
      "api_key_env": "DEEPSEEK_API_KEY",
      "base_url": "https://api.deepseek.com",
      "model": "deepseek-chat",
      "enable_thinking": true
    },
    "builtin/memory": {
      "api_key_env": "DEEPSEEK_API_KEY",
      "base_url": "https://api.deepseek.com",
      "model": "deepseek-chat",
      "idle_minutes": 60
    },
    "builtin/skill": {
      "skills_dirs": ["./skills", "~/.dolly/skills"]
    },
    "builtin/mcp": { "timeout_ms": 30000 }
  },
  "daemon": {
    "pid_dir": ".dolly/daemons",
    "log_dir": ".dolly/logs"
  }
}
```

### agent

AI 的人设和背景，直接注入 System Prompt。

| 字段 | 说明 |
|------|------|
| `name` | Agent 名字 |
| `persona` | 性格/行为描述 |
| `background` | 框架背景说明 |

### modules

每个模块的配置都在 `modules` 下，键为模块 ID。LLM 配置也在此：

| 模块 | 配置项 |
|------|--------|
| `builtin/llm` | `api_key_env`, `base_url`, `model`, `enable_thinking` |
| `builtin/memory` | `api_key_env`, `base_url`, `model`, `idle_minutes` |
| `builtin/skill` | `skills_dirs`（目录列表，~ 展开为用户目录） |
| `builtin/mcp` | `timeout_ms` |

`enable_thinking`（默认 false）：启用后 LLM 可用 `{"thinking":"difficult"}` 进入深度思考，用 `{"thinking":"solved"}` 退出。凌晨 3 点自动关闭防止浪费 reasoning token。

向后兼容：旧的顶层 `llm` 字段仍能工作，会自动迁移到 modules 下。

### context

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `max_tokens` | 32768 | 硬限制，超 95% 强制清除 |
| `compression_threshold` | 0.8 | 软阈值，超此值触发遗忘 |
| `decay_rate` | 0.1 | 默认遗忘速率 /小时 |
| `protect_window_min` | 10 | 保护窗口（分钟） |
| `max_background_chars` | 2000 | Background 最大字符数 |

## mcp.json

```json
{
  "servers": {
    "fs": {
      "command": "node",
      "args": ["node_modules/@modelcontextprotocol/server-filesystem/dist/index.js", "."]
    },
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
```

## .env

```
DEEPSEEK_API_KEY=sk-xxx
```

## CLI

```bash
dolly run [--name=xxx]     # 连接实例（自动启动 daemon）
dolly start [--name=xxx]   # 后台启动 daemon
dolly stop [--name=xxx]    # 停止 daemon
dolly status               # 查看状态
```

`dolly run` 不再自己初始化模块，而是自动启动 daemon（如果没在跑）再通过 relay 连接。daemon 持久运行 MCP/LLM/memory，console 只是一个客户端投影。
