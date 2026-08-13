# ADR 0007: Opaque versioned carrier for research hints

- Status: Accepted
- Scope: optional Block research hints and experimental consumers
- Compatibility: pre-candidate Block-schema break; no compatibility promise was
  made for the removed draft-only `hints.tensity` number
- Affected requirements: `INV-BLOCK-007`, `REQ-TENSITY-001`,
  `REQ-TENSITY-002`

## Context

The owner proposed `tensity` as an intentionally unresolved hypothesis: its
producer, scale, calibration, interpretation, and even usefulness require
experiments. Encoding a stable `0.001..1000` range and `1.0` default in the Core
Block schema would turn an unvalidated research choice into canonical Block
bytes and an apparent v1 guarantee.

Research still needs a reproducible way to attach candidate values to immutable
inputs. Removing all carrier support would encourage experiments to overload
metadata or introduce incompatible one-off Block schemas.

## Decision

Core defines only a bounded, namespaced opaque envelope. Each entry binds a
qualified name, integer envelope version, immutable payload schema URI and
digest, experiment ID, and canonical-JSON payload. Core preserves the bytes but
does not fetch the schema, interpret the payload, assign defaults, convert
versions, or authorize a consumer.

Use requires a separately enabled, schema-valid research-hint registration
matching the exact envelope identity, plan digest, producer/consumer Module,
and graph/config revision. That registry is an experimental eligibility
capability, not ambient authority and not an Extension RPC capability. Missing,
mismatched, expired, stale, invalid, or disabled entries select the stable
no-hint behavior.

The stable schema therefore does not define `tensity`, a range, a neutral value,
a producer, or a consumer. Any future stable semantics require successful
promotion, a new ADR, and a compatibility plan.

## Alternatives rejected

- Keep `hints.tensity: number` with a fixed range and default: prematurely
  freezes an unsupported scale into Block identity.
- Put research values in general metadata: loses explicit version/schema
  binding and makes accidental production consumption harder to audit.
- Give Core a dynamic schema-fetcher: introduces network, trust, and
  availability semantics into Block validation.
- Remove all hint transport: forces experiments to fork the Block contract.

## Consequences and rollback

The opaque envelope is part of canonical Block bytes, so quotas and canonical
JSON limits apply. Unknown entries remain portable data but have no effect.
Disabling or deleting a registry entry immediately restores stable behavior;
stored Blocks need no migration because Core never depended on the payload.

Before `spec-candidate`, implementations MUST reject the removed direct numeric
shape and accept a structurally valid opaque envelope. `TST-RESEARCH-001`
verifies that unsupported and mismatched hints are ignored without changing
retention or correctness. Rollback of an experiment removes its registry entry
and isolated derived state; it does not rewrite Blocks.
