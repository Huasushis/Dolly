//! Schema catalog tests: verify the embedded catalog has exactly 74 unique
//! `$id`s, and that the embedded schemas match the imported sources.

use dolly_canonical_json::parse_core_json;
use dolly_schema::embedded_schema_catalog;

// ---------------------------------------------------------------------------
// Catalog count and uniqueness
// ---------------------------------------------------------------------------

#[test]
fn catalog_has_74_unique_ids() {
    let catalog = embedded_schema_catalog().expect("catalog should load");
    assert_eq!(catalog.len(), 74);
    let ids = catalog.ids();
    assert_eq!(ids.len(), 74);
    // Verify uniqueness
    let mut sorted = ids.to_vec();
    sorted.sort();
    let mut deduped = sorted.clone();
    deduped.dedup();
    assert_eq!(sorted.len(), deduped.len(), "duplicate $ids found");
}

// ---------------------------------------------------------------------------
// Catalog lookup by $id
// ---------------------------------------------------------------------------

#[test]
fn catalog_lookup_by_id() {
    let catalog = embedded_schema_catalog().unwrap();
    let schema =
        catalog.schema("https://dolly.example/spec/0.1/schemas/module-descriptor.schema.json");
    assert!(schema.is_some(), "module-descriptor schema should be found");
    let schema =
        catalog.schema("https://dolly.example/spec/0.1/schemas/activation-manifest.schema.json");
    assert!(
        schema.is_some(),
        "activation-manifest schema should be found"
    );
    let schema = catalog.schema("https://dolly.example/spec/0.1/schemas/error.schema.json");
    assert!(schema.is_some(), "error schema should be found");
    let schema = catalog.schema("https://nonexistent.example/schema.json");
    assert!(schema.is_none(), "nonexistent schema should not be found");
}

// ---------------------------------------------------------------------------
// Catalog parity with imported sources
// ---------------------------------------------------------------------------

#[test]
fn catalog_matches_imported_sources() {
    let catalog = embedded_schema_catalog().unwrap();

    // Read each imported schema file and compare its $id and content
    let schemas_dir = std::path::Path::new("../../dolly-spec/schemas");
    let mut imported_count = 0;
    for entry in std::fs::read_dir(schemas_dir).expect("schemas directory should exist") {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            let content = std::fs::read(&path).expect("read schema file");
            let parsed =
                parse_core_json(&content, dolly_canonical_json::ParseLimits::protocol_wire())
                    .expect("schema should parse");
            // Extract $id from the parsed value
            if let dolly_canonical_json::CanonicalJsonValue::Object(ref obj) = parsed {
                if let Some(dolly_canonical_json::CanonicalJsonValue::String(id)) = obj.get("$id") {
                    // Verify the catalog has this schema
                    let catalog_schema = catalog
                        .schema(id)
                        .unwrap_or_else(|| panic!("catalog should contain schema with $id: {id}"));
                    // Verify the schemas are equal
                    let imported_canonical: dolly_canonical_json::CanonicalJsonValue =
                        parsed.clone();
                    let catalog_value: dolly_canonical_json::CanonicalJsonValue =
                        dolly_canonical_json::CanonicalJsonValue::Object(catalog_schema.clone());
                    let (imported_bytes, _) =
                        dolly_canonical_json::canonicalize(&imported_canonical).unwrap();
                    let (catalog_bytes, _) =
                        dolly_canonical_json::canonicalize(&catalog_value).unwrap();
                    assert_eq!(
                        imported_bytes.as_bytes(),
                        catalog_bytes.as_bytes(),
                        "schema content mismatch for $id: {id} (file: {})",
                        path.display()
                    );
                    imported_count += 1;
                }
            }
        }
    }

    assert_eq!(
        imported_count, 74,
        "should have matched exactly 74 imported schemas"
    );
}
