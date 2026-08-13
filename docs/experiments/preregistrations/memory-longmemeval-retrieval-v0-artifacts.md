# LongMemEval-S retrieval artifact contract

This contract is part of experiment version 3 and is frozen before the first
retrieval run. A classifiable run lives only at
`artifacts/experiments/probes/memory-longmemeval-retrieval-v0/runs/<runId>/`,
where `runId` matches `[a-z0-9][a-z0-9._-]{0,79}`. Failed or interrupted
attempts are not classifiable and must use a different run ID; no file may be
overwritten. Mutation copies live outside `runs/` under a temporary or
`verification-mutations/` directory.

All JSON and JSONL are UTF-8 without BOM. Canonical JSON recursively sorts
object keys by UTF-16 code-unit order, uses ordinary `JSON.stringify` scalar
encoding, contains no insignificant whitespace, and ends with exactly one LF.
JSONL is one canonical object plus LF per row, with no blank lines. Readers
reject noncanonical bytes, duplicate keys as exposed by noncanonical re-encode,
CRLF, non-finite numbers, and negative zero.

The complete bundle contains exactly these files:

```text
run-freeze.json
preregistration.json
split.jsonl
cases.jsonl
development-rankings.jsonl
selected-weights.json
evaluation-rankings.jsonl
analysis.json
run-manifest.json
validation.json
mutation-validation.json
sha256sums.txt
```

`run-freeze.json` is written first and identifies experiment version 3, the
run, source commit, exact preregistration/protocol/dataset hashes, every
result-affecting source path and hash, the exact checksum file list, and
`resultComputationStarted:false`. Every registered source path must be clean
relative to the recorded commit before the first ranking is computed. Unrelated
workspace changes may make `dirtyWorktree:true` but cannot substitute for the
registered per-file hashes.

`preregistration.json` is the canonical JSON snapshot of the preregistration;
the raw source-file hash is registered separately in `run-freeze.json`.
`split.jsonl` has 500 closed gold-aware rows
`{schemaVersion,questionId,questionType,splitDigest,split,caseSha256,distinctGoldSessionIds}`
and is visible only to the split driver, development selector, runner-side
analyzer, and independent verifier. `cases.jsonl` has exactly 500 treatment
input rows; each row itself is the closed
`{question_id,question,sessions:[{session_id,messages:[{role,content}]}]}`
object with no wrapper. `caseSha256` covers its canonical JSONL line including
the LF. Cases contain no question type, gold, date, `has_answer`, or source
object. Both files use ascending question ID and unique IDs.

Each ranking JSONL row is closed
`{schemaVersion,questionId,caseSha256,split,conditionId,variants,cost}`; each
evaluation row additionally binds `selectedWeightsSha256`. A variant is
`{weight,ranking,returnedRawSessionBytes}` and ranking contains exactly the
first ten or all retained sessions when fewer than ten, as closed
`{rank,sessionId}` objects. Scores are deliberately absent: the treatment
sorts on unrounded binary64 values, and the verifier recomputes that order
instead of re-sorting rounded artifact scores. Development has 588 rows and
1,911 variants. Evaluation has 1,412 rows and variants. Cost is closed
`{buildMilliseconds,queryMilliseconds,edgeCount,edgeBytes,corpusRawSessionBytes}`;
time must be finite and nonnegative but is descriptive, while counts and bytes
are independently exact.

`selected-weights.json` is closed
`{schemaVersion,developmentRankingsSha256,selectedWeights,selections}` with
exactly the three association conditions, all four ordered candidate means,
and frozen-grid values. It is written after all development ranking bytes and
before evaluation starts. `analysis.json` binds the selected-weight and
evaluation-ranking hashes and is closed with exactly
`{schemaVersion,selectedWeights,developmentConditionMetrics,conditionMetrics,
contrasts,knowledgeUpdate,cost,gates,classification,selectedWeightsSha256,
evaluationRankingsSha256}`. `developmentConditionMetrics` describes the four
conditions after applying the selected weights to development rankings;
`conditionMetrics` describes evaluation. Both contain exact Recall, hit, and
NDCG at 1, 5, and 10. The remaining objects contain the three frozen paired
contrasts, knowledge-update guardrail, per-treatment descriptive costs,
decision gates, and final classification. The independent verifier recomputes
every nested value and rejects extra or missing top-level fields.

`run-manifest.json` is closed, has `attemptStatus:"complete"`, exact counts,
zero network/model use, the analysis repeated as aggregate metrics, and
`validatorResults:{status:"pending",path:"validation.json"}`. It is immutable;
validation never rewrites scientific artifacts. Its nested configuration,
dataset, seeds, resource budgets, accounting, output declarations, validation
pointer, and aggregate pointer are exact closed values. `startedAt` equals the
freeze time; `finishedAt` is the ISO instant when primary rankings, analysis,
and manifest became complete and cannot precede `startedAt`. Finalization is
still charged to the same wall-clock and resident-memory budget, but its finish
instant is deliberately not written into the deterministic validation files.
`validation.json` and `mutation-validation.json` are deterministic summaries
without timestamps, temporary paths, exception stacks, or environment text.
The validation check list and each mutation's changed-file list are exact, not
merely nonempty.

The finalizer first verifies the primary artifacts, executes all eight declared
mutations on isolated copies while recomputing ordinary artifact checksums,
writes `mutation-validation.json`, writes the deterministic validation
candidate, then writes `sha256sums.txt`. The checksum file contains every file
above except itself, in the exact order shown, lowercase 64-hex SHA-256, two
ASCII spaces, relative ASCII filename, LF, and no blank line. A final read-only
verification checks the complete bundle, validation summaries, mutation IDs,
and checksum inventory. A partial bundle is inconclusive and can never be
supported or rejected.
