//! Leases, pins, and durable references (specification §7).
//!
//! A lease is temporary with a finite expiry, carried by an unguessable
//! `LeaseId`, and is NEVER silently converted to a pin. Creating a lease,
//! pin, or reference is atomic with checking that the asset is not
//! tombstoned: the check and the insert share one transaction, so a
//! tombstoned generation can never accept new retention. Pins without an
//! expiry require the privileged operator capability.

use crate::config::ResolvedAssetConfig;
use crate::error::{AssetError, AssetErrorCode, ErrorPhase};
use crate::record::{AssetLease, AssetPin, AssetReference};
use crate::store::{AssetStore, StoreError};
use crate::clock::Clock;

/// Generate an unguessable identifier from 32 random bytes (hex-encoded).
fn unguessable_id() -> String {
    let mut bytes = [0u8; 32];
    let _ = getrandom::fill(&mut bytes);
    let mut out = String::with_capacity(64);
    for b in bytes {
        out.push(char::from_digit((b >> 4) as u32, 16).expect("nibble"));
        out.push(char::from_digit((b & 0x0f) as u32, 16).expect("nibble"));
    }
    out
}

/// Create a lease with a finite expiry bounded by `lease_max_ms`.
pub fn create_lease(
    store: &mut AssetStore,
    config: &ResolvedAssetConfig,
    clock: &mut dyn Clock,
    asset_id: &str,
    domain: &str,
    owner: &str,
    purpose: &str,
    requested_ttl_ms: u64,
) -> Result<AssetLease, AssetError> {
    let now = clock.now();
    let lease = {
        let tx = store.transaction().map_err(store_error)?;
        let asset = tx
            .load_live_asset(asset_id, domain)
            .map_err(store_error)?;
        let Some(asset) = asset else {
            return Err(AssetError::new(
                AssetErrorCode::NotFound,
                ErrorPhase::Retain,
                "asset is not available in this security domain".to_string(),
            ));
        };
        if asset.lifecycle != crate::record::Lifecycle::Live {
            return Err(AssetError::new(
                AssetErrorCode::Tombstoned,
                ErrorPhase::Retain,
                "asset is tombstoned".to_string(),
            ));
        }
        let ttl = requested_ttl_ms.min(config.lease_max_ms);
        let expires_ms = now.millis.saturating_add(ttl.max(1));
        let record = AssetLease {
            lease_id: unguessable_id(),
            asset_id: asset_id.to_string(),
            security_domain: domain.to_string(),
            generation: asset.generation,
            owner: owner.to_string(),
            purpose: purpose.to_string(),
            created_at: now.iso(),
            expires_at: crate::clock::format_timestamp(expires_ms),
            expires_at_ms: expires_ms,
        };
        tx.insert_lease(&record).map_err(store_error)?;
        tx.commit().map_err(store_error)?;
        record
    };
    Ok(lease)
}

/// Release one lease by its unguessable id. Idempotent.
pub fn release_lease(store: &mut AssetStore, lease_id: &str) -> Result<bool, AssetError> {
    let tx = store.transaction().map_err(store_error)?;
    let released = tx.release_lease(lease_id).map_err(store_error)?;
    tx.commit().map_err(store_error)?;
    Ok(released)
}

/// Load one lease (for renewal authorization checks).
pub fn load_lease(store: &mut AssetStore, lease_id: &str) -> Result<Option<AssetLease>, AssetError> {
    let tx = store.transaction().map_err(store_error)?;
    let lease = tx.load_lease(lease_id).map_err(store_error)?;
    tx.commit().map_err(store_error)?;
    Ok(lease)
}

/// Create a durable pin. An expiry-less pin requires `privileged` (the
/// explicit operator capability). A pin NEVER extends an asset's lifecycle
/// beyond its own expiry; pins and leases never merge.
pub fn create_pin(
    store: &mut AssetStore,
    config: &ResolvedAssetConfig,
    clock: &mut dyn Clock,
    asset_id: &str,
    domain: &str,
    owner: &str,
    reason: &str,
    requested_expiry_ms: Option<u64>,
    privileged: bool,
) -> Result<AssetPin, AssetError> {
    let now = clock.now();
    let (expires_at, expires_at_ms) = match requested_expiry_ms {
        None if privileged => (None, None),
        None => {
            return Err(AssetError::new(
                AssetErrorCode::Unauthorized,
                ErrorPhase::Retain,
                "expiry-less pins require the privileged operator capability".to_string(),
            ))
        }
        Some(ttl) => {
            let expires = now.millis.saturating_add(ttl.min(config.lease_max_ms).max(1));
            (Some(crate::clock::format_timestamp(expires)), Some(expires))
        }
    };
    let pin_tx = {
        let tx = store.transaction().map_err(store_error)?;
        let asset = tx
            .load_live_asset(asset_id, domain)
            .map_err(store_error)?;
        let Some(asset) = asset else {
            return Err(AssetError::new(
                AssetErrorCode::NotFound,
                ErrorPhase::Retain,
                "asset is not available in this security domain".to_string(),
            ));
        };
        if asset.lifecycle != crate::record::Lifecycle::Live {
            return Err(AssetError::new(
                AssetErrorCode::Tombstoned,
                ErrorPhase::Retain,
                "asset is tombstoned".to_string(),
            ));
        }
        let record = AssetPin {
            pin_id: unguessable_id(),
            asset_id: asset_id.to_string(),
            security_domain: domain.to_string(),
            generation: asset.generation,
            owner: owner.to_string(),
            reason: reason.to_string(),
            privileged,
            created_at: now.iso(),
            expires_at,
            expires_at_ms: expires_at_ms,
        };
        tx.insert_pin(&record).map_err(store_error)?;
        tx.commit().map_err(store_error)?;
        record
    };
    Ok(pin_tx)
}

/// Remove a durable pin. Idempotent.
pub fn remove_pin(store: &mut AssetStore, pin_id: &str) -> Result<bool, AssetError> {
    let tx = store.transaction().map_err(store_error)?;
    let removed = tx.remove_pin(pin_id).map_err(store_error)?;
    tx.commit().map_err(store_error)?;
    Ok(removed)
}

/// Create a durable reference owned by a committed Block, retained Page
/// delivery, Memory record, or derived asset. Rejected when the target
/// generation is tombstoned (the recheck is atomic with the insert).
pub fn create_reference(
    store: &mut AssetStore,
    clock: &mut dyn Clock,
    asset_id: &str,
    domain: &str,
    owner: &str,
    ref_key: &str,
) -> Result<AssetReference, AssetError> {
    let now = clock.now();
    let tx = store.transaction().map_err(store_error)?;
    let asset = tx
        .load_live_asset(asset_id, domain)
        .map_err(store_error)?;
    let Some(asset) = asset else {
        return Err(AssetError::new(
            AssetErrorCode::NotFound,
            ErrorPhase::Retain,
            "asset is not available in this security domain".to_string(),
        ));
    };
    let reference = AssetReference {
        asset_id: asset_id.to_string(),
        security_domain: domain.to_string(),
        generation: asset.generation,
        ref_key: ref_key.to_string(),
        owner: owner.to_string(),
        created_at: now.iso(),
    };
    tx.insert_reference(&reference, now).map_err(|e| {
        let _ = tx;
        store_error(StoreError::Integrity(format!(
            "durable reference refused: {e}"
        )))
    })?;
    tx.commit().map_err(store_error)?;
    Ok(reference)
}

/// Remove a durable reference by its key. Idempotent.
pub fn remove_reference(
    store: &mut AssetStore,
    asset_id: &str,
    domain: &str,
    generation: u64,
    ref_key: &str,
) -> Result<bool, AssetError> {
    let tx = store.transaction().map_err(store_error)?;
    let removed = tx
        .remove_reference(asset_id, domain, generation, ref_key)
        .map_err(store_error)?;
    tx.commit().map_err(store_error)?;
    Ok(removed)
}

fn store_error(error: StoreError) -> AssetError {
    match error {
        StoreError::Conflict(message) => AssetError::new(
            AssetErrorCode::Internal,
            ErrorPhase::Retain,
            format!("retention state conflict: {message}"),
        ),
        StoreError::NotFound(message) => AssetError::new(
            AssetErrorCode::NotFound,
            ErrorPhase::Retain,
            message,
        ),
        StoreError::Integrity(message) => AssetError::new(
            AssetErrorCode::Tombstoned,
            ErrorPhase::Retain,
            message,
        ),
        other => AssetError::new(
            AssetErrorCode::Internal,
            ErrorPhase::Retain,
            format!("storage failure: {other}"),
        ),
    }
}
