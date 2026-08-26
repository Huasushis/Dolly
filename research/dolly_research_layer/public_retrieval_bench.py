#!/usr/bin/env python3
"""Public-data retrieval diagnostics for Dolly's Memory research layer.

This runner deliberately evaluates retrieval only.  It does not call a reader
LLM or an LLM judge, so its numbers are not official LongMemEval/LoCoMo QA
scores.  It answers narrower engineering questions:

* session versus turn granularity;
* role/content views;
* lexical fusion;
* recency and neighbor propagation;
* evidence completeness and abstention confidence;
* whether derived image captions improve evidence retrieval.

Only Python's standard library is required.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import statistics
import sys
import time
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

VERSION = "2026.08.26-public-v1"
WORD_RE = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?")
SESSION_RE = re.compile(r"^session_(\d+)$")
STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can",
    "could", "did", "do", "does", "for", "from", "had", "has", "have", "he",
    "her", "hers", "him", "his", "how", "i", "if", "in", "is", "it", "its",
    "me", "my", "of", "on", "or", "our", "ours", "she", "should", "so", "that",
    "the", "their", "theirs", "them", "then", "there", "they", "this", "to", "was",
    "we", "were", "what", "when", "where", "which", "who", "why", "will", "with",
    "would", "you", "your", "yours",
}


def mean(xs: Sequence[float]) -> float:
    return statistics.fmean(xs) if xs else 0.0


def percentile(xs: Sequence[float], q: float) -> float:
    if not xs:
        return 0.0
    ys = sorted(xs)
    if len(ys) == 1:
        return float(ys[0])
    p = (len(ys) - 1) * q
    lo, hi = math.floor(p), math.ceil(p)
    if lo == hi:
        return float(ys[lo])
    return float(ys[lo] * (hi - p) + ys[hi] * (p - lo))


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def normalize(text: Any) -> str:
    return unicodedata.normalize("NFKC", str(text or "")).lower()


def word_tokens(text: Any, keep_stopwords: bool = False) -> list[str]:
    words = WORD_RE.findall(normalize(text))
    if keep_stopwords:
        return words
    return [w for w in words if w not in STOPWORDS and (len(w) > 1 or w.isdigit())]


def bigram_tokens(text: Any) -> list[str]:
    words = word_tokens(text)
    return words + [f"{a}::{b}" for a, b in zip(words, words[1:])]


@dataclass(frozen=True)
class Document:
    doc_id: str
    text: str
    ordinal: int
    metadata: Mapping[str, Any]


class BM25:
    def __init__(self, tokenized_docs: Sequence[Sequence[str]], k1: float = 1.2, b: float = 0.75):
        self.docs = [list(x) for x in tokenized_docs]
        self.k1 = k1
        self.b = b
        self.lengths = [len(x) for x in self.docs]
        self.avgdl = mean(self.lengths) or 1.0
        self.tfs = [Counter(x) for x in self.docs]
        df: Counter[str] = Counter()
        for tf in self.tfs:
            df.update(tf.keys())
        n = len(self.docs)
        self.idf = {term: math.log(1.0 + (n - freq + 0.5) / (freq + 0.5)) for term, freq in df.items()}

    def scores(self, query: Sequence[str]) -> list[float]:
        qtf = Counter(query)
        scores = [0.0] * len(self.docs)
        for term, qfreq in qtf.items():
            idf = self.idf.get(term)
            if idf is None:
                continue
            for i, tf in enumerate(self.tfs):
                f = tf.get(term, 0)
                if not f:
                    continue
                denom = f + self.k1 * (1.0 - self.b + self.b * self.lengths[i] / self.avgdl)
                scores[i] += idf * (f * (self.k1 + 1.0) / denom) * min(2.0, 1.0 + math.log1p(qfreq))
        return scores


def ranked_ids(documents: Sequence[Document], scores: Sequence[float]) -> list[str]:
    return [documents[i].doc_id for i in sorted(range(len(documents)), key=lambda j: (scores[j], -documents[j].ordinal, documents[j].doc_id), reverse=True)]


def rank_positions(ranking: Sequence[str]) -> dict[str, int]:
    return {doc_id: i + 1 for i, doc_id in enumerate(ranking)}


def rrf_scores(documents: Sequence[Document], rankings: Sequence[Sequence[str]], k: float = 60.0, weights: Sequence[float] | None = None) -> list[float]:
    weights = list(weights or [1.0] * len(rankings))
    positions = [rank_positions(r) for r in rankings]
    return [sum(w / (k + pos[doc.doc_id]) for w, pos in zip(weights, positions)) for doc in documents]


def add_recency_rank(scores: Sequence[float], documents: Sequence[Document], weight: float = 0.45, k: float = 60.0) -> list[float]:
    newest = sorted(documents, key=lambda d: (d.ordinal, d.doc_id), reverse=True)
    recent_pos = rank_positions([d.doc_id for d in newest])
    return [s + weight / (k + recent_pos[d.doc_id]) for s, d in zip(scores, documents)]


def propagate_neighbors(scores: Sequence[float], documents: Sequence[Document], strength: float = 0.35, tau: float = 1.5, radius: int = 2) -> list[float]:
    by_ord = {d.ordinal: i for i, d in enumerate(documents)}
    out = list(scores)
    for i, d in enumerate(documents):
        for dist in range(1, radius + 1):
            for target_ord in (d.ordinal - dist, d.ordinal + dist):
                j = by_ord.get(target_ord)
                if j is not None:
                    out[j] += scores[i] * strength * math.exp(-dist / tau)
    return out


def confidence_from_scores(scores: Sequence[float]) -> float:
    positives = sorted((max(0.0, s) for s in scores), reverse=True)[:10]
    if not positives or positives[0] <= 0:
        return 0.0
    return positives[0] / (sum(positives) + 1e-12)


def retrieval_metrics(ranking: Sequence[str], relevant: set[str], ks: Sequence[int] = (1, 3, 5, 10)) -> dict[str, float]:
    if not relevant:
        return {}
    pos = [i + 1 for i, doc_id in enumerate(ranking) if doc_id in relevant]
    out: dict[str, float] = {"mrr": 1.0 / min(pos) if pos else 0.0}
    for k in ks:
        found = relevant & set(ranking[:k])
        out[f"hit_at_{k}"] = float(bool(found))
        out[f"recall_at_{k}"] = len(found) / len(relevant)
        out[f"complete_at_{k}"] = float(relevant <= set(ranking[:k]))
        dcg = sum(1.0 / math.log2(i + 2.0) for i, doc_id in enumerate(ranking[:k]) if doc_id in relevant)
        ideal = sum(1.0 / math.log2(i + 2.0) for i in range(min(k, len(relevant))))
        out[f"ndcg_at_{k}"] = dcg / ideal if ideal else 0.0
    return out


def auc(labels: Sequence[int], scores: Sequence[float]) -> float:
    positives = [s for y, s in zip(labels, scores) if y == 1]
    negatives = [s for y, s in zip(labels, scores) if y == 0]
    if not positives or not negatives:
        return 0.0
    wins = ties = 0
    for p in positives:
        for n in negatives:
            wins += p > n
            ties += p == n
    return (wins + 0.5 * ties) / (len(positives) * len(negatives))


class MetricBook:
    def __init__(self) -> None:
        self.values: dict[str, dict[str, dict[str, list[float]]]] = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
        self.counts: Counter[tuple[str, str]] = Counter()

    def add(self, method: str, category: str, metrics: Mapping[str, float]) -> None:
        self.counts[(method, category)] += 1
        for key, value in metrics.items():
            self.values[method][category][key].append(float(value))

    def aggregate(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for method, categories in self.values.items():
            result[method] = {}
            for category, metrics in categories.items():
                result[method][category] = {"n": self.counts[(method, category)]}
                result[method][category].update({k: mean(vs) for k, vs in metrics.items()})
        return result


def score_views(documents: Sequence[Document], query: str, text_views: Mapping[str, Sequence[str]]) -> dict[str, tuple[list[str], list[float]]]:
    q_word = word_tokens(query)
    q_bigram = bigram_tokens(query)
    word_index = BM25([word_tokens(t) for t in text_views["all"]])
    bigram_index = BM25([bigram_tokens(t) for t in text_views["all"]])
    word_scores = word_index.scores(q_word)
    bigram_scores = bigram_index.scores(q_bigram)
    word_rank = ranked_ids(documents, word_scores)
    bigram_rank = ranked_ids(documents, bigram_scores)
    fused = rrf_scores(documents, [word_rank, bigram_rank])
    out = {
        "word_all": (word_rank, word_scores),
        "bigram_all": (bigram_rank, bigram_scores),
        "rrf_word_bigram": (ranked_ids(documents, fused), fused),
        "rrf_plus_recency": (ranked_ids(documents, add_recency_rank(fused, documents)), add_recency_rank(fused, documents)),
        "rrf_neighbor": (ranked_ids(documents, propagate_neighbors(fused, documents)), propagate_neighbors(fused, documents)),
    }
    if "alternate" in text_views:
        alt_index = BM25([word_tokens(t) for t in text_views["alternate"]])
        alt_scores = alt_index.scores(q_word)
        out["word_alternate"] = (ranked_ids(documents, alt_scores), alt_scores)
        alt_fused = rrf_scores(documents, [word_rank, ranked_ids(documents, alt_scores)])
        out["rrf_word_alternate"] = (ranked_ids(documents, alt_fused), alt_fused)
    return out


def longmemeval(path: Path) -> dict[str, Any]:
    started = time.time()
    data = json.loads(path.read_text(encoding="utf-8"))
    session_book = MetricBook()
    turn_book = MetricBook()
    confidence: dict[str, list[float]] = defaultdict(list)
    answerable_labels: list[int] = []
    content_cache: dict[tuple[str, str], str] = {}
    cache_mismatches = 0
    category_counts: Counter[str] = Counter()

    for item in data:
        qid = str(item.get("question_id", ""))
        is_abstention = qid.endswith("_abs")
        category = "abstention" if is_abstention else str(item.get("question_type", "unknown"))
        category_counts[category] += 1
        question = str(item.get("question", ""))
        session_ids = [str(x) for x in item.get("haystack_session_ids", [])]
        dates = list(item.get("haystack_dates", []))
        sessions = list(item.get("haystack_sessions", []))
        session_docs: list[Document] = []
        session_all: list[str] = []
        session_user: list[str] = []
        turn_docs: list[Document] = []
        turn_all: list[str] = []
        turn_user: list[str] = []
        relevant_turns: set[str] = set()

        for ordinal, (sid, date, turns) in enumerate(zip(session_ids, dates, sessions)):
            all_parts, user_parts = [], []
            for turn_idx, turn in enumerate(turns):
                role = str(turn.get("role", "unknown"))
                content = str(turn.get("content", ""))
                rendered = f"{role}: {content}"
                all_parts.append(rendered)
                if role == "user":
                    user_parts.append(rendered)
                tid = f"{sid}#{turn_idx}"
                turn_docs.append(Document(tid, rendered, len(turn_docs), {"session_id": sid, "role": role}))
                turn_all.append(f"date {date} {rendered}")
                turn_user.append(f"date {date} {rendered if role == 'user' else ''}")
                if turn.get("has_answer") is True:
                    relevant_turns.add(tid)
            all_text = "\n".join(all_parts)
            user_text = "\n".join(user_parts)
            key_all = (sid, "all")
            key_user = (sid, "user")
            if key_all in content_cache and content_cache[key_all] != all_text:
                cache_mismatches += 1
            content_cache.setdefault(key_all, all_text)
            content_cache.setdefault(key_user, user_text)
            session_docs.append(Document(sid, all_text, ordinal, {"date": date}))
            session_all.append(f"date {date} {all_text}")
            session_user.append(f"date {date} {user_text}")

        answer_sessions = {str(x) for x in item.get("answer_session_ids", [])}
        answerable_labels.append(0 if is_abstention else 1)
        session_views = score_views(session_docs, question, {"all": session_all, "alternate": session_user})
        for method, (ranking, scores) in session_views.items():
            confidence[method].append(confidence_from_scores(scores))
            if not is_abstention and answer_sessions:
                metrics = retrieval_metrics(ranking, answer_sessions)
                session_book.add(method, "all_answerable", metrics)
                session_book.add(method, category, metrics)

        # Turn diagnostics are intentionally narrower to control CPU on the 277 MB corpus.
        if turn_docs and (relevant_turns or is_abstention):
            turn_views = score_views(turn_docs, question, {"all": turn_all, "alternate": turn_user})
            for method, (ranking, scores) in turn_views.items():
                if not is_abstention and relevant_turns:
                    metrics = retrieval_metrics(ranking, relevant_turns)
                    turn_book.add(method, "all_answerable", metrics)
                    turn_book.add(method, category, metrics)

    abstention_auc = {method: auc(answerable_labels, scores) for method, scores in confidence.items()}
    return {
        "dataset": "LongMemEval-S-cleaned",
        "instances": len(data),
        "category_counts": dict(category_counts),
        "session_retrieval": session_book.aggregate(),
        "turn_retrieval": turn_book.aggregate(),
        "retriever_confidence_answerable_auc": abstention_auc,
        "unique_session_views_cached": len(content_cache),
        "session_id_content_mismatches": cache_mismatches,
        "elapsed_seconds": time.time() - started,
        "claim_boundary": "Retrieval evidence metrics only; not official LongMemEval QA accuracy.",
    }


def sorted_session_keys(conversation: Mapping[str, Any]) -> list[str]:
    keys = []
    for key, value in conversation.items():
        match = SESSION_RE.match(key)
        if match and isinstance(value, list):
            keys.append((int(match.group(1)), key))
    return [key for _, key in sorted(keys)]


def locomo(path: Path) -> dict[str, Any]:
    started = time.time()
    data = json.loads(path.read_text(encoding="utf-8"))
    turn_book = MetricBook()
    session_book = MetricBook()
    labels: list[int] = []
    confidence: dict[str, list[float]] = defaultdict(list)
    category_counts: Counter[str] = Counter()
    image_evidence_count = 0

    for sample in data:
        conversation = sample.get("conversation", {})
        turn_docs: list[Document] = []
        turn_text: list[str] = []
        turn_caption: list[str] = []
        session_docs: list[Document] = []
        session_text: list[str] = []
        session_caption: list[str] = []
        dia_to_session: dict[str, str] = {}
        dia_has_image: dict[str, bool] = {}

        for session_ordinal, key in enumerate(sorted_session_keys(conversation)):
            turns = conversation.get(key, [])
            date = conversation.get(f"{key}_date_time", "")
            rendered_text, rendered_caption = [], []
            for turn in turns:
                dia_id = str(turn.get("dia_id", f"{key}#{len(turn_docs)}"))
                speaker = str(turn.get("speaker", "unknown"))
                text = str(turn.get("text", ""))
                caption = str(turn.get("blip_caption", "") or "")
                base = f"{speaker}: {text}"
                with_caption = base + (f" image caption: {caption}" if caption else "")
                ordinal = len(turn_docs)
                turn_docs.append(Document(dia_id, base, ordinal, {"session": key, "has_image": bool(caption or turn.get('img_url'))}))
                turn_text.append(f"date {date} {base}")
                turn_caption.append(f"date {date} {with_caption}")
                rendered_text.append(base)
                rendered_caption.append(with_caption)
                dia_to_session[dia_id] = key
                dia_has_image[dia_id] = bool(caption or turn.get("img_url"))
            session_docs.append(Document(key, "\n".join(rendered_text), session_ordinal, {"date": date}))
            session_text.append(f"date {date} {' '.join(rendered_text)}")
            session_caption.append(f"date {date} {' '.join(rendered_caption)}")

        for qa in sample.get("qa", []):
            question = str(qa.get("question", ""))
            category = str(qa.get("category", "unknown"))
            category_counts[category] += 1
            raw_evidence = qa.get("evidence") or []
            if isinstance(raw_evidence, (str, int)):
                raw_evidence = [raw_evidence]
            evidence = {str(x) for x in raw_evidence if str(x) in dia_to_session}
            answerable = bool(evidence)
            labels.append(int(answerable))
            image_evidence = any(dia_has_image.get(x, False) for x in evidence)
            image_evidence_count += image_evidence

            views = score_views(turn_docs, question, {"all": turn_caption, "alternate": turn_text})
            for method, (ranking, scores) in views.items():
                confidence[method].append(confidence_from_scores(scores))
                if evidence:
                    metrics = retrieval_metrics(ranking, evidence, ks=(1, 5, 10, 20))
                    turn_book.add(method, "all_answerable", metrics)
                    turn_book.add(method, f"category_{category}", metrics)
                    if image_evidence:
                        turn_book.add(method, "image_evidence", metrics)

            evidence_sessions = {dia_to_session[x] for x in evidence}
            if evidence_sessions:
                session_views = score_views(session_docs, question, {"all": session_caption, "alternate": session_text})
                for method, (ranking, scores) in session_views.items():
                    metrics = retrieval_metrics(ranking, evidence_sessions, ks=(1, 3, 5, 10))
                    session_book.add(method, "all_answerable", metrics)
                    session_book.add(method, f"category_{category}", metrics)

    return {
        "dataset": "LoCoMo-10",
        "conversations": len(data),
        "questions": sum(category_counts.values()),
        "category_counts": dict(category_counts),
        "questions_with_image_evidence": image_evidence_count,
        "turn_retrieval": turn_book.aggregate(),
        "session_retrieval": session_book.aggregate(),
        "retriever_confidence_answerable_auc": {m: auc(labels, s) for m, s in confidence.items()},
        "elapsed_seconds": time.time() - started,
        "claim_boundary": "Evidence retrieval metrics only; not LoCoMo answer F1 or LLM-judge accuracy.",
    }


def flatten(value: Any, prefix: str = "") -> Iterable[tuple[str, Any]]:
    if isinstance(value, dict):
        for key, child in value.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            yield from flatten(child, path)
    elif isinstance(value, list):
        for i, child in enumerate(value):
            yield from flatten(child, f"{prefix}[{i}]")
    else:
        yield prefix, value


def best_method(section: Mapping[str, Any], metric: str, group: str = "all_answerable") -> tuple[str, float]:
    candidates = []
    for method, groups in section.items():
        value = groups.get(group, {}).get(metric)
        if isinstance(value, (int, float)):
            candidates.append((float(value), method))
    if not candidates:
        return "n/a", 0.0
    value, method = max(candidates)
    return method, value


def summary(bundle: Mapping[str, Any]) -> str:
    lines = [
        "# Dolly public retrieval diagnostics",
        "",
        f"- Version: `{bundle['version']}`",
        "- Evidence class: **public_dataset_deterministic_retrieval**",
        "- These are retrieval metrics, not reader-LLM QA scores.",
        "",
    ]
    lme = bundle.get("longmemeval")
    if lme:
        s_method, s_value = best_method(lme["session_retrieval"], "recall_at_5")
        t_method, t_value = best_method(lme["turn_retrieval"], "recall_at_10")
        lines += [
            "## LongMemEval-S-cleaned",
            "",
            f"- Instances: `{lme['instances']}`; categories: `{json.dumps(lme['category_counts'], sort_keys=True)}`.",
            f"- Best session Recall@5: `{s_method}` = `{s_value:.4f}`.",
            f"- Best turn Recall@10: `{t_method}` = `{t_value:.4f}`.",
            f"- Best answerable-vs-abstention confidence AUROC: `{max(lme['retriever_confidence_answerable_auc'], key=lme['retriever_confidence_answerable_auc'].get)}` = `{max(lme['retriever_confidence_answerable_auc'].values()):.4f}`.",
            "",
        ]
    loc = bundle.get("locomo")
    if loc:
        t_method, t_value = best_method(loc["turn_retrieval"], "recall_at_10")
        s_method, s_value = best_method(loc["session_retrieval"], "recall_at_5")
        lines += [
            "## LoCoMo-10",
            "",
            f"- Questions: `{loc['questions']}`; categories: `{json.dumps(loc['category_counts'], sort_keys=True)}`.",
            f"- Questions with image-bearing evidence: `{loc['questions_with_image_evidence']}`.",
            f"- Best turn Recall@10: `{t_method}` = `{t_value:.4f}`.",
            f"- Best session Recall@5: `{s_method}` = `{s_value:.4f}`.",
            f"- Best answerable-vs-adversarial confidence AUROC: `{max(loc['retriever_confidence_answerable_auc'], key=loc['retriever_confidence_answerable_auc'].get)}` = `{max(loc['retriever_confidence_answerable_auc'].values()):.4f}`.",
            "",
        ]
    lines += [
        "## Interpretation boundary",
        "",
        "A retriever can locate evidence and still fail to answer, update, reason temporally, or abstain. Conversely, a reader may answer from parametric knowledge without retrieving the labeled evidence. Promotion therefore requires a fixed reader and official evaluator in a later gate.",
    ]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--longmemeval", type=Path)
    parser.add_argument("--locomo", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if not args.longmemeval and not args.locomo:
        parser.error("provide at least one dataset")
    args.out.mkdir(parents=True, exist_ok=True)
    bundle: dict[str, Any] = {
        "version": VERSION,
        "python": sys.version,
        "evidence_class": "public_dataset_deterministic_retrieval",
        "started_at_unix": time.time(),
        "datasets": {},
    }
    if args.longmemeval:
        bundle["datasets"]["longmemeval"] = {"path": str(args.longmemeval), "sha256": sha256_file(args.longmemeval)}
        bundle["longmemeval"] = longmemeval(args.longmemeval)
    if args.locomo:
        bundle["datasets"]["locomo"] = {"path": str(args.locomo), "sha256": sha256_file(args.locomo)}
        bundle["locomo"] = locomo(args.locomo)
    bundle["elapsed_seconds"] = time.time() - bundle["started_at_unix"]
    text = summary(bundle)
    (args.out / "public_metrics.json").write_text(json.dumps(bundle, indent=2, ensure_ascii=False), encoding="utf-8")
    (args.out / "public_summary.md").write_text(text, encoding="utf-8")
    with (args.out / "public_metrics.csv").open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["metric", "value"])
        writer.writerows(flatten(bundle))
    manifest = {
        "version": VERSION,
        "source_sha256": sha256_file(Path(__file__)),
        "dataset_sha256": bundle["datasets"],
        "command": " ".join(sys.argv),
        "claim_boundary": "No live model, LLM judge, or official QA accuracy in this run.",
    }
    (args.out / "public_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
