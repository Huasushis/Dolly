//! Closed resolved tool-broker registry: config admission and validation.
//!
//! Admission is the only authority that can expand the configured tool map
//! (spec §2/§3): discovery annotations and ordering, and any server-returned
//! name or result, can never add or replace a callable tool. No network,
//! provider, or tool execution is performed by this crate.

use std::collections::BTreeMap;

use dolly_canonical_json::{
    CanonicalJsonObject, CanonicalJsonValue, ParseLimits, Sha256Digest, canonicalize,
    parse_core_json,
};
use serde::{Deserialize, Serialize};

use crate::version::{
    MCP_PROTOCOL_VERSION_2025_06_18, TOOL_CONFIG_INVALID, UnsupportedProtocolVersion,
    check_protocol_version,
};

/// The `$id` of the embedded `tool-broker-config.schema.json`.
pub const TOOL_BROKER_CONFIG_SCHEMA_ID: &str =
    "https://dolly.example/spec/0.1/schemas/tool-broker-config.schema.json";

/// Stable dictionary reasons published in `ToolRegistryCandidateRejected`.
pub mod reason {
    pub const UNSUPPORTED_PROTOCOL_VERSION: &str = "unsupported_protocol_version";
    pub const SCHEMA_DIGEST_MISMATCH: &str = "schema_digest_mismatch";
    pub const INPUT_SCHEMA_NOT_OBJECT: &str = "input_schema_not_object";
    pub const MALFORMED: &str = "malformed";
}

/// Classification of why a config transaction was rejected (spec §8:
/// candidate registry/schema/package failures use `TOOL_CONFIG_INVALID`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RejectionReason {
    /// A candidate server contract is outside the freeze boundary
    /// (TST-TOOL-008): newer, unknown, or older revisions fail closed.
    UnsupportedProtocolVersion { protocol_version: String },
    /// A configured schema digest does not match the recomputed JCS digest.
    SchemaDigestMismatch {
        server_id: String,
        tool_name: String,
    },
    /// A configured input schema is not an object-form schema (spec §2).
    InputSchemaNotObject {
        server_id: String,
        tool_name: String,
    },
    /// Parse, schema-validation, or internal admission failure.
    Malformed { message: String },
}

impl RejectionReason {
    /// The stable dictionary reason string used in emitted events.
    pub fn as_str(&self) -> &'static str {
        match self {
            RejectionReason::UnsupportedProtocolVersion { .. } => {
                reason::UNSUPPORTED_PROTOCOL_VERSION
            }
            RejectionReason::SchemaDigestMismatch { .. } => reason::SCHEMA_DIGEST_MISMATCH,
            RejectionReason::InputSchemaNotObject { .. } => reason::INPUT_SCHEMA_NOT_OBJECT,
            RejectionReason::Malformed { .. } => reason::MALFORMED,
        }
    }
}

impl std::fmt::Display for RejectionReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RejectionReason::UnsupportedProtocolVersion { protocol_version } => write!(
                f,
                "protocol {protocol_version} is outside the {MCP_PROTOCOL_VERSION_2025_06_18} boundary"
            ),
            RejectionReason::SchemaDigestMismatch {
                server_id,
                tool_name,
            } => write!(
                f,
                "configured schema digest mismatch for {server_id}/{tool_name}"
            ),
            RejectionReason::InputSchemaNotObject {
                server_id,
                tool_name,
            } => write!(
                f,
                "input schema for {server_id}/{tool_name} is not an object schema"
            ),
            RejectionReason::Malformed { message } => write!(f, "malformed config: {message}"),
        }
    }
}

/// A rejected config transaction. `code` is always `TOOL_CONFIG_INVALID`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigRejection {
    pub code: &'static str,
    reason: RejectionReason,
}

impl ConfigRejection {
    pub fn new(reason: RejectionReason) -> Self {
        Self {
            code: TOOL_CONFIG_INVALID,
            reason,
        }
    }

    /// The underlying rejection classification.
    pub fn reason(&self) -> &RejectionReason {
        &self.reason
    }

    /// Stable dictionary reason (`unsupported_protocol_version`, …).
    pub fn reason_text(&self) -> &'static str {
        self.reason.as_str()
    }
}

/// Outcome of config admission.
#[derive(Debug)]
pub enum AdmissionOutcome {
    Admitted(ResolvedToolBrokerConfig),
    Rejected(ConfigRejection),
}

/// Closed resolved idempotency policy (spec §5 closed tagged union).
///
/// The `argument_key` variant retains the configured RFC 6901
/// `argument_pointer` so call-time verification can resolve it on the
/// complete caller-supplied `arguments` object and require the resolved
/// value to be a string exactly equal to `host.tool.invoke.idempotency_key`
/// (REQ-TOOL-002). Admission rejects a missing, empty, or malformed pointer
/// as config invalid; the pointer is never dropped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IdempotencyPolicy {
    None,
    ArgumentKey { argument_pointer: String },
}

/// Side-effect class (closed set).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SideEffectClass {
    ReadOnly,
    IdempotentWrite,
    NonIdempotentWrite,
    Unknown,
}

/// One resolved callable tool: the Dolly alias → upstream mapping plus the
/// frozen contract. Only admission constructs these; server discovery cannot.
#[derive(Debug, Clone)]
pub struct ResolvedTool {
    /// The separately stored upstream name the adapter dials.
    pub upstream_name: String,
    /// Bounded description.
    pub description: String,
    /// Embedded object-form input schema document (canonical bytes).
    pub input_schema: String,
    /// Recomputed and validated digest of the input schema document.
    pub input_schema_digest: Sha256Digest,
    /// Embedded output schema document (canonical bytes).
    pub output_schema: String,
    /// Recomputed and validated digest of the output schema document.
    pub output_schema_digest: Sha256Digest,
    pub side_effect_class: SideEffectClass,
    pub idempotency: IdempotencyPolicy,
    pub requires_confirmation: bool,
    pub enabled: bool,
}

/// One resolved server.
#[derive(Debug, Clone)]
pub struct ResolvedServer {
    pub adapter: String,
    pub protocol_version: String,
    pub transport_kind: String,
    pub allowed_modules: Vec<String>,
    pub tools: BTreeMap<String, ResolvedTool>,
    pub enabled: bool,
    /// The exact closed `Server` object from the retained registry, retained
    /// canonically at admission. `operation_digest` binds its JCS bytes as the
    /// spec §5 `server_contract`, so every authority-bearing field
    /// (`adapter`, `protocol_version`, full `transport`, `allowed_modules`,
    /// `limits`, tool map, schema digests) is frozen with the binding.
    pub server_contract: CanonicalJsonObject,
}

/// The closed resolved registry, authoritative for invoke mapping. Only
/// admission can construct one; it has no mutation path.
#[derive(Debug, Clone, Default)]
pub struct ResolvedToolBrokerConfig {
    servers: BTreeMap<String, ResolvedServer>,
}

impl ResolvedToolBrokerConfig {
    pub fn servers(&self) -> &BTreeMap<String, ResolvedServer> {
        &self.servers
    }
}

/// Admit a resolved `tool-broker-config` document.
///
/// Validates against the embedded `tool-broker-config.schema.json`, enforces
/// the frozen MCP version boundary for every server, recomputes each tool's
/// input/output schema digest (`sha256(JCS(document))`), and rejects the
/// candidate on any mismatch. This is the only path that builds a
/// `ResolvedToolBrokerConfig`.
pub fn admit_config(bytes: &[u8]) -> AdmissionOutcome {
    let value = match parse_core_json(bytes, ParseLimits::protocol_wire()) {
        Ok(value) => value,
        Err(error) => {
            return AdmissionOutcome::Rejected(ConfigRejection::new(RejectionReason::Malformed {
                message: error.to_string(),
            }));
        }
    };
    match admit_value(&value) {
        Ok(config) => AdmissionOutcome::Admitted(config),
        Err(rejection) => AdmissionOutcome::Rejected(rejection),
    }
}

fn admit_value(value: &CanonicalJsonValue) -> Result<ResolvedToolBrokerConfig, ConfigRejection> {
    // The version boundary is checked before schema validation so that a
    // concrete non-2025-06-18 candidate is reported as
    // `unsupported_protocol_version` (TST-TOOL-008), not as a generic shape
    // failure. Unknown, newer, and older revisions all fail closed.
    check_all_protocol_versions(value)?;

    let catalog = crate::schema_catalog()
        .map_err(|message| ConfigRejection::new(RejectionReason::Malformed { message }))?;
    let validator = catalog
        .validator(TOOL_BROKER_CONFIG_SCHEMA_ID)
        .map_err(|error| {
            ConfigRejection::new(RejectionReason::Malformed {
                message: error.to_string(),
            })
        })?;
    validator.validate(value).map_err(|errors| {
        ConfigRejection::new(RejectionReason::Malformed {
            message: errors.to_string(),
        })
    })?;
    build_registry(value)
}

/// Reject any server whose `protocol_version` is outside the frozen
/// `2025-06-18` boundary, reported via `unsupported_protocol_version`.
fn check_all_protocol_versions(value: &CanonicalJsonValue) -> Result<(), ConfigRejection> {
    let servers = as_object(value)
        .and_then(|root| root.get("servers"))
        .and_then(as_object)
        .ok_or_else(|| {
            ConfigRejection::new(RejectionReason::Malformed {
                message: "config root must contain a servers object".into(),
            })
        })?;
    for (server_id, server_value) in servers.iter() {
        let server = as_object(server_value).ok_or_else(|| {
            ConfigRejection::new(RejectionReason::Malformed {
                message: format!("server {server_id} must be an object"),
            })
        })?;
        let protocol = required_string(server, "protocol_version")?;
        check_protocol_version(protocol).map_err(|UnsupportedProtocolVersion { candidate }| {
            ConfigRejection::new(RejectionReason::UnsupportedProtocolVersion {
                protocol_version: candidate,
            })
        })?;
    }
    Ok(())
}

fn build_registry(value: &CanonicalJsonValue) -> Result<ResolvedToolBrokerConfig, ConfigRejection> {
    let root = as_object(value).ok_or_else(|| {
        ConfigRejection::new(RejectionReason::Malformed {
            message: "config root must be an object".into(),
        })
    })?;
    let servers = root.get("servers").and_then(as_object).ok_or_else(|| {
        ConfigRejection::new(RejectionReason::Malformed {
            message: "config root must contain a servers object".into(),
        })
    })?;

    let mut resolved = ResolvedToolBrokerConfig::default();
    for (server_id, server_value) in servers.iter() {
        let server = as_object(server_value).ok_or_else(|| {
            ConfigRejection::new(RejectionReason::Malformed {
                message: format!("server {server_id} must be an object"),
            })
        })?;
        let protocol = required_string(server, "protocol_version")?;
        let enabled = required_bool(server, "enabled")?;
        let adapter = required_string(server, "adapter")?.to_owned();
        let transport = transport_kind(server)?.to_owned();
        let allowed_modules = required_strings(server, "allowed_modules")?;
        let tools = build_tools(server, server_id)?;
        // Retain the exact canonical closed `Server` object so the frozen
        // operation binding can bind the complete authority (spec §5
        // `server_contract`): adapter, protocol, full transport, limits,
        // allowed modules, tools, and schema digests.
        let server_contract = server.clone();
        resolved.servers.insert(
            server_id.to_owned(),
            ResolvedServer {
                adapter,
                protocol_version: protocol.to_owned(),
                transport_kind: transport,
                allowed_modules,
                tools,
                enabled,
                server_contract,
            },
        );
    }
    Ok(resolved)
}

fn build_tools(
    server: &CanonicalJsonObject,
    server_id: &str,
) -> Result<BTreeMap<String, ResolvedTool>, ConfigRejection> {
    let tools = server.get("tools").and_then(as_object).ok_or_else(|| {
        ConfigRejection::new(RejectionReason::Malformed {
            message: format!("server {server_id} must contain a tools object"),
        })
    })?;
    let mut out = BTreeMap::new();
    for (tool_name, tool_value) in tools.iter() {
        let tool = as_object(tool_value).ok_or_else(|| {
            ConfigRejection::new(RejectionReason::Malformed {
                message: format!("tool {server_id}/{tool_name} must be an object"),
            })
        })?;

        let upstream_name = required_string(tool, "upstream_name")?.to_owned();
        let description = required_string(tool, "description")?.to_owned();
        let input = schema_digest_pair(
            tool,
            "input_schema",
            "input_schema_digest",
            true,
            server_id,
            tool_name,
        )?;
        let output = schema_digest_pair(
            tool,
            "output_schema",
            "output_schema_digest",
            false,
            server_id,
            tool_name,
        )?;
        let side_effect_class = side_effect_class(tool)?;
        let idempotency = idempotency_policy(tool)?;
        let requires_confirmation = required_bool(tool, "requires_confirmation")?;
        let enabled = required_bool(tool, "enabled")?;

        out.insert(
            tool_name.to_owned(),
            ResolvedTool {
                upstream_name,
                description,
                input_schema: input.canonical,
                input_schema_digest: input.digest,
                output_schema: output.canonical,
                output_schema_digest: output.digest,
                side_effect_class,
                idempotency,
                requires_confirmation,
                enabled,
            },
        );
    }
    Ok(out)
}

struct SchemaPair {
    canonical: String,
    digest: Sha256Digest,
}

/// Validates one embedded schema document, recomputes its JCS digest, and
/// requires that digest to equal the configured digest. Input schemas must be
/// object-form (`"type":"object"` at the root).
fn schema_digest_pair(
    tool: &CanonicalJsonObject,
    schema_key: &str,
    digest_key: &str,
    require_object_root: bool,
    server_id: &str,
    tool_name: &str,
) -> Result<SchemaPair, ConfigRejection> {
    let schema = tool.get(schema_key).and_then(as_object).ok_or_else(|| {
        ConfigRejection::new(if require_object_root {
            RejectionReason::InputSchemaNotObject {
                server_id: server_id.to_owned(),
                tool_name: tool_name.to_owned(),
            }
        } else {
            RejectionReason::Malformed {
                message: format!("{schema_key} must be an object"),
            }
        })
    })?;
    if require_object_root && root_type(schema) != Some("object") {
        return Err(ConfigRejection::new(
            RejectionReason::InputSchemaNotObject {
                server_id: server_id.to_owned(),
                tool_name: tool_name.to_owned(),
            },
        ));
    }
    let configured = required_string(tool, digest_key)?.to_owned();
    let doc = CanonicalJsonValue::Object(schema.clone());
    let (bytes, computed) = canonicalize(&doc).map_err(|error| {
        ConfigRejection::new(RejectionReason::Malformed {
            message: format!("{schema_key}: {error}"),
        })
    })?;
    if computed.to_canonical_string() != configured {
        return Err(ConfigRejection::new(
            RejectionReason::SchemaDigestMismatch {
                server_id: server_id.to_owned(),
                tool_name: tool_name.to_owned(),
            },
        ));
    }
    Ok(SchemaPair {
        canonical: String::from_utf8(bytes.into_vec()).expect("JCS is UTF-8"),
        digest: computed,
    })
}

fn root_type(schema: &CanonicalJsonObject) -> Option<&str> {
    schema.get("type").and_then(as_str)
}

fn side_effect_class(tool: &CanonicalJsonObject) -> Result<SideEffectClass, ConfigRejection> {
    let value = required_string(tool, "side_effect_class")?;
    Ok(match value {
        "read_only" => SideEffectClass::ReadOnly,
        "idempotent_write" => SideEffectClass::IdempotentWrite,
        "non_idempotent_write" => SideEffectClass::NonIdempotentWrite,
        "unknown" => SideEffectClass::Unknown,
        other => {
            return Err(ConfigRejection::new(RejectionReason::Malformed {
                message: format!("unknown side_effect_class {other}"),
            }));
        }
    })
}

fn idempotency_policy(tool: &CanonicalJsonObject) -> Result<IdempotencyPolicy, ConfigRejection> {
    let idemp = tool.get("idempotency").and_then(as_object).ok_or_else(|| {
        ConfigRejection::new(RejectionReason::Malformed {
            message: "idempotency must be an object".into(),
        })
    })?;
    let kind = required_string(idemp, "kind")?;
    Ok(match kind {
        "none" => IdempotencyPolicy::None,
        "argument_key" => {
            // The pointer is required, non-empty, well-formed RFC 6901, and
            // retained on the closed policy (REQ-TOOL-002 / spec §5). The
            // embedded schema constrains the pointer syntax; this check
            // keeps the resolved registry closed regardless of the schema.
            let pointer = required_string(idemp, "argument_pointer")?;
            if pointer.trim().is_empty() {
                return Err(ConfigRejection::new(RejectionReason::Malformed {
                    message: "argument_pointer must be non-empty".into(),
                }));
            }
            if !well_formed_rfc6901_pointer(pointer) {
                return Err(ConfigRejection::new(RejectionReason::Malformed {
                    message: format!(
                        "argument_pointer {pointer:?} is not a well-formed RFC 6901 pointer"
                    ),
                }));
            }
            IdempotencyPolicy::ArgumentKey {
                argument_pointer: pointer.to_owned(),
            }
        }
        other => {
            return Err(ConfigRejection::new(RejectionReason::Malformed {
                message: format!("unknown idempotency kind {other}"),
            }));
        }
    })
}

/// Non-recursive RFC 6901 well-formedness check (pointer syntax alone; no
/// document traversal). A pointer is either the whole document (`""`) or a
/// `/`-led reference-token path in which every `~` is escaped as `~0`
/// (tilde) or `~1` (slash); any other `~` occurrence makes the pointer
/// malformed.
pub(crate) fn well_formed_rfc6901_pointer(pointer: &str) -> bool {
    if pointer.is_empty() {
        // RFC 6901: the empty string refers to the whole document. The
        // config schema requires non-empty, so admission rejects it earlier;
        // the resolver still honors it when called directly.
        return true;
    }
    if !pointer.starts_with('/') {
        return false;
    }
    let mut escaped = false;
    for byte in pointer.bytes() {
        if escaped {
            if byte != b'0' && byte != b'1' {
                return false;
            }
            escaped = false;
        } else {
            match byte {
                b'~' => escaped = true,
                _ => {}
            }
        }
    }
    !escaped
}

fn transport_kind(server: &CanonicalJsonObject) -> Result<&str, ConfigRejection> {
    let transport = server.get("transport").and_then(as_object).ok_or_else(|| {
        ConfigRejection::new(RejectionReason::Malformed {
            message: "server must contain a transport object".into(),
        })
    })?;
    required_string(transport, "kind")
}

fn required_string<'a>(
    object: &'a CanonicalJsonObject,
    key: &str,
) -> Result<&'a str, ConfigRejection> {
    match object.get(key) {
        Some(CanonicalJsonValue::String(text)) => Ok(text),
        _ => Err(ConfigRejection::new(RejectionReason::Malformed {
            message: format!("{key} must be a string"),
        })),
    }
}

fn required_bool(object: &CanonicalJsonObject, key: &str) -> Result<bool, ConfigRejection> {
    match object.get(key) {
        Some(CanonicalJsonValue::Bool(value)) => Ok(*value),
        _ => Err(ConfigRejection::new(RejectionReason::Malformed {
            message: format!("{key} must be a boolean"),
        })),
    }
}

fn required_strings(object: &CanonicalJsonObject, key: &str) -> Result<Vec<String>, ConfigError> {
    match object.get(key) {
        Some(CanonicalJsonValue::Array(items)) => items
            .iter()
            .map(|item| match item {
                CanonicalJsonValue::String(text) => Ok(text.clone()),
                _ => Err(ConfigRejection::new(RejectionReason::Malformed {
                    message: format!("{key} must contain only strings"),
                })),
            })
            .collect(),
        _ => Err(ConfigRejection::new(RejectionReason::Malformed {
            message: format!("{key} must be an array"),
        })),
    }
}

fn as_object(value: &CanonicalJsonValue) -> Option<&CanonicalJsonObject> {
    match value {
        CanonicalJsonValue::Object(object) => Some(object),
        _ => None,
    }
}

fn as_str(value: &CanonicalJsonValue) -> Option<&str> {
    match value {
        CanonicalJsonValue::String(text) => Some(text),
        _ => None,
    }
}

/// Alias kept for error-message clarity.
type ConfigError = ConfigRejection;
