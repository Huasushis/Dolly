use dolly_canonical_json::{
    CanonicalBytes, CanonicalError, CanonicalJsonObject, CanonicalJsonValue, ParseLimits,
    Sha256Digest,
};

/// The embedded 72-schema catalog, compiled in as a JSON array.
pub const EMBEDDED_SCHEMA_CATALOG_JSON: &str = include_str!("embedded-schema-catalog.json");

/// One catalog entry: the `$id` and the schema document.
pub struct CatalogEntry {
    pub id: String,
    pub schema: CanonicalJsonObject,
}

/// The parsed catalog of 72 unique schema documents, indexed by `$id`.
pub struct SchemaCatalog {
    entries: Vec<CatalogEntry>,
}

impl SchemaCatalog {
    /// Load the embedded catalog, parsing and verifying all 72 schemas.
    pub fn load() -> Result<Self, CanonicalError> {
        // Parse through the Core JSON parser to reject duplicates etc.
        let json_value = dolly_canonical_json::parse_core_json(
            EMBEDDED_SCHEMA_CATALOG_JSON.as_bytes(),
            dolly_canonical_json::ParseLimits::protocol_wire(),
        )?;

        let arr = match json_value {
            CanonicalJsonValue::Array(arr) => arr,
            _ => {
                return Err(CanonicalError::invalid_json(
                    "embedded schema catalog must be a JSON array",
                ));
            }
        };

        let mut entries = Vec::with_capacity(arr.len());
        for schema in arr {
            let obj = match schema {
                CanonicalJsonValue::Object(o) => o,
                _ => {
                    return Err(CanonicalError::invalid_json(
                        "each schema document must be a JSON object",
                    ));
                }
            };
            let id_value = obj
                .get("$id")
                .ok_or_else(|| CanonicalError::invalid_json("schema document missing $id"))?;
            let id = match id_value {
                CanonicalJsonValue::String(s) => s.clone(),
                _ => return Err(CanonicalError::invalid_json("$id must be a string")),
            };
            entries.push(CatalogEntry { id, schema: obj });
        }

        // Verify count
        if entries.len() != 72 {
            return Err(CanonicalError::invalid_json(format!(
                "embedded schema catalog must contain exactly 72 schemas, got {}",
                entries.len()
            )));
        }

        // Verify unique $ids
        let mut seen = std::collections::HashSet::new();
        for entry in &entries {
            if !seen.insert(&entry.id) {
                return Err(CanonicalError::invalid_json(format!(
                    "duplicate $id in catalog: {}",
                    entry.id
                )));
            }
        }

        Ok(Self { entries })
    }

    /// Returns the number of schemas in the catalog.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Returns `true` if the catalog is empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Look up a schema by its `$id`.
    pub fn schema(&self, absolute_id: &str) -> Option<&CanonicalJsonObject> {
        self.entries
            .iter()
            .find(|e| e.id == absolute_id)
            .map(|e| &e.schema)
    }

    /// Iterate over all catalog entries.
    pub fn iter(&self) -> impl Iterator<Item = &CatalogEntry> {
        self.entries.iter()
    }

    /// Returns all `$id`s in the catalog, sorted.
    pub fn ids(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = self.entries.iter().map(|e| e.id.as_str()).collect();
        ids.sort();
        ids
    }

    /// Compute the catalog manifest digest: the SHA-256 digest of the
    /// canonical JSON array of all 72 `$id`s, sorted lexicographically.
    pub fn manifest_digest(&self) -> Sha256Digest {
        let mut ids: Vec<&str> = self.entries.iter().map(|e| e.id.as_str()).collect();
        ids.sort();
        let items: Vec<CanonicalJsonValue> = ids
            .iter()
            .map(|s| CanonicalJsonValue::String(s.to_string()))
            .collect();
        let id_array = CanonicalJsonValue::Array(items);
        let (bytes, _digest) =
            dolly_canonical_json::canonicalize(&id_array).expect("canonicalization succeeds");
        Sha256Digest::compute(bytes.as_bytes())
    }

    /// Build a `SchemaValidator` for the given root schema `$id`.
    pub fn validator(
        &self,
        root_id: &str,
    ) -> Result<crate::validator::SchemaValidator, crate::validator::SchemaError> {
        crate::validator::build_validator(self, root_id)
    }

    /// Validate a `CanonicalJsonValue` against the schema identified by `root_id`.
    pub fn validate(
        &self,
        root_id: &str,
        instance: &CanonicalJsonValue,
        semantic_limit: u16,
    ) -> Result<(), crate::validator::ValidationErrors> {
        if ParseLimits::semantic(semantic_limit).is_err() {
            return Err(crate::validator::ValidationErrors::new(vec![
                crate::validator::ValidationIssue {
                    instance_path: String::new(),
                    schema_path: root_id.to_string(),
                    keyword: "maxJsonNestingDepth".to_string(),
                    message: format!(
                        "semantic depth limit must be in 1..=64, got {semantic_limit}"
                    ),
                },
            ]));
        }
        if instance.semantic_depth() > semantic_limit {
            return Err(crate::validator::ValidationErrors::new(vec![
                crate::validator::ValidationIssue {
                    instance_path: String::new(),
                    schema_path: root_id.to_string(),
                    keyword: "maxJsonNestingDepth".to_string(),
                    message: format!(
                        "semantic nesting depth {} exceeds limit {semantic_limit}",
                        instance.semantic_depth()
                    ),
                },
            ]));
        }
        let validator = self.validator(root_id).map_err(|_| {
            crate::validator::ValidationErrors::new(vec![crate::validator::ValidationIssue {
                instance_path: String::new(),
                schema_path: root_id.to_string(),
                keyword: "internal".to_string(),
                message: "failed to build validator".to_string(),
            }])
        })?;
        validator.validate(instance)
    }

    /// Parse and validate untrusted JSON bytes, then deserialize into `T`.
    pub fn validate_bytes<T: serde::de::DeserializeOwned>(
        &self,
        root_id: &str,
        input: &[u8],
        wire_limits: ParseLimits,
        semantic_limit: u16,
    ) -> Result<T, crate::validator::SchemaError> {
        crate::validator::validate_bytes(self, root_id, input, wire_limits, semantic_limit)
    }
}

/// Compute the SHA-256 digest of a schema document's canonical JSON bytes.
pub fn schema_digest(schema: &CanonicalJsonObject) -> Result<Sha256Digest, CanonicalError> {
    let (bytes, digest) = dolly_canonical_json::canonicalize(schema)?;
    let _ = bytes;
    Ok(digest)
}

/// Compute the canonical bytes of a schema document.
pub fn schema_canonical_bytes(
    schema: &CanonicalJsonObject,
) -> Result<CanonicalBytes, CanonicalError> {
    let (bytes, _digest) = dolly_canonical_json::canonicalize(schema)?;
    Ok(bytes)
}
