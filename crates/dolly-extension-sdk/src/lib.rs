//! Data-only values that cross the G2 Extension boundary.
//!
//! This crate does not know Host authority, G1 state, transport, leases, or
//! Extension identity. Its public values are untrusted request data or
//! canonical result payload data; the Host binds them to its opaque admission
//! receipt before any callback or effect.

use dolly_canonical_json::{
    CanonicalBytes, CanonicalJsonObject, CanonicalJsonValue, Sha256Digest, canonicalize,
};
use serde::Serialize;
use thiserror::Error;

/// Data-only invocation input projected by the Host or decoded by an adapter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvocationInput {
    value: CanonicalJsonObject,
}

impl InvocationInput {
    /// Store input data without creating or carrying Host authority.
    pub fn new(value: CanonicalJsonObject) -> Self {
        Self { value }
    }

    pub fn value(&self) -> &CanonicalJsonObject {
        &self.value
    }
}

/// An untrusted Host-service request. Identity, direction, and grants are
/// deliberately absent; Host admission supplies and checks those fences.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityRequest {
    method: String,
    arguments: CanonicalJsonObject,
}

impl CapabilityRequest {
    /// Build request data for a Host method; this does not grant access.
    pub fn new(method: &str, arguments: CanonicalJsonObject) -> Result<Self, SdkError> {
        if !valid_host_method(method) {
            return Err(SdkError::InvalidCapabilityRequest);
        }
        Ok(Self {
            method: method.to_owned(),
            arguments,
        })
    }

    pub fn method(&self) -> &str {
        &self.method
    }

    pub fn arguments(&self) -> &CanonicalJsonObject {
        &self.arguments
    }
}

/// Closed activation result status.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResultStatus {
    Success,
    RetryableFailure,
    PermanentFailure,
}

/// Data-only activation result payload. It has no identity or fence fields.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ResultData {
    status: ResultStatus,
    output: Option<CanonicalJsonObject>,
    scheduling_hint: Option<CanonicalJsonObject>,
    error: Option<CanonicalJsonObject>,
}

impl ResultData {
    pub fn success(
        output: Option<CanonicalJsonObject>,
        scheduling_hint: Option<CanonicalJsonObject>,
    ) -> Self {
        Self {
            status: ResultStatus::Success,
            output,
            scheduling_hint,
            error: None,
        }
    }

    pub fn retryable_failure(error: CanonicalJsonObject) -> Self {
        Self {
            status: ResultStatus::RetryableFailure,
            output: None,
            scheduling_hint: None,
            error: Some(error),
        }
    }

    pub fn permanent_failure(error: CanonicalJsonObject) -> Self {
        Self {
            status: ResultStatus::PermanentFailure,
            output: None,
            scheduling_hint: None,
            error: Some(error),
        }
    }

    pub fn status(&self) -> ResultStatus {
        self.status
    }

    pub fn output(&self) -> Option<&CanonicalJsonObject> {
        self.output.as_ref()
    }

    pub fn scheduling_hint(&self) -> Option<&CanonicalJsonObject> {
        self.scheduling_hint.as_ref()
    }

    pub fn error(&self) -> Option<&CanonicalJsonObject> {
        self.error.as_ref()
    }

    /// Canonical bytes for Host-side result/receipt binding.
    pub fn canonical_bytes(&self) -> Result<CanonicalBytes, SdkError> {
        canonicalize(self)
            .map(|(bytes, _)| bytes)
            .map_err(|_| SdkError::InvalidResultData)
    }

    /// Digest of the canonical result payload only.
    pub fn digest(&self) -> Result<Sha256Digest, SdkError> {
        canonicalize(self)
            .map(|(_, digest)| digest)
            .map_err(|_| SdkError::InvalidResultData)
    }

    /// Canonical value for the Host receipt encoder.
    pub fn canonical_value(&self) -> Result<CanonicalJsonValue, SdkError> {
        let bytes = self.canonical_bytes()?;
        dolly_canonical_json::parse_core_json(
            bytes.as_bytes(),
            dolly_canonical_json::ParseLimits::protocol_wire(),
        )
        .map_err(|_| SdkError::InvalidResultData)
    }
}

/// SDK boundary failures.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum SdkError {
    #[error("capability request is not a Host method")]
    InvalidCapabilityRequest,
    #[error("result data could not be canonicalized")]
    InvalidResultData,
}

fn valid_host_method(method: &str) -> bool {
    !method.is_empty()
        && method.len() <= 160
        && method.starts_with("host.")
        && method.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object() -> CanonicalJsonObject {
        CanonicalJsonObject::try_from_iter([(
            "kind".into(),
            CanonicalJsonValue::String("text".into()),
        )])
        .unwrap()
    }

    #[test]
    fn sdk_data_cannot_reverse_or_mint_capability_authority() {
        assert!(CapabilityRequest::new("module.activate", object()).is_err());
        assert!(CapabilityRequest::new("host.block.get", object()).is_ok());
    }

    #[test]
    fn result_payload_is_canonical_and_has_no_invocation_identity() {
        let result = ResultData::success(Some(object()), None);
        let bytes = result.canonical_bytes().unwrap();
        assert_eq!(
            bytes.as_bytes(),
            br#"{"error":null,"output":{"kind":"text"},"scheduling_hint":null,"status":"success"}"#
        );
        assert!(result.digest().is_ok());
    }
}
