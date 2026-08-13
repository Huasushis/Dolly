# Conformance and compatibility

## Conformance targets

Conformance is claimed separately for:

| Target | Mandatory evidence |
| --- | --- |
| Core Runtime | reference-machine, schema, property, crash-point, and recovery suites |
| Extension Host | wire, lifecycle, fencing, hostile-peer, and resource-limit suites |
| Extension | manifest plus extension-specific protocol and failure suites |
| Daemon/Worker | process, lock, auth, configuration, backup, and platform suites |
| Provider Adapter | recorded-fixture and live smoke conformance for one profile revision |
| Dolly v1 distribution | all `V1-*` gates on Linux and Windows |

`REQ-CONF-001` — A partial implementation MUST name the exact conformance
targets and capability versions it passes. “Dolly-compatible” without this
matrix is not a valid claim.

## Compatibility negotiation

`REQ-CONF-002` — Peers MUST negotiate a protocol major version and named
capabilities during initialization. No common major version yields
`protocol_version_unsupported` at the transport layer and immediate graceful
shutdown.

A peer MUST NOT infer a capability from a version number alone. Optional fields
and methods are legal only when their capability was negotiated.

## Unknown and future data

Durable data is closed-world. Unknown durable event kinds or schema versions
MUST stop startup in `MigrationRequired`; they MUST NOT be skipped. Wire
notifications explicitly declared ignorable may be ignored and counted.

## Error contract

Every public error contains:

- stable `code`;
- `retryable`, which is true only when the same semantic operation may be
  retried under its original idempotency identity and method policy;
- `outcome`: `not_applied`, `applied`, or `unknown`;
- safe `message`;
- optional `correlation_id`;
- structured `details`.

A caller MUST NOT infer that `retryable: false` means a new semantic request is
safe. `outcome: unknown` always invokes the method-specific reconciliation or
operator policy.

Stack traces, secrets, raw provider payloads, and filesystem paths outside the
instance root MUST NOT cross an unprivileged boundary.

## Feature flags

`REQ-CONF-003` — Research and preview features MUST be off by default, named,
versioned, observable, and reversible. The resolved flag snapshot is part of the
normalized configuration named by the Activation manifest's immutable
`config_revision`; v1 does not duplicate it as a second manifest field. A retry
uses that exact revision even if active configuration changed meanwhile.

## Deprecation

A stable capability may be removed only in a major version. It MUST first be
marked deprecated for at least one minor release and emit a bounded diagnostic.
Security revocation may be immediate, but startup MUST explain the revocation
and the safe remediation.
