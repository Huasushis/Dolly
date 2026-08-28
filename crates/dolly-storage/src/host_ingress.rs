//! Authoritative durable Host ingress slice (submit/status seam).
//!
//! This module owns the exact `host_ingress_mappings` table, its `PRIMARY
//! KEY` over the ingress key, the freshly allocated `ingress_id`/`block_id`
//! `UNIQUE` constraints, the lifecycle/relation and digest `CHECK`s, the
//! `host_ingress_meta` schema singleton, and the declared recovery index. It
//! is the only writer of the mapping inside the one authoritative Runtime
//! database, under the same exclusive instance lock and durability profile as
//! Core state.
//!
//! **Authority.** A premise is never caller-shaped. [`HostIngress::submit`]
//! accepts only the opaque current [`HostConnectionAuthority`] and
//! [`HostCapabilityGrant`] (which have no public constructor, clone, or
//! deserializer) plus a caller request that carries event content only. The
//! transaction re-verifies that the passed authority is the current Host
//! authority, that the passed grant is the current unrevoked grant for the
//! module and authorizes `host.ingress.submit`, and it validates the
//! referenced event, the exact ordered target Pages against the installed
//! graph's producer direction, and the graph revision. The stored premise
//! binds owner/source/instance/generation/revision all derived from the
//! opaque authority and grant, so a caller cannot copy arbitrary identity,
//! fence, lifecycle, or Pages values into durable state.
//!
//! **Pre-effect persistence.** A submit executes inside ONE immediate SQLite
//! transaction: the row with the closed canonical premise bytes is inserted
//! first, the pure reducer effect (Block, deliveries, journal) is applied
//! second, and the effect linkage completes the row with the closed canonical
//! mapping bytes third. The single commit means a crash at any stage leaves
//! zero partial mapping rows; `status` either returns the committed mapping
//! (reconcile, never resubmit) or authoritative `Absent` (byte-identical
//! replay permitted) — but absence and commitment are each cross-checked
//! against the Core operation/effect ledger, so a deleted or tampered mapping
//! or effect can never masquerade as the other.
//!
//! **Idempotency.** The ingress key is the (owner, source, external event)
//! namespace derived from the calling principal; the operation digest binds
//! every premise field including the authority fences and the ordered target
//! Pages. Same key + same digest returns the prior mapping unchanged; same
//! key + a different digest is a conflict that changes nothing.

use dolly_canonical_json::{ParseLimits, canonicalize, deserialize_core_json};
use dolly_core_domain::{
    BlockId, HostIngressError, HostIngressErrorCode, HostIngressMapping, HostIngressStatus,
    HostIngressStatusRequest, HostIngressSubmitOutcome, HostIngressSubmitRequest, IngressDelivery,
    IngressId, HOST_INGRESS_PREMISE_RECORD_SCHEMA, HOST_INGRESS_RECORD_SCHEMA,
    HOST_INGRESS_SCHEMA_VERSION, HOST_INGRESS_SUBMIT_METHOD, MAX_HOST_INGRESS_ID_TEXT_BYTES,
};
use dolly_core_reducer::{
    CoreCommand, CoreSnapshot, EnvironmentInput, HostIngressPremiseError, IngressAuthorityFacts,
    IngressIdentity, IngressCommand, TransitionOutcome, build_ingress_command,
    derive_ingress_identity, derive_ingress_key, validate_ingress_request,
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::database::map_sqlite_error;
use crate::error::{StorageError, StorageResult};
use crate::runtime_binding::mint_uuid_v7_text;
use crate::transaction::{
    CoreTransaction, HostCapabilityGrant, HostConnectionAuthority, SqliteCoreStore,
    SqliteCoreTransaction, canonical_digest, load_current_host_capability_grant,
    request_identity_digest,
};

/// The logical table this slice writes.
pub const HOST_INGRESS_MAPPINGS_TABLE: &str = "host_ingress_mappings";

/// The schema discriminator stored in the meta singleton.
pub const HOST_INGRESS_SCHEMA_DISCRIMINATOR: &str = "dolly.host-ingress/v1";

/// The fixed environment input the seam commits reducer effects with. It is
/// part of the Core operation request identity, so `status` can recompute the
/// stored digest exactly.
const HOST_INGRESS_INPUT_NOW: &str = "2026-08-28T00:00:00.000000Z";

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
    revision INTEGER NOT NULL
        CHECK (revision BETWEEN 1 AND 9007199254740991),
    graph_revision INTEGER NOT NULL
        CHECK (graph_revision BETWEEN 1 AND 9007199254740991),
    external_event_id TEXT NOT NULL,
    kind TEXT NOT NULL
        CHECK (kind IN ('message', 'edit', 'delete')),
    references_external_event_id TEXT,
    target_pages_jcs BLOB NOT NULL,
    premise_jcs BLOB NOT NULL,
    premise_digest TEXT NOT NULL
        CHECK (premise_digest LIKE 'sha256:%' AND length(premise_digest) = 71),
    ingress_id TEXT NOT NULL UNIQUE
        CHECK (length(ingress_id) = 36),
    block_id TEXT NOT NULL UNIQUE
        CHECK (length(block_id) = 36),
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
    CHECK ((deliveries_jcs IS NULL) = (command_id IS NULL)),
    CHECK ((mapping_jcs IS NULL) = (mapping_digest IS NULL))
);
"#;

/// Deterministic recovery-order index over committed mappings by source.
pub const HOST_INGRESS_RECOVERY_INDEX_SQL: &str = r#"
CREATE INDEX host_ingress_mappings_recovery
    ON host_ingress_mappings(module_id, owner)
"#;

/// The exact meta-table definition used both in the batch SQL and the gate.
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
    revision INTEGER NOT NULL
        CHECK (revision BETWEEN 1 AND 9007199254740991),
    graph_revision INTEGER NOT NULL
        CHECK (graph_revision BETWEEN 1 AND 9007199254740991),
    external_event_id TEXT NOT NULL,
    kind TEXT NOT NULL
        CHECK (kind IN ('message', 'edit', 'delete')),
    references_external_event_id TEXT,
    target_pages_jcs BLOB NOT NULL,
    premise_jcs BLOB NOT NULL,
    premise_digest TEXT NOT NULL
        CHECK (premise_digest LIKE 'sha256:%' AND length(premise_digest) = 71),
    ingress_id TEXT NOT NULL UNIQUE
        CHECK (length(ingress_id) = 36),
    block_id TEXT NOT NULL UNIQUE
        CHECK (length(block_id) = 36),
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
    CHECK ((deliveries_jcs IS NULL) = (command_id IS NULL)),
    CHECK ((mapping_jcs IS NULL) = (mapping_digest IS NULL))
)"#;

const MAPPING_COLUMNS: &[&str] = &[
    "ingress_key",
    "operation_digest",
    "payload_digest",
    "owner",
    "extension_id",
    "module_id",
    "instance_id",
    "generation",
    "revision",
    "graph_revision",
    "external_event_id",
    "kind",
    "references_external_event_id",
    "target_pages_jcs",
    "premise_jcs",
    "premise_digest",
    "ingress_id",
    "block_id",
    "deliveries_jcs",
    "command_id",
    "mapping_jcs",
    "mapping_digest",
];

/// Install the Host ingress schema inside the controller-owned fresh/offline
/// initialization transaction. Existing partial or malformed objects fail
/// closed instead of being repaired.
pub(crate) fn initialize_host_ingress_schema(transaction: &Transaction<'_>) -> StorageResult<()> {
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

/// Create the Host ingress schema on an existing connection, inside its own
/// immediate transaction. Existing partial or malformed objects fail closed
/// instead of being repaired.
pub fn create_host_ingress_schema(connection: &mut Connection) -> StorageResult<()> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(map_sqlite_error)?;
    initialize_host_ingress_schema(&transaction)?;
    transaction.commit().map_err(map_sqlite_error)
}

/// Fail-closed schema gate every Host ingress reader/writer must pass:
/// the meta singleton, the mapping table (exact SQL and columns), and the
/// declared recovery index (exact SQL and columns).
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
    verify_object_sql(
        connection,
        "index",
        "host_ingress_mappings_recovery",
        HOST_INGRESS_RECOVERY_INDEX_SQL,
        StorageError::Corrupt,
)?;
    verify_table_columns(connection)?;
    verify_recovery_index_columns(connection)?;
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

fn verify_recovery_index_columns(connection: &Connection) -> StorageResult<()> {
    let mut statement = connection
        .prepare(&format!("PRAGMA index_info(host_ingress_mappings_recovery)"))
        .map_err(map_sqlite_error)?;
    let actual = statement
        .query_map([], |row| row.get::<_, Option<String>>(2))
        .map_err(map_sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(map_sqlite_error)?;
    if actual
        != vec![
            Some("module_id".to_owned()),
            Some("owner".to_owned()),
        ]
    {
        return Err(StorageError::Corrupt);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Seam
// ---------------------------------------------------------------------------

/// The generic durable Host ingress submit/status interface.
///
/// Implementations run inside the one authoritative Runtime database. The
/// caller supplies the opaque current Host authority and capability grant
/// (never any identity/fence fields) plus an event-content-only request; the
/// implementation re-verifies the principal inside the transaction, persists
/// the closed premise before the Core effect, links the effect atomically,
/// and reconciles lost responses through `status`.
pub trait HostIngress {
    /// Durably submit one already authenticated event and commit its Core
    /// effect. A prior mapping under the same principal's key with the same
    /// operation digest is returned unchanged (idempotent); a prior mapping
    /// under a different digest is a conflict that changes nothing.
    fn submit(
        &mut self,
        authority: &HostConnectionAuthority,
        grant: &HostCapabilityGrant,
        request: &HostIngressSubmitRequest,
    ) -> Result<HostIngressSubmitOutcome, HostIngressError>;

    /// Return the committed mapping for the calling principal's key, or
    /// authoritative absence, cross-verified against the Core
    /// operation/effect ledger so deletion or tamper never reads as the
    /// other.
    fn status(
        &mut self,
        authority: &HostConnectionAuthority,
        grant: &HostCapabilityGrant,
        request: &HostIngressStatusRequest,
    ) -> Result<HostIngressStatus, HostIngressError>;
}

/// The durable Host ingress store over one verified Runtime connection.
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
        authority: &HostConnectionAuthority,
        grant: &HostCapabilityGrant,
        request: &HostIngressSubmitRequest,
    ) -> Result<HostIngressSubmitOutcome, HostIngressError> {
        gate_host_ingress_schema(self.connection).map_err(map_storage)?;
        validate_ingress_request(request).map_err(map_premise)?;
        let facts = authority_facts(authority, grant);
        let identity = derive_ingress_identity(&facts, request).map_err(map_premise)?;
        let ingress_id = mint_identity::<IngressId>().map_err(map_mint)?;
        let block_id = mint_identity::<BlockId>().map_err(map_mint)?;

        let command = build_ingress_command(&identity, &block_id, &facts, request);
        let input = seam_input();
        let mut transaction =
            SqliteCoreTransaction::begin_for(self.connection, &command, &input)
                .map_err(map_storage)?;

        // 1. The scoped principal: the passed authority MUST be the current
        //    Host authority and the passed grant MUST be the current unrevoked
        //    grant authorizing host.ingress.submit.
        verify_current_principal(&transaction, authority, grant)?;

        // 2. Reconcile: a committed mapping is the durable authority.
        if let Some(mapping) =
            load_mapping_row(transaction.sql_transaction()?, identity.key.as_str())?
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

        // 3. The reducer effect authority: the installed graph revision must
        //    equal the grant's, and every target Page must be an authorized
        //    graph output of the module (producer direction, no reverse or
        //    cross-Extension page).
        let snapshot = transaction
            .load_command_snapshot(&command)
            .map_err(map_storage)?;
        let graph_revision = verify_graph_direction(&snapshot, &facts, grant, &identity)?;

        // 4. An edit/delete MUST reference an event the same principal
        //    already committed.
        if let Some(reference) = &request.references_external_event_id {
            let reference_key = derive_ingress_key(&facts, reference);
            if load_mapping_row(transaction.sql_transaction()?, reference_key.as_str())?.is_none() {
                drop(transaction);
                return Err(HostIngressError::new(
                    HostIngressErrorCode::ReferencedEventMissing,
                    format!(
                        "edit/delete references external event {reference:?} which the same principal never committed"
                    ),
                ));
            }
        }

        // 5. Pre-effect persistence: the closed canonical premise bytes are
        //    inserted before any Core consumer effect row in this
        //    transaction.
        let premise = StoredIngressPremise {
            schema: HOST_INGRESS_PREMISE_RECORD_SCHEMA.into(),
            ingress_key: identity.key.to_string(),
            operation_digest: identity.operation_digest.clone(),
            owner: facts.owner.clone(),
            extension_id: facts.extension_id.clone(),
            module_id: facts.module_id.clone(),
            instance_id: facts.instance_id.clone(),
            generation: facts.generation as i64,
            revision: facts.revision,
            graph_revision,
            external_event_id: request.external_event_id.clone(),
            kind: request.kind.as_str().into(),
            references_external_event_id: request.references_external_event_id.clone(),
            target_page_ids: identity.canonical_target_page_ids.clone(),
            payload: request.payload.clone(),
            payload_digest: identity.payload_digest.clone(),
        };
        let (premise_jcs, premise_digest) = canonical_digest(&premise)?;
        let (target_pages_jcs, _) = canonical_digest(&identity.canonical_target_page_ids)?;
        insert_premise_row(
            transaction.sql_transaction_mut()?,
            &identity,
            &facts,
            graph_revision,
            request,
            &premise_jcs,
            &premise_digest,
            &target_pages_jcs,
            &ingress_id,
            &block_id,
        )?;

        // 6. Core consumer effect, committed under the same atomic
        //    transaction and only after the premise row exists.
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

        // 7. Atomically link the effect into the mapping row.
        let deliveries = deliveries_for_block(&transition.state, block_id.as_str())?;
        let mapping = HostIngressMapping {
            schema: HOST_INGRESS_RECORD_SCHEMA.into(),
            ingress_key: identity.key.to_string(),
            operation_digest: identity.operation_digest.clone(),
            owner: facts.owner.clone(),
            extension_id: facts.extension_id.clone(),
            module_id: facts.module_id.clone(),
            instance_id: facts.instance_id.clone(),
            generation: facts.generation as i64,
            revision: facts.revision,
            graph_revision,
            external_event_id: request.external_event_id.clone(),
            kind: request.kind.as_str().into(),
            references_external_event_id: request.references_external_event_id.clone(),
            target_page_ids: identity.canonical_target_page_ids.clone(),
            payload: request.payload.clone(),
            payload_digest: identity.payload_digest.clone(),
            ingress_id: ingress_id.to_string(),
            block_id: block_id.to_string(),
            deliveries,
            command_id: command.command_id().to_owned(),
        };
        let (mapping_jcs, mapping_digest) = canonical_digest(&mapping)?;
        let (deliveries_jcs, _) = canonical_digest(&mapping.deliveries)?;
        complete_mapping_row(
            transaction.sql_transaction_mut()?,
            identity.key.as_str(),
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
        authority: &HostConnectionAuthority,
        grant: &HostCapabilityGrant,
        request: &HostIngressStatusRequest,
    ) -> Result<HostIngressStatus, HostIngressError> {
        gate_host_ingress_schema(self.connection).map_err(map_storage)?;
        validate_status_request(request)?;
        let facts = authority_facts(authority, grant);
        let key = derive_ingress_key(&facts, &request.external_event_id);

        // Scoped principal: a different authority/grant derives a different
        // key, and the passed authority must be the current Host authority
        // with a live grant, or nothing is disclosed.
        {
            let store = SqliteCoreStore::new(self.connection).map_err(map_storage)?;
            let current_authority =
                store.authenticated_host_connection().map_err(map_storage)?;
            if current_authority != *authority {
                return Err(HostIngressError::new(
                    HostIngressErrorCode::NotAuthorized,
                    "the passed Host authority is not the current authority",
                ));
            }
            let current = store
                .current_host_capability_grant(
                    authority,
                    &facts.extension_id,
                    &facts.module_id,
                )
                .map_err(map_storage)?;
            if current.as_ref().map(HostCapabilityGrant::grant_digest)
                != Some(grant.grant_digest())
            {
                return Err(HostIngressError::new(
                    HostIngressErrorCode::NotAuthorized,
                    "the passed grant is not the current grant",
                ));
            }
        }

        let Some(mapping) =
            load_mapping_row(self.connection, key.as_str()).map_err(map_storage)?
        else {
            // Cross-check absence: the deterministic Core operation for this
            // key must not exist, or a deleted mapping would read as absent.
            let command_id = format!("host-ingress-{key}");
            let operation: Option<String> = self
                .connection
                .query_row(
                    "SELECT command_id FROM core_operations WHERE command_id = ?1",
                    [&command_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(map_sqlite_error)?;
            return match operation {
                Some(_) => Err(HostIngressError::new(
                    HostIngressErrorCode::Corrupt,
                    "mapping row is missing but its Core operation exists; never false absent",
                )),
                None => Ok(HostIngressStatus::Absent),
            };
        };

        // Cross-check commitment: the Core operation digest and the reducer
        // effect (Block + deliveries) must exactly match the mapping.
        let stored_snapshot = {
            let store = SqliteCoreStore::new(self.connection).map_err(map_storage)?;
            store.snapshot().map_err(map_storage)?
        };
        let input = seam_input();
        let command = command_for_mapping(&mapping);
        let expected_request_digest =
            request_identity_digest(&command, &input).map_err(map_storage)?;
        let operation: Option<(String, Vec<u8>)> = self
            .connection
            .query_row(
                "SELECT request_digest, transition_jcs
                 FROM core_operations WHERE command_id = ?1",
                [&mapping.command_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(map_sqlite_error)?;
        let Some((stored_request_digest, transition_bytes)) = operation else {
            return Err(HostIngressError::new(
                HostIngressErrorCode::Corrupt,
                "committed mapping lost its Core operation; never false committed",
            ));
        };
        if stored_request_digest != expected_request_digest {
            return Err(HostIngressError::new(
                HostIngressErrorCode::Corrupt,
                "Core operation request digest does not match the committed mapping",
            ));
        }
        let expected_block = serde_json::to_value(&mapping.payload).map_err(|_| {
            HostIngressError::new(HostIngressErrorCode::Corrupt, "payload is not serializable")
        })?;
        let Some(block) = stored_snapshot.blocks.get(&mapping.block_id) else {
            return Err(HostIngressError::new(
                HostIngressErrorCode::Corrupt,
                "committed mapping lost its Core Block; never false committed",
            ));
        };
        let block_content = {
            let mut content = block.clone();
            // The reducer stamps the block with its commit_seq envelope; the
            // remaining block content must equal the mapping's payload.
            if let Some(object) = content.as_object_mut() {
                object.remove("commit_seq");
            }
            content
        };
        if block_content != expected_block {
            return Err(HostIngressError::new(
                HostIngressErrorCode::Corrupt,
                "Core Block content does not match the committed mapping",
            ));
        }
        let deliveries = deliveries_for_block(&stored_snapshot, &mapping.block_id)?;
        if deliveries != mapping.deliveries {
            return Err(HostIngressError::new(
                HostIngressErrorCode::Corrupt,
                "Core deliveries do not match the committed mapping",
            ));
        }
        let _ = transition_bytes;
        Ok(HostIngressStatus::Committed(Box::new(mapping)))
    }
}

// ---------------------------------------------------------------------------
// Principal derivation and validation
// ---------------------------------------------------------------------------

/// Derive the authority-bound premise facts from the opaque current Host
/// authority and capability grant. A caller can never pass these values
/// directly.
fn authority_facts(
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
) -> IngressAuthorityFacts {
    IngressAuthorityFacts {
        owner: authority.extension_connection_id().to_owned(),
        extension_id: grant.extension_id().to_owned(),
        module_id: grant.module_id().to_owned(),
        instance_id: authority.worker_epoch().to_string(),
        generation: grant.extension_generation() as u64,
        revision: authority.incarnation_revision(),
        graph_revision: grant.graph_revision(),
    }
}

fn verify_current_principal(
    transaction: &SqliteCoreTransaction<'_>,
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
) -> Result<(), HostIngressError> {
    if transaction.load_authority().map_err(map_storage)? != *authority {
        return Err(HostIngressError::new(
            HostIngressErrorCode::NotAuthorized,
            "the passed Host authority is not the current Host authority",
        ));
    }
    let Some(current) = load_current_host_capability_grant(
        transaction.sql_transaction().map_err(map_storage)?,
        authority,
        grant.extension_id(),
        grant.module_id(),
        None,
    )
    .map_err(map_storage)?
    else {
        return Err(HostIngressError::new(
            HostIngressErrorCode::NotAuthorized,
            "no current unrevoked capability grant exists for the principal",
        ));
    };
    if current.grant_revision() != grant.grant_revision()
        || current.grant_digest() != grant.grant_digest()
    {
        return Err(HostIngressError::new(
            HostIngressErrorCode::Stale,
            "the passed capability grant is no longer current",
        ));
    }
    if !current.allows(HOST_INGRESS_SUBMIT_METHOD) {
        return Err(HostIngressError::new(
            HostIngressErrorCode::NotAuthorized,
            format!("the capability grant does not allow {HOST_INGRESS_SUBMIT_METHOD}"),
        ));
    }
    Ok(())
}

/// Validate the installed graph for the module: its revision must equal the
/// grant's graph revision, and every ordered target Page must be an
/// authorized output Page of the module (producer direction).
fn verify_graph_direction(
    snapshot: &CoreSnapshot,
    facts: &IngressAuthorityFacts,
    grant: &HostCapabilityGrant,
    identity: &IngressIdentity,
) -> Result<i64, HostIngressError> {
    let graph_revision = snapshot
        .graph
        .get("revision")
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    if graph_revision < 1 {
        return Err(HostIngressError::new(
            HostIngressErrorCode::NotReady,
            "no installed graph revision to commit an ingress effect against",
        ));
    }
    if graph_revision != grant.graph_revision() {
        return Err(HostIngressError::new(
            HostIngressErrorCode::Stale,
            format!(
                "installed graph revision {graph_revision} differs from the grant's graph revision {}",
                grant.graph_revision()
            ),
        ));
    }
    let Some(graph_body) = snapshot.graph.get("graph") else {
        return Err(HostIngressError::new(
            HostIngressErrorCode::Corrupt,
            "installed graph body is missing",
        ));
    };
    let Some(output_pages) = graph_body.get("output_pages").and_then(Value::as_object) else {
        return Err(HostIngressError::new(
            HostIngressErrorCode::NotReady,
            "installed graph has no output_pages",
        ));
    };
    let Some(module_pages) = output_pages
        .get(&facts.module_id)
        .and_then(Value::as_array)
    else {
        return Err(HostIngressError::new(
            HostIngressErrorCode::TargetNotAuthorized,
            format!(
                "module {} is not a graph producer of any page",
                facts.module_id
            ),
        ));
    };
    for page in &identity.canonical_target_page_ids {
        if !module_pages
            .iter()
            .any(|candidate| candidate.as_str() == Some(page.as_str()))
        {
            return Err(HostIngressError::new(
                HostIngressErrorCode::TargetNotAuthorized,
                format!(
                    "target Page {page} is not an authorized graph output of module {}",
                    facts.module_id
                ),
            ));
        }
    }
    Ok(graph_revision)
}

fn validate_status_request(request: &HostIngressStatusRequest) -> Result<(), HostIngressError> {
    if request.external_event_id.is_empty()
        || request.external_event_id.len() > MAX_HOST_INGRESS_ID_TEXT_BYTES
        || request.external_event_id.chars().any(|character| character.is_control())
    {
        return Err(HostIngressError::new(
            HostIngressErrorCode::PremiseInvalid,
            "status external_event_id is empty, oversized, or malformed",
        ));
    }
    Ok(())
}

fn seam_input() -> EnvironmentInput {
    EnvironmentInput {
        now: HOST_INGRESS_INPUT_NOW.into(),
        ..Default::default()
    }
}

/// Reconstruct the exact Core command a committed mapping ran as, for
/// cross-verification of the stored Core operation digest.
fn command_for_mapping(mapping: &HostIngressMapping) -> CoreCommand {
    let block = serde_json::to_value(&mapping.payload)
        .expect("a canonical payload always serializes to a JSON value");
    CoreCommand::Ingress(IngressCommand {
        command_id: mapping.command_id.clone(),
        runtime_source: format!(
            "{}#{}#{}",
            mapping.extension_id, mapping.module_id, mapping.instance_id
        ),
        ingress_key: mapping.ingress_key.clone(),
        operation_digest: mapping.operation_digest.clone(),
        block_id: mapping.block_id.clone(),
        block,
        pages: mapping.target_page_ids.clone(),
    })
}

// ---------------------------------------------------------------------------
// Row persistence and verification
// ---------------------------------------------------------------------------

/// The closed canonical premise record persisted before the Core effect.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct StoredIngressPremise {
    schema: String,
    ingress_key: String,
    operation_digest: String,
    owner: String,
    extension_id: String,
    module_id: String,
    instance_id: String,
    generation: i64,
    revision: i64,
    graph_revision: i64,
    external_event_id: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    references_external_event_id: Option<String>,
    target_page_ids: Vec<String>,
    payload: dolly_canonical_json::CanonicalJsonValue,
    payload_digest: String,
}

fn insert_premise_row(
    transaction: &Transaction<'_>,
    identity: &IngressIdentity,
    facts: &IngressAuthorityFacts,
    graph_revision: i64,
    request: &HostIngressSubmitRequest,
    premise_jcs: &[u8],
    premise_digest: &str,
    target_pages_jcs: &[u8],
    ingress_id: &IngressId,
    block_id: &BlockId,
) -> StorageResult<()> {
    transaction
        .execute(
            "INSERT INTO host_ingress_mappings (
                ingress_key, operation_digest, payload_digest, owner,
                extension_id, module_id, instance_id, generation,
                revision, graph_revision, external_event_id, kind,
                references_external_event_id, target_pages_jcs,
                premise_jcs, premise_digest, ingress_id, block_id
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?18
             )",
            params![
                identity.key.as_str(),
                identity.operation_digest,
                identity.payload_digest,
                facts.owner,
                facts.extension_id,
                facts.module_id,
                facts.instance_id,
                facts.generation as i64,
                facts.revision,
                graph_revision,
                request.external_event_id,
                request.kind.as_str(),
                request.references_external_event_id,
                target_pages_jcs,
                premise_jcs,
                premise_digest,
                ingress_id.as_str(),
                block_id.as_str(),
            ],
        )
        .map(|_| ())
        .map_err(map_sqlite_error)
}

fn complete_mapping_row(
    transaction: &Transaction<'_>,
    ingress_key: &str,
    deliveries_jcs: &[u8],
    command_id: &str,
    mapping_jcs: &[u8],
    mapping_digest: &str,
) -> StorageResult<()> {
    transaction
        .execute(
            "UPDATE host_ingress_mappings
             SET deliveries_jcs = ?2, command_id = ?3,
                 mapping_jcs = ?4, mapping_digest = ?5
             WHERE ingress_key = ?1",
            params![
                ingress_key,
                deliveries_jcs,
                command_id,
                mapping_jcs,
                mapping_digest
            ],
        )
        .map_err(map_sqlite_error)
        .and_then(|updated| {
            if updated == 1 {
                Ok(())
            } else {
                Err(StorageError::Corrupt)
            }
        })
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
    revision: i64,
    graph_revision: i64,
    external_event_id: String,
    kind: String,
    references_external_event_id: Option<String>,
    target_pages_jcs: Vec<u8>,
    premise_jcs: Vec<u8>,
    premise_digest: String,
    ingress_id: String,
    block_id: String,
    deliveries_jcs: Vec<u8>,
    command_id: String,
    mapping_jcs: Vec<u8>,
    mapping_digest: String,
}

fn load_mapping_row(
    connection: &Connection,
    ingress_key: &str,
) -> StorageResult<Option<HostIngressMapping>> {
    let row: Option<MappingRow> = connection
        .query_row(
            "SELECT operation_digest, payload_digest, owner,
                    extension_id, module_id, instance_id, generation,
                    revision, graph_revision, external_event_id, kind,
                    references_external_event_id, target_pages_jcs,
                    premise_jcs, premise_digest, ingress_id, block_id,
                    deliveries_jcs, command_id, mapping_jcs, mapping_digest
             FROM host_ingress_mappings
             WHERE ingress_key = ?1",
            [ingress_key],
            |row| read_mapping_row(row, ingress_key),
        )
        .optional()
        .map_err(map_sqlite_error)?;
    row.map(verify_mapping_row).transpose()
}

fn read_mapping_row(
    row: &rusqlite::Row<'_>,
    ingress_key: &str,
) -> rusqlite::Result<MappingRow> {
    Ok(MappingRow {
        ingress_key: ingress_key.to_owned(),
        operation_digest: row.get(0)?,
        payload_digest: row.get(1)?,
        owner: row.get(2)?,
        extension_id: row.get(3)?,
        module_id: row.get(4)?,
        instance_id: row.get(5)?,
        generation: row.get(6)?,
        revision: row.get(7)?,
        graph_revision: row.get(8)?,
        external_event_id: row.get(9)?,
        kind: row.get(10)?,
        references_external_event_id: row.get(11)?,
        target_pages_jcs: row.get(12)?,
        premise_jcs: row.get(13)?,
        premise_digest: row.get(14)?,
        ingress_id: row.get(15)?,
        block_id: row.get(16)?,
        deliveries_jcs: row.get(17)?,
        command_id: row.get(18)?,
        mapping_jcs: row.get(19)?,
        mapping_digest: row.get(20)?,
    })
}

fn verify_mapping_row(row: MappingRow) -> StorageResult<HostIngressMapping> {
    // A fully committed mapping carries its closed records; the pre-effect
    // intermediate state is never observable outside its transaction.
    if row.mapping_jcs.is_empty() || row.mapping_digest.is_empty() {
        return Err(StorageError::Corrupt);
    }
    let premise: StoredIngressPremise = decode_canonical::<StoredIngressPremise>(&row.premise_jcs)?;
    let mapping: HostIngressMapping = decode_canonical::<HostIngressMapping>(&row.mapping_jcs)?;
    if premise.schema != HOST_INGRESS_PREMISE_RECORD_SCHEMA
        || mapping.schema != HOST_INGRESS_RECORD_SCHEMA
    {
        return Err(StorageError::Corrupt);
    }
    let (_, premise_digest) = canonical_digest(&premise)?;
    if premise_digest != row.premise_digest {
        return Err(StorageError::Corrupt);
    }
    let (_, computed_mapping_digest) = canonical_digest(&mapping)?;
    if computed_mapping_digest != row.mapping_digest {
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
        || mapping.revision != row.revision
        || mapping.graph_revision != row.graph_revision
        || mapping.external_event_id != row.external_event_id
        || mapping.kind != row.kind
        || mapping.references_external_event_id != row.references_external_event_id
        || target_pages_bytes != row.target_pages_jcs
        || mapping.ingress_id != row.ingress_id
        || mapping.block_id != row.block_id
        || deliveries_bytes != row.deliveries_jcs
        || mapping.command_id != row.command_id
    {
        return Err(StorageError::Corrupt);
    }
    // The closed premise record and the mapping record must agree on every
    // premise field.
    if premise.ingress_key != mapping.ingress_key
        || premise.operation_digest != mapping.operation_digest
        || premise.owner != mapping.owner
        || premise.extension_id != mapping.extension_id
        || premise.module_id != mapping.module_id
        || premise.instance_id != mapping.instance_id
        || premise.generation != mapping.generation
        || premise.revision != mapping.revision
        || premise.graph_revision != mapping.graph_revision
        || premise.external_event_id != mapping.external_event_id
        || premise.kind != mapping.kind
        || premise.references_external_event_id != mapping.references_external_event_id
        || premise.target_page_ids != mapping.target_page_ids
        || premise.payload_digest != mapping.payload_digest
        || premise.payload != mapping.payload
    {
        return Err(StorageError::Corrupt);
    }
    Ok(mapping)
}

fn decode_canonical<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> StorageResult<T> {
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
// Fresh identity allocation
// ---------------------------------------------------------------------------

fn mint_identity<T>() -> StorageResult<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Debug,
{
    let text = mint_uuid_v7_text().map_err(|_| StorageError::Corrupt)?;
    text.parse::<T>()
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

fn map_premise(error: HostIngressPremiseError) -> HostIngressError {
    match error {
        HostIngressPremiseError::PayloadTooLarge(_) => HostIngressError::new(
            HostIngressErrorCode::PremiseTooLarge,
            format!("{error}"),
        ),
        other => HostIngressError::new(HostIngressErrorCode::PremiseInvalid, format!("{other}")),
    }
}

fn map_mint(_error: StorageError) -> HostIngressError {
    HostIngressError::new(
        HostIngressErrorCode::Corrupt,
        "fresh ingress/block identity allocation failed",
    )
}

impl From<StorageError> for HostIngressError {
    fn from(error: StorageError) -> Self {
        map_storage(error)
    }
}
