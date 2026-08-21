# Memory product lexical replay v0 result

Status: rejected by the frozen decision rule on 2026-08-21.

## Decision

Do not wire the product lexical representation into an installed, durable
journal or configured Module startup at this time. The sealed run produced
typed treatment failures and missed three noninferiority/cost gates, so the
preregistered decision rule classifies the result as rejected. Nothing in this
outcome is installed or durable, and no product wiring was performed.

Scope of this result: the product lexical representation replay only
(`mode: "lexical"`, 512-byte segments, 64-byte overlap, NFC normalization,
record-level ranking with rank-then-duplicate occupancy). It is not evidence
about `automaticRecall`, automatic resume, vector/hybrid retrieval,
association expansion, checkpointing, or Module startup;
`RUNTIME_MODULE_MIGRATION_REQUIRED` remains unchanged.

## Formal evidence

- Source commit: `ceed3d36f0b1d4a1668303c897282f84ef4d9e6f`
  (`feature/memory-product-lexical-replay-v0-harness`, local == origin, tree
  clean before and after the run).
- Dataset LongMemEval-S SHA-256
  `08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894` at
  `test/memory-data/benchmarks/conversation-memory/longmemeval/longmemeval_s`;
  500 questions, 147 development, 353 evaluation.
- Frozen v4 reference run `retrieval-v4-20260813a`: full checksum inventory
  verified before treatment (11 entries all matching).
- Run `product-lexical-v0-20260821a` at
  `artifacts/experiments/probes/memory-product-lexical-replay-v0/runs/product-lexical-v0-20260821a`.
  Sealed bundle SHA-256 per `sha256sums.txt` outside this document:
  - `cases.jsonl` `d1066cfa…`
  - `split.jsonl` `b658f077…`
  - `treatment.jsonl` `92de38dc…`
  - `product-rankings.jsonl` `6ff2bf67…`
  - `analyse.json` `7a769af1…`
  - `run-manifest.json` `329aa6e1…`
  - `mutation-summary.json` `616a7f0d…`
  - `command.txt` `8c77d996…`
- 0 model calls, 0 provider calls, 0 network requests.

## Result

500 treatment rows were produced gold-blind: 493 ok, 7 failed (5
coverage-failure, 2 permanent-error; 5 of the failures fall on evaluation
rows, 2 on development rows). Any typed failure closes the row and forces
classification `rejected`.

Independent verifier returned `valid:true` after finalize; all 9 registered
mutations were rejected with their exact expected codes, and all 8 checksum
entries matched.

Classification: `rejected`, 4 failed metric gates on 348 scored evaluation
rows:

- `ndcg10-lower95`: fail;
- `recall10-lower95`: fail;
- `knowledge-update-error`: pass — product error 0.0727 minus reference error
  0.0545 = 0.0182 <= 0.02;
- `coverage-terminal`: fail (5 failed evaluation rows);
- `cost-ratio-p95`: fail — p95 `canonicalFeatureBytes / coveredNormalizedBytes`
  = 3.095 > frozen limit 2;
- `structural-validation`: pass (data from `analyse.json`).

Because typed failures are present, the classification is `rejected` by the
preregistered rule regardless of the efficacy gates. The result does not
authorize any product wiring; a later attempt may change one preregistered
representation factor using development data and must receive a new version
and sealed evaluation.

## Repro commands

```sh
# gold-blind treatment (run dir created O_EXCL; inputs under the heavy lock)
npx tsx scripts/experiments/probes/memory-product-lexical-replay-v0/run.mjs \
  --cases <sealed cases.jsonl> --run <run-id> --max-workers 3
# finalize (gold handoff + mutation harness)
npx tsx scripts/experiments/probes/memory-product-lexical-replay-v0/finalize.mjs \
  <run-dir> --split <split.jsonl> --reference <reference.jsonl>
# independent verification
npx tsx scripts/experiments/probes/memory-product-lexical-replay-v0/verify.mjs \
  <run-dir> --reference <reference.jsonl>
```

Sealed inputs for this run were derived from the frozen `retrieval-v4` run:
`cases.jsonl` is the v4 case projection bound by `caseSha256`; `split.jsonl`
maps each v4 question to `{question_id, question_type, split, goldSessionIds}`;
`reference.jsonl` is the frozen `content` top-10 ranking
`{questionId, rank, sessionId}` for the 353 evaluation questions.
