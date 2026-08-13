# Observability and Event Journal Specification

Status: **normative for Dolly v1**.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

`REQ-OBS-001` — Observability conformance MUST satisfy every normative
non-interference, event, redaction, cardinality, durability, backpressure,
health, access, retention, and conformance test obligation in this chapter.

## 1. Goals and non-interference

Observability MUST make a Dolly execution attributable, debuggable, replayable where permitted, and measurable without changing its correctness semantics. Failure, delay, or overload of a non-audit telemetry sink MUST NOT advance a cursor, commit an Activation, retry a side effect, or stop a healthy Runtime.

The system defines three distinct products:

- **telemetry**: logs, metrics, and traces for operations; loss may be bounded and reported;
- **audit records**: security- and configuration-relevant events that require durable append;
- **Event Journal**: a durable semantic event stream used for recovery evidence and deterministic replay inputs.

They MUST NOT be represented as one queue with one retention policy.

## 2. Common event envelope

Every event MUST include `event_name`, schema version, severity, event time, monotonic sequence within its producer, producer identity, and `trace_id` when a trace exists. Applicable events MUST also include:

```text
instance_id       runtime_id        module_id
extension_id      extension_version activation_id
attempt           block_id         page_id
config_revision   trace_id          span_id
model_profile_revision              provider_request_id
```

Missing optional identifiers MUST be omitted; JSON `null` MUST NOT be used as a substitute for absence. Producers MUST NOT invent placeholder IDs. `event_time` MUST use the Dolly canonical UTC timestamp form with exactly six fractional digits. Duration MUST use a monotonic clock and integer nanoseconds. Ordering across producers is not inferred from wall-clock timestamps; causal parent IDs and journal sequence are authoritative.

Event schemas MUST be versioned and backward-readable for the supported
retention period. Unknown optional fields explicitly declared ignorable MAY be
ignored. Archival tooling MUST preserve unknown event bytes, but a Runtime
recovery reader encountering an unknown durable Event Journal name or schema
version MUST enter `MigrationRequired` under the closed-world conformance rule;
it MUST NOT skip that event and continue state recovery.

## 3. Structured logging

Logs MUST be structured objects. The standard levels are `error`, `warn`, `info`, `debug`, `trace`, and the separately authorized `payload` class. Human-formatted text MAY be rendered at the sink but MUST NOT replace fields.

Error events MUST include a stable error code, phase, retryability, and outcome classification. Stack traces and chained causes SHOULD be available at debug access but MUST be redacted.

Payload logging is disabled by default. Enabling it MUST require an explicit scope, expiry, maximum bytes per event, retention, and operator warning. API keys, Authorization, cookies, secret values, signed URLs, local private paths, and configured personal fields MUST be redacted before an event leaves the process. Redaction failure MUST drop the sensitive field or entire payload event, not emit the raw value.

## 4. Metrics

At minimum, v1 MUST expose:

- Activation count, duration, failure, retry, lease expiry, and commit conflict;
- Page append rate, delivery bytes, subscriber lag, and retained bytes;
- Extension process health, restart, crash-loop, protocol error, and request latency;
- Asset import bytes, leases, pins, storage, GC, and replica failure;
- Gateway queue, request latency, normalized error, input/output/reasoning/cached/image/audio/tool units with per-component provenance, and cost provenance;
- Memory ingest lag, index revision, search latency, result count, and abstention;
- Alarm due, fired, missed, duplicate-suppressed, and acknowledgement latency.

Metric labels MUST have bounded cardinality. Raw Block, Asset, session, URL, query, prompt, user, request, and alarm IDs MUST NOT be labels. Per-object diagnosis belongs in logs or traces. Histograms MUST declare units and stable bucket policy.

## 5. Distributed traces

Trace context MUST propagate across daemon, Runtime, Extension RPC, Asset Service, Model Gateway, and authorized tool calls. A new Activation SHOULD create or continue a trace and MUST create an Activation span. Retries are child spans with distinct attempt numbers, not overwrites of the first attempt.

Sampling decisions MUST NOT change Runtime behavior. Error and high-latency tail sampling MAY retain more traces, but audit and Event Journal durability MUST NOT depend on trace sampling.

External trace headers are untrusted. Channel ingress MUST create a trusted internal trace and MAY link, rather than blindly adopt, an external trace ID.

## 6. Event Journal

The Event Journal MUST be an append-only, per-instance ordered sequence with a durable `journal_seq`. It SHOULD include semantic facts needed to reconstruct or explain execution, including configuration commits, Module lifecycle, Activation lease/commit/failure, Page append and cursor commit, Extension version change, action dispatch/result/outcome-unknown, alarm occurrence, and asset lifecycle transitions.

A journal entry MUST contain references and hashes sufficient to locate authorized payloads; it SHOULD NOT duplicate full sensitive payloads. If payload retention expires, the entry MUST remain and indicate `payload_unavailable`.

Appending a journal entry that is part of a Core state transition MUST occur in the same transaction as that transition or through a transactional outbox that guarantees eventual append without duplicating semantic identity. Journal consumer offsets MUST be independent from Module Page cursors.

Replay MUST distinguish:

- `simulation`: no external side effects; recorded results are supplied;
- `verification`: deterministic reducers recompute expected state and compare hashes;
- `live_replay`: may contact external systems and therefore requires explicit privileged approval and new idempotency scope.

The default MUST be simulation. A replay MUST NOT reuse old credentials or side-effect idempotency keys as authorization for a new live action.

## 7. Backpressure and sink failure

Telemetry buffers MUST be bounded. When full, the implementation MAY drop lower-priority telemetry in the order `trace`, `debug`, then `info`; it MUST increment an out-of-band dropped-events counter and SHOULD emit a rate-limited warning when capacity returns. `error` events SHOULD use a reserved buffer.

Audit append failure MUST reject the security- or configuration-sensitive operation when policy requires audit-before-commit. Event Journal append failure for a transactionally journaled Core transition MUST fail or delay that transition rather than create unjournaled state. The exact failure MUST be visible to health checks.

An unavailable remote exporter MUST NOT cause unbounded memory or disk growth.
For the v1 `otlp_https` exporter, resolved configuration MUST set
`spool_overflow_policy` to `drop_oldest_eligible_telemetry`,
`spool_eviction_order` to the exact ordered array `trace`, `debug`, `info`, and
`outage_behavior` to `degrade_and_buffer`. When the byte quota is reached, the
exporter MUST evict only the oldest eligible record in that order; it MUST NOT
evict audit records, Event Journal entries, `error` events, or their
transactional outbox rows. Exporter unavailability or any such eviction MUST
set health to degraded and increment the dropped-events counter. These fields,
the spool quota, and the resulting behavior MUST be testable.

## 8. Health and diagnostics

Health MUST be separated into liveness, readiness, and degradation. A process can be live but not ready due to database migration, unavailable required storage, incompatible Extension protocol, or audit failure. Optional OSS, metrics exporter, or experimental evaluator failure SHOULD report degradation without making Core unavailable.

A diagnostic bundle MAY collect selected schemas, versions, metrics snapshots, redacted logs, and journal ranges. It MUST use an allowlist, show its manifest before export, and exclude secrets and payloads by default.

## 9. Retention and access

Logs, traces, metrics, audit, journal metadata, and referenced payloads MUST
have separate retention and access policies; the resolved configuration MUST
contain every class explicitly and MUST NOT infer payload access from log
access. Deletion MUST honor legal or operator holds and MUST leave an audit
record when required. Clock-based retention MUST use stored UTC instants and be
robust to wall-clock rollback.

Access to payload logs, provider transcripts, journal payloads, and diagnostic bundles MUST be separately authorized and audited. The management UI and conversational Channel MUST NOT share an implicit observability privilege.

## 10. Conformance tests

Tests MUST cover schema compatibility, missing optional IDs, monotonic duration under wall-clock jumps, causal trace propagation, retry attempt spans, redaction of every secret class, payload truncation, high-cardinality rejection, bounded-buffer loss accounting, exporter outage, audit-before-commit failure, transactional journal recovery, duplicate outbox delivery, payload expiry, unauthorized access, and simulation replay proving that no network or tool side effect occurs.
