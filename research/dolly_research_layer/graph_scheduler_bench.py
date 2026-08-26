#!/usr/bin/env python3
"""Graph-level discrete-time scheduler experiment for Dolly.

The simulator is Gate-0 evidence only.  It models finite per-edge queues, fan-in,
fan-out, bounded cycles, slow modules, atomic fan-out publication and exact queue
visibility.  It compares direct observable-pressure policies against AIMD/PI rate
estimators.  It is deterministic under a seed and uses no wall-clock sleeps.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import random
import statistics
import time
from collections import Counter, defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

VERSION = "2026.08.26-graph-scheduler-v1"
QUEUE_CAPACITY = 36
HIGH_WATERMARK = 27
LOW_WATERMARK = 12
BATCH_SIZE = 4
MAX_VISITS_PER_NODE = 2


def mean(xs: Sequence[float]) -> float:
    return statistics.fmean(xs) if xs else 0.0


def pct(xs: Sequence[float], q: float) -> float:
    if not xs:
        return 0.0
    ys = sorted(xs)
    p = (len(ys) - 1) * q
    lo, hi = math.floor(p), math.ceil(p)
    if lo == hi:
        return float(ys[lo])
    return float(ys[lo] * (hi - p) + ys[hi] * (p - lo))


def cv(xs: Sequence[float]) -> float:
    m = mean(xs)
    return statistics.pstdev(xs) / m if len(xs) > 1 and m > 0 else 0.0


def jain(values: Sequence[float]) -> float:
    if not values or sum(values) == 0:
        return 1.0
    return sum(values) ** 2 / (len(values) * sum(x * x for x in values))


def direction_reversals(xs: Sequence[float]) -> int:
    last = 0
    reversals = 0
    for a, b in zip(xs, xs[1:]):
        sign = (b > a) - (b < a)
        if sign and last and sign != last:
            reversals += 1
        if sign:
            last = sign
    return reversals


@dataclass(frozen=True)
class Packet:
    trace_id: int
    born_at: int
    source: str
    route: tuple[str, ...]


@dataclass
class Node:
    name: str
    outgoing: tuple[str, ...]
    service_base: int
    service_per_item: int
    queue: deque[Packet] = field(default_factory=deque)
    running_until: int | None = None
    running_batch: list[Packet] = field(default_factory=list)
    pending_publish: deque[tuple[Packet, tuple[str, ...]]] = field(default_factory=deque)
    next_eligible: int = 0
    interval: float = 1.0
    integral: float = 0.0
    throttled: bool = False
    activations: int = 0
    blocked_ticks: int = 0
    busy_ticks: int = 0


@dataclass(frozen=True)
class Topology:
    name: str
    edges: dict[str, tuple[str, ...]]
    sources: tuple[str, ...]
    sinks: tuple[str, ...]
    slow_nodes: tuple[str, ...] = ()


def topologies() -> list[Topology]:
    return [
        Topology("line", {"a": ("b",), "b": ("sink",), "sink": ()}, ("a",), ("sink",)),
        Topology("fan_in", {"a": ("join",), "b": ("join",), "join": ("sink",), "sink": ()}, ("a", "b"), ("sink",)),
        Topology("fan_out", {"a": ("left", "right"), "left": ("sink_l",), "right": ("sink_r",), "sink_l": (), "sink_r": ()}, ("a",), ("sink_l", "sink_r"), ("right",)),
        Topology("diamond", {"a": ("left", "right"), "left": ("join",), "right": ("join",), "join": ("sink",), "sink": ()}, ("a",), ("sink",), ("right",)),
        Topology("self_loop", {"a": ("a", "sink"), "sink": ()}, ("a",), ("sink",)),
        Topology("two_cycle", {"a": ("b", "sink_a"), "b": ("a", "sink_b"), "sink_a": (), "sink_b": ()}, ("a",), ("sink_a", "sink_b"), ("b",)),
    ]


def policy_names() -> list[str]:
    names = ["reactive", "watermark", "credit", "pi"]
    for additive in (0.5, 1.0, 2.0):
        for multiplier in (1.35, 1.8, 2.5):
            names.append(f"aimd:a={additive}:m={multiplier}")
    return names


def parse_aimd(policy: str) -> tuple[float, float] | None:
    if not policy.startswith("aimd:"):
        return None
    fields = dict(part.split("=", 1) for part in policy.split(":")[1:])
    return float(fields["a"]), float(fields["m"])


def service_params(name: str, topology: Topology) -> tuple[int, int]:
    if name in topology.sinks:
        return 2, 1
    if name in topology.slow_nodes:
        return 12, 4
    return 5, 2


def arrival_intervals(load: str) -> tuple[int, int]:
    if load == "under":
        return 16, 22
    if load == "capacity":
        return 8, 12
    if load == "over":
        return 3, 6
    raise ValueError(load)


def downstream_pressure(node: Node, nodes: dict[str, Node]) -> float:
    if not node.outgoing:
        return 0.0
    return max(len(nodes[d].queue) / QUEUE_CAPACITY for d in node.outgoing)


def can_start(policy: str, node: Node, nodes: dict[str, Node], now: int) -> bool:
    if node.running_until is not None or node.pending_publish or not node.queue or now < node.next_eligible:
        return False
    if not node.outgoing:
        return True
    occupancies = [len(nodes[d].queue) for d in node.outgoing]
    if policy == "watermark":
        if node.throttled:
            if all(x <= LOW_WATERMARK for x in occupancies):
                node.throttled = False
        elif any(x >= HIGH_WATERMARK for x in occupancies):
            node.throttled = True
        return not node.throttled
    if policy == "credit":
        batch = min(BATCH_SIZE, len(node.queue))
        return all(QUEUE_CAPACITY - x >= batch for x in occupancies)
    return True


def update_controller(policy: str, node: Node, nodes: dict[str, Node], now: int, was_blocked: bool) -> None:
    pressure = downstream_pressure(node, nodes)
    aimd = parse_aimd(policy)
    if aimd:
        additive, multiplier = aimd
        if was_blocked or pressure >= HIGH_WATERMARK / QUEUE_CAPACITY:
            node.interval = min(80.0, max(1.0, node.interval * multiplier))
        else:
            node.interval = max(1.0, node.interval - additive)
    elif policy == "pi":
        error = pressure - 0.42
        node.integral = max(-20.0, min(20.0, node.integral + error))
        node.interval = max(1.0, min(80.0, 1.0 + 28.0 * error + 2.0 * node.integral))
    else:
        node.interval = 1.0
    node.next_eligible = now + int(math.ceil(node.interval))


def simulate(topology: Topology, load: str, policy: str, seed: int, horizon: int = 4200) -> dict[str, float]:
    rng = random.Random(seed)
    nodes = {
        name: Node(name, outgoing, *service_params(name, topology))
        for name, outgoing in topology.edges.items()
    }
    external: dict[str, deque[Packet]] = {s: deque() for s in topology.sources}
    next_arrival: dict[str, int] = {s: rng.randrange(0, 5) for s in topology.sources}
    low_i, high_i = arrival_intervals(load)
    trace_id = 0
    latencies: list[int] = []
    completed_keys: set[tuple[int, str]] = set()
    completions_by_source: Counter[str] = Counter()
    generated_by_source: Counter[str] = Counter()
    last_completion = 0
    sustained_no_progress = False
    max_queue = 0
    max_external = 0
    queue_samples: list[int] = []
    overflow_attempts = 0
    atomic_publish_stalls = 0
    drain_limit = horizon + 16000

    def has_work() -> bool:
        return any(external[s] for s in topology.sources) or any(n.queue or n.running_until is not None or n.pending_publish for n in nodes.values())

    now = 0
    while now <= drain_limit and (now < horizon or has_work()):
        # Create offered load only during the measurement horizon.
        if now < horizon:
            for source in topology.sources:
                while next_arrival[source] <= now:
                    packet = Packet(trace_id, now, source, (source,))
                    trace_id += 1
                    external[source].append(packet)
                    generated_by_source[source] += 1
                    next_arrival[source] += rng.randint(low_i, high_i)

        # Admit external work without dropping it.
        for source in topology.sources:
            while external[source] and len(nodes[source].queue) < QUEUE_CAPACITY:
                nodes[source].queue.append(external[source].popleft())

        # Complete service and create an atomic publication bundle per packet.
        for node in nodes.values():
            if node.running_until is not None:
                node.busy_ticks += 1
            if node.running_until is not None and now >= node.running_until:
                batch = node.running_batch
                node.running_batch = []
                node.running_until = None
                if not node.outgoing:
                    for packet in batch:
                        key = (packet.trace_id, node.name)
                        if key not in completed_keys:
                            completed_keys.add(key)
                            latencies.append(now - packet.born_at)
                            completions_by_source[packet.source] += 1
                            last_completion = now
                else:
                    for packet in batch:
                        destinations = tuple(
                            d for d in node.outgoing
                            if packet.route.count(d) < MAX_VISITS_PER_NODE
                        )
                        if destinations:
                            next_packet = Packet(packet.trace_id, packet.born_at, packet.source, packet.route + (node.name,))
                            node.pending_publish.append((next_packet, destinations))
                update_controller(policy, node, nodes, now, bool(node.pending_publish))

        # Publish only when every destination of one fan-out packet has room.
        for node in nodes.values():
            if node.pending_publish:
                node.blocked_ticks += 1
            while node.pending_publish:
                packet, destinations = node.pending_publish[0]
                if not all(len(nodes[d].queue) < QUEUE_CAPACITY for d in destinations):
                    atomic_publish_stalls += 1
                    break
                node.pending_publish.popleft()
                for destination in destinations:
                    if len(nodes[destination].queue) >= QUEUE_CAPACITY:
                        overflow_attempts += 1
                        raise AssertionError("capacity race in single-thread simulator")
                    routed = Packet(packet.trace_id, packet.born_at, packet.source, packet.route + (destination,))
                    nodes[destination].queue.append(routed)

        # Start eligible activations.
        for node in nodes.values():
            if can_start(policy, node, nodes, now):
                batch_size = min(BATCH_SIZE, len(node.queue))
                batch = [node.queue.popleft() for _ in range(batch_size)]
                jitter = rng.randint(0, 2)
                node.running_batch = batch
                node.running_until = now + node.service_base + node.service_per_item * len(batch) + jitter
                node.activations += 1

        total_queued = sum(len(n.queue) + len(n.pending_publish) for n in nodes.values())
        max_queue = max(max_queue, max((len(n.queue) for n in nodes.values()), default=0))
        max_external = max(max_external, sum(len(q) for q in external.values()))
        if now % 10 == 0:
            queue_samples.append(total_queued)
        if has_work() and now - last_completion > 650 and now > 650:
            sustained_no_progress = True
        now += 1

    generated = sum(generated_by_source.values())
    completed = len(completed_keys)
    pending = sum(len(q) for q in external.values()) + sum(len(n.queue) + len(n.running_batch) + len(n.pending_publish) for n in nodes.values())
    source_values = [completions_by_source[s] for s in topology.sources]
    return {
        "generated_traces": float(generated),
        "sink_completions": float(completed),
        "throughput_per_1000_ticks": completed / horizon * 1000.0,
        "p50_latency": pct(latencies, 0.50),
        "p95_latency": pct(latencies, 0.95),
        "p99_latency": pct(latencies, 0.99),
        "mean_latency": mean(latencies),
        "max_node_queue": float(max_queue),
        "max_external_backlog": float(max_external),
        "pending_after_drain": float(pending),
        "sustained_no_progress": float(sustained_no_progress),
        "activations": float(sum(n.activations for n in nodes.values())),
        "blocked_ticks": float(sum(n.blocked_ticks for n in nodes.values())),
        "busy_ticks": float(sum(n.busy_ticks for n in nodes.values())),
        "atomic_publish_stalls": float(atomic_publish_stalls),
        "overflow_attempts": float(overflow_attempts),
        "queue_cv": cv(queue_samples),
        "queue_direction_reversals": float(direction_reversals(queue_samples)),
        "source_fairness": jain(source_values),
    }


def paired_delta(rows_a: Sequence[dict[str, float]], rows_b: Sequence[dict[str, float]], metric: str) -> float:
    return mean([a[metric] - b[metric] for a, b in zip(rows_a, rows_b)])


def run_suite(seeds: int = 30, horizon: int = 4200) -> dict[str, Any]:
    started = time.time()
    policies = policy_names()
    loads = ["under", "capacity", "over"]
    raw: dict[str, dict[str, dict[str, list[dict[str, float]]]]] = defaultdict(lambda: defaultdict(dict))
    for topology_index, topology in enumerate(topologies()):
        for load_index, load in enumerate(loads):
            for policy_index, policy in enumerate(policies):
                rows = [
                    simulate(topology, load, policy, 20260826 + topology_index * 100000 + load_index * 10000 + s, horizon)
                    for s in range(seeds)
                ]
                raw[topology.name][load][policy] = rows

    aggregate: dict[str, Any] = {}
    comparison: dict[str, Any] = {}
    for topology in topologies():
        aggregate[topology.name] = {}
        comparison[topology.name] = {}
        for load in loads:
            aggregate[topology.name][load] = {}
            baseline = raw[topology.name][load]["watermark"]
            comparison[topology.name][load] = {}
            for policy in policies:
                rows = raw[topology.name][load][policy]
                aggregate[topology.name][load][policy] = {
                    key: mean([r[key] for r in rows]) for key in rows[0]
                }
                comparison[topology.name][load][policy] = {
                    "p95_delta_vs_watermark": paired_delta(rows, baseline, "p95_latency"),
                    "throughput_delta_vs_watermark": paired_delta(rows, baseline, "throughput_per_1000_ticks"),
                    "blocked_delta_vs_watermark": paired_delta(rows, baseline, "blocked_ticks"),
                    "no_progress_runs": sum(r["sustained_no_progress"] for r in rows),
                    "unfinished_runs": sum(r["pending_after_drain"] > 0 for r in rows),
                }

    aimd_policies = [p for p in policies if p.startswith("aimd:")]
    cells = [(t.name, load) for t in topologies() for load in loads]
    aimd_robustness = {}
    for policy in aimd_policies:
        wins = safe = 0
        for topology_name, load in cells:
            p = aggregate[topology_name][load][policy]
            b = aggregate[topology_name][load]["watermark"]
            latency_win = p["p95_latency"] <= 0.8 * b["p95_latency"] if b["p95_latency"] > 0 else False
            throughput_ok = p["throughput_per_1000_ticks"] >= 0.98 * b["throughput_per_1000_ticks"]
            no_progress = comparison[topology_name][load][policy]["no_progress_runs"]
            unfinished = comparison[topology_name][load][policy]["unfinished_runs"]
            wins += latency_win and throughput_ok and no_progress == 0 and unfinished == 0
            safe += no_progress == 0 and unfinished == 0
        aimd_robustness[policy] = {
            "cells": len(cells),
            "minimum_effect_wins": wins,
            "safe_cells": safe,
            "win_fraction": wins / len(cells),
            "safe_fraction": safe / len(cells),
        }

    policy_summary = {}
    for policy in policies:
        cell_rows = [aggregate[t][load][policy] for t, load in cells]
        policy_summary[policy] = {
            "mean_p95_latency": mean([r["p95_latency"] for r in cell_rows]),
            "mean_throughput": mean([r["throughput_per_1000_ticks"] for r in cell_rows]),
            "worst_backlog": max(r["max_external_backlog"] for r in cell_rows),
            "no_progress_cells": sum(r["sustained_no_progress"] > 0 for r in cell_rows),
            "unfinished_cells": sum(r["pending_after_drain"] > 0 for r in cell_rows),
            "mean_queue_cv": mean([r["queue_cv"] for r in cell_rows]),
            "mean_fairness": mean([r["source_fairness"] for r in cell_rows),
        }

    best_aimd = max(aimd_robustness, key=lambda p: (aimd_robustness[p]["win_fraction"], aimd_robustness[p]["safe_fraction"]))
    adopt_internal_aimd = aimd_robustness[best_aimd]["win_fraction"] >= 0.5 and aimd_robustness[best_aimd]["safe_fraction"] == 1.0
    return {
        "version": VERSION,
        "seeds_per_cell": seeds,
        "horizon": horizon,
        "topologies": [t.name for t in topologies()],
        "loads": loads,
        "policies": policies,
        "aggregate": aggregate,
        "paired_comparison": comparison,
        "policy_summary": policy_summary,
        "aimd_parameter_robustness": aimd_robustness,
        "decision": {
            "best_aimd_parameterization": best_aimd,
            "adopt_internal_aimd_default": adopt_internal_aimd,
            "recommended_default": "credit_or_watermark",
            "provider_concurrency_aimd": "separate_unobservable-queue_experiment",
        },
        "elapsed_seconds": time.time() - started,
        "claim_boundary": "Gate-0 graph simulation; must be validated against the real Runtime before product promotion.",
    }


def flatten(value: Any, prefix: str = "") -> Iterable[tuple[str, Any]]:
    if isinstance(value, dict):
        for k, v in value.items():
            yield from flatten(v, f"{prefix}.{k}" if prefix else str(k))
    elif isinstance(value, list):
        for i, v in enumerate(value):
            yield from flatten(v, f"{prefix}[{i}]")
    else:
        yield prefix, value


def summary(bundle: dict[str, Any]) -> str:
    lines = [
        "# Dolly graph scheduler experiment",
        "",
        f"- Version: `{bundle['version']}`",
        f"- Matrix: `{len(bundle['topologies'])}` topologies × `{len(bundle['loads'])}` loads × `{len(bundle['policies'])}` policies × `{bundle['seeds_per_cell']}` seeds.",
        f"- Decision: internal AIMD default = **{bundle['decision']['adopt_internal_aimd_default']}**.",
        f"- Recommended internal baseline: **{bundle['decision']['recommended_default']}**.",
        "",
        "## Policy aggregate",
        "",
        "| Policy | Mean p95 | Mean throughput | No-progress cells | Unfinished cells | Queue CV |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for policy, row in sorted(bundle["policy_summary"].items()):
        lines.append(f"| `{policy}` | {row['mean_p95_latency']:.2f} | {row['mean_throughput']:.2f} | {row['no_progress_cells']} | {row['unfinished_cells']} | {row['mean_queue_cv']:.3f} |")
    lines += [
        "",
        "## AIMD parameter sensitivity",
        "",
        "| Policy | ≥20% p95 wins at matched throughput | Safe cells |",
        "|---|---:|---:|",
    ]
    for policy, row in sorted(bundle["aimd_parameter_robustness"].items()):
        lines.append(f"| `{policy}` | {row['minimum_effect_wins']}/{row['cells']} | {row['safe_cells']}/{row['cells']} |")
    lines += [
        "",
        "The provider-facing concurrency problem is intentionally excluded: unlike internal Page queues, a remote provider's queue is not directly observable and may justify AIMD or delay-based limiting in a separate experiment.",
    ]
    return "\n".join(lines) + "\n"


def self_test(bundle: dict[str, Any]) -> None:
    for topology in bundle["aggregate"].values():
        for load in topology.values():
            for row in load.values():
                assert row["max_node_queue"] <= QUEUE_CAPACITY
                assert row["overflow_attempts"] == 0
                assert 0.0 <= row["source_fairness"] <= 1.0000001
    assert len(bundle["aimd_parameter_robustness"]) == 9


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seeds", type=int, default=30)
    parser.add_argument("--horizon", type=int, default=4200)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    bundle = run_suite(args.seeds, args.horizon)
    self_test(bundle)
    args.out.mkdir(parents=True, exist_ok=True)
    text = summary(bundle)
    (args.out / "scheduler_metrics.json").write_text(json.dumps(bundle, indent=2), encoding="utf-8")
    (args.out / "scheduler_summary.md").write_text(text, encoding="utf-8")
    with (args.out / "scheduler_metrics.csv").open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["metric", "value"])
        writer.writerows(flatten(bundle))
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
