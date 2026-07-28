#!/bin/bash
# Stops itself, then runs the command it was given.
#
# This is the deterministic pause in the `baseline-transient-unit` reproduction.
# ADR 0008's first reason for rejection turns on a `systemd-run` process being
# paused "before it asks systemd to create the service". SIGSTOP is raised here,
# before `exec`, so the service manager provably has not heard the request yet:
# there is no sleep, no polling window, and no timing assumption in the race.
#
# The process keeps its own identifier across the `exec`, so the caller can
# release it later with SIGCONT.
kill -STOP $$
exec "$@"
