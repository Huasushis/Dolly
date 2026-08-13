# LongMemEval-S retrieval screen protocol

This protocol selects or eliminates repeated adjacent-position raw retrieval as
a later experiment factor. It does not authorize a Dolly Memory index,
automatic recall, task resumption, a Module launch, a model call, or a network
request.

The only dataset is the local MIT-licensed LongMemEval-S file whose SHA-256 is
`08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894` and
which must contain 500 unique questions. The treatment receives question text,
ordered session identifiers, and ordered role/content messages. It must not
receive answer text, answer-session identifiers, question type, an inferred
gold label, or an inferred record-role label. The split driver may read
question type only to construct the frozen stratified split; it passes a closed
gold-blind projection to the treatment.

Within each question type, rows are sorted by lowercase SHA-256 of the UTF-8
bytes `question_type`, one NUL byte, and `question_id`. The first
`floor(0.30*n)` rows are development; the rest are evaluation. Development
chooses one association weight per association condition from
`[0.25, 0.5, 1, 2]` by macro NDCG@10, with ties going to the smaller weight.
Evaluation is opened once after those choices and development artifacts are
persisted.

Each supplied session is one retrieval unit. Its text is the supplied messages
in order, each encoded as lowercase role, `: `, exact content, and LF. Text is
Unicode NFKC-normalized and lowercased. Tokens are maximal Unicode
letter-or-number sequences of length at least two after removing the exact
stop-word list in the preregistration. There is no stemming, synonym expansion,
embedding, language model, or answer-derived feature.

Content ranking is BM25 with `k1=1.2`, `b=0.75`, and
`ln(1+(N-df+0.5)/(df+0.5))` IDF. An association edge is an unordered pair of
distinct tokens with at most one maximum proximity observation per session and
support in at least two distinct sessions. Repeated adjacent-position edges use
only messages at supplied distance one. The no-position control permits any
two distinct messages in a session. The shuffled control applies deterministic
Fisher-Yates inside each session using the first 32 bits of SHA-256 over
`question_id`, NUL, `session_id`, NUL, and `position-shuffle`, then applies the
same adjacent rule. The score added to a candidate is the maximum admitted edge
between a query token and a candidate token absent from the query. All four
conditions index the identical session bytes and return the same number of
session identifiers.

The independent analyzer recomputes the split, tokenizer, BM25, graphs,
development choices, rankings, Recall@1/5/10, hit@1/5/10, NDCG@1/5/10,
knowledge-update top-1 error, costs, and paired 10,000-resample bootstrap from
raw artifacts without importing treatment code. Artifact or dataset hash
mismatch, missing/duplicate rows, treatment access to forbidden fields,
non-finite measurements, resource abort, analyzer disagreement, checksum
failure, or surviving declared mutation makes the run inconclusive.

Repeated adjacent-position retrieval is retained for a separately
preregistered public revision-pinned Agent experiment only when its evaluation
NDCG@10 mean gain is at least 0.02 and paired lower 95 percent bootstrap bound
is above zero against each of content, no-position recurrence, and shuffled
position; its knowledge-update top-1 error is no more than 0.02 worse than
content; p95 per-question build is at most 500 ms, p95 query is at most 50 ms,
and p95 canonical association-edge bytes are at most twice normalized raw
session bytes. A structurally valid miss eliminates this association-index
design. No result enables automatic injection or task execution.
