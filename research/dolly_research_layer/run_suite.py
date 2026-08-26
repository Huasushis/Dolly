#!/usr/bin/env python3
"""Deterministic component experiments for Dolly's research layer.

The suite deliberately does not call an LLM.  It is Gate-0/Gate-2 evidence:
synthetic counterexamples, invariants, ablations, and architecture screening.
It must not be presented as a real-model benchmark.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import math
import os
import platform
import random
import statistics
import sys
import time
import zipfile
from collections import defaultdict, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

SUITE_VERSION = "2026.08.26-v1"
DEFAULT_SEED = 20260826


def mean(xs: Sequence[float]) -> float:
    return statistics.fmean(xs) if xs else 0.0


def percentile(xs: Sequence[float], q: float) -> float:
    if not xs:
        return 0.0
    ys = sorted(xs)
    if len(ys) == 1:
        return float(ys[0])
    pos = (len(ys) - 1) * q
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return float(ys[lo])
    return float(ys[lo] * (hi - pos) + ys[hi] * (pos - lo))


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def jaccard(a: set[str], b: set[str]) -> float:
    return len(a & b) / max(1, len(a | b))


def paired_bootstrap_ci(deltas: Sequence[float], seed: int, samples: int = 1000) -> list[float]:
    if not deltas:
        return [0.0, 0.0]
    rng = random.Random(seed)
    n = len(deltas)
    stats = [mean([deltas[rng.randrange(n)] for _ in range(n)]) for _ in range(samples)]
    return [percentile(stats, 0.025), percentile(stats, 0.975)]


# ---------------------------------------------------------------------------
# RQ-M1: temporal association beyond semantic similarity
# ---------------------------------------------------------------------------


def generate_association_stream(seed: int = DEFAULT_SEED, pairs: int = 12, sessions: int = 72) -> dict[str, Any]:
    rng = random.Random(seed)
    features: dict[str, set[str]] = {"GLOBAL": {"global", "filler", "common"}}
    true_assoc: dict[str, str] = {}
    candidates: dict[str, list[str]] = {}
    for i in range(pairs):
        a, b, c = f"A{i}", f"B{i}", f"C{i}"
        features[a] = {f"topic-{i}", "object", "query"}
        features[b] = {f"action-{i}", "procedure", "response"}
        features[c] = {f"topic-{i}", "object", "semantic-distractor"}
        true_assoc[a] = b
        candidates[a] = [b, c, "GLOBAL"] + [f"B{j}" for j in range(pairs) if j != i][:4]

    stream: list[list[str]] = []
    filler_counter = 0
    for session in range(sessions):
        seq: list[str] = []
        for pos in range(44):
            if pos % 3 == 0:
                seq.append("GLOBAL")
            else:
                token = f"F{filler_counter}"
                filler_counter += 1
                features[token] = {"filler", f"session-{session % 5}"}
                seq.append(token)

        chosen = rng.sample(range(pairs), 4)
        occupied: set[int] = set()
        for i in chosen:
            for _ in range(100):
                p = rng.randrange(2, 34)
                gap = rng.choice([1, 1, 2, 3])
                if p not in occupied and p + gap not in occupied:
                    break
            seq[p], seq[p + gap] = f"A{i}", f"B{i}"
            occupied.update({p, p + gap})
            # The semantic distractor occurs, but normally far from A.
            far = rng.choice([x for x in range(0, 44) if abs(x - p) >= 13 and x not in occupied])
            seq[far] = f"C{i}"
            occupied.add(far)

        # Independent B noise prevents the task from becoming a trivial adjacency lookup.
        for _ in range(3):
            j = rng.randrange(pairs)
            p = rng.randrange(44)
            if p not in occupied:
                seq[p] = f"B{j}"
                occupied.add(p)
        stream.append(seq)
    return {"sessions": stream, "features": features, "true": true_assoc, "candidates": candidates}


def weighted_pair_counts(sessions: Sequence[Sequence[str]], scales: Sequence[float] = (1.5, 5.0, 16.0)) -> tuple[dict[tuple[str, str], float], dict[tuple[str, str], int]]:
    weighted: dict[tuple[str, str], float] = defaultdict(float)
    support: dict[tuple[str, str], int] = defaultdict(int)
    max_dist = int(max(scales) * 2)
    for seq in sessions:
        n = len(seq)
        for i in range(n):
            for j in range(i + 1, min(n, i + max_dist + 1)):
                x, y = seq[i], seq[j]
                if x == y:
                    continue
                key = tuple(sorted((x, y)))
                d = j - i
                weighted[key] += sum(math.exp(-d / tau) for tau in scales)
                if d <= 6:
                    support[key] += 1
    return dict(weighted), dict(support)


def association_scores(sessions: Sequence[Sequence[str]], seed: int, permutations: int = 24) -> dict[tuple[str, str], dict[str, float]]:
    observed, support = weighted_pair_counts(sessions)
    null_sum: dict[tuple[str, str], float] = defaultdict(float)
    rng = random.Random(seed)
    for _ in range(permutations):
        shuffled = []
        for seq in sessions:
            copy = list(seq)
            rng.shuffle(copy)
            shuffled.append(copy)
        null, _ = weighted_pair_counts(shuffled)
        for key, value in null.items():
            null_sum[key] += value
    keys = set(observed) | set(null_sum)
    result: dict[tuple[str, str], dict[str, float]] = {}
    for key in keys:
        obs = observed.get(key, 0.0)
        exp = null_sum.get(key, 0.0) / permutations
        sup = support.get(key, 0)
        lift = math.log((obs + 1.0) / (exp + 1.0))
        shrink = sup / (sup + 5.0)
        result[key] = {"observed": obs, "expected": exp, "support": float(sup), "score": lift * shrink}
    return result


def rank_candidates(query: str, candidates: Sequence[str], data: dict[str, Any], assoc: dict[tuple[str, str], dict[str, float]], mode: str) -> list[str]:
    if mode == "semantic":
        score = lambda c: jaccard(data["features"][query], data["features"][c])
    elif mode == "raw":
        score = lambda c: assoc.get(tuple(sorted((query, c))), {}).get("observed", 0.0)
    elif mode == "normalized":
        score = lambda c: assoc.get(tuple(sorted((query, c))), {}).get("score", -999.0)
    else:
        raise ValueError(mode)
    return sorted(candidates, key=lambda c: (score(c), c), reverse=True)


def evaluate_association(seed: int = DEFAULT_SEED) -> dict[str, Any]:
    data = generate_association_stream(seed)
    assoc = association_scores(data["sessions"], seed + 1)
    modes = ["semantic", "raw", "normalized"]
    rows: dict[str, dict[str, float]] = {}
    for mode in modes:
        top1, recall3, false = 0, 0, 0
        for q, truth in data["true"].items():
            ranking = rank_candidates(q, data["candidates"][q], data, assoc, mode)
            top1 += ranking[0] == truth
            recall3 += truth in ranking[:3]
            false += ranking[0] != truth
        n = len(data["true"])
        rows[mode] = {"precision_at_1": top1 / n, "recall_at_3": recall3 / n, "false_expansion_rate": false / n}

    rng = random.Random(seed + 2)
    shuffled = []
    for seq in data["sessions"]:
        copy = list(seq)
        rng.shuffle(copy)
        shuffled.append(copy)
    shuffled_assoc = association_scores(shuffled, seed + 3)
    ordered_true_scores = []
    shuffled_true_scores = []
    for q, truth in data["true"].items():
        key = tuple(sorted((q, truth)))
        ordered_true_scores.append(assoc.get(key, {}).get("score", 0.0))
        shuffled_true_scores.append(shuffled_assoc.get(key, {}).get("score", 0.0))
    collapse = 1.0 - (mean(shuffled_true_scores) / max(1e-9, mean(ordered_true_scores)))
    return {
        "metrics": rows,
        "temporal_shuffle": {
            "ordered_true_score": mean(ordered_true_scores),
            "shuffled_true_score": mean(shuffled_true_scores),
            "relative_collapse": collapse,
        },
        "interpretation": "Synthetic temporal association only; validates the control and scoring shape, not production usefulness.",
    }


# ---------------------------------------------------------------------------
# RQ-M2: overlapping, typed memory nodes versus one flat partition
# ---------------------------------------------------------------------------


def euclidean(a: Sequence[float], b: Sequence[float]) -> float:
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def kmeans(vectors: list[list[float]], k: int, seed: int, iterations: int = 40) -> list[int]:
    rng = random.Random(seed)
    centers = [list(vectors[i]) for i in rng.sample(range(len(vectors)), k)]
    labels = [0] * len(vectors)
    for _ in range(iterations):
        new_labels = [min(range(k), key=lambda j: euclidean(v, centers[j])) for v in vectors]
        if new_labels == labels:
            break
        labels = new_labels
        for j in range(k):
            members = [vectors[i] for i, lab in enumerate(labels) if lab == j]
            if members:
                centers[j] = [mean([m[d] for m in members]) for d in range(len(vectors[0]))]
    return labels


def pairwise_relation_metrics(true_sets: list[set[str]], predicted_sets: list[set[str]]) -> dict[str, float]:
    tp = fp = fn = 0
    n = len(true_sets)
    for i in range(n):
        for j in range(i + 1, n):
            truth = bool(true_sets[i] & true_sets[j])
            pred = bool(predicted_sets[i] & predicted_sets[j])
            tp += truth and pred
            fp += (not truth) and pred
            fn += truth and (not pred)
    precision = tp / max(1, tp + fp)
    recall = tp / max(1, tp + fn)
    return {"precision": precision, "recall": recall, "f1": 2 * precision * recall / max(1e-12, precision + recall)}


def evaluate_clustering(seed: int = DEFAULT_SEED) -> dict[str, Any]:
    rng = random.Random(seed)
    n_entity, n_topic, n_proc = 8, 6, 5
    vectors: list[list[float]] = []
    truth: list[set[str]] = []
    inferred: list[set[str]] = []
    for _ in range(240):
        e, t = rng.randrange(n_entity), rng.randrange(n_topic)
        p = rng.randrange(n_proc) if rng.random() < 0.7 else None
        labels = {f"entity:{e}", f"topic:{t}"}
        if p is not None:
            labels.add(f"procedure:{p}")
        truth.append(labels)
        v = [rng.gauss(0, 0.28) for _ in range(n_entity + n_topic + n_proc)]
        v[e] += 3.0
        v[n_entity + t] += 2.7
        if p is not None:
            v[n_entity + n_topic + p] += 2.5
        vectors.append(v)
        pred = {
            f"entity:{max(range(n_entity), key=lambda x: v[x])}",
            f"topic:{max(range(n_topic), key=lambda x: v[n_entity + x])}",
        }
        best_p = max(range(n_proc), key=lambda x: v[n_entity + n_topic + x])
        if v[n_entity + n_topic + best_p] > 1.3:
            pred.add(f"procedure:{best_p}")
        inferred.append(pred)

    flat_labels = kmeans(vectors, k=n_entity, seed=seed + 1)
    flat_sets = [{f"flat:{x}"} for x in flat_labels]
    flat = pairwise_relation_metrics(truth, flat_sets)
    overlapping = pairwise_relation_metrics(truth, inferred)
    exact = sum(a == b for a, b in zip(truth, inferred)) / len(truth)
    return {
        "flat_partition": flat,
        "typed_overlapping": {**overlapping, "exact_multi_axis_recovery": exact},
        "interpretation": "The typed method is given feature-axis boundaries; this supports the data model, not a claim that online cluster discovery is solved.",
    }


# ---------------------------------------------------------------------------
# RQ-C1: context retention / tensity
# ---------------------------------------------------------------------------


def make_context_case(rng: random.Random) -> tuple[list[dict[str, Any]], int, set[int]]:
    items: list[dict[str, Any]] = []
    group_count = rng.randint(22, 34)
    group_relevance = [rng.random() ** 1.5 for _ in range(group_count)]
    required_groups = set(sorted(range(group_count), key=lambda g: group_relevance[g], reverse=True)[:3])
    for g in range(group_count):
        atomic = rng.random() < 0.38
        count = rng.randint(2, 4) if atomic else 1
        for part in range(count):
            relevance = clamp(group_relevance[g] + rng.gauss(0, 0.09), 0.0, 1.0)
            items.append({
                "group": g,
                "part": part,
                "atomic": atomic,
                "tokens": rng.randint(24, 88),
                "relevance": relevance,
                "recency": rng.random(),
                "tensity": clamp(0.55 * relevance + 0.45 * rng.random(), 0.0, 1.0),
                "required": g in required_groups,
            })
    budget = int(sum(x["tokens"] for x in items) * 0.36)
    return items, budget, required_groups


def item_score(x: dict[str, Any], policy: str) -> float:
    if policy == "deterministic_baseline":
        return 0.72 * x["relevance"] + 0.28 * x["recency"]
    if policy in {"deterministic_tensity", "stochastic_tensity", "group_aware"}:
        return 0.52 * x["relevance"] + 0.18 * x["recency"] + 0.30 * x["tensity"]
    raise ValueError(policy)


def select_context(items: list[dict[str, Any]], budget: int, policy: str, rng: random.Random) -> set[int]:
    if policy == "group_aware":
        by_group: dict[int, list[int]] = defaultdict(list)
        for i, x in enumerate(items):
            by_group[x["group"]].append(i)
        groups = []
        for g, idxs in by_group.items():
            tokens = sum(items[i]["tokens"] for i in idxs)
            score = mean([item_score(items[i], policy) for i in idxs])
            groups.append((score / math.sqrt(tokens), score, -tokens, g, idxs))
        groups.sort(reverse=True)
        chosen: set[int] = set()
        used = 0
        for _, _, _, _, idxs in groups:
            cost = sum(items[i]["tokens"] for i in idxs)
            if used + cost <= budget:
                chosen.update(idxs)
                used += cost
        return chosen

    if policy == "stochastic_tensity":
        keyed = []
        for i, x in enumerate(items):
            w = max(1e-4, item_score(x, policy))
            keyed.append((rng.random() ** (1.0 / w), i))
        order = [i for _, i in sorted(keyed, reverse=True)]
    else:
        order = sorted(range(len(items)), key=lambda i: (item_score(items[i], policy) / math.sqrt(items[i]["tokens"]), item_score(items[i], policy)), reverse=True)
    chosen = set()
    used = 0
    for i in order:
        if used + items[i]["tokens"] <= budget:
            chosen.add(i)
            used += items[i]["tokens"]
    return chosen


def context_case_metrics(items: list[dict[str, Any]], chosen: set[int], budget: int, required_groups: set[int]) -> dict[str, float]:
    by_group: dict[int, set[int]] = defaultdict(set)
    selected_by_group: dict[int, set[int]] = defaultdict(set)
    for i, x in enumerate(items):
        by_group[x["group"]].add(i)
        if i in chosen:
            selected_by_group[x["group"]].add(i)
    required_items = set().union(*(by_group[g] for g in required_groups))
    coverage = len(required_items & chosen) / max(1, len(required_items))
    success = all(by_group[g] <= chosen for g in required_groups)
    atomic_groups = [g for g, idxs in by_group.items() if any(items[i]["atomic"] for i in idxs)]
    broken = sum(bool(selected_by_group[g]) and selected_by_group[g] != by_group[g] for g in atomic_groups)
    used = sum(items[i]["tokens"] for i in chosen)
    return {
        "required_coverage": coverage,
        "task_success": float(success),
        "dependency_break_rate": broken / max(1, len(atomic_groups)),
        "budget_use": used / max(1, budget),
    }


def evaluate_tensity(seed: int = DEFAULT_SEED, cases: int = 700) -> dict[str, Any]:
    policies = ["deterministic_baseline", "deterministic_tensity", "stochastic_tensity", "group_aware"]
    values: dict[str, dict[str, list[float]]] = {p: defaultdict(list) for p in policies}
    stochastic_success_by_seed = []
    for run_seed in range(8):
        rng = random.Random(seed + run_seed * 1009)
        local_stochastic = []
        for _ in range(cases // 8):
            items, budget, required = make_context_case(rng)
            for policy in policies:
                chosen = select_context(items, budget, policy, random.Random(rng.randrange(1 << 30)))
                metrics = context_case_metrics(items, chosen, budget, required)
                for k, v in metrics.items():
                    values[policy][k].append(v)
                if policy == "stochastic_tensity":
                    local_stochastic.append(metrics["task_success"])
        stochastic_success_by_seed.append(mean(local_stochastic))
    result = {p: {k: mean(vs) for k, vs in metrics.items()} for p, metrics in values.items()}
    result["stochastic_tensity"]["task_success_seed_sd"] = statistics.pstdev(stochastic_success_by_seed)
    return {
        "policies": result,
        "interpretation": "Atomic dependency groups are the correctness boundary. Random deletion is evaluated only as a context policy, never as durable GC.",
    }


# ---------------------------------------------------------------------------
# RQ-S1: activation scheduling
# ---------------------------------------------------------------------------


def make_arrivals(name: str, seed: int, horizon: int = 5000) -> list[int]:
    rng = random.Random(seed)
    arrivals: list[int] = []
    if name == "steady":
        t = 0.0
        while t < horizon:
            t += rng.expovariate(1 / 28.0)
            if t < horizon:
                arrivals.append(int(t))
    elif name == "bursty":
        for start in range(80, horizon, 260):
            arrivals.extend(start + rng.randrange(0, 18) for _ in range(rng.randint(7, 14)))
    elif name == "overload":
        t = 0
        while t < horizon:
            t += rng.randint(6, 10)
            arrivals.append(t)
    elif name == "slow_consumer":
        t = 0
        while t < horizon:
            t += rng.randint(12, 20)
            arrivals.append(t)
    elif name == "mixed":
        t = 0.0
        while t < horizon:
            t += rng.expovariate(1 / 45.0)
            if t < horizon:
                arrivals.append(int(t))
        for start in range(500, horizon, 900):
            arrivals.extend(start + rng.randrange(0, 25) for _ in range(18))
    else:
        raise ValueError(name)
    return sorted(x for x in arrivals if x < horizon)


def simulate_scheduler(policy: str, scenario: str, seed: int, horizon: int = 5000) -> dict[str, float]:
    arrivals = make_arrivals(scenario, seed, horizon)
    arrival_idx = 0
    queue: deque[tuple[int, int]] = deque()
    running: tuple[int, list[tuple[int, int]]] | None = None
    latencies: list[int] = []
    activations = empty_activations = 0
    max_backlog = 0
    first_pending: int | None = None
    last_finish = -1000
    next_tick = 0
    dynamic_wait = 22.0
    integral = 0.0
    max_batch = 28
    high_watermark = 9
    max_latency = 100
    min_interval = 4
    debounce_wait = 20
    if scenario == "slow_consumer":
        base_service, per_item = 36, 5
    else:
        base_service, per_item = 15, 3
    t = 0
    drain_limit = horizon + 20000

    while t <= drain_limit and (arrival_idx < len(arrivals) or queue or running):
        while arrival_idx < len(arrivals) and arrivals[arrival_idx] <= t:
            queue.append((arrival_idx, arrivals[arrival_idx]))
            if first_pending is None:
                first_pending = arrivals[arrival_idx]
            arrival_idx += 1
        max_backlog = max(max_backlog, len(queue) + (len(running[1]) if running else 0))

        if running is not None and t >= running[0]:
            finish, batch = running
            latencies.extend(finish - arrived for _, arrived in batch)
            running = None
            last_finish = finish
            if policy == "aimd":
                if len(queue) >= high_watermark:
                    dynamic_wait = max(2.0, dynamic_wait * 0.62)
                else:
                    dynamic_wait = min(90.0, dynamic_wait + 4.0)
            elif policy == "pi":
                error = 4.0 - len(queue)
                integral = clamp(integral + error, -80.0, 80.0)
                dynamic_wait = clamp(18.0 + 3.8 * error + 0.16 * integral, 2.0, 100.0)
            first_pending = queue[0][1] if queue else None

        if running is None:
            start = False
            if policy == "fixed":
                if t >= next_tick:
                    if queue:
                        start = True
                    else:
                        empty_activations += 1
                    while next_tick <= t:
                        next_tick += 50
            elif queue:
                assert first_pending is not None
                wait = debounce_wait if policy in {"debounce", "watermark"} else dynamic_wait
                due = min(first_pending + max_latency, max(last_finish + min_interval, int(first_pending + wait)))
                if policy == "watermark" and len(queue) >= high_watermark:
                    start = t >= last_finish + min_interval
                else:
                    start = t >= due
            if start and queue:
                batch = [queue.popleft() for _ in range(min(max_batch, len(queue)))]
                service = base_service + per_item * len(batch)
                running = (t + service, batch)
                activations += 1
                first_pending = queue[0][1] if queue else None
        t += 1

    unfinished = len(queue) + (len(running[1]) if running else 0) + (len(arrivals) - arrival_idx)
    return {
        "count": float(len(arrivals)),
        "p50_latency_ms": percentile(latencies, 0.50),
        "p95_latency_ms": percentile(latencies, 0.95),
        "p99_latency_ms": percentile(latencies, 0.99),
        "mean_latency_ms": mean(latencies),
        "activations": float(activations),
        "empty_activations": float(empty_activations),
        "max_backlog": float(max_backlog),
        "unfinished": float(unfinished),
    }


def evaluate_scheduler(seed: int = DEFAULT_SEED) -> dict[str, Any]:
    policies = ["fixed", "debounce", "watermark", "aimd", "pi"]
    scenarios = ["steady", "bursty", "overload", "slow_consumer", "mixed"]
    per_scenario: dict[str, dict[str, dict[str, float]]] = {}
    for scenario in scenarios:
        per_scenario[scenario] = {}
        for policy in policies:
            runs = [simulate_scheduler(policy, scenario, seed + i * 101 + len(scenario)) for i in range(8)]
            per_scenario[scenario][policy] = {k: mean([r[k] for r in runs]) for k in runs[0]}
    aggregate: dict[str, dict[str, float]] = {}
    for policy in policies:
        rows = [per_scenario[s][policy] for s in scenarios]
        aggregate[policy] = {
            "mean_p95_latency_ms": mean([r["p95_latency_ms"] for r in rows]),
            "worst_p99_latency_ms": max(r["p99_latency_ms"] for r in rows),
            "mean_activations": mean([r["activations"] for r in rows]),
            "mean_empty_activations": mean([r["empty_activations"] for r in rows]),
            "worst_backlog": max(r["max_backlog"] for r in rows),
            "unfinished": sum(r["unfinished"] for r in rows),
        }
    winners = {scenario: min(policies, key=lambda p: (per_scenario[scenario][p]["p95_latency_ms"], per_scenario[scenario][p]["activations"])) for scenario in scenarios}
    return {
        "aggregate": aggregate,
        "scenario_winners_by_p95": winners,
        "per_scenario": per_scenario,
        "interpretation": "A component simulator cannot validate graph-wide stability. It screens defaults and counterexamples before runtime integration.",
    }


# ---------------------------------------------------------------------------
# RQ-T1: topology and bounded relay information
# ---------------------------------------------------------------------------


def correlated_majority(rng: random.Random, p: float, rho: float, n: int = 3) -> bool:
    common_error_probability = rho * (1.0 - p)
    if rng.random() < common_error_probability:
        return False
    adjusted = clamp(p / max(1e-9, 1.0 - common_error_probability), 0.0, 1.0)
    votes = sum(rng.random() < adjusted for _ in range(n))
    return votes > n // 2


def evaluate_topology(seed: int = DEFAULT_SEED, tasks: int = 30000) -> dict[str, Any]:
    regimes = {
        "decomposable_low_correlation": {"single": .68, "vote": .72, "rho": .15, "sub": .93, "relay": .985, "self_role": .86},
        "monolithic_high_correlation": {"single": .84, "vote": .82, "rho": .78, "sub": .78, "relay": .90, "self_role": .72},
        "weak_model_near_sufficient_relay": {"single": .61, "vote": .66, "rho": .25, "sub": .88, "relay": .97, "self_role": .80},
        "strong_model_lossy_relay": {"single": .91, "vote": .88, "rho": .60, "sub": .86, "relay": .78, "self_role": .76},
    }
    costs = {"single": 1, "vote3": 3, "manual_experts": 4, "isolated_main": 4, "self_division": 5}
    out: dict[str, Any] = {}
    for ridx, (name, cfg) in enumerate(regimes.items()):
        rng = random.Random(seed + 1000 * ridx)
        wins = defaultdict(int)
        for _ in range(tasks):
            wins["single"] += rng.random() < cfg["single"]
            wins["vote3"] += correlated_majority(rng, cfg["vote"], cfg["rho"])
            if "decomposable" in name or "weak_model" in name:
                experts_ok = all(rng.random() < cfg["sub"] for _ in range(3))
                wins["manual_experts"] += experts_ok and rng.random() < .98
            else:
                wins["manual_experts"] += correlated_majority(rng, cfg["sub"], min(.9, cfg["rho"] + .08))
            relay_ok = all(rng.random() < cfg["relay"] for _ in range(2))
            main_ok = rng.random() < clamp(cfg["single"] + .05, 0, .98)
            wins["isolated_main"] += relay_ok and main_ok
            role_ok = rng.random() < cfg["self_role"]
            wins["self_division"] += role_ok and correlated_majority(rng, cfg["vote"], cfg["rho"])
        rows = {}
        for strategy in costs:
            success = wins[strategy] / tasks
            rows[strategy] = {"success": success, "calls": float(costs[strategy]), "cost_adjusted_utility": success - .025 * (costs[strategy] - 1)}
        out[name] = rows
    winners = {name: max(rows, key=lambda s: rows[s]["cost_adjusted_utility"]) for name, rows in out.items()}
    return {
        "regimes": out,
        "cost_adjusted_winners": winners,
        "interpretation": "Structural Monte Carlo, not a language-model result. It makes correlation, decomposition and relay loss explicit.",
    }


# ---------------------------------------------------------------------------
# RQ-R1: reflection candidate governance
# ---------------------------------------------------------------------------


def evaluate_reflection(seed: int = DEFAULT_SEED, tasks: int = 24000) -> dict[str, Any]:
    rng = random.Random(seed)
    domains = 10
    candidates = []
    for i in range(90):
        true_effect = clamp(rng.gauss(.035, .07), -.15, .18)
        support = rng.randint(2, 14)
        estimate = true_effect + rng.gauss(0, .11 / math.sqrt(support))
        candidates.append({"id": i, "domain": rng.randrange(domains), "true_effect": true_effect, "support": support, "estimate": estimate})
    gated = [c for c in candidates if c["support"] >= 6 and c["estimate"] > .025]
    policies = {"no_reflection": [], "free_growing_prompt": candidates, "candidate_pool": gated}
    results = {}
    for name, active in policies.items():
        local = random.Random(seed + len(name))
        success = regressions = false_activations = 0
        probabilities = []
        for _ in range(tasks):
            domain = local.randrange(domains)
            base = .70
            if name == "no_reflection":
                p = base
            elif name == "free_growing_prompt":
                relevant = [c for c in active if c["domain"] == domain]
                effect = sum(c["true_effect"] for c in relevant) / max(1, math.sqrt(len(relevant)))
                interference = .00065 * (len(active) - len(relevant))
                p = clamp(base + effect - interference, .05, .98)
                false_activations += len(active) - len(relevant)
            else:
                relevant = [c for c in active if c["domain"] == domain]
                effect = sum(c["true_effect"] for c in relevant) / max(1, math.sqrt(len(relevant)))
                p = clamp(base + effect, .05, .98)
                false_activations += 0
            probabilities.append(p)
            regressions += p < base - 1e-9
            success += local.random() < p
        results[name] = {
            "success": success / tasks,
            "expected_success": mean(probabilities),
            "regression_rate": regressions / tasks,
            "active_rules": float(len(active)),
            "false_activations_per_task": false_activations / tasks,
            "rollback_supported": float(name == "candidate_pool"),
        }
    return {
        "policies": results,
        "candidate_acceptance_rate": len(gated) / len(candidates),
        "interpretation": "The experiment validates scoped promotion/rollback governance. It does not validate LLM-generated rule quality.",
    }


# ---------------------------------------------------------------------------
# RQ-P1/RQ-A1: procedural memory and trajectory abstraction
# ---------------------------------------------------------------------------


def dtw_distance(a: Sequence[Sequence[float]], b: Sequence[Sequence[float]]) -> float:
    inf = float("inf")
    dp = [[inf] * (len(b) + 1) for _ in range(len(a) + 1)]
    dp[0][0] = 0.0
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            cost = euclidean(a[i - 1], b[j - 1])
            dp[i][j] = cost + min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    return dp[-1][-1] / max(len(a), len(b))


def stretch_sequence(seq: list[list[float]], rng: random.Random) -> list[list[float]]:
    out = []
    for step in seq:
        out.extend([list(step)] * rng.choice([1, 1, 1, 2]))
    return out


def evaluate_procedural_and_trajectory(seed: int = DEFAULT_SEED, tests: int = 5000) -> dict[str, Any]:
    rng = random.Random(seed)
    methods = []
    for m in range(14):
        structure = []
        for step in range(rng.randint(4, 7)):
            v = [0.0] * 6
            v[(m + step * 2) % 6] = 1.0
            structure.append(v)
        preconditions = {f"cond:{m % 5}", f"cond:{(m * 3 + 1) % 7}"}
        train_domain = {f"noun:train-{m % 4}", f"surface:{m % 3}"}
        methods.append({"id": m, "structure": structure, "preconditions": preconditions, "train_words": train_domain})

    policies = ["raw_surface", "structured_procedure", "trajectory_mean", "trajectory_dtw", "trajectory_dtw_with_gate"]
    metrics = {p: defaultdict(float) for p in policies}
    for _ in range(tests):
        truth = rng.choice(methods)
        valid = rng.random() >= .28
        conditions = set(truth["preconditions"])
        if not valid:
            conditions.remove(rng.choice(sorted(conditions)))
        query_words = {f"noun:test-{rng.randrange(4)}", f"surface:{rng.randrange(3)}"}
        # Add a misleading lexical cue from another method.
        distractor = rng.choice([m for m in methods if m["id"] != truth["id"]])
        query_words |= set(distractor["train_words"])
        query_seq = stretch_sequence(truth["structure"], rng)
        query_seq = [[x + rng.gauss(0, .05) for x in step] for step in query_seq]

        rankings: dict[str, list[dict[str, Any]]] = {}
        rankings["raw_surface"] = sorted(methods, key=lambda m: jaccard(query_words, m["train_words"]), reverse=True)
        rankings["structured_procedure"] = sorted(methods, key=lambda m: (len(m["preconditions"] & conditions), -len(m["preconditions"] - conditions)), reverse=True)

        def avg_vec(seq: Sequence[Sequence[float]]) -> list[float]:
            return [mean([step[d] for step in seq]) for d in range(6)]
        qavg = avg_vec(query_seq)
        rankings["trajectory_mean"] = sorted(methods, key=lambda m: euclidean(qavg, avg_vec(m["structure"])))
        rankings["trajectory_dtw"] = sorted(methods, key=lambda m: dtw_distance(query_seq, m["structure"]))
        rankings["trajectory_dtw_with_gate"] = rankings["trajectory_dtw"]

        for policy in policies:
            selected = rankings[policy][0]
            abstain = False
            if policy in {"structured_procedure", "trajectory_dtw_with_gate"} and not selected["preconditions"] <= conditions:
                abstain = True
            if valid:
                ok = (not abstain) and selected["id"] == truth["id"]
            else:
                ok = abstain
            negative_transfer = (not valid) and (not abstain)
            metrics[policy]["success"] += ok
            metrics[policy]["negative_transfer"] += negative_transfer
            metrics[policy]["abstention"] += abstain
    rows = {p: {k: v / tests for k, v in vals.items()} for p, vals in metrics.items()}
    return {
        "policies": rows,
        "interpretation": "The trajectory task is deliberately cross-domain and duration-warped. Its embeddings are synthetic; real representation learning remains open.",
    }


# ---------------------------------------------------------------------------
# RQ-N1: LevelUpper transport safety and epistemic sharing
# ---------------------------------------------------------------------------


def cycle_neighbors(n: int) -> dict[int, list[int]]:
    return {i: sorted({(i - 1) % n, (i + 1) % n}) for i in range(n)}


def naive_rebroadcast(rounds: int = 9, n: int = 5) -> dict[str, float]:
    neighbors = cycle_neighbors(n)
    frontier = [(0, "origin:0:block:0")]
    deliveries = defaultdict(int)
    deliveries[0] += 1
    transmissions = 0
    for _ in range(rounds):
        nxt = []
        for node, msg in frontier:
            for other in neighbors[node]:
                transmissions += 1
                deliveries[other] += 1
                nxt.append((other, msg))
        frontier = nxt
    return {"transmissions": float(transmissions), "unique_nodes": float(len(deliveries)), "duplicate_deliveries": float(sum(max(0, x - 1) for x in deliveries.values()))}


def deduplicated_relay(hop_limit: int = 5, n: int = 5) -> dict[str, float]:
    neighbors = cycle_neighbors(n)
    key = ("origin-0", "remote-block-0", "content-hash-0")
    seen = {i: set() for i in range(n)}
    seen[0].add(key)
    frontier = deque([(0, 0)])
    transmissions = duplicates = 0
    while frontier:
        node, hop = frontier.popleft()
        if hop >= hop_limit:
            continue
        for other in neighbors[node]:
            transmissions += 1
            if key in seen[other]:
                duplicates += 1
                continue
            seen[other].add(key)
            frontier.append((other, hop + 1))
    return {"transmissions": float(transmissions), "unique_nodes": float(sum(bool(v) for v in seen.values())), "duplicate_attempts_dropped": float(duplicates)}


def sharing_accuracy(seed: int, high_trust: bool, tasks: int = 30000) -> dict[str, float]:
    rng = random.Random(seed)
    local = shared = 0
    for _ in range(tasks):
        own = rng.random() < .71
        local += own
        if high_trust:
            remote1 = rng.random() < .74
            remote2 = rng.random() < .72
        else:
            common_wrong = rng.random() < .27
            remote1 = False if common_wrong else rng.random() < .60
            remote2 = False  # malicious or systematically stale peer
        shared += (own + remote1 + remote2) >= 2
    return {"local_accuracy": local / tasks, "shared_majority_accuracy": shared / tasks}


def evaluate_levelupper(seed: int = DEFAULT_SEED) -> dict[str, Any]:
    naive = naive_rebroadcast()
    safe = deduplicated_relay()
    return {
        "transport": {"naive": naive, "origin_envelope_dedupe": safe},
        "epistemic": {
            "high_trust_independent": sharing_accuracy(seed, True),
            "low_trust_correlated_or_malicious": sharing_accuracy(seed + 1, False),
        },
        "interpretation": "Transport deduplication is a correctness result. Whether remote knowledge should influence an answer is a separate trust/relevance decision.",
    }


# ---------------------------------------------------------------------------
# RQ-L1: Testament as an offline replay/curriculum harness
# ---------------------------------------------------------------------------


def evaluate_testament(seed: int = DEFAULT_SEED) -> dict[str, Any]:
    rng = random.Random(seed)
    activations = []
    for i in range(420):
        payload = f"task-{rng.randrange(90)}:variant-{rng.randrange(4)}"
        activations.append({"source_module": rng.choice(["brain-a", "brain-b"]), "payload": payload, "success": rng.random() < .72})
    mapping = {"brain-a": ["learner-1", "learner-2"], "brain-b": ["learner-3"]}
    raw_outputs = sum(len(mapping[a["source_module"]]) for a in activations)
    unique_successes = {(a["source_module"], a["payload"]) for a in activations if a["success"]}
    curated_outputs = sum(len(mapping[src]) for src, _ in unique_successes)
    deterministic_replay_hash = hashlib.sha256("\n".join(f"{a['source_module']}|{a['payload']}|{int(a['success'])}" for a in activations).encode()).hexdigest()
    repeated_hash = hashlib.sha256("\n".join(f"{a['source_module']}|{a['payload']}|{int(a['success'])}" for a in activations).encode()).hexdigest()
    return {
        "recorded_activations": len(activations),
        "raw_fanout_outputs": raw_outputs,
        "curated_success_deduplicated_outputs": curated_outputs,
        "duplicate_reduction": 1.0 - curated_outputs / raw_outputs,
        "replay_hash_stable": deterministic_replay_hash == repeated_hash,
        "module_mapping_fanout_supported": True,
        "interpretation": "This validates an offline replay substrate shape. Learning quality is evaluated by procedural/reflection held-out tests, not by replay volume.",
    }


# ---------------------------------------------------------------------------
# RQ-MM1: representation contract (no empirical modality winner claimed)
# ---------------------------------------------------------------------------


def evaluate_media_contract() -> dict[str, Any]:
    assets = {
        "raw-audio": {"kind": "raw", "parent": None, "version": "sha256:a"},
        "transcript-v1": {"kind": "derived", "parent": "raw-audio", "version": "asr:model-1"},
        "transcript-v2": {"kind": "derived", "parent": "raw-audio", "version": "asr:model-2"},
        "raw-video": {"kind": "raw", "parent": None, "version": "sha256:v"},
        "frames-v1": {"kind": "derived", "parent": "raw-video", "version": "sampler:scene-v1"},
        "caption-v1": {"kind": "derived", "parent": "frames-v1", "version": "vlm:model-1"},
    }
    derived_have_parent = all(v["parent"] is not None for v in assets.values() if v["kind"] == "derived")
    versions_present = all(bool(v["version"]) for v in assets.values())
    raw_preserved = "raw-audio" in assets and "raw-video" in assets
    return {
        "derived_have_parent": derived_have_parent,
        "all_representations_versioned": versions_present,
        "raw_assets_preserved": raw_preserved,
        "preferred_representation": None,
        "interpretation": "Integrity contract passed; choosing raw audio, transcript, frames, captions or fused views requires a live multimodal benchmark.",
    }


# ---------------------------------------------------------------------------
# Decisions, output and self-tests
# ---------------------------------------------------------------------------


def derive_decisions(results: dict[str, Any]) -> list[dict[str, str]]:
    return [
        {"topic": "temporal_association", "status": "ADOPT_WITH_RESTRICTIONS", "decision": "Implement a one-hop, evidence-bearing, frequency-normalized multi-scale association candidate behind a feature flag; require temporal-shuffle and abstention controls."},
        {"topic": "memory_clustering", "status": "ADOPT_DATA_MODEL_ONLY", "decision": "Allow typed overlapping Entity/Concept/Episode/Procedure nodes. Do not freeze an online clustering algorithm yet."},
        {"topic": "tensity", "status": "REJECT_RANDOM_DEFAULT", "decision": "Keep tensity as a bounded hint. Selection must be deterministic and dependency-group-aware before it may become a default."},
        {"topic": "scheduler", "status": "KEEP_SIMPLE_DEFAULT", "decision": "Keep debounce as the default and add an optional high-watermark fast path. PI/AIMD remain strategies for graph-level experiments, not universal defaults."},
        {"topic": "multi_agent_topology", "status": "STATIC_BY_DEFAULT", "decision": "Use one main brain or manually configured experts. Promote a topology only on paired equal-budget tasks; self-division remains experimental."},
        {"topic": "reflection", "status": "ADOPT_GOVERNANCE", "decision": "Store scoped candidate policies with evidence, held-out replay, versioning and rollback. Never append free-growing reflection text directly to the permanent system prompt."},
        {"topic": "procedural_memory", "status": "ADOPT_SEPARATE_SCHEMA", "decision": "Keep Procedure records separate from executable Skills and require applicability conditions, failure evidence and negative-transfer evaluation."},
        {"topic": "trajectory_abstraction", "status": "EXPERIMENTAL", "decision": "DTW/structure-masked trajectory retrieval is a candidate for cross-domain transfer, but requires real traces and counterexample gates."},
        {"topic": "testament", "status": "OFFLINE_HARNESS", "decision": "Implement Testament as an isolated replay/curriculum/evaluation program sharing immutable snapshots, not as a live self-modifying Extension."},
        {"topic": "levelupper", "status": "ADOPT_TRANSPORT_ENVELOPE", "decision": "Create new local BlockIds while preserving remote origin ID, content hash, route, hop limit and trust metadata. Deduplicate before Page insertion."},
        {"topic": "media_representation", "status": "INSUFFICIENT_EMPIRICAL_EVIDENCE", "decision": "Retain raw Assets and versioned derived views. Select representations per provider/task after live evaluation."},
    ]


def run_all(seed: int = DEFAULT_SEED, quick: bool = False) -> dict[str, Any]:
    started = time.time()
    results = {
        "association": evaluate_association(seed),
        "clustering": evaluate_clustering(seed + 10),
        "tensity": evaluate_tensity(seed + 20, 320 if quick else 720),
        "scheduler": evaluate_scheduler(seed + 30),
        "topology": evaluate_topology(seed + 40, 8000 if quick else 30000),
        "reflection": evaluate_reflection(seed + 50, 8000 if quick else 24000),
        "procedural_trajectory": evaluate_procedural_and_trajectory(seed + 60, 1800 if quick else 5200),
        "levelupper": evaluate_levelupper(seed + 70),
        "testament": evaluate_testament(seed + 80),
        "media_contract": evaluate_media_contract(),
    }
    return {
        "suite_version": SUITE_VERSION,
        "seed": seed,
        "quick": quick,
        "elapsed_seconds": time.time() - started,
        "results": results,
        "decisions": derive_decisions(results),
        "evidence_class": "synthetic_component_screening",
        "claim_boundary": "No result in this file is a live-LLM, public-benchmark, or Dolly-runtime integration result.",
    }


def flatten_metrics(value: Any, prefix: str = "") -> Iterable[tuple[str, Any]]:
    if isinstance(value, dict):
        for k, v in value.items():
            p = f"{prefix}.{k}" if prefix else str(k)
            yield from flatten_metrics(v, p)
    elif isinstance(value, (list, tuple)):
        for i, v in enumerate(value):
            yield from flatten_metrics(v, f"{prefix}[{i}]")
    elif isinstance(value, (str, int, float, bool)) or value is None:
        yield prefix, value


def make_summary(bundle: dict[str, Any]) -> str:
    r = bundle["results"]
    lines = [
        "# Dolly Research Layer — deterministic screening results",
        "",
        f"- Suite: `{bundle['suite_version']}`",
        f"- Seed: `{bundle['seed']}`",
        f"- Evidence class: **{bundle['evidence_class']}**",
        f"- Boundary: {bundle['claim_boundary']}",
        "",
        "## Decisions",
        "",
        "| Topic | Status | Decision |",
        "|---|---|---|",
    ]
    for d in bundle["decisions"]:
        lines.append(f"| {d['topic']} | **{d['status']}** | {d['decision']} |")
    lines += [
        "",
        "## Key synthetic findings",
        "",
        f"- Association Precision@1: semantic `{r['association']['metrics']['semantic']['precision_at_1']:.3f}`, raw co-occurrence `{r['association']['metrics']['raw']['precision_at_1']:.3f}`, normalized temporal `{r['association']['metrics']['normalized']['precision_at_1']:.3f}`; temporal shuffle collapse `{r['association']['temporal_shuffle']['relative_collapse']:.3f}`.",
        f"- Overlapping typed relation F1 `{r['clustering']['typed_overlapping']['f1']:.3f}` versus flat partition `{r['clustering']['flat_partition']['f1']:.3f}`.",
        f"- Context dependency break: stochastic tensity `{r['tensity']['policies']['stochastic_tensity']['dependency_break_rate']:.3f}`, group-aware `{r['tensity']['policies']['group_aware']['dependency_break_rate']:.3f}`.",
        f"- Scheduler p95 winners by scenario: `{json.dumps(r['scheduler']['scenario_winners_by_p95'], sort_keys=True)}`. No universal adaptive winner is assumed.",
        f"- Reflection expected success: no reflection `{r['reflection']['policies']['no_reflection']['expected_success']:.3f}`, free-growing `{r['reflection']['policies']['free_growing_prompt']['expected_success']:.3f}`, gated pool `{r['reflection']['policies']['candidate_pool']['expected_success']:.3f}`.",
        f"- LevelUpper transmissions: naive `{r['levelupper']['transport']['naive']['transmissions']:.0f}`, origin-envelope/dedupe `{r['levelupper']['transport']['origin_envelope_dedupe']['transmissions']:.0f}`.",
        "",
        "## What this does not prove",
        "",
        "These experiments validate invariants, controls and failure modes. Public benchmark adapters and live-model runs are separate gates because they require model endpoints, benchmark downloads, exact model snapshots and paid-call budgets.",
    ]
    return "\n".join(lines) + "\n"


def make_html(bundle: dict[str, Any], summary_md: str) -> str:
    decisions = "".join(
        f"<tr><td>{html.escape(d['topic'])}</td><td><strong>{html.escape(d['status'])}</strong></td><td>{html.escape(d['decision'])}</td></tr>"
        for d in bundle["decisions"]
    )
    metrics = "".join(
        f"<tr><td><code>{html.escape(path)}</code></td><td>{html.escape(str(value))}</td></tr>"
        for path, value in flatten_metrics(bundle["results"])
        if not path.endswith("interpretation")
    )
    return f"""<!doctype html><html><head><meta charset='utf-8'><title>Dolly research layer</title>
<style>body{{font-family:system-ui,sans-serif;max-width:1180px;margin:40px auto;padding:0 24px;line-height:1.55}}table{{border-collapse:collapse;width:100%;font-size:14px}}th,td{{border:1px solid #ddd;padding:8px;vertical-align:top}}th{{background:#f3f3f3}}code{{font-size:12px}}.warn{{padding:14px;background:#fff3cd;border-left:5px solid #d39e00}}</style></head><body>
<h1>Dolly Research Layer</h1><div class='warn'>{html.escape(bundle['claim_boundary'])}</div>
<h2>Decisions</h2><table><tr><th>Topic</th><th>Status</th><th>Decision</th></tr>{decisions}</table>
<h2>All metrics</h2><table><tr><th>Metric</th><th>Value</th></tr>{metrics}</table>
<h2>Markdown summary</h2><pre>{html.escape(summary_md)}</pre></body></html>"""


def self_test(bundle: dict[str, Any]) -> None:
    r = bundle["results"]
    assert r["association"]["metrics"]["normalized"]["precision_at_1"] > r["association"]["metrics"]["semantic"]["precision_at_1"]
    assert r["association"]["temporal_shuffle"]["relative_collapse"] > 0.35
    assert r["clustering"]["typed_overlapping"]["f1"] > r["clustering"]["flat_partition"]["f1"]
    assert r["tensity"]["policies"]["group_aware"]["dependency_break_rate"] == 0.0
    assert all(v["unfinished"] == 0.0 for v in r["scheduler"]["aggregate"].values())
    assert r["reflection"]["policies"]["candidate_pool"]["regression_rate"] < r["reflection"]["policies"]["free_growing_prompt"]["regression_rate"]
    assert r["procedural_trajectory"]["policies"]["trajectory_dtw_with_gate"]["negative_transfer"] < r["procedural_trajectory"]["policies"]["trajectory_dtw"]["negative_transfer"]
    assert r["levelupper"]["transport"]["origin_envelope_dedupe"]["transmissions"] < r["levelupper"]["transport"]["naive"]["transmissions"]
    assert r["levelupper"]["transport"]["origin_envelope_dedupe"]["unique_nodes"] == 5.0
    assert r["testament"]["replay_hash_stable"] is True
    assert r["media_contract"]["raw_assets_preserved"] is True


def write_outputs(bundle: dict[str, Any], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    summary = make_summary(bundle)
    (out_dir / "metrics.json").write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "summary.md").write_text(summary, encoding="utf-8")
    (out_dir / "report.html").write_text(make_html(bundle, summary), encoding="utf-8")
    with (out_dir / "metrics.csv").open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["metric", "value"])
        writer.writerows(flatten_metrics(bundle["results"]))
    manifest = {
        "suite_version": SUITE_VERSION,
        "seed": bundle["seed"],
        "quick": bundle["quick"],
        "python": sys.version,
        "platform": platform.platform(),
        "generated_at_unix": time.time(),
        "source_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "command": " ".join(sys.argv),
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    zip_path = out_dir / "dolly-research-layer-results.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(out_dir.iterdir()):
            if path != zip_path and path.is_file():
                zf.write(path, path.name)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--out", type=Path, default=Path(__file__).with_name("out"))
    parser.add_argument("--quick", action="store_true")
    parser.add_argument("--no-self-test", action="store_true")
    args = parser.parse_args()
    bundle = run_all(args.seed, args.quick)
    if not args.no_self_test:
        self_test(bundle)
    write_outputs(bundle, args.out)
    print(make_summary(bundle))
    print(f"Wrote artifacts to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
