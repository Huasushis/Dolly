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
#   --test-file <path>
#                    Run this exact Linux integration test instead of the
#                    ownership experiment. Repeat the option for more files.
set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EXPERIMENT_DIR="${REPOSITORY_ROOT}/scripts/experiments/linux-core-service-ownership"
# The container name must be unique across concurrent runs, including runs
# started by different sessions whose process identifiers can coincide.
CONTAINER_NAME="dolly-experiment-$$-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
# A matching unique image tag prevents concurrent builds from retagging the
# image between another invocation's build and container creation.
IMAGE_TAG="${CONTAINER_NAME}-image"
BASE_IMAGE="ubuntu:24.04"
KEEP_CONTAINER="no"
TEST_FILES=()
CONTAINER_CREATED="no"
SOURCE_SNAPSHOT=""

# Options this script owns are consumed here; everything else is passed
# through to the experiment runner unchanged, so the runner's own filters
# (`--id-prefix`, `--group`, `--list`, and the rest) work the same way inside
# the container as they do on a host.
RUNNER_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE_IMAGE="$2"; shift 2 ;;
    --keep) KEEP_CONTAINER="yes"; shift ;;
    --test-file) TEST_FILES+=("$2"); shift 2 ;;
    --output-dir|--output-dir=*|--disposable)
      echo "$1 is managed by the disposable-container runner and cannot be overridden." >&2
      exit 1
      ;;
    *) RUNNER_ARGS+=("$1"); shift ;;
  esac
done

if [ "${#TEST_FILES[@]}" -gt 0 ] && [ "${#RUNNER_ARGS[@]}" -gt 0 ]; then
  echo "--test-file cannot be combined with ownership experiment filters." >&2
  exit 1
fi

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
    echo "Its required tracked-source snapshot remains at ${SOURCE_SNAPSHOT}." >&2
    warn_against_bulk_removal
    return
  fi
  if [ "${KEEP_CONTAINER}" = "yes" ]; then
    echo "Container ${CONTAINER_NAME} left running; remove it with this exact name:" >&2
    echo "  docker rm -f ${CONTAINER_NAME}" >&2
    echo "Its required tracked-source snapshot remains at ${SOURCE_SNAPSHOT}." >&2
    warn_against_bulk_removal
    return
  fi
  # The run has ended and will not write more evidence. Hand only this
  # invocation's artifact directory back to the host account before removing
  # the container. Doing this before the hangup/keep checks would make a live
  # unprivileged run lose write access halfway through.
  if [ -n "${ARTIFACT_ROOT:-}" ] && [ -d "${ARTIFACT_ROOT}" ]; then
    docker exec "${CONTAINER_NAME}" \
      chown -R "$(id -u):$(id -g)" /dolly-artifacts >/dev/null 2>&1 || true
  fi
  if [ "${CONTAINER_CREATED}" = "yes" ] \
      && ! docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1; then
    echo "Could not remove exact container ${CONTAINER_NAME}; preserving its source snapshot at" >&2
    echo "  ${SOURCE_SNAPSHOT}" >&2
    warn_against_bulk_removal
    return
  fi
  docker image rm "${IMAGE_TAG}" >/dev/null 2>&1 || true
  if [ -n "${SOURCE_SNAPSHOT}" ] && [ -d "${SOURCE_SNAPSHOT}" ]; then
    expected_snapshot="${ARTIFACT_ROOT}.tracked-source"
    if [ "${SOURCE_SNAPSHOT}" != "${expected_snapshot}" ]; then
      echo "Refusing to remove unexpected source snapshot path ${SOURCE_SNAPSHOT}." >&2
      return
    fi
    rm -rf -- "${SOURCE_SNAPSHOT}"
  fi
}
trap cleanup EXIT
# A hangup means the terminal went away, not that the experiment should stop.
# Marking the reason lets `cleanup` leave the container alone in that case.
trap 'CLEANUP_REASON=hangup' HUP

# Each invocation gets separate evidence and source-snapshot directories. The
# snapshot is an archive of the exact HEAD commit: dirty, ignored, or untracked
# owner files such as `.env` are not mounted into the privileged experiment
# container. It remains a host-owned temporary input and the container receives
# it read-only.
ARTIFACT_PARENT="${REPOSITORY_ROOT}/artifacts/experiments/linux-core-service-ownership"
ARTIFACT_ROOT="${ARTIFACT_PARENT}/container-$$-$(date -u +%Y%m%dT%H%M%SZ)"
SOURCE_SNAPSHOT="${ARTIFACT_ROOT}.tracked-source"
mkdir -p "${ARTIFACT_PARENT}"
mkdir "${ARTIFACT_ROOT}"
mkdir "${SOURCE_SNAPSHOT}"
(
  cd "${REPOSITORY_ROOT}"
  git archive --format=tar HEAD
) | tar --extract --file=- --directory "${SOURCE_SNAPSHOT}"
chmod -R a+rX,go-w "${SOURCE_SNAPSHOT}"

if [ -e "${SOURCE_SNAPSHOT}/.env" ] \
    || [ -e "${SOURCE_SNAPSHOT}/.git" ] \
    || [ -e "${SOURCE_SNAPSHOT}/node_modules" ] \
    || [ -L "${SOURCE_SNAPSHOT}/node_modules" ]; then
  echo "The tracked-source snapshot unexpectedly contains private repository state." >&2
  exit 1
fi
# Node resolves dependencies relative to each source file's real path under
# `/dolly`, while Vite needs one writable temporary directory. This controlled
# link points only at the ephemeral dependency view built later in the
# container; no host checkout path is exposed.
ln -s /dolly-run/node_modules "${SOURCE_SNAPSHOT}/node_modules"

echo "Building the disposable image from ${BASE_IMAGE}"
docker build \
  --build-arg "BASE=${BASE_IMAGE}" \
  -t "${IMAGE_TAG}" \
  "${EXPERIMENT_DIR}"

# The tracked-source snapshot is mounted read-only so a run cannot modify the
# source it is testing or read ignored/untracked owner files. Artifacts go to a
# separate writable directory on the host, which survives the container so a
# run's evidence can be inspected afterwards.
#
# Each invocation gets its own artifact directory. Concurrent runs would
# otherwise share one tree, and handing its ownership back at the end of one
# run breaks a run that is still writing: the container accounts have
# unrelated identifiers, so one run's `chown` makes the tree unwritable for
# another. A per-invocation directory removes the shared resource rather than
# asking callers to serialise.
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
  -v "${SOURCE_SNAPSHOT}:/dolly:ro" \
  -v "${ARTIFACT_ROOT}:/dolly-artifacts:rw" \
  "${DEPENDENCY_MOUNT[@]+"${DEPENDENCY_MOUNT[@]}"}" \
  "${IMAGE_TAG}" >/dev/null
CONTAINER_CREATED="yes"

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
DOLLY_GID="$(docker exec "${CONTAINER_NAME}" id -g dolly)"
DOLLY_GROUPS="$(docker exec "${CONTAINER_NAME}" id -G dolly)"
if [ "${DOLLY_UID}" -eq 0 ] || [ "${DOLLY_GROUPS}" != "${DOLLY_GID}" ]; then
  echo "The experiment account is root or retains supplementary groups; refusing to run." >&2
  exit 1
fi
echo "Service manager state: ${state}; unprivileged account uid ${DOLLY_UID}, gid ${DOLLY_GID}"

# Source identity and the exact inner command are written while the artifact
# directory still belongs to the host account. The directory is handed to the
# container account below.
git -C "${REPOSITORY_ROOT}" rev-parse HEAD > "${ARTIFACT_ROOT}/source-commit.txt"
git -C "${REPOSITORY_ROOT}" status --short > "${ARTIFACT_ROOT}/source-status.txt"
printf 'git archive HEAD\n' > "${ARTIFACT_ROOT}/source-snapshot.txt"
if [ "${#TEST_FILES[@]}" -gt 0 ]; then
  {
    printf '%q ' ./scripts/run-linux-module-launcher-integration.sh "${TEST_FILES[@]}"
    printf '\n'
  } > "${ARTIFACT_ROOT}/command.txt"
else
  {
    printf '%q ' \
      ./scripts/experiments/linux-core-service-ownership/run.sh \
      --disposable \
      --output-dir /dolly-artifacts \
      "${RUNNER_ARGS[@]+"${RUNNER_ARGS[@]}"}"
    printf '\n'
  } > "${ARTIFACT_ROOT}/command.txt"
fi

# The artifact volume is created by the host account, whose identifier need not
# exist inside the container. The experiment runs unprivileged, so the mount
# point is handed to that account before the run starts.
docker exec "${CONTAINER_NAME}" chown -R dolly:dolly /dolly-artifacts

# The working tree is mounted read-only, so the run needs a writable view.
# Every source entry is symbolically linked rather than copied. `node_modules`
# itself is a writable directory because Vite creates `.vite-temp` there; each
# installed dependency inside it remains a link to the read-only dependency
# mount, so a test cannot modify installed package contents.
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
    mkdir -p ${WORK_TREE}/node_modules/.vite-temp
    while IFS= read -r -d '' dependency; do
      name=\"\$(basename \"\${dependency}\")\"
      [ \"\${name}\" = .vite-temp ] && continue
      ln -sfn \"\${dependency}\" ${WORK_TREE}/node_modules/\"\${name}\"
    done < <(find /dolly-dependencies -mindepth 1 -maxdepth 1 -print0)
  fi
  chown -R dolly:dolly ${WORK_TREE}
"

# These checks make the security shape observable before any test or hostile
# fixture runs. In particular, the account must not see ignored checkout state,
# and changing either bind mount from read-only to read-write must fail here.
docker exec -u dolly "${CONTAINER_NAME}" bash -c '
  set -e
  test -r /dolly/package.json
  test ! -w /dolly/package.json
  test ! -e /dolly/.env
  test ! -e /dolly/.git
  test "$(readlink /dolly/node_modules)" = /dolly-run/node_modules
  test -w /dolly-run/node_modules/.vite-temp
  test -w /dolly-artifacts
  if [ -d /dolly-dependencies ]; then
    test -r /dolly-dependencies
    test ! -w /dolly-dependencies
  fi
  {
    echo "tracked_commit_source=true"
    echo "source_readable=true"
    echo "source_writable=false"
    echo "private_env_present=false"
    echo "git_directory_present=false"
    echo "dependencies_writable=false"
    echo "vite_temp_writable=true"
    echo "artifacts_writable=true"
  } | tee /dolly-artifacts/preflight.txt
'

# Report the conditions the matrix depends on, so a run that silently lost one
# of them is visible in its own output rather than only in a failed case.
docker exec "${CONTAINER_NAME}" bash -c '
  set -o pipefail
  {
    echo "cgroup filesystem: $(stat -fc %T /sys/fs/cgroup)"
    echo "root controllers:  $(cat /sys/fs/cgroup/cgroup.controllers)"
    echo "lingering:         $(loginctl show-user dolly -p Linger)"
    echo "systemd:           $(systemd --version | sed -n '1p')"
    echo "node:              $(node --version)"
    echo "dolly identity:    uid=$(id -u dolly) gid=$(id -g dolly) groups=$(id -G dolly)"
    echo "python3:           $(python3 -V 2>&1)"
  } | tee /dolly-artifacts/environment.txt
'

if [ "${#TEST_FILES[@]}" -gt 0 ]; then
  echo "Running exact Linux integration test files as the unprivileged account"
  docker exec -u dolly \
    -e "XDG_RUNTIME_DIR=/run/user/${DOLLY_UID}" \
    -w "${WORK_TREE}" \
    "${CONTAINER_NAME}" \
    bash -c '
      set -o pipefail
      ./scripts/run-linux-module-launcher-integration.sh "$@" \
        2>&1 | tee /dolly-artifacts/linux-integration.log
    ' bash "${TEST_FILES[@]}"
else
  echo "Running the experiment as the unprivileged account"
  docker exec -u dolly \
    -e "XDG_RUNTIME_DIR=/run/user/${DOLLY_UID}" \
    -w "${WORK_TREE}" \
    "${CONTAINER_NAME}" \
    ./scripts/experiments/linux-core-service-ownership/run.sh \
    --disposable --output-dir /dolly-artifacts "${RUNNER_ARGS[@]+"${RUNNER_ARGS[@]}"}"
fi

echo "Artifacts: ${ARTIFACT_ROOT}"
