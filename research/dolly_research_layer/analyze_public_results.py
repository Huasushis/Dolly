#!/usr/bin/env python3
"""Summarize committed LongMemEval/LoCoMo retrieval snapshots.

This is a deterministic post-processor.  It never changes benchmark outputs and
never upgrades retrieval evidence into a claim about reader-LLM answer quality.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Mapping


def load_latest(root: Path) -> tuple[Path, dict[str, Any], dict[str, Any]]:
    candidates: list[tuple[float, Path, dict[str, Any], dict[str, Any]]] = []
    for snapshot in root.iterdir() if root.exists() else []:
        loc_path = snapshot / "locomo" / "public_metrics.json"
        lme_path = snapshot / "longmemeval" / "public_metrics.json"
        if not loc_path.is_file() or not lme_path.is_file():
            continue
        loc = json.loads(loc_path.read_text(encoding="utf-8"))
        lme = json.loads(lme_path.read_text(encoding="utf-8"))
        timestamp = max(float(loc.get("started_at_unix", 0)), float(lme.get("started_at_unix", 0)))
        candidates.append((timestamp, snapshot, loc, lme))
    if not candidates:
        raise SystemExit(f"no complete public result snapshot under {root}")
    _, snapshot, loc, lme = max(candidates, key=lambda x: x[0])
    return snapshot, loc, lme


def metric(section: Mapping[str, Any], method: str, group: str, name: str) -> float:
    return float(section.get(method, {}).get(group, {}).get(name, 0.0))


def method_rows(section: Mapping[str, Any], group: str, metrics: tuple[str, ...]) -> list[dict[str, Any]]:
    rows = []
    for method, groups in section.items():
        if group not in groups:
            continue
        row: dict[str, Any] = {"method": method, "n": groups[group].get("n", 0)}
        row.update({name: float(groups[group].get(name, 0.0)) for name in metrics})
        rows.append(row)
    return sorted(rows, key=lambda r: (r.get(metrics[0], 0.0), r["method"]), reverse=True)


def best_by_group(section: Mapping[str, Any], metric_name: str, prefix: str) -> dict[str, dict[str, Any]]:
    groups = sorted({g for method in section.values() for g in method if g.startswith(prefix)})
    result: dict[str, dict[str, Any]] = {}
    for group in groups:
        candidates = [
            (float(groups_map[group].get(metric_name, 0.0)), method)
            for method, groups_map in section.items()
            if group in groups_map
        ]
        if candidates:
            value, method = max(candidates)
            result[group] = {"method": method, "value": value}
    return result


def delta(section: Mapping[str, Any], left: str, right: str, group: str, name: str) -> float:
    return metric(section, left, group, name) - metric(section, right, group, name)


def analyze(loc_bundle: dict[str, Any], lme_bundle: dict[str, Any], snapshot: Path) -> dict[str, Any]:
    loc = loc_bundle["locomo"]
    lme = lme_bundle["longmemeval"]
    loc_turn = loc["turn_retrieval"]
    loc_session = loc["session_retrieval"]
    lme_turn = lme["turn_retrieval"]
    lme_session = lme["session_retrieval"]

    analysis = {
        "snapshot": snapshot.name,
        "claim_boundary": "Deterministic retrieval post-analysis only; no reader LLM or official QA judge.",
        "locomo": {
            "turn_methods": method_rows(loc_turn, "all_answerable", ("recall_at_10", "complete_at_10", "mrr", "ndcg_at_10")),
            "session_methods": method_rows(loc_session, "all_answerable", ("recall_at_5", "complete_at_5", "mrr", "ndcg_at_5")),
            "category_winners_turn_recall10": best_by_group(loc_turn, "recall_at_10", "category_"),
            "caption_delta_all_turn_recall10": delta(loc_turn, "word_all", "word_alternate", "all_answerable", "recall_at_10"),
            "caption_delta_image_turn_recall10": delta(loc_turn, "word_all", "word_alternate", "image_evidence", "recall_at_10"),
            "neighbor_delta_turn_recall10": delta(loc_turn, "rrf_neighbor", "rrf_word_bigram", "all_answerable", "recall_at_10"),
            "recency_delta_turn_recall10": delta(loc_turn, "rrf_plus_recency", "rrf_word_bigram", "all_answerable", "recall_at_10"),
            "confidence_auc": loc["retriever_confidence_answerable_auc"],
        },
        "longmemeval": {
            "turn_methods": method_rows(lme_turn, "all_answerable", ("recall_at_10", "complete_at_10", "mrr", "ndcg_at_10")),
            "session_methods": method_rows(lme_session, "all_answerable", ("recall_at_5", "complete_at_5", "mrr", "ndcg_at_5")),
            "category_winners_session_recall5": best_by_group(lme_session, "recall_at_5", ""),
            "neighbor_delta_session_recall5": delta(lme_session, "rrf_neighbor", "rrf_word_bigram", "all_answerable", "recall_at_5"),
            "recency_delta_session_recall5": delta(lme_session, "rrf_plus_recency", "rrf_word_bigram", "all_answerable", "recall_at_5"),
            "user_only_delta_session_recall5": delta(lme_session, "word_alternate", "word_all", "all_answerable", "recall_at_5"),
            "confidence_auc": lme["retriever_confidence_answerable_auc"],
        },
    }

    loc_neighbor = analysis["locomo"]["neighbor_delta_turn_recall10"]
    loc_caption = analysis["locomo"]["caption_delta_image_turn_recall10"]
    lme_recency = analysis["longmemeval"]["recency_delta_session_recall5"]
    best_loc_auc = max(analysis["locomo"]["confidence_auc"].values())
    best_lme_auc = max(analysis["longmemeval"]["confidence_auc"].values())
    analysis["decisions"] = [
        {
            "topic": "retrieval_granularity",
            "status": "ADOPT_TWO_STAGE_CANDIDATE",
            "decision": "Retrieve sessions/episodes first, then retrieve turns/evidence inside the selected sessions. Preserve both scores and provenance; do not compare the two recall numbers as if their relevance sets were identical.",
        },
        {
            "topic": "lexical_baseline",
            "status": "ADOPT",
            "decision": "Keep word BM25 plus word/bigram reciprocal-rank fusion as a mandatory cheap baseline before embeddings or graph expansion.",
        },
        {
            "topic": "temporal_neighbor_expansion",
            "status": "FEATURE_FLAG",
            "decision": f"One-hop neighbor expansion improved LoCoMo turn Recall@10 by {loc_neighbor:+.4f} over lexical RRF, but must retain a token cap, evidence link and no-association abstention control.",
        },
        {
            "topic": "fixed_recency_bias",
            "status": "REJECT_GLOBAL_DEFAULT",
            "decision": f"A fixed recency boost changed LongMemEval session Recall@5 by {lme_recency:+.4f}; recency should be a query/category feature, not an unconditional global prior.",
        },
        {
            "topic": "image_caption_view",
            "status": "KEEP_VERSIONED_DERIVED_VIEW",
            "decision": f"Caption text changed Recall@10 on image-bearing LoCoMo evidence by {loc_caption:+.4f}. Preserve raw media and versioned captions, but route captions through retrieval/rerank experiments rather than always concatenating them.",
        },
        {
            "topic": "automatic_recall_abstention",
            "status": "NOT_READY",
            "decision": f"Best confidence AUROC was {best_loc_auc:.3f} on LoCoMo and {best_lme_auc:.3f} on LongMemEval. A top-score heuristic is not reliable enough for silent automatic memory injection; explicit query and conservative thresholding remain the default.",
        },
    ]
    return analysis


def render_table(rows: list[dict[str, Any]], columns: tuple[str, ...]) -> list[str]:
    lines = ["| Method | " + " | ".join(columns) + " |", "|---|" + "---:|" * len(columns)]
    for row in rows:
        cells = []
        for col in columns:
            value = row[col]
            cells.append(f"{value:.4f}" if isinstance(value, float) else str(value))
        lines.append(f"| `{row['method']}` | " + " | ".join(cells) + " |")
    return lines


def markdown(a: dict[str, Any]) -> str:
    lines = [
        "# Dolly Public Memory Retrieval — Result Analysis",
        "",
        f"Snapshot: `{a['snapshot']}`",
        "",
        f"> {a['claim_boundary']}",
        "",
        "## Engineering decisions",
        "",
        "| Topic | Status | Decision |",
        "|---|---|---|",
    ]
    for d in a["decisions"]:
        lines.append(f"| {d['topic']} | **{d['status']}** | {d['decision']} |")
    lines += [
        "",
        "## LoCoMo turn retrieval",
        "",
        *render_table(a["locomo"]["turn_methods"], ("recall_at_10", "complete_at_10", "mrr", "ndcg_at_10")),
        "",
        "## LoCoMo session retrieval",
        "",
        *render_table(a["locomo"]["session_methods"], ("recall_at_5", "complete_at_5", "mrr", "ndcg_at_5")),
        "",
        "## LongMemEval turn retrieval",
        "",
        *render_table(a["longmemeval"]["turn_methods"], ("recall_at_10", "complete_at_10", "mrr", "ndcg_at_10")),
        "",
        "## LongMemEval session retrieval",
        "",
        *render_table(a["longmemeval"]["session_methods"], ("recall_at_5", "complete_at_5", "mrr", "ndcg_at_5")),
        "",
        "## Important deltas",
        "",
        f"- LoCoMo neighbor propagation vs lexical RRF, turn Recall@10: `{a['locomo']['neighbor_delta_turn_recall10']:+.4f}`.",
        f"- LoCoMo fixed recency vs lexical RRF, turn Recall@10: `{a['locomo']['recency_delta_turn_recall10']:+.4f}`.",
        f"- LoCoMo captions vs text-only, image-evidence Recall@10: `{a['locomo']['caption_delta_image_turn_recall10']:+.4f}`.",
        f"- LongMemEval neighbor propagation vs lexical RRF, session Recall@5: `{a['longmemeval']['neighbor_delta_session_recall5']:+.4f}`.",
        f"- LongMemEval fixed recency vs lexical RRF, session Recall@5: `{a['longmemeval']['recency_delta_session_recall5']:+.4f}`.",
        f"- LongMemEval user-only vs all-role word index, session Recall@5: `{a['longmemeval']['user_only_delta_session_recall5']:+.4f}`.",
        "",
        "The deltas are descriptive for this deterministic retriever. Statistical uncertainty and downstream answer effects require per-question outputs plus a fixed reader in the next gate.",
    ]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).with_name("results") / "public")
    parser.add_argument("--out", type=Path, default=Path(__file__).with_name("PUBLIC_RESULTS_ANALYSIS.md"))
    args = parser.parse_args()
    snapshot, loc, lme = load_latest(args.root)
    a = analyze(loc, lme, snapshot)
    args.out.write_text(markdown(a), encoding="utf-8")
    args.out.with_suffix(".json").write_text(json.dumps(a, indent=2, ensure_ascii=False), encoding="utf-8")
    print(markdown(a))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
