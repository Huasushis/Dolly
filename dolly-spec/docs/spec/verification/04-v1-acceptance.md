# Dolly v1 acceptance

Every gate is mandatory unless an explicit platform qualifier is stated.

| Gate | Acceptance evidence |
| --- | --- |
| `V1-01 Platform` | packaged native builds pass full Core/Host suites on current supported Ubuntu LTS and Windows; macOS is compile/smoke only |
| `V1-02 Process modes` | foreground, daemon-managed, restart, multi-instance, duplicate-lock, and parent-death tests pass |
| `V1-03 Core separation` | dependency audit proves Core has no provider/UI/Extension implementation dependency |
| `V1-04 Extension resilience` | crash, hang, malformed frame, stale result, crash-loop quarantine, and hot replacement suites pass |
| `V1-05 Config` | revision conflict, prepare failure, quiesce timeout, partial commit, rollback failure, and recovery tests pass |
| `V1-06 Page semantics` | ordering, occurrence, durable/lossy retention, quota, dead-letter, and million-entry slow-subscriber tests pass |
| `V1-07 Block/Asset` | schema, reference DAG, import/crop/pin/GC, SSRF/path/media abuse, OSS optional-path tests pass |
| `V1-08 Channels` | CLI and Web can exchange text and supported multimodal Assets with auth and session isolation |
| `V1-09 Multi-LLM` | two LLM Modules communicate through Pages and complete recorded text/vision/tool scenarios |
| `V1-10 Providers` | at least one text/reasoning and one vision profile pass adapter conformance; every advertised non-text output modality additionally passes requested-subset, Asset import/MIME/size/lease, crash/status, and no-duplicate-dispatch conformance; requested DeepSeek/Qwen profiles are supplied when available through configured providers |
| `V1-11 Tools/MCP` | closed Tool Broker registry and transport configuration, exact MCP 2025-06-18 initialize/initialized conformance plus rejection of silent version fall-forward and 2026 MRTR, schema-digest/config-revision binding, stdio and Streamable HTTP lifecycle, hot-update drain/cutover, multi-turn model/tool traces, cancellation, output limits, permission denial, side-effect unknown outcome, reconciliation, and prompt-injection tests pass |
| `V1-12 Skills` | standard catalog discovery, progressive loading, validation, hot update, rollback, and capability non-escalation pass |
| `V1-13 Memory baseline` | hybrid retrieval/provenance/update/abstention pass; effective query-basis self-exclusion, no self-index loop, unique result identities, typed external Memory evidence, and same-request deduplication pass; fixed LongMemEval/LoCoMo and Dolly task-switch reports are published |
| `V1-14 Alarm` | persistent one-shot/repeating/acknowledged alarms pass virtual-clock, restart, DST, missed-fire, and race suites |
| `V1-15 Observability` | journal replay reproduces Core digest; trace correlation, redaction, rotation, cardinality, and diagnostics-bundle tests pass |
| `V1-16 Recovery` | exhaustive named crash points, known-fixed SQLite build/startup gate, WAL checkpoint/write concurrency regression, backup/restore, migration, corruption detection, and disk-full recovery pass |
| `V1-17 Research` | harness validates immutable plan/run records and reproduces registered Memory repeat/context-selection, association, abstraction/transfer, Reflection, scheduler/versioned-hint, browser, learning, topology, and pinned framework-comparison experiments; no ungated research path is enabled by default |
| `V1-18 Documentation` | schemas, protocol guide, Extension SDK guide, operations guide, security model, benchmark reports, ADRs, and clause-level source→requirement→implemented-test/manual-procedure inventory are complete; umbrella-only draft IDs do not pass |
| `V1-19 Optional profiles` | each advertised optional profile independently passes its complete schema, state, lifecycle, resource, security, migration, upstream-compatibility, and adversarial suite; an omitted profile creates no base-v1 blocker |

## Release blockers

`REQ-V1-001` — Any invariant violation, silent data loss, stale-generation
commit, dangling durable reference, secret disclosure, unauthenticated admin
mutation, unrecoverable supported migration, or unclassified external side
effect is a release blocker.

`REQ-V1-002` — A benchmark score cannot waive a release blocker.

## Acceptance packet

The release packet contains signed checksums of source commit, binaries,
schemas, migrations, test corpora, benchmark datasets, recorded provider
fixtures, test reports, SBOM, known risks, and backup/restore rehearsal. Results
must identify real Linux and Windows hosts, not emulation alone.

Testament and LevelUpper research records may appear in the packet as
reproducibility evidence, but their absence is not a base-v1 failure and their
presence is not a stable product claim. Any later stable claim needs a new
versioned acceptance gate after promotion.
