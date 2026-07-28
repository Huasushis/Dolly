#!/usr/bin/env python3
"""Dolly Linux Module child launcher, launcher control protocol version 1.

This is the fixed reviewed executable described by Architecture Decision
Record (ADR) 0009 "Module process control" and specified by
`docs/spec/extension-process-protocol.md` Section 4.1.1. Core starts this
program instead of starting Extension code directly, because ordinary child
creation cannot place a new process atomically into a different control group
(cgroup). The launcher joins the prepared Module cgroup itself, applies its
open-file limit, closes every other inherited descriptor, and waits for Core to
verify its kernel membership before it replaces itself with the installed
Extension runtime.

Why this program is Python and not Node.js
------------------------------------------
The specification requires that the launcher never fork and that it `exec` the
Extension runtime, so the process that speaks the control protocol must be the
same process that replaces its own image. It also requires the launcher to set
`RLIMIT_NOFILE` on itself. Node.js 20, the runtime this deployment installs,
exposes neither `execve` nor `setrlimit`; `process.execve` exists only from
Node.js 22.15. Any Node.js workaround (`child_process`, `/usr/bin/prlimit` as a
spawned helper) forks and leaves a second process outside the intended
topology, which is exactly what ADR 0009 forbids. The Python 3 standard library
provides `os.execve` and `resource.setrlimit` with no third-party dependency,
so the launcher is a single small Python file with no imports outside the
standard library.

Rules this file must keep:

  * every value acted on arrives in a Core-validated control frame; no path,
    limit, program, or environment value is read from environment variables or
    the command line;
  * no fork, no network input/output, no Extension configuration read, and no
    execution of anything before the `execute` command;
  * any malformed, oversized, unknown, or out-of-order frame, a closed control
    descriptor, or expiry of the fixed internal deadline exits immediately with
    a nonzero status; and
  * nothing is ever written to standard output, which carries the Extension
    protocol transport. Diagnostics go to standard error only.
"""

import errno
import fcntl
import json
import os
import resource
import select
import signal
import sys
import time

LAUNCHER_PROTOCOL_VERSION = 1

# Fixed descriptor number of the protected control descriptor. Descriptors 0
# and 1 carry the Extension protocol transport and 2 carries bounded diagnostic
# standard-error text.
CONTROL_DESCRIPTOR = 3
KEPT_DESCRIPTORS = frozenset((0, 1, 2, CONTROL_DESCRIPTOR))

MAX_FRAME_BYTES = 4096
CGROUP_V2_MOUNT_POINT = "/sys/fs/cgroup"
MIN_MAX_OPEN_FILES = 16
MAX_MAX_OPEN_FILES = 1048576
MAX_ARGUMENT_COUNT = 256
MAX_ENVIRONMENT_ENTRY_COUNT = 128

# Fixed internal deadline for the whole pre-execution phase, in seconds. It is
# a constant because the launcher accepts no input outside the control frames.
FIXED_DEADLINE_SECONDS = 10.0

# Nonzero exit statuses; kept identical to LAUNCHER_EXIT_STATUS in
# `launcher-control-protocol.ts`.
EXIT_FRAME_INVALID = 10
EXIT_CONTROL_CHANNEL_CLOSED = 11
EXIT_DEADLINE_EXPIRED = 12
EXIT_COMMANDED = 13
EXIT_CGROUP_JOIN_FAILED = 14
EXIT_PROCESS_LIMIT_FAILED = 15
EXIT_EXECUTE_FAILED = 16
EXIT_INVOCATION_INVALID = 17


def fail(status, reason):
    """Writes one bounded diagnostic line and exits without running cleanup."""
    try:
        os.write(2, ("dolly-module-launcher: " + reason + "\n").encode("utf-8", "replace")[:512])
    except OSError:
        pass
    # os._exit avoids interpreter shutdown work, which could flush a buffer
    # onto the Extension protocol transport.
    os._exit(status)


def on_deadline_signal(_signal_number, _frame):
    fail(EXIT_DEADLINE_EXPIRED, "fixed internal deadline expired")


def read_exactly(count, deadline):
    """Reads exactly `count` bytes from the control descriptor before `deadline`."""
    chunks = []
    remaining = count
    while remaining > 0:
        seconds_left = deadline - time.monotonic()
        if seconds_left <= 0:
            fail(EXIT_DEADLINE_EXPIRED, "fixed internal deadline expired while reading")
        try:
            readable, _, _ = select.select([CONTROL_DESCRIPTOR], [], [], seconds_left)
        except OSError as error:
            if error.errno == errno.EINTR:
                continue
            fail(EXIT_CONTROL_CHANNEL_CLOSED, "control descriptor failed")
        if not readable:
            fail(EXIT_DEADLINE_EXPIRED, "fixed internal deadline expired while waiting")
        try:
            chunk = os.read(CONTROL_DESCRIPTOR, remaining)
        except OSError as error:
            if error.errno == errno.EINTR:
                continue
            fail(EXIT_CONTROL_CHANNEL_CLOSED, "control descriptor failed")
        if not chunk:
            fail(EXIT_CONTROL_CHANNEL_CLOSED, "control descriptor closed")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def reject_duplicate_keys(pairs):
    seen = {}
    for key, value in pairs:
        if key in seen:
            raise ValueError("duplicate object key")
        seen[key] = value
    return seen


def read_frame(deadline):
    """Reads one length-prefixed UTF-8 JSON control frame."""
    header = read_exactly(4, deadline)
    length = int.from_bytes(header, "big")
    if length < 2 or length > MAX_FRAME_BYTES:
        fail(EXIT_FRAME_INVALID, "control frame length is zero or over limit")
    payload = read_exactly(length, deadline)
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        fail(EXIT_FRAME_INVALID, "control frame is not UTF-8")
    try:
        message = json.loads(text, object_pairs_hook=reject_duplicate_keys)
    except (ValueError, RecursionError):
        fail(EXIT_FRAME_INVALID, "control frame is not closed JSON")
    if not isinstance(message, dict):
        fail(EXIT_FRAME_INVALID, "control frame is not a JSON object")
    version = message.get("launcherProtocol")
    if not isinstance(version, int) or isinstance(version, bool) or version != LAUNCHER_PROTOCOL_VERSION:
        fail(EXIT_FRAME_INVALID, "control frame does not carry launcher protocol version 1")
    return message


def write_frame(message):
    payload = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(payload) > MAX_FRAME_BYTES:
        fail(EXIT_FRAME_INVALID, "outbound control frame exceeds its byte limit")
    frame = len(payload).to_bytes(4, "big") + payload
    written = 0
    while written < len(frame):
        try:
            written += os.write(CONTROL_DESCRIPTOR, frame[written:])
        except OSError as error:
            if error.errno == errno.EINTR:
                continue
            fail(EXIT_CONTROL_CHANNEL_CLOSED, "control descriptor failed while writing")


def require_closed_object(message, allowed_keys):
    if set(message.keys()) != set(allowed_keys):
        fail(EXIT_FRAME_INVALID, "control frame has unknown or missing fields")


def require_absolute_posix_path(value, label):
    if not isinstance(value, str) or not value or "\x00" in value:
        fail(EXIT_FRAME_INVALID, label + " is not a non-empty string")
    if not value.startswith("/"):
        fail(EXIT_FRAME_INVALID, label + " is not an absolute path")
    if len(value) > 1 and value.endswith("/"):
        fail(EXIT_FRAME_INVALID, label + " ends with a path separator")
    for segment in value[1:].split("/"):
        if segment in ("", ".", ".."):
            fail(EXIT_FRAME_INVALID, label + " contains an empty, . or .. segment")


def exit_if_commanded(message):
    """Honors the `exit` command, which Core may send in any pre-execution phase."""
    if message.get("command") == "exit":
        require_closed_object(message, ("launcherProtocol", "command"))
        fail(EXIT_COMMANDED, "Core commanded the launcher to exit")


def parse_configure(message):
    require_closed_object(message, ("launcherProtocol", "command", "moduleCgroupPath", "maxOpenFiles"))
    if message["command"] != "configure":
        fail(EXIT_FRAME_INVALID, "first control frame is not the configure command")
    module_cgroup_path = message["moduleCgroupPath"]
    require_absolute_posix_path(module_cgroup_path, "moduleCgroupPath")
    if not module_cgroup_path.startswith(CGROUP_V2_MOUNT_POINT + "/"):
        fail(EXIT_FRAME_INVALID, "moduleCgroupPath is not below the cgroup v2 mount point")
    max_open_files = message["maxOpenFiles"]
    if (
        not isinstance(max_open_files, int)
        or isinstance(max_open_files, bool)
        or max_open_files < MIN_MAX_OPEN_FILES
        or max_open_files > MAX_MAX_OPEN_FILES
    ):
        fail(EXIT_FRAME_INVALID, "maxOpenFiles is not an integer within its accepted range")
    return module_cgroup_path, max_open_files


def parse_execute(message):
    require_closed_object(
        message, ("launcherProtocol", "command", "program", "argumentVector", "environment")
    )
    program = message["program"]
    require_absolute_posix_path(program, "program")
    argument_vector = message["argumentVector"]
    if (
        not isinstance(argument_vector, list)
        or not argument_vector
        or len(argument_vector) > MAX_ARGUMENT_COUNT
    ):
        fail(EXIT_FRAME_INVALID, "argumentVector is not a bounded non-empty array")
    for argument in argument_vector:
        if not isinstance(argument, str) or "\x00" in argument:
            fail(EXIT_FRAME_INVALID, "argumentVector contains a non-string or NUL byte")
    environment = message["environment"]
    if not isinstance(environment, dict) or len(environment) > MAX_ENVIRONMENT_ENTRY_COUNT:
        fail(EXIT_FRAME_INVALID, "environment is not a bounded JSON object")
    for name, value in environment.items():
        if not isinstance(value, str) or "\x00" in value or "\x00" in name or "=" in name:
            fail(EXIT_FRAME_INVALID, "environment contains an invalid entry")
    return program, argument_vector, environment


def join_module_cgroup(module_cgroup_path):
    """Writes this process identifier into the prepared Module cgroup."""
    procs_path = module_cgroup_path + "/cgroup.procs"
    try:
        descriptor = os.open(procs_path, os.O_WRONLY)
    except OSError as error:
        fail(EXIT_CGROUP_JOIN_FAILED, "cannot open cgroup.procs: " + error.strerror)
    try:
        os.write(descriptor, str(os.getpid()).encode("ascii"))
    except OSError as error:
        fail(EXIT_CGROUP_JOIN_FAILED, "cannot write cgroup.procs: " + error.strerror)
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass


def apply_open_file_limit(max_open_files):
    try:
        resource.setrlimit(resource.RLIMIT_NOFILE, (max_open_files, max_open_files))
    except (OSError, ValueError) as error:
        fail(EXIT_PROCESS_LIMIT_FAILED, "cannot apply RLIMIT_NOFILE: " + str(error))


def close_other_inherited_descriptors():
    """Closes every inherited descriptor except the protocol transport and control descriptor."""
    try:
        open_descriptors = [int(name) for name in os.listdir("/proc/self/fd")]
    except (OSError, ValueError) as error:
        fail(EXIT_PROCESS_LIMIT_FAILED, "cannot list open descriptors: " + str(error))
    for descriptor in open_descriptors:
        if descriptor in KEPT_DESCRIPTORS:
            continue
        try:
            os.close(descriptor)
        except OSError:
            # The directory descriptor used by the listing above is already
            # closed, so a bad-descriptor error here is expected.
            pass


def main():
    # The launcher takes no command-line input at all; sys.argv[0] is its own
    # path. Anything else means it was invoked in an unexpected way.
    if len(sys.argv) != 1:
        fail(EXIT_INVOCATION_INVALID, "launcher accepts no command-line arguments")

    signal.signal(signal.SIGALRM, on_deadline_signal)
    signal.setitimer(signal.ITIMER_REAL, FIXED_DEADLINE_SECONDS)
    deadline = time.monotonic() + FIXED_DEADLINE_SECONDS

    configure_frame = read_frame(deadline)
    exit_if_commanded(configure_frame)
    module_cgroup_path, max_open_files = parse_configure(configure_frame)

    join_module_cgroup(module_cgroup_path)
    apply_open_file_limit(max_open_files)
    close_other_inherited_descriptors()

    write_frame({"launcherProtocol": LAUNCHER_PROTOCOL_VERSION, "event": "in-cgroup"})

    authorization_frame = read_frame(deadline)
    exit_if_commanded(authorization_frame)
    if authorization_frame.get("command") != "execute":
        fail(EXIT_FRAME_INVALID, "second control frame is not the execute or exit command")
    program, argument_vector, environment = parse_execute(authorization_frame)

    # The control descriptor must not survive exec, so the Extension retains no
    # Core management descriptor.
    try:
        flags = fcntl.fcntl(CONTROL_DESCRIPTOR, fcntl.F_GETFD)
        fcntl.fcntl(CONTROL_DESCRIPTOR, fcntl.F_SETFD, flags | fcntl.FD_CLOEXEC)
    except OSError as error:
        fail(EXIT_EXECUTE_FAILED, "cannot mark the control descriptor close-on-exec: " + str(error))

    # An interval timer survives exec while its handler is reset to the default
    # action, so a live timer would terminate the Extension later. Cancel it.
    signal.setitimer(signal.ITIMER_REAL, 0)

    try:
        os.execve(program, argument_vector, environment)
    except OSError as error:
        fail(EXIT_EXECUTE_FAILED, "exec failed: " + str(error))
    fail(EXIT_EXECUTE_FAILED, "exec returned unexpectedly")


main()
