# Dolly public retrieval diagnostics

- Version: `2026.08.26-public-v1`
- Evidence class: **public_dataset_deterministic_retrieval**
- These are retrieval metrics, not reader-LLM QA scores.

## LoCoMo-10

- Questions: `1986`; categories: `{"1": 282, "2": 321, "3": 96, "4": 841, "5": 446}`.
- Questions with image-bearing evidence: `857`.
- Best turn Recall@10: `rrf_neighbor` = `0.6337`.
- Best session Recall@5: `rrf_word_bigram` = `0.8749`.
- Best answerable-vs-adversarial confidence AUROC: `word_all` = `0.7102`.

## Interpretation boundary

A retriever can locate evidence and still fail to answer, update, reason temporally, or abstain. Conversely, a reader may answer from parametric knowledge without retrieving the labeled evidence. Promotion therefore requires a fixed reader and official evaluator in a later gate.
