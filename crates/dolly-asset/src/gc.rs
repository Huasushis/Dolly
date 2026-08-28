//! Garbage collection: mark / tombstone / recheck / sweep (spec §7).
//!
//! An asset becomes a GC candidate only when all durable-reference counts
//! are zero, no live pin exists, no unexpired lease exists, and the
//! configured grace period has elapsed. The mark step rechecks references,
//! pins, and leases inside the tombstoning transaction; if any retention
//! wins before the mark commits, GC aborts. A tombstoned asset is never
//! resurrected by reusing its row; reimporting the same bytes creates a new
//! lifecycle generation with the same content-derived `AssetId`.

use crate::clock::Clock;
use crate::content;
use crate::error::{AssetError, AssetErrorCode, ErrorPhase};
use crate::replica::ReplicaDriver;
use crate::store::AssetStore;
use std::path::Path;

/// Outcome summary of one sweep.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GcReport {
    pub candidates_evaluated: u64,
    pub tombstones_created: u64,
    pub swept_objects: u64,
    pub aborted: u64,
}

/// Run one deterministic sweep at `now` with an explicit grace period.
pub fn run_gc_with_grace(
    store: &mut AssetStore,
    content_root: &Path,
    clock: &mut dyn Clock,
    grace_ms: u64,
    replica: &mut dyn ReplicaDriver,
    quarantine_on_delete_error: bool,
) -> Result<GcReport, AssetError> {
    let now = clock.now();
    let mut report = GcReport::default();

    let candidates = {
        let tx = store.transaction().map_err(gc_store_error)?;
        let list = tx
            .list_gc_candidates(now.millis, grace_ms)
            .map_err(gc_store_error)?;
        tx.commit().map_err(gc_store_error)?;
        list
    };

    for (asset_id, domain, generation) in candidates {
        report.candidates_evaluated += 1;
        let marked = {
            let tx = store.transaction().map_err(gc_store_error)?;
            let result = tx
                .mark_tombstone(&asset_id, &domain, generation, now.millis, grace_ms, now)
                .map_err(gc_store_error)?;
            tx.commit().map_err(gc_store_error)?;
            result
        };
        if !marked {
            report.aborted += 1;
            continue;
        }
        report.tombstones_created += 1;

        let any_live = {
            let tx = store.transaction().map_err(gc_store_error)?;
            let rows = tx.all_rows_for_asset(&asset_id).map_err(gc_store_error)?;
            let live = rows
                .iter()
                .any(|r| r.lifecycle == crate::record::Lifecycle::Live);
            tx.commit().map_err(gc_store_error)?;
            live
        };
        if any_live {
            record_outcome(store, &asset_id, &domain, generation, "retained_shared")
                .map_err(gc_store_error)?;
            continue;
        }
        let local_outcome = match content::delete_local_object(content_root, &asset_id) {
            Ok(outcome) => outcome,
            Err(e) => {
                if quarantine_on_delete_error {
                    record_outcome(store, &asset_id, &domain, generation, "local_delete_failed")
                        .map_err(gc_store_error)?;
                    return Err(e);
                }
                "local_delete_failed".to_string()
            }
        };
        if local_outcome == "deleted" || local_outcome == "absent" {
            report.swept_objects += 1;
            let key = replica.key_for(&asset_id);
            match replica.delete("", &key) {
                crate::replica::ReplicaDeleteResult::Deleted
                | crate::replica::ReplicaDeleteResult::Absent => {}
                _ => {
                    record_outcome(store, &asset_id, &domain, generation, "replica_delete_failed")
                        .map_err(gc_store_error)?;
                }
            }
        }
        record_outcome(store, &asset_id, &domain, generation, &local_outcome)
            .map_err(gc_store_error)?;
    }
    Ok(report)
}

fn record_outcome(
    store: &mut AssetStore,
    asset_id: &str,
    domain: &str,
    generation: u64,
    outcome: &str,
) -> Result<(), crate::store::StoreError> {
    let tx = store.transaction()?;
    tx.record_tombstone_local_outcome(asset_id, domain, generation, outcome)?;
    tx.commit()
}

/// Enumerate deletion failures for operators (tombstones whose recorded
/// outcome is a delete/replica failure).
pub fn enumerate_deletion_failures(
    store: &mut AssetStore,
) -> Result<Vec<crate::record::AssetTombstone>, AssetError> {
    let tx = store.transaction().map_err(gc_store_error)?;
    let failures = tx.list_tombstones_with_failed_outcome().map_err(gc_store_error)?;
    tx.commit().map_err(gc_store_error)?;
    Ok(failures)
}

fn gc_store_error(error: crate::store::StoreError) -> AssetError {
    AssetError::new(
        AssetErrorCode::Internal,
        ErrorPhase::Collect,
        format!("gc store failure: {error}"),
    )
}

/// Reject new leases/references/pins for any tombstoned generation (the
/// atomic check is inside store transaction; this is the fail-closed proof).
pub fn reject_tombstoned_retention(
    store: &mut AssetStore,
    asset_id: &str,
    domain: &str,
) -> Result<(), AssetError> {
    let tx = store.transaction().map_err(gc_store_error)?;
    let asset = tx.load_live_asset(asset_id, domain).map_err(gc_store_error)?;
    tx.commit().map_err(gc_store_error)?;
    match asset {
        Some(_) => Ok(()),
        None => Err(AssetError::new(
            AssetErrorCode::Tombstoned,
            ErrorPhase::Retain,
            "asset is not live (tombstoned or absent)".to_string(),
        )),
    }
}
