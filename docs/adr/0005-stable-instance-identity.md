# ADR-0005: Persisted random instance identity

Status: Proposed

Date: 2026-07-24

## Context

Relative paths currently resolve from process working directory, and profile/IPC
identity ignores the actual configuration identity. The same file can therefore
use different state depending on launch location, while different files can
collide. A path hash would fix the working-directory bug but would incorrectly
turn a file move into a new instance.

## Proposed decision

- `dolly init` generates an opaque random `instanceId` and persists it in the
  versioned instance configuration/manifest. It is not a secret, path, name,
  port, PID, or hash of mutable configuration.
- Legacy configuration without an ID requires an explicit migration that
  generates and persists one before managed startup.
- The loader canonicalizes the configuration file to an absolute real path as a
  mutable locator. Every relative path in that file resolves against its
  containing directory, never the process working directory.
- Moving a config uses a `rebind`/migration operation that preserves
  `instanceId`; cloning an independent instance generates a new ID. Blindly
  copying a config with the same ID is detected as an identity collision.
- Configuration content hashes identify revisions, not instances.
- Profile directory, IPC endpoint, locks, registry entry, logs, and daemon state
  derive from `instanceId`. An explicit data directory contains a manifest that
  MUST match that ID before use.
- A short-lived controller lock prevents two supervisors from mutating one
  instance, while a separate authenticated child process record supports safe
  reconciliation after supervisor crash. Old process events cannot mutate a new
  generation.
- Effective resolved configuration is validated before any extension starts and
  can be inspected in redacted form.

## Consequences

Foreground and daemon launches agree regardless of current directory or config
move. Clone/rebind operations become explicit, and legacy startup requires a
migration instead of silently inventing identity from location.

## Required conformance evidence

Tests must cover different working directories, symlinks/case behavior on each
platform, migration, rebind/move, clone, copied-ID collisions, explicit data-dir
mismatch, concurrent controllers, supervisor reattach, stale PID/IPC artifacts,
generation races, and redaction of effective configuration.
