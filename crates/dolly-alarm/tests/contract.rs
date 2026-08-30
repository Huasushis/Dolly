//! WP-014 Alarm contract suite: deterministic occurrence rules, the full
//! claim/complete/release lifecycle, DST gap/fold policies, misfire
//! partition, competing claims, crash failpoints, recovery, and repeat
//! races. All runs use an injected virtual clock, fixed tzdb fixtures, and
//! real SQLite. No sleeps, no wall clock, no network.

use dolly_alarm::action::{ActionTarget, CommittedAction};
use dolly_alarm::clock::{Clock, SharedFixedClock};
use dolly_alarm::error::AlarmErrorCode;
use dolly_alarm::failpoint::{Failpoint, FailpointBoundary};
use dolly_alarm::occurrence::{DstFoldPolicy, DstGapPolicy, evaluate_cron_day};
use dolly_alarm::parse_utc_timestamp_us;
use dolly_alarm::record::FrozenAlarmConfig;
use dolly_alarm::scheduler::{Outcome, Scheduler};
use dolly_alarm::store::OccurrenceState;
use dolly_alarm::tzdb::{FixtureZoneRulesProvider, ZoneRulesProvider};
use std::path::Path;
use std::sync::Arc;

const ZONE: &str = "America/New_York-2025a";

fn uuid_v7(seed: u64) -> String {
    format!("0198ab31-6c44-7e8a-b2bb-{seed:012}")
}

fn cfg() -> FrozenAlarmConfig {
    FrozenAlarmConfig {
        revision: "config-v1".to_string(),
        authority: dolly_alarm::ALARM_EXTENSION_ID.to_string(),
        default_timezone: "America/New_York".to_string(),
        default_misfire_policy: dolly_alarm::record::MisfirePolicy::Skip,
        default_dst_gap_policy: DstGapPolicy::ShiftByGap,
        default_dst_fold_policy: DstFoldPolicy::Earlier,
        tzdb_revision: "2025a".to_string(),
        max_alarms: 64,
        max_catch_up: 3,
        min_repeat_interval_seconds: 1,
        wakeup_horizon_seconds: 30 * 86_400,
        misfire_grace_seconds: 300,
        misfire_scan_seconds: 30 * 86_400,
        retention_seconds: 365 * 86_400,
        lease_seconds: 300,
    }
}

fn provider() -> FixtureZoneRulesProvider {
    FixtureZoneRulesProvider::new("2025a")
}

/// Open with an advanceable shared virtual clock; the test keeps a clone to
/// drive time deterministically.
fn open_shared(path: &Path, now_us: i64) -> (Scheduler, SharedFixedClock) {
    let clock = SharedFixedClock::new(now_us);
    let handle = clock.clone();
    let sched = Scheduler::open(path, Box::new(clock), Box::new(provider()), cfg())
        .expect("open scheduler");
    (sched, handle)
}

fn make_action(action_id: &str, name: &str, arguments: serde_json::Value) -> CommittedAction {
    CommittedAction {
        action_id: action_id.to_string(),
        name: name.to_string(),
        arguments,
        target: Some(ActionTarget {
            module_id: "mod-contract".to_string(),
        }),
        correlation_id: None,
        idempotency_key: None,
    }
}

fn create_args(schedule: serde_json::Value, delivery: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "title": "Contract alarm",
        "schedule": schedule,
        "delivery": delivery,
        "enabled": true,
    })
}

fn create_once(scheduler: &mut Scheduler, action_id: u64, at: &str) -> String {
    let action = make_action(
        &uuid_v7(action_id),
        "org.dolly.alarm.create",
        create_args(
            serde_json::json!({"kind": "once", "at": at}),
            serde_json::json!({"mode": "once"}),
        ),
    );
    let result = scheduler.apply(&action).expect("create");
    result["record"]["alarm_id"].as_str().unwrap().to_string()
}

fn fold_zone() -> Arc<dolly_alarm::FixedZone> {
    provider().zone(ZONE).expect("fixture zone")
}

// ---------------------------------------------------------------------------
// Deterministic occurrence rules (REQ-ALARM-001)
// ---------------------------------------------------------------------------

#[test]
fn dst_fold_policies_earlier_later_both() {
    let zone = fold_zone();
    let expression = "30 1 2 11 *"; // 01:30 on 2025-11-02 (fall-back fold)
    let day = "2025-11-02";

    let earlier = evaluate_cron_day(
        expression,
        &zone,
        DstGapPolicy::ShiftByGap,
        DstFoldPolicy::Earlier,
        day,
        1440,
    )
    .expect("earlier");
    assert_eq!(earlier.len(), 1);
    assert_eq!(
        earlier[0].scheduled_us,
        parse_utc_timestamp_us("2025-11-02T05:30:00.000000Z", "t").unwrap()
    );
    assert_eq!(earlier[0].fold_ordinal, 0);

    let later = evaluate_cron_day(
        expression,
        &zone,
        DstGapPolicy::ShiftByGap,
        DstFoldPolicy::Later,
        day,
        1440,
    )
    .expect("later");
    assert_eq!(later.len(), 1);
    assert_eq!(
        later[0].scheduled_us,
        parse_utc_timestamp_us("2025-11-02T06:30:00.000000Z", "t").unwrap()
    );
    assert_eq!(later[0].fold_ordinal, 1);

    let both = evaluate_cron_day(
        expression,
        &zone,
        DstGapPolicy::ShiftByGap,
        DstFoldPolicy::Both,
        day,
        1440,
    )
    .expect("both");
    assert_eq!(both.len(), 2);
    assert_eq!(
        both[0].scheduled_us,
        parse_utc_timestamp_us("2025-11-02T05:30:00.000000Z", "t").unwrap()
    );
    assert_eq!(both[0].fold_ordinal, 0);
    assert_eq!(
        both[1].scheduled_us,
        parse_utc_timestamp_us("2025-11-02T06:30:00.000000Z", "t").unwrap()
    );
    assert_eq!(both[1].fold_ordinal, 1);
}

#[test]
fn dst_gap_policies_shift_and_skip() {
    let zone = fold_zone();
    let expression = "30 2 9 3 *"; // 02:30 on 2025-03-09 (spring-forward gap)
    let day = "2025-03-09";

    let shifted = evaluate_cron_day(
        expression,
        &zone,
        DstGapPolicy::ShiftByGap,
        DstFoldPolicy::Earlier,
        day,
        1440,
    )
    .expect("shift");
    assert_eq!(shifted.len(), 1);
    assert_eq!(
        shifted[0].scheduled_us,
        parse_utc_timestamp_us("2025-03-09T07:30:00.000000Z", "t").unwrap()
    );
    assert_eq!(shifted[0].fold_ordinal, 0);

    let skipped = evaluate_cron_day(
        expression,
        &zone,
        DstGapPolicy::Skip,
        DstFoldPolicy::Earlier,
        day,
        1440,
    )
    .expect("skip");
    assert!(skipped.is_empty());
}

fn day_count(expression: &str, date: &str) -> usize {
    let zone = fold_zone();
    evaluate_cron_day(
        expression,
        &zone,
        DstGapPolicy::ShiftByGap,
        DstFoldPolicy::Earlier,
        date,
        1440,
    )
    .expect("day evaluation")
    .len()
}

#[test]
fn cron_field_rules() {
    // Leap day: 2024-02-29 exists and matches; 2025 is not a leap year.
    assert_eq!(day_count("0 0 29 2 *", "2024-02-29"), 1);
    assert_eq!(day_count("0 0 30 2 *", "2024-02-29"), 0);
    // Month end: day 31 matches only 31-day months.
    assert_eq!(day_count("0 0 31 * *", "2025-01-31"), 1);
    assert_eq!(day_count("0 0 31 * *", "2025-04-30"), 0);
    // Steps and ranges.
    assert_eq!(day_count("*/15 * * * *", "2025-11-01"), 96);
    assert_eq!(day_count("0-30/10 * * * *", "2025-11-01"), 96);
    // DOM/DOW Vixie OR: 2025-11-01 is a Saturday; both restricted => either.
    assert_eq!(day_count("0 0 1 * 0", "2025-11-01"), 1);
    // 2025-11-02 is a Sunday.
    assert_eq!(day_count("0 0 1 * 0", "2025-11-02"), 1);
    // DOW-only restriction: Fridays of November 2025 are 7/14/21/28.
    assert_eq!(day_count("0 0 * * 5", "2025-11-14"), 1);
    assert_eq!(day_count("0 0 * * 5", "2025-11-15"), 0);
}

#[test]
fn cron_validation_rejects_bad_expressions() {
    let zone = fold_zone();
    let run = |expression: &str| {
        evaluate_cron_day(
            expression,
            &zone,
            DstGapPolicy::ShiftByGap,
            DstFoldPolicy::Earlier,
            "2025-11-01",
            1440,
        )
    };
    for expression in [
        "0 0 1 1 * 0",   // six fields
        "0 0 1 1",       // four fields
        "0 60 * * *",    // minute 60
        "* * * * 7",     // DOW 7
        "*/0 * * * *",   // zero step
        "0 5-1 * * *",   // inverted range
        "0 L * * *",     // L forbidden
        "0 0 1 1 * JAN", // names forbidden
    ] {
        match run(expression) {
            Err(e) => assert_eq!(e.code, AlarmErrorCode::InvalidSchedule, "{expression}"),
            Ok(_) => panic!("expected rejection for {expression:?}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Claim / complete / release lifecycle on a once schedule
// ---------------------------------------------------------------------------

#[test]
fn once_lifecycle_claim_complete_keep_same_identity() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("life.sqlite3");
    let at = "2025-11-10T12:00:00.000000Z";
    let at_us = parse_utc_timestamp_us(at, "at").expect("parse");
    let (mut sched, clock) = open_shared(&db, at_us - 3_600_000_000); // one hour before

    let alarm_id = create_once(&mut sched, 10, at);
    let (due_us, occ_id, _) = sched.store().earliest_due().expect("due").expect("due");
    assert_eq!(due_us, at_us);

    // Claim at the scheduled instant (+2s, within grace).
    clock.set(at_us + 2_000_000);
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    let claims = sched.claim_due("worker-a").expect("claim");
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].occurrence_id, occ_id);
    let claimed = sched
        .store()
        .get_occurrence(&occ_id)
        .expect("row")
        .expect("occ");
    assert_eq!(claimed.state, OccurrenceState::Claimed);

    // A competing worker claims nothing more.
    let again = sched.claim_due("worker-b").expect("claim");
    assert!(again.is_empty());

    // Complete: typed output premise, durable result, no further wakeup.
    let event = sched.complete(&claims[0]).expect("complete");
    assert_eq!(event.occurrence_id, occ_id);
    assert_eq!(event.scheduled_at, at);
    assert_eq!(event.fired_at, "2025-11-10T12:00:02.000000Z");
    assert_eq!(event.lateness_us, 2_000_000);
    assert!(!event.ack_required);
    assert!(
        sched.next_wakeup().expect("wakeup").is_none(),
        "once alarm finished"
    );

    let fired = sched
        .store()
        .get_occurrence(&occ_id)
        .expect("row")
        .expect("occ");
    assert_eq!(fired.state, OccurrenceState::Fired);
    assert!(fired.result_json.as_deref().unwrap().contains(&occ_id));
    assert_eq!(sched.store().count_occurrences(None).expect("count"), 1);
    let _ = alarm_id;
}

#[test]
fn release_returns_to_due_with_same_identity() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("release.sqlite3");
    let at_us = parse_utc_timestamp_us("2025-11-10T12:00:00.000000Z", "at").unwrap();
    let (mut sched, clock) = open_shared(&db, at_us - 1_000_000);
    create_once(&mut sched, 11, "2025-11-10T12:00:00.000000Z");
    let (_, occ_id, _) = sched.store().earliest_due().expect("due").expect("due");

    clock.set(at_us);
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    let claims = sched.claim_due("worker-a").expect("claim");
    assert_eq!(claims.len(), 1);
    // Host output not committed: release, then retry the same identity.
    assert!(sched.release(&claims[0]).expect("release"));
    assert!(
        !sched
            .release(&claims[0])
            .expect("stale release cannot release twice")
    );

    let claims2 = sched.claim_due("worker-a").expect("claim");
    assert_eq!(claims2.len(), 1);
    assert_eq!(
        claims2[0].occurrence_id, occ_id,
        "retry keeps the same occurrence"
    );
    let event = sched.complete(&claims2[0]).expect("complete");
    assert_eq!(event.occurrence_id, occ_id);
    assert_eq!(
        sched.store().count_occurrences(None).expect("count"),
        1,
        "no duplicate occurrence across the retry"
    );
}

// ---------------------------------------------------------------------------
// Simultaneous once alarms share one wakeup but keep independent identity
// ---------------------------------------------------------------------------

#[test]
fn simultaneous_due_events_are_claimed_in_scheduled_order() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("sim.sqlite3");
    let at = "2025-11-11T08:00:00.000000Z";
    let at_us = parse_utc_timestamp_us(at, "at").unwrap();
    let (mut sched, clock) = open_shared(&db, at_us - 3600_000_000);
    create_once(&mut sched, 20, at);
    create_once(&mut sched, 21, at);
    create_once(&mut sched, 22, at);

    // All three become due at the scheduled instant.
    clock.set(at_us + 2_000_000);
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    let claims = sched.claim_due("worker").expect("claim all");
    assert_eq!(claims.len(), 3);
    assert!(claims[0].scheduled_us <= claims[1].scheduled_us);
    assert!(claims[1].scheduled_us <= claims[2].scheduled_us);
    // Distinct identities for simultaneous events.
    let mut ids: Vec<&str> = claims.iter().map(|c| c.occurrence_id.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), 3);
    // Completing all three consumes the wakeup cursor.
    for claim in claims {
        sched.complete(&claim).expect("complete");
    }
    assert!(sched.next_wakeup().expect("wakeup").is_none());
}

// ---------------------------------------------------------------------------
// Fold "both" manifests as two distinct occurrences through the lifecycle
// ---------------------------------------------------------------------------

#[test]
fn fold_both_materializes_two_distinct_occurrences() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("fold.sqlite3");
    // Create the alarm before the fold at 05:30 (earlier instant of the fold).
    let fold_earlier = parse_utc_timestamp_us("2025-11-02T05:30:00.000000Z", "t").unwrap();
    let (mut sched, clock) = open_shared(&db, fold_earlier - 60_000_000_000);
    let action = make_action(
        &uuid_v7(30),
        "org.dolly.alarm.create",
        serde_json::json!({
            "title": "Fold both",
            "schedule": {"kind": "cron_v1", "expression": "30 1 2 11 *", "timezone": "America/New_York"},
            "delivery": {"mode": "once"},
            "dst_fold_policy": "both",
            "enabled": true,
        }),
    );
    sched.apply(&action).expect("create");
    let (first_us, first_id, _) = sched.store().earliest_due().expect("due").expect("due");
    assert_eq!(first_us, fold_earlier);

    // Fire the earlier fold instant, then the later one.
    clock.set(fold_earlier + 1_000_000);
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    let c1 = sched.claim_due("worker").expect("claim");
    assert_eq!(c1.len(), 1);
    assert_eq!(c1[0].occurrence_id, first_id);
    let e1 = sched.complete(&c1[0]).expect("complete");

    let (second_us, second_id, _) = sched.store().earliest_due().expect("due").expect("due");
    assert_eq!(
        second_us,
        parse_utc_timestamp_us("2025-11-02T06:30:00.000000Z", "t").unwrap(),
        "later fold instant becomes the next occurrence"
    );
    assert_ne!(second_id, first_id);
    // The later fold instant becomes due at its own instant.
    clock.set(second_us + 1_000_000);
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    let c2 = sched.claim_due("worker").expect("claim");
    let e2 = sched.complete(&c2[0]).expect("complete");
    assert_eq!(e1.scheduled_at, "2025-11-02T05:30:00.000000Z");
    assert_eq!(e2.scheduled_at, "2025-11-02T06:30:00.000000Z");
    // The annual schedule continues: the next wakeup is next year's fold, a
    // fresh occurrence identity.
    let next = sched.next_wakeup().expect("wakeup").expect("annual next");
    assert_ne!(next.key, format!("alarm:{second_id}"));
}

// ---------------------------------------------------------------------------
// Interval schedule: anchoring and exact next arithmetic
// ---------------------------------------------------------------------------

#[test]
fn interval_schedule_next_arithmetic() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("interval.sqlite3");
    let anchor = "2025-11-01T10:00:00.000000Z";
    let anchor_us = parse_utc_timestamp_us(anchor, "a").unwrap();
    // 25 minutes after the anchor: next = anchor + 30m (not 25m).
    let (mut sched, clock) = open_shared(&db, anchor_us + 25 * 60 * 1_000_000);
    let action = make_action(
        &uuid_v7(31),
        "org.dolly.alarm.create",
        create_args(
            serde_json::json!({"kind": "interval", "every_seconds": 1800, "anchor": anchor}),
            serde_json::json!({"mode": "once"}),
        ),
    );
    let created = sched.apply(&action).expect("create");
    let next = created["record"]["next_occurrence"].as_str().unwrap();
    assert_eq!(next, "2025-11-01T10:30:00.000000Z");

    clock.set(parse_utc_timestamp_us(next, "n").unwrap());
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    let c = sched.claim_due("w").expect("claim");
    assert_eq!(c.len(), 1);
    assert_eq!(c[0].scheduled_at, next);
    sched.complete(&c[0]).expect("complete");
    // Interval continues: next = 11:00Z.
    let (next_us, _, _) = sched.store().earliest_due().expect("due").expect("due");
    assert_eq!(next_us, anchor_us + 2 * 1800 * 1_000_000);
    let premise = sched.next_wakeup().expect("wakeup").expect("premise");
    assert_eq!(premise.at_us, anchor_us + 2 * 1800 * 1_000_000);
    let _ = clock;
}
