//! Semantic validator for the successful `org.dolly.channel.send` result.
//!
//! After JSON Schema validation against
//! `schemas/channel-send-result.schema.json`, this validator requires:
//!
//! - `messages[i].ordinal == i` for every array position, so the array is
//!   ordered and ordinals are contiguous from zero;
//! - bytewise uniqueness of every `external_message_id`, so transport IDs
//!   cannot alias two confirmed pieces.
//!
//! It receives only the frozen Action/result validation context and performs
//! no transport or ledger I/O.

use dolly_canonical_json::{CanonicalJsonObject, CanonicalJsonValue};
use dolly_schema::embedded_schema_catalog;

/// The semantic validator contract identity required by the spec's
/// `result_schema` binding for a confirmed send.
pub const RESULT_VALIDATOR_ID: &str = "org.dolly.validator.channel-send-result";
/// The frozen revision of the semantic result validator.
pub const RESULT_VALIDATOR_REVISION: i64 = 1;
/// The `$id` of the result schema document.
pub const SEND_RESULT_SCHEMA_ID: &str =
    "https://dolly.example/spec/0.1/schemas/channel-send-result.schema.json";
/// The frozen `$schema` tag of a successful send result.
pub const SEND_RESULT_SCHEMA_TAG: &str = "dolly.channel.send-result/v1";
/// Hard bound mirroring the schema (`maxItems: 32`).
pub const MAX_RESULT_MESSAGES: usize = 32;
/// Hard bound mirroring `external_message_id` limits.
pub const MAX_EXTERNAL_MESSAGE_ID_BYTES: usize = 512;

/// Check that a `result_schema` binding is the expected Channel send-result
/// contract at the frozen revision. A missing, stale, or foreign validator
/// identity or revision is a contract mismatch and MUST refuse the send.
pub fn result_contract_matches(validator_id: Option<&str>, revision: Option<i64>) -> bool {
    match (validator_id, revision) {
        (Some(id), Some(rev)) => id == RESULT_VALIDATOR_ID && rev == RESULT_VALIDATOR_REVISION,
        _ => false,
    }
}

/// Run JSON Schema validation plus the semantic invariant on one candidate
/// successful send result. `Ok(())` means the payload is a valid
/// `dolly.channel.send-result/v1` document that this validator endorses.
pub fn validate_send_result(value: &CanonicalJsonValue) -> Result<(), String> {
    let catalog =
        embedded_schema_catalog().map_err(|e| format!("embedded schema catalog unavailable: {e}"))?;
    catalog
        .validate(SEND_RESULT_SCHEMA_ID, value, 32)
        .map_err(|errors| format!("send result schema validation failed: {errors}"))?;
    semantic_validate_send_result(value)
}

fn as_object(value: &CanonicalJsonValue) -> Option<&CanonicalJsonObject> {
    match value {
        CanonicalJsonValue::Object(obj) => Some(obj),
        _ => None,
    }
}

fn as_str(value: &CanonicalJsonValue) -> Option<&str> {
    match value {
        CanonicalJsonValue::String(s) => Some(s),
        _ => None,
    }
}

fn as_array(value: &CanonicalJsonValue) -> Option<&[CanonicalJsonValue]> {
    match value {
        CanonicalJsonValue::Array(items) => Some(items),
        _ => None,
    }
}

/// Read an integer from a canonical number, requiring an exact integer value
/// representable as `i64`.
fn as_i64(value: &CanonicalJsonValue) -> Option<i64> {
    match value {
        CanonicalJsonValue::Number(n) => {
            let f = n.as_f64();
            if f.fract() != 0.0 || f < i64::MIN as f64 || f > i64::MAX as f64 {
                return None;
            }
            Some(f as i64)
        }
        _ => None,
    }
}

/// The pure semantic invariant (no schema, no I/O), kept public so the rule is
/// independently testable and reusable by the schema bundle harness.
pub fn semantic_validate_send_result(value: &CanonicalJsonValue) -> Result<(), String> {
    let obj = as_object(value).ok_or_else(|| "send result must be a JSON object".to_string())?;
    let schema_tag = obj
        .get("schema")
        .and_then(as_str)
        .ok_or_else(|| "send result missing schema tag".to_string())?;
    if schema_tag != SEND_RESULT_SCHEMA_TAG {
        return Err(format!(
            "send result schema tag must be {SEND_RESULT_SCHEMA_TAG}, got {schema_tag}"
        ));
    }
    let messages = obj
        .get("messages")
        .and_then(as_array)
        .ok_or_else(|| "send result missing messages array".to_string())?;
    if messages.is_empty() || messages.len() > MAX_RESULT_MESSAGES {
        return Err(format!(
            "send result messages length must be in 1..={MAX_RESULT_MESSAGES}, got {}",
            messages.len()
        ));
    }
    let mut seen: Vec<&str> = Vec::with_capacity(messages.len());
    for (index, message) in messages.iter().enumerate() {
        let message_obj =
            as_object(message).ok_or_else(|| format!("messages[{index}] must be an object"))?;
        let ordinal = message_obj
            .get("ordinal")
            .and_then(as_i64)
            .ok_or_else(|| format!("messages[{index}] missing ordinal"))?;
        if ordinal != index as i64 {
            return Err(format!(
                "messages[{index}].ordinal must equal its array position (got {ordinal})"
            ));
        }
        let external_id = message_obj
            .get("external_message_id")
            .and_then(as_str)
            .ok_or_else(|| format!("messages[{index}] missing external_message_id"))?;
        let bytes = external_id.as_bytes();
        if bytes.is_empty() || bytes.len() > MAX_EXTERNAL_MESSAGE_ID_BYTES {
            return Err(format!(
                "messages[{index}].external_message_id length must be in 1..={MAX_EXTERNAL_MESSAGE_ID_BYTES} bytes"
            ));
        }
        if seen.contains(&external_id) {
            return Err(format!(
                "messages[{index}].external_message_id duplicates an earlier confirmed piece"
            ));
        }
        seen.push(external_id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result_with(messages: Vec<(i64, &str)>) -> CanonicalJsonValue {
        let items: Vec<serde_json::Value> = messages
            .iter()
            .map(|(ordinal, id)| {
                serde_json::json!({
                    "ordinal": ordinal,
                    "external_message_id": id,
                })
            })
            .collect();
        let value = serde_json::json!({
            "schema": SEND_RESULT_SCHEMA_TAG,
            "session_id": "session-main",
            "delivery_outcome": "sent",
            "messages": items,
        });
        CanonicalJsonValue::try_from(value).unwrap()
    }

    #[test]
    fn contiguous_ordinals_and_unique_ids_pass() {
        let value = result_with(vec![(0, "m1"), (1, "m2"), (2, "m3")]);
        assert_eq!(semantic_validate_send_result(&value), Ok(()));
    }

    #[test]
    fn gapped_or_out_of_order_ordinals_fail() {
        let value = result_with(vec![(0, "m1"), (2, "m2")]);
        assert!(semantic_validate_send_result(&value).is_err());
        let value = result_with(vec![(1, "m1"), (0, "m2")]);
        assert!(semantic_validate_send_result(&value).is_err());
    }

    #[test]
    fn duplicate_external_ids_fail() {
        let value = result_with(vec![(0, "m1"), (1, "m1")]);
        assert!(semantic_validate_send_result(&value).is_err());
    }

    #[test]
    fn contract_revision_is_frozen() {
        assert!(result_contract_matches(Some(RESULT_VALIDATOR_ID), Some(RESULT_VALIDATOR_REVISION)));
        assert!(!result_contract_matches(Some(RESULT_VALIDATOR_ID), Some(2)));
        assert!(!result_contract_matches(Some("other.validator"), Some(1)));
        assert!(!result_contract_matches(None, Some(1)));
        assert!(!result_contract_matches(Some(RESULT_VALIDATOR_ID), None));
    }
}
