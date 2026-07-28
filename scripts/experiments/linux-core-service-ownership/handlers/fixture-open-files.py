#!/usr/bin/env python3
"""Open-file-limit fixture for cases LM-04-open-files and SC-14-08.

Fixed local script, no command-line or environment input, finite deadline.

It never calls `setrlimit`. Every limit it reports was applied by the reviewed
child launcher before `execve`, which is the property Architecture Decision
Record 0009 requires: the limit must already hold when Extension code gets
control, not be applied afterwards by the code being limited.

It also reports which descriptors survived the `exec`, because the launcher
must close every inherited descriptor except the protocol transport, and must
mark its own control descriptor close-on-exec.
"""

import errno
import json
import os
import resource
import signal
import sys

DEADLINE_SECONDS = 20
# A bound so a host with no limit cannot make this fixture open descriptors
# without end.
MAX_OPEN_ATTEMPTS = 4096

signal.alarm(DEADLINE_SECONDS)


def proc_limit_line():
    with open("/proc/self/limits", "r", encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("Max open files"):
                fields = line.split()
                # "Max open files   <soft>  <hard>  files"
                return {"soft": fields[3], "hard": fields[4], "line": line.rstrip()}
    return None


def descriptor_status(number):
    try:
        os.fstat(number)
        return {"open": True, "errno": None}
    except OSError as error:
        return {"open": False, "errno": error.errno, "errno_name": errno.errorcode.get(error.errno)}


# The descriptor checks run first, before anything else in this process can
# occupy a descriptor number. `os.listdir` needs a descriptor of its own, which
# the kernel gives the lowest free number, so a listing taken first would show a
# descriptor this fixture opened rather than one that survived `exec`.
control_descriptor = descriptor_status(3)
extra_descriptor = descriptor_status(4)
soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
inherited = sorted(int(name) for name in os.listdir("/proc/self/fd") if name.isdigit())

opened = []
failure_errno = None
while len(opened) < MAX_OPEN_ATTEMPTS:
    try:
        opened.append(os.open("/dev/null", os.O_RDONLY))
    except OSError as error:
        failure_errno = error.errno
        break

highest = max(opened) if opened else None
for descriptor in opened:
    try:
        os.close(descriptor)
    except OSError:
        pass

report = {
    "getrlimit_nofile": [soft, hard],
    "proc_self_limits": proc_limit_line(),
    # This listing includes the descriptor `os.listdir` opened for itself.
    "descriptor_listing_including_its_own": inherited,
    "control_descriptor_3": control_descriptor,
    "extra_inherited_descriptor_4": extra_descriptor,
    "opened_count": len(opened),
    "highest_descriptor": highest,
    "failure_errno": failure_errno,
    "failure_errno_name": errno.errorcode.get(failure_errno) if failure_errno else None,
}
sys.stdout.write(json.dumps(report) + "\n")
sys.stdout.flush()
