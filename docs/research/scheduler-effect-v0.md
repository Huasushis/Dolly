# Scheduler policy effect probe v0

## Result boundary

This run compares scheduling rules in a deterministic synthetic Page/Module model. It does not start Dolly's Module runtime and does not prove that the guarded product path is safe or supported.

The independent analyzer reconstructed 210 of 210 deterministic raw cases and 42 real-timer raw cases. Safety-invariant reconstruction failures: 0.

## Frozen hypotheses

| Hypothesis | Status | Supporting cases | Evaluated cases |
| --- | --- | ---: | ---: |
| H1 | heterogeneous-support | 11 | 15 |
| H2 | heterogeneous-support | 12/6 | 15/15 |
| H3 | heterogeneous-support | 13 | 15 |
| H4 | partial-factor-support | 9 | 24 |
| H5 | heterogeneous-support | 4 | 18 |
| H6 | supported | 64 | 84 |

H4 must be read by factor; combining the ablations would produce a false positive:

| Removed factor | Status | Supporting cases | Evaluated cases |
| --- | --- | ---: | ---: |
| queued bytes, service time, and arrivals during the run | supported | 9 | 12 |
| worst-downstream aggregation | not-supported | 0 | 12 |

A heterogeneous result is not a default-policy decision. The preregistered decision rule keeps the simpler reactive baseline unless an advantage clears the minimum meaningful difference in at least two relevant topology/load pairs without a safety failure or more than 10% throughput loss.

## Engineering implications

- Keep immediate event-driven activation as the simple reactive control. H1 cleared every frozen criterion in 11/15 stable cases, but failed the 10% latency threshold in all three fan-out repetitions, so this is a baseline rather than a universal winner.
- Carry downstream-pressure adaptive gating forward only as an overload-mode candidate. H3 cleared its frozen queue/recovery and throughput criteria in 13/15 shock cases, while several cases paid a substantial latency cost.
- Retain the combined byte, service-time, and arrivals-during-run signals only as a candidate bundle. The count-only ablation removed all three together, so this run cannot attribute the effect to byte pressure alone. Do not add mean-versus-maximum fan-out complexity on this evidence; that ablation was not distinguishable (0/12).
- Do not make explicit Module cadence feedback a default controller input yet. H5 cleared the requested cadence reduction in only 4/18 cases, and some line cases increased latency and peak queued bytes.
- Treat dependency-cycle and no-progress detection as a correctness feature, not a tuning detail. H6 exposed 64/84 cyclic or self-loop cases with deadlock or sustained no progress.

## Real Node.js timer smoke check

All 42 repetitions drained with zero serial violations, zero queued records, and no busy Module at stop. Recomputed from raw due/actual timestamps, the median case-level p95 absolute timer slip was 1.696332 ms; signed slip ranged from -2.614384 to 5.066919 ms. These timing results are reported separately and are not pooled with deterministic comparisons.

| Load | Policy | Repetition | Calls | Throughput/s | p95 latency ms | p95 absolute timer slip ms | Signed timer slip range ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| shock | adaptive-count-only | 1 | 105 | 68.75 | 29.875182 | 1.990542 | -1.990542 to 2.173429 |
| shock | adaptive-count-only | 2 | 102 | 65 | 31.801553 | 1.74932 | -1.818907 to 2.252699 |
| shock | adaptive-count-only | 3 | 101 | 66.25 | 34.51551 | 1.666006 | -2.167575 to 2.153142 |
| shock | adaptive-mean-fanout | 1 | 95 | 68.75 | 38.176513 | 1.572095 | -1.909828 to 2.167603 |
| shock | adaptive-mean-fanout | 2 | 96 | 65 | 36.234939 | 1.60316 | -2.279036 to 2.172843 |
| shock | adaptive-mean-fanout | 3 | 100 | 66.25 | 32.057074 | 1.755034 | -2.499703 to 2.184453 |
| shock | adaptive-no-module-feedback | 1 | 141 | 68.75 | 14.931503 | 1.14849 | -1.921638 to 2.326248 |
| shock | adaptive-no-module-feedback | 2 | 150 | 65 | 14.121515 | 1.696332 | -2.496876 to 4.124152 |
| shock | adaptive-no-module-feedback | 3 | 138 | 66.25 | 15.694099 | 1.230308 | -1.902202 to 2.179209 |
| shock | downstream-backlog-service-adaptive-period | 1 | 105 | 68.75 | 29.168657 | 1.700927 | -2.26729 to 2.173512 |
| shock | downstream-backlog-service-adaptive-period | 2 | 91 | 65 | 35.696149 | 1.527618 | -2.102491 to 2.138733 |
| shock | downstream-backlog-service-adaptive-period | 3 | 96 | 66.25 | 36.729966 | 1.728324 | -1.904096 to 2.152044 |
| shock | event-driven | 1 | 159 | 68.75 | 14.595621 | 2.128195 | -1.946836 to 2.219363 |
| shock | event-driven | 2 | 152 | 65 | 13.773438 | 1.764859 | -1.88631 to 2.154355 |
| shock | event-driven | 3 | 155 | 66.25 | 14.571829 | 2.139764 | -2.238217 to 2.222646 |
| shock | fixed-period | 1 | 123 | 68.75 | 59.081321 | 1.698979 | -1.981902 to 1.20386 |
| shock | fixed-period | 2 | 123 | 65 | 60.072407 | 1.420453 | -1.890732 to 1.442267 |
| shock | fixed-period | 3 | 123 | 66.25 | 60.507307 | 1.886824 | -2.35049 to 1.734424 |
| shock | queue-watermark | 1 | 40 | 68.75 | 114.119357 | 1.650805 | -2.505425 to 2.134641 |
| shock | queue-watermark | 2 | 41 | 65 | 113.774545 | 1.48266 | -1.930981 to 1.299875 |
| shock | queue-watermark | 3 | 38 | 66.25 | 113.906265 | 1.545934 | -2.053295 to 2.176676 |
| stable | adaptive-count-only | 1 | 90 | 52.5 | 33.676375 | 2.132514 | -2.201601 to 2.173246 |
| stable | adaptive-count-only | 2 | 92 | 52.5 | 33.60457 | 1.900725 | -2.313148 to 2.260722 |
| stable | adaptive-count-only | 3 | 89 | 51.25 | 32.197439 | 2.136391 | -2.569042 to 2.531927 |
| stable | adaptive-mean-fanout | 1 | 92 | 52.5 | 31.780399 | 1.838169 | -2.403323 to 2.184448 |
| stable | adaptive-mean-fanout | 2 | 92 | 52.5 | 30.890782 | 1.898353 | -2.394901 to 2.196444 |
| stable | adaptive-mean-fanout | 3 | 85 | 51.25 | 36.459165 | 1.813873 | -2.071182 to 2.175089 |
| stable | adaptive-no-module-feedback | 1 | 126 | 52.5 | 11.855415 | 2.133596 | -2.319585 to 2.170401 |
| stable | adaptive-no-module-feedback | 2 | 126 | 52.5 | 12.730779 | 2.129449 | -1.899791 to 2.39592 |
| stable | adaptive-no-module-feedback | 3 | 123 | 51.25 | 11.108052 | 1.601512 | -2.465732 to 2.153647 |
| stable | downstream-backlog-service-adaptive-period | 1 | 90 | 52.5 | 32.676395 | 1.472381 | -1.912478 to 1.942848 |
| stable | downstream-backlog-service-adaptive-period | 2 | 92 | 52.5 | 33.072194 | 1.1054 | -1.910359 to 1.860052 |
| stable | downstream-backlog-service-adaptive-period | 3 | 89 | 51.25 | 36.24307 | 2.216902 | -2.614384 to 2.146711 |
| stable | event-driven | 1 | 126 | 52.5 | 12.47965 | 1.131876 | -1.904691 to 3.424601 |
| stable | event-driven | 2 | 126 | 52.5 | 10.983435 | 1.119062 | -1.908069 to 1.913304 |
| stable | event-driven | 3 | 123 | 51.25 | 10.910301 | 1.103696 | -1.211149 to 1.378873 |
| stable | fixed-period | 1 | 123 | 52.5 | 53.196504 | 1.414443 | -1.904952 to 5.066919 |
| stable | fixed-period | 2 | 123 | 52.5 | 55.194196 | 1.321345 | -1.817363 to 2.085659 |
| stable | fixed-period | 3 | 123 | 51.25 | 60.025641 | 1.705379 | -1.930221 to 1.747801 |
| stable | queue-watermark | 1 | 34 | 52.5 | 113.867408 | 1.484651 | -1.812217 to 1.147527 |
| stable | queue-watermark | 2 | 39 | 52.5 | 114.110739 | 1.240314 | -1.693249 to 1.173417 |
| stable | queue-watermark | 3 | 36 | 51.25 | 114.237171 | 1.459687 | -1.90869 to 1.323508 |

## Deterministic per-case results

| Topology | Load | Policy | Seed | Calls | Throughput/s | p95 ms | Peak bytes | Recovery ms | Deadlock | No progress | External pending at stop |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |
| cycle | shock | adaptive-count-only | 104729 | 188 | 83.75 | 384.63326 | 237568 | 20 | false | true | 0 |
| cycle | shock | adaptive-count-only | 130363 | 188 | 83.125 | 399.191106 | 237568 | 20 | false | true | 0 |
| cycle | shock | adaptive-count-only | 155921 | 191 | 81.25 | 395.182343 | 237568 | 0 | false | true | 0 |
| cycle | shock | adaptive-mean-fanout | 104729 | 82 | 115 | 558.435666 | 134144 | 0 | false | true | 0 |
| cycle | shock | adaptive-mean-fanout | 130363 | 80 | 115 | 607.812434 | 164352 | 0 | false | true | 0 |
| cycle | shock | adaptive-mean-fanout | 155921 | 81 | 116.25 | 572.529158 | 142336 | 0 | false | true | 0 |
| cycle | shock | adaptive-no-module-feedback | 104729 | 82 | 115 | 558.435666 | 134144 | 0 | false | true | 0 |
| cycle | shock | adaptive-no-module-feedback | 130363 | 80 | 115 | 607.812434 | 164352 | 0 | false | true | 0 |
| cycle | shock | adaptive-no-module-feedback | 155921 | 81 | 116.25 | 572.529158 | 142336 | 0 | false | true | 0 |
| cycle | shock | downstream-backlog-service-adaptive-period | 104729 | 82 | 115 | 558.435666 | 134144 | 0 | false | true | 0 |
| cycle | shock | downstream-backlog-service-adaptive-period | 130363 | 80 | 115 | 607.812434 | 164352 | 0 | false | true | 0 |
| cycle | shock | downstream-backlog-service-adaptive-period | 155921 | 81 | 116.25 | 572.529158 | 142336 | 0 | false | true | 0 |
| cycle | shock | event-driven | 104729 | 193 | 85.625 | 390.179718 | 237568 | 20 | false | true | 0 |
| cycle | shock | event-driven | 130363 | 193 | 85 | 410.845347 | 237568 | 20 | false | true | 0 |
| cycle | shock | event-driven | 155921 | 192 | 83.125 | 413.138313 | 237568 | 10 | false | true | 0 |
| cycle | shock | fixed-period | 104729 | 258 | 115.625 | 593.489547 | 238592 | 330 | false | true | 0 |
| cycle | shock | fixed-period | 130363 | 256 | 121.25 | 485.895859 | 237824 | 0 | false | true | 0 |
| cycle | shock | fixed-period | 155921 | 257 | 113.75 | 592.637472 | 238592 | 530 | false | true | 0 |
| cycle | shock | queue-watermark | 104729 | 121 | 100.625 | 337.364009 | 172288 | 0 | false | true | 0 |
| cycle | shock | queue-watermark | 130363 | 110 | 100 | 335.712139 | 172544 | 0 | false | true | 0 |
| cycle | shock | queue-watermark | 155921 | 121 | 103.125 | 340.243978 | 172544 | 0 | false | true | 0 |
| cycle | stable | adaptive-count-only | 104729 | 209 | 97.5 | 325.827725 | 253952 | — | false | false | 0 |
| cycle | stable | adaptive-count-only | 130363 | 205 | 96.25 | 488.802254 | 262144 | — | false | true | 0 |
| cycle | stable | adaptive-count-only | 155921 | 203 | 97.5 | 523.739745 | 270336 | — | false | true | 0 |
| cycle | stable | adaptive-mean-fanout | 104729 | 83 | 83.75 | 366.869136 | 181504 | — | false | true | 0 |
| cycle | stable | adaptive-mean-fanout | 130363 | 82 | 104.375 | 533.6998 | 172288 | — | false | true | 0 |
| cycle | stable | adaptive-mean-fanout | 155921 | 82 | 102.5 | 539.161281 | 180224 | — | false | true | 0 |
| cycle | stable | adaptive-no-module-feedback | 104729 | 83 | 83.75 | 366.869136 | 181504 | — | false | true | 0 |
| cycle | stable | adaptive-no-module-feedback | 130363 | 82 | 104.375 | 533.6998 | 172288 | — | false | true | 0 |
| cycle | stable | adaptive-no-module-feedback | 155921 | 82 | 102.5 | 539.161281 | 180224 | — | false | true | 0 |
| cycle | stable | downstream-backlog-service-adaptive-period | 104729 | 83 | 83.75 | 366.869136 | 181504 | — | false | true | 0 |
| cycle | stable | downstream-backlog-service-adaptive-period | 130363 | 82 | 104.375 | 533.6998 | 172288 | — | false | true | 0 |
| cycle | stable | downstream-backlog-service-adaptive-period | 155921 | 82 | 102.5 | 539.161281 | 180224 | — | false | true | 0 |
| cycle | stable | event-driven | 104729 | 209 | 97.5 | 325.827725 | 253952 | — | false | false | 0 |
| cycle | stable | event-driven | 130363 | 205 | 96.25 | 488.802254 | 262144 | — | false | true | 0 |
| cycle | stable | event-driven | 155921 | 203 | 97.5 | 523.739745 | 270336 | — | false | true | 0 |
| cycle | stable | fixed-period | 104729 | 257 | 90 | 570.786212 | 238080 | — | false | true | 0 |
| cycle | stable | fixed-period | 130363 | 257 | 90 | 569.751713 | 238080 | — | false | true | 0 |
| cycle | stable | fixed-period | 155921 | 257 | 87.5 | 567.628645 | 238080 | — | false | true | 0 |
| cycle | stable | queue-watermark | 104729 | 114 | 93.75 | 347.164187 | 172544 | — | false | true | 0 |
| cycle | stable | queue-watermark | 130363 | 103 | 88.125 | 347.146951 | 172288 | — | false | true | 0 |
| cycle | stable | queue-watermark | 155921 | 104 | 95 | 347.590217 | 163840 | — | false | true | 0 |
| fan-in | shock | adaptive-count-only | 104729 | 205 | 208.75 | 149.578833 | 184064 | 50 | false | false | 0 |
| fan-in | shock | adaptive-count-only | 130363 | 205 | 209.375 | 148.322969 | 184320 | 80 | false | false | 0 |
| fan-in | shock | adaptive-count-only | 155921 | 201 | 210 | 149.406374 | 184064 | 50 | false | false | 0 |
| fan-in | shock | adaptive-mean-fanout | 104729 | 70 | 208.75 | 191.219556 | 106496 | 0 | false | false | 0 |
| fan-in | shock | adaptive-mean-fanout | 130363 | 70 | 209.375 | 193.465901 | 106496 | 0 | false | false | 0 |
| fan-in | shock | adaptive-mean-fanout | 155921 | 70 | 210 | 196.519967 | 106496 | 0 | false | false | 0 |
| fan-in | shock | adaptive-no-module-feedback | 104729 | 70 | 208.75 | 191.219556 | 106496 | 0 | false | false | 0 |
| fan-in | shock | adaptive-no-module-feedback | 130363 | 70 | 209.375 | 193.465901 | 106496 | 0 | false | false | 0 |
| fan-in | shock | adaptive-no-module-feedback | 155921 | 70 | 210 | 196.519967 | 106496 | 0 | false | false | 0 |
| fan-in | shock | downstream-backlog-service-adaptive-period | 104729 | 70 | 208.75 | 191.219556 | 106496 | 0 | false | false | 0 |
| fan-in | shock | downstream-backlog-service-adaptive-period | 130363 | 70 | 209.375 | 193.465901 | 106496 | 0 | false | false | 0 |
| fan-in | shock | downstream-backlog-service-adaptive-period | 155921 | 70 | 210 | 196.519967 | 106496 | 0 | false | false | 0 |
| fan-in | shock | event-driven | 104729 | 206 | 208.75 | 147.40215 | 184320 | 70 | false | false | 0 |
| fan-in | shock | event-driven | 130363 | 205 | 209.375 | 147.989636 | 184064 | 80 | false | false | 0 |
| fan-in | shock | event-driven | 155921 | 201 | 210 | 149.073041 | 184064 | 50 | false | false | 0 |
| fan-in | shock | fixed-period | 104729 | 242 | 208.75 | 171.253054 | 174080 | 570 | false | true | 0 |
| fan-in | shock | fixed-period | 130363 | 242 | 209.375 | 171.153074 | 174336 | 610 | false | true | 0 |
| fan-in | shock | fixed-period | 155921 | 243 | 210 | 169.794878 | 174080 | 610 | false | true | 0 |
| fan-in | shock | queue-watermark | 104729 | 155 | 208.75 | 110.87566 | 164608 | 0 | false | false | 0 |
| fan-in | shock | queue-watermark | 130363 | 151 | 209.375 | 99.211534 | 164352 | 0 | false | false | 0 |
| fan-in | shock | queue-watermark | 155921 | 150 | 210 | 100.065136 | 164608 | 0 | false | false | 0 |
| fan-in | stable | adaptive-count-only | 104729 | 216 | 187.5 | 148.977938 | 181248 | — | false | false | 0 |
| fan-in | stable | adaptive-count-only | 130363 | 217 | 188.75 | 151.637017 | 181248 | — | false | false | 0 |
| fan-in | stable | adaptive-count-only | 155921 | 216 | 186.25 | 150.384946 | 180992 | — | false | false | 0 |
| fan-in | stable | adaptive-mean-fanout | 104729 | 74 | 187.5 | 188.005757 | 114944 | — | false | false | 0 |
| fan-in | stable | adaptive-mean-fanout | 130363 | 74 | 188.75 | 193.551159 | 107520 | — | false | false | 0 |
| fan-in | stable | adaptive-mean-fanout | 155921 | 74 | 186.25 | 198.058604 | 107520 | — | false | false | 0 |
| fan-in | stable | adaptive-no-module-feedback | 104729 | 74 | 187.5 | 143.257596 | 114944 | — | false | false | 0 |
| fan-in | stable | adaptive-no-module-feedback | 130363 | 74 | 188.75 | 136.217826 | 107264 | — | false | false | 0 |
| fan-in | stable | adaptive-no-module-feedback | 155921 | 74 | 186.25 | 140.725271 | 107264 | — | false | false | 0 |
| fan-in | stable | downstream-backlog-service-adaptive-period | 104729 | 74 | 187.5 | 188.005757 | 114944 | — | false | false | 0 |
| fan-in | stable | downstream-backlog-service-adaptive-period | 130363 | 74 | 188.75 | 193.551159 | 107520 | — | false | false | 0 |
| fan-in | stable | downstream-backlog-service-adaptive-period | 155921 | 74 | 186.25 | 198.058604 | 107520 | — | false | false | 0 |
| fan-in | stable | event-driven | 104729 | 217 | 187.5 | 148.396825 | 181248 | — | false | false | 0 |
| fan-in | stable | event-driven | 130363 | 217 | 188.75 | 150.530172 | 180992 | — | false | false | 0 |
| fan-in | stable | event-driven | 155921 | 216 | 186.25 | 150.051613 | 180992 | — | false | false | 0 |
| fan-in | stable | fixed-period | 104729 | 240 | 187.5 | 169.340663 | 173056 | — | false | true | 0 |
| fan-in | stable | fixed-period | 130363 | 240 | 188.75 | 170.0007 | 173056 | — | false | true | 0 |
| fan-in | stable | fixed-period | 155921 | 240 | 186.25 | 170.796873 | 173056 | — | false | true | 0 |
| fan-in | stable | queue-watermark | 104729 | 127 | 187.5 | 109.008872 | 106752 | — | false | false | 0 |
| fan-in | stable | queue-watermark | 130363 | 126 | 188.75 | 105.465704 | 106496 | — | false | false | 0 |
| fan-in | stable | queue-watermark | 155921 | 123 | 186.25 | 100.427083 | 98304 | — | false | false | 0 |
| fan-out | shock | adaptive-count-only | 104729 | 204 | 138.75 | 209.396113 | 237568 | 550 | false | false | 0 |
| fan-out | shock | adaptive-count-only | 130363 | 208 | 140 | 209.309587 | 237568 | 590 | false | false | 0 |
| fan-out | shock | adaptive-count-only | 155921 | 204 | 138.75 | 209.310771 | 237568 | 550 | false | false | 0 |
| fan-out | shock | adaptive-mean-fanout | 104729 | 85 | 138.75 | 219.33348 | 196608 | 0 | false | false | 0 |
| fan-out | shock | adaptive-mean-fanout | 130363 | 97 | 140 | 179.739379 | 196608 | 0 | false | false | 0 |
| fan-out | shock | adaptive-mean-fanout | 155921 | 92 | 138.75 | 222.652934 | 196608 | 0 | false | false | 0 |
| fan-out | shock | adaptive-no-module-feedback | 104729 | 85 | 138.75 | 219.33348 | 196608 | 0 | false | false | 0 |
| fan-out | shock | adaptive-no-module-feedback | 130363 | 97 | 140 | 179.739379 | 196608 | 0 | false | false | 0 |
| fan-out | shock | adaptive-no-module-feedback | 155921 | 95 | 138.75 | 207.399762 | 196608 | 0 | false | false | 0 |
| fan-out | shock | downstream-backlog-service-adaptive-period | 104729 | 85 | 138.75 | 219.33348 | 196608 | 0 | false | false | 0 |
| fan-out | shock | downstream-backlog-service-adaptive-period | 130363 | 97 | 140 | 179.739379 | 196608 | 0 | false | false | 0 |
| fan-out | shock | downstream-backlog-service-adaptive-period | 155921 | 95 | 138.75 | 207.399762 | 196608 | 0 | false | false | 0 |
| fan-out | shock | event-driven | 104729 | 204 | 138.75 | 209.396113 | 237568 | 550 | false | false | 0 |
| fan-out | shock | event-driven | 130363 | 208 | 140 | 209.309587 | 237568 | 590 | false | false | 0 |
| fan-out | shock | event-driven | 155921 | 204 | 138.75 | 209.310771 | 237568 | 550 | false | false | 0 |
| fan-out | shock | fixed-period | 104729 | 245 | 138.75 | 221.73775 | 205824 | 610 | false | true | 0 |
| fan-out | shock | fixed-period | 130363 | 246 | 140 | 222.837119 | 205824 | 610 | false | true | 0 |
| fan-out | shock | fixed-period | 155921 | 246 | 138.75 | 222.707266 | 205824 | 610 | false | true | 0 |
| fan-out | shock | queue-watermark | 104729 | 128 | 138.75 | 116.09375 | 139520 | 0 | false | false | 0 |
| fan-out | shock | queue-watermark | 130363 | 124 | 140 | 116.635188 | 139520 | 0 | false | false | 0 |
| fan-out | shock | queue-watermark | 155921 | 125 | 138.75 | 116.0625 | 139520 | 0 | false | false | 0 |
| fan-out | stable | adaptive-count-only | 104729 | 196 | 125 | 206.892503 | 204800 | — | false | false | 0 |
| fan-out | stable | adaptive-count-only | 130363 | 194 | 126.25 | 205.737863 | 204800 | — | false | false | 0 |
| fan-out | stable | adaptive-count-only | 155921 | 192 | 123.75 | 210.056584 | 212992 | — | false | false | 0 |
| fan-out | stable | adaptive-mean-fanout | 104729 | 86 | 125 | 158.346325 | 196608 | — | false | false | 0 |
| fan-out | stable | adaptive-mean-fanout | 130363 | 86 | 126.25 | 141.769409 | 197120 | — | false | false | 0 |
| fan-out | stable | adaptive-mean-fanout | 155921 | 86 | 123.75 | 167.203616 | 196608 | — | false | false | 0 |
| fan-out | stable | adaptive-no-module-feedback | 104729 | 86 | 125 | 158.431691 | 196608 | — | false | false | 0 |
| fan-out | stable | adaptive-no-module-feedback | 130363 | 87 | 126.25 | 153.344278 | 196608 | — | false | false | 0 |
| fan-out | stable | adaptive-no-module-feedback | 155921 | 80 | 123.75 | 169.950676 | 204800 | — | false | false | 0 |
| fan-out | stable | downstream-backlog-service-adaptive-period | 104729 | 82 | 125 | 167.574916 | 196608 | — | false | false | 0 |
| fan-out | stable | downstream-backlog-service-adaptive-period | 130363 | 87 | 126.25 | 153.344278 | 196608 | — | false | false | 0 |
| fan-out | stable | downstream-backlog-service-adaptive-period | 155921 | 82 | 123.75 | 160.749145 | 196608 | — | false | false | 0 |
| fan-out | stable | event-driven | 104729 | 196 | 125 | 206.892503 | 204800 | — | false | false | 0 |
| fan-out | stable | event-driven | 130363 | 194 | 126.25 | 205.737863 | 204800 | — | false | false | 0 |
| fan-out | stable | event-driven | 155921 | 192 | 123.75 | 210.056584 | 212992 | — | false | false | 0 |
| fan-out | stable | fixed-period | 104729 | 245 | 125 | 222.232569 | 205312 | — | false | true | 0 |
| fan-out | stable | fixed-period | 130363 | 245 | 126.25 | 222.838546 | 205312 | — | false | true | 0 |
| fan-out | stable | fixed-period | 155921 | 245 | 123.75 | 225.362787 | 205312 | — | false | true | 0 |
| fan-out | stable | queue-watermark | 104729 | 118 | 125 | 125.98726 | 139520 | — | false | false | 0 |
| fan-out | stable | queue-watermark | 130363 | 114 | 126.25 | 120.012185 | 139520 | — | false | false | 0 |
| fan-out | stable | queue-watermark | 155921 | 111 | 123.75 | 122.196798 | 139520 | — | false | false | 0 |
| line | shock | adaptive-count-only | 104729 | 225 | 69.375 | 55.090437 | 57344 | 0 | false | false | 0 |
| line | shock | adaptive-count-only | 130363 | 226 | 70 | 54.875721 | 65536 | 0 | false | false | 0 |
| line | shock | adaptive-count-only | 155921 | 227 | 69.375 | 54.880878 | 57344 | 0 | false | false | 0 |
| line | shock | adaptive-mean-fanout | 104729 | 146 | 69.375 | 45.782504 | 32768 | 0 | false | false | 0 |
| line | shock | adaptive-mean-fanout | 130363 | 119 | 70 | 60.194477 | 32768 | 0 | false | false | 0 |
| line | shock | adaptive-mean-fanout | 155921 | 97 | 69.375 | 107.764365 | 25088 | 0 | false | false | 0 |
| line | shock | adaptive-no-module-feedback | 104729 | 150 | 69.375 | 45.782504 | 25088 | 0 | false | false | 0 |
| line | shock | adaptive-no-module-feedback | 130363 | 187 | 70 | 35.541737 | 32768 | 0 | false | false | 0 |
| line | shock | adaptive-no-module-feedback | 155921 | 186 | 69.375 | 35.974628 | 24832 | 0 | false | false | 0 |
| line | shock | downstream-backlog-service-adaptive-period | 104729 | 146 | 69.375 | 45.782504 | 32768 | 0 | false | false | 0 |
| line | shock | downstream-backlog-service-adaptive-period | 130363 | 119 | 70 | 60.194477 | 32768 | 0 | false | false | 0 |
| line | shock | downstream-backlog-service-adaptive-period | 155921 | 97 | 69.375 | 107.764365 | 25088 | 0 | false | false | 0 |
| line | shock | event-driven | 104729 | 233 | 69.375 | 48.643013 | 57344 | 0 | false | false | 0 |
| line | shock | event-driven | 130363 | 236 | 70 | 54.779476 | 65536 | 0 | false | false | 0 |
| line | shock | event-driven | 155921 | 233 | 69.375 | 53.647809 | 57344 | 0 | false | false | 0 |
| line | shock | fixed-period | 104729 | 243 | 69.375 | 65.864668 | 25600 | 0 | false | true | 0 |
| line | shock | fixed-period | 130363 | 243 | 70 | 65.702009 | 25856 | 0 | false | true | 0 |
| line | shock | fixed-period | 155921 | 243 | 69.375 | 65.701589 | 25856 | 0 | false | true | 0 |
| line | shock | queue-watermark | 104729 | 98 | 69.375 | 122.0625 | 33536 | 0 | false | false | 0 |
| line | shock | queue-watermark | 130363 | 95 | 70 | 122.0625 | 33536 | 0 | false | false | 0 |
| line | shock | queue-watermark | 155921 | 96 | 69.375 | 122.0625 | 33536 | 0 | false | false | 0 |
| line | stable | adaptive-count-only | 104729 | 220 | 62.5 | 40.791726 | 32768 | — | false | false | 0 |
| line | stable | adaptive-count-only | 130363 | 219 | 63.125 | 40.692465 | 32768 | — | false | false | 0 |
| line | stable | adaptive-count-only | 155921 | 219 | 61.875 | 43.490896 | 32768 | — | false | false | 0 |
| line | stable | adaptive-mean-fanout | 104729 | 69 | 62.5 | 80.868372 | 24832 | — | false | false | 0 |
| line | stable | adaptive-mean-fanout | 130363 | 130 | 63.125 | 46.190664 | 24576 | — | false | false | 0 |
| line | stable | adaptive-mean-fanout | 155921 | 69 | 61.875 | 82.800481 | 24576 | — | false | false | 0 |
| line | stable | adaptive-no-module-feedback | 104729 | 300 | 62.5 | 17.03125 | 16384 | — | false | false | 0 |
| line | stable | adaptive-no-module-feedback | 130363 | 303 | 63.125 | 17.03125 | 16384 | — | false | false | 0 |
| line | stable | adaptive-no-module-feedback | 155921 | 297 | 61.875 | 17.03125 | 16384 | — | false | false | 0 |
| line | stable | downstream-backlog-service-adaptive-period | 104729 | 69 | 62.5 | 80.868372 | 24832 | — | false | false | 0 |
| line | stable | downstream-backlog-service-adaptive-period | 130363 | 130 | 63.125 | 46.190664 | 24576 | — | false | false | 0 |
| line | stable | downstream-backlog-service-adaptive-period | 155921 | 69 | 61.875 | 82.800481 | 24576 | — | false | false | 0 |
| line | stable | event-driven | 104729 | 300 | 62.5 | 17.03125 | 16384 | — | false | false | 0 |
| line | stable | event-driven | 130363 | 303 | 63.125 | 17.03125 | 16384 | — | false | false | 0 |
| line | stable | event-driven | 155921 | 297 | 61.875 | 17.03125 | 16384 | — | false | false | 0 |
| line | stable | fixed-period | 104729 | 243 | 62.5 | 66.217509 | 25088 | — | false | true | 0 |
| line | stable | fixed-period | 130363 | 243 | 63.125 | 66.198748 | 25088 | — | false | true | 0 |
| line | stable | fixed-period | 155921 | 243 | 61.875 | 65.257038 | 25088 | — | false | true | 0 |
| line | stable | queue-watermark | 104729 | 89 | 62.5 | 122.09375 | 32768 | — | false | false | 0 |
| line | stable | queue-watermark | 130363 | 86 | 63.125 | 122.09375 | 32768 | — | false | false | 0 |
| line | stable | queue-watermark | 155921 | 84 | 61.875 | 122.09375 | 25344 | — | false | false | 0 |
| self-loop | shock | adaptive-count-only | 104729 | 14 | 0.625 | 52.364583 | 147456 | — | true | true | 88 |
| self-loop | shock | adaptive-count-only | 130363 | 20 | 1.875 | 142.364583 | 196608 | — | true | true | 85 |
| self-loop | shock | adaptive-count-only | 155921 | 14 | 0.625 | 52.364583 | 147456 | — | true | true | 88 |
| self-loop | shock | adaptive-mean-fanout | 104729 | 52 | 168.75 | 563.873707 | 164608 | 0 | false | false | 0 |
| self-loop | shock | adaptive-mean-fanout | 130363 | 52 | 173.75 | 548.47228 | 164352 | 0 | false | false | 0 |
| self-loop | shock | adaptive-mean-fanout | 155921 | 52 | 162.5 | 543.105658 | 164608 | 0 | false | false | 0 |
| self-loop | shock | adaptive-no-module-feedback | 104729 | 52 | 168.75 | 563.873707 | 164608 | 0 | false | false | 0 |
| self-loop | shock | adaptive-no-module-feedback | 130363 | 52 | 173.75 | 548.47228 | 164352 | 0 | false | false | 0 |
| self-loop | shock | adaptive-no-module-feedback | 155921 | 52 | 162.5 | 543.105658 | 164608 | 0 | false | false | 0 |
| self-loop | shock | downstream-backlog-service-adaptive-period | 104729 | 52 | 168.75 | 563.873707 | 164608 | 0 | false | false | 0 |
| self-loop | shock | downstream-backlog-service-adaptive-period | 130363 | 52 | 173.75 | 548.47228 | 164352 | 0 | false | false | 0 |
| self-loop | shock | downstream-backlog-service-adaptive-period | 155921 | 52 | 162.5 | 543.105658 | 164608 | 0 | false | false | 0 |
| self-loop | shock | event-driven | 104729 | 14 | 0.625 | 52.364583 | 147456 | — | true | true | 88 |
| self-loop | shock | event-driven | 130363 | 20 | 1.875 | 142.364583 | 196608 | — | true | true | 85 |
| self-loop | shock | event-driven | 155921 | 14 | 0.625 | 52.364583 | 147456 | — | true | true | 88 |
| self-loop | shock | fixed-period | 104729 | 95 | 0.625 | 85.333333 | 164096 | — | true | true | 87 |
| self-loop | shock | fixed-period | 130363 | 95 | 0.625 | 85.333333 | 147712 | — | true | true | 88 |
| self-loop | shock | fixed-period | 155921 | 101 | 2.5 | 205.333333 | 196864 | — | true | true | 78 |
| self-loop | shock | queue-watermark | 104729 | 23 | 8.75 | 318.395833 | 180480 | — | true | true | 48 |
| self-loop | shock | queue-watermark | 130363 | 23 | 9.375 | 318.395833 | 180480 | — | true | true | 49 |
| self-loop | shock | queue-watermark | 155921 | 22 | 9.375 | 318.395833 | 164352 | — | true | true | 52 |
| self-loop | stable | adaptive-count-only | 104729 | 15 | 0.625 | 52.364583 | 163840 | — | true | true | 76 |
| self-loop | stable | adaptive-count-only | 130363 | 14 | 0.625 | 52.364583 | 147456 | — | true | true | 78 |
| self-loop | stable | adaptive-count-only | 155921 | 15 | 0.625 | 52.364583 | 163840 | — | true | true | 75 |
| self-loop | stable | adaptive-mean-fanout | 104729 | 53 | 160.625 | 541.168735 | 180480 | — | false | false | 0 |
| self-loop | stable | adaptive-mean-fanout | 130363 | 53 | 156.25 | 535.781881 | 181760 | — | false | false | 0 |
| self-loop | stable | adaptive-mean-fanout | 155921 | 53 | 163.75 | 538.118392 | 180224 | — | false | false | 0 |
| self-loop | stable | adaptive-no-module-feedback | 104729 | 53 | 160.625 | 541.168735 | 180480 | — | false | false | 0 |
| self-loop | stable | adaptive-no-module-feedback | 130363 | 53 | 156.25 | 535.781881 | 181760 | — | false | false | 0 |
| self-loop | stable | adaptive-no-module-feedback | 155921 | 53 | 163.75 | 538.118392 | 180224 | — | false | false | 0 |
| self-loop | stable | downstream-backlog-service-adaptive-period | 104729 | 53 | 160.625 | 541.168735 | 180480 | — | false | false | 0 |
| self-loop | stable | downstream-backlog-service-adaptive-period | 130363 | 53 | 156.25 | 535.781881 | 181760 | — | false | false | 0 |
| self-loop | stable | downstream-backlog-service-adaptive-period | 155921 | 53 | 163.75 | 538.118392 | 180224 | — | false | false | 0 |
| self-loop | stable | event-driven | 104729 | 15 | 0.625 | 52.364583 | 163840 | — | true | true | 76 |
| self-loop | stable | event-driven | 130363 | 14 | 0.625 | 52.364583 | 147456 | — | true | true | 78 |
| self-loop | stable | event-driven | 155921 | 15 | 0.625 | 52.364583 | 163840 | — | true | true | 75 |
| self-loop | stable | fixed-period | 104729 | 95 | 0.625 | 85.333333 | 164352 | — | true | true | 68 |
| self-loop | stable | fixed-period | 130363 | 95 | 0.625 | 85.333333 | 164096 | — | true | true | 70 |
| self-loop | stable | fixed-period | 155921 | 95 | 0.625 | 85.333333 | 164352 | — | true | true | 69 |
| self-loop | stable | queue-watermark | 104729 | 62 | 143.75 | 553.422154 | 180992 | — | false | true | 0 |
| self-loop | stable | queue-watermark | 130363 | 61 | 142.5 | 549.648288 | 180736 | — | false | true | 0 |
| self-loop | stable | queue-watermark | 155921 | 61 | 135 | 544.206403 | 180736 | — | false | true | 0 |

## Reproducibility and checks

- Preregistration SHA-256: `28bd28a34b980a960792bd4cb98215db20600995d4ad8e24435c171a53091677`.
- Node.js: `v20.20.2`; platform: `linux/x64`.
- Each raw JSONL file contains one case, stable event sequence numbers, and a terminal metric record.
- For deterministic cases, the analyzer independently reconstructed calls, weighted latency, throughput, queue peaks, fairness, recovery, producer ownership, feedback counts, and the serial/output/broadcast/duplicate safety checks.
- For real-timer cases, it independently reconstructed input planning and admission, calls, throughput, weighted latency, queue drainage, serial execution, and timer-slip distributions.
- Raw file hashes and implementation hashes are in `artifacts/experiments/probes/scheduler-effect-v0/manifest.json`.

