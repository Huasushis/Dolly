# 编写注入/监控模块

## 注入器

放到 `extensions/injections/*.ts`，自动发现加载。

```typescript
import type { InjectionModule, InjectionEvent } from "../src/injection/base.js";

const myInjector: InjectionModule = {
  id: "my-injector",  // 唯一 ID

  // 可选：注入到 Head（Background Prompt）
  headContent(): string {
    return "你是一个擅长数学的助手。";
  },

  // 上下文变化时调用（可 async）
  onContextChange(frames): InjectionEvent | null {
    return {
      id: "my_inj_001",
      content: "注入的内容",
      priority: 50,  // 越小越高优
    };
  },

  // 可选：监听事件
  onEvent(event, payload): InjectionEvent | null {
    if (event === "tool.result") {
      return {
        id: "reaction",
        content: `工具返回了: ${JSON.stringify(payload)}`,
        priority: 40,
      };
    }
    return null;
  },
};

export default myInjector;
```

## 监控器

放到 `extensions/monitors/*.ts`，自动发现加载。

```typescript
import type { MonitorModule, MonitorAction } from "../src/monitor/base.js";

const myMonitor: MonitorModule = {
  id: "my-monitor",
  blocking: false,  // 设为 true 可暂停 LLM 输出

  onOutput(chunk, fullResponse): MonitorAction | null {
    if (fullResponse.includes("特定模式")) {
      return {
        action: "inject",
        injection_id: "detected_001",
        payload: "检测到特定模式，注入一些内容",
      };
    }
    return null;
  },
};

export default myMonitor;
```

### MonitorAction

| action | 效果 |
|--------|------|
| `pass` | 不干涉 |
| `block` | 暂停 LLM 输出流 |
| `inject` | 触发一次注入（payload 为注入内容） |
| `remove` | 按 injection_id 移除上下文帧 |

## SKILL 定义

放到 `extensions/skills/*.json`：

```json
{
  "name": "skill名称",
  "triggers": "自然语言描述触发条件",
  "prompt": "触发后注入给 LLM 的提示词"
}
```

`guard_llm` 用于语义检测触发条件。

## MCP 配置

编辑项目根目录的 `mcp.json`：

```json
{
  "servers": {
    "servername": {
      "command": "npx",
      "args": ["-y", "@scope/mcp-server@latest"]
    }
  }
}
```
