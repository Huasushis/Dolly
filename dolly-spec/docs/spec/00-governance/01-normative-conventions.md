# Normative conventions

`REQ-NORM-001` — Every conformance claim MUST apply the requirement language,
precedence, closed-world input, time, determinism, and security interpretation
defined by this chapter; an implementation MUST NOT substitute its own default
interpretation for an omitted case.

## Requirement language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**,
**MAY**, and **OPTIONAL** are to be interpreted as in BCP 14 when, and only
when, they appear in uppercase. A requirement is normative only if it is in
`docs/spec/`, a machine-readable schema, or a golden vector explicitly named by
a normative requirement.

Normative requirements use stable identifiers:

- `REQ-<AREA>-NNN` for externally testable behavior;
- `INV-<AREA>-NNN` for invariants that must hold in every committed state;
- `<DOMAIN>_<NAME>` for stable error categories, for example
  `ACTIVATION_STALE_LEASE` or `STORAGE_FULL`;
- `EVT_<NAME>` for durable event kinds.

Identifiers are never reused. Deleted requirements remain reserved.

## Specification precedence

When two artifacts conflict, an implementation MUST stop conformance testing
and report `SPEC_CONFLICT`; it MUST NOT silently choose whichever is easier.
Editors resolve the conflict using this precedence:

1. numbered invariant or state-transition table;
2. JSON Schema plus its normative semantic constraints;
3. reference abstract-machine transition and golden vector;
4. other numbered requirement prose;
5. unnumbered prose;
6. examples and diagrams.

A JSON Schema validates shape, not all semantics. A schema accepting a value
does not override a semantic prohibition. Owner notes and the planning baseline
are evidence, not normative text.

## Observable semantics versus implementation

The specification fixes externally observable state, order, errors, recovery,
and security boundaries. An implementation MAY use actors, queues, tables,
shared pointers, or other internal structures if every observable behavior is
equivalent to the reference abstract machine.

No implementation may use UUID byte order, wall-clock scheduling order, hash
map iteration, filesystem directory order, or thread completion order as a
semantic ordering source unless a requirement explicitly says so.

## Closed-world input rule

Unless a versioned extension point explicitly permits otherwise:

- unknown object members MUST be rejected;
- duplicate JSON member names MUST be rejected before schema validation;
- unknown enum variants, Part kinds, Action kinds, RPC methods, and durable
  event kinds MUST be rejected;
- an unknown JSON-RPC notification MAY be ignored only where the wire protocol
  explicitly grants that forward-compatibility behavior.

The runtime MUST NOT repair, strip, truncate, reorder, or replace invalid input
and then commit it as if it were valid. A repair workflow, if offered to a user
or LLM, is a new attempt with a new audit record.

## Time, clocks, and quantities

- Persistent instants use RFC 3339 UTC strings with exactly six fractional
  digits and suffix `Z`.
- Durations on the wire are unsigned integer milliseconds unless the field
  name declares another unit.
- Deadlines and lease expiry are evaluated against an injected monotonic clock.
- Wall-clock changes never shorten or extend an already-created monotonic
  lease.
- Byte limits count UTF-8 encoded bytes after canonical JSON serialization.
- Token limits are provider-profile estimates and never replace byte limits.

## Determinism boundary

Core state transitions MUST be deterministic given:

1. the prior durable state;
2. one validated command;
3. injected wall and monotonic time values;
4. injected random bytes, if the transition allocates an opaque identifier.

LLM, network, filesystem, and Extension outputs enter Core only as validated
commands. Replaying the durable journal with recorded inputs MUST reproduce the
same Core state and output digests.

## Security language

“Process isolated” means a failure and lifecycle boundary. It does **not** mean
an Extension is sandboxed. A capability grant is necessary but not sufficient
for OS-level isolation; the threat model specifies both.

## Informative references

- [BCP 14 / RFC 2119 and RFC 8174](https://www.rfc-editor.org/info/bcp14)
- [JSON-RPC 2.0](https://www.jsonrpc.org/specification)
- [JSON Schema 2020-12](https://json-schema.org/draft/2020-12)
- [JSON Patch, RFC 6902](https://www.rfc-editor.org/rfc/rfc6902)
