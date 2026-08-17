//! Closed destructive-disposition shape validation for configuration candidates.
//!
//! The normative rule (control-plane config-proposal schema, `disposition`
//! item): a `transfer` disposition MUST carry `target_id` and any other
//! disposition MUST NOT. The candidate object is closed: unknown fields,
//! missing or malformed values are rejected deterministically, with no host or
//! environment behavior.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Closed set of destructive backlog dispositions, per the config-proposal
/// schema. A destructive update removes durable state and names exactly one of
/// these dispositions in its approval request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Disposition {
    Archive,
    Transfer,
    DeadLetter,
    AuditedDiscard,
}

/// Reason a disposition candidate failed closed shape validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispositionShapeError {
    /// Candidate is not a JSON object.
    NotAnObject,
    /// Candidate carries a field other than `disposition`/`target_id`.
    UnknownField(String),
    /// Candidate omits `disposition`.
    MissingDisposition,
    /// `disposition` is present but not a string.
    NonStringDisposition,
    /// `disposition` is a string outside the closed set.
    UnknownDisposition(String),
    /// `target_id` is present but not a string.
    NonStringTargetId,
    /// `disposition` is `transfer` but `target_id` is absent.
    TransferRequiresTarget,
    /// `target_id` is present for a disposition other than `transfer`.
    TargetNotAllowed(Disposition),
}

/// Validates one disposition candidate against the closed shape rule.
///
/// Accepts exactly `{"disposition": "transfer", "target_id": <string>}` and
/// non-transfer dispositions without `target_id`; rejects everything else.
pub fn validate_disposition_candidate(
    candidate: &Value,
) -> Result<(), DispositionShapeError> {
    let object = candidate
        .as_object()
        .ok_or(DispositionShapeError::NotAnObject)?;
    for key in object.keys() {
        if key != "disposition" && key != "target_id" {
            return Err(DispositionShapeError::UnknownField(key.clone()));
        }
    }
    let disposition = object
        .get("disposition")
        .ok_or(DispositionShapeError::MissingDisposition)?
        .as_str()
        .ok_or(DispositionShapeError::NonStringDisposition)?;
    let parsed = match disposition {
        "archive" => Disposition::Archive,
        "transfer" => Disposition::Transfer,
        "dead_letter" => Disposition::DeadLetter,
        "audited_discard" => Disposition::AuditedDiscard,
        other => return Err(DispositionShapeError::UnknownDisposition(other.into())),
    };
    let has_target = object.contains_key("target_id");
    if has_target {
        object
            .get("target_id")
            .unwrap()
            .as_str()
            .ok_or(DispositionShapeError::NonStringTargetId)?;
    }
    match parsed {
        Disposition::Transfer if has_target => Ok(()),
        Disposition::Transfer => Err(DispositionShapeError::TransferRequiresTarget),
        other if has_target => Err(DispositionShapeError::TargetNotAllowed(other)),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn transfer_requires_target() {
        assert_eq!(
            validate_disposition_candidate(&json!({"disposition": "transfer"})),
            Err(DispositionShapeError::TransferRequiresTarget)
        );
    }

    #[test]
    fn non_transfer_rejects_target() {
        assert_eq!(
            validate_disposition_candidate(&json!({"disposition": "audited_discard", "target_id": "replacement-module"})),
            Err(DispositionShapeError::TargetNotAllowed(
                Disposition::AuditedDiscard
            ))
        );
        assert_eq!(
            validate_disposition_candidate(&json!({"disposition": "archive", "target_id": "m"})),
            Err(DispositionShapeError::TargetNotAllowed(Disposition::Archive))
        );
        assert_eq!(
            validate_disposition_candidate(&json!({"disposition": "dead_letter", "target_id": "m"})),
            Err(DispositionShapeError::TargetNotAllowed(Disposition::DeadLetter))
        );
    }

    #[test]
    fn transfer_with_target_ok() {
        assert_eq!(
            validate_disposition_candidate(&json!({"disposition": "transfer", "target_id": "replacement-module"})),
            Ok(())
        );
    }

    #[test]
    fn non_transfer_without_target_ok() {
        for disposition in ["archive", "dead_letter", "audited_discard"] {
            assert_eq!(
                validate_disposition_candidate(&json!({"disposition": disposition})),
                Ok(())
            );
        }
    }

    #[test]
    fn malformed_candidates_rejected() {
        assert_eq!(
            validate_disposition_candidate(&json!([1, 2])),
            Err(DispositionShapeError::NotAnObject)
        );
        assert_eq!(
            validate_disposition_candidate(&json!("transfer")),
            Err(DispositionShapeError::NotAnObject)
        );
        assert_eq!(
            validate_disposition_candidate(&json!({"target_id": "x"})),
            Err(DispositionShapeError::MissingDisposition)
        );
        assert_eq!(
            validate_disposition_candidate(&json!({"disposition": 7})),
            Err(DispositionShapeError::NonStringDisposition)
        );
        assert_eq!(
            validate_disposition_candidate(&json!({"disposition": "transfer", "target_id": 7})),
            Err(DispositionShapeError::NonStringTargetId)
        );
    }

    #[test]
    fn closed_field_set_and_disposition_set() {
        assert_eq!(
            validate_disposition_candidate(&json!({"disposition": "transfer", "target_id": "m", "extra": 1})),
            Err(DispositionShapeError::UnknownField("extra".into()))
        );
        assert_eq!(
            validate_disposition_candidate(&json!({"disposition": "shred"})),
            Err(DispositionShapeError::UnknownDisposition("shred".into()))
        );
    }
}
