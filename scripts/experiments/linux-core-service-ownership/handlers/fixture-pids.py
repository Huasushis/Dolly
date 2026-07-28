#!/usr/bin/env python3
"""Process-count-limit fixture for case LM-02-process-count.

Fixed local script, no command-line or environment input, finite deadline. It
forks until the kernel refuses, then reports the exact refusal errno together
with the `pids.current` and `pids.max` values it read from its own control
group at that moment. Reporting the refusal itself rather than "something
failed" is what lets the case assert an exact observation.

Every child closes the report pipe and sleeps, so the children hold process
slots without holding the pipe open.
"""

import json
import os
import signal
import sys
import time

DEADLINE_SECONDS = 30
CHILD_SLEEP_SECONDS = 25
# A bound so a host without `pids.max` cannot make this fixture fork forever.
MAX_ATTEMPTS = 256

signal.alarm(DEADLINE_SECONDS)


def own_cgroup_path():
    with open("/proc/self/cgroup", "r", encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("0::"):
                return "/sys/fs/cgroup" + line[3:].strip()
    raise RuntimeError("no cgroup version 2 line in /proc/self/cgroup")


def read_control_file(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError as error:
        return "unreadable:%d" % error.errno


own = own_cgroup_path()
forks_succeeded = 0
failure_errno = None
failure_class = None

while forks_succeeded < MAX_ATTEMPTS:
    try:
        child = os.fork()
    except OSError as error:
        failure_errno = error.errno
        failure_class = type(error).__name__
        break
    if child == 0:
        try:
            os.close(1)
            os.close(2)
        except OSError:
            pass
        signal.alarm(DEADLINE_SECONDS)
        time.sleep(CHILD_SLEEP_SECONDS)
        os._exit(0)
    forks_succeeded += 1

report = {
    "own_cgroup": own,
    "forks_succeeded": forks_succeeded,
    "failure_errno": failure_errno,
    "failure_class": failure_class,
    "pids_current_at_failure": read_control_file(own + "/pids.current"),
    "pids_max": read_control_file(own + "/pids.max"),
    "pids_events": read_control_file(own + "/pids.events"),
}
sys.stdout.write(json.dumps(report) + "\n")
sys.stdout.flush()
# The children keep the group populated; the driver proves whole-group
# termination from here.
time.sleep(CHILD_SLEEP_SECONDS)
