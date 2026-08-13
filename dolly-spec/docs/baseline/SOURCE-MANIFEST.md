# Source manifest

本目录保存 Dolly 正式规范的非规范性规划基线。`docs/owner-notes/` 保存所有者原话副本。它们用于需求追溯，不自动成为正式规范条款。

## 采用优先级

源材料发生冲突时，按以下顺序裁决：

1. `../owner-notes/06-development-order-clarification.txt`：2026-08-12 最新所有者澄清；要求明确关键开发顺序、并行依赖、首次可用门槛，NapCatQQ 尽早但避免追逐不稳定协议，Testament/LevelUpper 最后。
2. `../owner-notes/05-extension-and-future-clarification.txt`：同日较早的所有者澄清；要求完整规划 Testament/LevelUpper、NapCatQQ 与通用 Filter，并要求 review、对抗审查和操作模拟。
3. `../owner-notes/04-memory-injection-clarification.txt`：同日更早的所有者澄清；裁决 Memory 忽略自身、不得用固定时间禁止重复注入，以及 Premise/Block 载体问题。
4. `../owner-notes/03-pro-conversation-clarification.txt`：较早的新对话所有者明确说明；它补充并裁决 Memory 的关联、聚类和非因果语义。
5. `../owner-notes/01-dolly_new.txt`：较新的所有者详细规划。
6. `../owner-notes/02-newnew.txt`：较早的所有者补充原话，用于防止遗漏；不得覆盖较新的所有者规划。
7. `gpt-5.6-pro-planning.md`：GPT-5.6 Pro 给出的工程规划，作为派生设计建议；不得覆盖所有者原话。

后续所有者作出的明确新决定不属于这份静态源材料之间的冲突，应通过新的可追溯记录进入仓库。

## 收录材料与校验值

| 仓库路径 | 来源 | SHA-256 | 处理方式 |
| --- | --- | --- | --- |
| `../owner-notes/06-development-order-clarification.txt` | 2026-08-12 当前项目对话的最新用户消息 | `9cc9811e7df681c2d826ee4e78d06515d32c0de76331a8529a8a387b1ca19bca` | 逐字保存用户澄清；不包含后续派生设计 |
| `../owner-notes/05-extension-and-future-clarification.txt` | 2026-08-12 当前项目对话的最新用户消息 | `e3b9bbd097cd513134d7d546818a24748bed41f7a9942925b34900343ab0ba8c` | 逐字保存用户澄清；不包含后续派生设计 |
| `../owner-notes/04-memory-injection-clarification.txt` | 2026-08-12 当前项目对话的最新用户消息 | `eef595087ed9d36158b556e12930c182db9fdc0d9a23c009024366118234dd19` | 逐字保存用户澄清；不包含后续派生设计 |
| `../owner-notes/03-pro-conversation-clarification.txt` | `project_sources/03-dolly-2026-08-10.html` 的最后一条项目用户消息 | `927a866dac141076f20d735c617ae4a62d2b8e310d33792904277feec868bd72`（派生文本） | 机械提取用户消息正文并解码 HTML 实体；未作语义改写 |
| `../owner-notes/01-dolly_new.txt` | `project_sources/01-dolly_new.txt` | `1e9570f1b1328ad401c10973ce1ba85ad8c02712903c91de27a5f107dd3b3264` | 逐字节复制 |
| `../owner-notes/02-newnew.txt` | `project_sources/02-newnew.txt` | `fa7696156bbb0cdf02bc595c3676a00ac4712e56f497bc056f5cff93cb1445c3` | 逐字节复制 |
| `gpt-5.6-pro-planning.md` | `project_sources/03-dolly-2026-08-10.html` 的最后一条助手消息 | 源 HTML：`d2871803ee0201b83c8e3c020b0e8de92a2d842596237edf9b62a1598135098e`；派生 Markdown：`1651175cf8a5c65f7cda3cfcc966b338328ec08b60bbc517de8917c31ed90e8d` | 仅提取最后一条 `assistant-message.content`，用 Pandoc 机械转换为 GFM；正文未作语义改写 |

同一个源 HTML 同时包含所有者澄清和助手工程建议；两者分别提取并按上述优先级使用。源 HTML 本身不复制进仓库；仓库只保留可维护的 Markdown 基线和可追溯的所有者文本。

两份后来上传的粗略 spec 不加入上述设计优先级，也不作为实现来源。用户只要求从中
恢复其关注过的失败模式。它们的输入哈希、提取边界及未采用机制记录在
[两份粗略 spec 的边界条件提取记录](ROUGH-SPEC-EDGE-REVIEW.md)。

该静态导出能证明页面中助手文本明确自述为“GPT-5.6 Pro”，但不能独立证明服务端实际路由记录；规范只把其内容当作工程建议，并不以模型身份作为规范权威来源。

## 明确排除

标题为《项目规划与技术栈建议》的旧弱模型 HTML 明确排除：不得复制到本仓库、不得作为需求或规范依据、不得从中补写当前基线。当前 Markdown 基线只来自上表所列的新 GPT-5.6 Pro 对话导出。
