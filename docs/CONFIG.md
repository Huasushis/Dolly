# Dolly 配置参考

## dolly.json

```json
{
  "name": "dolly",
  "agent": {
    "name": "Dolly",
    "persona": "你是 Dolly，一个友好、好奇的 AI 助手。"
  },
  "context": {
    "max_tokens": 131072,
    "compression_threshold": 0.8,
    "decay_rate": 0.1,
    "protect_window_min": 10
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
    "builtin/mcp": {}
  },
  "daemon": {
    "pid_dir": ".dolly/daemons"
  }
}
```

### agent

| 字段 | 说明 |
|------|------|
| `name` | Agent 名字 |
| `persona` | 性格/行为描述，直接注入 System Prompt |

没有 `background`——background 由 memory extension 每天凌晨从上下文压缩生成，是一个 pinned inner 块。

### modules

每个模块的配置在 `modules` 下，键为模块 ID。`api_key_env` 指定的环境变量会被自动解析为 `api_key`。

| 模块 | 配置项 | 说明 |
|------|--------|------|
| `builtin/llm` | `api_key_env`, `base_url`, `model`, `enable_thinking` | 主 LLM 配置 |
| `builtin/memory` | `api_key_env`, `base_url`, `model`, `idle_minutes` | 记忆总结 LLM + 空闲分钟数 |
| `builtin/skill` | `skills_dirs` | 额外扫描的 skills 目录列表，`~` 展开为用户目录 |
| `builtin/mcp` | 无特殊配置 | MCP 服务器列表在 `mcp.json` |

### context

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `max_tokens` | 32768 | 硬限制，超 95% 强制清除 |
| `compression_threshold` | 0.8 | 软阈值 |
| `decay_rate` | 0.1 | 默认遗忘速率 /小时 |
| `protect_window_min` | 10 | 保护窗口（分钟） |

### daemon

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `pid_dir` | `.dolly/daemons` | PID 文件目录 |

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
dolly start [--name=xxx]     # 后台启动 daemon
dolly stop [--name=xxx]      # 停止 daemon
dolly status                 # 查看状态
dolly console [--name=xxx]   # 交互式终端
dolly memory midnight        # 强制执行午夜流水线
dolly memory recall <q>      # 搜索记忆
dolly skill reload           # 重载 skills
dolly skill list             # 列出 skills
dolly mcp reload             # 重载 MCP 连接
```

向后兼容：旧的顶层 `llm` 字段仍能工作，会自动迁移到 modules 下。
