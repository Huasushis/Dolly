# Architecture Decision Record 0002: Independent Extension trust and isolation

Status: Proposed

Date: 2026-07-24

## Context

Dolly is intended to support a public Extension ecosystem. In-process dynamic
imports give an Extension all process memory, credentials, filesystem access,
and the ability to block every Module. TypeScript interfaces do not form a security
boundary.

## Proposed decision

- Trust and isolation are separate decisions. `ExtensionTrust` records the
  deployment's binary judgment about the code that will run: `trusted` or
  `untrusted`. Whether code is built in, reviewed, or approved explains that
  judgment for auditing; those reasons are not additional runtime trust levels.
  `ExtensionIsolation` records the runtime boundary actually enforced: `none`,
  `process`, or `sandbox`.
- `none` has the host process's full authority and no hard failure boundary.
  `process` uses a separate operating-system process and the versioned
  JavaScript Object Notation (JSON) process protocol. It can scrub inherited
  environment state, but a direct child alone does not prove containment of
  descendants, hard termination, or central processing unit (CPU) hang
  recovery. `sandbox` additionally uses a tested platform sandbox to deny
  ambient filesystem, network, and subprocess permissions.
- Code classified as `untrusted` may run only with `sandbox`
  isolation. If no passing sandbox backend is available, Dolly refuses to run
  it. Trust is never inferred from package name, location, signature alone, or
  prior success.
- `ExtensionProcessHost` starts and supervises an Extension over the process
  protocol. It is used only for `process` or `sandbox` isolation. The current
  ordinary child-process launcher enforces only `process`; a passing backend
  descriptor alone cannot make that launcher a sandbox. `sandbox` requires a
  backend that controls and verifies the actual launch.
- The initial `process` and `sandbox` implementations run one Module per
  process. For executable Modules, Architecture Decision Record (ADR) 0009
  supersedes the generic isolation label on Linux: `none` is forbidden and a
  platform execution backend must prove that the entire assigned process group
  has stopped before any replacement. A direct Node.js child process is not that
  backend. Sharing a process between Modules requires a later accepted amendment
  that fences results from every stopped generation, revokes permissions, and
  applies the durable submission and external-effect evidence rules before it
  classifies any Claim. Process death alone never authorizes negative
  acknowledgement, release, retry, or recreation.
- Extensions receive explicit capability handles for Pages, Media, provider
  calls, tools, storage, logging, clock, and approved network operations. They do
  not receive raw global configuration or secrets. A Media handle must be derived
  from an exact Media reference in a Block already delivered to the authenticated
  Module job; a raw `mediaId` is not a handle or permission. The current process
  host has not yet wired this Media capability, so it must deny direct Media
  access rather than claim that the capability exists.
- Provider and storage requests are executed by trusted host services that enforce
  endpoint, model, operation, size, time, and budget policy.
- Every message carries the negotiated Extension process session identifier. Module
  execution messages additionally carry the stable Module identity `moduleId`,
  current initialization generation `moduleGenerationId`, stable Module job
  identity `moduleJobId`, fresh `runId`, deadline,
  and cancellation scope; capability
  calls carry their opaque handle and applicable run. Messages are
  schema-validated and size-bounded.
- CPU, memory, time, and output quotas and hard termination are part of the host
  contract. A terminated host cannot report against a newer generation.
- `process` and `sandbox` use the same Extension process protocol. `none`
  uses an in-process interface and cannot claim process isolation. Diagnostics
  MUST expose trust, isolation, and each enforced guarantee independently.

## Migration

Extension process protocol `3.0` replaces the version 2 `processingId` field
with `moduleJobId`; it is a major-version change, not a compatibility alias. A
version 3 host rejects a manifest or wire message that supports only version 2
or earlier and does not translate the field during an active session.

Version 2 previously removed the combined `profile` field and its old
`trusted-in-process`, `fault-isolated`, and `sandboxed-untrusted` values. Those
removed values did not map mechanically because the old field combined trust
and isolation. Version 2 also replaced `moduleInstanceId` with `moduleId`.
Those version 1 fields remain rejected by version 3.

## Consequences

Serialization and process startup add cost. `process` makes a separate failure
domain possible but does not itself make descendant containment or hard timeout
enforceable; the executable Module backend must prove those properties on each
supported platform. A conforming `sandbox` additionally makes permission denial
enforceable. Compatibility negotiation and resource accounting apply to both.
Existing Extensions require migration to protocol `3.0`.

## Required conformance evidence

Portable Extension process protocol tests must prove the trust/isolation policy matrix,
reject protocol `2.x` and earlier, verify the `isolation`, `moduleId`, and
`moduleJobId` wire fields, and
use malicious or faulty fixtures that attempt forged identity, oversized
messages, stale-generation reports, CPU loops, and use of revoked capabilities.
Media capability tests must additionally reject guessed identifiers,
cross-session or cross-Module handles, undelivered Blocks, and broadened crops
while permitting the exact delivered reference.
Module actor tests must prove that hard termination depends on the executor's
`terminate` operation rather than an isolation label.

For the Linux Module runner, the ADR 0009 tests additionally must prove
whole-cgroup termination, an empty cgroup before replacement, durable
submission/effect handling after a lost response, and refusal to use a PID or a
direct child exit as restart evidence.

Each `sandbox` backend must also pass real operating-system integration tests
for secret, path, network, subprocess, memory, CPU, and handle escape. A fake
host or a backend descriptor cannot establish sandbox conformance.
