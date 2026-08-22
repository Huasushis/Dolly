# ADR 0015: Share one Runtime SQLite authority database

- Status: Accepted
- Scope: TypeScript/Rust configuration revision identity, installed Module prerequisites, restart, and legacy migration
- Compatibility: fail-closed clarification within the pre-implementation v1 draft
- Affected requirements: `REQ-AUTH-001` through `REQ-AUTH-005`, `INV-AUTH-001`, `INV-AUTH-002`, `REQ-ACT-002` through `REQ-ACT-005`

## Context

TypeScript configuration loading needs a stable positive integer revision, while
Rust recovery needs exact persistent policy, installed-component, service, and
premise records. A digest-derived integer can collide and makes `A -> B -> A`
reuse history. Independent JSON and SQLite stores create two current pointers
and an unresolvable crash window. A path, copied object, live function, or
backend label cannot prove database or execution authority.

## Decision

One Dolly instance has one Runtime SQLite authority database, shared by the
TypeScript and Rust implementations and identified internally by
`(daemon_installation_id, instance_id)`. A filesystem path locates candidate
bytes but does not establish identity or ownership. Writable access requires
the same exclusive instance controller lock, SQLite attestation, WAL,
`synchronous=FULL`, foreign keys, disabled trusted schema, schema version, and
integrity checks used by Core.

Schema version 1 stores an append-only mapping from each positive integer config
revision to exact canonical resolved-config bytes and their SHA-256 digest. An
exact current digest and byte match reuses the current revision. A changed
current digest allocates the next integer; historical digest equality is
ignored, so `A -> B -> A` allocates a new revision. Digests are integrity fields,
not globally unique keys or integer allocators.

The same transaction inserts the new mapping; exact installed-component
origins, permission-policy definitions and backend bindings; one product-owned
service candidate; and exact premise-policy selections. It writes the complete
Module activation premise last, then updates the current pointer and journal.
Commit exposes all or none. The closed records contain no secret, endpoint
credential, path, function, live object, capability, runtime binding, stop
prover, or recovery handoff.

Legacy JSON import is offline under the same lock. It validates, normalizes,
digests, and commits schema version 1 once. Before commit it remains only import
input; after commit SQLite is sole authority even if archival of the JSON file
is interrupted. Reopen never chooses between the two.

## Alternatives rejected

- Hash or truncate a digest into a revision: collisions and historical reuse
  violate monotonic revision identity.
- Globally unique digest columns: equal bytes across distinct scoped identities
  are valid and a digest is not the record identity.
- Separate TypeScript and Rust authority stores: no transaction can publish one
  current revision and one complete premise set across them.
- Let a configured path or same-label component establish ownership: both are
  substitutable locators, not installed or controller-owned identity.
- Serialize functions, credentials, backend objects, or live permissions:
  deserialization cannot recreate current Host authority.

## Consequences and rollback

Both language implementations must use the versioned schema and transaction
semantics before TypeScript H1 configuration work can claim revision authority.
Crash/reopen/stale/mismatch/cross-origin conformance vectors are mandatory.
`tool_call_ledger` remains in the same database and keeps its existing dispatch
semantics.

No stable product authority database exists, so this is a compatible fail-closed
clarification. After deployment, rollback or schema replacement requires an
offline expected-version migration preserving every mapping and prerequisite.
This decision does not weaken `RUNTIME_MODULE_MIGRATION_REQUIRED` and makes no
global aggregate-boundedness claim for `FileCoreStateStore`, file-backed result
journals, or any other composition.
