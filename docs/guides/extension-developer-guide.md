# Extension Developer Guide

Status: Draft

This guide explains how to write a Dolly Extension: the package manifest, the
process protocol, the capability model, configuration and migration, error
reporting, and what a conforming Extension has to prove about itself.

It is a companion to the normative contract in
[the Extension process protocol](../spec/extension-process-protocol.md). Where
this guide and that specification differ, the specification is authoritative.
Read [the concepts guide](concepts.md) first if the words Block, Page, Delivery,
Module, and Module job are not already familiar.

## Read this before you start

**Dolly cannot run your Extension yet.** A configured Module is refused at
instance startup, so nothing described below is reachable from a running Dolly
today. There is also no `dolly extension` command: the command-line interface
rejects it with `CLI_FEATURE_UNAVAILABLE`.

What does exist is the host side of the boundary — package installation, the
process protocol, session identity, and capability scope enforcement — exercised
by conformance tests that start real child processes. So the protocol below is a
description of working code, not a sketch, but it is reached from tests rather
than from a running instance.

Every section below marks its subject as one of:

- **Implemented** — code exists and conformance tests exercise it.
- **Contract only** — specified and agreed, no implementation.

The specification is a Draft, which means an implementation must not claim
conformance to it yet and the wire details can still change. Write against it if
you want to be ready or to help shape it; do not ship a product on it.

For where this sits in the wider plan, see workstream 3 in
[the project roadmap](../takeover/project-roadmap.md).

## What an Extension is

An **Extension** is a separately packaged program that adds functionality to
Dolly. A **Module** is one configured instance of an Extension inside one Dolly
instance. One Extension can back many Modules with different configuration and
different connections.

Three properties define the boundary and explain most of the rules that follow.

**It is a process protocol, not a plugin interface.** Your Extension runs as its
own operating-system process and exchanges framed JSON messages with Dolly. It
does not link against Dolly binaries, import Dolly modules, or share a calling
convention. `dolly/sdk` exports read-only content types for convenience; it is
not the boundary and does not promise a stable in-process interface.

**Your code is untrusted by default.** The host assumes an Extension may be
malicious, compromised, or simply broken. It assumes you might try to read host
secrets, open network listeners, forge identifiers, exhaust resources, send
malformed messages, ignore cancellation, or hang during shutdown. None of this is
about your intentions; it is what the boundary has to withstand for anyone's
Extension to be safe to install.

**It must be portable.** A conforming Extension must not require a particular
model provider, relay, object store, or credential. Endpoints and models are
configuration a deployment supplies, and every automated test for your Extension
must pass with local or fake substitutes. Never embed a credential, private
endpoint, or host path in source, examples, or test snapshots.

## Trust and isolation

Two independent values, both visible in configuration and diagnostics.

**Trust** says whether the deployment trusts the code. It has exactly two values,
`trusted` and `untrusted`. Whether code shipped with Dolly, was reviewed, or was
picked by an operator may explain a decision, but none of those are extra trust
levels.

**Isolation** says what runtime boundary is actually enforced:

- `none` — no boundary at all. Extension code has the host process's authority.
- `process` — a separate operating-system process. It separates crashes and
  scrubs inherited environment state. It does **not** deny ambient filesystem,
  network, or subprocess access, and a direct child alone does not prove that
  descendants were contained or that a hung process can be stopped.
- `sandbox` — a tested platform sandbox plus host-side capability checks that
  deny undeclared filesystem, network, subprocess, secret, and resource access.

The rules connecting them:

- An `untrusted` Extension must use `sandbox`. A worker thread or an ordinary
  child process is not enough.
- On a platform with no passing sandbox backend the host refuses to run untrusted
  code. It never quietly downgrades to `process`.
- Trust is never inferred from a name, an install path, a signature alone, or the
  fact that previous runs went fine.

**No sandbox backend currently passes its tests on any platform, so untrusted
Extensions are refused everywhere today.**

## Package layout and manifest

**Implemented.**

An Extension package is an ordinary Node.js package with one extra file,
`dolly-extension.json`, at its root. The standard `package.json` cannot express
Dolly's protocol versions, Module kinds, or configuration schemas, so the
manifest is separate.

```text
my-extension/
  dolly-extension.json
  package.json
  dist/
    main.mjs
```

A complete minimal manifest:

```json
{
  "schemaVersion": "dolly.extension-package/1",
  "extensionId": "com.example.uppercase",
  "packageVersion": "1.0.0",
  "displayName": "Uppercase",
  "description": "Rewrites incoming text items in uppercase.",
  "supportedProtocolVersions": ["3.0"],
  "entrypoint": "dist/main.mjs",
  "modules": [
    {
      "moduleKind": "uppercase",
      "activation": "reactive",
      "configVersion": 1,
      "configurationSchema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "locale": { "type": "string", "minLength": 2 }
        }
      }
    }
  ],
  "requestedCapabilities": []
}
```

Field by field:

- `schemaVersion` must be exactly `dolly.extension-package/1`.
- `extensionId` names the package. Identifiers use a restricted ASCII syntax.
- `packageVersion` is an **opaque** identifier compared exactly. The installer
  does not parse it or apply semantic-version precedence, so `1.10.0` is not
  "after" `1.9.0` as far as Dolly is concerned — it is simply a different string.
- `displayName` and `description` are for operators.
- `supportedProtocolVersions` is a non-empty exact list of between 1 and 32
  unique values. Ranges are never inferred: to support two versions, list both.
- `entrypoint` is a normalized **relative** POSIX path ending in `.mjs`, naming
  one ordinary file. The manifest cannot supply a command, arguments, working
  directory, environment variables, or an absolute path. Dolly decides how the
  process is started.
- `modules` declares each Module kind. Each `moduleKind` is unique in the
  package. In this package schema version `activation` must be `"reactive"`.
- `configurationSchema` must be a valid JSON Schema Draft 2020-12 document, and
  `configVersion` is the version it validates.
- `requestedCapabilities` **must be empty** in package schema version 1.

That last one is worth stating plainly: in this version a package cannot request
capabilities, register payload schemas or renderers, declare configuration
migrations, or carry a signature. Each of those needs a later package schema with
its own security review and conformance tests. A valid signature, when it exists,
will establish who published a package — it will not grant capabilities or trust.

### What installation does

**Implemented.**

Installation recursively copies only ordinary files under finite file-count and
byte limits. It rejects symbolic links, reparse points, path escapes, case-folding
collisions, unknown or malformed manifest fields, invalid configuration schemas,
and an entrypoint that is not among the copied files. Resolution re-checks the
manifest, file list, content digests, paths, and private file permissions before
it hands back an entrypoint.

Two practical consequences: your package must be self-contained under its own
directory, and it must not rely on symlinked dependencies or on files it expects
to find outside the copied tree.

## The process protocol

**Implemented** for everything in this section unless a subsection says
otherwise. The current protocol version is `3.0`.

### Transport and framing

Dolly starts your entrypoint as a child process with an **empty environment** and
three pipes:

| Descriptor | Use |
| --- | --- |
| 0 (standard input) | Host to Extension messages |
| 1 (standard output) | Extension to host messages |
| 2 (standard error) | Bounded plain-text diagnostics, collected as local logs |

Do not write anything to descriptor 1 except protocol frames — a stray
`console.log` corrupts the stream and terminates the session.

Each message is one frame: a **4-byte big-endian unsigned length** followed by
that many bytes of UTF-8 JSON.

```text
+--------+--------+--------+--------+----------------------------+
|            length (uint32be)      |  UTF-8 JSON payload        |
+--------+--------+--------+--------+----------------------------+
```

A newline is not a frame boundary. The host enforces a maximum frame size before
parsing and rejects invalid JSON, an invalid JSON-RPC version, batch arrays, and
duplicate keys in security-sensitive envelopes. Enough protocol violations
terminate and quarantine the process.

Messages are JSON-RPC 2.0. Request identifiers must be **strings**, unique among
the sender's outstanding requests, and not reused until the original request has
finished. Every value crossing the boundary must be JSON-compatible. Binary data
must go through a bounded blob or Media capability, never as unbounded base64 in
routine messages.

Everything portable you need arrives through the protocol. The working directory,
host paths, home directory, and deployment layout are host implementation details
and are not part of the boundary. Do not read configuration from the environment
or from a path you construct yourself.

### Handshake

`dolly.initialize` is the first request of an operational session. The host
sends:

```json
{
  "jsonrpc": "2.0",
  "id": "host-1",
  "method": "dolly.initialize",
  "params": {
    "protocolVersion": "3.0",
    "sessionId": "session-1",
    "extensionId": "com.example.uppercase",
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "processGenerationId": "pg-1",
    "isolation": "process",
    "guarantees": {
      "crashContained": true,
      "cpuHangContained": true,
      "inheritedEnvironmentScrubbed": true,
      "ambientFilesystemDenied": false,
      "ambientNetworkDenied": false,
      "ambientSubprocessDenied": false,
      "hardMemoryLimit": false
    },
    "config": { "locale": "en" },
    "limits": { "maxFrameBytes": 262144, "maxConcurrentCapabilityRequests": 8 },
    "capabilities": []
  }
}
```

`guarantees` reports what the enforced boundary actually provides, so an
Extension can observe honestly that, for example, its process is crash-contained
but its filesystem access is not denied. `config` is your validated, non-secret
configuration. `capabilities` lists the granted capability descriptors, each with
a `capabilityType`, `capabilityVersion`, an `operations` list, and an opaque
`handle`.

The `limits` values above are the current host defaults, not constants. Read them
from the handshake rather than hardcoding them; a deployment may configure lower
ones, and an individual Run may be tighter still.

The `guarantees` values above are the ones the host reports for `process`
isolation today. Read them the same way — they are an honest report of one
deployment's boundary, not a fixed table. In particular, do not read
`cpuHangContained: true` as a promise that every descendant of your process can
be stopped: that stronger property is what the Linux control-group work in
Architecture Decision Record 0009 is for, and it is still `Proposed`.

Your reply must be an object with exactly these keys, echoing the host's values:

```json
{
  "protocolVersion": "3.0",
  "sessionId": "session-1",
  "extensionId": "com.example.uppercase",
  "packageVersion": "1.0.0",
  "moduleKinds": ["uppercase"]
}
```

Any mismatch aborts initialization: `protocolVersion` and `sessionId` must equal
what the host sent, and `extensionId`, `packageVersion`, and `moduleKinds` must
equal what your installed manifest declared. There is no renegotiation after
initialization. A process restart is a new session, and every handle from the
previous session is dead.

### Lifecycle methods

Host to Extension requests:

| Method | Purpose |
| --- | --- |
| `dolly.initialize` | Start the session. Always first. |
| `module.create` | Create the one Module for this session. |
| `module.execute` | Run one Module action over one input batch. |
| `module.stop` | Stop the Module. Must be idempotent. |
| `dolly.shutdown` | End the session. Must be idempotent. |

Host to Extension notifications:

| Notification | Purpose | State |
| --- | --- | --- |
| `dolly.cancel` | Cancel an outstanding request, with a reason | Implemented |
| `capability.revoked` | A handle is no longer valid | Contract only |

The current host never sends `capability.revoked`. Handle revocation happens, but
it is observed through a denied invocation rather than through a notification.

The host states are:

```text
created -> starting -> ready
ready -> executing -> ready
created/starting/ready/executing/failed -> stopping -> stopped
starting/ready/executing -> failed
```

`module.create` confirms the stable `moduleId` and the current
`moduleGenerationId` for the session. Its reply has exactly the keys
`protocolVersion`, `sessionId`, `moduleId`, and `moduleGenerationId`, echoing the
request. `module.stop` and `dolly.shutdown` reply with `protocolVersion`,
`sessionId`, and `stopped: true`.

**One session hosts exactly one Module.** That is why there is no second Module
handle: forcibly terminating the process can only ever affect one Module. Sharing
one process between Modules is a possible future capability, and it would first
have to prove that process death atomically rejects results from every sibling's
old generation and revokes its capabilities.

### Module input and result

`module.execute` carries the Core runtime's identifiers and the input batch:

```json
{
  "protocolVersion": "3.0",
  "sessionId": "session-1",
  "moduleId": "uppercase-1",
  "moduleGenerationId": "mg-1",
  "moduleJobId": "job-1",
  "runId": "run-1",
  "attempt": 1,
  "deadline": "2026-07-26T12:00:30.000Z",
  "hasMore": false,
  "input": {
    "schemaVersion": "dolly.reactive-module-input/2",
    "claimedDeliveryIds": ["delivery-9", "delivery-12"],
    "blockGroups": [
      {
        "block": { "...": "one immutable Block" },
        "deliveryIds": ["delivery-9", "delivery-12"],
        "occurrenceCount": 2,
        "firstGlobalSequence": "1204",
        "lastGlobalSequence": "1209"
      }
    ],
    "hasMore": false
  }
}
```

`hasMore` tells you the claim limits truncated the pending input; the remainder
comes in a later action. `deadline` is an ISO 8601 timestamp.

Your reply must contain exactly `protocolVersion`, `sessionId`, `moduleId`,
`moduleGenerationId`, `runId`, and `result`, and every echoed identifier must
match the request — a reply carrying a stale `runId` is rejected as a protocol
violation rather than being attributed to the current action.

`result` is one atomic Module result with **either no Block proposal or exactly
one**:

```json
{
  "schemaVersion": "dolly.module-result/1",
  "blockProposal": {
    "payload": {
      "schema": "dolly.content/1",
      "value": { "items": [{ "type": "text", "text": "HELLO", "format": "plain" }] }
    }
  }
}
```

Omit `blockProposal` entirely when the action has nothing to publish. Do not send
an empty content value; `items` must be non-empty and every text value must be
non-empty.

A proposal never contains core identity, `source`, `sequence`, delivery metadata,
local paths, or credentials. The runtime assigns those, and it authenticates
`source` as the Module that owns the Claim — you cannot attribute a Block to
anyone else.

Three result restrictions catch people out:

- An output `block-reference` may name only a Block **delivered directly in this
  action's batch**. A Block that one of your input Blocks merely references is
  not itself an input and cannot be forwarded as a separate reference.
- An output `media-reference` must reuse a `mediaId` from one of this batch's
  input Blocks, and it cannot widen a delivered crop. See
  [the concepts guide](concepts.md#media).
- Module description replacement and retention changes are **contract only**. The
  current runtime rejects those result fields until their durable records exist.

Receiving a Block does not authorize everything visible inside it. Identifiers are
information, not permission.

### Cancellation and termination

Every action has a deadline. On cancellation the host sends `dolly.cancel`,
revokes the capabilities scoped to that Run, and stops accepting a late result.
Observe it promptly and release your resources. After a bounded grace period the
host can terminate the process, which invalidates the whole session and all of
its handles before any replacement Module generation is created.

Before sending any termination signal, the host closes the capability session:
new invocations are rejected synchronously, every handle is revoked, and an abort
signal is delivered to each capability handler already running. Termination counts
as confirmed only after both the process has exited and every started capability
handler has finished, within a finite timeout. If either is still unconfirmed the
host reports `EXTENSION_TERMINATION_UNCONFIRMED`, does not report the process as
stopped, and does not create a replacement Module generation.

On Linux, once the reviewed launcher has joined its control group, a direct child
exit stops being sufficient evidence; confirmation also requires a closed protocol
channel and an empty control group. That backend is
[Architecture Decision Record 0009](../adr/0009-linux-core-service-process-ownership.md),
which is still `Proposed`.

### How a Module process is started and stopped

**Built, not enabled.** The ordering below exists in
`src/core/linux-module-process-lifecycle.ts` with tests that assert the order and
the refusals. Nothing calls it. It starts no Module by itself, it is not wired
into runtime startup, and `runtime-bootstrap.ts` still rejects every configured
Module. That guard is removed only if Architecture Decision Record 0009 becomes
`Accepted`, and it is still `Proposed`.

It is worth knowing anyway, because it explains failures whose inside your
Extension never sees. Each start step must be proven before the next one runs:

1. Core allocates a process generation that is never reused and persists its
   process record **before any child process exists**. A Core that dies here
   still leaves evidence that a child may have been created.
2. Core prepares the Module control group and **reads every limit back**. A group
   whose limits cannot be enforced never receives a process.
3. Only then does the reviewed launcher start. It joins that group and applies
   its own open-file limit before it can execute anything.
4. Core verifies the launcher's membership **from the kernel's control-group
   files**, never from the launcher's own report.
5. Only after that is the launcher authorized to replace itself with your
   Extension.

Stopping is equally fixed: terminate the whole control group and prove it empty.
Once membership has been verified a direct child exit is never that proof. The
record moves to `stopping` before termination begins, so a Core that dies partway
leaves its intent visible, and to `stopped` only after the group is proven empty.
An unproven stop stays `stopping` for a later Core to resolve rather than being
reported as a success.

The consequence for you is worth designing against: your process can be torn down
at a point where Dolly refuses to declare it stopped, and no replacement Module
generation is created until that is resolved. Make being killed without warning
safe, and do not rely on shutdown code to release anything that matters.

## Capabilities

A **capability** is an opaque, high-entropy handle bound to one Extension
process, session, instance, capability type, version, operation set, and resource
scope. Holding it authorizes exactly the operations the host-side grant encodes —
nothing more.

Invoke one with a request from your process to the host:

```json
{
  "jsonrpc": "2.0",
  "id": "extension-1",
  "method": "capability.invoke",
  "params": {
    "protocolVersion": "3.0",
    "sessionId": "session-1",
    "handle": { "...": "the opaque handle from dolly.initialize" },
    "operation": "read",
    "arguments": { "key": "last-seen" },
    "moduleJobId": "job-1",
    "runId": "run-1",
    "idempotencyKey": "job-1:last-seen"
  }
}
```

`capability.invoke` is the only extension-to-host method. There is no method that
evaluates code, imports host modules, reads host process state, or reflects over
host objects.

### Run-scoped enforcement

**Implemented, and stricter than you might expect.**

The host accepts a capability request only while it is executing a Run. Both
`moduleJobId` and `runId` must be present and must equal the host's own active
Run. A missing identifier, a request outside an active Run, or any mismatch is
rejected as `CAPABILITY_SCOPE_MISMATCH` **before the capability handler runs**.

There is no capability operation outside a Run in this profile — including any
query of a past Module job's outcome. So a background timer in your Extension
cannot call a capability, and neither can code in `module.create` or during
shutdown.

Both identifiers are required because one Module job can have several Runs after
a retry, while a Run identifier alone does not identify the persistent job.

Your `moduleJobId` and `runId` are treated as untrusted comparison inputs. After
an exact match, the host passes **its own** copies to the capability authority
and never forwards yours, even when the text is identical.

This strictness carries weight elsewhere: because no Core-authorized external
effect can happen outside a Run, the absence of a durable submission record for a
Run is meaningful evidence during crash recovery. Relaxing the rule would destroy
that inference.

### What capabilities exist

**Contract only.** The host enforces grants, scope, and revocation generically,
but no standard capability type is implemented or wired. Structured logging,
Extension-private storage, bounded Block reads, Media reads and crops,
endpoint-scoped outbound HTTP, model operations, tool invocation, and named-secret
use are all specified directions, not features you can call today.

The design rules those implementations will follow are worth knowing now:

- Read, write, delete, publish, external communication, and administrative
  operations are separate grants. There is no broad `filesystem`, `network`,
  `shell`, or `all tools` capability, and none is granted by default.
- A model-operation handle is not a network handle. A consumer of a model
  receives a descriptor-bound model operation and never the underlying HTTP
  handle, credential binding, redirect policy, or provider access grant. Being
  granted generic outbound HTTP for some unrelated purpose must not let you reach
  or authenticate to the model endpoint.
- A Media capability is never a grant for a raw `mediaId`. Its scope is derived
  from validated Media references in Blocks already delivered to your
  authenticated Module job, and it cannot be widened to an undelivered Block, a
  guessed identifier, another session, or a broader crop.
- A bounded Block-read capability lets you inspect a delivered Block. It does not
  make every Block identifier named inside that Block forwardable in your result.

### Handles and secrets

Handles are opaque. Do not parse them, and do not persist them across sessions —
they die with the session. A handle never contains a credential, a filesystem
path, an object-store key, or any other authority-bearing value, and handles and
secret references must be redacted from your logs, errors, traces, and any prompt
you build.

Raw secrets never appear in your configuration, in `dolly.initialize`, in the
environment, in ordinary capability results, or in published manifests.
Configuration may name a deployment-owned secret binding by a stable non-secret
name; the host resolves it and issues an endpoint-scoped capability whose handler
attaches authentication without ever returning the credential to you.

If some operation genuinely cannot work without handing raw credentials to
Extension code, that operation requires `trusted` code. It must not be presented
as conforming untrusted isolation.

### Effects and retries

If a capability can cause an external effect, it must persist its intent and
idempotency key durably **before** the input/output happens. An in-memory
duplicate map does not survive a host restart and is not evidence of anything.

The host will not retry a Run after uncertain external effects unless every such
effect used an idempotency key derived from the Module job identifier and a
stable operation identifier, through a capability that guarantees duplicate
suppression or a queryable outcome. Make your Runs safe to repeat where you can,
and report an unknown outcome as unknown rather than guessing.

Do not treat a returned result as committed. Your result becomes durable only
when Core commits it, and the outcome query that would let you observe that is
deferred to a later protocol version.

### Declared external effects

**Partly implemented.** A Module declares what external effects it may cause,
using one of two values:

- `"none"` — the host grants no capability and denies every `capability.invoke`
  request. Bounded standard-error text is still collected as local diagnostics;
  that is not a capability.
- `"core-capabilities-only"` — every granted effect-capable capability must
  implement the durable intent and idempotency contract above, and the host must
  not grant a capability that contradicts the declaration.

The declaration exists in the durable Module process records and in the runtime,
where the strict value is the default when it is unset. It is **not yet a field
of the instance configuration schema**: `dolly.instance/9` does not carry it, and
`dolly.instance/10` is the proposal that would.

The first Linux Module profile gives an Extension no external or persistent-effect
authority during initialization, Module creation, stopping, shutdown, or idle
time. Direct ambient effects in those phases make a package ineligible for
automatic activation and recovery.

## Configuration

**Partly implemented.** Installation checks that your manifest's
`configurationSchema` is a valid JSON Schema document. A configuration store
implementing the immutable-record model below — validation against the schema,
canonical digests, and revision checks — exists as a component with its own
tests, but it is not composed into a running instance, and the process host
itself does not validate configuration; it forwards what it is given. Migrations
do not exist at all.

Publish a machine-readable JSON Schema in your manifest. It must describe a JSON
value and should reject unknown properties unless you deliberately need an
extension point. The host validates configuration against the target version
before starting your code and again before each Module is created.

`configVersion` is a monotonically increasing integer, **independent of your
package version**. Stored configuration records its version, and the host rejects
a missing, future, ambiguous, or invalid one. Defaults are materialized
deterministically by the host or by a declared migration — never quietly inside
Module execution, where two Modules with the same stored configuration could
behave differently.

Only your own non-secret settings belong here. The host does not copy the whole
Dolly configuration, all endpoint definitions, all secrets, or another Module's
configuration into your context.

Dolly stores your configuration as an immutable record and the instance document
refers to it by a closed tuple: `configId` (stable logical identity), `revision`
(opaque, revealing no content), and `configVersion`. One `(configId, revision)`
pair is immutable — never overwritten, retargeted to another Extension or Module
kind, or reused after deletion. Editing creates a new revision, and activating it
takes a revision-checked configuration update. Startup runs
`inspect -> resolve -> validate -> launch` against one record revision and fails
closed on anything missing, corrupt, mismatched, mutable, or concurrently
replaced.

### Migrations

**Contract only.** `dolly.initializeMigration` and `config.migrate` are not
implemented, and package schema version 1 cannot declare a migration.

The shape they will take:

- Every automatic migration is one explicit step from version N to N+1.
- A migration is deterministic for the same input. It must not use the network,
  the current time, randomness, secrets, or undeclared host state, and it returns
  JSON plus structured warnings.
- Migrations run in a separate short-lived sandbox session whose first request is
  `dolly.initializeMigration`, followed only by `config.migrate` steps and
  `dolly.shutdown`. That session gets **no** operational capability handles and
  cannot create Modules, call providers or tools, or open persistent state.
- The host validates the result against the target schema after every step.
  Stored configuration is backed up and replaced atomically only after all steps
  succeed; on any failure the original stays active.
- A migration that drops data, changes external identity, broadens authority, or
  cannot be reversed requires explicit owner confirmation. Installing a new
  package never silently broadens capability grants, however its new schema is
  written.

## Errors

**Implemented, with two codes reserved.** JSON-RPC protocol errors use the
standard numeric `code`. Dolly-specific errors additionally carry, inside
`error.data`, a stable string `errorCode`, a safe human-readable message, and a
`retryable` boolean:

```json
{
  "jsonrpc": "2.0",
  "id": "host-3",
  "error": {
    "code": -32000,
    "message": "the upstream endpoint returned 503",
    "data": { "errorCode": "TRANSIENT_DEPENDENCY", "retryable": true }
  }
}
```

The wire error codes are:

| Error code | Meaning |
| --- | --- |
| `EXTENSION_PROCESS_PROTOCOL_INCOMPATIBLE` | No usable version, or identity mismatch |
| `CONFIG_INVALID` | Configuration failed validation |
| `MIGRATION_FAILED` | A configuration migration step failed |
| `CAPABILITY_DENIED` | Capability, operation, or handle not authorized |
| `CAPABILITY_REVOKED` | The handle was valid and has been revoked |
| `CAPABILITY_SCOPE_MISMATCH` | Wrong, partial, or missing Run identity |
| `CAPABILITY_SESSION_CLOSED` | The capability session was already closed |
| `INPUT_INVALID` | The delivered input failed validation |
| `RESULT_INVALID` | The returned result failed validation |
| `QUOTA_EXCEEDED` | A configured limit was reached |
| `DEADLINE_EXCEEDED` | The Run deadline passed |
| `CANCELLED` | The work was cancelled |
| `CONFLICT` | The operation conflicts with committed state |
| `TRANSIENT_DEPENDENCY` | A dependency failed but may succeed later |
| `EXTENSION_INTERNAL` | An unclassified Extension failure |
| `EXTENSION_TERMINATION_UNCONFIRMED` | Termination evidence missed the timeout |

Two of those are reserved names with no host implementation behind them yet.
`MIGRATION_FAILED` belongs to the migration runner, which does not exist, and no
host code path currently produces `TRANSIENT_DEPENDENCY` — it is the code an
effect-capable capability would use, and no standard capability is wired. Both
are safe to emit from your own Extension; just do not expect the host to have
produced them.

`CAPABILITY_SCOPE_MISMATCH` covers three cases: only one of `moduleJobId` and
`runId` was supplied, no Run was active, or either value differed from the host's
active Run. `EXTENSION_TERMINATION_UNCONFIRMED` means the host could not confirm
process exit and capability-handler completion — plus, on the Linux
executable-Module profile, a closed protocol channel and an empty control group —
within its configured timeout.

Your `retryable` value is advisory. The host decides whether a retry is safe from
method semantics, attempt state, idempotency, deadline, and policy — it will not
retry an unsafe operation because you marked it retryable, and it may retry
something you marked otherwise.

Never put a raw stack trace, secret, credential-bearing web address, host path,
environment variable, or unrelated user data into an error that crosses the
boundary. A privileged local diagnostic store may keep a redacted trace behind an
opaque identifier.

A crash, a malformed response, or a rejected result fails only your session. It
must not crash the orchestrator or corrupt Core state. The host applies bounded
restart backoff and a circuit breaker, and restart loops are visible to operators.

## Resource limits and backpressure

The host enforces finite limits for every untrusted Extension process and every
Run, covering wall-clock and CPU time, resident memory, inbound and outbound
frame bytes, result and log bytes, concurrent requests, storage bytes and object
count, network requests and bytes, open files and descriptors, subprocesses and
threads, and leased handles such as Blocks, Media, and provider access grants.

Limits arrive during initialization and may be lower for an individual Run. Apply
backpressure and never assume an unbounded queue. Your own accounting is
diagnostic only — enforcement is the host's job.

When a quota is exhausted, produce a typed error and, where safe, cancel. **Do
not silently truncate structured data into a result that looks valid.** Repeated
violations may trip a circuit breaker or quarantine the package.

## Compatibility

Protocol versions are `major.minor`. A major version changes wire or behavioral
compatibility; a minor version is additive for a receiver that negotiated that
minor. Package and configuration versions are independent of both.

Both sides negotiate one exact version before use. Within a major version, a
method, a required field, a field's meaning, an ordering rule, or an
authorization rule never changes incompatibly. New optional fields may appear in
a minor version, so ignore unknown non-security optional fields — but reject
unknown variants in tagged unions and in security-sensitive objects.

Supporting protocol 3.x does not imply supporting every 3.x capability;
capabilities and payload schemas are versioned separately. Never infer a
capability from a package version, the presence of a method, or a similarly named
older capability.

Protocol 3.0 removed fields that are **not** aliases. The version 2
`processingId` became `moduleJobId`; a protocol 3 capability request carrying
`processingId` is rejected as `CAPABILITY_DENIED` before its handler runs, and the
host does not copy the value across. Version 2 had already removed the version 1
`profile` field in favor of `isolation` and replaced `moduleInstanceId` with
`moduleId`. Protocol 3 defines no `moduleHandle`; sending one is rejected rather
than treated as `moduleId` or `moduleGenerationId`.

## Conformance

A conforming implementation must pass a portable, environment-independent
protocol suite using a fake host, a fake extension, and deterministic clocks and
quotas. Private infrastructure and paid services must never be required to run
it. The suite must cover at least:

- successful and failed version negotiation;
- lifecycle ordering and idempotent stop;
- malformed, duplicate-key, oversized, reordered, and late messages;
- process crash, hang, forced cancellation, and restart with fresh handles;
- forged, cross-session, expired, and revoked capabilities, including omitted,
  partial, matching, and mismatched `moduleJobId` and `runId`;
- closing the capability session before any forced signal, immediate denial of
  new calls, delivery of the abort signal, completion of active handlers, and
  `EXTENSION_TERMINATION_UNCONFIRMED` when completion exceeds the timeout;
- host denial of undeclared filesystem, network, listener, subprocess, and secret
  operations;
- quota enforcement and backpressure;
- configuration validation, every declared migration path, rollback, and
  capability reapproval after upgrade;
- retries that preserve `moduleJobId`, change `runId`, and deduplicate external
  operations by idempotency key;
- result validation and atomic commit; and
- redaction of logs and errors.

Two things the portable suite explicitly **cannot** prove:

**It cannot prove an operating-system sandbox.** A `sandbox` backend must also
pass platform integration tests driven by a real malicious process attempting
ambient secret reads, filesystem and storage escape, undeclared network, listener,
and process access, resource-limit escape, cross-instance access, and authority
retention after stop. A platform that skips or cannot enforce one of those cases
must not claim `sandbox` conformance — it may still accurately claim the portable
protocol or `process` isolation.

**It cannot prove executable-Module process ownership.** A Linux
executable-Module backend must also pass the failure tests required by
Architecture Decision Record 0009, including whole-control-group termination,
launcher membership verification, and the durable submission and external-effect
evidence rules, before Module activation may be claimed.

Record the protocol version, capability schema versions, host build, SDK build,
test-suite revision, trust, isolation, platform, and sandbox backend and version
with every conformance result.

## A minimal Extension

This is a complete Extension process that uppercases the text items it receives
and returns one Block. It has no dependencies and speaks the protocol directly.

It exercises the implemented parts of the boundary: framing, the handshake,
`module.create`, `module.execute`, and stop. **It cannot be installed and run
from a Dolly instance today**, because configured Modules are refused at startup.

`dolly-extension.json` is the manifest shown earlier. `dist/main.mjs`:

```javascript
// Frames are a 4-byte big-endian length followed by UTF-8 JSON.
// Descriptor 1 carries protocol frames only; use descriptor 2 for diagnostics.
const PROTOCOL_VERSION = "3.0";

let session;
let buffer = Buffer.alloc(0);

function send(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.byteLength, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, errorCode, message, retryable = false) {
  send({
    jsonrpc: "2.0",
    id,
    error: { code: -32000, message, data: { errorCode, retryable } },
  });
}

function uppercaseItems(input) {
  const items = [];
  for (const group of input.blockGroups) {
    for (const item of group.block.payload.value.items) {
      if (item.type === "text") {
        items.push({ type: "text", text: item.text.toUpperCase(), format: "plain" });
      }
    }
  }
  return items;
}

function handle(message) {
  const { id, method, params } = message;

  if (method === "dolly.initialize") {
    session = params;
    respond(id, {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: params.sessionId,
      extensionId: params.extensionId,
      // These two must equal the installed manifest, not the request.
      packageVersion: "1.0.0",
      moduleKinds: ["uppercase"],
    });
    return;
  }

  if (method === "module.create") {
    respond(id, {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: params.sessionId,
      moduleId: params.moduleId,
      moduleGenerationId: params.moduleGenerationId,
    });
    return;
  }

  if (method === "module.execute") {
    if (params.input.schemaVersion !== "dolly.reactive-module-input/2") {
      // Reject an unknown required schema instead of parsing it best-effort.
      fail(id, "INPUT_INVALID", "unsupported input schema version");
      return;
    }
    const items = uppercaseItems(params.input);
    respond(id, {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: params.sessionId,
      moduleId: params.moduleId,
      moduleGenerationId: params.moduleGenerationId,
      runId: params.runId,
      result: {
        schemaVersion: "dolly.module-result/1",
        // No Block proposal at all when there is nothing to publish. An empty
        // content value would be rejected.
        ...(items.length === 0
          ? {}
          : {
              blockProposal: {
                payload: { schema: "dolly.content/1", value: { items } },
              },
            }),
      },
    });
    return;
  }

  if (method === "module.stop" || method === "dolly.shutdown") {
    respond(id, {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: params.sessionId,
      stopped: true,
    });
    return;
  }

  if (method === "dolly.cancel") {
    // A notification: no reply. Release resources for the named request.
    return;
  }

  if (id !== undefined) fail(id, "EXTENSION_INTERNAL", "unsupported method");
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    if (buffer.byteLength < 4) return;
    const length = buffer.readUInt32BE(0);
    if (buffer.byteLength < 4 + length) return;
    const frame = buffer.subarray(4, 4 + length);
    buffer = buffer.subarray(4 + length);
    handle(JSON.parse(frame.toString("utf8")));
  }
});
```

The comments mark the three mistakes that are easy to make: echoing the request's
package identity instead of the manifest's, parsing an unknown input schema
best-effort instead of rejecting it, and sending an empty content value instead
of no proposal.

For a fuller worked example covering crashes, cancellation, oversized frames, and
capability scope failures, read the conformance fixture at
`tests/conformance/security/fixtures/extension-process-fixture.mjs`.

## Feature status

| Area | State |
| --- | --- |
| Package manifest, installation, digest-checked resolution | Implemented |
| Framing, JSON-RPC session, version negotiation | Implemented |
| The five lifecycle methods and `dolly.cancel` | Implemented |
| Capability handles and run-scoped enforcement | Implemented |
| Manifest `configurationSchema` checked at installation | Implemented |
| `capability.revoked` notification | Contract only |
| Standard capability types (logging, storage, Media, model, …) | Contract only |
| Immutable configuration records | Built as an uncomposed component |
| The configuration migration runner | Contract only |
| Module description and retention changes in a result | Rejected by the runtime |
| Periodic and source activation | Rejected by the runtime |
| `declaredExternalEffects` as a configuration field | Proposed for `dolly.instance/10` |
| Untrusted Extensions and a `sandbox` backend | Refused on every platform |
| Linux Module process start/stop ordering | Built, not wired into startup |
| Running a configured Module from an instance | Refused at startup |
| An `extension` command in the CLI | Refused as unavailable |
| A published SDK for Extension authors | Not started |

## Further reading

- [The Extension process protocol](../spec/extension-process-protocol.md) — the
  normative contract.
- [The concepts guide](concepts.md) — Blocks, Pages, Modules, and Media.
- [The Core runtime contract](../spec/core-runtime.md) — the runtime rules an
  Extension is executed under.
- [The instance topology contract](../spec/instance-topology.md) — how operators
  configure Modules and the configuration surfaces an Extension may contribute.
- [The Block content format](../spec/block-payload.md) — every content item and
  its validation rules.
- [Architecture Decision Record 0009](../adr/0009-linux-core-service-process-ownership.md)
  — the proposed Linux Module process ownership model.
