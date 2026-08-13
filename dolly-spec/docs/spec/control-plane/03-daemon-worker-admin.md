# Daemon, Worker, and Administrative Control Plane

Status: normative for process ownership, instance lifecycle, local administration, and authentication.

## 1. Process model

`dollyd` is a per-user Supervisor. Each configured Dolly instance runs in a separate Runtime Worker process. Extension processes are children of one Worker generation.

The daemon owns:

- instance discovery and lifecycle intent;
- authenticated administrative APIs;
- Worker process supervision;
- configuration transactions;
- log/health aggregation; and
- recovery orchestration.

A Worker owns one instance's Runtime, storage connections, Page/Activation state, and Extension Host. One Worker failure **MUST NOT** terminate another instance.

`dolly run --config ...` runs the same Worker implementation without `dollyd`. It **MUST** acquire the same exclusive instance lock and obey the same storage and protocol semantics. It **MUST NOT** silently attach to or take over an instance owned by the daemon.

## 2. Instance lifecycle

The daemon persists desired state separately from observed process state.

```text
Stopped -> Starting -> Running -> Stopping -> Stopped
Starting/Running -> Unhealthy -> RestartBackoff -> Starting
Starting/Running/Unhealthy -> Quarantined
Running/Unhealthy -> Degraded
Degraded -> Stopping or explicit Repairing
```

Administrative start, stop, restart, and repair operations **MUST** have idempotent operation IDs. Repeating an operation with the same ID returns its durable status.

`Running` means the Worker holds the instance lock, storage migrations are complete, the control API is ready, and required core services passed readiness. It does not require every optional Extension to be healthy. Required-vs-optional status **MUST** be explicit.

`Unhealthy` means supervision **MAY** restart without a configuration transaction. `Degraded` means state/revision convergence is not proven and **MUST NOT** be hidden by process restart. `Quarantined` prevents automatic restart until authenticated repair.

## 3. Exclusive ownership

Before opening instance storage for write, a Worker **MUST** acquire the platform-defined exclusive lock and create a Worker epoch. It **MUST** hold the lock for the complete write-capable lifetime.

Lock metadata MAY contain PID and diagnostics, but PID liveness is not authority. A second Worker that cannot acquire the lock **MUST** fail clearly and **MUST NOT** open the database in write mode.

The daemon **MUST** place each Worker and its Extension descendants in the platform lifecycle container. When a Worker exits, the daemon **MUST** terminate or fence its descendants before starting a replacement. A replacement uses a new Worker epoch.

V1 does not adopt Workers after a daemon restart. Loss of the authenticated daemon-parent channel **MUST** cause each Worker to fence new work and terminate through the platform parent-death mechanism. A new daemon recovers the instance under a new Worker epoch after exclusive ownership is re-established.

## 4. Administrative API surfaces

The control plane has two surfaces:

1. local privileged IPC used by the CLI and daemon/Worker supervision; and
2. optional loopback HTTP/WebSocket used by the administrative UI.

Both surfaces **MUST** use versioned schemas, bounded request bodies, stable structured errors, operation IDs for mutations, and revision preconditions for configuration writes.

The local IPC endpoint **MUST** apply the UDS or Named Pipe access-control rules in the cross-platform contract. Filesystem possession of a socket path or knowledge of a pipe name is not sufficient authorization when peer identity is available.

The HTTP listener **MUST** bind only to `127.0.0.1` and `::1` by default. Binding a non-loopback address is a high-risk configuration change requiring explicit administrator approval, TLS termination, trusted-proxy policy, and an audit event.

## 5. Principals and scopes

Administrative authorization **MUST** distinguish at least:

- read health/log metadata;
- read sensitive payloads;
- operate instance lifecycle;
- propose configuration;
- approve elevated configuration;
- manage Extensions/capabilities;
- read or export user data; and
- destructive repair/restore.

The chat/Channel UI and administrative UI are separate security domains. A conversation session **MUST NOT** gain admin authority merely because both are served on one origin or port. Routes, cookies/tokens, scopes, and WebSocket authorization **MUST** be separable, and deployments **MUST** be able to disable the admin UI while retaining Channel service.

## 6. Bootstrap and local authentication

On first start, the daemon **MUST** generate a cryptographically random bootstrap credential. It stores only an Argon2id verifier with recorded parameters. The credential **MUST** be shown through a local protected channel and **MUST** be rotated or disabled after administrator enrollment according to policy.

CLI authentication uses a random local token stored in a user-only file or operating-system credential facility. The token file **MUST** use mode `0600` on Unix and a DACL limited to the current user on Windows. Tokens **MUST** have identifier, scopes, creation time, optional expiry, and revocation status; raw values **MUST NOT** appear in logs.

Local peer credentials MAY replace a bearer token only where the platform API authenticates the expected user and the policy explicitly allows it.

## 7. Browser session security

The admin UI **MUST** use HttpOnly, SameSite=Strict session cookies. When served through HTTPS, cookies **MUST** also be Secure. State-changing requests **MUST** require a CSRF token bound to the session and **MUST** validate `Origin`; WebSocket upgrades **MUST** validate both session authorization and Origin.

CORS is disabled by default. Enabling an origin requires an exact allowlist; wildcard credentials are forbidden. Authentication responses **MUST** be rate-limited and **MUST NOT** reveal whether a token identifier is valid beyond what the protocol requires.

Reverse-proxy headers are ignored unless the direct peer is in an explicit trusted-proxy allowlist. Remote deployment guidance **SHOULD** prefer SSH tunnel, private overlay network, or a reviewed TLS reverse proxy rather than direct exposure.

## 8. Worker supervision

The daemon **MUST** record spawn intent before creating a Worker and record observed exit with Worker epoch, generation, exit status, and bounded diagnostics. It **MUST** distinguish clean stop, crash, protocol/security quarantine, configuration `Degraded`, and operator kill.

Automatic restart uses bounded backoff and a crash-loop threshold. It **MUST NOT** restart a Worker whose instance is `Degraded` if restart could overwrite or obscure recovery evidence.

Health endpoints **MUST** separate:

- liveness: event loop can respond;
- readiness: instance can accept its configured work;
- durability: storage/journal can commit;
- dependency health: Extension/Provider/Asset backends; and
- configuration convergence: all required participants match active revision.

A liveness success **MUST NOT** override a failed durability or convergence status.

## 9. Shutdown and orphan cleanup

On requested stop, the daemon sends a bounded graceful shutdown to the Worker. The Worker fences new Activations, drains according to policy, checkpoints durable intent, shuts down Extensions, closes storage, and releases the instance lock.

If the Worker misses its deadline, the daemon uses the platform termination sequence. Forceful kill **MUST** be recorded and recovery **MUST** run on next start before new work.

The daemon **MUST** use the Worker epoch and platform lifecycle container, not PID alone, to identify descendants. An orphan that cannot authenticate to the current Worker's private IPC cannot commit Host state even if termination fails.

## 10. Administrative audit

The daemon **MUST** journal authentication enrollment/revocation, lifecycle mutations, configuration proposals and approvals, capability changes, package installation, remote binding, payload-log enablement, backup/restore, and destructive repair.

An audit event **MUST** contain authoritative principal, operation ID, instance, timestamp, result, revision where relevant, and redacted diff/digest. User-supplied reason text is untrusted and bounded.

## 11. API failure behavior

Administrative mutations are asynchronous durable operations. A client timeout does not cancel or roll back an operation. The client **MUST** query by operation ID.

The API **MUST** distinguish:

- authentication failure;
- authorization denial;
- revision conflict;
- validation failure;
- operation in progress;
- resource exhaustion;
- quarantined state;
- degraded state; and
- retryable transport/dependency failure.

It **MUST NOT** map these all to a generic HTTP 500 or a textual CLI error.

## 12. Conformance tests

Tests **MUST** cover:

- simultaneous foreground and daemon start of one instance;
- daemon and Worker crash in every lifecycle state;
- orphan Extension fencing and PID reuse;
- local IPC access by another user;
- Named Pipe remote-client and DACL checks;
- UDS permissions and peer credentials;
- CSRF, Origin, CORS, cookie, and WebSocket attacks;
- token rotation/revocation and log redaction;
- idempotent retry after client timeout; and
- separation of Channel and admin authority.

## 13. Stable requirements and invariants

- `INV-ADMIN-001` — At most one write-capable Worker owns an instance, proven by the exclusive lock and Worker epoch rather than PID text.
- `INV-ADMIN-002` — Channel authority never implies administrative authority.
- `REQ-ADMIN-001` — Local control IPC is user-restricted by UDS/Named Pipe ACL and peer checks.
- `REQ-ADMIN-002` — V1 does not adopt Workers across daemon restart; loss of the authenticated parent channel fences and terminates them.
- `REQ-ADMIN-003` — Administrative mutations are durable idempotent operations whose outcome is queried by operation ID after transport loss.
