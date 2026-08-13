# Threat Model and Security Requirements

Status: normative security baseline for Dolly v1.

`REQ-SEC-001` — A Dolly v1 distribution MUST satisfy every normative trust
boundary, capability, sandbox, supply-chain, input, secret, isolation,
resource, audit, and security-test obligation in this chapter. A missing
platform control MUST be reported as an unsupported trust class, never hidden
behind the phrase “process isolated.”

## 1. Protected assets

Dolly **MUST** protect at least:

- instance configuration and revision history;
- Block, Page, Memory, Asset, Provider transcript, and tool data;
- API keys, session credentials, local control tokens, and capability grants;
- Runtime and Extension state integrity;
- admin and Channel identity boundaries;
- audit/event journals and backup integrity;
- host filesystem, network, processes, and user account; and
- availability against bounded resource abuse.

Confidentiality, integrity, and availability requirements apply to diagnostic and historical copies as well as active data.

## 2. Trust boundaries and actors

The following boundaries **MUST** be explicit in implementation and documentation:

1. browser or CLI to daemon/admin API;
2. external Channel user to Channel Extension and Runtime;
3. daemon to each Worker;
4. Worker Host to each Extension process;
5. LLM Extension to the Host Tool Broker, and the Host Tool Broker to MCP or
   workspace tool servers;
6. Host/Model Gateway to remote Providers;
7. Host to remote URL, OSS, or other storage backend;
8. one Dolly instance/session/user scope to another; and
9. active storage to backups, logs, exports, and research artifacts.

Inputs from users, websites, model responses, Blocks, Memory, Skills, Extension metadata, package archives, filenames, logs, Provider responses, and remote servers are untrusted unless a narrower policy says otherwise.

The local operating-system user and verified Dolly core binaries are trusted for v1. Compromise of the kernel, administrator/root account, hardware, or trusted core release-signing key is outside the containment guarantee, but detection and recovery documentation **SHOULD** address it.

## 3. Extension trust classes

Every installed Extension package **MUST** have one trust class:

- `bundled_trusted`: shipped and signed as part of the reviewed Dolly release;
- `approved_signed`: signature and publisher policy verified, with explicit administrator approval; or
- `third_party_untrusted`: every other package, including local development builds unless explicitly elevated.

Third-party Extensions are untrusted by default. They receive no ambient filesystem, network, process, secret, model, Block, Asset, configuration, or telemetry authority. Capabilities are granted deny-by-default and scoped as specified by the Host-service contract.

Process separation alone is not a sandbox. If a platform cannot enforce the configured untrusted sandbox, the Host **MUST** refuse to run a `third_party_untrusted` package. An administrator MAY enable an unsafe override, but the UI/CLI **MUST** describe that it grants user-account-equivalent code execution, require elevated approval, persist an audit event, and expose a continuous unhealthy security warning.

## 4. Package and supply-chain security

Before installation or execution the Host **MUST**:

- compute and persist a cryptographic package digest;
- validate manifest and schema before executing package code;
- enforce exact package identity/version/digest selection;
- verify signatures when trust policy requires them;
- reject absolute paths, `..`, device names, alternate data streams, links, and archive entries escaping the staging root;
- enforce archive entry count, compressed/uncompressed byte, nesting, and expansion-ratio limits;
- install into a new immutable digest directory; and
- avoid invoking installers or Extensions through a shell.

Replacing bytes under an installed digest/version is forbidden. Revoked or policy-blocked packages **MUST NOT** start new generations. Running revoked generations **SHOULD** be fenced promptly according to incident policy.

Publisher signatures do not grant capabilities automatically.

## 5. Capability and sandbox invariants

The effective capability set is the intersection of package request, instance policy, administrator approval, Module scope, platform enforcement, and current generation. Absence from any one set denies access.

The Host **MUST**:

- bind grants to private connection, Worker epoch, and Extension generation;
- clear unneeded environment variables and inherited handles;
- set a private controlled working directory;
- broker Runtime objects through Host services;
- enforce CPU, memory, process, handle/file, disk, RPC, telemetry, network, model, and wakeup quotas; and
- revoke grants on drain, exit, policy change, or generation replacement.

The sandbox **MUST** prevent direct access that would bypass Host-service auditing. Unsupported controls **MUST** be reported as unenforced; they MUST NOT be represented as successful isolation.

## 6. Prompt injection and confused-deputy defense

Model output, retrieved Memory, web content, tool output, Block metadata, Descriptor prose, and Skill instructions can contain hostile instructions. Trust labels **MUST** survive ingestion, retrieval, forwarding, and context compilation.

Untrusted content **MUST NOT**:

- enter a system/developer-equivalent prompt segment reserved for trusted policy;
- create or expand a capability grant;
- approve configuration or destructive operations;
- select another user's/session's data scope;
- supply an unreviewed shell command directly to a privileged executor; or
- suppress audit and confirmation requirements.

Tool authorization is evaluated at execution time against the authenticated user, Module, current Activation, operation arguments, and policy. A model's statement that an action is safe is not authorization.

High-risk tools such as arbitrary process execution, external messaging, account changes, destructive file edits, credential access, or broad web automation **MUST** have explicit policy and, where configured, human confirmation. Confirmation binds exact normalized arguments and expires after material change.

## 7. SSRF and remote content

Remote fetch is deny-by-default for untrusted Extensions and is performed by a broker. The broker **MUST**:

- allow only configured schemes, normally HTTPS and explicitly allowed HTTP;
- parse URLs with one standards-compliant parser and reject embedded credentials unless explicitly required;
- resolve all address records and deny loopback, unspecified, link-local, private, multicast, carrier-grade NAT, documentation/reserved, metadata-service, and policy-denied networks;
- re-check the actual connected address to prevent DNS rebinding;
- repeat all checks for every redirect and bound redirect count;
- deny `file:`, local sockets, pipes, unsupported protocols, and URL-to-local-path conversions;
- bound connection, header, idle, total-time, response-byte, decompression, and content-decoder resources; and
- avoid forwarding ambient cookies, Authorization, proxy credentials, or internal headers.

An allowlist MAY permit a denied range for a named integration. It **MUST** scope scheme, host, port, path where possible, and capability principal. Wildcard internal-network access is high risk.

## 8. Filesystem and path safety

Every file operation **MUST** start from an authorized root/handle, not an attacker-controlled absolute path. The implementation **MUST** reject NUL, traversal, platform device names, unsupported alternate streams, and components outside schema limits.

Authorization **MUST** remain valid at open time. A string `canonicalize` followed by an ordinary open is insufficient. Linux implementations SHOULD use directory handles and no-follow/open-beneath primitives; Windows implementations SHOULD inspect and constrain reparse points and open relative to authorized handles where available.

Symlink, junction, mount, and hard-link attacks **MUST** be considered for read, write, rename, delete, import, archive extraction, and workspace tools. Temporary files **MUST** be created with exclusive creation and restrictive permissions in an authorized directory. Publication **MUST** use the platform atomic-replace contract.

## 9. Asset and decoder safety

Declared MIME type is untrusted. Asset ingestion **MUST** hash and validate bytes before publication, retain observed size/type metadata, and enforce content and decoder limits.

Image/video/audio/archive/document processing **MUST** bound dimensions, frames/pages, duration, recursion, decompressed size, CPU, memory, and subprocess time. Decoders and FFmpeg-like helpers **MUST** run with the least privilege and without ambient network access unless required.

Content-addressed identity does not itself authorize access. The Host **MUST** check instance/session/object reachability before disclosing whether a hash exists, preventing cross-scope hash-oracle leakage.

## 10. Resource exhaustion

Every untrusted cardinality and byte stream **MUST** have a limit, including:

- protocol frames, nesting, strings, arrays, outstanding IDs, and queued bytes;
- Page backlog and per-subscriber lag;
- Blocks, Parts, Actions, references, trace fan-out, and hop count;
- pins, leases, Assets, views, wakeups, background jobs, and retries;
- log bytes and metric label cardinality;
- model tokens, concurrent calls, rate, and cost; and
- tool output, file reads, browser artifacts, and downloads.

Quota exhaustion **MUST** produce a typed observable outcome. Durable Pages **MUST** backpressure or reject writes rather than silently discard unacknowledged records. Repeated quota evasion MAY quarantine the principal.

Retry policy **MUST** be bounded and apply backoff. An attacker-controlled failure **MUST NOT** cause an infinite retry, crash, log, or billing loop.

## 11. Secrets

Secrets **MUST** be referenced by opaque `secret_ref` values in configuration. Raw secrets **MUST NOT** appear in configuration history, Extension environment/arguments, Event Journal, standard logs, metrics, panic reports, URLs, or ordinary backups.

The Model Gateway or owning broker uses the secret and returns only the authorized result. Secret stores **MUST** use user-only operating-system access controls and SHOULD use the platform credential facility when available. Rotation and revocation **MUST** take effect without revealing the old value.

Redaction is defense in depth, not permission to log secrets. Payload logging is disabled by default, separately authorized, bounded, retained briefly, and visibly warned.

## 12. Admin and Channel isolation

Admin and conversation authority are separate even when served by one process. Session cookies/tokens, routes, WebSocket authorization, CORS, CSRF, and scopes **MUST** enforce that separation.

Local UDS and Named Pipe endpoints **MUST** use user-only ACLs and peer checks. Network listeners bind loopback by default. A reverse proxy is trusted only when explicitly allowlisted, and forwarded identity/address headers from other peers are ignored.

Brute force, token replay, session fixation, cross-origin WebSocket, CSRF, malicious redirects, and stale-token use **MUST** be covered by security tests.

## 13. Data separation, retention, and deletion

Every Block, Asset, Memory record, Provider transcript, tool artifact, and export **MUST** carry enough scope to enforce instance and, where configured, user/session isolation. Retrieval and diagnostic APIs **MUST** apply the same scope rules as primary APIs.

Deletion **MUST** account for references, backups, legal/retention policy, remote copies, and audit requirements. The system **MUST NOT** claim immediate erasure when a retained backup or Provider copy remains. Conversely, GC **MUST NOT** delete a reachable object because an untrusted hint requested it.

Research datasets and raw runs containing user data require an explicit export, redaction, and retention policy. They are not implicitly authorized by enabling research features.

## 14. Audit and incident detection

Security-relevant actions **MUST** emit structured audit events with authoritative principal, instance, operation ID, policy revision, result, and redacted object identifiers. Audit records **SHOULD** be append-only and integrity-protected against ordinary application edits.

At minimum, detection covers repeated authentication failure, capability denial, sandbox weakening, package verification failure, path/SSRF attempts, protocol/resource abuse, secret access, remote admin binding, destructive configuration, backup/restore, and audit/payload-log policy changes.

## 15. Security conformance gate

A v1 release **MUST NOT** claim support for untrusted Extensions until adversarial tests cover package extraction, sandbox escape attempts within the documented boundary, capability bypass, stale generation, SSRF including DNS rebinding/redirects, path and link races, decoder bombs, RPC/log/metric floods, prompt-injection confused deputy, cross-session retrieval, local IPC ACLs, and admin browser attacks on every supported platform.

## 16. Stable requirements and invariants

- `INV-SEC-002` — Third-party Extension code is untrusted and receives no ambient authority; process separation alone is never represented as a sandbox.
- `INV-SEC-003` — Content trust labels survive storage and context compilation and cannot escalate tool, configuration, or data authority.
- `REQ-SEC-002` — Remote fetch revalidates scheme, destination address, redirect, byte/time bounds, and credential forwarding at every hop.
- `REQ-SEC-003` — File authority is root/handle scoped and remains valid at open time across symlink, junction, reparse, mount, and race attacks.
- `REQ-SEC-004` — Every attacker-controlled byte stream and cardinality is bounded with a typed observable quota outcome.
