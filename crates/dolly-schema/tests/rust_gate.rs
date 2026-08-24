//! Rust build gate invariants.
//!
//! `scripts/rust-gate.sh` is the deterministic locked build gate for the Rust
//! workspace. This test defends the observable contract of that script without
//! running it: it checks that the script exists, is executable, and contains
//! the three locked cargo commands plus the fail-closed environment settings
//! that keep the gate offline and out of the worktree. It does not invoke
//! cargo, rustc, or the script itself; the host-heavy gate run belongs to the
//! integration lane.

use std::path::PathBuf;

fn workspace_root() -> PathBuf {
    let manifest_dir =
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set");
    PathBuf::from(manifest_dir)
        .ancestors()
        .nth(2) // crates/dolly-schema -> crates -> workspace root
        .map(|p| p.to_path_buf())
        .expect("workspace root should exist")
}

fn read_script() -> String {
    let path = workspace_root().join("scripts").join("rust-gate.sh");
    assert!(
        path.exists(),
        "scripts/rust-gate.sh should exist at {}",
        path.display()
    );
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()))
}

#[test]
fn gate_script_is_executable() {
    let path = workspace_root().join("scripts").join("rust-gate.sh");
    let metadata = std::fs::metadata(&path)
        .unwrap_or_else(|e| panic!("failed to stat {}: {e}", path.display()));
    use std::os::unix::fs::PermissionsExt;
    let mode = metadata.permissions().mode();
    assert!(
        mode & 0o100 != 0,
        "scripts/rust-gate.sh should be owner-executable (mode {mode:o})"
    );
}

#[test]
fn gate_script_fails_closed_without_downloads() {
    let script = read_script();
    // `set -euo pipefail` makes the script exit on the first failing command
    // or unbound variable, so the gate cannot continue past a failure.
    assert!(
        script.contains("set -euo pipefail"),
        "gate should fail closed with `set -euo pipefail`"
    );
    // A missing pinned toolchain must error, not auto-download.
    assert!(
        script.contains("RUSTUP_AUTO_INSTALL=\"0\""),
        "gate should disable rustup auto-install (RUSTUP_AUTO_INSTALL=0)"
    );
    // No network use: crates come only from the committed lock and the local
    // registry cache.
    assert!(
        script.contains("CARGO_NET_OFFLINE=\"true\""),
        "gate should run cargo offline (CARGO_NET_OFFLINE=true)"
    );
}

#[test]
fn gate_script_runs_locked_commands() {
    let script = read_script();
    assert!(
        script.contains("cargo fmt --check"),
        "gate should check formatting with `cargo fmt --check`"
    );
    assert!(
        script.contains("cargo test --locked --workspace"),
        "gate should run `cargo test --locked --workspace`"
    );
    assert!(
        script.contains("cargo build --locked --workspace --all-targets"),
        "gate should run `cargo build --locked --workspace --all-targets`"
    );
    // Every cargo command in the gate must be locked; a bare `--locked` is not
    // enough if a command omits it, so require it on each cargo invocation.
    for line in script.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("cargo ") && !trimmed.starts_with("cargo fmt") {
            assert!(
                trimmed.contains("--locked"),
                "every non-fmt cargo command should be locked: {trimmed:?}"
            );
        }
    }
}

#[test]
fn gate_script_writes_outside_the_worktree() {
    let script = read_script();
    // Build artifacts must not pollute the (potentially read-only) worktree.
    assert!(
        script.contains("CARGO_TARGET_DIR="),
        "gate should set CARGO_TARGET_DIR to keep artifacts out of the worktree"
    );
    assert!(
        script.contains("mktemp -d"),
        "gate should default CARGO_TARGET_DIR to a fresh mktemp -d directory"
    );
}
