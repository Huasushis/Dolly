# Dolly

通用基础 AI Agent 框架。对标 OpenClaw / Hermes，更简化。

**核心理念**：上下文由 Block 构成，模块统一注入/监控/工具调用。

## 快速开始

```bash
pnpm install
cp .env.example .env   # 填入 DEEPSEEK_API_KEY
pnpm start             # 前台运行
```

## CLI

```bash
pnpm start                 # 前台运行
node --import tsx src/main.ts start              # 后台启动
node --import tsx src/main.ts start --name=agent2  # 多开
node --import tsx src/main.ts stop               # 停止
node --import tsx src/main.ts status             # 查看状态
```

## 项目结构

```
├── dolly.json              # 项目配置
├── mcp.json                # MCP server 配置
├── docs/                   # 文档
├── src/
│   ├── main.ts             # 入口 + CLI
│   ├── daemon/             # 守护进程
│   ├── core/               # 上下文、事件总线、LLM 客户端
│   ├── blocks/             # Block 类型 + 序列化
│   ├── modules/            # 模块注册表 + 基类
│   └── memory/             # 记忆存储
├── extensions/
│   └── builtin/            # 内置模块
│       ├── llm/            #   LLM 调用
│       ├── skill/          #   SKILL 触发检测
│       │   └── skills/     #     用户 SKILL 定义（JSON）
│       └── mcp/            #   MCP 工具调用
└── .memory/                # 长期记忆数据
```

## 配置

`dolly.json`：三组 LLM 配置（main/memory/guard）、上下文参数、模块列表、记忆参数。

`mcp.json`：MCP server 列表，启动时自动连接。

## 文档

- [架构文档](docs/ARCHITECTURE.md)
- [模块开发](docs/MODULES.md)
- [配置参考](docs/CONFIG.md)
