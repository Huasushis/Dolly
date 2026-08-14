# test-vectors/ ownership

This directory is owned by this repository (Huasushis/Dolly), not by the
imported `dolly-spec/` tree. It exists so repository-authored conformance
vectors can extend the byte-faithful owner-spec snapshot without being
written inside `dolly-spec/`, whose import provenance is fixed.

- Imported vectors: `dolly-spec/test-vectors/**` — authoritative owner
  archive SHA-256 `f828f64f45a3c48c096eb998a24c8a52807dfacaffb5adc028edd3efa202cf5b`;
  see `spec-import-provenance.md`. The imported subtree must stay
  byte-identical to import commit `fd5b252`.
- Overlay vectors: `test-vectors/**` — this directory.

Naming mirror: overlay files use the same `TST-*`/`dolly.test-vector/v1`
conventions and the same subdirectory layout as the imported snapshot so
both vector runners merge the two roots deterministically (imported root
wins on name collisions).

## core/

`TST-CORE-017-lease-generation-replay-collision.json` is a
repository-authored conformance vector (originally authored in commit
`dc6f258`, carried onto the WP-003 branch by `43ebc3c`, moved out of the
imported subtree here). It asserts that an IssueLease replay of an existing
`lease_id` that omits `extension_generation` is refused with
`STORAGE_IDEMPOTENCY_CONFLICT` when the stored lease carries an explicit
generation. It is wired into the TypeScript and Rust vector runners as the
seventeenth immutable Core vector; the imported set `TST-CORE-001` through
`TST-CORE-016` is untouched.

`TST-CORE-018-lease-generation-malformed-pool.json` and
`TST-CORE-019-lease-generation-malformed-binding.json` are
repository-authored conformance vectors closing the persisted-generation
presence-parity fix. They seed durable state through the vector's untyped
`initial` block, so no imported schema change is needed.

- `TST-CORE-018`: an IssueLease whose compatible persisted generation
  candidates include a present-but-malformed `"8"` is refused with
  `CORE_STATE_GENERATION_INVALID` instead of coercing it to `8`
  (TypeScript and Rust fail closed on the candidate pool).
- `TST-CORE-019`: a ReceiveResult whose persisted lease carries a
  present-but-malformed `"8"` `extension_generation` is refused with
  `ACTIVATION_FENCE_INVALID` even when the host proof omits
  `extension_generation` (Rust previously bound `None == None`).

They are wired into the TypeScript and Rust vector runners as the
eighteenth and nineteenth immutable Core vectors.