#!/bin/bash
# Runs the Linux Core service process-ownership experiment inside a disposable
# container that has its own systemd instance.
#
# The experiment protocol requires service-manager restart, login termination,
# reboot, forced-termination, and hostile-fixture cases. Those must never run
# against a shared machine, which is why the matrix has stayed inconclusive.
# A container with its own service manager is destroyed after every run, so
# the cases have no lasting effect on the host.
#
# What the container provides that a shared host cannot:
#
#   - its own systemd instance, so restarting the service manager is safe;
#   - user lingering enabled, which the authorized shared server does not have
#     and which a user service requires under Architecture Decision Record
#     0009; and
#   - a control-group version 2 tree with the cpu, memory, and pids
#     controllers delegated to an unprivileged account.
#
# The container runs privileged because systemd needs to manage its own
# control-group tree. That is acceptable only because the container is
# disposable and is destroyed at the end of every run; it is not a deployment
# recommendation.
#
# Usage, from the repository root:
#
#   ./scripts/experiments/linux-core-service-ownership/run-disposable-container.sh
#
# The full matrix runs for long enough that a remote shell is likely to drop
# before it finishes. Detach it from the terminal and read its log instead of
# holding the connection open:
#
#   nohup setsid ./scripts/experiments/linux-core-service-ownership/\
# run-disposable-container.sh <args> > run.log 2>&1 < /dev/null &
#
# A hangup no longer destroys a running container, but the run's output still
# goes wherever the terminal pointed, so detaching is what keeps the log.
#
# Options:
#   --base <image>   Base image, for a mirror where the default is unreachable
#   --keep           Leave the container running for inspection after the run
set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EXPERIMENT_DIR="${REPOSITORY_ROOT}/scripts/experiments/linux-core-service-ownership"
IMAGE_TAG="dolly-experiment"
# The container name must be unique across concurrent runs, including runs
# started by different sessions whose process identifiers can coincide.
CONTAINER_NAME="dolly-experiment-$$-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
BASE_IMAGE="ubuntu:24.04"
KEEP_CONTAINER="no"

# Options this script owns are consumed here; everything else is passed
# through to the experiment runner unchanged, so the runner's own filters
# (`--id-prefix`, `--group`, `--list`, and the rest) work the same way inside
# the container as they do on a host.
RUNNER_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE_IMAGE="$2"; shift 2 ;;
    --keep) KEEP_CONTAINER="yes"; shift ;;
    *) RUNNER_ARGS+=("$1"); shift ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "This script requires docker to create the disposable environment." >&2
  exit 1
fi

# Printed beside every removal command this script suggests.
#
# Container names carry a random suffix precisely so concurrent runs cannot
# collide, which also means a name-prefix filter matches other people's live
# runs. Removing one is not a visible failure for its owner: the container
# disappears, the run stops mid-matrix, and the log ends without an error, which
# is the hardest kind of outcome to attribute. It has already happened twice.
#
# The warning sits next to the command because a command printed here is the one
# that gets copied.
warn_against_bulk_removal() {
  echo "Remove only that exact name. Do not filter by prefix or use a wildcard:" >&2
  echo "  docker rm -f \$(docker ps -aq --filter name=dolly-experiment-)   # destroys other runs" >&2
  echo "Concurrent runs each have their own container and artifact directory, and a run" >&2
  echo "removed from outside stops with no error in its log." >&2
}

cleanup() {
  # The run writes artifacts as the container's unprivileged account, whose
  # identifier is unrelated to the host's. Ownership is handed back before the
  # container goes away, so the evidence stays readable and writable on the
  # host. This touches only this invocation's own directory.
  if [ -n "${ARTIFACT_ROOT:-}" ] && [ -d "${ARTIFACT_ROOT}" ]; then
    docker exec "${CONTAINER_NAME}" \
      chown -R "$(id -u):$(id -g)" /dolly-artifacts >/dev/null 2>&1 || true
  fi
  if [ "${CLEANUP_REASON:-}" = "hangup" ]; then
    # A lost terminal is not a decision to abandon the run. The full matrix
    # takes long enough that a dropped connection is likely, and destroying the
    # container here would end a run that is still making progress and leave a
    # truncated result ledger that looks like a silent failure. The container
    # keeps running; the command below removes it once the evidence is
    # collected.
    echo "Connection lost. ${CONTAINER_NAME} is still running; its artifacts are in" >&2
    echo "  ${ARTIFACT_ROOT}" >&2
    echo "Remove it when the run has finished with this exact name:" >&2
    echo "  docker rm -f ${CONTAINER_NAME}" >&2
    warn_against_bulk_removal
    return
  fi
  if [ "${KEEP_CONTAINER}" = "yes" ]; then
    echo "Container ${CONTAINER_NAME} left running; remove it with this exact name:" >&2
    echo "  docker rm -f ${CONTAINER_NAME}" >&2
    warn_against_bulk_removal
    return
  fi
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# A hangup means the terminal went away, not that the experiment should stop.
# Marking the reason lets `cleanup` leave the container alone in that case.
trap 'CLEANUP_REASON=hangup' HUP

echo "Building the disposable image from ${BASE_IMAGE}"
docker build --build-arg "BASE=${BASE_IMAGE}" -t "${IMAGE_TAG}" "${EXPERIMENT_DIR}"

# The working tree is mounted read-only so a run cannot modify the source it
# is testing. Artifacts go to a separate writable directory on the host, which
# survives the container so a run's evidence can be inspected afterwards.
#
# Each invocation gets its own artifact directory. Concurrent runs would
# otherwise share one tree, and handing its ownership back at the end of one
# run breaks a run that is still writing: the container accounts have
# unrelated identifiers, so one run's `chown` makes the tree unwritable for
# another. A per-invocation directory removes the shared resource rather than
# asking callers to serialise.
ARTIFACT_ROOT="${REPOSITORY_ROOT}/artifacts/experiments/linux-core-service-ownership/container-$$-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "${ARTIFACT_ROOT}"

# Handlers run TypeScript through the installed development dependencies.
# `node_modules` is often a symbolic link to a directory outside the working
# tree, and the directories on the way to that target may not be traversable
# by the unprivileged account inside the container. The real directory is
# therefore mounted at a fixed path that account can always reach, and the
# link inside the container is replaced with one pointing at it.
DEPENDENCY_MOUNT=()
DEPENDENCY_TARGET=""
if [ -e "${REPOSITORY_ROOT}/node_modules" ]; then
  DEPENDENCY_TARGET="$(readlink -f "${REPOSITORY_ROOT}/node_modules")"
  if [ -d "${DEPENDENCY_TARGET}" ]; then
    DEPENDENCY_MOUNT=(-v "${DEPENDENCY_TARGET}:/dolly-dependencies:ro")
    echo "Mounting dependencies from ${DEPENDENCY_TARGET}"
  else
    DEPENDENCY_TARGET=""
  fi
fi

echo "Starting ${CONTAINER_NAME}"
docker run -d --name "${CONTAINER_NAME}" \
  --privileged \
  --tmpfs /run --tmpfs /run/lock \
  --cgroupns=private \
  -v "${REPOSITORY_ROOT}:/dolly:ro" \
  -v "${ARTIFACT_ROOT}:/dolly-artifacts:rw" \
  "${DEPENDENCY_MOUNT[@]+"${DEPENDENCY_MOUNT[@]}"}" \
  "${IMAGE_TAG}" >/dev/null

# systemd needs a moment to reach a running state before the user manager and
# its delegated control-group tree exist.
for _ in $(seq 1 30); do
  state="$(docker exec "${CONTAINER_NAME}" systemctl is-system-running 2>/dev/null || true)"
  case "${state}" in
    running|degraded) break ;;
  esac
  sleep 1
done
if [ "${state:-}" != "running" ] && [ "${state:-}" != "degraded" ]; then
  echo "The container's service manager did not start; state was '${state:-unknown}'." >&2
  docker logs "${CONTAINER_NAME}" >&2 || true
  exit 1
fi

DOLLY_UID="$(docker exec "${CONTAINER_NAME}" id -u dolly)"
echo "Service manager state: ${state}; unprivileged account uid ${DOLLY_UID}"

# The artifact volume is created by the host account, whose identifier need not
# exist inside the container. The experiment runs unprivileged, so the mount
# point is handed to that account before the run starts.
docker exec "${CONTAINER_NAME}" chown -R dolly:dolly /dolly-artifacts

# The working tree is mounted read-only, so the run needs a writable view whose
# `node_modules` resolves inside the container. Every source entry is
# symbolically linked rather than copied, which keeps the source itself
# unmodifiable while letting the dependency link point at the mounted
# dependencies.
WORK_TREE=/dolly-run
docker exec "${CONTAINER_NAME}" bash -c "
  set -e
  mkdir -p ${WORK_TREE}
  for entry in /dolly/*; do
    name=\"\$(basename \"\${entry}\")\"
    [ \"\${name}\" = node_modules ] && continue
    ln -sfn \"\${entry}\" ${WORK_TREE}/\"\${name}\"
  done
  if [ -d /dolly-dependencies ]; then
    ln -sfn /dolly-dependencies ${WORK_TREE}/node_modules
  fi
  chown -R dolly:dolly ${WORK_TREE}
"

# Report the conditions the matrix depends on, so a run that silently lost one
# of them is visible in its own output rather than only in a failed case.
docker exec "${CONTAINER_NAME}" bash -c '
  echo "cgroup filesystem: $(stat -fc %T /sys/fs/cgroup)"
  echo "root controllers:  $(cat /sys/fs/cgroup/cgroup.controllers)"
  echo "lingering:         $(loginctl show-user dolly -p Linger)"
  echo "python3:           $(python3 -V 2>&1)"
'

echo "Running the experiment as the unprivileged account"
docker exec -u dolly \
  -e "XDG_RUNTIME_DIR=/run/user/${DOLLY_UID}" \
  -w "${WORK_TREE}" \
  "${CONTAINER_NAME}" \
  ./scripts/experiments/linux-core-service-ownership/run.sh \
  --disposable --output-dir /dolly-artifacts "${RUNNER_ARGS[@]+"${RUNNER_ARGS[@]}"}"

echo "Artifacts: ${ARTIFACT_ROOT}"
