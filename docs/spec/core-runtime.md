# Dolly Core Runtime Contract

Status: Draft

## 1. Purpose and authority

This document defines the proposed normative contract for Dolly's core runtime:
Block records, Page delivery, ownership and retention, Module execution,
lifecycle, scheduling, shutdown, recovery, and the observable invariants that
connect those concerns.

This is a Draft. Request for Comments (RFC) 2119 terms such as MUST, MUST NOT,
SHOULD, and MAY express the intended contract precisely, but an implementation
MUST NOT claim conformance until this document is accepted.

The contract is grounded in the owner's original model:

- Pages are broadcast spaces connecting sets of producing and consuming
  Modules.
- A Module consumes all newly available inputs as one logical batch and produces
  either no Block or exactly one Block.
- Different Modules may execute concurrently, but one Module must
  never execute two actions concurrently.
- Data arriving while a Module is executing remains available for a later
  action.
- Scheduling should eventually use measured downstream capacity, but an
  unvalidated adaptive algorithm must not become a product invariant.
- Blocks and Media require real shared ownership semantics rather
  than unrelated, manually balanced counters.

Where legacy specifications, handover notes, tests, or code disagree with this
document, they are evidence only. The authority order in `docs/spec/README.md`
applies.

## 2. Scope

This contract covers:

- immutable Block identity and structure;
- Block references and Media references;
- Page delivery logs and per-consumer delivery state;
- claim, acknowledgement, retry, and dead-letter behavior;
- persistent strong references and scoped access leases used for retention;
- the per-Module actor and run fencing model;
- revisioned descriptions published by adjacent Modules;
- activation modes and the definition of a period;
- mailbox bounds and backpressure;
- scheduler policy boundaries;
- lifecycle, shutdown, crash recovery, and stale-result handling;
- required metrics, events, and conformance tests.

## 3. Non-goals

This document deliberately does not define:

- media bytes, local files, Alibaba Cloud Object Storage Service (OSS) objects,
  signed web addresses, or crop processing; those belong in `media.md`;
- extension packaging, process permissions, capability grants, and protocol version
  negotiation; those belong in `extension-process-protocol.md`;
- large language model (LLM) provider behavior, prompts, conversation state, or
  tool calling;
- memory ranking, tensity formulas, forgetting, or cognitive hypotheses;
- a production additive increase/multiplicative decrease (AIMD) formula or
  default tuning constants;
- distributed exactly-once delivery across independent Dolly instances;
- a global order shared by different Dolly runtime instances.

The core runtime provides the correctness envelope within which those systems
operate. It does not infer their domain semantics.

## 4. Terminology

- **Block**: One immutable JavaScript Object Notation (JSON) information record
  committed by the runtime.
  `BlockProposal` is the Module value before the runtime assigns identity and
  provenance; it is a different stage, not a second kind of stored Block.
- **Page**: A named broadcast connection in Dolly's Module graph. Producers
  append Block identifiers (IDs), and each consumer observes its own ordered
  Deliveries from the resulting append-only log. The owner-defined term is
  retained because a Page names both the graph connection and its delivery
  history; a storage log alone does not describe that configuration role.
- **Delivery**: One occurrence of one Block ID in one Page.
- **Module**: One configured runtime component that consumes Pages and may
  produce a Block. Its stable identifier is `moduleId`, which is also the
  authenticated `source` of its accepted Blocks.
- **Module actor**: The serialized runtime controller for one Module; it never
  runs two actions at once.
- **Module generation**: One initialized incarnation of a Module, identified by
  `moduleGenerationId`. A result from another generation is stale.
- **Process generation**: One attempt to start a child process for a Module
  generation, identified by `processGenerationId`. It is a separate identifier
  from `moduleGenerationId` because one Module generation can be started, fail,
  and be started again, and because the operating system may reuse a process
  identifier while this one is never reused. On Linux the Module control group
  (cgroup) path embeds it; a control group is the kernel process hierarchy that
  bounds a Module's processes and resource limits.
- **Module job**: A persistent logical work unit assigned to one Module. It
  binds one immutable input snapshot and eventually produces a terminal result
  or terminal failure. A retry creates a new Run but retains the same
  `moduleJobId`; the Module qualifier is required because Dolly also has other
  persistent maintenance and provider jobs.
- **Run**: One execution attempt of a Module job, identified by a fresh `runId`
  and attempt number.
- **Consumer**: One Module subscribed to a Page.
- **Delivery batch**: The fixed ordered set of Delivery inputs bound to one
  reactive Module job. It is the job's immutable input snapshot, not a global
  execution or commit identity.
- **Claim**: One Run's temporary ownership of a Delivery batch. Its identity
  fields prevent a stale Run from acknowledging work owned by a newer Run.
- **Fencing**: The standard concurrency-control action of rejecting an
  operation whose identity no longer matches the current owner. In Dolly this
  means checking the Claim, Run, and Module generation fields before accepting
  output, acknowledgement, or retry; it does not name another stored object.
- **Positive acknowledgement** (`ack`): The runtime has accepted the result of
  a Claim and advanced the consumer state.
- **Negative acknowledgement** (`nack`): The runtime records a proved failed
  execution and keeps the same Deliveries eligible for retry or records a
  terminal failure according to policy. A submitted Run with an unknown outcome
  is not eligible for a negative acknowledgement.
- **Strong reference**: A persistent record-to-target reference that keeps the
  target and all of its transitive dependencies reachable until that record
  removes it. "Strong reference" is the standard garbage-collection and
  ownership term for this behavior. The wire type is `StrongReference`.
- **Access lease**: A temporary strong reference with its own identity, scope,
  and optional expiry time. It keeps asynchronous work safe without creating a
  persistent record-to-target reference. The wire type is `AccessLease`.
- **Reference graph**: The resource nodes, immutable dependency edges, strong
  references, and access leases from which Core computes reachability. Its
  persisted schema is `dolly.reference-graph/4`.
- **Module result commit**: The recoverable operation and journal record that
  together commit one Module result and its effects. It records commit recovery state;
  it is not the lifecycle state or identity of the Module job.
- **Module process record**: The durable Core-state record for one attempt to
  start one existing Module generation. It links that generation to the verified
  Core service, package/configuration revisions, and Linux Module cgroup because
  a later Core process has lost its in-memory child handle.
- **Module submission record**: The durable Core-state record that an existing
  Run may have crossed the Extension protocol boundary. It links the exact Claim,
  process generation, and canonical input digest; it does not create another Run
  or result store.
- **Core-state update**: One atomically durable replacement of the complete Core
  state that contains Claims, Module process records, and Module submission
  records. The qualified term is necessary because the separate Module result
  commit journal has a different recovery purpose and cannot prove that a Claim
  and a submission record were written together.
- **Unknown outcome**: The state of one exact active Claim when Core cannot use
  durable result and external-effect evidence to decide whether its submitted
  Run took effect. It is not a retryable failure classification and leaves the
  Claim active for audited operator action.
- **No-effect evidence**: A durable record, or a queryable provider result, that
  proves an intended external operation did not cross its effect boundary.
  **Retry-safe evidence** proves that repeating the exact operation cannot add a
  second effect, normally through a stable idempotency key and a queryable
  outcome. **Terminal outcome** means a durably recorded completed, permanently
  rejected, or explicitly operator-resolved result for that exact operation.
  A terminal outcome proves what happened; it does not prove that repeating
  the operation is safe. Without a separate durable idempotency contract, it
  does not permit automatic negative acknowledgement, release, or retry.
- **Mailbox**: Pending triggers and Deliveries that may start a Module actor.
- **Module description**: Bounded text a Module publishes to describe the input
  it accepts or the output it may produce. The runtime stores each revision as
  a `ModuleDescription`; this descriptive data is not authorization.
- **Scheduler policy**: A replaceable rule that chooses when eligible work may
  run. It does not own data or decide whether a result is valid.

## 5. JSON and identifier rules

All persisted and cross-boundary records MUST have a canonical JSON
representation. The initial wire format uses the RFC 8785 JSON Canonicalization
Scheme after closed-schema validation. When a contract requires a digest, it is
the 256-bit Secure Hash Algorithm (SHA-256) over those canonical 8-bit Unicode
Transformation Format (UTF-8) bytes and is encoded as
`sha256:<lowercase-hex>`.

`JsonValue` means null, boolean, finite number, string, an array of JsonValue,
or an object with string keys and JsonValue values. The following are invalid:

- `NaN`, positive or negative infinity, and negative zero when canonicalization
  would distinguish it;
- functions, symbols, bigint values, class instances, and cyclic objects;
- platform-native buffers or file handles embedded in JSON;
- object keys that violate the canonical JSON rules.

Identifiers MUST be opaque non-empty strings. The runtime MUST validate their
syntax and MUST NOT interpret an identifier as a filesystem path.

Sequences are unsigned integers maintained internally at sufficient precision.
Their canonical JSON form MUST be a base-10 string so values above JavaScript's
safe integer range remain exact.

### 5.1 Instance configuration

The closed instance configuration schema is `dolly.instance/9`. The runtime
MUST reject `dolly.instance/8` and every earlier document; field names removed
from those versions are not aliases and require an explicit migration.
Version 8 removed `core.abandonedClaimPolicy`: after a restart, an active Claim
is not known to be abandoned unless durable records of process state and Module
result submission prove that its former executor cannot still run. Until those
records exist, startup stops instead of selecting retry or dead-letter behavior
from configuration.

Version 9 replaces `core.limits.maxAttempts` with
`core.limits.maxFailedAttempts`. This value limits failed attempts for one
Module job. Core records a failed attempt when it accepts a valid negative
acknowledgement. When `failedAttemptCount` reaches the configured value, the
Module job enters dead letter. Releasing a Claim during an orderly shutdown
does not record a failed attempt and therefore does not consume this limit.
The removed field is not an alias.

Media configuration has exactly one of these shapes:

```typescript
type MediaConfiguration =
  | { enabled: false }
  | {
      enabled: true;
      maxMediaBytes: number;
      maxTotalMediaBytes: number;
      maxRegistrationRecords: number;
      maxStorageRecords: number;
      maxProviderAccessRecords: number;
      deletedRegistrationRetentionMs: number;
      ingress: {
        maxActiveCapabilities: number;
        maxConcurrentOperations: number;
        maxCapabilityLifetimeMs: number;
      };
    };
```

`enabled` states whether the instance creates its persistent local Media store.
The remaining fields are required only when Media is enabled. `maxMediaBytes`
limits one registered Media item; `maxTotalMediaBytes` limits bytes across all
non-deleted registrations, including `pending` and `deleting` registrations.
The record-count limits bound registration records, storage records, and
`ProviderAccessRecord` values. `deletedRegistrationRetentionMs` is the compact
deleted-registration retention interval in milliseconds. The `ingress` limits
bound active capability authorizations, concurrent authorized input/output
(I/O) operations, and capability lifetime. Remote object storage remains a
separate optional adapter and is not implied by this setting.

The `core.scheduler` object configures how often the runtime checks for pending
work and how long it waits before retrying failed work:

```typescript
interface SchedulerConfiguration {
  pollIntervalMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
}
```

`pollIntervalMs` is the interval between checks for pending input when no run
is active. `retryBaseMs` is the first delay after a retryable failure, and
`retryMaxMs` is the upper bound for bounded exponential retry delays. All three
values are positive, finite milliseconds; `retryMaxMs` MUST be greater than or
equal to `retryBaseMs`. These intervals affect scheduling only and MUST NOT
weaken Module serialization, execution timeouts, or durable delivery recovery.

Version 9 does not persist the remaining Scheduler correctness settings:
instance-wide actor concurrency, downstream backpressure behavior and recheck
interval, sustained-no-progress interval, baseline claim batch, retry jitter,
low-watermark ratio, or per-consumer mailbox count and byte bounds. Code that
constructs the product-before-startup reactive vertical slice must therefore
receive those values through an explicit trusted input and must not invent
defaults. They become product configuration only in a later closed instance
schema that also resolves the Linux process and external-effect fields in
Section 5.2. A test-only or candidate composition is not a migration of a
version 9 document.

`core.limits.maxModuleResultCommitJournalBytes` bounds the canonical bytes in
the Module result commit repository. The name identifies the data whose journal
is bounded; it is not a general Module job or Delivery-store size limit. The
version 4 field `maxProcessingJournalBytes` is rejected and requires explicit
configuration migration; it is not an alias.

Each configured Module uses these fields in addition to its identity, Page
routes, activation, and resource limits:

```typescript
interface ModuleConfiguration {
  extensionId: string;
  packageVersion: string;
  isolation: "none" | "process" | "sandbox";
  configurationReference: {
    configId: string;
    revision: string;
    configVersion: number;
  };
  permissionPolicyIds: readonly string[];
  limits: {
    claim: { maxCount: number; maxBytes: number } | null;
    maxInputBytes: number;
    maxResultBytes: number;
    maxFrameBytes: number;
    maxRunsPerGeneration: number;
    maxGenerations: number;
  };
  timeouts: {
    initializationTimeoutMs: number;
    executionTimeoutMs: number;
    cancellationGraceMs: number;
    terminationTimeoutMs: number;
  };
}
```

`extensionId` and `packageVersion` identify one exact installed Extension
package and MUST match its static manifest. `packageVersion` is a non-empty,
opaque version identifier using the manifest's restricted American Standard
Code for Information Interchange (ASCII) syntax. The runtime compares its exact
ASCII byte sequence with the manifest value; it does not parse, normalize,
sort, or apply semantic-version precedence. The
installation registry resolves the `extensionId` and `packageVersion` pair; an
instance configuration MUST NOT supply an executable path, command, or working
directory. Updating an installed package does not silently change an existing
Module's package version.

`isolation` states the execution boundary: `none` has no process boundary,
`process` uses a separate operating-system process but is not a security
sandbox, and `sandbox` requires an operating-system security sandbox. The
runtime MUST fail closed when it cannot provide the configured boundary.
The current `ReactiveModuleRuntime` library accepts only an executor whose
trusted host declares `isolation: "process"` and whose `terminate()` operation
confirms process exit. The repository now contains a reusable adapter from that
executor contract to `ExtensionProcessHost` and a real child-process test for
result commit and orderly shutdown. Normal runtime startup continues to reject
Modules. A product-before-bootstrap resolver now revalidates an installed
package and an immutable configuration record, but product startup does not call
it, no generation-owning runtime factory yet consumes it, and version 9 lacks
the Linux process and external-effect fields required by Section 5.2. Product
startup also does not yet write the durable child-process identity that Section
7.7 defines or prove an old Module control group empty after the Core process
exits.

For process isolation, `createExecutor` MUST synchronously return an executor
handle with `start()` and `terminate()` operations. Returning a Promise or an
object with a callable `then` property is invalid. The factory MUST NOT create
an operating-system process or begin process authentication or Extension
initialization. Those actions belong to `start()`, so Core holds a usable
termination handle before process creation begins.

The executor's `start()` operation creates the operating-system process,
authenticates its communication channel, and completes Extension and Module
initialization. Its `terminate()` operation MUST coordinate with an unfinished
`start()` operation and resolve only after the result channel is closed, the
process has exited, host-issued capabilities are revoked, in-flight capability
handlers have settled, and the unfinished `start()` operation cannot reopen
resources. Only this completed operation proves that a process executor has
stopped. A process executor's cooperative `stop()` operation, when present,
does not prove process exit and MUST NOT replace or run concurrently with
`terminate()` when handling a hard timeout or shutdown.

This portable executor contract is evidence only while one Core process remains
alive. It does not authorize Linux Module activation: a direct child exit proves
neither that descendants stopped nor that a later Core invocation may recover
the Run. The Linux-specific conditions for a Module process are in Section 5.2
and Architecture Decision Record (ADR) 0009.

A Module configuration reference identifies one exact, separately stored
configuration document. `configId` identifies the document, `revision`
identifies its immutable revision, and `configVersion` identifies the schema
that the Extension uses to validate it. The instance document MUST NOT contain
the referenced configuration or its credentials inline.

`configurationReference.revision` MUST have the exact form
`sha256:<64-lowercase-hexadecimal-characters>`. It is a content revision, not a
display label or mutable version name.

`maxInputBytes` and `maxResultBytes` bound the serialized Module input and
result. `maxFrameBytes` bounds one Extension process protocol frame. It MUST be
at least 4096 bytes greater than each of `maxInputBytes` and `maxResultBytes` so
the protocol envelope cannot consume the content budget. These limits are
independent of claim count and byte limits.

`initializationTimeoutMs` bounds the process executor's `start()` operation,
including process creation, authentication of its communication channel, and
Extension and Module initialization. It does not permit `createExecutor` to
perform those actions. `executionTimeoutMs` bounds one Module execution. After
execution timeout, `cancellationGraceMs` bounds the wait for cooperative
cancellation before the configured isolation policy may terminate execution.
`terminationTimeoutMs` bounds each wait for proof that the process stopped; it
does not cancel or replace an unfinished `terminate()` Promise. After one wait
expires, a later `stop()` call MUST observe that same Promise instead of
starting a concurrent `terminate()` or treating `stop()` as proof of process
exit. If the operation rejects, a later `terminate()` call MUST be safe because
rejection does not prove that the process stopped. All four values are
positive, finite milliseconds and do not weaken the no-overlap rule in Section
9.4.

A permission policy is a persistent operator-approved rule that the runtime
uses when deciding which operations a Module may request. `permissionPolicyIds`
stores identifiers of those rules. It MUST NOT store capability handles: a
capability handle is temporary session authority created for one authenticated
Extension process and becomes invalid when that session ends.

The current bootstrap validates this configuration but rejects every configured
Module until the isolated Extension process runtime is connected. Parsing a
Module does not imply that its execution path is available.

`composeReactiveModuleHost` is the narrow candidate composition used before
that product connection. It validates the complete version 9 document again,
requires exactly one supplied runtime and mailbox record for every configured
Module, accepts only reactive process-isolated Modules, takes Page routes only
from the validated document, and rejects a Scheduler baseline claim batch above
any Module's static Claim maximum. The Scheduler settings absent from version 9
remain explicit trusted inputs. This function is not called by
`openDollyRuntime`; its real-child-process test is evidence for the vertical
slice only and does not satisfy Linux control-group ownership, durable external
effect evidence, configuration resolution, or startup recovery.

Candidate-host shutdown first changes the Scheduler to its stopping state,
which synchronously closes dispatch admission. It then invokes every started
runtime's stop operation without waiting for the Scheduler's active ticks to
drain; runtime cancellation and process termination are what allow those ticks
to settle. Scheduler drain and runtime termination are awaited together. A
runtime whose termination remains unconfirmed stays in the started set, the
Host reports failure, and a later stop call retries that same proof instead of
returning a permanently cached rejection.

`resolveInstalledExtensionModule` and
`deriveInstalledLinuxExtensionModuleExecutor` form a narrower installation
derivation boundary: in ordinary terms, they ensure that the package digest,
absolute entrypoint, manifest, trust classification, configuration schema,
configuration bytes, and initial process record all come from the same
integrity-checked installation and configuration records. Callers cannot
separately substitute an executable, manifest, configuration, or package
digest. Service invocation, boot, delegated control-group root, and derived
Module control-group path come from one already verified Core service binding;
neither the launcher nor the Extension inherits Core's environment. The
derivation also rejects an untrusted package before a process-isolated launcher
exists.
It constructs no process and does not prove generation replacement, Scheduler
integration, live Linux control-group ownership, restart recovery, or orderly
product shutdown. `openDollyRuntime` does not call either function and retains
the configured-Module refusal in Section 5.1.

`createInstalledLinuxExtensionModuleGenerationFactory` owns the next narrower
identity rule. It creates at most one executor for each non-reused Module
generation, gives each one a distinct process generation absent from the
durable process-record store, and exposes the exact mapping that a future
product composer must use when persisting a Run submission. Thus executor
creation and submission authorization cannot capture two different process
identities. This factory still does not persist or start the process by itself;
`ModuleActor` and the Linux lifecycle remain the only owners of those actions.
The current product bootstrap does not construct the factory.

### 5.2 Proposed Linux Module process limits

This section defines the configuration required before the first Linux Module
runner can be accepted. It does not claim that the current runtime implements
it: the current `dolly.instance/9` schema and bootstrap continue to reject all
Modules. The first implementation must use a new schema version rather than
silently accept these fields in version 9.

A Linux Module process limit record is the per-Module configuration that maps
ordinary resource limits to the Linux controls that enforce them. It relates the
existing Module configuration to the process cgroup required by ADR 0009. A
Linux-qualified record is necessary because the same names cannot honestly claim
equivalent enforcement on another operating system.

```typescript
interface LinuxModuleProcessLimits {
  memoryMaxBytes: number;
  maxProcesses: number;
  cpuQuotaMicros: number;
  cpuPeriodMicros: number;
  maxOpenFiles: number;
}

interface LinuxModuleConfiguration extends ModuleConfiguration {
  linuxProcessLimits: LinuxModuleProcessLimits;
  declaredExternalEffects: "none" | "core-capabilities-only";
}
```

All values are positive safe integers. `memoryMaxBytes` maps to cgroup
`memory.max`; `maxProcesses` maps to `pids.max`; `cpuQuotaMicros` and
`cpuPeriodMicros` are the quota and period written to `cpu.max`; and
`maxOpenFiles` is applied by the reviewed child launcher as both the soft and
hard `RLIMIT_NOFILE` limit before Extension code executes. The existing
execution timeout remains the wall-clock deadline, but expiration must end in
cgroup-level termination and empty-cgroup proof. Core writes each limit, reads
it back, and refuses activation if the expected cgroup version 2 controller or
operation is unavailable.

`linuxProcessLimits` is required for every executable Module on Linux and is
not portable configuration. Windows and other platforms continue to reject
Module activation until a separately reviewed design defines equivalent process
ownership and resource enforcement. The exact installed package digest and
configuration revision are persisted before the child launcher starts and remain
pinned until the associated process record and any unresolved Run are terminal.

`declaredExternalEffects` is the required external-effect declaration for a
Linux executable Module. It states which effect channels the Module uses, and
it is configuration reviewed by the operator, not a runtime measurement:

- `"none"` declares that the Module makes no external or persistent effect at
  all. Because repeating such a Run cannot add an external effect, a submitted
  Run with no committed result may be recovered automatically once the old
  Module cgroup is proven empty.
- `"core-capabilities-only"` declares that every external or persistent effect
  passes through a durable Core capability. Recovery of a submitted Run then
  depends on the capability intent and outcome records defined in Section 7.5.

A Module that uses direct ambient filesystem, network, or subprocess effects
has no valid value and cannot be configured for automatic activation. The
first Linux Module runner automatically activates only a Module carrying one
of these two values, and Core copies the declaration into the Module process
record. A sandbox backend enforces the declaration for untrusted code; for
trusted code under ordinary `process` isolation it is an audited operator
assertion that Core cannot verify, and documentation must state that limit.
The proposed instance schema version that carries `linuxProcessLimits` and
`declaredExternalEffects` is `dolly.instance/10`; version 9 continues to
reject every configured Module.

The two halves of this declaration have different implementation status. The
persisted half exists: `dolly.module-process-record/1` in Section 7.7 carries
`declaredExternalEffects`, the Core-state store rejects any other value, and
startup recovery already applies the disposition rules that depend on it. The
configuration half does not exist yet: no released instance schema accepts
`linuxProcessLimits` or `declaredExternalEffects`, so today no operator can
supply the declaration and no Module can be activated to produce a record.

## 6. Block model

### 6.1 Block

The conceptual schema is:

```typescript
interface Block {
  schemaVersion: "dolly.block/2";
  id: BlockId;
  sequence: DecimalSequence;
  source: SourceIdentity;
  createdAt: string;
  summary?: string;
  payload: {
    schema: string;
    value: JsonValue;
  };
}
```

The stored Block contains no separate reference arrays. For the standard
`dolly.content/1` payload, the ordered `items` described in `block-payload.md`
are the only source of Block and Media dependencies.

### 6.2 Core-owned fields

The runtime MUST assign and authenticate all of the following fields:

- `schemaVersion`;
- `id`;
- `sequence`;
- `source`;
- `createdAt`.

A Module MUST NOT choose or override these fields. In particular, a Module
cannot self-report `source`. For a Module result submitted under a Delivery
Claim, `source` MUST be `{ kind: "module", id: claim.consumerId }`: it names
the consumer Module that owns that Claim, not another Module, an external
source, or a system source. External ingress uses a runtime-authenticated
external source identity only on a trusted Core direct Block commit, not on a
Module result.

`id` MUST be unique for the lifetime of an instance's BlockStore. Registration
of an existing ID MUST fail. Overwrite is forbidden.

`sequence` MUST be allocated by the committing runtime and MUST define total
commit order inside one runtime instance. Wall-clock timestamps MUST NOT be
used to establish Block order, reference legality, retry order, or lifetime.

`createdAt` is an observability timestamp. Clock correction or two equal wall
timestamps MUST NOT affect correctness.

### 6.3 Module-owned fields

A Module MAY propose:

- a human-readable `summary`;
- a namespaced payload schema identifier and JSON payload;
- content items inside the registered payload schema.

The runtime MUST validate JSON shape, size, content references, media access, and
configured limits before commit. Domain validation of an unknown payload is
owned by the extension process protocol and its declared payload schema.

The Core MUST NOT inspect arbitrary payload fields to discover files, Uniform
Resource Locators (URLs),
media, forwards, commands, or ownership. Only the registered `dolly.content/1`
items can create a Block or Media dependency. This prevents an extension-defined
payload key from accidentally activating Core behavior.

### 6.4 Immutability

After commit, a Block MUST be immutable.

- Store application programming interfaces (APIs) MUST return a read-only
  snapshot.
- A caller mutation MUST NOT modify the stored record.
- Event subscribers and Modules MUST NOT receive mutable aliases to stored
  arrays or nested objects.
- Content items and their references MUST NOT change after commit.

An implementation MAY use defensive copying, freezing, persistent data
structures, canonical serialization, or another mechanism, but observable
immutability is required.

### 6.5 References and acyclicity

Every `block-reference.blockId` MUST resolve at commit time. The target Block's
sequence MUST be lower than the new Block's sequence. Because IDs cannot be
overwritten and Blocks are immutable, this rule guarantees an acyclic reference
graph.

Reference validation MUST use store sequence, not a caller-supplied timestamp.
Self-reference and a reference to an uncommitted Block MUST fail the entire
proposal atomically.

Reference expansion is a consumer concern. Consumers MUST enforce explicit
depth, node-count, and serialized-byte limits even though the graph is acyclic.

Media identifiers are Core-managed and shared within one Dolly instance so a
Media reference can pass between Modules in immutable Blocks. At Block commit,
the trusted Core resolver validates that the referenced Media and crop exist. A
successful resolver lookup is not Extension authorization: an untrusted
Extension must be able to use a Media reference only when the host derives an
opaque capability from a matching reference in a Block already delivered to the
Extension's authenticated Module job. That capability may not be used for an
undelivered Block, another session or Module, a guessed identifier, or a crop
broader than the delivered reference.

The Core resolver deliberately validates instance-wide identity rather than
choosing a per-Module identity, because valid Block forwarding must preserve the
same `mediaId`. The Extension process host must separately validate Media
references in a proposal against the job's delivered-reference capability scope
before it calls the resolver. That Extension application binary interface (ABI)
wiring is not yet implemented; the current bootstrap rejects configured Modules
before execution. No current Core resolver test is therefore evidence of
untrusted Extension Media-access conformance.

### 6.6 Delivery metadata is not Block state

Retry attempts, path multiplicity, consumer progress, occurrence count, and
delivery timestamps MUST NOT be written into a Block. They describe a
Block's delivery to a particular consumer, not the Block's identity.

In particular, legacy `repeat_count` behavior belongs in a Block delivery group
or Delivery envelope. The same immutable Block may have different occurrence
counts for different Modules.

## 7. Page and Delivery model

### 7.1 Page as a delivery log

A Page is an append-only logical log of Delivery records. It stores Block IDs,
not mutable Block objects.

```typescript
interface Delivery {
  schemaVersion: "dolly.delivery/1";
  deliveryId: string;
  pageId: string;
  pageSequence: DecimalSequence;
  globalSequence: DecimalSequence;
  blockId: BlockId;
  enqueuedAt: string;
}
```

Each append MUST create a distinct Delivery, including repeated appends of the
same Block to the same Page. `deliveryId`, `pageSequence`, and `globalSequence`
are runtime-owned and immutable.

Appending a Block to multiple output Pages creates one Delivery per Page. The
runtime MUST either commit the output Block, output Deliveries, and input
positive acknowledgement as one transaction, or provide a durable outbox with
equivalent idempotent recovery behavior.

### 7.2 Consumer state

Each Page consumer has independent state. At minimum it includes:

- the highest contiguous acknowledged Page sequence;
- the earliest retained Page sequence and current consumption frontier;
- currently claimed delivery IDs and their claim token;
- attempt count and last failure classification per pending delivery;
- configured subscription start position;
- dead-letter disposition where applicable.

Page retention MUST be based on consumer state and strong references, not on array
indices exposed outside the Page implementation.

A newly added consumer MUST explicitly choose one of:

- `from-head`;
- `from-now`;
- an exact valid checkpoint.

There MUST NOT be an undocumented implicit choice.

The runtime preserves both the configured choice and the sequence boundary
resolved when the subscription is created:

```typescript
interface DeliverySubscriptionSnapshot {
  consumerId: string;
  start: "from-head" | "from-now" | { checkpoint: DecimalSequence };
  startAfter: DecimalSequence;
}

interface DeliveryPendingStatus {
  consumerId: string;
  pageIds: readonly string[];
  pendingCount: number;
  pendingBytes: number;
  oldestEnqueuedAt: string | null;
}
```

`start` is the original configured value. `startAfter` is the fixed Page
sequence after which Deliveries are eligible for that consumer. A restart MUST
restore both values and MUST NOT reinterpret `from-head` or `from-now` against
the Page contents present at restart. `DeliveryPendingStatus` is a read-only
inspection of current pending obligations for the requested Pages; reading it
does not claim, acknowledge, or otherwise mutate a Delivery.

`from-head` means the earliest Delivery still retained by that Page, not a
promise that already collected history can be reconstructed. An exact checkpoint
older than the retention frontier MUST fail visibly. Removing a consumer is an
audited operation that retires its pending obligations and associated strong references;
an absent or offline consumer MUST NOT be silently treated as removed.

### 7.3 Multi-Page input ordering and Block grouping

When a Module consumes several input Pages, the runtime MUST claim under that
Module actor's consumer lock and MUST present deliveries ordered by
`globalSequence`. Concatenating Pages in configuration order is not conformant.

The runtime MUST group Deliveries in the claimed batch that reference the same
Block ID into one Block delivery group. A Block delivery group is the immutable
Block plus the exact Deliveries for that Block within one Delivery batch; the
group avoids duplicating the same immutable Block while preserving each
Delivery's identity and order.

```typescript
interface BlockDeliveryGroup {
  block: Block;
  deliveryIds: readonly string[];
  occurrenceCount: number;
  firstGlobalSequence: DecimalSequence;
  lastGlobalSequence: DecimalSequence;
}
```

`occurrenceCount` MUST equal the number of deliveries in the group. Original
delivery IDs and ordering bounds MUST remain available for acknowledgement,
tracing, and debugging.

The Extension-facing reactive Module input schema is
`dolly.reactive-module-input/2`. Its top-level `claimedDeliveryIds` field lists
the exact ordered Delivery IDs in the Claim, and `blockGroups` contains the
corresponding Block delivery groups. Version 1 fields `deliveryIds` and
`occurrences` are removed and are not aliases; an Extension using the old
schema requires an explicit migration.

At eligibility, the logical input snapshot is every currently pending Delivery
across all input Pages, ordered by `globalSequence`. If finite claim limits cannot
hold that snapshot, the runtime claims the largest deterministic ordered prefix
that fits and returns `hasMore: true`; it MUST NOT sample or reorder later input.
At least one otherwise-valid Delivery must make progress, or the runtime returns
a visible oversize/backpressure error. The next run continues from the exact
frontier.

### 7.4 Claim

Claiming MUST be atomic from the perspective of one Module actor. A successful
claim returns:

- an unguessable claim token;
- a stable `moduleJobId` for the Module job bound to this exact Delivery batch;
- a fresh `runId`, attempt number, and `moduleGenerationId`;
- the exact delivery IDs covered;
- immutable Block delivery groups;
- the captured `hasMore` value, which says whether more input existed beyond
  the bounded prefix when the Module job was created; and
- a claim deadline if visibility timeout is enabled.

Claim does not acknowledge or permanently advance the consumer checkpoint.
Deliveries arriving during a run are outside its claim and remain pending for a
later run.

If Claim creation changes in-memory state but Core cannot confirm the required
persistence write, Core MUST NOT execute the Module, acknowledge or negatively
acknowledge the Claim, create another Claim for that consumer, or infer that the
write failed. Within the same process, recovery MUST first complete persistence
and then verify the exact `moduleJobId`, claim token, `runId`, attempt, and
`moduleGenerationId`. Only the same still-active Claim may then execute. After
a process restart, recovery MUST use durable process and submission records;
the former in-memory Claim is not evidence that Module execution did or did not
start.

On retry, the runtime MUST keep the same `moduleJobId` and exact input: Delivery
IDs, Block delivery groups, and `hasMore`. It stores `hasMore` with the Module job when it
selects the input and MUST NOT recompute it from Deliveries that arrived after
that selection. The retry receives a new claim token, `runId`, and attempt number
and is processed before later Deliveries for that consumer unless an explicit
operator action dead-letters or abandons the Module job.

Only the active generation and matching claim token may positively or
negatively acknowledge a Claim. Stale, duplicated, or foreign acknowledgements
MUST be rejected and recorded.

### 7.5 Positive and negative acknowledgement

The default Dolly delivery guarantee SHOULD be at-least-once.

- Positive acknowledgement (`ack`) commits a successful Run and advances the
  consumer checkpoint.
- Negative acknowledgement (`nack`) records a failed attempt and returns the
  Deliveries to retry policy.
- After an actor or process crash, Core MUST keep the Claim active until
  durable records of process state and result submission prove whether the old
  executor can still run and whether it submitted a result. Only a proven
  failed Run may proceed to negative acknowledgement. The current startup
  recovery reads and cross-checks those records. When an active Claim lacks the
  records or other durable evidence needed to establish its outcome, recovery
  leaves the Claim active and reports `STARTUP_ACTIVE_CLAIM_UNRESOLVED`.
- For the proposed Linux Module runner, a submitted Run may be negatively
  acknowledged only after the Module result commit journal and every possible
  external effect have no-effect or retry-safe evidence. A terminal external
  effect outcome does not by itself prove that repeating the Run is safe.
  Process exit, cgroup cleanup, cancellation, timeout, or an Extension error
  alone is not sufficient evidence. Otherwise the exact Claim remains active
  with an unknown outcome for audited operator action.
- A Module exception MUST NOT silently discard input.

An effect slot, represented by `effectSlot`, is the stable identifier assigned
to one intended external side effect within a Module job. It combines with
`moduleJobId` to provide retry idempotency; it is not a provider call
identifier because it must exist before dispatch and remain unchanged when a
retry creates a new provider call.

The runtime MUST NOT claim exactly-once Module side effects. A side effect that
may outlive one attempt MUST use an idempotency key derived from stable
`moduleJobId` plus a stable effect slot or tool-call ID. `runId` MUST NOT be the
sole side effect key because it changes on retry. Effects without an idempotency
or queryable outcome contract are not automatically retryable.

For any effect that can cross a provider, storage, Media, or tool boundary, Core
must persist an intent, stable key, and exact Claim/Run association before the
input/output operation. The responsible capability contract then persists or
queries its terminal outcome. An in-memory duplicate map, an Extension-declared
`retrySafe` flag, or a cancelled local Promise is not durable evidence.

The current `EffectIntentJournal`, `FileEffectIntentStore`, and
`effectIntentEvidenceSource` implement the record rules, crash-recoverable
storage, and the adapter consumed by startup and runtime recovery. Before
execution, the file store can durably open one exact Run. Closing that Run
atomically freezes the count and digest of every intent accepted while it was
open; a later new intent is refused. Only a matching closed record plus an empty
intent set, or a matching closed record whose entire frozen set has `no-effect`
outcomes, proves `no-effect` for that Run. A missing, open, mismatched, or
unsettled set remains `unknown`. A `terminal` record proves a durable final
effect result, not retry safety.

This is still a component boundary, not a supported product path. No product
capability execution path is yet required to open the Run before
`module.execute`, write every effect intent before crossing its boundary, wait
for all accepted capability handlers to settle, and close the Run after Host
stops accepting new capability calls. Until that single authorization path is
wired and tested, the persistent store's complete-set proof cannot be assumed
for a live Module.

The current `dolly.effect-intent/2` record carries both the stable idempotency
key and one exact Claim/Run identity. A retry Run records a separate record with
the same `moduleJobId`, idempotency key, and intent digest, plus its own claim
token, Run identifier, attempt, and Module generation. A different intent under
that stable key is a conflict. Evidence inspection uses only the exact Run's
record; it never treats another Claim's related record as authorization for the
current Run.

Positive acknowledgement operations MUST be idempotent for the same valid
claim token. A repeated positive acknowledgement MAY report
`already-committed`, but MUST NOT duplicate output or advance another Claim.

### 7.6 Retry and dead letters

Failure and retry policy MUST be explicit and bounded. It MUST distinguish at
least:

- retryable Module failure;
- invalid Module output;
- runtime backpressure;
- unavailable dependency;
- non-retryable input or configuration error.

Cancellation because orderly shutdown began before Core started handling a
hard timeout is not a Module failure. Core MUST report the Run as `cancelled`
with reason `shutdown`; it MUST NOT send that outcome to failure
classification, negatively acknowledge the Claim, or enter it in dead letter.
If Core started handling a hard timeout first, its termination and failure path
remains authoritative even if shutdown begins while that path is incomplete.

For one Module job, `attempt` is the monotonically increasing number of Runs
for which Core issued a Claim. A failed attempt is a Run for which Core accepts
a valid negative acknowledgement. `failedAttemptCount` is the number of failed
attempts recorded for that Module job. A later Claim increases `attempt`,
including after an orderly shutdown, but releasing the earlier Claim does not
record a failed attempt or increase `failedAttemptCount`.

An **unknown submission history item** records an exact active Claim migrated
from an older Core-state format when Dolly cannot determine whether its
submission record ever existed. Section 7.7 defines its complete identity and
storage rules.

The persisted Claim state `released` means Core has confirmed that the Run's
executor cannot submit a result, and that either no submission record exists in
a version 17 state that also has no unknown submission history item for that
exact Claim, or the result journal and every possible external effect have
no-effect or retry-safe evidence. A terminal external effect outcome requires
the Claim to remain unresolved unless a separate durable idempotency contract
proves retry safety. Version 15 and version 16 absence is not sufficient by
itself because those formats cannot prove that an older writer never removed
the record independently. The old Claim can no longer be acknowledged or
negatively acknowledged, and the same immutable Delivery batch remains pending
for the same Module job. The state is required because
`active` still authorizes a Run, `nacked` and `dead-lettered` classify failure,
and `committed` records success; none of those states represents an orderly
shutdown that preserves pending work.

After shutdown cancellation and proof that the executor stopped, Core MUST first
apply the same submission and external-effect evidence rule. It may release the
exact Claim identified by `moduleJobId`, claim token, `runId`, attempt, and
`moduleGenerationId` only when that rule permits release. Release does not increase
`failedAttemptCount`. If a matching submission record exists, the update that
records `released` MUST also remove that record. If the release write reports
failure or its result is otherwise uncertain, Core MUST flush pending
persistence and inspect that exact Claim and submission record. It may finish
stopping only if inspection confirms state `released` for the expected consumer
and confirms that no matching submission record remains. If it cannot confirm
both facts, it MUST report
`RUNTIME_RECOVERY_REQUIRED`, retain the exact Claim identity, and let a later
`stop()` call retry or reconcile the same release. It MUST NOT infer a failure
classification or issue a negative acknowledgement.

When this evidence is missing, orderly shutdown preserves the exact Claim as an
unknown outcome instead of releasing it. A later operator action must be
audited, identify the exact Claim and evidence considered, and warn before any
forced release that it can repeat an external effect.

A retryable failed attempt is eligible for another Claim only while
`failedAttemptCount` remains below `core.limits.maxFailedAttempts`. When the
count reaches that limit, or when the failed attempt is non-retryable, the
exact Module job and its immutable Delivery batch MUST enter dead letter. They
MUST NOT be silently dropped.

A dead-letter record MUST include Block ID, Delivery ID, consumer, attempts,
failure code, and timestamps. Payload inclusion is subject to security and
redaction policy.

### 7.7 Durability

The runtime defines two durability settings:

- `volatile`: committed state survives only for the current process lifetime;
  process failure may lose Blocks, Deliveries, checkpoints, and claims; and
- `persistent`: Block commits, Deliveries, consumer checkpoints, Module jobs,
  Claims, Module result commits or outbox state, strong references, and Module generations
  survive restart before success is reported across that boundary.

A durability setting defines observable guarantees, not a required database
product. An implementation may use an atomic transaction, journal, outbox, or
another recoverable mechanism that passes the same conformance tests.

The selected durability MUST be visible in configuration and runtime
status. At-least-once guarantees apply only within the declared durability
boundary.

The current persisted Delivery store schema is `dolly.delivery-store/6`.
Version 6 uses the strong-reference contract and stores Module jobs in
`moduleJobs`. It records each subscription's original `start` and resolved
`startAfter` along with Page, Delivery, Module job, Claim, append-effect, and
dead-letter state. The snapshot stores `maxFailedAttempts`, and every Module
job stores its required `failedAttemptCount`. Every stored Module job also has
a required boolean `hasMore` value. It is the value captured with that job's
exact input, so retry and restart cannot change the input when later Deliveries
arrive. Claim history may contain `released` only under the rules in Section
7.6. Readers MUST reject version 5 and its `maxAttempts` field, every earlier
version, or a version 6 Module job that omits `hasMore` or
`failedAttemptCount`; they MUST NOT infer the failure count from an older
snapshot during startup.

The current dead-letter record schema is `dolly.dead-letter/2`. Version 2 uses
`moduleJobId` for the originating Module job. Readers MUST reject version 1 and
its former field rather than accepting it as an alias.

The current file-backed Core state document is `dolly.core-state/17`. It contains
the revision, `referenceGraph`, optional Media state, Block state, Delivery
store state, `moduleProcessRecords`, `moduleSubmissionRecords`, the collection
of unknown submission history items defined below, and a digest over every one
of those fields including `schemaVersion`. Version 17 contains
`dolly.delivery-store/6`, including the required stored Module-job `hasMore`
and `failedAttemptCount` values, and accepts
`dolly.media-store/9`, including persistent upload recovery, bounded resource
records, generated identifier sequence state, URL-provider-request outcome
state, and temporary Media-read leases. Normal startup readers MUST reject
version 15, version 16, any unknown field, and any digest mismatch; they MUST
NOT silently migrate an older Core-state or Delivery-store snapshot.

Version 17 stores `moduleProcessRecords`, `moduleSubmissionRecords`, and unknown
submission history items in the same complete Core-state document as the
Delivery store state, not in another file or result store. As defined in
Section 7.6, each item identifies an exact active Claim migrated from version 15
or version 16 for which Dolly cannot determine whether a matching Module
submission record was never written or was removed by an older writer. The
serialized collection
`activeClaimsWithUnknownSubmissionHistory` contains exactly the Claim's
`moduleJobId`, claim token (`claimToken`), `runId`, attempt number (`attempt`),
and `moduleGenerationId`. An item is not a submission record, is not authority
to send, and is not proof that sending was never authorized. Each item MUST
match one exact active Claim, be unique by `runId`, and be disjoint from the
submission-record collection.

Earlier version 16 writers permitted a submission record to be removed
independently of its Claim transition and treated a record beside a terminal
Claim as later cleanup. `FileCoreStateStore` now makes every Claim terminal
transition and matching record removal one Core-state update, rejects direct
terminal methods on its public Delivery store, and rejects a terminal Claim
beside a submission record. Version 17 and its explicit migration establish the
missing historical distinction without interpreting an ambiguous older
document as evidence that sending was never authorized. The document version
does not by itself enable a Module; the remaining activation requirements in
this specification and ADR 0009 still apply.

A Module process record contains the instance, Module, Module-generation, and
non-reused process-generation identifiers; validated package digest and
configuration reference revision; the recorded external-effect declaration from
Section 5.2; verified Core-service invocation and Linux boot identifiers;
Core-derived Module cgroup path; lifecycle state; bounded timestamps; and safe
failure information. It contains no process control handle, credential,
capability handle, signed URL, user content, or Extension-provided path.

A Module submission record contains the exact active Claim identity
(`moduleJobId`, claim token, `runId`, attempt, and `moduleGenerationId`), the
matching process generation, canonical input digest, and durable authorization
to send `module.execute`. The record is written in a confirmed Core-state update
before the protocol send. Every submission record MUST match exactly one active
Claim in the same Core-state document. An active Claim has zero or one matching
submission record. When that record exists, its `processGenerationId` selects
exactly one Module process record; other stopped records retained for the same
Module generation are history, not additional matches. The selected process
record may become `stopped` during recovery, but it MUST be `running` when Core
first writes the submission record. The Claim's consumer identifier MUST equal
the selected process record's `moduleId`, and their Module-generation
identifiers MUST match.

Before writing or accepting a submission record, Core MUST recompute
`inputDigest` from the exact canonical `dolly.reactive-module-input/2` document
bound to that Claim and compare the result with the record. It MUST NOT trust a
stored digest without the durable input needed to perform that comparison.
Version 17 preserves the Delivery-store input needed for this validation when
it migrates an older document.

A Claim that is not active MUST have no submission record; finding both is a
fail-closed consistency error, not permission to collect the record later. An
identity mismatch, orphan record, missing durable input for digest validation,
or partial or unknown state write also fails closed. Core allocates the
process-generation identifier and pins the package/configuration revision in
the earlier update that creates the process record, before starting a child
launcher. The later submission-record update refers to those pinned values; it
does not allocate or change them.

The record shapes are:

```typescript
interface ModuleProcessRecord {
  schemaVersion: "dolly.module-process-record/1";
  instanceId: string;
  moduleId: string;
  moduleGenerationId: string;
  processGenerationId: string;
  packageDigest: string;
  configurationReference: {
    configId: string;
    revision: string;
    configVersion: number;
  };
  declaredExternalEffects: "none" | "core-capabilities-only";
  serviceInvocationId: string;
  bootId: string;
  moduleCgroupPath: string;
  state: "starting" | "running" | "stopping" | "stopped";
  createdAt: string;
  updatedAt: string;
  diagnosticPid?: number;
  failureCode?: string;
}

interface ModuleSubmissionRecord {
  schemaVersion: "dolly.module-submission-record/1";
  moduleJobId: string;
  claimToken: string;
  runId: string;
  attempt: number;
  moduleGenerationId: string;
  processGenerationId: string;
  inputDigest: string;
  createdAt: string;
}
```

`packageDigest` is the SHA-256 digest of the exact installed package contents
resolved by the installation registry. `serviceInvocationId` and `bootId` are
the manager-reported service invocation identifier and the Linux boot
identifier captured when Core verified its service binding; both are required
so recovery can apply the same-boot and changed-boot cgroup rules from ADR
0009. `moduleCgroupPath` is the Core-derived path that embeds the non-reused
`processGenerationId`. `diagnosticPid` is diagnostic data only and is never
used to address a signal. `failureCode` is a bounded, sanitized
machine-readable code; free-form failure text belongs in logs. `inputDigest`
is the digest of the canonical `dolly.reactive-module-input/2` document for
the Run; the existence of the submission record is itself the durable
authority to send, so the record has no separate authorization flag.

The process-record lifecycle is:

- `starting`: the record is durable, but process startup and authenticated
  initialization are not complete. The child launcher may or may not have
  been created, and execution authorization may already have been delivered.
  Execution authorization is Core's permission for the launcher to execute the
  Extension, carried by the launcher protocol's `execute` command. A failed
  start result may still mean that delivery of this command is unknown.
- `running`: Core verified the launcher's cgroup membership from kernel files
  and the Extension completed authenticated initialization.
- `stopping`: stop intent is persisted before group termination begins.
- `stopped`: recorded only after the ADR 0009 empty-cgroup proof
  (`populated 0`, the qualified missing-path rule, or a changed boot
  identifier plus fresh service verification). Before execution authorization,
  an observed launcher exit followed by a fresh `populated 0` reading and
  successful removal of the prepared cgroup directory is also sufficient.

Every transition is part of a Core-state update. A submission record may be
written only while its process record is `running` and its exact Claim is
active. A transition of that Claim to `released`, `nacked`, `committed`, or
`dead-lettered` MUST remove the matching submission record in the same
Core-state update. That terminal transition is the only permitted removal of a
submission record. A `stopped` process record with no remaining active Claim or
submission record may be removed in a later Core-state update; a record
referenced by an unresolved Claim, submission record, or unknown outcome is
retained and must not be collected. Its process identity, package digest,
configuration reference, and external-effect declaration are immutable. Its
lifecycle state may advance to `stopped` only after startup verifies a stop
proof bound to that exact process record. The exact container layout inside
`dolly.core-state/17` follows the existing Core-state document conventions; the
identity keys are the non-reused `processGenerationId` for process records and
`runId` for submission records and unknown submission history items.

Reading a `dolly.core-state/15` or `dolly.core-state/16` document during normal
startup reports `CORE_STATE_MIGRATION_REQUIRED`; startup never infers version
17. The explicit `migrate-core-state` command migrates either supported older
version directly to version 17. It first inspects the instance configuration,
acquires that instance's controller lock, and then claims the same instance
identity and configuration revision. While holding that lock, it restores and
validates the source and proposed target with the claimed failure limit, Media
enablement, Media identifier namespace, Media limits, and Core-state byte
limit. A configuration revision change, incompatible snapshot, invalid
cross-record relationship, or oversized target fails before a backup is
created or the source is replaced.

Migration increments the Core-state revision exactly once, computes a version
17 digest that includes `schemaVersion`, writes the exact original bytes beside
the state file as `.v15.backup` or `.v16.backup`, and then atomically replaces
the source. A retry may reuse an existing backup only when it is a regular file
whose bytes exactly equal the still-current source; a partial or different
backup fails closed. The Core-state file lock protects the replacement in
addition to the instance controller lock.

For every migrated active Claim without a matching submission record, migration
writes its exact five-field identity to the unknown submission history
collection. Version 15 has no Module record collections, while version 16
process and submission records are preserved and revalidated. Migration and
recovery MUST NOT call an item in that collection `never-submitted`, release or
retry its Claim, or create a new submission record for it. Only an active Claim
written under version 17 rules with neither a submission record nor an exact
unknown submission history item proves that Core was never authorized to send
that Run.

The Module result commit journal remains separate because it records output
effects. For a successful submitted Run, the required order is:

1. write and synchronize the `prepared` journal record before any result
   effect; this durable state lets recovery resume the remaining work;
2. apply and record the recoverable Block and output Delivery effects while the
   journal record remains `prepared`;
3. make one Core-state update that positively acknowledges the exact active
   Claim and removes its matching submission record; and
4. change the journal record from `prepared` to `committed`.

A crash between steps 3 and 4 may therefore leave a matching `prepared` journal
record beside a Claim whose status is `committed` and no submission record.
Recovery may finish step 4 only after it verifies the exact identities and that
all Block and output Delivery effects required by the `prepared` record are
complete. Missing or contradictory effects fail closed. This allowed boundary
does not permit any terminal Claim to coexist with a submission record. A
`prepared` journal record may otherwise coexist only with its exact active Claim
and matching submission record. A `committed` journal record MUST match a Claim
whose status is `committed`, with no submission record. Every other combination,
including any terminal Claim beside a submission record, is a fail-closed
consistency error.

For a negative acknowledgement, dead-letter disposition, or release of a
submitted Claim, Core first requires the result and external-effect evidence
specified in Sections 7.6 and 9.4 or an explicit audited operator disposition,
then changes the Claim and removes its submission record in one Core-state
update. An operator disposition is not evidence that repeating the Run is safe;
it must identify the exact Claim and warn that release or retry can repeat an
external effect. A matching active Claim with a submission record and neither
evidence nor an audited disposition remains an unknown outcome. An active Claim
without a submission record may be released after its old Module cgroup is
proven empty only when version 17 also contains no matching
unknown submission history item. When that item exists,
`FileCoreStateStore` rejects ordinary submission creation, acknowledgement,
negative acknowledgement, release, and result-commit acknowledgement before
changing state. Startup recovery likewise preserves the exact active Claim and
fails closed.

Dolly currently has no product command that records an audited operator
disposition and removes an unknown submission history item. A Claim marked this
way therefore remains blocked after migration; the audit requirements below do
not imply that the missing command already exists.

`operator-left-unresolved` is the audit reason code for an operator choice that
deliberately makes no Claim transition: the exact Claim remains active and its
submission record remains unchanged. The code records that review; it is not
no-effect evidence, a terminal disposition, or permission to retry the Run.
A stable code is required because structured audit records cannot use
free-form prose to identify this operator choice consistently.

These journal and Core-state rules support recovery and idempotent replay. They
do not provide exactly-once Module execution or exactly-once external effects;
the at-least-once and idempotency rules in Section 7.6 still apply.

Submission records are never removed by later collection. A stopped process
record is collectable once no submission record references it and no active
Claim belongs to its Module generation. Process-record collection MUST NOT
require the result-commit journal to retain a matching committed record.
Records are kept while a Claim preserved as an unknown outcome belongs to their
Module generation, because the audited operator flow needs the evidence they
carry.

Every terminal Claim transition that has a matching submission record and the
removal of that record are applied as one Core-state update and written once.
If that single write fails, the in-memory state can no longer be proven equal to
the file, so the store fails closed and requires a reopen rather than continuing
from an unproven state.

The Core-state writer must hold the instance controller lock, write and
synchronize the replacement file, atomically rename it, and synchronize its
parent directory where the operating system provides that operation. Fault
injection tests must cover the write, synchronization, rename, and parent
directory synchronization boundaries. A failed or uncertain write is resolved
only by rereading and validating the exact state revision; Core must not infer a
more favorable record combination.

When optional Media state is present, immutable Media records use
`dolly.media/2`, and registration and storage records use
`dolly.media-registration/4` and `dolly.media-storage-record/4`. An issued
provider access grant uses `dolly.media-access-grant/5` but is not itself stored
in the Core snapshot. The Media-store snapshot instead contains
`ProviderAccessRecord` entries: persistent records that associate the issued
uniform resource locator (URL) grant's Media, request, recipient, access mode,
and request status with its
temporary access lease. It never stores a URL or inline bytes. The Media
specification defines their fields, outcome recording, recovery rules, and the
distinction between storage `visibility` and provider `accessMode`.

The file-backed implementation synchronizes each state file before its atomic
rename. On Portable Operating System Interface (POSIX) systems it also
synchronizes the parent directory after the rename, so the durability claim
does not depend on an unsynchronized replacement directory entry. The
file-backed Media byte store likewise synchronizes its directory after hard link
creation and deletion. Windows keeps its existing atomic file operations and
does not open directories as POSIX file descriptors.

The current Block store snapshot is `dolly.block-store/3`. A persisted commit
effect records whether it still holds its strong reference in
`strongReferenceHeld`. Readers MUST reject version 2; the old field is not
inferred or renamed during startup.

The current reference graph snapshot is `dolly.reference-graph/4`, with
`strongReferences` and `leases` as separate reachability sources. Readers MUST
reject version 3 and earlier, the former `dolly.lifetime-graph/3` document, and
its `roots` field. No automatic terminology-based migration is permitted.

## 8. Strong references and access leases

### 8.1 Reachability model

Block and Media lifetime MUST be derived from reachability, not unrelated
integer counters manipulated by callers.

The current built-in persistent-record categories for strong references are:

- `delivery`: an unretired Delivery record references its Block;
- `media-registration`: one concrete persistent Media registration record holds
  its Media item while `holdsRegistrationReference` is true. It may release that
  reference only after another persistent strong-reference path exists;
- `dead-letter`: a retained dead-letter record references its Block; and
- `commit`: an incomplete or retained commit or outbox record
  references its committed output Block until every output Delivery and the
  input acknowledgement cross the recoverable commit boundary.

This closed set is not permission for an Extension or host subsystem to invent
or register another persistent-record category. Unknown `ownerKind` values fail
closed. In particular,
`module` is not currently allowed because Dolly has no concrete persistent
Module retention record to enumerate and cross-check. It may be enabled only
after that record, its bounded lifecycle, and its result-commit validation are
implemented and tested. Console queue/display ownership likewise requires
specific persistent record types and cannot use a generic owner registry.

Required temporary AccessLease categories include `active-claim`, `run-scope`,
and namespaced subsystem access such as `provider-access`. A Media
`ProviderAccessRecord` persists the last category when an issued provider
access grant can outlive the call that issued it. `media-read` protects one
verified Core byte read and Base64 copy; it is released before an inline grant
returns and is released during restore because an in-process copy cannot
survive. `storage-operation` protects Media while an original object is written
or deleted.

Block references and Media references are dependency edges, not independent
strong references. A reachable
Block makes its referenced Blocks and Media reachable.

One `delivery` strong reference remains until every consumer whose subscription
includes that Delivery has reached a terminal disposition (positive
acknowledgement, dead letter, or audited consumer removal) and Page retention
policy permits retirement. A
consumer being offline does not satisfy this rule.

### 8.2 Strong-reference and access-lease APIs

```typescript
interface StrongReference {
  ownerKind: string;
  ownerId: string;
  targetKind: string;
  targetId: string;
}

interface ModuleRetentionChange {
  operation: "add" | "remove";
  retentionKey: string;
  target?: {
    kind: "block" | "media";
    id: string;
  };
  policyId?: string;
}
```

`ModuleRetentionChange` is a future result field, not a currently available
ownership path. The current runtime MUST reject it because the concrete
persistent `module` owner record and its commit cross-checks do not exist yet.

`ownerKind` is the source field naming the type of persistent record that holds
the reference, and `ownerId` identifies one concrete record of that type. Every
such record MUST
be enumerable during recovery. Adding the same owner-to-target reference again
is idempotent, not reference counting; independent lifetimes require different
persistent records.

Creating or removing the same `StrongReference` is idempotent. With persistent
durability, the runtime MUST persist it with the state transition that creates
or retires the persistent record that requires it, or use a recoverable
equivalent.

An access operation that must retain an object across an asynchronous boundary
MUST atomically return a lease token with the immutable object.

```typescript
interface AccessLease {
  leaseId: string;
  ownerKind: string;
  ownerId: string;
  targetKind: string;
  targetId: string;
  kind:
    | "active-claim"
    | "run-scope"
    | "provider-access"
    | "media-read"
    | "storage-operation";
  moduleGenerationId?: string;
  moduleJobId?: string;
  runId?: string;
  expiresAt?: string;
}
```

A Claim lease uses the owner kind `module-job`, with `ownerId` equal to its
`moduleJobId`. Module job identifier allocation uses the same `module-job`
category. The old `processing` owner or allocator kind and old lease field are
rejected during version migration; they are not aliases.

AccessLease release MUST be idempotent by `leaseId`. Releasing an unknown lease
MUST return a diagnosable result; it MUST NOT silently decrement or detach an
unrelated persistent record.

When present, `expiresAt` MUST be the canonical International Organization for
Standardization (ISO) 8601 Coordinated Universal Time (UTC) representation
produced by `Date.prototype.toISOString()`. It is metadata interpreted by the
record or operation that created the lease. The reference graph does not read a clock and
does not release an access lease automatically.

Run-scoped AccessLeases MUST be released automatically when the Run commits,
receives a negative acknowledgement, is cancelled, or is fenced. A Module that
needs a Block after the Run MUST create a persistent strong reference owned by
an enumerable `module` record before its Run lease closes.

Module-owned strong references MUST be enumerable and observable. Generation-scoped
ones are released automatically when their generation is permanently stopped;
explicit durable Module state uses a stable Module owner and declared retention.

A Module manages persistent strong references only through bounded `ModuleRetentionChange`
entries in its serialized result. The runtime derives an owner record identity
from the authenticated `moduleId` plus `retentionKey`; the Module cannot choose
`ownerKind` or another owner identifier. An `add` MUST name a target authorized
by the current run and a configured finite retention policy. Reusing a key for another
target is a conflict. A `remove` is idempotent and can remove only a strong reference owned
by that Module and key. The runtime validates and commits these changes with the
Module job result before input positive acknowledgement. Direct caller-managed
strong-reference mutation is not part of the Module application programming
interface (API).

### 8.3 Collection

An object is collectible only when:

- it has no strong reference or live access lease;
- it is not reachable through another reachable resource's dependency edge;
- its retention policy permits collection.

Time to live (TTL) MAY delay collection after an object becomes unreachable.
TTL MUST NOT make a still-reachable object collectible. TTL age MUST use
internal retention metadata, not a Block event timestamp supplied by a caller.

Collection of a Block and release of its graph edges MUST be atomic or safely
recoverable. Collection MUST NOT leave a Page capable of delivering a missing
Block.

## 9. Module actor and run contract

### 9.1 Serialization invariant

Each Module has exactly one actor. At most one run for one Module
generation may be active at any instant.

This invariant MUST hold across:

- normal scheduler ticks;
- manual triggers;
- safety timeout;
- configuration reload;
- stop and restart;
- late Promise resolution;
- recovery after a Core service restart.

A timeout MUST NOT clear the serialization fence while old code can still run.

Different Module actors MAY run concurrently subject to resource limits.
Promise concurrency in one event loop is not hard isolation and MUST NOT be
described as such.

### 9.2 Run identity and fencing

Every run MUST have:

- a globally unique `runId` within the instance;
- a stable `moduleJobId` that is globally unique within the instance and the
  current attempt number;
- the current `moduleId` and `moduleGenerationId`;
- a matching Claim token or an explicit source activation request;
- a monotonic `startedAt` sample;
- a cancellation signal;
- an output idempotency scope derived from `moduleJobId`.

All reports, outputs, acks, nacks, and scheduler observations MUST carry
`moduleJobId`, `runId`, and `moduleGenerationId`. A result from an old
generation or a Run no longer owned by the actor MUST be fenced and MUST NOT
append output, positively acknowledge input, clear a new timer, or alter a new
Run's state.

The claim authority allocates the `moduleJobId`, `claimToken`, fresh `runId`,
attempt, and current `moduleGenerationId` as one set of identity fields. The
actor MUST use those exact fields; it MUST NOT allocate a second, unrelated run
identity.
Claim inspection and positive and negative acknowledgement operations validate
every member before changing state.
Pending work already bound to a generation is rejected when hard isolation
fences that generation. It may run later only after a fresh claim binds a new
run and generation; the actor MUST NOT silently relabel an old queued claim.

### 9.2.1 Module descriptions

Each Module MAY publish at most one current description for each direction:

- `input`: bounded text describing the input or method semantics it recognizes;
  and
- `output`: bounded text describing the output semantics it may produce.

The runtime stores immutable, revisioned descriptions:

```typescript
interface ModuleDescription {
  schemaVersion: "dolly.module-description/1";
  moduleId: string;
  direction: "input" | "output";
  revision: DecimalSequence;
  text: string;
  provenance: "configuration" | "module-result";
}
```

This schema replaces the unimplemented draft `dolly.premise/2`. Readers MUST
reject that draft, `premiseKind`, `moduleInstanceId`, and the `accepts`/`emits`
values; they MUST NOT accept compatibility aliases.

The runtime assigns identity and revision. A Module may propose replacement text
only as part of its serialized result. Background activity must enqueue an actor
signal before changing a description. Stale generations cannot update it. Description
replacement and the rest of the successful Module result use one atomic or
recoverable commit boundary.

For an invoked Module, the runtime deterministically supplies:

- the output description of every directly connected producer on its input Pages;
- the input description of every directly connected consumer on its output
  Pages; and
- its own current descriptions when configured.

Descriptions are deduplicated by `moduleId` and direction and ordered by `moduleId`.
The invoked Module receives no graph traversal authority.
Stopping, disconnecting, or reconfiguring a Module updates description availability
through revisioned runtime state; the runtime MUST NOT synchronously call
neighboring extension code while assembling an input.

A Module description is descriptive data, not authorization. Its provenance
must cross the Extension process protocol, and consumers MUST treat its text as
untrusted data by default. Promoting fixed, reviewed text to a trusted prompt is
a separate operator configuration action; an Extension cannot promote its own
description. A consumer such as the LLM extension decides how to delimit the
text under its prompt trust policy.

### 9.3 Input and output

A Module receives immutable Block delivery groups and a snapshot of adjacent
capabilities or descriptions. Pulling arbitrary neighboring Module code during the
critical run path is forbidden.

A Module result contains either no BlockProposal or exactly one BlockProposal per
Run. The future complete result contract MAY also contain replacement
input/output Module descriptions plus bounded `ModuleRetentionChange` entries;
the current runtime rejects those fields until their persistent records and
commit cross-checks exist. Description and retention updates are metadata, not
additional Blocks. This preserves the owner's single-result action model: one
accepted Block is broadcast through one Delivery on each configured output
Page. A proposal does not contain core identity, source, sequence, delivery
metadata, local paths, or credentials.

Before it writes a `prepared` Module result commit record, Core MUST apply the
following validation rules for a Delivery Claim. Here, a `prepared` record
is the durable journal record saved before Core commits its Block, output
Deliveries, and acknowledgement; the word describes commit progress, not a
second kind of Module result.

- The Claim MUST be active and have one exact, valid Module submission record.
- The result `source` MUST identify the Claim's consumer Module exactly.
- Each `media-reference` in the optional output Block MUST reuse a `mediaId`
  found in a `media-reference` of one of that Claim's input Blocks. A resolver
  lookup alone is not enough.
- If at least one delivered reference for that `mediaId` has no `crop`, the
  output may use the full Media or any otherwise-valid crop. If every
  delivered reference for that `mediaId` has a crop, the output MUST include a
  crop wholly contained in one individual delivered crop. It MUST NOT restore
  the full image, enlarge a delivered crop, or combine separate delivered
  crops into a larger region.

While the Claim remains active, the same validation MUST run again before each
new Block or output Delivery effect. It prevents a tampered or stale journal
record from bypassing the check during recovery. If the Claim is already
`committed` and the submission record is absent, recovery may only verify that
the `prepared` journal already records every required effect and that every
effect exists with the same identifiers and content; it then changes only the
journal to `committed`. It MUST NOT recreate a missing effect, acknowledge the
Claim again, or depend on input Deliveries that may already have been pruned.
These rules also mean that a Module result cannot introduce Media registered
during that run, nor make a Media reference valid by presenting a different
grant issued by trusted Core. Those flows need separately specified host
operations.

This is a restriction on a Module result, not a general restriction on
trusted Core. A trusted Core caller that commits a Block directly, such as
external ingress, follows the ordinary Block validation rules but is not
limited to a Delivery Claim's input Media. These rules also do not
provide an Extension Media-read capability: the isolated Extension runtime is
still disabled.

To complete a positive acknowledgement, the runtime MUST perform these steps
in order:

1. validate the optional proposal, optional Module description replacements, retention
   changes, and all referenced capabilities;
2. assign core Block fields when a proposal is present;
3. commit the optional Block idempotently under `moduleJobId`;
4. append its output-Page deliveries through a transaction or durable outbox;
5. commit any Module description replacements and retention changes under the same
   Module job result;
6. in one Core-state update, commit the input positive acknowledgement and
   remove the matching Module submission record;
7. close run-scoped AccessLeases;
8. change the Module result commit journal record from `prepared` to
   `committed`; and
9. publish completion metrics and events.

If this sequence cannot complete, recovery MUST be able to determine whether
the run was committed. Re-execution MUST not duplicate already committed
outputs.

The current Module-result digest envelope is `dolly.module-job-result/1`.
It canonically describes the submitted result input only: its validated
`source`, the normalized optional Block proposal (or explicit absence), and
the ordered output Page identifiers. The assigned Block identifier, output
Delivery identifiers, acknowledgement, Module-description revisions, and
retention changes are Core effects, not fields in this version of the digest.
Any later result shape that adds description or retention data MUST use a new
digest schema version rather than changing the meaning of
`dolly.module-job-result/1`.
If that result is durable but completion of positive acknowledgement is
interrupted, recovery finishes the remaining commit and outbox work without
invoking the Module again. A later Run that presents a result conflicting with
an already committed `moduleJobId` MUST be rejected and MUST NOT replace the
first result.

The Module result commit record uses `dolly.module-result-commit/1`; its
file-backed repository uses `dolly.module-result-commit-repository/1` and the
file name `module-result-commits.json`. The configured byte bound is
`maxModuleResultCommitJournalBytes`. A runtime that finds the legacy
`processing-commits.json` file MUST stop and require an explicit offline
migration or reject startup. It MUST NOT silently ignore the old file and begin
with an empty repository.

The current Module result commit coordinator requires an exact Delivery Claim,
its valid Module submission record, and the Core-state operation that both
positively acknowledges that Claim and removes the record. It verifies the two
postconditions before advancing the journal and enforces the allowed recovery
combinations above. It therefore defines a completion boundary only for
reactive Module jobs. The first runtime MUST reject periodic, source, and manual
activation. Source and manual support requires a separate, specified completion
boundary rather than a fabricated empty Delivery batch. The product bootstrap
still rejects every configured Module. Linux process-control, process-execution,
and stop-proof implementations exist, but `runtime-bootstrap.ts` does not
construct or connect them to the reactive runtime, result coordinator, and
external-effect evidence source. These remaining gaps still prevent product
startup from activating a Linux Module.

### 9.4 Cancellation and timeouts

Every run receives an `AbortSignal` or equivalent cancellation capability.

For process isolation, Core synchronously obtains the executor handle described
in Section 5.1, then invokes `start()` without issuing a Claim. Core MUST NOT
consider the actor ready until `start()` succeeds within
`initializationTimeoutMs`. If initialization fails or that wait expires, Core
MUST use the already returned handle to request termination, observe the late
`start()` settlement, and prevent that operation from reopening resources. It
MUST NOT execute the Module or create a replacement executor until termination
is confirmed. Unconfirmed termination leaves the actor unavailable and
requires a later stop or recovery attempt.

A **soft timeout** requests cooperative cancellation. Until the old Run exits
or process isolation proves that its Module generation has been fenced, the
actor remains occupied and MUST NOT start a replacement Run.

A **hard timeout** is conformant only when the runtime can terminate or isolate
the execution context, such as a Worker or subprocess, then advance the Module
generation. An in-process Promise that is merely ignored is not a hard timeout.

For a process executor, handling a hard timeout and shutting down both require
`terminate()` to provide the proof defined in Section 5.1. Each wait may end
after `terminationTimeoutMs` and report that termination is unconfirmed, but
the `terminate()` Promise continues. Core MUST retain it and observe it again
during a later `stop()` call. Core MUST NOT invoke a second termination
operation while that Promise is pending, invoke cooperative `stop()` in
parallel, advance the generation, or release the active Claim without proof
that the executor stopped.

If hard isolation is unavailable, the runtime MUST expose that limitation and
MUST choose one of:

- wait while marking the Module unhealthy;
- fail the containing instance;
- request operator intervention.

It MUST NOT overlap the timed-out run with a new run.

For the proposed Linux Module runner, the preceding portable `terminate()`
promise is not the production termination proof. Initialization, hard timeout,
orderly stop, protocol failure, and replacement use the ADR 0009 Linux execution
backend. Once a kernel file has shown any member, that backend terminates the
entire Module cgroup and Core waits for the protocol channel to close,
`cgroup.events` to report `populated 0`, directory removal, and applicable
capability handlers to reach a terminal state. Exact launcher-only membership
remains a prerequisite for sending `execute`, but a failed exact check does not
erase the observed member or the whole-group termination duty. A direct child
exit, a process identifier, or a Node.js child-process handle does not permit
generation fencing, Claim disposition, or replacement.

Before any member is observed, Core may complete cleanup only when execution
authorization is known not to have begun delivery, the reviewed launcher's
exit is observed through its protected control channel, a fresh
`cgroup.events` reading reports `populated 0`, and the prepared directory is
removed. If launcher exit or `execute` delivery is uncertain, Core exits with a
failure status and lets the Core service cleanup perform the only safe outer
group termination.

When orderly shutdown begins before Core starts handling a hard timeout,
shutdown cancellation wins: timeout callbacks MUST NOT start failure handling,
and Core follows the rules for releasing a Claim in Sections 7.6 and 15.1 after
proof that the executor stopped. When Core has already started handling a hard
timeout, the outcome remains an input to failure classification after confirmed
termination; a concurrent shutdown MUST NOT convert it to shutdown
cancellation or release its Claim as if no failure occurred.

Execution completion and host result acceptance are distinct serialized
phases. Before invoking the recoverable Module result commit path, the actor MUST
atomically leave the execution phase and enter result acceptance. Soft and hard
execution timeouts are invalid after that transition: termination at that point
could race a commit that already took effect and manufacture a conflicting
retry. Shutdown waits for result acceptance or its durable recovery decision.
If acceptance returns a confirmed commit, that commit wins a concurrent stop or
cancellation request. If acceptance fails without proving whether the commit
took effect, the Module result commit outcome is unknown; blind Module
re-execution is forbidden until Module result commit recovery resolves the
durable state.

The first Linux Module runner supports only reactive activation. It does not
start background services, periodic/source/manual activation, dynamic Module
reload, or any runless capability operation. Those wider runtime concepts remain
Draft contracts for a later separately accepted profile; they must not silently
appear in this path. During initialization, Module creation, stopping, shutdown,
and background-free idle time, the Extension has no authority to make an external
or persistent effect. Every effect in the first path occurs through a durable
Core capability while an exact active Claim and Run exist, and the runner
automatically activates only a Module whose configuration declares
Core-capability-only external effects as required by Section 5.2.

### 9.5 Background activity

Extensions may maintain background services, as anticipated by the owner's
original model, but those services MUST be registered with Core and governed by
the Module actor. They are not available in the first Linux Module runner
described in Section 9.4.

Background work:

- receives the Module generation cancellation signal;
- MUST stop or be isolated during generation shutdown;
- MAY submit a bounded source activation request with a stable
  `idempotencyKey`; the runtime turns that request into a serialized Module job
  and Run;
- MUST emit a Block only as the optional result of that actor run, never directly
  from the background task;
- MUST use runtime capabilities for storage or temporary access leases;
- MUST NOT mutate Page, BlockStore, or actor state behind the runtime;
- MUST NOT bypass mailbox bounds or output validation.

## 10. Lifecycle state machine

Each Module generation follows this state machine:

```text
CREATED -> INITIALIZING -> READY -> RUNNING -> QUIESCING -> STOPPED
                         |         |            |
                         +-------> FAILED <-----+
```

Required transition behavior:

- `initialize` is legal only from CREATED.
- Under process isolation, initialization synchronously obtains an executor
  handle and then awaits that executor's `start()` operation under
  `initializationTimeoutMs`, as specified in Sections 5.1 and 9.4. This
  executor operation is part of INITIALIZING and is distinct from the Module
  generation transition named `start` below.
- A failed initialize transitions to FAILED and triggers rollback of all
  resources, strong references, access leases, and background tasks acquired
  during initialize. Rollback of a process executor is not complete until its
  `terminate()` operation proves the process stopped and an unfinished
  executor `start()` cannot reopen resources.
- `start` is legal only from READY and is idempotent while RUNNING.
- `quiesce` stops new claims and triggers but permits the active run a bounded
  grace period.
- `stop` is idempotent and completes only after active execution and registered
  background work have exited or been hard-isolated. For a process executor,
  only successful `terminate()` completion supplies that proof; cooperative
  `stop()` does not.
- A bounded caller wait that expires before this proof returns an explicit
  incomplete-stop result and leaves the generation QUIESCING; it MUST NOT
  report STOPPED. A later `stop()` call observes the same still-pending
  `terminate()` Promise. It does not start a concurrent termination operation.
- Restart creates a new generation. It never reuses the old generation token.
- Starting a permanently STOPPED generation is forbidden.

The runtime instance controller MUST implement an equivalent state machine and
transactional initialization. Partial initialization MUST be rolled back in
reverse ownership order.

## 11. Activation modes

Every Module MUST declare one primary activation mode. A future accepted Extension process protocol
may define explicit combinations, but implicit hybrid behavior is forbidden.

The product bootstrap still rejects all configured Modules. The Scheduler
component implements one narrow delivery-backed periodic policy for scientific
and deterministic component testing: a periodic registration with input Pages
and `allowEmptyInput: false` uses the same runtime tick shape as a reactive
registration. The verified Extension composition does not activate it, because
package manifest version 1 can declare only reactive support and version 2 is
reserved for the complete schema-registry contract. Periodic and source process
activation remain future contract requirements.

### 11.1 Reactive mode

A reactive Module becomes eligible when at least one input delivery is pending.
The runtime MAY debounce or coalesce arrivals within configured bounds. It MUST
not invoke the Module with an empty input solely because a timer fired.

Reactive mode is the recommended default for transformation and sink Modules.

### 11.2 Periodic mode

A periodic Module becomes eligible according to a configured target period. At
eligibility it claims currently pending input. Configuration MUST state whether
an empty-input run is allowed.

The current Scheduler component permits only `allowEmptyInput: false`. Its first
run becomes eligible when pending input is first observed. Every later
eligibility is start-to-start as defined below. Waiting for a declared future
period is not reported as no progress. This is Scheduler behavior, not process
activation support. Empty-input periodic execution needs a durable trigger
identity independent of a Delivery Claim and remains rejected.

The target period is defined as the desired interval between run **start
times**, not the delay after a run finishes.

Let `S_n` be the monotonic start time of run `n` and `P_n` its selected period.
The next eligibility time is:

```text
E_(n+1) = S_n + P_n
wait = max(0, E_(n+1) - monotonicNow)
```

If a run exceeds its period, the next run is eligible immediately after the
actor becomes idle, subject to backpressure and policy. The default MUST NOT
launch catch-up bursts for every missed period. Missed periods MUST be counted
as an observable metric.

### 11.3 Source mode

A source Module has no input Pages. It is activated by a periodic, external, or
manual source activation request declared in configuration. Each request has a
unique idempotency key.

The protocol design maps that idempotency key to a `moduleJobId`; retries
preserve it while individual Run identifiers change. Duplicate submission with
the same live idempotency key MUST NOT create a second source Module job.

This mapping is not implemented by the current Delivery-based result commit
coordinator. Source and manual activation remain specified future behavior and
MUST be rejected by the first runtime as stated in Section 9.3.

A source MUST still obey actor serialization, mailbox bounds, generation
fencing, output transactions, and backpressure. Downstream congestion may delay
or reject source activation according to policy.

### 11.4 Clock requirements

Durations, deadlines, periods, and scheduler calculations MUST use a monotonic
clock. Wall clock MAY be recorded for human-readable events but MUST NOT drive
correctness.

Jitter MUST be explicit, bounded, and observable. Deterministic tests MUST be
able to inject a fake clock and deterministic random source.

## 12. Bounded mailboxes and backpressure

Every runtime configuration MUST set finite limits for:

- pending delivery count and serialized bytes per consumer;
- retained Page log count and bytes;
- claim batch count and bytes;
- pending source or manual activation requests per Module;
- active Module actors instance-wide;
- Block payload, reference, Media, and expansion sizes;
- retry and dead-letter storage.

Serialized byte accounting MUST be deterministic and documented.

When a limit is reached, the runtime MUST apply an explicit policy. Permitted
policies include:

- reject or delay the producing commit with a backpressure result;
- pause eligible upstream actors;
- spill to a configured durable store;
- route to a configured dead-letter Page;
- fail the affected Module or instance.

Silent dropping is forbidden. An overwrite-oldest policy is forbidden in the
default configuration. Any lossy experimental configuration MUST identify every
dropped Delivery and expose counters and structured events.

If output backpressure prevents transaction completion, input MUST remain
unacknowledged. Retried output commit MUST use the stable Module job
idempotency scope.

Cycles are allowed in the Page graph, but bounded mailboxes can create cyclic
wait. A scheduler or operator policy MUST detect sustained no-progress states
and expose the blocked dependency cycle. Correctness MUST not depend on
unbounded buffering.

## 13. Scheduler policy boundary

### 13.1 Correctness versus policy

The Module actor owns serialization, claims, run fencing, and lifecycle. The
scheduler policy only decides when an already-correct actor is eligible to run
or when an upstream actor should be throttled.

No policy decision may:

- start a second run for a busy actor;
- positively acknowledge, negatively acknowledge, prune, or mutate Deliveries;
- release a strong reference or access lease;
- bypass mailbox limits;
- accept a stale run report;
- change a Module generation.

### 13.2 Policy interface

A scheduler policy SHOULD be a versioned, deterministic component with a
conceptual interface like:

```typescript
type DownstreamAvailability = "available" | "blocked" | "unknown";

interface DownstreamPressure {
  moduleId: string;
  availability: DownstreamAvailability;
  pendingCount: number;
  pendingBytes: number;
  maxPendingCount: number;
  maxPendingBytes: number;
}

interface SchedulerSnapshot {
  moduleId: string;
  moduleGenerationId: string;
  activationMode: "reactive" | "periodic" | "source";
  monotonicNow: number;
  actorBusy: boolean;
  pendingCount: number;
  pendingBytes: number;
  oldestPendingAgeMs: number;
  arrivalsDuringLastRunCount: number;
  arrivalsDuringLastRunBytes: number;
  lastRunServiceTimeMs?: number;
  retryCount: number;
  downstream: readonly DownstreamPressure[];
}

interface SchedulerDecision {
  eligibleAt: number;
  claimLimitCount: number;
  claimLimitBytes: number;
  reasonCode: string;
  policyName: string;
  policyVersion: string;
}
```

`claimLimitCount` and `claimLimitBytes` are executable batch parameters, not
observability fields. The scheduler MUST pass the exact validated decision
values to the runtime tick that it dispatches, and the runtime MUST use them for
that tick's Delivery Claim. Per-Module runtime configuration supplies hard
maximum count and byte limits; a decision outside those maxima MUST fail before
claiming input. Direct runtime callers that omit per-dispatch values use the
configured maxima.

`oldestPendingAgeMs` MUST NOT reset merely because the Scheduler process or its
monotonic clock restarted. When the Delivery reader supplies the canonical
persisted `oldestEnqueuedAt`, the Scheduler computes its age once against an
injected wall-clock reading, maps that age onto the current monotonic epoch, and
then advances it only with the monotonic clock until the oldest Delivery
changes. A reader that cannot supply the optional timestamp falls back to age
since first observation. A malformed timestamp or invalid clock reading makes
that mailbox unavailable; it MUST NOT be treated as zero-age or free capacity.
The wall-clock reading MUST be a non-negative integer within the platform Date
range, and it MUST be at or after the persisted enqueue time. A future enqueue
time is evidence of clock rollback or inconsistent storage and fails closed;
the Scheduler does not hide it behind a zero-age clamp.

**Downstream pressure** is the read-only count and byte report for one
downstream Module in this snapshot. `available` means that the scheduler has
confirmed capacity under its configured bounds, `blocked` means that it has
confirmed no capacity, and `unknown` means that it cannot confirm either.
This report is scheduler input only: it is not an authorization, capability,
or control message.

Snapshots MUST report per-consumer pending state. A Page's total retained record
count is not a substitute for one consumer's lag.

Service time MUST include all work inside the run transaction boundary or name
separate Module, media, output commit, and total latencies explicitly.

For fan-out graphs, a policy MUST define how all downstream pressure signals are
aggregated. Results MUST NOT depend on callback completion order. For cycles,
the policy MUST define damping, stability limits, and no-progress detection.

### 13.3 Baseline policy

The Scheduler component uses a simple fixed policy:

- reactive Modules run when data is pending and the actor is idle;
- non-empty periodic Modules run at most once per start-to-start period when
  input is pending; missed periods are counted and never replayed as a burst;
- empty periodic and source Modules are rejected until their later Module job
  and completion contracts are implemented;
- bounded queues apply deterministic backpressure;
- retries use bounded exponential backoff with documented limits.

This baseline is required before evaluating adaptive scheduling.

### 13.4 Additive increase/multiplicative decrease (AIMD) status

Additive increase/multiplicative decrease (AIMD) is an experimental scheduler
policy, not a core requirement.

An AIMD experiment MUST specify and test:

- whether it controls rate, period, batch size, or more than one variable;
- the exact additive and multiplicative operations and units;
- count and byte pressure, including large multimedia payloads;
- aggregation across multiple downstream consumers;
- behavior for sources, sinks, self-loops, fan-in, fan-out, and cycles;
- interaction with retries and output backpressure;
- stability, convergence, throughput, latency, fairness, and cost baselines;
- parameter provenance and sensitivity;
- deterministic simulation and representative real workloads.

Hard-coded factors or thresholds without this evidence MUST NOT be defaults.
An adaptive policy MUST be selectable and reversible without changing Page,
Block, claim, or Module correctness.

## 14. Failure semantics

| Condition | Required behavior |
| --- | --- |
| Module throws or rejects | For a Run proven not submitted under Section 7.7, classify under policy. For a submitted Run, first require the result journal and every possible external effect to have no-effect or retry-safe evidence; a terminal effect outcome alone does not prove that repeating the Run is safe. Otherwise retain the exact Claim as an unknown outcome. Any permitted Claim disposition removes the matching submission record in the same Core-state update. Close run-scoped AccessLeases only when that disposition is durable and keep the actor serialized. |
| Invalid BlockProposal | Commit no output Block or Delivery. A submitted Run may be negatively acknowledged or entered in dead letter only after the same external-effect evidence rule, with Claim transition and submission-record removal in one Core-state update; otherwise preserve its Claim as an unknown outcome. |
| Missing Block or Media reference | Reject before commit; do not create a partial Block. |
| Soft timeout | Signal cancellation; mark unhealthy; do not overlap a replacement run. |
| Hard timeout with isolation | For the Linux Module runner, prove whole-Module-cgroup termination, protocol closure, and terminal capability handlers, then apply the submission/effect evidence rule before fencing, classification, or Claim disposition. A permitted terminal disposition and matching submission-record removal use one Core-state update. If any proof or evidence is missing, keep the Claim active, report recovery required or unknown outcome, and do not start a replacement. |
| Output store unavailable | Leave input unacknowledged and retry through idempotent outbox and commit recovery. |
| Mailbox full | Apply configured backpressure; never silently discard. |
| Scheduler policy failure | Fall back to a declared safe fixed policy or fail visibly; do not alter delivery state. |
| Initialization failure or timeout | Use the synchronously returned executor handle to terminate the process and prevent a late `start()` from reopening resources; issue no Claim and start no replacement without proof that the process stopped. |
| Termination wait expires | Report that termination is unconfirmed and retain the same `terminate()` Promise for a later `stop()` call; do not invoke process `stop()` as substitute proof. |
| Shutdown cancellation | If shutdown began before Core started handling a hard timeout, stop new claims, request cancellation, preserve any result acceptance already in progress, and prove the required process termination. Release the exact Claim only when submission/effect evidence permits it, removing a matching submission record in the same Core-state update; otherwise preserve the Claim as an unknown outcome. Do not blindly classify, negatively acknowledge, enter in dead letter, or increase `failedAttemptCount`. |
| Claim release persistence is uncertain | Flush pending persistence and inspect the exact Claim and submission record. If state `released` and absence of the matching submission record cannot both be confirmed, report `RUNTIME_RECOVERY_REQUIRED` and retain the Claim identity for a later `stop()` call. |
| Process crash | On restart, verify the Core service and old Module cgroups, reconcile the commit journal and outbox, then reread one complete version 17 Core-state update. After all old processes are proven stopped, the absence of both a submission record and an exact unknown submission history item proves `never-authorized-to-send`; a matching unknown submission history item instead preserves the active Claim and blocks startup. A terminal Claim with a submission record fails closed. If submitted-Run evidence is unavailable, block Module activation or retain an unknown outcome instead of acknowledging, negatively acknowledging, retrying, releasing, or entering it in dead letter. |

Errors crossing the core boundary MUST use stable machine-readable codes plus a
human-readable message and structured cause. Raw secrets, credentials, and
unredacted payloads MUST NOT appear in default error output.

The terminology-sensitive codes are exact. Claim validation uses
`CLAIM_MODULE_JOB_MISMATCH` and `CLAIM_ITEM_OVERSIZE`; Module job lifecycle uses
`MODULE_JOB_INPUT_PAGE_SET_CHANGED` and `MODULE_JOB_ALREADY_ACTIVE`. Module
result validation uses `MODULE_JOB_ID_INVALID`, `MODULE_JOB_RESULT_CONFLICT`,
`MODULE_JOB_CLAIM_NOT_ACTIVE`, `MODULE_JOB_SOURCE_MISMATCH` when a result
names a source other than its Claim's consumer Module, and
`MODULE_JOB_OUTPUT_INVALID` when the proposed output is malformed or violates
these rules, including an undelivered Media reference or an invalid
crop reuse. Module result commit recovery uses `MODULE_RESULT_COMMIT_RECORD_MISSING`,
`MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT`,
`MODULE_RESULT_PERSISTED_STATE_CONFLICT`,
`MODULE_RESULT_OPERATION_CONTRACT_VIOLATION`,
`MODULE_RESULT_COMMIT_DOCUMENT_INVALID`,
`MODULE_RESULT_COMMIT_LIMIT_EXCEEDED`, `MODULE_RESULT_COMMIT_LOCKED`, and
`MODULE_RESULT_COMMIT_IO_FAILED`.
`MODULE_RESULT_PERSISTED_STATE_CONFLICT` means the persisted Claim,
submission record, result journal, Block effect, or Delivery effect contradicts
another persisted part of the same commit. `MODULE_RESULT_OPERATION_CONTRACT_VIOLATION`
means an operation that must finish synchronously returned a Promise or another
thenable value; it does not assert that persisted state is inconsistent.
Removed names are not compatibility aliases.
The runtime reports `RUNTIME_RECOVERY_REQUIRED` when it cannot safely determine
a result commit, termination, failure classification, or the outcome of
releasing a Claim. Startup reports `STARTUP_ACTIVE_CLAIM_UNRESOLVED` when an
active Claim lacks durable records of process state and result submission that
are needed to continue safely, including an active Claim whose missing version
16 submission record cannot be interpreted.

## 15. Stop and recovery

### 15.1 Graceful stop

Instance stop MUST proceed in this order:

1. transition the instance to QUIESCING;
2. reject new external/source/manual triggers;
3. stop issuing new claims;
4. signal active runs and background services;
5. wait for the configured grace period;
6. for each remaining process execution, await the applicable termination
   proof. The Linux Module runner requires whole-Module-cgroup termination, a
   closed protocol channel, `cgroup.events` reporting `populated 0`, and
   terminal capability handlers; a direct child exit is insufficient. If the
   bounded wait expires, report recovery required and retain the same
   termination operation for a later `stop()` call;
7. finish or recover result acceptance that began before shutdown; a confirmed
   commit wins, its Claim remains `committed`, and no matching submission record
   remains;
8. after termination proof, apply the submission and external-effect evidence
   rule to an active Claim for a Run cancelled because shutdown began before Core
   started handling a hard timeout. Release it only when that rule permits; else
   preserve the exact Claim as an unknown outcome. Do not blindly send it to
   failure classification, negative acknowledgement, or dead letter. If a
   matching submission record exists, record `released` and remove that record
   in the same Core-state update;
9. flush release persistence and inspect the exact Claim and submission record
   when the release result is uncertain; report `RUNTIME_RECOVERY_REQUIRED` and
   retain its identity unless state `released` and absence of the matching
   submission record are both confirmed;
10. finish the failure path for any hard timeout whose handling began before
    shutdown, without converting it to shutdown cancellation;
11. release generation-scoped access leases and strong references;
12. flush and close stores, logs, interprocess communication (IPC), and other
    owned resources;
13. transition to STOPPED.

`stop()` MUST be awaitable and idempotent. Returning from stop means no old run
can later append output or mutate runtime state. For a portable process executor,
`stop()` MUST NOT report success until `terminate()` supplies the proof defined
in Section 5.1. The Linux Module runner instead requires the Section 9.4 group
proof. It MUST NOT invoke cooperative process `stop()` concurrently as a
substitute. A `RUNTIME_RECOVERY_REQUIRED` result leaves the instance outside
STOPPED and permits a later `stop()` call to observe the same pending termination
or reconcile the same Claim disposition.

### 15.2 Startup recovery

With `persistent` durability, before Modules enter READY, recovery MUST:

- acquire the instance controller lock and, for the Linux Module runner, verify
  the current Core service binding and every old Module cgroup according to ADR
  0009 before it starts or signals a Module;
- validate Block and Delivery log integrity;
- reconcile incomplete Block, output Delivery, and positive acknowledgement
  transactions;
- revalidate the source and Media-reference boundary of every `prepared`
  Module result commit record before resuming its effects;
- replay the durable outbox idempotently;
- recover Module result journal records through the Section 7.7 boundaries,
  reread one complete Core-state update, and then interpret each active Claim
  with its matching process and submission records plus external-effect evidence;
- release only a Claim with no submission record after every old Module process
  is proven stopped and version 17 also has no exact
  unknown submission history item; report that release as
  `never-authorized-to-send`;
- preserve a Claim with an unknown submission history item and any submitted
  Claim without safe evidence as an unknown outcome; and
- fail closed on an orphan, identity mismatch, terminal Claim with a submission
  record, or any committed journal record beside an active Claim;
- restore consumer checkpoints, Module jobs, and strong references;
- advance every restarted Module generation;
- quarantine corrupt records rather than silently skipping them;
- expose a recovery summary.

After Core state is parsed and validated, a runtime with Media enabled MUST
remove expired compact deleted-registration records, recover `deleting` Media
registrations, recover `pending` registrations, verify bytes for available
Media, and reconcile persistent uploads, in that order. Deletion recovery
precedes byte verification because an interrupted, durably recorded deletion
may already have removed local bytes. Upload reconciliation follows local-byte
verification so a persistent adapter never receives unverified original bytes.
After that work, it calls `markProviderAccessUnknownAfterRestart`: every
URL-based provider access record still awaiting a result becomes
`result-unknown` and retains its access lease. It MUST NOT infer a completed
fetch from signed-URL expiry or restart. The runtime then reconciles configured
Page topology before it makes Modules ready.

An implementation MUST distinguish a clean stop from crash recovery.

Startup reconciliation reports the following codes. An active Claim reports
`STARTUP_ACTIVE_CLAIM_UNRESOLVED` when Module-record operations are unavailable,
when its exact unknown submission history item exists, or when submitted-Run
evidence cannot support a safe disposition. A Claim written under version 17
rules with neither a submission record nor an unknown submission history item
does not use that error: after every old process is proven stopped, recovery releases it as
`never-authorized-to-send`. `STARTUP_MODULE_PROCESS_UNPROVEN` means an old
process record is not `stopped` and no accepted proof showed its Module cgroup
empty; startup never assumes a process died.
`STARTUP_MODULE_RECORD_INCONSISTENT` means that a submission record cannot be
linked to its exact active Claim, or that an unknown submission history item is
not unique, does not contain exactly the five Claim identity fields, does not
match its exact active Claim, overlaps a submission record, or disagrees with
the store's exact-identity query.
`STARTUP_CLAIM_RELEASE_UNCONFIRMED` means startup cannot synchronously confirm
all parts of a permitted release: the exact Claim is `released` in the Delivery
store recovery is reading, its submission record is absent, and no exact
unknown-submission-history item remains.
`STARTUP_JOURNAL_CLAIM_INCONSISTENT` means either that result-journal recovery
rejected a combination of journal record, Claim, submission record, Block
effect, or output Delivery effect, or that a journal record still exists beside
an active Claim after recovery. A Claim preserved as an unknown outcome is
reported, never silently acknowledged, negatively acknowledged, retried,
released, or recorded in dead letter.

Malformed Core-state JSON, an invalid document schema or digest, and a
submission record that does not match its active Claim, process record, and
persisted input are rejected earlier by the current file-based Core-state
store (`FileCoreStateStore`) as `CORE_STATE_DOCUMENT_INVALID`.
`CoreStartupRecovery` is constructed only after that store opens, so those
document errors are not converted into a `STARTUP_*` code.

`FileCoreStateStore` makes each terminal Claim transition and matching
submission record removal one Core-state update. The result coordinator
enforces the journal order above. `CoreStartupRecovery` converts
`MODULE_JOB_ID_INVALID`, `MODULE_JOB_RESULT_CONFLICT`,
`MODULE_JOB_CLAIM_NOT_ACTIVE`, `MODULE_JOB_SOURCE_MISMATCH`,
`MODULE_JOB_OUTPUT_INVALID`, `MODULE_RESULT_COMMIT_RECORD_MISSING`,
`MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT`, and
`MODULE_RESULT_PERSISTED_STATE_CONFLICT` into
`STARTUP_JOURNAL_CLAIM_INCONSISTENT`. It passes document, size-limit, lock,
input/output, and synchronous-operation-contract failures through unchanged;
those errors do not prove a persisted Claim inconsistency. Recovery keeps a
migrated Claim with unknown submission history unresolved and permits no
ordinary Claim transition. These checks preserve, rather than repair or guess
through, the historical version 15 and version 16 ambiguity described in
Section 7.7. Startup accepts Module-cgroup stop proof and external-effect evidence
through injected interfaces. The Linux stop-proof implementation exists, but
`runtime-bootstrap.ts` does not pass it to startup recovery. The effect-intent
record protocol, file store, recovery adapter (`effectIntentEvidenceSource`),
and an Extension Host effect lifecycle also exist. When explicitly configured,
that lifecycle resolves the already persisted Module submission, opens its
exact Run, records every invocation of a granted handle, and closes the
complete intent set after capability handlers settle. Dolly product startup
does not construct that lifecycle or pass the recovery evidence source, so it
remains a product-before-bootstrap component; `runtime-bootstrap.ts` still
passes no external-effect evidence source.
Consequently, any process record that is not already `stopped` fails product
startup as unproven. With no Module records at all, which is every
product-created deployment while Modules are rejected, behavior is unchanged.

A runtime with `volatile` durability starts from explicitly empty state after
process loss and reports that no restart recovery was attempted; it MUST NOT emit a
misleading successful recovery summary for state it could not preserve.

### 15.3 Stale work

Late completion from a fenced run MUST be ignored for state mutation and
recorded as `run.stale_result`. It MUST NOT:

- emit Blocks;
- positively or negatively acknowledge a current Claim;
- clear a current timer or cancellation signal;
- release current-generation AccessLeases;
- mark a current actor idle.

## 16. Observable invariants

The runtime MUST expose enough structured information to verify this contract
without reading private internal fields.

Required per-Module status includes:

- lifecycle state and generation;
- current input/output Module description revision, provenance, and
  byte size without description text by default;
- active run ID, start time, cancellation state, and claim ID;
- activation mode and scheduler policy/version;
- pending count and bytes per input consumer;
- current backpressure state;
- retry and dead-letter counts;
- retained strong-reference and access-lease count by kind;
- last success, failure, service time, and total transaction time.

Required instance-wide status includes:

- durability;
- Block, Delivery, Page log, strong-reference, and access-lease counts/bytes;
- oldest pending delivery age;
- outbox and recovery state;
- the count of URL-provider access records marked unknown during this startup;
- unhealthy, quiescing, stopped, and failed Modules;
- invariant violation count.

The current read-only runtime status value uses `dolly.runtime-status/3`.
Its `providerAccessMarkedUnknownCount` field is the count above. It reveals no
Media ID, URL, request ID, recipient, or credential; the status field MUST NOT
be used as a detailed Media inspection interface.

Required structured events include at least:

- `block.committed` and `block.collected`;
- `delivery.appended`, `delivery.claimed`, `delivery.acked`,
  `delivery.nacked`, and `delivery.dead_lettered`;
- `root_edge.created`, `root_edge.removed`, `access_lease.created`,
  and `access_lease.released`;
- `run.started`, `run.cancel_requested`, `run.completed`, `run.failed`,
  `run.fenced`, and `run.stale_result`;
- lifecycle transitions;
- `module-description.updated` and `module-description.unavailable` with Module
  identity, direction, revision, provenance, and size but no text by default;
- scheduler decisions with reason and input snapshot summary;
- backpressure enter/exit and no-progress detection;
- recovery start/result and invariant violations.

Events MUST carry `instanceId`, `moduleId` where applicable,
`moduleGenerationId`, `moduleJobId`, `runId`, and relevant Block, Delivery,
and claim identifiers. Payload contents MUST be excluded by
default. Trace-level payload logging must be explicit, access-controlled,
bounded, and redacted according to security policy.

## 17. Runtime invariant checks

A debug or audit mode SHOULD continuously check:

1. no Block ID has more than one immutable record;
2. every committed Block reference resolves to a lower sequence;
3. every live Delivery resolves to a Block;
4. every active claim belongs to exactly one consumer and actor generation;
5. one Module generation has at most one active run;
6. every positive or negative acknowledgement token matches its Run, Claim,
   consumer, and generation;
7. every Module job ID maps to at most one committed output Block and Delivery
   set;
8. every collected object is unreachable from all strong references and access leases;
9. every pending mailbox and store remains within configured bounds;
10. no STOPPED Module generation owns a run, background task, strong reference
     scoped to that generation, or live access lease.
11. every visible ModuleDescription has one stable Module owner, a monotonic
    revision, and no update accepted from a stale Module generation.
12. for the Linux Module runner, no replacement Module generation starts until
    the old Module cgroup is proven empty, its protocol channel is closed, and
    applicable capability handlers are terminal.
13. every submission record matches exactly one active Claim, no terminal Claim
    has a submission record, and every active Claim has the process and optional
    submission-record relationship defined in Section 7.7; a submitted Claim
    without a committed result has explicit external-effect evidence or remains
    an unknown outcome.

Violation of an invariant MUST produce a structured high-severity event. A
production runtime SHOULD fail closed or quarantine the affected Module rather
than continue with silently corrupt state.

## 18. Conformance requirements

A conformant implementation MUST provide deterministic automated tests for the
following cases.

### 18.1 Block and lifetime

- duplicate Block IDs are rejected without altering the original;
- equal wall-clock timestamps do not affect valid sequence ordering;
- self-reference, missing reference, and attempted cycle construction fail
  atomically;
- mutation of a returned Block cannot mutate stored state;
- an unread Page Delivery keeps its Block and Media dependency graph reachable;
- collection cannot leave a deliverable missing Block;
- AccessLease acquire is atomic with access, release is idempotent, and stale
  lease tokens cannot affect another persistent record or operation;
- a `media-read` lease prevents collection during verified inline-byte copying,
  releases before the inline result is returned, and is released on restart
  because the in-process copy cannot survive; and
- Module stop releases generation-scoped strong references and access leases.

### 18.2 Delivery

- two consumers advance independently;
- a failed Run retries the exact Delivery batch under the same `moduleJobId` and
  a fresh claim token/`runId`/attempt;
- positive acknowledgement is idempotent and fenced by Claim, Module job, Run,
  and Module generation;
- deliveries arriving during execution remain for the next claim;
- multi-Page input is globally ordered;
- oversized snapshots split only at a deterministic prefix and expose `hasMore`;
- repeated Block deliveries are grouped and produce correct per-consumer
  occurrence counts;
- retry exhaustion produces a visible dead letter;
- output commit recovery does not duplicate the output Block or its deliveries;
- a Module result source must match its Delivery Claim's consumer Module;
- a Module result can reuse only Media references in that Claim's input Blocks;
  an uncropped input permits the full Media or a valid sub-crop, while cropped
  inputs permit only a crop contained in one delivered crop and never a
  reconstructed full image or a combination of crops;
- the same source and Media-reference checks reject an invalid `prepared`
  Module result record during recovery, before it creates an output Block or
  advances its Claim;
- a trusted Core direct Block commit remains subject to ordinary Block and
  Media validation but is not restricted to a Module Claim's input Media;
- a fake side-effect capability deduplicates
  `(moduleJobId, effectSlot/toolCallId)` across a lost response and retry, and
  its intent and outcome records survive a Core process restart; an in-memory
  duplicate map is rejected as restart evidence;
- retention additions/removals commit with the Module job result before positive
  acknowledgement,
  are idempotent on replay, reject cross-Module ownership, and remain unchanged
  when the result is rejected;
- Block and Media content references reject invalid identifiers, missing targets,
  invalid crop data, and references to the wrong object type;
- process recovery restores checkpoints, Module jobs, Claims, strong references, and
  outbox state for the declared durability.

### 18.3 Execution and lifecycle

- rapid triggers cannot overlap one Module;
- soft timeout cannot overlap a replacement run;
- hard timeout advances generation only after isolation;
- a late old result cannot affect the current run;
- reload during execution preserves fencing;
- a process `createExecutor` factory returns its handle synchronously without
  starting a process, and its `start()` operation performs process creation,
  authentication, and initialization within `initializationTimeoutMs`;
- initialization failure or timeout invokes `terminate()`, observes late
  `start()` settlement, permits no execution, and permits no replacement before
  confirmation that the process stopped;
- after a `terminationTimeoutMs` wait expires, a later `stop()` call observes
  the same pending `terminate()` Promise without a concurrent `terminate()` or
  cooperative process `stop()` call;
- partial initialization rolls back prior resources only after confirmation
  that the process stopped;
- shutdown that begins before Core starts handling a hard timeout reports Run
  status `cancelled` with reason `shutdown`, then releases the exact Claim after
  confirmation that the executor stopped without failure classification,
  negative acknowledgement, dead-letter disposition, or an increase to
  `failedAttemptCount`; a matching submission record is removed in the same
  Core-state update;
- handling of a hard timeout that began before shutdown remains subject to the
  failure policy after confirmed termination;
- an uncertain write that releases a Claim is reconciled by flushing
  persistence and inspecting the exact Claim and matching submission record;
  success requires state `released` and absence of that record, and repeated
  uncertainty reports `RUNTIME_RECOVERY_REQUIRED` while preserving the Claim
  identity for a later `stop()` call;
- startup recovery constructed without durable Module-record operations reports
  `STARTUP_ACTIVE_CLAIM_UNRESOLVED` for an active Claim instead of guessing from
  unavailable state;
- startup releases an active version 17 Claim as `never-authorized-to-send` only
  after every old process is proven stopped and both its submission record and
  exact unknown submission history item are absent;
- startup with an unknown submission history item does not create a submission
  record, acknowledge, negatively acknowledge, release, retry, or record the
  Claim in dead letter, and no product operator command currently clears that
  item;
- a terminal Claim beside a submission record fails closed rather than
  collecting that record, and injected crashes cover each boundary from a
  `prepared` result journal record through atomic positive acknowledgement and
  submission-record removal to a `committed` journal record;
- a submitted Run whose provider/storage/tool accepts an effect and loses its
  response remains an unknown outcome, with zero negative acknowledgements,
  releases, retries, or replacement effects unless a durable query supplies
  no-effect or retry-safe evidence; a terminal outcome without a separate
  durable idempotency contract remains unresolved;
- a direct ambient effect from an Extension fixture during initialization,
  creation, stop, or execution makes that fixture ineligible for the first
  Linux Module runner and cannot be bypassed by a missing submission record;
- every Core-state write, synchronization, rename, and parent-directory
  synchronization fault recovers only a complete old or complete new
  Claim/process/submission relationship;
- a Linux Module runner uses a non-reused process generation and cgroup,
  verifies delegated-root/controller/limit read-back, never launches Extension
  code before the reviewed launcher joins its cgroup, and rejects a child that
  tries to leave or alter that cgroup, access Core state/manager controls, retain
  a Core descriptor, or signal Core;
- after any Module cgroup member is observed, normal hard timeout, orderly
  stop, protocol failure, Core crash, and child descendant creation prove
  whole-cgroup termination, `populated 0`, directory removal, closed protocol,
  and terminal capability handlers before any replacement or Claim
  disposition; before any member is observed, cleanup instead proves launcher
  exit, a fresh current-empty reading, and directory removal, while uncertain
  launcher exit or execution authorization delivery forces the Core service to
  exit with failure;
- package/configuration revision changes cannot alter an unresolved process or
  submission record, and a changed Linux boot identifier or missing old cgroup
  path follows the explicit recovery rule in ADR 0009;
- stop is idempotent, waits for owned activity, and permits no late output;
- background services can only enqueue bounded source activation requests and cannot emit a
  Block outside the actor Run;
- adjacent Module description selection is deterministic by Page direction, deduplicated by
  Module and direction, revisioned atomically with its result, and rejects stale
  updates; and
- a central processing unit (CPU)-blocking in-process test demonstrates and
  reports lack of hard isolation if the configured Extension execution
  boundary cannot terminate or isolate the blocked code.

### 18.4 Scheduling and backpressure

- periodic start-to-start timing follows the formula with a fake monotonic
  clock;
- overrun creates no concurrent or catch-up burst;
- buffer state is measured per consumer in count and bytes;
- fan-out decisions are independent of report arrival order;
- full mailboxes apply the configured visible policy and never silently drop;
- cyclic no-progress is detected;
- a scheduler policy crash cannot corrupt claims or violate serialization;
- an experimental adaptive policy is compared against the fixed baseline under
  a versioned experiment protocol.

### 18.5 Test hygiene

Core conformance tests MUST NOT depend on live private infrastructure, real API
keys, wall-clock sleeps, paid services, or public OSS access. They MUST use
injectable clocks, deterministic randomness, bounded fake stores, and fault
injection.

Live integration tests MUST be separately selected, identify their external
requirements, enforce cost and time budgets, and never run merely because an
API key happens to exist in the developer's environment.

## 19. Required decisions before acceptance

This Draft cannot become Accepted until Architecture Decision Records (ADRs)
or owner decisions settle:

1. acceptance of the Extension isolation modes needed to provide hard
   timeout and their process failure domain;
2. retry limits, dead-letter ownership, and operator recovery flow;
3. default mailbox and serialized-byte limits;
4. the stable wire schemas for BlockProposal, Block, Block content,
   Delivery, Delivery batch, Module job, Module job outcome, Claims,
   ModuleRetentionChange, strong references, access leases, result digests,
   host-owned strong-reference owner categories, and errors.
5. the Linux Module process ownership, Core-state record, external-effect, and
   audited unknown-outcome rules in ADR 0009.

The first accepted Extension process protocol supports one declared primary
activation mode per Module;
implicit or combined hybrid activation remains forbidden until a later ADR adds
an exact trigger and deduplication contract. A Block Media reference is a dependency
edge, not an independent strong reference: while the Block is reachable the same
Media remains reachable, and when the Block becomes unreachable the runtime may
collect that Media subject to its other strong references, access leases, and grace period. These
two points are settled contract boundaries rather than open implementation
choices.

The contract intentionally permits transactions, journals, or outboxes that
produce equivalent atomic and recovery behavior. Selecting a storage library is
an implementation decision, not a normative-contract prerequisite. Public
release scope may choose one or both declared durability settings without
changing their meanings.

Adaptive scheduling constants are intentionally absent from this list. They are
an experiment outcome, not an acceptance prerequisite for the fixed baseline.
