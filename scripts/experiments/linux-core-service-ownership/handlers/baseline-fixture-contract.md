# Shared fixture contract for the experiment's arms

The preregistered protocol
(`docs/experiments/linux-core-service-process-ownership.md`, "Baselines") says:

> The baselines use the same child fixture, deadlines, result payloads, and
> fault injection points. A baseline is not weakened to make the proposal look
> better.

This file records how far that holds between `baseline-direct-child` and the
proposed `fixed-interruption` arm, where it does not, and why — so a reviewer
can check the claim rather than take it on trust, and so nobody has to diff
three handlers to find out whether an arm was given a longer deadline.

Implemented by:

- `baseline-direct-child.sh` with `baseline-core-driver.mjs`,
  `baseline-successor-probe.mjs`, and `baseline-direct-child-evaluate.mjs`
  (arm `baseline-direct-child`, 210 cases); and
- `baseline-transient-unit.sh` with `baseline-paused-creation-request.sh`
  (arm `baseline-transient-unit`, 1 case).

The proposed arm's Core stand-in is `core-standin/core-standin.mts`.

## Child fixture: one file, shared

Both baseline arms execute
`core-standin/dolly-protocol-extension-fixture.py`. It is not reimplemented
here; the file itself is the child, launched as
`python3 -I -B <fixture> <sentinel>`. The trailing sentinel is ignored by the
fixture and exists only so this case's processes are findable under the run's
reserved prefix.

This became possible once `ExtensionProcessHost` gained its attached-process
seam: before that, no arm could run the shipped host at all.

**The proposed arm has not moved yet.** Its three handlers — the fixed
interruption matrix, capability idempotency, and live Core termination — still
execute `core-standin/extension-fixture.py` and still speak the experiment-only
message set. So the protocol's "same child fixture" holds **within the
baselines**, and the two arms of any one case are running two different fixtures
over two different message envelopes.

Until the proposed arm migrates, the consequence stated earlier in this
experiment still stands: **per-boundary counts from the two arms are not
directly subtractable.** What compares is which invariants each arm holds,
not the difference of two case counts. Treat a claim that the envelope is shared
as false until every handler in `real-protocol-migration.md`'s migration table
has moved and a case-by-case diff against the previous run has been read.

Configuration arrives in the `config` value of `dolly.initialize`, because the
host spawns with an empty environment in start-command mode and an environment
variable would behave differently in the two construction modes:
`{ workload, outputCount, environPath, descendantPidPath }`.

`descendantPidPath` is set by this arm and not by the proposed one, and the
asymmetry is the finding rather than a deviation. The proposed arm collects the
descendant by whole-control-group termination, which is exactly the property
under measurement; this arm has no control group, so the harness has to be told
the identifier to clean up after itself. That is harness cleanup, not baseline
recovery: the successor Core is never given the file, and every case records
that it has no handle of its own.

### One deliberate behavioural choice

**The fixture exits when its inherited channel reaches end of input**, which is
what the security specification quoted in ADR 0008 reason 3 requires of an
Extension: either an authenticated reconnectable channel, or exit after the
inherited channel closes.

It matters for how this arm reads, and it is the shared fixture's behaviour
rather than anything chosen for the baseline. A fixture that refused to exit
would make the direct-child arm look worse than it is, which the protocol
forbids just as much as flattering it. With a specification-conforming fixture
the direct child *does* exit after its Core is killed, and what the arm still
cannot do stands on its own evidence: it cannot prove the child exited, and
closing one pipe reaches exactly one process, so the child's own descendants
are not reached at all.

## Workloads and result payloads

Every workload issues one capability request first, before anything else, so the
capability-request boundary is reachable with all seven. The two workloads with
capability behaviour of their own issue a second request and trip the boundary
on **that** one; the other five trip it on the first.

| workload | after the first capability request | `outputCount` |
| --- | --- | --- |
| `no-output` | nothing | 0 |
| `single-output` | nothing | 1 |
| `multiple-output-pages` | nothing | 3 |
| `processor-loop` | busy loop for `processorLoopSeconds` | 1 |
| `process-descendant` | starts a descendant in a new session, never reaped | 1 |
| `active-capability-handler` | second request, `structured-log` / `write-slow` | 1 |
| `unknown-external-effect` | second request, `external-effect` / `emit` | 1 |

Capability requests:

| # | type / operation | arguments | idempotency key |
| --- | --- | --- | --- |
| 1 | `structured-log` / `write` | `{"level":"info","message":"module run started","runId":<runId>}` | `<runId>-log-1` |
| 2 | `structured-log` / `write-slow` | `{"level":"info","message":"slow handler","runId":<runId>}` | `<runId>-log-2` |
| 2 | `external-effect` / `emit` | `{"runId":<runId>,"payload":"external effect with an unknown outcome"}` | `<runId>-effect-1` |

The `external-effect` grant sets `requireIdempotencyKey`. Both grants use
`expiresAt` now + 600 000 ms, `maxInvocations` 16, `maxConcurrentInvocations` 4,
`maxArgumentBytes` 65 536, `maxResultBytes` 65 536.

Result payload, byte for byte:

```json
{"protocol":"dolly.experiment.module-protocol/1","type":"result","runId":"<runId>"}
```

`no-output` sends exactly that. The other six add
`"text":"output of <workload> for run <runId>"` and `"outputCount":<n>`.

Core turns the text into one Block,
`{ payload: { schema: "dolly.experiment.text/1", value: { text: <text> } } }`,
with source `{ kind: "module", id: "experimentworker" }`, and appends it to
`experiment-output-1` … `experiment-output-<outputCount>`.

Input side: page `experiment-input`, consumer `experimentworker`, start
`"from-now"`; one input Block
`{ payload: { schema: "dolly.experiment.text/1", value: { text: "input for <workload>" } } }`
with source `{ kind: "external", id: "experiment-console" }`. The
`module.execute` input is the real `buildReactiveModuleInput` product
(`dolly.reactive-module-input/2`), not a placeholder.

Identifiers: instance `dolly-test-instance`, Module `experimentworker`, Module
generation `dolly-test-module-generation-1`.

### The descendant is created before the first capability request

Changed 2026-07-26, and it changes what earlier boundaries measure, so read this
before comparing a run made after it against one made before.

The fixture used to create the descendant *after* its first capability request.
That request blocks until Core replies, and an interruption at boundary 8 or
earlier freezes Core before it replies — so in those cases the descendant was
never created. Every `process-descendant` case at boundary 8 or earlier was
measuring a Module with no descendant while reporting the same kind of verdict
as the cases that had one. Boundaries 4-after through 8 were meant to be
exercised with a descendant and were not.

Both arms execute this file, so both were affected and both change together.
Expect `process-descendant` cases at boundaries 4-after through 8 to report
differently than in any earlier run; that difference is the correction, not a
regression. Boundaries 1 through 4-before still cannot have one, because the
Extension process does not exist yet.

**Diff the new run against the previous one case by case — `caseId` to
`status` and `reason` — rather than comparing summary counts.** A shared-fixture
change that silently weakens a conclusion leaves the counts looking reasonable;
the last one cost nine cases before anyone noticed, and it was found by exactly
this diff.

### The descendant

`<sleep> 300`, started with a new session so it leaves the Extension's process
group: terminating only the direct child's group misses it, which is what the
workload exists to expose. It carries no marker of its own, so the fixture
records its identifier **together with its start time** from `/proc/<pid>/stat`
field 22. That pair names one exact process even after the identifier is reused,
and it is the only thing the harness will act on.

That is also invariant 7 in miniature: the harness can clean the descendant up
because it watched it start. This arm's successor Core has neither the
identifier nor the start time, so it can do nothing at all.

## Deadlines

| name | value | where |
| --- | --- | --- |
| wait for readiness | 30 000 ms | `initializationTimeoutMs` |
| wait for the result | 120 000 ms | `responseTimeoutMs` |
| stop the Module process | 20 000 ms | `shutdownRequestTimeoutMs`, `terminationTimeoutMs` |
| `forceKillDelayMs` | 2 000 ms | `ExtensionProcessHost` |
| `maxFrameBytes` | 4 MiB | frame channel |
| execute deadline offset | 60 000 ms after the send | `module.execute` `deadline` |
| slow capability handler | 3 000 ms | Core-side `write-slow` |
| capability grant lifetime | 600 000 ms | both grants |
| processor loop | 2.0 s | fixture |
| the fixture's own deadline | 600 s | fixture |
| barrier wait | 90 s | harness, before declaring the point unreached |
| survival observation window | 3 000 ms | harness, after Core is terminated |
| case deadline | 180 s | catalog |

The survival window is deliberately longer than the processor loop, so a child
that is merely busy is never recorded as one that survived.

## Fault injection points

Fifteen points: the protocol's fourteen durable boundaries with boundary 8 split
into its two named moments, each run with timing `before` and `after`. The
termination signal is `SIGKILL` throughout, as the catalog records.

`baseline-core-driver.mjs` reaches each point with the real operation, or with
the real refusal where this arm has no such operation. A refusal always comes
from the shipped validator; the handler never asserts one.

| point | operation in the direct-child arm | arm performs |
| --- | --- | --- |
| `M01` | `inspectCoreServiceBinding` for the Core unit | yes, and it refuses: no such unit |
| `M02` | `FileCoreStateStore.appendModuleProcessRecord` | no: the arm has no systemd `InvocationID` |
| `M03` | delegated Module control group creation and limits | no: `ExtensionProcessHost` creates no control group |
| `M04` | `ExtensionProcessHost.start()` | yes |
| `M05` | `deliveries.claim` | yes |
| `M06` | `appendModuleSubmissionRecord` | no: it requires a process record |
| `M07` | `host.execute` send, observed by the fixture's marker | yes |
| `M08.start` | Core-side capability handler entry and effect intent | yes, in memory only |
| `M08.completion` | capability outcome produced and recorded | yes |
| `M09` | Extension result receipt persistence | no: the result is held in memory only |
| `M10` | commit preparation | yes |
| `M11` | `blocks.commit` for the output Block | yes |
| `M12` | `deliveries.append`, first output page only | yes |
| `M13` | `deliveries.ack` | yes |
| `M14` | `host.stop()`, then process record closure | stop yes, closure no |

`before` blocks immediately before the operation; `after` blocks immediately
after it returns, or after the real refusal was recorded. Three points need
their exact moment stated:

- `M07` — the send happens inside `host.execute`, which does not return until
  the result arrives, and the shipped host exposes no seam between the two. The
  first thing that can only happen after the send crossed the boundary is the
  fixture's first capability request arriving back at Core, so that is what
  "after" is observed by. It makes `M07-after` and `M08.start-before` the same
  instant, the way `M03-after` and `M04-before` already are. **This definition
  is provisional**: the proposed arm faces the identical problem now that it
  drives the real host, and both arms must use one definition;
- `M08.completion` — "after" is the moment the capability outcome has been
  decided and recorded, while the host has still to transmit it. It is placed
  there rather than after transmission so the workload whose outcome is unknown,
  and which therefore leaves the handler by throwing, reaches the same point as
  every other workload; and
- `M12` — the barrier is on the **first** output Delivery append only, so a
  workload with three output pages still has one deterministic point.

### Two points that do not exist for one workload

A Run with no output commits no Block and appends no output Delivery, so `M11`
and `M12` have no referent for the `no-output` workload. That is a property of
the Run, not of an arm, so it holds for the proposed design too, and both arms
report those four cases `not-applicable`. The driver still runs the Run to
completion, so the artifacts show it really produced no output.

This is the only place either arm reports `not-applicable`. Everywhere else a
boundary this arm cannot perform is reported `failed`, because the invariant is
real and unmet — a step the arm lacks is a finding, not an exemption.

### Why `M03` is not one of them

`M03` is "delegated control group creation and limit application", and this arm
has no such step: `ExtensionProcessHost` creates no control group, so the child
simply joins Core's own. It is worth stating why those fourteen cases are
reported `failed` rather than `not-applicable`, because the two look alike:

- the `no-output` case above is a property of the **Run**. There is no Block to
  commit for anybody, so the proposed arm reports the same four cases the same
  way, and reporting them as anything else would invent a boundary; whereas
- the missing control group is a property of the **arm**. It is the difference
  the experiment exists to measure, and it is the direct reason this arm can
  never satisfy invariant 6. The proposed arm performs `M03` and passes it.
  Recording the arm's central deficiency as "does not apply" would delete the
  comparison.

The interruption still lands at a real moment in this arm's own timeline —
after Core readiness and the refused process record, before the Extension
process exists — and a real invariant is decidable there and violated, so the
case is not vacuous either. What the arm actually did in that slot is recorded
in the step log and the barrier snapshot as `armPerformed: false` together with
the control group state it observed, so nobody has to infer it.

`M03-after` and `M04-before` name the same instant in both arms: the control
group is ready, or in this arm was never created, and no launcher child exists.
Both cases run in both arms; the collapse is a property of the boundary list,
not of either implementation.

**Boundaries with the same name do not have the same semantics in the two
arms.** `M02`, `M03`, `M06`, `M09`, and the record-closure half of `M14` are
operations the proposed arm performs and this one cannot. Their per-boundary
numbers are not comparable line by line; the comparable statement is which
invariants each arm holds, which is what the evaluation records.

## What the harness observes, and what the arm can prove

These are kept apart on purpose:

- the **harness** observes the operating system directly across the SIGKILL —
  which processes were alive at the interruption point and which outlived it —
  and identifies a process only by its command-line sentinel, or, for the
  unmarked descendant, by identifier plus start time; and
- the **successor Core** (`baseline-successor-probe.mjs`) starts with nothing
  but the durable Core state file and the operating system, exactly as a real
  successor would, and reports only what shipped code lets it conclude
  (`inspectCoreServiceBinding`, `FileCoreStateStore`,
  `decideModuleProcessStopProof`).

A case is decided from both, by `baseline-direct-child-evaluate.mjs`. That file
also records why invariant 4 is treated as this arm's independent variable
rather than as a per-case outcome.
