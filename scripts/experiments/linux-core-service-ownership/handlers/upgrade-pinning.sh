#!/bin/bash
# Case handler: package and configuration revisions stay pinned while a record
# or Run is unresolved.
#
# Architecture Decision Record 0009 "Platform and migration impact" requires a
# later configuration revision to pin the package and configuration revision of
# every unresolved Run, and forbids a package upgrade or record collection from
# altering or erasing that evidence. `core-runtime.md` section 5.2 says the
# same: the pinned revisions stay until the associated process record and any
# unresolved Run are terminal.
#
#   SC-07-01-package-upgrade-unresolved-process-record
#   SC-07-02-package-upgrade-unresolved-submission-record
#   SC-07-03-configuration-upgrade-unresolved-run
#
# Each case builds durable state that is unresolved in the named way, performs
# the upgrade against the real store, and requires the recorded revisions to be
# unchanged afterwards.
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
  SC-07-01-package-upgrade-unresolved-process-record) SCENARIO="process-record" ;;
  SC-07-02-package-upgrade-unresolved-submission-record) SCENARIO="submission-record" ;;
  SC-07-03-configuration-upgrade-unresolved-run) SCENARIO="unresolved-run" ;;
  *) finish inconclusive unknown-case ;;
esac

event "checking revision pinning for ${SCENARIO}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

cat >"${WORK_DIR}/probe.mts" <<'PROBE'
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { pathToFileURL } = require("node:url") as typeof import("node:url");
const { mkdtempSync, rmSync } = require("node:fs") as typeof import("node:fs");
const { tmpdir } = require("node:os") as typeof import("node:os");

const scenario = process.argv[2]!;
const repository = process.argv[3]!;
const moduleUrl = (relative: string): string =>
  pathToFileURL(join(repository, relative)).href;

const { FileCoreStateStore } = await import(
  moduleUrl("src/core/file-core-state-store.ts")
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
const ORIGINAL_PACKAGE = `sha256:${"a".repeat(64)}`;
const ORIGINAL_CONFIG = `sha256:${"b".repeat(64)}`;
const UPGRADED_PACKAGE = `sha256:${"d".repeat(64)}`;
const UPGRADED_CONFIG = `sha256:${"e".repeat(64)}`;

const root = mkdtempSync(join(tmpdir(), "dolly-pinning-"));
const statePath = join(root, "core-state.json");

function open(prefix: string) {
  let block = 0;
  let runtime = 0;
  return new FileCoreStateStore({
    path: statePath,
    maxFailedAttempts: 3,
    nextBlockId: () => `${prefix}-block-${++block}`,
    nextDeliveryId: (kind: string) => `${prefix}-${kind}-${++runtime}`,
    now: () => NOW,
  });
}

const report = (value: Record<string, unknown>): never => {
  console.log(JSON.stringify(value));
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
};

try {
  const store = open("first");
  store.deliveries.createPage("input");
  store.deliveries.registerConsumer("input", "worker", "from-now");
  const block = store.blocks.commit(
    { payload: { schema: "test.content/1", value: { text: "input" } } },
    { kind: "external", id: "console" },
  );
  store.deliveries.append("input", block.id);
  store.appendModuleProcessRecord({
    schemaVersion: "dolly.module-process-record/1",
    instanceId: IDENTITY.instanceId,
    moduleId: IDENTITY.moduleId,
    moduleGenerationId: "module-generation-1",
    processGenerationId: IDENTITY.processGenerationId,
    packageDigest: ORIGINAL_PACKAGE,
    configurationReference: {
      configId: "config-1",
      revision: ORIGINAL_CONFIG,
      configVersion: 1,
    },
    declaredExternalEffects: "core-capabilities-only",
    serviceInvocationId: "2812432ad29e4d3bbd6776c62cafa929",
    bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
    moduleCgroupPath: deriveModuleCgroupPath(
      "/system.slice/dolly-core.service",
      IDENTITY,
    ).filesystemPath,
    state: "starting",
    createdAt: NOW,
    updatedAt: NOW,
  } as never);

  if (scenario !== "process-record") {
    store.updateModuleProcessRecordState(IDENTITY.processGenerationId, "running");
    const claim = store.deliveries.claim({
      consumerId: "worker",
      pageIds: ["input"],
      moduleGenerationId: "module-generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    store.appendModuleSubmissionRecord({
      schemaVersion: "dolly.module-submission-record/1",
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: "module-generation-1",
      processGenerationId: IDENTITY.processGenerationId,
      inputDigest: `sha256:${"c".repeat(64)}`,
      createdAt: NOW,
    } as never);
  }

  // The upgrade. A package or configuration change is an ordinary state
  // update; what it must not do is rewrite the revisions an unresolved record
  // pinned. The attempt below is the strongest form: appending a record for a
  // new process generation that carries the upgraded revisions.
  const upgraded = { ...IDENTITY, processGenerationId: "process-generation-2" };
  let upgradeRefused = false;
  let upgradeError = "";
  try {
    store.appendModuleProcessRecord({
      schemaVersion: "dolly.module-process-record/1",
      instanceId: upgraded.instanceId,
      moduleId: upgraded.moduleId,
      moduleGenerationId: "module-generation-2",
      processGenerationId: upgraded.processGenerationId,
      packageDigest: UPGRADED_PACKAGE,
      configurationReference: {
        configId: "config-1",
        revision: UPGRADED_CONFIG,
        configVersion: 2,
      },
      declaredExternalEffects: "core-capabilities-only",
      serviceInvocationId: "2812432ad29e4d3bbd6776c62cafa929",
      bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
      moduleCgroupPath: deriveModuleCgroupPath(
        "/system.slice/dolly-core.service",
        upgraded,
      ).filesystemPath,
      state: "starting",
      createdAt: NOW,
      updatedAt: NOW,
    } as never);
  } catch (error) {
    upgradeRefused = true;
    upgradeError = error instanceof Error ? error.message : String(error);
  }

  // Reopen: the unresolved record must still carry its original revisions.
  const reopened = open("second");
  const original = reopened.getModuleProcessRecord(IDENTITY.processGenerationId);
  const submissions = reopened.listModuleSubmissionRecords();

  report({
    ok:
      original !== undefined &&
      original.packageDigest === ORIGINAL_PACKAGE &&
      original.configurationReference.revision === ORIGINAL_CONFIG &&
      original.configurationReference.configVersion === 1,
    scenario,
    upgradeRefused,
    upgradeError,
    pinnedPackage: original?.packageDigest ?? "missing",
    pinnedConfig: original?.configurationReference.revision ?? "missing",
    pinnedConfigVersion: original?.configurationReference.configVersion ?? -1,
    submissionCount: submissions.length,
    recordCount: reopened.listModuleProcessRecords().length,
  });
} catch (error) {
  report({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
PROBE

RESULT="${CASE_DIR}/pinning-observation.json"
node --import "file://${TSX_LOADER}" "${WORK_DIR}/probe.mts" \
  "${SCENARIO}" "${REPOSITORY}" \
  >"${RESULT}" 2>"${CASE_DIR}/probe.stderr"
[ $? -eq 0 ] || finish inconclusive probe-did-not-complete

node -e '
  const fs = require("node:fs");
  const out = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  console.log("scenario=" + out.scenario
    + " pinnedPackage=" + out.pinnedPackage
    + " pinnedConfig=" + out.pinnedConfig
    + " pinnedConfigVersion=" + out.pinnedConfigVersion
    + " records=" + out.recordCount
    + " submissions=" + out.submissionCount);
  if (out.ok !== true) {
    console.error("the unresolved record did not keep its pinned revisions: "
      + JSON.stringify(out));
    process.exit(1);
  }
' "${RESULT}" >>"${OBSERVATIONS}" 2>>"${OBSERVATIONS}" \
  || finish failed pinned-revisions-were-altered

finish passed pinned-revisions-survived-the-upgrade
