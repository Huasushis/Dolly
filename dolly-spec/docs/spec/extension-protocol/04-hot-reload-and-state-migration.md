# Extension Hot Reload and State Migration

Status: normative for Extension configuration changes and package replacement.

In this document, **generation** means the Extension process generation defined by the lifecycle specification, not Core `lease_generation`.

## 1. Principles

Hot reload is a generation change coordinated by the Host. Dolly does not unload a Rust dynamic library in v1. A new package is started as a new process generation and cannot share mutable process memory with the old generation.

The Host **MUST NOT** promise distributed ACID semantics across its database and Extension-owned storage. It provides durable orchestration, fencing, idempotent operations, snapshots, and explicit `Degraded` recovery states.

Package bytes are immutable and addressed by a verified digest. Replacing bytes under an installed version/path is forbidden.

## 2. Change classes

Every configuration diff **MUST** be classified before prepare:

| Class | Required handling |
| --- | --- |
| Runtime-only parameter | apply at a specified Runtime commit point |
| Module live configuration | `module.prepare_config` then idempotent commit |
| Module restart | quiesce, snapshot as required, new generation, restore |
| Package upgrade/downgrade | verify package, state compatibility/migration, generation cutover |
| Graph/topology change | control-plane graph transaction; revision coexistence unless local participant state or a destructive disposition requires quiescence |
| Data-root or incompatible storage change | reject as hot reload; require offline migration |

An Extension **MAY** report a stricter class than the Host inferred. It **MUST NOT** report a weaker class merely to avoid restart or migration.

## 3. Prepare contract

The Host resolves any control-plane patch first, then calls
`module.prepare_config` with the configuration transaction `operation_id`, base
and target revisions, current generation, the complete normalized target
effective Module configuration, its JCS digest, its transitive schema-bundle
digest, the canonical digest of the prepare input, and a deadline.
The Extension-level object and schema binding MUST be unchanged for this
in-generation method; otherwise the Host performs process-generation
replacement instead. Parameters and
the prepare result MUST conform to `ModulePrepareConfigParams` and
`ModulePrepareConfigResult` in
[`extension-lifecycle-rpc.schema.json`](../../../schemas/extension-lifecycle-rpc.schema.json).

The digest domain is exact and non-recursive. Let `P` be the complete
`ModulePrepareConfigParams` object after removing only its `input_digest`
member. Then:

```text
input_digest = sha256(JCS({"method":"module.prepare_config","params":P}))
```

`operation_id` and `deadline` remain inside `P`; every retry under the same
operation therefore uses byte-identical semantic input. The Host and Extension
both recompute this digest before accepting or persisting prepare state. A
digest mismatch is invalid params and creates no prepare record or token.

Prepare **MUST** be:

- idempotent for the transaction ID and input digest;
- free of externally visible side effects;
- free of irreversible state mutation;
- bounded by the deadline and quotas; and
- safe to abandon after `module.abort_config` or process death.

Prepare MAY validate credentials through a Host service explicitly marked as a dry-run, compile templates in private temporary memory, and describe migration requirements. It **MUST NOT** publish Blocks, advance cursors, alter active model context, write active state, send external messages, or delete data.

The result **MUST** contain a prepare token, input digest, target revision,
target effective-configuration and schema digests, change class, required
quiescence, state compatibility range, estimated resource use, and warnings.
Every echoed target binding MUST equal the request. The token is bound to
transaction, generation, target revision, effective value digest, and schema
digest and **MUST NOT** be reused.

`module.commit_config` and `module.abort_config` MUST use the same transaction
identity and prepare token and MUST conform to their definitions in that same
schema. Commit and abort are mutually exclusive durable dispositions. A late
abort after commit returns `already_committed`; it cannot undo active state.
After transport loss, the Host queries `module.operation_status` with the
original transaction identity rather than repeating an unproved commit.

## 4. Quiescence and snapshots

Before replacing a Module's process generation or Extension-owned state, the
Host **MUST** fence new Activations and move that Module to `Quiescing`.
Existing Activations either:

- finish and commit under their original revision before the quiesce deadline; or
- are safely cancelled before their commit point; because cancellation is
  terminal, the scheduler later creates a new manifest from the unchanged
  cursors under the then-active revision.

A persisted Manifest that remains redispatchable after a candidate update is
immutable: its complete `effective_config`, its effective-configuration schema
digest, and every input Action's creation-time `contract_binding` remain
authoritative. An unexecuted Manifest may be safely cancelled before cutover so
that its unchanged cursors are rebuilt with the new effective configuration,
but its input Blocks retain their Action bindings. Such an input therefore
still requires a generation compatible with the retained binding or an
explicit audited input disposition. The Host MUST NOT pass the new current
configuration to an old Manifest or reinterpret an Action with the candidate
Descriptor.

The Host **MUST NOT** select a replacement process generation while an
old-generation Activation can still commit. A Host-only graph revision that
does not replace participant state follows the revision-coexistence rule in the
configuration specification and does not require this generation fence.

`module.snapshot` is called only in `Quiesced`. Its result **MUST** be an immutable envelope containing:

- Extension and Module type identity;
- the stable Host-assigned Module `storage_scope_id`;
- source package digest and generation;
- state schema version;
- config revision;
- last committed Activation or Extension operation IDs needed for deduplication;
- payload digest and byte length; and
- payload or a Host-owned opaque Asset/storage handle.

The Host **MUST** verify size and digest before accepting the snapshot. A snapshot is not complete until its envelope and referenced bytes are durably recorded. Snapshot methods **MUST NOT** clear active state.

A restore or migration whose source snapshot scope differs from the target
Module scope is an identity conflict. Cross-scope adoption requires a separate
explicit offline migration naming both scopes and cannot be smuggled through an
ordinary hot replacement or by changing a database path.

The request carries `target_storage_scope_id`; ordinary `module.restore` is
valid only when it equals the immutable snapshot scope. `module.migrate_state`
also carries `migration_kind` and the explicit target scope.
`schema_same_scope` preserves the source scope, while
`clone_to_fresh_scope` and `identity_adoption` must name a different target
scope. Identity adoption additionally requires an approval bound to the exact
source snapshot and target identity. The returned snapshot must name the target
Module, instance, and scope; the Extension cannot choose them from payload
contents. A clone-to-fresh-scope snapshot clears source-local Activation and
operation IDs unless a separate portable mapping contract explicitly replaces
each of them with a fresh target identity; source IDs remain provenance only.

The snapshot request, immutable envelope, and result MUST conform to
`ModuleSnapshotParams`, `SnapshotEnvelope`, and `ModuleSnapshotResult` in
`extension-lifecycle-rpc.schema.json`. Restore uses the exact retained envelope
and MUST return a Host-verifiable state digest. A lost snapshot or restore
response is reconciled by `module.operation_status` under the original
operation ID.

## 5. Migration

If the target package cannot restore the source schema directly, an explicit state migration is required. Migrations **MUST** declare source and target schema versions and package compatibility.

Migration **MUST**:

- run against a copy or Host-owned staging object, never the sole active state;
- be deterministic for identical input bytes and parameters;
- be idempotent by migration operation ID;
- run without unrestricted network access;
- enforce time, memory, output-size, and expansion limits;
- preserve source provenance and digest; and
- produce a new immutable snapshot envelope and migration report.

Migration params and results MUST conform to `ModuleMigrateStateParams` and
`ModuleMigrateStateResult` in `extension-lifecycle-rpc.schema.json`. The
migration operation ID, source snapshot digest, target package digest, target
state-schema version, approval identity when required, target snapshot, and
loss declaration are therefore machine-bound. `unknown` status never permits
mutation of the active source or blind creation of another migration identity.

A migration that drops, synthesizes, or semantically changes user data **MUST** declare that fact and require the configured approval class. Silent lossy migration is forbidden.

The Host **MUST** retain the pre-migration snapshot until the transaction's rollback window closes and backup policy permits deletion.

## 6. Generation replacement sequence

Package replacement follows this order:

1. verify and stage the target immutable package;
2. create a durable configuration transaction;
3. call side-effect-free prepare on affected old Modules where possible;
4. quiesce and fence the old generation;
5. take and verify required snapshots;
6. if needed, run migration and compatibility probes in a non-serving
   generation that has only read-only or independent staging handles;
7. verify the staged snapshot and prove the candidate can execute every
   surviving redispatchable Manifest's frozen configuration and retained
   Action bindings;
8. shut down the old Modules, revoke the old storage grants, terminate any
   holder of a non-revocable handle, and durably prove per-scope writer release;
9. terminate a staging probe whose grants cannot be upgraded in place, then
   spawn and initialize the target serving generation with the next active
   writer generation;
10. instantiate/restore new Modules without accepting Activations, then run
    bounded health and conformance probes;
11. reach the control-plane commit point and make the serving generation
    current;
12. allow new Activations only on the current generation.

At no step may the old and candidate generations both possess
`active_read_write` authority for one scope. A candidate with staging authority
is not a serving replacement, and its state cannot be promoted merely by
returning a successful health response. If writer release is unknown, the
transaction enters `Degraded` with that scope write-fenced. Before the Host
commit point, failure after terminating the old process may restart the old
package as a later generation from the retained snapshot; it never reuses an
old generation or silently reopens the old handle.

The old generation **MUST NOT** become current again merely because the new process exits. Generation numbers never move backward.

## 7. Commit, rollback, and Degraded state

Before the control-plane commit point, failure normally aborts the candidate, revokes its grant, and leaves the old generation current. Any participant that applied staging state **MUST** be cleaned up idempotently.

After the commit point, the target revision and generation are authoritative. Recovery SHOULD first converge forward by restarting/restoring that generation. Automatic rollback is permitted only when all of the following are proven:

- the old package remains verified and supported;
- no new-generation Activation or external side effect has committed, or a compatible reverse migration exists;
- every participant can restore the old snapshot; and
- the control-plane rollback transaction itself succeeds.

If any participant has partially committed, rollback fails, state has diverged, a reverse migration is unavailable, or safety cannot be proven, the instance **MUST** enter `Degraded`. It **MUST NOT** report the old revision as fully restored. New work for affected Modules **MUST** remain fenced until an operator chooses forward repair, verified restore, or explicit data-loss recovery.

## 8. Crash recovery

Every reload step **MUST** have a durable operation record. On Worker restart:

- operations before prepare completion are aborted;
- prepared but uncommitted operations are aborted and staging is cleaned;
- quiesced operations resume from verified snapshots;
- a durable commit point makes the target revision authoritative;
- partial post-commit application resumes forward; and
- an unresolvable or contradictory state becomes `Degraded`.

The Host **MUST** query participants using transaction and operation IDs rather than repeat unknown side effects blindly.

## 9. Downgrade policy

Package downgrade is an upgrade to a lower package version, not an implicit rollback. It requires declared state compatibility or an explicit reverse migration and passes the same verification, prepare, quiesce, snapshot, and approval gates.

If no safe reverse migration exists, the Host **MUST** reject an online downgrade. Restoring an older full backup is a separate destructive operation and **MUST** not be presented as a hot reload.

## 10. Conformance tests

The reload suite **MUST** inject process and Worker failure at every numbered sequence step and verify:

- no old generation commits after fencing;
- prepare has no active-state or external side effect;
- snapshot and migration digests detect corruption;
- operation replay is idempotent;
- failed rollback becomes `Degraded` rather than false success;
- state schema incompatibility is diagnosed before cutover; and
- package and configuration provenance remain auditable; and
- a surviving Manifest executes its creation-time effective configuration and
  Action contracts byte-for-byte across generation replacement.

## 11. Stable requirements and invariants

- `INV-XUPG-001` — Prepare is idempotent, bounded, and has no active-state, user-visible, or irreversible side effect.
- `INV-XUPG-002` — An old generation cannot commit after cutover fencing, and generation numbers never move backward.
- `INV-XUPG-003` — Migration operates on verified staging state and never destroys the sole source snapshot before commit.
- `INV-XUPG-004` — A hot replacement never overlaps active-write authority for
  one storage scope; staging is non-authoritative and an uncertain handoff
  write-fences the target.
- `REQ-XUPG-001` — Failure after the Host commit point converges forward unless a new proven-safe reverse transaction is committed.
- `REQ-XUPG-002` — Unprovable rollback or state convergence produces `Degraded`, never false rollback success.
- `REQ-XUPG-003` — Generation replacement never substitutes current configuration or Action contracts for a surviving immutable Manifest; configuration incompatibility requires a compatible generation or safe cancellation before cutover, while an input Action binding persists across rebuild and requires compatibility or an audited input disposition.
