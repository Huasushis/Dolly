#!/usr/bin/env python3
"""Processor-rate fixture for case LM-03-processor-rate.

Fixed local script, no command-line or environment input, finite deadline. It
busies one processor for a fixed wall-clock window and reports the window it
measured. The driver reads `cpu.stat` around that window, so the case can
assert real throttling rather than only that `cpu.max` accepted a value.

The mechanism probe recorded `cpu.max` as write and read-back only; this
fixture exists so the experiment can say whether the rate is enforced.
"""

import json
import signal
import sys
import time

DEADLINE_SECONDS = 30
BUSY_SECONDS = 3.0
MODULUS = 1_000_003

signal.alarm(DEADLINE_SECONDS)

sys.stdout.write(json.dumps({"phase": "starting", "busy_seconds": BUSY_SECONDS}) + "\n")
sys.stdout.flush()

started = time.monotonic()
value = 7
iterations = 0
while time.monotonic() - started < BUSY_SECONDS:
    for _ in range(10_000):
        value = (value * value + 1) % MODULUS
    iterations += 10_000
elapsed = time.monotonic() - started

sys.stdout.write(
    json.dumps({"phase": "finished", "elapsed_seconds": elapsed, "iterations": iterations}) + "\n"
)
sys.stdout.flush()
