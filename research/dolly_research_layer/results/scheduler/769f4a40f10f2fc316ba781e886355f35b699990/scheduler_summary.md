# Dolly graph scheduler experiment

- Version: `2026.08.26-graph-scheduler-v1`
- Matrix: `6` topologies × `3` loads × `13` policies × `30` seeds.
- Decision: internal AIMD default = **False**.
- Recommended internal baseline: **credit_or_watermark**.

## Policy aggregate

| Policy | Mean p95 | Mean throughput | No-progress cells | Unfinished cells | Queue CV |
|---|---:|---:|---:|---:|---:|
| `aimd:a=0.5:m=1.35` | 7768.15 | 140.39 | 5 | 8 | 0.303 |
| `aimd:a=0.5:m=1.8` | 7916.97 | 138.65 | 5 | 8 | 0.284 |
| `aimd:a=0.5:m=2.5` | 7972.82 | 138.00 | 5 | 8 | 0.277 |
| `aimd:a=1.0:m=1.35` | 7768.15 | 140.39 | 5 | 8 | 0.303 |
| `aimd:a=1.0:m=1.8` | 7916.97 | 138.65 | 5 | 8 | 0.284 |
| `aimd:a=1.0:m=2.5` | 7972.82 | 138.00 | 5 | 8 | 0.277 |
| `aimd:a=2.0:m=1.35` | 7768.15 | 140.39 | 5 | 8 | 0.303 |
| `aimd:a=2.0:m=1.8` | 7916.97 | 138.65 | 5 | 8 | 0.284 |
| `aimd:a=2.0:m=2.5` | 7972.82 | 138.00 | 5 | 8 | 0.277 |
| `credit` | 482.55 | 153.86 | 2 | 2 | 1.236 |
| `pi` | 1176.38 | 175.66 | 1 | 1 | 1.240 |
| `reactive` | 643.80 | 175.75 | 1 | 1 | 1.245 |
| `watermark` | 494.93 | 152.91 | 2 | 2 | 1.237 |

## AIMD parameter sensitivity

| Policy | ≥20% p95 wins at matched throughput | Safe cells |
|---|---:|---:|
| `aimd:a=0.5:m=1.35` | 0/18 | 8/18 |
| `aimd:a=0.5:m=1.8` | 0/18 | 8/18 |
| `aimd:a=0.5:m=2.5` | 0/18 | 8/18 |
| `aimd:a=1.0:m=1.35` | 0/18 | 8/18 |
| `aimd:a=1.0:m=1.8` | 0/18 | 8/18 |
| `aimd:a=1.0:m=2.5` | 0/18 | 8/18 |
| `aimd:a=2.0:m=1.35` | 0/18 | 8/18 |
| `aimd:a=2.0:m=1.8` | 0/18 | 8/18 |
| `aimd:a=2.0:m=2.5` | 0/18 | 8/18 |

The provider-facing concurrency problem is intentionally excluded: unlike internal Page queues, a remote provider's queue is not directly observable and may justify AIMD or delay-based limiting in a separate experiment.
