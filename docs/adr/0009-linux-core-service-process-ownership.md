# Architecture Decision Record 0009: Linux Core service owns Module processes

Status: Proposed

Date: 2026-07-26

## Context

Core must prove that an old Module process cannot still execute before it starts a
replacement Module generation or releases an active Claim. The current
`ExtensionProcessHost` signals only its direct child and can prove only that
this direct child exited, and only while the Core process that created the
child remains alive. It cannot prove that descendants stopped, so a Module
descendant can survive a hard timeout even while Core stays alive. A process
identifier (PID) is insufficient after restart because Linux may reuse it.

Architecture Decision Record (ADR) 0008 proposed one transient systemd user
service for every Module process generation. It was rejected because a delayed
creation request could overlap a replacement, stopping by unit name could not
atomically require the expected `InvocationID`, and inherited process pipes
could not be reattached.

A separate long-running process supervisor was also considered. It is rejected:
it would duplicate Core's Extension protocol, capability-handler lifecycle,
durable result handling, and recovery logic, while adding a second failure
boundary between Core and a new process. That complexity does not remove any
responsibility already held by Core.

## Proposed decision

On Linux, a configured Module may run only when the existing Dolly Core runtime
is the main process of a stable per-instance systemd service. In this decision,
the **Core service** means the existing Core runtime launched by systemd;
it is not a new runtime process or protocol. Core continues to own
`ModuleActor`, `ExtensionProcessHost`, capability handlers, Claims, and the
existing Module result-commit journal. A **Module result commit journal** is the
existing durable journal that records a received Module result before it creates
its Block, output Deliveries, and input acknowledgement; it remains the only
 result store. Each Module is a direct child of Core. Product code now contains
 `createModuleLauncherControl` for the ordered start and
 `attachLinuxModuleProcess` for presenting a started launcher and its verified
 Module control group to `ExtensionProcessHost`. No runtime startup caller has
 connected those exact values end to end, so the assembly remains unproved and
 the number of remaining gaps remains unknown. "Attaching the protocol
 transport to the launcher child" below states the resulting block on
 `Accepted`.

The outer systemd boundary makes a Core crash recoverable: systemd removes the
complete Core service control group before starting the next Core invocation.
The new Core invocation reconciles durable state before it starts a Module. A
**control group (cgroup)** is the Linux kernel hierarchy used to collect
processes so that resource limits and termination apply to the group.

A **Module cgroup** is one non-reused child cgroup assigned to one
`processGenerationId`. It relates the existing Module process record to the
kernel group that must contain that Module process and every descendant. The
qualified phrase is necessary because a service cgroup contains Core and may
contain more than one Module cgroup.

This proposal does not enable configured Modules. It may become `Accepted` only
after its contracts, implementation, migration, and failure tests exist and
pass. Until then, `runtime-bootstrap.ts` must reject configurations containing a
Module.

### Stable Core service lifecycle

The installed service has a stable identity derived from the existing
`instanceId`. Routine Module execution never creates, stops, or replaces that
unit. The effective service configuration, not merely its unit-file text, must
have all of the following:

- `Type=exec`;
- `Restart=on-failure` with finite restart limits;
- `KillMode=control-group`, `SendSIGKILL=yes`, and a finite
  `TimeoutStopSec`;
- `Delegate=yes` with `DelegateSubgroup=core`, cgroup version 2, and the
  required `cpu`, `memory`, and `pids` controllers;
- `ExitType=main` and `RestartMode=normal`; and
- no `RemainAfterExit=yes`, no restart-status override that treats a forced
  Core exit as successful or prevents its required restart, and an explicit
  minimal service environment.

The Core executable must clear inherited service-manager environment before the
Node.js runtime starts. Its `ExecStart` uses the systemd `:` prefix so systemd
does not expand environment variables in executable arguments. It uses only
absolute installed Node.js and Dolly paths; it never receives Extension paths,
commands, or shell syntax from Module configuration. Clearing only the command
used to ask systemd to start Core is insufficient because a user service can
inherit its user manager's environment.

Core may retain a non-secret candidate unit name and invocation identifier in
that minimal environment, but neither is authority. Before accepting Module
work, Core uses the systemd D-Bus service-manager interface and the Linux
process filesystem at `/proc/self/cgroup` to prove both directions of the
binding: the manager reports the current Core process identifier and expected
control-group path for the unit, and Core's own process identifier and cgroup
match them. It then records the manager-reported invocation identifier, the
Linux boot identifier, and only a Core-derived Module cgroup path. A saved
process identifier, environment value, unit property by itself, or child
report is insufficient.

A user service must verify that user lingering is enabled so its service manager
remains available after the last login session ends. A server deployment may
instead use a system service with a dedicated service account. If the expected
service lifetime, effective unit settings, current manager binding, cgroup
version 2 delegation, controller availability, timeout, or environment
boundary is absent or cannot be verified within a bounded wait, Module
activation fails closed. There is no foreground direct-child fallback that
claims restart safety.

Before recovering or starting Module work, Core verifies every old
Core-derived Module cgroup path from its durable records is empty. Within the
same Linux boot, the normal proof is `populated 0` in `cgroup.events`. A missing
path is equivalent only when the path contains the record's non-reused
process-generation identifier, Core has verified the current service-manager
binding, and the path has not been recreated. A populated, inaccessible, or
ambiguous path fails closed. A changed Linux boot identifier proves that a
process from the old boot cannot still exist, but does not make the old path an
identity for a new process: Core still verifies the new service binding and
uses a fresh non-reused path. Core never infers process absence from a saved
process identifier (PID). It may mark an old process record stopped only after
one of these proofs.

### Module process control

The delegated service root contains no processes. systemd places Core in its
`core` subgroup, and Core creates one non-reused sibling cgroup for each
`processGenerationId`. This topology is required by cgroup version 2 controller
rules: the parent can distribute domain controllers only when it has no tasks
of its own. Core constructs every Module cgroup path from its own instance,
Module, and process-generation identities; no Extension or configuration value
supplies a cgroup path.

Before it accepts Module work, Core reads the delegated root's `cgroup.procs`
and requires it to be empty, enables `+cpu`, `+memory`, and `+pids` in that
root's `cgroup.subtree_control`, and reads the control file back. For every
prepared Module cgroup it then verifies that the required controller files
exist and that the written limits are the requested finite values, not an
implicit unlimited default. If systemd policy or kernel delegation prevents any
of these checks, Core fails closed rather than treating `Delegate=yes` as proof
that resource controls work.

Before Core starts an Extension process, it persists the process generation,
creates its cgroup, writes and reads back all required limits, and verifies
that `cgroup.kill` and `cgroup.events` are usable. The Linux mechanisms are:
`memory.max` plus `memory.oom.group=1` for memory, `pids.max` for process
count, `cpu.max` for processor rate, a launcher-set `RLIMIT_NOFILE` for open
files, and Core-enforced protocol-frame and result-size limits. A finite
wall-clock deadline ultimately causes cgroup-level termination; a JavaScript
timer alone is not a hard time limit. Missing support or a failed read-back
blocks launch.

Core must not start an Extension and then move its process identifier into the
Module cgroup. That leaves a window in which Extension code or descendants can
run outside the group. A **child launcher** is a fixed reviewed executable that
exists only because ordinary Node.js child creation cannot place an Extension
atomically in a different cgroup. It relates the direct Core child to the
prepared Module cgroup and is necessary until an equally reviewed kernel
facility can create the child directly in that cgroup.

The launcher must join its cgroup, set its own `RLIMIT_NOFILE`, and then
replace its own process image, all in one process. Node.js 20, the runtime this
deployment installs, exposes neither `execve` nor `setrlimit`, and every
Node.js workaround creates a second process outside the intended topology.
The launcher is therefore a small program in a language whose standard library
provides both operations. The current implementation uses Python 3 with no
third-party import, which makes a Python 3 interpreter a Linux deployment
requirement for executable Modules; public installation documentation must
state that requirement and verify the interpreter before Module activation. A
later Node.js version that exposes both operations, or an equally reviewed
kernel facility, would remove this dependency and is the preferred long-term
direction.

Core starts only that launcher. Before it may execute Extension code, the
launcher moves itself into the prepared Module cgroup, applies the open-file
limit, closes every inherited descriptor except the protocol transport and the
one protected control descriptor, and waits for Core approval. It must not
fork, perform network input/output (I/O), read Extension configuration, or
execute an Extension before that approval. Core verifies its membership from
kernel cgroup files, confirms that stop was not requested, and only then
authorizes `exec` of the exact registry executable with a closed environment
and argument array. The control descriptor must not survive that `exec`, so
the Extension retains no Core management descriptor. The launcher accepts only
a Core-validated descriptor through that protected control descriptor; it
accepts no Extension-controlled path or command input.

Before Core has observed any member in the Module cgroup, and while the
`execute` command is known not to have begun delivery, it asks the launcher to
exit through the protected descriptor and waits for its observed exit. It does
not send a signal using a process identifier alone. Core then reads
`cgroup.events` again and removes the prepared cgroup directory. The process
record may become `stopped` only after the fresh reading reports `populated 0`
and directory removal succeeds. If the fresh reading finds a member, Core
instead terminates the whole Module cgroup. If launcher exit cannot be proven,
or delivery of `execute` may have begun, Core exits unsuccessfully and lets the
Core service's systemd cleanup remove the whole service cgroup; it does not
start a replacement or attempt process-identifier-based cleanup.

Once a kernel file has shown any member in the Module cgroup, every hard
timeout, orderly stop, failure cleanup, and replacement terminates the whole
Module cgroup with `cgroup.kill` or an equivalent group operation. This remains
required when the observed list fails exact launcher-only verification and
execution is refused. If that list does not contain the launcher and launcher
exit is also unconfirmed, Core attempts the group cleanup and still exits so
systemd removes any launcher outside that group. Core may report termination,
close a process record, release or classify a Claim, or start a replacement
only after the applicable protocol channel is closed, `cgroup.events` reports
`populated 0`, the Module cgroup directory is removed, and every applicable
capability handler has reached a terminal state. A direct child-process handle
or a child exit event is never sufficient proof after any cgroup member has
been observed.

`populated 0` carries different facts in these two paths, and evidence about
this decision must distinguish them. After execution was withheld and launcher
exit was observed, a fresh reading says that the group is empty at that moment;
successful directory removal then makes that current-state check enforceable.
It does not prove that no process briefly joined earlier. After `cgroup.kill`
of a group whose membership was observed, the same reading proves whole-group
termination. Measurement confirms why the reading alone is insufficient: with
the group prepared and its limits written, but before any observed membership,
the kernel reports the same empty members list and the same `populated 0` as it
does before the launcher is started at all.

The shipped controller performs configuration, the launcher's in-cgroup
report, kernel membership verification, and execution authorization in one
operation, but it evaluates the stop request again immediately before sending
`execute`. A test can hold the kernel membership read, request termination,
and prove that no execution command is sent. The current live-Core experiment's
earliest stop callback runs before this controller operation begins, so that
experiment does not by itself cover termination during membership reading or
an uncertain `execute` send; those require separate cases.

`none` isolation is forbidden for an executable Module. Ordinary `process`
isolation is not, by itself, enough to meet this decision, even for code that an
operator calls trusted: the Linux execution backend must prevent every Extension
process from changing or leaving its assigned cgroup, changing its limits,
opening Core state or service-manager control files, retaining Core management
descriptors, or signaling Core. It must also keep all descendants in the
assigned cgroup. A separate accepted sandbox backend is required for untrusted
code and additionally must prevent ambient filesystem, network, or subprocess
authority. Sharing a user account with Core means cgroup delegation alone is
not a hostile-code boundary. If either boundary cannot be enforced and tested,
Module activation remains disabled.

The first reactive Module path permits no external or persistent side effect
during `dolly.initialize`, `module.create`, `module.stop`, shutdown, or
background activity. Before an active `module.execute` Run, Core denies every
capability request that could have an effect. A Module is eligible for this
first path only when its validated configuration explicitly declares that the
Module makes no external or persistent effect except through the durable Core
capabilities in this decision, and Core records that declaration in the Module
process record. The configuration field implementing this declaration is
`declaredExternalEffects` in `core-runtime.md` Section 5.2. A sandbox backend
enforces the declaration for untrusted code.
Ordinary `process` isolation cannot enforce it for trusted code: there the
declaration is an audited operator assertion, and user documentation must state
that Core cannot verify it. An Extension with direct filesystem, network, or
subprocess authority is not eligible for automatic activation or recovery in
this first path, even when an operator calls it trusted: a later design may
expose an explicit audited manual workflow, but it must not treat absence of a
submission record as proof that such an Extension made no effect.

### Attaching the protocol transport to the launcher child

This decision keeps `ExtensionProcessHost` in Core and keeps each Module a
direct child of Core. The shipped host could not be assembled that way when
this decision was written: its options accepted only a command, arguments, and
a working directory, so its process creation always started its own direct
child. `ExtensionProcessHostOptions` now has an `attachedProcess` alternative
that supplies an already-started process instead, and the host builds its
protocol channel over that process's existing streams.

Three further gaps were found after that seam landed, each when something tried
to assemble the parts, and each now has source that addresses it:

First, the missing started-launcher adapter is now `attachLinuxModuleProcess`.
It requires the exact launcher and verified Module control group, and its two
termination operations call whole-group termination. The host deliberately
does not know how its attachment terminates a process, so it can neither perform
nor enforce that obligation. Required failure test 13 below states what this
adapter has to prove on Linux.

Second, `createModuleLauncherControl` now implements the launcher control
operations that the ordered start sequence calls. The launcher controller
presents a different shape: it runs the whole sequence from one call and
reports failure by returning an outcome rather than throwing. The adapter maps
every non-executing outcome to a failure; an unmapped variant would be
indistinguishable from success, which is the failure direction this decision
refuses everywhere else.

Third, the control-group path handed to the launcher was in the wrong form. The
launcher writes its own identifier into `cgroup.procs`, so it needs the path
under the cgroup version 2 mount point, and its own validation requires exactly
that. This was corrected where the value is chosen, not normalised inside an
adapter: the launcher's check exists to catch a wrong path before it can
redirect that write outside the cgroup filesystem, and an adapter that quietly
converts whatever it receives removes the protection that check provides.

Individual implementations therefore exist, but that is not an assembled
runtime. The executor still receives a no-argument protocol-session factory
from its caller, and no startup caller connects the same started launcher and
verified Module control group to `attachLinuxModuleProcess`. The assembly has
never been run end to end. Focused Linux tests now show that whole-group
termination reaches a descendant which left the process group and that the
launcher's standard streams carry the Extension protocol after `exec`; those
results do not replace the missing end-to-end runtime assembly.

These three shared one shape with each other and with the transport seam that
preceded them: a written interface, a comment asserting an implementation
exists, and no implementation. None was found by reading; each was found when
something tried to assemble the parts. That is the reason the sentence above
says the assembly has not been run rather than that the parts are complete:
**until an end-to-end assembly runs, the number of remaining gaps is unknown
rather than zero.**

The launcher side does not need to change. Core starts the launcher with the
protocol transport on the child's standard input and output and the control
descriptor on a separate inherited descriptor. The launcher closes every other
inherited descriptor, marks the control descriptor close-on-exec, cancels its
own interval timer, and replaces its process image, so the executed Extension
inherits exactly the standard streams Core created and retains no Core
management descriptor. The transport the host needs is already open and
correct, and always was; what the adapter has to supply is not a transport but
a termination that reaches the whole control group.

Neither the seam nor the adapter may be implemented by letting the host start
the launcher itself. Doing so would move cgroup membership verification inside
the host and break the required order: persist the process record, prepare the
cgroup, start the launcher, verify kernel membership, then authorize `exec`.
Membership verification must remain outside the host, between launcher start
and execution approval.

An attached host must reach the same termination proof as a host that started
its own child. It may report termination only on the evidence this decision
already requires, and when it cannot observe that evidence it must fail closed
rather than treat an unobservable exit as an exit.

Although both product adapters now exist, the current experiment still uses a
substitute child protocol and does not run `ExtensionProcessHost` or
`attachLinuxModuleProcess`. Its results support the ownership and persistence
boundary only, and must be reported as supporting that boundary rather than the
assembly. An experiment that supplies its own attached-process adapter tests
that adapter, not the one Core would ship, at precisely the layer carrying the
whole-group termination obligation; required failure test 13 must therefore run
against `attachLinuxModuleProcess`.

### Durable Module process record

A **Module process record** is Core's durable description of one attempt to
start one existing Module generation. It relates the existing Module and
process-generation identifiers to validated package and configuration revisions,
the recorded external-effect declaration, the verified Core-service invocation
and boot identifier, Core-derived cgroup path, lifecycle state, bounded
timestamps, and safe failure information. It is necessary because Core loses
its in-memory child handle if it exits; the existing Claim and result journal
do not say whether an Extension process was created.

The process-generation identifier is allocated by Core in durable state before
any child is created and is never reused. Core persists the process record
before it starts the child launcher. If Core dies before child creation, no
delayed external component can later create that child because only the
now-dead Core could do so. If the child was created, systemd removes it as part
of the Core service cgroup before a later Core invocation begins Module
recovery. The later Core marks the prior process record stopped only after it
has verified the new service boundary and that the old Module cgroup is empty.

A live Core uses its exact child-process handle only during the pre-membership
launcher phase. After restart, it never signals a recovered process identifier;
a process identifier may be retained only as diagnostic data. The record never
contains credentials, capability handles, signed URLs, user content, untrusted
paths, or an Extension-provided cgroup path.

### Durable Module submission record

A **Module submission record** is Core's durable statement that an existing Run
may have crossed the Extension process protocol. It relates the existing
`moduleJobId`, `runId`, attempt, Claim, and generations to the canonical input
digest and authority to send. It is not a new job, Run, or execution identity.
It is necessary because a crash between protocol send and result receipt
otherwise makes it unsafe to decide whether a Run was executed.

For this decision, a **Core-state update** is one atomic replacement of the
complete persisted Core state, including Delivery Claims, Module process
records, and Module submission records. It is not another repository or result
store. The term is necessary because absence of a submission record proves
anything only when it is observed in the same committed state as its Claim and
that state is known to have been written under the invariant below.
Each update synchronizes its file, atomically replaces the old file, and
synchronizes its parent directory to durable storage (`fsync`). Invalid
versions, identity mismatches, a submission record that cannot be linked to its
exact active Claim, a terminal Claim beside a submission record, or a partial
or unknown update fail closed.

Before `module.execute`, Core makes one confirmed Core-state update containing
the exact active Claim, matching running process record, process generation,
canonical input digest, and authority to send. It sends only after that update
returns successfully. If the write result is uncertain, Core rereads the exact
state; until it can prove the update's result, it does not send. Therefore a
submission record absent from a valid recovered Core-state update means Core
never received durable authority to send that Run only when the writer or an
explicit migration is known to enforce this decision. Version 17 makes that
distinction explicit. An **unknown submission history item** records the exact
identity of an active Claim migrated from an older Core-state format when Dolly
cannot determine whether its submission record ever existed. It contains the
Claim's `moduleJobId`, claim token, `runId`, attempt, and
`moduleGenerationId`. Absence proves no authority only when the exact active
Claim is also absent from that collection. A separate record file is forbidden
because an independently durable Claim and record could create a misleading
torn recovery view.

Every submission record matches exactly one active Claim in the same Core-state
update. An active Claim may have zero or one matching submission record. Any
submission record selects exactly one Module process record by its
process-generation identifier; stopped historical records for the same Module
generation are not additional matches. The Claim's consumer identifier must
equal that process record's `moduleId`, and their Module-generation identifiers
must match. Core recomputes the canonical input digest from the exact durable
input bound to the Claim before writing the record and again during recovery. A
missing input or digest mismatch fails closed.

Any transition of a submitted Claim to `released`, `nacked`, `committed`, or
`dead-lettered` removes its record in that same Core-state update. A terminal
Claim and submission record may never coexist and may not be repaired by later
record collection.

The existing result-commit journal remains the sole authoritative result store.
It remains a separately synchronized journal because it records Block, output
Delivery, and acknowledgement effects, but its recovery always precedes
interpretation of active Claims. A successful Run moves through a synchronized
`prepared` journal record, recoverable Block and output Delivery effects, one
Core-state update that positively acknowledges the exact Claim and removes its
submission record, and finally a `committed` journal record. A crash after the
`prepared` record is recoverable because that record is durable before any
result effect and identifies the work recovery must resume. A crash after the
Core-state update but before the final journal update may therefore leave a
`prepared` record with a Claim whose status is `committed` and no submission
record. Recovery may mark the journal record `committed` only after verifying
the exact result and that all required Block and output Delivery effects are
complete; missing or contradictory effects fail closed. This ordering does not
allow any terminal Claim with a submission record. Other terminal Claim
dispositions require no-send, no-effect, or retry-safe evidence applicable to
that disposition, or an explicit audited operator disposition, before the same
atomic Claim transition and record removal. A durable terminal external-effect
outcome does not prove that repeating the Run is safe without a separate
durable idempotency contract. The operator disposition is not retry-safety
evidence and must warn that release or retry can repeat an external effect.

A `prepared` journal record may otherwise coexist only with its exact active
Claim and matching submission record. A `committed` journal record must match a
Claim whose status is `committed`, with no submission record. Every other
combination fails closed.

This ordering provides recoverable, idempotent completion. It does not provide
exactly-once Module execution or exactly-once external effects.

The required startup reconciliation order is:

1. Verify the current Core service and prove every old Module cgroup empty.
2. Open and validate one complete Core-state update. Any submission record
   lacking its exact active Claim or process record, a terminal Claim beside a
   submission record, an invalid unknown submission history item, or any record
   identity mismatch blocks Module activation.
3. Reconcile the existing result-commit journal, then reread Core state because
   journal recovery can atomically complete a Claim and remove its submission
   record before marking a `prepared` journal record `committed`.
4. For each remaining active Claim, inspect the matching process and submission
   records from that one Core-state update.
5. In version 17, when neither a submission record nor an exact
   unknown submission history item exists and every old process was proven
   stopped, release only the exact Claim with reason
   `never-authorized-to-send`. A matching unknown submission history item keeps
   the Claim active and blocks startup; ambiguous version 15 or version 16
   absence never meets this condition directly.
6. A valid `prepared` journal record with its active Claim and submission record
   resumes under step 3; it is not an unknown outcome merely because the journal
   is not yet `committed`. When no valid recoverable result record exists,
   preserve a submitted Claim as an unknown outcome unless every possible effect
   has durable no-effect or retry-safe evidence, or an explicit audited operator
   disposition. A terminal effect outcome without a separate durable
   idempotency contract remains unresolved.
7. A `prepared` journal record with a Claim whose status is `committed` and no
   submission record may finish the verified transition described above. A
   `committed` journal record requires that same Claim status and absence of the
   submission record; every other journal/Claim combination fails closed.

Neither durable record alone authorizes acknowledgement, negative
acknowledgement, retry, dead letter, Claim release after an unknown outcome, or
a replacement Module generation.

### Capability handling and orderly stop

Capability handling remains in Core. For the first reactive Module path, every
Extension capability request must carry the exact active `moduleJobId` and
`runId`. The host denies a request sent before `module.execute`, sent after the
Run ends, missing either identifier, or carrying any mismatched identifier.
This restriction is necessary so absence of a submission record also means no
Core-mediated external effect was authorized for that Run.

Every capability that can cause an external effect must persist an intent with
a stable idempotency key before input/output, and its provider, storage, Media,
or tool contract must provide either a durable outcome or a query for an
unknown result. Its durable evidence is linked to the exact Claim and Run; an
in-memory duplicate map is not restart evidence. Aborting a local handler proves
only that Core stopped waiting; it does not prove that a remote operation did
not complete.

The current `EffectIntentJournal` and `effectIntentEvidenceSource` implement
this record protocol and expose it to recovery, but no persistent product
`EffectIntentStore` exists and no product capability execution path is required
to write through it. An empty journal or records that are all `no-effect`
therefore cannot prove that every possible effect for a Run was recorded; both
remain unknown. A `terminal` outcome proves only a durable final result.

The current `dolly.effect-intent/2` record puts the stable idempotency key and
one exact Claim/Run identity in the same record. It safely rejects reusing that
key from another retry Run, but that also means it cannot yet model both one
stable logical effect and every Run authorized to request it. Product
integration requires a persistent schema that represents those relationships
separately or proves an equivalent relationship before recovery can use a
record from another Claim.

All Claim dispositions use the same evidence, not only startup recovery. A
normal failure, timeout, cancellation, or orderly stop may negatively
acknowledge, release, or retry a submitted Run only when the result journal and
every possible effect have durable no-effect or retry-safe evidence. A terminal
effect outcome alone does not prove that repeating the Run is safe. Otherwise
Core preserves the exact active Claim as an unknown outcome for audited
operator action. That operator action must be recorded with the exact Claim
and the evidence considered, and a forced release must warn that it can repeat
an external effect before it is confirmed.

Ordinary `process` isolation cannot enumerate direct file, network, or
subprocess effects made by a trusted Extension. A trusted Module that can make
such direct effects is therefore never automatically retried after submission
without a committed result. Automatic recovery is available only for a Module
with no external effects or one whose effects all pass through the durable Core
capabilities above. An untrusted or publicly installed Extension requires the
separately accepted sandbox that prevents direct effects.

During termination, Core prevents new work, requests cancellation, revokes
capabilities, and begins the cgroup-level stop defined above. It waits for the
protocol channel to close, the Module cgroup to report `populated 0`, applicable
handlers to become terminal, and any result operation to settle. Only then does
it apply the evidence rules above and make one Core-state update for the exact
Claim. The finite systemd timeout is an outer fallback. If it expires, systemd
kills the complete service cgroup and the next Core invocation performs
conservative recovery; it must not fabricate a clean shutdown.

## Why this differs from ADR 0008

- systemd manages one stable Core service, not a new unit for every Module
  generation;
- the existing Core owns direct child-process handles and Extension protocol
  state;
- systemd cleanup occurs at the one necessary crash boundary, Core restart;
- durable process and submission records resolve only information missing after
  Core exit; and
- no separate process duplicates Core protocol, capability, or result logic.

## Alternatives not selected

- Persisting a PID and signaling it after a metadata check retains a
  check-then-act race and cannot prove process identity.
- A Linux process file descriptor (pidfd) removes the identifier-reuse race
  while signaling one live process, but it cannot be recovered after Core
  restart, identifies one process rather than its descendants, and therefore
  cannot prove group termination.
- Per-generation transient systemd services are rejected by ADR 0008.
- A separate Module process supervisor adds a duplicate lifecycle and an
  independent Core-to-supervisor recovery protocol without removing Core's
  existing process, Claim, capability, and result responsibilities.
- In-process Extensions cannot contain a central processing unit (CPU) loop or
  prove forced termination.

## Required failure tests

Before this ADR can become `Accepted`, Linux tests must cover at least:

1. Core termination before and after process-record persistence, cgroup
   preparation, launcher membership verification, child creation, Claim
   creation, submission-record persistence, protocol send, result receipt,
   every output effect, and acknowledgement;
2. a non-catchable Linux `SIGKILL` of Core with a normal child, a child in its
   delegated Module cgroup, descendants, a CPU loop, and active capability
   handlers, proving old cgroup cleanup before the next Core recovery;
3. ordinary hard timeout, orderly stop, failure cleanup, and replacement while
   Core remains alive, before and after a cgroup member is observed and before
   and after an Extension forks a descendant; an observed member requires
   `cgroup.kill`, `populated 0`, and directory removal, while the earlier path
   requires an observed launcher exit, a fresh `populated 0` reading, and
   directory removal without claiming whole-group termination; uncertain
   launcher exit or `execute` delivery must force a nonzero Core exit;
4. service-manager restart in a disposable environment, login termination with
   and without lingering, and machine reboot recovery, including a same-boot
   missing old cgroup path and a changed boot identifier;
5. exact service settings and environment verification, including executable
   paths containing spaces or literal variable-like text, inherited-environment
   sentinel values, and every rejected weakening setting (`ExitType`,
   `RestartMode`, `RemainAfterExit`, restart-status override, delegation, or
   timeout); exhausting the finite service restart limit must leave the service
   visibly failed with Modules disabled rather than restarting indefinitely;
6. enforced memory, process-count, processor, open-file, protocol-frame,
   result-size, and time limits; an untrusted sandbox fixture must also fail
   every cgroup-change, cgroup-escape, Core-signal, Core-state, manager-control,
   inherited-descriptor, other-process `/proc` state, filesystem, network, or
   subprocess escape attempt;
7. unavailable systemd, unavailable cgroup version 2 delegation, corrupt
   durable records, unavailable state storage, and finite cleanup timeout all
   failing closed;
8. Core-state write, file synchronization, atomic replacement, and parent
   directory synchronization faults at every boundary; recovery must reject a
   partial or mismatched Claim/process/submission view, including a terminal
   Claim beside a submission record;
9. result reconciliation, active Claims, unknown submission outcomes, and
   capability effects before remote acceptance, after remote acceptance, and
   after a lost response never producing duplicate output or an unsafe retry;
   injected failures must cover `prepared` result, atomic positive
   acknowledgement and submission-record removal, and `committed` result
   boundaries;
10. rejected reuse of a process-generation identifier or Module cgroup path,
   and a package or configuration upgrade that cannot alter or erase the
   pinned revisions of an unresolved process record, submission record, or
   Run;
11. capability effect-intent and idempotency evidence surviving a Core crash,
   with an in-memory duplicate map rejected as restart evidence, and refusal
   to automatically activate a Module whose configuration does not declare
   Core-capability-only external effects; and
12. an `ExtensionProcessHost` attached to a launcher child that Core already
   started reaching the same initialization, orderly-stop, forced-termination,
   and confirmed-exit behavior as a host that started its own child, and
   failing closed instead of reporting termination when it cannot observe the
   required evidence; a host that starts the launcher itself, or that verifies
   cgroup membership internally, must be rejected;
13. the adapter that presents a started launcher to that host terminating the
   whole Module cgroup rather than signalling a process identifier. The host
   deliberately does not know how its attachment terminates a process, so it
   cannot enforce this and no host test can cover it: an adapter that called
   for a signal to one process identifier would satisfy every host contract
   while leaving descendants running. The obligation therefore has to be
   tested where the adapter is, with a descendant that left the process group,
   and reported termination must still rest on `cgroup.events` reporting
   `populated 0` rather than on either termination call returning. Both
   termination levels must perform the group operation; implementing the
   escalation as a no-op would encode an unverified claim that the first call
   succeeded, which is what this decision refuses to do everywhere else; and
14. cleanup leaving no Dolly test service, process, cgroup, socket, or temporary
   record behind.

The tests use local fixtures and bounded timeouts. They do not require a model
provider, object store, owner credential, private endpoint, or paid application
programming interface (API).

## Platform and migration impact

This proposal is Linux-specific. Windows Module activation remains disabled
until a separately reviewed design supplies equivalent service ownership,
process-group cleanup, resource limits, and restart recovery, likely with a
Windows service and Job Object.

A Linux deployment that runs executable Modules additionally requires a
Python 3 interpreter for the child launcher described above. Startup must
verify the interpreter before Module activation and fail closed when it is
absent, in the same way it fails closed on missing systemd or cgroup version 2
delegation.

The explicit `migrate-core-state` command migrates Core-state version 15 or
version 16 directly to the current version 17. It inspects the instance
configuration, acquires that instance's controller lock, and then claims the
same instance identity and configuration revision. While holding the lock, it
restores and validates both the source and proposed target with the claimed
failure limit, Media enablement, Media identifier namespace, Media limits, and
Core-state byte limit. Validation failure or a configuration revision change
therefore leaves the source unchanged and creates no backup.

A successful migration increments the Core-state revision exactly once. Its
version 17 digest covers `schemaVersion` as well as the rest of the document.
Before atomic replacement, migration writes an exact source-byte backup named
for the actual source version, `.v15.backup` or `.v16.backup`. A retry may reuse
that path only when it is a regular file whose bytes exactly match the
still-current source; a partial or different backup fails closed.

Earlier version 16 writers did not enforce the Claim and submission-record
invariant above at every mutation boundary: they permitted independent record
removal and later collection beside a terminal Claim. Version 15 has no Module
record collections. Version 17 therefore stores every migrated active Claim
without a matching submission record as an unknown submission history item. The
field
`activeClaimsWithUnknownSubmissionHistory` contains exactly the Claim's
`moduleJobId`, claim token (`claimToken`), `runId`, attempt number (`attempt`),
and `moduleGenerationId`. An item means Dolly cannot determine whether the
older writer never created a submission record or removed it independently; it
is neither a submission record nor proof that sending was never authorized.

`FileCoreStateStore` requires each item to match one exact active Claim, be
unique by `runId`, and not overlap a submission record. It rejects ordinary
submission creation, acknowledgement, negative acknowledgement, release, and
result-commit acknowledgement for that Claim without changing state. Startup
recovery also fails closed. Only a version 17 active Claim with neither a
submission record nor an exact unknown submission history item may be released
as `never-authorized-to-send`, and only after every old process is proven
stopped.

Dolly currently has no product-level operator command that records an audited
disposition and removes an unknown submission history item. Such a Claim remains
blocked after migration. The Linux service validation and other required
failure tests must still pass before Module activation. A later configuration
revision must pin the package and configuration revision of every unresolved
Run; package upgrades and process-record collection cannot alter or erase that
evidence.
