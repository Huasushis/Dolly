//! Typed storage error codes per `§10 Storage errors` of the storage-and-recovery spec.
//!
//! Each variant maps one-for-one to a normative `STORAGE_*` code and a fixed
//! retryability bit. The raw-message rule of §10 is enforced at the call sites
//! (details are optional structured JSON, never free-form DB error text as a
//! contract).

use thiserror::Error;

/// Result alias for storage operations.
pub type StorageResult<T> = Result<T, StorageError>;

/// The nine normative storage error codes from §10.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum StorageError {
    #[error("STORAGE_INSTANCE_LOCKED")]
    InstanceLocked,
    #[error("STORAGE_UNSAFE_SQLITE_BUILD")]
    UnsafeSqliteBuild {
        observed_version_number: u32,
        required_version_number: u32,
    },
    #[error("STORAGE_UNSAFE_CONFIGURATION")]
    UnsafeConfiguration,
    #[error("STORAGE_BUSY")]
    Busy,
    #[error("STORAGE_FULL")]
    Full,
    #[error("STORAGE_CORRUPT")]
    Corrupt,
    #[error("STORAGE_IDEMPOTENCY_CONFLICT")]
    IdempotencyConflict,
    #[error("STORAGE_SEQUENCE_CONFLICT")]
    SequenceConflict,
    #[error("STORAGE_MIGRATION_REQUIRED")]
    MigrationRequired,
}

impl StorageError {
    /// The normative code string from §10, used for protocol-envelope mapping.
    pub fn code(&self) -> &'static str {
        match self {
            StorageError::InstanceLocked => "STORAGE_INSTANCE_LOCKED",
            StorageError::UnsafeSqliteBuild { .. } => "STORAGE_UNSAFE_SQLITE_BUILD",
            StorageError::UnsafeConfiguration => "STORAGE_UNSAFE_CONFIGURATION",
            StorageError::Busy => "STORAGE_BUSY",
            StorageError::Full => "STORAGE_FULL",
            StorageError::Corrupt => "STORAGE_CORRUPT",
            StorageError::IdempotencyConflict => "STORAGE_IDEMPOTENCY_CONFLICT",
            StorageError::SequenceConflict => "STORAGE_SEQUENCE_CONFLICT",
            StorageError::MigrationRequired => "STORAGE_MIGRATION_REQUIRED",
        }
    }

    /// Fixed retryability bit from §10.
    pub fn retryable(&self) -> bool {
        matches!(self, StorageError::Busy)
    }

    /// Structured identity side-channel for `UnsafeSqliteBuild`.
    pub fn unsafe_sqlite_build(observed_version_number: u32, required_version_number: u32) -> Self {
        StorageError::UnsafeSqliteBuild {
            observed_version_number,
            required_version_number,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_and_retryability_match_spec_table() {
        let cases: &[(StorageError, &str, bool)] = &[
            (
                StorageError::InstanceLocked,
                "STORAGE_INSTANCE_LOCKED",
                false,
            ),
            (
                StorageError::UnsafeSqliteBuild {
                    observed_version_number: 3051002,
                    required_version_number: 3051003,
                },
                "STORAGE_UNSAFE_SQLITE_BUILD",
                false,
            ),
            (
                StorageError::UnsafeConfiguration,
                "STORAGE_UNSAFE_CONFIGURATION",
                false,
            ),
            (StorageError::Busy, "STORAGE_BUSY", true),
            (StorageError::Full, "STORAGE_FULL", false),
            (StorageError::Corrupt, "STORAGE_CORRUPT", false),
            (
                StorageError::IdempotencyConflict,
                "STORAGE_IDEMPOTENCY_CONFLICT",
                false,
            ),
            (
                StorageError::SequenceConflict,
                "STORAGE_SEQUENCE_CONFLICT",
                false,
            ),
            (
                StorageError::MigrationRequired,
                "STORAGE_MIGRATION_REQUIRED",
                false,
            ),
        ];
        for (err, code, retryable) in cases {
            assert_eq!(err.code(), *code);
            assert_eq!(err.retryable(), *retryable);
        }
    }
}
