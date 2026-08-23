//! JSON-RPC 2.0 envelope validation over canonical (JCS, UTF-8, duplicate-free)
//! JSON frame payloads.
//!
//! The complete-frame parse uses `ParseLimits::protocol_wire` (96 levels) from
//! `dolly-canonical-json`; the configured (never higher) frame nesting limit is
//! enforced by a byte-level depth scan that classifies a depth rejection as
//! `frame_too_deep` before the authoritative parse runs. Semantic payload depth
//! is a schema-layer concern handled by the schema crate, so it is carried in
//! [`FrameLimits`] but not invented here.

use std::fmt;

use dolly_canonical_json::{CanonicalJsonValue, ParseLimits, parse_core_json};

use crate::frame::FrameLimits;

/// Classification of a decoded message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageKind {
    Request,
    Notification,
    Response,
}

/// A frame payload that passed the JCS parse and JSON-RPC 2.0 envelope checks.
#[derive(Clone, Debug, PartialEq)]
pub struct DecodedMessage {
    pub kind: MessageKind,
    /// Request or response ID (empty for notifications).
    pub id: Option<String>,
    pub body: CanonicalJsonValue,
}

impl DecodedMessage {
    pub fn body(&self) -> &CanonicalJsonValue {
        &self.body
    }

    /// The semantic payload root per envelope kind: `params` for requests and
    /// notifications, `result` for success responses, `error.data` for error
    /// responses. Semantics of a deeper schema-root reset belong to the schema
    /// layer.
    pub fn payload(&self) -> Option<&CanonicalJsonValue> {
        let CanonicalJsonValue::Object(map) = &self.body else {
            return None;
        };
        match self.kind {
            MessageKind::Request | MessageKind::Notification => map.get("params"),
            MessageKind::Response => {
                let error = map.get("error");
                if let Some(err_value) = error {
                    if let CanonicalJsonValue::Object(error_map) = err_value {
                        if let Some(data) = error_map.get("data") {
                            return Some(data);
                        }
                    }
                    return Some(err_value);
                }
                map.get("result")
            }
        }
    }

    pub fn method(&self) -> Option<&str> {
        let CanonicalJsonValue::Object(map) = &self.body else {
            return None;
        };
        match map.get("method") {
            Some(CanonicalJsonValue::String(text)) => Some(text),
            _ => None,
        }
    }
}

/// Fatal message (payload) violations, all of which close the connection.
#[derive(Clone, Debug, PartialEq)]
pub enum MessageError {
    /// Invalid UTF-8, invalid JSON, a duplicate key, or a top-level value
    /// other than an object (JSON-RPC Parse Error, -32700).
    Parse { reason: String },
    /// Complete-frame nesting depth above the configured limit.
    FrameTooDeep { limit: u16, found: u16 },
    /// Envelope fails the JSON-RPC 2.0 profile (JSON-RPC Invalid Request,
    /// -32600).
    InvalidRequest { reason: String },
}

impl MessageError {
    /// JSON-RPC error code to emit as a transport error before closing, if any.
    pub fn transport_error_code(&self) -> Option<i32> {
        match self {
            MessageError::Parse { .. } => Some(-32700),
            MessageError::InvalidRequest { .. } => Some(-32600),
            MessageError::FrameTooDeep { .. } => None,
        }
    }

    /// Whether closing on this error emits a JSON-RPC transport error before
    /// closing the transport.
    pub fn emits_transport_error(&self) -> bool {
        self.transport_error_code().is_some()
    }
}

impl fmt::Display for MessageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MessageError::Parse { reason } => write!(f, "parse error: {reason}"),
            MessageError::FrameTooDeep { limit, found } => {
                write!(f, "frame depth {found} exceeds configured limit {limit}")
            }
            MessageError::InvalidRequest { reason } => write!(f, "invalid request: {reason}"),
        }
    }
}

impl std::error::Error for MessageError {}

/// Byte-level scan of the complete-frame nesting depth using the wire rule:
/// the first object/array/container is depth 1 and each directly nested
/// object/array adds 1. String contents (including escapes) are skipped, so
/// braces inside strings never count.
pub(crate) fn scan_frame_depth(payload: &[u8]) -> u16 {
    let mut depth: u16 = 0;
    let mut max_depth: u16 = 0;
    let mut i = 0;
    while i < payload.len() {
        match payload[i] {
            b'"' => {
                i += 1;
                while i < payload.len() {
                    match payload[i] {
                        b'\\' => i += 2,
                        b'"' => {
                            i += 1;
                            break;
                        }
                        _ => i += 1,
                    }
                }
            }
            b'{' | b'[' => {
                depth = depth.saturating_add(1);
                if depth > max_depth {
                    max_depth = depth;
                }
                i += 1;
            }
            b'}' | b']' => {
                depth = depth.saturating_sub(1);
                i += 1;
            }
            _ => i += 1,
        }
    }
    max_depth
}

fn invalid(message: &str) -> MessageError {
    MessageError::InvalidRequest {
        reason: message.into(),
    }
}

fn jsonrpc_is_v2(value: &CanonicalJsonValue) -> bool {
    match value {
        CanonicalJsonValue::String(text) => text == "2.0",
        _ => false,
    }
}

fn valid_id(value: &CanonicalJsonValue) -> Option<String> {
    match value {
        CanonicalJsonValue::String(text)
            if !text.is_empty() && text.len() <= 128 && !text.contains('\0') =>
        {
            Some(text.clone())
        }
        _ => None,
    }
}

fn valid_method(value: Option<&CanonicalJsonValue>) -> Result<String, MessageError> {
    match value {
        Some(CanonicalJsonValue::String(text)) if !text.is_empty() && text.len() <= 160 => {
            Ok(text.clone())
        }
        Some(_) => Err(invalid(
            "method must be a non-empty string of at most 160 bytes",
        )),
        None => Ok(String::new()),
    }
}

/// Decodes and validates one frame payload.
pub fn decode_message(payload: &[u8], limits: FrameLimits) -> Result<DecodedMessage, MessageError> {
    let found = scan_frame_depth(payload);
    if found > limits.max_frame_nesting_depth() {
        return Err(MessageError::FrameTooDeep {
            limit: limits.max_frame_nesting_depth(),
            found,
        });
    }
    let value = parse_core_json(payload, ParseLimits::protocol_wire()).map_err(|err| {
        MessageError::Parse {
            reason: err.to_string(),
        }
    })?;
    let CanonicalJsonValue::Object(map) = &value else {
        return Err(MessageError::Parse {
            reason: "frame payload must be a JSON object".into(),
        });
    };

    if !jsonrpc_is_v2(map.get("jsonrpc").unwrap_or(&CanonicalJsonValue::Null)) {
        return Err(invalid("jsonrpc must be \"2.0\""));
    }

    let id = map.get("id");
    let method = map.get("method");
    let has_params = map.get("params").is_some();
    let has_result = map.get("result").is_some();
    let has_error = map.get("error").is_some();

    let method_text = valid_method(method)?;

    if method.is_none() && id.is_none() {
        return Err(invalid("message needs method or id"));
    }

    if !method_text.is_empty() {
        if has_result || has_error {
            return Err(invalid(
                "requests and notifications must not carry result or error",
            ));
        }
        if has_params {
            match map.get("params") {
                Some(CanonicalJsonValue::Object(_)) => {}
                _ => return Err(invalid("params must be an object")),
            }
        }
        let kind = if id.is_some() {
            MessageKind::Request
        } else {
            MessageKind::Notification
        };
        let id_text = match id {
            Some(value) => match valid_id(value) {
                Some(text) => Some(text),
                None => {
                    return Err(invalid(
                        "id must be a non-empty string of at most 128 bytes",
                    ));
                }
            },
            None => None,
        };
        return Ok(DecodedMessage {
            kind,
            id: id_text,
            body: value,
        });
    }

    // Response: requires an id and exactly one of result/error.
    if has_result == has_error {
        return Err(invalid("response must have exactly one of result or error"));
    }
    let id_text = match id {
        Some(value) => match valid_id(value) {
            Some(text) => Some(text),
            None => {
                return Err(invalid(
                    "id must be a non-empty string of at most 128 bytes",
                ));
            }
        },
        None => return Err(invalid("response id is required")),
    };
    if has_params {
        return Err(invalid("response must not carry params"));
    }
    if has_error {
        if !matches!(map.get("error"), Some(CanonicalJsonValue::Object(_))) {
            return Err(invalid("error must be an object"));
        }
    }
    Ok(DecodedMessage {
        kind: MessageKind::Response,
        id: id_text,
        body: value,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::FrameLimits;

    fn limits() -> FrameLimits {
        FrameLimits::defaults()
    }

    #[test]
    fn valid_request_decodes() {
        let payload = br#"{"jsonrpc":"2.0","id":"a","method":"extension.ping","params":{}}"#;
        let msg = decode_message(payload, limits()).unwrap();
        assert_eq!(msg.kind, MessageKind::Request);
        assert_eq!(msg.id.as_deref(), Some("a"));
        assert_eq!(msg.method(), Some("extension.ping"));
        assert!(msg.payload().is_some());
    }

    #[test]
    fn valid_notification_decodes() {
        let payload = br#"{"jsonrpc":"2.0","method":"extension.notify"}"#;
        let msg = decode_message(payload, limits()).unwrap();
        assert_eq!(msg.kind, MessageKind::Notification);
        assert!(msg.id.is_none());
    }

    #[test]
    fn valid_response_with_result() {
        let payload = br#"{"jsonrpc":"2.0","id":"a","result":{"ok":true}}"#;
        let msg = decode_message(payload, limits()).unwrap();
        assert_eq!(msg.kind, MessageKind::Response);
        assert_eq!(msg.id.as_deref(), Some("a"));
    }

    #[test]
    fn duplicate_key_is_parse_error() {
        let payload = br#"{"jsonrpc":"2.0","id":"a","id":"b","method":"extension.ping"}"#;
        let err = decode_message(payload, limits()).unwrap_err();
        assert!(matches!(err, MessageError::Parse { .. }));
        assert_eq!(err.transport_error_code(), Some(-32700));
    }

    #[test]
    fn wrong_jsonrpc_version_is_invalid_request() {
        let payload = br#"{"jsonrpc":"1.0","id":"a","method":"extension.ping"}"#;
        let err = decode_message(payload, limits()).unwrap_err();
        assert!(matches!(err, MessageError::InvalidRequest { .. }));
        assert_eq!(err.transport_error_code(), Some(-32600));
    }

    #[test]
    fn too_deep_frame_is_frame_too_deep() {
        let mut text = String::new();
        for _ in 0..97 {
            text.push('[');
        }
        text.push('0');
        for _ in 0..97 {
            text.push(']');
        }
        let err = decode_message(text.as_bytes(), limits()).unwrap_err();
        assert!(matches!(
            err,
            MessageError::FrameTooDeep {
                limit: 96,
                found: 97
            }
        ));
        assert!(err.transport_error_code().is_none());
    }

    #[test]
    fn top_level_primitive_is_parse_error() {
        let err = decode_message(b"true", limits()).unwrap_err();
        assert!(matches!(err, MessageError::Parse { .. }));
    }
}
