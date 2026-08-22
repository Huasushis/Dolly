# Rust reference implementation blueprint

Status: **informative implementation guide**. The normative schemas, reference
abstract machine, protocol catalog, and conformance vectors take precedence if
this guide and a contract ever differ.

This chapter turns the Dolly v1 contracts into a concrete Rust workspace and
delivery sequence. It intentionally fixes ownership and dependency direction,
but not private function names or a framework that would prevent an equivalent
implementation.

## 1. Workspace and dependency direction

Use one Cargo workspace with release dependency versions locked in
`Cargo.lock`:

| Crate | Owns | May depend on |
| --- | --- | --- |
| `dolly-core-domain` | IDs, Blocks, Pages, Deliveries, cursors, Activations, commands, events, pure transition rules | canonical JSON and small utility crates only |
| `dolly-schema` | generated closed wire/config types, schema bundle, JCS and digest verification | `dolly-core-domain` for shared newtypes |
| `dolly-protocol` | framing, JSON-RPC envelopes, method catalog, pair validation | `dolly-schema` |
| `dolly-storage` | migrations, SQLite repositories, transaction implementation, crash labels | `dolly-core-domain`, `dolly-schema` |
| `dolly-runtime` | Core writer, scheduler, retention, routing, activation dispatch and result application | domain, storage, protocol |
| `dolly-extension-host` | process generations, handshakes, leases, capabilities, RPC multiplexing, quarantine | runtime ports, protocol |
| `dolly-extension-sdk` | Extension-side lifecycle dispatcher, typed Host client, ledgers, test harness | protocol only |
| `dolly-control-plane` | normalized config, JSON Patch, prepare/cutover/recovery transactions | runtime/host administrative ports |
| `dolly-asset-service` | imports, immutable content store, leases, views and GC | storage and Host-service ports |
| `dolly-model-gateway` | provider profiles/adapters, request ledger, budgets and reconciliation | Host-service ports |
| `dolly-context-selection` | immutable Memory include/suppress decisions and canonical request assembly | domain, storage, schema |
| `dolly-tool-broker` | closed tool registry, MCP adapters, transport generations and call ledger | Host-service ports |
| `dolly-observability` | journal projection, bounded logs/traces/metrics and diagnostics export | stable event interfaces |
| `dollyd` | daemon composition and local admin API | all Host-side implementation crates |
| `dolly-cli` | client commands and foreground supervisor | generated admin client only |
| `extensions/*` | Channel, Alarm, Skills, LLM, and Memory processes | `dolly-extension-sdk`; never Runtime crates |

Enforce this table with a dependency-policy test. In particular,
`dolly-core-domain` has no SQLite, Tokio, provider, MCP, web, UI, or Extension
implementation dependency. Extensions compile as separate executables and do
not link the Host storage implementation.

## 2. Domain types

Generate or hand-maintain one closed Rust representation for each stable
schema. Do not expose raw strings where the Core requires an identity class.
One suitable shape is:

```rust,ignore
#[repr(transparent)] pub struct ModuleId(StableId);
#[repr(transparent)] pub struct PageId(StableId);
#[repr(transparent)] pub struct ActivationId(UuidV7);
#[repr(transparent)] pub struct BlockId(UuidV7);
#[repr(transparent)] pub struct ConfigRevision(SafeU53);
#[repr(transparent)] pub struct GraphRevision(SafeU53);
#[repr(transparent)] pub struct PageSeq(SafeU53);

pub struct DeliveryKey {
    pub page_id: PageId,
    pub page_seq: PageSeq,
}

pub struct CursorSpan {
    pub page_id: PageId,
    pub from_inclusive: PageSeq,
    pub to_exclusive: PageSeq,
}

pub struct FrozenConfig {
    pub revision: ConfigRevision,
    pub value: CanonicalJsonObject,
    pub value_digest: Sha256Digest,
    pub schema_digest: Sha256Digest,
    pub package_digest: Sha256Digest,
}
```

Constructors validate the complete lexical and numeric contract. Deserialization
uses a duplicate-key-rejecting visitor before conversion to typed values.
`serde_json::Value` is allowed only at explicitly open JSON payload boundaries;
it is not a substitute for a typed Block, Manifest, error, or lifecycle result.

The canonical JSON module exposes one operation that returns both bytes and
digest:

```rust,ignore
pub fn canonicalize<T: Serialize>(value: &T)
    -> Result<(CanonicalBytes, Sha256Digest), CanonicalError>;
```

Golden tests compare these bytes with the repository fixtures on every target
platform. Never compute a semantic digest by serializing a `HashMap`, pretty
JSON, or a database row projection directly.

## 3. Pure reducer boundary

Represent every Core mutation as a command evaluated against a complete logical
snapshot and deterministic inputs:

```rust,ignore
pub struct ReduceContext {
    pub now: Timestamp,
    pub id_source: DeterministicIdSource,
    pub active_config: ConfigRevision,
    pub active_graph: GraphRevision,
}

pub enum CoreCommand {
    AdmitIngress(AdmitIngress),
    BuildManifest(BuildManifest),
    AcquireLease(AcquireLease),
    StageResult(StageResult),
    ApplyResult(ApplyResult),
    ReleaseRetry(ReleaseRetry),
    ExpireLease(ExpireLease),
    SkipRange(SkipRange),
    ApplyRetention(ApplyRetention),
}

pub struct Transition {
    pub writes: Vec<DomainWrite>,
    pub events: Vec<CoreEvent>,
    pub reply: CommandReply,
}

pub fn reduce(snapshot: &CoreSnapshot, command: CoreCommand,
              context: &ReduceContext) -> Result<Transition, CoreError>;
```

The reducer performs no clock read, random generation, SQL, process I/O, or
network call. `BuildManifest` rechecks every graph-pinned descriptor and policy
revision in the snapshot it was given. `ApplyResult` computes quota against the
projected transaction: consumed cursor movement, retention eligible in that
same commit, then exact fan-out append. `SkipRange` rejects an end beyond the
Page's current `next_page_seq`.

The vector runner loads a fixture, applies one command, canonicalizes the new
observable state/events, and checks every expected assertion. The production
path executes the same reducer; it does not reimplement the transition rules in
SQL callbacks.

## 4. One authoritative writer

Give each instance exactly one `CoreWriter` task. Other tasks send bounded
requests and receive typed replies:

```rust,ignore
pub struct CoreRequest {
    pub command: CoreCommand,
    pub reply: oneshot::Sender<Result<CommandReply, CoreError>>,
}

async fn core_writer(mut inbox: mpsc::Receiver<CoreRequest>, store: CoreStore) {
    while let Some(request) = inbox.recv().await {
        let result = store.transact(request.command).await;
        let _ = request.reply.send(result);
    }
}
```

The queue has a configured finite capacity. Admission failure is explicit
backpressure, never an unbounded spawned task. The writer transaction performs:

1. begin an immediate SQLite write transaction;
2. load the exact rows and revisions required by the command;
3. run the reducer;
4. compare all optimistic versions and lease/generation fences;
5. apply all writes and append the journal event batch;
6. commit once; and
7. publish the committed reply/events after commit succeeds.

No actor may acknowledge a semantic write before step 6. Post-commit event
delivery is replayable from the journal; it is not part of correctness.

## 5. Storage implementation

Use explicit repository traits around a transaction handle, not a global pool
inside domain logic:

```rust,ignore
pub trait CoreTransaction {
    fn load_command_snapshot(&mut self, command: &CoreCommand)
        -> Result<CoreSnapshot, StorageError>;
    fn compare_and_apply(&mut self, transition: &Transition)
        -> Result<(), StorageError>;
    fn append_journal(&mut self, events: &[CoreEvent])
        -> Result<(), StorageError>;
    fn commit(self) -> Result<(), StorageError>;
}
```

The schema uses uniqueness and foreign keys as a second line of defense for
Block IDs, `(page_id,page_seq)`, one Delivery per fan-out target, one
authoritative Activation result digest, subscription cursors, and idempotent
operation IDs. Every migration has forward, rollback-policy, interrupted-run,
backup/restore, and schema-version tests.

The first migration is the language-neutral Runtime authority schema version 1,
not a Rust-owned variant. TypeScript configuration allocation and Rust recovery
open the same database under the same controller lock. Repository methods must
preserve the append-only config mapping, exact current pointer, prerequisite
foreign keys, premise-last insertion, and no-global-digest-uniqueness contract;
a JSON or Rust sidecar is not a fallback authority.

Open SQLite only after verifying the attested embedded library required by
`REQ-TECH-003`. Apply and read back the normative WAL, `synchronous=FULL`,
foreign-key, trusted-schema, busy-timeout, and `user_version` requirements, keep
a single application writer using immediate authority transactions, and run
the named checkpoint/write regression. A pool configuration must not
accidentally create another logical writer.

## 6. Scheduler and dispatch split

The scheduler only proposes `BuildManifest`; it never advances a cursor. Its
inputs are committed Page notifications, durable wakeups, retry deadlines,
activation-rate buckets, and gap-only work. Coalescing is a deterministic
optimization over these inputs.

Dispatch is a separate state machine:

1. select a persisted `ready` Manifest;
2. acquire a lease and persist its fence;
3. select the exact Extension process generation and verify frame bounds;
4. send the immutable Manifest bytes;
5. validate all response echoes and the JCS payload digest;
6. stage one authoritative result; and
7. ask `CoreWriter` to apply it atomically.

A timeout or broken process moves through the replay contract recorded in the
Manifest; generic retries are forbidden. Gap-only lossy work enters the same
durable scheduler queue so it cannot depend on a future Delivery arriving.

## 7. Extension Host structure

Use one supervisor per verified package generation and a connection actor per
process. A connection actor owns framing, JSON-RPC correlation, negotiated
limits, worker epoch, Extension generation, cancellation, and protocol strike
count. It accepts a response only after method-specific pair validation.

Keep capabilities as typed handles in a Host-side table. Wire tokens are opaque
indices plus unguessable material scoped to connection, Module, generation, and
expiry. Do not derive authorization from a method name or an Extension-supplied
Module ID alone.

Lifecycle operations persist their operation input digest before sending.
Initialization verifies the selected SDK ABI was offered and binds the exact
exclusive state-directory grant/ledger proof. Snapshot, migration, restore, and
config-prepare results are checked against their request and frozen package,
Module, schema, and operation identities before any state transition.

## 8. Host services

Assets, Model Gateway, and Tool Broker use the same operation pattern:

```text
validate identity/fence/capability
  -> persist operation input digest and pre-dispatch state
  -> perform bounded external work
  -> persist authoritative result or unknown outcome
  -> return or reconcile by operation status
```

An external timeout never rolls back a durable `DISPATCHED` fact. The Model
Gateway and Tool Broker own their credentials and transports; Extensions receive
only typed results. Asset reads bind the requested identity, delivery mode, and
inline byte ceiling to the response.

Memory retrieval and context selection stay separate. The Memory Extension
returns a validated search-result Block; it does not rewrite a Module Premise
or assemble provider messages. `dolly-context-selection` records one immutable
include/suppress decision for each candidate and target ModelRequest, deduplicates
the exact `(memory_id, record_revision)` within that request, and may select the
same revision again for a later request when the new context justifies it. The
Gateway compiles selected records only as typed `memory_evidence` parts under
the canonical `external` role. An automatic retrieval rate limiter controls
attempts; it is never a per-record eligibility timestamp and is not consulted by
an explicit `memory.search` Action.

## 9. Configuration and process cutover

Normalize config into an immutable `ResolvedRevision`. Compute every Module's
effective configuration using the specified shallow overlay, validate it, and
store its canonical bytes and digests. The prepare transaction builds all new
process/server generations without changing the active pointer. The Host commit
atomically changes the config/graph pointer and writes the recovery record.

After commit, old Manifests still reference retained config, graph, Descriptor,
policy, package, and Tool Broker revisions. Reference-count those snapshots by
nonterminal Manifest/operation rather than deleting them on a timer. Recovery
reads the durable transaction phase and converges forward or enters `Degraded`;
it never guesses based on which process happens to be alive.

## 10. Executable and UI composition

`dollyd` opens the instance lock, verifies storage, starts `CoreWriter`, then
starts projections/services/supervisors and finally the authenticated local
admin listener. Shutdown closes admission, drains within a deadline, persists
remaining recoverable state, fences processes, checkpoints according to policy,
and releases the lock last.

The CLI and Web UI are clients of the same versioned admin API. They cannot open
the SQLite database or import Extension frontend code. UI progress is a
projection of journaled operations; absence of a browser connection cannot
change Core execution.

## 11. Test construction

Build tests in this order:

1. schema/canonical JSON corpus and duplicate-key/depth/size rejection;
2. reducer vectors and generated command/state-machine sequences;
3. repository parity and kill-at-every-named-crash-label recovery;
4. fragmented, reordered, duplicated, stale, and malicious protocol peers;
5. virtual-clock scheduler/retention/quota/lease tests;
6. hostile Asset/provider/tool-server fixtures;
7. config prepare/commit/recovery matrices;
8. native Linux and Windows process, lock, parent-death, and path suites; and
9. soak, backup/restore, migration, diagnostics, and release-packet rehearsal.

Inject clock, ID source, process launcher, filesystem fault points, provider
transport, and tool transport. Recorded fixtures are the default; live external
tests are separately marked and cannot replace deterministic conformance.

## 12. First implementation slice

The first vertical slice starts with the shared Runtime authority mapping and
`TST-AUTH-004..006`, then contains one durable input Page, one echo Extension,
one Module, one durable output Page, SQLite, final framing, and the final
Activation transaction. It is complete only when it passes:

- current-equal revision reuse, changed-content next allocation, and
  `A -> B -> A`;
- crash/reopen/stale/mismatch/cross-origin and legacy JSON cutover;
- ingress idempotency;
- restart before and after each write/commit boundary;
- process death before and after Activation result staging;
- duplicate and conflicting results;
- self-loop quota at capacity using projected cursor movement;
- old-Manifest redispatch after a config revision; and
- journal replay to the same observable digest.

Only then add real Channel, provider, Tool Broker, Memory, or UI behavior.
