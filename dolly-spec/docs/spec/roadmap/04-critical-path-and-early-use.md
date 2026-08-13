# Critical Path, Parallel Lanes, and Early-Use Gates

Status: normative roadmap for integration order and conformance claims. It does
not assign calendar dates or relax any Core, security, or recovery requirement.

`REQ-PLAN-003` — Development MAY proceed in parallel, but an artifact may enter
an integrated or user-data-bearing stage only after its named dependency gates
pass. A phase number is not a global serialization barrier. A prototype behind
a fake Host or recorded transport MUST remain unable to open production state,
credentials, Pages, or external-effect capability until its integration gate.

`REQ-PLAN-004` — “Can be used” MUST name one of the stages in this chapter.
Passing a happy-path demo, connecting to a real account, or receiving one model
response does not authorize the next stage. Every stage has an explicit data,
effect, backup, observability, and rollback boundary.

`REQ-PLAN-005` — The shortest supported schedule freezes narrow compatibility
surfaces and runs independent work packages against simulators. It MUST NOT
shorten the schedule by letting an optional Extension depend on Runtime-private
APIs, by changing a frozen Activation outcome, or by combining unknown external
effects with automatic retry.

## 1. Integration checkpoints

The checkpoints are narrower than whole product phases so an Extension does not
wait for unrelated provider or UI work.

| Gate | Required evidence | What becomes safe to integrate |
| --- | --- | --- |
| `G0 Contract candidate` | WP-001/002 schemas, reducer, protocol vectors, deterministic clock/fault interfaces | generated SDKs, fake Host, offline adapters, no real user data |
| `G1 Durable activation` | WP-003/004 plus manifest, result-stage, cursor, Activation-status, replay-evidence, crash-point, and fixed SQLite gates | stateful Module logic against the real Core transaction boundary |
| `G2 Extension substrate` | WP-006/007 plus lifecycle, `storage_scope_id`, capability, ingress/status, activation-ledger, stop/restart, snapshot, and generation-fence suites | real Extension processes with test Pages and test storage |
| `G3 Operable local substrate` | WP-008/009/011A/012 daemon, config transaction, SecretRef, external-I/O policy, logs/replay, backup of Module scopes | supervised local processes and credentialed shadow connections |
| `G4 Content/channel substrate` | WP-010/013A/013B Asset and Channel text/effect/multimodal contracts | authorized external content and guarded outbound messaging |
| `G5 Agent substrate` | WP-011B/011C/015/016 Model Gateway, Tool Broker, Skills, and LLM Extension gates | interactive LLM use through recorded then live-smoke profiles |
| `G6 Stable baseline` | required stable WPs, Memory baseline, native platform, recovery, security, and `V1-*` packet | v1 claim; optional profiles remain conditional |

`WP-011A`, `WP-011B`, `WP-011C`, `WP-013A`, and `WP-013B` are the
subpackages defined in the work-package table. A gate names only the subset it
needs. For example, NapCatQQ does not wait for Model Gateway or Tool Broker to
open a shadow connection; it does wait for the SecretRef and network-policy
subset.

After a gate becomes a compatibility candidate, a dependent branch pins its
SDK/schema bundle digest. Later breaking work is introduced behind a versioned
adapter or on a new protocol revision. Developers do not repeatedly edit the
NapCatQQ journal or Filter state format to follow an unversioned Runtime branch.

## 2. Dependency graph and useful parallelism

The main dependency graph is:

```text
WP-001 schemas
  -> WP-002 reducer ---------------------------> WP-004 transaction engine
  -> WP-003 durable repositories --------------^       |
  -> WP-006 framing/lifecycle -> WP-007 SDK ------------+-> WP-008 daemon
                                                        +-> WP-010 Assets
                                                        +-> WP-012 observability

WP-004 + WP-006 + WP-008 -> WP-009 config transactions
WP-006 + WP-008          -> WP-011A secrets/I-O policy
WP-006                   -> WP-013A Channel text/effect core
WP-010 + WP-013A         -> WP-013B Channel multimodal

G0 -> WP-022A NapCat registry/fake server
G1 + G2 + G3 + WP-013A -> WP-022B shadow/read-only NapCat
G4 + WP-022B            -> WP-022C guarded send/media
WP-022C                  -> WP-022D full optional profile

G1 + G2 + WP-021A -> begin WP-021B Filter core/recovery work in parallel with LLM
G4 + WP-021B core/recovery -> complete WP-021B Filter Asset/copy profile

G5 -> WP-017 Memory -> WP-019 research harness
G6 + WP-019 -> WP-023/024 Testament
accepted future network research -> WP-025 Broker -> WP-026 LevelUpper
```

The maximum useful lanes before the first convergence are:

| Lane | Starts after | Work that can proceed independently | Converges at |
| --- | --- | --- | --- |
| Core model/storage | Phase 0 | reducer, repositories, transaction engine, crash instrumentation | `G1` |
| Extension Host/SDK | Phase 0 schemas | framing parser, hostile peer, generated SDK, fake Host, lifecycle model | `G2` |
| Operations/services | stable repository/Host interfaces | daemon, config coordinator, Asset store, secrets, telemetry | `G3/G4` |
| NapCatQQ | `G0` for offline work | official-registry compiler, fake NapCat, event normalizer, policy fixtures, UI/config examples | `G3` shadow integration |
| Reference Extensions | `G1/G2` as applicable | Channel/Alarm/Skills, then Filter and LLM adapters | `G4/G5` |
| Verification | immediately | reducer differential tests, protocol corpus, native process harness, fault schedules | every gate |
| Future research | only after stable inputs exist | plan/schema review and simulator-only work | post-v1; never blocks `G6` |

With fewer developers, preserve this priority order: Core transaction and Host
boundaries first; daemon/secret/observability second; Channel/Asset and the
NapCatQQ read path third; LLM and guarded send fourth; Memory and productization
fifth. Filter uses spare Extension capacity after `G2`. Testament and
LevelUpper never pre-empt a release blocker or NapCatQQ recovery/security work.

## 3. Ordered delivery and first-use milestones

### `U0` — Simulator-only

After `G0`, developers can run topologies, fake Extensions, fake NapCat events,
Filter vectors, and protocol fuzzing. No personal account, production database,
live provider, or durable user data is permitted. This is where changes to Core
semantics are cheapest.

### `U1` — Local developer vertical slice

After `G1`, `G2`, and the relevant part of `G3`, one echo Module and CLI test
Channel may use a disposable instance. Required evidence includes stop/restart,
duplicate lock, storage-scope isolation, crash before/after every Activation
write, backup/restore, and bounded logs. This stage is for developers, not daily
agent use.

### `U2` — Local agent preview

After `G4` and the recorded-profile part of `G5`, a backed-up local instance can
be used for text and supported multimodal conversations. Live models remain
opt-in and cost-capped. Tools with external effects remain disabled until their
unknown-outcome and permission suites pass. Memory is not required for this
first useful agent; it can be added after its own baseline gate.

### `U3` — v1 candidate

After `G6`, the required product may enter release-candidate use. The optional
Filter and NapCatQQ claims are independent: a base v1 package may omit them, and
a profile cannot borrow the base v1 result instead of running its own suite.

## 4. NapCatQQ: early development without protocol churn

NapCatQQ is intentionally split into four subpackages and five use stages.

| Stage | Dependencies | Real account/data | Allowed behavior | Exit evidence |
| --- | --- | --- | --- | --- |
| `QQ0 Offline adapter` (`WP-022A`) | `G0` | no | compile pinned registry; normalize recorded events; freeze role-specific configs, fixed ActionContracts/validator resources, and profile-admission oracle; fake WebSocket/HTTP; policy and schema tests | deterministic registry digest, validator availability, and fake-server corpus |
| `QQ1 Credentialed shadow` | `G2/G3`, WP-022A | yes, operator opt-in | reserve daemon owner, authenticate/probe actual self ID, journal to a disposable/private hub scope; no Page hint and no QQ mutation | principal/self-ID uniqueness across processes, URI redaction, bounded eviction/gaps, stop/restart tests |
| `QQ2 Read-only preview` (`WP-022B`) | `QQ1`, WP-013A ingress/read actions | yes | one per_extension hub/facade cohort, trusted-principal facades, private content-free hints/results, fixed mailbox/conversation validators, text pull/search and independent views; no send/mark-read/manage | exact output/ingress/Page/principal confidentiality, whole-hint admission, cursor/gap and general-operation replay isolation, storm/backpressure, ingress reconciliation, deny-all-effect proof |
| `QQ3 Guarded interactive` (`WP-022C`) | `G4`, QQ2 | yes, backed up | fixed QQ send/media validators, QQ view-epoch send and independent media acquisition only to explicit allowlisted private chats/test groups; all management disabled | private hub-owned media ingress/Core Asset authority/hash, policy race, Activation/general-operation/effect/import ledgers, aggregate output budget, unknown/partial outcome, rollback tests |
| `QQ4 Profile-conformant` (`WP-022D`) | QQ3 and full profile suite | yes | supported pinned NapCat operation catalog subject to per-family/per-conversation policy | compatibility probe, full safe-registry coverage, management gates, native soak |

`QQ1` is observation, not user-visible QQ integration. `QQ2` is the first stage
at which reading QQ through Dolly is reasonable. `QQ3` is the first stage at
which sending is reasonable, and only with an explicit conversation allowlist,
deny-by-default management, backups, visible `unknown` outcomes, and a quick
disable switch. Broad autonomous group use waits for `QQ4`.

The NapCat branch pins `G2` SDK types and talks to Core only through public Host
services. Its private journal, registry compiler, OneBot normalizer, fake server,
and policy engine do not import Runtime repository types. Therefore Core work
can continue while `QQ0` is built, and a later compatible Host implementation
does not force a rewrite. A breaking Host proposal is first tested through the
fake Host and versioned adapter; it does not land simultaneously in the real QQ
account branch.

No user-data-bearing QQ2 stage starts unless the fixed mailbox/conversation
ActionContracts, both semantic validators, and Host-owned profile/block
admission validator are installed and their negative vectors pass. QQ3 adds the
fixed send/media contracts and media-ingress/Asset admission suite; QQ4 does not
defer any fixed validator required by an earlier stage.

## 5. NapCatQQ communication profile

The initial profile uses this exact division:

```text
NapCat OneBot 11 forward-WebSocket server
    events -> one Dolly Channel client connection

Dolly Channel
    API calls -> NapCat HTTP endpoint

NapCat process ownership
    external/user managed; Dolly stop does not stop QQ or NapCat
```

The recommended same-host configuration is illustrative:

The verified Extension manifest uses `hosting: per_extension`; the two snippets
below are distinct Module configs with distinct Host-assigned storage scopes.

```yaml
module_type: napcat-onebot-v11-hub
module_role: shared_hub
runtime_mode: read_only
account_ref: qq-main
host_account_principal: qq-principal-main # Host-resolved, not user identity
expected_self_id: "123456789"
connection:
  mode: forward_websocket
  websocket_endpoint: ws://127.0.0.1:3001
  http_endpoint: http://127.0.0.1:3000
  credential_ref: secret://napcat/qq-main
  allow_non_loopback: false
ownership:
  mode: daemon_wide_exclusive
  cross_daemon_active_write: unsupported_v1

---
module_type: napcat-onebot-v11-facade
module_role: consumer_facade
runtime_mode: read_only
account_ref: qq-main
host_account_principal: qq-principal-main
hub_module_id: qq-hub-main
consumer_principal: {instance_id: main, module_id: agent-a}
private_result_page_id: qq-a-results
private_notification_page_id: qq-a-hints
```

The operator configures one NapCat forward-WebSocket service and one HTTP API
service with authentication; exact ports are operator choices. Dolly initiates
the WebSocket connection, so v1 needs no inbound listener. Event ingress uses
that one WebSocket only. HTTP POST event reporting is disabled, and the profile
does not connect a second event WebSocket, unless a future separately tested
cross-transport deduplication profile says otherwise.

HTTP carries action calls in the initial profile. It has an explicit request
boundary and works with the Stream/file APIs while the WebSocket remains a
single ordered event source. The pinned registry may mark an operation as
WebSocket-only, but enabling it requires a versioned transport adapter with
`echo` correlation and the same dispatch/outcome ledger; it cannot silently
fall back at runtime.

Reverse WebSocket is not in the initial profile. It requires Dolly to own an
authenticated inbound endpoint, resolve port conflicts across instances, fence
old listeners, and handle public exposure. That belongs behind the future Host
Network Broker. It offers no correctness advantage for a same-host NapCat
connection. For a remote NapCat, use an operator-controlled authenticated
tunnel or `wss`/`https` termination and set the elevated non-loopback policy;
never expose unauthenticated OneBot HTTP/WS directly to a public network.

Because Core output Pages broadcast, a private mailbox result cannot share an
output Page with another consumer. The topology is therefore:

```text
shared account hub/connection owner -> A-private content-free hint Page
                                    -> B-private content-free hint Page
                                    -> per-consumer private media-delivery Blocks

consumer A -> A's NapCat façade Module -> A-private result Page -> A only
consumer B -> B's NapCat façade Module -> B-private result Page -> B only

A/B outbound Action Pages -> their façade -> shared account effect broker
```

The hub owns the one upstream connection and account journal. A façade is a
separately scoped Module endpoint with one fixed authorized consumer principal,
not a caller-supplied `storage_scope_id`; configuration proves that only that
exact `(instance_id,module_id)` principal subscribes to its result and
notification Pages. The hint payload contains only fixed `schema` and `kind`
fields—no account, message, count, conversation, cursor, gap, or media state.
Detailed counts, gaps, and messages are pulled through the private façade.
ActionResults return only on that façade's private result Page. Until a future
Core supports confidential directed replies, a deployment that puts two
security principals on one NapCat result Page is invalid configuration.

The façade/hub path is a package-internal Host-brokered service in one
`per_extension` placement cohort, not a
Module-to-Module RPC and not ambient shared database access. Every hub table is
partitioned first by the hub Module's `storage_scope_id`; consumer views
are additionally keyed by the façade/consumer principal. Only the hub owns the
account connection and general operation/effect/import ledgers. Facade-only
shutdown leaves the hub and peer facades alive; cohort shutdown stops facades
before the hub and releases the owner epoch last. Group/friend lists, live content,
registry schemas, tokens, and connection state do not enter Premise.

## 6. Filter schedule

Filter schema, fixed-point arithmetic, and vectors can be completed during
`G0`. Real implementation waits for `G1/G2`, because its EMA and observation
ledger require the final Activation status/replay and storage-scope boundary.
It can then run in parallel with Model Gateway/LLM work and does not depend on
an LLM provider.

The first useful Filter stage requires text projection plus the newly generated
normalized signal JSON, two nested Filters,
missing-value hold, duplicate-Block suppression, prepare/promote crash recovery,
and restart. Full optional-profile conformance additionally waits for `G4` Asset
authorization/copy tests and high-fan-in Core lineage limits. An in-memory EMA
demo is never a user-data-bearing stage.

## 7. Memory, Testament, and LevelUpper order

Memory follows the usable LLM/observability substrate because its value must be
measured in real context selection and its state must survive the same backup,
scope, and migration tests. It does not block `U2`, but it does block the stable
Memory claim and the learning comparisons.

Testament begins after `G6`, WP-017, and WP-019. Schema/corpus thought work MAY
occur earlier, but no implementation gets production storage or credentials.
The order is Corpus/export and isolation, then portable replay, then artifact
families, then learning controls, and only then any promotion proposal.

LevelUpper is last. It begins only after a separately reviewed Host Network
Broker exists. The order is protocol simulator, hostile peer, two local peers,
durable one-way text, restart/ACK recovery, Assets, bidirectional shares,
triangle-loop tests, and finally shadow/canary research. Neither Testament nor
LevelUpper consumes base-v1 critical-path staff while a P0/P1, recovery gate,
or advertised NapCatQQ profile defect is open.

“Broker exists” here means WP-025 has frozen and validated its closed Host
method/schema registry for endpoint reservation, listen/connect/accept,
bounded read/write, status reconciliation, and revoke, including the exact
connection-bound capability and epoch fields. LevelUpper may build a pure wire
simulator before that freeze, but it MUST NOT enter a two-peer live stage or
open an ambient socket as a substitute.

## 8. Change-control rule for parallel branches

Every branch records its pinned gate, schema bundle digests, fake dependency
version, and integration owner. At convergence:

1. rerun the dependency's conformance kit unchanged;
2. run the branch against both the fake and real dependency;
3. compare durable outcomes, not only API responses;
4. run stop/restart and old/new generation overlap;
5. reject integration if a compatibility shim changes authority, retry, state
   identity, or unknown-effect semantics; and
6. merge one boundary at a time, retaining a disable/rollback path.

This permits early NapCatQQ and Filter work while keeping the expensive real
account, durable state, and outbound-effect integration after the relevant
protocols are stable enough to stop moving together.
