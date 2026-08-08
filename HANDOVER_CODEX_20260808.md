# Dolly Codex 交接（2026-08-08）

本文件记录 2026-08-01 至 2026-08-08 接管工作的实际状态。下一位接手时先读本文件，
再按本文件的指路读 `HANDOVER_NOW.md` 的旧章节；不要从头顺读 `TASK_HANDOVER.md`。

## 0. 所有者最强调的内容：不可在摘要中丢失

所有者补充原话已逐字保存在：

- `.qoder/specs/dolly_owner_addendum_20260801.txt`
- SHA-256：`fe378814e6fbbf6efc8374649c48c8368dfd597b2d3ab18f6514c422e025d4f8`

该文件被仓库 `.gitignore` 的 `.qoder/` 规则忽略，但它真实存在于本工作区。不得用本节摘要
替代完整原话。所有者特别要求防止代理反复总结后偏离；下一位必须完整读该文件。

以下两句是最高优先级的逐字原话：

> 原则：我个人的描述其实非常模糊，并不能清晰地直接表明最终架构，甚至并不是你能理解我的意思就能直接写出规划的那种。很多是需要进行一定研究测试，进行科学决策才能进行规划的。这点最为重要。

> 补充，你的最终goal应该是完成dolly这个项目

这意味着：

1. 最终目标是完成整个 Dolly 项目，不是完成调度、Memory 或某一个安全子系统。
2. 所有者描述的是希望出现的效果、候选因子和待研究问题，不是可直接照写的最终架构。
3. Memory 和调度必须作为研究问题处理：比较、消融、组合、重复、逐案例原始数据、独立验证；
   结果弱时修改设计并版本化重做，不能跑一次就结束。
4. 所有者明确要求搜索资料、参考开源项目并反复执行“研究—推敲—测试—修改”的循环。
5. `.qoder/specs/dolly_new.txt` 是所有者原始想法；两个 `ddb07167` 规格只是不可信的早期
   AI 草案。必须提取其中每一点想解决什么，不得按草案架构盲目实现。

原话中还明确列出了不能遗漏的研究/产品效果：

- Memory 联想不只返回一个语义相似片段，还要研究位置接近、共同出现和因果相关内容的统计；
- benchmark 要比较学习前后，尤其是 Memory、离线整理（所有者称“睡眠”）带来的提升；
- 测试任务中断、切换到另一个任务、几乎忘掉原上下文后，能否自动回忆并继续；
- 测试 Dolly 修改自身配置；动态配置必须研究由主框架重启还是扩展热重载，模型切换导致
  上下文上限变小、端点无法报告上限、本地能力表和超长响应错误都要处理；
- Dolly 要能安全、分段、可查询大小地读取图片/文件，不能用返回整个文件的玩具函数冒充；
- 测试 Camoufox 浏览器加 MCP 的截图和操作；
- 研究完善的闹钟扩展、独立加速学习装置（原话名 `testament`）和多实例 Page 共享
  （原话名 `levelupper`）。这些名字只代表待研究效果，不等于设计已经确定。

## 1. 不可突破的工作区与安全边界

- 命令工作目录必须是 `/home/ubuntu/codex-dolly/Dolly`。
- 源码、依赖、临时文件、实验和输出只能在 `/home/ubuntu/codex-dolly/` 下。
  本次接管的测试临时根使用 `/home/ubuntu/codex-dolly/.tmp`，不得使用系统 `/tmp`。
- 服务器有其他人的项目和共享工具状态。不得触碰、移动、停止或清理。
- 绝不按名称/前缀批量杀进程或删容器。只操作本次运行创建并记录的完整标识符或具体
  `ChildProcess`；清理时先精确核对。
- 不得移除或绕过 `src/core/runtime-bootstrap.ts` 中
  `RUNTIME_MODULE_MIGRATION_REQUIRED` 的 Module 启动拒绝。当前零 Module 运行可用不代表
  Module 产品运行时可用。
- 不得为了展示功能跨过未闭合的安全边界，也不得长期只做一个安全子系统而遗忘完整项目。
- 必须遵守 `AGENTS.md`：有通用技术术语时不要发明项目词；不得不用专有词时先用普通语言定义。
- Linux 优先、跨平台；确定性正确性测试不能依赖这台私有服务器。
- 宿主 `Linger=no`。真实 user service/control-group 证据只按仓库文档走唯一命名的一次性
  systemd 容器；不要在宿主直接跑后宣称成立。
- `127.0.0.1:10808` 可作 HTTP/SOCKS5 代理，但非交互子进程必须验证实际继承；不需要网络的
  测试应清除代理和密钥环境。

## 2. 服务、模型和实验约束

- 不依赖所有者的 Aether、DashScope、OSS、密钥或模型，公共项目必须有独立可复现路径。
- OSS 公共读取已关闭。OSS 只是可选适配器；默认偏好 base64/本地字节。只有 URL-only 模型
  需要时才考虑私有对象短期签名 URL。必须实测裁剪后的签名、模型取图、版本、删除与恢复，
  用户文档必须写明删除权限。
- 所有者的 Aether 后端是自部署 qwen3.6-27b：默认推理、不接受 `enable_thinking`，已知接受
  `thinking.type` 对象。只有响应里非空 `reasoning_content` 能证明该次真实推理。
- 模型配置必须按 endpoint/model 的真实能力控制编码、模态和上下文；文本 embedding 的
  OpenAI 兼容部署也必须正常工作，DashScope 视觉 embedding 只能是可选部署。
- 研究调度、Memory、模型上下文/推理、多模态/OSS、架构横向比较、长期记忆、竞品 benchmark
  和 headless computer-use 必须并行推进。每项先预注册可证伪问题、基线、数据、后端、种子、
  重复、指标、最低有效差异、停止规则和会改变的决策；保存逐案例原始数据并独立验证。
- `test/experiments` 和 `test/memory-experiments` 是历史材料，不是当前证据。

## 3. 当前 Git 与远端事实

在 2026-08-08 交接前重新读取：

- 工作树：`main...origin/main [ahead 1]`
- 本地 HEAD：`ebde548759ac6b8e405ba5a0a28c05deb6fcede9`
- 远端跟踪 `origin/main`：`bffea4dfc42714c4a5becf8b36bdce29202ac459`
- 本地提交：`ebde548 fix: require proven module process stops`

以上是创建本交接提交前的快照。本文件和 `HANDOVER_NOW.md` 随后作为一个独立本地提交写入，
因此接手时预期为 `ahead 2`；最终 HEAD 必须用 `git rev-parse HEAD` 读取，不要把上述 `ebde548`
误当成包含本文件的提交。

`ebde548` 是已提交的 19 文件安全修复；它没有修改 Module 启动拒绝。此前 push 被自动批准服务
以 `[input[6].namespace]` 未知参数拒绝。相同 push 不要盲目重试或用间接命令绕过；先确认批准
服务已恢复或由所有者明确处理。

## 4. 现有脏文件：严格区分所有者/历史工作与本次接管工作

以下是在本次接管前已存在或已明确列为受保护的脏文件/目录。不要 stage、覆盖或“顺手整理”：

```text
 M test/memory-experiments/REPORT.md
 M test/memory-experiments/exp4-emotion-memory.ts
 M test/memory-experiments/utils.ts
?? HANDOVER_SUMMARY.md
?? TASK_HANDOVER.md
?? docs/takeover/
?? test/experiments/
?? test/memory-experiments/FACTOR-COMBINATION-DESIGN.md
?? test/memory-experiments/README.md
?? test/memory-experiments/test-api.ts
```

本次接管创建/修改但尚未提交的预注册工作是：

```text
 M docs/experiments/protocol.md
?? docs/experiments/preregistrations/README.md
?? docs/experiments/preregistrations/schema-v1.json
?? docs/experiments/preregistrations/scheduler-policy-v1.json
?? docs/experiments/preregistrations/scheduler-policy-v1.md
?? scripts/experiments/validate-preregistration.mjs
?? scripts/experiments/validate-preregistration.d.mts
?? tests/conformance/experiments/preregistration-validation.test.ts
```

另有一个**刻意保持未完成、不得提交**的发布包反例：

```text
 M tests/conformance/operations/package-install-smoke.test.ts
```

它只把临时目录从系统 `/tmp` 改到 `/home/ubuntu/codex-dolly/.tmp`，并在仍只解出
`package.json` 和 `bin/dolly.js` 的情况下增加 `init` 期望成功。该状态用于暴露旧测试假绿，
还不是修复完成态。

## 5. 本轮完成到什么程度，不能扩大表述

### 5.1 通用实验预注册基础设施

新增了 JSON Schema 2020-12、Ajv 结构校验器、重复 JSON key 检测和跨字段检查。当前校验范围
在输出中明确写作：

```text
schema-and-cross-field-structure-only
```

它不声称实验语义正确，更不等于实验或产品通过。当前已验证：

- scheduler JSON SHA-256：`aa90fbd4695c0f89dad2bcf74d1452d3c898bc77bb9c90df566791a339fc5809`
- schema SHA-256：`7033edb6f9b194c6aca47645a15ba7ba342461cab982e8ac0871dd9227908d52`
- 结构校验：valid
- 定向 Vitest：1 文件，31/31
- `pnpm typecheck`：exit 0
- `pnpm build`：exit 0

这些结果在 2026-08-08 交接前基于当前字节重新运行。Module 启动安全拒绝未修改。

### 5.2 调度实验预注册当前内容

当前 JSON 已冻结或补强：固定/水位线/rate-AIMD 条件、训练/开发/评估分割、最大 9472 案例、
容量试运行、逐案例原始原子状态转换、独立展开、失败案例封口、顺序/回放变体 ID、激活触发映射、
重采样 family ID、服务分布 CDF 与 golden vector、baseline 无效路径和互斥决策顺序。

这是**预注册草案**，没有 simulator、独立 analyzer 或实验结果，不能作为调度方案支持证据。

独立终审还留下两个明确阻断，尚未修改：

1. `domainDesign.capacityFeasibility.projection` 先说 runner/analyzer time 乘 `2.0`，随后墙钟公式又写
   `2.0*projectedRunnerMs + 2.0*projectedAnalyzerMs`。`projected*` 是加倍前还是加倍后不唯一，
   会让同一运行按 2 倍或 4 倍判定，直接改变 design-infeasible 结论。应冻结
   `baseProjectedRunnerMs/baseProjectedAnalyzerMs`，并只算一次安全系数。
2. `domainDesign.rawEventFormat.encoding` 只冻结 DEFLATE level 9 和 gzip header，没有冻结 zlib
   版本、strategy、windowBits、memLevel、flush 和输入分块。同一 JSONL 的合法实现会产生不同 gzip
   字节、hash 和存储容量投影，可能改变容量结论。应冻结参考编码器与 golden gzip hash，或者把
   压缩结果降为环境测量、禁止它影响跨实现科学结论；二选一必须明确。

修复这两项后重新生成 SHA、跑 31 项结构反例、typecheck/build，再做一次只读差异终审；在此之前
不要提交预注册文件。

### 5.3 发布包反例与沙箱阻断

旧 `package-install-smoke.test.ts` 只解出 `package.json`/CLI 包装脚本并运行 help/version；这两个
分支不导入 `dist`，所以是明确假绿。当前增量反例要求在局部解包后运行 `init`；根据
`bin/dolly.js`，应以 `Dolly is not built` 失败。

实际运行先被执行环境阻断：受限沙箱给 Node `spawnSync` 注入 `EPERM`，即使子进程状态为 0，
测试也在 npm pack 处退出，尚未到达预期的 `init` 反例。请求在扩展沙箱外复跑又被批准服务的
`[input[6].namespace]` 错误拒绝；不要用间接方式规避同一拒绝。

独立只读审查给出的完成路径：

1. 完整、安全地验证 tar 后再写盘；限制压缩/解压/条目/单文件/总大小/路径长度；
2. 校验 checksum、对齐、PAX/GNU long name；拒绝遍历、反斜杠/Windows 路径、链接、设备、FIFO、
   未知类型、重复/大小写/Unicode 冲突、文件与目录祖先冲突；
3. tar 文件集和 npm pack manifest 的路径/大小逐项完全一致；
4. 黑盒执行 `init → config show → Linux run ready → 仅对记录的 ChildProcess 发送 SIGTERM →
   exit 0 → 同配置重新打开并再有序停止`；
5. 只证明默认 `modules: []` 生命周期。绝不改写 Module 启动拒绝；Windows 的 `SIGTERM` 语义不能
   冒充 Linux 有序停止。

## 6. 信任层级与阅读顺序

下一位按以下顺序读：

1. `AGENTS.md`；
2. 本文件；
3. `.qoder/specs/dolly_owner_addendum_20260801.txt`（完整原话，不得只读本文件摘要）；
4. `.qoder/specs/dolly_new.txt`（所有者原始想法）；
5. `HANDOVER_NOW.md` 中本文件明确指向的旧证据章节；
6. 当前代码、测试、协议、提交和原始实验工件；
7. 两个 `ddb07167` 规格只用于收集需求意图，不作为架构权威；
8. `TASK_HANDOVER.md` 只按具体章节号定点查历史，绝不从头顺读。

必须一直区分：组件存在、组件测试通过、确定性测试通过、真实后端实验通过、受支持产品入口可用。

## 7. 下一步的精确顺序

1. 只修改 scheduler prereg JSON，先用可单独变红的例子关闭“墙钟二次乘安全系数”和“gzip 字节
   不唯一”两项；重新跑 validator/31 tests/typecheck/build，再独立只读审查。
2. 只 stage 第 4 节列出的预注册文件，核对 `git diff --cached --name-status` 和完整 cached diff，
   做一个小提交；不要混入受保护脏文件或发布包红态。
3. 完成发布包完整安全解包和零 Module 生命周期测试；纯 tar 解析反例可在受限沙箱内跑，真实
   子进程链必须诚实记录沙箱/批准服务阻断，不能把未运行写成通过。
4. 随后回到完整项目路线：Module 跨层装配、公开配置能力、Memory/调度科学实验、模型能力描述、
   多模态、长期记忆、学习前后 benchmark、任务切换、Camoufox/MCP、headless computer-use；
   不得再次长期只停在一个安全子系统。

## 8. 当前进程、代理和临时对象

- 交接时没有存活的子代理。
- 没有记录任何由本轮启动、需要继续托管的长期进程、容器或 systemd unit。
- 手工 package 探测目录 `/home/ubuntu/codex-dolly/.tmp/package-probe.ZaWzux` 是本轮唯一命名的
  临时探测对象，已在交接前按这个完整路径删除；没有按 `package-probe-*` 批量处理。

本项目远未完成；当前目标状态仍是 active。任何“完成”声明必须指明是哪个有限层级，不能把
预注册、结构校验或零 Module 启动扩大为 Dolly 项目完成。
