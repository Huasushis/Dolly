#!/usr/bin/env python3
"""Claims cgroup membership without joining and ignores Core's exit command.

This fixture speaks enough of launcher control protocol version 1 to reach the
kernel membership check. It deliberately stays in the Core service control
group, reports `in-cgroup`, and then remains alive after receiving `exit`.
That leaves systemd, rather than a process-identifier signal, as the final
owner that can remove it when Core exits.
"""

import json
import os
import signal

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
    try:
        value = json.loads(read_exactly(length).decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        os._exit(10)
    if not isinstance(value, dict) or value.get("launcherProtocol") != 1:
        os._exit(10)
    return value


def write_frame(message):
    payload = json.dumps(message, separators=(",", ":")).encode("utf-8")
    os.write(CONTROL_DESCRIPTOR, len(payload).to_bytes(4, "big") + payload)


configure = read_frame()
if configure.get("command") != "configure":
    os._exit(10)

# Deliberately skipped: writing this process identifier to the supplied
# moduleCgroupPath/cgroup.procs file.
write_frame({"launcherProtocol": 1, "event": "in-cgroup"})

exit_command = read_frame()
if exit_command.get("command") != "exit":
    os._exit(10)

os.write(2, b"false-in-cgroup-unresponsive-launcher: ignoring protocol exit\n")
while True:
    signal.pause()
