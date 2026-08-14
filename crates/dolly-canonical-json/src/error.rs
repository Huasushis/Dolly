use thiserror::Error;

/// The Core error code for a canonical-JSON failure.
///
/// `CanonicalError` carries a diagnostic reason but maps every profile failure
/// to `CORE_INVALID_JSON` and digest disagreement to `CORE_DIGEST_MISMATCH`.
#[derive(Debug, Clone, Error)]
pub struct CanonicalError {
    pub code: CanonicalErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanonicalErrorCode {
    CoreInvalidJson,
    CoreDigestMismatch,
}

impl CanonicalError {
    pub fn invalid_json(message: impl Into<String>) -> Self {
        Self {
            code: CanonicalErrorCode::CoreInvalidJson,
            message: message.into(),
        }
    }

    pub fn digest_mismatch(message: impl Into<String>) -> Self {
        Self {
            code: CanonicalErrorCode::CoreDigestMismatch,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CanonicalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self.code {
            CanonicalErrorCode::CoreInvalidJson => "CORE_INVALID_JSON",
            CanonicalErrorCode::CoreDigestMismatch => "CORE_DIGEST_MISMATCH",
        };
        write!(f, "{code}: {}", self.message)
    }
}

impl serde::de::Error for CanonicalError {
    fn custom<T: std::fmt::Display>(msg: T) -> Self {
        CanonicalError::invalid_json(msg.to_string())
    }
}

impl CanonicalErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            CanonicalErrorCode::CoreInvalidJson => "CORE_INVALID_JSON",
            CanonicalErrorCode::CoreDigestMismatch => "CORE_DIGEST_MISMATCH",
        }
    }
}
