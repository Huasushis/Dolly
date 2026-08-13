# Dolly 规范仓库

这是 Dolly v1 的实现契约与研究路线仓库，不是实现代码。规范正文采用英文，
以避免中英文双份规范产生语义分叉；两份 TXT 所有者原始说明逐字保存在
`docs/owner-notes/`，HTML 中最新一条所有者澄清也以机械提取文本留档，后续
关于 Memory 自身排除、重复注入与载体选择的澄清作为第四份记录留档；
Extension、Filter、NapCatQQ、Testament、LevelUpper 的要求作为第五份，开发顺序、
并行依赖和最早可用门槛作为第六份。新上传对话中自述为 GPT-5.6 Pro 的规划稿
保存在 `docs/baseline/`，仅作非规范性来源证据。

当前版本为 `0.1.0-draft`。实现应依次阅读：

1. `docs/index.md`；
2. `docs/spec/00-governance/01-normative-conventions.md`；
3. `docs/spec/01-architecture/04-frozen-invariants.md`；
4. `docs/spec/core/07-reference-abstract-machine.md`；
5. `docs/implementation/01-rust-reference-blueprint.md`（Rust 参考实现蓝图）或
   `docs/implementation/02-extension-authoring-guide.md`（Extension 编写指南）；
6. `schemas/`、`protocol/examples/` 与 `test-vectors/`。

基础 v1 之外，仓库定义了两个可选一致性 profile：Two-Thirds Mean Filter 与
NapCatQQ Channel；只有声明支持它们的发行包才需要通过对应 gate。Testament 与
LevelUpper 是后置研究协议，不阻塞基础 v1，也不能因原型跑通就获得生产权限。

开发并不是把所有 Phase 串行执行。`docs/spec/roadmap/02-work-packages.md` 的依赖
DAG 是并行开发依据，`docs/spec/roadmap/04-critical-path-and-early-use.md` 定义了
`U0..U3` 与 `QQ0..QQ4` 的最早可用门槛。NapCatQQ 的离线适配器可较早并行，真实
账号的只读接入必须等 Extension、SecretRef、存储 scope、停止/重启和观测边界稳定；
发送与管理能力再分别升 gate。Testament 和 LevelUpper 默认最后开发。

运行 `python3 tools/validate_repo.py` 可检查来源证据哈希、JSON、Schema 引用、
内部链接、重复章节、需求编号、示例配置与测试向量结构。任何可观察语义变更都必须同时
更新 ADR、Schema、参考抽象机和测试向量。

完整校验链要求 Node.js 20 或更高版本；Python 结构校验器计算 RFC 8785/JCS
摘要时调用同一套 ECMAScript 数值序列化，从而避免跨语言 Schema bundle 哈希分叉。

安装 Node 依赖后可运行 `npm run validate` 或 `make package`；后者会先执行 Python
结构校验、通用 Schema/RPC 语义校验及 Filter/Testament/LevelUpper 研究域语义
校验，再生成不依赖 Git 工作区的确定性 `dist/dolly-spec.zip`。
