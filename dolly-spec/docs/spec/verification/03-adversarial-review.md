# Adversarial review

Adversarial review assumes malformed input, arbitrary process death, reordered
completion, hostile content, exhausted resources, and honest components with
incompatible versions. A feature is incomplete until its rejection behavior is
as specific as its happy path.

## Review questions

### Representation

- Can duplicate JSON keys change what validation and deserialization see?
- Are integer ranges, string bytes, nesting, collection lengths, Unicode,
  non-finite numbers, and canonical bytes fixed?
- Can an unknown variant enter durable state and make replay version-dependent?
- Does any field trust Extension-supplied identity, source, time, or privilege?
- Can a reference cross instance, point forward, create a cycle, or outlive its
  target?

### Ordering and concurrency

- Is every tie broken by durable semantic data rather than completion order?
- Can two timers lease one Module or can an expired worker commit late?
- Does a retry reconstruct a batch instead of replaying its manifest?
- What happens when configuration changes while computation is running?
- Can cancellation race with result commit, shutdown, or lease expiry?

### Persistence

- Is every claimed atomic effect inside one actual database transaction?
- What state remains after kill before and after each write barrier?
- Can disk full, WAL checkpoint failure, corrupt rows, or migration failure
  advance a cursor or delete the only copy?
- Is backup a consistent snapshot with an authenticated manifest?

### Protocol

- Are length zero, oversized length, invalid UTF-8, partial EOF, deep JSON,
  duplicate IDs, unknown methods, request floods, and stderr floods bounded?
- Is Host/Extension call direction unambiguous?
- Can a notification bypass authorization or a stale generation reuse a
  capability token?
- Are deadlines, cancellation, heartbeat, and forced termination ordered?

### Configuration and hot reload

- Does `prepare` have side effects or depend on mutable ambient state?
- Can array-index JSON Patch target the wrong Module after reordering?
- What is visible when only some participants commit or rollback fails?
- Can context shrink, model replacement, or schema migration silently discard
  state?
- When one process hosts several Modules, does any global singleton, default
  database connection, cache, or shutdown callback conflate their storage
  scopes? When two processes host one package, can they conflate generations?
- Can a deleted configured Module ID or storage scope be reused, or can a
  snapshot/config edit restore state into a different logical Module?

### Assets and external I/O

- Can URL redirects, DNS rebinding, IPv6/private ranges, symlinks, junctions,
  archives, decompression, media decoding, or MIME spoofing escape policy?
- Is crop interpretation identical after EXIF orientation and provider resize?
- Can GC race with a new pin, failed remote delete, or backup?
- For every image/audio/video/file path, where do untrusted URL/path/cookie
  data end, where is MIME sniffed, which Asset identity is authoritative, and
  what survives stop/restart, lazy-source expiry, crop/transcode, and export?
- Can a Provider-declared image sniff as audio/file, cross a per-operation or
  aggregate size bound, leak a signed temporary URL through status, or become
  an Asset Part before `AVAILABLE`? Does a model-output lease close the gap to
  atomic Block reference creation without becoming an infinite pin?

### LLM, Memory, Skills, and tools

- Is every model/tool result treated as hostile structured input?
- Can prompt injection turn Dolly into a confused deputy?
- Can prompt text enlarge `requested_output_modalities`, or can a Provider
  return an unrequested modality, raw bytes/URL/file ID, or a forged BlockRef?
- After Provider completion and crash during output Asset import, can recovery
  allocate a new Import ID, reorder output ordinals, dispatch the Provider a
  second time, silently omit rejected media, or report success while status is
  still `running`?
- Does context compaction orphan tool calls, results, reasoning dependencies,
  Block references, or image identifiers?
- Can Memory index its own retrieval output, leak another session, assert a
  superseded fact, or fabricate evidence during consolidation?
- Can a Memory query be derived from the Memory Module's own emitted Block or
  from an earlier retrieval result, creating a self-reinforcing recall loop?
- Can the same Memory revision appear twice in one ModelRequest, or can a
  wall-clock-only rule incorrectly suppress it from a later request where it
  is relevant again?
- Can recalled text reach a system/developer/Premise boundary, mutate the
  advertised Module capabilities, or escape its typed untrusted evidence part?
- Can a changed `SKILL.md` gain capabilities without an authorized config
  decision?
- Can a Filter signal forge its source, exploit omission versus malformed
  presence, update twice through duplicate Delivery occurrences, overflow EMA
  arithmetic, smuggle Actions/ActionResults/authority into its copy, or make a
  nested Filter impersonate the original producer?

### Interactive channels and NapCatQQ

- Can event traffic mutate Premise, cause one Block per heartbeat/message, or
  make a lossy notification Page the only copy of a QQ message?
- Are consumer read/ack cursors bound to the Runtime-attested
  `(instance_id,module_id)` principal rather than a claimed Module/storage
  scope, and are result/hint Pages private while local acknowledgement,
  open-conversation state, and upstream QQ mark-read remain distinct?
- Can group-deny policy be bypassed through generic catalog invocation, media
  upload, message control, a stale view epoch, a registry revision race, or a
  prompt-injected QQ string?
- Can two transports or reconnects conflate two legitimate identical messages,
  or accept the same event twice? Is every unavoidable disconnect uncertainty
  represented as a gap rather than a lossless claim?
- After send/upload/moderation dispatch, can timeout or restart cause an
  automatic duplicate across the facade Activation and hub effect ledgers?
  Can an alias or second Extension process evade the daemon-wide
  Host-principal/actual-self owner, or can a second daemon claim active write
  even though v1 explicitly does not support it?
- Can catalog discovery expose credentials, cookies, raw packets, account
  process control, unauthorized conversation existence, or more capability
  merely because the upstream registry contains an operation?
- Can a strange upstream operation name bypass its canonical key/family,
  registry or sanitizer digest; can endpoint userinfo/query/fragment, local
  paths, signed URLs, nested `common.Part`, or aggregate output expansion cross
  the QQ boundary?

### Testament and LevelUpper research

- Can a Testament sandbox open production mutable storage, reuse credentials/
  capabilities, leak held-out or `oracle_only` material, share treatment state,
  reinterpret a snapshot without remapping, or promote its own output?
- Does every portable replay object receive fresh local Block/Asset/trace/
  Activation identity, and are recorded Actions inert unless independently
  remapped and authorized?
- Can LevelUpper turn authenticated peer data into trusted producer identity,
  executable Action authority, global Block IDs, cross-node cursor/order, or a
  false distributed transaction?
- Does ACK require durable local ingress? Do lost ACK, stale sockets, stale
  backups, sequence/hash forks, equal-content distinct occurrences, Asset
  resume, peer revocation, and share reload have explicit outcomes?
- Does bridge-owned origin/path/hop state terminate two-node and triangle loops
  even though every correct import starts a fresh local Core trace?

### Operations

- Do logs reveal secrets, private prompts, signed URLs, or unbounded labels?
- Does Windows behavior truly match Linux for locks, pipes, atomic replace,
  shutdown, path handling, and clock events?
- Can a crash loop, backlog, or hostile Extension exhaust CPU, memory, disk,
  processes, handles, metrics, or logs?

## Required attack corpus

`REQ-ADV-001` — The repository MUST maintain versioned corpora for hostile JSON,
framing, paths, URLs, media, archives, Extension behavior, provider responses,
MCP/tool responses, Skills, and configuration patches. Each entry names its
expected stable error or bounded behavior.

## Review exit rule

No open P0 or P1 issue is permitted at `spec-candidate`. A P2 may remain only
with an accepted risk ADR, disabled-by-default exposure, detection, and a dated
remediation owner. “The implementation probably handles it” is not evidence.
