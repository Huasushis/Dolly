//! Public Worker-start entry derivation from the durable premise.
//!
//! The production worker-host binary receives only a database location plus
//! the extension/server identity pair. Its entire spawn authority — installed
//! locations and digests — is derived here exclusively from the closed
//! Worker-start premise projected by the Host-owned TS authority writer for
//! the current authority revision. An absent, stale, or tampered premise is a
//! typed startup refusal before any process exists.

use std::path::PathBuf;

use dolly_core_domain::ExtensionId;
use dolly_storage::Database;
use dolly_storage::worker_start_premise::load_worker_start_premise;

use crate::{WorkerError, WorkerStartConfig};

/// Derive a [`WorkerStartConfig`] solely from the durable Worker-start
/// premise recorded for the current authority revision.
///
/// This is the only sanctioned construction path for the public worker-host
/// entry: caller-supplied locations, environment, ACK/response/readiness/
/// cache/process-exit observations have no influence here.
pub fn load_worker_start_config(
    db_path: PathBuf,
    extension_alias: &str,
    server_id: &str,
) -> Result<WorkerStartConfig, WorkerError> {
    let database =
        Database::open(&db_path).map_err(|error| WorkerError::Storage(error.to_string()))?;
    let identity = database.authority_identity();
    let premise = load_worker_start_premise(database.connection(), identity, extension_alias, server_id)
        .map_err(|error| WorkerError::Premise(error.to_string()))?
        .ok_or_else(|| {
            WorkerError::Premise(
                "no durable Worker-start premise is projected for the current authority revision"
                    .to_string(),
            )
        })?;
    premise
        .verify_content()
        .map_err(|error| WorkerError::Premise(error.to_string()))?;
    let parsed_alias: ExtensionId = extension_alias
        .parse()
        .map_err(|error| WorkerError::Premise(format!("extension alias is invalid: {error}")))?;
    drop(database);
    Ok(WorkerStartConfig {
        db_path,
        extension_alias: parsed_alias,
        server_id: server_id.to_string(),
        package_root: premise.package_root_path(),
        package_path: premise.package_path(),
    })
}
