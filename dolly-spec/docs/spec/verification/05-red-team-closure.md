# Adversarial review closure record

## 2026-08-12 cross-profile closure

Status: **informative review evidence for `0.1.0-draft`**. This pass does not
turn the repository into an implementation or a conformance report.

The second pass attacked the combined Extension, Memory, multimodal, Filter,
NapCatQQ, Testament, and LevelUpper contracts. Findings were accepted only
when a concrete counterexample could cross a trust, durability, identity,
routing, or replay boundary. The following high-severity classes are now bound
by normative text, closed schemas, executable semantic validators, and/or
regression vectors:

| Area | Counterexample closed | Binding now required |
| --- | --- | --- |
| Extension ownership | a hot-reload candidate and the retiring process both keep writable handles to one state directory | one active writer per `storage_scope_id`, monotonic writer generation, read-only/staging candidates, and an explicit handoff barrier |
| Stop and restart | `Stopped` Modules and an `Exited` process had no legal path back to service | desired intent is separate from observed state; restart creates a new generation and re-instantiates the same scope; restore is a distinct verified-snapshot operation |
| Shared databases | two Modules pointing at one physical database could read, ACK, migrate, or delete one another's rows | every durable tenant and operation identity begins with the Host-granted storage scope; same-identity restore preserves it, while clone/fork receives a fresh scope and explicit remap |
| Multimodal output | a provider could return an unrequested modality, forged `BlockRef`, temporary URL, or bytes that outlived no durable Asset import | requested-output subset validation; only text, JSON, and AVAILABLE Assets; persisted `(request_id, ordinal)` import identity; MIME/size/status and crash reconciliation |
| Filter replay | floating-point EMA, ambiguous tie keys, configuration toggles, forged prior state/observations, or a resealed but invented output could choose or emit an unreachable Block | authoritative prior-state/Manifest/Block bindings, ordered integer replay, half-even rounding and clamping, JCS tie key, exact safe-projection reconstruction, immutable state epoch, exact prepared Activation payload, and fenced activation ledger |
| Memory reinjection | recall could cite its own output, reinsert the current basis, or turn a prior injection into a once-per-day ban | trusted provenance exclusion before ranking, same-request exact deduplication only, later-request eligibility, and dynamic low-trust evidence Blocks rather than Premise mutation |
| NapCat privacy | a shared output Page could broadcast one consumer's QQ messages, cursors, or conversation activity to another | a private hub plus one trusted-principal facade/result Page per consumer; content-free bounded hints; exact graph/config/profile admission |
| NapCat media | nested JSON media identifiers had no Core Asset pin or authorization edge | hub-owned ingress imports media into Core; facade results bind only sanitized references to committed, hash-checked Assets |
| NapCat split brain and replay | two local instances could own one account, a stale daemon could keep sending, or crash recovery could repeat a side effect | daemon-wide authenticated-account ownership, no multi-daemon writer claim without a real fencing proxy, general-operation/effect/activation ledgers, and unknown-outcome quarantine |
| Testament isolation | split overlap, dangling objects, opaque recorded Actions, fixture substitution, duplicate sandboxes, or an online full clone could be shape-valid | corpus and replay semantic validators, typed Actions and fixtures, treatment-scoped mapping, finite scheduler catalogs, and offline/mock-only full-clone constraints |
| LevelUpper transport | persistent capability tokens, occurrence/content identity collapse, bidirectional sequence collision, pre-commit send, downgrade, overlapping Asset ranges, or repeated flow credit could pass | out-of-band Network Broker grants; portable-content/envelope split; per-direction epochs and chains; Host-commit send fence; transcript-bound highest-version negotiation; exact range/frame/credit validators |
| Delivery order | a numbered phase list serialized independent work and delayed NapCat behind unrelated Extensions or LevelUpper behind Testament | the work-package DAG is authoritative; offline NapCat starts at `G0`, real read-only QQ at `QQ2`, guarded send at `QQ3`, while Testament and Network-Broker/LevelUpper remain independent post-v1 lanes |

The executable gate for this pass compiles 74 Draft 2020-12 schemas, validates
95 repository instances, runs the general protocol negative probes, and runs
111 independent Filter/Testament/LevelUpper semantic cases. The Python
repository check additionally closes JSON/reference/link/vector structure and
recognizes 286 requirement IDs. Counts describe this source revision only;
they are not a substitute for implementation crash, platform, or live-provider
evidence.

## 2026-08-10 foundation closure

Status: **informative review evidence for `0.1.0-draft`**. This is not a Dolly
v1 conformance report and does not promote the specification to
`spec-candidate`.

Four specialist passes reviewed Core/storage semantics, protocol/schema pair
semantics, source/research coverage, and cross-component integration. A fifth
integration recheck then attacked the combined result after those fixes landed.
Reviewers started from hostile counterexamples and converted accepted findings
into normative rules, schemas, semantic validators, and regression vectors.

## 1. Resolved high-severity findings

| Finding | Failure before resolution | Current binding and regression evidence |
| --- | --- | --- |
| Self-loop Page quota | A quota-1 durable self-loop could be permanently `commit_blocked` if admission counted the consumed input before cursor movement | projected post-transaction cursor/retention/append rule in Core 03/04/RAM; `TST-CORE-010` |
| Future skip | `SkipRange` could advance beyond data that had ever existed | upper bound and same-transaction recheck against `next_page_seq`; `TST-CORE-011` |
| Descriptor race | an independently “current” Descriptor could disagree with the GraphSnapshot used by `BuildManifest` | candidate Descriptors remain inactive until graph installation; revision+digest CAS; `TST-CORE-012` |
| Action-contract drift | a queued targeted Action could be reinterpreted by the target's newer Descriptor | complete creation-time `contract_binding` is immutable Block data and is the sole validation authority; `TST-CORE-013` |
| Lost lossy-gap work | an idle Module could wait forever when the only input was an unreported lossy gap | gap is an independent eligibility trigger; gap-only Manifest plus report-state CAS; `TST-CORE-014` |
| Cursor-conflict split state | documents allowed incompatible quarantine and recovery outcomes after a cursor invariant failure | result transaction rolls back; a separate recoverable safety-stop preserves Activation/Module ownership and enters `RecoveryRequired`; `TST-CORE-015` |
| Frozen config continuity | an old Manifest named only a revision and could accidentally execute current process config | complete object-valued effective config plus value/schema-bundle digests are Manifest bytes; generation compatibility gate; `TST-CORE-016` and `TST-CONFIG-003` |
| Extension/Module config dead fields | Extension and Module config had no deterministic merge/consumer, and two valid 1,024-key inputs could overflow the resolved consumer shape | fixed shallow overlay, resolved 1,024-member gate, whole-root bundle validation, lifecycle snapshots/echoes, and config semantic negatives |
| Missing Tool Broker registry | Host ownership of MCP transport had no closed registry, credential, revision, schema, or a cutover that preserved old-Activation calls | closed Tool Broker registry, revision-scoped Ready-to-Draining lifecycle, generation fencing, embedded-schema validation, and `TST-TOOL-007` |
| MCP date treated as a cosmetic upgrade | silently moving from `2025-06-18` to `2026-07-28` would remove the lifecycle model and turn MRTR continuations into post-dispatch redispatches not represented by Dolly's ledger | ADR 0008, exact-version `REQ-TOOL-008`, schema rejection and `TST-TOOL-008`; a later adapter needs per-round durable semantics |
| Mutable stdio Tool identity | an old registry revision could resolve the same package ID or executable path to different bytes after restart | exact package version/package digest and executable digest are retained operation inputs; substitution and path probes |
| Undefined Tool replay | an idempotency enum authorized replay without defining how the key reached the server or proving upstream durable deduplication | closed `none`/`argument_key` union and RFC 6901 key equality, but no post-dispatch auto-replay in v1; `REQ-TOOL-002` and `TST-TOOL-002` |
| Tool contract value-domain drift | registry input schemas could be boolean or scalar-root while Model Gateway and invoke arguments required objects | all three surfaces use object-root input schemas and stable tool aliases; malicious/remote schema and non-object negatives |
| Tool status/error ambiguity | status could substitute an unrelated/cross-Module result; identity depended on unavailable resolution; authorization/dispatch races had no terminal rule | request digest plus frozen accepted binding, denied/conflict no-new-row rules, exact scoped-row equality, zero-byte pre-dispatch failure, all-false error map, and `TST-TOOL-003..006` |
| Tool endpoint credential leak | a shape-valid HTTPS URI could contain userinfo, query credentials, or a fragment | semantic URL rejection plus the retained SecretRef-only credential and redirect/SSRF rules |
| Self-referential prepare digest | `module.prepare_config.input_digest` could be any value echoed by both peers | exact non-recursive method+params-minus-digest JCS domain and recomputation/substitution negatives |
| Executable Schema defaults | JSON Schema `default` annotations could produce different effective-config bytes across implementations | v1 package config bundles forbid any `default` member; only an explicit versioned normalizer may materialize a value, with schema/value bundle validation |
| Activation result digest | a structurally valid fake digest was accepted as a positive example | `result_digest = sha256(JCS(payload))` is recomputed and paired with all lease/Manifest fences |
| Snapshot/migration substitution | request/result pairs could switch Module, package, schema, source, target, or claim unapproved loss | Host-retained envelope and approval tuple binding plus synchronized-substitution negatives |
| Resource-read substitution | `host.block.get`/`host.asset.get` could return another object, representation, length, or oversized inline body | authoritative request/result pair validators and content/length/ceiling negatives |
| Lifecycle/status echo drift | ping, instantiate, prepare, and generic operation-status responses could acknowledge a different operation or fence | method-specific pair validators for operation, Module, generation, revision, config, and nested typed result identity |
| Initialize negotiation gaps | an unoffered SDK ABI or unproved activation ledger/storage grant could become Ready | ABI membership, exact exclusive handle, generation/package/state/proof checks and continuity negatives |
| ActionResult collection | duplicate, missing, extra, malformed, or reordered ActionResults could pass only shape validation | ordered one-to-one collection semantic validator; corrected `TST-CORE-003` and negative probes |
| Skills result binding | list order, pagination, catalog/name/path/revision and byte-range responses were insufficiently checked | complete Skills semantic validator and ordered/range/hash negative probes |
| JSON-RPC error mapping | numeric code, symbolic name, retryability/outcome, and parse-error null ID could disagree | closed error policy validator and valid null-ID parse-error example |
| SQLite WAL implementation floor | a documented upstream WAL-reset race could violate the durable profile | attested embedded SQLite `>=3.51.3` writable-start gate; ADR 0006 and `TST-STORAGE-001/002` |
| Premature `tensity` contract | stable Block bytes fixed an unvalidated range/default | opaque namespaced versioned research envelope, disabled registry boundary, ADR 0007 and `TST-RESEARCH-001` |
| Missing research controls | transfer, Reflection, browser, learning, and framework-comparison claims lacked executable fairness/leakage/rollback plans | five dedicated research specifications, plan/run schemas, fixtures, and `TST-RESEARCH-002..006` |

## 2. Executable review surface

The schema validator does more than compile individual shapes. Its negative
oracles exercise request/result pairs, Host-retained context, digest
recomputation, exact set/order constraints, range/length binding, approval
tuples, error-policy mapping, and untrusted embedded schema compilation. The
Core vectors separately exercise reference-machine state transitions rather
than treating RPC validation as a persistence proof.

The expected local gate is:

```text
make check-full
  -> source evidence, JSON, links, headings and ID/reference checks
  -> every Draft 2020-12 schema and RPC registry fragment compiles
  -> repository examples/fixtures/vectors validate
  -> semantic positive and negative probes pass
```

Packaging is accepted only after this gate passes in the source tree and again
from a clean extracted archive with freshly installed locked dependencies.

## 3. Deliberately open draft blockers

This review does **not** claim candidate closure:

1. Many independently falsifiable normative clauses still share a draft
   umbrella ID. The current validator detects unknown vector IDs but does not
   prove clause-level source→requirement→implemented-oracle coverage.
2. Schemas, model vectors, and hostile fixtures are an implementation oracle,
   not evidence that a Rust Runtime, native Linux/Windows process host, SQLite
   crash suite, provider adapter, browser, or Extension package already passes.
3. The release security review, SBOM, signed artifacts, backup/restore rehearsal,
   benchmark reports, and complete `V1-*` packet do not exist in a specification
   repository.

These are explicit Phase 0 or implementation/release gates, not silent risks.
`REQ-TRACE-001` prevents promotion while the first item remains, and the
acceptance chapter prevents Dolly v1 claims while the latter items remain.

## 4. Review decision

The reviewed repository is suitable as a **pre-implementation draft and
executable design oracle**. It is **not** `spec-candidate`, an implementation,
or a conformance claim. Any future semantic change reopens the affected row and
requires the normal requirement, ADR, schema/reference-machine, and regression
updates.
