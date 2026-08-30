//! WP-014 Alarm conformance: deterministic scheduler over durable SQLite
//! with an injected virtual clock and fixed tzdb fixtures.
//!
//! First-artifact boundary: one alarm created under injected virtual time and
//! the `America/New_York-2025a` rules fixture, the store/scheduler closed
//! and reopened, and the exact same next-occurrence timestamp and canonical
//! occurrence identity proven under the same virtual inputs.

use dolly_alarm::action::{ActionTarget, CommittedAction};
use dolly_alarm::clock::FixedClock;
use dolly_alarm::parse_utc_timestamp_us;
use dolly_alarm::record::FrozenAlarmConfig;
use dolly_alarm::scheduler::Scheduler;
use dolly_alarm::tzdb::{FixtureZoneRulesProvider, ZoneRulesProvider};
use std::path::Path;

/// 2025-11-02T05:30:00Z — inside the America/New_York 2025a autumn fold
/// (06:00Z transition), on a Sunday.
const T0_US: i64 = 1_762_061_400_000_000; // 2025-11-02T05:30:00Z

fn uuid_v7(seed: u64) -> String {
    // Valid UUIDv7 (version nibble 7, variant nibble a/b).
    format!("0198ab31-6c44-7e8a-b2bb-{seed:012}")
}

fn create_action(action_id: &str) -> CommittedAction {
    CommittedAction {
        action_id: action_id.to_string(),
        name: "org.dolly.alarm.create".to_string(),
        arguments: serde_json::json!({
            "title": "Daily test alarm",
            "schedule": {
                "kind": "cron_v1",
                "expression": "30 9 * * 1-5",
                "timezone": "America/New_York"
            },
            "delivery": { "mode": "once" },
            "enabled": true
        }),
        target: Some(ActionTarget {
            module_id: "mod-alarm-a".to_string(),
        }),
        correlation_id: None,
        idempotency_key: None,
    }
}

fn config() -> FrozenAlarmConfig {
    let mut config = FrozenAlarmConfig::default();
    config.tzdb_revision = "2025a".to_string();
    config
}

fn open_scheduler(path: &Path, now_us: i64) -> Scheduler {
    let clock = Box::new(FixedClock::new(now_us));
    let zones = Box::new(FixtureZoneRulesProvider::new("2025a"));
    Scheduler::open(path, clock, zones, config()).expect("open scheduler")
}

#[test]
fn first_artifact_create_then_restart_same_next_and_identity() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("alarm.sqlite3");
    let action_id = uuid_v7(1);
    let action = create_action(&action_id);

    // First scheduler: create one alarm under the injected virtual clock.
    let mut first = open_scheduler(&db_path, T0_US);
    let result = first.apply(&action).expect("apply create");
    let record = &result["record"];
    assert_eq!(record["title"], "Daily test alarm");
    assert_eq!(record["revision"], 1);
    assert_eq!(record["tzdb_revision"], "2025a");
    let first_next = record["next_occurrence"]
        .as_str()
        .expect("next_occurrence")
        .to_string();
    // Monday 2025-11-03 09:30 America/New_York (EST) = 14:30Z.
    assert_eq!(first_next, "2025-11-03T14:30:00.000000Z");

    let alarm_id = record["alarm_id"].as_str().unwrap().to_string();
    let (first_us, first_occurrence_id, _) = first
        .store()
        .earliest_due()
        .expect("earliest due")
        .expect("one due occurrence");
    assert!(first_occurrence_id.starts_with("sha256:"));
    assert_eq!(first_occurrence_id.len(), 7 + 64);
    assert_eq!(
        first_us,
        parse_utc_timestamp_us(&first_next, "next").expect("parse")
    );

    // Reopen the durable store and scheduler from the same file with the same
    // virtual clock, tzdb revision, and frozen config.
    drop(first);
    let mut second = open_scheduler(&db_path, T0_US);
    let replay = second.apply(&action).expect("replay create is idempotent");
    let replay_record = &replay["record"];
    assert_eq!(
        replay_record["next_occurrence"].as_str().unwrap(),
        first_next
    );
    assert_eq!(replay_record["alarm_id"].as_str().unwrap(), alarm_id);

    let (second_us, second_occurrence_id, second_alarm_id) = second
        .store()
        .earliest_due()
        .expect("earliest due")
        .expect("one due occurrence");
    assert_eq!(second_us, first_us, "same next occurrence instant");
    assert_eq!(
        second_occurrence_id, first_occurrence_id,
        "stable occurrence identity"
    );
    assert_eq!(second_alarm_id, alarm_id, "stable alarm identity");

    // The wakeup premise derives from the same durable state.
    let premise = second.next_wakeup().expect("wakeup").expect("premise");
    assert_eq!(premise.at_us, T0_US.max(first_us));
    assert!(premise.key.ends_with(&first_occurrence_id));

    // The origin date is inside the 2025-11-02 fold (fall back), proving the
    // tzdb fixture resolved the fold correctly for the local-date calendar.
    let zone = FixtureZoneRulesProvider::new("2025a")
        .zone("America/New_York-2025a")
        .expect("fixture");
    assert_eq!(zone.offset_minutes_at(T0_US), -240); // EDT before 06:00Z
    let _ = alarm_id;
}

#[test]
fn first_artifact_occurrence_id_is_deterministic_across_schedulers() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("alarm.sqlite3");
    let action_id = uuid_v7(2);
    let action = create_action(&action_id);

    let mut first = open_scheduler(&db_path, T0_US);
    let created = first.apply(&action).expect("create");
    let alarm_id = created["record"]["alarm_id"].as_str().unwrap().to_string();
    let (_, occ_a, _) = first.store().earliest_due().expect("due").expect("due");

    let clock = FixedClock::new(T0_US);
    let _ = clock; // same virtual instant for both schedulers

    // A fresh scheduler on the same file computes the same canonical id from
    // the durable row set.
    let mut second = open_scheduler(&db_path, T0_US);
    let _ = second.apply(&create_action(&action_id)); // replay path
    let (_, occ_b, _) = second.store().earliest_due().expect("due").expect("due");
    assert_eq!(occ_a, occ_b);

    // Cross-check against the pure identity rule from the spec section 4.
    let expected = dolly_alarm::occurrence::occurrence_id(
        &alarm_id,
        1,
        parse_utc_timestamp_us("2025-11-03T14:30:00.000000Z", "next").unwrap(),
        0,
    );
    assert_eq!(occ_a, expected);
}

#[test]
fn first_artifact_wakeup_never_creates_action_authority() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("alarm.sqlite3");
    let scheduler = open_scheduler(&db_path, T0_US);
    let premise = scheduler.next_wakeup().expect("wakeup");
    assert!(premise.is_none(), "no alarms yet means no wakeup premise");
    // Applying no action leaves no durable state behind.
    assert_eq!(scheduler.store().count_active_alarms().expect("count"), 0);
}
