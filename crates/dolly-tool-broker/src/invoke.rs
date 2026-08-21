//! Pre-resolution invocation evaluation: two-stage operation digest and
//! candidate admission.
//!
//! The two stages mirror the spec and REQ-TOOL-005:
//!   stage 1 — the pre-resolution `request_digest` (always computable from
//!             the call) is used FIRST to compare an existing
//!             `(module_id, operation_id)` identity without resolving any
//!             current registry or generation;
//!   stage 2 — after every current authorization gate passes, the frozen
//!             operation binding and its digest are produced for the Host to
//!             persist atomically with `AUTHORIZED`.
//!
//! Every denial returns before the `ResolutionBackend` seam is consulted, so
//! a backend that counts calls provably sees zero calls on every denial path.

use dolly_canonical_json::{CanonicalJsonObject, CanonicalJsonValue, Sha256Digest, canonicalize};
use serde_json::Value as JsonValue;

use crate::registry::{IdempotencyPolicy, ResolvedToolBrokerConfig};
use crate::result::{ToolErrorCode, ToolResult};

/// The durable digest of an accepted operation binding (stage 2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrozenBinding {
    pub operation_digest: Sha256Digest,
    pub tool_server_generation: u64,
}

/// The only crate→backend seam. Called only after a binding is accepted;
/// a denial never reaches it, which is what the vector spy proves.
pub trait ResolutionBackend {
    /// Select the exact server generation for an authorized call, or `None`
    /// when the server cannot be made available (`TOOL_SERVER_UNAVAILABLE`).
    fn resolve_server(&mut self, server_id: &str, tool_name: &str) -> Option<u64>;
}

/// An already-existing identity row `(authenticated_module_id, operation_id)`.
/// The Host persists these rows; this crate only reads the supplied snapshot.
#[derive(Debug, Clone)]
pub struct ExistingOperation {
    pub request_digest: Sha256Digest,
    pub result: Option<ToolResult>,
}

/// The complete `host.tool.invoke` request payload (identity + params) with
/// the always-computable pre-resolution `request_digest`.
#[derive(Debug, Clone)]
pub struct InvokeCandidate {
    pub operation_id: String,
    pub tool_transaction_id: String,
    pub module_id: String,
    pub activation_id: String,
    pub config_revision: u64,
    pub lease_token: String,
    pub tool_server_id: String,
    pub tool_name: String,
    pub tool_schema_digest: Sha256Digest,
    pub arguments: JsonValue,
    pub side_effect_class: String,
    pub idempotency_key: Option<String>,
    pub confirmation_id: Option<String>,
    pub deadline: String,
    pub request_digest: Sha256Digest,
}

/// The decision of `evaluate_invoke`.
#[derive(Debug)]
pub enum InvokeOutcome {
    /// Pre-resolution denial: no operation binding, no row, backend untouched.
    PreResolutionDenied { result: ToolResult },
    /// Identity present with an equal pre-resolution `request_digest`
    /// (REQ-TOOL-005): the recorded result is returned, nothing resolved.
    Replayed { result: ToolResult },
    /// Identity present with a different `request_digest`: `TOOL_IDEMPOTENCY_
    /// CONFLICT`, no row mutation, no backend call (REQ-7.5).
    Rejected { result: ToolResult },
    /// Every gate passed; the Host must persist `AUTHORIZED` atomically with
    /// the frozen binding before any dispatch.
    Authorized { binding: FrozenBinding },
}

/// The schema tag of the frozen operation binding (stage 2).
pub const OPERATION_BINDING_SCHEMA: &str = "dolly.tool-operation-binding/v1";
/// The schema tag of the pre-resolution digest envelope.
pub const INVOKE_METHOD: &str = "host.tool.invoke";

/// Non-recursive RFC 6901 JSON Pointer resolution over caller-supplied data.
///
/// The pointer syntax is evaluated against `document` (the complete
/// `host.tool.invoke.arguments` object) without mutating or normalizing a
/// single caller byte:
///   - `""` is the whole document (RFC 6901 root reference);
///   - `"/"` addresses the member whose key is the empty string;
///   - a reference token is unescaped `~1 → /`, `~0 → ~`, directly (RFC
///     6901 §4: a literal `~` must be followed by `0` or `1`);
///   - on an array, a token is the zero-prefix-free index of an existing
///     element; an out-of-range index or continuation from a scalar is a
///     MISS result.
/// Resolution is non-recursive and returns `None` for any missing member,
/// missing index, or structurally invalid pointer. It never reorders, adds,
/// or removes caller arguments, so the pointer always reads the exact
/// byte-identical object the caller supplied.
pub fn resolve_json_pointer<'a>(document: &'a JsonValue, pointer: &str) -> Option<&'a JsonValue> {
    if pointer.is_empty() {
        return Some(document);
    }
    if !pointer.starts_with('/') {
        return None;
    }
    let mut current = document;
    for raw_token in pointer[1..].split('/') {
        let token = unescape_pointer_token(raw_token)?;
        match current {
            JsonValue::Object(map) => current = map.get(&token)?,
            JsonValue::Array(items) => {
                let index = parse_array_index(&token)?;
                current = items.get(index)?;
            }
            _ => return None,
        }
    }
    Some(current)
}

/// RFC 6901 token unescaping (`~1` → `/`, `~0` → `~`). Any `~` not followed
/// by `0` or `1` is an invalid pointer.
fn unescape_pointer_token(token: &str) -> Option<String> {
    if !token.contains('~') {
        return Some(token.to_owned());
    }
    let mut out = String::with_capacity(token.len());
    let mut bytes = token.bytes();
    while let Some(byte) = bytes.next() {
        if byte != b'~' {
            out.push(char::from(byte));
            continue;
        }
        match bytes.next() {
            Some(b'0') => out.push('~'),
            Some(b'1') => out.push('/'),
            Some(_) => return None,
            None => return None,
        }
    }
    Some(out)
}

/// Parse an RFC 6901 array index: `"0"` or a non-zero-leading decimal; any
/// other token (including `-`) is not an existing array element reference
/// under RFC 6901 evaluation.
fn parse_array_index(token: &str) -> Option<usize> {
    if token == "0" {
        return Some(0);
    }
    if token.is_empty() || !token.starts_with(|c: char| c >= '1' && c <= '9') {
        return None;
    }
    if !token.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    token.parse().ok()
}

/// The always-computable pre-resolution caller digest (spec §5).
///
/// `params` is the complete `host.tool.invoke` params object. The digest is
/// computed over `P`, the complete params after removing only `operation_id`,
/// `deadline`, and `lease_token`:
///
/// ```text
/// request_digest = sha256(JCS({"method":"host.tool.invoke","params":P}))
/// ```
///
/// Every other member — including `tool_transaction_id`, `module_id`,
/// `config_revision`, `tool_server_id`, `tool_name`, `tool_schema_digest`,
/// `arguments`, and the side-effect/idempotency/confirmation bindings — is
/// part of `P` and therefore of the identity. Only the three identity-volatile
/// keys are excluded, so re-submitting the same semantic call after a fresh
/// lease/deadline keeps the identity digest stable. A non-object input is a
/// schema violation and is hashed as-is for totality (the wire layer rejects
/// it earlier).
pub fn request_digest(params: &JsonValue) -> Sha256Digest {
    let p = match params {
        JsonValue::Object(map) => {
            let mut map = map.clone();
            map.remove("operation_id");
            map.remove("deadline");
            map.remove("lease_token");
            JsonValue::Object(map)
        }
        _ => params.clone(),
    };
    let envelope = CanonicalJsonObject::try_from_iter(vec![
        (
            "method".to_owned(),
            CanonicalJsonValue::String(INVOKE_METHOD.to_owned()),
        ),
        (
            "params".to_owned(),
            serde_to_canonical(&p).unwrap_or(CanonicalJsonValue::Null),
        ),
    ])
    .expect("unique envelope keys");
    let (bytes, digest) =
        canonicalize(&CanonicalJsonValue::Object(envelope)).expect("envelope is canonicalizable");
    let _ = bytes;
    digest
}

fn serde_to_canonical(value: &JsonValue) -> Option<CanonicalJsonValue> {
    match value {
        JsonValue::Null => Some(CanonicalJsonValue::Null),
        JsonValue::Bool(b) => Some(CanonicalJsonValue::Bool(*b)),
        JsonValue::Number(n) => n.as_f64().and_then(|f| {
            let n = dolly_canonical_json::CanonicalNumber::from_f64(f).ok()?;
            Some(CanonicalJsonValue::Number(n))
        }),
        JsonValue::String(s) => Some(CanonicalJsonValue::String(s.clone())),
        JsonValue::Array(items) => {
            let converted: Vec<CanonicalJsonValue> =
                items.iter().filter_map(serde_to_canonical).collect();
            if converted.len() != items.len() {
                return None;
            }
            Some(CanonicalJsonValue::Array(converted))
        }
        JsonValue::Object(map) => {
            let mut entries = Vec::with_capacity(map.len());
            for (key, value) in map {
                match serde_to_canonical(value) {
                    Some(canonical) => entries.push((key.clone(), canonical)),
                    None => return None,
                }
            }
            Some(CanonicalJsonValue::Object(
                CanonicalJsonObject::try_from_iter(entries).ok()?,
            ))
        }
    }
}

/// Two-stage evaluation (REQ-TOOL-005 / TST-TOOL-005). Order is
/// authoritative: the identity's recorded `request_digest` is compared before
/// any resolution, and every denial returns before the backend seam.
pub fn evaluate_invoke<B: ResolutionBackend>(
    registry: &ResolvedToolBrokerConfig,
    authenticated_module_id: &str,
    candidate: &InvokeCandidate,
    existing_identity: Option<&ExistingOperation>,
    backend: &mut B,
) -> InvokeOutcome {
    // ---- stage 1: identity + pre-resolution request_digest comparison ----
    if let Some(row) = existing_identity {
        if row.request_digest == candidate.request_digest {
            // Equal digest: replay the recorded outcome; resolution must not
            // run for the same identity.
            let result = match &row.result {
                Some(result) => result.clone(),
                None => ToolResult::absent(candidate.operation_id.clone()),
            };
            return InvokeOutcome::Replayed { result };
        }
        // Different digest on the same identity: derived rejection, no row
        // mutation, no backend call (REQ-TOOL-003).
        return InvokeOutcome::Rejected {
            result: ToolResult::denied(
                candidate.operation_id.clone(),
                ToolErrorCode::IdempotencyConflict,
                "pre-existing operation identity has a different request_digest",
            ),
        };
    }

    // ---- stage 2: current resolution inside the closed registry ----
    let servers = registry.servers();
    let Some(server) = servers.get(&candidate.tool_server_id) else {
        return rejection(
            candidate,
            ToolErrorCode::Unknown,
            format!(
                "tool_server_id {} is not in the resolved registry",
                candidate.tool_server_id
            ),
        );
    };
    if !server.enabled {
        return rejection(
            candidate,
            ToolErrorCode::Unknown,
            format!("server {} is disabled", candidate.tool_server_id),
        );
    }
    if server.adapter != "mcp" {
        return rejection(
            candidate,
            ToolErrorCode::Unknown,
            format!("server {} adapter is not mcp", candidate.tool_server_id),
        );
    }
    if !server
        .allowed_modules
        .iter()
        .any(|module| module == authenticated_module_id)
    {
        return rejection(
            // TOOL_CAPABILITY_DENIED for a module grant failure
            candidate,
            ToolErrorCode::CapabilityDenied,
            format!(
                "module {authenticated_module_id} is not allowed on server {}",
                candidate.tool_server_id
            ),
        );
    }
    let Some(tool) = server.tools.get(&candidate.tool_name) else {
        return rejection(
            // TOOL_UNKNOWN: pre-resolution alias absent
            candidate,
            ToolErrorCode::Unknown,
            format!(
                "tool alias {} is not configured on server {}",
                candidate.tool_name, candidate.tool_server_id
            ),
        );
    };
    if !tool.enabled {
        return rejection(
            candidate,
            ToolErrorCode::Unknown,
            format!("tool {} is disabled", candidate.tool_name),
        );
    }
    // Schema-digest binding: the caller must target the frozen input-schema
    // digest admitted with the config.
    if candidate.tool_schema_digest != tool.input_schema_digest {
        return rejection(
            candidate,
            ToolErrorCode::InputInvalid,
            format!(
                "schema digest mismatch for {}/{}",
                candidate.tool_server_id, candidate.tool_name
            ),
        );
    }
    // Idempotency binding per the closed policy (REQ-TOOL-002). For
    // argument_key the RFC 6901 pointer MUST resolve on the caller-supplied
    // arguments to a string byte-identical to `idempotency_key`; a missing
    // target, a non-string target, or an unequal value is TOOL_INPUT_INVALID
    // and the denial returns before the backend seam. The key is never
    // treated as a dedup attestation: nothing here (no redispatch, no
    // upstream status probe, no result replay) is implied by a match.
    let matching_argument = match &tool.idempotency {
        IdempotencyPolicy::None => true,
        IdempotencyPolicy::ArgumentKey { argument_pointer } => {
            match resolve_json_pointer(&candidate.arguments, argument_pointer) {
                Some(JsonValue::String(resolved)) => {
                    candidate.idempotency_key.as_deref() == Some(resolved.as_str())
                }
                _ => false,
            }
        }
    };
    if !matching_argument {
        let pointer = match &tool.idempotency {
            IdempotencyPolicy::ArgumentKey { argument_pointer } => Some(argument_pointer.as_str()),
            _ => None,
        };
        return rejection(
            candidate,
            ToolErrorCode::InputInvalid,
            format!(
                "configured argument_key idempotency requires argument_pointer {pointer:?} to resolve to exactly the idempotency_key"
            ),
        );
    }
    // Confirmation policy per the frozen contract.
    if tool.requires_confirmation && candidate.confirmation_id.is_none() {
        return rejection(
            candidate,
            ToolErrorCode::ConfirmationRequired,
            format!(
                "tool {} requires an approved confirmation_id",
                candidate.tool_name
            ),
        );
    }

    // Every gate passed; only now may the backend resolve a generation.
    let Some(tool_server_generation) =
        backend.resolve_server(&candidate.tool_server_id, &candidate.tool_name)
    else {
        return rejection(
            candidate,
            ToolErrorCode::ServerUnavailable,
            format!("server {} is not available", candidate.tool_server_id),
        );
    };

    let operation_digest = operation_digest(
        &candidate.request_digest,
        tool_server_generation,
        &server.server_contract,
    );
    InvokeOutcome::Authorized {
        binding: FrozenBinding {
            operation_digest,
            tool_server_generation,
        },
    }
}

fn rejection(candidate: &InvokeCandidate, code: ToolErrorCode, message: String) -> InvokeOutcome {
    let result = ToolResult::denied(candidate.operation_id.clone(), code, message);
    InvokeOutcome::PreResolutionDenied { result }
}

/// Stage-2 digest: `sha256(JCS(operation-binding))`, freezing the request
/// digest, the selected generation, and the exact closed Server object from
/// the retained registry (spec §5 `server_contract`). The `operation_digest`
/// never exists for a denial (REQ-TOOL-005).
///
/// `server_contract` is the canonical, closed, serializable Server snapshot
/// retained by admission. Its JCS bytes bind the full closed-registry
/// authority — `adapter`, `protocol_version`, the complete `transport`
/// (endpoint/package/executable metadata), `allowed_modules`, `limits`, the
/// tool map, and both schema digests — so any authority-bearing field change
/// rotates the digest even when the resolved tool alias and `upstream_name`
/// are unchanged. Discovery and results never contribute to it. It contains
/// only secret *references* (`secret://` URIs), never resolved secret values,
/// function bodies, or runtime backend state, so the digest is a pure function
/// of the frozen inputs: request digest, selected generation, and retained
/// snapshot.
pub fn operation_digest(
    request_digest: &Sha256Digest,
    tool_server_generation: u64,
    server_contract: &CanonicalJsonObject,
) -> Sha256Digest {
    let binding = CanonicalJsonObject::try_from_iter(vec![
        (
            "schema".to_owned(),
            CanonicalJsonValue::String(OPERATION_BINDING_SCHEMA.to_owned()),
        ),
        (
            "request_digest".to_owned(),
            CanonicalJsonValue::String(request_digest.to_canonical_string()),
        ),
        (
            "tool_server_generation".to_owned(),
            CanonicalJsonValue::Number(
                dolly_canonical_json::CanonicalNumber::from_f64(tool_server_generation as f64)
                    .unwrap(),
            ),
        ),
        (
            "server_contract".to_owned(),
            CanonicalJsonValue::Object(server_contract.clone()),
        ),
        (
            "confirmation_decision".to_owned(),
            CanonicalJsonValue::String("not_required".to_owned()),
        ),
    ])
    .expect("unique binding keys");
    let (bytes, digest) =
        canonicalize(&CanonicalJsonValue::Object(binding)).expect("binding is canonicalizable");
    let _ = bytes;
    digest
}
