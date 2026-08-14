# Architecture Decision Records

An architecture decision record (ADR) captures a decision that affects more
than one Dolly subsystem. A document is not authoritative while its status is
`Proposed`.

Status values:

- `Proposed`: under cross-review; implementation must not claim conformance.
- `Accepted`: normative and takes precedence over Draft specifications.
- `Superseded`: replaced by a later ADR, which must be linked.
- `Rejected`: considered and deliberately not adopted.

An ADR may become `Accepted` only after its affected contracts, migration
impact, failure modes, and conformance tests have been reviewed together.

Current proposals:

- ADR-0001: per-consumer at-least-once delivery;
- ADR-0002: extension process isolation and session authorization;
- ADR-0003: one Media identifier within each Dolly instance;
- ADR-0004: deterministic scheduling as the default;
- ADR-0005: persisted random instance identity;
- ADR-0006: shared model provider broker selected by model
  description;
- ADR-0007: crash-recoverable synchronous cross-process locks.
- ADR-0009: Linux Core service ownership of Module processes and per-Module
  control groups.
- ADR-0010: Host-internal configuration-value upgrade chain.

Rejected decisions:

- ADR-0008: per-generation transient systemd user services were rejected because
  a delayed creation request can arrive after recovery, and systemd cannot make
  `InvocationID` an atomic precondition of stopping a unit by name.
