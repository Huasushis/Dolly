# Dolly Extension Process Protocol

Status: Draft

This document defines the proposed public extension boundary for Dolly. It is
normative only after it is accepted under `docs/spec/README.md`.

The Extension process protocol is the versioned JavaScript Object Notation
(JSON) message contract between Dolly and an Extension running in another
process. It is a process protocol, not an application binary interface (ABI):
Extensions exchange framed JSON messages and do not link to Dolly binaries or
use a shared calling convention.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, NOT RECOMMENDED, MAY, and OPTIONAL in this document are to be
interpreted as described by Request for Comments (RFC) 2119 and RFC 8174 when,
and only when, they appear in all capitals.

## 1. Scope

This specification covers:

- execution isolation for public third-party extensions;
- the versioned process protocol between the Dolly host and an extension;
- capability-based access to host resources;
- configuration schemas, versions, and migrations;
- lifecycle, cancellation, quotas, errors, and crash containment; and
- compatibility and conformance requirements.

The in-process TypeScript interfaces in the current prototype are not this
process protocol. Language-specific software development kits (SDKs) MAY wrap
the protocol, but a conforming host MUST be able to implement the contract
without loading Extension code into the host process.
Core Block, Delivery, Page, and scheduling semantics belong in
`core-runtime.md`. Media storage, crops, lifetime, and access grants belong in
`media.md`.
Descriptor-bound chat, embedding, and rerank operations, including provider
wire mapping and private Media access grants, belong in `model-provider.md`.

The process protocol is provider-independent. The project owner's private
object store, models, application programming interface (API) relays,
credentials, and network layout are optional deployment
fixtures only. A conforming extension MUST NOT require Aether, Bailian,
DashScope, OpenAI, a particular object store, or any other named provider.

## 2. Trust model

Public third-party extension packages, their dependencies, configuration
values, outputs, logs, and migrations MUST be treated as untrusted. A package
MAY be malicious, compromised, buggy, or merely incompatible. In particular,
the host MUST assume that an extension may try to:

- read secrets, host files, other instances, or another extension's state;
- open network listeners or make undeclared outbound connections;
- forge resource identifiers or capability handles;
- exhaust central processing unit (CPU), memory, storage, descriptors, bandwidth,
  or log volume;
- send malformed, oversized, reordered, or contradictory protocol messages;
- ignore cancellation, hang during shutdown, or crash at any point; and
- use returned text or tool output to cross a prompt or authorization boundary.

The host MUST expose trust and isolation as independent values in configuration
and diagnostics.

`ExtensionTrust` records only whether the deployment trusts the Extension code
that will run. It is separate from the runtime boundary and has exactly two
values: `trusted` and `untrusted`. Whether code was shipped with Dolly, reviewed,
or selected by an operator may explain a deployment decision, but those facts
are not additional runtime trust levels and are not encoded by this protocol.

`ExtensionIsolation` records the runtime boundary actually enforced for an
Extension. It relates to trust by limiting which trust value may use
which boundary, but it does not itself say whether code was reviewed. Its values
use the established isolation terms directly:

- `none` provides no isolation boundary and gives Extension code the host
  process's authority;
- `process` uses a separate operating-system process and this protocol to
  separate process failures and scrub inherited environment state. A direct
  child alone does not prove descendant containment, CPU-hang recovery, or hard
  termination. It does not deny ambient filesystem, network, or subprocess
  access; and
- `sandbox` uses a tested platform sandbox plus host-enforced capability checks to deny
  undeclared filesystem, network, subprocess, secret, and resource access.

An `untrusted` Extension MUST use `sandbox`. A Node Worker or ordinary child
process alone is insufficient. On a platform without a passing sandbox backend,
the host MUST refuse untrusted execution rather than silently fall back to
`process`. A `trusted` Extension MAY use `none`, `process`, or `sandbox` for a
non-executable integration, but an executable Module follows the stricter
platform rules below: `none` is forbidden, and `process` is insufficient until
the platform backend proves whole-group termination and containment. Trust MUST
NOT be inferred from name, install path, package signature alone, or prior
success.

## 3. Package metadata and discovery

The host MUST discover metadata without executing Extension code. Schema
`dolly.extension-package/1` is the static manifest that connects an installed
Node.js package to Dolly's Extension protocol, Module kinds, and configuration
schemas. A separate manifest is necessary because the standard `package.json`
format does not define those Dolly contracts.

```typescript
interface ExtensionPackageManifest {
  schemaVersion: "dolly.extension-package/1";
  extensionId: string;
  packageVersion: string;
  displayName: string;
  description: string;
  supportedProtocolVersions: readonly string[];
  entrypoint: string;
  modules: readonly {
    moduleKind: string;
    activation: "reactive";
    configVersion: number;
    configurationSchema: JsonValue;
  }[];
  requestedCapabilities: readonly [];
}
```

The file name is `dolly-extension.json`. Identifiers use the manifest's
restricted American Standard Code for Information Interchange (ASCII) syntax.
`packageVersion` is an opaque identifier compared exactly; the installer does
not interpret semantic-version precedence.

`entrypoint` is a normalized, relative Portable Operating System Interface
(POSIX) path ending in `.mjs`. It identifies one ordinary file copied into the
managed installation. The manifest cannot supply a command, arguments, working
directory, environment variables, or an absolute path.

Each `moduleKind` is unique within the package. Package schema version 1 supports
only reactive Modules. `configurationSchema` MUST be a valid JSON Schema Draft
2020-12 document, and `configVersion` identifies the configuration version that
it validates. `supportedProtocolVersions` is a non-empty exact list; protocol
version ranges are not inferred.

`dolly.extension-package/2` is the complete first producer-registration
manifest required by `schema-registry.md`. It has the same closed root fields as
version 1. Every Module declaration additionally has exactly one
`producedContentSchemas` array whose entries have this closed form:

```typescript
interface ExtensionContentSchemaProducer {
  schema: string;
  validator: JsonValue;
  validatorDigest: `sha256:${string}`;
  maxValueBytes: number;
  containsCoreReferences: false;
}
```

The array contains at most 64 entries. Each name is unique within the Module,
matches the content-name syntax, and is derived from the exact manifest
`extensionId`; a package cannot claim a `dolly.` name. `validator` is valid JSON
Schema Draft 2020-12, `validatorDigest` is its RFC 8785 canonical SHA-256 digest,
and `maxValueBytes` is a positive safe integer. Core references remain forbidden
until a reference extractor is separately specified and implemented. Version 2
still supports only reactive Modules. It does not add renderer registration,
capability requests, periodic activation, or source activation.

`dolly.extension-package/3` retains the complete version-2 producer registration
shape and permits a Module declaration's existing `activation` field to be
either `reactive` or `source`. It does not add a second activation list or a
background protocol. A source declaration means only that the Extension can
consume one ordinary `dolly.reactive-module-input/2` whose sole input came from
the Core-private, durable source activation queue. It does not let Extension
code enqueue work, publish Blocks outside a Run, or invoke itself. Periodic
activation remains unsupported.

`dolly.extension-package/4` retains the complete version-3 shape and also
permits `activation: "periodic"`. This authorizes only the delivery-backed,
non-empty periodic mode: the instance MUST provide at least one input Page and
`allowEmptyInput: false`. It adds no Extension timer or background protocol.
Core keeps the start-to-start period and invokes the same bounded
`module.execute` operation only after durable input becomes eligible.

`requestedCapabilities` MUST be empty in package schema versions 1 through 4.
Capability requests, renderer registration, configuration migrations, package
signatures, automatic source timers, and empty-input periodic activation require
a later package schema with their own security review and conformance tests.
Source activation in version 3 and non-empty periodic activation in version 4
grant no capability and no ambient authority. A valid future signature may
establish package provenance, but it will not grant capabilities or trust by
itself.

Installation recursively copies only ordinary files under finite file and byte
limits. It rejects symbolic links, reparse points, path escapes, case-folding
collisions, malformed or unknown manifest fields, invalid configuration schemas,
and an entrypoint absent from the copied files. Resolution rechecks the manifest,
file list, content digests, paths, and private file permissions before returning
an entrypoint.

## 4. Isolation and launch

For `sandbox`, the host MUST establish and verify a platform sandbox
with least authority:

- no inherited secrets or unrelated environment variables;
- no inherited network listeners, unrelated file descriptors, or unrelated host
  interprocess communication (IPC) endpoints; the single host-created protocol
  transport and explicitly granted descriptors are the only exceptions;
- no ambient filesystem access outside an extension-specific scratch area;
- no outbound or inbound network access unless separately granted;
- no process creation unless separately granted; and
- enforceable resource limits as described in Section 10.

`process` MUST still scrub secrets, unrelated environment, descriptors,
and IPC channels and enforce every resource limit available to its platform, but
it MUST report that ambient filesystem/network/process denial is not guaranteed.
`none` cannot claim any isolation property.

### 4.1 Proposed Linux Module launch profile

Architecture Decision Record (ADR) 0009 defines the first executable Module
profile. It supports only one reactive Module in one process. Core starts a
fixed reviewed child launcher rather than directly starting Extension code. The
launcher joins the prepared non-reused Module control group (cgroup), which is
the kernel process hierarchy that bounds a Module's processes and resource
limits. It then applies its open-file limit, closes every inherited descriptor
except the protocol transport and one protected control descriptor, and waits
for Core to verify its kernel membership before it executes the immutable
installed entrypoint.

Every executable Module, whether trusted or untrusted, must be prevented from
leaving or changing its Module cgroup, changing cgroup limits, accessing Core
state or service-manager control files, retaining Core management descriptors,
or signaling Core. A sandbox additionally denies undeclared filesystem, network,
subprocess, and secret authority. Until a tested backend enforces those rules,
the host MUST reject Module activation rather than treating ordinary `process`
isolation as sufficient.

The first profile gives an Extension no external or persistent-effect authority
during initialization, Module creation, stopping, shutdown, or idle time.
Direct ambient effects in those phases make the package ineligible for automatic
activation and recovery. Effects are available only through durable Core
capabilities while an exact reactive Run is active.

Capability grants in this profile follow the Module's
`declaredExternalEffects` configuration from `core-runtime.md` Section 5.2.
For `"none"`, the host grants no capability and denies every
`capability.invoke` request; bounded standard-error text is collected as local
diagnostics and is not a capability. For `"core-capabilities-only"`, every
granted capability that can cause an effect MUST implement the durable intent
and idempotency contract in Section 9, and the host MUST NOT grant a
capability that contradicts the declaration.

#### 4.1.1 Launcher control protocol

The launcher control protocol is the fixed message contract between Core and
the child launcher on the protected control descriptor. It is versioned
separately from the Extension process protocol because the launcher is a
reviewed fixed executable that runs before any Extension code; its version
field is `launcherProtocol`.

- The control descriptor is one Core-created private channel (for example a
  Unix socket pair) inherited at descriptor number 3. It is distinct from the
  Extension protocol transport on descriptors 0 and 1 and from the bounded
  diagnostic standard-error stream on descriptor 2, and it is the only
  descriptor above 2 that the launcher keeps.
- The launcher joins its cgroup, sets its own `RLIMIT_NOFILE`, and replaces
  its own process image without forking, so it is written in a language whose
  standard library provides both operations. The current implementation uses
  Python 3, which a Linux deployment running executable Modules must provide;
  ADR 0009 records why Node.js 20 cannot host it.
- Messages use the same four-byte length-prefixed UTF-8 JSON framing as the
  Extension process protocol, with a 4096-byte maximum control frame.
- Version 1 defines exactly four messages. Every value the launcher acts on
  arrives in these Core-validated frames; the launcher takes no path, limit,
  program, or environment input from anywhere else.
  - Core to launcher `{"launcherProtocol": 1, "command": "configure",
    "moduleCgroupPath": "...", "maxOpenFiles": n}` is the first frame. The
    launcher then writes its own process identifier into that cgroup, applies
    `maxOpenFiles` as both the soft and hard `RLIMIT_NOFILE`, and closes
    every other inherited descriptor.
  - launcher to Core `{"launcherProtocol": 1, "event": "in-cgroup"}` reports
    that those steps completed.
  - Core to launcher `{"launcherProtocol": 1, "command": "execute",
    "program": "...", "argumentVector": [...], "environment": {...}}` is sent
    only after Core has verified membership from kernel cgroup files and
    confirmed that no stop was requested. `program` is the absolute installed
    runtime executable and `argumentVector` and `environment` are the closed
    Core-validated argument array and environment. The launcher marks the
    control descriptor close-on-exec (or closes it) and calls `exec` with
    exactly those values.
  - Core to launcher `{"launcherProtocol": 1, "command": "exit"}`; the
    launcher exits immediately with a nonzero status.
- The launcher also exits on closure of the control descriptor, a malformed,
  out-of-order, unknown, or oversized frame, or expiry of its fixed internal
  deadline. It never forks, performs network input/output, reads Extension
  configuration, or executes anything before the `execute` command.
- Core bounds every phase with a finite wait. Before any cgroup member is
  observed and while `execute` is known not to have begun delivery, Core may
  complete cleanup only after observing launcher exit, reading a fresh
  `populated 0`, and removing the prepared cgroup directory. If a member is
  observed, Core terminates the whole Module cgroup even when exact launcher
  membership verification fails. If launcher exit or `execute` delivery is
  uncertain, Core exits unsuccessfully so service cleanup removes the whole
  service cgroup.

Launcher protocol version 1 has no working-directory field and does not change
the inherited Core working directory. The Node package entrypoint is therefore
an absolute path resolved from the verified installation, and package code MUST
resolve its own resources relative to `import.meta.url` rather than depending on
the process working directory. A future need for a package working directory
requires a new, closed launcher contract; it MUST NOT be smuggled through an
environment variable or inherited Core state.

This control protocol and its launcher exist in the codebase, and their
integration tests have been run inside a real delegated cgroup on a Linux
server: the launcher joined the prepared cgroup and executed only after Core
verified membership from kernel files, a launcher that falsely reported
membership was refused without any signal being sent, and a malformed,
oversized, out-of-order, or unknown-version frame, a closed control descriptor,
and the fixed deadline each ended in a nonzero exit. Focused tests also exercise
whole-group termination, including a descendant outside the Extension's
process group, and the ordered start now writes a Module process record before
a real launcher is created. The runtime still does not assemble that launcher,
its verified control group, and the product Extension protocol host end to end,
and Module activation remains disabled, so this section remains a proposal for
the profile as a whole. The Linux tests do not run in an ordinary shell,
because a process outside a delegated subtree cannot create the Module cgroup;
a repository script starts them inside a transient delegated service so they
cannot silently skip.

The current working directory, host paths, user home directory, and private
deployment layout MUST NOT be part of the process protocol. Persistent and shared storage
MUST be accessed through capability operations, not injected raw paths. The host
MUST use a private, authenticated transport created for that extension process.
The extension MUST NOT expose a network port merely to implement the process protocol.

Process environment values MUST be treated as host implementation details. An
extension MUST receive all portable inputs through the protocol. A host MUST
scrub inherited environment state even when a child process runtime normally
copies it by default.

## 5. Wire protocol

### 5.1 Base protocol

The current implemented process protocol version is `3.0`. Version `3.0`
replaces the version 2 `processingId` field with `moduleJobId` and applies the
Module job, Run, Delivery batch, and Claim meanings defined by
`core-runtime.md`. The removed field is migration evidence, not an alias. A
version 3 host MUST reject a manifest that supports only version 2 or earlier,
and MUST reject an initialization response or later message carrying an older
process protocol version. It MUST NOT translate removed fields during an active
session.

Version 2 previously removed the version 1 `dolly.initialize` field `profile`,
replaced it with `isolation`, and replaced `moduleInstanceId` with `moduleId`.
Those old fields remain rejected by version 3.

A protocol 3 capability request that carries the old `processingId` field is
rejected as `CAPABILITY_DENIED` before its capability handler runs. The host
MUST NOT copy that value into `moduleJobId`.

Protocol 3 does not define `moduleHandle`. An implementation of an earlier
draft that returns or sends that field is rejected; the host MUST NOT treat it
as an alias for `moduleId` or `moduleGenerationId`.

The process protocol MUST use JSON-RPC 2.0, a remote-procedure-call protocol
encoded as JavaScript Object Notation (JSON), with 8-bit Unicode Transformation
Format (UTF-8) text. Batch requests MUST NOT be used. Request identifiers (IDs)
MUST be strings, MUST be unique among the sender's
outstanding requests, and MUST NOT be reused until the original request has
terminated.

On a byte stream, messages MUST use an explicit UTF-8 byte length frame. The
package launch descriptor MAY select `Content-Length` framing or a fixed-width
length prefix, but both peers MUST agree before Extension code is launched. A
newline alone is not a sufficient frame boundary. On a message-preserving
transport, one transport message MUST contain exactly one JSON-RPC message.

The host MUST impose a maximum frame size before JSON parsing. Invalid JSON,
duplicate object keys in security-sensitive envelopes, invalid JSON-RPC
versions, unexpected batch arrays, and over-limit frames MUST be rejected. A
configurable number of protocol violations MUST terminate and quarantine the
extension process.

All post-initialization requests MUST carry the negotiated protocol version and the
host-issued session ID. Values crossing the process protocol MUST be JSON-compatible.
Binary data MUST use a bounded blob or media capability; it MUST NOT be embedded
as unbounded base64 in routine RPC messages.

### 5.2 Initialization

`dolly.initialize` MUST be the first request in an operational extension
session. The restricted migration session in Section 7.2 uses a separate first
request and cannot create Modules. For an operational session, the host selects
the highest protocol version supported by both the host and the static manifest and
supplies:

- the selected protocol version and a fresh session ID;
- the extension and instance identities;
- the enforced `isolation` value;
- the validated, non-secret extension configuration and its version;
- host-enforced process and per-execution limits;
- granted capability descriptors and opaque handles; and
- the versions of the Core input and result schemas available to this session.

The extension response MUST echo the selected protocol version and session ID, identify its
manifest and package versions, and declare the module kinds it is ready to
create. Any mismatch MUST abort initialization. No operational method or
capability invocation is valid before initialization succeeds.

The host MUST NOT silently renegotiate after initialization. A process restart
creates a new session and invalidates every handle from the previous session.

### 5.3 Required lifecycle methods

A protocol version MUST define schemas for at least these host-to-extension methods:

- `dolly.initialize`;
- `module.create`;
- `module.execute`;
- `module.stop`; and
- `dolly.shutdown`.

It MUST also define these notifications:

- `dolly.cancel`, identifying an outstanding request and a reason; and
- `capability.revoked`, identifying a no-longer-valid handle.

`module.create` confirms the stable `moduleId` and current
`moduleGenerationId` for the session. The initial protocol permits only one
Module in an Extension process session, so it does not add a second Module
handle for the same object. `module.execute` includes the Core runtime's stable
`moduleJobId`, fresh globally unique `runId`, current `moduleGenerationId`,
attempt number, deadline, `hasMore` input marker, and versioned core payload. Its
successful result is one atomic Module result containing either no Block
proposal or exactly one Block proposal. Module description replacement and
retention changes are future result fields; the current runtime rejects them
until their persistent records and result commit checks exist. Once supported,
they are metadata rather than extra Blocks, and the host must scope each
retention key to the authenticated Module and validate every target. Streaming
progress MAY be defined by a later
capability, but progress notifications MUST NOT be mistaken for committed output,
Module description, or retention state.

All payloads MUST identify their schema version. The extension MUST reject an
unknown required schema version instead of attempting a best-effort parse.

### 5.4 Extension-to-host calls

An extension MAY call only methods granted by the negotiated protocol version. Host resource
access MUST use:

```text
capability.invoke(handle, operation, arguments, moduleJobId, runId, idempotencyKey?)
```

The exact JSON object form is defined by the selected protocol schema. Unknown
methods, operations, or handles MUST be denied. The host MUST NOT expose a
generic method that evaluates code, imports host modules, reads arbitrary
process state, or reflects over host objects.

Every capability request in the first Linux Module profile carries both
`moduleJobId` and `runId`. Both identifiers are necessary because one Module job
can have more than one Run after retry, while a Run identifier alone does not
identify the persistent Module job. The capability authority is the host
component that validates handles and grants before calling a capability handler;
this name distinguishes grant authorization from Extension process protocol
message validation.

The first profile rejects a missing identifier, an invocation outside an active
Run, or any mismatch as `CAPABILITY_SCOPE_MISMATCH` before the capability
handler runs. It has no runless capability operation, including a post-Run
Module-job outcome query; that query and background work are deferred until a
later protocol version specifies their durable state and read-only authority.
Another profile may define a closed set of runless read-only operations, but it
must bind each one to an authenticated session, Module generation, and explicit
durable object; it MUST NOT create an external-effect channel.

The extension-provided fields are untrusted comparison inputs. After an exact
match, the host MUST pass `moduleJobId` and `runId` copied from its own active
Run to the capability authority. It MUST NOT forward the values
from the extension request as authority, even when their text is equal.

The current process host implements this rule. It accepts a capability request
only while it is executing a Run, requires both identifiers to be present and
equal to that Run's, and rejects anything else before the capability handler
runs. It previously also accepted requests in the `ready` state and allowed
both identifiers to be omitted together; that is removed, because an omitted
Run identity would break the inference that a Run with no submission record
received no Core-authorized external effect.

When durable effect accounting is configured, the host additionally resolves
the Run against Core's already-persisted Module submission record before it
sends `module.execute`. It durably opens that exact Claim/Run, routes every
invocation of a granted handle through one Host-owned effect recorder, and
closes the Run only after new capability admission has stopped and every
accepted handler has settled. The close freezes the count and digest of the
complete intent set. A Module response that races an active handler is a
protocol violation; the Run is not closed until termination cleanup drains the
handler. A forged handle or operation never reaches a handler and therefore is
not an omitted effect. This component path is not yet product startup wiring:
`runtime-bootstrap.ts` still rejects configured Modules.

No capability currently lets background code activate its own Module. Background
code MUST NOT publish a Block or call `module.execute` on itself. The candidate
installed composition accepts source activation from package schema version 3
or 4 only through an authentic, store-bound Core queue. Package schema version
4 can also declare a delivery-backed periodic Module; Core still rejects
empty-input periodic execution before process start. A source declaration whose
instance trigger is periodic is likewise rejected until a Core-owned producer
can persist each timed request. Product startup still rejects every configured
Module; trusted source ingress, queue-retention policy, and broader periodic
failure evidence remain prerequisites.

An extension that prepares durable work during `module.execute` MUST NOT treat
the returned result as committed. The first Linux Module profile defers both
background work and the post-Run outcome query, so durable background work
prepared during a Run cannot become eligible in that profile. A later protocol
version that introduces background work MUST first expose a scoped, read-only
`module-job-outcome` operation. That operation queries one Module job owned by
the authenticated Module and returns its durably recorded terminal state and
bounded result or failure summary; it does not create or identify a Module
result commit. The host MAY send a deduplicated commit notification as an
optimization.
Background work becomes eligible only after the extension can observe that its
exact `moduleJobId` committed with the expected result digest
and retention changes. A missing notification is recovered by querying the
same read-only operation.
Rejected, negatively acknowledged, or conflicting results do not activate
durable background work created during the Run. No supported operation lets
background code release a persistent strong reference directly; that release
requires a later serialized Module result.

## 6. Capability model

A capability is an opaque, high-entropy handle bound to one extension process,
session, instance, capability type, version, operation set, and resource scope.
Possession authorizes only the operations encoded by the host-side grant.

A capability session is the set of capability handles and active capability
invocations bound to one Extension process session. The qualified term
distinguishes this authorization state, which can be closed immediately, from
the broader Extension process session and its message transport.

The host MUST:

- deny every capability not explicitly granted;
- validate the handle on every invocation;
- reject handles from another session, process, module, or instance;
- enforce operation, resource, size, rate, and expiry constraints host-side;
- support immediate revocation; and
- keep the grant policy outside extension-controlled configuration.

Capability handles MUST NOT contain a credential, filesystem path, object-store
key, or other authority-bearing value. Extensions MUST treat handles as opaque
and MUST NOT persist them across process sessions. Handles and secret references
MUST be redacted from logs, errors, traces, and model prompts.

Standard capability types SHOULD include separately versioned operations for:

- structured logging;
- extension-private key/value or blob storage;
- bounded reads of Block snapshots;
- read-only outcome lookup for the extension's own Module jobs, which the
  first Linux Module profile defers together with background work (Section
  5.4);
- bounded Media reads and crop requests;
- endpoint-scoped outbound Hypertext Transfer Protocol (HTTP) requests;
- model operations, including separately described chat, embedding, and
  reranking operations;
- registered tool invocation; and
- use of a named secret without revealing its value.

A bounded Block-read capability permits an Extension to inspect the Block that
the host delivered. It does not authorize the Extension to emit a separate
`block-reference` to every Block named inside that snapshot. Core validates a
Module result independently and permits such an output reference only to a
Block delivered directly in that Module job's Delivery Claim.

A Media capability is not a grant for a raw `mediaId`. The host derives its
scope from validated `media-reference` items in immutable Blocks already
delivered to the authenticated Module job. Its scope MUST bind the instance,
Extension session, Module, delivered Block, Media identifier, permitted
operation, byte limit, and crop boundary. The Extension cannot use it for a
Media identifier from configuration, generated text, another session, or an
undelivered Block, and it cannot broaden a delivered crop. A future operation
may return an authorized bounded copy or request a permitted crop, but it MUST
NOT expose a storage locator, object-store credential, or generic Media-store
method.

The current process host does not yet implement or wire these Media capability
operations. The operations above are a required protocol direction, not a
claim that an isolated Extension can currently read Media. Until the host,
schema, and conformance tests exist, it MUST deny such calls rather than accept
a raw identifier.

Read, write, delete, publish, external communication, and administrative
operations MUST be distinct grants. A broad `filesystem`, `network`, `shell`,
or `all tools` capability MUST NOT be granted by default.

The compatibility `module-private-storage/v1` handle may be fixed to one
Module job and Run, or may retain its original session-wide scope. It MUST NOT
be used as a reusable handle for a long-lived Module process because it has no
per-Run invocation limit.

A long-lived Module process uses `module-private-storage/v2`. The host MUST
choose one of two explicit execution scopes when it creates the handle:

- a fixed `{moduleJobId, runId}` for a one-shot process or bounded test; or
- `active-run`, meaning the process host supplies the identifiers of the
  Module job and execution attempt that it is currently running.

Omitting the version 2 execution scope is invalid; absence MUST NOT mean broader
authority. An `active-run` request is accepted only while the process host has
an exact active Run, and the Extension cannot select or override that Run on
the wire. In addition to the finite process-session invocation ceiling,
version 2 enforces `maxInvocationsPerRun` independently for each exact
`(moduleJobId, runId)` pair. A failed or exhausted Run MUST NOT consume another
Run's per-Run allowance. The process-session expiry and total invocation limit
remain finite, so a product host must rotate the handle or restart the process
through its normal generation lifecycle before either is exhausted.
An installed process MUST NOT start when a newly issued handle cannot remain
valid through its bounded initialization protocol and one complete configured
Run.

Before Core acquires a Delivery Claim for a long-lived process, the process
host MUST issue one Host-owned Run admission. The admission freezes the current
Module generation, process generation, and absolute Run deadline. It is issued
only when every active-Run capability has enough remaining process-session
invocations for that capability's complete per-Run ceiling and remains valid
through the deadline. Insufficient expiry or invocation capacity requests
normal process-generation rotation; it is not discovered by letting an
untrusted Extension call an exhausted handle. One admission may authorize
exactly one Run. An empty mailbox or pre-execution Claim failure explicitly
releases it, and a submitted Run consumes it. A direct deadline-only execution
MUST NOT bypass an outstanding admission.

Claim and submission persistence consume the same Run time budget; they do not
reset it. If that persistence or recovery reaches the deadline before
`module.execute` is sent, Core MUST synchronously release the exact Claim and
matching submission, leave the Delivery failure count unchanged, and obtain a
fresh admission before re-Claiming. An unconfirmed release is a preserve-only
recovery state, never a negative acknowledgement. Once `module.execute` has
been sent, a result at or after the admitted deadline is not a success; normal
timeout fencing and external-effect evidence rules apply.

Model-operation and generic outbound-network capabilities are distinct. A large
language model (LLM), Memory, or other ordinary model consumer receives only a
  descriptor-bound model operation handle. It MUST NOT receive the underlying
  endpoint HTTP handle, credential binding,
redirect policy, or provider access grant. The model provider broker owns those
authorities and enforces the selected model description,
budgets, exact Media permissions, and selected provider adapter and transport.
Granting the same Extension generic HTTP access for an unrelated purpose
requires a separate explicit scope and MUST NOT allow it to reach or
authenticate to the model endpoint behind that service.

### 6.1 Secrets and outbound requests

Raw secrets MUST NOT appear in module configuration, `dolly.initialize`, ambient
environment variables, ordinary capability results, examples, snapshots, or
published manifests. Configuration MAY refer to a deployment-owned secret
binding by stable non-secret name. The host resolves that binding and issues an
endpoint-scoped capability whose handler attaches authentication without
returning the credential to the extension.

If a platform cannot perform a required operation without disclosing a raw
credential to Extension code, that operation requires `trusted` Extension code.
It MUST NOT be presented as conforming untrusted Extension isolation.

Network capabilities MUST constrain scheme, destination, port, redirect policy,
Domain Name System (DNS) resolution, request size, response size, and allowed
authentication binding. Redirects and DNS changes MUST be revalidated to
prevent server-side request forgery (SSRF) and rebinding. Opening listeners
requires a separate grant and user-visible policy.

Whether a provider can access an object through a time-limited authorized
uniform resource locator (URL) or
a host-mediated fetch is a property of one provider access grant for one Media
item. The host and Extension MUST NOT infer a global object-store visibility
policy from a provider name. A private object-store deployment is one supported
configuration, not a requirement for every user or storage adapter.

## 7. Configuration contract

### 7.1 Schema and validation

Each extension MUST publish a machine-readable JSON Schema using a schema draft
selected by the manifest version. The schema MUST describe a JSON value and
SHOULD reject unknown properties unless an explicit extension point is needed.
The host MUST validate target-version configuration before starting operational
extension code and again before every Module is created. A migration
runner may start only after the stored input validates against its retained
source-version schema and the restrictions in Section 7.2 are in place.

`configVersion` MUST be a monotonically increasing integer independent of the
package version. The stored configuration MUST include its version. The host
MUST reject missing, future, ambiguous, or invalid versions. Defaults MUST be
materialized deterministically by the host or a declared migration, not hidden
inside module execution.

Only extension-specific, non-secret settings belong in this configuration. The
host MUST NOT copy the entire Dolly configuration, all endpoint definitions,
all secrets, or unrelated module configuration into an extension context.

### 7.1.1 Immutable configuration reference

The public instance document MUST NOT embed an Extension's arbitrary
configuration object. A Module refers to one host-managed immutable record
through `configurationReference`, this closed, non-secret tuple:

- `configId`: stable logical configuration identity;
- `revision`: opaque revision identity that reveals no configuration or secret
  content; and
- `configVersion`: the monotonically increasing extension configuration schema
  version from Section 7.1.

The trusted configuration record additionally records the exact `extensionId`,
`moduleKind`, validated JSON document, configuration schema digest, and an internal
integrity digest. Provider, storage, secret, and endpoint selections inside the
document are opaque host-managed references; credentials are
never copied into the instance document or extension configuration.

One `(configId, revision)` tuple is immutable. It MUST NOT be overwritten,
retargeted to another extension or Module kind, or reused after deletion. An
edit creates a new revision. Activating it requires a revision-checked instance
configuration update that changes the complete reference tuple.

Startup performs `inspect -> resolve -> validate -> launch` against the same
record revision. The resolver MUST verify exact `extensionId`, `moduleKind`,
`configVersion`, configuration schema digest, integrity digest, and revision before
operational code starts. Missing, corrupt, mismatched, mutable, or concurrently
replaced records fail closed. The effective instance revision includes the
complete public reference tuple; status also reports the resolved configuration
revision so a difference between the configured and resolved revisions is
observable.

### 7.2 Migrations

Every automatic migration MUST be an explicit one-step transformation from
version N to N+1. Migrations MUST be deterministic for the same input, MUST NOT
use network access, current time, randomness, secrets, or undeclared host state,
and MUST return JSON plus structured warnings.

Migration runs use a separate, short-lived sandbox session. Its first request
MUST be `dolly.initializeMigration`, followed only by `config.migrate` one-step
requests and `dolly.shutdown`. The host supplies the selected protocol version,
package and migration identities, source and target config versions, validated
source JSON, and schema digests. The migration session receives no operational
capability handles and MUST NOT create Modules, invoke providers or tools, or
open persistent state.

The host MUST run migrations inside the extension sandbox with no operational
capabilities. It MUST validate the result against the target schema after every
step. Stored configuration MUST be backed up and replaced atomically only after
all steps succeed. On failure, the original configuration MUST remain active.

A migration that drops data, changes external identity, broadens authority, or
cannot be reversed MUST require explicit owner confirmation. Installing a new
package MUST NOT silently broaden capability grants, even if its new config
schema requests them.

## 8. Data and ownership rules

Inputs are immutable snapshots. An extension MUST NOT rely on object identity,
shared memory mutation, host class prototypes, or language-specific exceptions.
The host MUST validate an extension result before it becomes core state.
The current Module result uses the canonical JSON and digest rules from
`core-runtime.md`. Its `dolly.module-job-result/1` digest contains only the
validated source, optional Block proposal, and ordered output Page identifiers;
assigned Block and Delivery identifiers are later Core effects. The SDK and
host MUST produce the same `resultDigest`; an extension MAY compute it only
after assembling that immutable result. A Module job outcome lookup returns the
host-committed digest, not an extension-supplied claim.

Resource references in a result MUST be capabilities or schema-defined stable
  IDs that the host verifies. Returning an ID does not prove ownership. An
Extension MUST NOT create a Block, register Media, create a forward reference,
or return an external URL outside the operations granted to it.

Receiving a Block snapshot does not itself authorize every Block identifier
visible within that snapshot for a result. In particular, an input
`block-reference` does not make its target a separately forwardable output
reference. Before it accepts a Module result, Core restricts each output
`block-reference` to a Block delivered directly in the result's Delivery Claim.

The same rule applies to a `mediaId` in a Block proposal. Media identifiers are
shared by Core inside one Dolly instance so valid Blocks can forward a reference
between Modules, but a raw identifier is not authorization for an Extension.
Before accepting a proposal, the future host implementation of the Media
capability MUST prove that each Media reference appears in a Block delivered to
the authenticated Module job or is covered by another explicit host grant. This
proposal validation is not yet wired into the current Extension process host;
it is a required condition before claiming Extension Media support.

Text and metadata supplied by an extension are untrusted data. They MUST NOT be
promoted to a system prompt, authorization rule, capability request, or trusted
user interface (UI) markup solely because they came from an extension.

The standard storage contract distinguishes two scopes:

- a Module-private namespace keyed by `moduleId` and isolated from every other
  Module even when they were created by the same Extension package; and
- an optional extension-shared namespace for state deliberately shared by that
  package's Modules.

Both scopes are accessed through storage capabilities, never host paths. Access
to the shared namespace requires a separate grant and an explicit concurrency,
transaction, quota, and migration contract. A storage capability for the
Module-private namespace MUST NOT be usable to derive another Module's
namespace. Package name, display name, and caller-provided path text are not
storage authority.

## 9. Lifecycle and execution semantics

The following states describe the host lifecycle during one Extension process
session. The Module actor,
`moduleGenerationId`, Module job, Run, Claim, and Module result commit lifecycle
remains defined by `core-runtime.md`; the process protocol carries those
identifiers across the isolation boundary and MUST NOT weaken the rules that
reject stale identifiers.

The Extension process host has these states:

```text
created -> starting -> ready
ready -> executing -> ready
created/starting/ready/executing/failed -> stopping -> stopped
starting/ready/executing -> failed
```

Package discovery, validation, and quarantine belong to the installation
registry and are not Extension process host states.

The host MUST NOT call `module.execute` before successful creation. One Module
instance MUST never receive concurrent Runs; this invariant is not
negotiable. The initial process protocol permits one live Module per Extension
process session and process so hard termination affects only one Module. A
future capability for sharing one process may be standardized only if process
death atomically rejects results from every hosted sibling's old Module
generation and revokes its capabilities. Process death alone does not
negatively acknowledge an active Module job: each sibling's Claim follows the
durable submission and external-effect evidence rules in `core-runtime.md`
before any acknowledgement, release, retry, or recreation.
`module.stop` and `dolly.shutdown` MUST be idempotent.

Each Run has a deadline. On cancellation, the host MUST send `dolly.cancel`,
revoke capabilities scoped to that Run, and stop
accepting late results. The extension SHOULD observe it promptly and release
resources. After a bounded grace period, the host MUST be able to terminate the
process. Termination MUST invalidate the entire Extension process session and all of
its handles before a replacement `moduleGenerationId` is created.

Every immediate or forced termination path MUST call the capability session's
close operation before sending any operating-system termination signal to the
child process. This includes explicit termination, failure of graceful stop, a
  response timeout, a protocol violation, and a child-process error. Calling
close MUST synchronously reject new capability invocations, revoke every handle
in the session, and deliver an abort signal to every capability handler that
has already started. The close operation remains pending until those handlers
finish. The host MAY signal the child after the synchronous revocation without
waiting for the close operation to finish.

Termination is confirmed only after both the child-process exit and completion
of every started capability handler. The host MUST apply a finite confirmation
timeout to those two conditions. If either condition remains unconfirmed when
the timeout expires, it MUST return `EXTENSION_TERMINATION_UNCONFIRMED`, MUST
NOT report the process as stopped, and MUST NOT create a replacement Module
generation on the strength of that failed confirmation.

For the Linux executable Module profile in Section 4.1, a direct child-process
exit stops being sufficient termination evidence once any member has been
observed in the Module cgroup. Confirmation additionally requires a closed
protocol channel, `cgroup.kill` or an equivalent group operation, a Module
cgroup reporting `populated 0` in `cgroup.events`, and directory removal, as
defined by ADR 0009. Before any member is observed and before `execute` delivery
begins, confirmation instead requires an observed launcher exit, a fresh
empty-state reading, and directory removal. The portable two-condition rule
above remains the minimum for other uses of `process` isolation while the
creating host process is still alive.

Completion delivery is not assumed to be exactly once. The host MUST attach the
core `moduleJobId`, fresh `runId`, `moduleGenerationId`, and attempt number. It
MUST NOT retry a Run after uncertain external side effects unless every
such effect used an idempotency key derived from the Module job identifier and
a stable operation identifier through a capability whose contract
guarantees duplicate suppression or a queryable outcome.
An effect capability MUST persist its intent and idempotency key durably
before input/output; an in-memory duplicate map does not survive a host
restart and is not retry evidence. In the first Linux Module profile, a
trusted Extension that can make direct ambient effects is never automatically
retried after a submitted Run without a committed result; its unknown outcome
is preserved for audited operator action.
Extensions SHOULD make Runs without external effects safe to repeat and MUST
report when an effect outcome is unknown.

Stopping an instance MUST revoke its handles and release AccessLeases owned by
the host and strong references scoped to the Module generation. A process crash
MUST NOT leave partially returned output committed. Recovery of durable side
effects is governed by the relevant capability contract.

## 10. Resource quotas and backpressure

The host MUST enforce finite limits for every untrusted Extension process and
Run. Applicable limits include:

- wall-clock deadline and CPU time;
- resident memory;
- inbound and outbound frame bytes;
- result, log, and progress bytes;
- concurrent remote procedure calls (RPCs) and capability requests;
- storage bytes and object count;
- network requests and transferred bytes;
- open files, descriptors, subprocesses, and threads; and
- Blocks, Media, provider access grants, and other leased handles.

Limits MUST be supplied during initialization and MAY be lower for an individual
Run. The Extension MUST apply backpressure and MUST NOT assume unbounded
queues. The host remains responsible for enforcement; extension self-reporting
is diagnostic only.

Quota exhaustion MUST produce a typed error and, where safe, cancellation. It
MUST NOT silently truncate structured data into a valid-looking result. Repeated
quota violations MAY trip a circuit breaker or quarantine the package.

## 11. Errors, crashes, and diagnostics

JSON-RPC protocol errors use the standard numeric `code` field. Dolly-specific
wire errors MUST also include a stable string `errorCode` inside `error.data`, a
safe human-readable message, and a `retryable` boolean. The initial set of wire
error codes MUST distinguish at least:

- `EXTENSION_PROCESS_PROTOCOL_INCOMPATIBLE`;
- `CONFIG_INVALID` and `MIGRATION_FAILED`;
- `CAPABILITY_DENIED`, `CAPABILITY_REVOKED`,
  `CAPABILITY_SCOPE_MISMATCH`, and `CAPABILITY_SESSION_CLOSED`;
- `INPUT_INVALID` and `RESULT_INVALID`;
- `QUOTA_EXCEEDED`;
- `DEADLINE_EXCEEDED` and `CANCELLED`;
- `CONFLICT`;
- `TRANSIENT_DEPENDENCY`;
- `EXTENSION_INTERNAL`; and
- `EXTENSION_TERMINATION_UNCONFIRMED`.

The in-process `code` on `ExtensionProcessHostError` reports failures to trusted
Core code and is not a wire field. An implementation MUST deliberately map an
internal host error to a public `error.data.errorCode`; it MUST NOT send an
internal code merely because the strings happen to match.

`CAPABILITY_SCOPE_MISMATCH` means `moduleJobId` and `runId` are present only in
part, no Run is active, or either value differs from the host's active Run.
`CAPABILITY_SESSION_CLOSED` means a new invocation
targeted a capability session that was already closed.
`EXTENSION_TERMINATION_UNCONFIRMED` means the host could not confirm the
required termination evidence within the configured timeout: child-process
exit and completion of all capability handlers, plus, for the Linux executable
Module profile, a closed protocol channel and an empty Module cgroup.

An extension-provided `retryable` value is advisory. The host decides whether a
retry is safe based on method semantics, attempt state, idempotency, deadline,
and policy.

Errors crossing the public boundary MUST NOT include raw stack traces, secrets,
credential-bearing URLs, host paths, environment variables, or unrelated user
data. A privileged local diagnostic store MAY retain a redacted stack trace
under the security and retention policy, referenced by an opaque diagnostic ID.

An extension crash, malformed response, or rejected result MUST fail only the
affected extension session. It MUST NOT crash the orchestrator or corrupt core
state. The host SHOULD apply bounded restart backoff and a circuit breaker;
restart loops MUST be visible to operators.

## 12. Compatibility

Protocol versions use `major.minor` semantics:

- a major version changes wire or behavioral compatibility;
- a minor version is additive for receivers that negotiated that minor; and
- package and configuration versions remain independent.

Both sides MUST negotiate one exact protocol version before use. A method, required
field, field meaning, ordering rule, or authorization rule MUST NOT change
incompatibly within a major version. New optional fields MAY be added in a minor
version. Receivers SHOULD ignore unknown non-security optional fields, but MUST
reject unknown variants in tagged unions and security-sensitive objects.

Capabilities and core payload schemas are independently versioned. Supporting
Protocol 3.x does not imply support for every 3.x capability. The host MUST NOT infer
a capability from package version, method presence, or a similarly named older
capability.

Deprecation MUST identify a replacement and a removal major version. A host MUST
emit an actionable diagnostic before accepting a deprecated version. No-overlap
negotiation failure MUST be reported before module creation.

## 13. Conformance

A conforming implementation MUST pass a portable, environment-independent process protocol
suite using a fake host, fake extension, and deterministic clocks and quotas.
The portable suite MUST cover at least:

- successful and failed protocol version negotiation;
- lifecycle ordering and idempotent stop;
- malformed, duplicate-key, oversized, reordered, and late messages;
- process crash, hang, forced cancellation, and restart with fresh handles;
- forged, cross-session, expired, and revoked capabilities, including omitted,
  partial, matching, and mismatched `moduleJobId` and `runId` fields;
- closing the capability session before a forced process signal, immediate
  denial of new calls, delivery of an abort signal, completion of active
  handlers, and `EXTENSION_TERMINATION_UNCONFIRMED` when completion exceeds the
  timeout;
- host denial of undeclared filesystem, network, listener, subprocess, and
  secret capability operations;
- quota enforcement and backpressure;
- configuration validation, every declared migration path, rollback, and
  capability reapproval after upgrade;
- Run retries preserving `moduleJobId`, changing `runId`, and deduplicating
  external operations by their idempotency keys;
- result validation and atomic commit; and
- redaction of logs and errors.

The portable suite cannot prove an operating-system sandbox. Every `sandbox`
backend MUST additionally pass platform integration tests
using a real malicious process that attempts ambient host secret reads,
filesystem/storage escape, undeclared network/listener/process access, resource
limit escape, cross-instance access, and authority retention after stop. A
platform that skips or cannot enforce one of those cases MUST NOT claim
`sandbox` conformance; it may still claim the portable process protocol or
`process` isolation accurately.

The portable suite also cannot prove executable-Module process ownership. The
Linux executable-Module backend MUST additionally pass the ADR 0009 required
failure tests, including whole-cgroup termination, launcher membership, and
durable submission and external-effect evidence, before Module activation is
claimed.

Conformance results MUST record the protocol version, capability schema
versions, host build, SDK build, test-suite revision, trust, isolation,
platform, and sandbox backend/version where applicable. Private infrastructure
and paid services MUST NOT be required to run either suite.
