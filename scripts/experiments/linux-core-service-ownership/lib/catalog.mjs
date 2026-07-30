#!/usr/bin/env node
// Case catalog for the preregistered experiment
// `docs/experiments/linux-core-service-process-ownership.md` (protocol version 3).
//
// This file enumerates every case the protocol requires. It performs no
// input/output of its own except printing the catalog, so the enumeration can be
// reviewed and diffed against the protocol text without running anything.
//
// Every case carries a `source` field naming the exact protocol or Architecture
// Decision Record (ADR) clause it comes from, so a reviewer can check the
// enumeration against the documents clause by clause.
//
// Usage:
//   node catalog.mjs --format json      complete catalog as one JSON document
//   node catalog.mjs --format tsv       one tab-separated line per case
//   node catalog.mjs --format counts    per-group counts and source mapping
// Filters (repeatable, applied in order): --group ID, --arm ID,
//   --non-disruptive-only, --id-prefix PREFIX, --exclude-id ID
//
// `--exclude-id` is applied after the selecting filters, so it removes cases
// they selected. It narrows coverage, so the manifest and the summary record
// which identifiers were dropped and whether the selection was complete.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const EXPERIMENT_ID = "linux-core-service-process-ownership";
export const PROTOCOL_VERSION = 3;
// Version 2, 2026-07-26: amendment 1 splits the live-core-termination proof
// requirement by membership phase. See LIVE_CORE_PROOF_REQUIREMENT below.
// Results carrying catalogue version 1 were judged against the superseded
// single requirement and must not be merged with version 2 results for the
// live-core-termination group. Every other group is unchanged.
//
// Version 3, 2026-07-26: amendment 2 adds an `exclusive` property, set from
// EXCLUSIVE_CASE_IDS below. This records how a case must be run, not what
// counts as passing it. No pass criterion changed, so version 2 and version 3
// results remain directly comparable; the version moves only so that a reader
// can tell which catalogue produced a result.
//
// Version 4, 2026-07-30: removes the stale `status: "not-implemented"` field.
// Handler availability is measured by the runner and recorded in the result
// ledger; the catalog cannot know it without inspecting the filesystem. Case
// selection and pass criteria are unchanged, so versions 3 and 4 remain
// directly comparable.
export const CATALOG_VERSION = 4;

// The protocol does not fix the signal used to terminate Core at an
// interruption point. Hypothesis 2 names the non-catchable `SIGKILL`, which is
// the strictest case, so the catalog uses it by default. The runner can widen
// this; the manifest always records what was used.
export const DEFAULT_TERMINATION_SIGNALS = ["SIGKILL"];

// The twelve strict invariants from the protocol's "Required outcomes" section.
export const INVARIANTS = [
  { id: "INV-01", statement: "maximum concurrent live process generations for one Module: one" },
  { id: "INV-02", statement: "output Blocks or Deliveries committed more than once: zero" },
  { id: "INV-03", statement: "an unknown Extension or capability outcome automatically retried: zero" },
  { id: "INV-04", statement: "a Module started outside the validated Core service: zero" },
  {
    id: "INV-05",
    statement:
      "a Module automatically activated without the declared Core-capability-only " +
      "external-effect configuration: zero",
  },
  {
    id: "INV-06",
    statement: "a replacement started before proof that the old process control group is empty: zero",
  },
  { id: "INV-07", statement: "a signal sent using only a recovered process identifier: zero" },
  {
    id: "INV-08",
    statement:
      "a Core recovery that starts Module work before reconciling the Claim, submission record, " +
      "and result commit journal: zero",
  },
  { id: "INV-09", statement: "undeclared environment values observed by the Extension: zero" },
  { id: "INV-10", statement: "limit bypasses in the selected isolation mode: zero" },
  { id: "INV-11", statement: "unreconciled strong references or access leases after terminal cleanup: zero" },
  {
    id: "INV-12",
    statement:
      "test services, processes, sockets, control groups, or temporary records left after " +
      "harness cleanup: zero",
  },
];

const ALL_INVARIANTS = INVARIANTS.map((invariant) => invariant.id);

// Artifact kinds from the protocol's "Artifacts" section. A case whose run does
// not retain every artifact it declares is inconclusive, never passing.
const ARTIFACTS = {
  events: "events",
  barriers: "barrier-snapshots",
  observations: "process-and-cgroup-observations",
  outcome: "case-outcome",
};

const INTERRUPTION_ARTIFACTS = [
  ARTIFACTS.events,
  ARTIFACTS.barriers,
  ARTIFACTS.observations,
  ARTIFACTS.outcome,
];
const PLAIN_ARTIFACTS = [ARTIFACTS.events, ARTIFACTS.observations, ARTIFACTS.outcome];

// The fourteen durable boundaries of the fixed interruption matrix, in protocol
// order. Boundary 8 names two distinct moments, so it expands into two phases;
// every other boundary is a single moment.
const BOUNDARIES = [
  { id: "M01", title: "service configuration validation for Core and Core readiness" },
  { id: "M02", title: "Module process record creation" },
  { id: "M03", title: "delegated control group creation and limit application" },
  { id: "M04", title: "Extension process creation and readiness" },
  { id: "M05", title: "Delivery Claim persistence" },
  { id: "M06", title: "Module submission record persistence" },
  { id: "M07", title: "`module.execute` protocol send" },
  { id: "M08", title: "each capability request start and completion", phases: ["start", "completion"] },
  { id: "M09", title: "Extension result receipt persistence" },
  { id: "M10", title: "Core result commit preparation" },
  { id: "M11", title: "Block commit" },
  { id: "M12", title: "every output Delivery append" },
  { id: "M13", title: "positive acknowledgement" },
  { id: "M14", title: "Module process record closure and collection" },
];

// The protocol repeats cases "with delayed sends or process exit races" 100
// times across ten fixed seeds. These are the boundaries where such a race
// exists: child creation and readiness, the protocol send, and process record
// closure after child exit. The choice is recorded here so a reviewer can
// challenge it rather than having to infer it from the code.
const RACE_BOUNDARIES = new Set(["M04", "M07", "M14"]);
const RACE_REPETITION = { iterations: 100, seedCount: 10 };

// The seven workload variants each interruption must run with at least once.
const WORKLOADS = [
  { id: "no-output", title: "no output" },
  { id: "single-output", title: "one output" },
  { id: "multiple-output-pages", title: "multiple output Pages" },
  { id: "processor-loop", title: "a processor loop" },
  { id: "process-descendant", title: "a process descendant" },
  { id: "active-capability-handler", title: "an active capability handler" },
  { id: "unknown-external-effect", title: "a result whose external effect outcome is unknown" },
];

const TIMINGS = ["before", "after"];

// The proposed design and the two deliberately limited baselines. Only the
// proposed arm must satisfy the strict invariants; a baseline that fails one is
// a recorded comparison observation, not an experiment failure.
const ARMS = {
  proposed: {
    id: "proposed",
    title: "Core is the main process of a stable per-instance systemd service",
    enforcesInvariants: true,
  },
  baselineDirectChild: {
    id: "baseline-direct-child",
    title: "current direct child ExtensionProcessHost outside a validated stable service",
    enforcesInvariants: false,
  },
  baselineTransientUnit: {
    id: "baseline-transient-unit",
    title: "rejected per-generation transient systemd service from ADR 0008",
    enforcesInvariants: false,
  },
};

function boundaryPhases(boundary) {
  return boundary.phases ?? [null];
}

function boundaryKey(boundary, phase) {
  return phase === null ? boundary.id : `${boundary.id}.${phase}`;
}

function fixedMatrixCases(arm, signals) {
  const cases = [];
  for (const boundary of BOUNDARIES) {
    for (const phase of boundaryPhases(boundary)) {
      for (const timing of TIMINGS) {
        for (const workload of WORKLOADS) {
          for (const signal of signals) {
            const key = boundaryKey(boundary, phase);
            const signalSuffix = signals.length > 1 ? `-${signal.toLowerCase()}` : "";
            cases.push({
              id: `FM-${key}-${timing}-${workload.id}${signalSuffix}-${arm.id}`,
              group: "fixed-interruption-matrix",
              handler: arm.id === "proposed" ? "fixed-interruption" : arm.id,
              arm: arm.id,
              source: `experiment-v3:fixed-interruption-matrix#${Number(boundary.id.slice(1))}`,
              boundary: key,
              boundaryTitle: boundary.title,
              boundaryPhase: phase,
              timing,
              workload: workload.id,
              terminationSignal: signal,
              description:
                `terminate Core ${timing} ${boundary.title}` +
                (phase === null ? "" : ` (${phase})`) +
                ` with ${workload.title}, ${arm.title}`,
              disruptive: false,
              disruptiveReason: null,
              enforcesInvariants: arm.enforcesInvariants,
              invariants: ALL_INVARIANTS,
              requiredArtifacts: INTERRUPTION_ARTIFACTS,
              repetition: RACE_BOUNDARIES.has(boundary.id) ? RACE_REPETITION : null,
              timeoutSeconds: 180,
            });
          }
        }
      }
    }
  }
  return cases;
}

// One entry per case that the protocol lists outside the fixed matrix. `source`
// gives the clause; `separate-cases#N` counts the bullets of the protocol's
// "Separate cases" list in document order.
/**
 * Cases that destroy something the rest of a run needs, so they may not share a
 * run with any other case.
 *
 * `SC-03-02-user-manager-restart` ends the systemd user manager, which is its
 * own event under test. An unprivileged account cannot bring
 * `user@<uid>.service` back, so every later case in the same run fails to reach
 * the bus and reports a cause that has nothing to do with what it was testing.
 * That is worse than a failure: it is a run full of misattributed failures.
 *
 * This property lives here rather than in a handler comment because a rule the
 * runner does not enforce is a rule that will be broken, and the resulting
 * evidence looks like ordinary failures rather than like a mistake.
 */
const EXCLUSIVE_CASE_IDS = new Set(["SC-03-02-user-manager-restart"]);

const SEPARATE_CASE_SPECS = [
  // Bullet 1: attempted Module startup outside a validated Core service.
  {
    group: "service-binding",
    handler: "service-binding",
    source: "experiment-v3:separate-cases#1",
    cases: [
      ["no-service", "start a Module from a plain process with no systemd service at all"],
      [
        "manager-pid-mismatch",
        "start a Module when the manager-reported main process identifier is not Core's own",
        "adr-0009:stable-core-service-lifecycle",
      ],
      [
        "cgroup-path-mismatch",
        "start a Module when /proc/self/cgroup does not match the manager control group plus the delegated subgroup",
        "adr-0009:stable-core-service-lifecycle",
      ],
    ],
  },
  // Bullet 2: effective configuration differing from the required configuration.
  {
    group: "service-configuration",
    handler: "service-configuration",
    source: "experiment-v3:separate-cases#2",
    cases: [
      ["restart-policy-absent", "effective Restart is not on-failure"],
      ["restart-limit-infinite", "effective restart limit is not finite"],
      ["kill-mode-not-control-group", "effective KillMode is not control-group"],
      ["send-sigkill-disabled", "effective SendSIGKILL is no"],
      ["timeout-stop-infinite", "effective TimeoutStopSec is infinite"],
      ["delegate-disabled", "effective Delegate is no"],
      ["delegate-subgroup-absent", "effective DelegateSubgroup is unset"],
      ["cgroup-v1", "the service manager provides control group version 1"],
      ["controller-missing", "a required cpu, memory, or pids controller is not delegated"],
      ["exit-type-cgroup", "effective ExitType is cgroup"],
      ["restart-mode-direct", "effective RestartMode is direct"],
      ["remain-after-exit", "effective RemainAfterExit is yes"],
      ["success-exit-status-override", "a restart-status override treats a forced Core exit as successful"],
      ["restart-prevent-exit-status-override", "a restart-status override prevents the required restart"],
      ["pass-environment-set", "the service environment is not minimal because PassEnvironment is set"],
      ["environment-file-set", "the service environment is not minimal because EnvironmentFile is set"],
    ],
  },
  // Bullet 3: service manager, session, and machine lifecycle events.
  {
    group: "lifecycle",
    handler: "lifecycle",
    source: "experiment-v3:separate-cases#3",
    cases: [
      ["core-service-restart", "restart the Core service itself"],
      ["user-manager-restart", "restart the systemd user manager", null, "user-manager-termination"],
      ["login-end-with-lingering", "end the last login session with lingering enabled", null, "login-termination"],
      ["login-end-without-lingering", "end the last login session without lingering", null, "login-termination"],
      ["machine-reboot", "reboot the machine and recover", null, "reboot"],
      [
        "same-boot-missing-cgroup-path",
        "recover within the same boot when the old Module control group path is missing",
        "adr-0009:required-failure-tests#4",
      ],
      [
        "changed-boot-identifier",
        "recover when the Linux boot identifier has changed",
        "adr-0009:required-failure-tests#4",
      ],
    ],
  },
  // Bullet 4: exhaustion of the finite service restart limit.
  {
    group: "restart-limit",
    handler: "restart-limit",
    source: "experiment-v3:separate-cases#4",
    cases: [
      [
        "exhaust-finite-restart-limit",
        "exhaust the finite restart limit and require a visibly failed service with Modules disabled",
      ],
    ],
  },
  // Bullet 5: process identifier reuse pressure.
  {
    group: "pid-reuse",
    handler: "pid-reuse",
    source: "experiment-v3:separate-cases#5",
    cases: [
      [
        "identifier-reuse-pressure",
        "apply process identifier reuse pressure and require that no signal is ever sent by a recovered identifier",
        null,
        "hostile-resource",
      ],
    ],
  },
  // Bullet 6: attempted reuse of a generation identifier or control group path.
  {
    group: "identifier-reuse",
    handler: "identifier-reuse",
    source: "experiment-v3:separate-cases#6",
    cases: [
      ["process-generation-identifier-reuse", "attempt to reuse a process-generation identifier"],
      ["module-cgroup-path-reuse", "attempt to reuse a Module control group path"],
    ],
  },
  // Bullet 7: package or configuration upgrade with unresolved records.
  {
    group: "upgrade-pinning",
    handler: "upgrade-pinning",
    source: "experiment-v3:separate-cases#7",
    cases: [
      ["package-upgrade-unresolved-process-record", "upgrade the package while a process record is unresolved", null, "privilege"],
      [
        "package-upgrade-unresolved-submission-record",
        "upgrade the package while a submission record is unresolved",
        null,
        "privilege",
      ],
      ["configuration-upgrade-unresolved-run", "upgrade the configuration while a Run is unresolved", null, "privilege"],
    ],
  },
  // Bullet 9: capability effect-intent and idempotency evidence across a crash.
  {
    group: "capability-idempotency",
    handler: "capability-idempotency",
    source: "experiment-v3:separate-cases#9",
    cases: [
      ["effect-intent-survives-crash", "an effect intent persisted before input/output survives a Core crash"],
      ["idempotency-key-linked-to-claim", "idempotency evidence stays linked to the exact Claim and Run across a crash"],
      ["in-memory-duplicate-map-rejected", "an in-memory duplicate map is rejected as restart evidence"],
      ["unknown-outcome-queried-not-retried", "an unknown remote outcome is queried rather than automatically retried"],
      ["crash-before-remote-acceptance", "crash before the remote operation is accepted", "adr-0009:required-failure-tests#9"],
      ["crash-after-remote-acceptance", "crash after the remote operation is accepted", "adr-0009:required-failure-tests#9"],
      ["crash-after-lost-response", "crash after the remote response is lost", "adr-0009:required-failure-tests#9"],
    ],
  },
  // Bullet 10: refusal to activate without the external-effect declaration.
  {
    group: "effect-declaration",
    handler: "effect-declaration",
    source: "experiment-v3:separate-cases#10",
    cases: [
      ["declaration-absent", "refuse automatic activation when the configuration declares no external-effect boundary"],
      [
        "direct-effect-authority-declared",
        "refuse automatic activation and recovery for an Extension with direct filesystem, network, or subprocess authority",
        "adr-0009:module-process-control",
      ],
    ],
  },
  // Bullet 11: executable paths containing spaces and variable-like text.
  {
    group: "executable-paths",
    handler: "executable-paths",
    source: "experiment-v3:separate-cases#11",
    cases: [
      ["path-with-spaces", "an executable path containing spaces"],
      ["path-with-variable-like-text", "an executable path containing literal ${...} text"],
    ],
  },
  // Bullet 12: inherited environment sentinel values.
  {
    group: "environment-sentinels",
    handler: "environment-sentinels",
    source: "experiment-v3:separate-cases#12",
    cases: [
      ["user-manager-sentinel", "a sentinel placed in the user manager environment is not observed by the Extension"],
      ["service-manager-sentinel", "a sentinel placed in the service manager environment is not observed by the Node.js runtime"],
      ["extension-minimal-environment", "the Extension observes only the declared minimal environment"],
    ],
  },
  // Bullet 13: unavailable dependencies failing closed.
  {
    group: "dependency-unavailable",
    handler: "dependency-unavailable",
    source: "experiment-v3:separate-cases#13",
    cases: [
      ["systemd-unavailable", "the systemd service manager is unavailable", null, "privilege"],
      ["delegation-unavailable", "control group delegation is unavailable"],
      ["controller-unavailable", "a required control group controller is unavailable", null, "privilege"],
      ["state-store-unavailable", "the Core state store is unavailable"],
      ["protocol-channel-unavailable", "the Extension protocol channel is unavailable"],
      ["durable-records-corrupt", "durable Module records are corrupt", "adr-0009:required-failure-tests#7"],
      ["cleanup-timeout", "the finite cleanup timeout expires", "adr-0009:required-failure-tests#7"],
      [
        "python3-interpreter-absent",
        "the Python 3 interpreter required by the child launcher is absent",
        "adr-0009:platform-and-migration-impact",
      ],
    ],
  },
  // Bullet 14: untrusted sandbox fixture escape attempts.
  {
    group: "sandbox-escape",
    handler: "sandbox-escape",
    source: "experiment-v3:separate-cases#14",
    disruptiveReason: "hostile-resource",
    cases: [
      ["change-own-cgroup", "the fixture attempts to change its own control group"],
      ["leave-own-cgroup", "the fixture attempts to leave its control group"],
      ["change-own-limits", "the fixture attempts to change its limits"],
      ["signal-core", "the fixture attempts to signal Core"],
      ["open-core-state", "the fixture attempts to open Core state files"],
      ["open-manager-control-files", "the fixture attempts to open service-manager control files"],
      ["read-other-process-proc-state", "the fixture attempts to read another process's state through /proc"],
      ["use-inherited-descriptor", "the fixture attempts to use a retained inherited descriptor"],
      ["ambient-filesystem-authority", "the fixture attempts ambient filesystem authority", "adr-0009:required-failure-tests#6"],
      ["ambient-network-authority", "the fixture attempts ambient network authority", "adr-0009:required-failure-tests#6"],
      ["ambient-subprocess-authority", "the fixture attempts ambient subprocess authority", "adr-0009:required-failure-tests#6"],
    ],
  },
];

// Bullet 8 of the "Separate cases" list: storage faults injected at each
// boundary. It is generated rather than listed because it is the product of
// four fault kinds and every boundary of the fixed matrix.
const STORAGE_FAULT_KINDS = [
  { id: "write", title: "Core-state write fault" },
  { id: "file-sync", title: "file synchronization fault" },
  { id: "atomic-replace", title: "atomic replacement fault" },
  { id: "parent-directory-sync", title: "parent directory synchronization fault" },
];

function storageFaultCases() {
  const cases = [];
  for (const boundary of BOUNDARIES) {
    for (const phase of boundaryPhases(boundary)) {
      for (const fault of STORAGE_FAULT_KINDS) {
        const key = boundaryKey(boundary, phase);
        cases.push({
          id: `SC-08-${key}-${fault.id}`,
          group: "core-state-faults",
          handler: "core-state-faults",
          arm: ARMS.proposed.id,
          source: "experiment-v3:separate-cases#8",
          boundary: key,
          boundaryTitle: boundary.title,
          boundaryPhase: phase,
          timing: null,
          workload: null,
          terminationSignal: null,
          description:
            `inject a ${fault.title} at ${boundary.title}` +
            (phase === null ? "" : ` (${phase})`) +
            ", requiring recovery of only a complete old or complete new Claim, process, and submission view",
          disruptive: false,
          disruptiveReason: null,
          enforcesInvariants: true,
          invariants: ALL_INVARIANTS,
          requiredArtifacts: INTERRUPTION_ARTIFACTS,
          repetition: null,
          timeoutSeconds: 180,
        });
      }
    }
  }
  return cases;
}

// Hypothesis 5 requires every limit to be enforced at the real operating system
// boundary, and ADR 0009 required failure test 6 names them. The protocol's
// "Separate cases" list does not repeat them, so they are their own group.
const RESOURCE_LIMIT_SPECS = [
  ["memory", "the memory limit is enforced by memory.max with memory.oom.group", "hostile-resource"],
  ["process-count", "the process count limit is enforced by pids.max", "hostile-resource"],
  ["processor-rate", "the processor rate limit is enforced by cpu.max", "hostile-resource"],
  ["open-files", "the open file limit is enforced by the launcher-set RLIMIT_NOFILE", null],
  ["protocol-frame", "the Core-enforced protocol frame limit is enforced", null],
  ["result-size", "the Core-enforced result size limit is enforced", null],
  ["elapsed-time", "the finite wall-clock deadline ends the whole control group", null],
];

// ADR 0009 required failure test 3 covers termination while Core stays alive.
// The experiment protocol's fixed matrix only terminates Core, so this group is
// sourced from the ADR alone and is reported as a protocol coverage gap.
const LIVE_CORE_OPERATIONS = [
  ["hard-timeout", "an ordinary hard timeout"],
  ["orderly-stop", "an orderly stop"],
  ["failure-cleanup", "failure cleanup"],
  ["replacement", "starting a replacement generation"],
];
const LIVE_CORE_MEMBERSHIP = [
  ["before-membership", "before launcher control group membership is verified"],
  ["after-membership", "after launcher control group membership is verified"],
];
const LIVE_CORE_DESCENDANT = [
  ["no-descendant", "before the Extension forks a descendant"],
  ["with-descendant", "after the Extension forks a descendant"],
];

function separateCases() {
  const cases = [];
  for (const spec of SEPARATE_CASE_SPECS) {
    const bulletNumber = spec.source.split("#")[1];
    spec.cases.forEach((entry, index) => {
      const [slug, description, extraSource, disruptiveReason] = entry;
      const reason = disruptiveReason ?? spec.disruptiveReason ?? null;
      cases.push({
        id: `SC-${String(bulletNumber).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}-${slug}`,
        group: spec.group,
        handler: spec.handler,
        arm: ARMS.proposed.id,
        source: extraSource ? `${spec.source}+${extraSource}` : spec.source,
        boundary: null,
        boundaryTitle: null,
        boundaryPhase: null,
        timing: null,
        workload: null,
        terminationSignal: null,
        description,
        disruptive: reason !== null,
        disruptiveReason: reason,
        enforcesInvariants: true,
        invariants: ALL_INVARIANTS,
        requiredArtifacts: PLAIN_ARTIFACTS,
        repetition: null,
        timeoutSeconds: 300,
      });
    });
  }
  return cases;
}

function resourceLimitCases() {
  return RESOURCE_LIMIT_SPECS.map(([slug, description, disruptiveReason], index) => ({
    id: `LM-${String(index + 1).padStart(2, "0")}-${slug}`,
    group: "resource-limits",
    handler: "resource-limits",
    arm: ARMS.proposed.id,
    source: "experiment-v3:hypotheses#5+adr-0009:required-failure-tests#6",
    boundary: null,
    boundaryTitle: null,
    boundaryPhase: null,
    timing: null,
    workload: null,
    terminationSignal: null,
    description,
    disruptive: disruptiveReason !== null,
    disruptiveReason,
    enforcesInvariants: true,
    invariants: ALL_INVARIANTS,
    requiredArtifacts: PLAIN_ARTIFACTS,
    repetition: null,
    timeoutSeconds: 300,
  }));
}

/**
 * Amendment 1, 2026-07-26. The single proof requirement below originally read
 * "requiring control-group-level termination proven by populated 0" for all
 * sixteen cases. That is not satisfiable before launcher membership is
 * verified, and not by accident: `ModuleCgroup.terminate()` refuses to run
 * there with `MODULE_CGROUP_MEMBERSHIP_UNOBSERVED`, because a `populated 0`
 * read at that point only repeats the group's pre-membership state and proves
 * nothing. Architecture Decision Record 0009 argues the same. Demanding a
 * proof the design deliberately rejects as a false positive is worse than
 * demanding none.
 *
 * The requirement is therefore split by phase. The replacement is not weaker:
 * the pre-membership half must additionally show that the false-positive proof
 * was refused, which turns that design decision into a tested invariant. If
 * someone later lets the pre-membership phase report `populated 0`, these
 * cases must fail.
 *
 * This amendment is recorded here, in the pre-registered catalogue, rather
 * than in a handler. A criterion that the party running the cases can rewrite
 * when the cases fail is not a pre-registered criterion.
 */
const LIVE_CORE_PROOF_REQUIREMENT = {
  "after-membership":
    "requiring control-group-level termination proven by populated 0",
  "before-membership":
    "requiring the launcher control descriptor path, an observed launcher exit, " +
    "coreMustExit false, and later removal of the group, and requiring that a " +
    "populated 0 proof was refused for this phase rather than reported",
};

function liveCoreCases() {
  const cases = [];
  for (const [operation, operationTitle] of LIVE_CORE_OPERATIONS) {
    for (const [membership, membershipTitle] of LIVE_CORE_MEMBERSHIP) {
      for (const [descendant, descendantTitle] of LIVE_CORE_DESCENDANT) {
        cases.push({
          id: `LC-${operation}-${membership}-${descendant}`,
          group: "live-core-termination",
          handler: "live-core-termination",
          arm: ARMS.proposed.id,
          source: "adr-0009:required-failure-tests#3",
          boundary: null,
          boundaryTitle: null,
          boundaryPhase: null,
          timing: null,
          workload: null,
          terminationSignal: null,
          description:
            `${operationTitle} while Core stays alive, ${membershipTitle}, ${descendantTitle}, ` +
            LIVE_CORE_PROOF_REQUIREMENT[membership],
          disruptive: false,
          disruptiveReason: null,
          enforcesInvariants: true,
          invariants: ALL_INVARIANTS,
          requiredArtifacts: [ARTIFACTS.events, ARTIFACTS.observations, ARTIFACTS.outcome],
          repetition: null,
          timeoutSeconds: 240,
        });
      }
    }
  }
  return cases;
}

function baselineTransientUnitCase() {
  return {
    id: "BL-transient-unit-delayed-creation",
    group: "baseline-transient-unit",
    handler: ARMS.baselineTransientUnit.id,
    arm: ARMS.baselineTransientUnit.id,
    source: "experiment-v3:baselines",
    boundary: null,
    boundaryTitle: null,
    boundaryPhase: null,
    timing: null,
    workload: null,
    terminationSignal: null,
    description:
      "deterministic delayed creation reproduction against the rejected per-generation transient " +
      "systemd service from ADR 0008, used only as a reproduction and never as a fallback",
    disruptive: false,
    disruptiveReason: null,
    enforcesInvariants: false,
    invariants: ALL_INVARIANTS,
    requiredArtifacts: PLAIN_ARTIFACTS,
    repetition: RACE_REPETITION,
    timeoutSeconds: 300,
  };
}

export function buildCatalog(options = {}) {
  const signals = options.terminationSignals ?? DEFAULT_TERMINATION_SIGNALS;
  const cases = [
    ...fixedMatrixCases(ARMS.proposed, signals),
    ...fixedMatrixCases(ARMS.baselineDirectChild, signals),
    baselineTransientUnitCase(),
    ...separateCases(),
    ...storageFaultCases(),
    ...resourceLimitCases(),
    ...liveCoreCases(),
  ];

  const seen = new Set();
  for (const entry of cases) {
    if (seen.has(entry.id)) {
      throw new Error(`duplicate case identifier: ${entry.id}`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.id)) {
      throw new Error(`unsafe case identifier: ${entry.id}`);
    }
    seen.add(entry.id);
    entry.exclusive = EXCLUSIVE_CASE_IDS.has(entry.id);
  }
  for (const id of EXCLUSIVE_CASE_IDS) {
    if (!seen.has(id)) {
      throw new Error(`unknown exclusive case identifier: ${id}`);
    }
  }

  return {
    experiment: EXPERIMENT_ID,
    protocolVersion: PROTOCOL_VERSION,
    catalogVersion: CATALOG_VERSION,
    terminationSignals: signals,
    arms: Object.values(ARMS),
    invariants: INVARIANTS,
    raceBoundaries: [...RACE_BOUNDARIES],
    raceRepetition: RACE_REPETITION,
    cases,
  };
}

export function filterCases(cases, filters) {
  let result = cases;
  if (filters.groups.length > 0) {
    result = result.filter((entry) => filters.groups.includes(entry.group));
  }
  if (filters.arms.length > 0) {
    result = result.filter((entry) => filters.arms.includes(entry.arm));
  }
  if (filters.idPrefix !== null) {
    result = result.filter((entry) => entry.id.startsWith(filters.idPrefix));
  }
  // Exclusion is applied last so it removes cases the other filters selected,
  // never the reverse. It narrows coverage, so every consumer records it.
  if (filters.excludeIds !== undefined && filters.excludeIds.length > 0) {
    result = result.filter((entry) => !filters.excludeIds.includes(entry.id));
  }
  if (filters.nonDisruptiveOnly) {
    result = result.filter((entry) => !entry.disruptive);
  }
  return result;
}

function parseArguments(argv) {
  const filters = {
    groups: [],
    arms: [],
    idPrefix: null,
    excludeIds: [],
    nonDisruptiveOnly: false,
  };
  let format = "json";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--format") {
      format = argv[index + 1];
      index += 1;
    } else if (argument === "--group") {
      filters.groups.push(argv[index + 1]);
      index += 1;
    } else if (argument === "--arm") {
      filters.arms.push(argv[index + 1]);
      index += 1;
    } else if (argument === "--exclude-id") {
      filters.excludeIds.push(argv[index + 1]);
      index += 1;
    } else if (argument === "--id-prefix") {
      filters.idPrefix = argv[index + 1];
      index += 1;
    } else if (argument === "--non-disruptive-only") {
      filters.nonDisruptiveOnly = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return { format, filters };
}

function printCounts(catalog, cases) {
  const byGroup = new Map();
  const bySource = new Map();
  for (const entry of cases) {
    byGroup.set(entry.group, (byGroup.get(entry.group) ?? 0) + 1);
    for (const source of entry.source.split("+")) {
      bySource.set(source, (bySource.get(source) ?? 0) + 1);
    }
  }
  process.stdout.write(`experiment\t${catalog.experiment}\n`);
  process.stdout.write(`protocol_version\t${catalog.protocolVersion}\n`);
  process.stdout.write(`total_cases\t${cases.length}\n`);
  const disruptive = cases.filter((entry) => entry.disruptive).length;
  process.stdout.write(`non_disruptive_cases\t${cases.length - disruptive}\n`);
  process.stdout.write(`disruptive_cases\t${disruptive}\n`);
  const repeated = cases.filter((entry) => entry.repetition !== null);
  const plannedExecutions = cases.reduce(
    (total, entry) => total + (entry.repetition === null ? 1 : entry.repetition.iterations),
    0,
  );
  process.stdout.write(`repeated_cases\t${repeated.length}\n`);
  process.stdout.write(`planned_executions\t${plannedExecutions}\n`);
  for (const [group, count] of [...byGroup].sort()) {
    process.stdout.write(`group\t${group}\t${count}\n`);
  }
  for (const [source, count] of [...bySource].sort()) {
    process.stdout.write(`source\t${source}\t${count}\n`);
  }
}

function main() {
  const { format, filters } = parseArguments(process.argv.slice(2));
  const catalog = buildCatalog();
  const cases = filterCases(catalog.cases, filters);
  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ ...catalog, cases }, null, 2)}\n`);
  } else if (format === "tsv") {
    for (const entry of cases) {
      process.stdout.write(
        [
          entry.id,
          entry.group,
          entry.handler,
          entry.arm,
          entry.timeoutSeconds,
          entry.disruptive ? "disruptive" : "non-disruptive",
          entry.requiredArtifacts.join(","),
          entry.repetition === null ? 1 : entry.repetition.iterations,
        ].join("\t") + "\n",
      );
    }
  } else if (format === "counts") {
    printCounts(catalog, cases);
  } else {
    throw new Error(`unknown format: ${format}`);
  }
}

// The invoked path is resolved before it is compared, because Node reports the
// module's real path in `import.meta.url` while `process.argv[1]` keeps the
// path the caller typed. The disposable container runs the experiment from a
// symbolically linked work tree, so those two disagree there and this guard
// silently declined to run: the process printed nothing, exited successfully,
// and every caller parsing its output failed instead. A guard that turns "run
// as a program" into "produce no output and succeed" is worse than one that
// crashes, so it is compared on resolved paths.
const invokedPath = process.argv[1];
let invokedHref;
if (invokedPath) {
  try {
    invokedHref = pathToFileURL(realpathSync(invokedPath)).href;
  } catch {
    invokedHref = pathToFileURL(invokedPath).href;
  }
}
if (invokedHref === import.meta.url) {
  main();
}
