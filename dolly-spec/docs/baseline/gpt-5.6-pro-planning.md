---
status: non-normative-baseline
source: project_sources/03-dolly-2026-08-10.html
source_sha256: d2871803ee0201b83c8e3c020b0e8de92a2d842596237edf9b62a1598135098e
extraction: final assistant-message.content converted from HTML to GFM with Pandoc
---

> **非规范基线：** 以下正文从源 HTML 的最后一条 `assistant-message.content` 机械提取，并由 Pandoc 转为 GitHub-Flavored Markdown；未作语义改写。它是正式规范的规划基线，不是规范性条款本身。

我已经完整看过两份 `.txt`。下面的规划以第一份较新的详细规划为准；第二份作为“所有者原始补充记录”，用于防止遗漏需求，但出现冲突时不覆盖新版决定。因此：

- `Page / Module / Extension / Block / Premise` 保留为核心概念。
- 旧版 `forget`、`sleep`、独立 MCP Extension、`levelupper` 暂不进入当前版本。
- MCP 合并进 LLM Extension。
- `Network/LevelUpper`、`Testament` 属于后续研究项目。
- Alarm 可以作为较早实现的参考 Extension。
- memory、tensity、自适应调度都必须经过对比和消融实验，不能直接成为核心正确性机制。
- 最终目标不是只写一份 spec，而是逐阶段完成 Dolly。fileciteturn0file0 fileciteturn0file1

# 一、总体结论

我建议把 Dolly 重构为：

> **一个确定性、可恢复、可观测的认知运行时，加上一组进程隔离、协议驱动的 Extension，以及完全独立的实验研究层。**

推荐的总体进程结构是：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
┌────────────────────────────┐
                         │ dolly CLI / Web Admin UI   │
                         └──────────────┬─────────────┘
                                        │ JSON HTTP / WebSocket
                         ┌──────────────▼─────────────┐
                         │ dollyd Supervisor Daemon   │
                         │ 实例管理、认证、配置、日志 │
                         └──────────────┬─────────────┘
                                        │ 本地 JSON-RPC
             ┌──────────────────────────┼───────────────────────────┐
             │                          │                           │
┌────────────▼────────────┐ ┌───────────▼───────────┐ ┌────────────▼───────────┐
│ Runtime Worker: Dolly A │ │ Runtime Worker: Dolly B│ │ Runtime Worker: Test   │
│ Page / Scheduler / DB   │ │ Page / Scheduler / DB  │ │ 虚拟时钟/实验环境      │
└────────────┬────────────┘ └───────────────────────┘ └────────────────────────┘
             │ 长度前缀 JSON-RPC
     ┌───────┼─────────┬──────────┬──────────┐
     │       │         │          │          │
  Channel   LLM      Memory     Skills     Alarm
  Process  Process   Process    Process    Process
```

</div>

核心原则是：

1.  **不同 Module 可以并发，同一个 Module 永远单飞。**
2.  **Extension 不使用 Rust 动态库热卸载，而使用独立进程。**
3.  **Block 一旦提交就不可变。**
4.  **Page 是逻辑广播日志，不是无限增长的内存数组。**
5.  **Module 输入不是“取出后立即清空”，而是租约式、成功后提交游标。**
6.  **所有语义通信使用 JSON；大文件字节流走 Asset Service。**
7.  **实验算法不能破坏数据不丢、输入可重试、状态可恢复等基础语义。**

Rust 动态库不是这里合适的主插件机制：Rust ABI 不适合作为长期稳定插件边界，现有 `abi_stable` 方案本身也不支持卸载；Wasmtime Component Model 可以作为未来的沙箱插件路径，但第一版直接引入会显著扩大范围。因此，第一版应采用**子进程 + JSON-RPC**，Wasm 留作后续。<sup>\[<a href="https://docs.rs/abi_stable/" class="cite-num" target="_blank" rel="noopener" title="https://docs.rs/abi_stable/">Docs.rs</a>\]</sup>

------------------------------------------------------------------------

# 二、必须冻结的工程设计与必须保留为实验的内容

| 类别     | v1 必须冻结                            | 暂时只能实验               |
|----------|----------------------------------------|----------------------------|
| Page     | 追加日志、订阅游标、持久化、压缩       | 特殊认知传播机制           |
| Module   | 单飞 Activation、进程隔离、可重启      | 自主改变网络结构           |
| Block    | 不可变、强类型、引用合法性             | tensity 的最终定义         |
| 调度     | 事件驱动、debounce、deadline、背压     | AIMD、PI/PID、自适应周期   |
| Memory   | 混合检索、来源证据、版本化             | 联想图、轨迹匹配、抽象迁移 |
| LLM      | Provider Adapter、上下文预算、工具事务 | 随机遗忘、自主思考强度     |
| Premise  | 结构化 Descriptor + 文本说明           | 完全由模型动态重写         |
| 配置     | 事务更新、分类重载、回滚               | Dolly 自主直接修改配置     |
| Skill    | Agent Skills 标准、目录热扫描          | 自动生成并直接启用 Skill   |
| 多智能体 | 静态配置拓扑                           | 自主分工、自主拓扑演化     |

这张表应成为项目最重要的边界。任何研究功能只有通过 benchmark、消融和故障测试后，才允许从 `experimental` 晋升到稳定部分。

------------------------------------------------------------------------

# 三、需要修正的原始设想

## 1. Page 可以“逻辑上无限”，不能“物理上无限”

Page 应被定义为一个逻辑追加流。已处理数据可以：

- 留在 SQLite 中供调试与回放；
- 从热内存中移除；
- 到达保留期后压缩或删除；
- 被 Block 引用或 Module pin 时继续保留。

因此“不限制 Page 长度”的正确工程解释是：

> Page API 不暴露固定上下文长度，但实现必须有磁盘落盘、配额、游标和 GC。

## 2. 不能先清空 Module 缓冲区再执行

原方案中“取出并清空，然后调用 Module”会在 Module 崩溃、网络中断或进程被杀时丢数据。

正确语义应是：

1.  Runtime 为输入区间建立 `ActivationLease`。
2.  Module 处理这批输入。
3.  返回成功后，Runtime 原子地：
    - 推进输入游标；
    - 提交输出 Block；
    - 写入下游 Page。
4.  失败则租约失效，同一批输入可以重试。

因此 Dolly 的数据处理语义是：

> **至少一次输入投递 + 基于 activation_id 的输出去重。**

真正的“任意外部副作用恰好一次”通常做不到，Extension 必须使用 `activation_id` 或 `idempotency_key` 去重。

## 3. 不应直接修改所有上游 Module 的周期

一个下游 Module 可能有多个上游，一个上游也可能广播给多个快慢不同的下游。直接因为一个下游积压就降低整个上游频率，会造成：

- 无关下游也被减速；
- 环中多个控制器相互振荡；
- 慢节点拖累整个图；
- 局部拥塞变成全局拥塞。

v1 应使用：

- 每个订阅者独立游标；
- Page 磁盘缓冲；
- 有界待处理字节数；
- 明确背压；
- Module 自身的 `min_interval/max_latency`。

AIMD 可以研究，但不能作为第一版默认调度器。

## 4. `Arc<Block>` 不能作为跨进程协议

Runtime 内部可以用 `Arc<BlockRecord>`。但 Extension 进程、重启恢复和持久化只能使用：

- `BlockId`
- `AssetId`
- pin/lease
- Runtime 中的引用图

Module 想长期持有 Block 时，应调用：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
host.block.pin(block_id, owner_module, retention)
```

</div>

而不是持有某个跨进程共享指针。

## 5. tensity 不能控制真实对象生命周期

随机按 `1/tensity` 删除上下文可以作为实验，但不能用于：

- Block GC；
- Asset GC；
- Page 数据删除；
- 工具调用依赖删除；
- 配置状态删除。

否则会出现不可复现、工具事务断裂和随机丢失重要状态。

v1 中建议保留：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
"hints": {
  "tensity": 1.0
}
```

</div>

但它只是**不可信提示值**。Runtime 只做范围校验，不把它用于资源生命周期。它首先只能进入 LLM Extension 的实验性上下文选择器。

## 6. 每日总结不能直接改长期 System Prompt

这会导致：

- 幻觉被永久固化；
- 提示词不断增长；
- 自我强化错误；
- 风格和价值漂移；
- 很难回滚。

正确方式是维护版本化的 `ReflectionPolicy`：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "id": "reflection-...",
  "rule": "遇到接口兼容性问题时，先检查供应商实际返回格式",
  "scope": ["llm-provider-debugging"],
  "evidence_block_ids": ["..."],
  "confidence": 0.78,
  "status": "candidate",
  "created_at": "...",
  "expires_at": null
}
```

</div>

候选 Reflection 必须经过证据检查和回归测试，之后才能进入 active premise。

## 7. 时间相邻只能建立“关联”，不能标记成因果

你的澄清是合理的：A 和 B 本身语义可以完全不同，但如果它们反复在相近位置出现，检索 A 时可能应联想到 B。

但系统只能生成：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
relation = temporal_cooccurrence_association
```

</div>

不能生成：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
relation = causes
```

</div>

除非另有明确证据和因果抽取过程。

------------------------------------------------------------------------

# 四、核心领域模型

## 4.1 标识符和命名

建议使用两类名字：

### 人类可配置的稳定 ID

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
Page ID:       conversation
Module ID:     main-brain
Extension ID:  org.dolly.llm
Module Type:   chat
```

</div>

约束：

- 小写字母、数字、短横线；
- 配置中的 Module ID 视为持久化主键；
- 显示名称单独放 `display_name`；
- 修改显示名称不会移动数据；
- 修改 Module ID 相当于删除并新建，需要显式迁移。

### Runtime 生成的对象 ID

Block 使用 UUIDv7：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
0198ab31-6c44-7e8a-b2bb-...
```

</div>

UUIDv7 是时间有序的 128 位 UUID，适合日志和数据库主键。<sup>\[<a href="https://www.rfc-editor.org/info/rfc9562/" class="cite-num" target="_blank" rel="noopener" title="https://www.rfc-editor.org/info/rfc9562/">RFC编辑器</a>\]</sup>

Asset 使用内容哈希：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
ast_b3_<blake3 hash>
```

</div>

这样相同文件可去重，并能验证完整性。

------------------------------------------------------------------------

## 4.2 Block 分成 Draft 和 Envelope

Module 只能返回 `BlockDraft`，不能自行决定 ID、时间、生产者和 trace。

Rust 语义结构建议如下：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">rust</span>

</div>

``` code-block
pub struct BlockDraft {
    pub description: Option<String>,
    pub parts: Vec<PartDraft>,
    pub actions: Vec<Action>,
    pub metadata: BTreeMap<String, serde_json::Value>,
    pub hints: BlockHints,
}

pub struct BlockEnvelope {
    pub schema_version: SchemaVersion,
    pub id: BlockId,
    pub created_at: OffsetDateTime,
    pub logical_seq: u64,
    pub producer: ProducerRef,
    pub trace: TraceMeta,
    pub body: Arc<BlockBody>,
}

pub struct BlockBody {
    pub description: Option<String>,
    pub parts: Vec<Part>,
    pub actions: Vec<Action>,
    pub metadata: BTreeMap<String, serde_json::Value>,
    pub hints: BlockHints,
}
```

</div>

其中 `Arc` 只存在于 Runtime 内部。

## 4.3 Part 必须始终带类型

不建议允许字符串和对象混用：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
["hello", {"kind": "image", "...": "..."}]
```

</div>

这种设计会让 schema、代码生成、日志过滤和以后扩展变得困难。

统一为：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "kind": "text",
  "text": "hello",
  "format": "plain",
  "language": "zh-CN"
}
```

</div>

推荐的 v1 Part：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">rust</span>

</div>

``` code-block
pub enum Part {
    Text {
        text: String,
        format: TextFormat,
        language: Option<String>,
    },
    Json {
        value: serde_json::Value,
        schema: Option<String>,
    },
    Asset {
        asset_id: AssetId,
        media_type: String,
        view: Option<AssetView>,
    },
    BlockRef {
        block_id: BlockId,
        relation: BlockRelation,
    },
}
```

</div>

`BlockRef` 代替原来的 `forward`：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "kind": "block_ref",
  "block_id": "0198...",
  "relation": "forward"
}
```

</div>

合法性规则：

- 只能引用已经提交的 Block；
- 不能引用自己；
- 引用目标创建序号必须更小；
- 因此 Block 引用图天然是 DAG；
- 跨 Dolly 实例引用禁止；
- Context 展开时有最大深度和总 token 预算。

## 4.4 方法信息单独放进 actions

不要把机器动作和展示内容混在同一个数组。

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">rust</span>

</div>

``` code-block
pub struct Action {
    pub action_id: ActionId,
    pub name: ActionName,
    pub arguments: serde_json::Value,
    pub target: Option<ModuleSelector>,
    pub correlation_id: Option<String>,
    pub idempotency_key: Option<String>,
}
```

</div>

示例：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "action_id": "act_...",
  "name": "memory.search",
  "arguments": {
    "query": [
      {
        "kind": "text",
        "text": "之前讨论过的调度算法"
      }
    ],
    "depth": "normal",
    "include_associations": true
  },
  "target": {
    "module_id": "conversation-memory"
  }
}
```

</div>

命名使用命名空间：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
memory.search
channel.send
alarm.create
runtime.config.propose
llm.effort.set_next
```

</div>

Runtime 不理解这些动作的业务含义，只负责传递和验证通用结构。

## 4.5 Runtime 提交后的 Block JSON

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "schema_version": "dolly.block/v1",
  "id": "0198ab31-6c44-7e8a-b2bb-...",
  "created_at": "2026-08-10T18:30:00.123Z",
  "logical_seq": 4812,
  "producer": {
    "instance_id": "main",
    "module_id": "main-brain"
  },
  "trace": {
    "trace_id": "0198...",
    "parent_block_id": "0198...",
    "hop_count": 4
  },
  "description": "请求查询过去关于调度算法的讨论",
  "parts": [
    {
      "kind": "text",
      "text": "我记得之前讨论过一种调度方式"
    }
  ],
  "actions": [
    {
      "action_id": "act_...",
      "name": "memory.search",
      "arguments": {
        "query": "调度算法"
      }
    }
  ],
  "metadata": {},
  "hints": {
    "tensity": 1.0
  }
}
```

</div>

`producer` 完全由 Runtime 填写。Module 不能伪造 `source`。需要表示引用来源时，应写在 namespaced metadata 中，例如：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
"metadata": {
  "org.dolly.channel": {
    "channel": "web",
    "session_id": "..."
  }
}
```

</div>

------------------------------------------------------------------------

# 五、Page、Delivery 和 Activation 的唯一语义

## 5.1 Page 是广播日志

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">rust</span>

</div>

``` code-block
pub struct PageState {
    pub id: PageId,
    pub next_sequence: u64,
    pub subscribers: HashMap<ModuleId, SubscriptionCursor>,
    pub retention: PageRetentionPolicy,
}
```

</div>

数据库中不直接记录“Module 的一份完整缓冲区”，而记录：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">rust</span>

</div>

``` code-block
pub struct DeliveryRecord {
    pub page_id: PageId,
    pub page_sequence: u64,
    pub block_id: BlockId,
}
```

</div>

每个订阅 Module 只维护自己的游标。

## 5.2 相同 Block 经多个 Page 到达

Block 本身不增加 `count`。重复属于投递关系，而不是内容身份。

Module 收到：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "block_id": "0198...",
  "occurrences": [
    {
      "page_id": "conversation",
      "page_sequence": 31
    },
    {
      "page_id": "review",
      "page_sequence": 18
    }
  ],
  "occurrence_count": 2
}
```

</div>

这样既只传输一份 Block 内容，又准确保留“它通过两条路径到达了两次”。

## 5.3 Activation 使用租约

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">rust</span>

</div>

``` code-block
pub struct ActivationRequest {
    pub activation_id: ActivationId,
    pub module_id: ModuleId,
    pub reason: ActivationReason,
    pub inputs: Vec<ActivationItem>,
    pub neighbor_descriptors: Vec<NeighborDescriptor>,
    pub config_revision: u64,
    pub deadline: Option<OffsetDateTime>,
}
```

</div>

状态过程：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
Pending
  ↓
Leased
  ↓
Running
  ├─ success → Commit cursor + optional output Block
  ├─ retryable failure → Lease expires → Retry
  ├─ permanent failure → Dead-letter / quarantine
  └─ cancelled → 根据副作用状态决定是否重试
```

</div>

同一 Module 永远只有一个 `Running Activation`。

不同 Module 可以在 Tokio task 中并发。Tokio 官方文档也强调异步并发必须有界，因此需要全局和每类资源的 semaphore，而不是无限 `spawn`。<sup>\[<a href="https://docs.rs/tokio" class="cite-num" target="_blank" rel="noopener" title="https://docs.rs/tokio">Docs.rs</a>\]</sup>

## 5.4 Module 的后台任务

Module 可以“在后台偷偷工作”，但 v1 规定：

- 后台任务可以做 IO、索引、下载、预计算；
- 后台任务不能直接写 Page；
- 后台任务完成后调用：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
host.module.request_activation(module_id, reason)
```

</div>

- 定时需求调用：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
host.module.request_wakeup(module_id, not_before, desired_by)
```

</div>

- 最终仍由下一次 Activation 返回至多一个 Block。

这样可以同时满足：

- Memory 后台向量化；
- Channel 后台收到 WebSocket 消息；
- Alarm 到时触发；
- Module 输出仍有统一日志、事务和调度语义。

进度流、LLM token streaming 可以作为 `progress notification` 发送给 UI，但它不属于 Page 的正式语义，最终 Block 才会持久化。

------------------------------------------------------------------------

# 六、循环、自己收到自己消息和失控保护

Dolly 允许有环，不能简单禁止 Module 收到自身产生的内容。

每个 Block 携带：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
trace_id
parent_block_id
hop_count
producer_module_id
```

</div>

Runtime 提供以下保护：

- `max_hops_per_trace`
- `max_blocks_per_trace`
- `max_bytes_per_trace`
- `max_activation_rate`
- 同一 `activation_id` 的输出去重
- 同一 Block 在同一订阅中的重复 Delivery 合并
- 超限 trace 进入 quarantine，而不是静默丢弃

Module 可配置：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
"self_delivery": "deliver"
```

</div>

或：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
"self_delivery": "suppress_exact_block"
```

</div>

Memory 默认忽略：

- 自己生产的 Block；
- 自己注入的查询结果；
- 已经索引过的 Block ID。

LLM 默认忽略自己产生后又经环返回的**同一个 Block ID**，但不会自动忽略其他 Module 对其输出作出的新回应。

------------------------------------------------------------------------

# 七、Premise 应升级为结构化 Module Descriptor

单纯动态字符串可以保留，但不能作为唯一事实来源。

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">rust</span>

</div>

``` code-block
pub struct ModuleDescriptor {
    pub revision: u64,
    pub accepts: Vec<ActionContract>,
    pub emits: Vec<ActionContract>,
    pub accepted_parts: Vec<PartKind>,
    pub emitted_parts: Vec<PartKind>,
    pub input_prompt: Option<String>,
    pub output_prompt: Option<String>,
    pub trust: DescriptorTrust,
}
```

</div>

例如 Memory：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "revision": 7,
  "accepts": [
    {
      "name": "memory.search",
      "description": "Searches stored memories and procedural notes",
      "arguments_schema": {
        "type": "object",
        "required": ["query"]
      }
    }
  ],
  "emits": [
    {
      "name": "memory.matches",
      "description": "Returns grounded historical memories with provenance"
    }
  ],
  "input_prompt": "You may explicitly ask this module to search memory.",
  "output_prompt": "Its output may include recalled evidence and associations."
}
```

</div>

Runtime 不应在每次调用时逐个请求邻居 Premise，而应：

1.  Module 创建时注册 Descriptor。
2.  Runtime 缓存。
3.  Module 更新时发送 `descriptor.changed`。
4.  Activation 携带相邻 Module 的 Descriptor 快照和 revision。
5.  LLM Extension 再把结构化内容编译成模型提示词。

还需要信任等级：

- 第一方、签名 Extension 可以进入 system-level premise；
- 未信任 Extension 的描述只能作为外部信息，不能直接进入高权限 system prompt。

------------------------------------------------------------------------

# 八、Extension 运行模型和通信协议

## 8.1 v1 只采用进程 Extension

每个 Extension 是一个目录：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
extensions/
  org.dolly.memory/
    extension.json
    bin/
      dolly-ext-memory
    schemas/
    migrations/
    README.md
```

</div>

`extension.json`：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "manifest_version": "dolly.extension/v1",
  "id": "org.dolly.memory",
  "version": "0.1.0",
  "protocol_versions": ["dolly.extension-rpc/v1"],
  "executable": {
    "linux-x86_64": "bin/dolly-ext-memory",
    "windows-x86_64": "bin/dolly-ext-memory.exe"
  },
  "module_types": [
    {
      "id": "memory",
      "config_schema": "schemas/memory.schema.json",
      "state_schema_version": 1
    }
  ],
  "capabilities": [
    "host.blocks.read",
    "host.assets.read",
    "host.models.embedding",
    "host.models.rerank"
  ],
  "isolation": "per-extension"
}
```

</div>

默认一个 Extension 进程承载该 Dolly 实例中的多个同类 Module。高风险 Extension 可配置 `per-module` 隔离。

## 8.2 JSON-RPC 传输

语义消息全部使用 JSON-RPC 2.0 风格的请求、响应和 notification。

底层不是 NDJSON，而是：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
4-byte big-endian frame length
UTF-8 JSON bytes
```

</div>

原因是：

- 不受换行影响；
- 可以明确限制 frame size；
- 可以安全跳过未知消息；
- 适合 stdin/stdout；
- Linux 和 Windows 行为一致。

示例：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "jsonrpc": "2.0",
  "id": "rpc_0198...",
  "method": "module.activate",
  "params": {
    "activation_id": "0198...",
    "module_id": "main-brain",
    "inputs": [],
    "descriptor_revision": 17,
    "config_revision": 42
  }
}
```

</div>

Extension 生命周期 RPC：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
extension.initialize
module.instantiate
module.activate
module.prepare_config
module.commit_config
module.abort_config
module.snapshot
module.restore
module.health
module.shutdown
extension.shutdown
```

</div>

反向 Host RPC：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
host.block.get
host.block.pin
host.block.unpin
host.asset.import
host.asset.get
host.asset.materialize_view
host.model.invoke
host.module.request_activation
host.module.request_wakeup
host.log.emit
host.metrics.record
```

</div>

不允许 Extension 直接访问其他 Extension 的进程或内存。

## 8.3 初始化和版本协商

Extension 启动后必须先发送：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "method": "extension.initialize",
  "params": {
    "extension_id": "org.dolly.llm",
    "extension_version": "0.1.0",
    "supported_protocol_versions": [
      "dolly.extension-rpc/v1"
    ],
    "module_types": ["chat"]
  }
}
```

</div>

Host 选择协议版本并返回：

- 实例目录；
- Extension 公共目录；
- Module 私有目录映射；
- 能力 token；
- frame 限制；
- Host 服务列表；
- 日志配置。

秘密值不直接放入环境变量传给普通 Extension。需要模型调用时，由 Model Gateway 使用密钥完成请求。

------------------------------------------------------------------------

# 九、Asset 和多模态系统

## 9.1 Draft 可接受多种来源，提交后只保留 AssetId

Module Draft 可以表示：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "kind": "asset_input",
  "media_type": "image/png",
  "source": {
    "kind": "existing_asset",
    "asset_id": "ast_b3_..."
  }
}
```

</div>

也可以是：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
inline_base64
remote_url
module_file
existing_asset
```

</div>

提交时 Runtime 完成：

1.  大小和 MIME 校验；
2.  URL 下载和 SSRF 检查；
3.  路径 canonicalize；
4.  哈希；
5.  本地缓存；
6.  可选 OSS 上传；
7.  转成正式 `AssetRef`。

正式 Block 中永远只出现：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "kind": "asset",
  "asset_id": "ast_b3_...",
  "media_type": "image/png"
}
```

</div>

大文件不应通过 JSON Base64 在进程间反复传递。JSON 仍负责描述，实际字节通过 Host Asset Service 的受控流式接口传输。

## 9.2 图片裁剪使用归一化坐标

统一坐标：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "kind": "image_rect",
  "x0": 0.10,
  "y0": 0.20,
  "x1": 0.80,
  "y1": 0.90
}
```

</div>

规则：

- 范围 `[0,1]`；
- 左上角为原点；
- 基于 EXIF 方向归一化后的原图；
- `x1 > x0`、`y1 > y0`；
- 裁剪只是 Asset View，不立即复制图片；
- 模型调用时按需 materialize。

不同模型的坐标规则不能写死在 Block 中。当前 Qwen 不同系列和调用方式已经存在归一化坐标与绝对像素坐标的差异，因此必须放进 `ModelProfile.coordinate_system` 和转换矩阵中。<sup>\[<a href="https://help.aliyun.com/zh/model-studio/vision" class="cite-num" target="_blank" rel="noopener" title="https://help.aliyun.com/zh/model-studio/vision">阿里云帮助中心</a>\]</sup>

## 9.3 生命周期

跨进程不能依赖 `Arc`，所以 Asset 生命周期由引用表管理：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
Page delivery refs
Block → Asset refs
Block → Block refs
Module pins
Temporary request leases
Persistent memory refs
```

</div>

只有全部引用归零且超过 grace period 后才能 GC。

OSS 是可选后端：

- 默认本地；
- 只删除 Dolly 自己上传到专用 prefix 的对象；
- 不删除原始外部 URL；
- 使用短期签名 URL；
- 上传失败不应阻断本地 Base64/本地流式调用路径。

------------------------------------------------------------------------

# 十、调度器设计

## 10.1 v1 使用事件驱动加合并窗口

每个 Module 配置：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "activation": {
    "min_interval_ms": 200,
    "max_latency_ms": 3000,
    "idle_interval_ms": null,
    "max_batch_blocks": 128,
    "max_batch_bytes": 1048576,
    "timeout_ms": 120000,
    "jitter_ratio": 0.05
  }
}
```

</div>

这些数字只是实例配置，不应写死为全局理论常数。

当第一个 Block 到达时：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
earliest_due = last_finish + min_interval
latest_due   = first_pending_time + max_latency
next_due     = max(now, earliest_due)，但不能晚于 latest_due
```

</div>

后续 Block 在这一窗口中合并。

若一次处理未取完全部待处理数据：

- 已提交的部分推进游标；
- 剩余部分立即重新排队；
- 仍遵守最小间隔；
- 不会一次把无限输入喂给 Module。

这修正了“每次读取全部数据”的 OOM 和超长请求风险。

## 10.2 Module 可以返回调度提示，但不能直接改周期

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "scheduling_hint": {
    "not_before": "2026-08-10T18:30:00Z",
    "desired_by": "2026-08-10T18:31:00Z",
    "load_signal": "underloaded"
  }
}
```

</div>

Runtime 会：

- 校验；
- 限幅；
- 与全局配额合并；
- 记录是否采纳。

Alarm 使用 `desired_by`，Memory 后台完成索引后使用 `request_activation`。

## 10.3 调度研究

实验算法至少比较：

1.  固定周期；
2.  事件驱动 debounce；
3.  backlog-aware；
4.  edge credit/token bucket；
5.  AIMD；
6.  PI/PID backlog controller。

合成拓扑：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
Chain
Fan-in
Fan-out
Diamond
Cycle
Two cycles sharing a node
Bursty input
Slow LLM
Fast producer + slow consumer
Mixed-cost modules
```

</div>

指标：

- p50/p95/p99 端到端延迟；
- backlog bytes；
- 激活次数；
- 空激活比例；
- 吞吐；
- starvation；
- 周期振荡幅度；
- API token 成本；
- 因背压拒绝或落盘的数据量。

只有在多拓扑、多负载下稳定胜过事件驱动基线，才允许启用自适应调度。

------------------------------------------------------------------------

# 十一、配置、热重载和自我修改

## 11.1 配置全部使用严格 JSON

建议文件：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
~/.config/dolly/daemon.json
instances/main/dolly.json
instances/main/runtime-state/
```

</div>

实例配置：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "api_version": "dolly.io/v1alpha1",
  "kind": "DollyInstance",
  "metadata": {
    "name": "main",
    "display_name": "Main Dolly"
  },
  "spec": {
    "pages": [
      {
        "id": "conversation",
        "storage": "durable"
      }
    ],
    "extensions": [
      {
        "alias": "llm",
        "package": "org.dolly.llm",
        "version": "0.1.0",
        "config": {}
      }
    ],
    "modules": [
      {
        "id": "main-brain",
        "extension": "llm",
        "type": "chat",
        "inputs": ["conversation"],
        "outputs": ["conversation"],
        "config": {
          "provider": "aether",
          "model": "deepseek-v4-pro",
          "retain_context": true
        }
      }
    ]
  }
}
```

</div>

密钥不出现在这里：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "id": "aether",
  "base_url": "...",
  "api_key": {
    "secret_ref": "providers.aether.api_key"
  }
}
```

</div>

## 11.2 热修改使用 JSON Patch

UI 和 CLI 提交：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "base_revision": 42,
  "patch": [
    {
      "op": "replace",
      "path": "/spec/modules/0/config/model",
      "value": "deepseek-v4-flash"
    }
  ]
}
```

</div>

JSON Patch 是标准化的 JSON 局部修改格式。<sup>\[<a href="https://datatracker.ietf.org/doc/html/rfc6902" class="cite-num" target="_blank" rel="noopener" title="https://datatracker.ietf.org/doc/html/rfc6902">IETF Datatracker</a>\]</sup>

## 11.3 热重载事务

每次配置更新必须经过：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
Parse
  ↓
JSON Schema validation
  ↓
Graph semantic validation
  ↓
Extension-specific validation
  ↓
Diff classification
  ↓
prepare_config
  ↓
Quiesce affected modules
  ↓
Snapshot
  ↓
Apply / Restart
  ↓
Health check
  ├─ success → Commit revision
  └─ failure → Rollback
```

</div>

变更分类：

| 修改              | 处理                              |
|-------------------|-----------------------------------|
| 温度、普通 prompt | 下次 Activation 生效              |
| Module 调度参数   | Runtime live update               |
| Page 连接关系     | 暂停受影响节点，原子更新图        |
| LLM 模型          | LLM Module prepare + context 适配 |
| 上下文窗口变小    | 先压缩；失败则拒绝或按策略 reset  |
| Extension 配置    | `prepare_config/apply_config`     |
| Extension 二进制  | 滚动重启进程并 restore            |
| 数据目录          | 禁止热改                          |
| daemon 监听地址   | daemon restart                    |

## 11.4 Dolly 修改自身配置

LLM 不能直接写 `dolly.json`。它只能调用：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
runtime.config.propose
```

</div>

提交：

- JSON Patch；
- 修改理由；
- 预期影响；
- 回滚条件。

Runtime 进行 dry-run，并根据权限决定：

- 自动应用低风险修改；
- 请求用户批准；
- 拒绝高风险修改。

所有修改都有审计日志和一键回滚。

------------------------------------------------------------------------

# 十二、Daemon、前台运行和管理界面

## 12.1 进程模型

`dollyd` 是每个用户一个的 Supervisor。

每个 Dolly 实例独立 Worker 进程：

- 一个实例崩溃不影响其他实例；
- 可独立重启；
- 可运行不同配置；
- 可单独收集日志；
- 前台模式与后台模式共用同一个 Worker 程序。

命令：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
dolly run --config ./dolly.json
dolly start main
dolly stop main
dolly restart main
dolly ps
dolly logs main
dolly graph validate main
dolly config apply main patch.json
dolly extension list
dolly doctor
dolly daemon status
```

</div>

`dolly run` 不依赖 daemon。

`dolly start` 通过 daemon 启动。

每个实例数据目录有 OS 文件锁。前台和后台同时启动相同实例时，后者会明确失败，而不是产生两个 Dolly 写同一个数据库。

## 12.2 Linux 和 Windows

Linux 优先：

- Unix Domain Socket；
- systemd user service；
- XDG 目录；
- 可选 bubblewrap 沙箱。

Windows：

- Named Pipe；
- Windows Service 或受控后台进程；
- Job Object 管理子进程；
- `%APPDATA%` / `%LOCALAPPDATA%`。

macOS 先保证编译和 CI，之后再完善 LaunchAgent 和沙箱。

## 12.3 管理前端

前端建议：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
TypeScript
React
Vite
React Flow
TanStack Query
pnpm
```

</div>

Rust 前端并不会降低整体复杂度，反而会让图编辑器、表单和前端生态更难处理。核心仍然是 Rust，前端使用 TypeScript 是合理的边界。

管理 UI 包含：

- 实例列表和健康状态；
- Page/Module 图编辑器；
- Module 配置表单；
- 配置 diff 和回滚；
- Extension 安装和版本；
- 实时日志；
- Activation trace；
- Page backlog；
- LLM token/费用；
- Memory 检索调试；
- Chat 页面。

Extension v1 不允许注册任意 JS 控件。它只能提供：

- JSON Schema；
- UI hints；
- 声明式命令；
- 状态和指标定义。

主界面根据 schema 生成表单。这样避免第三方 Extension 在管理员页面执行任意脚本。

## 12.4 认证

默认只绑定 `127.0.0.1`。

首次启动：

- 生成随机 bootstrap 密码；
- 存储 Argon2id 哈希；
- CLI 使用权限受限的本地 token 文件；
- Web 使用 HttpOnly session cookie；
- 有 CSRF 防护。

远程访问默认关闭。需要远程时，应通过 SSH tunnel、Tailscale 或配置 TLS 反向代理，而不是直接把管理端口暴露到公网。

------------------------------------------------------------------------

# 十三、推荐技术栈

## Rust Workspace

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
Rust 2024
Tokio
Axum + Tower
Serde / serde_json
Schemars + JSON Schema validator
SQLx + SQLite WAL
Clap
Tracing / tracing-subscriber
OpenTelemetry
Reqwest
Notify
UUID
BLAKE3
Image
FFmpeg / ffprobe subprocess
```

</div>

MCP 使用官方 Rust SDK。当前 MCP 规范和 SDK 已支持客户端、服务端、工具、资源以及本地/远程传输，因此没有必要自己重新发明一套 LLM 工具服务器协议。<sup>\[<a href="https://blog.modelcontextprotocol.io/posts/2026-07-28/?utm_source=chatgpt.com" class="cite-num" target="_blank" rel="noopener" title="The 2026-07-28 Specification">Model Context Protocol Blog</a>\]</sup>

## 存储

第一版：

- Runtime/Page/Block：SQLite；
- Memory metadata：独立 SQLite；
- 关键词检索：FTS5；
- Embedding：SQLite BLOB + 精确余弦检索；
- Assets：本地内容寻址目录；
- OSS：可选 backend。

Memory 研究阶段先用精确检索，避免 ANN 参数成为实验混淆因素。数据量增大后，再单独比较 Qdrant、嵌入式 ANN 等后端。

## 目录结构

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
dolly/
├── Cargo.toml
├── crates/
│   ├── dolly-types/
│   ├── dolly-protocol/
│   ├── dolly-core/
│   ├── dolly-runtime/
│   ├── dolly-scheduler/
│   ├── dolly-storage/
│   ├── dolly-assets/
│   ├── dolly-model-gateway/
│   ├── dolly-extension-sdk/
│   ├── dolly-extension-host/
│   ├── dolly-worker/
│   ├── dolly-daemon/
│   └── dolly-cli/
├── extensions/
│   ├── channel-web/
│   ├── llm/
│   ├── memory/
│   ├── skills/
│   ├── alarm/
│   └── workspace-tools-mcp/
├── web/
├── schemas/
├── docs/
│   ├── owner-notes/
│   ├── spec/
│   │   ├── core/
│   │   └── extensions/
│   ├── adr/
│   ├── research/
│   └── benchmarks/
├── tests/
│   ├── conformance/
│   ├── integration/
│   ├── simulation/
│   ├── fault-injection/
│   └── cross-platform/
└── fixtures/
```

</div>

两份原始 `.txt` 应原样放入 `docs/owner-notes/`，不再反复摘要覆盖。

------------------------------------------------------------------------

# 十四、Model Gateway

Model Gateway 是 Runtime 提供的公共服务，负责：

- Provider 注册；
- API Key；
- base URL；
- HTTP 连接池；
- 超时和重试；
- 限流；
- token/费用统计；
- Provider 错误分类；
- 模型能力表；
- 请求审计和脱敏。

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">rust</span>

</div>

``` code-block
pub struct ModelProfile {
    pub provider: ProviderId,
    pub model: String,
    pub context_window: Option<u32>,
    pub max_output_tokens: Option<u32>,
    pub input_modalities: BTreeSet<Modality>,
    pub output_modalities: BTreeSet<Modality>,
    pub tool_calling: CapabilityLevel,
    pub structured_output: StructuredOutputProfile,
    pub reasoning: ReasoningProfile,
    pub coordinate_system: Option<CoordinateSystem>,
    pub consecutive_role_policy: RolePolicy,
    pub tokenizer: TokenizerProfile,
}
```

</div>

信息优先级：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
Module 手工配置
    >
Provider 动态 discovery
    >
Dolly 内置版本化 registry
    >
安全保守默认值
```

</div>

不能只依赖 `/models`，因为很多 Provider 不返回上下文窗口或完整能力。

DeepSeek 当前官方 API 已明确提供 `deepseek-v4-flash`、`deepseek-v4-pro`、thinking 和 thinking-mode tool call；其 Chat Completions 是无状态接口，需要客户端管理历史。<sup>\[<a href="https://api-docs.deepseek.com/guides/thinking_mode/?utm_source=chatgpt.com" class="cite-num" target="_blank" rel="noopener" title="Thinking Mode">DeepSeek API 文档</a>\]</sup>

Qwen3.6-27B 官方资料给出了 262144 的上下文窗口，但结构化输出、思考模式和模型系列之间存在能力差异；Qwen 还提供 `preserve_thinking` 等额外参数。这正说明不能假定所有 OpenAI-compatible 模型具有相同语义。<sup>\[<a href="https://help.aliyun.com/en/model-studio/qwen3-6-27b" class="cite-num" target="_blank" rel="noopener" title="https://help.aliyun.com/en/model-studio/qwen3-6-27b">阿里云帮助中心</a>\]</sup>

百炼的 `qwen3-vl-embedding` 支持统一的文本/图像表征，`qwen3-vl-rerank` 支持多模态重排，但多模态重排需要 DashScope API，不支持 OpenAI 兼容接口。因此 Model Gateway 至少需要 OpenAI-compatible 和 DashScope-native 两类 Adapter。<sup>\[<a href="https://help.aliyun.com/zh/model-studio/qwen3-vl-rerank?utm_source=chatgpt.com" class="cite-num" target="_blank" rel="noopener" title="qwen3-vl-rerank 模型信息 - 阿里云帮助文档">阿里云帮助中心</a>\]</sup>

------------------------------------------------------------------------

# 十五、LLM Extension 规划

## 15.1 内部结构

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
LLM Module
├── Canonical Context Store
├── Context Compiler
├── Provider Adapter
├── Tool Loop
├── Structured Output Validator
├── Repair Pipeline
├── Retention Policy
└── Descriptor Compiler
```

</div>

## 15.2 上下文不能直接存 Provider messages

LLM Module 应维护提供商无关的 `ContextEntry`：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">rust</span>

</div>

``` code-block
pub struct ContextEntry {
    pub id: ContextEntryId,
    pub source_block_id: BlockId,
    pub role_class: RoleClass,
    pub parts: Vec<Part>,
    pub dependencies: Vec<ContextEntryId>,
    pub token_estimate: u32,
    pub retention: RetentionClass,
}
```

</div>

Provider Adapter 再将其编译为：

- OpenAI Chat messages；
- DeepSeek messages + reasoning/tool replay；
- Qwen messages；
- 视觉消息；
- ASR 请求。

这样修改模型不会把某家厂商的消息结构永久写进上下文。

## 15.3 Role 映射

- 该 LLM Module 自己产生的 Block：assistant。
- 其他 Module 产生的 Block：user/external。
- Tool call 与 tool result：原子 ToolTransaction。
- 自己产生后经 Page 环返回的同一 Block：忽略。
- BlockRef 展开后仍保留原 `source_block_id`。

连续多个 user 或 assistant 是否需要合并，由 Provider Adapter 处理。

## 15.4 Context 预算

上下文清理优先级：

1.  System、Module role、可信 Premise；
2.  当前 Activation 输入；
3.  未完成 ToolTransaction；
4.  显式 pinned 内容；
5.  最近和高相关内容；
6.  摘要；
7.  低价值旧内容。

工具调用组必须原子保留：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
assistant tool call
tool result 1
tool result 2
assistant continuation
```

</div>

不能只删除其中一项。

默认使用确定性打分。tensity 随机淘汰只作为实验策略。

遇到 context length error：

1.  根据实际错误更新模型 profile；
2.  缩小预算；
3.  重新编译上下文；
4.  有界重试；
5.  仍失败则返回诊断 Block，而不是终止 Module。

## 15.5 系统提示词构成

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
Dolly Runtime Contract
    +
Module Role Prompt
    +
Trusted Neighbor Descriptors
    +
Output Schema Instructions
    +
Tool Availability
    +
Current Context
```

</div>

“否认其他对话”不应写成无条件反驳。应改为：

> 主动提出问题、检查隐含前提、在证据不足时表达不确定，不因其他 Module 已经给出结论就停止独立审查。

## 15.6 结构化输出

按模型能力选择：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
JSON Schema structured output
    ↓ 不支持
emit_block virtual tool
    ↓ 不支持
strict JSON text
```

</div>

验证流程：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
严格 JSON parse
  ↓
Schema validation
  ↓
类型和引用校验
  ↓
可确定修复的纯语法修复
  ↓
可选低成本非思考模型修复
  ↓
仍失败 → no block + diagnostic
```

</div>

修复模型不能自由改写语义，只能依据原始输出和 schema error 修正格式。

## 15.7 MCP 和工具

MCP 客户端位于 LLM Extension 内部，不建立独立 MCP Extension。

推荐实现一个第一方 `workspace-tools-mcp`，至少提供：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
read_file(path, offset, limit)
stat(path)
write_file_atomic(path, content)
apply_patch(path, patch)
edit_file(...)
grep(pattern, path, limits)
glob(pattern, root)
bash(command, cwd, timeout, sandbox)
web_fetch(url, limits)
```

</div>

`read_file` 不能简单返回整文件，必须支持：

- 文件大小；
- 编码；
- 行范围或字节范围；
- 输出截断；
- 二进制检测；
- 大文件分页；
- 哈希。

Camoufox 浏览器通过 MCP 接入，测试截图、DOM/可访问性树、点击、表单、下载等。

## 15.8 Reasoning 内容

Provider reasoning 不应广播成 Block，也不应默认展示给其他 Module。它属于 Provider Transcript。

DeepSeek 和 Qwen 对 reasoning replay 的要求可能不同，必须由 Adapter 管理，而不是在通用上下文里假定一个统一字段。官方文档已经表明两者均存在专门的 thinking/tool 上下文规则。<sup>\[<a href="https://api-docs.deepseek.com/guides/thinking_mode/?utm_source=chatgpt.com" class="cite-num" target="_blank" rel="noopener" title="Thinking Mode">DeepSeek API 文档</a>\]</sup>

“控制思考强度”不能在一次已经开始的生成中改变。可以实现为：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
llm.effort.set_next
```

</div>

影响下一次 Activation，并受配置上限约束。

------------------------------------------------------------------------

# 十六、Channel Extension

原来的 Console 建议改名为 **Channel**。

第一方实现：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
org.dolly.channel-web
```

</div>

它负责：

- Web 聊天；
- CLI REPL；
- 外界输入；
- 多模态上传；
- Session 映射；
- 输出投递；
- 人工干预和测试。

入站 Block metadata：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "org.dolly.channel": {
    "channel": "web",
    "session_id": "sess_...",
    "message_id": "msg_...",
    "sender": "user"
  }
}
```

</div>

出站动作：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "name": "channel.send",
  "arguments": {
    "session_id": "sess_...",
    "parts": [
      {
        "kind": "text",
        "text": "..."
      }
    ],
    "reply_to": "msg_..."
  }
}
```

</div>

Channel 收到自己产生的普通入站 Block 时忽略；只消费明确指向自己的 `channel.send`。

管理 UI 和对话 UI 应使用不同权限域。开发阶段可以同端口不同 route，外网部署时必须允许单独关闭管理页面。

------------------------------------------------------------------------

# 十七、Skill Extension

Skill Extension 不调用 LLM，只做：

- 扫描目录；
- 验证 `SKILL.md`；
- 建立 catalog；
- 修改 Descriptor/Premise；
- 文件变化热更新；
- 报告错误和冲突。

Agent Skills 标准采用 `SKILL.md` 和逐步披露：启动时只加载名称与描述，真正匹配任务后再读取完整说明及其资源。因此 Dolly 只需把 catalog 放入 LLM 可见 premise，并让 LLM 通过 Read 工具加载 Skill。<sup>\[<a href="https://agentskills.io/specification" class="cite-num" target="_blank" rel="noopener" title="https://agentskills.io/specification">Agent Skills</a>\]</sup>

目录优先级：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
instance skills
    >
user skills
    >
bundled skills
```

</div>

同名时高优先级覆盖，但 UI 必须显示来源。

Skill Extension 不直接执行 `scripts/`。脚本执行仍通过 LLM 工具沙箱。

热更新：

- `notify` 文件事件；
- debounce；
- 定期完整重扫作为兜底；
- catalog revision 更新；
- Descriptor changed notification。

未信任或被禁用的 Skill 必须完全从 catalog 中隐藏，避免 LLM 反复尝试加载。

------------------------------------------------------------------------

# 十八、Alarm Extension

Alarm 很适合作为早期参考 Extension，因为它能验证：

- 后台状态；
- 持久化；
- wakeup API；
- 动态 Descriptor；
- 一次返回多个事件；
- 时区和重启恢复。

动作：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
alarm.create
alarm.list
alarm.update
alarm.delete
alarm.snooze
alarm.acknowledge
```

</div>

数据结构：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "alarm_id": "alm_...",
  "title": "提交作业",
  "schedule": {
    "kind": "once",
    "at": "2026-08-11T20:00:00+08:00",
    "timezone": "Asia/Shanghai"
  },
  "delivery": {
    "mode": "repeat_until_acknowledged",
    "repeat_interval_seconds": 300
  },
  "enabled": true
}
```

</div>

多个闹钟同时到期时，合并成一个输出 Block，其中每个闹钟保留独立 ID。

Alarm 不需要高频轮询，而是调用 `request_wakeup`。系统时钟发生跳变后重新计算所有 deadline。

------------------------------------------------------------------------

# 十九、Memory Extension：先做稳定基线，再做联想研究

## 19.1 分阶段能力

### M0：可靠存储

- Block 正规化；
- 文本抽取；
- provenance；
- 时间和 Page；
- 去重；
- embedding 模型版本；
- 后台任务队列；
- FTS5。

### M1：基础检索

- BM25/FTS；
- dense embedding；
- hybrid fusion；
- rerank；
- 时间过滤；
- 来源返回；
- 显式 `memory.search`。

### M2：自动注入

- 只在触发分数超过阈值时注入；
- 有 cooldown；
- 可以返回空；
- 有 token 预算；
- 防止自己匹配自己。

### M3：Consolidation

- 事件、事实、偏好、决策；
- 版本和有效期；
- 来源证据；
- 更新和冲突；
- 反幻觉验证。

### M4：Procedural Memory

- 方法；
- 适用条件；
- 操作步骤；
- 成功/失败证据；
- 不自动变成 Agent Skill。

### M5：关联图

- 时间共现；
- 多尺度窗口；
- 聚类；
- 关联扩展；
- 证据审计。

### M6：Reflection Policy

- 候选思维规则；
- 回归测试；
- 版本化；
- 晋升和回滚。

任何后续阶段失败都不能影响前面的基础检索。

## 19.2 不要持有一天的 Block 指针

Memory 收到 Block 后应立即：

1.  记录 Block ID；
2.  提取可持久化文本；
3.  写入 ingestion queue；
4.  需要媒体时申请短期 Asset lease；
5.  释放 Activation 输入。

“每日总结”通过数据库时间范围查询当天记录，不需要把所有 Block 的引用在内存里持有一天。

## 19.3 MemoryRecord

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">rust</span>

</div>

``` code-block
pub struct MemoryRecord {
    pub id: MemoryRecordId,
    pub page_id: PageId,
    pub source_block_ids: Vec<BlockId>,
    pub record_type: MemoryRecordType,
    pub text: String,
    pub event_time_start: Option<OffsetDateTime>,
    pub event_time_end: Option<OffsetDateTime>,
    pub ingestion_time: OffsetDateTime,
    pub valid_time: ValidTime,
    pub provenance: Provenance,
    pub status: MemoryStatus,
}
```

</div>

Embedding 必须绑定：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
provider
model
snapshot/version
dimension
preprocessing version
created_at
```

</div>

修改模型时异步回填。旧向量按版本保留，但必须受磁盘配额控制；至少保留当前版本和一个可回滚版本，其余可归档。

## 19.4 来源约束和防止总结编造

每条总结结果必须是：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "claim": "用户更偏好 Rust",
  "kind": "preference",
  "confidence": 0.92,
  "source_block_ids": ["..."],
  "valid_from": "...",
  "valid_until": null
}
```

</div>

验证步骤：

1.  每条 claim 必须有 source；
2.  检查 source 是否蕴含 claim；
3.  不确定时标记 `candidate`；
4.  与旧事实冲突时创建新版本，不覆盖旧值；
5.  注入时区分 current、historical、uncertain。

没有证据的内容不能进入稳定 Memory。

------------------------------------------------------------------------

# 二十、你所说的“语义不同但经常相邻”的关联应如何实现

你的想法不应实现成“搜到 A 后，把它附近的原始 Block 全返回”。那只会产生大量噪声。

应建立四层结构：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
原始 Block
    ↓
Memory Unit
    ↓
Concept / Entity / Episode / Procedure Nodes
    ↓
Association Edges
```

</div>

## 20.1 为什么不能只有一种聚类

你说的 A、B 可能分别是：

- 一个名字；
- 一个人；
- 一个对象；
- 一个概念；
- 一段方法；
- 一个证明；
- 一次完整事件；
- 一类抽象模式。

所以不能做一个把所有内容强行分成互斥类别的 flat clustering。

建议使用**多分辨率、可重叠节点**：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
Entity node
Concept node
Episode node
Procedure node
Topic community
```

</div>

同一 Memory Unit 可以属于多个节点。

例如：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
“用户在调试 Codex 时遇到 provider context 丢失”
    ∈ Codex
    ∈ API compatibility
    ∈ context persistence
    ∈ debugging episode 2026-08-08
```

</div>

## 20.2 “距离近”不应只选择一个分钟数

同时使用事件距离和时间距离：

<div class="math-block">

\\K(i,j)= \sum_k \alpha_k e^{-\|\Delta t\|/\tau_k} + \beta e^{-\|\Delta n\|/\nu}\\

</div>

其中：

- \\\Delta t\\：真实时间差；
- \\\Delta n\\：事件序列中的 Block/Memory Unit 距离；
- \\\tau_k\\：多个时间尺度；
- session 边界可以额外衰减。

因此不会被迫提前决定“近是几分钟、一天还是几天”，而是同时维护：

- 短距离关联；
- session 级关联；
- 跨日关联。

各尺度权重由验证集决定。

## 20.3 必须减去高频基线

如果 A 和 B 都非常常见，原始共现次数会很高，但不代表特殊关联。

第一版候选统计量可以比较：

- PMI / normalized PMI；
- lift；
- log-likelihood ratio；
- Bayesian smoothed lift；
- residual above familiarity baseline。

概念形式：

<div class="math-block">

\\Association(A,B) = \log \frac{Observed(A,B)+\epsilon} {Expected(A,B)+\epsilon}\\

</div>

其中 Expected 根据 A、B 各自出现频率计算。

每条关联边保存：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">json</span>

</div>

``` code-block
{
  "from": "concept:A",
  "to": "concept:B",
  "relation": "temporal_cooccurrence_association",
  "scale": "session",
  "strength": 0.73,
  "support": 12,
  "evidence_pairs": [
    ["memory-1", "memory-2"],
    ["memory-9", "memory-11"]
  ]
}
```

</div>

## 20.4 检索过程

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
用户查询
  ↓
BM25 + dense 取得 seed memories
  ↓
映射到 Concept/Episode nodes
  ↓
一跳关联扩展
  ↓
取关联节点背后的代表性 evidence
  ↓
统一 rerank
  ↓
多样性和 token budget
  ↓
返回带来源结果
```

</div>

关联扩展候选分数：

<div class="math-block">

\\score(c)= seed\\score \times edge\\strength \times evidence\\confidence \times freshness\\

</div>

默认只展开一跳。多跳很容易指数增长和漂移，只能作为实验。

## 20.5 与现有研究的关系

2026 年的一项 Predictive Associative Memory 工作正是在研究“通过时间共现而非语义相似性形成关联”，并用 temporal shuffle 控制验证信号确实来自时间顺序。但该工作主要在受控合成环境中验证，也明确指出跨 episode 的联想需要持久实体结构，尚不能直接作为生产实现。它适合成为 Dolly 联想实验的参考和 baseline，而不是直接照搬。<sup>\[<a href="https://arxiv.org/html/2602.11322v1" class="cite-num" target="_blank" rel="noopener" title="https://arxiv.org/html/2602.11322v1">arXiv</a>\]</sup>

## 20.6 专门为 Dolly 构建的关联测试集

必须增加一个自建 benchmark：

### 数据生成

构造语义上不相似但反复共现的 A/B：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
A：蓝色雨伞
B：某个特定调试命令
```

</div>

在多个 session 中让二者反复靠近出现。

同时加入：

- C：与 A 语义很相似，但从未与 A 共同出现；
- D：与 B 高频出现但只是全局高频词；
- 单次高强度事件；
- 错误关联；
- 时间顺序打乱版本；
- 跨 session 持久实体；
- 噪声 Block。

### 指标

- Association Recall@k；
- Association Precision@k；
- false expansion rate；
- temporal-shuffle degradation；
- evidence precision；
- downstream QA accuracy；
- token overhead；
- 不应召回时的 abstention。

只有关联机制在语义相似检索失败的样本上提升，同时不显著增加错误召回，才允许进入正式 Memory。

------------------------------------------------------------------------

# 二十一、抽象模式、轨迹和方法迁移研究

你提出的：

- 去掉名词/动词/形容词后 embedding；
- 把 embedding 序列看成轨迹；
- 类似 T2Vec；
- 正交变换后匹配；

都应视为候选研究因子，而不是架构设计。

建议比较四条路线：

1.  **词性遮蔽**
    - mask noun；
    - mask entity；
    - mask noun+adjective；
    - 保留动词和关系词。

<!-- -->

1.  **句法和语义角色模板**
    - dependency pattern；
    - subject-action-object；
    - agent/patient/instrument；
    - 条件—操作—结果。

<!-- -->

1.  **序列形状**
    - Dynamic Time Warping；
    - sequence encoder；
    - contrastive trajectory model；
    - 不同长度轨迹池化。

<!-- -->

1.  **LLM 抽象**
    - 抽取方法模板；
    - 抽取适用条件；
    - 与原始来源绑定；
    - 搜索抽象模板。

测试集不能只测“能找到相似句子”，而要测：

- 同一方法迁移到不同领域；
- 表面词汇完全不同；
- 错误类比；
- 缺少关键条件时拒绝迁移；
- 新任务上的 held-out transfer。

不应直接把地理轨迹模型 T2Vec 当成语义轨迹解决方案，两者的“不变性”假设并不相同。

------------------------------------------------------------------------

# 二十二、Memory 的长期思维模式

不建议维护一段自由增长字符串。建议结构化为多个 Policy：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">rust</span>

</div>

``` code-block
pub struct ReflectionPolicy {
    pub id: ReflectionId,
    pub rule: String,
    pub scope: Vec<String>,
    pub evidence: Vec<BlockId>,
    pub confidence: f32,
    pub status: ReflectionStatus,
    pub priority: i32,
    pub created_at: OffsetDateTime,
    pub expires_at: Option<OffsetDateTime>,
}
```

</div>

流程：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
Consolidation 发现反复失败模式
  ↓
生成 candidate reflection
  ↓
证据检查
  ↓
在历史任务上 shadow replay
  ↓
在 held-out 任务上回归
  ↓
通过 → active
  ↓
LLM Extension 编译进 premise
```

</div>

人称建议使用**行为规范式第二人称或无主语指令**：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
在判断两个 API 是否兼容前，先检查实际字段和错误响应。
```

</div>

不要用：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
我总是很擅长检查 API。
```

</div>

后者只是自我描述，约束性更弱，也更容易产生错误身份叙事。

------------------------------------------------------------------------

# 二十三、研究与 benchmark 体系

## 23.1 Memory benchmark

采用：

- LongMemEval：信息提取、多 session 推理、时间推理、知识更新和拒答；
- LoCoMo：长时间、多 session 对话、事件总结和多模态对话；
- MemoryAgentBench：检索、test-time learning、长程理解、选择性遗忘；
- MemOps：记住、更新、遗忘、反思等生命周期操作。<sup>\[<a href="https://arxiv.org/abs/2410.10813?utm_source=chatgpt.com" class="cite-num" target="_blank" rel="noopener" title="LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory">arXiv</a>\]</sup>

此外必须有 Dolly 自建测试：

- 任务中断和恢复；
- 重新遇到同一人；
- 事实被纠正；
- 对位置/对象逐渐形成印象；
- 隐式关联；
- 方法迁移；
- 跨模态记忆；
- 不相关时不注入；
- 自己输出不进入循环记忆。

## 23.2 工具与 Agent benchmark

- BFCL：单轮、多轮、并行和状态化函数调用；
- τ-bench：用户交互、工具、政策和最终数据库状态；
- GAIA：推理、Web、多模态和工具；
- BrowserGym/WebArena：浏览器任务；
- OSWorld：桌面多模态任务。<sup>\[<a href="https://gorilla.cs.berkeley.edu/leaderboard.html?utm_source=chatgpt.com" class="cite-num" target="_blank" rel="noopener" title="Berkeley Function Calling Leaderboard (BFCL) V4 - Gorilla">Gorilla</a>\]</sup>

Camoufox + MCP 应先在自建小测试上稳定，再接 BrowserGym/WebArena。

## 23.3 多专家拓扑实验

至少比较：

### A：直接单主脑

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
Channel → Main LLM
Memory ↔ Main LLM
Tools attached to Main LLM
```

</div>

### B：人工分工

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
Channel → Main LLM
Main LLM ↔ Tool Worker
Main LLM ↔ Memory Worker
Main LLM ↔ Reviewer
```

</div>

### C：隔离主脑

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
External input → Worker Layer → Main LLM
Tools only on workers
Memory only queried by workers
```

</div>

### D：自行分工

所有弱 LLM 获得相同基础 Descriptor，由系统观察它们是否形成稳定角色。

公平性要求：

- 相同主模型；
- 相同总 token 预算；
- 相同最大请求次数；
- 相同工具权限；
- 相同重试策略；
- 相同模型温度；
- 相同环境快照。

指标：

- task success；
- pass@1、pass^k；
- token/费用；
- wall time；
- 工具错误；
- 重复工作；
- Module 间通信量；
- 主脑上下文占用；
- 角色漂移；
- 是否错误依赖弱模型。

τ-bench 本身强调多次运行可靠性，因此不能只跑一次看“感觉”。<sup>\[<a href="https://arxiv.org/abs/2406.12045?utm_source=chatgpt.com" class="cite-num" target="_blank" rel="noopener" title="$τ$-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains">arXiv</a>\]</sup>

## 23.4 学习实验

不能只做：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
先跑一遍题 → 学习 → 再跑同一题
```

</div>

这无法区分记忆和测试集泄漏。

应分成：

1.  **同任务保持**
    - 测试是否记得历史反馈。

<!-- -->

1.  **同分布 held-out**
    - 学习一部分任务，测试未见实例。

<!-- -->

1.  **跨分布迁移**
    - 学习一种方法，应用到不同表面领域。

<!-- -->

1.  **负迁移**
    - 检查学到的规则是否错误套用。

<!-- -->

1.  **遗忘和更新**
    - 旧事实被新事实替代。

所有模型调用记录：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
model snapshot
provider
prompt hash
config revision
dataset version
random seed
temperature
tool trace
token usage
cost
retry count
```

</div>

采用 bootstrap confidence interval，不以一次运行决定结论。

------------------------------------------------------------------------

# 二十四、与 OpenClaw 和 Hermes 的对比方法

OpenClaw 当前采用一个长生命周期 Gateway，CLI、Web UI 和节点通过带 Schema 验证的 WebSocket API 接入；Hermes 强调持久记忆、FTS5 session search、Skill 和学习循环。它们分别可以作为 Dolly 的运维/Channel 基线和 Memory/Skill 基线。<sup>\[<a href="https://docs.openclaw.ai/concepts/architecture" class="cite-num" target="_blank" rel="noopener" title="https://docs.openclaw.ai/concepts/architecture">OpenClaw</a>\]</sup>

比较时必须：

- 固定具体 commit/tag；
- 使用相同模型；
- 使用相同机器；
- 使用相同浏览器和工具；
- 使用相同任务集；
- 限制相同预算；
- 分离框架错误和模型错误；
- 报告成功率、费用和稳定性。

Dolly 不应在第一阶段追逐 OpenClaw 的所有聊天平台。Dolly 真正需要验证的独特价值是：

> Page/Module 认知网络是否在相同模型和预算下，比普通单 Agent loop 更可靠、更能长期学习、更能处理任务切换。

------------------------------------------------------------------------

# 二十五、日志、可观测性和调试

使用 `tracing` 结构化日志。

每个事件带：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
instance_id
module_id
activation_id
trace_id
block_id
config_revision
extension_version
model
provider_request_id
```

</div>

日志级别：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
error
warn
info
debug
trace
payload
```

</div>

`payload` 才记录完整通信，并且：

- 默认关闭；
- 自动脱敏 API Key、Authorization、Cookie；
- 可限制长度；
- 可设置保留期；
- 明确警告隐私风险。

指标：

- Module activation duration；
- Page backlog；
- retry；
- crash loop；
- blocks/sec；
- bytes/sec；
- LLM input/output/reasoning token；
- Provider latency；

-费用；

- Memory retrieval hit；
- false-memory evaluator；
- Asset storage；
- GC。

还应有一个持久 Event Journal，用于：

- 重放；
- 调度实验；
- bug 复现；
- Testament 未来的输入 replay。

------------------------------------------------------------------------

# 二十六、测试体系

## 单元测试

- Block schema；
- 引用合法性；
- Asset crop；
- 配置 diff；
- Provider message compiler；
- Memory scoring；
- schedule calculation。

## Property/Fuzz

- 任意有环图；
- 任意 Block 引用输入；
- 畸形 JSON；
- 超大整数；
- Unicode；
- 路径穿越；
- frame 分片；
- Extension 随机断开；
- 配置 Patch 序列。

## 并发测试

- 同 Module 不并发；
- 多 Module 并发；
- Activation commit 原子性；
- 重启恢复；
- cursor 不后退；
- 不重复提交输出；
- GC 不删除仍被引用资源。

## 故障注入

- Extension 在处理一半时退出；
- Provider 429/500；
- 网络中断；
- SQLite busy；
- 磁盘空间不足；
- Asset 下载超时；
- OSS 上传失败；
- 模型返回非法 JSON；
- context length error；
- MCP server crash；
- daemon crash 后 worker 孤儿进程。

## 虚拟时钟

调度、Alarm、每日总结、记忆衰减测试全部使用可注入 Clock。

测试时可以把“一天”映射成有限事件跨度，但必须保持相同事件密度和数据量比例，而不是简单把 24 小时改成 10 秒后用极少数据。

------------------------------------------------------------------------

# 二十七、分阶段实施 Plan

## Phase 0：规格仓库和不可变语义

产物：

- 原始 owner notes；
- terminology；
- goals/non-goals；
- Block JSON Schema；
- Extension RPC；
- config schema；
- ADR；
- research registry。

退出条件：

- Page、Block、Delivery、Activation、Module、Extension、Premise 的语义无歧义；
- 不依赖任何具体 Extension 也能解释 Runtime；
- 所有实验字段明确标记 experimental。

## Phase 1：协议和模拟器

实现：

- `dolly-types`
- `dolly-protocol`
- JSON Schema
- Extension mock
- virtual clock
- graph simulator
- trace recorder

退出条件：

- 能在内存中模拟 chain、fan-out、cycle；
- 相同输入和时钟产生相同事件序列；
- schema round-trip 和 fuzz 通过。

## Phase 2：Runtime 核心

实现：

- Page log；
- subscriber cursor；
- Activation lease；
- Scheduler baseline；
- SQLite journal；
- Block commit；
- crash recovery；
- GC 基础。

退出条件：

- 进程被杀后无已确认输入丢失；
- 同一 Module 不重入；
- 输出提交和 cursor 前进原子；
- 环路受限；
- backlog 可观测。

## Phase 3：Extension Host 和 SDK

实现：

- 进程管理；
- framed JSON-RPC；
- handshake；
- Module lifecycle；
- host services；
- snapshot/restore；
- crash loop quarantine；
- protocol conformance suite。

退出条件：

- Extension 随机崩溃后可恢复；
- 畸形消息不会拖垮 Runtime；
- Extension 版本不兼容时给出清晰错误；
- 热替换参考 Extension 成功。

## Phase 4：Daemon、CLI 和配置事务

实现：

- `dollyd`
- worker process；
- multi-instance；
- instance lock；
- CLI；
- JSON Patch；
- prepare/commit/rollback；
- auth；
- 最小管理 API。

退出条件：

- 前台后台不冲突；
- 可管理多个实例；
- 失败配置自动回滚；
- Windows/Linux 基本工作。

## Phase 5：Asset、Secret 和 Model Gateway

实现：

- Asset import；
- crop/view；
- lifecycle；
- 本地和 OSS backend；
- Provider registry；
- Aether；
- DashScope；
- retry/rate-limit/cost；
- model profile。

退出条件：

- Base64/URL/本地文件/OSS 路径测试；
- SSRF 和路径穿越测试；
- DeepSeek/Qwen/Embedding/Rerank 基本 conformance；
- 密钥不出现在日志和 Extension 环境中。

## Phase 6：参考 Extensions

顺序：

1.  Alarm；
2.  Channel Web/CLI；
3.  Skills。

退出条件：

- 外界消息能形成 Block；
- Dolly 输出能回到会话；
- 多模态上传；
- Alarm 重启恢复；
- Skill 目录热更新；
- Descriptor 更新传播。

## Phase 7：LLM Extension

实现：

- canonical context；
- provider adapters；
- structured output；
- repair；
- context budget；
- MCP；
- workspace tools；
- multimodal；
- reasoning replay；
- streaming progress。

退出条件：

- DeepSeek v4 flash/pro；
- Qwen3.6-27B；
- 两个 LLM Module 经 Page 交流；
- 图片裁剪和视觉任务；
- 工具多轮调用；
- Provider 错误不导致 Module 永久停止；
- context shrink 热配置通过。

## Phase 8：Memory 稳定基线

只实现：

- ingestion；
- FTS；
- dense；
- hybrid；
- rerank；
- provenance；
- explicit query；
- conservative auto injection；
- grounded consolidation。

退出条件：

- LongMemEval/LoCoMo 基线；
- 自己输出不重复索引；
- 更新事实正确；
- 无来源 summary 不进入稳定记忆；
- 资源无泄漏；
- 可以返回空。

## Phase 9：研究阶段

分别开独立实验分支：

- adaptive scheduler；
- association graph；
- clustering；
- tensity；
- reflection policy；
- procedural memory；
- direct vs isolated topology；
- self-division。

每项必须有：

<div class="code-wrapper">

<div class="code-header">

<span class="code-lang">text</span>

</div>

``` code-block
hypothesis.md
baseline
dataset
ablation matrix
metrics
raw runs
analysis notebook/script
decision ADR
```

</div>

只有通过 gate 的部分进入正式代码。

## Phase 10：竞品对比、UI 完善和发布

- OpenClaw/Hermes 对比；
- BrowserGym/GAIA/τ-bench；
- 管理图编辑器；
- 安装包；
- systemd/Windows service；
- backup/restore；
- extension developer guide；
- README；
- 示例配置；
- 安全说明；
- logo 和项目主页。

------------------------------------------------------------------------

# 二十八、第一版明确不做的事情

第一版不应实现：

- Rust `cdylib` 热卸载；
- Network/LevelUpper；
- Testament；
- 任意 Extension 注入前端 JavaScript；
- tensity 驱动 Block/Asset GC；
- 无证据的每日人格重写；
- 无上限 Page 内存；
- 一次 Activation 强制读取任意多输入；
- 共现自动标注因果；
- Memory 自动生成 Agent Skill 并立即启用；
- LLM 直接写配置文件；
- 没有沙箱的 Bash；
- 所有媒体永久删除且不可追溯；
- 只跑一次模型就下实验结论。

------------------------------------------------------------------------

# 二十九、Dolly v1 的完成标准

Dolly v1 完成时，应满足：

1.  Linux 和 Windows 可运行。
2.  前台、后台、多实例正常。
3.  Core 和 Extensions 完全分离。
4.  Extension 可崩溃、重启、热替换。
5.  配置可事务热更新和回滚。
6.  Page 有持久游标和背压。
7.  Block、Asset、引用生命周期正确。
8.  Web/CLI Channel 可输入文本和多模态。
9.  两个 LLM Module 可沟通和使用工具。
10. DeepSeek v4 与 Qwen3.6 有正式 Adapter。
11. MCP 和文件工具不是玩具实现。
12. Skill 可热更新。
13. Memory 有可靠基础检索、来源和更新语义。
14. Alarm 正常。
15. 日志、trace、metrics、回放完整。
16. Memory、调度、tensity 和拓扑实验可复现。
17. 所有进入生产路径的研究功能都有消融结果和 ADR。
18. README、核心 spec、Extension 开发规范和 benchmark 报告齐全。

这套规划保留了你真正想要的“内生宏观多专家、广播式认知空间、长期联想与能力增强”，但把数据正确性、插件边界、热重载、模型兼容、跨平台和科研验证放到了它们应在的位置：**稳定内核负责绝不乱，实验层负责探索是否真的有效。**
