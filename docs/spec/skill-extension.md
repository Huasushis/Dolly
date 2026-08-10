# Dolly Skill Extension

Status: Draft

This document defines the minimal Skill extension contract. The baseline is a
deterministic catalog and Module description publisher for Agent
Skills-compatible content.
It does not call a large language model (LLM) to decide what to inject and does
not introduce a second manual skill-execution mechanism.

The exact external Agent Skills package format version is not yet accepted. A
package format is the versioned file layout and metadata contract used to
recognize an external skill package; it is not Dolly Module configuration. Its
official specification MUST be cited and frozen before this Draft is accepted;
the current document deliberately does not invent version-sensitive fields.

## 1. Purpose and non-goals

The Skill extension:

- discovers skill packages in explicitly granted libraries;
- validates their versioned package format and bounded static metadata;
- publishes a revisioned catalog through its output Module description;
- provides scoped read handles for authorized skill resources; and
- hot reloads valid changes through the normal serialized actor path.

The baseline does not:

- ask a model whether a skill should be injected;
- automatically copy full skill bodies into every prompt;
- execute a skill as a special remote procedure call (RPC) or bypass normal
  LLM/tool behavior;
- grant Bash, filesystem, network, process, provider, or secret authority; or
- treat skill instructions as trusted merely because parsing succeeded.

## 2. Relationship to Dolly contracts

The extension MUST obey `extension-process-protocol.md`, `core-runtime.md`, and
`security-operations.md`.

- One Skill Module has one `moduleId`, one private configuration, and one
  serialized actor.
- Filesystem discovery uses a deployment-granted library capability. Host paths
  are not part of the public Extension process protocol and MUST NOT appear in
  Blocks or Module descriptions.
- A watcher or timer is registered background activity. It submits a debounced
  source activation request with a stable `idempotencyKey`; only the resulting
  actor Run may publish catalog state.
- A run returns zero or one Block and MAY replace its input description, output
  description, or both. The normal catalog refresh needs no Block.
- Module description revision, validation, and stale-generation fencing are
  core-owned.

## 3. Configuration and capability grants

Configuration MUST have a strict versioned schema. It contains only non-secret
settings, including:

- named library grants to scan;
- accepted package format versions;
- include/exclude rules expressed in portable package identifiers, not host paths;
- finite file, package, catalog, and refresh limits;
- debounce and periodic verification intervals; and
- whether invalid packages fail the Module or are quarantined with diagnostics.

Each library grant is read-only by default and scoped to one approved root. A
separate write grant is required for any future authoring feature and is outside
this baseline. The extension MUST NOT inherit the daemon's home directory or scan
ambient project/user directories.

Bash or general file-reading tools used by an LLM are independent deployment
grants. Enabling the Skill extension MUST NOT enable those tools. A catalog may
advertise that a skill expects a capability, but text cannot grant it.

## 4. Catalog model

The canonical catalog is an immutable revision containing ordered entries:

```typescript
interface SkillCatalogEntry {
  skillId: string;
  formatId: string;
  formatVersion: string;
  name: string;
  description: string;
  packageDigest: string;
  entryResource: string;
  declaredResourceCount: number;
  declaredCapabilities: readonly string[];
  validationState: "valid" | "quarantined";
}
```

`formatId` and `formatVersion` identify the accepted external package format.
`entryResource` is an opaque resource handle or logical package-relative
identifier resolved by a scoped read capability. It is not an absolute path or
Uniform Resource Locator (URL). The accepted package format defines which
external static metadata maps into this canonical shape.

`skillId` MUST be stable for one configured package identity and MUST NOT be
derived only from a display name. Duplicate identifiers, case-folding collisions,
symlink/reparse escapes, unsupported format versions, malformed front matter,
ambiguous encodings, and over-limit packages MUST fail or enter quarantine
according to the configured policy.

Catalog order MUST be deterministic for the same validated library snapshot.
Filesystem enumeration order and watcher event order MUST NOT affect it.

## 5. Discovery and validation

Discovery MUST be static and MUST NOT execute package code, shell commands,
template expressions, imports, or network requests.

For every candidate package, the extension MUST:

1. resolve it under the granted library without symlink/reparse escape;
2. enforce package, file-count, per-file, total-byte, nesting, and parse-time
   limits before reading full content;
3. select one explicit package format;
4. parse and validate the required `SKILL.md` and declared resources;
5. calculate a deterministic package digest over the format-defined files;
6. sanitize metadata for Module description and user-interface display; and
7. publish only after the whole new catalog revision validates.

Unknown files MAY be ignored only when the selected format permits them. A
package cannot broaden filesystem scope through a manifest path. Active
Hypertext Markup Language (HTML), scripts, device files, pipes, sockets, and
credential-bearing links are never catalog resources.

## 6. Hot reload and lifecycle

Filesystem watcher events are hints, not truth. Events MUST be debounced and
coalesced into one source activation request with a stable `idempotencyKey`;
the actor then rescans the affected library or a safe deterministic subset.

A partial write MUST NOT replace the last valid catalog. The extension SHOULD
wait for a bounded stability window and then parse a fresh snapshot. A successful
refresh atomically publishes one new catalog and Module description revision.
Repeated watcher events for the same digest are idempotent.

Watcher overflow, unsupported filesystem semantics, or missed-event suspicion
triggers a bounded full rescan. Periodic verification MAY provide recovery but
MUST NOT overlap another run. Stop cancels watchers/timers, drains or cancels the
active scan, releases resource handles, and permits no late Module description update.

## 7. Module description publication

The Skill Module's output description is a bounded, deterministic catalog summary,
not concatenated full skill bodies. At minimum it contains stable skill
identifiers,
names, short descriptions, package format, and the logical operation for
reading an authorized entry resource.

If the catalog cannot fit the Module description limit, the extension MUST
publish a bounded index with deterministic pagination/query instructions. It MUST NOT silently
truncate an entry into misleading valid-looking metadata.

Skill text and metadata are untrusted by default. The Module description carries
provenance. The LLM extension encodes it as delimited untrusted context and
does not promote it to a system instruction. A deployment may explicitly trust a
specific pinned package digest, but that trust applies to prompt placement only;
it never grants host capabilities.

The extension MAY publish an input description for supported catalog
administration input in a future version. The baseline does not accept model-
generated installation, update, deletion, or trust decisions.

## 8. Skill resource access

An LLM or tool reads skill resources through a capability scoped to:

- owner/tenant and Dolly instance;
- requesting Module/session/conversation;
- exact library and skill package digest;
- allowed package-relative resources;
- byte, file-count, rate, and deadline limits; and
- read-only operation.

A changed package digest invalidates old resource handles. Resource reads return
bounded bytes/text plus digest and provenance; they do not return a host path.
Nested references remain within the same package unless another explicit grant
is selected. Network links in skill text are inert and require a separate
approved network/tool operation.

## 9. Security and privacy

Skill packages and library contents may be malicious. The extension MUST defend
against traversal, symlink/reparse races, special files, encoding attacks,
decompression/expansion bombs, watcher floods, metadata injection, terminal/log
escape, and prompt injection.

Catalog metadata, file bodies, parse errors, and package-relative names MUST NOT
expose secrets, unrelated host paths, environment variables, or another tenant's
library. Default logs contain identifiers, digests, sizes, state transitions, and
typed errors, not skill bodies.

No package content may change capability grants, approval policy, endpoint
configuration, Extension isolation, system prompt policy, or its own trust state.

## 10. Limits and observability

All limits are finite. Status MUST expose Module generation, active scan,
catalog revision/digest, valid and quarantined counts, watcher health, last full
verification, pending signal count, bytes/files scanned, and last typed error.

Structured events include discovery, quarantine/recovery, catalog publication,
watcher overflow, resource-handle issue/revocation, and stale-generation result.
They exclude package bodies by default.

## 11. Required conformance tests

A deterministic fake-library suite MUST cover:

- valid discovery and stable order independent of enumeration order;
- duplicate/case-colliding identifiers and unsupported format versions;
- malformed or partially written `SKILL.md` retaining the last valid revision;
- path traversal, symlink/reparse escape, special files, encoding and size bombs;
- watcher burst coalescing, overflow/full rescan, missed events, and stop races;
- stale-generation refresh unable to replace a newer catalog;
- Module description size bounds, deterministic pagination, and provenance;
- package digest change revoking old resource handles;
- cross-instance/session/tenant and out-of-package read denial;
- skill text unable to grant Bash, network, file, process, provider, or secret
  capabilities;
- no model/provider call during discovery, ranking, or publication; and
- operation with no private endpoint, owner path, credential, or internet access.

Platform tests MUST exercise actual containment and watcher behavior on supported
Windows, macOS, and Linux platforms; skipped platform security cases cannot claim
that platform's conformance.

## 12. Deferred research and features

Semantic skill ranking, automatic injection selection, model-generated skill
rewrites, remote registries, autonomous installation, and skill-effect scoring
are outside the baseline. They require separate threat models, approval user
experience, and the experiment protocol before entering a later contract.

## 13. Baseline implementation status

Status: implemented under `src/extensions/skill/`, not wired into any
production startup path. Conformance tests are under `tests/conformance/skill/`.

### 13.1 Accepted package format

The Draft above deliberately left the external package format unpinned. The
baseline pins it to the Agent Skills open standard published at
<https://agentskills.io/specification> (machine-readable mirror
<https://agentskills.io/specification.md>), retrieved 2026-07-26. Claude Code
documents its skills as following the same standard at
<https://code.claude.com/docs/en/skills>.

That document publishes no version number and the site index
(<https://agentskills.io/llms.txt>) lists no changelog page, so the pin is a
retrieval date rather than an invented version: `formatId` is
`agentskills.io/specification` and `formatRevision` is `2026-07-26`. Its
normative front matter fields are `name` (1-64 characters, lowercase `a-z`,
`0-9` and hyphens, no leading, trailing, or consecutive hyphen, and it must
match the parent directory name), `description` (1-1024 characters, non-empty),
`license`, `compatibility` (1-500 characters), `metadata`, and `allowed-tools`.

Front matter is parsed by a restricted YAML subset: `key: value` scalars plus
one level of nested `key: value` scalars, which covers every example in the
upstream document. Block scalars, sequences, flow collections, anchors, aliases,
tags, tabs, and duplicate keys are refused as malformed instead of guessed at.

### 13.2 Limits

| Limit | Default | Reason |
| --- | --- | --- |
| `maxSkillCount` | 256 | The upstream progressive-disclosure budget is about 100 tokens of always-loaded metadata per skill, so 256 already exceeds any bounded description; the description limit trims the rest deterministically. |
| `maxVisitedEntries` | 4096 | Bounds the directory walk itself against a wide or deeply fanned-out library, independently of how many skills are valid. |
| `maxEntryFileBytes` | 65536 | Upstream recommends `SKILL.md` under 500 lines and a body under about 5000 tokens; 64 KiB holds that including non-Latin scripts and still bounds one read. |
| `maxTotalBytes` | 4194304 | `maxSkillCount` times 16 KiB of average skill file, which bounds one scan's total read work. |
| `maxDirectoryDepth` | 4 | The upstream layout is `skill-name/SKILL.md`; depth 4 still allows a few grouping directories without an unbounded walk. |
| description `maxBytes` | 8192 | About two thousand tokens. The description rides on every downstream prompt assembly, so it must stay small next to the conversation. |
| description minimum | 1024 | Below this the header plus the omission and refusal notices cannot fit, so the caller gets a typed error instead of a header-only description. |
| `debounceMs` | 500 | Coalesces the several write events one logical edit or checkout produces while still reading as an immediate reload. |
| `maxDebounceMs` | 5000 | Bounds starvation when changes never stop arriving. |
| `periodicVerificationMs` | 300000 | Heals a missed, dropped, or unsupported watcher event within a working session without becoming a polling loop. |

Every refusal is reported in `SkillCatalog.rejections` with a typed code and a
library-relative subject. Nothing is silently skipped, and no host path appears
in a catalog entry, a rejection, or a description.

### 13.3 Hot reload stays inside the actor

A watcher or verification timer never touches the description. It calls
`SkillRefreshScheduler.notifyChange`, which debounces and coalesces hints into
at most one live source activation request whose `idempotencyKey` is stable
until the runtime reports that refresh complete, as `core-runtime.md`
sections 9.2.1, 9.5, and 11.3 require. Scanning the library and proposing the
replacement description happen only inside the serialized actor Run created from
that request. `stop()` cancels the timers and permits no later request.

`createSkillSourceActivationSubmitter` is the current component adapter to the
Core queue in `core-runtime.md` Section 11.3. It stores the exact reason,
monotonic request time, and coalesced signal count as canonical request data.
An exact duplicate is accepted as the already-live job. If Core reports queue
capacity pressure, the adapter throws before reporting success; the refresh
scheduler restores its pending window and waits for a later filesystem hint or
periodic verification instead of spinning or losing the change. The adapter
also rejects a request whose Module ID differs from the bound queue.

Conformance evidence covers the initial request, three filesystem hints
coalesced into one later request, and a full-queue refusal followed by admission
after capacity is released. The Scheduler and Reactive runtime component tests
cover Claim and atomic completion of the same queue representation. This is not
installed-process or product-bootstrap evidence.

### 13.4 Not implemented in this baseline

These are decisions, not omissions:

- no model or provider call anywhere, including for ranking or selection;
- no manual skill execution interface, adapter, or tool binding;
- no execution authority: no process, script, template, or network access, and
  `allowed-tools` is parsed and dropped rather than honoured;
- no reading of `scripts/`, `references/`, or `assets/`; only each candidate
  `SKILL.md` is read, and bundled resources are not digested or counted;
- no scoped skill resource read capability (section 8) and no catalog
  administration input description (section 7); and
- no production wiring: nothing is registered with `runtime-bootstrap.ts` or the
  Extension process host, and configured Modules remain rejected.

Section 11's platform requirement is only partly met on Windows: the directory
containment case runs there using a junction, but a file symbolic link needs a
privilege the test cannot assume, so that one case does not claim Windows
conformance.
