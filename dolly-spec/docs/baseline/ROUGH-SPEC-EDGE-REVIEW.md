# 两份粗略 spec 的边界条件提取记录

本页是非规范性审阅记录。用户明确要求不要沿用两份草稿的实现，而只提取其曾经
关注的边界条件；因此这里把“意图/失败模式”映射到当前规范，草稿中的 TypeScript
类、路径、字段、库、默认时长和具体 Provider 写法都不构成实现要求。

审阅输入：

- `Dolly_鲁棒性与功能完善_ddb07167.md`，SHA-256
  `93fc71d22c77a698e213652912cda85783f49c432903158bf6eb45e20df82354`；
- `Dolly架构重构实施计划_ddb07167.md`，SHA-256
  `222978088d0bfaea11b65360ebdefa57c0d48a1cbeae9e7985cc251d79f3123d`。

## 提取并保留的边界

| 草稿中暴露的关注点 | 当前规范中的归一化处理 |
| --- | --- |
| 实例级 Provider 配置可能对 Module 不可达 | Host 计算完整 effective config，绑定 revision/value/schema digest；Extension 不自行合并配置 |
| CLI/入口文件、daemon 与实例可能各自“看起来存在”却不可启动 | packaging gate、原生进程套件、daemon intent/observed-state 分离和真实 stop/restart 向量 |
| 前后实现使用不同的 media/forward 字段 | 封闭 Part Schema、Asset/BlockRef 类型和 schema-bundle digest，拒绝私有字段漂移 |
| 把 `image` 当 MIME、信任 Provider MIME 或扩展名 | Asset Service sniff 后的 MIME 是权威；请求模态、大小、解码与响应 Part 做配对校验 |
| LLM tool/reasoning/media 中间态在重试、裁剪上下文时断裂 | Provider-specific state 归入固定 adapter profile 和 transaction；Tool 结果、模型结果与 Asset import 各自有 operation/status，不靠拼接 Block 猜测 |
| Module 长期保留上下文 Block；forward 展开也要保活 | Extension 只持 Block ID；通过有界 durable pin 保活，退出不自动解除；引用深度、可达性、配额和解除均由 Host 管理 |
| context 清理必须连带清理 tool/reasoning/media | LLM 维护 canonical request/transaction closure；不能只删可见文本留下无主 authority 或 Provider continuation |
| forward 必须无环、限制展开爆炸、目标可能已回收 | Core BlockRef DAG/深度/trace/GC edge 校验；未授权或已失效引用显式失败，不能用字符串 ID 冒充引用 |
| 同一图片的 crop/point 顺序不交换、坐标系不同、重复回插浪费上下文 | Asset view 使用归一化 half-open 坐标、确定性舍入和显式变换链；Model profile 声明能力；等价视图按内容/变换 identity 去重 |
| Provider 返回图片/音频可能只给临时 URL | URL/bytes 先以 `(request_id, ordinal)` 绑定一次 Asset import；全部 `AVAILABLE` 后 Model operation 才成功，重启不重调 Provider |
| Page 指针提前移动会在 Module 失败时丢消息 | Manifest 冻结输入；Block 输出、Delivery 与 cursor 在 Core 单事务提交，失败不推进 |
| Page 无消费者、慢消费者、多路重复、跨轮重复的 prune/count 语义 | durable Page retention/backpressure；Delivery occurrence 与 Block identity 分离；重复路径不修改共享 Block |
| 同一 Module 不得并发重入，不同 Module 可并行 | 每 Module 最多一个 nonterminal Activation；进程内不同 Module 可并行，shutdown 有逐 Module barrier |
| timeout/间隔的 `-1`、拍脑袋默认值、加速实验与真实日尺度混淆 | 稳定路径不接受隐式无限 sentinel；所有资源有机器上限；频率/tensity/联想只在版本化研究计划和真实尺度验证后 promotion |
| AIMD 到底调自己还是上游、何时生效容易实现反向 | scheduler 是独立研究轨，必须冻结 control subject、采样窗口、下一周期生效点和稳定性 oracle；不进入 Core correctness |
| 多开 daemon/前台实例、端口别名、PID 复用、自动重启 | daemon installation/instance lock、平台 lifecycle container、endpoint reservation、generation/epoch fence；PID 不是身份 |
| Extension/Module 共享路径会导致状态串库 | Host 分配不可复用 `storage_scope_id`；同物理数据库先按 scope tenant，且每 scope 只有一个 active writer generation |
| 热更新候选和旧代同时打开 SQLite/外部 DB | candidate 只能 read-only/staging；旧 writer 释放被证明后才授予新 active writer；不确定则停止而非超时假定成功 |
| stop 后能否重启、部分 Module shutdown、配置仍在但进程 Exited | durable intent `run/hold/remove` 与 observed state 分开；`Exited -> Verified`、`Stopped -> Instantiating`；逐 Module receipt/unknown 对账 |
| Memory 自产内容形成反馈环；同一记忆重复投放 | provenance 自排除；同一 model request 精确去重，后续 request 仍按新上下文可选；禁止“每天一次”硬禁用 |
| Memory 动态结果放 Premise 还是 Block | 动态检索先走普通 Block/ActionResult；最终入模型时是低权限 typed external evidence，Premise 只描述能力 |
| Memory/LLM 持有多媒体一天后 URL/ID 失效 | 只依赖 Host Asset/Block pin 和显式 retention；外部 URL、进程内 stream session、路径不成为长期身份 |
| Skill 目录热更新会把全文和不受信指令塞进 Premise | Premise 只投影有界能力目录；资源按需读取，版本/摘要/权限在调用时复核 |
| 任意 EventBus 或自由 `content` 方法绕过 Core | 语义通信必须走 Page/Block/Action 或明确定义的 Host RPC；Action schema/side-effect/validator 在创建时冻结 |
| raw file/base64/URL、公开 OSS、路径与日志泄密 | SecretRef、精确 egress、Asset import、SSRF/path/signed-URL redaction 与有限 stream capability |
| 每个子系统先独测再联合、每步要审查和故障注入 | work-package DAG 允许 test double 并行；每个 gate 要 schema、semantic negative、crash/status、native lifecycle 和 rollback 证据 |

## 明确不继承的机制

当前规范不继承“框架完全不解析 content”、进程内引用计数即持久生命周期、消费时
立即移动 Page 指针、公共读 OSS URL、Extension 自开任意 MCP/网络连接、以配置文件
路径哈希作为安全身份、PID/端口双保险、固定每日重置或“一天持有/一天注入”等机制。
这些方案在草稿中提醒了真实问题，但不能提供跨进程崩溃、authority、备份恢复和
unknown external effect 所需的证据。

