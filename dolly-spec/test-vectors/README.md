# Test vectors

Vectors are executable examples for the pure reference abstract machine and
wire parsers. They do not weaken normative prose.

Each vector records:

- stable test ID and covered requirements/invariants;
- exact prior state or named fixture;
- injected clock or random values whenever the case consumes them;
- one or more deterministic commands, events, or byte properties;
- observable state assertions, emitted events, and stable error/output;
- crash label where applicable.

Once a named fixture receives canonical fixture bytes, its vector SHOULD also
pin the expected canonical state digest. A draft vector MUST NOT fabricate a
digest for a fixture whose serialization has not yet been implemented.

`core/` covers transitions and invariants; `protocol/`, `services/`,
`extensions/`, and `config/` cover their corresponding boundaries. Every JSON
file outside `fixtures/` and the two `*.schema.json` files is a current
mandatory conformance vector, not a placeholder. Named initial states and
drafts resolve to closed fixture envelopes under `fixtures/`; a harness applies
the vector's explicitly listed overrides after loading the fixture.
Implementations MAY translate the declarative assertions into
their native harness, but MUST preserve the test ID, stimulus, injected values,
and observable outcome.

Assertion paths are RFC 6901 JSON Pointers into the observable result.
`equals` and `not_equals` compare the complete value, `contains` requires the
listed scalar or member, and `count` compares an array/object cardinality.
`absent` requires that the path does not resolve. `unchanged` compares the
resolved value with the same path in the initial observable state. The latter
two operators therefore forbid a `value` member; every other operator requires
one. In particular, `absent` never means “present but unequal.”
