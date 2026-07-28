#!/usr/bin/env python3
"""Memory-limit fixture for case LM-01-memory.

Fixed local script, no command-line or environment input, finite deadline. It
runs as the Module process inside one prepared Module control group and does
two things: it forks one innocent process that only sleeps, then allocates and
touches memory until the kernel stops it.

The innocent process exists so the case can tell a whole-group memory kill
(`memory.oom.group=1`, which Architecture Decision Record 0009 requires) from
an ordinary out-of-memory kill that ends only the allocating process.

The alarm is a safety net, not the mechanism under test: if the memory limit
were not enforced this fixture would otherwise keep allocating.
"""

import json
import os
import signal
import sys
import time

DEADLINE_SECONDS = 30
BLOCK_BYTES = 1024 * 1024
PAGE_BYTES = 4096

signal.alarm(DEADLINE_SECONDS)

bystander = os.fork()
if bystander == 0:
    # The bystander must not hold the report pipe open, so the driver still
    # sees end-of-file, and must not allocate anything of its own.
    try:
        os.close(1)
        os.close(2)
    except OSError:
        pass
    signal.alarm(DEADLINE_SECONDS)
    time.sleep(DEADLINE_SECONDS)
    os._exit(0)

sys.stdout.write(json.dumps({"bystander_pid": bystander, "allocating_pid": os.getpid()}) + "\n")
sys.stdout.flush()

blocks = []
while True:
    block = bytearray(BLOCK_BYTES)
    # Touching every page forces the pages to be charged to this control group;
    # an untouched allocation may never reach the limit.
    for offset in range(0, BLOCK_BYTES, PAGE_BYTES):
        block[offset] = 1
    blocks.append(block)
