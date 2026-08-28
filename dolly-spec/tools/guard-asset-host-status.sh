#!/usr/bin/env bash
# End-to-end guard for the Asset Host status wire.
#
# Obtains a real AVAILABLE response through AssetHostFacade (Rust),
# persists its serialized bytes as the emission artifact, validates those
# actual bytes against the authoritative asset-status schema (AJV), and
# proves the committed artifact did not drift from the live response.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GUARD_TARGET="$(mktemp -d -t dolly-asset-guard-target.XXXXXX)"
trap 'rm -rf "${GUARD_TARGET}"' EXIT

cd "${REPO_ROOT}"
CARGO_TARGET_DIR="${GUARD_TARGET}" cargo test --locked -p dolly-asset \
  --test conformance facade_end_to_end_available_emission_is_live

cd "${REPO_ROOT}/dolly-spec"
node tools/validate_schemas.mjs

if ! git -C "${REPO_ROOT}" diff --quiet -- \
    dolly-spec/examples/host-asset-status-available.json; then
  echo "error: committed AVAILABLE emission drifted from the live façade response" >&2
  exit 1
fi

echo "asset host status end-to-end guard: PASS"
