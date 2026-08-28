//! Content-addressed local store: staging, commit, verification, and
//! quarantine.
//!
//! Bytes enter the private per-import staging area and are read exactly once
//! by the acquisition stream. Commit moves the finished staging file into
//! `objects/<asset_id>` with an atomic rename and re-verifies the recorded
//! length and BLAKE3 digest; a mismatch quarantines the file and never
//! publishes it. Identical bytes therefore share one immutable object, and a
//! crash between the rename and the durable row is resolved by recovery.

use crate::error::{AssetError, AssetErrorCode, ErrorPhase};
use crate::identity::ContentHash;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

/// Bounded acquisition stream that enforces a byte cap *while* reading and
/// computes the content hash incrementally. The cap is checked on every read,
/// so an over-limit source is cut off mid-stream, never buffered to the end.
pub struct BoundedSink {
    file: File,
    written: u64,
    cap: u64,
    hasher: blake3::Hasher,
    staging: PathBuf,
}

impl BoundedSink {
    /// Create the staging file for one import. The staging path is derived
    /// from the import, never from caller input.
    pub fn open(content_root: &Path, staging_name: &str, cap: u64) -> io::Result<Self> {
        let staging_dir = content_root.join("staging");
        fs::create_dir_all(&staging_dir)?;
        let staging = staging_dir.join(staging_name);
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .read(true)
            .open(&staging)?;
        Ok(Self {
            file,
            written: 0,
            cap,
            hasher: blake3::Hasher::new(),
            staging,
        })
    }

    pub fn write_bounded(&mut self, bytes: &[u8]) -> Result<(), AssetError> {
        if self.written.saturating_add(bytes.len() as u64) > self.cap {
            let _ = fs::remove_file(&self.staging);
            return Err(AssetError::new(
                AssetErrorCode::SizeLimit,
                ErrorPhase::Acquire,
                format!(
                    "byte bound {} exceeded ({} read)",
                    self.cap,
                    self.written.saturating_add(bytes.len() as u64)
                ),
            ));
        }
        self.hasher.update(bytes);
        self.file.write_all(bytes).map_err(|e| {
            let _ = fs::remove_file(&self.staging);
            AssetError::new(
                AssetErrorCode::StorageFull,
                ErrorPhase::Acquire,
                format!("staging write failed: {e}"),
            )
        })?;
        self.written += bytes.len() as u64;
        Ok(())
    }

    /// Finish the staging file: flush and report the counted length and hash
    /// as computed over the accepted bytes. Quarantines (rejects) are made by
    /// the caller via `abort`.
    pub fn finish(self) -> Result<(u64, ContentHash), AssetError> {
        self.file.sync_all().map_err(|e| {
            AssetError::new(
                AssetErrorCode::StorageFull,
                ErrorPhase::Acquire,
                format!("staging sync failed: {e}"),
            )
        })?;
        Ok((self.written, ContentHash::of_bytes_hasher(self.hasher.finalize())))
    }

    /// Discard the partial staging file (used on rejection and cancellation).
    pub fn abort(&self) {
        let _ = fs::remove_file(&self.staging);
    }

    pub fn staging_path(&self) -> &Path {
        &self.staging
    }
}

impl ContentHash {
    fn of_bytes_hasher(finalized: blake3::Hash) -> Self {
        Self {
            algorithm: "blake3-256",
            digest: *finalized.as_bytes(),
        }
    }
}

/// Verify a finished staging file against the recorded length and hash.
pub fn verify_object(path: &Path, expected_len: u64, expected_hash: &ContentHash) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if meta.len() != expected_len {
        return false;
    }
    hash_file(path).map(|hash| hash == *expected_hash).unwrap_or(false)
}

/// Hash a whole file with BLAKE3.
pub fn hash_file(path: &Path) -> io::Result<ContentHash> {
    let mut file = File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(ContentHash::of_bytes_hasher(hasher.finalize()))
}

/// Commit one finished staging file into the content-addressed store.
///
/// Returns `Committed` (moved or already present). The object is atomically
/// renamed into place; a concurrent identical commit leaves the first object
/// and discards this staging file. The caller durably records the row after
/// this returns.
pub enum CommitDisposition {
    /// The object was moved/linked into the content store.
    Moved,
    /// An identical object already existed; this staging file was discarded.
    Deduplicated,
}

pub fn commit_object(
    content_root: &Path,
    staging_path: &Path,
    asset_id: &str,
    expected_len: u64,
    expected_hash: &ContentHash,
) -> Result<CommitDisposition, AssetError> {
    if !verify_object(staging_path, expected_len, expected_hash) {
        let quarantine_dir = content_root.join("quarantine");
        let _ = fs::create_dir_all(&quarantine_dir);
        let name = staging_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let _ = fs::rename(staging_path, quarantine_dir.join(format!("{name}-{asset_id}")));
        return Err(AssetError::new(
            AssetErrorCode::HashMismatch,
            ErrorPhase::Commit,
            "staging object failed length or hash verification; quarantined".to_string(),
        ));
    }
    let objects_dir = content_root.join("objects");
    fs::create_dir_all(&objects_dir).map_err(|e| {
        AssetError::new(
            AssetErrorCode::StorageFull,
            ErrorPhase::Commit,
            format!("cannot create objects directory: {e}"),
        )
    })?;
    let target = objects_dir.join(asset_id);
    if target.exists() {
        // Identical content already present; dedup by discarding our copy.
        let _ = fs::remove_file(staging_path);
        return Ok(CommitDisposition::Deduplicated);
    }
    fs::rename(staging_path, &target).map_err(|e| {
        AssetError::new(
            AssetErrorCode::StorageFull,
            ErrorPhase::Commit,
            format!("cannot move object into place: {e}"),
        )
    })?;
    // The rename is atomic; a crash before this point leaves only an
    // unreferenced staging file, which recovery deletes.
    Ok(CommitDisposition::Moved)
}

/// Bounded reader over an available object. Enforces the recorded length.
pub struct ObjectReader {
    file: File,
    remaining: u64,
}

impl ObjectReader {
    pub fn open(content_root: &Path, asset_id: &str, byte_length: u64) -> io::Result<Self> {
        let path = content_root.join("objects").join(asset_id);
        let file = File::open(path)?;
        // Confirm the on-disk length matches the recorded durable length.
        let meta = file.metadata()?;
        if meta.len() != byte_length {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "object length does not match the durable record",
            ));
        }
        Ok(Self {
            file,
            remaining: byte_length,
        })
    }

    /// Read at most `buf.len()` bytes, never beyond the recorded length.
    pub fn read_bounded(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return Ok(0);
        }
        let want = buf.len().min(self.remaining as usize);
        let n = self.file.read(&mut buf[..want])?;
        self.remaining -= n as u64;
        Ok(n)
    }

    pub fn remaining(&self) -> u64 {
        self.remaining
    }
}

/// Delete the local object file when no live lifecycle row references it.
/// Returns the deletion outcome string for the audit tombstone.
pub fn delete_local_object(content_root: &Path, asset_id: &str) -> Result<String, AssetError> {
    let path = content_root.join("objects").join(asset_id);
    match fs::remove_file(&path) {
        Ok(()) => Ok("deleted".to_string()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok("absent".to_string()),
        Err(e) => Err(AssetError::new(
            AssetErrorCode::Internal,
            ErrorPhase::Collect,
            format!("local object deletion failed: {e}"),
        )),
    }
}

/// Delete a stale staging file (recovery and rejection paths).
pub fn delete_staging(content_root: &Path, staging_name: &str) {
    let _ = fs::remove_file(content_root.join("staging").join(staging_name));
}

/// True when the staging file for one import still exists.
pub fn staging_exists(content_root: &Path, staging_name: &str) -> bool {
    content_root.join("staging").join(staging_name).exists()
}
