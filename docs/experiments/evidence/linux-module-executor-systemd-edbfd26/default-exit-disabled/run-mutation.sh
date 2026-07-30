#!/usr/bin/env bash
set -euo pipefail

PRIMARY=/home/ubuntu/dolly-test
BASE_SHA=edbfd268478f65cb430aa5ece23c9dcd6634c872
PATCH_PATH=/tmp/p0-4-disable-default-exit-edbfd26.patch
TEST_FILE=tests/conformance/security/linux-module-executor-systemd-integration.test.ts
BASE_IMAGE=docker.m.daocloud.io/library/ubuntu:24.04

test "$(git -C "${PRIMARY}" rev-parse --show-toplevel)" = "${PRIMARY}"
test -z "$(git -C "${PRIMARY}" status --short)"
git -C "${PRIMARY}" cat-file -e "${BASE_SHA}^{commit}"
test -f "${PRIMARY}/node_modules/vitest/vitest.mjs"
test -f "${PATCH_PATH}"

MUTATION_ROOT="$(mktemp -d /tmp/dolly-p0-4-default-exit-disabled.XXXXXX)"
WORKTREE="${MUTATION_ROOT}/source"
mkdir -p "${PRIMARY}/artifacts/p0-4"
EVIDENCE="$(mktemp -d "${PRIMARY}/artifacts/p0-4/linux-module-executor-default-exit-disabled.XXXXXX")"

cleanup() {
  original_status=$?
  set +e
  if [ "${WORKTREE}" = "${MUTATION_ROOT}/source" ] &&
     [[ "${MUTATION_ROOT}" =~ ^/tmp/dolly-p0-4-default-exit-disabled\.[A-Za-z0-9]+$ ]]; then
    if git -C "${PRIMARY}" worktree list --porcelain |
       grep -Fqx "worktree ${WORKTREE}"; then
      git -C "${PRIMARY}" worktree remove --force "${WORKTREE}"
    fi
    rmdir "${MUTATION_ROOT}" 2>/dev/null || true
  fi
  return "${original_status}"
}
trap cleanup EXIT

git -C "${PRIMARY}" worktree add --detach "${WORKTREE}" "${BASE_SHA}"
# The source keeps its real /dolly path inside the container, so its relative
# loader imports must also exist below /dolly/node_modules. A same-filesystem
# hard-link copy supplies that read-only tree without duplicating file data.
cp -al "${PRIMARY}/node_modules" "${WORKTREE}/node_modules"
git -C "${WORKTREE}" apply --check "${PATCH_PATH}"
git -C "${WORKTREE}" apply "${PATCH_PATH}"
git -C "${WORKTREE}" diff --check
test "$(git -C "${WORKTREE}" diff --name-only)" = \
  "src/adapters/linux-module-executor.ts"
test "$(git -C "${WORKTREE}" status --short)" = \
  " M src/adapters/linux-module-executor.ts"

cp "${PATCH_PATH}" "${EVIDENCE}/mutation.patch"
cp "$0" "${EVIDENCE}/run-mutation.sh"
git -C "${WORKTREE}" rev-parse HEAD > "${EVIDENCE}/baseline-commit.txt"
git -C "${WORKTREE}" status --short > "${EVIDENCE}/source-status-before-run.txt"
git -C "${WORKTREE}" diff -- src/adapters/linux-module-executor.ts \
  > "${EVIDENCE}/observed-mutation.diff"
git -C "${WORKTREE}" show \
  "${BASE_SHA}:src/adapters/linux-module-executor.ts" |
  sha256sum > "${EVIDENCE}/baseline-product-file-sha256.txt"
(
  cd "${WORKTREE}"
  sha256sum \
    src/adapters/linux-module-executor.ts \
    tests/conformance/security/linux-module-executor-systemd-integration.test.ts \
    tests/conformance/security/fixtures/linux-module-executor-systemd-exit.ts \
    scripts/run-linux-module-launcher-integration.sh \
    scripts/experiments/linux-core-service-ownership/run-disposable-container.sh
) > "${EVIDENCE}/test-input-sha256.txt"
docker ps -a --format '{{.Names}} {{.Status}}' \
  > "${EVIDENCE}/containers-before.txt"
docker image ls --format '{{.Repository}}:{{.Tag}}' \
  > "${EVIDENCE}/images-before.txt"

RUNNER="${WORKTREE}/scripts/experiments/linux-core-service-ownership/run-disposable-container.sh"
set +e
"${RUNNER}" \
  --base "${BASE_IMAGE}" \
  --test-file "${TEST_FILE}" \
  2>&1 | tee "${EVIDENCE}/runner-console.log"
RUNNER_STATUS=${PIPESTATUS[0]}
set -e

printf '%s\n' "${RUNNER_STATUS}" > "${EVIDENCE}/runner-exit-status.txt"
test "${RUNNER_STATUS}" -eq 1

ARTIFACT_PARENT="${WORKTREE}/artifacts/experiments/linux-core-service-ownership"
mapfile -d '' RUN_ARTIFACTS < <(
  find "${ARTIFACT_PARENT}" -mindepth 1 -maxdepth 1 -type d -print0
)
test "${#RUN_ARTIFACTS[@]}" -eq 1
mkdir "${EVIDENCE}/disposable-container-artifact"
cp -a "${RUN_ARTIFACTS[0]}/." \
  "${EVIDENCE}/disposable-container-artifact/"

grep -F '"ExecMainStatus":"92"' "${EVIDENCE}/runner-console.log" >/dev/null
grep -F 'executor start rejected instead of ending Core' \
  "${EVIDENCE}/runner-console.log" >/dev/null
grep -F ' M src/adapters/linux-module-executor.ts' \
  "${EVIDENCE}/disposable-container-artifact/source-status.txt" >/dev/null

mapfile -t CREATED_NAMES < <(
  sed -n 's/^Starting \(dolly-experiment-[0-9]\+-[0-9a-f]\{8\}\)$/\1/p' \
    "${EVIDENCE}/runner-console.log"
)
test "${#CREATED_NAMES[@]}" -eq 1
CREATED_NAME="${CREATED_NAMES[0]}"
[[ "${CREATED_NAME}" =~ ^dolly-experiment-[0-9]+-[0-9a-f]{8}$ ]]
if docker container inspect "${CREATED_NAME}" >/dev/null 2>&1; then
  echo "the exact disposable container still exists: ${CREATED_NAME}" >&2
  exit 1
fi
if docker image inspect "${CREATED_NAME}-image:latest" >/dev/null 2>&1; then
  echo "the exact disposable image still exists: ${CREATED_NAME}-image:latest" >&2
  exit 1
fi
printf 'container=%s\ncontainer_removed=yes\nimage_removed=yes\n' \
  "${CREATED_NAME}" > "${EVIDENCE}/exact-cleanup.txt"
docker ps -a --format '{{.Names}} {{.Status}}' \
  > "${EVIDENCE}/containers-after.txt"
docker image ls --format '{{.Repository}}:{{.Tag}}' \
  > "${EVIDENCE}/images-after.txt"

(
  cd "${EVIDENCE}"
  find . -type f ! -name SHA256SUMS -print0 |
    sort -z |
    xargs -0 sha256sum
) > "${EVIDENCE}/SHA256SUMS"

echo "Mutation evidence: ${EVIDENCE}"
