# Architecture Decision Record 0007: Crash-recoverable synchronous cross-process locks

Status: Proposed

Date: 2026-07-25

## Context

`InstanceConfigStore`, `FileCoreStateStore`, and
`FileModuleResultCommitRepository` expose synchronous mutations. Their original
`open(..., "wx")` marker files were
removed only by a normal `finally` path, so process termination could leave an
empty file that rejected every later writer indefinitely.

An elapsed-time rule cannot prove that a lock owner is dead. Checking only a
process identifier (PID) is also insufficient because operating systems reuse
PIDs, and Node core does not expose one
portable synchronous advisory file-lock API for both Linux and Windows.

## Proposed decision

Node's socket and pipe APIs are asynchronous, while these three store APIs are
synchronous. Therefore, one unreferenced Node.js Worker thread per Dolly process
performs the asynchronous bind and close calls and keeps each acquired address
bound. The rest of this document calls it the **lock helper thread**. It does
not route application data or add another application service.

- Linux uses abstract Unix-domain socket addresses. Windows uses named-pipe
  addresses. The operating system permits only one listener at an address, so a
  successfully bound address acts as the cross-process lock.
- An address contains a SHA-256 (Secure Hash Algorithm with 256-bit output)
  digest of the normalized absolute path for the protected file. Windows paths
  are compared without letter case. State-directory paths are never exposed in
  the address or lock errors.
- The calling thread sends acquire/release requests and waits through
  `SharedArrayBuffer`/`Atomics`. The repository operation itself must be short,
  fully synchronous, and must not return a Promise.
- A live bound address means `LOCKED`. The address disappears when its process is
  forcibly terminated, so a successor can acquire it without inspecting a PID,
  timestamp, or marker-file age.
- A lock helper response timeout never authorizes takeover. It terminates and
  permanently disables that process's helper thread; subsequent writes are
  rejected until the process restarts.
- Legacy `*.lock` files are not ownership evidence and are ignored. An upgrade
  must first stop every older Dolly process that still implements marker-file
  locking. Running old and new lock protocols against the same state directory
  is unsupported because neither protocol can observe the other's live owner.
- Unsupported platforms fail explicitly. There is no marker-file fallback.

## Security limits and independent failures

The bound addresses provide cooperative exclusion between local Dolly
processes. They are not authenticated inter-process communication and do not
establish a cross-user authorization boundary. Linux abstract socket names and
Windows pipe names do not by themselves satisfy peer-identity or access-control
list requirements for public inter-process communication.

The lock helper and the calling thread can fail independently. Whole-process
termination releases both correctly. An isolated helper-thread or native-runtime
failure could release the address while the calling thread is inside a
synchronous operation that has not returned control to the event loop. The
mandatory release check detects the
failure before a successful return and disables further writes, but it cannot
retroactively close that small overlap window. Strict operation ordering still
relies on the normal deployment running one Dolly controller process. Here,
**controller** means the process that schedules work and commits repository
updates. Some repositories add a second check by writing only when the stored
revision still equals the expected revision. The cross-process lock
also protects independent configuration commands and accidental concurrent
store opens.

## Consequences

Normal lock acquisition no longer writes, unlinks, or ages a filesystem marker.
Crash recovery is immediate and does not depend on wall time. Reusing one lock
helper avoids spawning a process or helper thread for every durable mutation, at the
cost of a small synchronous cross-thread round-trip.

## Required tests

- a live child process excludes a competing writer;
- forcibly terminating that child permits immediate successor acquisition;
- each of the three durable stores maps live contention to its stable
  public error and succeeds immediately after owner termination;
- old marker-file residue does not cause permanent denial of service;
- acquisition/release lock helper failures disable further use rather than
  steal ownership; and
- Linux and Windows run the forced-termination suite without timeout-based lock
  reclamation.
