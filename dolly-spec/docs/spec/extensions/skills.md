# Skills Extension Specification

Status: **normative for Dolly v1 catalog behavior**.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

`REQ-SKILL-001` — A Skills Extension conformance claim MUST satisfy every
normative discovery, precedence, validation, revision, trust, permission,
failure, and conformance test obligation in this chapter.

## 1. Responsibility and prohibition

The Skills Extension discovers, validates, resolves, and publishes a revisioned catalog of Agent Skills. It does not call an LLM and MUST NOT execute Skill scripts, install dependencies, edit a Skill, enable an untrusted Skill, grant tool permissions, append a Page, or change Core state outside normal descriptor-update protocol.

The built-in v1 package Extension ID is `org.dolly.skills`; every catalog Action
name and owned metadata namespace uses that exact owner.

Skill instructions are untrusted content. Catalog presence is not authorization to execute commands or access resources.

## 2. Configuration

Configuration MUST be strict, revisioned, and include the ordered root set, root trust and enable policies, supported Agent Skills schema revisions, maximum manifest/resource sizes, scan debounce, full-rescan interval, snapshot retention, and resource-read policy. Unknown fields MUST be rejected. A hot reload MUST validate and build a complete candidate catalog under the new revision before it becomes active; in-flight reads remain pinned to their prior revision.

## 3. Roots and precedence

Configured roots have the fixed precedence:

```text
instance > user > bundled
```

Within one root, duplicate canonical Skill names are an error; filesystem enumeration order MUST NOT decide. Across roots, the highest-precedence valid and enabled Skill wins, while every shadowed source remains visible to authorized management diagnostics.

Each root MUST have a stable ID, trust class, read boundary, and enable policy. Symlinks escaping the canonical root MUST be rejected. Case-folding collisions MUST be detected on every supported filesystem.

## 4. Validation and catalog

A Skill directory MUST contain a `SKILL.md` that conforms to the configured Agent Skills schema revision. At minimum, canonical name and description MUST be available for progressive disclosure. Names MUST be normalized according to that schema and MUST be unique after normalization.

The catalog entry MUST contain name, description, selected source, trust class, enabled state, content hash, schema revision, required tools/capabilities if declared, referenced-resource manifest, validation diagnostics, and catalog revision. Durable Extension state consists of immutable catalog snapshots, the active revision pointer, root scan generations, and diagnostics; temporary filesystem events are not semantic state. Startup premise MUST expose only the bounded catalog metadata needed for selection, not every full instruction file.

Unknown or invalid metadata MUST not be guessed. An invalid higher-precedence Skill MUST be reported; it MUST NOT silently shadow a valid lower-precedence Skill unless policy explicitly reserves the name.

## 5. Inputs, outputs, and actions

Inputs are filesystem change notifications, periodic rescan wakeups,
configuration revisions, and explicit catalog Actions contained in committed
Blocks selected into an Activation. Outputs are an atomically published catalog
snapshot, a descriptor-changed notification, diagnostics, and for every
consumed catalog Action an `ActionResult` JSON Part in the Activation's single
optional output BlockDraft. There is no direct cross-Extension action RPC.

The stable read-only actions below MUST target a Module configured with
Extension owner `org.dolly.skills`:

- `org.dolly.skills.list(filter, catalog_revision, cursor, limit)`;
- `org.dolly.skills.resolve(name, catalog_revision)`;
- `org.dolly.skills.get-manifest(name, catalog_revision)`;
- `org.dolly.skills.get-resource(name, relative_path, catalog_revision, byte_range)` when policy permits.

Every complete committed catalog Action MUST conform to
[`schemas/skills-action.schema.json`](../../../schemas/skills-action.schema.json).
That schema freezes required nulls, pagination, byte-range bounds, target
presence, and unknown-field rejection. A null `catalog_revision` selects the
latest fully published revision at Activation start; the response MUST record
the exact revision used.

All relative paths MUST resolve within the selected Skill root. Resource reads MUST be bounded, binary-aware, and return content hash and truncation state. Script resources are returned as data; invocation requires a separately authorized sandboxed tool action.

Catalog reads MUST be pinned to one revision for their response. A missing requested revision MUST return `CATALOG_REVISION_GONE`, not silently switch to the latest.

For a successful read action, `ActionResult.result` MUST conform to the mapped
fragment below. Failed or unknown reads use the common `ActionResult` envelope
with `result: null`.

| Action | Successful result schema |
|---|---|
| `org.dolly.skills.list` | `schemas/skills-result.schema.json#/$defs/ListResult` |
| `org.dolly.skills.resolve` | `schemas/skills-result.schema.json#/$defs/ResolveResult` |
| `org.dolly.skills.get-manifest` | `schemas/skills-result.schema.json#/$defs/ManifestResult` |
| `org.dolly.skills.get-resource` | `schemas/skills-result.schema.json#/$defs/ResourceResult` |

Every row is a `result_schema.uri`; all rows bind the same verified transitive
bundle digest for `skills-result.schema.json` and semantic validator
`{"id":"org.dolly.validator.skills-result","revision":1}`. The
ActionContract argument binding names the applicable installed argument schema
bundle and uses its declared validator, or `null` when JSON Schema is complete.

List entries MUST be ordered by canonical Skill name. The opaque cursor is
bound to the filter and catalog revision. A returned catalog entry's embedded
`catalog_revision` MUST equal the enclosing result revision. `content_hash`
always covers the complete selected resource, not merely the returned range.
For resource data, `utf8` is permitted only for valid UTF-8 bytes; otherwise
the encoding MUST be canonical padded RFC 4648 `base64`. `returned_bytes` is
the decoded byte count, `offset + returned_bytes` MUST NOT exceed
`total_bytes`, and `truncated` is true exactly when bytes remain after the
returned range. After JSON Schema validation, the bound Runtime validator MUST
decode `data` according to `encoding`, require its decoded length to equal
`returned_bytes`, require `offset + returned_bytes <= total_bytes`, require
`truncated == (offset + returned_bytes < total_bytes)`, and enforce the original
frozen Action's requested byte range and effective byte limit. Integer addition
MUST be checked without overflow. The validator performs no filesystem read and
does not substitute a current catalog revision.

## 6. Hot update

File notifications are hints. The Extension MUST debounce them and build a complete candidate snapshot in isolation. It MUST validate every changed entry and all name collisions before one atomic catalog-revision swap. Readers see either the old or new snapshot, never a mixture.

A periodic full rescan MUST repair missed notifications. Repeating a scan with identical selected file hashes MUST not increment the catalog revision or emit descriptor change. A failed candidate scan MUST leave the previous snapshot active and publish diagnostics.

Disabling or removing a Skill MUST remove it from LLM-visible catalog metadata at the new revision. In-flight Activations retain their pinned old revision and resource hashes; new Activations use the new revision.

## 7. Trust and permission semantics

Untrusted or disabled Skills MUST be absent from the ordinary LLM catalog. A Skill declaration of required tools is advisory metadata; actual tool capability comes only from Module/Core configuration. A Skill MUST NOT expand its own filesystem root or request credentials by naming them.

Automatic Skill generation or automatic enablement by Memory/LLM is outside stable v1. If researched later, generated candidates MUST enter an untrusted quarantine and follow explicit review and promotion.

## 8. Failure and idempotency

Scan jobs MUST be keyed by root revision and observed change generation. Duplicate notifications MAY coalesce. A crash during candidate construction MUST not affect the active snapshot. Diagnostics MUST use stable codes for invalid manifest, duplicate name, case collision, path escape, missing resource, unsupported schema, too-large resource, permission denied, and I/O failure.

Skills Extension failure MUST not stop Core or remove an already-published valid snapshot. Read actions MAY be retried against the same catalog revision.

## 9. Conformance tests

Tests MUST cover precedence, same-root duplicate, case-only collision, invalid high-precedence entry, symlink and traversal escape, huge/binary resources, decoded-length mismatch, range overflow or out-of-bounds totals, false `truncated` values, result-validator revision mismatch, missed notification repaired by rescan, event storms/debounce, crash before swap, identical scan no-op, removal and disablement, pinned old revision, concurrent readers during swap, untrusted hiding, script non-execution, advisory capability non-escalation, and proof that catalog updates cannot directly change Pages, cursors, tool grants, or prompts outside the descriptor protocol.
