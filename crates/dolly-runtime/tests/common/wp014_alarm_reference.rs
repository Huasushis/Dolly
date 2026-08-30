//! WP-014 Alarm deterministic reference engine ("boundary test double").
//!
//! The WP-014 integration rule starts each package behind a boundary test
//! double with recorded deterministic dependencies. The accepted base
//! (3172f470fba22677598023c319f5e81f4ed6e5cc) ships no `org.dolly.alarm`
//! consumer, so this module is that double: it evaluates the frozen WP-014
//! contract (dolly-spec/docs/spec/extensions/alarm.md) purely and
//! deterministically over an injected virtual clock and injected IANA-derived
//! zone-rule fixtures. It never reads the wall clock, never touches the
//! ambient timezone or network, and never writes to the Core store; the test
//! suite drives the REAL committed-premise seam and then pins the frozen
//! reference facts here, while the production-presence probe observes only
//! the real Core store.
//!
//! Every crossing to a real shared substrate uses the real public seams of
//! the workspace: `dolly_canonical_json` (JCS) and `Sha256Digest` for the
//! occurrence identity tuple, and the checked-in JSON Schemas for
//! action/result validation (in the suite). All numeric goldens derive from
//! the normative spec text and independently verified IANA transition facts;
//! see `fixtures/wp014_alarm_conformance.json` for the frozen target copy.

use dolly_canonical_json::{Sha256Digest, canonicalize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// The ES-anchored example alarm identity and instants from the spec.
pub const SPEC_ALARM_ID: &str = "019535d4-6f00-7a2c-9b31-8e11d2345000";
pub const SPEC_CREATED_AT: &str = "2026-08-09T15:00:00.000000Z";
pub const TZ_LA: &str = "America/Los_Angeles";
pub const TZ_BERLIN: &str = "Europe/Berlin";
pub const TZ_UTC: &str = "UTC";
pub const TZDB_2026B: &str = "2026b";
pub const TZDB_2027A: &str = "2027a";
pub const HOUR: i64 = 3_600;
pub const DAY: i64 = 86_400;
pub const EVENT_SCHEMA: &str = "dolly.alarm.event/v1";
/// Alarm-domain claim-contention code (beyond the §8 action-error set).
pub const CODE_ALREADY_CLAIMED: &str = "ALREADY_CLAIMED";

// ---------------------------------------------------------------------------
// Virtual clock (wall + monotonic), injected and fully scriptable.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RefClock {
    /// Wall-clock unix microseconds as seen by the Alarm.
    pub wall_unix_us: i128,
    /// Monotonic microseconds since an arbitrary process origin.
    pub mono_us: i128,
}

impl RefClock {
    pub fn new(wall_utc: &str, mono_us: i128) -> Self {
        Self {
            wall_unix_us: parse_core_utc(wall_utc).expect("virtual wall instant"),
            mono_us,
        }
    }
    /// Advance monotonic without moving the wall clock (suspend/resume and
    /// local-repeat-wait control).
    pub fn advance_mono(&mut self, delta_us: i128) {
        self.mono_us += delta_us;
    }
    /// Jump/resume the wall clock, leaving monotonic untouched.
    pub fn set_wall(&mut self, wall_utc: &str) {
        self.wall_unix_us = parse_core_utc(wall_utc).expect("virtual wall instant");
    }
}

// ---------------------------------------------------------------------------
// Core microsecond UTC form (parsing and formatting).
// ---------------------------------------------------------------------------

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

const DAYS_IN_MONTH: [i64; 13] = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

fn days_in_month(y: i64, m: i64) -> i64 {
    if m == 2 && is_leap_year(y) {
        29
    } else {
        DAYS_IN_MONTH[m as usize]
    }
}

fn pad2(v: i64) -> String {
    format!("{v:02}")
}

/// Days from the civil epoch (1970-01-01) using Hinnant proleptic algorithms.
pub fn days_from_civil(y0: i64, m0: i64, d0: i64) -> i64 {
    let mut y = y0;
    let m = m0;
    y -= if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d0 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn civil_from_days(z0: i64) -> (i64, i64, i64) {
    let z = z0 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Weekday with Sunday == 0 (cron convention); 1970-01-01 was Thursday.
pub fn weekday_sunday0(days: i64) -> i64 {
    (days + 4).rem_euclid(7)
}

/// Strict Core six-digit microsecond UTC form `YYYY-MM-DDTHH:MM:SS.ffffffZ`;
/// rejects leap seconds and invalid calendar dates (normalizer rule).
pub fn parse_core_utc(s: &str) -> Result<i128, String> {
    let b = s.as_bytes();
    if b.len() != 27
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b[19] != b'.'
        || b[26] != b'Z'
    {
        return Err("timestamp must be the Core microsecond UTC form".into());
    }
    fn digits(b: &[u8]) -> i64 {
        let mut v = 0i64;
        for &c in b {
            v = v * 10 + (c - b'0') as i64;
        }
        v
    }
    let y = digits(&b[0..4]);
    let mo = digits(&b[5..7]);
    let d = digits(&b[8..10]);
    let h = digits(&b[11..13]);
    let mi = digits(&b[14..16]);
    let se = digits(&b[17..19]);
    let us = digits(&b[20..26]);
    if !(1..=12).contains(&mo) {
        return Err("month out of range".into());
    }
    if !(1..=days_in_month(y, mo)).contains(&d) {
        return Err("day out of range".into());
    }
    if !(0..=23).contains(&h) {
        return Err("hour out of range".into());
    }
    if !(0..=59).contains(&mi) {
        return Err("minute out of range".into());
    }
    if se > 59 {
        return Err("leap seconds are rejected".into());
    }
    Ok(days_from_civil(y, mo, d) as i128 * DAY as i128 * 1_000_000
        + (h * 3600 + mi * 60 + se) as i128 * 1_000_000
        + us as i128)
}

pub fn format_core_utc(us: i128) -> String {
    let secs = us.div_euclid(1_000_000);
    let us_part = us.rem_euclid(1_000_000);
    let (y, mo, d) = civil_from_days(secs.div_euclid(DAY as i128) as i64);
    let tod = secs.rem_euclid(DAY as i128) as i64;
    let (h, mi, se) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    format!(
        "{y:04}-{}-{}T{}:{}:{}.{us_part:06}Z",
        pad2(mo),
        pad2(d),
        pad2(h),
        pad2(mi),
        pad2(se)
    )
}

/// Normalize a raw once-at RFC3339 timestamp (explicit Z or numeric offset)
/// to the Core six-digit UTC form without loss of the instant. Leap seconds
/// and invalid calendar dates are rejected.
pub fn normalize_once_at(raw: &str) -> Result<String, RefError> {
    let has_z = raw.ends_with('Z');
    let (body, offset_secs) = if has_z {
        (&raw[..raw.len() - 1], 0i64)
    } else if raw.len() >= 6 {
        let tail = &raw[raw.len() - 6..];
        let tb = tail.as_bytes();
        if (tb[0] == b'+' || tb[0] == b'-') && tb[3] == b':' {
            let sign = if tb[0] == b'-' { -1 } else { 1 };
            let oh = (tb[1] - b'0') as i64 * 10 + (tb[2] - b'0') as i64;
            let om = (tb[4] - b'0') as i64 * 10 + (tb[5] - b'0') as i64;
            if oh > 23 || om > 59 {
                return Err(invalid_schedule("offset out of range", json!({"at": raw})));
            }
            (&raw[..raw.len() - 6], sign * (oh * 3600 + om * 60))
        } else {
            return Err(invalid_schedule(
                "once at must carry an explicit Z or numeric offset",
                json!({"at": raw}),
            ));
        }
    } else {
        return Err(invalid_schedule(
            "once at must carry an explicit Z or numeric offset",
            json!({"at": raw}),
        ));
    };
    let (clock, frac) = match body.split_once('.') {
        Some((c, f)) => (c, f),
        None => (body, ""),
    };
    if clock.len() != 19 || frac.len() > 9 {
        return Err(invalid_schedule("malformed timestamp", json!({"at": raw})));
    }
    let mut mirror = String::with_capacity(27);
    mirror.push_str(clock);
    mirror.push_str(".000000Z");
    let base_us = parse_core_utc(&mirror).map_err(|e| {
        invalid_schedule(format!("invalid calendar date/time: {e}"), json!({"at": raw}))
    })?;
    let frac_us: i128 = if frac.is_empty() {
        0
    } else {
        let mut padded = frac.to_string();
        while padded.len() < 6 {
            padded.push('0');
        }
        padded[..6].parse::<i128>().unwrap_or(0)
    };
    let instant = base_us + frac_us - offset_secs as i128 * 1_000_000;
    Ok(format_core_utc(instant))
}

// ---------------------------------------------------------------------------
// Injected deterministic IANA-derived zone rules (tzdb fixtures).
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ZoneTransition {
    /// Unix seconds at which the new offset takes effect.
    pub at_unix_sec: i64,
    /// UTC offset in seconds after the transition.
    pub offset_sec: i32,
    /// Whether the post-transition offset is daylight saving time.
    pub dst: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ZoneRules {
    pub id: String,
    pub revision: String,
    pub base_offset_sec: i32,
    pub transitions: Vec<ZoneTransition>,
}

/// The injected deterministic tzdb fixture: IANA 2026b facts for the zones
/// under test, plus a second revision of America/Los_Angeles ("2027a") whose
/// 2027 rules differ so a tzdb upgrade recomputes future occurrences.
pub fn zone_rules() -> Vec<ZoneRules> {
    let z = |id: &str, rev: &str, base: i32, ts: &[(i64, i32, bool)]| ZoneRules {
        id: id.to_string(),
        revision: rev.to_string(),
        base_offset_sec: base,
        transitions: ts
            .iter()
            .map(|(at, off, dst)| ZoneTransition {
                at_unix_sec: *at,
                offset_sec: *off,
                dst: *dst,
            })
            .collect(),
    };
    let pst = -8 * HOUR as i32;
    let pdt = -7 * HOUR as i32;
    let cet = HOUR as i32;
    let cest = 2 * HOUR as i32;
    vec![
        z(
            TZ_LA,
            TZDB_2026B,
            pst,
            // 2026-03-08T10:00:00Z spring forward, 2026-11-01T09:00:00Z fall
            // back, 2027-03-14T10:00:00Z spring forward,
            // 2027-11-07T09:00:00Z fall back (IANA 2026b).
            &[
                (1_772_964_000, pdt, true),
                (1_793_523_600, pst, false),
                (1_805_018_400, pdt, true),
                (1_825_578_000, pst, false),
            ],
        ),
        z(
            TZ_LA,
            TZDB_2027A,
            pst,
            // "2027a" revision: 2026 DST identical to 2026b, but 2027 keeps
            // PST all year (no DST), so future occurrences recompute while
            // already-fired instants stay unchanged.
            &[
                (1_772_964_000, pdt, true),
                (1_793_523_600, pst, false),
            ],
        ),
        z(
            TZ_BERLIN,
            TZDB_2026B,
            cet,
            // 2026-03-29T01:00:00Z spring forward, 2026-10-25T01:00:00Z fall
            // back (IANA 2026b).
            &[
                (1_774_746_000, cest, true),
                (1_792_890_000, cet, false),
            ],
        ),
        z(TZ_UTC, TZDB_2026B, 0, &[]),
    ]
}

pub fn zone_named(id: &str) -> Option<ZoneRules> {
    zone_rules().into_iter().find(|z| z.id == id)
}

pub fn zone_named_with_revision(id: &str, revision: &str) -> Option<ZoneRules> {
    zone_rules()
        .into_iter()
        .find(|z| z.id == id && z.revision == revision)
}

/// Resolve a timezone against a specific tzdb revision, falling back to the
/// canonical definition. A tzdb upgrade recomputes through the NEW revision.
fn zone_for(tz: &str, revision: &str) -> Option<ZoneRules> {
    zone_named_with_revision(tz, revision).or_else(|| zone_named(tz))
}

fn offset_at_sec(z: &ZoneRules, unix_sec: i64) -> (i32, bool) {
    let mut off = z.base_offset_sec;
    let mut dst = false;
    for t in &z.transitions {
        if t.at_unix_sec <= unix_sec {
            off = t.offset_sec;
            dst = t.dst;
        } else {
            break;
        }
    }
    (off, dst)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GapPolicy {
    ShiftByGap,
    Skip,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FoldPolicy {
    Earlier,
    Later,
    Both,
}

pub fn gap_policy(name: &str) -> Option<GapPolicy> {
    match name {
        "shift_by_gap" => Some(GapPolicy::ShiftByGap),
        "skip" => Some(GapPolicy::Skip),
        _ => None,
    }
}

pub fn fold_policy(name: &str) -> Option<FoldPolicy> {
    match name {
        "earlier" => Some(FoldPolicy::Earlier),
        "later" => Some(FoldPolicy::Later),
        "both" => Some(FoldPolicy::Both),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ResolvedInstant {
    pub unix_sec: i64,
    pub fold_ordinal: i64,
}

/// Resolve a wall-clock civil second in the zone to zero, one, or two UTC
/// instants per the gap/fold policies.
pub fn wall_to_unix(
    z: &ZoneRules,
    wall_sec: i64,
    gap: GapPolicy,
    fold: FoldPolicy,
) -> Vec<ResolvedInstant> {
    let mut folds: Vec<ResolvedInstant> = Vec::new();
    let mut gap_shift: Option<ResolvedInstant> = None;
    let mut gap_hit = false;
    for t in &z.transitions {
        let (before_off, _) = offset_at_sec(z, t.at_unix_sec - 1);
        let before = before_off as i64;
        let after = t.offset_sec as i64;
        if after < before {
            // Fold: local wall times in [at + after, at + before) twice.
            if wall_sec >= t.at_unix_sec + after && wall_sec < t.at_unix_sec + before {
                folds.push(ResolvedInstant { unix_sec: wall_sec - before, fold_ordinal: 0 });
                folds.push(ResolvedInstant { unix_sec: wall_sec - after, fold_ordinal: 1 });
            }
        } else if after > before {
            // Gap: local wall times in [at + before, at + after) nonexistent.
            if wall_sec >= t.at_unix_sec + before && wall_sec < t.at_unix_sec + after {
                gap_hit = true;
                let gap_seconds = after - before;
                match gap {
                    GapPolicy::ShiftByGap => {
                        // Add the exact DST gap duration, interpret with the
                        // post-transition offset.
                        let resolved = (wall_sec + gap_seconds) - after;
                        gap_shift = Some(ResolvedInstant { unix_sec: resolved, fold_ordinal: 0 });
                    }
                    GapPolicy::Skip => {}
                }
            }
        }
    }
    if !folds.is_empty() {
        match fold {
            FoldPolicy::Earlier => return vec![folds[0]],
            FoldPolicy::Later => return vec![folds[1]],
            FoldPolicy::Both => {
                let mut ordered = folds.clone();
                ordered.sort();
                return ordered;
            }
        }
    }
    if let Some(r) = gap_shift {
        return vec![r];
    }
    if gap_hit {
        return Vec::new();
    }
    let guess = offset_at_sec(z, wall_sec).0 as i64;
    let candidate = wall_sec - guess;
    if offset_at_sec(z, candidate).0 as i64 == guess {
        return vec![ResolvedInstant { unix_sec: candidate, fold_ordinal: 0 }];
    }
    let again = offset_at_sec(z, candidate).0 as i64;
    vec![ResolvedInstant { unix_sec: wall_sec - again, fold_ordinal: 0 }]
}

// ---------------------------------------------------------------------------
// Cron_v1 evaluation (five fields, Vixie DOM/DOW OR semantics).
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CronField {
    Any,
    Set(BTreeMap<i64, ()>),
}

impl CronField {
    pub fn is_any(&self) -> bool {
        matches!(self, CronField::Any)
    }
    pub fn matches(&self, v: i64) -> bool {
        match self {
            CronField::Any => true,
            CronField::Set(s) => s.contains_key(&v),
        }
    }
    pub fn values(&self, lo: i64, hi: i64) -> Vec<i64> {
        match self {
            CronField::Any => (lo..=hi).collect(),
            CronField::Set(s) => s.keys().copied().collect(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CronSpec {
    pub minute: CronField,
    pub hour: CronField,
    pub dom: CronField,
    pub month: CronField,
    pub dow: CronField,
}

fn parse_field(raw: &str, lo: i64, hi: i64, field: &str) -> Result<CronField, RefError> {
    let mut values = BTreeMap::new();
    for element in raw.split(',') {
        let element = element.trim();
        if element.is_empty() {
            return Err(invalid_schedule(
                format!("empty {field} field element"),
                json!({"field": field}),
            ));
        }
        let (range, step) = match element.split_once('/') {
            Some((r, st)) => (
                r,
                st.parse::<i64>()
                    .map_err(|_| invalid_schedule(format!("bad step in {field}"), json!({"field": field})))?,
            ),
            None => (element, 1),
        };
        if step < 1 {
            return Err(invalid_schedule(
                format!("step must be positive in {field}"),
                json!({"field": field}),
            ));
        }
        if range == "*" && step == 1 {
            // `*` is the unrestricted field (Vixie DOM/DOW `*` rule).
            return Ok(CronField::Any);
        }
        if range == "*" {
            let mut v = lo;
            while v <= hi {
                values.insert(v, ());
                v += step;
            }
        } else {
            let (a, b) = match range.split_once('-') {
                Some((a, b)) => (a.trim(), Some(b.trim())),
                None => (range.trim(), None),
            };
            let a = a.parse::<i64>().map_err(|_| {
                invalid_schedule(format!("bad value in {field}"), json!({"field": field}))
            })?;
            if !(lo..=hi).contains(&a) {
                return Err(invalid_schedule(
                    format!("{field} value {a} out of range {lo}..{hi}"),
                    json!({"field": field, "value": a}),
                ));
            }
            let top = match b {
                Some(b) => b.parse::<i64>().map_err(|_| {
                    invalid_schedule(format!("bad range end in {field}"), json!({"field": field}))
                })?,
                None => a,
            };
            if !(lo..=hi).contains(&top) {
                return Err(invalid_schedule(
                    format!("{field} range end {top} out of range"),
                    json!({"field": field, "value": top}),
                ));
            }
            if a > top {
                return Err(invalid_schedule(
                    format!("{field} range {a}-{top} is descending"),
                    json!({"field": field}),
                ));
            }
            let mut v = a;
            while v <= top {
                values.insert(v, ());
                v += step;
            }
        }
    }
    if values.is_empty() {
        return Err(invalid_schedule(
            format!("{field} matched no values"),
            json!({"field": field}),
        ));
    }
    Ok(CronField::Set(values))
}

/// Parse five fields restricted to `*`, comma lists, numeric ranges, and
/// positive steps (names, `L`, `W`, `#`, and seconds are rejected upstream).
pub fn parse_cron(expr: &str) -> Result<CronSpec, RefError> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(invalid_schedule(
            "cron_v1 requires exactly five fields",
            json!({"expression": expr}),
        ));
    }
    let minute = parse_field(fields[0], 0, 59, "minute")?;
    let hour = parse_field(fields[1], 0, 23, "hour")?;
    let dom = parse_field(fields[2], 1, 31, "day_of_month")?;
    let month = parse_field(fields[3], 1, 12, "month")?;
    let dow = parse_field(fields[4], 0, 6, "day_of_week")?;
    Ok(CronSpec { minute, hour, dom, month, dow })
}

fn day_matches(c: &CronSpec, days: i64, mo: i64, d: i64) -> bool {
    if !c.month.matches(mo) {
        return false;
    }
    let dom_any = c.dom.is_any();
    let dow_any = c.dow.is_any();
    let dom_match = c.dom.matches(d);
    let dow_match = c.dow.matches(weekday_sunday0(days));
    match (dom_any, dow_any) {
        (true, true) => true,
        (true, false) => dow_match,
        (false, true) => dom_match,
        (false, false) => dom_match || dow_match,
    }
}

/// Earliest occurrence strictly after `from_us`; bounded by `max_days`.
pub fn cron_next(
    c: &CronSpec,
    z: &ZoneRules,
    from_us: i128,
    gap: GapPolicy,
    fold: FoldPolicy,
    max_days: i64,
) -> Result<Option<(i128, i64)>, RefError> {
    let from_seconds = from_us.div_euclid(1_000_000) as i64;
    let (mut y, mut mo, mut d) = civil_from_days(from_seconds.div_euclid(DAY as i64));
    for _ in 0..max_days {
        let days = days_from_civil(y, mo, d);
        if day_matches(c, days, mo, d) {
            let day_start = days * DAY as i64;
            for hour in c.hour.values(0, 23) {
                for minute in c.minute.values(0, 59) {
                    let wall = day_start + hour * 3600 + minute * 60;
                    for r in wall_to_unix(z, wall, gap, fold) {
                        let us = r.unix_sec as i128 * 1_000_000;
                        if us > from_us {
                            return Ok(Some((us, r.fold_ordinal)));
                        }
                    }
                }
            }
        }
        let (ny, nm, nd) = civil_from_days(days + 1);
        y = ny;
        mo = nm;
        d = nd;
    }
    Err(RefError::iteration_bound(format!(
        "no occurrence within {max_days} days"
    )))
}

/// Earliest occurrence strictly after `from_us` for an interval schedule.
pub fn interval_next(anchor_us: i128, every_seconds: i64, from_us: i128) -> Option<(i128, i64)> {
    if anchor_us > from_us {
        return Some((anchor_us, 0));
    }
    let delta = every_seconds as i128 * 1_000_000;
    let steps = ((from_us - anchor_us) / delta) + 1;
    let candidate = anchor_us + steps * delta;
    if candidate > from_us {
        Some((candidate, 0))
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Occurrence identity (JCS tuple -> sha256).
// ---------------------------------------------------------------------------

fn jcs_sha256(value: &Value) -> String {
    let (bytes, _) = canonicalize(value).expect("identity tuple is canonical JSON");
    Sha256Digest::compute(bytes.as_bytes()).to_canonical_string()
}

pub fn occurrence_identity(
    alarm_id: &str,
    alarm_revision: i64,
    scheduled_utc: &str,
    fold: i64,
) -> String {
    jcs_sha256(&json!([
        "dolly.alarm.occurrence/v1",
        alarm_id,
        alarm_revision,
        scheduled_utc,
        fold
    ]))
}

pub fn repeat_identity(parent_occurrence_id: &str, repeat_ordinal: i64) -> String {
    jcs_sha256(&json!(["dolly.alarm.repeat/v1", parent_occurrence_id, repeat_ordinal]))
}

/// The JCS tuple exactly as the spec freezes it (pinned in the fixture).
pub fn occurrence_identity_tuple(
    alarm_id: &str,
    alarm_revision: i64,
    scheduled_utc: &str,
    fold_ordinal: i64,
) -> Value {
    json!([
        "dolly.alarm.occurrence/v1",
        alarm_id,
        alarm_revision,
        scheduled_utc,
        fold_ordinal
    ])
}

// ---------------------------------------------------------------------------
// Error envelopes and alarm configuration.
// ---------------------------------------------------------------------------

const CODE_INVALID_SCHEDULE: &str = "INVALID_SCHEDULE";
const CODE_NONEXISTENT_TIMEZONE: &str = "NONEXISTENT_TIMEZONE";
const CODE_REVISION_CONFLICT: &str = "REVISION_CONFLICT";
const CODE_ITERATION_BOUND: &str = "ITERATION_BOUND";
const CODE_ALARM_LIMIT: &str = "ALARM_LIMIT";
const CODE_REPEAT_INTERVAL: &str = "REPEAT_INTERVAL";
const CODE_OCCURRENCE_NOT_FOUND: &str = "OCCURRENCE_NOT_FOUND";
const CODE_ALREADY_ACKNOWLEDGED: &str = "ALREADY_ACKNOWLEDGED";
const CODE_DATABASE_UNAVAILABLE: &str = "DATABASE_UNAVAILABLE";
const CODE_CLOCK_UNAVAILABLE: &str = "CLOCK_UNAVAILABLE";
const CODE_RUNTIME_OUTCOME_UNKNOWN: &str = "RUNTIME_OUTCOME_UNKNOWN";
/// Alarm-side cursor validation code (beyond the §8 minimum set).
const CODE_INVALID_CURSOR: &str = "INVALID_CURSOR";

/// The §8 stable action-error codes plus `INVALID_CURSOR`. Consumed by the
/// deferred WP014-ERROR-001 case; kept here so the frozen code set is stable.
#[allow(dead_code)]
pub const STABLE_ERROR_CODES: [&str; 12] = [
    CODE_INVALID_SCHEDULE,
    CODE_NONEXISTENT_TIMEZONE,
    CODE_REVISION_CONFLICT,
    CODE_ITERATION_BOUND,
    CODE_ALARM_LIMIT,
    CODE_REPEAT_INTERVAL,
    CODE_OCCURRENCE_NOT_FOUND,
    CODE_ALREADY_ACKNOWLEDGED,
    CODE_DATABASE_UNAVAILABLE,
    CODE_CLOCK_UNAVAILABLE,
    CODE_RUNTIME_OUTCOME_UNKNOWN,
    CODE_INVALID_CURSOR,
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefError {
    pub code: String,
    pub retryable: bool,
    pub outcome: String,
    pub message: String,
    pub details: Value,
}

impl RefError {
    fn new(code: &str, retryable: bool, outcome: &str, message: String, details: Value) -> Self {
        Self {
            code: code.to_string(),
            retryable,
            outcome: outcome.to_string(),
            message,
            details,
        }
    }
    pub fn iteration_bound(message: impl Into<String>) -> Self {
        Self::new(CODE_ITERATION_BOUND, false, "not_applied", message.into(), json!({}))
    }
    pub fn envelope(&self) -> Value {
        json!({
            "code": self.code,
            "retryable": self.retryable,
            "outcome": self.outcome,
            "message": self.message,
            "details": self.details,
        })
    }
}

fn invalid_schedule(message: impl Into<String>, details: Value) -> RefError {
    RefError::new(CODE_INVALID_SCHEDULE, false, "not_applied", message.into(), details)
}

fn nonexistent_timezone(zone: &str) -> RefError {
    RefError::new(
        CODE_NONEXISTENT_TIMEZONE,
        false,
        "not_applied",
        format!("timezone {zone} does not exist in the recorded tzdb revision"),
        json!({"timezone": zone}),
    )
}

fn revision_conflict(alarm_id: &str, expected: i64, actual: i64) -> RefError {
    RefError::new(
        CODE_REVISION_CONFLICT,
        false,
        "not_applied",
        format!("expected revision {expected}, record is at {actual}"),
        json!({"alarm_id": alarm_id, "expected_revision": expected, "actual_revision": actual}),
    )
}

fn alarm_limit(max: i64) -> RefError {
    RefError::new(
        CODE_ALARM_LIMIT,
        false,
        "not_applied",
        format!("alarm limit {max} reached"),
        json!({"maximum_alarms": max}),
    )
}

fn repeat_interval(interval: i64, min: i64) -> RefError {
    RefError::new(
        CODE_REPEAT_INTERVAL,
        false,
        "not_applied",
        format!("repeat interval {interval} below minimum {min}"),
        json!({"repeat_interval_seconds": interval, "minimum_repeat_interval_seconds": min}),
    )
}

fn occurrence_not_found(alarm_id: &str, occurrence_id: Option<&str>) -> RefError {
    let mut details = serde_json::Map::new();
    details.insert("alarm_id".into(), json!(alarm_id));
    if let Some(oid) = occurrence_id {
        details.insert("occurrence_id".into(), json!(oid));
    }
    RefError::new(
        CODE_OCCURRENCE_NOT_FOUND,
        false,
        "not_applied",
        "the named alarm/occurrence was not found".to_string(),
        Value::Object(details),
    )
}

fn database_unavailable(detail: &str) -> RefError {
    RefError::new(
        CODE_DATABASE_UNAVAILABLE,
        true,
        "unknown",
        format!("durable alarm store unavailable: {detail}"),
        json!({}),
    )
}

#[allow(dead_code)]
fn clock_unavailable() -> RefError {
    RefError::new(
        CODE_CLOCK_UNAVAILABLE,
        true,
        "unknown",
        "the injected Clock reported no usable time".to_string(),
        json!({}),
    )
}

fn runtime_outcome_unknown(occurrence_id: &str) -> RefError {
    RefError::new(
        CODE_RUNTIME_OUTCOME_UNKNOWN,
        true,
        "unknown",
        "expired claim: Runtime Activation outcome must be queried before retry".to_string(),
        json!({"occurrence_id": occurrence_id}),
    )
}

fn invalid_cursor(detail: &str) -> RefError {
    RefError::new(
        CODE_INVALID_CURSOR,
        false,
        "not_applied",
        format!("list cursor is invalid: {detail}"),
        json!({}),
    )
}

#[allow(dead_code)]
fn already_acknowledged(occurrence_id: &str, acknowledged_at: &str) -> RefError {
    RefError::new(
        CODE_ALREADY_ACKNOWLEDGED,
        false,
        "applied",
        "occurrence is already acknowledged".to_string(),
        json!({"occurrence_id": occurrence_id, "acknowledged_at": acknowledged_at}),
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AlarmConfig {
    pub revision: i64,
    pub default_timezone: String,
    pub default_misfire_policy: String,
    pub default_dst_gap_policy: String,
    pub default_dst_fold_policy: String,
    pub maximum_alarms: i64,
    pub maximum_catch_up_count: i64,
    pub minimum_repeat_interval_seconds: i64,
    pub wakeup_horizon_seconds: i64,
    pub misfire_grace_seconds: i64,
    pub maximum_iterations_days: i64,
}

/// The frozen alarm defaults installed with a config revision. A handled
/// create/update omitting a policy selects the default from THIS revision; a
/// persisted record never inherits a later default.
pub fn alarm_config(revision: i64, defaults: &Value) -> AlarmConfig {
    let get = |k: &str, fallback: &str| -> String {
        defaults
            .get(k)
            .and_then(Value::as_str)
            .unwrap_or(fallback)
            .to_string()
    };
    AlarmConfig {
        revision,
        default_timezone: get("default_timezone", TZ_LA),
        default_misfire_policy: get("default_misfire_policy", "fire_once"),
        default_dst_gap_policy: get("default_dst_gap_policy", "shift_by_gap"),
        default_dst_fold_policy: get("default_dst_fold_policy", "earlier"),
        maximum_alarms: defaults.get("maximum_alarms").and_then(Value::as_i64).unwrap_or(100),
        maximum_catch_up_count: defaults
            .get("maximum_catch_up_count")
            .and_then(Value::as_i64)
            .unwrap_or(10),
        minimum_repeat_interval_seconds: defaults
            .get("minimum_repeat_interval_seconds")
            .and_then(Value::as_i64)
            .unwrap_or(60),
        wakeup_horizon_seconds: defaults
            .get("wakeup_horizon_seconds")
            .and_then(Value::as_i64)
            .unwrap_or(86_400),
        misfire_grace_seconds: defaults
            .get("misfire_grace_seconds")
            .and_then(Value::as_i64)
            .unwrap_or(300),
        maximum_iterations_days: defaults
            .get("maximum_iterations_days")
            .and_then(Value::as_i64)
            .unwrap_or(2_000),
    }
}

pub fn default_alarm_config(revision: i64) -> AlarmConfig {
    alarm_config(revision, &json!({}))
}

// ---------------------------------------------------------------------------
// Durable record / occurrence model (the future alarm repository contract).
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefRecord {
    pub alarm_id: String,
    pub revision: i64,
    pub title: String,
    pub schedule: Value,
    pub delivery: Value,
    pub misfire_policy: String,
    pub dst_gap_policy: String,
    pub dst_fold_policy: String,
    pub enabled: bool,
    pub created_at: String,
    pub next_occurrence: Option<String>,
    pub tzdb_revision: String,
}

impl RefRecord {
    pub fn to_json(&self) -> Value {
        json!({
            "alarm_id": self.alarm_id,
            "revision": self.revision,
            "title": self.title,
            "schedule": self.schedule,
            "delivery": self.delivery,
            "misfire_policy": self.misfire_policy,
            "dst_gap_policy": self.dst_gap_policy,
            "dst_fold_policy": self.dst_fold_policy,
            "enabled": self.enabled,
            "created_at": self.created_at,
            "next_occurrence": self.next_occurrence,
            "tzdb_revision": self.tzdb_revision,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefOccurrence {
    pub occurrence_id: String,
    pub kind: String,
    pub parent_occurrence_id: Option<String>,
    pub repeat_ordinal: Option<i64>,
    pub alarm_id: String,
    pub alarm_revision: i64,
    pub scheduled_utc: String,
    pub scheduled_us: i128,
    pub fold_ordinal: i64,
    pub state: String,
    pub claim_worker: Option<String>,
    pub claim_expires_mono_us: Option<i128>,
    pub fired_at: Option<String>,
    pub lateness_us: Option<i128>,
    pub misfire_status: String,
    pub acknowledgement_required: bool,
    pub acknowledged_at: Option<String>,
    pub repeat_due_mono_us: Option<i128>,
    pub disabled: bool,
}

impl RefOccurrence {
    pub fn to_json(&self) -> Value {
        json!({
            "occurrence_id": self.occurrence_id,
            "kind": self.kind,
            "parent_occurrence_id": self.parent_occurrence_id,
            "repeat_ordinal": self.repeat_ordinal,
            "alarm_id": self.alarm_id,
            "alarm_revision": self.alarm_revision,
            "scheduled_utc": self.scheduled_utc,
            "fold_ordinal": self.fold_ordinal,
            "state": self.state,
            "fired_at": self.fired_at,
            "lateness_us": self.lateness_us,
            "misfire_status": self.misfire_status,
            "acknowledgement_required": self.acknowledgement_required,
            "acknowledged_at": self.acknowledged_at,
            "disabled": self.disabled,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FiredEvent {
    pub schema: String,
    pub alarm_id: String,
    pub occurrence_id: String,
    pub alarm_revision: i64,
    pub title: String,
    pub scheduled_at: String,
    pub fired_at: String,
    pub lateness_seconds: i64,
    pub misfire_status: String,
    pub acknowledgement_requirement: String,
    pub parent_occurrence_id: Option<String>,
    pub repeat_ordinal: Option<i64>,
}

impl FiredEvent {
    pub fn to_json(&self) -> Value {
        let mut event = json!({
            "schema": self.schema,
            "alarm_id": self.alarm_id,
            "occurrence_id": self.occurrence_id,
            "alarm_revision": self.alarm_revision,
            "title": self.title,
            "scheduled_at": self.scheduled_at,
            "fired_at": self.fired_at,
            "lateness_seconds": self.lateness_seconds,
            "misfire_status": self.misfire_status,
            "acknowledgement_requirement": self.acknowledgement_requirement,
        });
        if let Some(p) = &self.parent_occurrence_id {
            event["parent_occurrence_id"] = json!(p);
        }
        if let Some(r) = self.repeat_ordinal {
            event["repeat_ordinal"] = json!(r);
        }
        event
    }
}

/// The ordered due-output block draft the alarm commits (one or more alarm
/// events sharing a block with independent identity/state).
pub fn due_output_block(events: &[FiredEvent]) -> Value {
    json!({
        "schema": "dolly.block/v1",
        "body": {
            "description": "org.dolly.alarm due occurrence(s)",
            "parts": [],
            "events": events.iter().map(FiredEvent::to_json).collect::<Vec<_>>(),
        }
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WakeupEntry {
    pub next_utc_instant: String,
    pub wakeup_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditEntry {
    pub alarm_id: String,
    pub from_revision: String,
    pub to_revision: String,
    pub recomputed_occurrences: i64,
    pub retained_fired: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RefStore {
    pub snapshot_revision: i64,
    pub records: BTreeMap<String, RefRecord>,
    pub occurrences: BTreeMap<String, RefOccurrence>,
    pub processed_actions: BTreeMap<String, Value>,
    pub wakeups: Vec<WakeupEntry>,
    pub fired_events: Vec<FiredEvent>,
    pub audit: Vec<AuditEntry>,
    pub misfire_diagnostics: Vec<Value>,
    /// (alarm_id, revision) whose future claims are disabled (updated/deleted).
    pub disabled_revisions: Vec<(String, i64)>,
    /// alarm_id -> monotonic instant of the first committed firing (repeat
    /// chain anchor; monotonic governs local repeat waits).
    pub first_fired_mono: BTreeMap<String, i128>,
    /// Deterministic fault-injection flags (WP-014 §8 failure semantics).
    pub database_unavailable: bool,
    pub host_output_failed: bool,
}

impl RefStore {
    pub fn to_json(&self) -> Value {
        json!({
            "snapshot_revision": self.snapshot_revision,
            "records": Value::Object(
                self.records.iter().map(|(k, r)| (k.clone(), r.to_json())).collect()
            ),
            "occurrences": Value::Object(
                self.occurrences.iter().map(|(k, o)| (k.clone(), o.to_json())).collect()
            ),
            "wakeups": self.wakeups.iter().map(|w| json!({
                "next_utc_instant": w.next_utc_instant,
                "wakeup_key": w.wakeup_key,
            })).collect::<Vec<Value>>(),
            "fired_events": self.fired_events.iter().map(FiredEvent::to_json).collect::<Vec<Value>>(),
            "audit": self.audit.iter().map(|a| json!({
                "alarm_id": a.alarm_id,
                "from_revision": a.from_revision,
                "to_revision": a.to_revision,
                "recomputed_occurrences": a.recomputed_occurrences,
                "retained_fired": a.retained_fired,
            })).collect::<Vec<Value>>(),
            "misfire_diagnostics": self.misfire_diagnostics,
        })
    }
}

// ---------------------------------------------------------------------------
// Normalized schedule evaluation.
// ---------------------------------------------------------------------------

enum NormalizedSchedule {
    Once { at_us: i128 },
    Interval { every_seconds: i64, anchor_us: i128 },
    Cron { spec: CronSpec, zone: ZoneRules },
}

fn normalize_schedule(schedule: &Value, tzdb_revision: &str) -> Result<NormalizedSchedule, RefError> {
    let kind = schedule
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_schedule("schedule.kind is required", schedule.clone()))?;
    match kind {
        "once" => {
            let raw = schedule
                .get("at")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid_schedule("once requires at", schedule.clone()))?;
            let normalized = normalize_once_at(raw)?;
            Ok(NormalizedSchedule::Once {
                at_us: parse_core_utc(&normalized).expect("normalized instant"),
            })
        }
        "interval" => {
            let every = schedule
                .get("every_seconds")
                .and_then(Value::as_i64)
                .ok_or_else(|| invalid_schedule("interval requires every_seconds", schedule.clone()))?;
            if !(1..=315_576_000).contains(&every) {
                return Err(invalid_schedule(
                    format!("interval every_seconds {every} out of range"),
                    schedule.clone(),
                ));
            }
            let anchor = schedule
                .get("anchor")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    invalid_schedule("interval requires an explicit UTC anchor", schedule.clone())
                })?;
            let anchor_us = parse_core_utc(anchor).map_err(|e| {
                invalid_schedule(format!("invalid interval anchor: {e}"), schedule.clone())
            })?;
            Ok(NormalizedSchedule::Interval { every_seconds: every, anchor_us })
        }
        "cron_v1" => {
            let expression = schedule
                .get("expression")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid_schedule("cron_v1 requires expression", schedule.clone()))?;
            let tz = schedule
                .get("timezone")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| TZ_LA.to_string());
            let zone = zone_for(&tz, tzdb_revision).ok_or_else(|| nonexistent_timezone(&tz))?;
            let spec = parse_cron(expression)?;
            Ok(NormalizedSchedule::Cron { spec, zone })
        }
        other => Err(invalid_schedule(
            format!("unknown schedule kind {other}"),
            schedule.clone(),
        )),
    }
}

/// Compute the next future occurrence for a record from `now_us` (pure).
fn next_occurrence_us(
    schedule: &Value,
    enabled: bool,
    gap_name: &str,
    fold_name: &str,
    now_us: i128,
    max_days: i64,
    tzdb_revision: &str,
) -> Result<Option<i128>, RefError> {
    if !enabled {
        return Ok(None);
    }
    match normalize_schedule(schedule, tzdb_revision)? {
        NormalizedSchedule::Once { at_us } => Ok(Some(at_us)),
        NormalizedSchedule::Interval { every_seconds, anchor_us } => {
            Ok(interval_next(anchor_us, every_seconds, now_us).map(|(us, _)| us))
        }
        NormalizedSchedule::Cron { spec, zone } => {
            let gap = gap_policy(gap_name)
                .ok_or_else(|| invalid_schedule(format!("unknown gap policy {gap_name}"), json!({})))?;
            let fold = fold_policy(fold_name)
                .ok_or_else(|| invalid_schedule(format!("unknown fold policy {fold_name}"), json!({})))?;
            Ok(cron_next(&spec, &zone, now_us, gap, fold, max_days)?.map(|(us, _)| us))
        }
    }
}

// ---------------------------------------------------------------------------
// Actions.
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct CommittedAction {
    pub action_id: String,
    pub name: String,
    pub target_module: String,
    pub arguments: Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ActionResult {
    Ok { name: String, result: Value },
    Err { name: String, error: RefError },
}

impl ActionResult {
    #[allow(dead_code)]
    pub fn name(&self) -> &str {
        match self {
            ActionResult::Ok { name, .. } | ActionResult::Err { name, .. } => name,
        }
    }
    pub fn envelope_value(&self) -> Value {
        match self {
            ActionResult::Ok { name, result } => json!({"name": name, "result": result}),
            ActionResult::Err { name, error } => json!({
                "name": name,
                "result": null,
                "error": error.envelope()
            }),
        }
    }
    pub fn error(&self) -> Option<&RefError> {
        match self {
            ActionResult::Err { error, .. } => Some(error),
            _ => None,
        }
    }
    pub fn result(&self) -> Option<&Value> {
        match self {
            ActionResult::Ok { result, .. } => Some(result),
            _ => None,
        }
    }
}

fn replay_outcome(saved: &Value) -> ActionResult {
    let name = saved
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if saved.get("error").is_some() {
        ActionResult::Err {
            name,
            error: error_envelope_from_value(saved.get("error").expect("present error envelope")),
        }
    } else {
        ActionResult::Ok {
            name,
            result: saved.get("result").cloned().unwrap_or(Value::Null),
        }
    }
}

/// Reconcile a committed action: idempotent replay by committed `action_id`,
/// then the operation itself. `now_utc` is the activation wall instant.
pub fn process_action(
    store: &mut RefStore,
    action: &CommittedAction,
    cfg: &AlarmConfig,
    clock: &mut RefClock,
    now_utc: &str,
) -> ActionResult {
    if let Some(saved) = store.processed_actions.get(&action.action_id) {
        return replay_outcome(saved);
    }
    let outcome = dispatch_action(store, action, cfg, clock, now_utc);
    if action.name == "org.dolly.alarm.list" {
        // Pure read: no durable write, no snapshot bump, no wakeup.
        return outcome;
    }
    store.snapshot_revision += 1;
    store
        .processed_actions
        .insert(action.action_id.clone(), outcome.envelope_value());
    // request_wakeup after each state change; duplicates are harmless.
    produce_wakeup(store, cfg, clock);
    outcome
}

fn require_str<'a>(action: &'a CommittedAction, key: &str) -> Result<&'a str, RefError> {
    action
        .arguments
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_schedule(format!("{key} is required"), action.arguments.clone()))
}

fn require_i64(action: &CommittedAction, key: &str) -> Result<i64, RefError> {
    action
        .arguments
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid_schedule(format!("{key} is required"), action.arguments.clone()))
}

fn delivery_interval(arguments: &Value) -> Result<(String, Option<i64>), RefError> {
    let delivery = arguments
        .get("delivery")
        .ok_or_else(|| invalid_schedule("delivery is required", arguments.clone()))?;
    let mode = delivery
        .get("mode")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_schedule("delivery.mode is required", delivery.clone()))?;
    match mode {
        "once" => Ok(("once".to_string(), None)),
        "repeat_until_acknowledged" => {
            let interval = delivery
                .get("repeat_interval_seconds")
                .and_then(Value::as_i64)
                .ok_or_else(|| {
                    invalid_schedule(
                        "repeat_until_acknowledged requires repeat_interval_seconds",
                        delivery.clone(),
                    )
                })?;
            Ok(("repeat_until_acknowledged".to_string(), Some(interval)))
        }
        other => Err(invalid_schedule(
            format!("unknown delivery mode {other}"),
            delivery.clone(),
        )),
    }
}

/// Normalize the shared create/update argument contract against the frozen
/// config revision: materializes every selected policy, timezone, and tzdb
/// revision into the durable record.
#[allow(clippy::type_complexity)]
fn normalize_create_fields(
    args: &Value,
    cfg: &AlarmConfig,
) -> Result<(String, Value, Value, String, String, String, bool, ZoneRules), RefError> {
    let title = args
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_schedule("title is required", args.clone()))?
        .to_string();
    if title.is_empty() || title.len() > 256 {
        return Err(invalid_schedule(
            "title must be 1..=256 characters",
            json!({"title": title}),
        ));
    }
    let schedule = args
        .get("schedule")
        .cloned()
        .ok_or_else(|| invalid_schedule("schedule is required", args.clone()))?;
    // Validate against the selected defaults (pure).
    // Validation-only pre-check (zone resolution falls back to the canonical
    // definition for the schedule's timezone).
    let _ = normalize_schedule(&schedule, "")?;
    let (_, repeat_interval_value) = delivery_interval(args)?;
    if let Some(interval) = repeat_interval_value {
        if interval < cfg.minimum_repeat_interval_seconds || interval > 315_576_000 {
            return Err(repeat_interval(interval, cfg.minimum_repeat_interval_seconds));
        }
    }
    let misfire = policy_or_default(args, "misfire_policy", &cfg.default_misfire_policy, &["skip", "fire_once", "catch_up"])?;
    let gap = policy_or_default(args, "dst_gap_policy", &cfg.default_dst_gap_policy, &["shift_by_gap", "skip"])?;
    let fold = policy_or_default(args, "dst_fold_policy", &cfg.default_dst_fold_policy, &["earlier", "later", "both"])?;
    let enabled = args.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let timezone = schedule
        .get("timezone")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| cfg.default_timezone.clone());
    let zone = zone_named(&timezone).ok_or_else(|| nonexistent_timezone(&timezone))?;
    let delivery = args.get("delivery").cloned().unwrap_or(json!({"mode": "once"}));
    Ok((title, schedule, delivery, misfire, gap, fold, enabled, zone))
}

fn policy_or_default(
    args: &Value,
    key: &str,
    default: &str,
    allowed: &[&str],
) -> Result<String, RefError> {
    match args.get(key) {
        None => Ok(default.to_string()),
        Some(v) => {
            let name = v
                .as_str()
                .ok_or_else(|| invalid_schedule(format!("{key} must be a string"), args.clone()))?;
            if allowed.contains(&name) {
                Ok(name.to_string())
            } else {
                Err(invalid_schedule(
                    format!("{key} value {name} is not supported"),
                    json!({key: name}),
                ))
            }
        }
    }
}

fn materialize_at_once(schedule: &mut Value) {
    if schedule.get("kind").and_then(Value::as_str) == Some("once") {
        if let Some(at) = schedule.get("at").and_then(Value::as_str) {
            if let Ok(normalized) = normalize_once_at(at) {
                schedule["at"] = json!(normalized);
            }
        }
    }
}

fn op_create(
    store: &mut RefStore,
    action: &CommittedAction,
    cfg: &AlarmConfig,
    _clock: &mut RefClock,
    now_utc: &str,
) -> ActionResult {
    let args = &action.arguments;
    if store.records.len() as i64 >= cfg.maximum_alarms {
        return Err_result(action, alarm_limit(cfg.maximum_alarms));
    }
    let (title, mut schedule, delivery, misfire, gap, fold, enabled, zone) =
        match normalize_create_fields(args, cfg) {
            Ok(v) => v,
            Err(e) => return Err_result(action, e),
        };
    materialize_at_once(&mut schedule);
    let now_us = parse_core_utc(now_utc).expect("activation wall instant");
    let next = match next_occurrence_us(
        &schedule,
        enabled,
        &gap,
        &fold,
        now_us,
        cfg.maximum_iterations_days,
        &zone.revision,
    ) {
        Ok(v) => v,
        Err(e) => return Err_result(action, e),
    };
    let alarm_id = deterministic_alarm_id(store, &action.action_id);
    let record = RefRecord {
        alarm_id: alarm_id.clone(),
        revision: 1,
        title,
        schedule,
        delivery,
        misfire_policy: misfire,
        dst_gap_policy: gap,
        dst_fold_policy: fold,
        enabled,
        created_at: now_utc.to_string(),
        next_occurrence: next.map(format_core_utc),
        tzdb_revision: zone.revision.clone(),
    };
    store.records.insert(alarm_id.clone(), record.clone());
    ActionResult::Ok {
        name: action.name.clone(),
        result: json!({
            "schema": "dolly.alarm.create-result/v1",
            "record": record.to_json(),
        }),
    }
}

fn deterministic_alarm_id(store: &mut RefStore, action_id: &str) -> String {
    // Deterministic v7-shaped identity derived from the committed action so
    // replay/restart remain byte-identical without ambient randomness.
    let seed: i128 = action_id
        .as_bytes()
        .iter()
        .fold(0i128, |acc, b| acc.wrapping_mul(31).wrapping_add(*b as i128));
    let combined = seed + store.snapshot_revision as i128;
    let n = combined.rem_euclid(1_000_000_000_000);
    format!("019535d4-6f00-7a2c-9b31-{n:012}")
}

fn Err_result(action: &CommittedAction, error: RefError) -> ActionResult {
    ActionResult::Err { name: action.name.clone(), error }
}

fn op_get(store: &RefStore, action: &CommittedAction) -> ActionResult {
    let alarm_id = match require_str(action, "alarm_id") {
        Ok(v) => v,
        Err(e) => return Err_result(action, e),
    };
    match store.records.get(alarm_id) {
        Some(record) => ActionResult::Ok {
            name: action.name.clone(),
            result: json!({
                "schema": "dolly.alarm.get-result/v1",
                "record": record.to_json(),
            }),
        },
        None => Err_result(action, occurrence_not_found(alarm_id, None)),
    }
}

fn list_order_key(record: &RefRecord) -> (u8, Option<String>, String) {
    // Ascending (next_occurrence nulls last, alarm_id bytewise tie-break):
    // timestamps first, JSON null after every timestamp.
    match &record.next_occurrence {
        Some(_) => (0, record.next_occurrence.clone(), record.alarm_id.clone()),
        None => (1, None, record.alarm_id.clone()),
    }
}

fn enabled_json(enabled: Option<bool>) -> Value {
    enabled.map(|b| json!(b)).unwrap_or(Value::Null)
}

fn op_list(store: &RefStore, action: &CommittedAction) -> ActionResult {
    let args = &action.arguments;
    let enabled = match args.get("enabled") {
        Some(Value::Bool(b)) => Some(*b),
        Some(Value::Null) => None,
        _ => {
            return Err_result(
                action,
                invalid_schedule("list enabled must be boolean or null", args.clone()),
            )
        }
    };
    let limit = match args.get("limit").and_then(Value::as_i64) {
        Some(l) if (1..=1000).contains(&l) => l,
        _ => {
            return Err_result(
                action,
                invalid_schedule("list limit must be 1..=1000", args.clone()),
            )
        }
    };
    let mut filtered: Vec<&RefRecord> = store
        .records
        .values()
        .filter(|r| enabled.map(|e| r.enabled == e).unwrap_or(true))
        .collect();
    filtered.sort_by(|a, b| {
        list_order_key(a)
            .cmp(&list_order_key(b))
    });
    let snapshot_revision = store.snapshot_revision;
    let start: usize = match args.get("cursor") {
        None | Some(Value::Null) => 0,
        Some(Value::String(raw)) => {
            let parsed: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
            let recorded_snapshot = parsed.get("snapshot_revision").and_then(Value::as_i64);
            let recorded_filter = parsed.get("enabled").cloned().unwrap_or(Value::Null);
            let Some(recorded_snapshot) = recorded_snapshot else {
                return Err_result(action, invalid_cursor("malformed cursor"));
            };
            if recorded_snapshot != snapshot_revision || recorded_filter != enabled_json(enabled) {
                return Err_result(
                    action,
                    invalid_cursor("cursor is only valid with the same filter and snapshot revision"),
                );
            }
            match parsed.get("offset").and_then(Value::as_i64) {
                Some(o) if o >= 0 => o as usize,
                _ => return Err_result(action, invalid_cursor("malformed offset")),
            }
        }
        _ => {
            return Err_result(
                action,
                invalid_schedule("cursor must be a string or null", args.clone()),
            )
        }
    };
    let end = (start + limit as usize).min(filtered.len());
    let page = &filtered[start..end];
    let next_cursor = if end < filtered.len() {
        let mut cursor_obj = serde_json::Map::new();
        cursor_obj.insert("snapshot_revision".into(), json!(snapshot_revision));
        cursor_obj.insert("enabled".into(), enabled_json(enabled));
        cursor_obj.insert("offset".into(), json!(end));
        Some(serde_json::to_string(&Value::Object(cursor_obj)).expect("cursor json"))
    } else {
        None
    };
    ActionResult::Ok {
        name: action.name.clone(),
        result: json!({
            "schema": "dolly.alarm.list-result/v1",
            "records": page.iter().map(|r| r.to_json()).collect::<Vec<_>>(),
            "next_cursor": next_cursor,
        }),
    }
}

fn op_update(
    store: &mut RefStore,
    action: &CommittedAction,
    cfg: &AlarmConfig,
    clock: &mut RefClock,
) -> ActionResult {
    let alarm_id = match require_str(action, "alarm_id") {
        Ok(v) => v.to_string(),
        Err(e) => return Err_result(action, e),
    };
    let expected = match require_i64(action, "expected_revision") {
        Ok(v) => v,
        Err(e) => return Err_result(action, e),
    };
    let replacement = match action.arguments.get("replacement").cloned() {
        Some(r) => r,
        None => {
            return Err_result(
                action,
                invalid_schedule("update requires replacement", action.arguments.clone()),
            )
        }
    };
    let Some(record) = store.records.get(&alarm_id) else {
        return Err_result(action, occurrence_not_found(&alarm_id, None));
    };
    if record.revision != expected {
        return Err_result(action, revision_conflict(&alarm_id, expected, record.revision));
    }
    let (title, mut schedule, delivery, misfire, gap, fold, enabled, zone) =
        match normalize_create_fields(&replacement, cfg) {
            Ok(v) => v,
            Err(e) => return Err_result(action, e),
        };
    materialize_at_once(&mut schedule);
    let old_revision = record.revision;
    store
        .disabled_revisions
        .push((alarm_id.clone(), old_revision));
    for occurrence in store.occurrences.values_mut() {
        if occurrence.alarm_id == alarm_id && occurrence.state == "DUE" {
            occurrence.disabled = true;
        }
    }
    let now_us = clock.wall_unix_us;
    let next = match next_occurrence_us(
        &schedule,
        enabled,
        &gap,
        &fold,
        now_us,
        cfg.maximum_iterations_days,
        &zone.revision,
    ) {
        Ok(v) => v,
        Err(e) => return Err_result(action, e),
    };
    let updated = RefRecord {
        alarm_id: alarm_id.clone(),
        revision: old_revision + 1,
        title,
        schedule,
        delivery,
        misfire_policy: misfire,
        dst_gap_policy: gap,
        dst_fold_policy: fold,
        enabled,
        created_at: record.created_at.clone(),
        next_occurrence: next.map(format_core_utc),
        tzdb_revision: zone.revision.clone(),
    };
    store.records.insert(alarm_id.clone(), updated.clone());
    ActionResult::Ok {
        name: action.name.clone(),
        result: json!({
            "schema": "dolly.alarm.update-result/v1",
            "record": updated.to_json(),
        }),
    }
}

fn op_delete(store: &mut RefStore, action: &CommittedAction) -> ActionResult {
    let alarm_id = match require_str(action, "alarm_id") {
        Ok(v) => v.to_string(),
        Err(e) => return Err_result(action, e),
    };
    let expected = match require_i64(action, "expected_revision") {
        Ok(v) => v,
        Err(e) => return Err_result(action, e),
    };
    let Some(record) = store.records.get(&alarm_id) else {
        return Err_result(action, occurrence_not_found(&alarm_id, None));
    };
    if record.revision != expected {
        return Err_result(action, revision_conflict(&alarm_id, expected, record.revision));
    }
    let deleted_revision = record.revision;
    store
        .disabled_revisions
        .push((alarm_id.clone(), deleted_revision));
    // Disable future claims on pending occurrences of the deleted revision;
    // the occurrence history itself is preserved.
    for occurrence in store.occurrences.values_mut() {
        if occurrence.alarm_id == alarm_id && occurrence.state == "DUE" {
            occurrence.disabled = true;
        }
    }
    store.records.remove(&alarm_id);
    ActionResult::Ok {
        name: action.name.clone(),
        result: json!({
            "schema": "dolly.alarm.delete-result/v1",
            "alarm_id": alarm_id,
            "deleted_alarm_revision": deleted_revision,
        }),
    }
}

fn op_snooze(store: &mut RefStore, action: &CommittedAction, clock: &mut RefClock) -> ActionResult {
    let alarm_id = match require_str(action, "alarm_id") {
        Ok(v) => v.to_string(),
        Err(e) => return Err_result(action, e),
    };
    let occurrence_id = match require_str(action, "occurrence_id") {
        Ok(v) => v.to_string(),
        Err(e) => return Err_result(action, e),
    };
    let expected = match require_i64(action, "expected_revision") {
        Ok(v) => v,
        Err(e) => return Err_result(action, e),
    };
    let new_at = match require_str(action, "new_at") {
        Ok(v) => v.to_string(),
        Err(e) => return Err_result(action, e),
    };
    let Some(record) = store.records.get_mut(&alarm_id) else {
        return Err_result(action, occurrence_not_found(&alarm_id, None));
    };
    if record.revision != expected {
        return Err_result(action, revision_conflict(&alarm_id, expected, record.revision));
    }
    let Some(parent) = store.occurrences.get(&occurrence_id).cloned() else {
        return Err_result(action, occurrence_not_found(&alarm_id, Some(&occurrence_id)));
    };
    if parent.alarm_id != alarm_id {
        return Err_result(action, occurrence_not_found(&alarm_id, Some(&occurrence_id)));
    }
    let new_at_us = match parse_core_utc(&new_at) {
        Ok(us) => us,
        Err(e) => {
            return Err_result(
                action,
                invalid_schedule(format!("invalid new_at: {e}"), json!({"new_at": new_at})),
            )
        }
    };
    // Snooze creates a new one-time child occurrence; the historical
    // scheduled instant is not altered.
    let child_scheduled = format_core_utc(new_at_us);
    let child_id = occurrence_identity(&alarm_id, record.revision + 1, &child_scheduled, 0);
    let tzdb = zone_named(TZ_LA).expect("zone").revision;
    store
        .disabled_revisions
        .push((alarm_id.clone(), record.revision));
    for occurrence in store.occurrences.values_mut() {
        if occurrence.alarm_id == alarm_id && occurrence.state == "DUE" {
            occurrence.disabled = true;
        }
    }
    record.revision += 1;
    record.schedule = json!({"kind": "once", "at": child_scheduled.clone()});
    record.next_occurrence = Some(child_scheduled.clone());
    record.tzdb_revision = tzdb;
    let _ = clock;
    store.occurrences.insert(
        child_id.clone(),
        RefOccurrence {
            occurrence_id: child_id.clone(),
            kind: "original".to_string(),
            parent_occurrence_id: None,
            repeat_ordinal: None,
            alarm_id: alarm_id.clone(),
            alarm_revision: record.revision,
            scheduled_utc: child_scheduled.clone(),
            scheduled_us: new_at_us,
            fold_ordinal: 0,
            state: "DUE".to_string(),
            claim_worker: None,
            claim_expires_mono_us: None,
            fired_at: None,
            lateness_us: None,
            misfire_status: "on_time".to_string(),
            acknowledgement_required: true,
            acknowledged_at: None,
            repeat_due_mono_us: None,
            disabled: false,
        },
    );
    let record = store.records.get(&alarm_id).cloned().expect("snoozed record");
    ActionResult::Ok {
        name: action.name.clone(),
        result: json!({
            "schema": "dolly.alarm.snooze-result/v1",
            "snoozed_occurrence_id": child_id,
            "record": record.to_json(),
        }),
    }
}

fn op_acknowledge(
    store: &mut RefStore,
    action: &CommittedAction,
    _clock: &mut RefClock,
    now_utc: &str,
) -> ActionResult {
    let alarm_id = match require_str(action, "alarm_id") {
        Ok(v) => v.to_string(),
        Err(e) => return Err_result(action, e),
    };
    let occurrence_id = match require_str(action, "occurrence_id") {
        Ok(v) => v.to_string(),
        Err(e) => return Err_result(action, e),
    };
    let expected = match require_i64(action, "expected_revision") {
        Ok(v) => v,
        Err(e) => return Err_result(action, e),
    };
    let Some(record) = store.records.get(&alarm_id).cloned() else {
        return Err_result(action, occurrence_not_found(&alarm_id, None));
    };
    if record.revision != expected {
        return Err_result(action, revision_conflict(&alarm_id, expected, record.revision));
    }
    let occurrence = store.occurrences.get(&occurrence_id).cloned();
    let Some(mut occurrence) = occurrence else {
        return Err_result(action, occurrence_not_found(&alarm_id, Some(&occurrence_id)));
    };
    if occurrence.alarm_id != alarm_id {
        return Err_result(action, occurrence_not_found(&alarm_id, Some(&occurrence_id)));
    }
    let already = occurrence.acknowledged_at.is_some();
    let acknowledged_at = match occurrence.acknowledged_at.clone() {
        Some(first) => first,
        None => {
            occurrence.acknowledged_at = Some(now_utc.to_string());
            now_utc.to_string()
        }
    };
    store
        .occurrences
        .insert(occurrence.occurrence_id.clone(), occurrence.clone());
    // Acknowledgement suppresses this and all later repeats.
    suppress_repeats(store, &occurrence_id);
    ActionResult::Ok {
        name: action.name.clone(),
        result: json!({
            "schema": "dolly.alarm.acknowledge-result/v1",
            "alarm_id": alarm_id,
            "alarm_revision": record.revision,
            "occurrence_id": occurrence_id,
            "acknowledged_at": acknowledged_at,
            "already_acknowledged": already,
        }),
    }
}

fn error_envelope_from_value(value: &Value) -> RefError {
    RefError {
        code: value.get("code").and_then(Value::as_str).unwrap_or("UNKNOWN").to_string(),
        retryable: value.get("retryable").and_then(Value::as_bool).unwrap_or(false),
        outcome: value
            .get("outcome")
            .and_then(Value::as_str)
            .unwrap_or("not_applied")
            .to_string(),
        message: value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        details: value.get("details").cloned().unwrap_or(Value::Null),
    }
}

fn dispatch_action(
    store: &mut RefStore,
    action: &CommittedAction,
    cfg: &AlarmConfig,
    clock: &mut RefClock,
    now_utc: &str,
) -> ActionResult {
    match action.name.as_str() {
        "org.dolly.alarm.create" => op_create(store, action, cfg, clock, now_utc),
        "org.dolly.alarm.get" => op_get(store, action),
        "org.dolly.alarm.list" => op_list(store, action),
        "org.dolly.alarm.update" => op_update(store, action, cfg, clock),
        "org.dolly.alarm.delete" => op_delete(store, action),
        "org.dolly.alarm.snooze" => op_snooze(store, action, clock),
        "org.dolly.alarm.acknowledge" => op_acknowledge(store, action, clock, now_utc),
        other => Err_result(
            action,
            invalid_schedule(
                format!("unknown org.dolly.alarm action name {other}"),
                json!({"action_name": other}),
            ),
        ),
    }
}

// ---------------------------------------------------------------------------
// Due processing: materialization, claims, misfire, repeats, wakeups.
// ---------------------------------------------------------------------------

/// Materialize the due occurrences of a single record from its current
/// `next_occurrence` chain (never synthesizing an occurrence whose schedule
/// did not match), and advance the record's next occurrence. Returns the
/// materialized occurrences; the caller batches them into the store.
#[allow(clippy::type_complexity)]
fn materialize_record_due(
    store: &mut RefStore,
    record: &RefRecord,
    now_wall_us: i128,
    cap: usize,
) -> (Vec<RefOccurrence>, Option<String>) {
    let mut out: Vec<RefOccurrence> = Vec::new();
    let mut from = match &record.next_occurrence {
        Some(t) => match parse_core_utc(t) {
            Ok(us) => us,
            Err(_) => return (out, record.next_occurrence.clone()),
        },
        None => return (out, None),
    };
    let mut advanced: Option<String> = None;
    let gap_name = record.dst_gap_policy.as_str();
    let fold_name = record.dst_fold_policy.as_str();
    let mut iterated = 0usize;
    loop {
        if from > now_wall_us {
            break;
        }
        if iterated >= cap {
            break;
        }
        iterated += 1;
        let Some(materialized) = occurrence_at(store, record, from, gap_name, fold_name) else {
            break;
        };
        let occurrence = RefOccurrence {
            occurrence_id: materialized.0,
            kind: "original".to_string(),
            parent_occurrence_id: None,
            repeat_ordinal: None,
            alarm_id: record.alarm_id.clone(),
            alarm_revision: record.revision,
            scheduled_utc: materialized.1.clone(),
            scheduled_us: from,
            fold_ordinal: materialized.2,
            state: "DUE".to_string(),
            claim_worker: None,
            claim_expires_mono_us: None,
            fired_at: None,
            lateness_us: None,
            misfire_status: "on_time".to_string(),
            acknowledgement_required: true,
            acknowledged_at: None,
            repeat_due_mono_us: None,
            disabled: false,
        };
        if store.occurrences.contains_key(&occurrence.occurrence_id) || out.iter().any(|o| o.occurrence_id == occurrence.occurrence_id) {
            break;
        }
        advanced = materialized.3.clone();
        out.push(occurrence);
        match materialized.3 {
            Some(next) => match parse_core_utc(&next) {
                Ok(next_us) if next_us > from => from = next_us,
                _ => break,
            },
            None => break,
        }
    }
    (out, advanced)
}

/// Derive the occurrence identity at instant `from_us` and the next future
/// occurrence. Returns (occurrence_id, scheduled_utc, fold_ordinal, next_after).
fn occurrence_at(
    store: &mut RefStore,
    record: &RefRecord,
    from_us: i128,
    gap_name: &str,
    fold_name: &str,
) -> Option<(String, String, i64, Option<String>)> {
    let max_days = default_alarm_config(1).maximum_iterations_days;
    let scheduled_utc = format_core_utc(from_us);
    let gap = gap_policy(gap_name)?;
    let fold = fold_policy(fold_name)?;
    match normalize_schedule(&record.schedule, &record.tzdb_revision).ok()? {
        NormalizedSchedule::Once { at_us } => {
            if from_us != at_us {
                return None;
            }
            let id = occurrence_identity(&record.alarm_id, record.revision, &scheduled_utc, 0);
            Some((id, scheduled_utc, 0, None))
        }
        NormalizedSchedule::Interval { every_seconds, anchor_us } => {
            let next = interval_next(anchor_us, every_seconds, from_us);
            let id = occurrence_identity(&record.alarm_id, record.revision, &scheduled_utc, 0);
            Some((id, scheduled_utc, 0, next.map(|(us, _)| format_core_utc(us))))
        }
        NormalizedSchedule::Cron { spec, zone } => {
            // Find the fold ordinal of the instant at `from`.
            let ordinal = cron_next(&spec, &zone, from_us - 1, gap, fold, max_days)
                .ok()
                .flatten()
                .filter(|(us, _)| *us == from_us)
                .map(|(_, ordinal)| ordinal)
                .unwrap_or(0);
            let next = cron_next(&spec, &zone, from_us, gap, fold, max_days)
                .ok()
                .flatten()
                .map(|(us, _)| format_core_utc(us));
            let id = occurrence_identity(&record.alarm_id, record.revision, &scheduled_utc, ordinal);
            let _ = store;
            Some((id, scheduled_utc, ordinal, next))
        }
    }
}

/// Claim a DUE occurrence through compare-and-set with a finite worker lease.
/// Competing workers converge: one holder wins; a loser observes contention.
/// An expired claim never authorizes a blind retry — the caller MUST
/// reconcile against the Runtime Activation outcome first.
pub fn claim(
    store: &mut RefStore,
    occurrence_id: &str,
    worker: &str,
    mono_now_us: i128,
    lease_us: i128,
) -> Result<(), RefError> {
    if store.database_unavailable {
        return Err(database_unavailable("claim compare-and-set"));
    }
    let Some(occ) = store.occurrences.get_mut(occurrence_id) else {
        return Err(occurrence_not_found("?", Some(occurrence_id)));
    };
    if occ.disabled {
        return Err(runtime_outcome_unknown(occurrence_id));
    }
    match occ.state.as_str() {
        "DUE" => {
            occ.state = "CLAIMED".to_string();
            occ.claim_worker = Some(worker.to_string());
            occ.claim_expires_mono_us = Some(mono_now_us + lease_us);
            Ok(())
        }
        "CLAIMED" => {
            let expired = occ.claim_expires_mono_us.map(|exp| mono_now_us > exp).unwrap_or(false);
            if expired {
                return Err(runtime_outcome_unknown(occurrence_id));
            }
            Err(RefError::new(
                CODE_ALREADY_CLAIMED,
                false,
                "not_applied",
                "a competing worker holds the claim".to_string(),
                json!({"occurrence_id": occurrence_id, "claim_worker": occ.claim_worker}),
            ))
        }
        _ => Err(RefError::new(
            CODE_ALREADY_CLAIMED,
            false,
            "not_applied",
            "occurrence is no longer due".to_string(),
            json!({"occurrence_id": occurrence_id, "state": occ.state}),
        )),
    }
}

/// Reconcile an expired claim against the Runtime Activation outcome: if the
/// outcome committed, the occurrence becomes FIRED with its original identity
/// (no duplicate); otherwise the expired claim is released for retry with the
/// SAME occurrence and Activation identity.
pub fn reconcile_expired_claim(
    store: &mut RefStore,
    occurrence_id: &str,
    runtime_outcome_committed: bool,
    now_wall_us: i128,
) -> Result<(), RefError> {
    let Some(occ) = store.occurrences.get_mut(occurrence_id) else {
        return Err(occurrence_not_found("?", Some(occurrence_id)));
    };
    if runtime_outcome_committed {
        occ.state = "FIRED".to_string();
        occ.fired_at = occ.fired_at.clone().or_else(|| Some(format_core_utc(now_wall_us)));
        return Ok(());
    }
    if occ.state == "CLAIMED" {
        occ.state = "DUE".to_string();
        occ.claim_worker = None;
        occ.claim_expires_mono_us = None;
    }
    Ok(())
}

fn suppress_repeats(store: &mut RefStore, parent_occurrence_id: &str) {
    for occ in store.occurrences.values_mut() {
        if occ.kind == "repeat"
            && occ.parent_occurrence_id.as_deref() == Some(parent_occurrence_id)
            && (occ.state == "DUE" || occ.state == "CLAIMED")
        {
            occ.disabled = true;
        }
    }
}

fn mark_missed(store: &mut RefStore, occurrence_id: &str) {
    if let Some(occ) = store.occurrences.get_mut(occurrence_id) {
        occ.state = "MISSED".to_string();
        occ.misfire_status = "missed".to_string();
    }
}

/// Schedule the next repeat for `repeat_until_acknowledged` originals at a
/// fixed elapsed interval from the first committed firing; monotonic governs
/// the local repeat wait.
fn schedule_next_repeat(
    store: &mut RefStore,
    parent: &RefOccurrence,
    interval_seconds: i64,
    first_fired_mono_us: i128,
) {
    let next_ordinal = store
        .occurrences
        .values()
        .filter(|o| o.kind == "repeat" && o.parent_occurrence_id.as_deref() == Some(parent.occurrence_id.as_str()))
        .filter_map(|o| o.repeat_ordinal)
        .max()
        .unwrap_or(0)
        + 1;
    let interval_us = interval_seconds as i128 * 1_000_000;
    let repeat_due_mono_us = first_fired_mono_us + next_ordinal as i128 * interval_us;
    let scheduled_us = parent
        .fired_at
        .as_deref()
        .and_then(|at| parse_core_utc(at).ok())
        .map(|base| base + next_ordinal as i128 * interval_us)
        .unwrap_or(repeat_due_mono_us);
    let scheduled_utc = format_core_utc(scheduled_us);
    let repeat_id = repeat_identity(&parent.occurrence_id, next_ordinal);
    if store.occurrences.contains_key(&repeat_id) {
        return;
    }
    store.occurrences.insert(
        repeat_id.clone(),
        RefOccurrence {
            occurrence_id: repeat_id,
            kind: "repeat".to_string(),
            parent_occurrence_id: Some(parent.occurrence_id.clone()),
            repeat_ordinal: Some(next_ordinal),
            alarm_id: parent.alarm_id.clone(),
            alarm_revision: parent.alarm_revision,
            scheduled_utc: scheduled_utc.clone(),
            scheduled_us,
            fold_ordinal: 0,
            state: "DUE".to_string(),
            claim_worker: None,
            claim_expires_mono_us: None,
            fired_at: None,
            lateness_us: None,
            misfire_status: "repeat".to_string(),
            acknowledgement_required: true,
            acknowledged_at: None,
            repeat_due_mono_us: Some(repeat_due_mono_us),
            disabled: false,
        },
    );
}

/// Fire a CLAIMED occurrence (only the claim holder may prepare output).
/// Returns the due-event row; `None` when the occurrence was not claimable.
pub fn fire(
    store: &mut RefStore,
    occurrence_id: &str,
    cfg: &AlarmConfig,
    clock: &mut RefClock,
    now_utc: &str,
) -> Result<Option<FiredEvent>, RefError> {
    if store.database_unavailable {
        return Err(database_unavailable("committed output transaction"));
    }
    if store.host_output_failed {
        // Host output failure leaves the occurrence retryable with the same
        // identity: state stays CLAIMED and the finite lease governs retry.
        return Err(RefError::new(
            "HOST_OUTPUT_FAILED",
            true,
            "unknown",
            "the Host output path failed after the claim".to_string(),
            json!({"occurrence_id": occurrence_id}),
        ));
    }
    let Some(occ) = store.occurrences.get_mut(occurrence_id) else {
        return Err(occurrence_not_found("?", Some(occurrence_id)));
    };
    if occ.state != "CLAIMED" {
        return Ok(None);
    }
    let now_us = parse_core_utc(now_utc).expect("wall instant");
    let lateness_us = now_us - occ.scheduled_us;
    occ.state = "FIRED".to_string();
    occ.fired_at = Some(now_utc.to_string());
    occ.lateness_us = Some(lateness_us);
    occ.claim_worker = None;
    occ.claim_expires_mono_us = None;
    occ.misfire_status = if lateness_us == 0 {
        "on_time".to_string()
    } else if lateness_us <= cfg.misfire_grace_seconds as i128 * 1_000_000 {
        "within_grace".to_string()
    } else {
        "catch_up".to_string()
    };
    let is_original = occ.kind != "repeat";
    let parent_id = occ.parent_occurrence_id.clone();
    let repeat_ordinal = occ.repeat_ordinal;
    let alarm_id = occ.alarm_id.clone();
    let alarm_revision = occ.alarm_revision;
    let occurrence_id_owned = occ.occurrence_id.clone();
    let scheduled_at = occ.scheduled_utc.clone();
    let acknowledgement_requirement = if occ.acknowledgement_required {
        "repeat_until_acknowledged".to_string()
    } else {
        "once".to_string()
    };
    let title = store
        .records
        .get(&alarm_id)
        .map(|r| r.title.clone())
        .unwrap_or_default();
    let event = FiredEvent {
        schema: EVENT_SCHEMA.to_string(),
        alarm_id: alarm_id.clone(),
        occurrence_id: occurrence_id_owned.clone(),
        alarm_revision,
        title,
        scheduled_at: scheduled_at.clone(),
        fired_at: now_utc.to_string(),
        lateness_seconds: lateness_us.div_euclid(1_000_000) as i64,
        misfire_status: occ.misfire_status.clone(),
        acknowledgement_requirement: acknowledgement_requirement.clone(),
        parent_occurrence_id: parent_id.clone(),
        repeat_ordinal,
    };
    if let Some(interval) = store
        .records
        .get(&alarm_id)
        .and_then(|r| r.delivery.get("repeat_interval_seconds"))
        .and_then(Value::as_i64)
    {
        // Repeat chain: every unacknowledged firing (original or repeat) of a
        // repeat_until_acknowledged delivery schedules the next repeat at a
        // fixed elapsed interval from the first committed firing.
        let parent_id = store
            .occurrences
            .get(&occurrence_id_owned)
            .and_then(|o| o.parent_occurrence_id.clone())
            .unwrap_or_else(|| occurrence_id_owned.clone());
        let acked = store
            .occurrences
            .get(&parent_id)
            .and_then(|o| o.acknowledged_at.clone())
            .is_some();
        if !acked {
            let first_fired_mono = if is_original {
                clock.mono_us
            } else {
                store.first_fired_mono.get(&alarm_id).copied().unwrap_or(clock.mono_us)
            };
            if is_original {
                store.first_fired_mono.insert(alarm_id.clone(), first_fired_mono);
            }
            if let Some(parent) = store.occurrences.get(&parent_id).cloned() {
                schedule_next_repeat(store, &parent, interval, first_fired_mono);
            }
        }
    }
    store.fired_events.push(event.clone());
    Ok(Some(event))
}

/// One due-processing pass (a wakeup): materializes due occurrences from the
/// Materialize the due occurrences of every enabled record from its
/// next-occurrence chain (never synthesizing an occurrence whose schedule did
/// not match) and advance each record's next occurrence. Exposed so tests can
/// hold DUE rows before a claim pass.
pub fn materialize_due(
    store: &mut RefStore,
    cfg: &AlarmConfig,
    clock: &mut RefClock,
) -> Result<(), RefError> {
    if store.database_unavailable {
        return Err(database_unavailable("occurrence materialization"));
    }
    let now_wall_us = clock.wall_unix_us;
    let cap = (cfg.maximum_catch_up_count + cfg.maximum_iterations_days) as usize;
    let record_ids: Vec<String> = store.records.keys().cloned().collect();
    for alarm_id in record_ids {
        let record = store.records.get(&alarm_id).cloned();
        let Some(record) = record else { continue };
        if !record.enabled {
            continue;
        }
        let (occurrences, advanced) = materialize_record_due(store, &record, now_wall_us, cap);
        for occ in occurrences {
            store.occurrences.insert(occ.occurrence_id.clone(), occ);
        }
        if let Some(record) = store.records.get_mut(&alarm_id) {
            if let Some(next) = advanced {
                record.next_occurrence = Some(next);
            }
        }
    }
    Ok(())
}

/// One due-processing pass (a wakeup): partition due occurrences by misfire
/// grace, apply the misfire policy to older occurrences, fire the within-grace
/// ones in scheduled order, persist the misfire handling before scheduling the
/// next future occurrence, and re-request the next wakeup.
pub fn process_due(
    store: &mut RefStore,
    cfg: &AlarmConfig,
    clock: &mut RefClock,
) -> Result<TickOutcome, RefError> {
    let now_wall_us = clock.wall_unix_us;
    let now_mono_us = clock.mono_us;
    if store.database_unavailable {
        return Err(database_unavailable("due processing"));
    }
    let grace_us = cfg.misfire_grace_seconds as i128 * 1_000_000;
    // 1. Materialize due occurrences from record next-occurrence chains.
    materialize_due(store, cfg, clock)?;
    // 2. Gather all due occurrences (originals and repeats).
    let due_ids: Vec<String> = store
        .occurrences
        .iter()
        .filter(|(_, o)| {
            !o.disabled
                && o.acknowledged_at.is_none()
                && match o.kind.as_str() {
                    "repeat" => o.repeat_due_mono_us.map(|due| due <= now_mono_us).unwrap_or(false),
                    _ => o.scheduled_us <= now_wall_us,
                }
        })
        .map(|(id, _)| id.clone())
        .collect();
    let mut due: Vec<RefOccurrence> = due_ids
        .iter()
        .filter_map(|id| store.occurrences.get(id).cloned())
        .collect();
    due.sort_by(|a, b| (a.scheduled_us, a.fold_ordinal).cmp(&(b.scheduled_us, b.fold_ordinal)));
    let (older, recent): (Vec<RefOccurrence>, Vec<RefOccurrence>) =
        due.into_iter().partition(|o| now_wall_us - o.scheduled_us > grace_us);

    let mut outcome = TickOutcome {
        fired_event_ids: Vec::new(),
        missed: Vec::new(),
        diagnostics: Vec::new(),
    };

    // 3. Misfire policy for older occurrences. It MUST never synthesize an
    //    occurrence whose schedule did not match (all rows come from the
    //    materialization step above), and it is persisted before the next
    //    future occurrence is scheduled (record.next_occurrence was advanced
    //    before this partition is applied).
    if !older.is_empty() {
        let policy = older
            .last()
            .and_then(|o| store.records.get(&o.alarm_id))
            .map(|r| r.misfire_policy.clone())
            .unwrap_or_else(|| "fire_once".to_string());
        match policy.as_str() {
            "skip" => {
                for occ in &older {
                    mark_missed(store, &occ.occurrence_id);
                    outcome.missed.push(occ.occurrence_id.clone());
                }
            }
            "fire_once" => {
                for occ in &older[..older.len().saturating_sub(1)] {
                    mark_missed(store, &occ.occurrence_id);
                    outcome.missed.push(occ.occurrence_id.clone());
                }
                if let Some(latest) = older.last() {
                    let now_utc = format_core_utc(now_wall_us);
                    if claim(
                        store,
                        &latest.occurrence_id,
                        "worker-misfire",
                        now_mono_us,
                        30_000_000,
                    )
                    .is_ok()
                    {
                        if let Some(event) = fire(store, &latest.occurrence_id, cfg, clock, &now_utc)? {
                            outcome.fired_event_ids.push(event.occurrence_id.clone());
                        }
                    }
                }
            }
            "catch_up" => {
                let cap_count = cfg.maximum_catch_up_count as usize;
                let fireable: Vec<&RefOccurrence> = older.iter().take(cap_count).collect();
                let missable: Vec<&RefOccurrence> = older.iter().skip(cap_count).collect();
                let now_utc = format_core_utc(now_wall_us);
                for occ in fireable {
                    if claim(
                        store,
                        &occ.occurrence_id,
                        "worker-misfire",
                        now_mono_us,
                        30_000_000,
                    )
                    .is_ok()
                    {
                        if let Some(event) = fire(store, &occ.occurrence_id, cfg, clock, &now_utc)? {
                            outcome.fired_event_ids.push(event.occurrence_id.clone());
                        }
                    }
                }
                for occ in &missable {
                    mark_missed(store, &occ.occurrence_id);
                    outcome.missed.push(occ.occurrence_id.clone());
                }
                if !missable.is_empty() {
                    outcome.diagnostics.push(json!({
                        "reason": "catch_up_cap",
                        "missed_count": missable.len(),
                    }));
                    store.misfire_diagnostics.push(json!({
                        "reason": "catch_up_cap",
                        "missed_count": missable.len(),
                    }));
                }
            }
            _ => {}
        }
    }
    // 4. Within grace: process normally in scheduled order.
    let now_utc = format_core_utc(now_wall_us);
    for occ in &recent {
        if claim(
            store,
            &occ.occurrence_id,
            "worker-wakeup",
            now_mono_us,
            30_000_000,
        )
        .is_ok()
        {
            if let Some(event) = fire(store, &occ.occurrence_id, cfg, clock, &now_utc)? {
                outcome.fired_event_ids.push(event.occurrence_id.clone());
            }
        }
    }
    // 5. request_wakeup after the state change.
    produce_wakeup(store, cfg, clock);
    Ok(outcome)
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TickOutcome {
    pub fired_event_ids: Vec<String>,
    pub missed: Vec<String>,
    pub diagnostics: Vec<Value>,
}

/// The request_wakeup seam: after each state change the Alarm requests the
/// next future instant under the wakeup horizon. Duplicate wakeups collapse.
pub fn produce_wakeup(store: &mut RefStore, cfg: &AlarmConfig, clock: &mut RefClock) {
    let now_us = clock.wall_unix_us;
    let mut best: Option<i128> = None;
    for record in store.records.values() {
        if !record.enabled {
            continue;
        }
        if let Some(next) = &record.next_occurrence {
            if let Ok(us) = parse_core_utc(next) {
                if best.map(|b| us < b).unwrap_or(true) {
                    best = Some(us);
                }
            }
        }
    }
    if let Some(next) = best {
        let horizon = now_us + cfg.wakeup_horizon_seconds as i128 * 1_000_000;
        let target = next.min(horizon);
        let entry = WakeupEntry {
            next_utc_instant: format_core_utc(target),
            wakeup_key: format!("org.dolly.alarm@{}", format_core_utc(target)),
        };
        if store.wakeups.last() != Some(&entry) {
            store.wakeups.push(entry);
        }
    }
}

// ---------------------------------------------------------------------------
// tzdb revision change: deterministic recomputation of future occurrences.
// ---------------------------------------------------------------------------

/// Upgrade the tzdb revision for the store's records: already-fired
/// occurrences keep their exact instants/identities; future not-yet-fired
/// occurrences are recomputed under the new revision and an audit event is
/// appended.
pub fn apply_tzdb_upgrade(
    store: &mut RefStore,
    target_revision: &str,
    cfg: &AlarmConfig,
) -> Result<(), RefError> {
    let mut updated: Vec<RefRecord> = Vec::new();
    for record in store.records.values() {
        let zone_id = record
            .schedule
            .get("timezone")
            .and_then(Value::as_str)
            .unwrap_or(TZ_LA);
        let Some(new_zone) = zone_named_with_revision(zone_id, target_revision) else {
            continue;
        };
        // Recompute the future (not already-fired) occurrences from the last
        // processed boundary: the latest fired/missed scheduled instant, or
        // the record creation instant when nothing has fired yet.
        let last_boundary = store
            .occurrences
            .values()
            .filter(|o| {
                o.alarm_id == record.alarm_id && (o.state == "FIRED" || o.state == "MISSED")
            })
            .map(|o| o.scheduled_us)
            .max()
            .or_else(|| parse_core_utc(&record.created_at).ok());
        let boundary = last_boundary.unwrap_or_else(|| parse_core_utc(SPEC_CREATED_AT).expect("anchor"));
        let recomputed = next_occurrence_us(
            &record.schedule,
            record.enabled,
            &record.dst_gap_policy,
            &record.dst_fold_policy,
            boundary,
            cfg.maximum_iterations_days,
            target_revision,
        )?;
        let changed = recomputed.map(format_core_utc).as_ref() != record.next_occurrence.as_ref();
        store.audit.push(AuditEntry {
            alarm_id: record.alarm_id.clone(),
            from_revision: record.tzdb_revision.clone(),
            to_revision: target_revision.to_string(),
            recomputed_occurrences: if changed { 1 } else { 0 },
            retained_fired: store
                .occurrences
                .values()
                .filter(|o| {
                    o.alarm_id == record.alarm_id && (o.state == "FIRED" || o.state == "MISSED")
                })
                .count() as i64,
        });
        let mut updated_record = record.clone();
        updated_record.tzdb_revision = new_zone.revision.clone();
        updated_record.next_occurrence = recomputed.map(format_core_utc);
        updated.push(updated_record);
    }
    for record in updated {
        store.records.insert(record.alarm_id.clone(), record);
    }
    store.snapshot_revision += 1;
    Ok(())
}
