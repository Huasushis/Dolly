#!/bin/bash
# Case handler: external-effect declaration gating.
#
# Decision register row DEC-009 and `core-runtime.md` section 5.2 restrict the
# first Linux Module path to a Module whose configuration declares that every
# external or persistent effect passes through a durable Core capability. This
# handler checks the two refusals that follow from it:
#
#   SC-10-01-declaration-absent              no declaration at all
#   SC-10-02-direct-effect-authority-declared  direct ambient effect authority
#
# The refusal is checked against the real record validator, so a case that
# passes here means the shipped code rejects the configuration, not that a
# simulation agreed with the specification.
set -uo pipefail

CASE_ID="${DOLLY_EXPERIMENT_CASE_ID:?}"
CASE_DIR="${DOLLY_EXPERIMENT_CASE_DIR:?}"
REPOSITORY="${DOLLY_EXPERIMENT_REPOSITORY:?}"

EVENTS="${CASE_DIR}/events"
OBSERVATIONS="${CASE_DIR}/process-and-cgroup-observations"
OUTCOME="${CASE_DIR}/case-outcome"

: >"${EVENTS}"
: >"${OBSERVATIONS}"

event() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"${EVENTS}"
}

finish() {
  printf 'status=%s\nreason=%s\n' "$1" "$2" >"${OUTCOME}"
  event "outcome $1 $2"
  exit 0
}

TSX_LOADER="${REPOSITORY}/node_modules/tsx/dist/loader.mjs"
[ -f "${TSX_LOADER}" ] || finish inconclusive tsx-loader-missing

case "${CASE_ID}" in
  SC-10-01-declaration-absent) DECLARATION="absent" ;;
  SC-10-02-direct-effect-authority-declared) DECLARATION="direct-ambient" ;;
  *) finish inconclusive unknown-case ;;
esac

event "checking refusal for a ${DECLARATION} external-effect declaration"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

cat >"${WORK_DIR}/probe.mts" <<'PROBE'
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { pathToFileURL } = require("node:url") as typeof import("node:url");

const declaration = process.argv[2]!;
const repository = process.argv[3]!;
const moduleUrl = (relative: string): string =>
  pathToFileURL(join(repository, relative)).href;

const { assertValidModuleProcessRecord } = await import(
  moduleUrl("src/core/module-process-records.ts")
);
const { deriveModuleCgroupPath } = await import(
  moduleUrl("src/core/linux-module-cgroup.ts")
);

const NOW = "2026-07-26T00:00:00.000Z";
const IDENTITY = {
  instanceId: "instance-1",
  moduleId: "worker",
  processGenerationId: "process-generation-1",
};

// A record that is valid apart from the declaration under test.
const base: Record<string, unknown> = {
  schemaVersion: "dolly.module-process-record/1",
  instanceId: IDENTITY.instanceId,
  moduleId: IDENTITY.moduleId,
  moduleGenerationId: "module-generation-1",
  processGenerationId: IDENTITY.processGenerationId,
  packageDigest: `sha256:${"a".repeat(64)}`,
  configurationReference: {
    configId: "config-1",
    revision: `sha256:${"b".repeat(64)}`,
    configVersion: 1,
  },
  serviceInvocationId: "2812432ad29e4d3bbd6776c62cafa929",
  bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
  moduleCgroupPath: deriveModuleCgroupPath(
    "/system.slice/dolly-core.service",
    IDENTITY,
  ).filesystemPath,
  state: "starting",
  createdAt: NOW,
  updatedAt: NOW,
};

const record =
  declaration === "absent"
    ? base
    : { ...base, declaredExternalEffects: "direct-ambient" };

let refused = false;
let code = "none";
let message = "";
try {
  assertValidModuleProcessRecord(record);
} catch (error) {
  refused = true;
  code = (error as { code?: string }).code ?? "unknown";
  message = error instanceof Error ? error.message : String(error);
}

// The control: the same record with an accepted declaration must be valid, so
// the refusal above is attributable to the declaration and nothing else.
let controlAccepted = true;
let controlMessage = "";
try {
  assertValidModuleProcessRecord({
    ...base,
    declaredExternalEffects: "core-capabilities-only",
  });
} catch (error) {
  controlAccepted = false;
  controlMessage = error instanceof Error ? error.message : String(error);
}

console.log(
  JSON.stringify({ refused, code, message, controlAccepted, controlMessage }),
);
PROBE

RESULT="${CASE_DIR}/declaration-observation.json"
node --import "file://${TSX_LOADER}" "${WORK_DIR}/probe.mts" \
  "${DECLARATION}" "${REPOSITORY}" \
  >"${RESULT}" 2>"${CASE_DIR}/probe.stderr"
[ $? -eq 0 ] || finish inconclusive probe-did-not-complete

node -e '
  const fs = require("node:fs");
  const out = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  console.log("refused=" + out.refused + " code=" + out.code
    + " controlAccepted=" + out.controlAccepted);
  if (out.controlAccepted !== true) {
    console.error("the control record was rejected: " + out.controlMessage);
    process.exit(1);
  }
  if (out.refused !== true) {
    console.error("the declaration under test was accepted");
    process.exit(1);
  }
  if (out.code !== "MODULE_PROCESS_RECORD_INVALID") {
    console.error("unexpected refusal code: " + out.code);
    process.exit(1);
  }
' "${RESULT}" >>"${OBSERVATIONS}" 2>>"${OBSERVATIONS}" \
  || finish failed declaration-was-not-refused

finish passed refused-ineligible-external-effect-declaration
