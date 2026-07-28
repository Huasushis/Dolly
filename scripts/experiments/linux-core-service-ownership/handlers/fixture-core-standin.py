#!/usr/bin/env python3
"""A stand-in for the Core process, used by the sandbox-escape cases.

The escape cases ask whether an Extension process can signal Core, read Core's
process state, or open Core state files. Answering that needs a Core-like
process to aim at. This script is that target: it runs in the Core subgroup of
the same delegated service root, carries a fixed sentinel in its command line
so the hostile fixture can find it the way real hostile code would, carries one
sentinel environment value so a successful `/proc/<pid>/environ` read is
provable rather than merely plausible, and holds the Core state probe file open
so a descriptor-based discovery attempt has something to find.

It is started by the case driver, never by the fixture, and it does nothing but
wait. Its sentinel value is what makes the fixture's targeting safe: the
fixture signals only a process whose command line carries that exact string.
"""

import os
import signal
import sys
import time

SAFETY_NET_SECONDS = 120

signal.alarm(SAFETY_NET_SECONDS)

state_path = sys.argv[2] if len(sys.argv) > 2 else None
held = None
if state_path:
    try:
        held = os.open(state_path, os.O_RDONLY)
    except OSError:
        held = None

sys.stderr.write("core-standin ready pid=%d held_fd=%s\n" % (os.getpid(), held))
sys.stderr.flush()

while True:
    time.sleep(1)
