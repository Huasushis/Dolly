#!/usr/bin/env python3
"""Wall-clock-deadline fixture for case LM-07-elapsed-time.

Fixed local script, no command-line or environment input, finite safety net.

It forks one descendant and then busies a processor without ever ending. Both
processes ignore `SIGTERM`, so the case cannot be satisfied by a polite request
and must reach control-group termination, which is the point Architecture
Decision Record 0009 makes: a JavaScript timer alone is not a hard time limit,
and a direct-child exit is not proof after cgroup membership.

The alarm is a safety net for a driver that dies before it terminates the
group; the case itself always finishes long before it.
"""

import json
import os
import signal
import sys
import time

SAFETY_NET_SECONDS = 120
MODULUS = 1_000_003

signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGINT, signal.SIG_IGN)
signal.alarm(SAFETY_NET_SECONDS)

descendant = os.fork()
if descendant == 0:
    try:
        os.close(1)
        os.close(2)
    except OSError:
        pass
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.alarm(SAFETY_NET_SECONDS)
    while True:
        time.sleep(1)

sys.stdout.write(json.dumps({"descendant_pid": descendant, "module_pid": os.getpid()}) + "\n")
sys.stdout.flush()

value = 7
while True:
    value = (value * value + 1) % MODULUS
