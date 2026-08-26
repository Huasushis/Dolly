# Worker-Host Launch Contract

Status: Implemented (bounded scope defined below)

This section defines the implemented contract for launching the installed
`worker_host` binary from the Host process. It uses only established Dolly
concepts: the Runtime authority database, the Host-owned authority writer,
and the frozen worker-host control framing profile.

## Premise projection (Host-owned, single producer)

A **Worker-start premise** is a Host-sealed durable launch record: it fixes
the current configuration revision and its digest, one extension/server
identity pair, and the installed package/executable paths together with
their digests and endpoint. It is written into the Runtime authority
database next to the authority snapshot that authorized it, and Worker
startup consumes it instead of accepting locations or digests from any
caller. The plain term "configuration" is insufficient because a premise
freezes exactly one launch identity and its installed bytes for a single
extension server, not the whole runtime configuration.

The Host owns exactly one producer of a Worker-start premise:
`RuntimeAuthorityDatabase.installWorkerStartPremise`. The TypeScript
authority writer is the only component allowed to write or seal premise
records. The Rust storage crate deliberately exposes no public write, seal,
or schema-creation API for premises.

A premise is projected per (current config revision, extension alias,
server id). The table's primary key is that triple; the foreign key to
`(config_revision, config_digest)` on `config_revision_mappings` is kept.
Re-projecting an identical premise for one identity pair is idempotent;
a conflicting rewrite for the same pair fails closed with
`WORKER_START_PREMISE_CONFLICT`. Distinct identity pairs of one revision
coexist as separate rows.

## Read-only canonical preflight

Before any writable open, the consumer performs one read-only preflight:

1. open SQLite read-only (`query_only` set);
2. verify the exact Host-authority and worker-start-premise schemas;
3. load the persisted identity tuple from the same connection;
4. load and fully verify the requested identity-pair row.

Verification includes byte-exact JSON Canonicalization Scheme (JCS)
equality of the stored record bytes, exact agreement of every projection
column, the sealing record digest, and the current revision/digest.
Malformed JSON, wrong schema, non-canonical bytes, stale revision, or
identity mismatch refuse closed before anything mutable happens.

SQLite may materialize `-shm`/`-wal` sidecars even for read-only opens;
that sidecar behavior is not claimed away by flags. The durable-content
contract is proven by a keeper-backed test comparing db/WAL/SHM contents
across refused runs.

## Single writable open with equality binding

After the preflight accepts, production startup opens the database exactly
once. Through that same connection it reloads the current authority
snapshot AND the exact premise row (closing any preflight-to-lock race),
then binds every carried field — revision, config digest, extension/server
pair, package root/path, package/executable digests, endpoint, record
digest — against both. Only then are the installed package and executable
byte digests verified and the child spawned. A programmatically constructed
config cannot bypass durable equality.

The public Rust entry refuses non-Linux platforms before any preflight,
open, or lock action.

## Fixed installed asset and reviewed digest

The binary resolves from one canonical location,
`<packageRoot>/dist/bin/worker_host`, using an exact module-layout check
(source vs built); any other layout fails closed. `scripts/build.mjs`
builds it with `cargo build --locked --release`, copies it into `dist/bin/`,
sets mode 0755, and enforces its SHA-256 digest at build time. The adapter
enforces the same reviewed digest at runtime before spawn. Install safety
checks every fixed-layout component: ordinary file kind, no symlinks, no
group/world-writable bits, owner equal to the effective user or root, and
leaf executability. Binary reads/hash failures are typed errors. No PATH,
environment, cwd, or caller-supplied executable is ever consulted.

## Frozen control channel

The child's argv is exactly `<database path> <extension alias>
<server id>`. Control frames use the frozen profile: 4-byte big-endian
length prefix, maximum payload 262144 bytes, wire depth 96, semantic depth
64. stdin is read incrementally into a fixed-size buffer; each complete
frame is handled immediately while stdin stays open. EOF with a partial or
trailing frame is a typed fatal error. There is no resynchronization after
a fatal framing violation. stdout carries frames only; stderr carries
bounded diagnostics.

Lifecycle: the first frame must be exactly `{v:1,event:"started",
server_id:<requested>}` or launch fails and the child is terminated and
reaped. `status` replies `{v:1,event:"status",state:"ready",server_id}`
before EOF. `stop` replies `{v:1,event:"stopped"}`; the launcher then
requires observable child-exit/stdio closure within a bounded grace period
and treats timeout as a typed failure. Unsolicited frames, wrong keys or
values, send failures, timeouts, and early exit all terminate and reap the
child before the typed error propagates.

## Unchanged guards

The unconditional `RUNTIME_MODULE_MIGRATION_REQUIRED` guard in
`src/core/runtime-bootstrap.ts` is untouched: this composition is internal
and does not make product startup reachable.
