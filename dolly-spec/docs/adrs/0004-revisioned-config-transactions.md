# ADR 0004: Revisioned configuration transactions

- Status: Accepted

## Decision

Configuration is strict JSON over stable keyed objects. A proposal carries a
base revision and JSON Patch, then passes validate, prepare, quiesce, Runtime
commit, participant activation, and verification. Each Activation freezes its
graph/config revision.

Partial participant commit or failed rollback yields explicit `Degraded` or
`RecoveryRequired`; Dolly does not claim distributed ACID across processes.

## Rationale

Direct file edits race with running Modules. Pretending arbitrary Extension
state can always roll back hides the most dangerous failure. Revisions make
conflicts, audits, and replay deterministic.

