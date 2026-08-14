use dolly_canonical_json::{CanonicalError, CanonicalJsonValue, ParseLimits};
use jsonschema::{Registry, Resource, draft202012};
use serde_json::Value;

use crate::catalog::SchemaCatalog;

/// A classified schema error.
#[derive(Debug, Clone)]
pub enum SchemaError {
    /// Catalog load failure.
    Load(String),
    /// Unresolved or duplicate reference.
    Reference(String),
    /// JSON parse error.
    Json(CanonicalError),
    /// Schema validation error (compiled validator rejects the schema itself).
    Validation(String),
    /// Digest mismatch.
    Digest(String),
}

impl std::fmt::Display for SchemaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SchemaError::Load(s) => write!(f, "schema load error: {s}"),
            SchemaError::Reference(s) => write!(f, "schema reference error: {s}"),
            SchemaError::Json(e) => write!(f, "schema JSON error: {e}"),
            SchemaError::Validation(s) => write!(f, "schema validation error: {s}"),
            SchemaError::Digest(s) => write!(f, "schema digest error: {s}"),
        }
    }
}

impl std::error::Error for SchemaError {}

impl From<CanonicalError> for SchemaError {
    fn from(e: CanonicalError) -> Self {
        SchemaError::Json(e)
    }
}

/// One validation issue.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ValidationIssue {
    pub instance_path: String,
    pub schema_path: String,
    pub keyword: String,
    pub message: String,
}

/// A nonempty, deterministically sorted collection of validation issues.
#[derive(Debug, Clone)]
pub struct ValidationErrors {
    issues: Vec<ValidationIssue>,
}

impl ValidationErrors {
    pub fn new(mut issues: Vec<ValidationIssue>) -> Self {
        // Deterministically sort by (instance_path, schema_path, keyword, message)
        issues.sort();
        Self { issues }
    }

    pub fn issues(&self) -> &[ValidationIssue] {
        &self.issues
    }

    pub fn len(&self) -> usize {
        self.issues.len()
    }

    pub fn is_empty(&self) -> bool {
        self.issues.is_empty()
    }
}

impl std::fmt::Display for ValidationErrors {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} validation error(s)", self.issues.len())?;
        for issue in &self.issues {
            write!(f, "\n  {issue}")?;
        }
        Ok(())
    }
}

impl std::fmt::Display for ValidationIssue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "at {} [{}]: {} (schema: {})",
            self.instance_path, self.keyword, self.message, self.schema_path
        )
    }
}

/// A compiled schema validator for one root schema, with cross-`$ref` resolution
/// by `$id` from the catalog. No network or filesystem resolution.
pub struct SchemaValidator {
    pub(crate) validator: jsonschema::Validator,
}

impl SchemaValidator {
    /// Validate an already-parsed `CanonicalJsonValue` against this schema.
    pub fn validate(&self, instance: &CanonicalJsonValue) -> Result<(), ValidationErrors> {
        // Convert CanonicalJsonValue to serde_json::Value for the validator
        let value: Value = serde_json::to_value(instance).map_err(|_| {
            ValidationErrors::new(vec![ValidationIssue {
                instance_path: String::new(),
                schema_path: String::new(),
                keyword: "internal".to_string(),
                message: "failed to serialize canonical value for validation".to_string(),
            }])
        })?;

        let mut issues = Vec::new();
        for error in self.validator.iter_errors(&value) {
            issues.push(ValidationIssue {
                instance_path: error.instance_path().to_string(),
                schema_path: error.schema_path().to_string(),
                keyword: error.kind().keyword().to_string(),
                message: error.to_string(),
            });
        }

        if issues.is_empty() {
            Ok(())
        } else {
            Err(ValidationErrors::new(issues))
        }
    }
}

/// Build a `Registry` from the catalog, registering all resources by `$id`.
pub(crate) fn build_registry(catalog: &SchemaCatalog) -> Result<Registry<'_>, SchemaError> {
    let mut builder = Registry::new();
    for entry in catalog.iter() {
        let schema_value: Value = serde_json::to_value(&entry.schema).map_err(|e| {
            SchemaError::Reference(format!("failed to serialize resource {}: {e}", entry.id))
        })?;
        let resource = Resource::from_contents(schema_value);
        builder = builder.add(&entry.id, resource).map_err(|e| {
            SchemaError::Reference(format!("registry add error for {}: {e}", entry.id))
        })?;
    }
    builder
        .prepare()
        .map_err(|e| SchemaError::Reference(format!("registry prepare error: {e}")))
}

/// Build a `SchemaValidator` for a given root schema `$id`.
pub(crate) fn build_validator(
    catalog: &SchemaCatalog,
    root_id: &str,
) -> Result<SchemaValidator, SchemaError> {
    let schema = catalog
        .schema(root_id)
        .ok_or_else(|| SchemaError::Reference(format!("schema {root_id} not found in catalog")))?;

    let schema_value: Value = serde_json::to_value(schema).map_err(|e| {
        SchemaError::Reference(format!("failed to serialize schema {root_id}: {e}"))
    })?;

    let registry = build_registry(catalog)?;
    let validator = draft202012::options()
        .with_registry(&registry)
        .build(&schema_value)
        .map_err(|e| {
            SchemaError::Validation(format!("validator build error for {root_id}: {e}"))
        })?;

    Ok(SchemaValidator { validator })
}

/// Validate untrusted JSON bytes: parse through the Core JSON parser (with
/// duplicate-key rejection), enforce the wire depth limit, then validate
/// against the schema, and finally deserialize into `T`.
pub(crate) fn validate_bytes<T: serde::de::DeserializeOwned>(
    catalog: &SchemaCatalog,
    root_id: &str,
    input: &[u8],
    wire_limits: ParseLimits,
    semantic_limit: u16,
) -> Result<T, SchemaError> {
    ParseLimits::semantic(semantic_limit)?;
    // Parse through the Core JSON parser.
    let json_value = dolly_canonical_json::parse_core_json(input, wire_limits)?;
    let semantic_depth = json_value.semantic_depth();
    if semantic_depth > semantic_limit {
        return Err(SchemaError::Validation(format!(
            "semantic nesting depth {semantic_depth} exceeds limit {semantic_limit}"
        )));
    }

    // Validate against the schema.
    let validator = build_validator(catalog, root_id)?;
    validator
        .validate(&json_value)
        .map_err(|e| SchemaError::Validation(e.to_string()))?;

    // Deserialize into T.
    use serde::de::IntoDeserializer;
    T::deserialize(json_value.into_deserializer())
        .map_err(|e| SchemaError::Json(CanonicalError::invalid_json(e.to_string())))
}
