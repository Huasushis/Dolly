use dolly_canonical_json::{CanonicalBytes, CanonicalError, CanonicalJsonObject, Sha256Digest};

/// A schema bundle: the exact generated representation of `dolly.schema-bundle/v1`.
///
/// The bundle contains a `root` and `resources` map. Its canonical bytes are
/// the JCS of the exact normative `{root, resources}` value.
pub struct SchemaBundle {
    /// The root schema `$id`.
    root: String,
    /// The resources map: `$id` -> schema document.
    resources: CanonicalJsonObject,
    /// The raw canonical JSON value of the bundle.
    raw: CanonicalJsonObject,
}

impl SchemaBundle {
    /// Parse a schema bundle from JSON bytes.
    /// The input must be a `dolly.schema-bundle/v1` document.
    pub fn from_json_bytes(input: &[u8]) -> Result<Self, CanonicalError> {
        let value = dolly_canonical_json::parse_core_json(
            input,
            dolly_canonical_json::ParseLimits::protocol_wire(),
        )?;

        let obj = match value {
            dolly_canonical_json::CanonicalJsonValue::Object(o) => o,
            _ => {
                return Err(CanonicalError::invalid_json(
                    "schema bundle must be a JSON object",
                ));
            }
        };

        // Validate the schema tag
        let schema_tag = obj
            .get("schema")
            .ok_or_else(|| CanonicalError::invalid_json("schema bundle missing 'schema' field"))?;
        match schema_tag {
            dolly_canonical_json::CanonicalJsonValue::String(s)
                if s == "dolly.schema-bundle/v1" => {}
            _ => {
                return Err(CanonicalError::invalid_json(
                    "schema bundle must have schema = 'dolly.schema-bundle/v1'",
                ));
            }
        }

        let root = obj
            .get("root")
            .ok_or_else(|| CanonicalError::invalid_json("schema bundle missing 'root' field"))?;
        let root_id = match root {
            dolly_canonical_json::CanonicalJsonValue::String(s) => s.clone(),
            _ => {
                return Err(CanonicalError::invalid_json(
                    "schema bundle 'root' must be a string",
                ));
            }
        };

        let resources = obj.get("resources").ok_or_else(|| {
            CanonicalError::invalid_json("schema bundle missing 'resources' field")
        })?;
        let resources_obj = match resources {
            dolly_canonical_json::CanonicalJsonValue::Object(o) => o.clone(),
            _ => {
                return Err(CanonicalError::invalid_json(
                    "schema bundle 'resources' must be an object",
                ));
            }
        };

        Ok(Self {
            root: root_id,
            resources: resources_obj,
            raw: obj,
        })
    }

    /// Returns the root schema `$id`.
    pub fn root(&self) -> &str {
        &self.root
    }

    /// Returns the resources map.
    pub fn resources(&self) -> &CanonicalJsonObject {
        &self.resources
    }

    /// Compute the canonical bytes of the bundle.
    pub fn canonical_bytes(&self) -> Result<CanonicalBytes, CanonicalError> {
        let (bytes, _digest) = dolly_canonical_json::canonicalize(&self.raw)?;
        Ok(bytes)
    }

    /// Compute the SHA-256 digest of the bundle's canonical bytes.
    pub fn digest(&self) -> Result<Sha256Digest, CanonicalError> {
        let (bytes, digest) = dolly_canonical_json::canonicalize(&self.raw)?;
        let _ = bytes;
        Ok(digest)
    }

    /// Verify that the bundle's canonical bytes hash to the expected digest.
    pub fn verify_digest(&self, expected: &Sha256Digest) -> Result<(), CanonicalError> {
        let (bytes, _digest) = dolly_canonical_json::canonicalize(&self.raw)?;
        expected.verify_bytes(bytes.as_bytes())
    }

    /// Build a `SchemaValidator` for the bundle's root schema, registering all
    /// resources from the bundle for cross-`$ref` resolution.
    pub fn validator(
        &self,
    ) -> Result<crate::validator::SchemaValidator, crate::validator::SchemaError> {
        use jsonschema::{Registry, Resource, draft202012};

        let mut builder = Registry::new();
        for (id, schema) in self.resources.iter() {
            let schema_value: serde_json::Value = serde_json::to_value(schema).map_err(|e| {
                crate::validator::SchemaError::Reference(format!(
                    "failed to serialize resource {id}: {e}"
                ))
            })?;
            let resource = Resource::from_contents(schema_value);
            builder = builder.add(id, resource).map_err(|e| {
                crate::validator::SchemaError::Reference(format!(
                    "registry add error for {id}: {e}"
                ))
            })?;
        }
        let registry = builder.prepare().map_err(|e| {
            crate::validator::SchemaError::Reference(format!("registry prepare error: {e}"))
        })?;

        let root_schema = self.resources.get(&self.root).ok_or_else(|| {
            crate::validator::SchemaError::Reference(format!(
                "root schema {} not found in bundle resources",
                self.root
            ))
        })?;
        let root_value: serde_json::Value = serde_json::to_value(root_schema).map_err(|e| {
            crate::validator::SchemaError::Reference(format!(
                "failed to serialize root schema: {e}"
            ))
        })?;

        let validator = draft202012::options()
            .with_registry(&registry)
            .build(&root_value)
            .map_err(|e| {
                crate::validator::SchemaError::Validation(format!(
                    "validator build error for {}: {e}",
                    self.root
                ))
            })?;

        Ok(crate::validator::SchemaValidator { validator })
    }
}
