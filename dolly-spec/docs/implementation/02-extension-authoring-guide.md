# Extension authoring guide

Status: **informative SDK guide**. An Extension conforms to the normative
manifest, wire, lifecycle, capability, hot-reload, and Module contracts linked
from this guide—not to an example implementation by itself.

## 1. What an Extension is

A Dolly Extension is a verified package containing one or more native process
executables, a signed manifest, package-local JSON Schemas, and optional
resources. It implements Module behavior behind the Dolly JSON-RPC protocol.
It is not loaded into the Core process and receives no database object, Page
writer, cursor mutator, secret value, provider credential, or tool-server
socket.

The Host owns durable truth. An Extension receives one immutable Activation
Manifest and returns a proposed result. Only the Host can validate, stage, and
atomically commit that result with input cursor movement.

## 2. Package layout

One recommended package is:

```text
extension-package/
  extension.json
  bin/
    linux-x86_64/my-extension
    windows-x86_64/my-extension.exe
  schemas/
    extension-config.schema.json
    module-config.schema.json
    state-v1.schema.json
  resources/
    default-prompt.txt
  signatures/
    package.sig
```

Every path is relative and every installed byte is covered by the immutable
package digest. The manifest names executable hashes, protocol range, hosting
mode, Module types, config-schema URI/digest bindings, supported state schemas,
and requested capabilities. A manifest declaration requests authority; it does
not grant it.

For each Module type, publish a Descriptor template whose accepted/emitted Part
kinds and Actions are no wider than the implementation actually supports.
Unknown manifest or config fields are errors, not forward-compatible storage.

## 3. Configuration contract

Declare two scopes deliberately:

| Scope | Typical fields | Consumer |
| --- | --- | --- |
| Extension config | process-wide caches, package behavior shared by all Modules | `extension.initialize` and process generation |
| Module config | role, Page-independent behavior, profile/tool/Skill choices | `module.instantiate`, config prepare, Activation |

Both are JSON objects. Dolly computes one effective Module object using its
fixed top-level shallow overlay. A Module key replaces the complete Extension
value; nested objects are not merged, arrays are not concatenated, and `null`
is not deletion. Design schemas so this rule is unsurprising—prefer a small
number of cohesive top-level objects over partial nested overrides.

The SDK gives the Extension the already resolved object, revision, object
digest, and schema digest. Verify the digest before use and retain the complete
frozen value with prepared or in-flight state. Never reread an active-config
file during an old Activation.

## 4. Process startup and lifecycle

The process communicates only on the private Host-provided framed connection.
Do not read JSON lines from standard input unless the SDK explicitly owns that
framing; Dolly frames are length-bounded protocol messages, not newline JSON.

The normal sequence is:

1. Host launches the verified executable with a minimal environment and private
   working directory.
2. `extension.initialize` negotiates protocol/SDK ABI, exact limits,
   capabilities, storage handles, Extension config, generation, and epoch.
3. Extension validates the offer, verifies each Module `storage_scope_id`, opens only granted handles, verifies or
   creates its activation ledger, and returns the selected ABI plus proofs.
4. Host may issue `extension.ping` and Module lifecycle calls.
5. `module.instantiate` creates one Module instance under the frozen effective
   config and state schema.
6. `module.activate` supplies an immutable Manifest and lease fence.
7. Host explicitly reports the Activation's committed or aborted outcome; only
   then may prepared semantic state become committed Extension state.
8. Drain/shutdown stops new Activations, resolves outstanding calls, and exits
   by the negotiated deadline.

Every response echoes the exact operation, generation, epoch, Module, lease,
and revision fields required by that method. Use the generated dispatcher so a
stale or mismatched request is rejected before reaching business logic.

## 5. SDK handler shape

A Rust SDK can expose a trait similar to this non-normative sketch:

```rust,ignore
#[async_trait]
pub trait Extension: Send + Sync + 'static {
    type Module: Module;

    async fn initialize(
        &self,
        request: InitializeRequest,
        host: HostClient,
    ) -> Result<Initialized<Self::Module>, ExtensionError>;

    async fn snapshot(
        &self,
        request: SnapshotRequest,
    ) -> Result<Snapshot, ExtensionError>;

    async fn migrate(
        &self,
        request: MigrateRequest,
    ) -> Result<MigrationReport, ExtensionError>;
}

#[async_trait]
pub trait Module: Send + 'static {
    async fn activate(
        &mut self,
        manifest: ActivationManifest,
        host: ActivationHostClient,
    ) -> Result<ActivationPayload, ExtensionError>;
}
```

The SDK, not each Extension, handles frame decoding, closed schema validation,
deadlines, cancellation, correlation IDs, echo construction, payload JCS digest,
capability tokens, and one response per request. The handler receives a client
already scoped to its Module/Activation; it cannot choose another identity.

An Activation handler returns one of:

- no `BlockDraft`, with a successful empty semantic result;
- exactly one `BlockDraft` containing bounded Parts and zero or more Action
  proposals; or
- one structured error that leaves input uncommitted.

It never assigns Block IDs, Page sequence numbers, delivery identities, or
commit timestamps. It never returns Actions outside the draft.

## 6. Durable replay ledger

If a Module declares a replay mode stronger than `never_auto_retry`, implement
an exclusive activation ledger in its granted state directory. A minimal row is
keyed by `(storage_scope_id, activation_id)` and records:

```text
manifest_digest
attempt/fence identity
state: received | external_dispatch | prepared | host_committed | host_aborted
external idempotency/status identity
prepared payload bytes and digest
unknown-side-effect evidence
```

The ledger transaction is durable before any claimed replay-safety boundary.
Receiving the same Activation with the same Manifest digest returns or resumes
the recorded state. The same ID with a different digest is a state conflict.
Never infer that an external side effect did not happen merely because the
process crashed before recording its result.

Do not accept a user-provided database path as a substitute for state scoping.
When one process or physical database hosts multiple Modules, bind every query,
transaction, cache key, migration, and background job to the Host-provided
scope. On startup, a mismatched or missing scope marker is a state-identity
error; do not create fresh tables over it.

Prepared Module state is isolated by Activation. Make it visible to the next
Activation only after the Host's committed notification. On abort, discard the
semantic delta but retain audit evidence and any unknown external outcome.

## 7. Host services and capabilities

Call only the typed SDK client method corresponding to an initialized grant.
Each mutating or externally billable call has a stable operation ID and input
digest. After a lost response, query the matching operation status; do not mint
a new ID to make the request “work.”

Important boundaries:

- Assets return metadata, bounded inline data, or an expiring stream—not a Host
  filesystem path.
- Model requests go through Model Gateway profiles; provider credentials never
  enter the process.
- Tools go through the Host Tool Broker. The Extension names the configured
  server/tool alias, frozen config revision, schema digest, and stable call ID;
  it does not launch or connect to an MCP server.
- Scheduling is a request to the Host, not a timer that can commit Core state.
- A config proposal is only a proposal and cannot self-approve.

Treat Blocks, Descriptor prose, model responses, Memory, Skills, tool output,
and Asset metadata as untrusted data even when schemas validate their shape.
They cannot expand a grant.

### 7.1 Holding Blocks across Activations

An Extension never owns a mutable Block object. During an Activation it reads
the immutable Blocks authorized by the Manifest. If a Module needs one after
the current input cursor commits—for LLM history, a daily Memory summary,
LevelUpper transfer, or another bounded job—it stores the Block ID and obtains
a durable `host.block.pin`; retaining an SDK object, process pointer, URL, or
reference count is not a hold.

Treat pin creation as a separate recoverable Host operation:

1. allocate and persist one stable pin operation ID with the Module's prepared
   semantic state;
2. call `host.block.pin` only for a reachable Block and a finite expiry;
3. after a lost reply, use `host.operation.status` for that same operation;
4. on Activation commit, adopt the returned `pin_id` into committed Module
   state; on authoritative abort, unpin it; on unknown disposition, keep a
   bounded orphan record and reconcile rather than guessing;
5. on context eviction or completed background work, call `host.block.unpin`
   with its own stable operation ID; and
6. let expiry be the final fail-safe, never the normal cleanup path.

A pin roots the Block's transitive BlockRef, causal-parent, and Asset closure in
Core GC. It grants no right to mutate, append, forward with authority, or read
an object that was not initially reachable. Pin quotas include the transitive
retained bytes. To extend a hold, obtain a new overlapping finite pin under a
new operation ID, durably adopt it, and only then release the old one; reusing
an old operation ID with a later expiry is an idempotency conflict.

Pins belong to the logical Module/storage scope, not an OS process lifetime.
Graceful stop checkpoints their inventory and leaves required pins intact;
restart under a new process generation reconciles them before serving. Module
removal, storage-scope reset, clone, backup retention, and forced stop each need
an explicit keep/transfer/release/expire disposition. A hot-reload candidate
cannot use a retained pin as proof that it owns the old generation's writable
state; storage-writer fencing remains separate.

## 8. Actions and targeted delivery

An Action name and argument/result contract come from the Descriptor revision
pinned into the Activation Manifest. The contract snapshot carried by queued
work is authoritative for that work; a later Descriptor cannot reinterpret it.

When consuming targeted Actions, return one canonical ActionResult for each
selected Action, ordered by its Manifest input order, with unique matching
`action_id`. Missing, duplicate, extra, or reordered results reject the complete
Activation result. A side-effecting Action implementation uses the Activation
ledger and its stable action identity to prevent unsafe duplicate dispatch.

A Memory search Action also receives the complete declared query-basis Block
IDs. Exclude those records and every current Activation source Block before
ranking. Return the stable search result and its provenance as an ordinary
untrusted Block. The Memory Extension does not decide whether a result is
included in a ModelRequest, does not inspect prior presentation history, and
does not publish recalled text through its Premise or Descriptor.

## 9. Concurrency and cancellation

One Module instance processes at most one Activation at a time. Do not spawn a
detached task that survives its lease and later returns a semantic result. Child
work inherits the request deadline and cancellation token. Cancellation stops
local work when safe, but it is not proof that an already dispatched provider
or tool operation was not applied.

Bound every queue, task set, buffer, response, log field, and retry loop. Reject
work before allocating based on an untrusted advertised size. Use the Host clock
for protocol deadlines and an injected clock in Module tests.

## 10. Errors and diagnostics

Return only the common closed error envelope and method-specific detail shape.
Choose `retryable` and `outcome` from evidence:

- `not_applied` means the operation is known not to have crossed its semantic
  commit/dispatch boundary;
- `applied` means an authoritative result exists;
- `unknown` means an external effect may have occurred and forbids blind retry.

Logs are untrusted bounded fields. Never log capability tokens, credentials,
raw provider prompts/responses, full Blocks, or state snapshots unless an
explicit retention policy and redaction path authorizes the payload. Include
the Host-provided operation, Activation, Module, generation, and trace IDs so
the Host can correlate without trusting Extension-supplied replacements.

## 11. Hot replacement and migration

Support the narrowest state contract possible. Stateless replacement is
simplest. Otherwise:

1. quiesce the old generation at the Host fence;
2. snapshot a closed, versioned, size-bounded state object;
3. bind the snapshot to Module ID, source package digest, and source schema;
4. migrate through declared adjacent steps into the target package/schema;
5. require explicit approval for any lossy report;
6. restore and verify without taking authority; and
7. let the Host perform the single cutover.

Snapshot and migration handlers are idempotent by operation ID/input digest.
They do not activate the target generation or delete old state. Retain the old
generation/snapshot until the Host declares the transaction terminal and its
rollback policy allows cleanup.

## 12. Local conformance workflow

An Extension package should ship tests that run without a real daemon:

1. validate manifest, config schemas, Descriptor, and every result schema;
2. run initialize with unsupported ABI, missing grant, wrong epoch, and limit
   boundary cases;
3. instantiate with valid and invalid effective config/digests;
4. replay golden Activations and compare canonical payload digests;
5. duplicate, reorder, cancel, timeout, and stale-fence every RPC;
6. crash at each ledger transition and restart from the same state directory;
7. lose each Host-service response and reconcile it by operation status;
8. fuzz frame fragmentation, duplicate JSON keys, nesting, sizes, and unknown
   fields;
9. run snapshot/migrate/restore including mismatch and lossy-approval cases;
10. prove the process cannot access ungranted files, network, secrets, Pages,
    or another Module's handles.

The Host SDK conformance kit is necessary but not sufficient: Channel, LLM,
Memory, Skills, and Alarm Extensions also satisfy their own normative chapters.

## 13. Review checklist

Before publishing a package, confirm:

- identity, version, executable hashes, protocol range, schemas, and requested
  grants are exact;
- all config is consumed through declared Extension or effective Module scope;
- all semantic state is Activation-staged until Host commit;
- replay claims have durable evidence and crash tests;
- external calls use stable operation IDs and preserve unknown outcomes;
- Descriptor Action contracts match emitted/consumed values exactly;
- every byte/task/retry/time/resource path is bounded;
- no ambient credential, filesystem, network, shell, database, or UI authority
  is assumed; and
- upgrade, downgrade/rollback policy, diagnostics, and data cleanup are
  documented and tested.
