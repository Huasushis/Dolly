# Dolly 测试清单

每次改动后逐条验证。未通过的标注原因，不要跳过。

## 基础功能

| # | 测试项 | 命令/方法 | 预期结果 |
|---|--------|-----------|----------|
| 1 | 类型检查 | `pnpm typecheck` | 零错误 |
| 2 | daemon 启动 | `node --import tsx/esm bin/dolly.js start` | 后台启动，PID 写入 .dolly/daemons/ |
| 3 | 客户端连接 | `echo "你好" \| node --import tsx/esm bin/dolly.js run` | 自动连 daemon，收到回复 |
| 4 | Ctrl-C 退出 | 前台 `run` 按 Ctrl-C | 立即退出，无残留进程 |
| 5 | daemon 停止 | `node --import tsx/esm bin/dolly.js stop` | 进程终止，PID 文件清除 |
| 6 | 状态查看 | `node --import tsx/esm bin/dolly.js status` | 正确显示 running/stale |

## 对话与工具

| # | 测试项 | 命令/方法 | 预期结果 |
|---|--------|-----------|----------|
| 7 | 多轮对话 | 连续发 3 条消息 | 上下文保持，不重复响应 |
| 8 | MCP 工具调用 | `echo "读取 dolly.json" \| pnpm start` | 工具成功调用，结果注入上下文 |
| 9 | SKILL 触发 | `echo "帮我搜索 weather" \| pnpm start` | skill 模块检测并处理 |
| 10 | speak 输出 | 正常对话 | 回复只显示 speak 内容，无控制字符乱码 |

## 记忆系统

| # | 测试项 | 命令/方法 | 预期结果 |
|---|--------|-----------|----------|
| 11 | daily log 写入 | 运行后检查 `.memory/daily/{today}.jsonl` | 每次操作有记录 |
| 12 | 总结生成 | 触发总结（修改系统时间或手动调用） | 三步：情绪+教训+总结，存入 entries/ |
| 13 | 关键词索引 | 总结完后检查 index.json | 关键词→日期映射存在 |
| 14 | 自动记忆注入 | 发一条与历史相关的消息（如"我之前叫什么？"） | 自动注入相关 summary+片段 |
| 15 | 显式 recall | 消息中包含 `{"recall":"hard"}` | 5天5段深度召回 |
| 16 | 软 recall | 消息中包含 `{"recall":"soft"}` | 1天1段轻量召回 |
| 17 | 总结去重 | 同一天多次触发总结 | 只更新不新增 |
| 18 | 遗忘功能 | 消息中包含 `{"forget":"<blockId>"}` | 指定块从上下文移除 |

## Profile 持久化

| # | 测试项 | 命令/方法 | 预期结果 |
|---|--------|-----------|----------|
| 19 | 重启不重播 | Ctrl-C 退出后重新 run，检查 daily log | 不出现重复响应 |
| 20 | 上下文恢复 | 重启后问"上次我们聊了什么？" | 能回忆之前的对话 |
| 21 | speak_history 唯一 | 检查 `.dolly/profiles/default/exts/builtin-console/speak_history.json` | 无重复条目 |

## 多开

| # | 测试项 | 命令/方法 | 预期结果 |
|---|--------|-----------|----------|
| 22 | 多实例 | `start --name=a` + `start --name=b` | 两个独立进程 |
| 23 | 隔离 | 在实例 a 发消息，检查实例 b 上下文 | 互不影响 |

## 待实现

- [ ] thinking 模式端到端（enable_thinking + difficult/solved 标签 + reasoning 留存 + 凌晨关闭）
- [ ] 长时间运行稳定性（24h+ 无内存泄漏、日志不爆炸）
- [ ] Web UI 客户端
