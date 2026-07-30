# 当前状态与待办（接手先读这一份）

写于 2026-07-26 深夜，最近一次更新为 2026-07-31，当前 HEAD 为 `1fd90e1`。P0-3 的 Linux
源码复验仍绑定到 `e9d5975`，不能改标签冒充当前 HEAD；其后的 `d5acea1`、`6ea62f8`、
`8ef9f07` 和 `e9200c5` 只提交了证据或文档。`7462046` 随后修复异步 Core-state update，
`1fd90e1` 修复持久更新完成后锁释放确认失败时继续使用不确定内存状态的问题。上一轮所有并行
会话同时到达上限而停止，任务表随之丢失，所以这份文件是权威的接续点；下文把更早结果明确标为
历史结果，不用追加日志的方式保留过期结论。

`TASK_HANDOVER.md` 有 2269 行、55 个小节，**按时间顺序堆叠，后面的小节会推翻前面的**
（例如 0.29 说"装配做不出来"，已被 0.35 和 0.52b 推翻两次）。**不要从头读它**。
需要背景时按本文件的指路去读特定小节。

---

## 一句话状态

ADR 0009（Linux Core 服务进程归属）的终止范围和启动失败后的五项已知所有权缺陷已有对应实现与
聚焦证据，但默认 Core 退出前的同步持久化仍无期限，不能声称强制退出有端到端时间上界；catalog
v5 的同一组 233 个 proposed-arm 案例已在 `e9d5975` 上逐案例复跑。
这些证据仍不等于完整运行时：普通启动入口继续拒绝配置了 Module 的实例，而且产品代码还没有把
同一个 launcher、Module control group、协议会话、Core 服务绑定和持久记录交叉绑定后再交给
`ReactiveModuleRuntime`。当前工作应先处理下列 P0 风险，而不是把 ADR 0009 改成 Accepted。

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
三个相关测试文件若仍看不到 delegated `core` subgroup 会在收集阶段失败。该提交当时的三文件
Linux 运行是 25/25，普通容器进程中的证伪退出码为 1；这是历史 runner 结果。当前四文件 26/26
结果见 P0-4，不能把两次运行的文件数混写。

### P0-3　整组终止、能力关闭、通道关闭与持久状态：✓ 当前 v5 选择集已复跑

`3e20e77` 是 2026-07-30 的历史实现基线，不是当前源码提交。它建立的终止判据仍有效：能力会话先
同步拒绝新调用并等待已开始的处理程序结束，协议通道已观察到关闭，整个 Module control group 已
证明为空且目录已删除，最后才能把匹配记录写成 `stopped`。当时的本机 91/91、14/14 个定向变异及
catalog v3 的 Linux 工件保留为历史证据，路径为 `artifacts/p0-3/`。

catalog v5 修正了 `live-core-termination` 的判据：必须观察产品对 control-group 文件的操作和目录
删除，不能再因只看到 `populated 0` 就接受仍存在的目录。因此 catalog v3/v4 的 live 结果不能作为
当前判据的替代。当前证据是在干净的 `e9d597579b71fcd5d1711696dfc649c0ea4dac21` 上重新执行同一
233 个 proposed-arm 案例，外层 runner 留存的 `source-status.txt` 为空：

- catalog v5，分组仍为 fixed-interruption 210、capability-idempotency 7、
  live-core-termination 16；
- 225 pass、8 个逐例列明理由的 not-applicable、0 fail、0 inconclusive；
- 与历史 233 个案例相比，没有新增或缺失标识符；221 行的 `status + reason` 不变；
- 其余 12 行全部是 live-core-termination 的 pass，状态未变。理由由含糊的
  `proved-group-termination` 改为与当前判据一致的 `proved-module-cleanup`。这 12 行已逐例审定，
  不是用汇总相同代替逐例比较；
- 16 份 live-core-termination 的 `invariant-evaluation.json` 均已读取核对；233 个结果均无非零
  exit code、超时、缺失工件或 invariant violation；
- 清理尝试 233 个 unit、失败 0，状态目录已删除且残留检查为 clean；
- 留存副本共 8,030 个文件、8,761,267 字节；排序后的逐文件 SHA-256 清单摘要为
  `ce4cf5ca4d3842e9e36bde6bb2d9530a7fa937d072a63bf22c43e865c4aeeb2b`。

当前可复核证据在
`docs/experiments/evidence/linux-core-service-ownership-e9d5975/`；总核对结果在
`validation-report.json`，原始 manifest、逐案例结果和清理结果在其 `run/` 子目录。

**范围限制**：233 行的 `iterations` 仍全部为 1，不是 manifest 计划的 4,391 次；只执行了三个
proposed-arm 组，不是 catalog v5 的全部 570 例；fixed-interruption 仍使用实验 Core stand-in 和
`dolly.experiment.module-protocol/1`，没有证明真实 `ExtensionProcessHost` 或完整运行时装配。
`SC-13-07-cleanup-timeout` 的历史聚焦测试以确定性文件系统注入保持 `populated 1`，不能描述成真实
内核长期不清空。历史变异也没有对 `instanceId`、`moduleId` 做逐字段证明。

### P0-4　启动失败后的控制组所有权与持久状态：五项有对应修改，退出期限仍开放

原来列出的五项缺陷已有 `46180c8`、`2f501c3`、`46a034d` 和 `2333ce1` 的对应修改。这里的
“对应修改”不等于五项风险全部关闭，尤其不能把默认退出函数存在写成强制退出已有总期限：

1. launcher 授权失败现在返回观察到的 process identifier、成员资格、命令是否可能送达以及
   `ModuleCgroup`；生命周期不再丢掉“已经观察到成员”这一事实，也不再把只看到 launcher 退出当作
   整组已经停止；
2. 持久记录只在协议 `initialize()` 成功后写成 `running`。初始化或该写入失败时，executor 仍持有
   同一个 control group，并走整组停止证明；
3. `startLauncher()` 抛错被视为“进程可能已经创建但所有权未知”，而不是猜成未创建；可以证明为空的
   已准备 control group 会清理，无法证明所有权时要求 Core 退出；
4. `coreMustExit` 已有默认产品退出函数：执行到该函数时调用 `process.exit(1)`，不再只是返回值或
   错误文字。真实 systemd 正反例证明了该函数会被走到并且不可删；但在它之前执行的同步
   `stopping` 写入与文件同步没有时间上界，所以“Core 必定在期限内退出”仍是 P0-5 第 5 项；
5. `FileCoreStateStore` 进入 `CORE_STATE_REOPEN_REQUIRED` 后拒绝所有公开读写，包括先前保留的方法
   引用和嵌套状态路径；回滚后的内存对象不能再冒充磁盘事实。

真实 Linux 已正反向验证默认退出函数这一路径。提交
`edbfd268478f65cb430aa5ece23c9dcd6634c872` 的正向 1/1 测试把产品 executor 自身作为一次性
systemd 服务主进程，未注入 `exitCoreProcess`：服务得到 `Result=exit-code`、
`ExecMainStatus=1`，没有写 fallback 文件，持久记录留在 `stopping`，Core、launcher、Module
control group 和服务 control group 均消失。反向副本只把默认退出函数改为返回，测试即以
`ExecMainStatus=92` 和明确 fallback 原因失败；外层 runner 观察到预期的非零测试状态。随后四个精确
Linux 文件共 26/26 通过。证据、单文件补丁、逐文件 SHA-256 与精确清理记录在
`docs/experiments/evidence/linux-module-executor-systemd-edbfd26/`，解释在
`docs/experiments/linux-module-executor-systemd-results.md`。

**范围限制**：这只证明“launcher 在内核确认前谎报成员资格并拒绝退出”这一条 fail-closed 路径，
以及四个列明的 Linux 文件没有回归。测试刻意使用 `Restart=no`；它不证明成功启动、服务重启与
恢复、生产 Core 服务绑定、其他 launcher 失败，或 runtime startup 已经调用产品 Linux executor。

### Linux 验证 runner：两种模式均留存来源，输出目录不可被覆盖

`run-disposable-container.sh` 现在有两个互斥模式：重复的 `--test-file` 运行列明的精确 Linux
测试文件；不带 `--test-file` 时把筛选参数原样交给所有权实验 runner。两种模式都在各自的唯一工件
目录写入 `source-commit.txt`、`source-status.txt`、`command.txt` 和 `environment.txt`，源码与依赖
只读挂载，只有测试缓存与工件目录可写。

外层 runner 独占 `--output-dir` 和 `--disposable`；调用者试图传入任一参数会直接失败，不能把
`/dolly-artifacts` 改到未留存位置，也不能伪造隔离声明。容器、镜像和工件目录都按单次调用唯一命名，
清理只能使用该次调用的完整名称，不能按前缀批量删除。

### P0-5　当前最高风险：先写跨层反例，再决定修复顺序

以下编号保持稳定，便于后续交接引用；除明确标为“已修”的项目外，都是当前代码审查已确认且尚未由
上面证据关闭的风险：

1. `openProtocolSession()` 不接收刚启动的 launcher 或 `ModuleCgroup`，所以类型与运行时都没有强制
   返回的协议会话属于同一次启动、同一个进程和同一个 control group；
2. Core 服务绑定、持久 process record、当前 boot/service invocation 和 control-group identity
   分别有检查，但启动边界没有把它们作为一个不可拆分的前置条件交叉核验；
3. `FileCoreStateStore.updateModuleProcessRecordState()` 是公开的状态写入方法，并接受
   `stopped`；类型没有要求调用者同时提交已关闭协议通道、已结束 capability handler、
   `populated 0` 和目录删除的证明。
   `stopModuleProcess()` 在自己的路径上稍后重新证明这些条件，不能阻止别的调用者先持久化并暴露
   一个没有证明的 `stopped`；
4. submission record 与 Claim 的规范强度互相冲突。`core-runtime.md` 一处要求每条 submission
   record 精确匹配 active Claim，并把找不到 Claim 的孤立记录定为 fail-closed；另一处又把“没有
   active Claim 的 submission record”解释成已终止、可收集的残留。当前写接口只强制匹配
   `running` process record 和 Module generation，不强制匹配 Claim 的 job、token、run、attempt；
   启动恢复实现了较弱的后一种解释。这项规范冲突尚未裁定，不能把任一方向写成已经决定的方案；
5. 所有权未知时的 control-group 清理有超时，但它之前的同步 `stopping` 持久化调用没有时间上界；
   若该调用不返回，默认 `process.exit(1)` 强制点也到不了；
6. ✓ **已修（`7462046`）**：`FileCoreStateStore.runAtomicUpdate()` 现在只接受静态返回
   `void` 或 `never` 的回调；直接传入 `async` 回调或返回非 `undefined` 值的回调都会被 TypeScript
   拒绝。运行时也拒绝通过类型断言绕过后返回的任何非 `undefined` 值，不读取返回对象的 `then`
   getter，不持久化局部更新，并使原 store 进入 `CORE_STATE_REOPEN_REQUIRED`，所以已返回 Promise
   的异步后续代码不能再写该 store。四类反例分别覆盖：带 `then` getter 的返回值、首次变更后的
   异步后续代码、首次变更前等待的异步后续代码，以及未改变状态就同步抛错时 store 仍可用。两个
   直接类型反例也留在测试中；受影响的精确测试为 30/30，完整 `typecheck` exit 0；
7. Linux executor 没有像 `coreExitCleanupTimeoutMs` 一样验证 `terminationTimeoutMs` 和
   `channelCloseTimeoutMs`；`NaN` 等无效值会破坏“有界等待”的含义；
8. `runtime-bootstrap.ts` 仍拒绝配置了 Module 的运行时，也没有生产调用者把 service binding、
   launcher、control group、协议会话、持久记录、Claim 与 submission record 装配成一条路径。
9. `DollyRuntimeSession.core` 公开暴露具体的 `FileCoreStateStore`，不是只读或按职责收窄的接口；
   任何拿到 runtime session 的调用者都能直接使用上述 process/submission record 写入方法。当前
   没有证据证明这些写入只能从持有对应运行时证明的路径到达；
10. store 只按 `processGenerationId` 防重复；它允许同一个 instance、Module 和 Module generation
    同时存在多条 `starting`、`running` 或 `stopping` 记录。后续恢复检查不能撤销这种重叠已经被
    持久化并可能被其他代码观察到的事实。

处理这些问题时不要只补单元分支：每项先在真正的跨层强制点构造会失败的反例，尤其要证明“来自另一
次启动的会话/记录”不能被接受，以及没有停止证明时任何路径都不能写 `stopped`。

另外有四项已审查的后续问题；第 1 项已经修复，其余三项仍开放：

1. ✓ **已修（`1fd90e1`）**：跨进程锁在持久更新提交后才报告释放确认失败时，
   `FileCoreStateStore` 现在进入 `CORE_STATE_REOPEN_REQUIRED`。判断边界是锁内回调是否已经
   返回：回调自身抛错仍按原错误处理，不误把未完成更新标成释放失败；回调已返回后，
   外层锁调用再抛错才表示提交可能已完成而释放确认失败。反例保留真实的锁获取、回调与释放，
   只在三者结束后注入错误，并证明磁盘是新 revision、记录 API 回滚出的内存是旧 revision、原 store
   及失败前取得的读取方法都拒绝继续使用。相关精确测试为 53 pass、1 个平台限定的 skip；
2. 真正进入 `CORE_STATE_REOPEN_REQUIRED` 的 store 在 Linux executor 内没有替换或让 Core
   退出重开的产品策略，普通终止重试会永久持有失效对象；
3. state file 的父目录若通过符号链接或 Windows junction 形成两个路径别名，同一文件可能得到
   两个不同的锁标识；当前没有跨别名互斥证据，修复方式尚未决定；
4. 单次读取 `cgroup.procs` 不能阻止进程在验证后迁移到 sibling control group。ADR 0009 已承认
   这需要执行后端强制，当前产品路径仍没有该保证。

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
“4.5 秒/次 → 10.6 小时/遍”不是完整重复计划的实测，不能作为停止规则依据；P0-1 的两次历史
233 例单次运行和当前 `e9d5975` 的单次复跑也都不能外推真实重复耗时。

下一步必须先让 runner 从目录读取重复次数和固定种子、实际执行并诚实记录每次迭代，再用
一个小选择集证伪：目标迭代数减一时案例或完整性检查必须变红。之后才测并行容器上限并定
停止规则。P0-1 的单次逐案例 A/B 结论有效，但没有提供时序竞态证据。

### P3　收尾项

- **`live-core-termination` / `capability-idempotency` 的独立复现**：现有结果全部出自
  同一台机器同一镜像。换人换机器跑一遍。当前可移交的同步来源是提交中的
  `docs/experiments/evidence/linux-core-service-ownership-e9d5975/`，其
  `validation-report.json` 记录 8,030 个文件的完整副本和逐文件清单摘要；不要再用旧的
  219 文件摘要代表当前结果。
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

## 已核实的重要改动与当前证据

| 改动 | 位置 | 核实 |
|---|---|---|
| 目录入口守卫在符号链接工作树下静默失效 | `lib/catalog.mjs` 用 `realpathSync` | 符号链接路径 708,267 字节，与直接路径 `diff` 为空 |
| 后代创建移到第一次能力请求之前（真覆盖缺口） | `core-standin/dolly-protocol-extension-fixture.py` | `ast.parse` 通过，无重复分支，`elif`→`if` 已改 |
| 恢复"两条 arm 计数不可相减"限制 + 改正"三条 arm 共用 fixture"错误陈述 | `handlers/baseline-fixture-contract.md` | 逐文件 grep 核实引用关系 |
| ADR 装配状态重新审查 | `docs/adr/0009-*.md`、executor、结果文档 | 独立实现存在，但运行时连接未证明；剩余缺口数未知 |
| 记录回收判定抽为纯函数 + 10 例测试 | `src/core/core-startup-recovery.ts` | 三条守卫分别置真 → 4/1/2 例失败 |
| P0-1 手写 launcher control 换成产品适配器 | `core-standin.mts` | 14 例边界 A/B + 233 例完整 A/B，逐案例三字段 diff 均为空 |
| P0-2 真实 Linux control group 与文件描述符验证 | Linux integration test、fixture、control-group implementation | 未修改产品实现时 2/2 pass；仅终止直接进程的证伪在 `populated 1` 处失败；清理后零残留 |
| P0-3 完整终止证明 | executor、`ModuleCgroup`、停止生命周期、实验调用点 | `3e20e77` 的本机与变异结果保留为历史；`e9d5975` 上 catalog v5 的同一 233 例为 225 pass / 8 not-applicable，221 行不变，12 行审定为只改 reason |
| P0-4 启动失败所有权与 Core 退出 | 生命周期、Linux executor、`FileCoreStateStore` | 五项有对应修改；真实 systemd 正向 1/1、默认退出反向变异失败、四文件 26/26；前置同步持久化无期限，范围限制见 P0-4 / P0-5 |
| Linux runner 的执行与证据边界 | 一次性容器入口、精确 Linux 测试入口、实验入口 | 两种模式均记录来源、状态、命令和环境；拒绝调用者覆盖 `--output-dir` / `--disposable`；catalog v5 为 570 例 |
| 拒绝异步 Core-state update | `FileCoreStateStore.runAtomicUpdate()`、启动恢复接口 | 类型与运行时都拒绝异步回调和非 `undefined` 返回值；四类反例通过，精确测试 30/30，完整 `typecheck` exit 0 |
| 锁释放确认失败后关闭旧 store | `FileCoreStateStore.#withMutationLock()` | 按回调是否已返回区分回调错误与释放确认错误；精确测试 53 pass、1 个平台限定 skip |
| 恢复完整 TypeScript 范围并修复 91 条诊断 | `tsconfig.json`、`package.json`、33 个测试文件 | 标准 `typecheck` exit 0；按受影响文件精确运行的用例全绿，5 个未启用的付费 live 用例明确 skipped |

当前核实点：HEAD 为 `1fd90e1`。P0-3 Linux 复验使用的源码与 runner 仍是 `e9d5975`；其后的
文档/证据提交为 `d5acea1`、`6ea62f8`、`8ef9f07`、`e9200c5`，产品代码修复为 `7462046` 和
`1fd90e1`。目录为 **v5、570 例、1 个 exclusive**。catalog v5 修改了 live-Core 终止判据，所以
该组必须重跑；当前 233 例 proposed-arm 选择集已重跑，但完整 570 例和目录声明的重复次数仍未
执行。更早 catalog v3 的 P0-3 工件只作为历史运行保留。

---

## 环境（不读这段会浪费大量时间）

**C 盘 100% 满，可用 0 字节。** 占用是机器所有者自己的应用，不是本项目产生的，未做删除。
`/tmp` 映射到 C:，所以：

- `tsc` 崩成 `Zone Allocation failed`，**崩溃后 grep 不到 `error TS`，和零错误长得一样**；
- vitest 报 `Tests no tests`，看着像文件里没有用例；
- 写 `/tmp` 一律 `No space left on device`。

PowerShell 中每次运行 `tsc` 或 Vitest 前先设置：

```powershell
New-Item -ItemType Directory -Force E:\Huasushis\program\Dolly\.tmp | Out-Null
$env:TEMP='E:\Huasushis\program\Dolly\.tmp'
$env:TMP='E:\Huasushis\program\Dolly\.tmp'
$env:TMPDIR='E:\Huasushis\program\Dolly\.tmp'
```

若从 Git Bash 运行，同一目录写作 `/e/Huasushis/program/Dolly/.tmp`，三个环境变量必须指向它。

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
- v4：删除无法由静态目录诚实声明的 `status: "not-implemented"`；选择集和判据不变 → 升，
  v3/v4 的同一选择集可直接比较。
- v5：`live-core-termination` 必须观察产品 control-group 文件操作和目录删除，不能只接受
  `populated 0`；判据改变 → 升，v3/v4 的该组必须重跑。
- `--exclude-id` 过滤能力（对任意选择集输出逐字节相同）→ **不升**。

**判据修订必须落在目录上，不能落在 handler 里**：一个由跑这些案例的人在案例失败时
可以自行改写的判据，不是预注册判据。

**不同判据版本的 `live-core-termination` 结果不得合并。** v1/v2 曾出现工件标签
`catalogVersion: 1` 而 evaluator 施加 v2 判据的情况——发现者主动作废重跑，
**不是改标签让它对上**（那是伪造）。同样，v3/v4 不能冒充 v5；当前合格复跑是
`docs/experiments/evidence/linux-core-service-ownership-e9d5975/`。
