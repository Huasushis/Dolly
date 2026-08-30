//! Versioned timezone-rule interface and fixed deterministic fixtures.
//!
//! Calendar interpretation uses the IANA time-zone database revision
//! recorded with an alarm. This crate ships no system tzdb and never consults
//! host locale data; a `ZoneRulesProvider` resolves a zone name plus a tzdb
//! revision to explicit UTC transition rules. The runtime bridge injects a
//! provider later (real tzdb or a richer fixture set); this crate ships the
//! fixture provider the conformance suite and the first-artifact proof run
//! against.
//!
//! A `FixedZone` is `{ base_offset_minutes, transitions }`: before the first
//! transition the base offset applies; after each transition the new offset
//! applies. That compact form is sufficient to derive every offset, gap, and
//! fold for the covered years.

use crate::error::{AlarmError, AlarmErrorCode};
use crate::time::{CivilTime, US_PER_MINUTE, US_PER_SECOND, UsInstant, civil_to_us, us_to_civil};
use std::collections::HashMap;
use std::sync::Arc;

/// One offset transition at a UTC instant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ZoneTransition {
    /// UTC instant the new offset starts applying.
    pub at_us: UsInstant,
    /// New UTC offset in minutes.
    pub to_offset_minutes: i32,
}

/// Explicit transition rules for one zone at one tzdb revision.
#[derive(Debug, Clone)]
pub struct FixedZone {
    /// Combined identifier, e.g. `America/New_York-2025a`.
    pub id: String,
    /// Offset in minutes applying before the first transition.
    pub base_offset_minutes: i32,
    /// Transitions in ascending order.
    pub transitions: Vec<ZoneTransition>,
}

impl FixedZone {
    /// Offset in minutes that applies at `us`.
    pub fn offset_minutes_at(&self, us: UsInstant) -> i32 {
        let mut offset = self.base_offset_minutes;
        for transition in &self.transitions {
            if us >= transition.at_us {
                offset = transition.to_offset_minutes;
            } else {
                break;
            }
        }
        offset
    }

    /// Resolve a civil time to the UTC instants that actually exist:
    /// zero entries for a gap, one for an unambiguous time, and two (earlier
    /// first) for a fold, in ascending UTC order. `fold_ordinal` is the
    /// index in that order.
    pub fn resolve_civil(&self, civil: &CivilTime) -> Vec<ResolvedCivil> {
        let nominal_us = civil_to_us(civil);
        let mut offsets: Vec<i32> = vec![self.base_offset_minutes];
        for transition in &self.transitions {
            if !offsets.contains(&transition.to_offset_minutes) {
                offsets.push(transition.to_offset_minutes);
            }
        }
        let mut resolved: Vec<ResolvedCivil> = Vec::new();
        for &offset in &offsets {
            let candidate_us = nominal_us
                .checked_sub(offset as i64 * US_PER_MINUTE)
                .unwrap_or(nominal_us);
            if self.offset_minutes_at(candidate_us) == offset {
                resolved.push(ResolvedCivil {
                    us: candidate_us,
                    offset_minutes: offset,
                    fold_ordinal: 0,
                });
            }
        }
        resolved.sort_by_key(|entry| entry.us);
        for (index, entry) in resolved.iter_mut().enumerate() {
            entry.fold_ordinal = index as u8;
        }
        resolved
    }

    /// Instants an alarm with `shift_by_gap` fires at for a nonexistent civil
    /// time, or `None` when the civil time is not inside a gap at all. Adds
    /// the exact gap duration to the requested local time.
    pub fn shift_by_gap_us(&self, civil: &CivilTime) -> Option<UsInstant> {
        let nominal_us = civil_to_us(civil);
        let mut before = self.base_offset_minutes;
        let mut covering: Option<&ZoneTransition> = None;
        for transition in &self.transitions {
            let after = transition.to_offset_minutes;
            if after != before {
                let local_start_us = transition.at_us + before as i64 * US_PER_MINUTE;
                let local_end_us = transition.at_us + after as i64 * US_PER_MINUTE;
                let (local_lo, local_hi) = if local_start_us <= local_end_us {
                    (local_start_us, local_end_us)
                } else {
                    (local_end_us, local_start_us)
                };
                if nominal_us >= local_lo && nominal_us < local_hi {
                    covering = Some(transition);
                    break;
                }
            }
            before = after;
        }
        let transition = covering?;
        let after = transition.to_offset_minutes as i64;
        let duration_us = (before as i64 - after).abs() * US_PER_MINUTE;
        (nominal_us - after * US_PER_MINUTE).checked_add(duration_us)
    }

    /// Civil time that a UTC instant shows in this zone. `fold_ordinal` is
    /// ignored except to note which fold side produced the instant; the
    /// offset at the resolved instant is authoritative.
    pub fn civil_at(&self, us: UsInstant, _fold_ordinal: u8) -> CivilTime {
        let offset_minutes = self.offset_minutes_at(us);
        us_to_civil(us + offset_minutes as i64 * US_PER_MINUTE)
    }
}

/// One resolved UTC instant for a civil time, with its fold ordinal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedCivil {
    pub us: UsInstant,
    pub offset_minutes: i32,
    /// 0 for unambiguous or earlier; 1 for the later instant of a fold.
    pub fold_ordinal: u8,
}

/// Resolves zone names at a tzdb revision to concrete transition rules.
///
/// Versioned: a rule change between tzdb revisions is observable to the
/// scheduler as a different `FixedZone` for the same zone name, which drives
/// the deterministic future-occurrence recomputation the spec requires.
pub trait ZoneRulesProvider: Send + Sync {
    /// The tzdb revision this provider currently serves.
    fn revision(&self) -> &str;

    /// Resolve a zone at this provider's revision. An unknown zone is the
    /// spec's `NONEXISTENT_TIMEZONE` failure.
    fn zone(&self, zone_name: &str) -> Result<Arc<FixedZone>, AlarmError>;
}

/// The built-in deterministic fixture provider.
///
/// Identifiers combine zone name and revision exactly like the reference
/// alarm slice: `America/New_York-2025a`. A second revision of the same zone
/// (`2026a`) is included so the tzdb-upgrade recomputation can be proven
/// without any network or host tzdb.
pub struct FixtureZoneRulesProvider {
    revision: String,
    zones: HashMap<String, Arc<FixedZone>>,
}

impl FixtureZoneRulesProvider {
    pub fn new(revision: &str) -> Self {
        let mut zones = HashMap::new();
        for zone in fixture_zones() {
            zones.insert(zone.id.clone(), Arc::new(zone));
        }
        Self {
            revision: revision.to_string(),
            zones,
        }
    }
}

impl ZoneRulesProvider for FixtureZoneRulesProvider {
    fn revision(&self) -> &str {
        &self.revision
    }

    fn zone(&self, zone_name: &str) -> Result<Arc<FixedZone>, AlarmError> {
        self.zones.get(zone_name).cloned().ok_or_else(|| {
            let mut details = serde_json::Map::new();
            details.insert(
                "timezone".to_string(),
                serde_json::Value::String(zone_name.to_string()),
            );
            AlarmError::with_details(
                AlarmErrorCode::NonexistentTimezone,
                format!("unknown timezone fixture {zone_name}"),
                details,
            )
        })
    }
}

/// Built-in fixture zones: `America/New_York` for the 2025a and 2026a tzdb
/// revisions. The 2026a revision moves the spring-forward transition so a
/// recomputation across revisions yields different UTC instants for the same
/// civil schedule.
fn fixture_zones() -> Vec<FixedZone> {
    let new_york_2025 = FixedZone {
        id: "America/New_York-2025a".to_string(),
        base_offset_minutes: -300, // EST from 2025-01-01
        transitions: vec![
            ZoneTransition {
                // 2025-03-09T07:00:00Z: 02:00 EST -> 03:00 EDT.
                at_us: 1741503600 * US_PER_SECOND,
                to_offset_minutes: -240,
            },
            ZoneTransition {
                // 2025-11-02T06:00:00Z: 02:00 EDT -> 01:00 EST.
                at_us: 1762072800 * US_PER_SECOND,
                to_offset_minutes: -300,
            },
        ],
    };
    let new_york_2026 = FixedZone {
        id: "America/New_York-2026a".to_string(),
        base_offset_minutes: -300, // EST from 2026-01-01
        transitions: vec![
            ZoneTransition {
                // 2026-03-08T07:00:00Z: 02:00 EST -> 03:00 EDT.
                at_us: 1772348400 * US_PER_SECOND,
                to_offset_minutes: -240,
            },
            ZoneTransition {
                // 2026-11-01T06:00:00Z: 02:00 EDT -> 01:00 EST.
                at_us: 1793624400 * US_PER_SECOND,
                to_offset_minutes: -300,
            },
        ],
    };
    vec![new_york_2025, new_york_2026]
}

/// Combined zone@revision identifier, e.g. `America/New_York-2025a`.
pub fn zone_rules_id(zone_name: &str, tzdb_revision: &str) -> String {
    format!("{zone_name}-{tzdb_revision}")
}
