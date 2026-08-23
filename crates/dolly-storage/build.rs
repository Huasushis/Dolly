//! Build-time SQLite artifact attestation.
//!
//! REQ-TECH-003 / ADR 0006 require the release manifest to record the
//! embedded library's source id, version number, and artifact digest, and
//! startup to verify the loaded library against that record. This script
//! derives the record from the bundled libsqlite3-sys amalgamation so the
//! source of truth is the pinned upstream crate — the same bytes compiled
//! into the binary — instead of duplicated constants that can drift.
//!
//! The values are exposed to the crate as environment variables:
//!
//! - `DOLLY_STORAGE_SQLITE3_SOURCE_ID` — the `SQLITE_SOURCE_ID` string
//!   exactly as the upstream sqlite.org release defines it.
//! - `DOLLY_STORAGE_SQLITE3_VERSION_NUMBER` — the `SQLITE_VERSION_NUMBER`
//!   integer (SQLite's `major * 1000000 + minor * 1000 + patch` encoding).
//! - `DOLLY_STORAGE_SQLITE3_C_SHA256` — the lowercase hex SHA-256 of the
//!   bundled `sqlite3.c` amalgamation compilation unit.
//!
//! Nothing in this workspace links a downloaded or system SQLite; the crate
//! is built only from the bundled source, and its identity is derived from
//! that exact source at compile time.

use std::env;
use std::fs;
use std::path::PathBuf;

use sha2::{Digest, Sha256};

fn main() {
    // libsqlite3-sys emits `cargo:include={manifest_dir}/sqlite3` from its
    // build script; cargo forwards it to dependents as DEP_SQLITE3_INCLUDE.
    let include_dir = match env::var_os("DEP_SQLITE3_INCLUDE") {
        Some(dir) => PathBuf::from(dir),
        None => {
            cargo_error(
                "libsqlite3-sys did not set DEP_SQLITE3_INCLUDE; is the bundled \
                 feature of rusqlite/libsqlite3-sys enabled and does the build \
                 script exist?",
            );
            std::process::exit(1);
        }
    };
    let amalgamation_path = include_dir.join("sqlite3.c");
    let header_path = include_dir.join("sqlite3.h");
    for required in [&amalgamation_path, &header_path] {
        if !required.is_file() {
            cargo_error(&format!(
                "bundled file missing at {} (DEP_SQLITE3_INCLUDE={}); \
                 refusing to produce an unattested artifact",
                required.display(),
                include_dir.display()
            ));
            std::process::exit(1);
        }
    }

    let amalgamation = fs::read(&amalgamation_path).unwrap_or_else(|e| {
        cargo_error(&format!("cannot read {}: {e}", amalgamation_path.display()));
        std::process::exit(1);
    });
    let digest = Sha256::digest(&amalgamation);
    let digest_hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    if digest_hex.len() != 64 {
        cargo_error("internal: SHA-256 rendered outside 64 hex chars");
        std::process::exit(1);
    }

    let header = fs::read_to_string(&header_path).unwrap_or_else(|e| {
        cargo_error(&format!("cannot read {}: {e}", header_path.display()));
        std::process::exit(1);
    });
    let source_id = extract_source_id(&header);
    let version_number = extract_version_number(&header);

    println!("cargo:rustc-env=DOLLY_STORAGE_SQLITE3_C_SHA256={digest_hex}");
    println!("cargo:rustc-env=DOLLY_STORAGE_SQLITE3_SOURCE_ID={source_id}");
    println!("cargo:rustc-env=DOLLY_STORAGE_SQLITE3_VERSION_NUMBER={version_number}");
    // Rebuild only when the bundled files or this script change.
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={}", amalgamation_path.display());
    println!("cargo:rerun-if-changed={}", header_path.display());
}

fn extract_source_id(header: &str) -> String {
    // `#define SQLITE_SOURCE_ID "2026-03-13 10:38:09 ..."`
    let marker = "#define SQLITE_SOURCE_ID ";
    let line = header
        .lines()
        .find(|l| l.contains(marker))
        .unwrap_or_else(|| {
            cargo_error(
                "SQLITE_SOURCE_ID missing from bundled sqlite3.h; refusing unattested artifact",
            );
            std::process::exit(1)
        });
    let start = line.find('"').expect("source id opening quote");
    let rest = &line[start + 1..];
    let end = rest.find('"').expect("source id closing quote");
    rest[..end].to_string()
}

fn extract_version_number(header: &str) -> String {
    // `#define SQLITE_VERSION_NUMBER 3051003`
    let marker = "#define SQLITE_VERSION_NUMBER ";
    let line = header.lines().find(|l| l.contains(marker)).unwrap_or_else(|| {
        cargo_error("SQLITE_VERSION_NUMBER missing from bundled sqlite3.h; refusing unattested artifact");
        std::process::exit(1)
    });
    let value = line.trim_start_matches(marker).trim();
    value.split_whitespace().next().unwrap().to_string()
}

fn cargo_error(message: &str) {
    println!("cargo:error={message}");
}
