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

## Focused Linux attached-process and protocol tests

On 2026-07-28, the two Linux-only tests in
`tests/conformance/security/linux-module-attached-process-integration.test.ts`
ran in a systemd 255 container with Linux control group version 2, kernel
6.8.0-106-generic, and Node.js 20.20.2. The Core process ran in the delegated
`core` subgroup of a user service, rather than directly from `docker exec`.
A direct invocation outside that service skipped both tests and was rejected as
evidence.

The retained JSON report names both assertions and records two passed, zero
failed, and zero skipped tests:

| Test | Kernel or process observation |
|---|---|
| `terminates a descendant that left the process group` | The descendant was a member of the Module control group, had a different process-group identifier from the launcher, and was live before termination. After `cgroup.kill`, the descendant was gone and `cgroup.events` reported `populated 0`; cleanup then removed the empty control group. |
| `carries the Extension protocol on descriptors 0 and 1 after exec` | A real `ExtensionProcessHost` completed its handshake and one Run over descriptors 0 and 1. The fixture returned `process.pid`, which equalled the launcher's process identifier and confirmed that the process executing the fixture retained the launcher process identifier across `exec`. |

Each test enabled the delegated root's `cpu`, `memory`, and `pids` controllers
before creating the Module control group. The earlier attempt that omitted
`prepareDelegatedCgroupRoot` failed with `EACCES` while writing `memory.max`;
that was an invalid test setup, not a product failure. Finding 2 below remains
a product gap because no caller in `src/` owns that preparation step.

The test limits were 256 MiB and 64 tasks. The `oom_kill` counter in
`memory.events` was unchanged in both tests, so their termination observations
were not caused by the kernel out-of-memory handler. Cleanup checked that the
descendant process, user service unit, and Module control group were absent
after both the passing run and the negative test.

The negative test changed the adapter to send `SIGKILL` only to the direct
launcher process and to incorrectly report that process's exit as the whole
Module's exit. The first assertion then failed at its required distinction:
the adapter reported `exited === true`, but `cgroup.events` still reported
`populated 1` because the descendant survived. The second test was deliberately
filtered out of this negative run and is recorded as skipped, not passed.

The generated evidence is retained locally and is not committed:

| File | SHA-256 |
|---|---|
| `artifacts/p0-2/control/result.json` | `15406113bcb4056945e02cb03f01476dbd3c009dd411f893fefd8d589af316c0` |
| `artifacts/p0-2/direct-pid.json` | `959e78a790a42b8ac64a22063a8afe657ca4b5eb341061efd898ba4b69b52bfd` |
| `artifacts/p0-2/direct-pid.patch` | `3f94c1d5ecdb7df737fd031e082bd7461442b7796ae88ba4513df54b501a5662` |

The source copied into the passing container had these SHA-256 values:

| Source | SHA-256 |
|---|---|
| Linux integration test | `6e974a27804e3038e68d308403af61f3027e714f9005e4eef5d4ea40eeadeea9` |
| Extension process fixture | `67bdf89ce8a8f96f1edc84f71b3f948e96880b29fb369f9efb62f65f7c64edd0` |
| Control-group implementation | `914de56002553a79a365f9325827063dd394c58a7c9ff0fe5b971716f7ea925f` |
| Attached-process adapter | `7332b3bc6a53b59c4fbf321bd3b97f519176907591a8b15d6b815287e2f4f85a` |

These two focused tests do not use `startModuleProcess`. They establish the
adapter's whole-control-group termination behavior and the standard-stream
transport after `exec`; they do not establish the complete runtime assembly or
the full experiment matrix. At the time of this run, the integration script did
not reject an all-skipped Vitest result on its own, so the named assertion
results and counts were checked directly in the JSON report. Commit `e391ff9`
later fixed that runner defect; the historical result remains recorded as run.

## P0-3 termination confirmation and Linux rerun

On 2026-07-30, commit `3e20e77` tightened the Linux Module executor and process
lifecycle so that termination is confirmed only after all of these conditions
hold:

- the capability-session close call has synchronously rejected new calls and
  every already-started capability handler has finished;
- the Extension protocol channel has been observed closed;
- the whole Module control group has been proven empty and its directory has
  been removed; and
- the matching durable process record has been written as `stopped`.

A failure to persist `stopping` no longer prevents physical cleanup, but it
does prevent a successful termination result. Protocol attachment failure,
unfinished protocol initialization, a mismatched durable record, and a failed
final write likewise cannot be treated as confirmed termination.

### Source and platform

The Linux runs used one source archive with SHA-256
`74e292fc35196d46ffcc74e5cf0ebd6d7a0ed1d4763fb1a552b6a1c9ad35ebe8`.
It contained the product and experiment changes later committed as `3e20e77`.
The environment was Ubuntu 24.04.4, kernel 6.8.0-106-generic, systemd 255,
control group version 2, Node.js 20.20.2, and Python 3.12.3. Each experiment
ran as an unprivileged account under a delegated systemd user service in a
uniquely named disposable container.

The archive lost the executable mode on two experiment entry scripts, and its
host dependency view contained absolute symbolic links that did not resolve in
the container. The successful runs used a unique execution copy that changed
only those script modes and the read-only dependency mount. Product sources
and experiment sources were byte-identical to the archive. Commit `e391ff9`
subsequently records the three public Linux entry scripts as executable.

### Local review and mutation tests

Four exact conformance files passed 91 of 91 tests, and the complete TypeScript
check exited zero. An independent review found no remaining false-success or
wrong-control-group termination path in this change.

Fourteen isolated mutations were then applied one at a time to frozen source
copies. Every mutation made its intended single test fail, with underlying
Vitest exit code 1 and no compilation or missing-test failure. The retained
report is
`artifacts/p0-3/mutation/module-termination-mutation-tests-20260730-004/REPORT.md`,
whose SHA-256 is
`1ad4e954f7ae6778a73fcc6b47ce016f147ccbf24e70886dec17d59410e73592`.

The mutation evidence has a deliberate limit. It separately rejects a wrong
control-group path and a wrong process generation, but it does not mutate
`instanceId` and `moduleId` one field at a time. It must not be cited as
field-by-field proof for those two values.

### Focused runs

| Selection | Result | Scope |
|---|---:|---|
| The two attached-process Linux tests | 2 passed, 0 skipped | A real descendant outside the launcher's process group was terminated through `cgroup.kill`; the real protocol also completed over descriptors 0 and 1. |
| `SC-13-07-cleanup-timeout` | 1 passed | Real processes, control-group membership, and `cgroup.kill` were used. The `cgroup.events` read was deterministically held at `populated 1`, so this proves refusal without an empty-group result, not a kernel that naturally remained populated. |
| `live-core-termination`, proposed arm | 12 passed, 4 not applicable | The four not-applicable cases require a descendant before execution authorization, when the Extension cannot have created one. No case failed or was inconclusive. |
| `FM-M14-after-process-descendant-proposed` | 1 passed | The trace reached `M14-after`, process and submission records were closed, and no Module control group remained. The artifacts do not contain a pre-stop descendant process identifier, so direct proof that this particular run killed a descendant remains incomplete. |

The new attached-process JSON is retained at
`artifacts/p0-3/p0-2/result.json`, with SHA-256
`dcdd24d0dce695d2f987cce828c5a0fae8d51df352b2de92437fc57cee0eab2d`.
The three focused experiment directories are under `artifacts/p0-3/focused/`.

### Complete proposed-arm comparison

The same three groups used for P0-1 were run again: 210 fixed-interruption
cases, 7 capability-idempotency cases, and 16 live-termination cases. All 233
selected cases had a handler and produced this result:

```
cases  233   passed 225   not applicable 8   failed 0   inconclusive 0
cleanup ok true   residue clean true
verdict  pass
```

All 233 case results had exit code zero, no timeout, no invariant violation,
and no missing required artifact. Cleanup attempted 233 systemd units with
zero failures, and the exact disposable container was absent after the run.

The current and P0-1 result ledgers were independently parsed, sorted by case
identifier, and projected to `caseId`, `status`, and `reason`. Both had 233
unique identifiers. There were no missing, added, or changed rows, and the
ordered current projection matched the retained P0-1 projection line for line.
This is a per-case comparison, not an inference from equal summary counts.

Retained complete-run files:

| File | SHA-256 |
|---|---|
| `artifacts/p0-3/full-proposed/20260730T032758Z-184/results.jsonl` | `b0a77ddb5c195fc86d5a6740e5a0a5fb3ac21ac5abfa6dcc5868b32afb263b42` |
| `artifacts/p0-3/full-proposed/20260730T032758Z-184/summary.json` | `f03b85e07ab2aec6dd527e5693cf27028e685f1825f7ecfe3a7163b275af51ee` |
| `artifacts/p0-3/full-proposed/20260730T032758Z-184/manifest.json` | `083af20ee194378f5501e299bcd5654af619ae598934fa81c75eb7db7ca48281` |

The UTF-8, line-feed-separated list of each retained relative path and SHA-256
contains 8,025 entries and hashes to
`17c6fe2a47f001e1d628b93b857da3b550f7ee9cef3d22c556ce1898413c4df5`.

The manifest still plans 4,391 executions, but every one of the 233 result rows
records `iterations: 1`. This run confirms one execution of every selected
case. It does not establish the planned repetition count or the absence of
timing races.

### Runner correction after the evidence run

Commit `e391ff9` also removed the catalog's stale
`status: "not-implemented"` field. Catalog version 4 has the same 570 cases,
filters, and pass criteria as version 3; handler availability is measured by
the runner and recorded in the result ledger. The P0-3 artifacts correctly
retain catalog version 3 because that is the code that produced them.

The Linux integration runner now sets
`DOLLY_LINUX_MODULE_INTEGRATION_REQUIRED=1`. If the systemd service fails to
place the test process in the delegated `core` subgroup, the three Linux test
files fail during collection rather than allowing an all-skipped success. A
negative run outside the subgroup exited 1. A positive systemd-container run
executed 25 tests across the three files: 25 passed, 0 failed, 0 pending or
skipped, and 0 todo. Its JSON is retained at
`artifacts/p0-3/runner-fix/result.json`, with SHA-256
`98b66976649986e50cdb3a01cde145c5a88cea1a11ac1a44999212e58f97d444`.

These results accept the termination behavior described above. They do not
accept the complete Linux startup design. In particular, process ownership can
still be lost on failures after membership verification or while writing the
`running` record, and no runtime startup caller yet assembles the same launcher,
control group, attached process, and `ExtensionProcessHost` end to end.

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
