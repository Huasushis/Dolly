import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const EXPERIMENT_ID = "memory-longmemeval-retrieval-v0";
export const EXPERIMENT_VERSION = 4;
export const DATASET_PATH =
  "test/memory-data/benchmarks/conversation-memory/longmemeval/longmemeval_s";
export const DATASET_SHA256 =
  "08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894";
export const QUESTION_TYPE_COUNTS = Object.freeze({
  "knowledge-update": 78,
  "multi-session": 133,
  "single-session-assistant": 56,
  "single-session-preference": 30,
  "single-session-user": 70,
  "temporal-reasoning": 133,
});
export const CONDITIONS = Object.freeze([
  "content",
  "recurrence-no-position",
  "repeated-adjacent-position",
  "shuffled-position",
]);
export const ASSOCIATION_CONDITIONS = Object.freeze(CONDITIONS.slice(1));
export const ASSOCIATION_WEIGHTS = Object.freeze([0.25, 0.5, 1, 2]);
export const CUT_OFFS = Object.freeze([1, 5, 10]);

export function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(codeUnitCompare).map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function serializeJsonLines(rows) {
  return rows.map((row) => `${stableJson(row)}\n`).join("");
}

export function assertClosedObject(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort(codeUnitCompare);
  const expected = [...fields].sort(codeUnitCompare);
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError(`${label} has unexpected fields`);
  }
  return value;
}

function requireString(value, label, { empty = false } = {}) {
  if (typeof value !== "string" || (!empty && value.length === 0) || value.includes("\0")) {
    throw new TypeError(`${label} must be ${empty ? "a" : "a nonempty"} NUL-free string`);
  }
  return value;
}

function requireStringArray(value, label, { empty = false } = {}) {
  if (!Array.isArray(value) || (!empty && value.length === 0)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value.map((entry, index) => requireString(entry, `${label}[${index}]`));
}

function projectMessage(rawMessage, label) {
  const keys = Object.keys(rawMessage).sort(codeUnitCompare);
  const withoutGold = ["content", "role"];
  const withGold = ["content", "has_answer", "role"];
  const matches = (expected) => keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
  if (!matches(withoutGold) && !matches(withGold)) {
    throw new TypeError(`${label} source message fields changed`);
  }
  if (Object.hasOwn(rawMessage, "has_answer") && typeof rawMessage.has_answer !== "boolean") {
    throw new TypeError(`${label}.has_answer must be boolean`);
  }
  const role = requireString(rawMessage.role, `${label}.role`);
  if (role !== "user" && role !== "assistant") throw new TypeError(`${label}.role changed`);
  return Object.freeze({
    role,
    content: requireString(rawMessage.content, `${label}.content`, { empty: true }),
  });
}

export function adaptDatasetRows(datasetBytes) {
  if (sha256(datasetBytes) !== DATASET_SHA256) throw new TypeError("LongMemEval-S hash changed");
  const rawRows = JSON.parse(datasetBytes.toString("utf8"));
  if (!Array.isArray(rawRows) || rawRows.length !== 500) {
    throw new TypeError("LongMemEval-S must contain exactly 500 rows");
  }
  const questionIds = new Set();
  const typeCounts = new Map();
  const rows = rawRows.map((rawRow, rowIndex) => {
    const row = assertClosedObject(rawRow, [
      "answer", "answer_session_ids", "haystack_dates", "haystack_session_ids",
      "haystack_sessions", "question", "question_date", "question_id", "question_type",
    ], `dataset[${rowIndex}]`);
    const questionId = requireString(row.question_id, `dataset[${rowIndex}].question_id`);
    if (questionIds.has(questionId)) throw new TypeError(`duplicate question_id ${questionId}`);
    questionIds.add(questionId);
    const questionType = requireString(row.question_type, `dataset[${rowIndex}].question_type`);
    if (!Object.hasOwn(QUESTION_TYPE_COUNTS, questionType)) {
      throw new TypeError(`unknown question_type ${questionType}`);
    }
    typeCounts.set(questionType, (typeCounts.get(questionType) ?? 0) + 1);
    if (typeof row.answer !== "string" && typeof row.answer !== "number") {
      throw new TypeError(`dataset[${rowIndex}].answer must be text or number`);
    }
    requireString(row.question_date, `dataset[${rowIndex}].question_date`);
    const ids = requireStringArray(row.haystack_session_ids, `dataset[${rowIndex}].haystack_session_ids`);
    const dates = requireStringArray(row.haystack_dates, `dataset[${rowIndex}].haystack_dates`);
    if (!Array.isArray(row.haystack_sessions) || ids.length !== row.haystack_sessions.length ||
      ids.length !== dates.length || ids.length < 39 || ids.length > 66) {
      throw new TypeError(`dataset[${rowIndex}] session arrays changed`);
    }
    const firstById = new Map();
    for (let sessionIndex = 0; sessionIndex < ids.length; sessionIndex += 1) {
      const rawMessages = row.haystack_sessions[sessionIndex];
      if (!Array.isArray(rawMessages)) throw new TypeError(`dataset[${rowIndex}] session must be an array`);
      const messages = rawMessages.map((message, messageIndex) =>
        projectMessage(message, `dataset[${rowIndex}].session[${sessionIndex}].message[${messageIndex}]`)
      );
      const sessionId = ids[sessionIndex];
      const prior = firstById.get(sessionId);
      if (prior !== undefined) {
        if (stableJson(prior.messages) !== stableJson(messages)) {
          throw new TypeError(`duplicate session ${sessionId} changed role/content bytes`);
        }
        continue;
      }
      firstById.set(sessionId, Object.freeze({ session_id: sessionId, messages: Object.freeze(messages) }));
    }
    const sessions = Object.freeze([...firstById.values()]);
    const retainedIds = new Set(sessions.map((session) => session.session_id));
    const goldSessionIds = Object.freeze([
      ...new Set(requireStringArray(row.answer_session_ids, `dataset[${rowIndex}].answer_session_ids`)),
    ]);
    if (goldSessionIds.some((sessionId) => !retainedIds.has(sessionId))) {
      throw new TypeError(`dataset[${rowIndex}] gold session is absent after deduplication`);
    }
    const input = Object.freeze({
      question_id: questionId,
      question: requireString(row.question, `dataset[${rowIndex}].question`),
      sessions,
    });
    return Object.freeze({
      questionId,
      questionType,
      input,
      inputSha256: sha256(`${stableJson(input)}\n`),
      goldSessionIds,
      suppliedSessionCount: ids.length,
      retainedSessionCount: sessions.length,
    });
  });
  for (const [questionType, expected] of Object.entries(QUESTION_TYPE_COUNTS)) {
    if (typeCounts.get(questionType) !== expected) {
      throw new TypeError(`question_type count changed for ${questionType}`);
    }
  }
  return Object.freeze(rows);
}

export function readAndAdaptDataset(repositoryRoot) {
  return adaptDatasetRows(readFileSync(`${repositoryRoot}/${DATASET_PATH}`));
}

function splitDigest(row) {
  return sha256(Buffer.concat([
    Buffer.from(row.questionType, "utf8"),
    Buffer.from([0]),
    Buffer.from(row.questionId, "utf8"),
  ]));
}

export function createSplit(rows) {
  const byType = new Map();
  for (const row of rows) {
    const entries = byType.get(row.questionType) ?? [];
    entries.push({ row, digest: splitDigest(row) });
    byType.set(row.questionType, entries);
  }
  const splitByQuestion = new Map();
  for (const questionType of Object.keys(QUESTION_TYPE_COUNTS).sort(codeUnitCompare)) {
    const entries = byType.get(questionType).sort((left, right) =>
      codeUnitCompare(left.digest, right.digest) || codeUnitCompare(left.row.questionId, right.row.questionId)
    );
    const developmentCount = Math.floor(entries.length * 0.3);
    entries.forEach((entry, index) => splitByQuestion.set(entry.row.questionId, Object.freeze({
      schemaVersion: "memory-longmemeval-retrieval/split-v4",
      questionId: entry.row.questionId,
      questionType,
      digest: entry.digest,
      split: index < developmentCount ? "development" : "evaluation",
    })));
  }
  const splitRows = [...splitByQuestion.values()].sort((left, right) =>
    codeUnitCompare(left.questionId, right.questionId)
  );
  const development = splitRows.filter((row) => row.split === "development");
  const evaluation = splitRows.filter((row) => row.split === "evaluation");
  if (development.length !== 147 || evaluation.length !== 353) {
    throw new TypeError("frozen split counts changed");
  }
  return Object.freeze({ rows: Object.freeze(splitRows), development, evaluation, splitByQuestion });
}

function rankingSessionIds(variant) {
  return [...new Set(variant.ranking.map((entry) => entry.sessionId))];
}

export function metricsForRanking(variant, goldSessionIds) {
  const gold = new Set(goldSessionIds);
  const ids = rankingSessionIds(variant);
  const result = {};
  for (const cutoff of CUT_OFFS) {
    const selected = ids.slice(0, cutoff);
    const relevant = selected.reduce((sum, sessionId) => sum + Number(gold.has(sessionId)), 0);
    let dcg = 0;
    for (let index = 0; index < selected.length; index += 1) {
      if (gold.has(selected[index])) dcg += 1 / Math.log2(index + 2);
    }
    let idcg = 0;
    for (let index = 0; index < Math.min(cutoff, gold.size); index += 1) {
      idcg += 1 / Math.log2(index + 2);
    }
    result[`recallAt${cutoff}`] = relevant / gold.size;
    result[`hitAt${cutoff}`] = Number(relevant > 0);
    result[`ndcgAt${cutoff}`] = dcg / idcg;
  }
  return Object.freeze(result);
}

export function selectDevelopmentWeights(developmentRows, rowByQuestion) {
  const selected = {};
  const selections = [];
  for (const conditionId of ASSOCIATION_CONDITIONS) {
    const rows = developmentRows.filter((row) => row.conditionId === conditionId)
      .sort((left, right) => codeUnitCompare(left.questionId, right.questionId));
    let bestWeight;
    let bestMean = -Infinity;
    const candidates = [];
    for (const weight of ASSOCIATION_WEIGHTS) {
      let sum = 0;
      for (const row of rows) {
        const variant = row.variants.find((candidate) => candidate.weight === weight);
        sum += metricsForRanking(variant, rowByQuestion.get(row.questionId).goldSessionIds).ndcgAt10;
      }
      const mean = sum / rows.length;
      candidates.push(Object.freeze({ weight, macroNdcgAt10: mean }));
      if (mean > bestMean || (mean === bestMean && (bestWeight === undefined || weight < bestWeight))) {
        bestMean = mean;
        bestWeight = weight;
      }
    }
    selected[conditionId] = bestWeight;
    selections.push(Object.freeze({
      conditionId,
      candidates: Object.freeze(candidates),
      selectedWeight: bestWeight,
    }));
  }
  return Object.freeze({
    selectedWeights: Object.freeze(selected),
    selections: Object.freeze(selections),
  });
}

function nearestRank(values, proportion) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(proportion * sorted.length) - 1];
}

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function pairedBootstrap(orderedDifferences) {
  const random = xorshift32(1296387376);
  const samples = [];
  for (let repetition = 0; repetition < 10000; repetition += 1) {
    let sum = 0;
    for (let draw = 0; draw < orderedDifferences.length; draw += 1) {
      const index = Math.floor((random() * orderedDifferences.length) / 0x1_0000_0000);
      sum += orderedDifferences[index];
    }
    samples.push(sum / orderedDifferences.length);
  }
  samples.sort((left, right) => left - right);
  return Object.freeze({ lower: samples[249], upper: samples[9749] });
}

function aggregateConditionMetrics(rows, rowByQuestion, selectedWeights) {
  const orderedQuestions = [...new Set(rows.map((row) => row.questionId))].sort(codeUnitCompare);
  const byKey = new Map(rows.map((row) => [`${row.questionId}\0${row.conditionId}`, row]));
  return Object.fromEntries(CONDITIONS.map((conditionId) => {
    const perQuestion = orderedQuestions.map((questionId) => {
      const row = byKey.get(`${questionId}\0${conditionId}`);
      const selectedWeight = conditionId === "content" ? 0 : selectedWeights[conditionId];
      const variant = row.variants.find((candidate) => candidate.weight === selectedWeight);
      return metricsForRanking(variant, rowByQuestion.get(questionId).goldSessionIds);
    });
    return [conditionId, Object.freeze(Object.fromEntries(
      ["recallAt1", "recallAt5", "recallAt10", "hitAt1", "hitAt5", "hitAt10", "ndcgAt1", "ndcgAt5", "ndcgAt10"]
        .map((metric) => [metric, perQuestion.reduce((sum, row) => sum + row[metric], 0) / perQuestion.length]),
    ))];
  }));
}

export function analyzeEvaluation(evaluationRows, rowByQuestion, selectedWeights, developmentRows) {
  const orderedQuestions = [...new Set(evaluationRows.map((row) => row.questionId))]
    .sort(codeUnitCompare);
  const byKey = new Map(evaluationRows.map((row) => [`${row.questionId}\0${row.conditionId}`, row]));
  const conditionMetrics = {};
  for (const conditionId of CONDITIONS) {
    const perQuestion = orderedQuestions.map((questionId) => {
      const row = byKey.get(`${questionId}\0${conditionId}`);
      return metricsForRanking(row.variants[0], rowByQuestion.get(questionId).goldSessionIds);
    });
    conditionMetrics[conditionId] = Object.freeze(Object.fromEntries(
      ["recallAt1", "recallAt5", "recallAt10", "hitAt1", "hitAt5", "hitAt10", "ndcgAt1", "ndcgAt5", "ndcgAt10"]
        .map((metric) => [metric, perQuestion.reduce((sum, row) => sum + row[metric], 0) / perQuestion.length]),
    ));
  }
  const contrasts = {};
  for (const baseline of ["content", "recurrence-no-position", "shuffled-position"]) {
    const differences = orderedQuestions.map((questionId) => {
      const gold = rowByQuestion.get(questionId).goldSessionIds;
      const treatment = byKey.get(`${questionId}\0repeated-adjacent-position`).variants[0];
      const control = byKey.get(`${questionId}\0${baseline}`).variants[0];
      return metricsForRanking(treatment, gold).ndcgAt10 - metricsForRanking(control, gold).ndcgAt10;
    });
    const interval = pairedBootstrap(differences);
    contrasts[baseline] = Object.freeze({
      mean: differences.reduce((sum, value) => sum + value, 0) / differences.length,
      lower95: interval.lower,
      upper95: interval.upper,
    });
  }
  const knowledgeQuestions = orderedQuestions.filter((questionId) =>
    rowByQuestion.get(questionId).questionType === "knowledge-update"
  );
  const topOneError = (conditionId) => knowledgeQuestions.reduce((sum, questionId) => {
    const gold = new Set(rowByQuestion.get(questionId).goldSessionIds);
    const first = byKey.get(`${questionId}\0${conditionId}`).variants[0].ranking[0]?.sessionId;
    return sum + Number(!gold.has(first));
  }, 0) / knowledgeQuestions.length;
  const contentError = topOneError("content");
  const positionError = topOneError("repeated-adjacent-position");
  const positionRows = evaluationRows.filter((row) => row.conditionId === "repeated-adjacent-position");
  const ratios = positionRows.map((row) => row.cost.corpusRawSessionBytes === 0
    ? (row.cost.edgeBytes === 0 ? 0 : Number.POSITIVE_INFINITY)
    : row.cost.edgeBytes / row.cost.corpusRawSessionBytes);
  const finiteNumbers = [
    ...Object.values(conditionMetrics).flatMap((metrics) => Object.values(metrics)),
    ...Object.values(contrasts).flatMap((contrast) => Object.values(contrast)),
    contentError, positionError, ...ratios,
  ].every(Number.isFinite);
  if (!finiteNumbers) throw new TypeError("analysis contains non-finite values");
  const ratioP95 = nearestRank(ratios, 0.95);
  const descriptiveCost = Object.fromEntries(ASSOCIATION_CONDITIONS.map((conditionId) => {
    const rows = evaluationRows.filter((row) => row.conditionId === conditionId);
    const summarize = (values) => ({ p50: nearestRank(values, 0.5), p95: nearestRank(values, 0.95) });
    return [conditionId, {
      buildMilliseconds: summarize(rows.map((row) => row.cost.buildMilliseconds)),
      queryMilliseconds: summarize(rows.map((row) => row.cost.queryMilliseconds)),
      edgeBytes: summarize(rows.map((row) => row.cost.edgeBytes)),
      corpusRawSessionBytes: summarize(rows.map((row) => row.cost.corpusRawSessionBytes)),
      returnedRawSessionBytes: summarize(rows.map((row) => row.variants[0].returnedRawSessionBytes)),
      edgeToCorpusRawRatio: summarize(rows.map((row) => row.cost.corpusRawSessionBytes === 0
        ? (row.cost.edgeBytes === 0 ? 0 : Number.POSITIVE_INFINITY)
        : row.cost.edgeBytes / row.cost.corpusRawSessionBytes)),
    }];
  }));
  const useful = Object.values(contrasts).every((contrast) =>
    contrast.mean >= 0.02 && contrast.lower95 > 0
  );
  const knowledgeGuard = positionError - contentError <= 0.02;
  const costGuard = ratioP95 <= 2;
  return Object.freeze({
    schemaVersion: "memory-longmemeval-retrieval/analysis-v4",
    selectedWeights,
    developmentConditionMetrics: aggregateConditionMetrics(
      developmentRows,
      rowByQuestion,
      selectedWeights,
    ),
    conditionMetrics,
    contrasts,
    knowledgeUpdate: {
      contentTop1Error: contentError,
      repeatedPositionTop1Error: positionError,
      difference: positionError - contentError,
    },
    cost: { repeatedPositionEdgeToRawRatioP95: ratioP95, descriptiveByTreatment: descriptiveCost },
    gates: { usefulEffect: useful, knowledgeUpdate: knowledgeGuard, deterministicCost: costGuard },
    classification: useful && knowledgeGuard && costGuard ? "supported" : "rejected",
  });
}
