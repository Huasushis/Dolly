/**
 * Fixed tzdb fixtures for the alarm slice (virtual-clock conformance).
 *
 * Calendar interpretation uses the IANA time-zone database revision recorded
 * with an alarm. The slice ships no system tzdb and never consults host
 * locale data; instead it accepts a fixture identifier such as
 * `America/New_York-2025a` and resolves civil times against that fixture's
 * explicit UTC transition instants. An identifier outside the fixture table is
 * a typed `NONEXISTENT_TIMEZONE` failure, exactly as the spec requires for a
 * timezone the database does not contain.
 *
 * A fixture is `{ baseOffsetMinutes, transitions }`: before the first
 * transition the base offset applies; after each transition the new offset
 * applies. This compact form is sufficient to derive every offset, gap, and
 * fold for the covered year.
 */
import { civilToUs, type CivilTime, type UsInstant } from "./time.js";
import { alarmError } from "./errors.js";

export interface ZoneTransition {
  readonly atUs: UsInstant;
  readonly toOffsetMinutes: number;
}

export interface ZoneFixture {
  readonly id: string;
  readonly baseOffsetMinutes: number;
  readonly transitions: readonly ZoneTransition[];
}

const ZONE_FIXTURES: readonly ZoneFixture[] = [
  {
    id: "America/New_York-2025a",
    baseOffsetMinutes: -300, // EST, from Jan 1 2025
    transitions: [
      {
        // 2025-03-09T07:00:00Z: 02:00 EST -> 03:00 EDT (spring forward).
        atUs: Date.UTC(2025, 2, 9, 7, 0, 0) * 1000,
        toOffsetMinutes: -240, // EDT
      },
      {
        // 2025-11-02T06:00:00Z: 02:00 EDT -> 01:00 EST (fall back).
        atUs: Date.UTC(2025, 10, 2, 6, 0, 0) * 1000,
        toOffsetMinutes: -300, // EST
      },
    ],
  },
];

export function lookupZone(id: string): ZoneFixture {
  for (const fixture of ZONE_FIXTURES) {
    if (fixture.id === id) return fixture;
  }
  throw alarmError("NONEXISTENT_TIMEZONE", `unknown timezone fixture ${id}`, { timezone: id });
}

/** Offset in minutes that applies at `us` for a fixture. */
export function zoneOffsetMinutesAt(zone: ZoneFixture, us: UsInstant): number {
  let offset = zone.baseOffsetMinutes;
  for (const transition of zone.transitions) {
    if (us >= transition.atUs) offset = transition.toOffsetMinutes;
    else break;
  }
  return offset;
}

export interface ResolvedCivil {
  readonly us: UsInstant;
  readonly offsetMinutes: number;
  readonly foldOrdinal: 0 | 1;
}

/**
 * Map a civil time to every UTC instant that actually exists in the zone.
 * Returns zero entries for a gap, one for unambiguous time, and two (earlier
 * first, `foldOrdinal` 0 then 1) for a fold. Deterministic and independent of
 * the host locale.
 */
export function resolveCivilInZone(zone: ZoneFixture, civil: CivilTime): readonly ResolvedCivil[] {
  const nominalUs = civilToUs(civil);
  const offsets = new Set<number>([zone.baseOffsetMinutes]);
  for (const transition of zone.transitions) offsets.add(transition.toOffsetMinutes);
  const resolved: ResolvedCivil[] = [];
  for (const offset of offsets) {
    const candidateUs = nominalUs - offset * 60 * 1_000_000;
    if (zoneOffsetMinutesAt(zone, candidateUs) === offset) {
      resolved.push({ us: candidateUs, offsetMinutes: offset, foldOrdinal: 0 });
    }
  }
  resolved.sort((a, b) => a.us - b.us);
  return resolved.map((entry, index) => ({ ...entry, foldOrdinal: index as 0 | 1 }));
}

/**
 * Instant a `shift_by_gap` alarm fires at for a nonexistent civil time, or
 * null when the civil time is not inside a gap at all. Adds the exact gap
 * duration to the requested local time, per the spec.
 */
export function shiftByGapUs(zone: ZoneFixture, civil: CivilTime): UsInstant | null {
  const nominalUs = civilToUs(civil);
  let before = zone.baseOffsetMinutes;
  let transitionCoveringGap: ZoneTransition | null = null;
  for (const transition of zone.transitions) {
    const after = transition.toOffsetMinutes;
    if (after !== before) {
      const localStartUs = transition.atUs + before * 60 * 1_000_000;
      const localEndUs = transition.atUs + after * 60 * 1_000_000;
      const localLo = Math.min(localStartUs, localEndUs);
      const localHi = Math.max(localStartUs, localEndUs);
      if (nominalUs >= localLo && nominalUs < localHi) {
        transitionCoveringGap = transition;
        break;
      }
    }
    before = after;
  }
  if (transitionCoveringGap === null) return null;
  const after = transitionCoveringGap.toOffsetMinutes;
  const durationUs = Math.abs(after - before) * 60 * 1_000_000;
  return (nominalUs - after * 60 * 1_000_000) + durationUs;
}
