# Linux Core service process ownership experiment

Status: Preregistered; no implementation result yet

Protocol version: 3

Related decision: Architecture Decision Record (ADR) 0009,
`docs/adr/0009-linux-core-service-process-ownership.md`

Protocol version 3 was recorded before any run of version 2 produced a result.
It adds the storage-fault, restart-limit, revision-pinning, identifier-reuse,
durable capability-idempotency, and effect-declaration cases required by the
revised ADR 0009. No case from version 2 was removed.

## Contract question

Can the existing Dolly Core runtime, when systemd launches it as the main
process of one stable Linux service for an instance, directly own Module child
processes through a Core failure and restart without overlapping Module process
generations, losing a recoverable result, retrying an unknown outcome,
inheriting credentials, or leaving processes and control groups behind?

This experiment evaluates the Proposed design in ADR 0009. It cannot make that
ADR Accepted by itself; the implementation and conformance contracts must also
agree. The design does not add a process between Core and a Module: the existing
Core process owns `ModuleActor`,
`ExtensionProcessHost`, capability handlers, Claims, and result commits.

A **Module process record** is Core's durable description of one attempt to
start one existing Module process generation. It records the existing
`instanceId`, `moduleId`, `moduleGenerationId`, and `processGenerationId`; it
neither creates a job nor an execution identity. This record is necessary
because Core can exit after deciding to start the already identified generation
but before it can durably observe the child; the existing Run does not describe
that attempt to start the child.

A **Module submission record** is Core's durable statement that an existing Run
may have crossed the Extension protocol boundary. It refers to the existing
`moduleJobId`, `runId`, attempt, Delivery Claim, and process generation; it is
not another Run, job, or execution identity. This record is necessary because a
Core exit can otherwise leave the `module.execute` send outcome unknown; the
existing Run does not record whether that protocol boundary was crossed.

The existing **Delivery Claim** reserves the exact input Deliveries for the
existing Run. The existing result commit journal remains the sole durable source
for a received Extension result; neither new record is a second result store.

## Hypotheses

1. If Core exits at any registered interruption point, systemd removes every
   old Module process in the Core service control group tree before the restarted
   Core reconciles durable state or starts a replacement. Two Module process
   generations never overlap.
2. If the Core main process receives the Linux termination signal `SIGKILL`,
   which the process cannot catch, the service manager removes descendants in
   delegated Module control groups before the next Core invocation can accept
   Module work.
3. The Module process record and Module submission record distinguish an
   unstarted process, a possibly sent Run with unknown outcome, a stored result,
   and a terminal Core commit without inferring a more favorable state after a
   crash. They do not independently authorize acknowledgement, negative
   acknowledgement, retry, dead-lettering, or replacement.
4. A capability request active when Core exits cannot mutate Core after restart
   and cannot authorize automatic repetition unless the existing provider or
   storage record gives a durable outcome or idempotency proof.
5. Each Extension process receives only the declared minimal environment, and
   each required memory, process count, processor, open file, frame, and
   elapsed-time limit is enforced at the real operating system boundary.

Any counterexample rejects the corresponding hypothesis. A status value alone
does not count as evidence; process, control group, durable record, and output
state must agree.

## Baselines

The experiment compares the proposed design, in which Core is the main service
process, with two deliberately limited baselines:

- the current direct child `ExtensionProcessHost` outside a validated stable
  service, which is expected to prove cleanup only while its creating Core
  process remains alive; and
- the rejected transient systemd service for each process generation from ADR
  0008, used only in a deterministic delayed creation reproduction and never as
  a proposed fallback.

The baselines use the same child fixture, deadlines, result payloads, and fault
injection points. A baseline is not weakened to make the proposal look better.

## Environments

The full matrix runs in a disposable Linux virtual machine or container with:

- a pinned kernel and systemd version;
- control group version 2 and explicit delegation;
- a fresh service account and empty Dolly state directory;
- permission to restart the service manager, end login sessions, and reboot;
  and
- no provider, object storage, owner credential, private endpoint, or paid
  application programming interface.

The authorized University of Science and Technology of China (USTC) server may
run only non-disruptive cases at service scope. It must not be used for user
manager termination, login termination, reboot, privilege, or hostile resource
tests.

## Fixed interruption matrix

For each case, the harness terminates Core immediately before and after these
durable boundaries. A Core termination must exercise the actual stable service
restart path rather than a test process that merely resembles it.

1. service configuration validation for Core and Core readiness;
2. Module process record creation;
3. delegated control group creation and limit application;
4. Extension process creation and readiness;
5. Delivery Claim persistence;
6. Module submission record persistence;
7. `module.execute` protocol send;
8. each capability request start and completion;
9. Extension result receipt persistence;
10. Core result commit preparation;
11. Block commit;
12. every output Delivery append;
13. positive acknowledgement; and
14. Module process record closure and collection.

Each interruption runs at least once with no output, one output, multiple output
Pages, a processor loop, a process descendant, an active capability handler,
and a result whose external effect outcome is unknown. Scheduling is
deterministic; a barrier confirms the exact interruption point before
termination.

Separate cases cover:

- attempted Module startup outside a validated Core service;
- a service whose effective restart, kill, delegation, timeout, or environment
  configuration differs from the required configuration;
- Core service restart, user manager restart, login end with and without
  lingering, and machine reboot;
- exhaustion of the finite service restart limit, which must leave the service
  visibly failed with Modules disabled instead of restarting indefinitely;
- process identifier reuse pressure without ever signaling by a recovered
  process identifier;
- attempted reuse of a process-generation identifier or Module control group
  path;
- a package or configuration upgrade while a process record, submission
  record, or Run remains unresolved, proving the pinned revisions are
  unchanged;
- Core-state write, file synchronization, atomic replacement, and parent
  directory synchronization faults injected at each boundary, recovering only
  a complete old or complete new Claim/process/submission view;
- capability effect-intent and idempotency evidence across a Core crash,
  rejecting an in-memory duplicate map as restart evidence;
- refusal to automatically activate a Module whose configuration does not
  declare that its external effects pass only through durable Core
  capabilities;
- executable paths containing spaces and `${...}`;
- inherited environment sentinel values;
- unavailable systemd, delegation, control group controller, state store, and
  Extension protocol channel; and
- attempts by an untrusted sandbox fixture to change or leave its control
  group, change its limits, signal Core, open Core state or service-manager
  control files, read another process's state through the process filesystem
  (`/proc`), or use a retained inherited descriptor.

## Required outcomes

Every case for the proposed design must satisfy all of these strict invariants:

- maximum concurrent live process generations for one Module: one;
- output Blocks or Deliveries committed more than once: zero;
- an unknown Extension or capability outcome automatically retried: zero;
- a Module started outside the validated Core service: zero;
- a Module automatically activated without the declared Core-capability-only
  external-effect configuration: zero;
- a replacement started before proof that the old process control group is
  empty: zero;
- a signal sent using only a recovered process identifier: zero;
- a Core recovery that starts Module work before reconciling the Claim,
  submission record, and result commit journal: zero;
- undeclared environment values observed by the Extension: zero;
- limit bypasses in the selected isolation mode: zero;
- unreconciled strong references or access leases after terminal cleanup: zero;
  and
- test services, processes, sockets, control groups, or temporary records left
  after harness cleanup: zero.

The report also records recovery duration and processor, memory, and storage
overhead, but no performance improvement can compensate for an invariant
failure.

## Artifacts

Every run retains:

- a manifest with source revision, whether the worktree is dirty, operating
  system and systemd versions, effective service configuration, configuration
  digest, seed, and ordered case list;
- timestamped Core, Extension, service manager, capability handler, and fault
  injector events with secrets and user content removed;
- durable Core, Module process, Module submission, Claim, result, reference,
  and control group snapshots at each barrier;
- exact child process and control group membership observations;
- exit status, timeout, cleanup result, and invariant evaluation for each case;
  and
- a machine-readable summary that includes failed and inconclusive cases.

A missing artifact makes the case inconclusive, not passing.

## Iteration and stopping rule

The first failure stops architectural promotion but does not stop diagnosis.
The implementation or ADR must be revised, a new protocol version recorded, and
the complete fixed matrix rerun. Cases are never deleted because they expose a
failure. New cases discovered during diagnosis join the next preregistered
version; they are not reported as if they belonged to the earlier untouched
evaluation set.

The experiment ends only when the complete matrix passes from two independently
created clean environments for each supported Linux service mode. Cases with
delayed sends or process exit races also run 100 times across ten fixed seeds in
each environment. An independent review must find no missing interruption
boundary. Neutral, failed, and inconclusive iterations remain in the report
history.

## Safety and cleanup

All child commands are fixed local fixtures with finite deadlines. Temporary
service names use a reserved test prefix and are enumerated before and after the
run. Cleanup stops only exact test service names created by the manifest and
verifies that their control groups contain no processes before removing test
state. The harness never removes an arbitrary path, service, process, or control
group discovered from untrusted output.
