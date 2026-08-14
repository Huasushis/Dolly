//! Canonical durable state projection (`dolly.state-projection/v1`) and digest.
//!
//! The projection excludes volatile lossy queue entries: they are in-memory
//! only and intentionally do not survive recovery. The canonical digest is the
//! SHA-256 over JCS (RFC 8785) canonical JSON bytes of the projection, computed
//! via the WP-001 `dolly-canonical-json` crate — never via `serde_json`
//! serialization.

use dolly_canonical_json::canonicalize;

use crate::types::CoreSnapshot;

/// Build the durable projection of a Core snapshot as a canonical JSON value.
///
/// Volatile lossy entries are dropped. The returned value is a
/// `serde_json::Value` object whose keys are the durable snapshot fields; the
/// canonical serializer sorts members by UTF-16 code-unit sequence, matching
/// the TypeScript `projectCoreState`.
pub fn project_core_state(state: &CoreSnapshot) -> serde_json::Value {
    // Serialize the full snapshot, then remove `volatile_lossy_entries`. This
    // mirrors the TypeScript `{ volatile_lossy_entries: _, ...durable } = state`
    // spread. We serialize-then-edit rather than reconstruct field-by-field so
    // that every durable field is included by construction and field-name
    // drift is impossible.
    let mut value =
        serde_json::to_value(state).expect("CoreSnapshot serializes to serde_json::Value");
    if let serde_json::Value::Object(map) = &mut value {
        map.remove("volatile_lossy_entries");
    }
    value
}

/// Compute the canonical state hash: `sha256:<64 hex>` over the JCS bytes of
/// Compute the SHA-256 digest of the durable core-state projection.
///
/// Returns a canonical JSON error instead of panicking when a deserialized
/// snapshot violates the Dolly canonical JSON profile.
pub fn hash_core_state(
    state: &CoreSnapshot,
) -> Result<String, dolly_canonical_json::CanonicalError> {
    let projection = project_core_state(state);
    canonicalize(&projection).map(|(_, digest)| digest.to_canonical_string())
}
