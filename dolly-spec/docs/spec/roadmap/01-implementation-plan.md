# Implementation plan

The phases describe product priority and stable convergence points, not a
calendar or a global serialization barrier. The work-package DAG and the gates
in `04-critical-path-and-early-use.md` are authoritative for parallel starts.
An independent package may start when all of its own dependencies pass; it does
not wait for an unrelated deliverable merely because that deliverable appears
in an earlier numbered phase. Stable release integration still requires every
applicable convergence and acceptance gate.

`REQ-PLAN-001` — Stable integration MUST follow the work-package dependencies,
named integration gates, and applicable phase exits. Prototype work from a
later product-priority phase MUST remain isolated until every dependency it
actually consumes has passed with recorded evidence.

## Phase 0 — Specification and oracle

Deliver:

- normative semantics, schemas, ADRs, and reference abstract machine;
- source-to-requirement-to-test traceability;
- golden state, protocol, and failure vectors;
- deterministic clock/random/fault interfaces.

Exit: repository validator passes; adversarial review has no open P0/P1;
independent implementers agree on every reference vector.

## Phase 1 — Protocol simulator

Deliver a pure Core reducer, fake Extension Host, virtual clock, in-memory store
model, cross-language mock Extension, and hostile protocol corpus.

Exit: generated command sequences preserve every invariant; all wire vectors
pass under arbitrary fragmentation and reordering allowed by the protocol.

## Phase 2 — Durable Runtime Core

Deliver the shared TypeScript/Rust Runtime authority schema/migration first,
then Page/Block/Subscription/Activation repositories, transactional commit,
scheduler baseline, retention/backpressure, Tool call ledger, journal, and
crash-point instrumentation.

Exit: production Core matches the reducer; `TST-AUTH-004..006` and
kill-after-every-write tests show no partial config mapping/premise/pointer,
acknowledged input loss, partial output/cursor commit, or Module re-entry.

## Phase 3 — Extension Host and SDK

Deliver framing, handshake, generation/lease fencing, lifecycle, host services,
resource limits, snapshot/restore, hot replacement, crash quarantine, and SDK
conformance kit.

Exit: malicious and randomly crashing Extensions cannot corrupt Runtime;
incompatible versions fail clearly; reference Extension hot replacement passes.

## Phase 4 — Daemon, CLI, and config transactions

Deliver per-user `dollyd`, Worker lifecycle, controller locks, multi-instance
registry, JSON configuration proposal/import, SQLite-backed integer revisions,
prepare/quiesce/commit/recovery, authenticated local API, CLI, and minimal Web
admin. JSON never remains current authority after migration.

Exit: foreground/background conflict is impossible; same current content reuses
its revision, changed content allocates the next, partial updates become an
explicit recoverable state, and native Linux/Windows process suites pass.

## Phase 5 — Assets, secrets, Model Gateway, and Tool Broker

Deliver content store, imports/views/crops, local and optional OSS backends,
secret store, provider profiles/adapters, the closed MCP Tool Broker registry
and transports, retry/rate/cost controls, and recorded conformance fixtures.

Exit: supported source conversions, SSRF/path/media abuse, lifecycle, disk-full,
provider/tool-server error, side-effect unknown-outcome, and secret-leak tests pass.

## Phase 6 — Channel, Alarm, and Skills

Deliver CLI/Web Channel, persistent Alarm, Agent Skills catalog, progressive
loading contract, Descriptor update path, and Extension-specific diagnostics.

Exit: external multimodal round trip, restart recovery, DST/missed alarms,
Skill hot update/rollback, and no-capability-escalation pass.

## Phase 6B — Optional Extension profiles

This is an optional branch, not a dependency of base Phase 7 or base v1.
It MAY begin in parallel with the independent Alarm/Skills/LLM lanes at the
sub-gates defined in the critical-path chapter; it does not wait for those
unrelated Extensions.

Deliver the Two-Thirds Mean Filter profile and/or the NapCatQQ Channel profile
only when the distribution chooses to advertise them. The Filter work includes
the provider-neutral score Part, trusted-source state, bias-corrected fixed-point
EMA, deterministic two-thirds-mean selection, safe semantic projection, and
Activation ledger. NapCatQQ work includes a shared hub plus principal-bound
private facades, the pinned canonical-key compatibility registry, fixed
ActionContracts/validators, bounded static Descriptor, private durable event
journal with explicit retention gaps, content-free coalesced hints, private
pull views/results, independent media acquisition with top-level Assets,
sanitization, aggregate output budgeting, daemon-wide account ownership, and
facade-Activation/hub-effect ledgers.

Exit for a claimed Filter profile: numeric vectors, missing-value hold,
never-signaled exclusion, non-LLM input, nesting, identity/authority stripping,
storage-scope isolation, snapshot/restart, and every ledger crash point pass.

Exit for a claimed NapCatQQ profile: the pinned official compatibility probe,
100,000-event/Premise-bound soak, per-consumer cursor isolation, multimodal
Asset/index flow, every deny-policy path, strange upstream-name mapping,
endpoint/sanitizer abuse, exact count/byte eviction and gaps, daemon-wide
principal/self-ID owner handoff, private facade graph, every replay/effect crash
point, aggregate output limits, restart, and unknown-send tests pass. Omitted
profiles require no stub and create no v1 acceptance dependency.

## Phase 7 — LLM Extension

Deliver canonical context, provider-neutral planning, profile adapters,
structured-output validation/repair as a new audited attempt, MCP/tools,
workspace permissions, multimodal mapping, reasoning dependencies, progress,
and context-budget strategies.

Exit: required recorded and live-smoke profiles pass; two Modules cooperate;
vision/crop/tool/error/context-shrink tests pass without permanent Module stop.

## Phase 8 — Memory stable baseline

Deliver ingestion jobs, FTS, dense retrieval, fusion, rerank, provenance,
versioned facts, explicit query, and evaluation harness. Auto-injection and
consolidation remain separately flagged, disabled-by-default experiments and
MUST NOT enter the stable path in this phase without their promotion gates.

Exit: baseline reports published; self-output is not recursively indexed;
superseded facts, abstention, task resumption, provenance, resource and restart
tests pass.

## Phase 9 — Research tracks

Run independent, preregistered tracks for association/clustering;
abstraction, trajectory, and method transfer; adaptive scheduling and
versioned `tensity` hints; structured Reflection Policy; browser-tool
conformance; learning before/after controls; multi-agent topology; and pinned,
equal-budget Dolly/OpenClaw/Hermes comparison. Preregister feasibility work for
the Testament replay substrate, its learning-artifact families, the Host
Network Broker, and LevelUpper using their dedicated research contracts.
Every promotion-relevant plan and run MUST use the machine contracts in
`research/method.md`; stable integration follows promotion gates only.

Exit: the local Camoufox/MCP corpus passes before public browser benchmarks;
learning reports separate retention, same-distribution held-out, cross-domain,
negative-transfer, and update/forgetting results; comparison packets pin every
system artifact and separate framework/model/tool/harness failures; and every
track ends with reject, inconclusive, continue-research, or a fully evidenced
promotion-stage decision.

## Phase 10 — Productization and release

Deliver full UI, packaging, installers/services, backup/restore UX, operations
guide, Extension developer guide, benchmark comparison, SBOM, security review,
project identity, and acceptance packet.

Exit: every `V1-*` gate passes.

The remaining phases are explicit post-v1 research/promotion tracks. Their
prototypes MAY begin earlier only inside Phase 9 isolation. They are not
dependencies of Phase 10 and do not become stable merely by reaching an exit
criterion below. Phase numbers express preferred attention, not dependencies:
the `Testament -> artifact promotion` and `Network Broker -> LevelUpper` chains
are independent. They MAY run in parallel after their own prerequisites, but
the default priority leaves both behind v1 and advertised-profile defects.

## Phase 11 — Testament replay substrate

Deliver the isolated research Worker, immutable Corpus, full-snapshot-clone and
portable-semantic-replay modes, deterministic Module remapping, fresh Core and
Asset identity import, side-effect stripping/mocking, virtual-time controller,
hard budgets, operation ledger, pause/resume/finalization, and source-erasure
propagation.

Exit: production-write and capability-reuse probes fail closed; one-to-one,
independent one-to-many, cooperative one-to-many, and ordered many-to-one
replays pass; every materialize/import/controller/finalize crash point resumes
without duplicate semantic input; oracle-only material never reaches a target.

## Phase 12 — Testament learning and artifact promotion

Deliver distinct artifact pipelines for Memory evidence, Skills, Reflection
Policy, Premise/personality, portable Extension state, indexes, and model
adapter/weight candidates. Run no-learning, Memory-only, full-treatment,
equal-extra-budget, and family-ablation controls under immutable splits.

Exit: retention, held-out, cross-domain, negative-transfer, update/forgetting,
unaffected-task, and cost reports reproduce; all outputs remain quarantined;
any production adoption occurs only through an independent authorized
promotion transaction and family-specific compatibility review.

## Phase 13 — Host Network Broker

Deliver exact endpoint reservation, conflict detection, TLS 1.3 peer identity
and key custody, revocation/rotation, connection-bound capabilities, fencing,
bounded framed streams, quotas, diagnostics, and native Linux/Windows behavior.
Do not embed LevelUpper content semantics in this Broker.

Exit: hostile listener/client, slow peer, downgrade, stale socket, key-change,
endpoint conflict, resource exhaustion, stop/restart, and cross-instance lease
tests pass without exposing private keys or ambient sockets to an Extension.

## Phase 14 — LevelUpper bridge

Deliver per-direction revisioned shares, durable outbox/inbox and checkpoints,
ACK-after-local-commit, fresh local Block/Asset identity, portable reference
closure, binary Asset resume, default Action stripping, flow control,
backup-rollback reconciliation, and bridge-owned loop termination.

Exit: lost ACK imports once; equal content with distinct occurrences remains
distinct; two-node and triangle loops terminate; forged Core identity and
remote Actions have no authority; all inbound/outbound crash points recover;
bidirectional media transfer remains bounded; no test claims a distributed
Page, global Block ID, shared cursor, or cross-instance transaction.
