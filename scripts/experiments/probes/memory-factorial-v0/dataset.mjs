import {
  CUE_TYPES,
  actionEquals,
  stableJson,
  tokenize,
} from "./common.mjs";

const BASE_TASKS = [
  {
    seed: 501,
    family: "structured-data-import",
    taskId: "alder-import-501",
    completedStep: "invoice parsing",
    initialAction: {
      operation: "add_idempotency_guard",
      arguments: { idempotencyKey: "idem-501-a3f18c" },
    },
    replacementAction: {
      operation: "reconcile_duplicate_deliveries",
      arguments: { batchId: "batch-501-r2" },
    },
    retentionDays: 31,
  },
  {
    seed: 502,
    family: "structured-data-import",
    taskId: "birch-import-502",
    completedStep: "billing validation",
    initialAction: {
      operation: "add_idempotency_guard",
      arguments: { idempotencyKey: "idem-502-b6d209" },
    },
    replacementAction: {
      operation: "reconcile_duplicate_deliveries",
      arguments: { batchId: "batch-502-r4" },
    },
    retentionDays: 67,
  },
  {
    seed: 503,
    family: "software-incident",
    taskId: "cedar-service-503",
    completedStep: "dependency diagnosis",
    initialAction: {
      operation: "restart_service",
      arguments: { serviceName: "ledger-api-503" },
    },
    replacementAction: {
      operation: "revert_release",
      arguments: { releaseId: "rel-503.7", serviceName: "ledger-api-503" },
    },
    retentionDays: 14,
  },
  {
    seed: 504,
    family: "software-incident",
    taskId: "dogwood-service-504",
    completedStep: "health-check diagnosis",
    initialAction: {
      operation: "restart_service",
      arguments: { serviceName: "search-api-504" },
    },
    replacementAction: {
      operation: "revert_release",
      arguments: { releaseId: "rel-504.2", serviceName: "search-api-504" },
    },
    retentionDays: 45,
  },
];

function record(id, episodeId, position, sequence, role, text) {
  return { id, episodeId, position, sequence, role, text };
}

function familyText(task, variant) {
  if (task.family === "structured-data-import") {
    if (variant === "anchor-1") return "Billing intake parses invoice batches before validation.";
    if (variant === "anchor-2") return "The invoice importer reads billing files into staging.";
    if (variant === "constraint-1") {
      return `Rejected rows must be retained for retention_days=${task.retentionDays}; this prerequisite is required before the next operation can run.`;
    }
    if (variant === "constraint-2") {
      return `Failed entries must be kept for retention_days=${task.retentionDays}; the same prerequisite is required before continuing.`;
    }
    if (variant === "cue") return "billing import work";
  }
  if (variant === "anchor-1") return "Service incident triage inspects the failing deployment before recovery.";
  if (variant === "anchor-2") return "The outage response reviews service health before an operation is chosen.";
  if (variant === "constraint-1") {
    return `Diagnostic logs must be retained for retention_days=${task.retentionDays}; this prerequisite is required before the next operation can run.`;
  }
  if (variant === "constraint-2") {
    return `Crash evidence must be kept for retention_days=${task.retentionDays}; the same prerequisite is required before continuing.`;
  }
  return "service incident work";
}

function currentText(task) {
  return [
    `Task ${task.taskId} state=active.`,
    `completed_step=${JSON.stringify(task.completedStep)}.`,
    `operation_code=${task.initialAction.operation}.`,
    `arguments=${stableJson(task.initialAction.arguments)}.`,
  ].join(" ");
}

function updateText(task, cueType) {
  if (cueType === "cancelled") {
    return `Task ${task.taskId} state=cancelled. operation_code=none. The previous operation is no longer authorized and there is no current action.`;
  }
  if (cueType === "superseded") {
    return [
      `Task ${task.taskId} state=active.`,
      `Previous operation_code=${task.initialAction.operation} is superseded and forbidden.`,
      `replacement_operation_code=${task.replacementAction.operation}.`,
      `replacement_arguments=${stableJson(task.replacementAction.arguments)}.`,
    ].join(" ");
  }
  return null;
}

function activeContext(task, cueType) {
  const interruptedTask = `interrupt-${task.seed}`;
  const prefix = [
    {
      id: `${task.seed}-${cueType}-active-interrupt-start`,
      role: "user",
      text: `Pause the earlier task and verify ${interruptedTask}.`,
    },
    {
      id: `${task.seed}-${cueType}-active-interrupt-done`,
      role: "assistant",
      text: `${interruptedTask} verification completed.`,
    },
  ];
  let cue;
  if (cueType === "positive") {
    cue = `Resume task ${task.taskId} and continue the ${familyText(task, "cue")} with its current operation.`;
  } else if (cueType === "do-not-resume") {
    cue = `Do not resume or continue task ${task.taskId}; leave it paused and perform no task operation.`;
  } else {
    cue = `Go back to task ${task.taskId} and continue the ${familyText(task, "cue")} now.`;
  }
  return [
    ...prefix,
    { id: `${task.seed}-${cueType}-active-cue`, role: "user", text: cue },
  ];
}

function claimGroup(required, sufficientSourceSets) {
  return { required, sufficientSourceSets };
}

function buildScenario(task, cueType) {
  const scenarioId = `evaluation-${task.seed}-${cueType}`;
  const sourceId = (suffix) => `${scenarioId}-${suffix}`;
  const records = [
    record(sourceId("h1-anchor"), sourceId("h1"), 0, 0, "historical-anchor", familyText(task, "anchor-1")),
    record(sourceId("h1-constraint"), sourceId("h1"), 1, 1, "constraint", familyText(task, "constraint-1")),
    record(sourceId("h1-filler"), sourceId("h1"), 2, 2, "filler", "A weekly owner rotation is listed in the runbook."),
    record(sourceId("h2-anchor"), sourceId("h2"), 0, 3, "historical-anchor", familyText(task, "anchor-2")),
    record(sourceId("h2-constraint"), sourceId("h2"), 1, 4, "constraint", familyText(task, "constraint-2")),
    record(sourceId("h2-filler"), sourceId("h2"), 2, 5, "filler", "The dashboard theme is changed once per quarter."),
    record(sourceId("current"), sourceId("current-episode"), 0, 6, "current-state", currentText(task)),
    record(sourceId("identity-distractor"), sourceId("identity"), 0, 7, "distractor", `Task ${task.taskId} dashboard color is amber.`),
  ];
  const update = updateText(task, cueType);
  if (update) {
    records.push(record(
      sourceId("state-update"),
      sourceId("update-episode"),
      0,
      8,
      cueType === "cancelled" ? "cancellation" : "supersession",
      update,
    ));
  }

  const currentId = sourceId("current");
  const constraint1 = sourceId("h1-constraint");
  const constraint2 = sourceId("h2-constraint");
  const updateId = sourceId("state-update");
  let decision = "resume";
  let decisionReason = "current_action";
  let taskState = "active";
  let action = task.initialAction;
  let retentionDays = task.retentionDays;
  let claimGroups = {
    taskState: claimGroup(true, [[currentId]]),
    action: claimGroup(true, [[currentId]]),
    constraints: claimGroup(true, [[constraint1], [constraint2]]),
  };

  if (cueType === "do-not-resume") {
    decision = "abstain";
    decisionReason = "explicit_do_not_resume";
    taskState = "unknown";
    action = null;
    retentionDays = null;
    claimGroups = {
      taskState: claimGroup(false, []),
      action: claimGroup(false, []),
      constraints: claimGroup(false, []),
    };
  } else if (cueType === "cancelled") {
    decision = "abstain";
    decisionReason = "task_cancelled";
    taskState = "cancelled";
    action = null;
    retentionDays = null;
    claimGroups = {
      taskState: claimGroup(true, [[updateId]]),
      action: claimGroup(true, [[updateId]]),
      constraints: claimGroup(false, []),
    };
  } else if (cueType === "superseded") {
    decisionReason = "superseded_action";
    action = task.replacementAction;
    claimGroups = {
      taskState: claimGroup(true, [[updateId]]),
      action: claimGroup(true, [[updateId]]),
      constraints: claimGroup(true, [[constraint1], [constraint2]]),
    };
  }

  const allowedClaimSources = new Set(
    Object.values(claimGroups).flatMap((group) => group.sufficientSourceSets.flat()),
  );
  const forbiddenSourceIds = records
    .map((entry) => entry.id)
    .filter((id) => !allowedClaimSources.has(id));
  const context = activeContext(task, cueType);
  return {
    schemaVersion: "memory-factorial/dataset-v2",
    scenarioId,
    split: "evaluation",
    seed: task.seed,
    taskFamily: task.family,
    cueType,
    records,
    activeContext: context,
    query: context.at(-1).text,
    groundTruth: {
      decision,
      decisionReason,
      taskId: task.taskId,
      taskState,
      action,
      constraints: { retentionDays },
      uncertain: false,
      initialAction: task.initialAction,
      replacementAction: task.replacementAction,
      claimGroups,
      forbiddenSourceIds,
    },
  };
}

export function generateDataset() {
  return BASE_TASKS.flatMap((task) => CUE_TYPES.map((cueType) => buildScenario(task, cueType)));
}

function lexicalScore(queryTokens, recordTokens) {
  const recordSet = new Set(recordTokens);
  return queryTokens.reduce((score, token) => score + Number(recordSet.has(token)), 0);
}

export function retrieveContentRecords(scenario) {
  const queryTokens = tokenize(scenario.query);
  return scenario.records
    .map((entry) => ({ entry, score: lexicalScore(queryTokens, tokenize(entry.text)) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score
      || right.entry.sequence - left.entry.sequence
      || left.entry.id.localeCompare(right.entry.id))
    .slice(0, 4)
    .map(({ entry }) => entry);
}

export function buildRepeatedPositionEdges(records) {
  const perEpisode = new Map();
  for (const entry of records) {
    const episode = perEpisode.get(entry.episodeId) ?? [];
    episode.push(entry);
    perEpisode.set(entry.episodeId, episode);
  }
  const support = new Map();
  for (const [episodeId, episode] of perEpisode) {
    const ordered = [...episode].sort((left, right) => left.position - right.position);
    for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
        const distance = Math.abs(ordered[rightIndex].position - ordered[leftIndex].position);
        if (distance !== 1) continue;
        for (const leftToken of tokenize(ordered[leftIndex].text)) {
          for (const rightToken of tokenize(ordered[rightIndex].text)) {
            if (leftToken === rightToken) continue;
            const pair = [leftToken, rightToken].sort();
            const key = pair.join("\u0000");
            const episodes = support.get(key) ?? new Set();
            episodes.add(episodeId);
            support.set(key, episodes);
          }
        }
      }
    }
  }
  return [...support.entries()]
    .filter(([, episodes]) => episodes.size >= 2)
    .map(([key, episodes]) => ({ terms: key.split("\u0000"), distinctEpisodes: episodes.size }))
    .sort((left, right) => left.terms.join("/").localeCompare(right.terms.join("/")));
}

export function retrieveAssociationRecords(scenario) {
  const content = retrieveContentRecords(scenario);
  const seedTokens = new Set([
    ...tokenize(scenario.query),
    ...content.flatMap((entry) => tokenize(entry.text)),
  ]);
  const edges = buildRepeatedPositionEdges(scenario.records);
  const associatedTokens = new Set();
  for (const edge of edges) {
    const [left, right] = edge.terms;
    if (seedTokens.has(left)) associatedTokens.add(right);
    if (seedTokens.has(right)) associatedTokens.add(left);
  }
  const associated = scenario.records
    .map((entry) => ({
      entry,
      score: tokenize(entry.text).reduce(
        (score, token) => score + Number(associatedTokens.has(token)),
        0,
      ),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score
      || left.entry.sequence - right.entry.sequence
      || left.entry.id.localeCompare(right.entry.id))
    .map(({ entry }) => entry);
  const selected = [];
  for (const entry of [...associated.slice(0, 2), ...content]) {
    if (!selected.some((candidate) => candidate.id === entry.id)) selected.push(entry);
    if (selected.length === 4) break;
  }
  return selected;
}

function parseActionFromText(text, replacement = false) {
  const operationPattern = replacement
    ? /replacement_operation_code=([a-z0-9_]+)/u
    : /operation_code=([a-z0-9_]+)/u;
  const argumentsPattern = replacement
    ? /replacement_arguments=(\{[^\n]+?\})\./u
    : /arguments=(\{[^\n]+?\})\./u;
  const operation = text.match(operationPattern)?.[1];
  const argumentsText = text.match(argumentsPattern)?.[1];
  if (!operation || !argumentsText) return null;
  return { operation, arguments: JSON.parse(argumentsText) };
}

export function constructDeterministicCheckpoint(scenario, associationRecords) {
  const update = associationRecords.find((entry) => ["cancellation", "supersession"].includes(entry.role));
  const current = associationRecords.find((entry) => entry.role === "current-state");
  const constraint = associationRecords.find((entry) => entry.role === "constraint");
  let taskState = "unknown";
  let action = null;
  let stateSource = null;
  let actionSource = null;
  if (update?.role === "cancellation") {
    taskState = "cancelled";
    stateSource = update.id;
    actionSource = update.id;
  } else if (update?.role === "supersession") {
    taskState = "active";
    action = parseActionFromText(update.text, true);
    stateSource = update.id;
    actionSource = update.id;
  } else if (current) {
    taskState = "active";
    action = parseActionFromText(current.text, false);
    stateSource = current.id;
    actionSource = current.id;
  }
  const retentionText = constraint?.text.match(/retention_days=(\d+)/u)?.[1];
  const retentionDays = retentionText ? Number(retentionText) : null;
  const sourceRecordIds = [...new Set([stateSource, actionSource, constraint?.id].filter(Boolean))];
  return {
    schemaVersion: "memory-factorial/checkpoint-v2",
    checkpointId: `${scenario.scenarioId}-deterministic-checkpoint`,
    scenarioId: scenario.scenarioId,
    taskId: scenario.groundTruth.taskId,
    taskState,
    action,
    constraints: { retentionDays },
    support: {
      taskState: stateSource ? [stateSource] : [],
      action: actionSource ? [actionSource] : [],
      constraints: constraint ? [constraint.id] : [],
    },
    sourceRecordIds,
    construction: {
      kind: "deterministic-source-cited",
      inputRecordIds: associationRecords.map((entry) => entry.id),
    },
  };
}

export function buildCellEvidence(scenario, cellId, checkpoint = undefined) {
  const content = retrieveContentRecords(scenario);
  const association = retrieveAssociationRecords(scenario);
  const checkpointEntry = checkpoint ?? constructDeterministicCheckpoint(scenario, association);
  const raw = (records) => records.map((entry) => ({
    id: entry.id,
    kind: "raw-record",
    text: entry.text,
    sourceRecordIds: [entry.id],
  }));
  if (cellId === "content-raw") return raw(content);
  if (cellId === "association-raw") return raw(association);
  const derived = {
    id: checkpointEntry.checkpointId,
    kind: "deterministic-checkpoint",
    text: stableJson(checkpointEntry),
    sourceRecordIds: checkpointEntry.sourceRecordIds,
  };
  if (cellId === "deterministic-checkpoint") return [derived];
  if (cellId === "checkpoint-association-raw") return [derived, ...raw(association)];
  throw new Error(`unknown cell ${cellId}`);
}

export function assertDatasetStructure(dataset) {
  if (dataset.length !== 16) throw new Error(`expected 16 scenarios, received ${dataset.length}`);
  const identities = new Set();
  for (const scenario of dataset) {
    if (identities.has(scenario.scenarioId)) throw new Error(`duplicate scenario ${scenario.scenarioId}`);
    identities.add(scenario.scenarioId);
    if (!CUE_TYPES.includes(scenario.cueType)) throw new Error(`unknown cue ${scenario.cueType}`);
    if (scenario.activeContext.some((entry) => scenario.records.some((recordEntry) => recordEntry.id === entry.id))) {
      throw new Error(`active context leaks source record in ${scenario.scenarioId}`);
    }
    if (scenario.cueType === "superseded" && actionEquals(scenario.groundTruth.action, scenario.groundTruth.initialAction)) {
      throw new Error(`superseded action did not change in ${scenario.scenarioId}`);
    }
  }
  for (const family of ["structured-data-import", "software-incident"]) {
    for (const cueType of CUE_TYPES) {
      const count = dataset.filter((scenario) => scenario.taskFamily === family && scenario.cueType === cueType).length;
      if (count !== 2) throw new Error(`expected two ${family}/${cueType} scenarios, received ${count}`);
    }
  }
  return true;
}
