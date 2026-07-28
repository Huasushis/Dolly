# Migrating the Core stand-in onto the real Extension protocol

Status: design, not yet executed. `createModuleLauncherControl` and
`attachLinuxModuleProcess` exist as product code, but `core-standin.mts` still
uses the experiment protocol and has not run `ExtensionProcessHost`. This note
describes that larger migration; replacing the stand-in's launcher control is
only one prerequisite.

This states how the fixed interruption matrix moves from
`dolly.experiment.module-protocol/1` to the shipped `ExtensionProcessHost`
without disturbing the two case groups that share the same file, and how the
one obligation the host cannot enforce will be checked once it can be.

## Why the file cannot simply be rewritten

`core-standin.mts` now serves three handlers:

| handler | entry point | fixture |
|---|---|---|
| `fixed-interruption.sh` | `runWorkload` | `extension-fixture.py` |
| `capability-idempotency.sh` | `runWorkload` | `extension-fixture.py` |
| `live-core-termination.sh` | `runLiveTermination` | `extension-fixture.py` |

`capability-idempotency` is built directly on `runWorkload`, the function whose
protocol changes. Replacing that protocol in place would break a passing case
group that has nothing to do with this migration.

## The change: one flag, one seam, default unchanged

Add to `StandinConfiguration`:

```ts
/**
 * Which Extension protocol this run speaks. Absent means the experiment's own
 * message set, which is what every existing case uses and what the recorded
 * results were produced with.
 */
readonly extensionProtocol?: "experiment" | "dolly";
```

Introduce one interface inside `runWorkload`, with two implementations:

```ts
interface ModuleProtocolSession {
  /** Through Extension readiness. Boundary 4's "after" follows it. */
  start(): Promise<void>;
  /** Sends the Run and resolves with its result. Boundary 7 fires inside. */
  execute(request: {
    moduleJobId: string; runId: string; attempt: number;
    hasMore: boolean; input: JsonValue;
  }): Promise<{ blockProposal?: JsonValue }>;
  /** Drains capability handlers and asks for termination. */
  terminate(): Promise<void>;
}
```

`runWorkload` keeps its present shape. Only the construction of the session
differs, and only the `dolly` implementation is new code. The `experiment`
implementation is today's code moved verbatim behind the interface, so its
behaviour is unchanged for the two groups that do not set the flag.

Handler changes are limited to one file: `fixed-interruption.sh` sets
`extensionProtocol: "dolly"` and points `extensionFixturePath` at
`dolly-protocol-extension-fixture.py`. `capability-idempotency.sh` and
`live-core-termination.sh` are not edited at all. Either can migrate later by
changing those same two lines.

## What moves, and what does not

Ten of the fourteen boundaries are unaffected because they never touched the
Extension protocol: M01, M02, M03, M05, M06, M10, M11, M12, M13, and the record
closure and collection half of M14. The recovery invocation is unaffected.

The four that move:

| boundary | today | after the migration |
|---|---|---|
| M04 after | the fixture's `ready` frame | `host.start()` resolves, i.e. after `dolly.initialize` and `module.create` |
| M07 before/after | around an explicit `channel.send` | around the write of the `module.execute` frame, intercepted on the transport the stand-in owns |
| M08 start/completion | in the stand-in's own request handler | in the capability handler the stand-in grants to the host, which the host invokes |
| M09 before/after | around the receipt written after the fixture's `result` frame | around the receipt written after `host.execute()` resolves |

M07 needs explanation. The send happens inside the host, and the host exposes
no hook around it. In attached mode the stand-in creates the pipes and hands
them over, so it can wrap the writable it supplies as `standardInput`, decode
each outgoing frame's `method`, and fire the barrier immediately before the
`module.execute` frame is written and immediately after that write completes.
This is the send itself, and it does not collapse into boundary 8.

That technique is unavailable to any arm whose host spawns its own child, since
the pipes are then internal to the host. The baseline arms are in that position
by definition, so their M07 "after" is necessarily a later, different event.
The difference is a property of the arms and belongs in the comparison notes,
not something to be smoothed over.

The `barrier` flag the old fixture carried is gone: `capability.invoke`
parameters are a closed object the host validates, so the Extension cannot mark
a request. Core selects the interruption point from the workload instead, which
is deterministic because the operation is fixed per workload:

- `active-capability-handler` → the `write-slow` invocation;
- `unknown-external-effect` → the `emit` invocation;
- the other five workloads → the `write` invocation.

## Termination, and the obligation the host cannot enforce

`ExtensionProcessHost` asks its attachment to terminate and then refuses to
report success unless it observes the exit. It deliberately does not know how
the attachment terminates anything. An adapter that implemented
`requestTermination` as a signal to one process identifier would satisfy the
host completely while breaking the whole-group termination ADR 0009 exists to
provide. `src/adapters/linux-module-executor.ts` states this, and it is why the
adapter is product code with its own tests rather than something this experiment
supplies: an experiment that brought its own adapter would be testing its own
adapter at exactly the layer that carries the obligation.

The stand-in therefore consumes `attachLinuxModuleProcess` and adds no
termination mechanism of its own. Boundary 14 becomes:

1. `at("M14", "before")`;
2. `await host.terminate()` — drains the capability session, sends `module.stop`
   and `dolly.shutdown`, asks the adapter to terminate, and fails closed with
   `EXTENSION_TERMINATION_UNCONFIRMED` if no exit is observed;
3. `await stopModuleProcess(...)` — the durable `populated 0` proof and the
   record transition to `stopped`;
4. collect the records, then `at("M14", "after")`.

## Checking that no process identifier is ever signalled

ADR 0009 required failure test 13. Three layers, cheapest first. The first two
run inside the case; the third is available if syscall-level proof is wanted.

**1. Static.** Search the adapter, the host, the lifecycle, and the stand-in for
`process.kill`, `.kill(`, `SIGKILL`, `SIGTERM`, and spawns of `kill` or `pkill`.
Cheap, and it catches an adapter written the obvious wrong way. Not sufficient
alone: an indirect call would not appear.

**2. Runtime interception, in-process.** Before anything else runs, the stand-in
replaces `process.kill` and `ChildProcess.prototype.kill` with recorders that
capture the target, the signal, and the call stack, and it records every
`child_process` spawn whose program is `kill` or `pkill`. The case then asserts
that the recorded list is **empty**. This catches any call site regardless of
where it was written, including inside the product adapter.

Care is needed on two points. The recorder must not swallow a call it observes —
it records and then delegates, so a genuine defect still behaves as written and
the case fails on evidence rather than on altered behaviour. And the harness's
own `SIGKILL` to Core comes from outside the process, so it never appears here;
that is correct, because the invariant is about what Core does, not about what
is done to Core.

**3. Positive evidence, not only absence.** "No signal" is only half the claim.
The other half is that termination really happened by group termination, which
is observable through the `ModuleCgroupFileSystem` seam the stand-in already
supplies: record every `writeTextFile` whose path ends in `/cgroup.kill`, and
require at least one for the Module control group, followed by a `populated 0`
reading. A case that signals nothing and also never terminates the group would
pass a negative-only check and must not.

**Optional, if syscall-level proof is required.** In the disposable privileged
container, `bpftrace` on the `kill` syscall would observe signals sent by any
process by any means, including the Python launcher and any descendant. This is
stronger than layer 2 and costs a build dependency; it is not proposed as the
default, only recorded as the available escalation.

## Verification obligation when the migration lands

Because the file is shared, the migration is not finished when the interruption
matrix passes. All three groups run:

- `fixed-interruption` — one boundary first, then the full 210;
- `capability-idempotency` — unchanged, must still pass;
- `live-core-termination` — unchanged, must still pass.

A migration that only verified its own group would be exactly the failure this
note exists to prevent.
