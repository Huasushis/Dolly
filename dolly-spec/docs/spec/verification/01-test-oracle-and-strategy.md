# Test oracle and strategy

## Oracle hierarchy

`REQ-TEST-001` — Correctness tests MUST compare committed state and emitted
commands against the pure reference abstract machine. They MUST NOT use the
production implementation as its own oracle.

The oracle consumes a sequence of explicit commands containing injected clock
and random values. It produces:

- the next logical state;
- zero or more durable events;
- zero or more Extension/service commands;
- a stable success value or error code.

Canonical state snapshots exclude nondeterministic diagnostics and are hashed.
Production and model implementations receive the same commands; each committed
step MUST match the oracle hash.

## Mandatory test layers

| Layer | Scope | Required method |
| --- | --- | --- |
| Schema | every JSON boundary | official meta-schema check, positive/negative corpus |
| Reducer | one transition | table tests for every state/event pair |
| Stateful model | arbitrary sequences | generated commands compared to abstract machine |
| Property | invariants | generated graphs, Blocks, limits, retries, config revisions |
| Protocol | byte stream | golden frames, fragmentation, hostile peer, cross-language mock |
| Concurrency | task interleavings | deterministic scheduler/loom-equivalent plus stress |
| Crash point | every durable write boundary | kill before/after point, reopen, compare oracle |
| Security | every trust boundary | deny-by-default and malicious corpus |
| Platform | Linux and Windows | native CI and packaged smoke tests |
| Extension | one reference Extension | contract, restart, idempotency, resource and input abuse |
| Optional profile | each advertised profile | its normative vectors, upstream evidence, lifecycle, state isolation, and hostile content |
| Research protocol | each claimed prototype | simulator/hostile-peer, isolation proof, immutable plan/run evidence; never a v1 product oracle |
| System | representative topologies | virtual clock, recorded providers, no live nondeterminism |
| Live smoke | provider/OSS/MCP | bounded, opt-in, cost-capped; never sole correctness oracle |

## Deterministic test environment

`REQ-TEST-002` — Tests of Core behavior MUST inject:

- wall clock;
- monotonic clock;
- random/UUID bytes;
- filesystem faults and free-space results;
- process exits and signals;
- network/provider responses;
- scheduler wakeup order.

Jitter is derived from recorded random bytes. Test fixtures MUST pin locale,
timezone, Unicode data version when relevant, model profile revision, database
schema, and config revision.

## Stateful generation

The generator SHOULD produce invalid commands deliberately, including stale
generations, expired leases, future references, duplicate occurrences,
retention pressure, graph updates during running Activations, and repeated
results with both equal and conflicting digests. Shrinking MUST preserve the
failure so a minimal reproducible trace is emitted as a test vector.

## Provider tests

Provider Adapter correctness primarily uses recorded, licensed, redacted
fixtures that include malformed and partial responses. Live API tests confirm
current compatibility and are tagged by provider, model-profile revision,
date, region, and cost. A live provider outage cannot make Core tests flaky.
Recorded fixtures for every claimed output modality MUST also drive the full
Gateway-to-Asset path: request/profile/grant subset checks, deterministic
output ordinals, Provider bytes and temporary URLs, sniffed MIME and byte
budgets, `AVAILABLE` gating, lease handoff, crash/status reconciliation, and
proof of one Provider dispatch.

## Resource and soak tests

Release candidates MUST test bounded behavior under:

- one million Page entries with one deliberately slow durable subscriber;
- frame, log, metric-cardinality, and wakeup floods;
- repeated Extension crash loops;
- one Extension process hosting many Module scopes, many processes of one
  package, hot replacement, force-stop, restart, and cross-scope restore probes;
- disk-full and recovery cycles;
- long-running Asset and Block GC;
- a NapCatQQ 100,000-event storm with constant-size Premise, exact count/byte
  journal eviction, content-free private hints, slow principal-bound facades,
  disconnect/disk-full gaps, and bounded complete output Blocks/Assets;
- Filter high-fan-in, nested-Filter, repeated-Block, fixed-point overflow,
  observation-ledger quota, and prepare/promote crash cycles;
- when research prototypes are claimed, Testament clone/replay resource bounds
  and LevelUpper slow/hostile-peer, ACK-loss, Asset-resume, and loop soaks;
- clock jumps, sleep/resume, and DST transitions;
- 24-hour virtual execution and a shorter real-time soak.

Passing means invariants hold and documented limits take effect; it does not
require accepting unlimited work.

## Test identity and evidence

Each mandatory test has a stable `TST-AREA-NNN` identifier and names the
requirements/invariants it covers. Release evidence stores toolchain versions,
commit, config, seed, platform, raw trace, and result digest.

## Required cross-boundary scenarios

`REQ-TEST-003` — The system suite MUST include these end-to-end simulations:

1. ingest text plus an image, validate and import the image once as an Asset,
   deliver distinct Page occurrences to two Modules, stop one Extension during
   activation, restart under the same storage scope, and prove one committed
   output with valid Asset pins and no cross-Module private-state visibility;
2. run two Modules from one Extension process and two generations of the same
   package during hot replacement, then prove that Module storage scopes and
   process generations are independent fences;
3. point multiple Memory Modules at one brokered physical database and prove
   automatic tenant predicates, backups, restores, migrations, queries, and
   vector-index namespaces never cross `storage_scope_id`;
4. reserve one daemon-wide QQ account principal/actual-self owner, journal a QQ
   event storm through one shared hub, evict an exact prefix with a visible gap,
   emit only content-free hints to two private principal-bound facades, let them
   pull/ack independently, import media through an independent Action and
   top-level Asset, enforce a group deny and stale view epoch across all effect
   surfaces, lose a send response, replay through the facade Activation/hub
   effect ledgers, stop/restart, and prove the send is `unknown`, output stays
   within aggregate budget, and no effect is blindly repeated;
5. feed LLM and non-LLM score Parts through two nested Filters, omit later
   scores, redeliver one Block, crash after prepared state, and prove fixed-point
   hold/dedup, deterministic choice, fresh identity, and removal of Actions;
6. in research isolation, replay a multimodal Corpus into independent Testament
   clones and bridge one result through LevelUpper with a lost ACK; prove fresh
   identities/Assets in every domain, one local import per foreign occurrence,
   no executable remote Action, no production write, and terminating loop data.

Each scenario records state after every command and compares both the stable
portion and the profile/research ledger to its appropriate independent model.
