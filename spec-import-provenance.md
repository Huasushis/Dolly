# Spec import provenance

Imported into branch `spec/import` from the authoritative owner-supplied archive:

- Source: `/home/ubuntu/codex-dolly/dolly-spec(2).zip` (left unmodified)
- Archive SHA-256: `f828f64f45a3c48c096eb998a24c8a52807dfacaffb5adc028edd3efa202cf5b`
- Archive size: 701,987 bytes; entries: 277; uncompressed bytes: 2,061,514
- Extraction: fresh exclusive no-clobber dir `/home/ubuntu/codex-dolly/.tmp/spec-extract-K0eQWw9XoDhW/`
  (audit ordering: central-directory scan before any extraction; zero symlink/traversal/
  special-file/encrypted entries; zero case/Unicode-fold collisions)
- Per-file SHA-256 manifest: `/home/ubuntu/codex-dolly/.tmp/spec-receipt/manifest-v1.json`
- Import verification: 277/277 staged files match the manifest (byte-faithful; `VERIFY: PASS`)
- Imported tree lives only under `dolly-spec/`; no archive wrapper name stripped
- Receipts: `/home/ubuntu/codex-dolly/.tmp/spec-receipt/authority-receipt-v1.txt`,
  `inventory.txt`, `guided-goal-plan.md`, `requirements-ledger.jsonl`, `task-ledger.jsonl`

No content outside `dolly-spec/` was altered. Head of the worktree is the pre-import
commit `c8c6712f9c6707daed86b59795e3aa591dfe9b50`.

## Repository-owned overlay

`test-vectors/` at the repository root is owned by this repository and
extends the imported set with locally authored conformance vectors (see
`test-vectors/OWNERSHIP.md`). `TST-CORE-017` is such a vector and lives in
`test-vectors/core/`, outside this imported tree. The `dolly-spec/` subtree
is byte-identical to the import commit (`git diff fd5b252 -- dolly-spec/`
is empty).