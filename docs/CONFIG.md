# Dolly 配置参考

## dolly.json

项目根目录 `dolly.json`：

```json
{
  "name": "my-agent",
  "version": "0.1.0",

  "llm": {
    "main": {
      "api_key_env": "DEEPSEEK_API_KEY",
      "base_url": "https://api.deepseek.com",
      "model": "deepseek-chat"
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
    "max_tokens": 32768,
    "compression_threshold": 0.8
  },

  "modules": {
    "enabled": [
      "builtin/llm",
      "builtin/skill",
      "builtin/mcp"
    ],
    "my-module": {
      "enabled": true,
      "config": {}
    }
  },

  "memory": {
    "path": ".memory",
    "auto_summarize": true,
    "idle_minutes": 60
  },

  "daemon": {
    "pid_dir": ".dolly/daemons",
    "log_dir": ".dolly/logs"
  }
}
```

### llm

- `main`: 主推理 LLM
- `memory`: 长期记忆总结 LLM
- `guard`: SKILL 触发检测 LLM

均以 `api_key_env` 引用 `.env` 中的环境变量。

### modules.enabled

启用的模块列表。路径相对于 `extensions/` 目录。例如 `"builtin/llm"` → `extensions/builtin/llm/`。

### modules.<name>.config

模块自定义配置，传递到 `ModuleContext.config`。

## mcp.json

```json
{
  "servers": {
    "fs": {
      "command": "node",
      "args": ["node_modules/@modelcontextprotocol/server-filesystem/dist/index.js", "."]
    },
    "web": {
      "command": "npx",
      "args": ["-y", "@some-mcp/server@latest"]
    }
  }
}
```

## .env

```
DEEPSEEK_API_KEY=sk-xxx
TAVILY_API_KEY=tvly-xxx    # 可选
```

## CLI

```bash
dolly run                     # 前台运行
dolly start                   # 后台启动
dolly start --name agent2     # 多开实例
dolly stop                    # 停止
dolly stop --name agent2 -f   # 强制停止
dolly status                  # 查看状态
dolly status --all            # 所有实例
dolly list                    # 列出扩展
```
