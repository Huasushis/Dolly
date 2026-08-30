//! WP-014 Alarm contract suite: deterministic occurrence rules, the full
//! claim/complete/release lifecycle, DST gap/fold policies, misfire
//! partition, competing claims, crash failpoints, recovery, and repeat
//! races. All runs use an injected virtual clock, fixed tzdb fixtures, and
//! real SQLite. No sleeps, no wall clock, no network.

use dolly_alarm::action::{ActionTarget, CommittedAction};
use dolly_alarm::clock::SharedFixedClock;
use dolly_alarm::error::AlarmErrorCode;
use dolly_alarm::failpoint::{Failpoint, FailpointBoundary};
use dolly_alarm::occurrence::{DstFoldPolicy, DstGapPolicy, evaluate_cron_day};
use dolly_alarm::parse_utc_timestamp_us;
use dolly_alarm::record::{FrozenAlarmConfig, MisfirePolicy};
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

// ---------------------------------------------------------------------------
// Misfire policies: skip / fire_once / catch_up
// ---------------------------------------------------------------------------

fn open_cfg(
    path: &Path,
    now_us: i64,
    misfire: MisfirePolicy,
    max_catch_up: u64,
) -> (Scheduler, SharedFixedClock) {
    let clock = SharedFixedClock::new(now_us);
    let handle = clock.clone();
    let mut config = cfg();
    config.default_misfire_policy = misfire;
    config.max_catch_up = max_catch_up;
    let sched = Scheduler::open(path, Box::new(clock), Box::new(provider()), config)
        .expect("open scheduler");
    (sched, handle)
}

#[test]
fn misfire_skip_marks_old_occurrence_missed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("miss.sqlite3");
    let at = "2025-11-10T12:00:00.000000Z";
    let at_us = parse_utc_timestamp_us(at, "a").unwrap();
    let (mut sched, clock) = open_cfg(&db, at_us - 3_600_000_000, MisfirePolicy::Skip, 3);
    create_once(&mut sched, 40, at);
    let (_, occ_id, _) = sched.store().earliest_due().expect("due").expect("due");

    // One hour late: beyond the 5-minute grace.
    clock.set(at_us + 3_600_000_000);
    let report = sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    assert_eq!(report.alarms_settled, 1);
    let occ = sched
        .store()
        .get_occurrence(&occ_id)
        .expect("row")
        .expect("occ");
    assert_eq!(occ.state, OccurrenceState::Missed, "skip marks missed");
    assert_eq!(occ.missed_reason.as_deref(), Some("skip"));
    // No claimable work remains and no future occurrence exists for a once alarm.
    assert!(sched.claim_due("w").expect("claim").is_empty());
    assert!(sched.next_wakeup().expect("wakeup").is_none());
}

#[test]
fn misfire_fire_once_keeps_latest_with_original_schedule() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("fire_once.sqlite3");
    let at = "2025-11-10T12:00:00.000000Z";
    let at_us = parse_utc_timestamp_us(at, "a").unwrap();
    let (mut sched, clock) = open_cfg(&db, at_us - 1_000_000, MisfirePolicy::FireOnce, 3);
    create_once(&mut sched, 41, at);
    let (_, occ_id, _) = sched.store().earliest_due().expect("due").expect("due");

    clock.set(at_us + 3_600_000_000);
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    let claims = sched.claim_due("w").expect("claim");
    assert_eq!(
        claims.len(),
        1,
        "fire_once keeps the latest older occurrence claimable"
    );
    assert_eq!(claims[0].occurrence_id, occ_id);
    let event = sched.complete(&claims[0]).expect("complete");
    assert_eq!(event.scheduled_at, at, "original scheduled_at retained");
    assert_eq!(
        event.fired_at, "2025-11-10T13:00:00.000000Z",
        "fired_at is now"
    );
    assert_eq!(event.lateness_us, 3_600_000_000);
    let occ = sched
        .store()
        .get_occurrence(&occ_id)
        .expect("row")
        .expect("occ");
    assert_eq!(occ.state, OccurrenceState::Fired);
}

#[test]
fn misfire_fire_once_without_row_backfills_most_recent_instant() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("fire_back.sqlite3");
    // Interval schedule: the materialized row is the single next tick, but a
    // long suspension leaves many unmaterialized older instants; fire_once
    // must fire the most recent one.
    let anchor = "2025-11-01T10:00:00.000000Z";
    let anchor_us = parse_utc_timestamp_us(anchor, "a").unwrap();
    let (mut sched, clock) = open_cfg(&db, anchor_us, MisfirePolicy::FireOnce, 3);
    let action = make_action(
        &uuid_v7(42),
        "org.dolly.alarm.create",
        create_args(
            serde_json::json!({"kind": "interval", "every_seconds": 60, "anchor": anchor}),
            serde_json::json!({"mode": "once"}),
        ),
    );
    sched.apply(&action).expect("create");
    let (first_tick, already, _) = sched.store().earliest_due().expect("due").expect("due");
    assert_eq!(first_tick, anchor_us + 60 * 1_000_000);

    // Suspend for two hours: many ticks were due and unmaterialized.
    clock.set(anchor_us + 2 * 3_600_000_000);
    let report = sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    assert_eq!(report.alarms_settled, 1);

    // fire_once materializes the most recent older instant (not the stale
    // first tick), while the within-grace ticks of the last 5 minutes are
    // processed normally in scheduled order.
    let now = anchor_us + 2 * 3_600_000_000;
    let latest_older = now - 300 * 1_000_000; // most recent instant at/before grace
    let claims = sched.claim_due("w").expect("claim");
    assert_eq!(claims.len(), 6, "1 fire_once keeper + 5 within-grace ticks");
    // Scheduled order: the fire_once keeper is the oldest claimable.
    assert_eq!(
        claims[0].scheduled_us, latest_older,
        "most recent older instant fires with fire_once"
    );
    assert_eq!(
        claims[0].misfire_basis,
        Some(dolly_alarm::store::MisfireBasis::FireOnce)
    );
    assert_eq!(
        claims[5].scheduled_us, now,
        "within-grace ticks processed normally"
    );
    assert_ne!(claims[0].occurrence_id, already);
    for claim in claims {
        let event = sched.complete(&claim).expect("complete");
        assert_eq!(event.fired_at, dolly_alarm::format_utc_iso6(now));
    }
    // The future series resumes after the fired instants.
    let (next_us, _, _) = sched.store().earliest_due().expect("due").expect("due");
    assert_eq!(next_us, now + 60 * 1_000_000);
    // Older unmaterialized instants were coalesced into the bounded diagnostic.
    let diagnostics = sched
        .store()
        .misfire_diagnostics(&sched_alarm_id(&sched))
        .expect("diag");
    let fire_once_total: u64 = diagnostics
        .iter()
        .find(|(policy, _)| policy == "fire_once")
        .map(|(_, count)| *count)
        .unwrap_or(0)
        .try_into()
        .unwrap();
    assert!(
        fire_once_total >= 100,
        "bounded diagnostic records the skipped count, got {fire_once_total}"
    );
    let _ = clock;
}

fn sched_alarm_id(sched: &Scheduler) -> String {
    sched
        .store()
        .list_alarms(None)
        .expect("list")
        .first()
        .expect("alarm")
        .alarm_id
        .clone()
}

#[test]
fn misfire_catch_up_fires_up_to_cap_in_scheduled_order() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("catchup.sqlite3");
    let anchor = "2025-11-01T10:00:00.000000Z";
    let anchor_us = parse_utc_timestamp_us(anchor, "a").unwrap();
    let (mut sched, clock) = open_cfg(&db, anchor_us, MisfirePolicy::CatchUp, 3);
    let action = make_action(
        &uuid_v7(43),
        "org.dolly.alarm.create",
        create_args(
            serde_json::json!({"kind": "interval", "every_seconds": 60, "anchor": anchor}),
            serde_json::json!({"mode": "once"}),
        ),
    );
    sched.apply(&action).expect("create");
    let (first_tick, _, _) = sched.store().earliest_due().expect("due").expect("due");
    assert_eq!(first_tick, anchor_us + 60 * 1_000_000);

    let now = anchor_us + 2 * 3_600_000_000; // 2h suspension
    clock.set(now);
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");

    // catch_up keeps exactly max_catch_up most-recent older instants — in
    // scheduled order after the within-grace ticks of the last 5 minutes.
    let claims = sched.claim_due("w").expect("claim");
    assert_eq!(claims.len(), 8, "3 catch_up keepers + 5 within-grace ticks");
    assert_eq!(claims[0].scheduled_us, now - 420 * 1_000_000);
    assert_eq!(claims[2].scheduled_us, now - 300 * 1_000_000);
    assert_eq!(claims[5].scheduled_us, now - 120 * 1_000_000);
    assert_eq!(claims[7].scheduled_us, now);
    let mut fired_scheduled: Vec<i64> = Vec::new();
    for claim in claims {
        let event = sched.complete(&claim).expect("complete");
        fired_scheduled.push(event.scheduled_us);
    }
    assert_eq!(fired_scheduled.len(), 8);
    // Future series continues after the newest fired instant.
    let (next_us, _, _) = sched.store().earliest_due().expect("due").expect("due");
    assert_eq!(next_us, now + 60 * 1_000_000);
    let diagnostics = sched
        .store()
        .misfire_diagnostics(&sched_alarm_id(&sched))
        .expect("diag");
    let cap_total: u64 = diagnostics
        .iter()
        .find(|(policy, _)| policy == "catch_up_cap")
        .map(|(_, count)| *count)
        .unwrap_or(0)
        .try_into()
        .unwrap();
    assert!(cap_total >= 100, "catch_up cap diagnostic, got {cap_total}");
}

// ---------------------------------------------------------------------------
// Competing claims: exactly one holder, retry with the same identity
// ---------------------------------------------------------------------------

#[test]
fn two_workers_race_exactly_one_claim_wins() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("race.sqlite3");
    let at_us = parse_utc_timestamp_us("2025-11-20T09:00:00.000000Z", "at").unwrap();

    // Set up the alarm first.
    let (mut sched, clock) = open_shared(&db_path, at_us - 3_600_000_000);
    create_once(&mut sched, 50, "2025-11-20T09:00:00.000000Z");
    let (_, occ_id, _) = sched.store().earliest_due().expect("due").expect("due");
    clock.set(at_us);
    drop(sched);

    // Two schedulers on separate connections race at the same virtual instant.
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let mut handles = Vec::new();
    for worker in ["worker-a", "worker-b"] {
        let barrier = barrier.clone();
        let db_path = db_path.clone();
        let clock = clock.clone();
        let worker = worker.to_string();
        handles.push(std::thread::spawn(move || {
            let mut sched = Scheduler::open(&db_path, Box::new(clock), Box::new(provider()), cfg())
                .expect("open worker");
            barrier.wait();
            let claims = sched.claim_due(&worker).expect("claim");
            claims
        }));
    }
    barrier.wait();
    let mut won: Vec<dolly_alarm::Claim> = Vec::new();
    for handle in handles {
        won.extend(handle.join().expect("worker thread"));
    }
    assert_eq!(
        won.len(),
        1,
        "competing claims settle on exactly one holder"
    );
    assert_eq!(won[0].occurrence_id, occ_id);
    // The loser still sees exactly one occurrence row: no duplicate firing.
    assert_eq!(
        dolly_alarm::AlarmStore::open(&db_path, 5000)
            .expect("open")
            .count_occurrences(None)
            .expect("count"),
        1
    );
}

// ---------------------------------------------------------------------------
// Crash failpoints: atomic effect boundaries
// ---------------------------------------------------------------------------

#[test]
fn failpoint_before_create_leaves_no_durable_effect() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("fp.sqlite3");
    let at_us = parse_utc_timestamp_us("2025-11-20T09:00:00.000000Z", "at").unwrap();
    let (mut sched, _clock) = open_shared(&db, at_us - 3_600_000_000);
    sched.set_failpoint(Some(Failpoint::new(FailpointBoundary::BeforeCreate)));
    let action = make_action(
        &uuid_v7(60),
        "org.dolly.alarm.create",
        create_args(
            serde_json::json!({"kind": "once", "at": "2025-11-20T09:00:00.000000Z"}),
            serde_json::json!({"mode": "once"}),
        ),
    );
    let err = sched.apply(&action).expect_err("failpoint aborts create");
    assert_eq!(err.code, AlarmErrorCode::Failpoint);
    assert_eq!(sched.store().count_active_alarms().expect("count"), 0);
    assert_eq!(sched.store().count_occurrences(None).expect("count"), 0);
    assert!(sched.next_wakeup().expect("wakeup").is_none());
    // The same committed action applies cleanly once the failpoint is gone.
    sched.set_failpoint(None);
    let result = sched.apply(&action).expect("create after disarm");
    assert_eq!(result["record"]["alarm_id"].as_str().unwrap().len(), 36);
}

fn once_action(id: u64, at: &str) -> CommittedAction {
    make_action(
        &uuid_v7(600 + id),
        "org.dolly.alarm.create",
        create_args(
            serde_json::json!({"kind": "once", "at": at}),
            serde_json::json!({"mode": "once"}),
        ),
    )
}

#[test]
fn failpoint_matrix_aborts_every_mutation_effect() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("fpm.sqlite3");
    let at = "2025-11-21T09:00:00.000000Z";
    let at_us = parse_utc_timestamp_us(at, "a").unwrap();
    let (mut sched, clock) = open_shared(&db, at_us - 3_600_000_000);

    // Create an alarm so mutation targets exist.
    let created = sched.apply(&once_action(1, at)).expect("create");
    let alarm_id = created["record"]["alarm_id"].as_str().unwrap().to_string();
    let (_, occ_id, _) = sched.store().earliest_due().expect("due").expect("due");

    let before_count = sched.store().count_occurrences(None).expect("count");

    // Update failpoint.
    sched.set_failpoint(Some(Failpoint::new(FailpointBoundary::BeforeUpdate)));
    let update = make_action(
        &uuid_v7(700),
        "org.dolly.alarm.update",
        serde_json::json!({
            "alarm_id": alarm_id,
            "expected_revision": 1,
            "replacement": {
                "title": "Changed",
                "schedule": {"kind": "once", "at": "2025-11-21T10:00:00.000000Z"},
                "delivery": {"mode": "once"},
                "enabled": true
            }
        }),
    );
    let err = sched.apply(&update).expect_err("update aborted");
    assert_eq!(err.code, AlarmErrorCode::Failpoint);
    sched.set_failpoint(None);

    // Acknowledge failpoint against a due occurrence.
    sched.set_failpoint(Some(Failpoint::new(FailpointBoundary::BeforeAcknowledge)));
    let ack = make_action(
        &uuid_v7(701),
        "org.dolly.alarm.acknowledge",
        serde_json::json!({"alarm_id": alarm_id, "occurrence_id": occ_id, "expected_revision": 1}),
    );
    let err = sched.apply(&ack).expect_err("ack aborted");
    assert_eq!(err.code, AlarmErrorCode::Failpoint);
    sched.set_failpoint(None);

    // Claim failpoint.
    clock.set(at_us + 1_000_000);
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    sched.set_failpoint(Some(Failpoint::new(FailpointBoundary::BeforeClaim)));
    let err = sched.claim_due("w").expect_err("claim aborted");
    assert_eq!(err.code, AlarmErrorCode::Failpoint);
    sched.set_failpoint(None);

    // Complete failpoint with a real claim.
    let claims = sched.claim_due("w").expect("claim");
    assert_eq!(claims.len(), 1);
    sched.set_failpoint(Some(Failpoint::new(FailpointBoundary::BeforeComplete)));
    let err = sched.complete(&claims[0]).expect_err("complete aborted");
    assert_eq!(err.code, AlarmErrorCode::Failpoint);
    sched.set_failpoint(None);

    // Every abort left the durable state unchanged (the claim still held).
    let occ = sched
        .store()
        .get_occurrence(&occ_id)
        .expect("row")
        .expect("occ");
    assert_eq!(occ.state, OccurrenceState::Claimed);
    assert_eq!(
        sched.store().count_occurrences(None).expect("count"),
        before_count
    );
    assert_eq!(
        sched
            .store()
            .get_alarm(&alarm_id)
            .expect("alarm")
            .expect("row")
            .revision,
        1,
        "update failpoint never bumped the revision"
    );
}

// ---------------------------------------------------------------------------
// Crash after claim: expired-lease reconciliation through the outcome provider
// ---------------------------------------------------------------------------

#[test]
fn expired_claim_reconcile_applied_not_applied_unknown() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("crash.sqlite3");
    let at_us = parse_utc_timestamp_us("2025-11-22T09:00:00.000000Z", "at").unwrap();
    // FireOnce so an expired-claim retry is claimable after the misfire pass.
    let (mut sched, clock) = open_cfg(&db, at_us - 1_000_000, MisfirePolicy::FireOnce, 3);
    let _alarm_id = create_once(&mut sched, 80, "2025-11-22T09:00:00.000000Z");
    let (_, occ_id, _) = sched.store().earliest_due().expect("due").expect("due");

    clock.set(at_us);
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    let claims = sched.claim_due("worker").expect("claim");
    assert_eq!(claims.len(), 1);
    // Crash after claim: no completion. The lease lapses.
    clock.set(at_us + 301 * 1_000_000);
    let report = sched
        .settle(&|occ, _| {
            if occ == occ_id {
                Outcome::Applied
            } else {
                Outcome::Unknown
            }
        })
        .expect("settle");
    assert_eq!(report.reconciled_applied.len(), 1);
    let occ = sched
        .store()
        .get_occurrence(&occ_id)
        .expect("row")
        .expect("occ");
    assert_eq!(
        occ.state,
        OccurrenceState::Fired,
        "runtime-applied output is reconciled to FIRED"
    );
    assert_eq!(
        sched.store().count_occurrences(None).expect("count"),
        1,
        "no duplicate occurrence after reconcile"
    );

    // NotApplied reopens with the same identity; fire_once keeps it claimable
    // and it completes with its original schedule and a fresh now.
    let alarm_id2 = create_once(&mut sched, 81, "2025-11-24T09:00:00.000000Z");
    let at2_us = parse_utc_timestamp_us("2025-11-24T09:00:00.000000Z", "a").unwrap();
    clock.set(at2_us - 1_000_000);
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    clock.set(at2_us);
    let claims2 = sched.claim_due("worker").expect("claim");
    assert_eq!(claims2.len(), 1);
    clock.set(at2_us + 301 * 1_000_000);
    let report2 = sched.settle(&|_, _| Outcome::NotApplied).expect("settle");
    assert_eq!(report2.reconciled_reopened.len(), 1);
    let retried = sched.claim_due("worker").expect("claim");
    assert_eq!(retried.len(), 1);
    assert_eq!(
        retried[0].occurrence_id, claims2[0].occurrence_id,
        "retry keeps the same identity"
    );
    let event = sched.complete(&retried[0]).expect("complete");
    assert_eq!(event.scheduled_at, "2025-11-24T09:00:00.000000Z");
    assert_eq!(event.fired_at, "2025-11-24T09:05:01.000000Z");
    let _ = alarm_id2;

    // Unknown leaves the claim untouched for the runtime to resolve.
    let alarm_id3 = create_once(&mut sched, 82, "2025-11-27T09:00:00.000000Z");
    let at3_us = parse_utc_timestamp_us("2025-11-27T09:00:00.000000Z", "a").unwrap();
    clock.set(at3_us - 1_000_000);
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    clock.set(at3_us);
    let claims3 = sched.claim_due("worker").expect("claim");
    assert_eq!(claims3.len(), 1);
    clock.set(at3_us + 301 * 1_000_000);
    let report3 = sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    assert_eq!(report3.reconciled_unknown.len(), 1);
    let held = sched
        .store()
        .get_occurrence(&claims3[0].occurrence_id)
        .expect("row")
        .expect("occ");
    assert_eq!(
        held.state,
        OccurrenceState::Claimed,
        "Unknown outcome leaves the claim untouched"
    );
    let _ = alarm_id3;
    let _ = clock;
}

// ---------------------------------------------------------------------------
// Update: optimistic revision, suppressed old-revision claims, preserved history
// ---------------------------------------------------------------------------

#[test]
fn update_revision_conflict_and_clean_cutover() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("update.sqlite3");
    let at_us = parse_utc_timestamp_us("2025-11-25T09:00:00.000000Z", "at").unwrap();
    let (mut sched, clock) = open_shared(&db, at_us - 3_600_000_000);
    let created = sched
        .apply(&once_action(90, "2025-11-25T09:00:00.000000Z"))
        .expect("create");
    let alarm_id = created["record"]["alarm_id"].as_str().unwrap().to_string();
    let (_, old_occ, _) = sched.store().earliest_due().expect("due").expect("due");

    // Stale expected revision => REVISION_CONFLICT, no state change.
    let stale = make_action(
        &uuid_v7(901),
        "org.dolly.alarm.update",
        serde_json::json!({
            "alarm_id": alarm_id,
            "expected_revision": 7,
            "replacement": {
                "title": "X",
                "schedule": {"kind": "once", "at": "2025-11-25T10:00:00.000000Z"},
                "delivery": {"mode": "once"},
                "enabled": true
            }
        }),
    );
    let err = sched.apply(&stale).expect_err("revision conflict");
    assert_eq!(err.code, AlarmErrorCode::RevisionConflict);
    assert_eq!(
        sched
            .store()
            .get_alarm(&alarm_id)
            .expect("alarm")
            .expect("row")
            .revision,
        1
    );

    // Correct update bumps the revision and moves the schedule.
    let update = make_action(
        &uuid_v7(902),
        "org.dolly.alarm.update",
        serde_json::json!({
            "alarm_id": alarm_id,
            "expected_revision": 1,
            "replacement": {
                "title": "Moved",
                "schedule": {"kind": "once", "at": "2025-11-25T11:00:00.000000Z"},
                "delivery": {"mode": "once"},
                "enabled": true
            }
        }),
    );
    let result = sched.apply(&update).expect("update");
    assert_eq!(result["record"]["revision"], 2);
    assert_eq!(result["record"]["title"], "Moved");
    assert_eq!(
        result["record"]["next_occurrence"],
        serde_json::Value::String("2025-11-25T11:00:00.000000Z".into())
    );

    // Future claims for the old revision are disabled; history is preserved.
    let old = sched
        .store()
        .get_occurrence(&old_occ)
        .expect("row")
        .expect("old occ");
    assert_eq!(
        old.state,
        OccurrenceState::Suppressed,
        "old-revision DUE disabled"
    );
    assert_eq!(
        sched.store().count_occurrences(None).expect("count"),
        2,
        "history preserved"
    );

    clock.set(parse_utc_timestamp_us("2025-11-25T11:00:00.000000Z", "n").unwrap());
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    let claims = sched.claim_due("w").expect("claim");
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].scheduled_at, "2025-11-25T11:00:00.000000Z");
    assert_eq!(claims[0].alarm_revision, 2);
}

// ---------------------------------------------------------------------------
// Delete: tombstone, disabled claims, preserved history
// ---------------------------------------------------------------------------

#[test]
fn delete_tombstone_preserves_history_and_rejects_future_claims() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("delete.sqlite3");
    let at_us = parse_utc_timestamp_us("2025-11-26T09:00:00.000000Z", "at").unwrap();
    let (mut sched, clock) = open_shared(&db, at_us - 3_600_000_000);
    let created = sched
        .apply(&once_action(91, "2025-11-26T09:00:00.000000Z"))
        .expect("create");
    let alarm_id = created["record"]["alarm_id"].as_str().unwrap().to_string();
    let (_, occ_id, _) = sched.store().earliest_due().expect("due").expect("due");

    let del = make_action(
        &uuid_v7(903),
        "org.dolly.alarm.delete",
        serde_json::json!({"alarm_id": alarm_id, "expected_revision": 1}),
    );
    let result = sched.apply(&del).expect("delete");
    assert_eq!(result["deleted_alarm_revision"], 1);
    assert_eq!(
        sched
            .store()
            .get_alarm(&alarm_id)
            .expect("alarm")
            .expect("row")
            .deleted,
        true
    );

    let occ = sched
        .store()
        .get_occurrence(&occ_id)
        .expect("row")
        .expect("occ");
    assert_eq!(
        occ.state,
        OccurrenceState::Suppressed,
        "delete disables future claims"
    );
    assert!(sched.next_wakeup().expect("wakeup").is_none());

    // A fresh delete of the tombstoned alarm is NotFound (the same action_id
    // replays idempotently), and claims never fire.
    let del_again = make_action(
        &uuid_v7(904),
        "org.dolly.alarm.delete",
        serde_json::json!({"alarm_id": alarm_id, "expected_revision": 1}),
    );
    let err = sched.apply(&del_again).expect_err("double delete");
    assert_eq!(err.code, AlarmErrorCode::OccurrenceNotFound);
    clock.set(at_us);
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    assert!(sched.claim_due("w").expect("claim").is_empty());
}

// ---------------------------------------------------------------------------
// Snooze: one-time child occurrence, history preserved
// ---------------------------------------------------------------------------

#[test]
fn snooze_reschedules_occurrence_without_touching_history() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("snooze.sqlite3");
    let at_us = parse_utc_timestamp_us("2025-11-28T09:00:00.000000Z", "a").unwrap();
    let (mut sched, clock) = open_shared(&db, at_us - 3_600_000_000);
    let created = sched
        .apply(&once_action(100, "2025-11-28T09:00:00.000000Z"))
        .expect("create");
    let alarm_id = created["record"]["alarm_id"].as_str().unwrap().to_string();
    let (_, occ_id, _) = sched.store().earliest_due().expect("due").expect("due");

    let snooze = make_action(
        &uuid_v7(1000),
        "org.dolly.alarm.snooze",
        serde_json::json!({
            "alarm_id": alarm_id,
            "occurrence_id": occ_id,
            "expected_revision": 1,
            "new_at": "2025-11-28T10:00:00.000000Z"
        }),
    );
    let result = sched.apply(&snooze).expect("snooze");
    assert_eq!(result["snoozed_occurrence_id"], serde_json::json!(occ_id));
    // The alarm record's revision is unchanged (only the occurrence moved).
    assert_eq!(result["record"]["revision"], 1);

    // History untouched: suppressed row keeps its original scheduled instant.
    let original = sched
        .store()
        .get_occurrence(&occ_id)
        .expect("row")
        .expect("occ");
    assert_eq!(original.state, OccurrenceState::Suppressed);
    assert_eq!(original.scheduled_at, "2025-11-28T09:00:00.000000Z");

    // The child occurrence fires at the snoozed instant.
    clock.set(parse_utc_timestamp_us("2025-11-28T10:00:00.000000Z", "n").unwrap());
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    let claims = sched.claim_due("w").expect("claim");
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].scheduled_at, "2025-11-28T10:00:00.000000Z");
    assert_eq!(claims[0].kind, dolly_alarm::store::OccurrenceKind::Snooze);
    let event = sched.complete(&claims[0]).expect("complete");
    assert_eq!(event.scheduled_at, "2025-11-28T10:00:00.000000Z");
    // Exactly two rows: the suppressed original and the snooze child.
    assert_eq!(sched.store().count_occurrences(None).expect("count"), 2);
}

// ---------------------------------------------------------------------------
// Acknowledge and repeat_until_acknowledged races
// ---------------------------------------------------------------------------

fn repeat_action(id: u64, schedule: serde_json::Value, interval: u64) -> CommittedAction {
    make_action(
        &uuid_v7(id),
        "org.dolly.alarm.create",
        serde_json::json!({
            "title": "Repeat",
            "schedule": schedule,
            "delivery": {"mode": "repeat_until_acknowledged", "repeat_interval_seconds": interval},
            "enabled": true,
        }),
    )
}

#[test]
fn ack_before_repeat_claim_suppresses_all_repeats() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("ack1.sqlite3");
    let at = "2025-11-28T09:00:00.000000Z";
    let at_us = parse_utc_timestamp_us(at, "a").unwrap();
    let (mut sched, clock) = open_shared(&db, at_us - 1_000_000);
    let created = sched
        .apply(&repeat_action(
            110,
            serde_json::json!({"kind": "once", "at": at}),
            60,
        ))
        .expect("create");
    let alarm_id = created["record"]["alarm_id"].as_str().unwrap().to_string();
    let (_, source_id, _) = sched.store().earliest_due().expect("due").expect("due");

    // Fire the original; the repeat series starts from that committed firing.
    clock.set(at_us);
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    let claims = sched.claim_due("w").expect("claim");
    assert_eq!(claims.len(), 1);
    let original = sched.complete(&claims[0]).expect("complete");
    assert_eq!(original.scheduled_at, at);

    // Repeat ordinal 1 is materialized at first firing + 60s.
    clock.set(at_us + 61 * 1_000_000);
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    let (repeat_us, repeat_id, _) = sched.store().earliest_due().expect("due").expect("due");
    assert_eq!(repeat_us, at_us + 60 * 1_000_000);
    assert_ne!(repeat_id, source_id);

    // Acknowledge the original before the repeat is claimed.
    let ack = make_action(
        &uuid_v7(1100),
        "org.dolly.alarm.acknowledge",
        serde_json::json!({"alarm_id": alarm_id, "occurrence_id": source_id, "expected_revision": 1}),
    );
    let result = sched.apply(&ack).expect("ack");
    assert_eq!(result["already_acknowledged"], serde_json::json!(false));
    assert_eq!(
        result["acknowledged_at"],
        serde_json::json!("2025-11-28T09:01:01.000000Z")
    );

    // That and all later repeats are suppressed.
    let repeat = sched
        .store()
        .get_occurrence(&repeat_id)
        .expect("row")
        .expect("occ");
    assert_eq!(repeat.state, OccurrenceState::Suppressed);
    assert!(sched.next_wakeup().expect("wakeup").is_none());
    assert!(sched.claim_due("w").expect("claim").is_empty());
}

#[test]
fn ack_after_repeat_claim_allows_one_completion_then_suppresses_rest() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("ack2.sqlite3");
    let at = "2025-11-28T09:00:00.000000Z";
    let at_us = parse_utc_timestamp_us(at, "a").unwrap();
    let (mut sched, clock) = open_shared(&db, at_us - 1_000_000);
    let created = sched
        .apply(&repeat_action(
            111,
            serde_json::json!({"kind": "once", "at": at}),
            60,
        ))
        .expect("create");
    let alarm_id = created["record"]["alarm_id"].as_str().unwrap().to_string();
    let (_, source_id, _) = sched.store().earliest_due().expect("due").expect("due");

    clock.set(at_us);
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    let c0 = sched.claim_due("w").expect("claim");
    sched.complete(&c0[0]).expect("complete original");

    // The repeat claim commits FIRST (ordinal 1).
    clock.set(at_us + 61 * 1_000_000);
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    let c1 = sched.claim_due("w").expect("claim repeat");
    assert_eq!(c1.len(), 1);
    // Ack arrives while the repeat claim is held: "MAY complete once".
    let ack = make_action(
        &uuid_v7(1101),
        "org.dolly.alarm.acknowledge",
        serde_json::json!({"alarm_id": alarm_id, "occurrence_id": c1[0].occurrence_id, "expected_revision": 1}),
    );
    let result = sched.apply(&ack).expect("ack");
    assert_eq!(result["already_acknowledged"], serde_json::json!(false));
    // The in-flight repeat completes once.
    let event = sched.complete(&c1[0]).expect("complete repeat");
    assert_eq!(event.repeat_ordinal, 1);
    assert_eq!(event.scheduled_at, "2025-11-28T09:01:00.000000Z");
    // Every subsequent ordinal (2, ...) is suppressed.
    clock.set(at_us + 121 * 1_000_000);
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    assert!(
        sched.next_wakeup().expect("wakeup").is_none(),
        "later repeats suppressed"
    );
    let _ = source_id;
}

#[test]
fn ack_replay_preserves_first_acknowledged_at_and_flags_already() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("ack_replay.sqlite3");
    let at = "2025-11-29T09:00:00.000000Z";
    let at_us = parse_utc_timestamp_us(at, "a").unwrap();
    let (mut sched, clock) = open_shared(&db, at_us - 1_000_000);
    let created = sched
        .apply(&repeat_action(
            112,
            serde_json::json!({"kind": "once", "at": at}),
            60,
        ))
        .expect("create");
    let alarm_id = created["record"]["alarm_id"].as_str().unwrap().to_string();
    let (_, source_id, _) = sched.store().earliest_due().expect("due").expect("due");

    clock.set(at_us);
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    let c0 = sched.claim_due("w").expect("claim");
    sched.complete(&c0[0]).expect("complete");

    let ack = make_action(
        &uuid_v7(1110),
        "org.dolly.alarm.acknowledge",
        serde_json::json!({"alarm_id": alarm_id, "occurrence_id": source_id, "expected_revision": 1}),
    );
    let first = sched.apply(&ack).expect("first ack");
    assert_eq!(first["already_acknowledged"], serde_json::json!(false));
    assert_eq!(
        first["acknowledged_at"],
        serde_json::json!("2025-11-29T09:00:00.000000Z")
    );
    // A fresh ack action on the same occurrence preserves the first time.
    let ack2 = make_action(
        &uuid_v7(1111),
        "org.dolly.alarm.acknowledge",
        serde_json::json!({"alarm_id": alarm_id, "occurrence_id": source_id, "expected_revision": 1}),
    );
    let second = sched.apply(&ack2).expect("second ack");
    assert_eq!(second["already_acknowledged"], serde_json::json!(true));
    assert_eq!(
        second["acknowledged_at"],
        serde_json::json!("2025-11-29T09:00:00.000000Z")
    );
    // Replay of the first action returns its recorded result.
    let replay = sched.apply(&ack).expect("replay ack");
    assert_eq!(replay, first);
}

// ---------------------------------------------------------------------------
// List ordering: ascending next_occurrence, nulls last, alarm_id tie-break
// ---------------------------------------------------------------------------

#[test]
fn list_order_and_cursor() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("list.sqlite3");
    let t0 = parse_utc_timestamp_us("2025-12-01T00:00:00.000000Z", "t").unwrap();
    let (mut sched, _clock) = open_shared(&db, t0);
    // Three alarms: two with future nexts (late and early), one already past
    // (null next) and one disabled (still ordered by its next).
    sched
        .apply(&once_action(121, "2025-12-05T09:00:00.000000Z"))
        .expect("c");
    sched
        .apply(&once_action(122, "2025-12-02T09:00:00.000000Z"))
        .expect("c");
    sched
        .apply(&once_action(123, "2025-11-20T09:00:00.000000Z"))
        .expect("c"); // past -> null
    sched
        .apply(&make_action(
            &uuid_v7(124),
            "org.dolly.alarm.create",
            serde_json::json!({
                "title": "Disabled",
                "schedule": {"kind": "once", "at": "2025-12-03T09:00:00.000000Z"},
                "delivery": {"mode": "once"},
                "enabled": false
            }),
        ))
        .expect("c");

    let list = make_action(
        &uuid_v7(1200),
        "org.dolly.alarm.list",
        serde_json::json!({"enabled": null, "cursor": null, "limit": 10}),
    );
    let result = sched.apply(&list).expect("list");
    let records = result["records"].as_array().unwrap();
    assert_eq!(records.len(), 4);
    let order: Vec<&str> = records
        .iter()
        .map(|r| r["next_occurrence"].as_str().unwrap_or("<null>"))
        .collect();
    assert_eq!(
        order,
        vec![
            "2025-12-02T09:00:00.000000Z",
            "2025-12-03T09:00:00.000000Z",
            "2025-12-05T09:00:00.000000Z",
            "<null>", // nulls last
        ]
    );

    // Pagination via cursor preserves the same pinned order.
    let page1 = make_action(
        &uuid_v7(1201),
        "org.dolly.alarm.list",
        serde_json::json!({"enabled": null, "cursor": null, "limit": 2}),
    );
    let r1 = sched.apply(&page1).expect("page1");
    let cursor = r1["next_cursor"].as_str().expect("cursor").to_string();
    assert_eq!(r1["records"].as_array().unwrap().len(), 2);
    let page2 = make_action(
        &uuid_v7(1202),
        "org.dolly.alarm.list",
        serde_json::json!({"enabled": null, "cursor": cursor, "limit": 2}),
    );
    let r2 = sched.apply(&page2).expect("page2");
    assert_eq!(r2["records"].as_array().unwrap().len(), 2);
    assert_ne!(
        r2["records"][0]["next_occurrence"], r1["records"][0]["next_occurrence"],
        "second page continues after the first"
    );
    // The cursor is invalid for a different filter.
    let wrong = make_action(
        &uuid_v7(1203),
        "org.dolly.alarm.list",
        serde_json::json!({"enabled": true, "cursor": cursor, "limit": 2}),
    );
    let err = sched.apply(&wrong).expect_err("filter mismatch");
    assert_eq!(err.code, AlarmErrorCode::InvalidSchedule);
}

// ---------------------------------------------------------------------------
// Create replay: byte-identical logical record
// ---------------------------------------------------------------------------

#[test]
fn create_replay_is_idempotent_by_action_id() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("replay.sqlite3");
    let (mut sched, _clock) = open_shared(
        &db,
        parse_utc_timestamp_us("2025-12-10T00:00:00.000000Z", "t").unwrap(),
    );
    let action = once_action(130, "2025-12-10T09:00:00.000000Z");
    let first = sched.apply(&action).expect("create");
    let second = sched.apply(&action).expect("replay");
    assert_eq!(
        first, second,
        "create replay returns the byte-identical logical record"
    );
    assert_eq!(sched.store().count_active_alarms().expect("count"), 1);
    // An update replay returns the recorded result and does not double-apply.
    let update = make_action(
        &uuid_v7(1300),
        "org.dolly.alarm.update",
        serde_json::json!({
            "alarm_id": first["record"]["alarm_id"],
            "expected_revision": 1,
            "replacement": {
                "title": "Replayed update",
                "schedule": {"kind": "once", "at": "2025-12-10T10:00:00.000000Z"},
                "delivery": {"mode": "once"},
                "enabled": true
            }
        }),
    );
    let u1 = sched.apply(&update).expect("update");
    let u2 = sched.apply(&update).expect("update replay");
    assert_eq!(u1, u2);
    assert_eq!(u1["record"]["revision"], 2);
}

// ---------------------------------------------------------------------------
// tzdb upgrade: future occurrences recomputed, fired history preserved
// ---------------------------------------------------------------------------

#[test]
fn tzdb_upgrade_recomputes_future_and_keeps_fired_history() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("tzdb.sqlite3");
    // 2025-11-02T00:00:00Z, before the autumn fold.
    let t0 = parse_utc_timestamp_us("2025-11-02T00:00:00.000000Z", "t").unwrap();
    let (mut sched, clock) = open_shared(&db, t0);
    let action = make_action(
        &uuid_v7(140),
        "org.dolly.alarm.create",
        serde_json::json!({
            "title": "Tzdb",
            "schedule": {"kind": "cron_v1", "expression": "45 1 2 11 *", "timezone": "America/New_York"},
            "delivery": {"mode": "once"},
            "dst_fold_policy": "both",
            "enabled": true,
        }),
    );
    let created = sched.apply(&action).expect("create");
    assert_eq!(
        created["record"]["next_occurrence"],
        serde_json::json!("2025-11-02T05:45:00.000000Z")
    );
    let alarm_id = created["record"]["alarm_id"].as_str().unwrap().to_string();

    // Fire the earlier fold instant before the upgrade.
    clock.set(parse_utc_timestamp_us("2025-11-02T05:45:00.000000Z", "e").unwrap());
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    let c = sched.claim_due("w").expect("claim");
    assert_eq!(c.len(), 1);
    let fired_event = sched.complete(&c[0]).expect("complete");
    let fired_id = fired_event.occurrence_id.clone();
    let _ = fired_event;

    // Upgrade to the 2026a rules; settle recomputes future occurrences.
    sched.upgrade_tzdb(
        "2026a".to_string(),
        Box::new(FixtureZoneRulesProvider::new("2026a")),
    );
    clock.set(parse_utc_timestamp_us("2025-11-02T06:00:00.000000Z", "t").unwrap());
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");

    // The record advanced to the new revision; fired history is preserved.
    let row = sched
        .store()
        .get_alarm(&alarm_id)
        .expect("alarm")
        .expect("row");
    assert_eq!(row.tzdb_revision, "2026a");

    let fired = sched
        .store()
        .get_occurrence(&fired_id)
        .expect("row")
        .expect("fired");
    assert_eq!(
        fired.state,
        OccurrenceState::Fired,
        "already-fired history never recomputed"
    );

    // The later fold instant under 2026a rules is still the next occurrence.
    let premise = sched.next_wakeup().expect("wakeup").expect("premise");
    let occ_key = premise.key.splitn(2, ':').nth(1).unwrap();
    let due = sched
        .store()
        .get_occurrence(occ_key)
        .expect("row")
        .expect("occ");
    assert_eq!(due.scheduled_at, "2025-11-02T06:45:00.000000Z");
    // It can still be claimed and completed (identity stable under same
    // revision + instant), proving the recompute did not lose the occurrence.
    clock.set(parse_utc_timestamp_us("2025-11-02T06:45:00.000000Z", "l").unwrap());
    sched.settle(&|_, _| Outcome::Unknown).expect("settle");
    for occ in sched.store().due_occurrences(None).expect("due") {
        eprintln!(
            "DUE {} state={:?} fold={} at={}",
            occ.occurrence_id, occ.state, occ.fold_ordinal, occ.scheduled_at
        );
    }
    let claims = sched.claim_due("w").expect("claim");
    assert_eq!(claims.len(), 1);
    let event = sched.complete(&claims[0]).expect("complete later fold");
    assert_eq!(event.scheduled_at, "2025-11-02T06:45:00.000000Z");
}
