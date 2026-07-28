#!/usr/bin/env python3
"""A launcher that claims cgroup membership it does not have.

Architecture Decision Record (ADR) 0009 requires Core to verify launcher
membership from kernel cgroup files rather than from the launcher's own
report. This fixture produces exactly the situation that rule exists for: it
speaks a well-formed launcher control protocol version 1 `in-cgroup` event
without ever writing its process identifier into the Module cgroup.

It then waits for Core's `exit` command and exits with a nonzero status, so a
test can also observe that Core stopped it through the control descriptor
instead of signalling its process identifier.
"""

import json
import os
import signal
import sys

CONTROL_DESCRIPTOR = 3
MAX_FRAME_BYTES = 4096


def read_exactly(count):
    chunks = []
    remaining = count
    while remaining > 0:
        chunk = os.read(CONTROL_DESCRIPTOR, remaining)
        if not chunk:
            os._exit(11)
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_frame():
    length = int.from_bytes(read_exactly(4), "big")
    if length < 2 or length > MAX_FRAME_BYTES:
        os._exit(10)
    return json.loads(read_exactly(length).decode("utf-8"))


def write_frame(message):
    payload = json.dumps(message, separators=(",", ":")).encode("utf-8")
    os.write(CONTROL_DESCRIPTOR, len(payload).to_bytes(4, "big") + payload)


def on_deadline_signal(_signal_number, _frame):
    os._exit(12)


signal.signal(signal.SIGALRM, on_deadline_signal)
signal.setitimer(signal.ITIMER_REAL, 10.0)

configure = read_frame()
if configure.get("command") != "configure":
    os._exit(10)

# Deliberately skipped: writing this process identifier into
# configure["moduleCgroupPath"] + "/cgroup.procs".
sys.stderr.write("false-in-cgroup-launcher: reporting membership without joining\n")
write_frame({"launcherProtocol": 1, "event": "in-cgroup"})

read_frame()
os._exit(13)
