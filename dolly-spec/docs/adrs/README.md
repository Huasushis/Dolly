# Architecture decision records

ADRs document why the specification chose one observable semantic contract.
They are not substitutes for normative requirements.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-process-extensions.md) | Process Extensions, not Rust dynamic libraries | Accepted |
| [0002](0002-persisted-activation-manifest.md) | Persisted Activation manifest and atomic Runtime commit | Accepted |
| [0003](0003-stable-core-research-boundary.md) | Stable Core separated from experimental cognition | Accepted |
| [0004](0004-revisioned-config-transactions.md) | Revisioned config with failure-aware transactions | Accepted |
| [0005](0005-delivery-occurrences.md) | Multiplicity belongs to Delivery, not Block | Accepted |
| [0006](0006-fixed-sqlite-wal-build.md) | Known-fixed, attested SQLite build for WAL durability | Accepted |
| [0007](0007-opaque-versioned-research-hints.md) | Opaque versioned carrier for research hints | Accepted |
| [0008](0008-pin-mcp-2025-06-18.md) | Pin MCP 2025-06-18 until multi-round-trip effects have a durable ledger | Accepted |
| [0009](0009-memory-recall-transport-and-repeat-policy.md) | Carry recall as Blocks and make repetition context-sensitive | Accepted |
| [0010](0010-module-storage-scope-isolation.md) | Assign a stable, never-reused storage scope to each logical Module | Accepted |
| [0011](0011-two-thirds-filter-signal-and-copy.md) | Carry Filter scores as JSON Parts and emit a safe semantic copy | Accepted |
| [0012](0012-napcatqq-mailbox-and-catalog.md) | Journal QQ events and expose a bounded pull/catalog interface | Accepted |
| [0013](0013-testament-and-levelupper-boundaries.md) | Keep Testament isolated and LevelUpper identity-local | Accepted |
| [0014](0014-installed-module-activation-authority.md) | Keep installed Module activation authority upstream of execution | Accepted |
| [0015](0015-runtime-authority-database.md) | Share one Runtime SQLite authority database across TypeScript and Rust | Accepted |

Status may be `Proposed`, `Accepted`, `Deprecated`, or `Superseded`.
