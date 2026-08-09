import { createHash } from 'node:crypto';

export const EXPERIMENT_ID = 'memory-association-task-switch-v0';
export const ALGORITHM_VERSION = 'memory-association-task-switch/v3';

export const CONDITION_IDS = Object.freeze([
  'no-memory',
  'exact-lexical-bm25',
  'sham-replay',
  'normalized-content',
  'normalized-content-position-recurrence',
  'normalized-content-recurrence-no-position',
  'normalized-content-position-single-observation',
  'normalized-content-position-shuffled',
  'normalized-content-temporal-neighbours',
  'explicit-task-checkpoint',
  'summary-only',
  'skill-and-long-term-prompt',
  'combined-memory',
]);

export const LIVE_CONDITION_IDS = Object.freeze([
  'no-memory',
  'exact-lexical-bm25',
  'sham-replay',
  'normalized-content',
  'normalized-content-position-recurrence',
  'normalized-content-position-shuffled',
  'normalized-content-temporal-neighbours',
  'explicit-task-checkpoint',
  'combined-memory',
]);

export const NORMALIZATION_TABLE = Object.freeze({
  billing: 'invoice',
  intake: 'import',
  importer: 'import',
  continue: 'resume',
  back: 'resume',
  failed: 'rejected',
  entries: 'rows',
  keep: 'retain',
  preserve: 'retain',
  retained: 'retain',
});

// Frozen function-word list. Domain-bearing terms are deliberately retained.
export const STOPWORDS = Object.freeze(new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'because', 'been', 'before',
  'by', 'can', 'did', 'do', 'does', 'for', 'from', 'go', 'has', 'have',
  'in', 'into', 'is', 'it', 'later', 'now', 'of', 'on', 'only', 'or',
  'so', 'than', 'that', 'the', 'their', 'then', 'there', 'this', 'to',
  'was', 'we', 'were', 'when', 'with', 'work', 'you',
]));

const PROJECT_WORDS = Object.freeze([
  'alder', 'birch', 'cedar', 'dogwood', 'elm', 'fir', 'ginkgo', 'hazel',
  'ironwood', 'juniper', 'kapok', 'linden', 'maple', 'nutmeg', 'oak',
  'poplar', 'quince', 'redwood', 'spruce', 'teak', 'umber', 'verbena',
  'willow', 'xylia', 'yew', 'zinnia', 'acacia', 'buckeye', 'cypress',
  'daphne', 'eucalyptus', 'fig',
]);
const COLORS = Object.freeze([
  'amber', 'blue', 'coral', 'denim', 'emerald', 'fuchsia', 'gold', 'hazel',
  'indigo', 'jade', 'khaki', 'lilac', 'magenta', 'navy', 'ochre', 'pearl',
  'quartz', 'rose', 'silver', 'teal', 'umber', 'violet', 'white', 'yellow',
]);
const TIMEZONES = Object.freeze([
  'Africa/Accra', 'America/Aruba', 'America/Belize', 'Asia/Brunei',
  'Asia/Dhaka', 'Asia/Manila', 'Asia/Tokyo', 'Australia/Perth',
  'Europe/Dublin', 'Europe/Lisbon', 'Europe/Oslo', 'Pacific/Guam',
]);

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function xorshift32(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

export function fisherYates(values, seed) {
  const result = [...values];
  const next = xorshift32(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = next() % (index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function choose(values, next) {
  return values[next() % values.length];
}

function record(id, episodeId, position, role, text, relevant = true) {
  return Object.freeze({ id, episodeId, position, role, text, relevant });
}

export function generateCase(seed, split) {
  const next = xorshift32(seed);
  const splitCode = { training: 't', development: 'd', evaluation: 'e' }[split];
  if (!splitCode) throw new Error(`Unknown split ${split}`);
  const project = `${choose(PROJECT_WORDS, next)}${splitCode}${seed}p`;
  const interruptProject = `cert${choose(PROJECT_WORDS, next)}${splitCode}${seed}x`;
  const retentionDays = 21 + (next() % 70);
  const idempotencyKey = `idem-${seed}-${(next() >>> 0).toString(16).padStart(8, '0')}`;
  const chartColor = choose(COLORS, next);
  let headerColor = choose(COLORS, next);
  while (headerColor === chartColor) headerColor = choose(COLORS, next);
  const identityColor = choose(COLORS, next);
  const timezone = choose(TIMEZONES, next);
  const prefix = `${split}-${seed}`;

  const records = [
    record(`${prefix}-h1-setup`, `${prefix}-h1`, 0, 'history-filler', `Operators opened the ${project} checklist.`, false),
    record(`${prefix}-h1-anchor`, `${prefix}-h1`, 1, 'historical-anchor', `Billing intake parses invoice batches into staging.`, true),
    record(`${prefix}-h1-constraint`, `${prefix}-h1`, 2, 'true-constraint', `Retain rejected rows for ${retentionDays} days so operators can inspect failures.`, true),
    record(`${prefix}-h1-filler`, `${prefix}-h1`, 3, 'history-filler', `The staging owner rotates weekly on Tuesdays.`, false),
    record(`${prefix}-h1-chart`, `${prefix}-h1`, 4, 'repeated-far-distractor', `The ${project} dashboard chart color is ${chartColor}.`, false),

    record(`${prefix}-h2-setup`, `${prefix}-h2`, 0, 'history-filler', `A dry run was scheduled for ${project}.`, false),
    record(`${prefix}-h2-anchor`, `${prefix}-h2`, 1, 'historical-anchor', `The invoice importer reads billing files before validation.`, true),
    record(`${prefix}-h2-constraint`, `${prefix}-h2`, 2, 'true-constraint', `Failed entries must be kept for ${retentionDays} days for operator review.`, true),
    record(`${prefix}-h2-filler`, `${prefix}-h2`, 3, 'history-filler', `Validation samples go to the archive vault.`, false),
    record(`${prefix}-h2-chart`, `${prefix}-h2`, 4, 'repeated-far-distractor', `The ${project} dashboard chart color remains ${chartColor}.`, false),

    record(`${prefix}-cur-setup`, `${prefix}-cur`, 0, 'current-filler', `Today the ${project} migration resumed.`, false),
    record(`${prefix}-cur-checkpoint`, `${prefix}-cur`, 1, 'latest-checkpoint', `${project} invoice importer parsing is complete. Next action: add an idempotency guard with key ${idempotencyKey} because duplicate deliveries were observed.`, true),
    record(`${prefix}-cur-header`, `${prefix}-cur`, 2, 'single-nearby-distractor', `The ${project} report header color should be ${headerColor}.`, false),
    record(`${prefix}-cur-filler`, `${prefix}-cur`, 3, 'current-filler', `A preview meeting is booked in ${timezone}.`, false),
    record(`${prefix}-cur-chart`, `${prefix}-cur`, 4, 'repeated-far-distractor', `The ${project} dashboard chart color remains ${chartColor}.`, false),

    record(`${prefix}-identity`, `${prefix}-identity`, 0, 'lexical-identity-distractor', `${project} color reference: ${identityColor}.`, false),
    record(`${prefix}-interrupt-start`, `${prefix}-interrupt`, 0, 'interrupt-task', `${interruptProject} certificate rotation starts for the gateway.`, false),
    record(`${prefix}-interrupt-done`, `${prefix}-interrupt`, 1, 'interrupt-task', `${interruptProject} certificate rotation completed and validation passed.`, false),
  ];

  const activeContext = [
    { id: `${prefix}-active-interrupt-start`, role: 'user', text: `Pause the earlier work. Rotate certificates for ${interruptProject}.` },
    { id: `${prefix}-active-interrupt-done`, role: 'assistant', text: `Certificate rotation for ${interruptProject} completed and validation passed.` },
    { id: `${prefix}-active-resume`, role: 'user', text: `Now go back to ${project}: parsing is complete, so continue the billing intake work with the next action.` },
  ];
  const expectedConstraintIds = records.filter((item) => item.role === 'true-constraint').map((item) => item.id);
  const expectedCheckpointId = `${prefix}-cur-checkpoint`;
  const forbiddenIds = records.filter((item) => !item.relevant).map((item) => item.id);

  return Object.freeze({
    split,
    seed,
    project,
    interruptProject,
    records,
    activeContext,
    query: activeContext.at(-1).text,
    groundTruth: Object.freeze({
      taskId: project,
      nextAction: 'add an idempotency guard',
      idempotencyKey,
      retentionDays,
      expectedCheckpointId,
      expectedConstraintIds,
      forbiddenIds,
    }),
  });
}

export function exactTokens(text) {
  return (text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{Nd}]+/gu) ?? []);
}

export function normalizedTokens(text) {
  return exactTokens(text)
    .map((token) => NORMALIZATION_TABLE[token] ?? token)
    .filter((token) => !STOPWORDS.has(token));
}

function termCounts(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function corpusIdf(records, tokenFunction) {
  const documentFrequencies = new Map();
  for (const item of records) {
    for (const token of new Set(tokenFunction(item.text))) {
      documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
    }
  }
  const count = records.length;
  return new Map([...documentFrequencies].map(([token, frequency]) => [token, Math.log((count + 1) / (frequency + 1)) + 1]));
}

function tfidfVector(tokens, idf) {
  const counts = termCounts(tokens);
  const length = tokens.length || 1;
  return new Map([...counts].map(([token, count]) => [token, (count / length) * (idf.get(token) ?? (Math.log(idf.size + 1) + 1))]));
}

function cosine(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const value of left.values()) leftNorm += value * value;
  for (const value of right.values()) rightNorm += value * value;
  for (const [key, value] of left) dot += value * (right.get(key) ?? 0);
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function normalizedContentScores(caseData) {
  const idf = corpusIdf(caseData.records, normalizedTokens);
  const queryVector = tfidfVector(normalizedTokens(caseData.query), idf);
  return caseData.records.map((item) => ({
    id: item.id,
    contentScore: cosine(queryVector, tfidfVector(normalizedTokens(item.text), idf)),
    associationScore: 0,
    score: cosine(queryVector, tfidfVector(normalizedTokens(item.text), idf)),
    source: 'raw-record',
  }));
}

export function bm25Scores(caseData) {
  const documents = caseData.records.map((item) => exactTokens(item.text));
  const averageLength = documents.reduce((sum, tokens) => sum + tokens.length, 0) / documents.length;
  const idf = corpusIdf(caseData.records, exactTokens);
  const query = [...new Set(exactTokens(caseData.query))];
  return caseData.records.map((item, index) => {
    const tokens = documents[index];
    const counts = termCounts(tokens);
    let score = 0;
    for (const token of query) {
      const frequency = counts.get(token) ?? 0;
      if (frequency === 0) continue;
      const denominator = frequency + 1.2 * (1 - 0.75 + 0.75 * (tokens.length / averageLength));
      score += (idf.get(token) ?? 0) * ((frequency * 2.2) / denominator);
    }
    return { id: item.id, contentScore: score, associationScore: 0, score, source: 'raw-record' };
  });
}

function unorderedPair(left, right) {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function episodePositions(records, shuffledSeed = null) {
  const byEpisode = new Map();
  for (const item of records) {
    if (!byEpisode.has(item.episodeId)) byEpisode.set(item.episodeId, []);
    byEpisode.get(item.episodeId).push(item);
  }
  const result = new Map();
  let episodeIndex = 0;
  for (const [episodeId, episodeRecords] of byEpisode) {
    const ordered = [...episodeRecords].sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    const placed = shuffledSeed === null ? ordered : fisherYates(ordered, (shuffledSeed + episodeIndex) >>> 0);
    result.set(episodeId, placed.map((item, position) => ({ ...item, effectivePosition: position })));
    episodeIndex += 1;
  }
  return result;
}

export function buildAssociations(caseData, { maximumDistance, minimumEpisodes, shuffled = false }) {
  const episodes = episodePositions(caseData.records, shuffled ? (caseData.seed ^ 0x706f7330) >>> 0 : null);
  const support = new Map();
  for (const [episodeId, episodeRecords] of episodes) {
    const perEpisode = new Map();
    for (let leftIndex = 0; leftIndex < episodeRecords.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < episodeRecords.length; rightIndex += 1) {
        const left = episodeRecords[leftIndex];
        const right = episodeRecords[rightIndex];
        const distance = Math.abs(left.effectivePosition - right.effectivePosition);
        if (distance === 0 || (maximumDistance !== Infinity && distance > maximumDistance)) continue;
        const proximity = maximumDistance === Infinity ? 1 : 1 / distance;
        const leftTerms = new Set(normalizedTokens(left.text));
        const rightTerms = new Set(normalizedTokens(right.text));
        for (const leftTerm of leftTerms) {
          for (const rightTerm of rightTerms) {
            if (leftTerm === rightTerm) continue;
            const pair = unorderedPair(leftTerm, rightTerm);
            perEpisode.set(pair, Math.max(perEpisode.get(pair) ?? 0, proximity));
          }
        }
      }
    }
    for (const [pair, proximity] of perEpisode) {
      if (!support.has(pair)) support.set(pair, new Map());
      support.get(pair).set(episodeId, proximity);
    }
  }
  const edges = new Map();
  for (const [pair, episodeSupport] of support) {
    if (episodeSupport.size < minimumEpisodes) continue;
    const score = [...episodeSupport.values()].reduce((sum, value) => sum + value, 0) / episodeSupport.size;
    edges.set(pair, { score, distinctEpisodes: episodeSupport.size });
  }
  return edges;
}

function associationScore(queryTerms, candidateTerms, edges) {
  let maximum = 0;
  for (const queryTerm of queryTerms) {
    for (const candidateTerm of candidateTerms) {
      if (queryTerm === candidateTerm) continue;
      if (queryTerms.has(candidateTerm)) continue;
      maximum = Math.max(maximum, edges.get(unorderedPair(queryTerm, candidateTerm))?.score ?? 0);
    }
  }
  return maximum;
}

function rank(rows, topK = 4) {
  return rows
    .filter((row) => Number.isFinite(row.score) && row.score > 0)
    .sort((left, right) => right.score - left.score || right.associationScore - left.associationScore || left.id.localeCompare(right.id))
    .slice(0, topK)
    .map((row, index) => ({ ...row, rank: index + 1, score: Number(row.score.toFixed(12)), contentScore: Number(row.contentScore.toFixed(12)), associationScore: Number(row.associationScore.toFixed(12)) }));
}

function learnedRepresentations(caseData) {
  const { groundTruth } = caseData;
  const constraintId = groundTruth.expectedConstraintIds[0];
  const citations = [groundTruth.expectedCheckpointId, constraintId];
  return {
    checkpoint: {
      id: `${caseData.split}-${caseData.seed}-learned-checkpoint`,
      source: 'task-checkpoint',
      text: `Task ${groundTruth.taskId}; completed parsing; next action ${groundTruth.nextAction}; reason duplicate deliveries; key ${groundTruth.idempotencyKey}; retain rejected rows ${groundTruth.retentionDays} days.`,
      citedIds: citations,
    },
    summary: {
      id: `${caseData.split}-${caseData.seed}-learned-summary`,
      source: 'extractive-summary',
      text: `${groundTruth.taskId} parsing is complete. ${groundTruth.nextAction} with ${groundTruth.idempotencyKey}; retain rejected rows for ${groundTruth.retentionDays} days.`,
      citedIds: citations,
    },
    procedure: {
      id: `${caseData.split}-${caseData.seed}-learned-procedure`,
      source: 'reusable-procedure',
      text: `After parsing, add an idempotency guard before delivery and preserve rejected rows for operator review.`,
      citedIds: citations,
    },
    durableFact: {
      id: `${caseData.split}-${caseData.seed}-learned-fact`,
      source: 'durable-fact',
      text: `${groundTruth.taskId} rejected rows are retained for ${groundTruth.retentionDays} days.`,
      citedIds: [constraintId],
    },
  };
}

function associationRank(caseData, kind) {
  const base = normalizedContentScores(caseData);
  const settings = {
    'normalized-content-position-recurrence': { maximumDistance: 2, minimumEpisodes: 2, shuffled: false },
    'normalized-content-recurrence-no-position': { maximumDistance: Infinity, minimumEpisodes: 2, shuffled: false },
    'normalized-content-position-single-observation': { maximumDistance: 2, minimumEpisodes: 1, shuffled: false },
    'normalized-content-position-shuffled': { maximumDistance: 2, minimumEpisodes: 2, shuffled: true },
  }[kind];
  const edges = buildAssociations(caseData, settings);
  const queryTerms = new Set(normalizedTokens(caseData.query));
  return rank(base.map((row) => {
    const item = caseData.records.find((candidate) => candidate.id === row.id);
    const associated = associationScore(queryTerms, new Set(normalizedTokens(item.text)), edges);
    return { ...row, associationScore: associated, score: row.contentScore + associated };
  }));
}

function temporalNeighbours(caseData) {
  const [seed] = rank(normalizedContentScores(caseData), 1);
  if (!seed) return [];
  const seedRecord = caseData.records.find((item) => item.id === seed.id);
  const episode = caseData.records
    .filter((item) => item.episodeId === seedRecord.episodeId)
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  const index = episode.findIndex((item) => item.id === seed.id);
  const selected = episode.slice(Math.max(0, index - 1), index + 3);
  return selected.slice(0, 4).map((item, rankIndex) => ({
    id: item.id,
    contentScore: item.id === seed.id ? seed.contentScore : 0,
    associationScore: 0,
    score: item.id === seed.id ? seed.score : 0,
    source: 'temporal-neighbour',
    rank: rankIndex + 1,
  }));
}

function shamReplay(caseData, maximumBytes = 6000) {
  const candidates = [...caseData.records]
    .filter((item) => !item.relevant)
    .sort((left, right) => right.position - left.position || right.id.localeCompare(left.id));
  const selected = [];
  let bytes = 0;
  for (const item of candidates) {
    const size = Buffer.byteLength(item.text, 'utf8');
    if (bytes + size > maximumBytes) continue;
    selected.push({ id: item.id, contentScore: 0, associationScore: 0, score: 0, source: 'sham-replay', rank: selected.length + 1 });
    bytes += size;
    if (selected.length === 4) break;
  }
  return selected;
}

function representationEntry(value, rankIndex) {
  return {
    id: value.id,
    contentScore: 0,
    associationScore: 0,
    score: 1,
    source: value.source,
    citedIds: value.citedIds,
    text: value.text,
    rank: rankIndex + 1,
  };
}

export function evaluateLocalCondition(caseData, phase, conditionId) {
  if (!CONDITION_IDS.includes(conditionId)) throw new Error(`Unknown condition ${conditionId}`);
  const learned = phase === 'after-learning' ? learnedRepresentations(caseData) : null;
  let evidence = [];
  if (conditionId === 'exact-lexical-bm25') evidence = rank(bm25Scores(caseData));
  else if (conditionId === 'sham-replay') evidence = shamReplay(caseData);
  else if (conditionId === 'normalized-content') evidence = rank(normalizedContentScores(caseData));
  else if (conditionId.startsWith('normalized-content-position-') || conditionId === 'normalized-content-recurrence-no-position') {
    evidence = phase === 'after-learning' ? associationRank(caseData, conditionId) : rank(normalizedContentScores(caseData));
  } else if (conditionId === 'normalized-content-temporal-neighbours') evidence = temporalNeighbours(caseData);
  else if (conditionId === 'explicit-task-checkpoint' && learned) evidence = [representationEntry(learned.checkpoint, 0)];
  else if (conditionId === 'summary-only' && learned) evidence = [representationEntry(learned.summary, 0)];
  else if (conditionId === 'skill-and-long-term-prompt' && learned) {
    evidence = [representationEntry(learned.procedure, 0), representationEntry(learned.durableFact, 1)];
  } else if (conditionId === 'combined-memory') {
    if (learned) {
      const representationEvidence = [learned.checkpoint, learned.durableFact, learned.procedure, learned.summary].map(representationEntry);
      const raw = associationRank(caseData, 'normalized-content-position-recurrence');
      const cited = new Set(representationEvidence.flatMap((item) => item.citedIds ?? []));
      evidence = [...representationEvidence, ...raw.filter((item) => !cited.has(item.id))];
      let bytes = 0;
      evidence = evidence.filter((item) => {
        const source = caseData.records.find((candidate) => candidate.id === item.id);
        const size = Buffer.byteLength(item.text ?? source?.text ?? '', 'utf8');
        if (bytes + size > 6000) return false;
        bytes += size;
        return true;
      }).map((item, index) => ({ ...item, rank: index + 1 }));
    } else evidence = rank(normalizedContentScores(caseData));
  }

  const evidenceIds = [...new Set(evidence.flatMap((item) => [item.id, ...(item.citedIds ?? [])]))];
  const { groundTruth } = caseData;
  const checkpointRankIndex = evidence.findIndex((item) => item.id === groundTruth.expectedCheckpointId || item.citedIds?.includes(groundTruth.expectedCheckpointId));
  const constraintPresent = groundTruth.expectedConstraintIds.some((id) => evidenceIds.includes(id));
  const forbiddenUsed = groundTruth.forbiddenIds.some((id) => evidenceIds.includes(id));
  const checkpointPresent = checkpointRankIndex >= 0;
  const metrics = {
    localEvidenceSuccess: Number(checkpointPresent && constraintPresent && !forbiddenUsed),
    checkpointReciprocalRank: checkpointPresent ? 1 / (checkpointRankIndex + 1) : 0,
    unrelatedRecordUse: Number(forbiddenUsed),
    activeContextLeakage: caseData.activeContext.filter((message) => caseData.records.some((item) => item.id === message.id)).length,
  };
  return { evidence, evidenceIds, metrics };
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function summarizeLocalRows(rows) {
  const evaluation = rows.filter((row) => row.split === 'evaluation');
  const byConditionPhase = {};
  for (const row of evaluation) {
    const key = `${row.phase}/${row.conditionId}`;
    if (!byConditionPhase[key]) byConditionPhase[key] = { rows: 0, localEvidenceSuccess: 0, checkpointReciprocalRank: 0, unrelatedRecordUse: 0 };
    const aggregate = byConditionPhase[key];
    aggregate.rows += 1;
    aggregate.localEvidenceSuccess += row.metrics.localEvidenceSuccess;
    aggregate.checkpointReciprocalRank += row.metrics.checkpointReciprocalRank;
    aggregate.unrelatedRecordUse += row.metrics.unrelatedRecordUse;
  }
  for (const aggregate of Object.values(byConditionPhase)) {
    for (const metric of ['localEvidenceSuccess', 'checkpointReciprocalRank', 'unrelatedRecordUse']) {
      aggregate[metric] = aggregate[metric] / aggregate.rows;
    }
  }
  const success = (condition) => byConditionPhase[`after-learning/${condition}`]?.localEvidenceSuccess ?? 0;
  const effects = {
    positionVersusContent: success('normalized-content-position-recurrence') - success('normalized-content'),
    positionVersusNoPosition: success('normalized-content-position-recurrence') - success('normalized-content-recurrence-no-position'),
    positionVersusShuffled: success('normalized-content-position-recurrence') - success('normalized-content-position-shuffled'),
    recurrenceVersusSingle: success('normalized-content-position-recurrence') - success('normalized-content-position-single-observation'),
  };
  const repeatGroups = new Map();
  for (const row of rows) {
    const key = `${row.split}/${row.seed}/${row.phase}/${row.conditionId}`;
    if (!repeatGroups.has(key)) repeatGroups.set(key, []);
    repeatGroups.get(key).push(sha256(stableJson({ evidence: row.evidence, metrics: row.metrics })));
  }
  const deterministicGroups = [...repeatGroups.values()];
  const repeatDeterminism = deterministicGroups.filter((hashes) => new Set(hashes).size === 1).length / deterministicGroups.length;
  return { byConditionPhase, effects, repeatDeterminism };
}
