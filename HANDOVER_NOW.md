# 当前状态与待办（接手先读这一份）

写于 2026-07-26 深夜，最近一次更新为 2026-07-30 完成 P0-3 终止范围验收。上一轮所有并行
会话同时到达上限而停止，任务表随之丢失，所以这份文件是权威的接续点。

`TASK_HANDOVER.md` 有 2269 行、55 个小节，**按时间顺序堆叠，后面的小节会推翻前面的**
（例如 0.29 说"装配做不出来"，已被 0.35 和 0.52b 推翻两次）。**不要从头读它**。
需要背景时按本文件的指路去读特定小节。

---

## 一句话状态

ADR 0009（Linux Core 服务进程归属）的**终止范围**已通过独立审查、14 个反向变异和新的
Linux 逐案例运行；但启动失败后的控制组所有权仍有 P0 设计错误，不能声称完整运行时已经正确。
运行时也没有把同一个已启动 launcher、已验证 Module control group、
`attachLinuxModuleProcess` 和 `ExtensionProcessHost` 端到端连接起来。实验已经改用产品
launcher control 和停止生命周期，但仍使用实验协议，因此完整装配的剩余缺口数仍必须视为未知。

---

## 待办，按优先级

### P0-1　已完成：`core-standin` 改用产品 launcher control 适配器

`runWorkload` 和 `runLiveTermination` 现在都返回
`createModuleLauncherControl({ launcher: started })`。手写实现中的错误路径转换、硬编码
open-file limit、丢失的失败证据，以及第一处漏关控制描述符均已删除。

交接中的两个结论经审查证实是错的：

1. 不是 40 例。三个 proposed 组共有 **233** 例；其中 **184** 例真正创建并配置
   适配器，**176** 例进入 `authorizeExecution`。三个数字分别表示选择集、配置覆盖和授权
   覆盖，不能混用。
2. `createModuleLauncherControl` 负责启动阶段控制和成员资格验证前退出。ADR 0009
   required failure test 13 的整组终止适配器是 `attachLinuxModuleProcess`；本轮实验仍未
   运行它或 `ExtensionProcessHost`，所以 P0-1 不能作为 failure test 13 的证据。

验证在 USTC 的两个独立一次性 systemd 容器快照上完成，均为 catalog v3、同一数据集
哈希、`service-mode=user`、`seed=1`：

- 源码快照 SHA-256：before
  `759c8cb9057b9407a023a129c0fad713d9d544e398f3d0159fb064760a5c8d93`；after
  `6b457575d5cc373fa453018203ef62bafd99fc23c335b1a4fba66eb95f15588b`。逐文件比较只差
  `core-standin.mts` 和 lifecycle 的事实注释；
- M10 边界：before/after 各 14 例全过，排序后的 `caseId + status + reason` 投影相同；
- 三组完整运行：before/after 各 233 行、225 pass、8 not-applicable、0 fail、
  0 inconclusive；manifest 计划执行数各 4,391，但所有结果均为 `iterations: 1`，所以实际
  只各跑 233 次；分组行数均为 210/7/16；
- 完整投影 SHA-256 均为
  `9e29e059f85158bc43c378cc0634ce457b663fb222cdc7448e42ef527b66ab4a`，diff 为空；
- 8 条 not-applicable 已逐例核对，都是无输出时 M11/M12 不发生，或成员资格验证前
  Extension 尚未执行、无法创建后代；不是被汇总掩盖的失败；
- 本地 `typecheck` exit 0；产品适配器精确单测 1 文件、16 例全过，其中新增一例用真实
  controller 证明成员资格已验证后的授权失败仍拒绝把 direct-child exit 当作整组证明。

完整工件在本机 `artifacts/p0-1/`（源码 tar、四次运行、四份投影、两份空 diff），详细
结果写入 `docs/experiments/linux-core-service-ownership-results.md`。背景仍可定点查
`TASK_HANDOVER.md` 0.52b、0.53，但其中“40 例”和适配器职责不得再引用。

### P0-2　`#19` B 类 2 例：已在 Linux 内核强制点运行 ✓ 完成

`tests/conformance/security/linux-module-attached-process-integration.test.ts`
的 2 例在 USTC 的 systemd 255 容器中运行，环境为 Linux control group v2、内核
6.8.0-106-generic、Node.js 20.20.2。Core 位于 user service 的 delegated `core` subgroup；
从普通 `docker exec` 直接运行会跳过两例，该结果已经拒绝作为证据。

未修改产品实现的运行，其 JSON 逐例结果为：

- `terminates a descendant that left the process group`：pass。后代位于 Module control group，
  process group identifier 与 launcher 不同；`cgroup.kill` 后后代消失且 `populated 0`；
- `carries the Extension protocol on descriptors 0 and 1 after exec`：pass。真实
  `ExtensionProcessHost` 完成 handshake 和一次 Run；fixture 返回的 `process.pid` 与 launcher
  process identifier 相等，证明 `exec` 前后是同一个 process identifier；
- 总数 2、pass 2、failed 0、skipped 0。不能只引用 Vitest 汇总行；保留的 JSON 含两个命名
  assertion。

第一次 Linux 尝试缺少 `prepareDelegatedCgroupRoot`，写 `memory.max` 得到 `EACCES`。测试现已
在创建 Module control group 前启用 delegated root 的 `cpu`、`memory`、`pids` controller。
这修复的是测试装配；`src/` 仍没有调用者负责该步骤，产品运行时缺口没有被测试修复掩盖。

证伪也完成：独立源码副本把 adapter 改成只向 direct launcher process 发送 `SIGKILL`，并
错误地把 direct-process exit 报告为整个 Module exit。第一例随后在真正的区分点变红：
`attached.exited === true`，但 `cgroup.events` 仍是 `populated 1`，逃逸后代仍存活。证伪运行
只选择第一例，第二例在 JSON 中明确记作 skipped。运行后 unit、control group 和后代残留均为 0。

为了排除资源限制误杀，测试使用 256 MiB 与 64 tasks 的宽松限制，且两例运行前后的
`memory.events:oom_kill` 不变。控制结果、证伪结果、补丁及源码哈希已写入
`docs/experiments/linux-core-service-ownership-results.md`；本地工件在 `artifacts/p0-2/`。

**范围限制**：这两例直接驱动 launcher controller，没有运行 `startModuleProcess`，因此只证明
adapter 的整组终止和 `exec` 后文件描述符 0/1 上的协议传输，不证明完整 runtime assembly。
全 skipped 假阳性已在提交 `e391ff9` 修复：runner 设置“Linux 集成环境必须存在”的环境变量，
三个相关测试文件若仍看不到 delegated `core` subgroup 会在收集阶段失败。Linux 正向运行 25/25，
普通容器进程中的证伪退出码为 1。

### P0-3　整组终止、能力关闭、通道关闭与持久状态：✓ 完成终止范围验收

产品提交为 `3e20e77`，runner 修复为 `e391ff9`。终止成功现在必须同时证明：能力会话已同步拒绝
新调用且已有处理程序结束、协议通道已观察到关闭、整个 Module control group 已为空、目录已删除，
而且匹配的持久记录已写成 `stopped`。`stopping` 写失败仍启动物理清理，但禁止报告成功；并发停止
共享同一最终状态；协议挂接失败、初始化未结束或记录与控制组不匹配均不能被当作成功。

验收证据：

- 本机精确 4 文件 91/91，主 `typecheck` exit 0；
- 冻结六文件逐 SHA-256 一致的隔离副本中，14/14 个定向变异都使预定的单个断言失败，底层
  Vitest 均 exit 1；报告在
  `artifacts/p0-3/mutation/module-termination-mutation-tests-20260730-004/REPORT.md`；
- 独立代码复审没有再发现当前终止补丁的错误成功或错误 control group 终止；
- Linux 冻结归档 SHA-256 为
  `74e292fc35196d46ffcc74e5cf0ebd6d7a0ed1d4763fb1a552b6a1c9ad35ebe8`；
- P0-2 两个命名测试重新实际执行，2/2 pass、0 skipped，JSON SHA-256 为
  `dcdd24d0dce695d2f987cce828c5a0fae8d51df352b2de92437fc57cee0eab2d`；
- `SC-13-07-cleanup-timeout` 1/1 pass；它使用真实进程、control group、成员资格和 `cgroup.kill`，
  但以确定性文件系统注入保持 `cgroup.events` 为 `populated 1`，不能描述成真实内核长期不清空；
- `live-core-termination` 为 12 pass、4 个逐例合理的 not-applicable、0 fail/inconclusive；
- 三个 proposed 组完整重跑 233 行：225 pass、8 not-applicable、0 fail/inconclusive；210/7/16
  分组计数不变。按 `caseId + status + reason` 排序后与 P0-1 的 retained projection 逐行相同，
  新增、缺失和变化均为 0。工件在 `artifacts/p0-3/`。

**不得夸大**：233 行的 `iterations` 仍全部为 1，不是 manifest 计划的 4,391 次；M14 聚焦工件没有
停止前 descendant process identifier 快照；变异只分别证明了错误 control-group path 和错误 process
generation，没有对 `instanceId`、`moduleId` 做逐字段变异；stand-in 仍不等于完整 runtime assembly。

### P0-4　启动失败后的控制组所有权与持久状态：当前最高优先级

已由三个独立审查交叉确认，当前实现有以下 P0 错误，尚未修改：

1. 产品 launcher control 保留了 `membershipVerified: true`，但 `startModuleProcess` 捕获普通异常后
   丢弃该事实，错误地走验证前退出；额外 process identifier 已在组内时也可能只观察 launcher 退出，
   错写 `stopped`；
2. `running` 在协议 `initialize()` 前写入，违反规范定义；该写入失败又会使 executor 丢失已经验证的
   control group，无法执行整组终止；
3. `startLauncher()` 的 rejected Promise 不能区分“未创建进程”和“spawn 后失去控制”，现有真实
   launcher 确实可能在 spawn 后抛错；准备好的空 control group 也会遗留；
4. `coreMustExit` 目前只是返回值和错误文本，没有真实 Core 服务退出强制点；
5. `FileCoreStateStore` 进入“必须重新打开”状态后仍可读取回滚后的内存记录，不能把它当作磁盘事实。

下一步先写跨层反例，再改契约：控制组一旦准备成功，每个结果必须在函数内完成可验证清理，或把
`ModuleCgroup` 交给 executor；`running` 只在协议初始化成功后写；成员资格已验证或观察到任何成员时
必须整组终止。不要让 core 识别 adapter 的 Error 类，也不要新增无法解释的状态名。

### P1-1　`typecheck` 覆盖和诊断修复 ✓ 完成

**已完成**（2026-07-27）：

1. ✓ 确认收窄原因：为了让 tsc 在 C 盘满、内存紧的机器上跑得动（临时绕过 OOM）
2. ✓ 恢复原始 `include: ["src/**/*", "extensions/**/*", "daemon/**/*", "tests/**/*"]`
3. ✓ 用跨 Windows/Linux 的直接 Node 调用写入 `package.json`：
   `node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit`
4. ✓ 阳性对照验证：往 `extensions/console/index.ts:14` 注入类型错误，tsc 精确定位，撤回后 exit 0
5. ✓ 修复 33 个测试文件中的 91 条真实诊断，没有用扩大 `any` 或无依据的
   `as unknown as` 掩盖问题；故意构造非法输入的测试在局部边界明确说明原因
6. ✓ 按受影响文件精确运行测试；已运行用例全部通过。付费 live memory 文件加载成功，5 例因
   未启用开关/API 而明确 skipped，不计作 pass
7. ✓ 最终 `npm.cmd run typecheck -- --pretty false` exit 0

`src/config.ts` 不需要单独排期——原始配置下它本来就被检查且干净。

### P1-2　`sc1305` 也在测替身 ✓ 完成

**已完成**（2026-07-27）：`handlers/dependency-unavailable-driver.mjs` 现在使用
`createModuleLauncherControl` 真适配器 + 一个 `send()` 会失败的 channel。
断言仍保持 `MODULE_PROCESS_LAUNCHER_FAILED`（lifecycle 层的汇总码），
底层真实路径是 `LAUNCHER_CONTROL_SEND_FAILED`。

改完之后 `startModuleProcess:238` 的 configure catch 分支确实没有产品路径覆盖了
（真适配器的 `configure()` 只记录、不抛）。**没删那条分支**——删掉等于把接口收窄成
"只有当前这一种实现"。

**Linux 验证仍待办**：handler 在 Windows 上加载正常，但这条独立案例还没有留存的 Linux
运行结果。它不属于上面已完成的两条聚焦测试，也不能因 P0-2 通过而算完成。

### P2-1　两条 arm 的实测冲突：待定案，且不能由受益方自证

两条 arm 对 `M07-after` 是否存在后代给出冲突结果。

- 一方（读 210 例留存工件的 `cgroup.procs` 成员数）：分界在
  `M08.completion-after` 与 `M09-before` 之间，M07-after **只有 1 个成员，无后代**。
- 另一方：M07-after **有**后代。

最可能的答案是**两条 arm 的 M07-after 本来就不是同一时刻**（一方打在 `module.execute`
帧写完那一刻；另一方是 PROVISIONAL 定义"第一个 capability 请求回到 Core"）。

**定案需要**：让后者按同样方式扫一列 `members`，并确认其屏障落在 capability 回复
**之前**还是**之后**。之前 → 也该是 1 个成员，那才是真缺陷；之后 → 两份观测都对。

**程序要求**：提出冲突的一方主动指认了自己的偏向——前两次观测缺陷都让基线显得更好，
这次若是缺陷则**方向相反、偏向对他有利**，所以他要求由他人复核他的表。**照办，
不能由受益方自证。** 并且要回答第三个问题：若是观测缺陷，**它还影响哪些案例**。

### P2-2　重复执行与停止规则：P0-1 已解锁，但 runner 尚未执行目录要求

目录自报完整选择集 `planned_executions 8985`，其中 8,500 次来自 85 个 M04 / M07 /
M14 重复案例。P0-1 的两个完整 manifest 也各自报 4,391 次计划执行；但是两份
`results.jsonl` 的 233 行全部是 `iterations: 1`，实际每个案例只跑了一次。

根因已定位：catalog 的 TSV 第 8 列是重复次数，`run.sh` 的主循环只读取 7 个变量且没有
重复循环，`record_result()` 又把已实现 handler 的 `iterations` 固定为 1。因此旧的
“4.5 秒/次 → 10.6 小时/遍”不是完整重复计划的实测，不能作为停止规则依据；本轮两次
233 例单次运行各约 6 分钟也不能外推真实重复耗时。

下一步必须先让 runner 从目录读取重复次数和固定种子、实际执行并诚实记录每次迭代，再用
一个小选择集证伪：目标迭代数减一时案例或完整性检查必须变红。之后才测并行容器上限并定
停止规则。P0-1 的单次逐案例 A/B 结论有效，但没有提供时序竞态证据。

### P3　收尾项

- **`live-core-termination` / `capability-idempotency` 的独立复现**：现有结果全部出自
  同一台机器同一镜像。换人换机器跑一遍。同步标识用
  **219 文件 / `sha256:bad7e1c76b80a3e2e3aa057a914363ba5a18b8a912c303fb7dd2639b689660fd`**
  （远端从解出文件重算 `mismatches 0 of 219`），**不要用更早的摘要**。
- **`raceRepetition` 从未跑过**：2026-07-27 的 P0-1 manifest 计划 4,391 次，但 233 条
  结果全部为 `iterations: 1`；runner 忽略 catalog 的重复列。"跑过一次"不等于"没有
  时序竞态"。
- **`SC-03-05-machine-reboot`**：reboot 恢复无法从被重启的环境内部测试，需要环境之外的
  编排器。真实基础设施缺口，无方案。
- **`docs/spec/schema-registry.md`（Draft, 665 行）只有契约没有实现**，且**无法在
  package schema v1 上实现**，需要 `dolly.extension-package/2`。五条产品决策已裁完写入。
  它引用了 4 份别人的文档，文档内已写明**义务式标注**：改那 4 份中任何一份的人，
  有义务回来重新核对——那些陈述不会显式过期，只会静默变假。
- **`fixed-interruption` 的 fixture 分叉**：三个 proposed handler 仍 exec 旧
  `core-standin/extension-fixture.py`，两条基线已用
  `dolly-protocol-extension-fixture.py`。所以同一案例两条 arm 跑两份 fixture、
  两套消息封套，**per-boundary 计数不可直接相减**（该限制已在
  `handlers/baseline-fixture-contract.md` 恢复）。P0-1 只替换 launcher control；fixture
  统一属于真实 `ExtensionProcessHost` 协议迁移，仍未完成。

---

## 我这一轮改了什么（都已核实）

| 改动 | 位置 | 核实 |
|---|---|---|
| 目录入口守卫在符号链接工作树下静默失效 | `lib/catalog.mjs` 用 `realpathSync` | 符号链接路径 708,267 字节，与直接路径 `diff` 为空 |
| 后代创建移到第一次能力请求之前（真覆盖缺口） | `core-standin/dolly-protocol-extension-fixture.py` | `ast.parse` 通过，无重复分支，`elif`→`if` 已改 |
| 恢复"两条 arm 计数不可相减"限制 + 改正"三条 arm 共用 fixture"错误陈述 | `handlers/baseline-fixture-contract.md` | 逐文件 grep 核实引用关系 |
| ADR 装配状态重新审查 | `docs/adr/0009-*.md`、executor、结果文档 | 独立实现存在，但运行时连接未证明；剩余缺口数未知 |
| 记录回收判定抽为纯函数 + 10 例测试 | `src/core/core-startup-recovery.ts` | 三条守卫分别置真 → 4/1/2 例失败 |
| P0-1 手写 launcher control 换成产品适配器 | `core-standin.mts` | 14 例边界 A/B + 233 例完整 A/B，逐案例三字段 diff 均为空 |
| P0-2 真实 Linux control group 与文件描述符验证 | Linux integration test、fixture、control-group implementation | 未修改产品实现时 2/2 pass；仅终止直接进程的证伪在 `populated 1` 处失败；清理后零残留 |
| P0-3 完整终止证明 | executor、`ModuleCgroup`、停止生命周期、实验调用点 | 本机 91/91 + 14/14 定向变异；Linux 2/2、1/1、12 pass + 4 not-applicable 和完整 233 行均符合各自判据；逐案例三字段 diff 为空 |
| Linux runner 拒绝全 skipped 并恢复执行位 | 三个入口脚本、三个 Linux integration 文件、catalog | 普通容器证伪 exit 1；systemd 容器 25/25、0 skipped；catalog v4 仍为 570 例 |
| 恢复完整 TypeScript 范围并修复 91 条诊断 | `tsconfig.json`、`package.json`、33 个测试文件 | 标准 `typecheck` exit 0；按受影响文件精确运行的用例全绿，5 个未启用的付费 live 用例明确 skipped |

最终核实：`npm.cmd run typecheck -- --pretty false` **exit 0**；目录 **v4、570 例、
1 个 exclusive**。catalog v4 只删除过期实现状态，案例与判据不变；P0-3 产品实验工件仍准确标记为
运行时使用的 catalog v3。

---

## 环境（不读这段会浪费大量时间）

**C 盘 100% 满，可用 0 字节。** 占用是机器所有者自己的应用，不是本项目产生的，未做删除。
`/tmp` 映射到 C:，所以：

- `tsc` 崩成 `Zone Allocation failed`，**崩溃后 grep 不到 `error TS`，和零错误长得一样**；
- vitest 报 `Tests no tests`，看着像文件里没有用例；
- 写 `/tmp` 一律 `No space left on device`。

```
mkdir -p /e/dolly-tmp
export TMPDIR=/e/dolly-tmp TMP=/e/dolly-tmp TEMP=/e/dolly-tmp
```

**不许整目录跑 vitest**：实测汇总行报 `Test Files 11 passed (11)`，而 34 个文件里
**23 个从没跑过**。逐文件跑，核对实际用例数。

**声称 typecheck 干净必须核对 exit code**：0 干净 / 2 有错误 / **其他值是崩溃**。
只 grep 不看 exit code 是漏洞。

**Linux 环境**：本机无（无 docker/podman/systemd，WSL 无发行版，C 盘满装不上）。
`ssh ustc` 有 docker + cgroup2 + systemd 255，但 `Linger=no`——ADR 0009 的 user service
需要 lingering，**所以 ustc 主机上直跑不成立**（提案组每例都会停在
`CORE_SERVICE_USER_LINGERING_DISABLED → MODULE_ACTIVATION_SERVICE_UNVERIFIED`），
必须走 `run-disposable-container.sh` 一次性容器。
**Docker Hub 从 ustc 解析不了**，必须加
`--base docker.m.daocloud.io/library/ubuntu:24.04`（已缓存）。

**绝不按名字前缀批量删容器**：
`for c in $(docker ps -aq --filter "name=dolly-experiment-"); do docker rm -f $c; done`
已造成两次 210 全量在第 72 / 183 例被杀，**受害方看到的是"没有错误、容器消失"**，
最难归因。只删自己那一个完整容器名。

---

## 工作纪律（这些都是踩出来的，不是偏好）

1. **可证伪验证是硬性的**：每条断言都要能单独变红。破坏点必须是**真正的强制点**——
   曾出现"守卫改空操作测试仍全绿"，因为三条守卫互相覆盖；处置是把判定抽成纯函数，
   好构造出"每条守卫是唯一保护者"的输入。
2. **"移除注入的故障"比"改断言"更强**：前者证明案例真的在检测那个故障条件，
   而不是恒真通过。一个只要环境正常就 pass 的案例，改断言抓不到。
3. **完备性声明无法在运行期自证**：测试跑绿只说明它跑了它列出的那些，
   说明不了它列全了。要表达"全部"只能靠类型系统（`never` 兜底）或从单一真源生成。
   覆盖率量的是被执行的代码，不是被枚举的可能。
4. **否定式检查天然放行"什么都不做"**：只查"没发信号"时，一个既不发信号也从不终止
   整组的实现会通过。必须同时要求正面证据。已由突变实测证实。
5. **`not-applicable` / `inconclusive` 要逐例点名理由**。`inconclusive` 比"留成悬案"
   更糟——实测发现它**埋掉了一条已经暴露的失败**。
6. **凡缩小覆盖范围的动作都要在产物里留痕**，且提示要打印在计数正上方——人读的是
   打印不是 JSON。
7. **改共用文件前先看还有谁在读它**；格式变更当接口变更；改完做**逐案例 diff**
   而不是比对汇总。已有两次"让基线显得更好"的静默退化，方向相同。
8. **过期陈述**：这一轮出现 **6 次**，形状同一个——**在 T 时刻为真的话被写死，
   而没写明它依赖什么条件**。把依赖条件写出来是让陈述能自己失效的唯一办法。
   **改动落地时回头扫一遍所有声称"X 不存在 / X 已存在 / X 满足某形状"的地方。**
   删限制前必须核实限制真的不再成立，而非"应该不再成立了"。
9. **备份/恢复**：不要写 `cp a b && ... ; cp b a`——中间的 `;` 会在备份失败时用空文件
   覆盖原文件（我这么丢过一个文件）。用 `&&` 串，或恢复前 `test -s`，
   或用反向编辑而不是 `cp` 回写。
10. **"产品实现落地"不会让任何顶替它的替身发出信号**——测试不变红、覆盖率不掉、
    名字没变。落地时必须主动去找谁还在用替身。**没有自动化手段。**
11. **不能由受益方自证**：当一处争议的结论偏向某一方时，由他人复核其数据。
12. **禁止破坏已有工作**：不用 `git reset` / `checkout` / `revert`。用户现在明确要求勤于
    提交；每次只 stage 已核对的精确文件，先看 cached diff，再做小提交。不动
    `src/core/runtime-bootstrap.ts` 的 Module guard（**注意路径在 `src/core/` 下**）。

---

## 目录（预注册工件）的修订规矩

`lib/catalog.mjs` 是预注册工件。**判据**：这次改动会不会让"同一个选择集"产出不同的
目录内容？会 → 升 `CATALOG_VERSION`；不会 → 不升。

- v2：`live-core-termination` 判据按 membership 阶段拆开（改了案例数据）→ 升。
- v3：新增 `exclusive` 字段（改了每个案例携带的数据）→ 升。
- `--exclude-id` 过滤能力（对任意选择集输出逐字节相同）→ **不升**。

**判据修订必须落在目录上，不能落在 handler 里**：一个由跑这些案例的人在案例失败时
可以自行改写的判据，不是预注册判据。

**v1 与 v2 的 `live-core-termination` 结果不得合并。** 曾出现工件标签
`catalogVersion: 1` 而 evaluator 施加 v2 判据的情况——发现者主动作废重跑，
**不是改标签让它对上**（那是伪造）。
