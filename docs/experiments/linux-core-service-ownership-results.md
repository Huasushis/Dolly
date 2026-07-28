# Linux Core service process ownership — results

Status: Partial. Three proposed-arm groups of protocol version 3 have run with
the product launcher control adapter. The complete matrix and the real
`ExtensionProcessHost` migration have not run.

This records what has actually been executed of the preregistered experiment in
`linux-core-service-process-ownership.md` (protocol version 3), what it does and does not
establish, and the defects it exposed. It is written to be read together with
`linux-core-service-ownership-runbook.md`, which explains how to reproduce a run.

## What this evidence does not establish

Read this before quoting any number below.

> The 210 cases of the fixed interruption matrix ran against an experiment Core stand-in speaking
> `dolly.experiment.module-protocol/1`, a protocol and child fixture created for this experiment.
> They are evidence that the **durability and ownership boundary design** holds. They are **not**
> evidence that Architecture Decision Record 0009 can be delivered on the code as it stands,
> because they did not run `ExtensionProcessHost` or `ModuleActor`.

When these cases ran, the substitution was forced rather than chosen: `ExtensionProcessHost` could
only spawn its own direct child. The host attachment option and the two product adapters now exist,
but no runtime startup caller has assembled them end to end; see Finding 3. The matrix still needs a
rerun against the real host and real frame protocol. Until that rerun happens, the sentence above
stands as written.

Concretely, of the fourteen durable boundaries, four are the ones the substitution touches:

- boundary 4, Extension process creation and readiness (`ExtensionProcessHost.start()` and its
  `dolly.initialize` and `module.create` exchange);
- boundary 7, the `module.execute` protocol send;
- boundary 8, each capability request start and completion, which in the product arrives through
  the host's capability dispatch; and
- boundary 9, Extension result receipt.

The protocol substitution directly changes those four boundaries. All cases also shared a
handwritten launcher-control implementation until the P0-1 replacement, so the report cannot call
the other ten boundaries unaffected without a case-by-case rerun. The real-host migration remains
separate: its fixture becomes a real Extension speaking the real frame protocol and all three
groups sharing the stand-in must be rerun.

Two further boundaries rest partly on experiment code even so, and this does not change when the
seam lands. Core ships no durable record for the capability effect intent and outcome of boundary
8, and none for the result receipt of boundary 9; `CoreStartupRecovery` has the
`ExternalEffectEvidenceSource` seam for the first and no implementation of it. The experiment
supplies both, in
`scripts/experiments/linux-core-service-ownership/core-standin/journals.mts`, which says so in its
own header. A case that passes only because of those journals proves something about that file.

## Retained 210-case run

One group, one arm, one environment:

| | |
|---|---|
| Group | `fixed-interruption-matrix` |
| Arm | `proposed` (the two baseline arms are separate work) |
| Cases | 210 — 15 boundary keys (M01–M07, M08.start, M08.completion, M09–M14) x 2 timings x 7 workloads |
| Environment | Disposable container, Ubuntu 24.04.4, kernel 6.8.0-106-generic, systemd 255, Node.js 20.20.2, Python 3.12.3 |
| Service scope | user, with lingering enabled |
| Controllers | `cpuset cpu io memory hugetlb pids rdma misc` at the root; `cpu memory pids` delegated |
| Termination signal | `SIGKILL` to the service-manager-reported main process |

Result:

```
cases  210   passed 206   failed 0   inconclusive 0   not applicable 4
cleanup ok true   residue clean true
verdict  pass
```

The four not-applicable cases are `M11` and `M12` with the `no-output` workload: a Run that commits
no Block and appends no output Delivery does not have those boundaries. The matrix is a cross
product and enumerates the combination anyway. They are reported as not applicable with that
reason rather than as passes they did not earn.

Every boundary key ran with every workload. Per boundary: 14 cases each, except `M11` and `M12`
with 12 plus the 2 not-applicable. Per workload: 30 each, except `no-output` with 26 plus 4.

The run's artifacts, including per-case barrier snapshots, control-group observations, and the
ordered boundary trace of both Core invocations, are retained under the run directory the runbook
describes. This experiment's run kept them at
`artifacts/experiments/linux-core-service-ownership/container-992688-20260726T140816Z/20260726T140818Z-159/`
on the machine that ran it; artifact directories are not committed.

## P0-1 launcher control adapter comparison

On 2026-07-27, the two handwritten `ModuleLauncherControl` implementations in
`core-standin.mts` were replaced by the product
`createModuleLauncherControl`. This is the adapter used while starting a Module:
it records the requested control group and open-file limit, delegates membership
verification and execution authorization to the launcher controller, preserves
its failure evidence, and handles exit before membership is verified.

This is not the adapter in ADR 0009 required failure test 13.
`attachLinuxModuleProcess` presents a started launcher to
`ExtensionProcessHost` and owns whole-control-group termination after membership
is verified. This stand-in still runs neither of them, so the comparison below
does not establish the real-host assembly or failure test 13.

The comparison used two isolated source snapshots. They contained no `.env`,
`dolly.json`, Git metadata, or dependency directory. The same remote dependency
directory supplied `tsx` 4.21.0 and TypeScript 5.9.3 to both runs.

| Snapshot | Source archive SHA-256 | Runtime source difference |
|---|---|---|
| Before | `759c8cb9057b9407a023a129c0fad713d9d544e398f3d0159fb064760a5c8d93` | Handwritten controls and the old lifecycle comment |
| After | `6b457575d5cc373fa453018203ef62bafd99fc23c335b1a4fba66eb95f15588b` | Product control adapter and the corrected lifecycle comment |

The catalog selects 233 cases: 210 fixed-interruption cases, 7 capability
idempotency cases, and 16 live termination cases. Of those, 184 reach launcher
creation and configuration. The remaining 49 stop before a launcher exists.
Of the 184, 176 reach execution authorization; eight live-termination cases
request a stop after configuration but before authorization. These three counts
must not be collapsed into one coverage number.

Both snapshots first ran the same M10 boundary selection, where launcher
authorization has completed and no 100-iteration race case is present:

| Snapshot | Run | Rows | Result |
|---|---|---:|---|
| Before | `20260727T035311Z-158` | 14 | 14 passed |
| After | `20260727T040220Z-158` | 14 | 14 passed |

Sorting both result ledgers by `caseId` and projecting only `caseId`, `status`,
and `reason` produced identical 14-line files with SHA-256
`b55129cac7b99048d9d29f595fc51584cacab4afaaa5fd20d7de5787ce132541`.

The full comparison then used catalog version 3, dataset hash
`sha256:a1aabe97869b5d43d78f73f545e024e1c91f336bae1ec3ec0d16da0b61a2107a`,
service mode `user`, seed 1, and 4,391 planned executions in each snapshot:

| Snapshot | Run | Passed | Not applicable | Failed | Inconclusive |
|---|---|---:|---:|---:|---:|
| Before | `20260727T035532Z-160` | 225 | 8 | 0 | 0 |
| After | `20260727T040624Z-160` | 225 | 8 | 0 | 0 |

The word *planned* is material. Every one of the 233 result rows records
`iterations: 1`. The runner reads only seven of the catalog's eight tab-separated
case fields and `record_result()` currently writes one iteration for every
implemented handler, so the 100-iteration race plan did not run. This comparison
therefore establishes one before/after execution of each selected case, not
4,391 actual executions and not the absence of timing races.

Each result ledger contains 233 unique case identifiers and the same per-group
row counts, 210/7/16. The sorted three-field projections are byte-identical;
both have SHA-256
`9e29e059f85158bc43c378cc0634ce457b663fb222cdc7448e42ef527b66ab4a`.
The retained diff files are empty, rather than a comparison of summary counts.

The eight not-applicable results were checked individually and had the same
reason before and after:

| Case | Reason |
|---|---|
| `FM-M11-before-no-output-proposed` | boundary M11 does not occur without output |
| `FM-M11-after-no-output-proposed` | boundary M11 does not occur without output |
| `FM-M12-before-no-output-proposed` | boundary M12 does not occur without output |
| `FM-M12-after-no-output-proposed` | boundary M12 does not occur without output |
| `LC-orderly-stop-before-membership-with-descendant` | the Extension cannot fork a descendant before execution is authorized |
| `LC-hard-timeout-before-membership-with-descendant` | the Extension cannot fork a descendant before execution is authorized |
| `LC-failure-cleanup-before-membership-with-descendant` | the Extension cannot fork a descendant before execution is authorized |
| `LC-replacement-before-membership-with-descendant` | the Extension cannot fork a descendant before execution is authorized |

The complete local evidence is under `artifacts/p0-1/`: both source archives,
both boundary runs, both full runs, the four projections, and two empty diff
files. Those generated artifacts are not committed.

## How an interruption point is established

Protocol version 3 requires that "a barrier confirms the exact interruption point before
termination". Sleeping for a chosen interval confirms nothing. The stand-in instead appends every
durable boundary it reaches to a synchronised trace **before** that boundary's own work may
proceed, writes an arrival file at the named boundary by the same atomic write-and-rename the
Core-state writer uses, and then stops its only thread on a value nothing ever changes. No timer,
socket read, or promise continuation can run after that point.

The handler therefore learns "Core is at this boundary and has performed nothing after it" from
the existence of a file, and only then signals. The evaluator re-checks it: every case asserts that
the last line of the interrupted invocation's trace is the boundary the case names. That assertion
passed in all 206 executed cases.

The signal goes to the process the service manager reports as the unit's main process at that
moment. No process identifier is ever read back from a durable record and signalled, which is what
INV-07 forbids.

## Findings

### Finding 1 — the launcher requires the control-group filesystem path; fixed

The retained 210-case run exposed that the then-current lifecycle passed the service manager's
relative path. Current `startModuleProcess` passes `ModuleCgroup.path`, the path below
`/sys/fs/cgroup`, and the product `createModuleLauncherControl` rejects any path change between
configuration and execution authorization. The experiment no longer translates either path form.
The retained run does not retroactively become evidence for the product adapter; that requires the
P0-1 case-by-case rerun recorded separately above.

### Finding 2 — nothing in shipped code prepares the delegated control-group root

`prepareDelegatedCgroupRoot` has no caller in `src/`. `decideLinuxModuleActivation` does not call
it and `startModuleProcess` does not either, so nothing writes `+cpu +memory +pids` to the delegated
service root's `cgroup.subtree_control`. systemd delegates the subtree but leaves that file to the
delegatee, which is Core. Without it a Module control group has no `memory.max`, `pids.max`, or
`cpu.max` file at all and the first limit write fails with `EACCES`.

The stand-in calls it as part of Core readiness. Product code needs an owner for the step.

### Finding 3 — individual adapters now exist; end-to-end assembly remains unproved

**When the 210 cases ran**, `ExtensionProcessHost` had no seam for attaching to an already-started
child process: it unconditionally spawned its own direct child, and `#spawn`, `#child`, and
`#channel` were private, while `ExtensionProcessHostOptions` carried only `command`, `args`, and
`workingDirectory`. Meanwhile `src/adapters/linux-module-executor.ts:48` already assumed otherwise
— "the existing `ExtensionProcessHost` satisfies this shape once its transport is attached to the
launcher's standard streams" — and ADR 0009's own text asserts that each Module is a direct child
of Core, which is the arrangement the rest of ADR 0009 forbids on Linux. The composition ADR 0009
requires therefore could not be built at all, which is why the experiment used a stand-in.

The transport was never the problem and needed no rework: the launcher inherits its control channel
on descriptor 3 (`linux-module-launcher-process.ts:119`) and marks it close-on-exec before `execve`,
so descriptors 0 and 1 survive into the Module and are exactly the pipes Core created.

**This has since been fixed.** `ExtensionProcessHost` now accepts
`AttachedExtensionProcessHostOptions` carrying an `AttachedExtensionProcess`, and both construction
modes converge on one termination and exit-confirmation path. Reviewed against the two constraints
that matter for ADR 0009:

- The seam constructs a host over a process Core already started; it does not let the host start a
  launcher. The ordering `linux-module-process-lifecycle.ts` enforces — persist the process record,
  prepare the control group, start the launcher, verify kernel control-group membership, authorize
  `exec` — is therefore untouched.
- An attachment that cannot report its own exit is rejected at construction:
  `assertAttachedProcess` requires `exited`, `onExit`, `requestTermination`, and `forceTermination`.
  In attached mode the constructor assigns the process and registers the exit observer before
  `start()`, so the "no process, nothing to wait for" branch of `#startForcedProcessTermination` is
  unreachable for an attached host rather than merely documented as such. When an exit is not
  observed within `terminationTimeoutMs`, `#waitForConfirmedExit` throws
  `EXTENSION_TERMINATION_UNCONFIRMED` and moves the host to `failed`; it never treats an
  unobserved exit as an exit.

`attachLinuxModuleProcess` now turns a started launcher and verified Module control group into an
`AttachedExtensionProcess`, and its termination operations call whole-group termination. The host
still cannot enforce that choice. More importantly, no runtime startup caller connects the exact
launcher and control group to this adapter, and no end-to-end run has established that the current
interfaces are sufficient without another change.

The results above still describe a run that used neither `attachLinuxModuleProcess` nor
`ExtensionProcessHost`. The real-host matrix rerun remains pending, and the number of further
assembly gaps must be treated as unknown until it runs.

## Reading limits that apply even within the executed group

- **`M03-after` and `M04-before` are the same instant** in the stand-in: the control group is
  prepared and the launcher does not yet exist. Both cases run and both pass, but they collapse to
  one interruption point. The retained observations show it directly — at both barriers the Module
  control group exists with its limits and reports `members` empty, `populated 0`.
- **Boundary 4 is one wide window, not a sequence of observable steps.** The shipped launcher
  controller performs `configure`, waits for the launcher's in-cgroup report, verifies kernel
  membership, and sends `execute` inside a single `authorizeExecution` call, so an interruption
  cannot be placed between those sub-steps. The observations bracket it: at `M04-before` the group
  is present and `populated 0`; at `M04-after` it holds the executing Extension and is
  `populated 1`.
- **A pass at `M03-after` or `M04-before` is not evidence about stopping a running Module.** At
  those points the control group was never populated, so recovery's `populated 0` proof establishes
  that nothing of that generation ever ran, rather than that something which ran has stopped. Both
  satisfy what ADR 0009 requires before a replacement may start, but they are different facts and
  only the later boundaries demonstrate the second one.
- **`M12` fires on the first output Delivery append only.** The `multiple-output-pages` workload
  performs three. This is a determinism trade-off, made once and recorded here.
- **The `process-descendant` workload has no descendant before boundary 9.** The protocol asks for
  each interruption to run at least once "with a process descendant". The retained control-group
  observations show that this was only true from boundary 9 onward:

  ```
  M05-before .. M08.completion-after   members: 1   (the Extension alone)
  M09-before .. M14-after              members: 2   (the Extension and its descendant)
  ```

  The cause is the fixture's ordering: it issues its first capability request and only creates the
  descendant after that request is answered. An interruption at or before boundary 8 freezes Core
  while that request is outstanding, so the answer never arrives and the descendant is never
  created. Those cells therefore ran the descendant *workload* without a descendant existing at the
  interruption point, and their passes say nothing about descendants.

  Boundaries 1 to 4-before cannot have a descendant under any ordering, because no Extension
  process exists yet. Between those two facts, the genuinely covered range today is boundaries 9
  through 14. Creating the descendant immediately after `exec`, before the handshake, would extend
  real coverage to boundary 4-after onward; that change belongs with the fixture rework and is not
  applied to the fixture the recorded results used.
- **One restart per case.** Protocol version 3 also requires the boundaries with delayed sends or
  process exit races (M04, M07, M14) to run 100 times across ten fixed seeds in each environment.
  That has not been done.
- **One environment, one service scope.** The protocol's stopping rule needs the complete matrix to
  pass from two independently created clean environments for each supported Linux service mode. The
  handler implements the user scope only; the system scope reports `inconclusive` with that reason.
- **The other case groups have not run.** This is one group of protocol version 3, not the matrix.

## Proof that the runner can fail

An experiment whose runner cannot report a failure reports nothing. Both directions were checked
against the executed group.

Breaking the implementation under test: an environment value was added to the launcher's `execute`
command without adding it to Core's declaration. `FM-M13-after-single-output-proposed` became
`failed`, with `declared-environment-only [INV-09] the Extension observed 1 undeclared or altered
environment value(s): DOLLY_UNDECLARED_LEAK`, and the run verdict became `fail`.

Breaking an assertion: the expected `memory.max` read-back was changed to a value the control group
does not carry. `FM-M07-before-processor-loop-proposed` became `failed`, with
`isolation-limits-applied [INV-10] limit read-back mismatch: .../memory.max: 134217728 (expected
999999999)`, and the run verdict became `fail`.

Both changes were reverted and both cases pass again.

## Cleanup

Run-level: the reserved `dolly-test-` namespace held nothing before the run and nothing after it;
cleanup stopped 210 units with none failing, removed no control groups because the service manager
had already removed each unit's own tree, and removed the run state directory. The summary records
`residue.clean: true`.

Host-level, after every run including the fault injections: no container, no `dolly-test-*` unit, no
`dolly-test-*` or `dolly-module-*` control group, and no leftover unit file. Every destructive case
ran inside a disposable container; none ran against the shared machine.
