# LongMemEval-S retrieval screen protocol

This version-4 protocol selects or eliminates repeated adjacent-position raw
retrieval as a later experiment factor. It does not authorize a Dolly Memory
index, automatic recall, task resumption, a Module launch, a model call, or a
network request. Versions 1 and 2 were replaced before any dataset run. The
only version-3 attempt reached the frozen 30-minute limit during development
treatment before writing either ranking file, selected weights, analysis, or a
manifest. Version 4 therefore changes only the implementation strategy and
artifact version labels: data, split, formulas, conditions, weights, metrics,
decision gates, and resource limits remain unchanged. No retrieval ranking or
outcome was available or inspected while making this replacement.

## Dataset adapter and gold isolation

The only dataset is the local MIT-licensed LongMemEval-S file with SHA-256
`08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894`.
It must contain exactly 500 rows with unique nonempty `question_id` values and
the six exact question-type counts frozen in the preregistration. The adapter
validates the complete source row, but constructs treatment input recursively:

```text
{
  question_id: string,
  question: string,
  sessions: Array<{
    session_id: string,
    messages: Array<{ role: string, content: string }>
  }>
}
```

The adapter copies only those fields. In particular it does not spread or
serialize source messages, because some source messages contain the gold field
`has_answer`. A later occurrence of the same session identifier must have a
byte-identical ordered role/content array or the run aborts; the adapter then
retains only the first occurrence and its aligned message array. Empty sessions
and empty message content remain valid retrieval data; an empty session has
document length zero. Duplicate gold session identifiers are reduced to
distinct IDs. Every distinct gold identifier must name a retained retrieval
unit.

The treatment never receives `answer` (which may be text or a number),
`answer_session_ids`, `question_type`, `has_answer`, dates, an inferred gold
label, or an inferred record-role label. The split driver may read
`question_type`. A separate gold-aware selector and analyzer may read distinct
gold session IDs only after treatment rankings have been persisted. Gold is
never an argument to tokenization, graph construction, ranking, or timing.

## Split and execution order

For a row, compute lowercase hexadecimal SHA-256 of the UTF-8 bytes formed by
`question_type`, one NUL byte, and `question_id`. Within each question type,
sort by that digest and then by UTF-16 code-unit ascending `question_id` to
resolve any digest collision. The first `floor(0.30*n)` rows are development;
the rest are evaluation. Exact counts are:

| Question type | Total | Development | Evaluation |
| --- | ---: | ---: | ---: |
| knowledge-update | 78 | 23 | 55 |
| multi-session | 133 | 39 | 94 |
| single-session-assistant | 56 | 16 | 40 |
| single-session-preference | 30 | 9 | 21 |
| single-session-user | 70 | 21 | 49 |
| temporal-reasoning | 133 | 39 | 94 |
| Total | 500 | 147 | 353 |

Development produces 588 question-condition rows and 1,911 ranking vectors:
one content vector plus four weight variants for each of three association
conditions per question. The gold-aware selector chooses one weight per
association condition from `[0.25, 0.5, 1, 2]` using the unrounded macro
development NDCG@10, with an exact tie going to the smaller weight. It persists
the rankings, metrics, and selected weights before evaluation opens.
Evaluation then produces exactly 1,412 question-condition rows and 1,412
ranking vectors, using only the persisted selected weights. Thus the run has
2,000 condition rows and 3,323 ranking vectors. Question rows and artifact rows
use UTF-16 code-unit ascending `question_id`; conditions use `content`,
`recurrence-no-position`, `repeated-adjacent-position`, then
`shuffled-position`.

## Text and BM25

Each first-occurrence session identifier is one retrieval unit. BM25 text is
the supplied messages in order, each encoded as lowercase role, `: `, exact
content, and LF. The complete string is Unicode NFKC-normalized and Unicode
lowercased. Tokens are maximal Unicode letter-or-number sequences with at
least two Unicode code points after removing the exact preregistered stop-word
set. Query terms are the first occurrences of the resulting question tokens;
query repetition has no weight. There is no stemming, synonym expansion,
embedding, language model, or answer-derived feature.

For each unique query term, BM25 contribution uses this exact JavaScript
binary64 evaluation order:
`idf * ((tf * (k1+1)) / (tf+k1*(1-b+b*dl/avgdl)))`, where `k1=1.2`, `b=0.75`, and
`idf=ln(1+(N-df+0.5)/(df+0.5))`. Document length is filtered token count,
including zero.
Average length is the sum of lengths divided by `N`; if it is zero, every BM25
score is exactly zero. All candidates remain rankable even when their score is
zero.

## Association graphs and ranking

Each question has its own query-independent graph over that question's
retained session corpus. No edge or support crosses question boundaries.
Association construction uses message `content` tokens only; structural role
labels remain in BM25 text but never generate association edges. Tokens within
each message are treated as a set. For every admitted pair of different
messages, form the cross-product of their token sets, discard equal-token
pairs, and canonicalize each remaining pair as the UTF-16 code-unit smaller
token followed by the larger token. A session supports a pair at most once,
and the candidate session itself remains part of corpus support. An edge is
admitted at support of at least two distinct retained session identifiers.
The edge's ranking value is the binary value one; support count is retained
only for audit bytes and does not increase score.

Version 4 computes the same support relation without materializing unsupported
one-session string pairs. A token with total session frequency below two is
removed before pair enumeration because it cannot be an endpoint of an
admitted edge. Recurrence-without-position support uses per-token session
bitsets and subtracts a session exactly when both tokens occur only in the same
single message; adjacent and shuffled-position support use numeric token-pair
identifiers. Token identifiers follow UTF-16 code-unit token order, preserving
canonical edge order and bytes. Treatment and independent verification keep
separate implementations and do not import one another's graph code.

`recurrence-no-position` admits every pair of different messages in a session.
`repeated-adjacent-position` admits only supplied indices `(i,i+1)`.
`shuffled-position` first shuffles message references and then applies the same
adjacent rule. Its seed is the first four SHA-256 bytes interpreted as an
unsigned big-endian integer over UTF-8 `question_id`, NUL, `session_id`, NUL,
and `position-shuffle`. Xorshift32 applies `x ^= x << 13`, `x ^= x >>> 17`,
and `x ^= x << 5` with 32-bit JavaScript bitwise semantics and returns the
unsigned state. Fisher-Yates iterates `i` from `length-1` down to one and swaps
`i` with `floor(nextUint32()*(i+1)/4294967296)`.

For a candidate, association score is one if at least one admitted edge joins
a unique query token to a candidate content token not itself present in the
query; otherwise it is zero. Final score is BM25 plus selected weight times
that score. Ranking sorts by descending final score, descending association
score, descending BM25, then UTF-16 code-unit ascending session identifier,
and returns the first ten unique identifiers.

## Metrics, bootstrap, and cost

Relevance is binary membership in distinct gold session IDs. At cutoff `k`,
Recall is the number of distinct relevant returned IDs divided by distinct
gold count, and hit is one iff that intersection is nonempty. DCG is
`sum(relevance(rank)/log2(rank+1))`; IDCG uses ones in the first
`min(k,goldCount)` ranks; NDCG is DCG divided by IDCG. Knowledge-update top-one
error is one iff the first returned ID is not a distinct gold ID. Metrics are
summed in UTF-16 code-unit `question_id` order using JavaScript binary64 and
divided once by the population size.

The three paired evaluation contrasts use the same 10,000 bootstrap index
vectors. Evaluation question IDs are first placed in UTF-16 code-unit order.
Xorshift32 starts at unsigned seed `1296387376`; each vector draws exactly `n`
indices independently with replacement as
`floor(nextUint32()*n/4294967296)`. For each
contrast and vector, differences are summed in sampled order and divided by
`n`. Sorted bounds use nearest-rank indices
`ceil(0.025*10000)-1` and `ceil(0.975*10000)-1`. The lower bound used by the
decision is therefore sorted index 249. Resampling is unstratified because
the primary population is the frozen aggregate evaluation set; question-type
metrics remain descriptive strata.

Corpus raw session bytes are the UTF-8 bytes of the exact NFKC-lowercased
BM25 session encodings after first-occurrence deduplication. Returned raw bytes
are a separate descriptive sum for the ten returned units and never the ratio
denominator. Canonical graph bytes are UTF-8 JSONL,
one admitted edge per line sorted by `left`, then `right` in UTF-16 code-unit
order, with property order exactly
`{"left":...,"right":...,"distinctSessions":...}` and LF. The per-question
edge-to-raw ratio is edge bytes divided by corpus raw session bytes; it is zero
only when both are zero and is positive infinity when corpus raw bytes are zero
but edge bytes are not. Each line uses ECMAScript `JSON.stringify`: Unicode
letter/number token characters remain literal UTF-8 rather than being rewritten
as `\uXXXX`; only escapes required by that algorithm are emitted.
Nearest-rank p50 and p95 use sorted index `ceil(p*n)-1`.

One fixed non-dataset synthetic question warms the JavaScript functions before
timing and is excluded from every artifact metric. Timings use
`performance.now()`: build covers document projection plus BM25 for content,
and graph construction for each association condition; query covers candidate
association scoring, ranking, and all requested weight variants. Graphs are
built once per question-condition, not once per weight. Development measures
all four variants; evaluation measures only the selected variant. Wall-clock
timings are environment observations and resource diagnostics, not a
cross-machine scientific decision gate. Timeout or non-finite timing makes the
run inconclusive; a slow but completed run does not eliminate the retrieval
design. The runner and verifier each use exactly three worker threads and
preserve result ordering by frozen question and condition order. Verification
may retain independently recomputed per-question results in process memory for
the baseline, declared mutation copies, and final attestation; cache keys bind
the canonical case hash and selected-weight profile, and never reuse treatment
output.

## Verification and decision

The treatment writes rankings and gold-blind cost data. The development
selector and independent analyzer separately join persisted rankings with
gold. The analyzer recomputes the source projection, split, tokenizer, BM25,
graphs, shuffle, weight selection, rankings, relevance metrics, bootstrap,
canonical byte counts, and decision without importing treatment code. It may
remeasure time for diagnostics but must not require physical timing equality.
Artifact or registered-source hash mismatch, missing or duplicate rows,
forbidden-field exposure, non-finite numbers, resource abort, analyzer
disagreement, checksum failure, or a surviving declared mutation makes the run
inconclusive.

Repeated adjacent-position retrieval is retained only as a factor for a
separately preregistered public revision-pinned Agent experiment when its
evaluation NDCG@10 mean gain is at least 0.02 and its paired lower 95 percent
bootstrap bound is above zero against each of content, recurrence-no-position,
and shuffled-position; its knowledge-update top-one error is no more than 0.02
worse than content; and its p95 per-question edge-to-normalized-raw byte ratio
is at most two. A structurally valid miss eliminates this association-index
design. No result enables automatic injection, automatic recall, task
execution, or Module startup.
