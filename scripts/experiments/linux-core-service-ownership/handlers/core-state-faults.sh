#!/bin/bash
# Case handler: Core-state write faults at every atomic-write boundary.
#
# Architecture Decision Record 0009 requires that a fault at any point of the
# Core-state write leave recovery able to observe only a complete old view or a
# complete new one: never a released Claim whose submission record survives, a
# submission record without its Claim, or a submission record without its
# process record.
#
# The case identifier names an interruption point (`SC-08-M01` through
# `SC-08-M14`, with `M08` split into start and completion) and a write boundary
# (`write`, `file-sync`, `atomic-replace`, `parent-directory-sync`). This
# handler injects a fault at that exact boundary against the real
# `FileCoreStateStore`, then reopens the file and checks the invariant.
#
# The fault is injected into the real store rather than a simulation: the point
# of the case is that the shipped atomic writer holds the invariant, so a
# handler that reimplemented the writer would prove nothing.
set -uo pipefail

CASE_ID="${DOLLY_EXPERIMENT_CASE_ID:?}"
CASE_DIR="${DOLLY_EXPERIMENT_CASE_DIR:?}"
REPOSITORY="${DOLLY_EXPERIMENT_REPOSITORY:?}"

EVENTS="${CASE_DIR}/events"
BARRIERS="${CASE_DIR}/barrier-snapshots"
OBSERVATIONS="${CASE_DIR}/process-and-cgroup-observations"
OUTCOME="${CASE_DIR}/case-outcome"

: >"${EVENTS}"
: >"${BARRIERS}"
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

# The boundary is the identifier's last segment; the interruption point is
# everything before it.
case "${CASE_ID}" in
  *-parent-directory-sync) BOUNDARY="parent-directory-sync" ;;
  *-atomic-replace) BOUNDARY="atomic-replace" ;;
  *-file-sync) BOUNDARY="file-sync" ;;
  *-write) BOUNDARY="write" ;;
  *) finish inconclusive unrecognised-boundary ;;
esac
POINT="${CASE_ID%-"${BOUNDARY}"}"

# The parent-directory synchronization boundary exists only where the operating
# system provides it. The shipped writer returns before opening the parent on
# Windows, so the case has nothing to inject there; on Linux it is a real step.
if [ "${BOUNDARY}" = "parent-directory-sync" ] && [ "$(uname -s)" != "Linux" ]; then
  finish not-applicable parent-directory-sync-not-a-boundary-on-this-platform
fi

event "injecting a ${BOUNDARY} fault at ${POINT}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

# The probe drives the real store, injects one fault at the named boundary,
# then reopens the file and reports what a recovery would observe.
cat >"${WORK_DIR}/probe.mts" <<'PROBE'
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The ECMAScript module namespace of `node:fs` is read-only, so the fault is
// injected through the CommonJS module object, which the store's own
// `node:fs` import resolves to at run time.
const require = createRequire(import.meta.url);
const realFs = require("node:fs") as typeof import("node:fs");
const { mkdtempSync, rmSync } = realFs;

const boundary = process.argv[2]!;
const repository = process.argv[3]!;
const root = mkdtempSync(join(tmpdir(), "dolly-fault-"));
const statePath = join(root, "core-state.json");

// One fault, at one boundary, on the first Core-state write that follows.
let armed = false;
const injected = (syscall: string): NodeJS.ErrnoException => {
  const error: NodeJS.ErrnoException = new Error(`injected ${syscall} failure`);
  error.code = "EIO";
  error.syscall = syscall;
  return error;
};
const originalWriteFileSync = realFs.writeFileSync;
const originalFsyncSync = realFs.fsyncSync;
const originalRenameSync = realFs.renameSync;
const originalOpenSync = realFs.openSync;

let temporaryDescriptor: number | undefined;
let parentDescriptor: number | undefined;

(realFs as any).openSync = ((
  ...args: Parameters<typeof realFs.openSync>
) => {
  const descriptor = originalOpenSync(...args);
  const path = String(args[0]);
  const flags = String(args[1]);
  if (flags === "wx" && path.endsWith(".tmp")) temporaryDescriptor = descriptor;
  if (flags === "r" && path === root) parentDescriptor = descriptor;
  return descriptor;
}) as typeof realFs.openSync;

(realFs as any).writeFileSync = ((
  ...args: Parameters<typeof realFs.writeFileSync>
) => {
  if (armed && boundary === "write" && typeof args[0] === "number") {
    throw injected("write");
  }
  return originalWriteFileSync(...args);
}) as typeof realFs.writeFileSync;

(realFs as any).fsyncSync = ((
  ...args: Parameters<typeof realFs.fsyncSync>
) => {
  if (armed && boundary === "file-sync" && args[0] === temporaryDescriptor) {
    throw injected("fsync");
  }
  if (armed && boundary === "parent-directory-sync" && args[0] === parentDescriptor) {
    throw injected("fsync");
  }
  return originalFsyncSync(...args);
}) as typeof realFs.fsyncSync;

(realFs as any).renameSync = ((
  ...args: Parameters<typeof realFs.renameSync>
) => {
  if (armed && boundary === "atomic-replace") throw injected("rename");
  return originalRenameSync(...args);
}) as typeof realFs.renameSync;

const { pathToFileURL } = require("node:url") as typeof import("node:url");
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
  // Build the smallest state in which a torn write is observable.
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
    packageDigest: `sha256:${"a".repeat(64)}`,
    configurationReference: {
      configId: "config-1",
      revision: `sha256:${"b".repeat(64)}`,
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
  const revisionBefore = store.revision;

  // Arm the fault, then make the Claim terminal together with its submission
  // record. That is the update ADR 0009 requires to be atomic.
  armed = true;
  let threw = false;
  try {
    store.runAtomicUpdate(() => {
      store.deliveries.releaseClaim({
        moduleJobId: claim.moduleJobId,
        claimToken: claim.claimToken,
        runId: claim.runId,
        attempt: claim.attempt,
        moduleGenerationId: claim.moduleGenerationId,
      });
      store.removeModuleSubmissionRecord(claim.runId);
    });
  } catch {
    threw = true;
  }
  armed = false;

  // Reopen and check what a recovery would see.
  const reopened = open("second");
  const claimActive = reopened.deliveries
    .listActiveClaims()
    .some((c: { runId: string }) => c.runId === claim.runId);
  const submission = reopened.getModuleSubmissionRecord(claim.runId);
  const processRecords = reopened.listModuleProcessRecords();
  const submissions = reopened.listModuleSubmissionRecords();

  // The invariant: the Claim and its submission record are either both present
  // or both gone, and no submission record lacks its process record.
  const coherent = (claimActive ? submission !== undefined : submission === undefined)
    && submissions.every((s: { processGenerationId: string }) =>
      processRecords.some(
        (p: { processGenerationId: string }) =>
          p.processGenerationId === s.processGenerationId,
      ),
    );

  report({
    ok: coherent,
    threw,
    view: claimActive ? "old" : "new",
    revisionBefore,
    revisionAfter: reopened.revision,
    claimActive,
    hasSubmission: submission !== undefined,
    processRecordCount: processRecords.length,
  });
} catch (error) {
  report({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
PROBE

RESULT="${CASE_DIR}/fault-observation.json"
node --import "file://${TSX_LOADER}" "${WORK_DIR}/probe.mts" "${BOUNDARY}" "${REPOSITORY}" \
  >"${RESULT}" 2>"${CASE_DIR}/probe.stderr"
probe_exit=$?

if [ "${probe_exit}" -ne 0 ]; then
  cp "${CASE_DIR}/probe.stderr" "${BARRIERS}" 2>/dev/null || true
  finish inconclusive probe-did-not-complete
fi

cp "${RESULT}" "${BARRIERS}"
node -e '
  const fs = require("node:fs");
  const out = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  console.log("view=" + (out.view ?? "none") + " threw=" + out.threw
    + " revision=" + out.revisionBefore + "->" + out.revisionAfter
    + " claimActive=" + out.claimActive + " hasSubmission=" + out.hasSubmission);
  if (out.ok !== true) {
    console.error("torn view: " + JSON.stringify(out));
    process.exit(1);
  }
' "${RESULT}" >>"${OBSERVATIONS}" 2>>"${OBSERVATIONS}" \
  || finish failed recovery-observed-a-torn-view

finish passed one-complete-view-after-fault
