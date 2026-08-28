//! Durable SQLite authority for asset imports, asset lifecycle rows,
//! references, leases, pins, and tombstones.
//!
//! Every write runs under an immediate transaction. Forward import-state
//! transitions are compare-and-set on the current state, so a concurrent
//! mover cannot double-apply; a stale compare-and-set returns `Conflict`.
//! Tombstone-sensitive operations (lease, pin, reference) recheck the
//! lifecycle inside the same transaction as their insert.

use crate::clock::ClockTime;
use crate::identity::ContentHash;
use crate::record::*;
use rusqlite::types::Type as SqlType;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use std::path::Path;

pub const ASSET_SCHEMA_VERSION: i64 = 1;

pub const ASSET_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS asset_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_imports (
    import_id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    module_id TEXT NOT NULL,
    security_domain TEXT NOT NULL,
    state TEXT NOT NULL,
    params_digest TEXT NOT NULL,
    media_kind TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_json TEXT NOT NULL,
    declared_media_type TEXT,
    expected_byte_length INTEGER,
    remote_required INTEGER NOT NULL,
    deadline TEXT NOT NULL,
    max_bytes INTEGER NOT NULL,
    asset_id TEXT,
    detected_media_type TEXT,
    byte_length INTEGER,
    encoded_width INTEGER,
    encoded_height INTEGER,
    orientation INTEGER,
    staging_bytes INTEGER,
    staging_hash TEXT,
    error_code TEXT,
    error_message TEXT,
    error_retryable INTEGER,
    error_outcome TEXT,
    error_details_json TEXT,
    replica_state TEXT NOT NULL,
    replica_attempt INTEGER NOT NULL DEFAULT 0,
    retry_at_ms INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_records (
    asset_id TEXT NOT NULL,
    security_domain TEXT NOT NULL,
    generation INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    declared_media_type TEXT,
    detected_media_type TEXT,
    orientation INTEGER,
    encoded_width INTEGER,
    encoded_height INTEGER,
    display_width INTEGER,
    display_height INTEGER,
    lifecycle TEXT NOT NULL,
    deletion_generation INTEGER NOT NULL DEFAULT 0,
    local_state TEXT NOT NULL,
    replica_state TEXT NOT NULL,
    tombstoned_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (asset_id, security_domain, generation)
);
CREATE INDEX IF NOT EXISTS idx_asset_records_content
    ON asset_records (content_hash, security_domain);
CREATE INDEX IF NOT EXISTS idx_asset_records_lifecycle
    ON asset_records (asset_id, lifecycle);
CREATE TABLE IF NOT EXISTS asset_references (
    asset_id TEXT NOT NULL,
    security_domain TEXT NOT NULL,
    generation INTEGER NOT NULL,
    ref_key TEXT NOT NULL,
    owner TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (asset_id, security_domain, generation, ref_key)
);
CREATE TABLE IF NOT EXISTS asset_leases (
    lease_id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    security_domain TEXT NOT NULL,
    generation INTEGER NOT NULL,
    owner TEXT NOT NULL,
    purpose TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_pins (
    pin_id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    security_domain TEXT NOT NULL,
    generation INTEGER NOT NULL,
    owner TEXT NOT NULL,
    reason TEXT NOT NULL,
    privileged INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    expires_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS asset_tombstones (
    asset_id TEXT NOT NULL,
    security_domain TEXT NOT NULL,
    generation INTEGER NOT NULL,
    deletion_generation INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    local_outcome TEXT NOT NULL,
    deleted_at TEXT NOT NULL,
    deleted_at_ms INTEGER NOT NULL,
    PRIMARY KEY (asset_id, security_domain, generation, deletion_generation)
);
"#;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("state conflict: import {0} is no longer in the expected state")]
    Conflict(String),
    #[error("record not found: {0}")]
    NotFound(String),
    #[error("illegal transition {from:?} -> {to:?}")]
    IllegalTransition { from: ImportState, to: ImportState },
    #[error("integrity: {0}")]
    Integrity(String),
}

pub type StoreResult<T> = Result<T, StoreError>;

/// The owned SQLite authority for one asset service root.
pub struct AssetStore {
    connection: Connection,
}

impl AssetStore {
    /// Open (or create) the asset database at `path` after refusing unsafe
    /// path components, and install the versioned schema.
    pub fn open(path: &Path) -> StoreResult<Self> {
        reject_symlink_components(path)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                StoreError::Integrity(format!("cannot create store parent: {e}"))
            })?;
        }
        let mut connection = Connection::open(path)?;
        let pragmas = [
            "PRAGMA foreign_keys = ON;",
            "PRAGMA busy_timeout = 5000;",
            "PRAGMA synchronous = FULL;",
        ];
        for pragma in pragmas {
            connection.execute_batch(pragma)?;
        }
        let version: i64 = connection.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > ASSET_SCHEMA_VERSION {
            return Err(StoreError::Integrity(format!(
                "database schema {version} is newer than supported {ASSET_SCHEMA_VERSION}"
            )));
        }
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if version == 0 {
            tx.execute_batch(ASSET_SCHEMA_SQL)?;
            tx.execute(
                "INSERT INTO asset_meta (singleton, schema_version) VALUES (1, ?1)",
                params![ASSET_SCHEMA_VERSION],
            )?;
        } else {
            // Existing schema: verify the singleton matches.
            let existing: i64 = tx.query_row(
                "SELECT schema_version FROM asset_meta WHERE singleton = 1",
                [],
                |r| r.get(0),
            )?;
            if existing != ASSET_SCHEMA_VERSION {
                return Err(StoreError::Integrity(
                    "asset schema version mismatch".to_string(),
                ));
            }
        }
        tx.execute_batch(&format!("PRAGMA user_version = {ASSET_SCHEMA_VERSION};"))?;
        tx.commit()?;
        Ok(Self { connection })
    }

    /// Write-through connection for callers that need one transaction across
    /// store and content operations.
    pub fn transaction(&mut self) -> StoreResult<StoreTransaction<'_>> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        Ok(StoreTransaction { tx })
    }
}

/// One immediate transaction over the store.
pub struct StoreTransaction<'a> {
    tx: rusqlite::Transaction<'a>,
}

impl<'a> StoreTransaction<'a> {
    pub fn commit(self) -> StoreResult<()> {
        self.tx.commit()?;
        Ok(())
    }

    /// Insert a new import record; returns false when the import already
    /// exists (caller must then replay or conflict).
    pub fn insert_import_if_absent(&self, record: &ImportRecord) -> StoreResult<bool> {
        let changed = self.tx.execute(
            r#"INSERT INTO asset_imports (
                import_id, instance_id, module_id, security_domain, state, params_digest,
                media_kind, source_kind, source_json, declared_media_type,
                expected_byte_length, remote_required, deadline, max_bytes,
                asset_id, detected_media_type, byte_length, encoded_width, encoded_height,
                orientation, staging_bytes, staging_hash, error_code, error_message,
                error_retryable, error_outcome, error_details_json,
                replica_state, replica_attempt, retry_at_ms,
                created_at, updated_at, updated_at_ms
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?18, ?19,
                ?20, ?21, ?22, ?23, ?24,
                ?25, ?26, ?27,
                ?28, ?29, ?30,
                ?31, ?32, ?33
            ) ON CONFLICT(import_id) DO NOTHING"#,
            params![
                record.import_id,
                record.instance_id,
                record.module_id,
                record.security_domain,
                wire_state(record.state),
                record.params_digest,
                record.media_kind,
                record.source_kind,
                record.source_json,
                record.declared_media_type,
                record.expected_byte_length.map(|v| v as i64),
                bool_i64(record.remote_required),
                record.deadline,
                record.max_bytes as i64,
                record.asset_id,
                record.detected_media_type,
                record.byte_length.map(|v| v as i64),
                record.encoded_width.map(|v| v as i64),
                record.encoded_height.map(|v| v as i64),
                record.orientation.map(i64::from),
                record.staging_bytes.map(|v| v as i64),
                record.staging_hash,
                record.error_code,
                record.error_message,
                record.error_retryable.map(bool_i64),
                record.error_outcome,
                record.error_details_json,
                wire_replica(record.replica_state),
                record.replica_attempt as i64,
                record.retry_at_ms.map(|v| v as i64),
                record.created_at,
                record.updated_at,
                record.updated_at_ms as i64,
            ],
        )?;
        Ok(changed == 1)
    }

    pub fn load_import(&self, import_id: &str) -> StoreResult<Option<ImportRecord>> {
        load_import_from(&self.tx, import_id)
    }

    /// Compare-and-set one import state transition. Returns `Conflict` when
    /// the import is absent or no longer in `from`.
    pub fn cas_import(
        &self,
        import_id: &str,
        from: ImportState,
        to: ImportState,
        patch: &ImportPatch,
        now: ClockTime,
    ) -> StoreResult<()> {
        if !from.allows(to) {
            return Err(StoreError::IllegalTransition { from, to });
        }
        let changed = self.tx.execute(
            r#"UPDATE asset_imports SET
                state = ?1,
                updated_at = ?2,
                updated_at_ms = ?3,
                asset_id = COALESCE(?4, asset_id),
                detected_media_type = COALESCE(?5, detected_media_type),
                byte_length = COALESCE(?6, byte_length),
                encoded_width = COALESCE(?7, encoded_width),
                encoded_height = COALESCE(?8, encoded_height),
                orientation = COALESCE(?9, orientation),
                staging_bytes = COALESCE(?10, staging_bytes),
                staging_hash = COALESCE(?11, staging_hash),
                error_code = ?12,
                error_message = ?13,
                error_retryable = ?14,
                error_outcome = ?15,
                error_details_json = ?16,
                replica_state = ?17,
                replica_attempt = COALESCE(?18, replica_attempt),
                retry_at_ms = COALESCE(?19, retry_at_ms)
            WHERE import_id = ?20 AND state = ?21"#,
            params![
                wire_state(to),
                now.iso(),
                now.millis as i64,
                patch.asset_id,
                patch.detected_media_type,
                patch.byte_length.map(|v| v as i64),
                patch.encoded_width.map(|v| v as i64),
                patch.encoded_height.map(|v| v as i64),
                patch.orientation.map(i64::from),
                patch.staging_bytes.map(|v| v as i64),
                patch.staging_hash,
                patch.error_code,
                patch.error_message,
                patch.error_retryable.map(bool_i64),
                patch.error_outcome,
                patch.error_details_json,
                wire_replica(patch.replica_state),
                patch.replica_attempt.map(|v| v as i64),
                patch.retry_at_ms.map(|v| v as i64),
                import_id,
                wire_state(from),
            ],
        )?;
        if changed != 1 {
            return Err(StoreError::Conflict(import_id.to_string()));
        }
        Ok(())
    }

    /// Update byte-accounting fields while acquiring (no state change).
    pub fn update_import_staging(
        &self,
        import_id: &str,
        staging_bytes: u64,
        staging_hash: &str,
        now: ClockTime,
    ) -> StoreResult<()> {
        let changed = self.tx.execute(
            "UPDATE asset_imports SET staging_bytes = ?1, staging_hash = ?2,
                updated_at = ?3, updated_at_ms = ?4 WHERE import_id = ?5",
            params![
                staging_bytes as i64,
                staging_hash,
                now.iso(),
                now.millis as i64,
                import_id
            ],
        )?;
        if changed != 1 {
            return Err(StoreError::NotFound(import_id.to_string()));
        }
        Ok(())
    }

    /// Resolve a `COMMITTING` mapping: the asset row may or may not exist.
    pub fn find_live_asset(
        &self,
        content_hash: &str,
        domain: &str,
    ) -> StoreResult<Option<(String, u64)>> {
        Ok(self
            .tx
            .query_row(
                "SELECT asset_id, generation FROM asset_records
                 WHERE content_hash = ?1 AND security_domain = ?2 AND lifecycle = 'live'
                 ORDER BY generation DESC LIMIT 1",
                params![content_hash, domain],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64)),
            )
            .optional()?)
    }

    /// The next lifecycle generation for a resurrected content/domain pair.
    pub fn next_generation(&self, content_hash: &str, domain: &str) -> StoreResult<u64> {
        let max: Option<i64> = self
            .tx
            .query_row(
                "SELECT COALESCE(MAX(generation), -1) FROM asset_records
                 WHERE content_hash = ?1 AND security_domain = ?2",
                params![content_hash, domain],
                |r| r.get(0),
            )
            .optional()?;
        match max {
            Some(value) => Ok(value.max(0) as u64 + 1),
            None => Ok(0),
        }
    }

    pub fn insert_asset(&self, record: &AssetRecord, now: ClockTime) -> StoreResult<()> {
        self.tx.execute(
            r#"INSERT INTO asset_records (
                asset_id, security_domain, generation, content_hash, byte_length,
                declared_media_type, detected_media_type, orientation,
                encoded_width, encoded_height, display_width, display_height,
                lifecycle, deletion_generation, local_state, replica_state,
                tombstoned_at, created_at, updated_at, updated_at_ms
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5,
                ?6, ?7, ?8,
                ?9, ?10, ?11, ?12,
                ?13, ?14, ?15, ?16,
                ?17, ?18, ?19, ?20
            ) ON CONFLICT(asset_id, security_domain, generation) DO NOTHING"#,
            params![
                record.asset_id,
                record.security_domain,
                record.generation as i64,
                record.content_hash.digest_hex(),
                record.byte_length as i64,
                record.declared_media_type,
                record.detected_media_type,
                record.orientation.map(i64::from),
                record.encoded_width.map(|v| v as i64),
                record.encoded_height.map(|v| v as i64),
                record.display_width.map(|v| v as i64),
                record.display_height.map(|v| v as i64),
                wire_lifecycle(record.lifecycle),
                record.deletion_generation as i64,
                wire_local(record.local_state),
                wire_replica(record.replica_state),
                record.tombstoned_at,
                record.created_at,
                record.updated_at,
                now.millis as i64,
            ],
        )?;
        Ok(())
    }

    /// The current live lifecycle row for one asset in one domain.
    pub fn load_live_asset(
        &self,
        asset_id: &str,
        domain: &str,
    ) -> StoreResult<Option<AssetRecord>> {
        load_asset_where(
            &self.tx,
            "WHERE asset_id = ?1 AND security_domain = ?2 AND lifecycle = 'live'
             ORDER BY generation DESC LIMIT 1",
            params![asset_id, domain],
        )
    }

    /// Every lifecycle row (any domain, any generation) for one content
    /// address, ordered by domain then generation.
    pub fn all_rows_for_asset(&self, asset_id: &str) -> StoreResult<Vec<AssetRecord>> {
        load_assets_where(
            &self.tx,
            "WHERE asset_id = ?1 ORDER BY security_domain, generation",
            params![asset_id],
        )
    }

    /// Insert a durable reference iff the target lifecycle is live. The
    /// lifecycle check and the insert share one transaction.
    pub fn insert_reference(
        &self,
        reference: &AssetReference,
        now: ClockTime,
    ) -> StoreResult<()> {
        let live = self.asset_live(&reference.asset_id, &reference.security_domain, reference.generation)?;
        if !live {
            return Err(StoreError::Integrity("asset is not live".to_string()));
        }
        self.tx.execute(
            "INSERT INTO asset_references
                (asset_id, security_domain, generation, ref_key, owner, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING",
            params![
                reference.asset_id,
                reference.security_domain,
                reference.generation as i64,
                reference.ref_key,
                reference.owner,
                now.iso(),
            ],
        )?;
        Ok(())
    }

    pub fn remove_reference(
        &self,
        asset_id: &str,
        domain: &str,
        generation: u64,
        ref_key: &str,
    ) -> StoreResult<bool> {
        let changed = self.tx.execute(
            "DELETE FROM asset_references WHERE asset_id = ?1 AND security_domain = ?2
             AND generation = ?3 AND ref_key = ?4",
            params![asset_id, domain, generation as i64, ref_key],
        )?;
        Ok(changed == 1)
    }

    fn asset_live(
        &self,
        asset_id: &str,
        domain: &str,
        generation: u64,
    ) -> StoreResult<bool> {
        let live: Option<String> = self
            .tx
            .query_row(
                "SELECT lifecycle FROM asset_records WHERE asset_id = ?1
                 AND security_domain = ?2 AND generation = ?3",
                params![asset_id, domain, generation as i64],
                |r| r.get(0),
            )
            .optional()?;
        Ok(live.as_deref() == Some("live"))
    }

    pub fn reference_count(
        &self,
        asset_id: &str,
        domain: &str,
        generation: u64,
    ) -> StoreResult<u64> {
        let count: i64 = self.tx.query_row(
            "SELECT COUNT(*) FROM asset_references WHERE asset_id = ?1
             AND security_domain = ?2 AND generation = ?3",
            params![asset_id, domain, generation as i64],
            |r| r.get(0),
        )?;
        Ok(count as u64)
    }

    /// Insert a lease iff the asset is not tombstoned (atomic).
    pub fn insert_lease(&self, lease: &AssetLease) -> StoreResult<()> {
        let live = self.asset_live(&lease.asset_id, &lease.security_domain, lease.generation)?;
        if !live {
            return Err(StoreError::Integrity("asset is not live".to_string()));
        }
        self.tx.execute(
            "INSERT INTO asset_leases
                (lease_id, asset_id, security_domain, generation, owner, purpose,
                 created_at, expires_at, expires_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                lease.lease_id,
                lease.asset_id,
                lease.security_domain,
                lease.generation as i64,
                lease.owner,
                lease.purpose,
                lease.created_at,
                lease.expires_at,
                lease.expires_at_ms as i64,
            ],
        )?;
        Ok(())
    }

    pub fn release_lease(&self, lease_id: &str) -> StoreResult<bool> {
        let changed = self.tx.execute(
            "DELETE FROM asset_leases WHERE lease_id = ?1",
            params![lease_id],
        )?;
        Ok(changed == 1)
    }

    pub fn load_lease(&self, lease_id: &str) -> StoreResult<Option<AssetLease>> {
        Ok(self
            .tx
            .query_row(
                "SELECT lease_id, asset_id, security_domain, generation, owner, purpose,
                        created_at, expires_at, expires_at_ms
                 FROM asset_leases WHERE lease_id = ?1",
                params![lease_id],
                |r| {
                    Ok(AssetLease {
                        lease_id: r.get(0)?,
                        asset_id: r.get(1)?,
                        security_domain: r.get(2)?,
                        generation: r.get::<_, i64>(3)? as u64,
                        owner: r.get(4)?,
                        purpose: r.get(5)?,
                        created_at: r.get(6)?,
                        expires_at: r.get(7)?,
                        expires_at_ms: r.get::<_, i64>(8)? as u64,
                    })
                },
            )
            .optional()?)
    }

    pub fn unexpired_lease_count(
        &self,
        asset_id: &str,
        domain: &str,
        generation: u64,
        now_ms: u64,
    ) -> StoreResult<u64> {
        let count: i64 = self.tx.query_row(
            "SELECT COUNT(*) FROM asset_leases WHERE asset_id = ?1 AND security_domain = ?2
             AND generation = ?3 AND expires_at_ms > ?4",
            params![asset_id, domain, generation as i64, now_ms as i64],
            |r| r.get(0),
        )?;
        Ok(count as u64)
    }

    pub fn insert_pin(&self, pin: &AssetPin) -> StoreResult<()> {
        let live = self.asset_live(&pin.asset_id, &pin.security_domain, pin.generation)?;
        if !live {
            return Err(StoreError::Integrity("asset is not live".to_string()));
        }
        self.tx.execute(
            "INSERT INTO asset_pins
                (pin_id, asset_id, security_domain, generation, owner, reason,
                 privileged, created_at, expires_at, expires_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                pin.pin_id,
                pin.asset_id,
                pin.security_domain,
                pin.generation as i64,
                pin.owner,
                pin.reason,
                bool_i64(pin.privileged),
                pin.created_at,
                pin.expires_at,
                pin.expires_at_ms.map(|v| v as i64),
            ],
        )?;
        Ok(())
    }

    pub fn remove_pin(&self, pin_id: &str) -> StoreResult<bool> {
        let changed = self.tx.execute(
            "DELETE FROM asset_pins WHERE pin_id = ?1",
            params![pin_id],
        )?;
        Ok(changed == 1)
    }

    pub fn live_pin_count(
        &self,
        asset_id: &str,
        domain: &str,
        generation: u64,
        now_ms: u64,
    ) -> StoreResult<u64> {
        let count: i64 = self.tx.query_row(
            "SELECT COUNT(*) FROM asset_pins WHERE asset_id = ?1 AND security_domain = ?2
             AND generation = ?3 AND (expires_at_ms IS NULL OR expires_at_ms > ?4)",
            params![asset_id, domain, generation as i64, now_ms as i64],
            |r| r.get(0),
        )?;
        Ok(count as u64)
    }

    /// Candidates whose grace period has elapsed: live rows with zero
    /// durable references, no live pins, and no unexpired leases.
    pub fn list_gc_candidates(&self, now_ms: u64, grace_ms: u64) -> StoreResult<Vec<(String, String, u64)>> {
        let cutoff = now_ms.saturating_sub(grace_ms);
        let mut stmt = self.tx.prepare(
            "SELECT r.asset_id, r.security_domain, r.generation FROM asset_records r
             WHERE r.lifecycle = 'live' AND r.updated_at_ms <= ?1
               AND NOT EXISTS (SELECT 1 FROM asset_references ref
                    WHERE ref.asset_id = r.asset_id AND ref.security_domain = r.security_domain
                      AND ref.generation = r.generation)
               AND NOT EXISTS (SELECT 1 FROM asset_pins p
                    WHERE p.asset_id = r.asset_id AND p.security_domain = r.security_domain
                      AND p.generation = r.generation AND (p.expires_at_ms IS NULL OR p.expires_at_ms > ?2))
               AND NOT EXISTS (SELECT 1 FROM asset_leases l
                    WHERE l.asset_id = r.asset_id AND l.security_domain = r.security_domain
                      AND l.generation = r.generation AND l.expires_at_ms > ?2)",
        )?;
        let rows = stmt
            .query_map(params![cutoff as i64, now_ms as i64], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)? as u64,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// The mark step of GC: recheck references/pins/leases inside this
    /// transaction, flip the row to tombstoned, and record the audit
    /// tombstone. Returns false when a reference, pin, or lease won, or the
    /// grace period has not yet elapsed.
    pub fn mark_tombstone(
        &self,
        asset_id: &str,
        domain: &str,
        generation: u64,
        now_ms: u64,
        grace_ms: u64,
        now: ClockTime,
    ) -> StoreResult<bool> {
        let cutoff = now_ms.saturating_sub(grace_ms);
        let row: Option<(String, i64, String, i64, i64, String, i64)> = self
            .tx
            .query_row(
                "SELECT lifecycle, updated_at_ms, content_hash, byte_length,
                        deletion_generation, security_domain, generation
                 FROM asset_records WHERE asset_id = ?1 AND security_domain = ?2 AND generation = ?3",
                params![asset_id, domain, generation as i64],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, i64>(6)?,
                    ))
                },
            )
            .optional()?;
        let Some((lifecycle, updated_ms, content_hash, byte_length, del_gen, _dom, _gen)) = row
        else {
            return Ok(false);
        };
        if lifecycle != "live" || updated_ms > cutoff as i64 {
            return Ok(false);
        }
        let refs = self.reference_count(asset_id, domain, generation)?;
        let pins = self.live_pin_count(asset_id, domain, generation, now_ms)?;
        let leases = self.unexpired_lease_count(asset_id, domain, generation, now_ms)?;
        if refs > 0 || pins > 0 || leases > 0 {
            return Ok(false);
        }
        let changed = self.tx.execute(
            "UPDATE asset_records SET lifecycle = 'tombstoned',
                deletion_generation = deletion_generation + 1,
                tombstoned_at = ?4, updated_at = ?5, updated_at_ms = ?6
             WHERE asset_id = ?1 AND security_domain = ?2 AND generation = ?3
               AND lifecycle = 'live'",
            params![
                asset_id,
                domain,
                generation as i64,
                now.iso(),
                now.iso(),
                now.millis as i64
            ],
        )?;
        if changed != 1 {
            return Ok(false);
        }
        self.tx.execute(
            "INSERT INTO asset_tombstones
                (asset_id, security_domain, generation, deletion_generation, content_hash,
                 byte_length, local_outcome, deleted_at, deleted_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8)",
            params![
                asset_id,
                domain,
                generation as i64,
                del_gen + 1,
                content_hash,
                byte_length,
                now.iso(),
                now.millis as i64
            ],
        )?;
        Ok(true)
    }

    /// Record the local-deletion outcome on the most recent tombstone.
    pub fn record_tombstone_local_outcome(
        &self,
        asset_id: &str,
        domain: &str,
        generation: u64,
        outcome: &str,
    ) -> StoreResult<()> {
        self.tx.execute(
            "UPDATE asset_tombstones SET local_outcome = ?4
             WHERE asset_id = ?1 AND security_domain = ?2 AND generation = ?3
               AND deletion_generation = (SELECT MAX(deletion_generation) FROM asset_tombstones
                    WHERE asset_id = ?1 AND security_domain = ?2 AND generation = ?3)",
            params![asset_id, domain, generation as i64, outcome],
        )?;
        Ok(())
    }

    /// Tombstones whose deletion has not completed (for operator
    /// enumeration): still pending, or failed locally/replica-side.
    pub fn list_tombstones_with_failed_outcome(
        &self,
    ) -> StoreResult<Vec<AssetTombstone>> {
        let mut stmt = self.tx.prepare(
            "SELECT asset_id, security_domain, generation, deletion_generation,
                    content_hash, byte_length, local_outcome, deleted_at, deleted_at_ms
             FROM asset_tombstones
             WHERE local_outcome IN ('pending', 'local_delete_failed', 'replica_delete_failed')
             ORDER BY deleted_at_ms",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(AssetTombstone {
                    asset_id: r.get(0)?,
                    security_domain: r.get(1)?,
                    generation: r.get::<_, i64>(2)? as u64,
                    deletion_generation: r.get::<_, i64>(3)? as u64,
                    content_hash: r.get(4)?,
                    byte_length: r.get::<_, i64>(5)? as u64,
                    local_outcome: r.get(6)?,
                    deleted_at: r.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

/// A set of optional field updates applied by a CAS transition.
#[derive(Debug, Clone, Default)]
pub struct ImportPatch {
    pub asset_id: Option<String>,
    pub detected_media_type: Option<String>,
    pub byte_length: Option<u64>,
    pub encoded_width: Option<u64>,
    pub encoded_height: Option<u64>,
    pub orientation: Option<u8>,
    pub staging_bytes: Option<u64>,
    pub staging_hash: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub error_retryable: Option<bool>,
    pub error_outcome: Option<String>,
    pub error_details_json: Option<String>,
    pub replica_state: ReplicaState,
    pub replica_attempt: Option<u64>,
    pub retry_at_ms: Option<u64>,
}

impl ImportPatch {
    pub fn rejection(error: &crate::error::AssetError) -> Self {
        Self {
            error_code: Some(error.code.to_string()),
            error_message: Some(error.message.clone()),
            error_retryable: Some(error.code.retryable()),
            error_outcome: Some("not_applied".to_string()),
            error_details_json: serde_json::to_string(&error.to_envelope().details).ok(),
            ..Self::default()
        }
    }
}

// ---------------------------------------------------------------------------
// Row loaders and helpers
// ---------------------------------------------------------------------------

fn load_import_from(tx: &rusqlite::Transaction<'_>, import_id: &str) -> StoreResult<Option<ImportRecord>> {
    let row = tx
        .query_row(
            "SELECT import_id, instance_id, module_id, security_domain, state, params_digest,
                    media_kind, source_kind, source_json, declared_media_type,
                    expected_byte_length, remote_required, deadline, max_bytes,
                    asset_id, detected_media_type, byte_length, encoded_width, encoded_height,
                    orientation, staging_bytes, staging_hash, error_code, error_message,
                    error_retryable, error_outcome, error_details_json,
                    replica_state, replica_attempt, retry_at_ms,
                    created_at, updated_at, updated_at_ms
             FROM asset_imports WHERE import_id = ?1",
            params![import_id],
            |r| map_import_row(r),
        )
        .optional()?;
    Ok(row)
}

fn map_import_row(
    r: &rusqlite::Row<'_>,
) -> rusqlite::Result<ImportRecord> {
    let state: String = r.get(4)?;
    let replica_state: String = r.get(27)?;
    Ok(ImportRecord {
        import_id: r.get(0)?,
        instance_id: r.get(1)?,
        module_id: r.get(2)?,
        security_domain: r.get(3)?,
        state: parse_state(&state)
            .ok_or_else(|| rusqlite::Error::FromSqlConversionFailure(
                4,
                SqlType::Text,
                "unknown import state".into(),
            ))?,
        params_digest: r.get(5)?,
        media_kind: r.get(6)?,
        source_kind: r.get(7)?,
        source_json: r.get(8)?,
        declared_media_type: r.get(9)?,
        expected_byte_length: r.get::<_, Option<i64>>(10)?.map(|v| v as u64),
        remote_required: i64_bool(r.get::<_, i64>(11)?),
        deadline: r.get(12)?,
        max_bytes: r.get::<_, i64>(13)? as u64,
        asset_id: r.get(14)?,
        detected_media_type: r.get(15)?,
        byte_length: r.get::<_, Option<i64>>(16)?.map(|v| v as u64),
        encoded_width: r.get::<_, Option<i64>>(17)?.map(|v| v as u64),
        encoded_height: r.get::<_, Option<i64>>(18)?.map(|v| v as u64),
        orientation: r.get::<_, Option<i64>>(19)?.map(|v| v as u8),
        staging_bytes: r.get::<_, Option<i64>>(20)?.map(|v| v as u64),
        staging_hash: r.get(21)?,
        error_code: r.get(22)?,
        error_message: r.get(23)?,
        error_retryable: r.get::<_, Option<i64>>(24)?.map(i64_bool),
        error_outcome: r.get(25)?,
        error_details_json: r.get(26)?,
        replica_state: parse_replica(&replica_state)
            .ok_or_else(|| rusqlite::Error::FromSqlConversionFailure(
                27,
                SqlType::Text,
                "unknown replica state".into(),
            ))?,
        replica_attempt: r.get::<_, i64>(28)? as u64,
        retry_at_ms: r.get::<_, Option<i64>>(29)?.map(|v| v as u64),
        created_at: r.get(30)?,
        updated_at: r.get(31)?,
        updated_at_ms: r.get::<_, i64>(32)? as u64,
    })
}

fn load_asset_where(
    tx: &rusqlite::Transaction<'_>,
    where_clause: &str,
    params: &[&dyn rusqlite::ToSql],
) -> StoreResult<Option<AssetRecord>> {
    let query = format!(
        "SELECT asset_id, security_domain, generation, content_hash, byte_length,
                declared_media_type, detected_media_type, orientation,
                encoded_width, encoded_height, display_width, display_height,
                lifecycle, deletion_generation, local_state, replica_state,
                tombstoned_at, created_at, updated_at, updated_at_ms
         FROM asset_records {where_clause}"
    );
    let row = tx.query_row(&query, params, |r| map_asset_row(r)).optional()?;
    Ok(row)
}

fn load_assets_where(
    tx: &rusqlite::Transaction<'_>,
    where_clause: &str,
    params: &[&dyn rusqlite::ToSql],
) -> StoreResult<Vec<AssetRecord>> {
    let query = format!(
        "SELECT asset_id, security_domain, generation, content_hash, byte_length,
                declared_media_type, detected_media_type, orientation,
                encoded_width, encoded_height, display_width, display_height,
                lifecycle, deletion_generation, local_state, replica_state,
                tombstoned_at, created_at, updated_at, updated_at_ms
         FROM asset_records {where_clause}"
    );
    let mut stmt = tx.prepare(&query)?;
    let rows = stmt
        .query_map(params, |r| map_asset_row(r))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn map_asset_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<AssetRecord> {
    let lifecycle: String = r.get(12)?;
    let local_state: String = r.get(14)?;
    let replica_state: String = r.get(15)?;
    let content_hash_hex: String = r.get(3)?;
    let content_hash = ContentHash::from_digest_hex(&content_hash_hex).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(
            3,
            SqlType::Text,
            format!("bad stored content hash: {e}").into(),
        )
    })?;
    Ok(AssetRecord {
        asset_id: r.get(0)?,
        security_domain: r.get(1)?,
        generation: r.get::<_, i64>(2)? as u64,
        content_hash,
        byte_length: r.get::<_, i64>(4)? as u64,
        declared_media_type: r.get(5)?,
        detected_media_type: r.get(6)?,
        orientation: r.get::<_, Option<i64>>(7)?.map(|v| v as u8),
        encoded_width: r.get::<_, Option<i64>>(8)?.map(|v| v as u64),
        encoded_height: r.get::<_, Option<i64>>(9)?.map(|v| v as u64),
        display_width: r.get::<_, Option<i64>>(10)?.map(|v| v as u64),
        display_height: r.get::<_, Option<i64>>(11)?.map(|v| v as u64),
        lifecycle: parse_lifecycle(&lifecycle)
            .ok_or_else(|| rusqlite::Error::FromSqlConversionFailure(
                12,
                SqlType::Text,
                "unknown lifecycle".into(),
            ))?,
        deletion_generation: r.get::<_, i64>(13)? as u64,
        local_state: parse_local(&local_state)
            .ok_or_else(|| rusqlite::Error::FromSqlConversionFailure(
                14,
                SqlType::Text,
                "unknown local state".into(),
            ))?,
        replica_state: parse_replica(&replica_state)
            .ok_or_else(|| rusqlite::Error::FromSqlConversionFailure(
                15,
                SqlType::Text,
                "unknown replica state".into(),
            ))?,
        tombstoned_at: r.get(16)?,
        created_at: r.get(17)?,
        updated_at: r.get(18)?,
        updated_at_ms: r.get::<_, i64>(19)? as u64,
    })
}

// ---------------------------------------------------------------------------
// Accessors that open their own immediate transaction
// ---------------------------------------------------------------------------

impl AssetStore {
    pub fn load_import_public(&mut self, import_id: &str) -> StoreResult<Option<ImportRecord>> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let record = load_import_from(&tx, import_id)?;
        tx.commit()?;
        Ok(record)
    }

    /// Count durable import records (Host diagnostics).
    pub fn load_import_count(&self) -> rusqlite::Result<i64> {
        self.connection
            .query_row("SELECT COUNT(*) FROM asset_imports", [], |r| r.get(0))
    }

    /// Iterate every import in non-terminal (or explicitly listed) states.
    pub fn load_imports_in_states(
        &mut self,
        states: &[ImportState],
    ) -> StoreResult<Vec<ImportRecord>> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let placeholders = vec!["?"; states.len()].join(",");
        let sql = format!(
            "SELECT import_id, instance_id, module_id, security_domain, state, params_digest,
                    media_kind, source_kind, source_json, declared_media_type,
                    expected_byte_length, remote_required, deadline, max_bytes,
                    asset_id, detected_media_type, byte_length, encoded_width, encoded_height,
                    orientation, staging_bytes, staging_hash, error_code, error_message,
                    error_retryable, error_outcome, error_details_json,
                    replica_state, replica_attempt, retry_at_ms,
                    created_at, updated_at, updated_at_ms
             FROM asset_imports WHERE state IN ({placeholders})"
        );
        let params_vec: Vec<String> = states.iter().map(|s| wire_state(*s).to_string()).collect();
        let refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        let mut stmt = tx.prepare(&sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(refs), map_import_row)?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        tx.commit()?;
        Ok(rows)
    }
}

// ---------------------------------------------------------------------------
// Coders
// ---------------------------------------------------------------------------

pub(crate) fn wire_state(state: ImportState) -> &'static str {
    state.wire_name()
}

fn parse_state(text: &str) -> Option<ImportState> {
    Some(match text {
        "accepted" => ImportState::Accepted,
        "acquiring" => ImportState::Acquiring,
        "verifying" => ImportState::Verifying,
        "committing" => ImportState::Committing,
        "replicating" => ImportState::Replicating,
        "replica_failed" => ImportState::ReplicaFailed,
        "available" => ImportState::Available,
        "rejected" => ImportState::Rejected,
        "cancelled" => ImportState::Cancelled,
        _ => return None,
    })
}

pub(crate) fn wire_replica(state: ReplicaState) -> &'static str {
    state.wire_name()
}

fn parse_replica(text: &str) -> Option<ReplicaState> {
    Some(match text {
        "disabled" => ReplicaState::Disabled,
        "pending_upload" => ReplicaState::PendingUpload,
        "present" => ReplicaState::Present,
        "upload_failed" => ReplicaState::UploadFailed,
        "pending_delete" => ReplicaState::PendingDelete,
        "delete_failed" => ReplicaState::DeleteFailed,
        "deleted" => ReplicaState::Deleted,
        _ => return None,
    })
}

pub(crate) fn wire_lifecycle(lifecycle: Lifecycle) -> &'static str {
    match lifecycle {
        Lifecycle::Live => "live",
        Lifecycle::Tombstoned => "tombstoned",
    }
}

fn parse_lifecycle(text: &str) -> Option<Lifecycle> {
    match text {
        "live" => Some(Lifecycle::Live),
        "tombstoned" => Some(Lifecycle::Tombstoned),
        _ => None,
    }
}

pub(crate) fn wire_local(state: LocalState) -> &'static str {
    match state {
        LocalState::Present => "present",
        LocalState::Missing => "missing",
        LocalState::Quarantined => "quarantined",
    }
}

fn parse_local(text: &str) -> Option<LocalState> {
    match text {
        "present" => Some(LocalState::Present),
        "missing" => Some(LocalState::Missing),
        "quarantined" => Some(LocalState::Quarantined),
        _ => None,
    }
}

fn bool_i64(value: bool) -> i64 {
    if value { 1 } else { 0 }
}

fn i64_bool(value: i64) -> bool {
    value != 0
}

/// Refuse paths with any symlinkable component (mirrors the storage open
/// gate: a substituted target must never be touched).
pub fn reject_symlink_components(path: &Path) -> StoreResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let mut current = path;
        if current.exists() {
            let meta = std::fs::symlink_metadata(current)
                .map_err(|e| StoreError::Integrity(format!("cannot stat store path: {e}")))?;
            if meta.file_type().is_symlink() {
                return Err(StoreError::Integrity(
                    "store path must not be a symlink".to_string(),
                ));
            }
        }
        while let Some(parent) = current.parent() {
            current = parent;
            if current.as_os_str().is_empty() || current == Path::new("/") {
                break;
            }
            let meta = std::fs::symlink_metadata(current)
                .map_err(|e| StoreError::Integrity(format!("cannot stat store parent: {e}")))?;
            if meta.file_type().is_symlink() {
                return Err(StoreError::Integrity(
                    "store path must not contain a symlink component".to_string(),
                ));
            }
        }
    }
    Ok(())
}
