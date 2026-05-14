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
  "llm": {
    "main": {
      "api_key_env": "DEEPSEEK_API_KEY",
      "base_url": "https://api.deepseek.com",
      "model": "deepseek-chat",
      "max_tokens": 131072
    },
    "memory": {
      "api_key_env": "DEEPSEEK_API_KEY",
      "base_url": "https://api.deepseek.com",
      "model": "deepseek-chat"
    },
    "guard": {
      "api_key_env": "DEEPSEEK_API_KEY",
      "base_url": "https://api.deepseek.com",
      "model": "deepseek-chat"
    }
  },
  "context": {
    "compression_threshold": 0.8,
    "decay_rate": 0.1,
    "protect_window_min": 10,
    "max_background_chars": 2000
  },
  "modules": {
    "enabled": ["builtin/console", "builtin/llm", "builtin/skill", "builtin/mcp"],
    "builtin/skill": { "max_skills": 20 },
    "builtin/mcp": { "timeout_ms": 30000 }
  },
  "memory": {
    "auto_summarize": true,
    "idle_minutes": 60
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

### llm

三组 LLM 配置。`max_tokens` 可选——未配则启动时从 API 自动获取。

| 角色 | 用途 |
|------|------|
| `main` | 主对话推理 |
| `memory` | 长期记忆总结 + 睡眠流水线 |
| `guard` | SKILL 触发语义检测 |

### context

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `compression_threshold` | 0.8 | 软阈值，超此值触发遗忘（删 1 块） |
| `decay_rate` | 0.1 | 默认遗忘速率 /小时（半衰期 ~7h） |
| `protect_window_min` | 10 | 保护窗口（分钟），此时间内块永不删除 |
| `max_background_chars` | 2000 | Background 自述最大字符数 |

硬阈值固定 0.95（强制清除至软阈值以下）。

### modules

- `enabled`: 启用的扩展列表，路径相对 `extensions/`
- `<id>`: 模块级配置，传入 `ModuleContext.config`

### memory

| 字段 | 说明 |
|------|------|
| `auto_summarize` | 是否启用自动日总结 |
| `idle_minutes` | 空闲多少分钟后触发睡眠 |

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
dolly run [--name=xxx]           # 前台运行（瞬态，不保存）
dolly start [--name=xxx]         # 后台守护进程
dolly attach [--name=xxx]        # 连接到后台实例
dolly stop [--name=xxx] [-f]     # 停止（触发保存）
dolly status [--all]             # 查看状态
```
