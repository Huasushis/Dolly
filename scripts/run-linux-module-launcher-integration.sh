#!/bin/bash
# Runs the Linux Module launcher integration scenarios inside the environment
# they require.
#
# These scenarios need the process that runs them to sit in a delegated
# cgroup v2 subtree named `core`, exactly as Architecture Decision Record 0009
# places the Dolly Core service. An ordinary shell is not in such a subtree, so
# the test file normally skips itself and reports why. Running the suite through
# this script is the only way to make those scenarios execute. The script sets
# `DOLLY_LINUX_MODULE_INTEGRATION_REQUIRED=1`, which makes the relevant test
# files fail during collection if the delegated environment is missing instead
# of allowing an all-skipped run to exit successfully.
#
# With no file arguments, the runner executes every real Linux Module test.
# File arguments replace that list, which keeps focused reproduction exact.
# Usage, from a checkout with dependencies installed:
#
#   ./scripts/run-linux-module-launcher-integration.sh
#
# It creates one transient systemd user service with the `dolly-test-` prefix
# and `--collect`, so systemd removes the unit and its whole control group when
# the run finishes. It changes no system configuration and installs nothing.
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
  echo "This script requires Linux; these scenarios have no meaningful partial form elsewhere." >&2
  exit 1
fi
if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  echo "This script requires a running systemd user manager (XDG_RUNTIME_DIR is unset)." >&2
  exit 1
fi

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VITEST_ENTRY="${REPOSITORY_ROOT}/node_modules/vitest/vitest.mjs"
if [ ! -f "${VITEST_ENTRY}" ]; then
  echo "Install dependencies first; ${VITEST_ENTRY} is missing." >&2
  exit 1
fi

# The `node_modules/.bin` wrapper is a shell script, so the service runs the
# package entry point directly with the Node.js executable instead.
NODE_PATH_RESOLVED="$(command -v node)"
UNIT_NAME="dolly-test-launcher-integration-$$"
if [ "$#" -eq 0 ]; then
  TEST_FILES=(
    tests/conformance/security/linux-module-launcher-integration.test.ts
    tests/conformance/security/linux-module-cgroup-integration.test.ts
    tests/conformance/security/linux-module-attached-process-integration.test.ts
    tests/conformance/security/linux-module-executor-systemd-integration.test.ts
  )
else
  TEST_FILES=("$@")
fi

# The installed-executor integration verifies that the running test process is
# the service manager's exact MainPID. Worker threads preserve that process
# identity; a forked Vitest worker would correctly fail the Core binding even
# though its parent is the service main process.
VITEST_POOL="forks"
for test_file in "${TEST_FILES[@]}"; do
  if [ "${test_file}" = "tests/conformance/security/linux-extension-module-executor-integration.test.ts" ] ||
     [ "${test_file}" = "tests/conformance/security/installed-reactive-module-host-integration.test.ts" ] ||
     [ "${test_file}" = "tests/conformance/security/installed-inline-media-agent-integration.test.ts" ]; then
    VITEST_POOL="threads"
  fi
done

exec systemd-run \
  --user \
  --quiet \
  --pipe \
  --wait \
  --collect \
  --expand-environment=no \
  "--unit=${UNIT_NAME}" \
  -p Delegate=yes \
  -p DelegateSubgroup=core \
  -p Type=exec \
  -p Restart=on-failure \
  -p StartLimitBurst=1 \
  -p StartLimitIntervalSec=60 \
  --setenv=DOLLY_LINUX_MODULE_INTEGRATION_REQUIRED=1 \
  "--setenv=DOLLY_LINUX_MODULE_INTEGRATION_UNIT=${UNIT_NAME}.service" \
  "--working-directory=${REPOSITORY_ROOT}" \
  -- \
  "${NODE_PATH_RESOLVED}" "${VITEST_ENTRY}" run \
  --config vitest.config.ts \
  "--pool=${VITEST_POOL}" \
  --maxWorkers=1 \
  "${TEST_FILES[@]}"
