//! The Asset Host import/status façade (WP-010 -> G4 Host wiring).
//!
//! A façade in this crate is the thin, stable wire boundary the Host's
//! method registry binds `host.asset.import` and `host.asset.status` to. It
//! adapts the typed [`AssetService`] to the frozen wire contracts in
//! `asset-import.schema.json`, `asset-status-request.schema.json`, and
//! `asset-status.schema.json`: every entry point validates the request,
//! binds the caller's capability (the exact instance, module, and security
//! domain, plus the issuing Host lifecycle), maps typed failures to the
//! closed error envelope, and never exposes a path, capability, or secret.
//!
//! The façade performs no transport, no JSON-RPC framing, and no shared Host
//! registration; the later integrator registers these methods and supplies
//! the authenticated capability per call.

use crate::config::ResolvedAssetConfig;
use crate::error::{AssetError, AssetErrorCode, AssetErrorEnvelope, ErrorPhase};
use crate::record::{ImportRequest, StatusResult};
use crate::service::{AssetCapability, AssetService};
use dolly_core_domain::{ModuleId, Timestamp, UuidV7};
use serde::{Deserialize, Serialize};

/// The `host.asset.status` params (asset-status-request.schema.json).
/// Every field is validated against its wire grammar at construction, so a
/// forged or malformed request fails closed before any store read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetStatusRequest {
    /// The status read's own operation id (UUIDv7), distinct from
    /// `import_id`.
    pub operation_id: String,
    /// The calling Module, used as a consistency check against the granted
    /// capability.
    pub module_id: String,
    /// The original import whose state is being read (UUIDv7).
    pub import_id: String,
    /// The read deadline (RFC3339 UTC with microsecond precision).
    pub deadline: String,
}

impl AssetStatusRequest {
    /// Fail-closed construction: every field must match its wire grammar.
    pub fn new(
        operation_id: impl Into<String>,
        module_id: impl Into<String>,
        import_id: impl Into<String>,
        deadline: impl Into<String>,
    ) -> Result<Self, String> {
        let request = AssetStatusRequest {
            operation_id: operation_id.into(),
            module_id: module_id.into(),
            import_id: import_id.into(),
            deadline: deadline.into(),
        };
        request.validate()?;
        Ok(request)
    }

    /// Validate each field against its schema grammar. A failure means the
    /// request is forged or malformed and must never reach the store.
    pub fn validate(&self) -> Result<(), String> {
        self.operation_id
            .parse::<UuidV7>()
            .map_err(|_| "operation_id must be a canonical lowercase UUIDv7".to_string())?;
        self.module_id
            .parse::<ModuleId>()
            .map_err(|_| "module_id must be a stable local identifier".to_string())?;
        self.import_id
            .parse::<UuidV7>()
            .map_err(|_| "import_id must be a canonical lowercase UUIDv7".to_string())?;
        self.deadline
            .parse::<Timestamp>()
            .map_err(|_| "deadline must be an RFC3339 UTC timestamp".to_string())?;
        Ok(())
    }

    pub fn module_id(&self) -> &str {
        &self.module_id
    }

    pub fn import_id(&self) -> &str {
        &self.import_id
    }
}

impl Serialize for AssetStatusRequest {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AssetStatusRequest", 4)?;
        s.serialize_field("operation_id", &self.operation_id)?;
        s.serialize_field("module_id", &self.module_id)?;
        s.serialize_field("import_id", &self.import_id)?;
        s.serialize_field("deadline", &self.deadline)?;
        s.end()
    }
}

impl<'de> Deserialize<'de> for AssetStatusRequest {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct WireStatusRequest {
            operation_id: String,
            module_id: String,
            import_id: String,
            deadline: String,
        }
        let wire = WireStatusRequest::deserialize(deserializer)?;
        Self::new(
            wire.operation_id,
            wire.module_id,
            wire.import_id,
            wire.deadline,
        )
        .map_err(serde::de::Error::custom)
    }
}

/// The stable Asset Host import/status façade the G4 integrator registers
/// for `host.asset.import` and `host.asset.status`. It owns the
/// [`AssetService`] and hands back typed results or the closed error
/// envelope; it never leaks a raw cause, path, or capability field.
pub struct AssetHostFacade {
    service: AssetService,
}

impl AssetHostFacade {
    /// Open the façade over one local content root (see
    /// [`AssetService::open`]).
    pub fn open(config: ResolvedAssetConfig) -> Result<Self, AssetError> {
        Ok(Self {
            service: AssetService::open(config)?,
        })
    }

    /// Hand the wrapped service to the integrator for the remaining Host
    /// operations (recovery, GC, read, lease, pin, reference, diagnostics).
    pub fn into_service(self) -> AssetService {
        self.service
    }

    /// Mint a capability for one security domain, module instance, and
    /// module (the Host boundary; see [`AssetService::issue_capability`]).
    pub fn issue_capability(
        &self,
        domain: impl Into<String>,
        instance_id: impl Into<String>,
        module_id: impl Into<String>,
    ) -> AssetCapability {
        self.service
            .issue_capability(domain, instance_id, module_id)
    }

    /// Run (or replay) one import. The result is the non-`absent`
    /// `ImportResult` fragment: `available` with the canonical `AssetRef`,
    /// a recorded in-progress or terminal state, or `rejected`/`cancelled`
    /// with the embedded error envelope. Hard failures return the closed
    /// error envelope.
    pub fn import(
        &mut self,
        capability: &AssetCapability,
        request: &ImportRequest,
    ) -> Result<StatusResult, AssetErrorEnvelope> {
        self.service
            .import(capability, request)
            .map_err(|error| error.to_envelope())
    }

    /// Read one import's status. The request's `module_id` must match the
    /// granted capability; unknown and cross-owner `ImportId`s both resolve
    /// to the closed `absent` status (they are indistinguishable), which is
    /// the only outcome that authorizes replay of a byte-identical import.
    pub fn status(
        &mut self,
        capability: &AssetCapability,
        request: &AssetStatusRequest,
    ) -> Result<StatusResult, AssetErrorEnvelope> {
        if request.module_id() != capability.module_id() {
            return Err(facade_error(
                AssetErrorCode::Unauthorized,
                "status request module does not match the granted capability",
            ));
        }
        let import_id = request.import_id().to_string();
        self.service
            .status(capability, &import_id)
            .map_err(|error| error.to_envelope())
    }
}

fn facade_error(code: AssetErrorCode, message: &str) -> AssetErrorEnvelope {
    AssetError::new(code, ErrorPhase::Validate, message).to_envelope()
}
