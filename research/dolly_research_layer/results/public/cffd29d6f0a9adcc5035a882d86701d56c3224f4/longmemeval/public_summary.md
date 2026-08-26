# Dolly public retrieval diagnostics

- Version: `2026.08.26-public-v1`
- Evidence class: **public_dataset_deterministic_retrieval**
- These are retrieval metrics, not reader-LLM QA scores.

## LongMemEval-S-cleaned

- Instances: `500`; categories: `{"abstention": 30, "knowledge-update": 72, "multi-session": 121, "single-session-assistant": 56, "single-session-preference": 30, "single-session-user": 64, "temporal-reasoning": 127}`.
- Best session Recall@5: `rrf_word_bigram` = `0.9185`.
- Best turn Recall@10: `rrf_word_bigram` = `0.7713`.
- Best answerable-vs-abstention confidence AUROC: `bigram_all` = `0.6763`.

## Interpretation boundary

A retriever can locate evidence and still fail to answer, update, reason temporally, or abstain. Conversely, a reader may answer from parametric knowledge without retrieving the labeled evidence. Promotion therefore requires a fixed reader and official evaluator in a later gate.
