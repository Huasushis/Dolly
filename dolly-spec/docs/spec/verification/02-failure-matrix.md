# Failure matrix

This matrix specifies recovery, not merely what to test. “Retry same” means the
same persisted identity and bytes; “new attempt” means a new identity and audit
link. External effects are never described as exactly once.

| Failure point | Durable state on restart | Required action | User-visible outcome |
| --- | --- | --- | --- |
| loaded SQLite is older than 3.51.3 or differs from the release attestation | instance remains unopened for writes | permit only read-only inspection or refuse startup; never migrate, recover-write, checkpoint, or accept an unsafe override | `STORAGE_UNSAFE_SQLITE_BUILD` with observed and required identities |
| installed Linux Module inspected on a non-Linux Host | no controller lock, configuration claim, writable Core store, systemd query, cgroup write, process, or capability exists | return `MODULE_ACTIVATION_PLATFORM_UNSUPPORTED`; do not probe later premises | startup refused without writable residue |
| current configuration, permission-policy definition/binding, installed-product origin, service candidate, revision, or digest cannot be proven exactly | controller lock may be held, but no activation permission, recovery handoff, installed composition, process, or capability exists | unwind under the lock and refuse; Ready/process/result/acknowledgement/absence cannot fill the premise | `MODULE_ACTIVATION_PREMISES_INVALID` or `MODULE_ACTIVATION_POLICY_BINDING_UNAVAILABLE` |
| authority transaction crashes before commit while allocating a changed config | prior current pointer/mapping and all prerequisite sets remain; candidate has zero visible rows | reopen under the same controller lock and retry the same validated candidate; never skip to the attempted integer | prior revision remains authoritative; no partial premise or live authority |
| authority transaction commits, then acknowledgement or legacy-JSON archival is lost | complete next mapping, prerequisite rows, premise, journal event, and current pointer are visible | reopen SQLite, verify exact bytes/digests, return the committed revision, and ignore legacy JSON for selection | one committed revision; no duplicate allocation and no dual authority |
| authority database path, stored installation/instance identity, current pointer, digest/content, or installed-component foreign key mismatches on reopen | suspect database remains unopened for recovery writes; no live binding, handoff, process, or Ready exists | fail closed under the lock; never repair from path, copied rows, legacy JSON, logs, process evidence, or equal labels | `STORAGE_CORRUPT` or the specific activation premise error |
| crash after live backend binding or recovery handoff mint | persistent premise bytes remain; old object brands and handoff belong to the dead controller generation | reacquire, re-claim, revalidate, remint all live bindings/permissions, rerun recovery, and issue a fresh one-use handoff | stale objects rejected; no generation or handoff reuse |
| before Activation manifest transaction | no Activation | scheduler may select later | no attempt recorded |
| after manifest commit, before lease | Activation `ready` | select only a frame-compatible generation, then lease the same Manifest | delayed, no input loss |
| after lease commit, before durable `started` marker | attempt is `prepared`; transport invariant proves no frame byte was eligible | fence the empty/old slot, record `safe_before_dispatch`, retry same within limits | delayed, no input loss |
| after `started` marker or partial frame write | leased manifest; possible dispatch; no valid response | terminate/fence, then apply the exact frozen replay contract; `never_auto_retry` quarantines | protocol fault plus delayed safe retry or operator-required quarantine |
| Extension receives request, before private state write | same conservative `started` evidence | do not infer non-execution; `pure_compute` or a compatible activation ledger may authorize replay, otherwise quarantine | possible repeated computation only where the frozen contract permits it |
| Extension private state write, before response | same as above | only the approved activation-ledger namespace/version may return or reconcile the same `(activation_id, manifest_digest)` | no second private transition when ledger evidence is valid |
| provider accepts billable request, response lost | provider outcome unknown | do not blind-retry unless adapter policy and key prove safety | `ExternalOutcomeUnknown`; operator/policy decides |
| Provider completes media output, crash after output-ordinal binding but before Asset import response | Provider result skeleton and `(request_id, ordinal) -> import_id` binding are durable; model operation is `running` | query the original Asset Import IDs, resume only their legal recovery transitions, and never redispatch the Provider | delayed complete response or explicit post-Provider failure; Provider dispatch count remains one |
| output Asset reaches `AVAILABLE`, crash before Model result commit | verified Asset, byte length, sniffed MIME, finite model-output lease, and original binding remain | reconstruct the exact response from retained output order and Asset records, then commit the original model result | one response with one Asset occurrence; no URL/bytes exposure and no duplicate generation |
| output Asset MIME/decoder/size validation fails or temporary URL expires after Provider completion | Provider application/billing is complete; Asset import is terminal rejected or cannot become available | fail the original Model operation with the stable output-Asset code and `outcome: applied`; release staging/leases by policy; never omit the occurrence or retry Provider | explicit failed generation, no dangling Asset Part and no false success |
| tool side effect occurs, result lost | external outcome unknown | query by idempotency key if tool supports it; otherwise stop Activation | explicit unknown outcome, never “success” |
| response bytes received, before result-stage SQLite commit | no authoritative result; Manifest and per-attempt dispatch evidence retained | terminate/fence first; `never_auto_retry` quarantines, `pure_compute` requires no effect evidence, and `activation_ledger` requires the exact retained ledger; unpersisted response bytes are not digest authority | delayed same-Activation retry or explicit operator-required quarantine; no cursor advance |
| result-stage SQLite commit succeeds, before `ApplyResult` | Activation `result_staged` with exact authoritative payload and digest | apply those persisted bytes without Module reinvocation; durable Page pressure transitions to `commit_blocked` and retries only application | delayed commit, one eventual Runtime output |
| Runtime commit succeeds, response to Extension lost | Activation `committed` | status query returns committed digest; duplicate equal result is success | one Runtime output |
| result retry has different digest | first digest or committed output retained | reject, quarantine Module | `ACTIVATION_RESULT_CONFLICT` |
| Worker dies during SQLite transaction | transaction absent or fully present | SQLite recovery, invariant scan | no partial cursor/output |
| Page append allocation hits quota | no commit | backpressure/reject producer; durable cursor unchanged | `PAGE_BACKPRESSURE` |
| dead-letter write fails | original Delivery remains blocking | retry/repair storage; do not advance cursor | subscription stalled and observable |
| Asset temp write fails | no available Asset, temp eligible for cleanup | return import failure | no dangling Asset reference |
| Asset rename succeeds, DB commit fails | orphan content object | startup reconciliation removes after grace period | import failed, storage reclaimed |
| Asset DB commit succeeds, response lost | available Asset exists | same import key resolves existing Asset | no duplicate logical Asset |
| GC races with a generated Asset before its Block commits | finite model-output lease or atomic durable Block reference exists | lease wins before tombstone, or Block reference wins atomically; after abort/expiry the ordinary GC policy applies | valid prepared reference remains usable, or commit fails explicitly; never a dangling Asset ID |
| OSS upload succeeds, metadata commit fails | remote orphan under Dolly prefix | reconciler deletes by upload id | no Block references it |
| OSS delete fails during GC | Asset lifecycle `TOMBSTONED`, replica state `delete_failed` | retry with backoff; retain metadata | capacity warning, no false `PURGED` claim |
| config validation fails | active revision unchanged | reject proposal | deterministic validation errors |
| one Extension prepare fails | active revision unchanged; prepares aborted | abort all successful prepare tokens | proposal failed |
| Worker dies after prepare, before commit | active revision unchanged | expire/abort tokens on recovery | proposal failed/retryable |
| config commit partly reaches Extensions before Host commit | base revision active; participant receipts recorded | enter `RollingBack`; prove compensation or become `Degraded` | not reported as atomic rollback |
| Host config commit succeeds but target participant activation fails | target revision authoritative | enter `ForwardRecovering`; fence mismatched participants | explicit degraded state if convergence cannot be proven |
| rollback command fails | last proven revision and receipts retained | transaction and instance become `Degraded`; operator workflow | explicit degraded state |
| old Extension returns after replacement | stale generation | reject every Host RPC/result | transport `stale_generation` plus domain fence error |
| Extension process hosts several Modules and one Module faults | distinct storage scopes and per-Module lifecycle state remain | quarantine/fence only the affected Module unless the process itself is unsafe; a process restart restores every Module by its own scope | unaffected Modules retain state and cursors; shared process death is visible as a bounded interruption |
| two Modules open one physical private-state database | distinct Host-issued storage scopes exist | broker every operation with an injected tenant key and reject unscoped SQL/index access | automatic logical isolation; no name/path convention is treated as proof |
| snapshot or restore names another Module's storage scope | no target state is changed | reject before opening/importing payload; quarantine malformed package if repeated | `STATE_SCOPE_MISMATCH` |
| Module config is deleted, then an unrelated Module requests the old ID | Module/Page ID and storage-scope tombstones remain | reject reuse; require a fresh configured identity and scope | `CONFIG_ID_TOMBSTONED` |
| Filter prepared EMA/selection state, response or Core commit is lost | exact prepared decision and observation keys remain under Module scope | query Activation status; promote once on committed, return identical result on redispatch, or discard only on authoritative non-apply | no double weighting and no duplicate external authority |
| Filter receives malformed present signal from one source | prior committed value remains; malformed Block is recorded as rejected candidate | exclude that Block, continue bounded processing of unrelated sources, emit diagnostic | omission is not fabricated; other sources may still produce one result |
| NapCat event received, crash before private journal commit | upstream has no universal replay cursor; event durability is unknown | reconnect, record a gap, run only bounded supported reconciliation | explicit possible-loss range; never a lossless claim |
| NapCat event journaled, content-free private-hint response lost | hub journal plus per-principal notification intent/idempotency key remain | query ingress status and complete or retry the identical two-field hint to that facade's private Page | at most one logical wakeup per coalesce slot; no mailbox content leaks; message stays queryable |
| NapCat append crosses count/byte capacity or disk fills | exact journal floor, consumer cursors, gap ledger, and storage outcome remain | atomically evict a complete prefix plus retention gap; if no marker fits, disconnect and add a possible-loss gap on recovery | cursors are not silently advanced; no hint names an unjournaled event |
| NapCat send dispatched, response or facade result lost | facade Activation intent and hub outbound ledger identify the same principal/Action/digest; external outcome may be unknown | fenced replay returns the prior result or reconciles the same hub operation; without authority mark `Unknown` | possible prior send is explicit and never duplicated blindly |
| NapCat hot replacement or duplicate account owner races across Extension processes | Host account principal, probed actual self ID, old owner epoch, and candidate generation are known | daemon-wide registry grants only fenced handoff; stale socket cannot journal/send; reject cross-daemon active write in v1 | exactly one daemon owner for the principal/self pair; unsupported configurations fail closed |
| Testament import/controller step crashes | immutable Corpus plus prepared operation disposition remains in sandbox | reconcile the same operation and idempotency key; never mint a new source identity to escape uncertainty | run resumes or quarantines without production mutation |
| LevelUpper entry committed locally, ACK lost | receiver inbox and local ingress result are durable; sender outbox remains | retransmit same ForeignEntryKey; receiver returns the exact checkpoint ACK | one local occurrence, eventual pin release |
| LevelUpper starts from stale backup/checkpoint | hash chain or peer high-water disagrees | enter `ReconciliationRequired`; do not skip, reset, import, or ACK | operator-visible blocked share, no silent fork |
| daemon dies | Workers receive parent death/connection loss | terminate and recover under new daemon | bounded interruption |
| backup copy interrupted | no valid completed manifest | discard incomplete backup | prior backups unchanged |
| migration crashes before version marker commit | old schema or transactional rollback | rerun migration idempotently | startup delayed |
| migration crashes after marker commit | new schema | verify checksum and continue | no second semantic migration |

## Stable classifications

`REQ-FAIL-001` — Recovery code MUST distinguish:

- `SafeToRetrySame`: replay the identical durable command;
- `SafeToRetryNew`: prior attempt is terminal and a linked new command is safe;
- `ExternalOutcomeUnknown`: duplication risk exists outside Dolly;
- `OperatorRequired`: automatic progress could violate an invariant;
- `PermanentInputError`: changing time alone cannot make the input valid.

`REQ-FAIL-002` — A timeout is not evidence that an operation did not occur.
Adapters and tools MUST NOT translate timeout into `SafeToRetrySame` without an
enforced idempotency or status-query contract.

## Crash-point instrumentation

Every durable transition implementation MUST expose test-only crash labels
immediately before and after each transaction commit, filesystem atomic replace,
process handoff, and external request acknowledgement. The test harness kills
the process at each label and compares recovery to this matrix.
