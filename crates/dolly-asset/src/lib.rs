//! Dolly Core-owned binary Asset service (WP-010, G4).
//!
//! The service imports, identifies, validates, stores, leases, reads, and
//! garbage-collects binary objects with bounded fail-closed acquisition and
//! durable, content-addressed `AssetRef` semantics. The Core is the only
//! authority that turns an `asset_input` draft into an immutable `AssetRef`;
//! consumers receive only the downstream-safe reference.
//!
//! Scope of this crate: the import state machine with idempotent replay and
//! crash recovery, the content-addressed local store, media sniffing and
//! image metadata bounds, leases/pins/durable references, the
//! mark/tombstone/sweep GC protocol, security-domain isolation, the
//! replica/remote capability contracts, and the Asset Host import/status
//! façade (`facade`). Channel and multimodal delivery are out of scope here.

pub mod clock;
pub mod config;
pub mod content;
pub mod error;
pub mod facade;
pub mod gc;
pub mod identity;
pub mod media;
pub mod pipeline;
pub mod record;
pub mod remote;
pub mod replica;
pub mod retention;
pub mod service;
pub mod source;
pub mod store;

pub use clock::{Clock, ClockTime, FixedClock, SystemClock, format_timestamp};
pub use config::{
    MAX_INLINE_BASE64_CHARS_CEILING, ReplicaConfig, ReplicaRetryConfig, ResolvedAssetConfig,
};
pub use error::{
    AssetError, AssetErrorCode, AssetErrorDetails, AssetErrorEnvelope, AssetResult, ErrorPhase,
};
pub use facade::{AssetHostFacade, AssetStatusRequest};
pub use identity::{AssetId, AssetRef, ContentHash, MediaType};
pub use pipeline::{ImportPipeline, RecoveryReport};
pub use record::{
    AssetLease, AssetPin, AssetRecord, AssetReference, ImportRecord, ImportRequest, ImportState,
    Lifecycle, LocalState, MediaKind, ReplicaState, Source, StatusResult,
};
pub use service::{AssetCapability, AssetService, ReadGrant};
pub use store::{AssetStore, StoreError, StoreTransaction};

/// The stable artifact version of this crate.
pub const ASSET_CRATE_SCHEMA_VERSION: i64 = 1;
