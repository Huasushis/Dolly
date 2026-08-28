//! Object-store replica driver and the replica state transitions.
//!
//! Local content-addressed storage is authoritative in v1; object storage is
//! an optional replica. An upload failure MUST NOT make a locally available
//! asset unavailable unless the caller explicitly requested `remote_required`
//! before commit. This lane wires no real cloud backend (out of WP-010's
//! scope); the [`DisabledReplica`] default fails every upload/verify so a
//! `remote_required` import cannot reach `AVAILABLE`, while an in-memory
//! driver exercises the full `REPLICATING`/`REPLICA_FAILED` state machine in
//! tests.

use crate::error::{AssetError, AssetErrorCode, ErrorPhase};
use crate::identity::ContentHash;
use std::collections::HashMap;

/// The target object identity for one replica upload.
#[derive(Debug, Clone)]
pub struct ReplicaObject {
    /// The dedicated configured bucket.
    pub bucket: String,
    /// The dedicated prefix plus the content-derived object key.
    pub key: String,
    pub content_hash: ContentHash,
    pub byte_length: u64,
}

/// Outcome of one replica upload attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplicaUploadResult {
    Uploaded,
    /// The object was already present with a matching hash.
    AlreadyPresent,
    Failure(String),
}

/// Outcome of one replica verify attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplicaVerifyResult {
    Verified,
    Missing,
    Failure(String),
}

/// Result of a replica deletion attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplicaDeleteResult {
    Deleted,
    Absent,
    Failure(String),
}

/// Host-wired object-store transport. The service only ever passes
/// content-derived keys inside the configured bucket/prefix, and only for
/// objects this service recorded.
pub trait ReplicaDriver {
    fn upload(
        &mut self,
        object: &ReplicaObject,
        bytes: &[u8],
    ) -> ReplicaUploadResult;
    fn verify(&mut self, object: &ReplicaObject) -> ReplicaVerifyResult;
    fn delete(&mut self, bucket: &str, key: &str) -> ReplicaDeleteResult;
    fn key_for(&self, asset_id: &str) -> String;
}

/// The v1 default: no object store is configured, so uploads always fail.
/// A `remote_required` import therefore fails before acquisition (the
/// pipeline refuses it), and no import can claim a replica it never verified.
pub struct DisabledReplica {
    prefix: String,
}

impl DisabledReplica {
    pub fn new(prefix: impl Into<String>) -> Self {
        Self {
            prefix: prefix.into(),
        }
    }
}

impl ReplicaDriver for DisabledReplica {
    fn upload(&mut self, _object: &ReplicaObject, _bytes: &[u8]) -> ReplicaUploadResult {
        ReplicaUploadResult::Failure("no object store is configured".to_string())
    }

    fn verify(&mut self, _object: &ReplicaObject) -> ReplicaVerifyResult {
        ReplicaVerifyResult::Failure("no object store is configured".to_string())
    }

    fn delete(&mut self, _bucket: &str, _key: &str) -> ReplicaDeleteResult {
        ReplicaDeleteResult::Absent
    }

    fn key_for(&self, asset_id: &str) -> String {
        format!("{}/{}", self.prefix.trim_end_matches('/'), asset_id)
    }
}

/// In-memory object store for deterministic replica tests.
#[derive(Debug, Default)]
pub struct InMemoryReplica {
    pub prefix: String,
    pub objects: HashMap<String, Vec<u8>>,
    pub fail_uploads: bool,
    pub fail_verifies: bool,
    pub fail_deletes: bool,
}

impl InMemoryReplica {
    pub fn new(prefix: &str, bucket: &str, _bucket_name: &str) -> Self {
        let _ = bucket;
        Self {
            prefix: prefix.to_string(),
            objects: HashMap::new(),
            fail_uploads: false,
            fail_verifies: false,
            fail_deletes: false,
        }
    }
}

impl ReplicaDriver for InMemoryReplica {
    fn upload(&mut self, object: &ReplicaObject, bytes: &[u8]) -> ReplicaUploadResult {
        if self.fail_uploads {
            return ReplicaUploadResult::Failure("injected upload failure".to_string());
        }
        if bytes.len() != object.byte_length as usize {
            return ReplicaUploadResult::Failure("length mismatch".to_string());
        }
        let hash = ContentHash::of_bytes(bytes);
        if hash != object.content_hash {
            return ReplicaUploadResult::Failure("hash mismatch".to_string());
        }
        if let Some(existing) = self.objects.get(&object.key) {
            if existing.as_slice() == bytes {
                return ReplicaUploadResult::AlreadyPresent;
            }
            return ReplicaUploadResult::Failure("key collision with different bytes".to_string());
        }
        self.objects.insert(object.key.clone(), bytes.to_vec());
        ReplicaUploadResult::Uploaded
    }

    fn verify(&mut self, object: &ReplicaObject) -> ReplicaVerifyResult {
        if self.fail_verifies {
            return ReplicaVerifyResult::Failure("injected verify failure".to_string());
        }
        match self.objects.get(&object.key) {
            Some(bytes) => {
                if bytes.len() != object.byte_length as usize {
                    ReplicaVerifyResult::Failure("length mismatch".to_string())
                } else if ContentHash::of_bytes(bytes) != object.content_hash {
                    ReplicaVerifyResult::Missing
                } else {
                    ReplicaVerifyResult::Verified
                }
            }
            None => ReplicaVerifyResult::Missing,
        }
    }

    fn delete(&mut self, _bucket: &str, key: &str) -> ReplicaDeleteResult {
        if self.fail_deletes {
            return ReplicaDeleteResult::Failure("injected delete failure".to_string());
        }
        match self.objects.remove(key) {
            Some(_) => ReplicaDeleteResult::Deleted,
            None => ReplicaDeleteResult::Absent,
        }
    }

    fn key_for(&self, asset_id: &str) -> String {
        format!("{}/{}", self.prefix.trim_end_matches('/'), asset_id)
    }
}

/// Encode a replica upload failure as the stable import error.
pub fn replica_failure(phase: ErrorPhase, message: impl Into<String>) -> AssetError {
    AssetError::new(
        AssetErrorCode::RemoteReplicaFailed,
        phase,
        message.into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_replica_never_uploads_or_verifies() {
        let mut driver = DisabledReplica::new("assets");
        let object = ReplicaObject {
            bucket: "dolly".into(),
            key: driver.key_for("ast_whatever"),
            content_hash: ContentHash::of_bytes(b"x"),
            byte_length: 1,
        };
        assert!(matches!(
            driver.upload(&object, b"x"),
            ReplicaUploadResult::Failure(_)
        ));
        assert!(matches!(
            driver.verify(&object),
            ReplicaVerifyResult::Failure(_)
        ));
    }

    #[test]
    fn in_memory_replica_round_trip_and_failures() {
        let mut driver = InMemoryReplica::new("assets", "dolly", "dolly-bucket");
        let bytes = b"payload!";
        let object = ReplicaObject {
            bucket: "dolly".into(),
            key: driver.key_for("ast_a"),
            content_hash: ContentHash::of_bytes(bytes),
            byte_length: bytes.len() as u64,
        };
        assert_eq!(
            driver.upload(&object, bytes),
            ReplicaUploadResult::Uploaded
        );
        assert_eq!(driver.verify(&object), ReplicaVerifyResult::Verified);
        driver.fail_uploads = true;
        assert!(matches!(
            driver.upload(&object, bytes),
            ReplicaUploadResult::Failure(_)
        ));
        driver.fail_uploads = false;
        assert_eq!(driver.verify(&object), ReplicaVerifyResult::Verified);
        driver.fail_verifies = true;
        assert!(matches!(
            driver.verify(&object),
            ReplicaVerifyResult::Failure(_)
        ));
        driver.fail_verifies = false;
        assert_eq!(
            driver.delete("dolly", &object.key),
            ReplicaDeleteResult::Deleted
        );
        assert_eq!(driver.verify(&object), ReplicaVerifyResult::Missing);
    }
}
