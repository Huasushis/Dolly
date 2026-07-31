# 给 USTC 上新 Codex 的启动提示词

在 `/home/ubuntu/codex-dolly/Dolly` 中启动 Codex 后，把下面整段作为第一条任务发送：

```text
你正在接管 Dolly。工作目录必须是 /home/ubuntu/codex-dolly/Dolly；项目源码、临时文件、依赖、实验和输出只能放在 /home/ubuntu/codex-dolly/ 内。服务器还有其他人的项目和共享工具状态，不得触碰、移动、停止或清理。绝不按名称前缀批量杀进程或删容器，只操作当前运行创建并记录的完整标识符。

先执行 pwd、git status --short --branch、git rev-parse HEAD 和 git log -5 --oneline。随后完整阅读 AGENTS.md、HANDOVER_USTC.md 和 HANDOVER_NOW.md。不要从头顺读 TASK_HANDOVER.md；它是会被后文推翻的历史日志，只按 HANDOVER_NOW.md 的具体指路查章节。

然后完整阅读 .qoder/specs/dolly_new.txt，理解所有者的原始想法。再读 .qoder/specs/Dolly架构重构实施计划_ddb07167.md 和 .qoder/specs/Dolly_鲁棒性与功能完善_ddb07167.md，但把它们视为不可信的早期人工智能草案：用它们发现所有者曾强调的需求，不要照着实现。当前代码、测试、规范、交接和实验也都可能错；区分组件存在、组件测试通过和受支持产品真正可用。

为本次接管建立一个持续目标：审查而非盲从 Dolly 的已有设计和证据，在不移除 Module 启动安全拒绝条件的前提下关闭当前最高风险；并行启动能影响工程选择的独立研究，最终把 Dolly 推进为 Linux 优先、跨平台、通用、可公开维护、可证伪验证的项目。不要让工作长期只集中在一个安全子系统，也不要绕过未闭合的安全边界来展示功能。

必须遵守 AGENTS.md：能用通行技术术语时禁止造项目新词；不得不用项目专有名词时必须先用普通语言定义。用中文和所有者沟通，规范可以用英文。

服务器是 Ubuntu 24.04，Node 20、pnpm 9、Docker、systemd 和 Codex 已安装。127.0.0.1:10808 同时有 HTTP 和 SOCKS5 代理，http_proxy/https_proxy 已写入 .bashrc；非交互进程要确认实际继承。允许安装软件和配置环境，但不要污染用户目录。宿主 Linger=no，真实 user service/control-group 验证按仓库文档走唯一命名的一次性 systemd 容器。Linux 比 Windows 更重要，但确定性正确性测试不能只依赖私有服务器。

所有者的 OSS 已关闭公共读取。OSS 是可选适配器，真实使用偏好 base64/本地字节；URL-only 模型需要时才考虑私有对象的短期签名 URL。必须实测签名裁剪、模型取图、版本和删除恢复，用户文档必须写删除权限。不要依赖所有者的 Aether、DashScope、OSS、密钥或模型。

所有者经 Aether 使用自部署 qwen3.6-27b：默认推理、不接受 enable_thinking，已测得接受 thinking.type 对象；只有响应里非空 reasoning_content 能证明该次实际推理。模型配置必须按 endpoint/model 的实际能力描述控制编码和模态。DashScope 视觉 embedding 是所有者的可选部署；只有文本 embedding 的 OpenAI 兼容部署也必须正常工作。

实验不是附属收尾。工程推进的同时，独立研究调度、Memory、模型上下文与推理、多模态/OSS、架构横向比较、长期记忆、竞品 benchmark 和 headless computer-use。每个实验先预注册可证伪问题、基线、数据、模型/后端、种子、重复、指标、最低有效差异、停止规则和会改变的决策；保存逐案例原始数据和独立验证。旧 test/experiments 与 test/memory-experiments 是历史材料，不是当前证据。结果弱就修改设计并版本化迭代，不能跑一次结束。

如果多代理可用，可以把互不写同一文件的只读审查、研究设计、测试复核和实现子问题并行分派；主代理必须亲自读完上述权威入口、合并冲突结论，并避免多个代理在共享工作区互相覆盖。每个改动先查消费者，做可单独变红的反例，逐案例比较，不只看汇总。频繁做精确小提交并 push；不要 stage 或覆盖交接中列出的既有脏文件。

先不要只复述交接。完成远端副本、依赖和最小验证的核对后，给出一份简短但有证据的接管审查：实际 Git/测试状态、信任层级、最危险的设计缺口、应重审的旧抽象、并行研究计划和第一项可逆工作。然后继续执行第一项工作；遇到文件或结论不可信时调查，不要猜。
```

启动命令：

```bash
cd /home/ubuntu/codex-dolly/Dolly
codex
```
