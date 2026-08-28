//! Durable serialization fence between one daemon activation and any grant
//! replace/revoke commit on another connection of the same database file.
//!
//! The activation acquires the fence inside the same immediate transaction
//! that atomically re-validates the current Host grant. While the fence row
//! is active, `install_host_capability_grant` and
//! `revoke_host_capability_grant` refuse inside their own transactions, so a
//! grant change cannot commit between that validation and the end of the
//! activation (its final G2 admission). The fence is durable SQLite state and
//! therefore visible to every connection; it is not a process-local mutex and
//! needs no recheck-after-commit compensation.

use rusqlite::{Connection, Transaction};

use crate::database::map_sqlite_error;
use crate::error::StorageResult;

/// Schema for the durable grant activation fence.
pub const GRANT_FENCE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS grant_activation_fence (
    owner TEXT NOT NULL PRIMARY KEY,
    grant_revision INTEGER NOT NULL CHECK (grant_revision BETWEEN 1 AND 9007199254740991),
    active INTEGER NOT NULL CHECK (active IN (0, 1))
);
"#;

pub(crate) fn ensure_grant_fence_schema(connection: &Connection) -> StorageResult<()> {
    connection
        .execute_batch(GRANT_FENCE_SCHEMA_SQL)
        .map_err(map_sqlite_error)
}

/// True while any activation holds the fence, inside the caller's own
/// transaction.
pub(crate) fn fence_is_active(transaction: &Transaction<'_>) -> StorageResult<bool> {
    let active: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(active), 0) FROM grant_activation_fence",
            [],
            |row| row.get(0),
        )
        .map_err(map_sqlite_error)?;
    Ok(active == 1)
}
