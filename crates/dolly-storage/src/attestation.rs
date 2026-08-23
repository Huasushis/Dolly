//! Pure SQLite build-attestation gate for the `dolly-storage` first slice.
//!
//! Implements REQ-TECH-003 / ADR 0006 as a closed, deterministic validator:
//! given the release attestation recorded for a build and the SQLite library
//! actually loaded by that build, decide whether the loaded library may be
//! used for writable storage. The gate is deliberately pure — it performs no
//! FFI, no file I/O, and no library probing. Feeding it identity data from an
//! unattested source is meaningless; the enclosing startup path obtains the
//! loaded identity from the real `sqlite3_libversion*` family before invoking
//! this validator. This slice contains no SQLite dependency, so the validator
//! is the only part of REQ-TECH-003 exercised by TST-STORAGE-001/002.

use serde::{Deserialize, Serialize};

use crate::error::{StorageError, StorageResult};

/// Upstream SQLite release number required by REQ-TECH-003, i.e.
/// `sqlite3_libversion_number() >= 3051003` (`SQLITE_VERSION_NUMBER >= 3051003`).
/// Encoded as the decimal concatenation of major.minor.patch with the hundredth
/// omitted from the minor, matching SQLite's own `SQLITE_VERSION_NUMBER`.
///
/// Do not lower this value; the WAL-reset race that motivates the floor is
/// present in every release through 3.51.2 (see ADR 0006).
pub const SQLITE_VERSION_NUMBER_MIN: u32 = 3051003;

/// Release attestation for the embedded SQLite, derived at build time from the
/// bundled libsqlite3-sys amalgamation by `build.rs` (the same bytes compiled
/// into the binary). These values are the release record; startup verifies the
/// loaded library against them.
pub fn release_attestation() -> ReleaseAttestation {
    let source_id = env!("DOLLY_STORAGE_SQLITE3_SOURCE_ID").to_string();
    let version_number_env = env!("DOLLY_STORAGE_SQLITE3_VERSION_NUMBER");
    let attested_min: u32 = version_number_env
        .parse()
        .expect("build.rs must emit a numeric SQLITE_VERSION_NUMBER");
    let digest_hex = env!("DOLLY_STORAGE_SQLITE3_C_SHA256");
    debug_assert_eq!(digest_hex.len(), 64);
    // `sha256:` + 64 lowercase hex; build.rs guarantees lowercase.
    let artifact_digest: dolly_canonical_json::Sha256Digest = format!("sha256:{digest_hex}")
        .parse()
        .expect("build.rs must emit a valid sha256: hex digest");
    ReleaseAttestation {
        sqlite_version_number_min: attested_min,
        sqlite_source_id: source_id,
        artifact_digest,
        compile_options: None,
        linkage_mode: Some("bundled-static".to_string()),
    }
}

/// Release attestation for an embedded SQLite library.
///
/// Mirrors `REQ-TECH-003`'s manifest record. `compile_options` and
/// `linkage_mode` are optionals so that a future attestation may tighten the
/// gate toward the full manifest without invalidating the current vectors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseAttestation {
    /// Lowest attested `sqlite3_libversion_number()`.
    pub sqlite_version_number_min: u32,
    /// Attested `sqlite3_sourceid()` exactly as produced by the build.
    pub sqlite_source_id: String,
    /// Attested digest of the embedded library artifact.
    pub artifact_digest: dolly_canonical_json::Sha256Digest,
    /// Attested compile options, if the manifest ships them.
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "compile_options"
    )]
    pub compile_options: Option<Vec<String>>,
    /// Attested linkage mode, if the manifest ships it.
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "linkage_mode"
    )]
    pub linkage_mode: Option<String>,
}

/// Identity of the SQLite library loaded by the current build.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoadedSqlite {
    pub version: String,
    pub version_number: u32,
    pub source_id: String,
    pub artifact_digest: dolly_canonical_json::Sha256Digest,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "compile_options"
    )]
    pub compile_options: Option<Vec<String>>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "linkage_mode"
    )]
    pub linkage_mode: Option<String>,
}

/// Positive result of the build gate, admitted for writable startup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VerifiedSqliteBuild {
    pub version_number: u32,
    pub source_id: String,
    pub artifact_digest: dolly_canonical_json::Sha256Digest,
}

/// The authoritative SQLite build gate from REQ-TECH-003 / ADR 0006.
///
/// Every field of `loaded` that the attestation names MUST match before the
/// build is admitted, and a release attestation can never lower the absolute
/// version floor. There is deliberately no way to weaken the check via a
/// bundled attestation: a higher attested minimum may tighten it, but the
/// absolute floor always wins.
#[derive(Debug, Clone, Copy, Default)]
pub struct SqliteBuildGate;

impl SqliteBuildGate {
    pub fn verify(
        &self,
        attestation: &ReleaseAttestation,
        loaded: &LoadedSqlite,
    ) -> StorageResult<VerifiedSqliteBuild> {
        // The absolute REQ-TECH-003 floor is unconditional: a signed
        // attestation claiming a lower minimum can tighten but never weaken
        // the constant. The effective floor is the stricter of the two.
        let effective_min = SQLITE_VERSION_NUMBER_MIN.max(attestation.sqlite_version_number_min);
        if loaded.version_number < effective_min {
            return Err(StorageError::unsafe_sqlite_build(
                loaded.version_number,
                effective_min,
            ));
        }
        if loaded.source_id != attestation.sqlite_source_id {
            return Err(StorageError::unsafe_sqlite_build(
                loaded.version_number,
                attestation.sqlite_version_number_min,
            ));
        }
        if loaded.artifact_digest != attestation.artifact_digest {
            return Err(StorageError::unsafe_sqlite_build(
                loaded.version_number,
                attestation.sqlite_version_number_min,
            ));
        }
        // A named compile-option set or linkage mode in the attestation must be
        // replicated exactly by the loaded library. Absent on both sides it is
        // not a checking failure: the current vectors omit them.
        if attestation.compile_options.is_some()
            && loaded.compile_options != attestation.compile_options
        {
            return Err(StorageError::unsafe_sqlite_build(
                loaded.version_number,
                attestation.sqlite_version_number_min,
            ));
        }
        if attestation.linkage_mode.is_some() && loaded.linkage_mode != attestation.linkage_mode {
            return Err(StorageError::unsafe_sqlite_build(
                loaded.version_number,
                attestation.sqlite_version_number_min,
            ));
        }
        Ok(VerifiedSqliteBuild {
            version_number: loaded.version_number,
            source_id: loaded.source_id.clone(),
            artifact_digest: loaded.artifact_digest.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::StorageError;

    const MIN: u32 = SQLITE_VERSION_NUMBER_MIN;
    const SOURCE: &str = "sqlite-3.51.3-attested-source";
    const SHA_C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const SHA_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn attestation() -> ReleaseAttestation {
        ReleaseAttestation {
            sqlite_version_number_min: MIN,
            sqlite_source_id: SOURCE.to_string(),
            artifact_digest: SHA_C.parse().unwrap(),
            compile_options: None,
            linkage_mode: None,
        }
    }
    fn loaded(version_number: u32) -> LoadedSqlite {
        LoadedSqlite {
            version: format!(
                "{}.{}.{}",
                version_number / 1000000,
                (version_number / 1000) % 1000,
                version_number % 1000
            ),
            version_number,
            source_id: SOURCE.to_string(),
            artifact_digest: SHA_C.parse().unwrap(),
            compile_options: None,
            linkage_mode: None,
        }
    }

    #[test]
    fn rejects_below_floor() {
        let result = SqliteBuildGate.verify(&attestation(), &loaded(MIN - 1));
        assert!(matches!(
            result,
            Err(StorageError::UnsafeSqliteBuild { .. })
        ));
    }

    /// A vulnerable loaded build must be rejected even when the attestation
    /// illegally claims a lower minimum than the spec floor: the constant
    /// never weakens.
    #[test]
    fn rejects_below_floor_despite_lowered_attestation_min() {
        let mut a = attestation();
        a.sqlite_version_number_min = MIN - 100; // attacker/corrupt attestation
        assert!(a.sqlite_version_number_min < MIN);
        // loaded is below the absolute floor but above the lowered attested min.
        let result = SqliteBuildGate.verify(&a, &loaded(MIN - 1));
        assert!(matches!(
            result,
            Err(StorageError::UnsafeSqliteBuild { .. })
        ));
    }

    /// A higher attested minimum may tighten beyond the spec floor.
    #[test]
    fn higher_attestation_min_tightens_but_never_loosens() {
        // floor pass, attested-min fail
        let mut a = attestation();
        a.sqlite_version_number_min = MIN + 1;
        assert!(SqliteBuildGate.verify(&a, &loaded(MIN)).is_err());
    }

    #[test]
    fn accepts_at_floor_with_matching_identity() {
        let result = SqliteBuildGate.verify(&attestation(), &loaded(MIN));
        assert!(result.is_ok());
        assert_eq!(result.unwrap().version_number, MIN);
    }

    #[test]
    fn rejects_source_id_mismatch() {
        let mut l = loaded(MIN);
        l.source_id = "different-source".to_string();
        assert!(SqliteBuildGate.verify(&attestation(), &l).is_err());
    }

    #[test]
    fn rejects_digest_mismatch() {
        let mut l = loaded(MIN);
        l.artifact_digest = SHA_B.parse().unwrap();
        assert!(SqliteBuildGate.verify(&attestation(), &l).is_err());
    }

    #[test]
    fn rejects_named_compile_options_mismatch() {
        let mut a = attestation();
        a.compile_options = Some(vec!["THREADSAFE=1".to_string(), "ENABLE_FTS5".to_string()]);
        let mut l = loaded(MIN);
        l.compile_options = Some(vec!["ENABLE_FTS5".to_string()]);
        assert!(SqliteBuildGate.verify(&a, &l).is_err());

        // Exact replication passes.
        let ok = loaded(MIN);
        let mut ok_loaded = ok.clone();
        ok_loaded.compile_options =
            Some(vec!["THREADSAFE=1".to_string(), "ENABLE_FTS5".to_string()]);
        assert!(SqliteBuildGate.verify(&a, &ok_loaded).is_ok());
    }

    #[test]
    fn rejects_named_linkage_mode_mismatch() {
        let mut a = attestation();
        a.linkage_mode = Some("static".to_string());
        let mut l = loaded(MIN);
        l.linkage_mode = Some("dynamic".to_string());
        assert!(SqliteBuildGate.verify(&a, &l).is_err());
    }
}
