# Dolly USTC 交接说明

更新时间：2026-07-31

这份文件用于把 Dolly 从 Windows 工作区转交到 USTC Ubuntu 服务器继续开发。它说明接手顺序、当前事实、目录、服务器边界，以及不能再次犯的错误。它不是新的产品规范，也不能替代源代码、测试和实验原始数据。

## 1. 接手后的阅读顺序

先运行以下只读命令，确认实际状态，而不是相信本文写死的提交号：

```bash
cd ~/codex-dolly/Dolly
git status --short --branch
git rev-parse HEAD
git log -5 --oneline
```

然后按以下顺序阅读：

1. `AGENTS.md`：仓库工作规则。尤其禁止在有普通技术术语可用时发明项目专有名词；不得不用项目专有名词时，必须在首次权威使用处解释它具体指什么、与 Dolly 已有概念的关系，以及普通术语为什么不够。
2. `HANDOVER_NOW.md`：当前实现状态的权威快照。先读这一份。
3. `.qoder/specs/dolly_new.txt`：项目所有者的原始想法。它是理解意图最重要的历史来源，但其中许多机制是未验证假设和实现建议，不是已经裁定的规范。
4. `.qoder/specs/Dolly架构重构实施计划_ddb07167.md` 和 `.qoder/specs/Dolly_鲁棒性与功能完善_ddb07167.md`：早期人工智能生成的规范。不要照单全收。它们有冲突、过度设计、错误事实和危险设计；价值在于记录了所有者曾反复强调但在原始想法中没有展开的需求。逐项回到原始意图、当前代码、正式规范和证据核验。
5. `docs/spec/README.md`、`docs/adr/README.md`、`docs/research/open-research-questions.md`、`docs/experiments/protocol.md`：分别查看当前规范的权威顺序、架构决策状态、待研究问题和实验要求。Draft 不是已经实现或可发布的保证。
6. `docs/takeover/`：前一轮接管审查。该目录当前未被 Git 跟踪，内容有用但仍需审查。优先看 `confirmed-user-requirements.md`、`project-roadmap.md`、`legacy-qoder-spec-review.md`、`module-runtime-audit.md`、`media-foundation-audit.md` 和 `historical-experiment-materials.md`。

`TASK_HANDOVER.md` 是 2269 行按时间追加的历史日志，后面的章节会推翻前面的结论。不要从头顺读。仅在 `HANDOVER_NOW.md` 指向具体章节时定点查阅。

任何文件都可能过期。接手者必须区分四件事：目标写在文档里、组件代码存在、测试覆盖了组件、受支持的产品入口真正可用。前面三项都不能自动推出第四项。

## 2. 项目概括和原始方向

Dolly 是一个实验性的本地优先智能体运行时，目标类似 OpenClaw 和 Hermes，但核心研究问题是“内生的宏观多专家协作”和内部思考能否形成更强的通用助理或智能个体。未来设想中的 Testament（在给定数据基础上快速学习能力）和 Network（多个智能体通信与组网）不属于当前阶段。

原始模型有四个需要保留且已在现有文档中定义的项目概念：

- Block：不可变的 JSON 信息记录。生产者提供内容，运行时分配标识、来源和顺序信息。
- Page：带历史记录的广播通道。多个生产者可写入，多个消费者分别记录自己的读取位置。
- Extension 和 Module：Extension 是可复用程序包；Module 是一个 Extension 按具体配置创建的运行实例。
- Premise：所有者最初对 Module 能力说明的称呼。当前文档通常使用更普通的“Module description”；它包含该 Module 能接收什么和会输出什么，并在调用相邻 Module 时提供相关说明，但不暴露整个连接图。

一个 Module action 应把所有输入 Page 上新到达的 Block 作为一个有序批次处理；返回空或一个 Block；同一 Module 绝对串行，不同 Module 可并行；执行期间新到的输入留给下一次；一个输出 Block 广播到所有输出 Page。实现可以与原始设想的数据结构不同，但可观察行为不能偷偷变化。

Page、Module、Block 和 Premise 这些名称已经来自所有者的原始模型。除此之外，应优先使用通行的工程术语，不要继续制造难以维护的新名词。

## 3. 当前真实状态

转移时本地和远端分支均为 `main`。最后一个包含产品代码变化的提交是 `a134241`；它之后先有三次只修改 USTC 交接文档的已推送提交：

- `7029651 docs: prepare USTC project handoff`
- `90707ab docs: exclude Windows build data from USTC copy`
- `d6aa7f7 docs: correct pnpm validation commands`

本交接还会继续产生纯文档提交，因此实际 `HEAD` 必须以 Git 为准。产品代码基线 `a134241` 的完整 Windows 验证为：127 个测试文件通过、4 个按平台跳过；1622 个测试通过、47 个跳过；完整 TypeScript 检查和构建退出码为 0。该结果只证明当时的默认 Windows 测试集合通过，不证明 Linux 内核行为、真实模型、对象存储、网页界面或完整 Module 运行可用。

最重要的产品事实：普通启动入口仍会拒绝包含 Module 的配置，错误为 `RUNTIME_MODULE_MIGRATION_REQUIRED`。底层的持久状态、投递、进程协议、能力检查、Linux control group 适配器等已经有大量代码和证据，但还没有装配成受支持的完整 Module 执行路径。不要为了展示功能而移除 `src/core/runtime-bootstrap.ts` 中的拒绝条件。

`HANDOVER_NOW.md` 的 P0-1 至 P0-4 记录了已经完成或部分完成的 Linux 进程所有权工作；当前最高风险在 P0-5。尤其仍需在真实跨层强制点构造反例，证明启动出来的进程、协议会话、Module control group、Core 服务身份、持久记录、Claim 和 submission record 属于同一次启动，并阻止任何缺少完整停止证据的路径把记录写成 `stopped`。不能只补一个单元测试分支后宣称端到端完成。

同时不要让整个项目只剩 Linux 进程所有权这一条线。安全边界必须在启用 Module 前闭合，但下面的架构审查、通用模型适配和独立研究应并行推进；研究结果会改变后续工程方案。

## 4. 所有者反复指出、仍需正面处理的问题

### Block、引用和 Media

所有者明确不满意现有 Media 与 Block 管理方式，认为它不符合“引用”的直觉并会增加出错概率。不要因为已有 `BlockManager`、`MediaStore` 或架构决策记录就默认当前抽象正确。应从可观察语义、故障恢复、并发、持久生命周期、访问授权和开发者易用性重新审查。

Media 应在一个 Dolly 实例内保持一个稳定身份。默认以本地原始字节为权威。裁剪是引用到同一原图的逻辑视图，不应自然演变成每次裁剪一个长期对象。只有明确的派生文件操作才应产生第二个持久对象，并有独立且可恢复的生命周期。

### 阿里云对象存储

对象存储服务（Object Storage Service，OSS）是可选适配器，不是 Dolly 或 Extension 的必需环境。所有者已经关闭桶的公共读取；不能把普通对象 URL 当成可公开访问。远程模型确实只能通过 URL 取媒体时，才应考虑临时上传私有、精确版本的原始对象，并给出短期签名 URL。裁剪优先复用同一对象的签名图片处理参数，例如阿里云的 `x-oss-process`，但真实私有桶、签名查询参数、模型取图和像素结果都必须做端到端实验后才能宣称可用。

现有 `AliOssDirectObjectStore` 未接入受支持产品路径，也不符合当前存储适配器的完整契约。当前代码不能声称 OSS 可用。启用前至少要验证：私有桶、对象版本、准确选择存储适配器、未知上传/删除结果的恢复、短期访问记录、裁剪签名、模型实际取图和删除。用户文档必须明确最小权限还需要删除对象和必要的版本清理权限，不只是上传与读取。

真实使用时所有者更偏好 base64 或本地路径，OSS 只是可选功能。不要让一个 Extension 依赖所有者的桶、AccessKey、endpoint 或网络环境。

### 模型和 embedding 配置

大语言模型（Large Language Model，LLM）、视觉语言模型和 embedding 必须由每个 endpoint/model 的实际能力描述驱动，不能只按供应商品牌猜能力，也不能依赖所有者的 Aether 或 DashScope。

所有者通过 Aether 中转自部署的 `qwen3.6-27b`：默认推理，不接受 `enable_thinking`。已测得该端点接受 `thinking: { type: "enabled" | "disabled" }` 对象，但请求参数被接受不等于本次真的推理；对该端点，只有响应中非空的 `reasoning_content` 是本次实际产生推理的证据。配置需要表达一个端点究竟支持哪种控制编码、默认行为和允许值，并把 `reasoning_content` 与用户可见 `content` 分开保存。不要把这一私有端点的行为外推成通用规则。

所有者个人部署希望使用百炼/DashScope 的视觉语言 embedding 来向量化图片；其他用户可能只有 OpenAI 兼容的文本 embedding。这两种都必须是受支持配置。实际 Module 能力应从成功解析出的操作句柄和声明模态推导；没有图片 embedding 时必须明确选择文本化、跳过图片向量或另配字幕/光学字符识别流程，不能悄悄声称图片已被向量化。

默认测试不得访问 Aether、DashScope、OSS 或其他付费端点。真实服务实验必须显式启用，记录去密配置摘要、准确模型和后端，设置次数、时间和费用上限，失败时不得自动退回 mock 后端后仍计为成功。

### Module、控制台和公共仓库

所有者认为旧 Module 代码过于儿戏，测试没有覆盖足够的边界情况。这一判断与当前普通入口仍拒绝 Module 的事实一致。继续实现前需要从协议身份、跨进程故障、取消、超时、重复投递、外部副作用、恢复、配置变化和能力隔离逐层证明，而不是只让 happy path 跑起来。

当前没有可从受支持命令启动的网页控制台或管理面板。`extensions/console/`、`daemon/` 和旧网页是迁移材料，包含全接口监听、查询字符串凭据、`localStorage` 凭据、未转义内容和回环地址跨端口 Cookie 等风险，不能发布或直接开放。未来界面既要达到现代可用性和可访问性标准，也要有真实浏览器安全反例、持久审计和命令行功能一致性。

README 比早期版本诚实，但仓库引导仍未达到公共项目标准。一些 README 链接指向未被 Git 跟踪的 `docs/takeover/` 文件；公共贡献者拿不到这些来源。发布前还要补真实 Linux 安装矩阵、依赖闭包、Extension 开发文档、贡献和安全文档、包安装测试，并选择仍受支持的 Node.js 版本。

## 5. 工程与研究必须并行

Dolly 不只是工程项目。所有者提出的 Additive Increase/Multiplicative Decrease（加性增大/乘性减小，AIMD）调度、tensity、每日总结、持续思维提示、情绪触发、向量轨迹和抽象模式匹配，都是研究假设，不是听起来新颖就应该实现的功能。

至少应维持以下可独立推进的研究方向；每条都由独立报告和版本化原始工件支撑，最后再决定是否工程化：

1. 固定调度基线与自适应调度的吞吐、等待、积压、公平性和稳定性比较，并把加速实验时钟与真实时间尺度分开。
2. Memory 的词法、向量和混合检索基线；新旧记忆权重、情绪、关键词组合、每日总结幻觉、技能提炼、持续思维提示、tensity、轨迹或抽象关系匹配分别做消融和组合实验。
3. LLM 适配器的推理控制、`reasoning_content`、完整工具调用轮次、流式响应、上下文清理、多模态和错误恢复；按准确 endpoint/model 测，不按品牌归纳。
4. 本地 Media、私有 OSS、短期签名 URL、裁剪参数、模型取图和未知结果恢复的完整生命周期实验。
5. 所有者提出的架构横向比较：主模型直接接所有输入和工具，对比主模型只通过辅助模型访问工具和记忆；人工分配角色对比模型自行分工；单主模型对比多个主模型。
6. 长时间事实记忆、人物/地点/概念印象、技能习得和接近真实时间尺度的持续运行。
7. 与 OpenClaw、Hermes 等可比公共系统做公平的成对比较。预算、工具、模型、数据、随机顺序和评判方式必须可比；弱结果应触发设计修改和新一轮实验，不能做一次就结束或只挑有利案例。
8. 无图形服务器上的 computer-use，从显示和驱动的确定性验证开始，再到 Dolly 取消/恢复，最后才允许模型能力和系统比较。

历史 `test/experiments/` 和 `test/memory-experiments/` 不是当前证据。已确认的问题包括：绕过当前 Dolly 运行时、自写替代编排器、API 失败后静默改用 hash mock、错误只打印但退出码仍为 0、缺环境变量时悄悄少比较对象、只看回答关键词而不验证实际状态，以及答案错误时摘要仍显示 100%。这些材料必须保留用于审计，但不能改标签冒充有效 benchmark。

新实验遵循 `docs/experiments/protocol.md`：先写可证伪问题、最简单基线、数据和威胁边界、预期最小有效差异、停止规则以及结果会改变的决策；然后依次做确定性契约测试、固定数据的组件实验、当前 Dolly 路径的故障测试、受控真实服务 canary，最后才做比较性结论。记录源提交和脏工作树、数据哈希、模型能力描述、后端、随机种子、重复次数、逐案例原始结果和独立验证。实验水平不够就改设计再迭代，不能一次运行后收工。

## 6. 仓库目录说明

- `src/`：当前受支持 Core、命令行入口、持久状态、投递、Media、模型操作和进程边界实现。代码存在不代表已在产品入口装配。
- `tests/`：当前支持的确定性测试、契约测试和 Linux 集成测试。默认 `npm test` 主要从这里运行。
- `test/`：旧原型测试和历史研究脚本，尤其 `test/experiments/`、`test/memory-experiments/`；保留但不得当作当前产品证据。
- `extensions/`、`daemon/`：旧 Extension 和 daemon 原型，当前不在受支持发布边界内。
- `docs/spec/`：当前契约草案和规范索引。先看每份状态；Draft 不等于已实现。
- `docs/adr/`：架构决策记录。Proposed 不等于 Accepted。
- `docs/experiments/`：实验协议、Linux runner 文档、结果解释和部分已提交证据。
- `docs/research/`：尚需实验决定的问题。
- `docs/takeover/`：接管审查和路线图；转移时仍未被 Git 跟踪。
- `.qoder/specs/`：所有者原始想法和两份不可信的早期人工智能规范。
- `scripts/`：构建、Linux 一次性容器 runner、实验和检查脚本。使用前读对应文档，不能按名称猜用途。
- `artifacts/`：本机保存的大型实验工件，约 98 MiB。
- `.tmp/`：Windows 测试缓存和临时文件，约 246 MiB。它不是证据来源。
- `dist/` 和 `node_modules/`：Windows 生成物和依赖，不复制到 Linux。远端必须按锁文件重新安装依赖并重新构建。
- `.dolly/`：本地实例数据。不要当作公开示例。
- `HANDOVER_NOW.md`：当前状态入口。
- `TASK_HANDOVER.md`：只供定点查历史。
- `HANDOVER_SUMMARY.md`：较短的旧摘要，不覆盖 `HANDOVER_NOW.md`。

USTC 目录布局：

```text
/home/ubuntu/codex-dolly/
  Dolly/                  当前项目内容的副本；Windows 可重建目录不在其中
  previous-server-work/   以前散落在用户目录顶层的 Dolly Linux 工件
  pnpm-store/             Dolly 在 Linux 上重新安装依赖时使用的项目专用 pnpm store
  npm-cache/              Dolly 测试可使用的项目专用 npm 缓存
  cache/                  Dolly 命令可使用的项目专用通用缓存
  tmp/                    Dolly 命令可使用的项目专用临时目录
  validation/             转移和接管验证的原始输出；按日期和用途分目录
  Dolly-transfer-20260731.tar.gz  已校验的转移压缩包；确认不再需要回滚后可精确删除
```

`previous-server-work/` 有 52 个顶层项目，约 3.5 GiB，包括旧源码副本、依赖、Linux runner 输出、日志和证据。它们不是当前工作区，也不能用目录名推断为当前证据；需要时按 `HANDOVER_NOW.md` 和结果文档核对来源提交。未经核对不要删除。

## 7. 转移时的 Git 和文件状态

转移包含完整项目内容：`.git`、所有已跟踪和未跟踪文件、`.env`、本地实例数据、历史归档和实验工件。Windows 可重建目录 `node_modules/`、`.tmp/`、`.pnpm-store/` 和 `dist/` 不复制到 Linux；应在远端按锁文件重新安装依赖并重新构建。`.env` 含私有 API/OSS 配置，远端权限应为 `0600`；不得显示值、写入日志、提交或复制到实验报告。

转移前以下文件不是 `a134241` 的已提交内容，必须保留，不能随手清理、覆盖或混入无关提交：

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

这些变化来自此前工作，当前交接不替它们背书。开始修改前先查看具体 diff。每次只 stage 已核对的精确文件，先检查 `git diff --cached`，做小提交并及时 push。禁止用 `git reset --hard`、`git checkout --` 或大范围恢复破坏已有工作。

用于转移的干净压缩包是 Windows 上的 `E:\Huasushis\program\Dolly-ustc-linux-clean-20260731.tar.gz`，服务器内保存为 `/home/ubuntu/codex-dolly/Dolly-transfer-20260731.tar.gz`。它大小为 209,224,305 字节，SHA-256 为 `3ED96258D5BC2D14FE3FD5CBAB6EF8FD4BE2526D979D4D0FCD4CCF41E382C7DD`；上传前后摘要一致。压缩包共检查 45,847 个条目，没有任何路径名为 `node_modules` 的目录，也没有 `.tmp`、`.pnpm-store` 或根目录 `dist`。它包含 `.git`、`.env`、交接文件、原始想法、早期规范和未跟踪实验材料。

解压后的工作区约 637 MiB；关键文件摘要与本地一致，Git 的已跟踪修改和未跟踪文件清单也逐项一致。三个由 Git 记录为可执行的 Linux 脚本已经恢复执行位，远端仓库的 `core.filemode=true`；项目根目录权限为 `0700`，`.env` 权限为 `0600`。GNU tar 关于 `SCHILY.fflags` 的提示来自 Windows 文件标志，未发现路径缺失或解压失败。压缩包目前作为一次回滚副本保留在 Dolly 专用目录内，不再需要时只精确删除该文件。

## 8. USTC 环境和操作边界

盘点时服务器为 Ubuntu 24.04.4 LTS，Linux 6.8，x86-64，8 个逻辑处理器，15 GiB 内存，4 GiB swap，约 262 GiB 磁盘可用。已有 Node.js 20.20.2、npm 10.8.2、pnpm 9.15.9、Docker 29.6.2、systemd 255。交互式 Bash 中 `codex` 位于 `~/.local/bin/codex`，转移时版本为 `codex-cli 0.146.0`。

本机 `10808` 同时提供 HTTP 和 SOCKS5 代理。`.bashrc` 已设置：

```bash
export http_proxy="http://127.0.0.1:10808"
export https_proxy="http://127.0.0.1:10808"
```

交互式 Bash 会读取这些变量；非交互命令不一定读取 `.bashrc`。需要联网的独立进程应明确继承代理环境。不要再次把代理配置散落到用户目录或改写其他项目配置。

所有者允许在服务器安装软件和做必要配置，但项目源码、下载、临时文件、虚拟环境、运行输出和新实验必须放在 `~/codex-dolly/` 内。系统级软件包可以安装；不得触碰其他项目、共享 Codex 状态或不属于当前运行的进程和容器。特别不得改动：

- `~/codex-urmotiv/`
- `~/codex-urmotiv-database-foundation-019f99c1/`
- `~/urmotiv-codex/`
- `~/cc.sql`
- 用户目录中名字为单个空格的目录，它属于另一套 `apps/api` 迁移工作
- `~/.codex`、`~/.cache`、`~/.npm`、`~/.local`、`~/.docker` 等共享工具目录
- `~/wlt.sh`、`~/get-docker.sh` 和用户网络/系统配置

不得按 `dolly-*` 等前缀批量杀进程或删除容器。以前两次全量实验在第 72 和第 183 例被这种清理误杀，受害运行只表现为容器消失。只操作当前命令创建并记录的完整进程标识符、容器名和输出目录。转移时服务器没有运行中的 Dolly/Node/Codex 进程；有一个已退出的容器 `dolly-experiment-1465180-06d2ffb2`，在确认不再需要其内部状态前不要扩大清理范围。

宿主用户的 `Linger=no`。需要真实 user service 和 delegated control group 的 ADR 0009 测试不能直接在宿主声称有效，应继续使用仓库的一次性 systemd 容器 runner；Docker Hub 访问问题时使用文档记录且已缓存的 `docker.m.daocloud.io/library/ubuntu:24.04`。源码、命令、环境、脏状态和输出目录都必须留存，且每次使用唯一完整名称。

Linux 是首要平台，Windows 是次要开发平台，macOS 暂不作为发布门槛。能力实验和真实服务测试优先在 USTC 做，普通确定性正确性测试仍需能在本地和持续集成运行，不能把一台私有服务器当作正确性唯一来源。

服务器当前不保证有图形桌面。computer-use 不应直接安装并暴露一个让模型可随意打开终端、文件管理器和任意应用的完整运维桌面。先按 `docs/experiments/computer-use-protocol.md` 做 CU0 显示/驱动验证和 CU1 确定性动作；优先隔离的浏览器会话。若确实需要完整桌面，应放入一次性容器或虚拟机，只挂允许的数据并限制网络，远程访问保持回环/私有并通过 SSH 隧道。最终公共文档要有可复现安装、资源消耗、安全访问和卸载教程。

## 9. 验证和工作纪律

Linux 上不要沿用 Windows `.tmp` 环境说明；在 `~/codex-dolly/Dolly/` 内创建本项目自己的临时目录。Windows 上若再次运行，必须按 `HANDOVER_NOW.md` 设置 `TEMP`、`TMP`、`TMPDIR` 和 npm 缓存到 E 盘，否则 TypeScript 可能崩溃却看起来像零诊断，Vitest 可能假报没有测试。

Linux 重新安装依赖后，至少执行：

```bash
pnpm install --frozen-lockfile --store-dir /home/ubuntu/codex-dolly/pnpm-store
pnpm run typecheck --pretty false
pnpm run build
npm test -- --maxWorkers=4
```

安装本身会替换 Windows 的原生依赖；源代码和 Git 状态必须保持可核对。TypeScript 检查必须看退出码：0 才是干净，2 是类型错误，其他值是崩溃。测试必须核对实际收集到的文件数和用例数；传目录后只运行一部分不是完整性证明。

2026-07-31 的转移核验已经完成依赖安装。安装得到的是 Linux x86-64 原生依赖，而不是从 Windows 复制的 `node_modules/`。同一远端副本上：

- `pnpm run typecheck --pretty false` 通过；
- `pnpm run build` 通过；
- `npm test -- --maxWorkers=4` 实际收集 131 个测试文件和 1669 个测试，其中 126 个文件通过、1 个失败、4 个跳过；1637 个用例通过、1 个失败、31 个跳过；
- 唯一失败是 `tests/conformance/core/linux-core-service-binding-service.test.ts` 的真实 systemd 正面案例。产品检查要求 `ExecStart` 使用 systemd 的 `:` 前缀来禁止环境变量展开，但测试中的 `runProbeInTransientService` 直接把 `process.execPath` 传给 `systemd-run`，没有构造该前缀，因此同时得到 `CORE_SERVICE_EXEC_START_ENVIRONMENT_EXPANDED`。这说明当前正面测试装配与被测契约不一致；仍需在真实 systemd 上验证正确的 `systemd-run` 表达方式，再修改测试并证明故障案例仍能单独变红。不要把它记成产品通过，也不要在未复核 systemd 语义时仅删除断言；
- 不要用 `pnpm test --maxWorkers=4`，因为参数会先被 pnpm 自身解析。`pnpm run test --maxWorkers=4` 虽然能进入 Vitest，但会让 `tests/conformance/operations/package-install-smoke.test.ts` 把 pnpm 当成 npm，再向 `pnpm pack` 传 npm 专有的 `--cache`，产生第二个测试执行器相关失败。通过仓库声明的 npm 脚本运行时，该包安装测试通过。后续应让测试明确支持实际执行器或明确只接受 npm，并分别为选择逻辑增加反例。

因此，远端副本、依赖、类型检查和构建已核对，完整 Linux 测试尚未全绿。接手者的第一项代码工作前应先检查下述原始输出并重新运行该单例，确认它仍是同一个问题。

在提交 `40f0ccb` 上重跑完整测试仍得到完全相同的计数和失败。原始输出保存在 `/home/ubuntu/codex-dolly/validation/20260731-transfer/npm-test.log`，大小 24,636 字节，权限为 `0600`，SHA-256 为 `6226C7619BA4D922291909A24235E487F85A74F209729D241008CC1520E4E0BB`。这份日志是转移核验材料，不在 Git 仓库内；后续运行应写入新的日期或运行目录，不得覆盖它。

以下规则来自反复失败，属于强制工作方式：

1. 每个重要断言都要有会单独变红的证伪。破坏点必须位于真正的强制点，不能被另一条守卫遮住。
2. 能移除被测故障并让测试失败，比只改断言更能证明案例真的覆盖该故障。
3. 运行期测试不能自证“枚举完整”；完整性依赖单一真源生成、类型系统穷尽检查或独立清单核对。
4. 只检查“没有坏事发生”会放过什么都不做的实现；同时要求正面成功证据。
5. 每个 `not-applicable` 和 `inconclusive` 都要逐例解释。不能用汇总掩盖失败。
6. 任何缩小覆盖范围的筛选都必须写入工件，并在计数附近明确显示。
7. 修改共享格式或 runner 前先查所有消费者；修改后做逐案例差异，而不是只比总数。
8. 代码落地后回查所有“X 不存在、X 已存在、X 满足某结构”的陈述，把成立条件写清并删除过期事实。
9. 备份和恢复必须防止备份失败后用空文件覆盖原文件；恢复前核验备份非空和摘要。
10. 产品实现存在不会让仍在使用替身的测试自动失败；每次产品接入都要主动搜出所有替身和自写适配器。
11. 对争议结论有直接收益的一方不能独自完成最终复核。
12. 不破坏已有工作；精确 stage、小提交、勤 push，不用大范围 Git 恢复命令。

目录化实验另有规则：改变同一选择集会产生的目录内容就要增加 `CATALOG_VERSION`；纯过滤能力且对原选择集输出逐字节不变时不用增加。现有 catalog v5 有 570 例、1 个 exclusive；233 个 proposed-arm 案例虽然逐例跑过，但目录要求的重复次数仍被旧 runner 忽略，不能声称完成了时序竞态验证。

## 10. 接手后的第一轮工作

不要直接大改。第一轮应同时完成并留下书面结果：

1. 复核已经完成的远端文件摘要、Git 提交、脏工作树、`.env` 权限和 Linux 验证结果；先重现并解释上文唯一的真实 systemd 失败，不要无理由重新安装依赖。
2. 对照实际 HEAD 复核 `HANDOVER_NOW.md` 的每个“当前”陈述，尤其转移后是否已经过期。
3. 从 P0-5 选择一个跨层风险，在真正产品边界先写会失败的反例，再决定最小修复；不得移除 Module 启动拒绝条件。
4. 同时为至少一个独立研究方向完成预注册或审查现有实验设计。不要用旧脚本的一次运行替代研究。
5. 输出一份简短接管审查：哪些事实已证实、哪些仅是文档目标、哪些设计应重审、工程主线和研究主线如何并行、下一批可提交工作是什么。

接手者应审查前任的判断，包括本文件。目标不是延续已有代码量，而是逐步得到可理解、可证伪、可迁移、对公共用户通用，并且经过有意义实验支持的 Dolly。
