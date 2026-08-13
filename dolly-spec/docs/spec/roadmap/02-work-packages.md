# Work packages

Work packages expose dependency and completion evidence. Effort bands are
relative (`S`, `M`, `L`, `XL`) and are not schedule promises.

`REQ-PLAN-002` — A work package is complete only when its named dependency
packages have passed and its completion evidence is reproducible; an
end-to-end demonstration alone MUST NOT close a package.

| WP | Deliverable | Depends on | Band | Completion evidence |
| --- | --- | --- | --- | --- |
| `WP-001` | schemas and canonical JSON library | Phase 0 semantics | M | cross-language corpus |
| `WP-002` | reference reducer and vector runner | WP-001 | L | state-hash parity |
| `WP-003` | SQLite repositories/migrations | WP-001 | L | crash-point suite |
| `WP-004` | Page/Activation transaction engine | WP-002/003 | XL | model-based parity |
| `WP-005` | scheduler/backpressure/retention | WP-004 | L | backlog/slow subscriber soak |
| `WP-006` | Extension framing and lifecycle | WP-001/002 | XL | hostile peer kit |
| `WP-007` | SDK plus mock Extensions | WP-006 | L | two-language conformance |
| `WP-008` | daemon/worker/process control | WP-003/006 | L | native OS suite |
| `WP-009` | config revision/update recovery | WP-004/006/008 | XL | partial failure matrix |
| `WP-010` | Asset service | WP-003/006 | XL | import/GC/security suite |
| `WP-011A` | secret store and exact external-I/O policy | WP-006/008 | M | SecretRef, redaction, exact egress, lifecycle, and denial fixtures |
| `WP-011B` | Model Gateway | WP-006/008/010/011A | L | provider, multimodal-output, cost, retry, and redaction fixtures |
| `WP-011C` | Tool Broker | WP-006/008/011A | L | pinned MCP, hostile server, permission, and unknown-effect fixtures |
| `WP-012` | observability/replay | WP-002/003 | L | replay hash and bounded telemetry |
| `WP-013A` | Channel text, ingress, and effect ledger | WP-004/006/011A/012 | M | text round trip, ingress reconciliation, authorization, and unknown effect |
| `WP-013B` | Channel multimodal profile | WP-010/013A | M | Asset import/send, MIME, lease, and media abuse round trip |
| `WP-014` | Alarm | WP-006/003 | M | virtual time/DST/restart |
| `WP-015` | Skills | WP-006/009 | M | hot update/capability tests |
| `WP-016` | LLM Extension | WP-010/011B/011C/015 | XL | adapter/tool/context suite |
| `WP-017` | Memory baseline | WP-003/010/011B/012 | XL | retrieval/task-switch report |
| `WP-018` | admin Web UI | WP-008/009/012 | L | auth/CSRF/accessibility/E2E |
| `WP-019` | research harness and plan/run registry | WP-002/012/016/017 | XL | schema-valid immutable plans/runs; abstraction, Reflection, browser, learning, topology, and pinned framework-comparison packets |
| `WP-020` | packaging/release | required stable WP-001 through WP-019, interpreting split package families as all required members | XL | `V1-*` packet |
| `WP-021A` | Filter schema, arithmetic oracle, and fake-Host logic | WP-001/002 | M | fixed-point, hold, malformed, dedup, selection, and safe-projection vectors |
| `WP-021B` | Two-Thirds Mean Filter optional profile | WP-004/006/010/012/021A | M | Activation-ledger crash, nesting, Asset, lineage, lifecycle, and storage-scope suites |
| `WP-022A` | NapCat registry compiler, normalizer, fixed contract/config schemas, and fake server | WP-001/002 | M | canonical operation-key/exact upstream-name map, role-specific config roots, fixed validator IDs/resources, pinned sanitizer/registry digests, URI corpus, and recorded WebSocket/HTTP faults |
| `WP-022B` | NapCat shared hub and read-only private-facade profile | WP-003/004/006/008/009/011A/012/013A/022A | L | fixed mailbox/conversation ActionContracts and argument/result/profile-admission validators; daemon owner; exact per_extension placement/output/ingress/privacy graph; journal eviction/gaps; exact content-free hint; general hub-operation replay; cursor, restart, and storm suites |
| `WP-022C` | NapCat guarded send and multimodal profile | WP-010/013B/022B | L | fixed QQ send/media contracts and admission validators, QQ view epoch, allowlist/deny race, facade Activation/general hub operation/effect/import ledgers, unknown/partial, hub-owned private media ingress/Core Asset, aggregate output budget, and rollback suites |
| `WP-022D` | NapCat full optional profile | WP-022C | L | complete closed safe registry/sanitizer coverage, management policy, sanitizer drift, daemon ownership, ordered cohort shutdown/hot-reload, and native soak |
| `WP-023` | Testament Corpus and replay substrate | WP-002/010/012/019/020 | XL | immutable corpus, semantic remap, isolation, budget, and crash-resume packet |
| `WP-024` | Testament artifact and promotion pipelines | WP-015/017/023 | XL | family-specific quarantine, ablation, transfer, forgetting, and promotion packets |
| `WP-025` | Host Network Broker | WP-006/008/009/011A/012/020 plus an accepted research plan | XL | first freeze the closed reserve/listen/connect/accept/read/write/status/revoke RPC/schema registry and operation-reconciliation contract; then pass mTLS identity, endpoint, capability/fencing, hostile-stream, lifecycle, and native-platform suites |
| `WP-026` | LevelUpper bridge | WP-004/010/012/025 | XL | commit-fenced outbox/inbox, frozen wire corpus, fresh-identity, Asset, ACK-loss, loop, backup, and crash-point suite |
| `WP-027` | future promotion decisions | WP-019 plus each candidate WP | M | separate accept/reject/inconclusive packet for Testament, Network Broker, and LevelUpper |

## Integration rule

Each package starts behind a boundary test double. It is integrated first with
recorded deterministic dependencies, then fault injection, then live services.
No package is accepted solely because an end-to-end demo succeeded.

`WP-021A/B` and `WP-022A-D` are conditional: they gate only a distribution that
advertises the corresponding optional profile. `WP-023` through `WP-027` are
research/future packages and do not gate `WP-020` or base v1. A future stable
release MUST create a new release-plan dependency only after the applicable
promotion packet is accepted; completion of a research WP alone is not that
decision.

## Recommended first vertical slice

Use one durable Page, one echo Extension, one Module, one output Page, the CLI
Channel, a virtual clock, and SQLite. It must already use the final framing,
manifest, transaction, fencing, journal, and schema contracts. This is a
semantic slice, not a disposable prototype.
