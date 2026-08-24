#!/bin/bash
# Deterministic locked build gate for the Rust workspace.
#
# Runs the three locked commands that prove the committed Cargo.lock,
# rust-toolchain.toml, and source tree agree, with no network use:
#
#   1. cargo fmt --check        — formatting matches the checked-in style
#   2. cargo test  --locked     — lock is exactly reproduced and tests pass
#   3. cargo build --locked     — the workspace builds from the lock alone
#
# The pinned toolchain comes from rust-toolchain.toml (channel 1.85.0,
# profile minimal). If that toolchain is not installed, the script fails
# instead of downloading it: rustup auto-install is disabled and the build
# artifacts are kept out of the worktree so a read-only checkout stays clean.
#
# Usage, from anywhere:
#
#   ./scripts/rust-gate.sh
#
# Optional environment:
#   RUST_GATE_TARGET_DIR  — where cargo writes its target/ directory.
#                           Defaults to a fresh per-run mktemp -d directory
#                           under the system temp root, removed on exit.
set -euo pipefail

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is not on PATH; install rustup and the pinned toolchain first." >&2
  exit 1
fi

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPOSITORY_ROOT}"

# Fail closed if the pinned toolchain is missing rather than fetching it.
export RUSTUP_AUTO_INSTALL="0"
# No network during the gate: crates come from the committed Cargo.lock and
# the local registry cache, never from crates.io.
export CARGO_NET_OFFLINE="true"
# Keep build artifacts out of the worktree so the checkout stays clean and a
# read-only worktree is not written into.
TARGET_DIR="$(mktemp -d -t dolly-rust-target.XXXXXX)"
cleanup() {
  rm -rf "${TARGET_DIR}"
}
trap cleanup EXIT
export CARGO_TARGET_DIR="${RUST_GATE_TARGET_DIR:-${TARGET_DIR}}"

echo "==> cargo fmt --check"
cargo fmt --check

echo "==> cargo test --locked --workspace"
cargo test --locked --workspace

echo "==> cargo build --locked --workspace --all-targets"
cargo build --locked --workspace --all-targets

echo "rust-gate: PASS"
