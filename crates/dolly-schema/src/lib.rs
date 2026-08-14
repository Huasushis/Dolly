//! Dolly schema catalog, bundle validator, and generated closed representations.
//!
//! This crate embeds the 72 Dolly JSON Schema documents, provides a bundle
//! validator that resolves `$ref` by `$id` (no network resolution), and
//! exports generated closed representations for the three public stable roots:
//! `BlockEnvelope`, `ActivationManifest`, and `ModuleDescriptor`.

mod bundle;
mod catalog;
mod generated;
mod validator;

pub use bundle::SchemaBundle;
pub use catalog::{CatalogEntry, SchemaCatalog, schema_canonical_bytes, schema_digest};
pub use generated::*;
pub use validator::{SchemaError, SchemaValidator, ValidationErrors, ValidationIssue};

/// The `$id` of the module-descriptor schema.
pub const MODULE_DESCRIPTOR_SCHEMA_ID: &str =
    "https://dolly.example/spec/0.1/schemas/module-descriptor.schema.json";

/// The `$id` of the activation-manifest schema.
pub const ACTIVATION_MANIFEST_SCHEMA_ID: &str =
    "https://dolly.example/spec/0.1/schemas/activation-manifest.schema.json";

/// The `$id` of the error schema.
pub const ERROR_SCHEMA_ID: &str = "https://dolly.example/spec/0.1/schemas/error.schema.json";

/// The `$id` of the block schema.
pub const BLOCK_SCHEMA_ID: &str = "https://dolly.example/spec/0.1/schemas/block.schema.json";

/// The `$id` of the common schema.
pub const COMMON_SCHEMA_ID: &str = "https://dolly.example/spec/0.1/schemas/common.schema.json";

/// Load the embedded schema catalog. Returns a static reference.
///
/// The catalog is loaded exactly once and cached for the process lifetime.
/// Load failures are cached too: the first failure determines the error for
/// every subsequent caller, so embedding errors surface deterministically and
/// honestly rather than being recomputed (or silently swallowed) on retry.
pub fn embedded_schema_catalog() -> Result<&'static SchemaCatalog, SchemaError> {
    static CATALOG: std::sync::LazyLock<Result<SchemaCatalog, SchemaError>> =
        std::sync::LazyLock::new(|| SchemaCatalog::load().map_err(SchemaError::from));
    CATALOG.as_ref().map_err(Clone::clone)
}
