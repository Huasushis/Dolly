# Architecture Decision Record 0008: Linux Extension processes as transient systemd user services

Status: Rejected

Date: 2026-07-26

## Context

`ExtensionProcessHost` can confirm that its direct child exited while the same
Core controller remains alive. It cannot provide the same evidence after the
controller exits unexpectedly. On Linux, a normal child may outlive its parent,
and a process identifier (PID) may later refer to another process. Persisting a
PID therefore cannot authorize a new controller to send a signal or start a
replacement Module generation.

Here, **controller** means the Core process that schedules Module work and
commits state. A **transient systemd user service** is a service created at run
time in the current operating-system user's systemd service manager rather than
installed as a permanent unit file. systemd assigns each service invocation an
`InvocationID` and places its processes in a Linux control group (cgroup). The
service manager remains able to query and stop that service after the controller
that requested it has exited.

A **process record** is the durable description of one attempt to start one
Module in another process. Dolly needs this project-specific record because an
in-memory child-process object is lost when the controller exits, while a PID
alone may later identify an unrelated process.

## Reasons For Rejection

This design was rejected before implementation:

1. Persisting a `starting` record does not prove that the request to create the
   service has completed. An old `systemd-run` process may be paused before it
   asks systemd to create the service. A successor controller can then observe
   `not-found`, start a replacement, and later see the old request create a
   second service. Absence is not final while an earlier creation request can
   still arrive.
2. systemd stops a service by unit name; its stop operation has no
   `InvocationID` precondition. Querying `InvocationID` and then stopping by name
   is a check-then-act race. A different invocation under the same name could be
   stopped after the check.
3. `systemd-run --pipe` passes the caller's existing standard streams to the
   service. Those anonymous pipes cannot be reopened by a successor controller.
   The current security specification requires either an authenticated
   reconnectable channel or child exit after the inherited channel closes. This
   design satisfies neither rule as written.
4. Unit inactivity and `MainPID=0` do not prove that the control group is empty,
   that pending initialization cannot reopen resources, or that capability
   handlers have finished. Those additional facts are required before a Module
   executor may report confirmed termination.
5. A systemd user service normally inherits the user service manager's
   environment. Starting `systemd-run` with an empty client environment does not
   prevent the service from receiving imported credentials or proxy settings.
6. `systemd-run` expands environment-variable syntax in arguments by default.
   The rejected command did not disable that behavior, so a valid installed path
   containing `${...}` could be changed before execution.
7. The design set a finite timeout only after a stop request. It did not set a
   finite service lifetime, so a central processing unit loop could continue
   indefinitely when no successor controller arrived.
8. A running systemd user manager during startup does not prove that it remains
   available after the last login session ends or after the manager restarts.
   The tested server session did not cover either event.
9. The current Module configuration has byte, count, generation, and time
   limits, but no finite resident-memory, process-count, or open-file limits.
   The design therefore could not meet the resource-control contract.
10. The current Core state does not atomically record Module generation, process
    creation, protocol submission, Delivery Claim state, and result acceptance.
    Process cleanup alone cannot decide whether an interrupted Module job may be
    retried.

## Rejected Proposal

The remainder of this section records the design that was reviewed. Its
requirements are not part of Dolly's active contract.

If the blocking issues are resolved, the Linux process launcher used by normal
runtime startup will run one Module generation as one transient systemd user
service. Direct child-process launch remains useful for portable protocol tests
and local development, but it does not satisfy recovery after controller exit
and MUST NOT enable configured Modules in normal runtime startup.

This decision does not make `process` isolation a security sandbox. A trusted
Extension still has ambient filesystem, network, and subprocess permissions.
Untrusted Extensions continue to require a separately tested `sandbox`
implementation.

### Service Name And Process Record

Before service creation, Core MUST:

1. generate the existing process generation identifier, `processGenerationId`,
   with at least 128 bits from a cryptographically secure random generator;
2. derive a systemd unit name from the full Secure Hash Algorithm with 256-bit
   output (SHA-256) digest of the canonical JavaScript Object Notation (JSON)
   array `[instanceId, moduleId, processGenerationId]`, encoded with 8-bit
   Unicode Transformation Format (UTF-8); and
3. atomically persist a process record before asking systemd to create the
   service.

The process generation identifier names exactly one attempt to launch an
Extension process. It connects host callbacks and persisted state to that
attempt; a PID is insufficient because the operating system may reuse it.

The unit name has the form
`dolly-extension-<64 lowercase hexadecimal digits>.service`. The unit name is
an operating-system lookup key, not a credential, Extension identifier, or
Module identifier. Dolly MUST never deliberately reuse a process generation
identifier. A live unit-name collision is a startup failure, not permission to
replace the existing service.

The persisted process record MUST contain at least:

- instance, Module, Module generation, and process generation identifiers;
- unit name and, after service creation, the exact systemd `InvocationID`;
- Extension and package versions, Module kind, configuration version, and
  configuration revision;
- negotiated Extension process protocol version and session identifier after
  authenticated readiness;
- lifecycle state: `starting`, `running`, `stopping`, or `stopped`; and
- bounded timestamps and a sanitized failure code where applicable.

`starting` means the record is durable but service creation and Extension
readiness are not both confirmed. `running` means the systemd unit identity and
Extension readiness response have both been verified. `stopping` records stop
intent before the request is sent. `stopped` means systemd has confirmed that
the unit is inactive or absent.

The record MUST NOT contain credentials, capability handles, raw configuration
secrets, signed uniform resource locators (URLs), or arbitrary executable paths
supplied by instance configuration.
The installation registry remains the authority for the executable path.

The record is persisted before service creation to close the interruption window in
which systemd has accepted the service but Core has not recorded its name. After
creation and before Module readiness, Core queries and persists the non-empty
`InvocationID`. Dolly itself never reuses a unit name, so a `starting` record can
still identify the exact name submitted during that window. Once an
`InvocationID` is present, every later query or stop MUST match both the unit
name and `InvocationID`. A mismatch is an identity failure: Core MUST NOT send a
signal or create a replacement Module generation.

### Launch And Termination

The launcher MUST invoke `systemd-run` and `systemctl` directly with argument
arrays; it MUST NOT construct a shell command. The user service runs an absolute
program that clears the inherited service-manager environment before it starts
the absolute Node.js executable and installed Extension entrypoint. The
Extension process protocol uses standard input and standard output. Status text
from `systemd-run` MUST be disabled so it cannot corrupt the length-framed JSON
stream.

The service MUST disable automatic restart and use `KillMode=control-group`, a
finite stop timeout, and forced termination after that timeout. The launcher
MUST verify that the unit is active, has a non-empty `InvocationID`, and has a
non-empty cgroup before accepting the Extension's authenticated readiness
response. A PID is diagnostic data only.

Normal termination requests the exact unit to stop and waits for systemd to
report it inactive with no remaining main process. A collected unit reported as
`not-found` is also stopped, because its never-reused unit name no longer exists
in that user's service manager. A query error, user-manager outage, identity
mismatch, or bounded wait timeout leaves termination unconfirmed.

The launcher MUST give `ExtensionProcessHost` the service's standard input,
standard output, bounded standard error, exit notification, diagnostic PID, and
an operation that stops the verified service. `ExtensionProcessHost` MUST NOT
call `kill()` on the `systemd-run` client PID as a substitute for stopping the
service. The service unit and `InvocationID`, not the client process, identify
the Extension process after launch.

### Controller Restart

After acquiring the instance controller lock and before starting any Module, a
new controller reads every process record not marked `stopped` and queries the
exact unit name.

- If the unit is absent or inactive, Core records confirmed exit.
- If the unit is active and its recorded identity matches, Core stops it and
  waits for confirmed inactivity before proceeding.
- If a `starting` record has no saved `InvocationID`, its never-reused unit name
  is the only expected identity during the documented creation interruption
  window. Core may stop that exact unit but MUST NOT treat it as ready or resume
  its protocol session.
- If a saved `InvocationID` does not match, or systemd cannot be queried, Core
  leaves the record unresolved and refuses to start that Module or a replacement
  process.

Confirmed service exit is necessary but not sufficient to retry an active
Delivery Claim. Core still needs durable Module-submission and result-commit
evidence before deciding whether execution or an external effect occurred.

### Platform Availability

This launcher requires Linux, cgroup v2, a running systemd user manager, and the
required `systemd-run` and `systemctl` behavior. Startup MUST test these
conditions, including whether the selected service manager remains available
for the intended deployment. There is no direct-child fallback for configured
Module execution when they are absent.

Windows requires a separate design based on an operating-system process group
such as a Job Object. This ADR makes no Windows process-recovery claim.

## What Remains True

A PID alone is not enough to identify a process after controller exit, and the
current direct-child implementation cannot support that recovery. systemd may
still be part of a later Linux design, but unit queries and transient services
do not by themselves provide the required creation and termination guarantees.

A trusted Extension can also move work outside its original service cgroup.
Preventing that behavior belongs to the `sandbox` contract, not ordinary
`process` isolation.

No production code implements this proposal yet. In particular, the current
`ExtensionProcessHost` directly creates a child process and must not be described
as systemd-managed or recoverable after controller exit.

## Requirements For A Replacement Design

- standard input and output preserve exact binary frames with no wrapper text;
- a sentinel secret present in the systemd user manager is absent from the
  Extension process while the explicitly required minimal environment remains;
- pausing a service-creation request, killing its controller, and starting a
  successor can never create overlapping Extension processes;
- stopping a process cannot affect another invocation inserted between identity
  verification and the stop operation;
- a controller killed before and after readiness either causes channel-driven
  child exit or leaves a process that can be authenticated through a
  reconnectable channel;
- crashes before record creation, service creation, `InvocationID` persistence,
  readiness, execution, result preparation, and record cleanup recover without
  process overlap;
- a central processing unit (CPU) loop and normal descendants are removed by
  `KillMode=control-group` before a replacement starts;
- unavailable systemd, unavailable cgroup v2, query failure, and stop timeout
  all fail closed;
- configured memory, process-count, open-file, and time limits are enforced by
  the real service and rejected when the platform cannot enforce them;
- package paths containing spaces or `${...}` are passed unchanged without a
  shell or environment-variable expansion;
- the portable direct-child tests remain valid but cannot prove recovery after
  controller exit; and
- Linux release tests run on a fresh user service manager and leave no Dolly
  test units behind.
