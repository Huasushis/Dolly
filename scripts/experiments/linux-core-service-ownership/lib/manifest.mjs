#!/usr/bin/env node
// Builds the run manifest required by `docs/experiments/protocol.md` and by the
// "Artifacts" section of `docs/experiments/linux-core-service-process-ownership.md`.
//
// It also writes the ordered execution list the runner iterates, so the manifest
// and the executed cases cannot drift apart: the runner reads only the list this
// file produced.
//
// Usage:
//   node manifest.mjs --environment FILE --run-id ID --seed N --mode MODE \
//     --profile PROFILE --repository DIR --manifest-out FILE --cases-out FILE \
//     [--group ID]... [--arm ID]... [--id-prefix PREFIX] [--non-disruptive-only] \
//     [--core-unit NAME]

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { buildCatalog, filterCases } from "./catalog.mjs";

function parseArguments(argv) {
  const options = {
    environment: null,
    runId: null,
    seed: null,
    mode: "full",
    profile: "default",
    repository: null,
    manifestOut: null,
    casesOut: null,
    coreUnit: null,
    filters: {
      groups: [],
      arms: [],
      idPrefix: null,
      excludeIds: [],
      nonDisruptiveOnly: false,
    },
  };
  const single = {
    "--environment": "environment",
    "--run-id": "runId",
    "--seed": "seed",
    "--mode": "mode",
    "--profile": "profile",
    "--repository": "repository",
    "--manifest-out": "manifestOut",
    "--cases-out": "casesOut",
    "--core-unit": "coreUnit",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument in single) {
      options[single[argument]] = argv[index + 1];
      index += 1;
    } else if (argument === "--group") {
      options.filters.groups.push(argv[index + 1]);
      index += 1;
    } else if (argument === "--arm") {
      options.filters.arms.push(argv[index + 1]);
      index += 1;
    } else if (argument === "--exclude-id") {
      options.filters.excludeIds.push(argv[index + 1]);
      index += 1;
    } else if (argument === "--id-prefix") {
      options.filters.idPrefix = argv[index + 1];
      index += 1;
    } else if (argument === "--non-disruptive-only") {
      options.filters.nonDisruptiveOnly = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  for (const required of ["environment", "runId", "seed", "manifestOut", "casesOut"]) {
    if (options[required] === null) {
      throw new Error(`missing required argument for ${required}`);
    }
  }
  return options;
}

// The environment file holds one `key=value` line per fact, collected by the
// runner from the operating system. Values may contain spaces and `=`.
function readEnvironmentFile(path) {
  const facts = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 1) {
      continue;
    }
    facts.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return facts;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

// A private host name is a private identifier, so the manifest keeps a stable
// redacted label instead of the name itself.
function redactedLabel(prefix, value) {
  if (value === undefined || value === "") {
    return null;
  }
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function optional(facts, key) {
  const value = facts.get(key);
  return value === undefined || value === "" ? null : value;
}

// Ten fixed seeds derived from the run seed. The protocol repeats race cases
// across ten fixed seeds; deriving them keeps the repetition reproducible from
// the single seed the manifest records.
function derivedSeeds(seed, count) {
  const seeds = [];
  for (let index = 0; index < count; index += 1) {
    const hash = createHash("sha256").update(`${seed}:${index}`).digest();
    seeds.push(hash.readUInt32BE(0));
  }
  return seeds;
}

// The service properties ADR 0009 requires to be correct in the *effective*
// configuration. The runner collects them with `systemctl show`; when there is
// no installed Core service yet, the manifest records their absence and every
// case that depends on them stays inconclusive.
export const REQUIRED_SERVICE_PROPERTIES = [
  "Type",
  "Restart",
  "StartLimitIntervalUSec",
  "StartLimitBurst",
  "KillMode",
  "SendSIGKILL",
  "TimeoutStopUSec",
  "Delegate",
  "DelegateSubgroup",
  "DelegateControllers",
  "ExitType",
  "RestartMode",
  "RemainAfterExit",
  "SuccessExitStatus",
  "RestartPreventExitStatus",
  "PassEnvironment",
  "EnvironmentFiles",
  "Environment",
  "ControlGroup",
  "MainPID",
  "InvocationID",
];

function readServiceConfiguration(facts) {
  // The `systemctl show` output is multi-line, so the runner leaves it in its
  // own file and the environment file only points at that file.
  const path = optional(facts, "core_unit_show_file");
  if (path === null) {
    return {
      available: false,
      unit: optional(facts, "core_unit"),
      reason: optional(facts, "core_unit_reason") ?? "no Core service unit was supplied to this run",
      properties: null,
      digest: null,
    };
  }
  const properties = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator < 1) {
      continue;
    }
    properties[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const canonical = Object.keys(properties)
    .sort()
    .map((key) => `${key}=${properties[key]}`)
    .join("\n");
  return {
    available: true,
    unit: optional(facts, "core_unit"),
    reason: null,
    properties,
    digest: digest(canonical),
  };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const facts = readEnvironmentFile(options.environment);
  const catalog = buildCatalog();
  const cases = filterCases(catalog.cases, options.filters);

  if (cases.length === 0) {
    throw new Error("the selected filters leave no case to run");
  }

  const canonicalCases = JSON.stringify(cases);
  const serviceConfiguration = readServiceConfiguration(facts);

  const manifest = {
    experiment: catalog.experiment,
    protocolVersion: catalog.protocolVersion,
    catalogVersion: catalog.catalogVersion,
    runId: options.runId,
    startedAt: optional(facts, "started_at"),
    mode: options.mode,
    profile: options.profile,
    // No model provider, object store, or paid interface is involved, so the
    // backend is the local operating system. There is no fake substitute: a
    // missing dependency fails the run instead of silently degrading it.
    backendKind: "local",
    model: {
      endpointCapabilityProfile: null,
      identifier: null,
      reason: "this experiment uses no model provider; see the protocol's Environments section",
    },
    prompts: {
      versions: null,
      reason: "this experiment uses no prompt; its subject is process and control group behaviour",
    },
    source: {
      commit: optional(facts, "source_commit"),
      commitDate: optional(facts, "source_commit_date"),
      branch: optional(facts, "source_branch"),
      dirtyWorktree: optional(facts, "source_dirty") === "yes",
      dirtyFileCount: Number(optional(facts, "source_dirty_files") ?? 0),
      repository: options.repository,
    },
    environment: {
      hostLabel: redactedLabel("host", facts.get("host_name")),
      userLabel: redactedLabel("user", facts.get("user_name")),
      kernelRelease: optional(facts, "kernel_release"),
      kernelVersion: optional(facts, "kernel_version"),
      operatingSystem: optional(facts, "os_pretty_name"),
      systemdVersion: optional(facts, "systemd_version"),
      cgroupFilesystem: optional(facts, "cgroup_filesystem"),
      cgroupVersion: optional(facts, "cgroup_version"),
      availableControllers: (optional(facts, "cgroup_controllers") ?? "").split(" ").filter(Boolean),
      nodeVersion: optional(facts, "node_version"),
      python3Version: optional(facts, "python3_version"),
      serviceMode: optional(facts, "service_mode"),
      lingering: optional(facts, "lingering"),
      bootId: optional(facts, "boot_id"),
      disposableEnvironment: optional(facts, "disposable") === "yes",
    },
    serviceConfiguration,
    configurationDigest: serviceConfiguration.digest,
    // The case catalog is this experiment's dataset: it is fixed before the run
    // and its hash proves which case set produced the results.
    dataset: {
      name: "fixed-interruption-matrix-and-separate-cases",
      version: `protocol-${catalog.protocolVersion}.catalog-${catalog.catalogVersion}`,
      split: "evaluation",
      contentHash: digest(canonicalCases),
    },
    seed: Number(options.seed),
    seeds: derivedSeeds(options.seed, catalog.raceRepetition.seedCount),
    executionOrder: "catalog-order",
    terminationSignals: catalog.terminationSignals,
    arms: catalog.arms,
    invariants: catalog.invariants,
    raceBoundaries: catalog.raceBoundaries,
    raceRepetition: catalog.raceRepetition,
    filters: options.filters,
    // Every action that narrows coverage is recorded beside the counts it
    // produced, so a narrowed run cannot be read as a complete one. `complete`
    // is the single field a reader can check: it is true only when this run
    // selected the entire catalog.
    selection: {
      catalogCaseCount: catalog.cases.length,
      selectedCaseCount: cases.length,
      complete: cases.length === catalog.cases.length,
      excludedIds: [...options.filters.excludeIds],
      narrowedBy: [
        ...(options.filters.groups.length > 0 ? ["group"] : []),
        ...(options.filters.arms.length > 0 ? ["arm"] : []),
        ...(options.filters.idPrefix !== null ? ["id-prefix"] : []),
        ...(options.filters.excludeIds.length > 0 ? ["exclude-id"] : []),
        ...(options.filters.nonDisruptiveOnly ? ["non-disruptive-only"] : []),
      ],
    },
    caseCount: cases.length,
    plannedExecutions: cases.reduce(
      (total, entry) => total + (entry.repetition === null ? 1 : entry.repetition.iterations),
      0,
    ),
    // Per-case token and call counts do not apply without a model provider.
    // Latency, retry, and error counts are recorded per case in results.jsonl.
    perCaseAccounting: {
      tokens: "not applicable; no model provider is used",
      calls: "not applicable; no model provider is used",
      latency: "recorded per case as durationMs in results.jsonl",
      retries: "recorded per case as retries in results.jsonl",
      errors: "recorded per case as exitCode and reason in results.jsonl",
    },
    orderedCases: cases.map((entry) => entry.id),
    cases,
  };

  writeFileSync(options.manifestOut, `${JSON.stringify(manifest, null, 2)}\n`);

  const lines = cases.map((entry) =>
    [
      entry.id,
      entry.group,
      entry.handler,
      entry.arm,
      String(entry.timeoutSeconds),
      entry.disruptive ? "disruptive" : "non-disruptive",
      entry.requiredArtifacts.join(","),
    ].join("\t"),
  );
  writeFileSync(options.casesOut, `${lines.join("\n")}\n`);

  process.stdout.write(`${cases.length}\n`);
}

main();
