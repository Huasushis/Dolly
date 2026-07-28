#!/usr/bin/env python3
"""Stand-in for an installed Extension runtime in the Linux launcher tests.

The child launcher replaces itself with this program, so what this program
observes about itself is evidence about the process the launcher produced: its
control group, its `RLIMIT_NOFILE`, and which descriptors it inherited. It
writes one JSON line to standard output, which is the Extension protocol
transport in a real launch, and then exits.
"""

import json
import os
import resource
import sys

# Probe the descriptor table before opening anything, so the reported set is
# exactly what survived exec.
open_descriptors = []
for descriptor in range(0, 64):
    try:
        os.fstat(descriptor)
    except OSError:
        continue
    open_descriptors.append(descriptor)

with open("/proc/self/cgroup", "r", encoding="utf-8") as handle:
    cgroup = handle.read().strip()


def nul_separated(path):
    with open(path, "rb") as handle:
        raw = handle.read()
    return [item.decode("utf-8") for item in raw.split(b"\x00") if item]


# The kernel reports the argument vector and environment that `execve`
# received. Python's own startup adds LC_CTYPE to `os.environ` under locale
# coercion, so these two files are the evidence that the launcher passed a
# closed argument vector and environment.
exec_argument_vector = nul_separated("/proc/self/cmdline")
exec_environment = {}
for entry in nul_separated("/proc/self/environ"):
    name, separator, value = entry.partition("=")
    if separator:
        exec_environment[name] = value

max_open_files_line = ""
with open("/proc/self/limits", "r", encoding="utf-8") as handle:
    for line in handle:
        if line.startswith("Max open files"):
            max_open_files_line = " ".join(line.split())

report = {
    "processId": os.getpid(),
    "execArgumentVector": exec_argument_vector,
    "execEnvironment": exec_environment,
    "interpreterArgumentVector": sys.argv,
    "environment": dict(os.environ),
    "cgroup": cgroup,
    "openDescriptors": open_descriptors,
    "maxOpenFiles": list(resource.getrlimit(resource.RLIMIT_NOFILE)),
    "maxOpenFilesLine": max_open_files_line,
}
sys.stdout.write(json.dumps(report) + "\n")
sys.stdout.flush()
