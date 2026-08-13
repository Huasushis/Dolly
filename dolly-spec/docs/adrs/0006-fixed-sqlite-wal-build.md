# ADR 0006: Known-fixed SQLite WAL build

- Status: Accepted
- Scope: durable Runtime storage and release attestation
- Compatibility: startup-hardening change; older or unattested SQLite builds
  cease to satisfy durable conformance

## Context

Dolly's internal atomicity and recovery boundary is SQLite WAL. SQLite's
documented WAL-reset race affects releases through 3.51.2 and can corrupt a
database when checkpoint and write activity align across connections. A
single logical Runtime writer does not prove that a separate read/checkpoint
connection can never exercise the affected path.

## Decision

Dolly v1 durable-conformance builds embed upstream SQLite 3.51.3 or newer.
They attest the exact runtime/source identity, compile options, linkage mode,
and artifact digest, then verify the loaded library before any instance write.
An older or substituted library yields `STORAGE_UNSAFE_SQLITE_BUILD`; there is
no writable override.

## Alternatives rejected

- Rely on one application writer: checkpoint concurrency remains part of the
  storage design and does not prove the vulnerable path unreachable.
- Accept arbitrary distributor backports: package-version labels do not give
  one portable, machine-checkable compatibility rule.
- Warn and continue: possible corruption contradicts the Core durability
  contract.

## Verification and rollback

`TST-STORAGE-001` rejects the last affected upstream version before writes;
`TST-STORAGE-002` admits the minimum fixed version only when its attestation
matches. Release CI also stresses concurrent checkpoint/write recovery.
Rollback means running an older Dolly binary only in read-only inspection mode
until its SQLite dependency is upgraded; no schema or wire migration is
introduced by this decision.

## Primary evidence

- [SQLite WAL documentation and WAL-reset fix boundary](https://www.sqlite.org/wal.html#the_wal_reset_bug)
