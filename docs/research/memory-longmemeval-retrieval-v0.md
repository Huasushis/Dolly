# LongMemEval-S repeated-position retrieval result

Status: rejected by the frozen version-4 decision rule on 2026-08-13.

## Decision

Do not implement the tested repeated adjacent-position association index and
do not advance it to a public Agent experiment. Keep content BM25 as the
retrieval baseline. This result does not authorize automatic recall, automatic
task resumption, Memory product wiring, or Module startup.

The result applies to this exact binary association design: a candidate gets a
single additive point when any query token is connected to any non-query token
in that candidate by an edge supported in at least two sessions. It does not
eliminate every possible learned or task-specific retrieval method.

## Formal evidence

The classifiable run is `retrieval-v4-20260813a`, frozen to source commit
`5703d8a4ab9e187fa514884009d47bedf9cd0491` and LongMemEval-S SHA-256
`08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894`.
It contains 500 projected questions, 147 development and 353 evaluation
questions, 2,000 condition rows, and 3,323 ranking vectors. It made zero model,
network, and paid calls.

The independent verifier returned `valid:true`, `classification:"rejected"`,
and no errors. All eleven checksum entries match. All eight preregistered
mutations were rejected with their exact expected primary error codes,
including gold replacement, forbidden projection data, message reordering,
ranking deletion, selected-weight substitution, metric forgery, checksum
removal, and secret-marker injection.

The earlier `retrieval-v3-20260813a` attempt is not evidence about retrieval
quality. It hit the frozen 1,800,000 ms limit during development treatment and
contains only the freeze, preregistration snapshot, split, and cases. It has no
ranking, selected weight, analysis, manifest, or classification. Version 4
changed only the equivalent graph representation, fixed three-worker
execution, verifier caching, source inventory, and artifact labels. Six real
dataset questions reproduced the complete version-3 rankings, rounded scores,
edge counts, and canonical edge bytes; 500 generated cases independently
matched treatment and verifier output before the version-4 run.

## Results

Development selected weight 0.25 for all three association conditions only
because all four grid values, 0.25, 0.5, 1, and 2, had the same macro NDCG@10
of 0.8922592856345359. This is the frozen smallest-weight tie break, not an
estimated useful weight.

On the 353 evaluation questions, content BM25 had NDCG@10
0.8900030338773225, Recall@10 0.9384324834749769, and Hit@10
0.9773371104815864. Recurrence without position, repeated adjacent-position,
and shuffled-position had exactly the same aggregate metrics. Each treatment
changed the top-10 ordering on 2 of 353 questions relative to content, but none
of those changes altered a relevance metric. Therefore repeated-position minus
each baseline had mean, lower 95 percent bound, and upper 95 percent bound all
equal to zero. The useful-effect gate failed.

Knowledge-update top-one error was 0.05454545454545454 for both content and
repeated-position, so the difference was zero and the knowledge-update
guardrail passed.

The repeated-position graph was also too large: its p95 edge bytes divided by
the normalized raw corpus bytes was 11.9049318479526, versus the frozen maximum
of 2. Its median and p95 edge sizes were 5,109,133 and 5,880,189 bytes, while
the corresponding raw-session corpus p95 was 508,376 bytes. The deterministic
cost gate failed. Recurrence without position was larger still, with a p95
ratio of 76.24236525728254; shuffled-position had p95 23.205516756188466.

## Engineering consequence

Remove repeated-position association raw from the current Memory candidate
list. Do not build the previously proposed one-hop association score/index
slice, because the retrieval-only screen found no relevance gain and a large
index-cost violation on public data.

The next Memory work should remain independent of Scheduler implementation and
should test a materially different, preregistered retrieval hypothesis. A
reasonable next experiment would compare bounded task-aware or learned
retrieval against BM25 on public data, with an explicit index-size budget and
without checkpoint, automatic injection, or automatic resume. The existing
checkpoint and checkpoint-plus-raw candidates remain rejected by the earlier
task-state experiment.
