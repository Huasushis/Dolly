#!/usr/bin/env python3
"""Extension fixture for the fixed interruption matrix.

This is the program the reviewed child launcher replaces itself with, so it
runs inside the Module control group, under the control group's limits, with
exactly the environment Core declared and no descriptor Core did not intend it
to keep. It speaks the same length-prefixed JSON framing that
`src/core/framed-json-channel.ts` implements, on the descriptors the launcher
leaves in place: descriptor 0 for input and descriptor 1 for output.

It is a fixture, not the shipped Extension runtime. Protocol version 3 requires
child commands to be "fixed local fixtures with finite deadlines", and what the
matrix measures is Core's durability across an interruption, not the Extension.
What the fixture must be faithful about is the shape of the traffic Core has to
survive being interrupted in the middle of: a readiness report, capability
requests that Core must answer while the Run is open, descendants, processor
work, and one result.

Seven workloads, matching the protocol's list:

  no-output                  a Run that commits nothing
  single-output              one output Block on one Page
  multiple-output-pages      one output Block on several Pages
  processor-loop             a bounded processor loop during the Run
  process-descendant         a descendant that outlives the direct child
  active-capability-handler  a capability request whose Core handler is slow
  unknown-external-effect    a capability request with a real external effect

Every workload issues at least one capability request, so boundary 8 is
reachable in all of them. The request the matrix interrupts at is marked
`barrier` so the interruption point is chosen here, once, rather than guessed
by Core from the request order.
"""

import json
import os
import signal
import struct
import subprocess
import sys
import time

PROTOCOL = "dolly.experiment.module-protocol/1"

# Nothing in this fixture may run without bound. The matrix's own case deadline
# is longer, so a fixture that outlives its Core still stops by itself.
FIXED_DEADLINE_SECONDS = 600


def fail(message):
    sys.stderr.write("extension-fixture: " + message + "\n")
    sys.stderr.flush()
    os._exit(70)


def read_exactly(count):
    chunks = []
    remaining = count
    while remaining > 0:
        chunk = os.read(0, remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_frame():
    header = read_exactly(4)
    if header is None:
        return None
    (length,) = struct.unpack(">I", header)
    if length < 2 or length > 4 * 1024 * 1024:
        fail("inbound frame length is out of range")
    body = read_exactly(length)
    if body is None:
        fail("input ended mid-frame")
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        fail("inbound frame is not closed UTF-8 JSON")


def write_frame(value):
    body = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    payload = struct.pack(">I", len(body)) + body
    written = 0
    while written < len(payload):
        written += os.write(1, payload[written:])


def record_environment():
    """Writes the environment this process actually inherited.

    Invariant INV-09 requires zero undeclared environment values observed by
    the Extension, which is a statement about what `execve` handed this
    process. `os.environ` is not that: CPython adds to its own environment
    during start-up (locale coercion sets `LC_CTYPE`, for example), so
    comparing it with Core's declaration would measure the interpreter rather
    than the inheritance. `/proc/self/environ` is the block the kernel placed
    on the stack at `execve` time and no later `setenv` changes it.

    The interpreter's own view is written beside it for diagnosis, but the
    invariant is evaluated against the inherited block.
    """
    path = os.environ.get("DOLLY_FIXTURE_ENVIRON_PATH")
    if not path:
        return
    inherited = {}
    try:
        with open("/proc/self/environ", "rb") as handle:
            for entry in handle.read().split(b"\0"):
                if not entry:
                    continue
                name, separator, value = entry.decode("utf-8", "replace").partition("=")
                if separator:
                    inherited[name] = value
    except OSError:
        inherited = {"__unreadable__": "/proc/self/environ"}
    for target, payload in ((path, inherited), (path + ".runtime", dict(os.environ))):
        with open(target, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())


def start_descendant():
    """A descendant that outlives its parent unless the whole group is stopped.

    It is started with `start_new_session` so it leaves this process's process
    group: a caller that terminated the direct child's process group would miss
    it, which is exactly the failure whole-control-group termination prevents.
    """
    return subprocess.Popen(
        ["/bin/sleep", "300"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        env={},
    )


def burn_processor(seconds):
    deadline = time.monotonic() + seconds
    value = 0
    while time.monotonic() < deadline:
        for _ in range(20000):
            value = (value * 31 + 7) & 0xFFFFFFFF
    return value


def request_capability(request_id, capability_type, operation, arguments, key, barrier):
    write_frame(
        {
            "protocol": PROTOCOL,
            "type": "capability-request",
            "id": request_id,
            "capabilityType": capability_type,
            "operation": operation,
            "arguments": arguments,
            "idempotencyKey": key,
            "barrier": barrier,
        }
    )
    while True:
        frame = read_frame()
        if frame is None:
            # Core went away while the request was open. The fixture never
            # decides a capability outcome for itself, so it just stops.
            os._exit(0)
        if frame.get("type") in ("capability-result", "capability-error"):
            if frame.get("id") != request_id:
                fail("capability reply identifier does not match the request")
            return frame
        fail("unexpected frame while a capability request was open")


def run_live_termination(workload, run_id, ack_descendant):
    """The Module side of a live Core termination case.

    Core stays alive here and terminates this Module's whole control group. The
    fixture's only jobs are to optionally create a descendant that leaves this
    process's process group, and to tell Core when that descendant exists so
    Core can terminate at a confirmed point instead of after a guessed sleep.

    Nothing here exits by itself: whether these processes are gone afterwards is
    exactly what the case measures, so they must only ever be removed by the
    control-group termination Core performs.
    """
    descendant = None
    if workload == "live-descendant":
        descendant = start_descendant()
        if ack_descendant:
            # The confirmation Core waits on. It carries both identifiers so the
            # case can assert from kernel files that two distinct processes were
            # in the group, rather than inferring it.
            write_frame(
                {
                    "protocol": PROTOCOL,
                    "type": "descendant-started",
                    "runId": run_id,
                    "pid": os.getpid(),
                    "descendantPid": descendant.pid,
                }
            )

    # No result is ever sent. A live-termination case ends when Core terminates
    # the control group, so replying would let the Run finish for the wrong
    # reason and the case would measure nothing.
    while True:
        frame = read_frame()
        if frame is None:
            break
        if frame.get("type") == "shutdown":
            break
    return 0


def run(workload, run_id, output_count, ack_descendant=False):
    descendant = None

    if workload in ("live-quiet", "live-descendant"):
        return run_live_termination(workload, run_id, ack_descendant)

    # Every workload exercises boundary 8 at least once. Workloads that have
    # their own capability behaviour mark that request as the interruption
    # point instead of this one.
    plain_barrier = workload not in ("active-capability-handler", "unknown-external-effect")
    request_capability(
        1,
        "structured-log",
        "write",
        {"level": "info", "message": "module run started", "runId": run_id},
        run_id + "-log-1",
        plain_barrier,
    )

    if workload == "process-descendant":
        descendant = start_descendant()
    elif workload == "processor-loop":
        burn_processor(2.0)
    elif workload == "active-capability-handler":
        request_capability(
            2,
            "structured-log",
            "write-slow",
            {"level": "info", "message": "slow handler", "runId": run_id},
            run_id + "-log-2",
            True,
        )
    elif workload == "unknown-external-effect":
        request_capability(
            2,
            "external-effect",
            "emit",
            {"runId": run_id, "payload": "external effect with an unknown outcome"},
            run_id + "-effect-1",
            True,
        )

    result = {"protocol": PROTOCOL, "type": "result", "runId": run_id}
    if workload != "no-output":
        result["text"] = "output of " + workload + " for run " + run_id
        result["outputCount"] = output_count
    write_frame(result)

    # The Extension stays alive after its result, because most interruption
    # boundaries are after the result and the matrix needs a live Module
    # process to terminate at them. It exits when Core closes the channel.
    while True:
        frame = read_frame()
        if frame is None:
            break
        if frame.get("type") == "shutdown":
            break
    if descendant is not None:
        # Deliberately not stopped: whether the descendant is still alive is
        # what whole-control-group termination is measured against.
        pass
    return 0


def main():
    signal.alarm(FIXED_DEADLINE_SECONDS)
    record_environment()
    write_frame({"protocol": PROTOCOL, "type": "ready", "pid": os.getpid()})
    frame = read_frame()
    if frame is None:
        return 0
    if frame.get("type") != "execute":
        fail("first frame after readiness is not the execute request")
    workload = frame.get("workload")
    run_id = frame.get("runId")
    if not isinstance(workload, str) or not isinstance(run_id, str):
        fail("execute request is missing its workload or Run identifier")
    output_count = frame.get("outputCount")
    if not isinstance(output_count, int):
        output_count = 1
    return run(workload, run_id, output_count, frame.get("ackDescendant") is True)


sys.exit(main())
