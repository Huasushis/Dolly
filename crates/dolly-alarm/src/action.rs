//! Committed Alarm Action envelope, argument contracts, and typed results.
//!
//! Actions arrive only inside a committed Block selected into an Activation;
//! the Runtime validates the common envelope and reachability at Block
//! commit. This module validates the operation-specific schema during that
//! Activation: authority (`target` owner + action name owner must be
//! `org.dolly.alarm`), unknown-field rejection, revision guards, and the
//! frozen-config normalization every stable action result fragments over.

use crate::occurrence::{DstFoldPolicy, DstGapPolicy};
use crate::record::MisfirePolicy;
use crate::record::{
    ALARM_ACKNOWLEDGE_ACTION, ALARM_CREATE_ACTION, ALARM_DELETE_ACTION, ALARM_EXTENSION_ID,
    ALARM_GET_ACTION, ALARM_LIST_ACTION, ALARM_SNOOZE_ACTION, ALARM_UPDATE_ACTION, RawDelivery,
    RawSchedule,
};
use serde::Deserialize;
use serde::Serialize;

/// The runtime-resolved blocker target of a committed action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionTarget {
    pub module_id: String,
}

/// A committed Action: the wire envelope is deserialized leniently here; the
/// scheduler re-parses `arguments` into the per-name contract with
/// unknown-field rejection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommittedAction {
    pub action_id: String,
    pub name: String,
    pub arguments: serde_json::Value,
    pub target: Option<ActionTarget>,
    pub correlation_id: Option<String>,
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateArgs {
    pub title: String,
    pub schedule: RawSchedule,
    pub delivery: RawDelivery,
    pub misfire_policy: Option<MisfirePolicy>,
    pub dst_gap_policy: Option<DstGapPolicy>,
    pub dst_fold_policy: Option<DstFoldPolicy>,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListArgs {
    pub enabled: Option<bool>,
    pub cursor: Option<String>,
    pub limit: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GetArgs {
    pub alarm_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateArgs {
    pub alarm_id: String,
    pub expected_revision: u64,
    pub replacement: CreateArgs,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteArgs {
    pub alarm_id: String,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnoozeArgs {
    pub alarm_id: String,
    pub occurrence_id: String,
    pub expected_revision: u64,
    pub new_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcknowledgeArgs {
    pub alarm_id: String,
    pub occurrence_id: String,
    pub expected_revision: u64,
}

/// A validated, typed committed action ready for the scheduler.
#[derive(Debug, Clone)]
pub enum ActionCommand {
    Create(CreateArgs),
    List(ListArgs),
    Get(GetArgs),
    Update(UpdateArgs),
    Delete(DeleteArgs),
    Snooze(SnoozeArgs),
    Acknowledge(AcknowledgeArgs),
}

impl ActionCommand {
    pub fn name(&self) -> &'static str {
        match self {
            ActionCommand::Create(_) => ALARM_CREATE_ACTION,
            ActionCommand::List(_) => ALARM_LIST_ACTION,
            ActionCommand::Get(_) => ALARM_GET_ACTION,
            ActionCommand::Update(_) => ALARM_UPDATE_ACTION,
            ActionCommand::Delete(_) => ALARM_DELETE_ACTION,
            ActionCommand::Snooze(_) => ALARM_SNOOZE_ACTION,
            ActionCommand::Acknowledge(_) => ALARM_ACKNOWLEDGE_ACTION,
        }
    }
}

/// Result payload fragments from `alarm-result.schema.json`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "schema", rename_all = "snake_case")]
pub enum ActionResult {
    #[serde(rename = "dolly.alarm.create-result/v1")]
    Create { record: crate::record::AlarmRecord },
    #[serde(rename = "dolly.alarm.list-result/v1")]
    List {
        records: Vec<crate::record::AlarmRecord>,
        next_cursor: Option<String>,
    },
    #[serde(rename = "dolly.alarm.get-result/v1")]
    Get { record: crate::record::AlarmRecord },
    #[serde(rename = "dolly.alarm.update-result/v1")]
    Update { record: crate::record::AlarmRecord },
    #[serde(rename = "dolly.alarm.delete-result/v1")]
    Delete {
        alarm_id: String,
        deleted_alarm_revision: u64,
    },
    #[serde(rename = "dolly.alarm.snooze-result/v1")]
    Snooze {
        snoozed_occurrence_id: String,
        record: crate::record::AlarmRecord,
    },
    #[serde(rename = "dolly.alarm.acknowledge-result/v1")]
    Acknowledge {
        alarm_id: String,
        alarm_revision: u64,
        occurrence_id: String,
        acknowledged_at: String,
        already_acknowledged: bool,
    },
}

/// Validate the committed-action envelope: authority owner, action name
/// owner, action id shape, and the target requirement.
pub fn validate_committed(action: &CommittedAction) -> Result<(), crate::error::AlarmError> {
    crate::record::validate_action_id(&action.action_id)?;
    let name_owner = action.name.rsplit_once('.').map(|(owner, _)| owner);
    if name_owner != Some(ALARM_EXTENSION_ID) {
        return Err(crate::error::AlarmError::new(
            crate::error::AlarmErrorCode::InvalidSchedule,
            format!("action name is not owned by {ALARM_EXTENSION_ID}"),
        ));
    }
    // Every stable Alarm action requires a target (schema `required`).
    if action.target.is_none() {
        return Err(crate::error::AlarmError::new(
            crate::error::AlarmErrorCode::InvalidSchedule,
            "alarm actions require a target Module",
        ));
    }
    Ok(())
}

/// Parse the arguments value into the typed contract for `name`.
pub fn parse_command(action: &CommittedAction) -> Result<ActionCommand, crate::error::AlarmError> {
    fn parse<T: serde::de::DeserializeOwned>(
        value: &serde_json::Value,
    ) -> Result<T, crate::error::AlarmError> {
        serde_json::from_value(value.clone()).map_err(|e| {
            let mut details = serde_json::Map::new();
            details.insert(
                "detail".to_string(),
                serde_json::Value::String(e.to_string()),
            );
            crate::error::AlarmError::with_details(
                crate::error::AlarmErrorCode::InvalidSchedule,
                "action arguments failed contract validation",
                details,
            )
        })
    }
    let arguments = &action.arguments;
    Ok(match action.name.as_str() {
        ALARM_CREATE_ACTION => ActionCommand::Create(parse(arguments)?),
        ALARM_LIST_ACTION => ActionCommand::List(parse(arguments)?),
        ALARM_GET_ACTION => ActionCommand::Get(parse(arguments)?),
        ALARM_UPDATE_ACTION => ActionCommand::Update(parse(arguments)?),
        ALARM_DELETE_ACTION => ActionCommand::Delete(parse(arguments)?),
        ALARM_SNOOZE_ACTION => ActionCommand::Snooze(parse(arguments)?),
        ALARM_ACKNOWLEDGE_ACTION => ActionCommand::Acknowledge(parse(arguments)?),
        _ => {
            return Err(crate::error::AlarmError::new(
                crate::error::AlarmErrorCode::InvalidSchedule,
                format!("unknown alarm action {}", action.name),
            ));
        }
    })
}
