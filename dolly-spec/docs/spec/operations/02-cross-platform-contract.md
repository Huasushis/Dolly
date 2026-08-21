# Linux and Windows Cross-Platform Contract

Status: normative platform mapping for Dolly v1.

## 1. Support levels

V1 supports Linux and Windows as runtime targets. macOS is build-and-unit-test only until a later specification defines lifecycle, IPC ACL, sandbox, and packaging behavior.

| Capability | Linux v1 | Windows v1 | macOS v1 |
| --- | --- | --- | --- |
| Foreground Worker | Required | Required | Build-only |
| Per-user daemon | Required | Required | Not specified |
| Multiple isolated instances | Required | Required | Not specified |
| Local privileged IPC | Unix Domain Socket | Named Pipe | Not specified |
| Child lifetime containment | process group plus supervisor/systemd scope | Job Object with kill-on-close | Not specified |
| Untrusted Extension sandbox | bubblewrap/user namespace policy or refuse to run | AppContainer policy or refuse to run | Refuse to run |
| SQLite durable storage | Required on local supported filesystem | Required on local NTFS/ReFS | Not specified |
| Transactional config and recovery | Required | Required | Not specified |
| Installer/service integration | package + systemd user unit | per-user package + logon/on-demand daemon | Not specified |

“Required” means the same observable state-machine and durability semantics pass platform CI. A feature **MUST NOT** be marked supported merely because it compiles.

## 2. Per-user daemon mapping

### 2.1 Linux

`dollyd` is a user process. Where systemd user services are available, the supported background integration is a `systemd --user` unit. Environments without systemd MAY run `dollyd` foreground or under a documented user supervisor, but process ownership and IPC permissions remain identical.

The daemon **MUST NOT** require root. System-wide multi-user daemon mode is outside v1.
The installed Linux process backend is narrower than platform-neutral Module
semantics. Its [activation authority contract](04-module-activation-authority.md)
accepts only a product-owned systemd user-service candidate and refuses that
backend on Windows or macOS before acquiring an instance lock or creating a
writable resource. A future Windows backend requires its own versioned service
or Job Object ownership premise; it MUST NOT reinterpret a Linux candidate,
process record, Ready response, result, acknowledgement, or absence as that
authority.

### 2.2 Windows

The v1 daemon is a per-user process launched on demand by the CLI and MAY be configured to start at user logon through Task Scheduler or the approved installer integration. It is not a machine-level Windows Service in v1.

Running as a Windows Service under `LocalSystem` while using an interactive user's `%APPDATA%` is non-conforming. A future service design requires an explicit account/profile and impersonation specification.

## 3. Standard directories

### 3.1 Linux

The implementation **MUST** use XDG locations, with these defaults when variables are absent:

| Purpose | Location |
| --- | --- |
| configuration | `${XDG_CONFIG_HOME:-$HOME/.config}/dolly` |
| durable data | `${XDG_DATA_HOME:-$HOME/.local/share}/dolly` |
| cache | `${XDG_CACHE_HOME:-$HOME/.cache}/dolly` |
| runtime IPC/PIDs | `${XDG_RUNTIME_DIR}/dolly` |

If `XDG_RUNTIME_DIR` is absent or insecure, the daemon **MUST** refuse background IPC or use a documented user-private runtime directory whose ownership and mode it verifies. It **MUST NOT** place privileged sockets in a world-writable directory without a private `0700` ancestor.

### 3.2 Windows

| Purpose | Location |
| --- | --- |
| roaming/user configuration | `%APPDATA%\Dolly` |
| durable local instance data | `%LOCALAPPDATA%\Dolly\data` |
| cache | `%LOCALAPPDATA%\Dolly\cache` |
| runtime records | `%LOCALAPPDATA%\Dolly\run` |

The implementation **MUST** resolve these through Windows known-folder APIs rather than trust an unvalidated environment string.

User-supplied data roots MAY override defaults only through validated offline configuration. Network shares and removable filesystems are unsupported for active v1 SQLite/lock state unless a later backend explicitly guarantees equivalent locking and durability.

## 4. Local IPC and ACLs

### 4.1 Linux UDS

The daemon control socket is `${XDG_RUNTIME_DIR}/dolly/dollyd.sock`. Its parent directory **MUST** be owned by the user and mode `0700`; the socket **MUST** be user-only. The daemon **MUST** reject symlinked socket paths and verify peer credentials where the platform provides them.

Stale socket cleanup is permitted only after acquiring the daemon ownership lock and confirming the path is a socket owned by the current user. A client **MUST NOT** unlink it.

### 4.2 Windows Named Pipe

The control pipe name derives from the current user's SID, not display name, for example `\\.\pipe\dolly-{SID}`. The daemon **MUST** create an explicit DACL granting the current user and required system principal only. `Everyone`, `Authenticated Users`, anonymous, and network clients are denied by default.

The server **MUST** reject remote pipe clients, verify the client token/SID when available, and disable unintended impersonation. Knowledge of the pipe name is not authorization.

### 4.3 Common protocol behavior

Platform IPC adapters **MUST** preserve message bytes and backpressure. They **MUST NOT** rely on line endings or terminal encoding. Disconnect is an indeterminate transport outcome and is resolved by durable operation ID.

## 5. Process creation and containment

Extensions and Workers **MUST** be spawned directly with an argument vector, never through a shell by default. Protocol text uses UTF-8; platform APIs convert paths losslessly at the boundary. The Host **MUST** close or mark non-inheritable every handle/file descriptor not explicitly needed.

### 5.1 Linux

The daemon places each Worker and its Extension descendants in a dedicated process group and, when managed by systemd, a unit/scope with kill semantics and resource policy. Each Worker **MUST** monitor an authenticated parent control pipe and **MUST** fence new work and exit when that pipe closes; a supported parent-death signal MAY provide an additional guard. V1 does not adopt a surviving Worker into a new daemon. Extension sandbox policy uses bubblewrap/user namespaces plus configured filesystem and network restrictions. Seccomp/cgroup controls SHOULD be used where available and their enforcement status recorded.

If required untrusted-sandbox primitives are unavailable or disabled by system policy, untrusted Extensions **MUST** be refused unless the administrator enables the audited unsafe override.

### 5.2 Windows

The daemon places each Worker tree in a Job Object owned by the daemon with `KILL_ON_JOB_CLOSE` and configured process/memory limits. Each Worker also monitors its authenticated parent control pipe. Closing the daemon's last Job handle or parent pipe **MUST** fence/terminate the old Worker tree; V1 does not adopt it. Job Objects provide lifecycle/resource containment, not filesystem or network isolation.

Untrusted Extensions require an AppContainer profile with explicit capabilities and brokered access. A restricted token without adequate filesystem/network containment is not sufficient to claim the untrusted sandbox. If AppContainer policy cannot be established, the Host **MUST** refuse untrusted Extensions unless the audited unsafe override is enabled.

## 6. Instance locks

Each instance has one lock file in its durable data root.

- Linux **MUST** use an advisory exclusive file lock held by an open descriptor for the entire write-capable Worker lifetime.
- Windows **MUST** use `LockFileEx` or an equivalently exclusive open/lock held by an open handle for the entire lifetime.

Lock-file metadata such as PID, start time, and Worker epoch is diagnostic only. Failure to acquire the lock is authoritative; implementations **MUST NOT** break a live lock based on PID text. Operating-system release on process death permits recovery, which then creates a new Worker epoch.

## 7. Paths, names, and Unicode

Protocol paths and configured identifiers are UTF-8 strings. The implementation **MUST** reject names that cannot be represented losslessly on the target platform or that collide after the target filesystem's case/Unicode behavior.

Stable Dolly IDs use the portable identifier grammar defined by the core specification and **MUST NOT** depend on path case. File-import APIs additionally **MUST** handle:

- `/` versus `\` separators;
- drive-relative and drive-absolute paths;
- UNC and device namespaces;
- Windows reserved device names and trailing dot/space behavior;
- alternate data streams;
- Linux symlinks and mount crossings;
- Windows junctions and reparse points; and
- platform path-length limits.

The Host **MUST** use native wide-character Windows APIs. It **MUST NOT** round-trip Windows paths through a legacy code page.

## 8. Atomic file publication and durability

Writers **MUST** create a private temporary file in the destination filesystem, write and flush content, verify digest/schema, and atomically replace/publish it with the platform primitive. Temporary files **MUST** use restrictive ACL/mode and exclusive creation.

- Linux uses same-filesystem `rename`/`renameat` semantics and, where durability is required, flushes the file and containing directory.
- Windows uses `ReplaceFileW` or the documented same-volume atomic replacement primitive, flushes file buffers where durability is required, and handles sharing violations with bounded retry.

An implementation **MUST NOT** assume rename is atomic across volumes. Failure before publication leaves the previous committed file authoritative; partial temporary files are recovery garbage, not active configuration.

## 9. SQLite contract

V1 SQLite databases **MUST** reside on a supported local filesystem with functioning byte-range locks. WAL and synchronous settings **MUST** be selected and recorded by the storage specification; platform adapters **MUST NOT** silently downgrade durability.

Busy/locked errors use bounded retry and surface typed failure when the deadline expires. Disk-full, I/O, corruption, and read-only transitions are distinct. A Worker **MUST** stop acknowledging durable work when it cannot commit the authoritative database.

The online backup API or a quiesced verified copy is required; copying live database files with ordinary file copy is forbidden.

## 10. Time and timers

Intervals, timeouts, debounce, lease expiry checks, and backoff **MUST** use a monotonic clock within one process lifetime. Persisted deadlines and user schedules use UTC instants plus the declared IANA timezone where civil-time meaning matters.

After restart, resume, wall-clock jump, or timezone database change, the Runtime **MUST** recompute monotonic timers from persisted wall-clock intent. Alarm policy **MUST** define DST gap/fold, missed-fire, and catch-up behavior; the platform adapter **MUST NOT** invent a different rule.

Leap seconds follow the operating system's UTC representation. Dolly does not assume every civil day is exactly 86,400 seconds.

## 11. Shutdown mapping

- Linux planned shutdown uses the control protocol; signals request the same state transition. `SIGKILL` is forceful and followed by recovery on restart.
- Windows planned shutdown uses the control protocol. Job termination or `TerminateProcess` is forceful and followed by recovery.

No platform-specific termination implies transaction rollback. Durable state and fencing decide recovery.

## 12. External tools

External binaries such as FFmpeg **MUST** be version-discovered, capability-tested, and invoked by absolute verified path with an argument vector. Absence or incompatible version yields an unavailable capability, not a malformed shell fallback.

A `bash` tool is Linux-specific. Windows command execution requires a separately declared PowerShell or process tool contract. Tool prompts **MUST NOT** assume one shell syntax across platforms.

## 13. Packaging and upgrades

Packages **MUST** preserve per-user data and use the configuration transaction/migration protocol. Uninstall **MUST NOT** silently delete instance data, logs, Assets, backups, or secrets. Service/logon integration removal and data removal are separate confirmed operations.

## 14. Cross-platform conformance matrix

Release CI **MUST** run real Linux and Windows tests for:

- foreground and background lifecycle;
- UDS/Named Pipe ACL and hostile-user access;
- exclusive lock and simultaneous start;
- process-tree cleanup and stale generation fencing;
- strict UTF-8 JSON and non-ASCII paths;
- case-collision/reserved-name/link traversal fixtures;
- atomic replace under sharing/open-file races;
- SQLite crash, busy, disk-full, backup, and restore;
- wall-clock jump, suspend/resume, timezone, and DST fixtures;
- untrusted-sandbox availability/refusal behavior; and
- identical normalized config and protocol digests.

Architecture support such as x86_64 or arm64 **MUST** be listed per release artifact. An untested architecture is not implied by the operating-system support claim.

## 15. Stable requirements and invariants

- `REQ-PLAT-001` — Linux and Windows expose the same Core, fencing, transaction, and recovery semantics through the unique mappings in this document.
- `REQ-PLAT-002` — Linux uses a per-user daemon, UDS, XDG directories, held file lock, process-group/parent-death containment, and enforced bubblewrap policy for untrusted Extensions.
- `REQ-PLAT-003` — Windows uses a per-user daemon, SID-scoped Named Pipe DACL, known folders, `LockFileEx`, Job Object, and AppContainer policy for untrusted Extensions.
- `INV-PLAT-001` — Platform path, clock, process, and filesystem differences never select a different semantic ordering or committed revision.
- `REQ-PLAT-004` — If the required untrusted sandbox is unavailable, the package is refused unless the administrator enables the persistent unsafe override.
