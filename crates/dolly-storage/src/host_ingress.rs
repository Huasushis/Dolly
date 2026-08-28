//! Authoritative durable Host ingress slice (submit/status seam).
//!
//! This module owns the exact `host_ingress_mappings` table, its `PRIMARY
//! KEY` over the ingress key, the minted `ingress_id`/`block_id` `UNIQUE`
//! constraints, the lifecycle/relation and digest `CHECK`s, the
//! `host_ingress_meta` schema singleton, and the `host_ingress_mappings`
//! recovery index. It is the only writer of the mapping inside the one
//! authoritative Runtime database, under the same exclusive instance lock and
//! durability profile as Core state.
//!
//! Every committed row stores the exact canonical mapping record JCS
//! (`mapping_jcs`) plus its digest (`mapping_digest`); every read recomputes
//! the digest, re-decodes the closed record, and verifies every indexed
//! column against the decoded record. A mapping whose record, columns,
//! digests, or per-state constraints disagree fails closed (`StorageError::Corrupt`).
//!
//! **Pre-effect persistence.** A submit executes inside ONE immediate SQLite
//! transaction: the premise/mapping row is inserted first, the pure reducer
//! effect (Block, deliveries, journal) is applied second, and the effect
//! linkage completes the row third. The mapping therefore always exists in
//! the transaction before any Core consumer effect row is written, and the
//! single commit means a crash at any stage leaves zero partial mapping rows:
//! `status` either returns the committed mapping (reconcile, never resubmit)
//! or authoritative `Absent` (byte-identical replay permitted).
//!
//! **Idempotency.** The ingress key is the (owner, source, external event)
//! namespace; the operation digest binds every premise field including the
//! ordered target Pages. Same key + same digest returns the prior mapping
//! unchanged; same key + different digest is a conflict that changes nothing.

use dolly_canonical_json::{ParseLimits, Sha256Digest, canonicalize, deserialize_core_json};
use dolly_core_domain::{
    BlockId, HostIngress, HostIngressError, HostIngressErrorCode, HostIngressKey,
    HostIngressMapping, HostIngressPremise, HostIngressStatus, HostIngressSubmitOutcome,
    IngressDelivery, IngressId,
    HOST_INGRESS_RECORD_SCHEMA, HOST_INGRESS_SCHEMA_VERSION,
    MAX_HOST_INGRESS_PAYLOAD_JCS_BYTES,
};

use dolly_core_reducer::{
    CoreSnapshot, EnvironmentInput, HostIngressPremiseError, IngressIdentity, TransitionOutcome,
    build_ingress_command, derive_ingress_identity,
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::Value;

use crate::database::map_sqlite_error;
use crate::error::{StorageError, StorageResult};
use crate::transaction::{CoreTransaction, SqliteCoreTransaction, canonical_digest};

/// The logical table this slice writes.
pub const HOST_INGRESS_MAPPINGS_TABLE: &str = "host_ingress_mappings";

/// The schema discriminator stored in the meta singleton.
pub const HOST_INGRESS_SCHEMA_DISCRIMINATOR: &str = "dolly.host-ingress/v1";

/// The authoritative Host ingress schema: the meta singleton and the mapping
/// table. Installed only inside the controller-owned initialization
/// transaction; ordinary opens never execute it and never repair partial
/// objects.
pub const HOST_INGRESS_SCHEMA_SQL: &str = r#"
CREATE TABLE host_ingress_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    schema_discriminator TEXT NOT NULL
        CHECK (schema_discriminator = 'dolly.host-ingress/v1')
);
CREATE TABLE host_ingress_mappings (
    ingress_key TEXT PRIMARY KEY NOT NULL
        CHECK (ingress_key LIKE 'sha256:%' AND length(ingress_key) = 71),
    operation_digest TEXT NOT NULL
        CHECK (operation_digest LIKE 'sha256:%' AND length(operation_digest) = 71),
    payload_digest TEXT NOT NULL
        CHECK (payload_digest LIKE 'sha256:%' AND length(payload_digest) = 71),
    owner TEXT NOT NULL,
    extension_id TEXT NOT NULL,
    module_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    generation INTEGER NOT NULL
        CHECK (generation BETWEEN 1 AND 9007199254740991),
    external_event_id TEXT NOT NULL,
    kind TEXT NOT NULL
        CHECK (kind IN ('message', 'edit', 'delete')),
    references_external_event_id TEXT,
    target_pages_jcs BLOB NOT NULL,
    revision INTEGER NOT NULL
        CHECK (revision BETWEEN 1 AND 9007199254740991),
    ingress_id TEXT NOT NULL UNIQUE
        CHECK (length(ingress_id) = 36),
    block_id TEXT NOT NULL UNIQUE
        CHECK (length(block_id) = 36),
    graph_revision INTEGER
        CHECK (graph_revision BETWEEN 1 AND 9007199254740991),
    deliveries_jcs BLOB,
    command_id TEXT,
    mapping_jcs BLOB,
    mapping_digest TEXT
        CHECK (
            mapping_digest IS NULL OR
            (mapping_digest LIKE 'sha256:%' AND length(mapping_digest) = 71)
        ),
    CHECK (
        (kind = 'message' AND references_external_event_id IS NULL) OR
        (kind IN ('edit', 'delete') AND references_external_event_id IS NOT NULL)
    ),
    CHECK ((graph_revision IS NULL) = (deliveries_jcs IS NULL)),
    CHECK ((mapping_jcs IS NULL) = (mapping_digest IS NULL))
);
"#;

/// Deterministic recovery-order index over committed mappings by source.
pub const HOST_INGRESS_RECOVERY_INDEX_SQL: &str = r#"
CREATE INDEX host_ingress_mappings_recovery
    ON host_ingress_mappings(module_id, owner);
"#;

/// Install the Host ingress schema inside the controller-owned fresh/offline
/// initialization transaction. Existing partial or malformed objects fail
/// closed instead of being repaired.
pub(crate) fn initialize_host_ingress_schema(transaction: &Transaction<'_>) -> StorageResult<()> {
    initialize_host_ingress_schema_inner(transaction)
}
/// Create the Host ingress schema on an existing connection, inside its own
/// immediate transaction. Existing partial or malformed objects fail closed
/// instead of being repaired.
pub fn create_host_ingress_schema(connection: &mut Connection) -> StorageResult<()> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(map_sqlite_error)?;
    initialize_host_ingress_schema(&transaction)?;
    transaction.commit().map_err(map_sqlite_error)}

fn initialize_host_ingress_schema_inner(
    transaction: &Transaction<'_>,
) -> StorageResult<()> {
    let has_objects: i64 = transaction
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master
                WHERE type IN ('table', 'index')
                  AND name IN (
                    'host_ingress_meta',
                    'host_ingress_mappings',
                    'host_ingress_mappings_recovery'
                  )
             )",
            [],
            |row| row.get(0),
        )
        .map_err(map_sqlite_error)?;
    if has_objects != 0 {
        return gate_host_ingress_schema(transaction);
    }
    transaction
        .execute_batch(HOST_INGRESS_SCHEMA_SQL)
        .map_err(map_sqlite_error)?;
    transaction
        .execute_batch(HOST_INGRESS_RECOVERY_INDEX_SQL)
        .map_err(map_sqlite_error)?;
    transaction
        .execute(
            "INSERT INTO host_ingress_meta
                (singleton, schema_version, schema_discriminator)
             VALUES (1, 1, 'dolly.host-ingress/v1')",
            [],
        )
        .map(|_| ())
        .map_err(map_sqlite_error)?;
    Ok(())
}

/// Fail-closed schema gate every Host ingress reader/writer must pass.
/// Ordinary opens never create or repair a missing table, index, or metadata
/// row.
pub fn gate_host_ingress_schema(connection: &Connection) -> StorageResult<()> {
    verify_object_sql(
        connection,
        "table",
        "host_ingress_meta",
        HOST_INGRESS_SCHEMA_SQL_META,
        StorageError::MigrationRequired,
    )?;
    verify_object_sql(
        connection,
        "table",
        HOST_INGRESS_MAPPINGS_TABLE,
        HOST_INGRESS_SCHEMA_SQL_TABLE,
        StorageError::Corrupt,
    )?;
    verify_table_columns(connection)?;
    let metadata: Option<(i64, String)> = connection
        .query_row(
            "SELECT schema_version, schema_discriminator
             FROM host_ingress_meta WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(map_sqlite_error)?;
    let Some((version, discriminator)) = metadata else {
        return Err(StorageError::MigrationRequired);
    };
    if version != HOST_INGRESS_SCHEMA_VERSION || discriminator != HOST_INGRESS_SCHEMA_DISCRIMINATOR
    {
        return Err(StorageError::MigrationRequired);
    }
    Ok(())
}

/// The exact meta-table definition used both in the batch SQL and the gate.
fn verify_table_columns(connection: &Connection) -> StorageResult<()> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info(host_ingress_mappings)"))
        .map_err(map_sqlite_error)?;
    let actual = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(map_sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(map_sqlite_error)?;
    if actual != MAPPING_COLUMNS {
        return Err(StorageError::Corrupt);
    }
    Ok(())
}

pub const HOST_INGRESS_SCHEMA_SQL_META: &str = r#"CREATE TABLE host_ingress_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    schema_discriminator TEXT NOT NULL
        CHECK (schema_discriminator = 'dolly.host-ingress/v1')
)"#;

/// The exact mapping-table definition used both in the batch SQL and the gate.
pub const HOST_INGRESS_SCHEMA_SQL_TABLE: &str = r#"CREATE TABLE host_ingress_mappings (
    ingress_key TEXT PRIMARY KEY NOT NULL
        CHECK (ingress_key LIKE 'sha256:%' AND length(ingress_key) = 71),
    operation_digest TEXT NOT NULL
        CHECK (operation_digest LIKE 'sha256:%' AND length(operation_digest) = 71),
    payload_digest TEXT NOT NULL
        CHECK (payload_digest LIKE 'sha256:%' AND length(payload_digest) = 71),
    owner TEXT NOT NULL,
    extension_id TEXT NOT NULL,
    module_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    generation INTEGER NOT NULL
        CHECK (generation BETWEEN 1 AND 9007199254740991),
    external_event_id TEXT NOT NULL,
    kind TEXT NOT NULL
        CHECK (kind IN ('message', 'edit', 'delete')),
    references_external_event_id TEXT,
    target_pages_jcs BLOB NOT NULL,
    revision INTEGER NOT NULL
        CHECK (revision BETWEEN 1 AND 9007199254740991),
    ingress_id TEXT NOT NULL UNIQUE
        CHECK (length(ingress_id) = 36),
    block_id TEXT NOT NULL UNIQUE
        CHECK (length(block_id) = 36),
    graph_revision INTEGER
        CHECK (graph_revision BETWEEN 1 AND 9007199254740991),
    deliveries_jcs BLOB,
    command_id TEXT,
    mapping_jcs BLOB,
    mapping_digest TEXT
        CHECK (
            mapping_digest IS NULL OR
            (mapping_digest LIKE 'sha256:%' AND length(mapping_digest) = 71)
        ),
    CHECK (
        (kind = 'message' AND references_external_event_id IS NULL) OR
        (kind IN ('edit', 'delete') AND references_external_event_id IS NOT NULL)
    ),
    CHECK ((graph_revision IS NULL) = (deliveries_jcs IS NULL)),
    CHECK ((mapping_jcs IS NULL) = (mapping_digest IS NULL))
)"#;

fn normalized_schema_sql(sql: &str) -> String {
    sql.split_whitespace().collect::<String>()
}

fn verify_object_sql(
    connection: &Connection,
    object_type: &str,
    name: &str,
    expected: &str,
    missing_error: StorageError,
) -> StorageResult<()> {
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT type, sql FROM sqlite_master WHERE name = ?1",
            [name],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(map_sqlite_error)?;
    match row {
        Some((actual_type, actual))
            if actual_type == object_type
                && normalized_schema_sql(&actual) == normalized_schema_sql(expected) =>
        {
            Ok(())
        }
        Some(_) => Err(StorageError::Corrupt),
        None => Err(missing_error),
    }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/// The durable Host ingress store over one verified Runtime connection.
///
/// Implements the generic [`HostIngress`] submit/status interface.
pub struct SqliteHostIngressStore<'connection> {
    connection: &'connection mut Connection,
}

impl<'connection> SqliteHostIngressStore<'connection> {
    /// Create the store and verify the Host ingress schema is present and
    /// exact. Missing or malformed schema fails closed (no repair).
    pub fn new(connection: &'connection mut Connection) -> StorageResult<Self> {
        gate_host_ingress_schema(connection)?;
        Ok(Self { connection })
    }
}

impl HostIngress for SqliteHostIngressStore<'_> {
    fn submit(
        &mut self,
        premise: &HostIngressPremise,
    ) -> Result<HostIngressSubmitOutcome, HostIngressError> {
        gate_host_ingress_schema(self.connection).map_err(map_storage)?;
        let identity = derive_ingress_identity(premise).map_err(map_premise)?;
        let ingress_id = mint_ingress_id(&identity.key).map_err(map_storage)?;
        let block_id = mint_block_id(&identity.key, &identity.operation_digest)
            .map_err(map_storage)?;

        let (payload_jcs, _) = canonicalize(&premise.payload).map_err(|_| {
            HostIngressError::new(
                HostIngressErrorCode::PremiseInvalid,
                "premise payload failed canonicalization",
            )
        })?;
        if payload_jcs.as_bytes().len() > MAX_HOST_INGRESS_PAYLOAD_JCS_BYTES {
            return Err(HostIngressError::new(
                HostIngressErrorCode::PremiseTooLarge,
                format!(
                    "premise payload exceeds the {MAX_HOST_INGRESS_PAYLOAD_JCS_BYTES}-byte ceiling"
                ),
            ));
        }

        let command = build_ingress_command(&identity, &block_id, premise);
        let input = EnvironmentInput {
            now: "2026-08-28T00:00:00.000000Z".into(),
            ..Default::default()
        };
        let mut transaction =
            SqliteCoreTransaction::begin_for(self.connection, &command, &input)
                .map_err(map_storage)?;
       
        // 1. Reconcile: a committed mapping is the durable authority.
        if let Some(mapping) =
            load_mapping_in_transaction(transaction.sql_transaction()?, identity.key.as_str())?
        {
            drop(transaction);
            if mapping.operation_digest == identity.operation_digest {
                return Ok(HostIngressSubmitOutcome::Committed {
                    mapping: Box::new(mapping),
                    idempotent: true,
                });
            }
            return Ok(HostIngressSubmitOutcome::Conflict {
                key: identity.key.clone(),
                stored_digest: mapping.operation_digest,
                submitted_digest: identity.operation_digest,
            });
        }

               // 2. Pre-effect persistence: the exact premise/mapping row is
        //    inserted before any Core consumer effect row in this
        //    transaction. The reducer effect completes the row before the
        //    single commit.
        insert_premise_row(
            transaction.sql_transaction_mut()?,
            &identity,
            premise,
            &ingress_id,
            &block_id,
        )?;
       
        // 3. Core consumer effect, committed under the same atomic
        //    transaction and only after the mapping row exists.
        let snapshot = transaction
            .load_command_snapshot(&command)
            .map_err(map_storage)?;
        let graph_revision = snapshot
            .graph
            .get("revision")
            .and_then(Value::as_i64)
            .unwrap_or(-1);
        if graph_revision < 1 {
            drop(transaction);
            return Err(HostIngressError::new(
                HostIngressErrorCode::NotReady,
                "no installed graph revision to commit an ingress effect against",
            ));
        }
        let transition = dolly_core_reducer::reduce(&snapshot, &command, &input);
        if transition.outcome != TransitionOutcome::Committed {
            let reason = transition
                .error
                .as_ref()
                .map(|error| error.code.clone())
                .unwrap_or_else(|| "core effect refused".into());
            drop(transaction);
            return Err(HostIngressError::new(
                HostIngressErrorCode::NotReady,
                format!("core effect not committed: {reason}"),
            ));
        }
        transaction
            .compare_and_apply(&transition)
            .map_err(map_storage)?;
        transaction
            .append_journal(&transition.events)
            .map_err(map_storage)?;

        // 4. Complete the mapping row with the effect linkage.
        let deliveries = deliveries_for_block(&transition.state, block_id.as_str())?;
        let mapping = HostIngressMapping {
            schema: HOST_INGRESS_RECORD_SCHEMA.into(),
            ingress_key: identity.key.to_string(),
            operation_digest: identity.operation_digest.clone(),
            owner: premise.owner.clone(),
            extension_id: premise.source.extension_id.to_string(),
            module_id: premise.source.module_id.to_string(),
            instance_id: premise.source.instance_id.to_string(),
            generation: premise.source.generation.value() as i64,
            external_event_id: premise.external_event_id.clone(),
            kind: premise.kind.as_str().into(),
            references_external_event_id: premise.references_external_event_id.clone(),
            target_page_ids: identity.canonical_target_page_ids.clone(),
            payload: premise.payload.clone(),
            payload_digest: identity.payload_digest.clone(),
            revision: premise.revision,
            ingress_id: ingress_id.to_string(),
            block_id: block_id.to_string(),
            graph_revision,
            deliveries,
            command_id: command.command_id().to_owned(),
        };
        let (mapping_jcs, mapping_digest) = canonical_digest(&mapping)?;
        let (deliveries_jcs, _) = canonical_digest(&mapping.deliveries)?;
        complete_mapping_row(
            transaction.sql_transaction_mut()?,
            identity.key.as_str(),
            graph_revision,
            &deliveries_jcs,
            &mapping.command_id,
            &mapping_jcs,
            &mapping_digest,
        )?;
        transaction.commit().map_err(map_storage)?;

        Ok(HostIngressSubmitOutcome::Committed {
            mapping: Box::new(mapping),
            idempotent: false,
        })
    }

    fn status(
        &mut self,
        key: &HostIngressKey,
    ) -> Result<HostIngressStatus, HostIngressError> {
        gate_host_ingress_schema(self.connection).map_err(map_storage)?;
        let mapping = load_mapping_in_transaction(self.connection, key.as_str())
            .map_err(map_storage)?;
        Ok(match mapping {
            Some(mapping) => HostIngressStatus::Committed(Box::new(mapping)),
            None => HostIngressStatus::Absent,
        })
    }
}

// ---------------------------------------------------------------------------
// Row persistence and verification
// ---------------------------------------------------------------------------

const MAPPING_COLUMNS: &[&str] = &[
    "ingress_key",
    "operation_digest",
    "payload_digest",
    "owner",
    "extension_id",
    "module_id",
    "instance_id",
    "generation",
    "external_event_id",
    "kind",
    "references_external_event_id",
    "target_pages_jcs",
    "revision",
    "ingress_id",
    "block_id",
    "graph_revision",
    "deliveries_jcs",
    "command_id",
    "mapping_jcs",
    "mapping_digest",
];

fn insert_premise_row(
    transaction: &Transaction<'_>,
    identity: &IngressIdentity,
    premise: &HostIngressPremise,
    ingress_id: &IngressId,
    block_id: &BlockId,
) -> StorageResult<()> {
    let (target_pages_jcs, _) = canonical_digest(&identity.canonical_target_page_ids)?;
    transaction
        .execute(
            "INSERT INTO host_ingress_mappings (
                ingress_key, operation_digest, payload_digest, owner,
                extension_id, module_id, instance_id, generation,
                external_event_id, kind, references_external_event_id,
                target_pages_jcs, revision, ingress_id, block_id
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
             )",
            params![
                identity.key.as_str(),
                identity.operation_digest,
                identity.payload_digest,
                premise.owner,
                premise.source.extension_id.as_str(),
                premise.source.module_id.as_str(),
                premise.source.instance_id.as_str(),
                premise.source.generation.value() as i64,
                premise.external_event_id,
                premise.kind.as_str(),
                premise.references_external_event_id,
                target_pages_jcs,
                premise.revision,
                ingress_id.as_str(),
                block_id.as_str(),
            ],
        )
        .map(|_| ())
        .map_err(map_sqlite_error)?;
    Ok(())
}

fn complete_mapping_row(
    transaction: &Transaction<'_>,
    ingress_key: &str,
    graph_revision: i64,
    deliveries_jcs: &[u8],
    command_id: &str,
    mapping_jcs: &[u8],
    mapping_digest: &str,
) -> StorageResult<()> {
    transaction
        .execute(
            "UPDATE host_ingress_mappings
             SET graph_revision = ?2, deliveries_jcs = ?3, command_id = ?4,
                 mapping_jcs = ?5, mapping_digest = ?6
             WHERE ingress_key = ?1",
            params![
                ingress_key,
                graph_revision,
                deliveries_jcs,
                command_id,
                mapping_jcs,
                mapping_digest
            ],
        )
        .map(|updated| {
            if updated != 1 {
                return Err(StorageError::Corrupt);
            }
            Ok(())
        })
        .map_err(map_sqlite_error)??;
    Ok(())
}

struct MappingRow {
    ingress_key: String,
    operation_digest: String,
    payload_digest: String,
    owner: String,
    extension_id: String,
    module_id: String,
    instance_id: String,
    generation: i64,
    external_event_id: String,
    kind: String,
    references_external_event_id: Option<String>,
    target_pages_jcs: Vec<u8>,
    revision: i64,
    ingress_id: String,
    block_id: String,
    graph_revision: i64,
    deliveries_jcs: Vec<u8>,
    command_id: String,
    mapping_jcs: Vec<u8>,
    mapping_digest: String,
}

fn load_mapping_in_transaction(
    connection: &Connection,
    ingress_key: &str,
) -> StorageResult<Option<HostIngressMapping>> {
    let row: Option<MappingRow> = connection
        .query_row(
            "SELECT operation_digest, payload_digest, owner,
                    extension_id, module_id, instance_id, generation,
                    external_event_id, kind, references_external_event_id,
                    target_pages_jcs, revision, ingress_id, block_id,
                    graph_revision, deliveries_jcs, command_id,
                    mapping_jcs, mapping_digest
             FROM host_ingress_mappings
             WHERE ingress_key = ?1",
            [ingress_key],
            |row| read_mapping_row(row, ingress_key),
        )
        .optional()
        .map_err(map_sqlite_error)?;
    row.map(verify_mapping_row).transpose()
}

fn read_mapping_row(row: &rusqlite::Row<'_>, ingress_key: &str) -> rusqlite::Result<MappingRow> {
    Ok(MappingRow {
        ingress_key: ingress_key.to_owned(),
        operation_digest: row.get(0)?,
        payload_digest: row.get(1)?,
        owner: row.get(2)?,
        extension_id: row.get(3)?,
        module_id: row.get(4)?,
        instance_id: row.get(5)?,
        generation: row.get(6)?,
        external_event_id: row.get(7)?,
        kind: row.get(8)?,
        references_external_event_id: row.get(9)?,
        target_pages_jcs: row.get(10)?,
        revision: row.get(11)?,
        ingress_id: row.get(12)?,
        block_id: row.get(13)?,
        graph_revision: row.get(14)?,
        deliveries_jcs: row.get(15)?,
        command_id: row.get(16)?,
        mapping_jcs: row.get(17)?,
        mapping_digest: row.get(18)?,
    })
}

fn verify_mapping_row(row: MappingRow) -> StorageResult<HostIngressMapping> {
    // A fully committed mapping carries its closed record; the pre-effect
    // intermediate state is never observable outside its transaction.
    let mapping: HostIngressMapping = decode_canonical_mapping(&row.mapping_jcs)?;
    if mapping.schema != HOST_INGRESS_RECORD_SCHEMA {
        return Err(StorageError::Corrupt);
    }
    let (_, computed_digest) = canonical_digest(&mapping)?;
    if computed_digest != row.mapping_digest {
        return Err(StorageError::Corrupt);
    }
    let (target_pages_bytes, _) = canonical_digest(&mapping.target_page_ids)?;
    let (deliveries_bytes, _) = canonical_digest(&mapping.deliveries)?;
    if mapping.ingress_key != row.ingress_key
        || mapping.operation_digest != row.operation_digest
        || mapping.payload_digest != row.payload_digest
        || mapping.owner != row.owner
        || mapping.extension_id != row.extension_id
        || mapping.module_id != row.module_id
        || mapping.instance_id != row.instance_id
        || mapping.generation != row.generation
        || mapping.external_event_id != row.external_event_id
        || mapping.kind != row.kind
        || mapping.references_external_event_id != row.references_external_event_id
        || target_pages_bytes != row.target_pages_jcs
        || mapping.revision != row.revision
        || mapping.ingress_id != row.ingress_id
        || mapping.block_id != row.block_id
        || mapping.graph_revision != row.graph_revision
        || deliveries_bytes != row.deliveries_jcs
        || mapping.command_id != row.command_id
    {
        return Err(StorageError::Corrupt);
    }
    Ok(mapping)
}

fn decode_canonical_mapping(bytes: &[u8]) -> StorageResult<HostIngressMapping> {
    let value: Value = deserialize_core_json(
        bytes,
        ParseLimits::semantic(64).map_err(|_| StorageError::Corrupt)?,
    )
    .map_err(|_| StorageError::Corrupt)?;
    let (canonical, _) = canonicalize(&value).map_err(|_| StorageError::Corrupt)?;
    if canonical.as_bytes() != bytes {
        return Err(StorageError::Corrupt);
    }
    serde_json::from_value(value).map_err(|_| StorageError::Corrupt)
}

/// Extract the exact per-Page deliveries the reducer produced for one Block.
fn deliveries_for_block(
    state: &CoreSnapshot,
    block_id: &str,
) -> StorageResult<Vec<IngressDelivery>> {
    let mut deliveries = Vec::new();
    for record in &state.deliveries {
        if record.get("block_id").and_then(Value::as_str) != Some(block_id) {
            continue;
        }
        let page_id = record
            .get("page_id")
            .and_then(Value::as_str)
            .ok_or(StorageError::Corrupt)?
            .to_owned();
        let commit_seq = record
            .get("commit_seq")
            .and_then(Value::as_i64)
            .ok_or(StorageError::Corrupt)?;
        deliveries.push(IngressDelivery { page_id, commit_seq });
    }
    if deliveries.is_empty() {
        return Err(StorageError::Corrupt);
    }
    Ok(deliveries)
}

// ---------------------------------------------------------------------------
// Deterministic store-minted identities
// ---------------------------------------------------------------------------

fn domain_hash(prefix: &[u8], parts: &[&[u8]]) -> Sha256Digest {
    let mut input =
        Vec::with_capacity(prefix.len() + parts.iter().map(|part| part.len() + 1).sum::<usize>());
    input.extend_from_slice(prefix);
    for part in parts {
        input.extend_from_slice(part);
        input.push(0);
    }
    Sha256Digest::compute(&input)
}

/// Format a canonical SHA-256 digest into a lowercase RFC-9562-shaped UUIDv7
/// string (version nibble 7, variant nibble 8) from its first 32 hex digits.
fn uuid7_shape(digest: &str) -> String {
    let hex = &digest["sha256:".len()..];
    let mut out: Vec<u8> = Vec::with_capacity(36);
    for (index, character) in hex.bytes().take(32).enumerate() {
        out.push(character);
        if matches!(index, 7 | 11 | 15 | 19) {
            out.push(b'-');
        }
    }
    // Force the RFC-9562 version and variant nibbles at their UUID output
    // positions (14 and 19), independent of the input hex layout.
    out[14] = b'7';
    out[19] = b'8';
    String::from_utf8(out).expect("uuid shape is ASCII")
}

fn mint_ingress_id(key: &HostIngressKey) -> StorageResult<IngressId> {
    let digest = domain_hash(b"dolly.host-ingress\0ingress-id\0", &[key.as_str().as_bytes()]);
    let shaped = uuid7_shape(&digest.to_canonical_string());
    shaped
        .parse::<IngressId>()
        .map_err(|_| StorageError::Corrupt)
}

fn mint_block_id(key: &HostIngressKey, operation_digest: &str) -> StorageResult<BlockId> {
    let digest = domain_hash(
        b"dolly.host-ingress\0block-id\0",
        &[key.as_str().as_bytes(), operation_digest.as_bytes()],
    );
    let shaped = uuid7_shape(&digest.to_canonical_string());
    shaped
        .parse::<BlockId>()
        .map_err(|_| StorageError::Corrupt)
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

fn map_storage(error: StorageError) -> HostIngressError {
    match error {
        StorageError::Busy => {
            HostIngressError::new(HostIngressErrorCode::Busy, "storage is busy; retryable")
        }
        StorageError::Full => HostIngressError::new(
            HostIngressErrorCode::Full,
            "durable ingress capacity exhausted",
        ),
        StorageError::MigrationRequired => HostIngressError::new(
            HostIngressErrorCode::MigrationRequired,
            "durable Host ingress schema is missing or stale",
        ),
        other => HostIngressError::new(
            HostIngressErrorCode::Corrupt,
            format!("durable Host ingress failed verification: {other}"),
        ),
    }
}

impl From<StorageError> for HostIngressError {
    fn from(error: StorageError) -> Self {
        map_storage(error)
    }
}

fn map_premise(error: HostIngressPremiseError) -> HostIngressError {
    match error {
        HostIngressPremiseError::PayloadTooLarge(_) => HostIngressError::new(
            HostIngressErrorCode::PremiseTooLarge,
            format!("{error}"),
        ),
        other => HostIngressError::new(HostIngressErrorCode::PremiseInvalid, format!("{other}")),
    }
}
