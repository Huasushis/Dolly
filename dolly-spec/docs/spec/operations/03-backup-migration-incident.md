# Backup, Schema Migration, and Incident Recovery

Status: normative for recoverability of Dolly v1 instance data.

## 1. Recovery objectives and scope

Each deployment **MUST** declare a recovery point objective, recovery time objective, backup retention, backup destination, encryption policy, and whether Provider/remote-system side effects are recoverable. Defaults **MUST NOT** imply that external messages, model billing, or remote tool mutations can be rolled back.

An instance backup inventory **MUST** consider:

- active and historical normalized configuration and transaction journal;
- Runtime SQLite databases, Page/Delivery/Activation state, and Event Journal;
- Extension snapshots and state stores covered by the Extension contract;
- Block/Asset metadata and content-addressed Asset bytes;
- Memory stores, embedding/version metadata, and indexes or rebuild recipes;
- installed package digests and manifests needed to restore compatibility;
- capability/trust policy and audit metadata; and
- explicit references to excluded secret material and external backends.

Cache, reproducible indexes, and downloaded package bytes MAY be excluded only when the manifest identifies how to rebuild or reacquire the exact compatible data.

## 2. Secret treatment

Ordinary instance backups **MUST NOT** contain raw Provider keys, bootstrap credentials, session cookies, local bearer tokens, or capability grants.

Secret backup, if supported, is a separate encrypted export using a user-selected recovery credential or approved platform key. Its manifest **MUST** identify included secret references without logging values. Restoring an instance without secrets leaves those references unresolved and the affected capabilities unavailable; it **MUST NOT** substitute empty or guessed values.

## 3. Backup state machine

The durable backup state machine is:

```text
Requested -> Planning -> Quiescing -> Snapshotting -> Packaging
Packaging -> Verifying -> Complete
Planning/Quiescing/Snapshotting/Packaging/Verifying -> Failed
```

Every backup has an operation ID and records source instance, config/graph revisions, Worker epoch, requested consistency class, included stores, start/end times, and terminal result.

The published machine-readable inventory MUST conform to
[`backup-manifest.schema.json`](../../../schemas/backup-manifest.schema.json).
In particular it binds the source daemon installation and instance identity,
every Module storage scope and snapshot digest, the last granted per-scope
writer generation, and external-state clone policy. Module IDs or scopes may
not be reconstructed from object paths during restore.

Two consistency classes are permitted:

- `quiesced`: affected Modules are fenced, Extension snapshots are taken, and all stores represent one documented cut; and
- `online`: only when every included store provides an online snapshot mechanism and the manifest records the cross-store cut relationship.

If a cross-store consistent online cut cannot be proven, the operation **MUST** use `quiesced`. An ordinary recursive copy of live SQLite and Extension state is non-conforming.

## 4. Creating a backup

The backup operation **MUST**:

1. validate destination policy and free-space quota;
2. persist the backup plan and consistency class;
3. quiesce/fence the required Module and Extension set;
4. use SQLite online backup or verified quiesced database snapshots;
5. request immutable Extension snapshots with schema and package metadata;
6. enumerate referenced Assets from a stable metadata cut;
7. write into a new private staging directory/object prefix;
8. compute digest and length for every stored object;
9. write a versioned manifest last;
10. reopen and verify manifest, databases, object digests, and required references; and
11. atomically publish the backup as `Complete` before unquiescing.

For a quiesced backup, every Module in the declared cut reaches `Quiesced`
before the first snapshot request. Independent Module snapshots SHOULD then run
in parallel. An explicit shared-state contract may define a bounded acyclic
snapshot order or one group snapshot; Page graph direction alone is not an
ordering rule. Failure of any required member prevents publication of the
complete cut.

A failed or cancelled backup is never a restore candidate. Partial staging data MAY be garbage-collected after its operation record reaches a terminal state and retention permits it.

Backup publication does not delete source data. A retention job **MUST NOT** remove the last known-good backup merely because creation of its replacement started.

## 5. Backup manifest

The manifest **MUST** include:

- backup format version and Dolly core version;
- source instance ID and platform;
- source daemon installation ID;
- source config and graph revisions and digests;
- storage schema versions;
- Extension aliases and IDs, package digests, generations, Module IDs and
  types, Module storage scopes, last writer generations, snapshot IDs/digests,
  state schema versions, and external-state references with clone policy;
- object path/key, media type, byte length, and cryptographic digest;
- consistency class and cut metadata;
- excluded/rebuildable components;
- encryption and compression algorithms/parameters without secret keys;
- creation tool/version and timestamps; and
- verification result.

Object paths in a backup are logical portable paths. Restore **MUST** reject absolute paths, traversal, duplicate normalized paths, case collisions on the destination, links, device names, and unbounded archive expansion.

## 6. Restore state machine

Restore is always explicit and uses:

```text
Requested -> Inspecting -> Staging -> Migrating -> Verifying
Verifying -> CutoverReady -> Committed -> AcquiringWriters -> Starting -> Complete
Inspecting/Staging/Migrating/Verifying/CutoverReady -> Aborted
Committed/AcquiringWriters/Starting -> ForwardRecovering -> Complete or Degraded
```

Restore **MUST NOT** merge unknown backup files into a live data directory. It restores to a new staging root on a supported local filesystem.

Every restore or clone has a closed plan conforming to
[`restore-plan.schema.json`](../../../schemas/restore-plan.schema.json). An
ambiguous command that does not choose exactly one identity mode is rejected:

- `replace_same_identity` is disaster recovery or in-place replacement. It
  preserves daemon, instance, Module, and storage-scope identity, uses fresh
  Worker/process/capability fences, increments every active writer generation,
  and requires source-retirement or backend-fence proof before external or
  shared state is writable.
- `isolated_snapshot_clone` is a research/test replica with a fresh daemon and
  secret/capability domain and private mutable stores. It may retain copied
  scope values solely for byte-faithful opaque state, but all external effects,
  account sessions, remote databases, and provider state are disabled. It
  cannot be promoted or merged into production without a portable remap.
- `portable_fork` creates a new live identity. Every enabled stateful Module
  receives a fresh target scope through an explicit
  `clone_to_fresh_scope` migration. A Module that cannot remap its opaque state
  remains disabled with the source bytes retained for later recovery; ordinary
  restore cannot adopt the source scope.

The plan lists every manifest Module exactly once. `preserve` and
`isolated_copy` keep the source scope value in their defined identity domain;
`remap` names a distinct never-used target scope and migration operation;
`disabled` names no target scope. Equality, inequality, one-to-one coverage,
freshness, and source-manifest membership are semantic Host checks because JSON
Schema alone cannot compare projected array fields.

Before restore, the control plane **MUST**:

- authenticate and authorize the destructive operation;
- stop/fence the target instance and acquire its exclusive lock;
- inspect manifest compatibility without executing restored Extension code;
- verify all available digests and required objects;
- resolve package trust/revocation policy;
- determine required core and Extension migrations; and
- state which external effects and secrets cannot be restored.

At `CutoverReady`, staged databases pass integrity checks, migrations, schema validation, reference validation, and a no-network dry-run. Cutover **MUST** use the platform atomic directory/pointer strategy and preserve the prior data root as a rollback candidate until policy allows deletion.

After the restore commit point, the staged root is authoritative. Before
`Starting`, the Host increments and acquires every required per-scope writer
generation. A stale process or restored external client must be unable to
write. If acquisition or source fencing is uncertain, the affected scope and
all dependent external effects remain disabled in `ForwardRecovering` or
`Degraded`. Failure to start enters `ForwardRecovering`; if consistency cannot
be proven it becomes `Degraded`. The system **MUST NOT** silently switch between
roots after either has accepted new work.

## 7. Core schema migrations

Every core schema migration **MUST** declare:

- source and target versions;
- compatible Dolly versions;
- whether it is online or requires quiescence;
- expected disk/time expansion;
- validation invariants;
- reversibility or explicit lack thereof; and
- deterministic implementation/version digest.

Before an irreversible migration, a verified compatible backup is required unless an authenticated administrator accepts explicit data-loss risk. The migration **MUST** have a durable journal and idempotent steps. It SHOULD operate on a staged copy when cost permits.

The schema version changes only at the migration commit point. A crash resumes from the journal or restores the pre-migration copy; it **MUST NOT** guess completion from partially changed tables.

Automatic downgrade is forbidden unless an explicit reverse migration exists and passes the same gates. An older binary **MUST** refuse a newer unsupported store rather than attempt best-effort writes.

## 8. Extension state migrations

Extension state follows the Extension hot-reload specification. Restore **MUST** verify that an installed, trusted package can read the snapshot schema or that a declared migration path exists.

Missing or revoked optional Extensions MAY leave Modules disabled with preserved opaque state. A required Extension without a safe package/migration blocks instance readiness. The Host **MUST NOT** deserialize opaque Extension bytes as trusted core data.

## 9. Asset and index recovery

Asset metadata and bytes **MUST** be cross-checked by content digest. A missing referenced Asset makes verification fail unless the manifest explicitly marks it external/rebuildable and policy accepts that state. A corrupt object **MUST** be quarantined, not served.

Indexes that are declared rebuildable MAY be omitted or discarded after mismatch. Rebuilding **MUST** use the recorded source records, model/version, preprocessing version, and dimensions. An embedding index generated with a different model/version **MUST NOT** be presented as equivalent.

## 10. Incident classes and mandatory response

### 10.1 Disk full or read-only storage

The Worker **MUST** stop acknowledging durable commits, fence mutations that require storage, preserve in-memory diagnostics within bounds, and expose `durability_unavailable`. It **MUST NOT** advance cursors or claim backup success. After capacity repair, integrity and transaction recovery run before readiness.

### 10.2 SQLite corruption or I/O error

The Worker **MUST** stop write service for the affected store, preserve the original files, collect bounded diagnostics, and run read-only integrity assessment. Automatic destructive repair is forbidden. Recovery choices are verified restore, documented salvage into a new store, or explicit reset with data-loss approval.

### 10.3 Degraded configuration transaction

Affected Modules and routes remain fenced. Incident output **MUST** show authoritative Host revision, participant receipts, snapshots, uncertain effects, and forward/restore choices. Restart alone does not clear `Degraded`.

### 10.4 Extension crash loop or compromise

The Host revokes grants, fences the generation, quarantines the package/alias according to policy, preserves operation receipts, and scans for indeterminate side effects. Re-enabling requires package/policy review and explicit operation.

### 10.5 Lost or exposed secret

The secret reference is revoked/disabled, dependent calls are fenced or fail closed, and operators are directed to rotate it at the source. Logs/backups are inspected according to incident policy. Dolly **MUST NOT** display the old value during recovery.

### 10.6 Asset digest mismatch

The object is quarantined immediately. References remain but retrieval returns a typed integrity error. Recovery rehydrates from a verified backup/backend or records explicit loss; it never silently substitutes bytes under the same Asset ID.

### 10.7 Orphan processes

The current Worker/daemon revokes old epochs/generations and uses the platform lifecycle container to terminate orphans. Even if termination fails, old processes cannot commit through current Host IPC. PID identity alone is not used.

## 11. Diagnostic and repair tooling

`dolly doctor` or an equivalent read-only tool **MUST** be able to report:

- instance lock and Worker epoch state;
- active/nonterminal configuration, backup, restore, and migration operations;
- database integrity status without changing data;
- missing/corrupt Asset references;
- package/state schema compatibility;
- per-scope active writer owner/generation, uncertain handoffs, and pending
  restore/clone scope remaps;
- revision/generation convergence;
- sandbox/capability enforcement status; and
- available disk space and quota pressure.

Repair commands are separate from diagnosis, require authenticated approval, create operation/audit IDs, and show whether they are reversible or destructive.

## 12. Retention and deletion

Backup retention is reference-aware and policy-driven. Deletion **MUST** verify the exact backup ID/destination prefix and **MUST NOT** follow untrusted links or delete an external source object not owned by Dolly.

At least one verified recovery point SHOULD remain after automated retention. Legal/user deletion policy MAY require removal of all copies; the system **MUST** report pending or unreachable remote copies rather than claim completion.

## 13. Recovery drills and release gate

Backups are not considered operationally valid until restore is tested. Each supported release/platform **MUST** run automated drills for:

- quiesced and supported online backup;
- crash at every backup/restore/migration phase;
- corrupt/missing object and wrong digest;
- old supported backup migration to current version;
- unsupported future/downgrade refusal;
- missing optional and required Extension packages;
- disk-full during backup, migration, and cutover;
- Windows sharing/atomic-replace races and Linux fsync/rename recovery;
- restored instance startup with secrets intentionally absent; and
- same-identity restore with a stale writer, isolated clone external-effect
  denial, portable-fork fresh scope remap, and unsupported opaque-state disable.

Production operators SHOULD periodically perform an isolated restore drill and record achieved recovery point/time against declared objectives.

## 14. Stable requirements and invariants

- `INV-REC-001` — Only a verified `Complete` backup with a versioned digest manifest is a restore candidate.
- `INV-REC-002` — Restore and migration operate in staging and change authority only at their documented Host commit point.
- `INV-REC-003` — A digest mismatch never serves substituted bytes under the original identity.
- `REQ-REC-001` — Live SQLite and Extension stores are backed up only through a proved online cut or quiesced snapshots, never an ordinary recursive copy.
- `REQ-REC-002` — Irreversible migration requires a verified compatible backup or explicit audited acceptance of data-loss risk.
- `REQ-REC-003` — Post-cutover uncertainty becomes forward recovery or `Degraded`; the system never silently switches between data roots.
- `REQ-REC-004` — Same-identity restore preserves Module scopes only after
  source fencing; isolated clones remain effect-free, and a portable fork uses
  fresh explicit scope remaps or leaves the Module disabled.
