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
//! **Authority.** The principal is sealed. [`HostIngress::submit`] and
//! [`HostIngress::status`] accept only the opaque current
//! [`HostConnectionAuthority`] and [`HostCapabilityGrant`] (no public
//! constructor, clone, or deserializer) plus a caller request that carries
//! event content only; the storage transaction derives the principal
//! primitives internally and re-verifies, inside the same transaction, that
//! the authority is current, that the grant is current/unrevoked and
//! authorizes `host.ingress.submit`, that the referenced edit/delete event is
//! committed by the same principal, and that every ordered target Page is an
//! exact output Page of the module in the grant-pinned graph (digest and
//! revision bound, Extension ownership through the granted (extension,
//! module) pair, no extra, opposite, or cross-Extension pages).
//!
//! **Shared verification.** One fail-closed path (`verify_mapping`) serves
//! submit replay/conflict, referenced-event validation, and status. It
//! verifies the premise and mapping closed records plus all their column
//! digests, the Core operation (request digest, transition digest and
//! transition bytes), the reducer ingress record, the Block content, the
//! deliveries, and the recovery index. A mapping whose row was deleted while
//! its Core effect remains never reads as `Absent`; a missing or tampered
//! operation, ingress record, block, or link never reads as `Committed`.
//! Status performs the principal checks and every mapping/snapshot/effect
//! read inside ONE transaction so rotation/revocation cannot race a
//! disclosure.
//!
//! **Pre-effect persistence.** A submit executes inside ONE immediate SQLite
//! transaction: the row with the closed canonical premise bytes is inserted
//! first, the pure reducer effect (Block, deliveries, journal) is applied
//! second, and the effect linkage completes the row with the closed canonical
//! mapping bytes third. Reconcile happens before any fresh identity is
//! minted, so a same-key/same-digest replay returns the stored identifiers
//! with no new entropy or allocation.
//!
//! **Idempotency.** The ingress key is the (owner, source, external event)
//! namespace of the calling principal; the operation digest binds every
//! premise field including the authority fences and the ordered target Pages.
//! Same key + same digest returns the prior mapping unchanged; same key + a
//! different digest is a conflict that changes nothing.

use dolly_core_domain::{
    BlockId, HostIngressError, HostIngressErrorCode, HostIngressKey, HostIngressMapping,
    HostIngressStatus, HostIngressStatusRequest, HostIngressSubmitOutcome,
    HostIngressSubmitRequest, IngressDelivery, IngressId, HOST_INGRESS_PREMISE_RECORD_SCHEMA,
    HOST_INGRESS_RECORD_SCHEMA, HOST_INGRESS_SCHEMA_VERSION, HOST_INGRESS_SUBMIT_METHOD,
    MAX_HOST_INGRESS_ID_TEXT_BYTES, MAX_HOST_INGRESS_PRINCIPAL_TEXT_BYTES,
    MAX_HOST_INGRESS_REVISION,
};
use dolly_core_reducer::{
    CoreCommand, CoreSnapshot, EnvironmentInput, HostIngressPremiseError, IngressCommand,
    IngressIdentity, Transition, TransitionOutcome, build_ingress_command,
    derive_ingress_identity, derive_ingress_key,
    validate_ingress_request,
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::database::map_sqlite_error;
use crate::error::{StorageError, StorageResult};
use crate::runtime_binding::mint_uuid_v7_text;
use crate::transaction::{
    CoreTransaction, HostCapabilityGrant, HostConnectionAuthority, SqliteCoreTransaction,
    canonical_digest, decode_canonical, load_core_snapshot, load_current_host_capability_grant,
    request_identity_digest,
};

/// The logical table this slice writes.
pub const HOST_INGRESS_MAPPINGS_TABLE: &str = "host_ingress_mappings";

/// The schema discriminator stored in the meta singleton.
pub const HOST_INGRESS_SCHEMA_DISCRIMINATOR: &str = "dolly.host-ingress/v1";

/// The fixed environment input the seam commits reducer effects with. It is
/// part of the Core operation request identity, so verification can recompute
/// the stored digest exactly.
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
/// plus an event-content-only request; the implementation re-verifies the
/// principal inside the transaction, persists the closed premise before the
/// Core effect, links the effect atomically, and reconciles lost responses
/// through `status`.
pub trait HostIngress {
    /// Durably submit one already authenticated event and commit its Core
    /// effect. A prior mapping under the same principal's key with the same
    /// operation digest is returned unchanged (idempotent, with the stored
    /// identities and no new allocation); a prior mapping under a different
    /// digest is a conflict that changes nothing.
    fn submit(
        &mut self,
        authority: &HostConnectionAuthority,
        grant: &HostCapabilityGrant,
        request: &HostIngressSubmitRequest,
    ) -> Result<HostIngressSubmitOutcome, HostIngressError>;

    /// Return the committed mapping for the calling principal's key, or
    /// authoritative absence, cross-verified against the Core
    /// operation/effect ledger so deletion or tamper never reads as the
    /// other. Requires the current authority, a live grant authorizing
    /// `host.ingress.submit`, and performs every check and read in one
    /// transaction.
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
        let facts = principal_facts(authority, grant)?;
        let identity = derive_ingress_identity(
            &facts.owner,
            &facts.extension_id,
            &facts.module_id,
            &facts.instance_id,
            facts.generation,
            facts.revision,
            facts.graph_revision,
            request,
        )
        .map_err(map_premise)?;

        let mut transaction =
            SqliteCoreTransaction::begin(self.connection).map_err(map_storage)?;

        // 1. The scoped principal, verified inside this transaction before
        //    any reconciliation or allocation.
        verify_current_principal(&transaction, authority, grant, true)?;

        // 2. Reconcile through the shared fail-closed path BEFORE any fresh
        //    identity is minted: a replay returns the stored identifiers
        //    without new entropy or allocation.
        match verify_mapping(
            transaction.sql_transaction().map_err(map_storage)?,
            &facts,
            &identity.key,
            &request.external_event_id,
        )
        .map_err(map_storage)?
        {
            Some(mapping) => {
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
            None => {}
        }

        // 3. Only now allocate fresh RFC-9562 UUIDv7 identities and bind the
        //    reducer command to this transaction. The minted ingress id is
        //    carried through the Core ingress command identity so the
        //    committed mapping is verifiably linked end-to-end.
        let ingress_id = mint_identity::<IngressId>().map_err(map_mint)?;
        let block_id = mint_identity::<BlockId>().map_err(map_mint)?;
        let identity = identity.with_ingress_id(ingress_id.to_string());
        let runtime_source = format!(
            "{}#{}#{}",
            facts.extension_id, facts.module_id, facts.instance_id
        );
        let command = build_ingress_command(&identity, &block_id, &runtime_source, request);
        let input = seam_input();
        transaction
            .bind_request(&command, &input)
            .map_err(map_storage)?;
        let snapshot = transaction
            .load_command_snapshot(&command)
            .map_err(map_storage)?;
        let graph_revision =
            verify_graph_direction(&snapshot, &facts, grant, &identity)?;

        // 4. An edit/delete MUST reference an event the same principal
        //    already committed, verified through the shared path.
        if let Some(reference) = &request.references_external_event_id {
            let reference_key =
                derive_ingress_key(&facts.owner, &facts.extension_id, &facts.module_id, &facts.instance_id, reference);
            match verify_mapping(
                transaction.sql_transaction().map_err(map_storage)?,
                &facts,
                &reference_key,
                reference,
            )
            .map_err(map_storage)?
            {
                Some(_) => {}
                None => {
                    drop(transaction);
                    return Err(HostIngressError::new(
                        HostIngressErrorCode::ReferencedEventMissing,
                        format!(
                            "edit/delete references external event {reference:?} which the same principal never committed"
                        ),
                    ));
                }
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
            transaction.sql_transaction_mut().map_err(map_storage)?,
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
            transaction.sql_transaction_mut().map_err(map_storage)?,
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
        let facts = principal_facts(authority, grant)?;
        let key = derive_ingress_key(
            &facts.owner,
            &facts.extension_id,
            &facts.module_id,
            &facts.instance_id,
            &request.external_event_id,
        );

        // One transaction: principal checks and every mapping/snapshot/
        // effect read happen together, so a rotation or revocation cannot
        // race a disclosure.
        let transaction =
            SqliteCoreTransaction::begin(self.connection).map_err(map_storage)?;
        verify_current_principal(&transaction, authority, grant, true)?;
        let presence = verify_mapping(
            transaction.sql_transaction().map_err(map_storage)?,
            &facts,
            &key,
            &request.external_event_id,
        )
        .map_err(map_storage)?;
        transaction.commit().map_err(map_storage)?;

        Ok(match presence {
            Some(mapping) => HostIngressStatus::Committed(Box::new(mapping)),
            None => HostIngressStatus::Absent,
        })
    }
}

// ---------------------------------------------------------------------------
// Sealed principal derivation and validation
// ---------------------------------------------------------------------------

/// The sealed authority-bound principal of one premise. Its fields are
/// private and its only constructor derives them from the opaque current Host
/// authority and capability grant inside this module; a caller cannot
/// construct or forge a principal, and no seam API accepts one.
struct PrincipalFacts {
    owner: String,
    extension_id: String,
    module_id: String,
    instance_id: String,
    generation: u64,
    revision: i64,
    graph_revision: i64,
}

fn principal_facts(
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
) -> Result<PrincipalFacts, HostIngressError> {
    let owner = authority.extension_connection_id().to_owned();
    let extension_id = grant.extension_id().to_owned();
    let module_id = grant.module_id().to_owned();
    let instance_id = authority.worker_epoch().to_string();
    let generation = grant.extension_generation() as u64;
    let revision = authority.incarnation_revision();
    let graph_revision = grant.graph_revision();
    for (value, name) in [
        (&owner, "owner"),
        (&extension_id, "extension_id"),
        (&module_id, "module_id"),
        (&instance_id, "instance_id"),
    ] {
        if value.is_empty()
            || value.len() > MAX_HOST_INGRESS_PRINCIPAL_TEXT_BYTES
            || value.chars().any(|character| character.is_control())
        {
            return Err(HostIngressError::new(
                HostIngressErrorCode::NotAuthorized,
                format!("authenticated principal {name} is malformed"),
            ));
        }
    }
    if generation == 0
        || generation > MAX_HOST_INGRESS_REVISION as u64
        || !(1..=MAX_HOST_INGRESS_REVISION).contains(&revision)
        || !(1..=MAX_HOST_INGRESS_REVISION).contains(&graph_revision)
    {
        return Err(HostIngressError::new(
            HostIngressErrorCode::NotAuthorized,
            "authenticated principal fences are out of range",
        ));
    }
    Ok(PrincipalFacts {
        owner,
        extension_id,
        module_id,
        instance_id,
        generation,
        revision,
        graph_revision,
    })
}

fn verify_current_principal(
    transaction: &SqliteCoreTransaction<'_>,
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
    require_submit_method: bool,
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
    if require_submit_method && !current.allows(HOST_INGRESS_SUBMIT_METHOD) {
        return Err(HostIngressError::new(
            HostIngressErrorCode::NotAuthorized,
            format!("the capability grant does not allow {HOST_INGRESS_SUBMIT_METHOD}"),
        ));
    }
    Ok(())
}

/// Validate the installed graph against the grant: the graph revision AND
/// digest must equal the grant-pinned values, the module must be admitted in
/// the pinned graph, and every ordered target Page must be an exact output
/// Page of the module — never an input-only (opposite) Page, an extra Page,
/// or a Page of another Extension (the granted (extension, module) pair is
/// the ownership/source binding).
fn verify_graph_direction(
    snapshot: &CoreSnapshot,
    facts: &PrincipalFacts,
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
    if graph_revision != grant.graph_revision()
        || snapshot
            .graph
            .get("digest")
            .and_then(Value::as_str)
            != Some(grant.graph_digest())
    {
        return Err(HostIngressError::new(
            HostIngressErrorCode::Stale,
            format!(
                "installed graph (revision {graph_revision}, digest {:?}) does not match the grant-pinned graph (revision {}, digest {:?})",
                snapshot.graph.get("digest").and_then(Value::as_str),
                grant.graph_revision(),
                grant.graph_digest()
            ),
        ));
    }
    let Some(graph_body) = snapshot.graph.get("graph") else {
        return Err(HostIngressError::new(
            HostIngressErrorCode::Corrupt,
            "installed graph body is missing",
        ));
    };
    let graph_body = graph_body.as_object().ok_or_else(|| {
        HostIngressError::new(HostIngressErrorCode::Corrupt, "installed graph body is malformed")
    })?;
    let Some(descriptors) = graph_body.get("descriptors").and_then(Value::as_object) else {
        return Err(HostIngressError::new(
            HostIngressErrorCode::TargetNotAuthorized,
            "installed graph has no descriptors",
        ));
    };
    let Some(admitted) = descriptors.get(&facts.module_id) else {
        return Err(HostIngressError::new(
            HostIngressErrorCode::TargetNotAuthorized,
            format!(
                "module {} is not admitted in the grant-pinned graph",
                facts.module_id
            ),
        ));
    };
    // Grant-to-descriptor binding: the activating grant pins one descriptor
    // digest, and the pinned graph admits its own descriptor source digest.
    // A live grant under any other Extension pins a different descriptor and
    // cannot reuse this Module's authorized output Pages.
    let source_descriptor_digest = admitted
        .get("source_descriptor_digest")
        .and_then(Value::as_str);
    if source_descriptor_digest != Some(grant.descriptor_digest()) {
        return Err(HostIngressError::new(
            HostIngressErrorCode::NotAuthorized,
            format!(
                "the grant-pinned descriptor {:?} is not the graph-admitted descriptor {:?} for module {}",
                grant.descriptor_digest(),
                source_descriptor_digest,
                facts.module_id
            ),
        ));
    }
    let Some(module_pages) = graph_body
        .get("output_pages")
        .and_then(Value::as_object)
        .and_then(|pages| pages.get(&facts.module_id))
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
    let input_pages = graph_body
        .get("input_pages")
        .and_then(Value::as_object)
        .and_then(|pages| pages.get(&facts.module_id))
        .map(|pages| {
            pages
                .as_array()
                .map(|pages| pages.iter().filter_map(Value::as_str).collect::<Vec<_>>())
                .unwrap_or_default()
        })
        .unwrap_or_default();
    for page in &identity.canonical_target_page_ids {
        let authorized = module_pages
            .iter()
            .any(|candidate| candidate.as_str() == Some(page.as_str()));
        let opposite = input_pages.iter().any(|candidate| *candidate == page.as_str());
        if !authorized {
            return Err(HostIngressError::new(
                HostIngressErrorCode::TargetNotAuthorized,
                format!(
                    "target Page {page} is not an authorized output Page of module {}",
                    facts.module_id
                ),
            ));
        }
        if opposite {
            return Err(HostIngressError::new(
                HostIngressErrorCode::TargetNotAuthorized,
                format!(
                    "target Page {page} is an input (opposite-direction) Page of module {}",
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

// ---------------------------------------------------------------------------
// Shared fail-closed verification (submit replay/conflict, referenced-event,
// and status)
// ---------------------------------------------------------------------------

/// The one verification path shared by submit replay/conflict, referenced-
/// event validation, and status.
///
/// - `Ok(None)` — genuinely absent: no mapping row, no Core operation, and no
///   Core ingress record for the key.
/// - `Ok(Some(mapping))` — the mapping row exists and its premise/mapping
///   records, column digests, Core operation (request digest, transition
///   digest and bytes), reducer ingress record, Block content, deliveries,
///   and the recovery index all verify.
/// - `Err(Corrupt)` — any inconsistency: a tampered record/column, a lost
///   operation/effect, a deleted mapping whose effect remains, or a broken
///   id/block/delivery link. Absence with a remaining effect never reads as
///   `Absent`; a missing or tampered effects/link never reads as `Committed`.
fn verify_mapping(
    connection: &Connection,
    facts: &PrincipalFacts,
    key: &HostIngressKey,
    external_event_id: &str,
) -> StorageResult<Option<HostIngressMapping>> {
    verify_recovery_index_columns(connection)?;
    let command_id_prefix = format!("host-ingress-{key}-");
    let ingress_record_key = ingress_record_key(facts, key);

    let Some(mapping) = load_mapping_row(connection, key.as_str())? else {
        // Absence cross-check: if any effect for this key remains (Core
        // operation or reducer ingress record), a deleted mapping must not
        // read as absent. The minted id inside the command id is unknown
        // without the mapping, so the prefix binds the key's operations.
        let operation: Option<String> = connection
            .query_row(
                "SELECT command_id FROM core_operations WHERE command_id LIKE ?1 || '%'",
                [&command_id_prefix],
                |row| row.get(0),
            )
            .optional()
            .map_err(map_sqlite_error)?;
        if operation.is_some() {
            return Err(StorageError::Corrupt);
        }
        let snapshot = load_core_snapshot(connection)?;
        if snapshot.ingress.contains_key(&ingress_record_key) {
            return Err(StorageError::Corrupt);
        }
        let _ = external_event_id;
        return Ok(None);
    };

    // The mapping identity must be verifiably linked end-to-end: the stored
    // command id carries the minted ingress id, so the mapping binding and
    // the Core operation binding must agree on it.
    let expected_command_id = format!("host-ingress-{key}-{}", mapping.ingress_id);
    if mapping.command_id != expected_command_id {
        return Err(StorageError::Corrupt);
    }

    // Core operation link: request digest, transition digest, and transition
    // bytes. The stored command id must match the mapping's command id.
    let input = seam_input();
    let command = command_for_mapping(&mapping);
    let expected_request_digest = request_identity_digest(&command, &input)?;
    let operation: Option<(String, String, String, Vec<u8>)> = connection
        .query_row(
            "SELECT command_id, request_digest, transition_digest, transition_jcs
             FROM core_operations WHERE command_id = ?1",
            [&mapping.command_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(map_sqlite_error)?;
    let Some((operation_command_id, stored_request_digest, stored_transition_digest, transition_jcs)) = operation else {
        return Err(StorageError::Corrupt);
    };
    if operation_command_id != expected_command_id {
        return Err(StorageError::Corrupt);
    }
    if stored_request_digest != expected_request_digest {
        return Err(StorageError::Corrupt);
    }
    let transition: Transition = decode_canonical(&transition_jcs)?;
    let (_, computed_transition_digest) = canonical_digest(&transition)?;
    if computed_transition_digest != stored_transition_digest
        || transition.outcome != TransitionOutcome::Committed
        || !transition
            .events
            .iter()
            .any(|event| event.command_id == expected_command_id)
    {
        return Err(StorageError::Corrupt);
    }

    // Effect link, cross-checked against BOTH the stored transition state and
    // the current snapshot: the reducer ingress record, the Block content,
    // and the per-Page deliveries. A substituted (but self-consistent)
    // transition or identity is rejected because the current snapshot is
    // digest-protected and must agree with the stored transition.
    let snapshot = load_core_snapshot(connection)?;
    verify_effect_links(&transition.state, &snapshot, facts, key, &mapping)?;
    Ok(Some(mapping))
}

/// Verify the ingress record, Block content, and deliveries for one mapping
/// in a given reducer state, and that the current snapshot agrees.
/// Verify the immutable operation -> stored transition -> actual Core ingress
/// effect chain. Both states MUST agree with the committed mapping (the
/// current snapshot is digest-protected, so a substituted transition that is
/// inconsistent with it is rejected).
fn verify_effect_links(
    transition_state: &CoreSnapshot,
    snapshot: &CoreSnapshot,
    facts: &PrincipalFacts,
    key: &HostIngressKey,
    mapping: &HostIngressMapping,
) -> StorageResult<()> {
    let ingress_record_key = ingress_record_key(facts, key);
    let expected_block = serde_json::to_value(&mapping.payload).map_err(|_| StorageError::Corrupt)?;

    let mut observed: Option<Value> = None;
    for state in [transition_state, snapshot] {
        let record = state.ingress.get(&ingress_record_key).ok_or(StorageError::Corrupt)?;
        if record.operation_digest != mapping.operation_digest
            || record.block_id != mapping.block_id
            || record.pages != mapping.target_page_ids
        {
            return Err(StorageError::Corrupt);
        }
        let block = state.blocks.get(&mapping.block_id).ok_or(StorageError::Corrupt)?;
        let mut content = block.clone();
        if let Some(object) = content.as_object_mut() {
            object.remove("commit_seq");
        }
        if content != expected_block {
            return Err(StorageError::Corrupt);
        }
        let deliveries = deliveries_for_block(state, &mapping.block_id)?;
        if deliveries != mapping.deliveries {
            return Err(StorageError::Corrupt);
        }
        // The stored transition state and the current snapshot must expose
        // the exact same ingress record: the chain is immutable.
        let record_json = serde_json::to_value(record).map_err(|_| StorageError::Corrupt)?;
        if let Some(previous) = &observed {
            if previous != &record_json {
                return Err(StorageError::Corrupt);
            }
        }
        observed = Some(record_json);
    }
    Ok(())
}

fn ingress_record_key(facts: &PrincipalFacts, key: &HostIngressKey) -> String {
    format!(
        "{}#{}#{}\0{}",
        facts.extension_id, facts.module_id, facts.instance_id, key
    )
}

/// Reconstruct the exact Core command a committed mapping ran as, for
/// cross-verification of the stored Core operation request digest.
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
    facts: &PrincipalFacts,
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
    let premise: StoredIngressPremise = decode_canonical(&row.premise_jcs)?;
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
    text.parse::<T>().map_err(|_| StorageError::Corrupt)
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
