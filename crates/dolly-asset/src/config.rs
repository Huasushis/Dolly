//! Resolved Asset Service configuration, mirroring
//! `asset-service-config.schema.json`.
//!
//! The fields are the enforced bounds: byte caps are checked while bytes
//! stream, never by buffering first. Replica defaults to `disabled`; a
//! `remote_required` import with no configured replica fails before
//! acquisition.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// The v1 hard ceiling for inline base64 characters.
pub const MAX_INLINE_BASE64_CHARS_CEILING: u64 = 50_331_648;

/// v1 default replica retry series.
pub const DEFAULT_REPLICA_MAX_ATTEMPTS: u64 = 5;
pub const DEFAULT_REPLICA_RETRY_BASE_MS: u64 = 1_000;
pub const DEFAULT_REPLICA_RETRY_CAP_MS: u64 = 60_000;

/// Bounded replica retry backoff series (schema `replica_retry`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplicaRetryConfig {
    pub max_import_attempts: u64,
    pub retry_base_ms: u64,
    pub retry_cap_ms: u64,
}

impl ReplicaRetryConfig {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=64).contains(&self.max_import_attempts) {
            return Err("replica_retry.max_import_attempts out of range".into());
        }
        if !(1..=60_000).contains(&self.retry_base_ms) {
            return Err("replica_retry.retry_base_ms out of range".into());
        }
        if !(1..=3_600_000).contains(&self.retry_cap_ms) {
            return Err("replica_retry.retry_cap_ms out of range".into());
        }
        if self.retry_base_ms > self.retry_cap_ms {
            return Err("retry_base_ms MUST NOT exceed retry_cap_ms".into());
        }
        Ok(())
    }
}

impl Default for ReplicaRetryConfig {
    fn default() -> Self {
        Self {
            max_import_attempts: DEFAULT_REPLICA_MAX_ATTEMPTS,
            retry_base_ms: DEFAULT_REPLICA_RETRY_BASE_MS,
            retry_cap_ms: DEFAULT_REPLICA_RETRY_CAP_MS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplicaConfig {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bucket: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_ref: Option<String>,
}

impl ReplicaConfig {
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }
}

impl Default for ReplicaConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            endpoint: None,
            bucket: None,
            prefix: None,
            credential_ref: None,
        }
    }
}

/// The fully resolved, validated Asset Service configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolvedAssetConfig {
    /// Content-addressed local store root. Refused when unsafe (any
    /// symlinkable component).
    pub local_root: PathBuf,
    /// Hard cap on bytes received in one encoded envelope form.
    pub max_encoded_bytes: u64,
    /// Cap on inline base64 characters (ceiling 50,331,648).
    pub max_inline_base64_chars: u64,
    /// Hard cap on decoded asset bytes.
    pub max_decoded_bytes: u64,
    /// Hard cap on decoded image pixels (width * height).
    pub max_image_pixels: u64,
    /// Hard cap on decoded media frames.
    pub max_frames: u64,
    /// Bound on remote redirects (0 means no redirects).
    pub max_redirects: u64,
    /// Bound on a single remote fetch, milliseconds.
    pub remote_fetch_timeout_ms: u64,
    /// Maximum lease lifetime, milliseconds.
    pub lease_max_ms: u64,
    /// GC grace period, milliseconds.
    pub gc_grace_ms: u64,
    pub replica_retry: ReplicaRetryConfig,
    pub replica: ReplicaConfig,
}

impl ResolvedAssetConfig {
    /// v1 defaults with the local root supplied by the caller.
    pub fn with_local_root(local_root: PathBuf) -> Self {
        Self {
            local_root,
            max_encoded_bytes: 64 * 1024 * 1024,
            max_inline_base64_chars: 50_331_648,
            max_decoded_bytes: 64 * 1024 * 1024,
            max_image_pixels: 200_000_000,
            max_frames: 10_000,
            max_redirects: 5,
            remote_fetch_timeout_ms: 30_000,
            lease_max_ms: 7 * 24 * 3600 * 1000,
            gc_grace_ms: 5 * 60 * 1000,
            replica_retry: ReplicaRetryConfig::default(),
            replica: ReplicaConfig::default(),
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        let root = self.local_root.as_os_str();
        if root.is_empty() {
            return Err("local_root must be non-empty".into());
        }
        if !(1024..=268_435_456).contains(&self.max_encoded_bytes) {
            return Err("max_encoded_bytes out of range (1024..=268435456)".into());
        }
        if !(4..=MAX_INLINE_BASE64_CHARS_CEILING).contains(&self.max_inline_base64_chars) {
            return Err("max_inline_base64_chars out of range".into());
        }
        if !(1024..=1_073_741_824).contains(&self.max_decoded_bytes) {
            return Err("max_decoded_bytes out of range (1024..=1073741824)".into());
        }
        if !(1..=1_000_000_000).contains(&self.max_image_pixels) {
            return Err("max_image_pixels out of range".into());
        }
        if !(1..=1_000_000).contains(&self.max_frames) {
            return Err("max_frames out of range".into());
        }
        if !(0..=16).contains(&self.max_redirects) {
            return Err("max_redirects out of range".into());
        }
        if !(100..=3_600_000).contains(&self.remote_fetch_timeout_ms) {
            return Err("remote_fetch_timeout_ms out of range".into());
        }
        if !(1_000..=604_800_000).contains(&self.lease_max_ms) {
            return Err("lease_max_ms out of range".into());
        }
        if !(60_000..=315_576_000_000).contains(&self.gc_grace_ms) {
            return Err("gc_grace_ms out of range".into());
        }
        self.replica_retry.validate()?;
        if self.replica.enabled {
            let endpoint = self.replica.endpoint.as_deref().unwrap_or("");
            let bucket = self.replica.bucket.as_deref().unwrap_or("");
            let prefix = self.replica.prefix.as_deref().unwrap_or("");
            let credential = self.replica.credential_ref.as_deref().unwrap_or("");
            if !endpoint.starts_with("https://") || bucket.is_empty() || prefix.is_empty() {
                return Err("remote replica requires an https endpoint, bucket, and prefix".into());
            }
            if credential.is_empty() {
                return Err("remote replica requires a credential_ref".into());
            }
        }
        Ok(())
    }

    /// Whether a remote (object-store) replica is configured and enabled.
    pub fn replica_enabled(&self) -> bool {
        self.replica.is_enabled()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn default_config_validates() {
        let config = ResolvedAssetConfig::with_local_root(PathBuf::from("/tmp/asset-root"));
        config.validate().expect("defaults validate");
        assert_eq!(config.replica_retry.max_import_attempts, 5);
        assert!(!config.replica_enabled());
    }

    #[test]
    fn retry_base_must_not_exceed_cap() {
        let mut config = ResolvedAssetConfig::with_local_root(PathBuf::from("/tmp/r"));
        config.replica_retry.retry_base_ms = 600_000;
        config.replica_retry.retry_cap_ms = 1_000;
        assert!(config.validate().is_err());
    }

    #[test]
    fn remote_required_without_replica_is_visible_via_replica_enabled() {
        let config = ResolvedAssetConfig::with_local_root(PathBuf::from("/tmp/r"));
        assert!(!config.replica_enabled());
        let mut remote = ResolvedAssetConfig::with_local_root(PathBuf::from("/tmp/r"));
        remote.replica = ReplicaConfig {
            enabled: true,
            endpoint: Some("https://oss.example".into()),
            bucket: Some("dolly-assets".into()),
            prefix: Some("assets".into()),
            credential_ref: Some("k8s://dolly/oss".into()),
        };
        assert!(remote.replica_enabled());
        remote.validate().expect("remote replica config validates");
    }
}
