# ADR 0010: Bind Module state to a Host-assigned storage scope

- Status: Accepted
- Scope: Extension multi-hosting, Module restart/restore, shared physical databases
- Compatibility: protocol-contract extension within the pre-implementation v1 draft
- Affected requirements: `REQ-ID-005`, `REQ-XCAP-003`, `INV-XCAP-004`

## Context

`module_id` is human-configured and Extension processes may host many Modules.
Several Memory Modules can intentionally use one physical database, while
process replacement must reopen the same logical state. A path, table name, PID,
Extension generation, or Module display name cannot distinguish logical
ownership safely. Deleting and later reusing a Module ID could otherwise attach
old Memory, view, filter, or side-effect state to an unrelated Module.

## Decision

The Host assigns one stable never-reused UUIDv7 `storage_scope_id` to each
logical Module before first instantiation. Initialization, state handles,
instantiate result, activation-ledger continuity, replay evidence, snapshot,
restore, migration, backup, and deletion bind that identity. Restart changes
Worker/process fences but preserves the scope. Destructive reset creates a new
scope.

Configured Page and Module IDs are tombstoned after removal. Reusing one is an
explicit offline identity-adoption migration, not an ordinary create.

Module configuration cannot use a raw writable path as its isolation contract.
A shared physical database uses a scope-owned tenant/schema and includes the
scope in every semantic key and transaction. Collision or an incapable backend
fails before write.

## Alternatives rejected

- `module_id` only: can be accidentally reused and is not globally scoped.
- process generation: changes on every restart and would make recovery look
  like new state.
- one database per process: one process may host several Modules, and a package
  restart must preserve state.
- user-selected paths or prefixes: permit collision, path escape, and silent
  cross-instance adoption.

## Consequences and rollback

The pre-implementation protocol schemas gain the field and schema-bundle
digests change transitively. A future implementation must migrate any prototype
state by assigning and recording scopes before enabling concurrent Modules.
Rolling back this decision would make isolation and recovery ambiguous, so no
compatible rollback is defined after stable data exists; restore must use a
scope-aware release.

