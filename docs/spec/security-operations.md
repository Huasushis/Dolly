# Security and Operations Specification

Status: Draft

This document proposes Dolly's security boundaries and operational contract for
the daemon, management console, interprocess communication (IPC), extensions,
and recovery. It applies even to a single-user local installation because browsers,
model output, extensions, local processes, and nearby network clients are
distinct trust domains.

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described by Request for Comments (RFC) 2119. Because this
document is a Draft, these
terms describe the proposed contract and do not claim current implementation
conformance.

## 1. Security objectives

Dolly MUST protect:

- provider and storage credentials;
- user prompts, model responses, media, and configuration;
- authority to start, stop, configure, or inspect modules;
- host files, network access, and child-process execution;
- daemon and registry integrity across crashes; and
- audit evidence needed to understand an administrative action.

Secure local operation is the default product mode. Remote or public operation
is an explicit deployment mode with additional requirements; it is never
enabled merely by changing a listen address.

## 2. Threat model

The design MUST account for these actors:

- an unauthenticated client on the same machine, local area network (LAN), or
  public network;
- a malicious webpage attempting cross-origin Hypertext Transfer Protocol
  (HTTP) or WebSocket control;
- another unprivileged local operating system (OS) user;
- a malicious, vulnerable, or compromised extension;
- prompt-injected or adversarial model/tool output;
- a compromised upstream model, relay, storage, or proxy endpoint; and
- ordinary crashes, partial writes, stale processes, and power loss.

The operating-system account running Dolly is trusted to administer its own
installation. Host administrators and code executing in the same unsandboxed
process are outside the isolation boundary. Documentation MUST state this
limit plainly.

Trust boundaries include browser-to-console, console-to-daemon,
supervisor-to-child, core-to-extension, Dolly-to-provider, Dolly-to-object
storage, and durable-state-to-running-process transitions. Data crossing a
boundary MUST be authenticated where an identity exists, schema validated,
bounded, and treated as untrusted until validated.

## 3. Network exposure defaults

The daemon, management console, health endpoint, and all administrative
application programming interfaces (APIs)
MUST bind only to a loopback address by default. Implementations SHOULD bind
both Internet Protocol version 4 (IPv4) and Internet Protocol version 6 (IPv6)
loopback deliberately or document which one is used. They
MUST NOT use an unspecified address such as `0.0.0.0` or `::` as a fallback.

A bind failure MUST stop startup with a clear error. The process MUST NOT retry
on a wider interface. Remote exposure requires an explicit deployment profile,
authenticated configuration, and the controls in section 12.

Discovery broadcasts, unauthenticated LAN pairing, and automatic port mapping
are outside the default mode and MUST NOT be enabled implicitly.

## 4. Console and application programming interface security

### 4.1 Authentication and authorization

Every API that reads private state or changes daemon, module, media, extension,
or configuration state MUST require authentication. Health endpoints exposed to
an untrusted network MUST reveal no configuration and MUST either be
authenticated or limited to a constant liveness result.

The local console MUST use a high-entropy bootstrap credential or equivalent OS
identity mechanism to establish an authenticated session. Credentials MUST NOT
appear in uniform resource locator (URL) query strings, process command lines,
browser local storage, or
logs. A browser session SHOULD use an `HttpOnly`, `SameSite=Strict` cookie; it
MUST also be `Secure` whenever Hypertext Transfer Protocol Secure (HTTPS) is
used. Session identifiers MUST rotate on
authentication and privilege changes and expire after bounded inactivity.

The baseline local bootstrap flow is an in-memory, single-use pairing code shown
only by an interactive `dolly console` command or supplied through an OS
credential broker. The browser submits the code in a same-origin HTTP `POST`
request to a
loopback-only endpoint. The code MUST expire within a short bounded interval,
be invalidated after one success, allow only a small number of rate-limited
attempts, and never be written to a URL, browser storage, config, or routine log.
The endpoint MUST validate an exact loopback `Host`/origin and exchange the code
for the HttpOnly session cookie plus the normal cross-site request forgery
(CSRF) mechanism. Headless service
deployment uses a protected pre-provisioned identity flow, not a printed default
password.

Administrative actions MUST be authorized independently of user interface (UI)
visibility. A
hidden or disabled button is not an authorization check. Public deployment
SHOULD separate read-only observation from administrative roles.

An unauthenticated development mode MAY exist only as an explicit test/developer
profile. It MUST bind to loopback, refuse to load production credentials, emit a
persistent warning, and be impossible to select through an untrusted request.

### 4.2 Origin, CSRF, and WebSocket controls

Browser APIs MUST use an exact origin allowlist and default to same-origin only.
Wildcard origins, reflecting an arbitrary `Origin`, and credentialed wildcard
Cross-Origin Resource Sharing (CORS) are forbidden.

State-changing HTTP requests authenticated by cookies MUST use CSRF protection
in addition to `SameSite`. WebSocket upgrades MUST authenticate before or during
the handshake and validate `Origin` against the exact allowlist. A WebSocket
credential MUST NOT be put in its URL. Each message MUST have a versioned schema,
an authorization decision, a size limit, and backpressure handling.

Connections MUST have idle timeouts, heartbeat policy, and per-session limits.
Malformed, oversized, or unauthorized messages MUST close or reject the request
without crashing the daemon or exposing a stack trace.

### 4.3 Browser content safety

Model output, extension strings, filenames, logs, and provider errors are
untrusted display data. The console MUST escape them by default. Any rich-text
renderer MUST use a reviewed sanitizer and disable active Hypertext Markup
Language (HTML), script URLs,
event handlers, and unexpected external resource loading.

The console MUST ship a restrictive Content Security Policy (CSP), deny framing unless
explicitly required, use media-type sniffing protection, and avoid third-party scripts
in the administrative origin. Frontend source maps, development endpoints, and
detailed stack traces MUST NOT be publicly served in production.

Secrets MUST be masked in the UI and MUST not be retrievable after submission
unless a dedicated, re-authenticated secret export operation exists. Clipboard
copy of a secret MUST be an explicit user action.

### 4.4 Request limits

All HTTP and WebSocket paths MUST have finite limits before parsing or buffering.
The Draft baseline is:

| Limit | Default |
| --- | ---: |
| Administrative JavaScript Object Notation (JSON) request | 1 mebibyte (MiB) |
| WebSocket message | 256 kibibytes (KiB) |
| Concurrent WebSockets per session | 4 |
| Header read timeout | 10 seconds |
| Administrative request timeout | 30 seconds |

Media bodies use the limits in `media.md` and MUST use a streaming endpoint.
Rate limits MUST exist for authentication, configuration mutation, module
control, expensive diagnostics, and provider-triggering operations. Operators
MAY tune finite values; public mode MUST NOT permit unbounded values.

The administrative JSON request limit is a ceiling, not only a default.
Operators MAY lower it, and an implementation SHOULD give individual routes
smaller limits than the baseline, but a configured value above 1 MiB MUST be
refused when the listener is constructed rather than accepted and applied. The
reason is that the whole administrative surface is bounded JSON control
messages: no administrative route needs a larger body, media and other large
payloads use their own streaming endpoints, and raising this limit only widens
what an authenticated-but-hostile client — or a cross-site request that has
defeated one other control — can make the daemon buffer before any
authorization decision. A deployment that believes it needs a larger
administrative body has an endpoint that should be streaming instead.

## 5. Transport Layer Security (TLS) and reverse proxies

Remote traffic MUST use authenticated HTTPS and secure WebSockets. Plain HTTP
Basic authentication is forbidden. A public deployment SHOULD terminate TLS at
a maintained reverse proxy or ingress and keep Dolly's upstream listener on a
loopback or private interface inaccessible to clients.

Dolly MUST trust forwarded scheme, address, host, or identity headers only from
an explicit proxy address allowlist. It MUST reject conflicting forwarding
headers and enforce an external host/origin allowlist. The proxy and Dolly MUST
both impose body, header, connection, and timeout limits.

Direct TLS termination MAY be supported if certificate loading, rotation, modern
protocol configuration, and failure behavior have equivalent tests. Merely
setting a password while binding plain HTTP to all interfaces is not a supported
remote-security profile.

## 6. Secret handling

Configuration SHOULD contain secret references, not secret values. Supported
sources MAY include an OS credential store, a restricted file, an injected
descriptor, or a narrowly scoped environment variable. Long-lived secrets MUST
be readable only by the Dolly service identity and SHOULD be replaceable without
editing extension source.

Secrets MUST NOT appear in:

- source code, examples, fixtures, snapshots, or published artifacts;
- command-line arguments, URLs, process titles, or routine status output;
- exception messages, access logs, traces, audit payloads, or metrics; or
- environment inherited by an extension that lacks the corresponding secret
  capability.

Configuration and secret files MUST use owner-only permissions: `0600` with a
`0700` parent directory on the Portable Operating System Interface (POSIX), and
an access control list (ACL) limited to the service identity and
required system administrators on Windows. Permission validation MUST fail
closed for public mode. UI and logs MUST redact access keys, bearer tokens,
cookies, passwords, signed media URLs, and authorization headers structurally,
not through a small list of literal names alone.

The system MUST support credential rotation and invalidate cached sessions or
signed access material where applicable. Tests MUST use deterministic fake
credentials; live credentials are opt-in integration fixtures only.

## 7. Daemon supervision

### 7.1 Generation-aware state machine

Each child spawn MUST receive a new unpredictable `processGenerationId`. This is
distinct from every extension `moduleGenerationId`. Supervisor
state MUST distinguish at least:

`stopped`, `starting`, `ready`, `running`, `stopping`, `backoff`, and `failed`.

Exit, error, timer, readiness, and health callbacks MUST include the process generation
they describe and MUST mutate state only if it is still current. An old process
event MUST never mark a newer process stopped, trigger a second restart, or
overwrite its process identifier (PID) or endpoint.

Start and stop commands MUST be serialized per instance and idempotent by
operation identifier (ID). A stop command sets intent before signaling the child, disables
automatic restart for that process generation, and waits for confirmed exit. After a
bounded graceful timeout the supervisor MAY escalate termination, but it MUST
verify process identity as described below.

A process launcher MUST reject its launch operation only when the operating
system reports that no child process was created. Once the operating system has
created the child, the launcher MUST immediately return a process handle bound
to that exact child, including its PID, process identity token, identity check,
and termination operation. Authentication, protocol, or control-channel
failure after creation MUST be reported as an event for that process
generation. The supervisor owns termination and MUST keep the generation active
until it observes the matching process exit.

### 7.2 Readiness and health

A spawned process is not running merely because a PID exists. The child MUST
complete an authenticated readiness handshake that includes:

- `processGenerationId` and instance identity;
- daemon and IPC protocol versions;
- actual bound endpoint(s);
- effective configuration revision/hash; and
- successful initialization of required durable state and listeners.

The supervisor MUST validate this message and enforce a readiness timeout.
Startup failure before readiness counts against the restart budget. Ongoing
health uses an authenticated request/heartbeat and MUST distinguish unresponsive
from exited. A static field on a registry object is not a health check.

To avoid a port allocation race, the child SHOULD bind port `0` and report the
actual endpoint in readiness, or inherit an already bound descriptor. A
probe-close-spawn sequence MUST NOT be used as proof that a port remains free.

### 7.3 Restart policy

Restart accounting belongs to the supervisor and MUST survive replacement of
the child object. The Draft default permits five unexpected exits in a rolling
five-minute window, with exponential backoff and jitter capped at 60 seconds.
The budget resets only after ten minutes of stable readiness, not on each spawn.

Exhausting the budget moves the instance to `failed`, preserves diagnostics, and
requires an explicit administrative retry or a documented cool-down policy.
Configuration/authentication failures SHOULD be classified as non-retryable.
Rapid infinite restart loops are forbidden.

### 7.4 Process identity and termination

A PID alone is not an identity because operating systems reuse PIDs. Durable
process records MUST include instance ID, process generation ID, PID, observed
process start time or OS identity token, and an authenticated IPC session
identity. Before sending
a signal to a recovered PID, Dolly MUST confirm that the live process matches
the stored identity through OS metadata and/or authenticated IPC.

If identity cannot be proven, Dolly MUST mark the record stale and MUST NOT kill
the process. Cleanup of a stale record and termination of a proven Dolly child
are separate audited operations.

This subsection governs daemon-managed Dolly instance processes. A Linux Module
child process is stricter: under Architecture Decision Record (ADR) 0009, Core
never signals a recovered PID for a Module process, even after an identity
check. Module termination uses only whole-control-group operations on the
non-reused Module control group, proven by `cgroup.events` reporting
`populated 0`.

### 7.5 Controller ownership and reattachment

The controller/supervisor and child have separate records:

- a `controllerLock` is an OS-backed exclusive lock held only while a foreground
  controller or daemon is authorized to mutate one instance; and
- a child process record identifies the live child by instance ID,
  `processGenerationId`, process identity, protocol version, and authenticated
  IPC session.

A **controller session identifier** is a fresh unpredictable identifier for one
authenticated controller-to-supervisor connection. It relates the existing
controller lock to commands for child process generations; a separate value is
necessary to reject delayed commands after a replacement controller attaches.

The controller lock MUST be automatically releasable when its owning controller
process dies. The child MUST NOT hold that lock. After acquiring an abandoned
controller lock, a replacement supervisor reconciles the child process record
before starting or signaling any process.

A daemon-managed child either exposes a reconnectable authenticated IPC endpoint
for a bounded orphan/reattach interval, or uses a tested parent-death mechanism
and exits when its inherited control channel dies. An inherited-only channel
without parent-death behavior MUST NOT be combined with a claim that a new daemon
can reattach. Reattachment performs a fresh challenge-response, creates a new
controller session identifier, and invalidates commands carrying the old
identifier. Failure to
prove identity leaves the process untouched and the instance visibly unresolved;
it does not authorize a duplicate spawn or PID-based kill.

## 8. IPC protocol

An inherited, OS-provided child IPC channel SHOULD be used for directly spawned
children that exit on parent/channel death. A reconnectable Unix-domain socket
or Windows named pipe is required when supervisor reattachment is supported.

Every IPC protocol MUST be:

- explicitly versioned and negotiated;
- framed before allocation with a 256 KiB default maximum control-frame size;
- authenticated per process generation with OS peer identity where available
  and a challenge-response protocol keyed by a fresh high-entropy session secret;
- schema validated with unknown message types rejected;
- correlated by request ID and bounded by a deadline;
- protected against replay where reconnect is possible; and
- subject to backpressure and connection-count limits.

Large media, logs, or dumps MUST NOT be embedded in control frames. They use a
separately authorized streaming or file-handle mechanism.

An IPC session secret SHOULD be inherited through an existing protected channel
or descriptor, not passed in a command line. If persisted for reconnection, it
MUST use the secret-file protections in section 6 and rotate for every process
generation and successful controller reattachment. A bare nonce echoed by the
client is not authentication. The handshake MUST bind instance ID, process
generation, controller session identifier, protocol version, both challenges,
and a transcript message authentication code (MAC); application frames then use
the negotiated session identity and replay/order protection.

Unix socket directories MUST be `0700` and sockets accessible only to the Dolly
service identity. Windows named pipes MUST use an ACL limited to the current
service security identifier (SID), user, and required system administrators.
Peer credentials SHOULD be
verified where the OS supports them. On Unix, a stale socket filesystem entry may
be unlinked only after directory ownership, expected path derivation, failed
authenticated connect, and instance identity checks. On Windows, named-pipe
instances are kernel objects rather than filesystem entries: recovery closes or
replaces only handles owned by the proven Dolly controller and never performs a
Unix-style unlink. Dolly MUST NOT remove or open an arbitrary endpoint name
supplied by extension, model, or IPC input.

## 9. Stable instance and configuration identity

Each managed instance MUST have a persisted random `instanceId` independent of
the current working directory, display name, port, PID, or config file text. A
canonical configuration location and immutable revision hash identify what was
loaded; they do not replace `instanceId`.

Initialization generates the ID in a versioned instance manifest/configuration;
legacy files require migration. Moving configuration performs an authenticated
`rebind` that updates its canonical locator while preserving identity. Creating
an independent copy performs `clone` and generates a new ID. Reusing a copied ID
as two local instances is a collision and MUST fail before either shares state.

State, locks, process records, audit logs, and IPC endpoints MUST live under a
stable per-user or service state directory, for example the platform's local app
data/state directory. Changing the launch directory MUST NOT create a second
identity or hide the first instance.

Configuration changes MUST be schema validated, written atomically, assigned a
new revision, and audited. Writers MUST use an inter-process lock or equivalent
compare-and-swap mechanism. A partial write or incompatible migration MUST leave
the last valid revision recoverable. Runtime status MUST report both desired and
effective revisions so an unsuccessful reload is visible.

If startup inspects a configuration before waiting for an instance controller
lock, it MUST re-read the configuration while holding the configuration-file
lock and compare both the instance ID and inspected revision. A mismatch MUST
fail before writing an instance registry record, state manifest, or any other
state for either identity.

The current runtime status schema is `dolly.runtime-status/3`. It includes
`providerAccessMarkedUnknownCount`, the number of URL-based provider requests
whose outcome became unknown during this startup and therefore still retain
Media access leases. The status value MUST expose only that count, never a
signed URL, Media ID, recipient, request ID, or credential. Operators use the
count to investigate incomplete provider work; expiry of a signed URL is not a
safe cleanup signal.

## 10. Extension isolation and model output

Third-party extensions are code, not passive configuration. The execution
trust and isolation fields in `extension-process-protocol.md` apply
independently. `ExtensionTrust` records the deployment's binary judgment about
the code that will run: `trusted` or `untrusted`. Built-in origin, review, or
approval may explain that judgment in audit information; they are not additional
runtime trust levels. `ExtensionIsolation` records the boundary actually
enforced. An `untrusted` Extension MUST use a passing platform-specific
`sandbox` backend. Ordinary `process` isolation separates process failures and
scrubs inherited environment state, but a direct child process alone does not
prove descendant containment, central processing unit (CPU) hang recovery, or
hard termination, and it
does not deny ambient filesystem, network, or subprocess access. It MUST NOT
be presented as a
security sandbox. Relevant capabilities include:

- network destinations;
- media access and remote fetch;
- granted filesystem roots;
- provider credentials or named secret use;
- child-process execution;
- durable storage quotas; and
- UI contribution privileges.

The default capability set is empty. Extensions receive only the individual
secret handles, Media capability handles, and operations they need; they MUST NOT
inherit the daemon's entire environment or filesystem authority. Core/extension
messages use the bounded, authenticated, versioned principles in section 8.

`mediaId` is a Core-managed identifier shared inside one Dolly instance so a
validated Block can pass a Media reference between Modules. It is not a secret,
but it is also not an Extension permission. The host may issue a Media
capability only from the exact `media-reference` values in Blocks already
delivered to the authenticated Module job. It MUST bind the grant to the
instance, Extension session, Module, delivered Block, Media identifier,
operation, byte limit, and crop boundary, and must reject a guessed identifier,
another Module's identifier, an undelivered Block, or a broadened crop.

The current Extension process implementation has not yet wired this Media
capability into its public protocol. It MUST deny direct raw-identifier Media
access, and product documentation MUST NOT claim that isolated Extensions can
read Media until the host-side scope validation and conformance suite exist.

A deployment MAY classify an Extension as `trusted` and use `none` isolation,
but the UI and documentation MUST state that it then has the daemon's full
authority. In-process execution is not a sandbox. If the current platform has
no passing sandbox backend, Dolly MUST refuse `untrusted` code rather than
silently downgrade its isolation.

An executable Module is stricter than a non-executable integration. On Linux,
ADR 0009 forbids `none` isolation for it and requires that the execution
backend keep the Module process and every descendant inside one non-reused
Module control group, terminate that whole group on stop, hard timeout,
failure, and replacement, and prove `populated 0` before any replacement or
Claim disposition. Before any of that, Core MUST hold the current controller
lock for the exact installation/instance identity and reopen the one shared
Runtime SQLite authority database under its required PRAGMAs. It verifies the
internal identity, schema version, current config mapping/revision/digest, and
complete premise records; a filesystem path or legacy JSON file cannot claim
or override them. A changed configuration transaction inserts all origins,
policy definitions, backend bindings, and service candidate before writing the
premise last and publishing the current pointer in one commit. No persistent
record serializes a live object, function, endpoint credential, secret, path,
capability, activation permission, runtime binding, stop prover, or recovery
handoff.

Core then proves in both directions that it is the main process of the
product-owned systemd user-service candidate. The candidate origin, unit name,
mode, and digest are lookup inputs, not authority: the service manager must
report this process as the unit's main process, and this process's own control
group, read from the process filesystem, must be the delegated subgroup inside
the manager-reported unit cgroup. An environment value, instance source field,
process record, Ready response, result, acknowledgement, or absence cannot
create that candidate or proof. Core MUST also confirm the effective restart,
kill, timeout, delegation, and control-group settings and fail closed on any
unreadable value. This verification and the persistent policy
definition/backend-binding chain remain prerequisites; current candidate
evidence does not satisfy the complete product composition, so Modules stay
disabled under `RUNTIME_MODULE_MIGRATION_REQUIRED`.
Claims, Module process records, and Module submission records live in one atomic Core-state update as defined by `core-runtime.md`,
and a submitted Run without a
committed result MUST NOT be automatically negatively acknowledged, released,
or retried unless the result journal and every possible external effect have
durable no-effect or retry-safe evidence. A `terminal` outcome proves that an
effect completed; without a separate durable idempotency or replay contract, it
does not authorize Core to repeat the Run automatically. A trusted Extension
with direct ambient effect authority is never automatically retried after such
a submission. The proposed first Linux Module profile will require a
configuration that declares Core-capability-only external effects, but the
existing version 1 process record is not proof that the declaration came from
that configuration: historical candidate code wrote the same value. Recovery
therefore preserves such records as unknown until a new record format binds the
declaration to the accepted configuration and execution boundary. Unknown
outcomes are preserved for the audited operator flow below.

Prompt text, model responses, tool arguments, generated blocks, and extension
payloads are untrusted data. They MUST NOT directly choose host paths, network
destinations, process arguments, credentials, or administrative actions. Such
operations require schema validation, an owning extension capability, and any
required user confirmation. Media-specific server-side request forgery (SSRF)
and local-file rules are in
`media.md`.

## 11. Audit, logging, and privacy

Security-relevant operations MUST emit structured audit events, including:

- authentication success/failure and session revocation;
- instance start, readiness, stop, restart, crash-loop failure, and stale-record
  cleanup;
- configuration and extension install/enable/capability changes;
- secret reference creation, rotation, and deletion without the secret value;
- preservation of a Module Claim as an unknown outcome, and every operator
  disposition of it; a forced Claim release MUST record the evidence
  considered and MUST warn that it can repeat an external effect before it is
  confirmed;
- public-exposure mode changes; and
- media remote upload/delete failures and administrative recovery.

Events MUST include timestamp, event type, result, request/operation ID, actor or
session identity, instance ID, `processGenerationId` or `moduleGenerationId`
where applicable, and configuration revision. They MUST exclude credentials,
signed URLs, raw media, full prompts,
and response bodies by default. Untrusted strings MUST be encoded so they cannot
forge log records.

For an unknown-outcome disposition, "record the evidence considered" means a
bounded, verifiable summary rather than a copy of user or provider content. The
request and result events record the digest of the complete evidence; the
canonical JSON digest, or `null` when absent, for the Module process record,
stop proof, submission record, and result journal entry; and, for each
external-effect intent, its stable intent ID, recorded outcome, and the
canonical JSON digest of its description. They MAY also record counts and
presence or status fields. They MUST NOT record the descriptions, journal
content, or other full evidence. These digests allow a later reviewer who
already holds the evidence to verify it; they do not reconstruct evidence that
has been deleted.

Operational logs MUST be structured, bounded, rotated, and protected with the
same ownership as state. Public error responses use stable error codes and
request IDs; stack traces and host paths remain local diagnostics. Metrics MUST
avoid user/content identifiers as labels.

Audit retention and deletion policy MUST be documented. A public or multi-user
deployment SHOULD send audit events to an append-oriented external sink so a
daemon compromise cannot silently rewrite the only copy.

## 12. Public deployment requirements

Public deployment is unsupported unless all of the following are true:

1. An explicit public/remote profile is enabled in local configuration.
2. A maintained TLS reverse proxy or equivalent authenticated TLS endpoint is
   configured; Dolly's upstream port is not directly internet-accessible.
3. Strong user authentication, session expiry, brute-force protection, and
   role-based authorization protect every non-public endpoint.
4. Exact host and origin allowlists, CSRF protection, secure cookies, WebSocket
   origin validation, and trusted-proxy restrictions are enabled.
5. Firewall, request/body limits, timeouts, concurrency limits, and rate limits
   are tested from outside the trusted network.
6. The console uses production CSP/security headers and serves no development
   tooling, directory listings, or credential-bearing diagnostics.
7. Secrets use a protected store, are absent from commands and logs, and have a
   documented rotation procedure.
8. Extension isolation and capabilities are enforced; unreviewed extensions do
   not run with daemon authority.
9. State backup, restore, audit export, upgrade rollback, and crash-loop recovery
   have been exercised.
10. Dependency/security update ownership and an incident response contact are
    documented.

An operator warning is not a substitute for a missing control. If any mandatory
control fails validation, public mode MUST refuse startup. The management
console SHOULD be further restricted by a virtual private network (VPN),
private access proxy, or equivalent
network policy even when application authentication is present.

## 13. Recovery and reconciliation

Startup MUST acquire the per-instance `controllerLock` before mutating state. It
then reconciles desired configuration, child process records, authenticated
IPC state, and actual child processes before it starts anything. Recovery MUST
distinguish:

- a proven live child that can be reattached;
- a proven dead child eligible for restart policy;
- an identity-mismatched or unverifiable PID that must not be signaled;
- a stale IPC endpoint safe to remove; and
- corrupt or incompatible durable state requiring safe mode.

Durable files MUST use atomic replacement and versioned schemas. Migrations MUST
be restartable and preserve a backup or equivalent rollback point. If state
integrity cannot be established, Dolly MUST enter a read-only or stopped safe
mode instead of guessing and launching duplicate children. The Core-state
document follows this rule concretely: an outdated version is refused at
startup, and the separate offline migration keeps the original bytes beside the
state file before it replaces the document, as `core-runtime.md` Section 7.7
describes.

Linux Module recovery MUST follow the fixed order defined by ADR 0009: verify
the Core service binding, prove every old Module control group empty before
marking its process record stopped, check that each Module submission record
matches its exact active Claim and reject a terminal Claim beside a submission
record, recover the result journal through the allowed `prepared` and
`committed` states, and only then apply a permitted disposition to remaining
Claims. A committed journal record belongs beside its exact committed Claim and
no submission record; it is not an alternative match for a submission record.
The current file-based Core-state store (`FileCoreStateStore`) validates every
submission record that exists against its exact active Claim, process record,
and persisted input when it opens state and at the submission and terminal
mutation boundaries. It does not interpret an absent submission record as
proof that a Run was never submitted.
Startup reconciliation enforces the order above when its stop-proof and
external-effect evidence sources are supplied. This enforcement cannot
determine whether an active Claim whose submission record is missing from
historical version 16 state was never submitted or lost its record through an
earlier writer, so that Claim remains unresolved. Product startup still rejects
configured Modules and does not connect the existing Linux process-control,
execution, and stop-proof implementations to the runtime. Recovery never
assumes a Module process died because its record is old or its process
identifier is gone.

### 13.1 Unknown Module outcomes

A Module Claim preserved as an unknown outcome is the state Core reaches when
it cannot prove from durable evidence whether a submitted Run took effect.
Startup and every stop path report it rather than guessing; the Claim stays
active and its Module stays inactive.

Resolving one is an explicit operator action, never an automatic one. The
operator interface MUST:

1. identify the exact Claim (`moduleJobId`, claim token, `runId`, attempt, and
   `moduleGenerationId`) and show the evidence Core actually considered: the
   Module process record and its stop proof, the submission record or its
   absence, the result journal entry or its absence, and each external-effect
   intent with its recorded outcome;
2. offer only dispositions whose consequence is stated plainly: release for
   another attempt, dead letter, or leave unresolved;
3. require an explicit confirmation for a forced release that warns it can
   repeat an external effect known to have completed or not proven absent; and
4. emit `console.claim.unknown-outcome.disposition-requested`, recording the
   actor, chosen disposition, and bounded evidence summary from section 11
   before applying it, then emit
   `console.claim.unknown-outcome.disposition` with actual success or failure.

The Hypertext Transfer Protocol (HTTP) application programming interface (API)
and command-line interface (CLI) forced-release responses both use wire schema
`dolly.unknown-outcome-warning/2`. Its
`externalEffectsThatMayRepeat` array contains each effect whose
`recordedOutcome` is `terminal` or `unknown`, including its `intentId`,
description, and recorded outcome. `terminal` means the effect is known to have
completed; `unknown` means completion cannot be ruled out. Both can be repeated
by another Run. The version 1 field `unprovenExternalEffects` named only effects
with an `unknown` outcome; version 2 does not reuse that field name for the
broader set. Issuing this response records the stable event type
`console.claim.unknown-outcome.warning-issued`.

When an audited disposition makes a submitted Claim terminal, Core MUST remove
the matching Module submission record in the same Core-state update as the
Claim transition. The same update MUST first compare the evidence digest shown
to the operator with the current evidence and MUST reject a mismatch before
changing either record. Inspection before and after separate terminal
operations does not satisfy this atomic comparison.

Construction of evidence for this operator flow MUST reject, rather than
truncate, more than 1,024 external-effect intents, an intent description or
the value of `preservedReason` longer than 8,192 UTF-8 bytes, duplicate or invalid
intent IDs, or a complete evidence value larger than 1,048,576 canonical JSON
bytes. Claim, run, Module, generation, and intent identifiers are limited to
128 characters by the identifier grammar used by Core.

`preservedReason` is the operator-facing explanation of why Core refused an
automatic decision; it is not proof that an effect did or did not occur. An
entry in `externalEffectIntents` describes one possible external effect:
`intentId` is its stable identifier, `description` is the bounded explanation
shown to the operator, and `recordedOutcome` is the durable status Core
considered.

An operator disposition MUST NOT weaken the automatic rules: it never converts
missing evidence into proof, and Core still refuses to start a replacement
Module generation until the old Module control group is proven empty.

Recovery actions MUST be idempotent and audited. Operator tooling SHOULD expose
the evidence used for a decision (generation, process start time, readiness,
config revision, last error) without exposing secrets.

## 14. Required conformance tests

Acceptance of this specification requires automated tests for at least:

1. loopback-only default binding and refusal to widen after bind failure;
2. authentication on every private/read and state-changing HTTP route;
3. exact CORS/Origin, CSRF, and WebSocket upgrade rejection cases, including a
   malicious webpage origin, plus one-time pairing-code expiry, attempt limits,
   single consumption, loopback Host validation, and cookie exchange;
4. absence of credentials from URLs, process arguments, browser storage, logs,
   errors, and extension environments;
5. request, header, frame, connection, rate, idle, and timeout limits before
   unbounded allocation;
6. sanitized rendering of model, extension, filename, and log payloads plus CSP
   enforcement;
7. reverse-proxy allowlisting and rejection of spoofed forwarded headers;
8. a delayed exit/error from process generation N that cannot mutate process
   generation N+1;
9. readiness timeout, wrong process generation/version/config hash, and bind
   failure;
10. restart-budget persistence across child replacement, stable-period reset,
    backoff, and terminal `failed` state;
11. graceful stop, controller crash/lock release, authenticated child reattach,
    orphan timeout, escalation, PID reuse, identity mismatch, and the guarantee
    that an unverifiable PID is never killed or duplicated;
12. IPC challenge-response authentication, controller session replacement, version
    negotiation, replay, malformed framing, oversized frames, timeouts,
    backpressure, Unix socket cleanup, and Windows named-pipe permissions;
13. stable instance identity across working directories, ports, restarts,
    configuration revisions, rebind/move, clone, and copied-ID collision;
14. atomic config writes, interrupted migrations, single-instance locking, and
    recovery into safe mode;
15. audit completeness, log-injection resistance, rotation, permissions, and
    structural redaction;
16. portable extension capability denial plus real per-platform sandbox tests
    for ambient environment, filesystem, network, process, media, resource, and
    secret access;
17. public-profile startup refusing each missing mandatory control; and
18. for a Linux executable Module, the ADR 0009 required failure tests: the
    two-direction Core service binding check and each rejected unit setting,
    child-launcher control-group membership verified before `exec`, whole-group
    termination proven by `populated 0`, and Core-state reconciliation of
    Module process records, Module submission records, and Claims.

Tests that assert only a status field or URL string are insufficient. Process
tests MUST use real child lifecycles and injected timing races. Network tests
MUST exercise real HTTP/WebSocket handshakes at loopback boundaries. Secret and
permission tests MUST inspect the actual spawned process environment, command
line, filesystem ACL/mode, and emitted logs on supported platforms.

## 15. Migration impact

Adopting this Draft requires replacing unauthenticated console and IPC paths,
removing unspecified-address defaults, introducing stable instance/generation
identity, and making restart accounting supervisor-owned. Existing state files,
PID records, and configuration secrets require a versioned migration. Until the
security tests above pass, Dolly MUST be documented as local development
software and MUST NOT be presented as safe for public exposure.
