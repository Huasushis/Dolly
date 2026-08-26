//! Public Worker-start entry derivation from the durable premise.
//!
//! The production worker-host binary receives only a database location plus
//! the extension/server identity pair. This module performs the READ-ONLY
//! hostile preflight exclusively: it opens the database once in read-only
//! mode, gates both schemas, reads the persisted authority identity, and
//! verifies the requested premise row. It never mints controller generations,
//! rewrites lock owners, creates schemas, or opens the database writable —
//! `Worker::start` owns that single writable open and re-binds every carried
//! premise field against the freshly loaded current Host authority before any
//! child process exists.

use std::path::PathBuf;

use dolly_core_domain::ExtensionId;
use dolly_storage::worker_start_premise::preflight_worker_start_premise;

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
    let premise = preflight_worker_start_premise(&db_path, extension_alias, server_id)
        .map_err(|error| WorkerError::Premise(error.to_string()))?
        .ok_or_else(|| {
            WorkerError::Premise(
                "no durable Worker-start premise is projected for the current authority revision"
                    .to_string(),
            )
        })?;
    let parsed_alias: ExtensionId = extension_alias
        .parse()
        .map_err(|error| WorkerError::Premise(format!("extension alias is invalid: {error}")))?;
    Ok(WorkerStartConfig {
        config_revision: premise.config_revision,
        config_digest: premise.config_digest.clone(),
        db_path,
        package_root: premise.package_root_path(),
        package_path: premise.package_path(),
        package_digest: premise.package_digest.clone(),
        executable_digest: premise.executable_digest.clone(),
        endpoint: premise.endpoint.clone(),
        record_digest: premise.record_digest.clone(),
        extension_alias: parsed_alias,
        server_id: server_id.to_string(),
    })
}
