# Frozen invariants

These invariants define Dolly Core. An implementation that can violate one is
non-conforming regardless of throughput or benchmark quality.

| ID | Invariant |
| --- | --- |
| `INV-CORE-001` | A committed Block's canonical bytes never change. |
| `INV-CORE-002` | Only the Runtime assigns trusted Block identity, producer, creation commit sequence, trace, and commit time. |
| `INV-CORE-003` | Every committed Block/Asset reference resolves within the same instance and permitted namespace. |
| `INV-CORE-004` | A Block may reference only Blocks with a lower `commit_seq`; the Block reference graph is a DAG. |
| `INV-PAGE-001` | A durable subscription cursor is monotonic and never passes an entry not committed, dead-lettered, or explicitly skipped by an audited operator command. |
| `INV-PAGE-002` | A durable Page entry needed by a durable subscription is not removed by retention or GC. |
| `INV-ACT-001` | A Module has at most one nonterminal Activation and at most one current live dispatch lease. |
| `INV-ACT-002` | Retrying an Activation reuses the persisted manifest, identity, graph revision, complete resolved Module-scoped effective configuration plus value/schema digests, resolved config revision (including feature flags), and input occurrence set. |
| `INV-ACT-003` | One Activation identity commits zero or one output digest; a different authenticated second digest quarantines the Module. |
| `INV-TXN-001` | Runtime output commit, every durable output Page append, lossy Page sequence reservation, Activation terminal state, and every durable input cursor advancement are one SQLite transaction; in-memory lossy append is explicitly post-commit and may be lost. |
| `INV-FENCE-001` | A stale lease token, Worker epoch, or Extension process generation cannot call privileged Host services or commit a result. |
| `INV-ROUTE-001` | An Activation uses the graph revision recorded in its manifest, not the latest graph at result time. |
| `INV-ROUTE-002` | A graph revision pins every Descriptor/policy revision used for Manifest construction; activating a new Descriptor creates a new graph snapshot rather than mutating the old one. |
| `INV-ASSET-001` | An Asset with a durable pin or committed Block reference is not physically deleted. |
| `INV-CONFIG-001` | A rejected or uncommitted config proposal never becomes the active revision. |
| `INV-REPLAY-001` | Replaying recorded Core commands, injected clocks, and identifier bytes produces identical committed state and digests. |
| `INV-SEC-001` | Secrets never appear in Block data, Extension environment, ordinary logs, traces, metrics, or admin API responses. |

## Assertion behavior

`REQ-INV-001` — A detected invariant violation MUST stop writes for the affected
instance, persist or emit a tamper-evident incident record outside the suspect
transaction, mark the instance `RecoveryRequired`, and require the documented
repair workflow. It MUST NOT auto-delete evidence or continue “best effort.”

## Research boundary

Research code MAY influence eligibility, ranking, or optional suggestions only
through a versioned capability. It MUST NOT bypass or weaken an invariant.
