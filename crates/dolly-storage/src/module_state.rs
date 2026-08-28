use std::time::{SystemTime, UNIX_EPOCH};

use dolly_core_domain::{ModuleId, ModuleStorageScopeId, UuidV7};
use dolly_core_reducer::CoreSnapshot;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::Value;

use crate::database::map_sqlite_error;
use crate::error::{StorageError, StorageResult};

const MODULE_STORAGE_OWNER_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS module_storage_owners (
    module_id TEXT PRIMARY KEY NOT NULL,
    storage_scope_id TEXT NOT NULL UNIQUE,
    host_incarnation_revision INTEGER NOT NULL
        CHECK (host_incarnation_revision BETWEEN 1 AND 9007199254740991)
);
"#;
const MODULE_STORAGE_OWNER_COLUMNS: &[&str] =
    &["module_id", "storage_scope_id", "host_incarnation_revision"];

/// An opaque projection issued only from the verified Host storage owner.
///
/// Its identity, storage scope, revision, and safe durable state are copied
/// from one current durable Core snapshot. There is no public constructor,
/// serializer, deserializer, or mutable state path.
///
/// ```compile_fail
/// use dolly_storage::ModuleStateProjection;
///
/// let secret = vec![103_u64, 51, 45, 115, 101, 99, 114, 101, 116];
/// let _projection = ModuleStateProjection::new(secret);
/// ```
#[derive(Debug, PartialEq, Eq)]
pub struct ModuleStateProjection {
    module_id: ModuleId,
    storage_scope_id: ModuleStorageScopeId,
    revision: u64,
    durable_commit_seq: u64,
}

impl ModuleStateProjection {
    pub fn module_id(&self) -> &ModuleId {
        &self.module_id
    }

    pub fn storage_scope_id(&self) -> &ModuleStorageScopeId {
        &self.storage_scope_id
    }
    pub const fn revision(&self) -> u64 {
        self.revision
    }

    pub const fn durable_commit_seq(&self) -> u64 {
        self.durable_commit_seq
    }

    pub(crate) fn from_storage(
        module_id: ModuleId,
        storage_scope_id: ModuleStorageScopeId,
        revision: i64,
        durable_commit_seq: i64,
    ) -> StorageResult<Self> {
        let revision = safe_positive_u64(revision)?;
        let durable_commit_seq = safe_positive_u64(durable_commit_seq)?;
        Ok(Self {
            module_id,
            storage_scope_id,
            revision,
            durable_commit_seq,
        })
    }
}

pub(crate) fn initialize_module_storage_schema(connection: &Connection) -> StorageResult<()> {
    connection
        .execute_batch(MODULE_STORAGE_OWNER_SCHEMA_SQL)
        .map_err(map_sqlite_error)?;
    let mut statement = connection
        .prepare("PRAGMA table_info(module_storage_owners)")
        .map_err(map_sqlite_error)?;
    let actual = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(map_sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(map_sqlite_error)?;
    if actual != MODULE_STORAGE_OWNER_COLUMNS {
        return Err(StorageError::MigrationRequired);
    }
    Ok(())
}

pub(crate) fn load_owner(
    transaction: &Transaction<'_>,
    module_id: &ModuleId,
) -> StorageResult<Option<(ModuleStorageScopeId, i64)>> {
    let row = transaction
        .query_row(
            "SELECT storage_scope_id, host_incarnation_revision
             FROM module_storage_owners WHERE module_id = ?1",
            params![module_id.to_string()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(map_sqlite_error)?;
    row.map(|(scope, host_revision)| {
        let scope = scope.parse::<UuidV7>().map_err(|_| StorageError::Corrupt)?;
        if host_revision <= 0 {
            return Err(StorageError::Corrupt);
        }
        Ok((ModuleStorageScopeId::from_uuid_v7(scope), host_revision))
    })
    .transpose()
}

pub(crate) fn insert_owner(
    transaction: &Transaction<'_>,
    module_id: &ModuleId,
    storage_scope_id: &ModuleStorageScopeId,
    host_incarnation_revision: i64,
) -> StorageResult<()> {
    if host_incarnation_revision <= 0 {
        return Err(StorageError::Corrupt);
    }
    transaction
        .execute(
            "INSERT INTO module_storage_owners
             (module_id, storage_scope_id, host_incarnation_revision)
             VALUES (?1, ?2, ?3)",
            params![
                module_id.to_string(),
                storage_scope_id.to_string(),
                host_incarnation_revision,
            ],
        )
        .map_err(map_sqlite_error)?;
    Ok(())
}

pub(crate) fn update_owner_incarnation(
    transaction: &Transaction<'_>,
    module_id: &ModuleId,
    host_incarnation_revision: i64,
) -> StorageResult<()> {
    if host_incarnation_revision <= 0 {
        return Err(StorageError::Corrupt);
    }
    let changed = transaction
        .execute(
            "UPDATE module_storage_owners
             SET host_incarnation_revision = ?2 WHERE module_id = ?1",
            params![module_id.to_string(), host_incarnation_revision],
        )
        .map_err(map_sqlite_error)?;
    if changed != 1 {
        return Err(StorageError::Corrupt);
    }
    Ok(())
}

pub(crate) fn module_projection(
    snapshot: &CoreSnapshot,
    module_id: &ModuleId,
    storage_scope_id: ModuleStorageScopeId,
    revision: i64,
) -> StorageResult<ModuleStateProjection> {
    ModuleStateProjection::from_storage(
        module_id.clone(),
        storage_scope_id,
        revision,
        snapshot.next_commit_seq,
    )
}

pub(crate) fn admitted_module_id(
    snapshot: &CoreSnapshot,
    requested_module_id: &ModuleId,
) -> Option<ModuleId> {
    let requested_module_id = requested_module_id.to_string();
    let admitted_module_id = snapshot
        .graph
        .get("graph")
        .and_then(Value::as_object)
        .and_then(|graph| graph.get("descriptors"))
        .and_then(Value::as_object)
        .and_then(|descriptors| descriptors.get(&requested_module_id))
        .and_then(|descriptor| descriptor.get("value"))
        .and_then(Value::as_object)
        .and_then(|descriptor| descriptor.get("module_id"))
        .and_then(Value::as_str)?;
    if admitted_module_id == requested_module_id {
        ModuleId::from_string(admitted_module_id.to_owned()).ok()
    } else {
        None
    }
}

fn safe_positive_i64(value: i64) -> StorageResult<i64> {
    if (1..=9_007_199_254_740_991).contains(&value) {
        Ok(value)
    } else {
        Err(StorageError::Corrupt)
    }
}

fn safe_positive_u64(value: i64) -> StorageResult<u64> {
    Ok(safe_positive_i64(value)? as u64)
}

pub(crate) fn mint_storage_scope_id() -> StorageResult<ModuleStorageScopeId> {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| StorageError::Corrupt)?
        .as_millis();
    let timestamp = u64::try_from(milliseconds).map_err(|_| StorageError::Corrupt)?;
    if timestamp > 0x0000_FFFF_FFFF_FFFF {
        return Err(StorageError::Corrupt);
    }
    let mut random = [0_u8; 10];
    getrandom::fill(&mut random).map_err(|_| StorageError::Corrupt)?;
    let mut bytes = [0_u8; 16];
    bytes[0..6].copy_from_slice(&timestamp.to_be_bytes()[2..]);
    bytes[6] = 0x70 | (random[0] & 0x0f);
    bytes[7] = random[1];
    bytes[8] = 0x80 | (random[2] & 0x3f);
    bytes[9..16].copy_from_slice(&random[3..10]);
    let text = format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    );
    let uuid = text.parse::<UuidV7>().map_err(|_| StorageError::Corrupt)?;
    Ok(ModuleStorageScopeId::from_uuid_v7(uuid))
}
