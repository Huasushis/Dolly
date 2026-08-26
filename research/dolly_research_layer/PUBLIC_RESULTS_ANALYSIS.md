# Dolly Public Memory Retrieval — Result Analysis

Snapshot: `cffd29d6f0a9adcc5035a882d86701d56c3224f4`

> Deterministic retrieval post-analysis only; no reader LLM or official QA judge.

## Engineering decisions

| Topic | Status | Decision |
|---|---|---|
| retrieval_granularity | **ADOPT_TWO_STAGE_CANDIDATE** | Retrieve sessions/episodes first, then retrieve turns/evidence inside the selected sessions. Preserve both scores and provenance; do not compare the two recall numbers as if their relevance sets were identical. |
| lexical_baseline | **ADOPT** | Keep word BM25 plus word/bigram reciprocal-rank fusion as a mandatory cheap baseline before embeddings or graph expansion. |
| temporal_neighbor_expansion | **FEATURE_FLAG** | One-hop neighbor expansion improved LoCoMo turn Recall@10 by +0.0210 over lexical RRF, but must retain a token cap, evidence link and no-association abstention control. |
| fixed_recency_bias | **REJECT_GLOBAL_DEFAULT** | A fixed recency boost changed LongMemEval session Recall@5 by -0.0192; recency should be a query/category feature, not an unconditional global prior. |
| image_caption_view | **KEEP_VERSIONED_DERIVED_VIEW** | Caption text changed Recall@10 on image-bearing LoCoMo evidence by +0.0096. Preserve raw media and versioned captions, but route captions through retrieval/rerank experiments rather than always concatenating them. |
| automatic_recall_abstention | **NOT_READY** | Best confidence AUROC was 0.710 on LoCoMo and 0.676 on LongMemEval. A top-score heuristic is not reliable enough for silent automatic memory injection; explicit query and conservative thresholding remain the default. |

## LoCoMo turn retrieval

| Method | recall_at_10 | complete_at_10 | mrr | ndcg_at_10 |
|---|---:|---:|---:|---:|
| `rrf_neighbor` | 0.6337 | 0.5953 | 0.3578 | 0.4072 |
| `word_all` | 0.6129 | 0.5721 | 0.4645 | 0.4812 |
| `rrf_word_bigram` | 0.6127 | 0.5716 | 0.4627 | 0.4800 |
| `rrf_word_alternate` | 0.6120 | 0.5695 | 0.4646 | 0.4805 |
| `word_alternate` | 0.6105 | 0.5680 | 0.4668 | 0.4814 |
| `bigram_all` | 0.6076 | 0.5670 | 0.4595 | 0.4761 |
| `rrf_plus_recency` | 0.6064 | 0.5665 | 0.3640 | 0.4073 |

## LoCoMo session retrieval

| Method | recall_at_5 | complete_at_5 | mrr | ndcg_at_5 |
|---|---:|---:|---:|---:|
| `rrf_word_bigram` | 0.8749 | 0.8321 | 0.8036 | 0.7991 |
| `bigram_all` | 0.8742 | 0.8321 | 0.8060 | 0.8014 |
| `word_all` | 0.8705 | 0.8265 | 0.7972 | 0.7929 |
| `rrf_word_alternate` | 0.8674 | 0.8230 | 0.7937 | 0.7891 |
| `word_alternate` | 0.8641 | 0.8199 | 0.7924 | 0.7868 |
| `rrf_plus_recency` | 0.8612 | 0.8159 | 0.6993 | 0.7191 |
| `rrf_neighbor` | 0.7872 | 0.7420 | 0.6303 | 0.6424 |

## LongMemEval turn retrieval

| Method | recall_at_10 | complete_at_10 | mrr | ndcg_at_10 |
|---|---:|---:|---:|---:|
| `rrf_word_bigram` | 0.7713 | 0.6894 | 0.6502 | 0.6373 |
| `bigram_all` | 0.7691 | 0.6830 | 0.6517 | 0.6369 |
| `word_all` | 0.7663 | 0.6872 | 0.6369 | 0.6283 |
| `rrf_plus_recency` | 0.7618 | 0.6745 | 0.5709 | 0.5733 |
| `rrf_word_alternate` | 0.7273 | 0.6511 | 0.6366 | 0.6209 |
| `rrf_neighbor` | 0.7183 | 0.6106 | 0.4248 | 0.4616 |
| `word_alternate` | 0.7154 | 0.6383 | 0.6181 | 0.6065 |

## LongMemEval session retrieval

| Method | recall_at_5 | complete_at_5 | mrr | ndcg_at_5 |
|---|---:|---:|---:|---:|
| `rrf_word_bigram` | 0.9185 | 0.8404 | 0.9101 | 0.8848 |
| `word_all` | 0.9159 | 0.8340 | 0.9132 | 0.8853 |
| `bigram_all` | 0.9145 | 0.8362 | 0.9114 | 0.8848 |
| `rrf_word_alternate` | 0.9102 | 0.8447 | 0.9110 | 0.8859 |
| `word_alternate` | 0.9000 | 0.8277 | 0.8996 | 0.8719 |
| `rrf_plus_recency` | 0.8993 | 0.8064 | 0.7870 | 0.7709 |
| `rrf_neighbor` | 0.8189 | 0.6830 | 0.7495 | 0.7064 |

## Important deltas

- LoCoMo neighbor propagation vs lexical RRF, turn Recall@10: `+0.0210`.
- LoCoMo fixed recency vs lexical RRF, turn Recall@10: `-0.0063`.
- LoCoMo captions vs text-only, image-evidence Recall@10: `+0.0096`.
- LongMemEval neighbor propagation vs lexical RRF, session Recall@5: `-0.0996`.
- LongMemEval fixed recency vs lexical RRF, session Recall@5: `-0.0192`.
- LongMemEval user-only vs all-role word index, session Recall@5: `-0.0159`.

The deltas are descriptive for this deterministic retriever. Statistical uncertainty and downstream answer effects require per-question outputs plus a fixed reader in the next gate.
