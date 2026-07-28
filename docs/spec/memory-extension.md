# Dolly Memory Extension

Status: Draft

This document defines the proposed minimal, deterministic contract for a Dolly
Memory extension. It is normative only after acceptance under
`docs/spec/README.md`.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, NOT RECOMMENDED, MAY, and OPTIONAL in this document are to be
interpreted as described by RFC 2119 and RFC 8174 when, and only when, they
appear in all capitals.

## 1. Purpose and authority

The owner's original idea requires a Memory Module to preserve useful prior
information for a Page, retrieve relevant history, avoid indexing its own
outputs, process indexing work outside the critical Module action, and avoid
retaining multimedia bytes after useful features have been extracted. The same
idea explicitly warns that cognitive mechanisms must be researched rather than
accepted because they sound novel.

This specification therefore separates:

- a minimal product baseline for isolated, recoverable indexing and honest
  retrieval; and
- experimental mechanisms that MUST remain disabled by default until controlled
  evidence and an accepted ADR promote them.

The confirmed `OWNER-CORE-*`, `OWNER-DATA-*`, `OWNER-MEDIA-*`, and
`OWNER-RESEARCH-001` requirements in
`docs/takeover/confirmed-user-requirements.md` take precedence over this Draft.
The contracts in `core-runtime.md`, `block-payload.md`, `media.md`,
`extension-process-protocol.md`, `model-provider.md`, and `security-operations.md` also
apply. `llm-extension.md` applies only when a large language model (LLM)
consumes recalled data; the Memory extension does not depend on the LLM
conversation implementation.

Current code, legacy specifications, handover claims, and existing experiments
are evidence only. They do not define Memory conformance.

## 2. Scope

The baseline covers:

- Memory namespace and authorization isolation;
- deterministic text and permitted media-feature extraction;
- bounded, recoverable background indexing;
- lexical, vector, and hybrid retrieval;
- explicit query and recall Block schemas;
- embedding endpoint/model capabilities and feature provenance;
- index generations and model migration;
- Block and Media retention through strong references and access leases;
- retention, deletion, reindexing, crash recovery, and observability; and
- deterministic conformance tests and evaluation gates.

The baseline does not claim human-like memory, learning, emotion, creativity,
analogy, or self-improvement. It does not include daily summaries, tensity-based
forgetting, emotional recall, trajectory matching, memory-owned skills, or
abstract thinking prompts. Section 14 classifies those proposals as research.

## 3. Baseline invariants

A conforming baseline MUST preserve all of these invariants:

1. Memory data is isolated by runtime-authenticated instance, owner, session
   scope, Page, and Memory Module identity.
2. One immutable source Block is indexed at most once per namespace, extractor
   version, and feature plan. Repeated Deliveries are recorded as occurrences,
   not duplicate vectors.
3. A Memory Module action is serialized by the core actor and returns either no
   BlockProposal or exactly one BlockProposal.
4. Per-Module-job indexing admissions and cross-Delivery feature extraction
   jobs are distinct,
   durable, and idempotent. Extraction and embedding run in a registered,
   bounded background service; background work never emits a Block directly.
5. The Module never indexes its own output or a baseline recall result.
6. Recall is delivered as an explicit, ordinary, untrusted Block. Recalled text
   is never inserted into a system prompt or dynamic Module description.
7. Text, image, and other embedding support is selected from an exact
   endpoint/model/operation descriptor. Unsupported modalities remain visibly
   unsupported.
8. Raw media is not retained by Memory by default. Persistent text and vectors
   are derived data with complete provenance and deletion obligations.
9. Incompatible vector spaces or extractor versions never share one index and
   never have raw scores compared as if they were compatible.
10. Thresholds apply to real, named score channels. Rank position is not a
    relevance score.
11. Every queue, query, result, context expansion, retry, lease, and stored
    feature has a finite limit.
12. Research fields such as tensity, emotion, access count, or recency do not
    affect baseline ranking or retention.

## 4. Isolation and namespace model

### 4.1 Runtime-authenticated identity

Every stored record, index, query, and result belongs to a `MemoryNamespace`.
The conceptual identity is:

```text
MemoryNamespace = (
  instanceId,
  ownerScopeId,
  memoryModuleInstanceId,
  inputPageId,
  retentionScopeKind,
  retentionScopeId
)
```

The runtime supplies and authenticates every component. A Block payload, model,
tool, extension string, endpoint response, or client-provided field MUST NOT
choose or override a namespace component.

`retentionScopeKind` has this baseline meaning:

- `session`: `retentionScopeId` is the current runtime-authenticated session ID;
  this is the default; or
- `owner-long-term`: `retentionScopeId` is an explicitly configured persistent
  memory-space ID owned by the same `ownerScopeId`.

Every record also stores its originating session ID. An `owner-long-term` query
MAY retrieve records from prior sessions only after configuration and
authorization explicitly select that scope. It MUST NOT cross an owner, Dolly
instance, Memory Module, or Page boundary.

A missing owner or session identity is a configuration or migration error. It
MUST NOT fall back to a shared `default`, empty string, process-global store, or
the first available namespace. Single-user local deployments still use an
explicit stable local-owner identity.

### 4.2 Page isolation

The owner's baseline topology is one Memory Module per Page. Deployments SHOULD
use that topology because its isolation is simple and observable.

If one Memory Module consumes more than one input Page, it MUST maintain a
separate subnamespace, job stream, CoverageState, lexical index, and vector index
set for each Page. It MUST NOT concatenate Page histories into one index. A
baseline query addresses exactly one input Page. Cross-Page federation is
outside this baseline and requires a future authorization and score-composition
contract.

The source Page comes from the core Delivery metadata, not from the Block
payload. A Block delivered to two Pages can produce one record in each isolated
Page namespace; one Page's record or query MUST not reveal that the other exists.

### 4.3 Authorization

Authorization is checked on every query, delete, export, reindex, and retention
change, not only when the namespace is created. A caller can search only a
namespace granted by runtime policy. A model-generated query cannot broaden its
scope, request another owner, or opt into owner-long-term memory.

Storage files, database tables, caches, metrics labels, and temporary work MUST
all preserve the same isolation. A cache key that omits any namespace component
is invalid unless it stores only non-sensitive public constants.

## 5. Baseline data model

### 5.1 MemoryRecord

A `MemoryRecord` is immutable after commit. One record represents one bounded,
versioned extraction segment from one immutable source Block. Its persisted
schema is `dolly.memory-record/2`; version 2 uses `moduleJobId`, and readers
MUST reject version 1 and its former field as `MEMORY_RECORD_INVALID` rather
than accepting an alias. It
contains at least:

- opaque `recordId`;
- complete `MemoryNamespace` identity;
- source Block ID and core sequence as provenance;
- source Page ID and originating session ID;
- payload schema and extractor ID/version;
- deterministic segment ID and segment boundaries;
- permitted extracted text, if any;
- committed feature references and terminal skipped-feature reasons;
- a feature-plan digest;
- creation Module job ID and coverage revision at commit; and
- schema version and deletion epoch.

The source Block ID stored inside Memory is provenance, not automatically a Core
`block-reference` content item and not an independent strong reference. Section 11 defines when
the output may include such an item and how its lifetime is retained.

An extraction change creates a new record or index generation. It MUST NOT
mutate prior text or silently replace its provenance. Wall-clock timestamps MAY
be stored for display but MUST NOT define order, eligibility, retention, or
deduplication.

### 5.2 OccurrenceRecord

Every accepted source Delivery creates an idempotent `OccurrenceRecord` keyed by
Delivery ID and linked to its `recordId` or source Block. It retains the source
Page ID and exact Page sequence. Repeated Deliveries of the same Block in one
namespace update occurrence metadata without creating a second text segment or
vector.

Occurrence count is observable evidence only. It MUST NOT boost baseline
ranking, retention, or threshold results. Any such use is a research feature.

### 5.3 FeatureRecord

A `FeatureRecord` is immutable and includes:

- `recordId` and namespace;
- feature kind, such as `lexical`, `native-embedding`, or
  `derived-text-embedding`;
- source modality;
- extractor or transformation pipeline identity and version;
- embedding endpoint ID, model ID, adapter version, descriptor digest, and
  operation, when applicable;
- vector-space ID, dimension, numeric encoding, normalization, and metric;
- source Media identity and optional crop provenance for media-derived features,
  without a signed uniform resource locator (URL), object key, local path, or
  bytes;
- creation feature-extraction job ID and index generation ID; and
- terminal status.

Embedding vectors are sensitive derived user data. They receive the same
namespace, access, export, retention, and deletion protections as extracted
text.

### 5.4 IndexGeneration and RetrievalSnapshot

An `IndexGeneration` is an immutable compatibility boundary. Its identity binds
the namespace, index kind, extractor, tokenizer, endpoint/model descriptor,
vector-space properties, distance or similarity metric, and index algorithm and
parameters.

A `RetrievalSnapshot` pins the exact lexical generation, zero or more compatible
vector generations, ordered score-channel identities, fusion and threshold
profile digests, namespace, corpus revision, tombstone revision, and
`CoverageState` used by one query. Results MUST report this identity so a later
index switch, deletion, or threshold edit cannot rewrite what the query
observed.

The snapshot MUST be backed by an MVCC revision, immutable segment snapshot, or
equivalent read token that excludes later writes. Before reading, the action
acquires a bounded `IndexReadLease` over the exact generations and revisions.
The lease is fenced by Module generation and query run, released on every
terminal path, and expires or is reconciled after a crash. Compaction and old
generation deletion wait for all covering read leases; a label containing only
generation names is not a data snapshot.

Coverage is not one optimistic scalar. Per Page, `CoverageState` records:

- `processedThrough`: the highest contiguous Page sequence for which every
  eligible Delivery has a terminal success, policy-approved skip, or permanent
  failure outcome;
- `completeThrough`: the highest contiguous Page sequence for which every
  required feature succeeded or reached a policy-approved skip; and
- bounded counts/ranges of pending, retryable, and permanent-failure gaps after
  those points.

A permanent unexpected failure may advance `processedThrough` but MUST NOT
advance `completeThrough`. Later records may still be searchable, but the
reported gaps prevent a caller from interpreting either watermark as complete
coverage of all more recent input.

Coverage is evaluated per Delivery occurrence. A repeated Delivery of a Block
creates another OccurrenceRecord and terminal coverage obligation but reuses a
compatible already committed feature set. Both Page sequences advance only when
their own occurrence reaches the required terminal state. Deduplicating feature
work MUST NOT skip, merge, or prematurely advance a Delivery sequence.

### 5.5 IndexAdmission and FeatureJob

An `IndexAdmission` is the per-Module-job commit receipt for proposed indexing
work. "Admission" is used because the record controls whether prepared indexing
work may become runnable after the Module job commits; it is not another job.
It includes:

- stable `admissionId` derived from namespace, `moduleJobId`, exact Delivery
  identities, feature-plan digest, and deletion epoch;
- originating Module job and Module generation;
- expected committed result digest;
- prepared OccurrenceRecords and the FeatureJob IDs they require;
- one distinct Module retention key per source target; and
- state `prepared`, `committed`, or `discarded`.

An admission is immutable after it reaches a terminal state. `prepared` is not
runnable and is not visible to retrieval. It becomes `committed` only after the
extension observes through the Extension process protocol `module-job-outcome`
operation that the exact `moduleJobId`, result digest, and requested retention
changes committed. A rejected, nacked, conflicting, or terminally abandoned
result makes it
`discarded`; it never reaches a provider.

A `FeatureJob` is the cross-Delivery durable work that creates one planned
feature set, not an in-memory promise. It is separate from the Module job that
admitted a Delivery batch; the Feature qualifier prevents those two job
identities from being confused. It includes:

- stable `featureJobId` derived from namespace, source Block,
  extractor/feature plan, and deletion epoch;
- source Block identity and the committed admissions that require it;
- finite planned feature set and limits;
- state `pending`, `running`, `retryable`, `succeeded`, `skipped`,
  `permanent-failure`, or `cancelled`;
- attempt count, deadline policy, and safe typed error; and
- idempotency keys for provider and storage operations.

Creating the same admission or job twice is idempotent. A committed admission
attaches its occurrences to the shared job or to an already compatible terminal
feature set. A job is complete only when every planned feature has a committed
value or a visible terminal skipped/error reason. Partially returned provider
batches MUST be correlated by item ID and MUST NOT be treated as a complete job.
Admission-specific retention keys prevent a job that just became terminal from
racing with a later Delivery: every newly committed strong reference is either needed by the
job or scheduled for serialized release.

## 6. Serialized action and background indexing

### 6.1 Module action

The Memory Module MUST use the core Module actor. Its action is absolutely
serialized and observes the immutable, ordered input batch supplied by the
runtime. It MUST return either no BlockProposal or exactly one BlockProposal,
consistent with `OWNER-CORE-002` and `core-runtime.md`.

For one run, the baseline action performs these bounded steps in deterministic
order:

1. validate runtime namespace and Page identities;
2. pin the current RetrievalSnapshot and CoverageState;
3. identify explicit query payloads and eligible automatic-recall triggers;
4. perform bounded retrieval against the pinned snapshot, excluding every
   source Block in the current input batch;
5. assemble the immutable Module result, compute its canonical digest, and
   durably prepare an IndexAdmission plus OccurrenceRecords and FeatureJob links
   for eligible non-self inputs;
6. include the bounded `ModuleRetentionChange` additions required for those
   admissions in the Module result; and
7. return no BlockProposal, or one aggregate recall/error BlockProposal for all
   accepted query requests in the run.

The Core commits the retention additions with the Module job result before
input acknowledgement. Prepared records become visible to retrieval and a new
FeatureJob becomes runnable only after that commit is observed. Recovery queries
the outcome when a commit notification was lost. The result MUST remain
byte-for-byte unchanged after its digest is stored. This boundary prevents both
acknowledged input without a source strong reference and background access based on a result
the Core rejected.

The action MUST NOT embed, caption, OCR, summarize, or rerank every input Block
inline. A bounded query embedding required to service the current explicit
query MAY occur inside the action under its deadline and capabilities. If it
cannot complete, the result is a typed query outcome; indexing continues from
committed admissions and durable jobs.

The action MUST not wait for newly enqueued FeatureJobs. Its result reports the
snapshot CoverageState and pending-job count. Therefore callers can distinguish
"no match in the committed snapshot" from "all recent input has already been
indexed".

### 6.2 Background indexing

The registered background indexer consumes durable `pending` FeatureJobs under
bounded concurrency. It MUST NOT enumerate prepared admissions as runnable.
`featureJobId` identifies the persistent job. Notifications, retries, process
restarts, and duplicate wakeups MUST converge on that same job and
committed features.

Correctness MUST NOT depend on an unbounded in-memory queue, a fixed sleep, or a
fire-and-forget Promise. On startup, the indexer enumerates durable nonterminal
jobs within its namespace and resumes them. A completion that needs
actor-visible state MAY submit a bounded source activation request with a stable
`idempotencyKey`; the runtime turns it into a serialized Run.

Background work:

- is registered with Core and governed by the Module actor;
- receives the Module generation cancellation signal and observes generation
  fencing;
- uses storage, Block, media-view, descriptor-bound model-operation, and logging
  capabilities only;
- acquires and releases AccessLeases around every asynchronous object use;
- obeys finite concurrency, batch, byte, provider-call, retry, and time limits;
- commits features and CoverageState advancement transactionally or through an
  idempotent outbox; and
- never emits a Block, changes a Page, or mutates core actor state directly.

After a job reaches a durable terminal feature state, the background service
submits a stable actor signal. The later serialized Module result removes the
admission strong references through `ModuleRetentionChange`. Until that result
commits, the strong reference remains intentionally live. The background service MUST NOT
remove a Core strong reference itself.

Quiesce stops new job admission. Stop completes only after active jobs exit or
are hard-isolated and every remaining job is durably resumable. Late results
from an old Module generation are fenced and MUST NOT advance an index.

### 6.3 Backpressure

The Memory extension MUST expose finite limits for prepared admissions, pending
jobs, retained source bytes, concurrent extractors, provider batches, retry
attempts, and total storage. If admission or job capacity is exhausted, the
actor MUST apply its configured
backpressure outcome, such as nack/retry or a visible permanent skip. It MUST
NOT acknowledge input and silently discard the indexing obligation.

A permanent failure removes temporary source retention only after recording the
failure. An operator-triggered retry after that point succeeds only if the
source or permitted extracted text remains available.

## 7. Loop prevention and deduplication

Core-authenticated source identity, not a payload field, determines self-output.
The Memory Module MUST exclude every Block whose source Module instance is the
same Memory Module instance. It MUST also exclude every
`dolly.memory.query/1` and `dolly.memory.recall/1` control item from feature
extraction by default, even when another Memory instance produced it. Other
independently eligible standard content items in the same Block MAY be indexed
under their declared extractor; the query or recall control value never is.

An output Page MAY also be an input Page. This topology MUST remain safe without
a hop counter because self-produced results are filtered before admission.
Cross-Memory recall indexing is outside the baseline and MUST NOT be enabled by
a generic "index all JavaScript Object Notation (JSON)" option.

The deduplication key includes namespace, source Block ID, extractor version,
segment definition, feature plan, and deletion epoch. Display text, timestamp,
embedding similarity, and source summary are not identity.

Query Blocks in the current run and their derived query vectors MUST be excluded
from candidates. A query MUST NOT retrieve itself merely because a fast
background worker committed it during the same run; the pinned snapshot and
current-batch exclusion make this deterministic.

## 8. Text and media feature extraction

### 8.1 Text extraction

The extension MUST use allowlisted, versioned extractors for known payload
schemas. It MUST NOT stringify arbitrary JSON, scan opaque fields for text,
interpret a filename or URL as content, or index an unknown schema by default.

An extractor produces deterministic bounded segments. Its contract declares:

- accepted payload schemas and fields;
- Unicode normalization and language/tokenization behavior;
- maximum input and segment bytes;
- segmentation boundaries and overlap;
- treatment of summaries, code, tool payloads, and control messages; and
- redaction or exclusion rules.

The same input and extractor version MUST produce the same segment IDs and text.
Changing any behavior creates a new extractor version and index generation.

### 8.2 Default media policy

Memory MUST NOT retain raw media by default. After permitted features are
committed, it MUST hold no Memory-owned strong reference to source media bytes, local
files, base64, signed URLs, object-store keys, materialized representations, or
provider upload handles.

For pending extraction, each committed indexing record owns a temporary durable
strong reference to the source Block. Reachability retains its Media references. The worker
atomically acquires Block/media AccessLeases before asynchronous access. When
the feature plan reaches a terminal state, it releases every AccessLease and
submits the stable actor signal that requests removal of all applicable
admission strong references. Normal media garbage collection may then remove bytes while
Memory text or vector features remain under their own retention policy.

An explicit raw-media retention mode is outside the minimal baseline. If a
future accepted profile adds it, it must use separate, enumerable strong references,
finite retention, user-visible storage accounting, and the complete `media.md`
deletion contract.

### 8.3 Media feature policies

For each media modality, configuration MUST select exactly one supported policy:

- `skip`: record `MODALITY_SKIPPED` and create no media feature;
- `native-embedding`: use an embedding descriptor that explicitly accepts that
  modality;
- `derived-text`: use a separately configured OCR, caption, transcription, or
  other transformation capability, then send the derived text to a text
  embedding descriptor; or
- `metadata-only`: store only an allowlisted, non-content metadata feature.

There is no implicit fallback order. If the selected policy cannot run, the job
records a visible typed outcome or follows an explicitly configured degraded
policy. It MUST NOT hash bytes, insert zeros, reuse a text vector, call a mock,
or claim the media itself was embedded.

OCR, captions, and transcripts are derived assertions. Their records MUST retain
the transformation descriptor and source view provenance and MUST label the
text as derived. A generated caption MUST NOT be presented as source truth.

### 8.4 Provider representations

Memory passes authorized Media references to its configured model operation.
The model provider broker asks the Media store for request-scoped input
compatible with the exact model description. Memory does not receive the
endpoint Hypertext Transfer Protocol (HTTP) handle, credential, signed URL,
inline provider bytes, or provider upload handle and cannot select an input
format by provider name.

The host keeps Media access valid through request termination and releases it
under `media.md`. The Memory result may retain only safe input-format
diagnostics needed for provenance, never the temporary access details. Crop
parameters follow `media.md`; Memory MUST not build object-store crop URLs or
call a model endpoint itself.

## 9. Embedding descriptors and index generations

### 9.1 Exact capability selection

Embedding is selected by the exact descriptor tuple defined in
`model-provider.md`:

```text
(endpointId, operation=embedding, modelId, adapterId,
 adapterVersion, descriptorVersion)
```

Memory configuration references that descriptor through a capability. It MUST
NOT infer modality, dimension, route, metric, or cross-modal compatibility from
the words `OpenAI`, `Qwen`, `VL`, `DashScope`, `Bailian`, or any other provider
or model-name substring.

Before accepting vector configuration, Memory validates accepted modalities,
MIME/representation limits, batch size, output dimension, numeric encoding,
normalization, metric semantics, and shared-vector-space declarations. A
descriptor change is configuration change, not a transparent provider detail.

### 9.2 Text-only and native image support

A text-only descriptor is a fully supported deployment. It can index extracted
text and serve lexical, text-vector, or text-hybrid queries. Direct image-vector
features remain unavailable.

The owner's Bailian/DashScope VL embedding deployment MAY be configured as an
optional integration fixture with native image support. It is not a dependency
or product default. Aether, DashScope, Bailian, OpenAI-compatible endpoints, and
all other named providers remain optional adapters.

Text-to-image or image-to-text vector retrieval is permitted only when the exact
descriptor declares that the two modalities share one comparable vector space.
Equal dimension is insufficient evidence. If modalities use separate spaces,
they require separate indexes and compatible query modalities.

### 9.3 Provenance

Every stored vector MUST record the complete FeatureRecord provenance in
Section 5.3. Query vectors record the same fields plus request ID and snapshot.
Results MUST distinguish:

- source text embedded directly;
- native media embedded directly; and
- OCR/caption/transcript text embedded after a declared transformation.

A deterministic fake embedding used by tests MUST identify a fake endpoint and
model in provenance. It MUST never be cached or reported under a real descriptor
identity.

### 9.4 Incompatible changes and migration

The following changes require a new IndexGeneration unless the descriptor
explicitly proves compatibility:

- endpoint, model, adapter, or descriptor digest;
- vector-space ID, dimension, encoding, or normalization;
- distance/similarity metric or score transformation;
- source modality or derived-text pipeline;
- text extractor, tokenizer, segmenter, or normalization; or
- vector index algorithm parameters that change score meaning.

Vectors from incompatible generations MUST NOT be inserted into one index,
averaged, compared, or padded/truncated to fit. Raw scores from those generations
MUST NOT be merged as if they shared a scale.

A model migration uses this sequence:

1. create a new empty generation with a stable migration ID and capture corpus
   and tombstone revisions at high-watermark `r0`;
2. begin dual-writing newly committed eligible records and tombstones after
   `r0` into the old and target generations through durable reindex jobs;
3. backfill records visible at `r0` from retained permitted text or
   still-authorized source data;
4. repeatedly catch up through a recorded watermark until lag is within the
   declared bound, or briefly quiesce new admissions for a final bounded catchup;
5. validate required records/skips through the switch watermark, dimension,
   provenance, tombstones, and retrieval smoke fixtures;
6. atomically switch the active RetrievalSnapshot with the exact corpus and
   tombstone revisions only after the configured completeness gate passes; and
7. retain the old generation read-only for a bounded rollback window, then
   delete it after all index read leases end.

Queries during migration pin one active generation. The baseline does not query
old and new incompatible vector generations together. Records that cannot be
reconstructed without deleted source media are visibly `not-reindexable`; they
MUST NOT receive fabricated replacement vectors.

## 10. Retrieval contract

### 10.1 Query payload

Explicit recall uses a first-party `extension-data` item with schema
`dolly.memory.query/1` inside a `dolly.content/1` payload. Its closed value
contains a caller request ID, optional query text, zero or more authorized
Media inputs, requested mode, bounded result count, and optional
context-expansion limit. Each Media input MUST resolve to an authorized Core
`media-reference` item in that Block and MUST satisfy the selected query
descriptor.
Raw asset IDs, view IDs, URLs, paths, object keys, and media bytes are forbidden
in the query value. Namespace, owner, session scope, and Page are supplied by
runtime authority, not the payload.

The Module MAY aggregate multiple query payloads in one input batch into one
output BlockProposal. Each result entry remains correlated to its request ID and
has its own typed status. Query count and total bytes are bounded; over-limit
entries receive explicit errors rather than disappearing.

Before returning the aggregate proposal, the Module MUST enforce one total
  budget for canonical output bytes, items, matches, excerpts, Block references,
  Media references, and context records within the stricter Core limits. It processes
queries in deterministic input order and reserves a bounded status entry for
each. A result that cannot fit loses matches/context and returns `OUTPUT_LIMIT`;
the Module MUST NOT build a predictably invalid proposal that can only nack and
repeat forever.

Automatic recall is OPTIONAL and disabled by default. If enabled, its trigger,
query extractor, minimum input size, cooldown, maximum frequency, retrieval
profile, and no-match behavior MUST be deterministic and finite. It uses the
same output schema and trust boundary as explicit recall. It MUST not turn every
input into a Module description or system-message update.

### 10.2 Baseline retrieval modes

A baseline implementation MUST expose these modes when their prerequisites are
available:

- `lexical`: a versioned deterministic lexical index over permitted text;
- `vector`: nearest-neighbor retrieval within one compatible vector generation;
  and
- `hybrid`: deterministic fusion of lexical and compatible vector candidates.

Lexical retrieval is the provider-independent default for text. The chosen
tokenizer, normalization, algorithm, parameters, and score direction are part of
the IndexGeneration.

Vector retrieval is available only when a valid embedding descriptor and active
compatible index exist for the query modality. If vector service is unavailable,
the extension MUST either return a typed failure or use a configured
`degradedMode: lexical`. A degraded result MUST say that vector retrieval did
not run and MUST use a separately configured lexical threshold profile. A
hybrid or vector threshold cannot be reinterpreted as a lexical threshold.

Hybrid retrieval MUST name and version its fusion algorithm. It MAY use a
method such as reciprocal-rank fusion, or calibrated component scores. It MUST
NOT add raw lexical and vector numbers merely because both are numeric. A fusion
score is not a probability unless a separately versioned calibration proves
that interpretation.

The immutable fusion profile and digest MUST bind the ordered component channel
identities, candidate depth per channel, weights, normalization/calibration,
RRF constant or equivalent parameters, duplicate collapse, missing-channel
policy, tie-break rule, and degraded profiles. A result cannot compare or merge
scores produced under another profile merely because the algorithm name matches.

Reranking is not required by the minimal baseline. If configured, it is a
separate bounded endpoint/model operation with its own descriptor, provenance,
score semantics, failure policy, and evaluation.

### 10.3 Honest scores and thresholds

Every result score MUST identify:

- score channel and algorithm/version;
- index generation;
- raw value;
- whether higher or lower is better;
- valid range if defined;
- calibration identity if any; and
- rank within that channel.

Rank position MUST NOT replace a raw distance, similarity, lexical, fusion, or
reranker score. A top-ranked unrelated record does not become score `1.0`.

A threshold is a typed rule bound to one exact score channel, metric,
IndexGeneration, fusion/calibration profile digest, comparison direction, and
value. A generic configuration such as `threshold: 0.3` with no score meaning is
invalid. Thresholds MUST be
selected on development data and frozen before held-out evaluation. If no
candidate passes, recall returns no match rather than lowering the threshold
silently.

Hybrid output reports every available component score and rank in addition to
the fusion score. Missing components and degraded paths are explicit.

### 10.4 Candidate rules and ordering

Retrieval MUST filter namespace, Page, owner, session scope, tombstone, index
generation, modality compatibility, and current-batch exclusions before final
selection. It MUST NOT fetch broadly and rely on post-hoc display filtering for
security.

Results are deterministic for the same snapshot and query. Ties use a declared
stable order, such as source sequence followed by record ID. Duplicate segments
or occurrences MAY be collapsed by record/source Block, but occurrence count
does not boost baseline rank.

Optional adjacent-context expansion uses committed records from the same
namespace and Page sequence only. Context records are labeled separately from
the scored match, do not inherit its score, and obey independent record, byte,
and reference limits.

### 10.5 Recall output

Recall output uses one `dolly.content/1` BlockProposal. Its first-party
`extension-data` item has schema `dolly.memory.recall/1`, a bounded plain-text
fallback, and a closed structured value that includes:

- request ID and typed status;
- namespace-safe Page and scope identifiers suitable for the caller;
- RetrievalSnapshot and complete CoverageState;
- pending and failed indexing counts;
- bounded matches with permitted text excerpts;
- complete component score semantics and feature provenance;
- optional source Block references and separately labeled adjacent context; and
- degraded, skipped-modality, or unavailable-capability notices.

Every source reference is a `block-reference` content item and is validated by
the Core. The structured result never embeds a target Block ID as authority. For an explicit
query, no match produces one correlated result entry with an empty match list.
For automatic recall, no match normally produces no BlockProposal. Multiple
query entries are aggregated into one BlockProposal so the Module never violates
the zero-or-one output rule.

The provider-independent `features-only` default does not emit source Block
references. Enabling `includeSourceRefs` is an explicit finite retention choice:
while a
recall Block is rooted, its immutable references can keep the source Block and
attached media reachable even after Memory releases every strong reference it owns. Status
and storage diagnostics MUST count these external blockers. A Memory forget
operation cannot rewrite already committed recall Blocks or erase copied
excerpts; user-facing deletion documentation MUST state that separate Page/Block
retention may be required to remove those immutable outputs.

## 11. Block, media, and feature lifetime

### 11.1 Immutable references

A recalled source can be emitted as a `block-reference` content item only if the referenced Block
still exists, belongs to the authorized instance/namespace, precedes the recall
Block by core sequence, and passes the Core reference limits. The Memory Module
MUST resolve and lease it before proposing the item. A stale provenance ID is
not a valid Block reference.

If a source Block is unavailable, Memory MAY return its independently retained
permitted text and provenance with `sourceAvailable: false`; it MUST omit the
Core block-reference item. It MUST NOT create a dangling reference or pretend that stored
text is the immutable original Block.

### 11.2 Strong references for indexing and optional source retention

Before the actor acknowledges a Delivery whose source is needed by background
indexing, its Module result requests an idempotent strong reference owned by an
enumerable `module` record
using a distinct stable retention key owned by the IndexAdmission. The Core commits this
change with the Module job result. This strong reference survives restart and keeps the
  source Block and reachable Media available until the feature plan is
terminal.

On success, policy-approved skip, or explicit cancellation, the terminal job
state schedules a stable actor signal; a later committed Module result removes
the admission strong references. On permanent failure, the configured dead-letter policy
similarly requests removal or replacement with a bounded dead-letter hold for
operator retry. A crash before that actor result leaves an observable extra strong reference,
not a dangling source; reconciliation resubmits the same signal. The hold,
storage cost, and expiry MUST be visible.

The default `features-only` retention mode creates no long-term strong reference to the
source Block. An explicit `retain-source-block` mode MAY create a separate,
enumerable strong reference owned by the Memory record before the
admission strong references are removed. It MUST have finite record/byte/time limits and a
deterministic release policy.

### 11.3 AccessLeases

Every asynchronous read of a Block or Media item uses an unguessable fenced
AccessLease acquired atomically with access. Provider calls also use the required
`provider-access` lease. Leases carry Module generation,
Module job, FeatureJob, and request identity and are released idempotently on success,
failure, timeout, cancellation, or fencing.

The extension MUST NOT implement lifetime with independent integer reference
counts, raw `acquire/release` guesses, or IDs hidden inside opaque payload text.
Stop and recovery enumerate outstanding strong references and access leases by
the persistent record named in each reference or lease.

### 11.4 Retention and quota eviction

Baseline retention uses explicit namespace policy over committed record order,
age metadata, storage quota, and user pins. It MUST be deterministic for a fixed
state and configuration. Tensity, random inverse weighting, emotion, access
count, and "new memory" boosts are not baseline retention inputs.

Time to live (TTL) delays or requests deletion of Memory records; it does not
make a still reachable Core Block or Media item collectible. Retention uses internal committed
metadata, not a caller-supplied Block timestamp.

## 12. Persistence, deletion, reindexing, and recovery

### 12.1 Durable state

The persistent baseline stores namespace metadata, schemas, records,
occurrences, features, index generations, active-snapshot pointers, admissions,
feature/reindex jobs, CoverageStates, tombstones, strong-reference ownership intents,
and recovery checkpoints.
Updates use transactions or an idempotent outbox. An in-memory-only profile MAY
exist for tests, but it MUST advertise that restart loses Memory.

Index and schema versions are explicit. Startup MUST refuse an unknown future
version and preserve the last readable state. It MUST NOT open a table with a
new embedding dimension or metric and hope that backend coercion succeeds.

### 12.2 Deletion

Deletion may target a record, source Block lineage, the Media identity referenced
by a source Block, session scope, Page namespace, owner scope, index generation, or the complete
Memory Module namespace. Authorization is rechecked at execution time.

Every logical delete, undelete, retention eviction, active-generation switch,
and tombstone revision change runs through the serialized Module actor as an
input or stable authorized control signal. Background workers may perform the
physical purge after the tombstone commits, but they cannot change logical
visibility. The actor remains occupied through Core result commit, so a deletion
cannot interleave between a recall snapshot and commitment of that recall
Block. Code paths that mutate tombstones outside this boundary are nonconformant.

The deletion sequence is:

1. compare-and-set the current corpus/tombstone revision and durably create a
   lineage tombstone with the next deletion epoch;
2. make every query and reindex path filter it immediately;
3. cancel or fence matching nonterminal jobs;
4. remove lexical/vector entries, extracted text, derived features, and
   occurrences, and schedule serialized removal of optional source-retention
   strong references;
5. compact backend data and backups according to the declared retention policy;
   and
6. record a content-free audit outcome.

Late provider or worker results carry the older deletion epoch and MUST NOT
resurrect data. Both preparation and activation of an IndexAdmission after its
Module job commits atomically recheck the lineage tombstone and expected revision.
An ordinary repeated Delivery of deleted content records a terminal
`TOMBSTONED` occurrence; it cannot create a job under a newer epoch. Re-admission
requires a distinct authorized undelete/new-content operation. Reindexing skips
tombstoned records. Removing raw media does not
by itself erase intentionally retained derived features, but an explicit user
forget/delete request for that media lineage MUST remove those features as well.

If physical removal from a backend is delayed, queries still exclude the
tombstone and status reports the pending purge. Deletion errors MUST remain
visible and retryable; they MUST NOT be logged as success.

### 12.3 Reindexing

Reindexing uses the same durable FeatureJob principles with distinct stable
migration/reindex IDs and target generations. It MUST be resumable, cancellable,
quota bounded, revision aware, and isolated by namespace and target
IndexGeneration. Repeated starts converge on the same jobs.

The active snapshot pointer changes atomically only after validation. A failed
or incomplete reindex leaves the prior generation active. Old generations are
deleted only after the rollback window and every covering `IndexReadLease`
ends or is safely reconciled after expiry/crash.

### 12.4 Crash recovery

Startup reconciliation MUST:

1. validate namespace and schema metadata;
2. recover active-snapshot pointers and committed CoverageStates;
3. reset abandoned `running` jobs to a retryable or outcome-unknown state using
   idempotency evidence;
4. reconcile admissions, their strong references, FeatureJobs, and outstanding
   AccessLease recovery records;
5. continue tombstone purges before admitting matching new work;
6. verify index generation dimension, metric, record count, and descriptor
   digest; and
7. expose corruption, missing sources, and non-reindexable records explicitly.

One failed job MUST NOT stop unrelated jobs. Repeated failure reaches a bounded
dead-letter state with a typed reason. The indexer MUST not spin forever,
advance `completeThrough` over failed records, or silently substitute fake
features.

When an embedding endpoint is unavailable, lexical retrieval MAY continue only
under an explicit degraded policy. Status and results report vector indexing
lag/unavailability until recovery.

## 13. Trust, privacy, and observability

### 13.1 Recalled memory is untrusted

Stored text, OCR, captions, transcripts, summaries, feature labels, and source
model output are untrusted user-derived data. A Memory result MUST never be
concatenated into `getOutputPremise`, a system message, developer policy,
capability grant, approval decision, or tool allowlist.

Recall crosses Module boundaries only as the explicit
`dolly.memory.recall/1` Block. An LLM consumer follows the trust-class and
prompt-construction rules in `llm-extension.md`, preserving the result as
delimited user/tool-level context. Text inside a recalled record has no authority
to change scope or instructions.

The Memory Module MAY expose a static Module description for its payload
schemas. That description MUST NOT contain dynamic recalled content, user records,
queries, summaries, endpoint data, or paths.

### 13.2 Data minimization

Configuration MUST declare which payload schemas, text fields, media-derived
features, sessions, and retention scopes are indexed. Unknown or disallowed data
is skipped. Logs, metrics, and ordinary errors MUST omit query text, recalled
text, vectors, media, signed URLs, raw provider errors, and credentials.

Derived text and vectors can reveal source content even when raw media has been
deleted. User-facing retention and deletion documentation MUST state this.

### 13.3 Required status and metrics

Status MUST expose, without leaking record content:

- namespaces and their isolation scope;
- active and pending index generations and descriptor digests;
- processed-through and complete-through watermarks plus gaps per Page;
- pending/running/retryable/dead-letter job counts and oldest-job age;
- records, segments, vectors, bytes, and strong references by feature kind;
- modality skip and unsupported counts by typed reason;
- query count, no-match count, degraded-mode count, and latency distributions;
- provider calls, retries, failures, token/item usage, and bounded cost where
  known;
- deletion and reindex progress; and
- corruption or recovery state.

High-cardinality owner, session, Block, asset, or query IDs MUST NOT be exported
as public metric labels. Privileged diagnostics may use opaque correlation IDs.

## 14. Experimental mechanisms

The following ideas come from the owner's research direction but are explicitly
outside the minimal baseline:

- daily or windowed summaries;
- memory-owned skills distinct from the Skill extension;
- a long-lived self-improvement or abstract-thinking prompt;
- tensity-based ranking, random retention, or forgetting;
- emotion, desire, surprise, or intensity extraction and matching;
- new-memory, in-day, access-count, or positive-feedback boosts;
- trajectory or sequence-shape matching;
- part-of-speech removal and relation-pattern embeddings;
- concept analogy, associative bridges, abstraction, or transfer;
- MMR or serendipity optimization presented as memory utility; and
- LLM-selected salience, synthesis, or factual consolidation.

All are disabled by default. An experiment MUST use separate configuration,
feature and index generations, result labels, metrics, and data retention. It
MUST NOT alter baseline records or scores in place, and baseline evaluation must
remain runnable without it.

### 14.1 Daily summary safeguards

If daily/windowed summary research is enabled, the window is identified by a
runtime-issued source activation request, not an ambiguous local date or fixed
sleep. The
background summarizer cannot emit directly; it submits a stable actor signal and
any output still obeys the zero-or-one Block contract.

Every factual summary statement MUST carry source MemoryRecord or valid Block
citations. Unsupported synthesis is labeled as inference. A summary with missing
or invalid citations fails validation. It remains untrusted recalled content and
MUST NOT become a system prompt merely because Memory generated it.

### 14.2 Sensitive inferred features

Emotion, desire, personality, salience, and behavioral inference are sensitive
derived data. Experiments require explicit owner policy, deletion/export support,
separate retention, and a documented harm evaluation. A model's confidence is
not ground truth, and constructing the evaluation label from the same intensity
being evaluated is invalid.

### 14.3 Promotion rule

An experimental mechanism becomes baseline or default only after:

1. a pre-registered protocol compares it with this baseline under equal data,
   model, token, latency, and cost budgets;
2. held-out results meet a predeclared minimum useful effect with uncertainty;
3. prompt-injection, privacy, deletion, recovery, and isolation tests pass;
4. operational regressions are within accepted bounds; and
5. an accepted ADR updates this specification and its conformance suite.

One handcrafted dataset, one run, a mock embedding, a model-authored score, or a
plausible anecdote is not sufficient evidence.

## 15. Configuration contract

The extension MUST publish a closed JSON Schema and versioned migrations under
`extension-process-protocol.md`. Baseline configuration declares at least:

- retention scope: `session` or explicit `owner-long-term`;
- Page topology and per-Page namespace behavior;
- allowlisted payload extractors and versions;
- record, segment, context, queue, concurrency, byte, storage, and time limits;
- retention mode and deterministic deletion/expiry policy;
- retrieval mode, immutable fusion profile, and typed threshold profiles;
- optional embedding and rerank model-operation references;
- media policy per modality and optional derived-text pipeline descriptor;
- explicit degraded behavior;
- `includeSourceRefs` plus its independent count/byte/time retention budget;
- automatic-recall policy, disabled by default; and
- active index-generation and migration policy.

The provider-independent defaults are:

- session-scoped isolation;
- one input Page per Memory Module;
- allowlisted text extraction only;
- lexical retrieval;
- media policy `skip`;
- features-only source retention;
- `includeSourceRefs: false`;
- no automatic recall; and
- every experimental mechanism disabled.

Selecting vector or hybrid mode without a compatible embedding descriptor is a
configuration error unless `degradedMode: lexical` is explicitly selected.
Selecting native image embedding against a text-only descriptor is an error,
not a reason to substitute OCR, captions, or a mock.

Raw endpoint credentials, complete Dolly configuration, host paths, object-store
keys, and private deployment details MUST NOT enter Memory configuration. The
extension receives only scoped capabilities and non-secret descriptor identity.

## 16. Deterministic conformance tests

The Memory baseline MUST pass an environment-independent suite using fake Core,
storage, media, model-operation, clock, and crash-injection fixtures. No private
service, public OSS access, model download, application programming interface
(API) key, internet connection, or billable call may be required.

The suite MUST cover at least:

### 16.1 Isolation and action contract

- instance, owner, session, owner-long-term, Page, and Memory Module isolation;
- missing identity failing closed;
- one Page per default namespace and separate subnamespaces for multi-Page input;
- one serialized action under overlapping input/background signals;
- zero-or-one BlockProposal with multiple queries aggregated into one result;
- input arriving during a run remaining for a later run; and
- query scope fields in model/user payloads unable to broaden authorization.

### 16.2 Indexing and loops

- self-output and every query/recall control item never creating an admission;
- duplicate Deliveries creating occurrences but one feature set;
- per-Module-job admissions remaining distinct from stable cross-Delivery FeatureJobs
  while both occurrences advance CoverageState independently;
- stable job IDs deduplicating duplicate wakeups and retries;
- bounded queue backpressure with no acknowledged silent loss;
- cancellation, old-generation fencing, partial provider batches, timeout, and
  one failed job not stopping others;
- crash after admission, strong-reference, feature, CoverageState, and tombstone
  transitions;
  and
- recovery reaching the same committed state as uninterrupted execution.

### 16.3 Lifetime and media

- committed admissions retaining source Blocks through strong references;
- asynchronous access acquiring fenced AccessLeases and releasing them on every
  terminal path;
- features-only completion removing source/media strong references;
- stale provenance never becoming a dangling Block reference;
- default media processing retaining no bytes, paths, base64, object keys,
  signed URLs, or upload handles;
- private signed provider-access cleanup; and
- media lineage deletion removing native and derived features.

### 16.4 Embedding and indexes

- a fake text-only descriptor accepting text and visibly rejecting image input;
- a fake native text/image descriptor with an explicitly shared vector space;
- explicit OCR/caption derived-text provenance and no implicit fallback;
- fake embeddings always labeled fake and never cached as real;
- dimension, metric, descriptor, modality, and vector-space mismatch rejection;
- old/new model generations never mixing during backfill and atomic switch;
- concurrent admission during backfill reaching the target through dual-write,
  catch-up watermarks, and the atomic switch revision;
- interrupted migration rollback and non-reindexable media records; and
- endpoint outage using only the configured failure or degraded path.

### 16.5 Retrieval and trust

- deterministic lexical, vector, and hybrid fixtures;
- raw distance/similarity preserved, rank never replacing score, and typed
  thresholds applied in the correct direction;
- hybrid components and degradation reported honestly;
- exact fusion/threshold profiles, missing-channel behavior, and a distinct
  lexical threshold during degraded mode;
- MVCC snapshot/read-lease stability under concurrent indexing and compaction;
- tombstone CAS preventing new admission, late provider resurrection, and
  recall/deletion commit races;
- current query Blocks excluded despite concurrent index completion;
- no-match explicit-query and silent automatic-recall behavior;
- context expansion remaining in namespace and separate from match score;
- aggregate output limits producing deterministic per-query errors rather than
  an invalid BlockProposal;
- source-reference retention being disabled by default and reported when
  enabled; existing recall Blocks remaining immutable after Memory deletion;
- adversarial recalled text remaining an untrusted Block and never entering a
  system prompt or Module description; and
- logs, errors, metrics, and snapshots containing no protected content.

All fixtures use deterministic IDs, clocks, vectors, tokenization, scores,
failures, and ordering. Tests MUST use state-based completion, not arbitrary
sleeps. A caught fatal error, permanent job failure, or skipped required case
MUST make the conformance command exit non-zero.

## 17. Evaluation gates

Conformance proves contract correctness, not retrieval usefulness. Any default
retrieval profile or experimental promotion also requires a separate evaluation
protocol. Every run MUST follow all gates, manifests, validators, live/paid
opt-ins, and promotion rules in `docs/experiments/protocol.md`. This section adds
Memory-specific requirements; it does not define a second gate sequence.

### 17.1 Protocol requirements

In addition to the global protocol, a Memory evaluation MUST:

- define task families and representative data before running;
- split tuning/development data from untouched held-out evaluation data;
- prevent the same conversation, source Block, near-duplicate, owner, or session
  from leaking across splits where that would inflate results;
- compare no-memory, lexical, vector, and justified hybrid modes under the same
  eligible corpus, query set, downstream information, and budgets;
- evaluate text-only, native-image, and derived-text paths separately;
- freeze extractor, descriptor, threshold, fusion, and index versions before
  held-out evaluation;
- report Recall@k and at least one rank-sensitive metric such as NDCG@k or MRR,
  plus precision/no-match behavior where automatic recall is used;
- measure downstream answer/task correctness and false-memory use separately
  from retrieval score;
- report indexing and query p50/p95 latency, queue lag, storage, provider calls,
  token use, failure rate, and cost where applicable;
- use paired uncertainty estimates, such as bootstrap confidence intervals, and
  predeclare the minimum meaningful effect; and
- retain a run manifest with commit, config, dataset hash, extractor, descriptor
  digest, model, seed, thresholds, and sanitized raw outcomes.

If any stochastic component remains, the protocol uses declared seeds and
enough repetitions to estimate variability. Model judging MAY supplement but
MUST NOT replace deterministic task validators where those are possible.
Global Gate 3 MUST exercise the selected profile through the real Dolly Core,
Delivery, actor, capability, restart, and cancellation paths; a standalone
retrieval script cannot satisfy integration evidence.

### 17.2 Gates

In addition to satisfying global promotion through Gate 5, a profile may be
recommended or made default only when:

1. all required conformance cases pass with no unhandled errors or skipped
   security/isolation cases;
2. namespace leakage, dangling references, silent data loss, silent modality
   fallback, and deletion resurrection are all zero in the test matrix;
3. held-out quality meets the predeclared useful-effect gate and its uncertainty
   rule against the selected baseline;
4. no critical task family regresses beyond its predeclared tolerance;
5. latency, queue lag, storage, and cost remain within published finite budgets;
   and
6. every scored result has complete namespace, snapshot, score, and feature
   provenance.

A real or paid provider run is optional and follows the explicit opt-in rules in
`model-provider.md`, including `RUN_PAID_INTEGRATION=1` and finite spend limits.
The presence of a credential MUST NOT activate it. A failed real endpoint MUST
not silently fall back to fake embeddings while preserving a `real` label.

## 18. Conformance claim

A Memory extension MUST NOT claim conformance while a required deterministic
test is skipped, while research behavior changes baseline results, or while a
configured modality is silently unsupported.

A conformance claim identifies the Core Runtime and Extension process protocol versions,
this specification revision, Memory schema and extractor versions, active
retrieval profile, embedding descriptor schema, and conformance-suite revision.
Plausible recalled text, a successful provider call, or an existing vector table
is not evidence of conformance.
