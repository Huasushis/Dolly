#!/bin/bash
# Runs the Linux Module launcher integration scenarios inside the environment
# they require.
#
# These scenarios need the process that runs them to sit in a delegated
# cgroup v2 subtree named `core`, exactly as Architecture Decision Record 0009
# places the Dolly Core service. An ordinary shell is not in such a subtree, so
# the test file skips itself and reports why. Running the suite through this
# script is the only way to make those scenarios execute.
#
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

exec systemd-run \
  --user \
  --quiet \
  --pipe \
  --wait \
  --collect \
  "--unit=${UNIT_NAME}" \
  -p Delegate=yes \
  -p DelegateSubgroup=core \
  -p Type=exec \
  "--working-directory=${REPOSITORY_ROOT}" \
  -- \
  "${NODE_PATH_RESOLVED}" "${VITEST_ENTRY}" run \
  --config vitest.config.ts \
  --pool=forks \
  --maxWorkers=1 \
  "${@:-tests/conformance/security/linux-module-launcher-integration.test.ts}"
