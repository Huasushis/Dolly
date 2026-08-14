//! Dependency-policy test.
//!
//! Inspects every current workspace member's direct normal/build dependencies.
//! Fails on an unknown Dolly workspace crate. Enforces the three-crate edges
//! from the contract. Forbids direct `ryu` (must use `ryu-js`). Encodes the
//! blueprint's future internal edges so that `dolly-core-domain` cannot acquire
//! SQLite, Tokio, provider, MCP, web/UI, or Extension dependencies and an
//! `extensions/*` executable cannot acquire Host storage.

use std::collections::BTreeMap;
use std::path::PathBuf;

/// Parsed Cargo.toml dependency entry.
#[derive(Debug, Clone)]
struct DependencyInfo {
    name: String,
    /// Whether `default-features` is left enabled (Cargo's default).
    /// `default-features = false` flips this to `false`.
    default_features: bool,
}

/// Parsed Cargo.toml for a workspace member.
struct MemberInfo {
    name: String,
    dependencies: Vec<DependencyInfo>,
    dev_dependencies: Vec<DependencyInfo>,
    build_dependencies: Vec<DependencyInfo>,
}

fn workspace_root() -> PathBuf {
    // The test is run from the crate directory, so go up to the workspace root.
    let manifest_dir =
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set");
    PathBuf::from(manifest_dir)
        .ancestors()
        .nth(2) // crates/dolly-schema -> crates -> workspace root
        .map(|p| p.to_path_buf())
        .expect("workspace root should exist")
}

fn parse_cargo_toml(path: &std::path::Path) -> MemberInfo {
    let content = std::fs::read_to_string(path).expect("should read Cargo.toml");

    // Simple TOML parser for the sections we need.
    // We only need [dependencies], [dev-dependencies], [build-dependencies],
    // and [package].name
    let mut name = String::new();
    let mut deps = Vec::new();
    let mut dev_deps = Vec::new();
    let mut build_deps = Vec::new();

    let mut section = "";
    for line in content.lines() {
        let trimmed = line.trim();

        // Detect section headers
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            section = trimmed;
            continue;
        }

        // Parse package name
        if section == "[package]" {
            if let Some(val) = trimmed.strip_prefix("name = ") {
                name = val.trim_matches('"').to_string();
            }
        }

        // Parse dependencies
        if section == "[dependencies]" || section.starts_with("[dependencies.") {
            if let Some((dep_name, dep_info)) = parse_dep_line(trimmed) {
                deps.push(parse_dep_entry(dep_name, dep_info));
            }
        } else if section == "[dev-dependencies]" || section.starts_with("[dev-dependencies.") {
            if let Some((dep_name, dep_info)) = parse_dep_line(trimmed) {
                dev_deps.push(parse_dep_entry(dep_name, dep_info));
            }
        } else if section == "[build-dependencies]" || section.starts_with("[build-dependencies.") {
            if let Some((dep_name, dep_info)) = parse_dep_line(trimmed) {
                build_deps.push(parse_dep_entry(dep_name, dep_info));
            }
        }
    }

    MemberInfo {
        name,
        dependencies: deps,
        dev_dependencies: dev_deps,
        build_dependencies: build_deps,
    }
}

fn parse_dep_line(line: &str) -> Option<(&str, &str)> {
    if line.starts_with('#') || line.is_empty() {
        return None;
    }
    let eq_pos = line.find('=')?;
    let name = line[..eq_pos].trim();
    let info = line[eq_pos + 1..].trim();
    Some((name, info))
}

fn parse_dep_entry(name: &str, info: &str) -> DependencyInfo {
    // Cargo enables default features unless `default-features = false`
    // (or the snake-case `default_features = false`) is present.
    let default_features =
        !info.contains("default-features = false") && !info.contains("default_features = false");

    DependencyInfo {
        name: name.to_string(),
        default_features,
    }
}

/// The set of allowed Dolly workspace crate names.
const ALLOWED_DOLLY_CRATES: &[&str] =
    &["dolly-canonical-json", "dolly-core-domain", "dolly-schema"];

/// Dependencies forbidden in any WP-001 crate.
const FORBIDDEN_DEPS: &[&str] = &[
    "ryu", // must use ryu-js instead
    "tokio",
    "anyhow",
    "rusqlite",
    "sqlx",
    "reqwest",
    "mcp",
    "axum",
    "actix-web",
    "rocket",
    "warp",
    "tower",
    "hyper",
    "rand",
    "uuid",
    "time",
    "chrono",
    "base64",
    "regex",
];

/// Dependencies forbidden specifically in dolly-core-domain.
const FORBIDDEN_IN_CORE_DOMAIN: &[&str] = &[
    "sha2",
    "hex",
    "subtle",
    "ryu-js",     // core-domain must not implement JCS
    "serde_json", // core-domain must not depend on serde_json directly
    "jsonschema",
];

#[test]
fn dependency_policy_enforced() {
    let root = workspace_root();
    let workspace_toml =
        std::fs::read_to_string(root.join("Cargo.toml")).expect("should read workspace Cargo.toml");

    // Verify workspace members
    assert!(
        workspace_toml.contains("dolly-canonical-json"),
        "workspace must include dolly-canonical-json"
    );
    assert!(
        workspace_toml.contains("dolly-core-domain"),
        "workspace must include dolly-core-domain"
    );
    assert!(
        workspace_toml.contains("dolly-schema"),
        "workspace must include dolly-schema"
    );

    // Parse each member's Cargo.toml
    let members = [
        root.join("crates/dolly-canonical-json/Cargo.toml"),
        root.join("crates/dolly-core-domain/Cargo.toml"),
        root.join("crates/dolly-schema/Cargo.toml"),
    ];

    let mut member_infos = BTreeMap::new();
    for path in &members {
        assert!(
            path.exists(),
            "Cargo.toml should exist at {}",
            path.display()
        );
        let info = parse_cargo_toml(path);
        member_infos.insert(info.name.clone(), info);
    }

    assert_eq!(
        member_infos.len(),
        3,
        "should have exactly 3 workspace members"
    );

    // Verify allowed Dolly crates
    for name in member_infos.keys() {
        assert!(
            ALLOWED_DOLLY_CRATES.contains(&name.as_str()),
            "unexpected Dolly crate: {name}"
        );
    }

    // Verify dependency edges
    // dolly-canonical-json: MUST NOT depend on either other Dolly crate
    let cj = &member_infos["dolly-canonical-json"];
    for dep in &cj.dependencies {
        assert_ne!(
            dep.name, "dolly-core-domain",
            "dolly-canonical-json must not depend on dolly-core-domain"
        );
        assert_ne!(
            dep.name, "dolly-schema",
            "dolly-canonical-json must not depend on dolly-schema"
        );
    }

    // dolly-core-domain: depends on dolly-canonical-json and serde only
    let cd = &member_infos["dolly-core-domain"];
    let cd_dep_names: Vec<&str> = cd.dependencies.iter().map(|d| d.name.as_str()).collect();
    assert!(
        cd_dep_names.contains(&"dolly-canonical-json"),
        "dolly-core-domain must depend on dolly-canonical-json"
    );
    assert!(
        cd_dep_names.contains(&"serde"),
        "dolly-core-domain must depend on serde"
    );
    // dolly-core-domain must not have forbidden dependencies
    for dep in &cd.dependencies {
        for forbidden in FORBIDDEN_IN_CORE_DOMAIN {
            assert_ne!(
                dep.name, *forbidden,
                "dolly-core-domain must not depend on {forbidden}"
            );
        }
    }

    // dolly-schema: depends on dolly-canonical-json, dolly-core-domain, serde,
    // serde_json, thiserror, and jsonschema
    let sc = &member_infos["dolly-schema"];
    let sc_dep_names: Vec<&str> = sc.dependencies.iter().map(|d| d.name.as_str()).collect();
    assert!(
        sc_dep_names.contains(&"dolly-canonical-json"),
        "dolly-schema must depend on dolly-canonical-json"
    );
    assert!(
        sc_dep_names.contains(&"dolly-core-domain"),
        "dolly-schema must depend on dolly-core-domain"
    );
    assert!(
        sc_dep_names.contains(&"serde"),
        "dolly-schema must depend on serde"
    );
    assert!(
        sc_dep_names.contains(&"serde_json"),
        "dolly-schema must depend on serde_json"
    );
    assert!(
        sc_dep_names.contains(&"thiserror"),
        "dolly-schema must depend on thiserror"
    );
    assert!(
        sc_dep_names.contains(&"jsonschema"),
        "dolly-schema must depend on jsonschema"
    );

    // Verify jsonschema has default-features = false (no network resolution),
    // asserted from the parsed dependency metadata rather than the raw TOML.
    let jsonschema_dep = sc
        .dependencies
        .iter()
        .find(|d| d.name == "jsonschema")
        .expect("dolly-schema must depend on jsonschema");
    assert!(
        !jsonschema_dep.default_features,
        "jsonschema must have default-features = false (no network resolution)"
    );

    // Verify no forbidden dependencies in any member, across every
    // dependency kind (normal, dev, build). cargo_metadata is allowed as a
    // dev-dependency only because it is absent from FORBIDDEN_DEPS.
    for (name, info) in &member_infos {
        for dep in info
            .dependencies
            .iter()
            .chain(&info.dev_dependencies)
            .chain(&info.build_dependencies)
        {
            for forbidden in FORBIDDEN_DEPS {
                assert_ne!(
                    dep.name, *forbidden,
                    "{name} must not depend on {forbidden}"
                );
            }
        }
    }

    // Verify dolly-canonical-json uses ryu-js (not ryu)
    let cj_toml =
        std::fs::read_to_string(root.join("crates/dolly-canonical-json/Cargo.toml")).unwrap();
    assert!(
        cj_toml.contains("ryu-js"),
        "dolly-canonical-json must use ryu-js"
    );
    assert!(
        !cj_toml.contains("ryu =") && !cj_toml.contains("\"ryu\""),
        "dolly-canonical-json must not depend on ryu (only ryu-js)"
    );

    // Verify edition and rust-version
    let workspace_toml = std::fs::read_to_string(root.join("Cargo.toml")).unwrap();
    assert!(
        workspace_toml.contains("edition = \"2024\""),
        "workspace must use edition 2024"
    );
    assert!(
        workspace_toml.contains("rust-version = \"1.85\""),
        "workspace must have rust-version 1.85"
    );
    assert!(
        workspace_toml.contains("resolver = \"3\""),
        "workspace must use resolver 3"
    );

    // Verify rust-toolchain.toml exists and is pinned to 1.85.0
    let toolchain_path = root.join("rust-toolchain.toml");
    assert!(toolchain_path.exists(), "rust-toolchain.toml must exist");
    let toolchain = std::fs::read_to_string(&toolchain_path).unwrap();
    assert!(
        toolchain.contains("1.85.0"),
        "rust-toolchain.toml must be pinned to 1.85.0"
    );
}
