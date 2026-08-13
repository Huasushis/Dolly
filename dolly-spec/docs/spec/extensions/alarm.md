# Alarm Extension Specification

Status: **normative for Dolly v1**.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

## 1. Responsibility and clock

The Alarm Extension stores schedules, computes occurrences, requests Host wakeups, emits due events, and processes snooze and acknowledgement actions. It MUST use the injected Runtime `Clock`; tests MUST be able to replace both wall and monotonic time. It MUST NOT poll at high frequency, append directly to a Page, mutate a committed Block, or assume that one process is the only scheduler.

The built-in v1 package Extension ID is `org.dolly.alarm`; every stable Alarm
Action is owned by that exact ID.

All stored instants are UTC. Calendar interpretation uses an IANA time-zone database revision recorded with the alarm. A tzdb upgrade MUST trigger deterministic recomputation of future, not already-fired, occurrences and an audit event.

## 2. Configuration and record

Global configuration MUST define default IANA timezone, default misfire/DST
policies, maximum alarms, maximum catch-up count, minimum repeat interval,
wakeup horizon, misfire grace, and retention. Raw create/update arguments omit a
policy to select the default from that operation's frozen config revision. The
normalizer materializes every selected policy, timezone, and tzdb revision into
the durable record; a persisted record never inherits a later default.

An alarm record MUST conform to
[`schemas/alarm-record.schema.json`](../../../schemas/alarm-record.schema.json).
For example:

```json
{
  "alarm_id": "019535d4-6f00-7a2c-9b31-8e11d2345000",
  "revision": 4,
  "title": "Submit assignment",
  "schedule": {
    "kind": "cron_v1",
    "expression": "30 8 * * 1-5",
    "timezone": "America/Los_Angeles"
  },
  "delivery": {
    "mode": "repeat_until_acknowledged",
    "repeat_interval_seconds": 300
  },
  "misfire_policy": "fire_once",
  "dst_gap_policy": "shift_by_gap",
  "dst_fold_policy": "earlier",
  "enabled": true,
  "created_at": "2026-08-09T15:00:00.000000Z",
  "next_occurrence": "2026-08-10T15:30:00.000000Z",
  "tzdb_revision": "2026b"
}
```

Create is idempotent by the committed `action_id` and returns the existing
created record on replay. Update and delete MUST carry `expected_revision` and
use optimistic revision checking. Unknown fields MUST be rejected.

## 3. Schedule kinds

Stable v1 supports:

1. `once`: raw Action input accepts an RFC3339 timestamp with explicit `Z` or
   numeric offset. It represents exactly that instant; timezone is display
   metadata only. Before persistence it is converted without loss of the
   represented instant to the Core six-digit UTC `Z` form required by
   `alarm-record.schema.json`.
2. `interval`: a positive integer duration in seconds and an explicit UTC anchor. Occurrences are `anchor + n*duration`; DST has no effect.
3. `cron_v1`: five fields `minute hour day_of_month month day_of_week` plus an
   IANA timezone. Raw Action input MAY omit timezone to select the frozen global
   default; the durable record always contains the selected name. Fields allow
   `*`, comma lists, numeric ranges, and positive steps; names and `L`, `W`, `#`,
   or seconds are forbidden. Day of week is `0..6`, Sunday `0`. If both
   day-of-month and day-of-week are restricted, a local time matches when either
   field matches, following Vixie cron semantics. If either field is `*`, the
   restricted field MUST match.

Cron matching occurs in local civil time. For a nonexistent local time, `shift_by_gap` adds the exact DST gap duration to the requested local time and fires at that resolved instant; `skip` creates no occurrence. For an ambiguous folded local time, `earlier` selects the earlier UTC instant, `later` the later instant, and `both` creates two distinct occurrences. Defaults are `shift_by_gap` and `earlier`.

Schedule evaluation MUST be pure for `(alarm revision, tzdb revision, last boundary, next boundary)` and MUST have a configured iteration bound.

## 4. Occurrence identity and competing schedulers

Each occurrence ID MUST be `sha256:` plus the lowercase hexadecimal SHA-256 of
the UTF-8 JCS bytes of
`["dolly.alarm.occurrence/v1", alarm_id, alarm_revision,
scheduled_utc_instant, fold_ordinal]`. `scheduled_utc_instant` uses the Core
microsecond UTC form and `fold_ordinal` is `0` for an unambiguous or earlier
instant and `1` for the later instant. A repeat-delivery ID uses the same rule
over `["dolly.alarm.repeat/v1", occurrence_id, repeat_ordinal]`. These identities
MUST survive restart.

Before emitting, a worker MUST claim the occurrence through a durable compare-and-set from `DUE` to `CLAIMED`, with a finite worker lease. Only the claim holder may prepare output. A committed output moves it to `FIRED`. If the worker dies before Core commit, claim expiry permits reconciliation and retry with the same occurrence and Activation identity; it MUST not create a new occurrence.

Multiple workers or wakeups racing on the same alarm MUST therefore converge on one logical firing. Core output deduplication protects internal retries, but an external Channel may still have unknown delivery outcome and follows its own ledger.

## 5. Misfire semantics

At recovery or each wakeup, due occurrences are partitioned by `now - scheduled_at <= misfire_grace`.

- Within grace, each due occurrence is processed normally in scheduled order.
- `skip`: older occurrences become `MISSED` and emit no reminder.
- `fire_once`: the most recent older occurrence is fired immediately with original `scheduled_at` and `fired_at=now`; all older ones become `MISSED`.
- `catch_up`: older occurrences are fired in scheduled order up to `max_catch_up`; remaining older occurrences become `MISSED` and a bounded diagnostic records their count.

The default is `fire_once`. Misfire handling MUST be persisted before scheduling the next future occurrence. It MUST never synthesize an occurrence whose schedule did not match.

## 6. Inputs, outputs, and actions

Stable actions are `org.dolly.alarm.create`, `org.dolly.alarm.list`,
`org.dolly.alarm.get`, `org.dolly.alarm.update`,
`org.dolly.alarm.delete`, `org.dolly.alarm.snooze`, and
`org.dolly.alarm.acknowledge`. Each MUST target a Module configured with
Extension owner `org.dolly.alarm` and arrives only inside a committed Block
selected into an Activation. The Runtime validates the common envelope and
reachability at Block commit; the Alarm validates the operation-specific schema
and capability during that Activation. Each consumed Action produces an
`ActionResult` JSON Part in the Activation's single optional output BlockDraft.
Every complete committed Action MUST conform to
[`schemas/alarm-action.schema.json`](../../../schemas/alarm-action.schema.json),
which freezes the required arguments, revision guards, target requirement, and
unknown-field rejection for all seven names. Occurrence IDs are the canonical
`sha256:` digest of the identity tuple in Section 4.
The Action schema is the raw operation-input contract; omitted policy overrides
are normalized from the frozen config revision. It is intentionally distinct
from the fully materialized durable AlarmRecord schema.

For a successful action, `ActionResult.result` MUST conform to the exact
operation fragment below. A failed or unknown action follows the common
`ActionResult` rule and has `result: null`; it MUST NOT return a partial record.

| Action | Successful result schema |
|---|---|
| `org.dolly.alarm.create` | `schemas/alarm-result.schema.json#/$defs/CreateResult` |
| `org.dolly.alarm.list` | `schemas/alarm-result.schema.json#/$defs/ListResult` |
| `org.dolly.alarm.get` | `schemas/alarm-result.schema.json#/$defs/GetResult` |
| `org.dolly.alarm.update` | `schemas/alarm-result.schema.json#/$defs/UpdateResult` |
| `org.dolly.alarm.delete` | `schemas/alarm-result.schema.json#/$defs/DeleteResult` |
| `org.dolly.alarm.snooze` | `schemas/alarm-result.schema.json#/$defs/SnoozeResult` |
| `org.dolly.alarm.acknowledge` | `schemas/alarm-result.schema.json#/$defs/AcknowledgeResult` |

Every row is a `result_schema.uri`; all rows bind the same verified transitive
bundle digest for `alarm-result.schema.json` and semantic validator
`{"id":"org.dolly.validator.alarm-result","revision":1}`. The
ActionContract argument binding names the applicable installed argument schema
bundle and uses its declared validator, or `null` when JSON Schema is complete.

The result `schema` discriminator is mandatory. List order is ascending by
`(next_occurrence nulls last, alarm_id)` within the pinned snapshot; a cursor
is valid only with the same filter and snapshot revision. Create replay returns
the byte-identical logical record. Acknowledgement replay preserves the first
`acknowledged_at` and returns `already_acknowledged: true`.

After JSON Schema validation, the bound Runtime validator MUST enforce that
ordering by comparing canonical UTC timestamp strings first, placing JSON
`null` after every timestamp, and comparing `alarm_id` bytewise as the tie
breaker. It MUST reject duplicate or descending keys and perform no clock,
database, or tzdb lookup.

A due output Block draft MUST include one or more ordered alarm events. Each event includes alarm and occurrence IDs, alarm revision, title, scheduled time, actual firing time, lateness, misfire status, and acknowledgement requirement. Simultaneous due events MAY share one Block, but each retains independent identity and state.

The Extension MUST call `request_wakeup(next_utc_instant, wakeup_key)` after each state change. Duplicate wakeups are harmless. A wall-clock jump or resume event MUST cause recomputation; monotonic time MUST govern local repeat waits between recomputations.

## 7. Snooze, acknowledgement, and repeat races

Snooze creates a new one-time schedule revision or child occurrence as specified by the action and MUST identify the occurrence being snoozed. It MUST NOT alter the historical scheduled instant.

Acknowledgement uses compare-and-set on the occurrence acknowledgement state and is idempotent. For `repeat_until_acknowledged`, repeat ordinal zero is the original firing; later repeats occur at fixed elapsed intervals from the first committed firing unless configuration specifies a new schedule.

The race rule is:

- if acknowledgement commits before a repeat claim, that and all later repeats MUST be suppressed;
- if a repeat claim commits first, that repeat MAY complete once, but acknowledgement MUST suppress every subsequent ordinal;
- replay of either action returns the existing state.

An update or delete disables future claims for old revisions but MUST preserve occurrence history and action reconciliation.

## 8. Failure semantics

Database failure MUST prevent occurrence claim and state advancement. Host output failure leaves the occurrence retryable with the same identity. An expired worker claim MUST not be treated as evidence that no output was committed; the worker MUST query Runtime Activation outcome before retrying.

Errors MUST use the common error envelope. Stable `code` values MUST distinguish invalid schedule, nonexistent timezone, revision conflict, iteration bound, alarm limit, repeat interval, occurrence not found, already acknowledged, database unavailable, clock unavailable, and Runtime outcome unknown; alarm-, occurrence-, and schedule-specific fields belong in `details`.

## 9. Conformance tests

Tests MUST use a virtual clock and fixed tzdb fixtures. They MUST cover every cron field rule, DOM/DOW OR semantics, leap day, month end, all DST gap/fold policies, tzdb revision change, wall-clock forward/backward jumps, suspend/resume, every misfire policy and cap, simultaneous alarms, multi-worker claim race, crash before/after claim and Core commit, duplicate wakeup, snooze/update/delete revision races, acknowledgement versus repeat claim, same action replay, ascending/null-last/tie-break list order, duplicate list keys, result-validator revision mismatch, and proof that the Extension cannot append directly to a Page or advance a cursor.

`REQ-ALARM-001` — A fixed alarm revision, tzdb revision, boundary interval, and
clock sequence MUST produce one deterministic ordered occurrence set, including
the specified DST gap/fold ordinals.
