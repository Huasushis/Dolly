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

/// The always-computable pre-resolution caller digest.
pub fn request_digest(operation_id: &str, txn_id: &str, params: &JsonValue) -> Sha256Digest {
    // request_digest = sha256(JCS({"method":"host.tool.invoke","params":P}))
    // where P = the complete params. In the minimal pure-core crate the
    // envelope re-serializes the provided params; no registry is needed here.
    let _ = (operation_id, txn_id);
    let envelope = CanonicalJsonObject::try_from_iter(vec![
        (
            "method".to_owned(),
            CanonicalJsonValue::String(INVOKE_METHOD.to_owned()),
        ),
        (
            "params".to_owned(),
            serde_to_canonical(params).unwrap_or(CanonicalJsonValue::Null),
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
    // Idempotency binding per the closed policy.
    let idempotency_ok = match &tool.idempotency {
        IdempotencyPolicy::None => true,
        IdempotencyPolicy::ArgumentKey => candidate.idempotency_key.is_some(),
    };
    if !idempotency_ok {
        return rejection(
            candidate,
            ToolErrorCode::InputInvalid,
            format!("configured argument_key idempotency requires an idempotency_key"),
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
        &candidate.tool_server_id,
        &tool.upstream_name,
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
/// digest, the selected generation, and the exact resolved server contract.
/// The `operation_digest` never exists for a denial (REQ-TOOL-005).
pub fn operation_digest(
    request_digest: &Sha256Digest,
    tool_server_generation: u64,
    tool_server_id: &str,
    upstream_name: &str,
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
            CanonicalJsonValue::String(format!("{tool_server_id}:{upstream_name}")),
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
