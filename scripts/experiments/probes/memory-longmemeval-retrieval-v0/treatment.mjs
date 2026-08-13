import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

export const CONDITION_ORDER = Object.freeze([
  "content",
  "recurrence-no-position",
  "repeated-adjacent-position",
  "shuffled-position",
]);

export const ASSOCIATION_WEIGHTS = Object.freeze([0.25, 0.5, 1, 2]);

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "has", "have", "i", "in", "is", "it", "my", "of", "on", "or",
  "that", "the", "this", "to", "was", "were", "what", "when", "where",
  "which", "who", "why", "with", "you", "your",
]);

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;
const CLOSED_INPUT_FIELDS = Object.freeze([
  "question_id",
  "question",
  "sessions",
]);

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertClosedObject(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort(codeUnitCompare);
  const expected = [...fields].sort(codeUnitCompare);
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError(`${label} fields do not match the gold-blind treatment contract`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a nonempty NUL-free string`);
  }
  return value;
}

function requireContent(value, label) {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new TypeError(`${label} must be a NUL-free string`);
  }
  return value;
}

export function tokenize(value) {
  const normalized = value.normalize("NFKC").toLowerCase();
  const tokens = [];
  for (const match of normalized.matchAll(TOKEN_PATTERN)) {
    const token = match[0];
    if ([...token].length >= 2 && !STOP_WORDS.has(token)) tokens.push(token);
  }
  return tokens;
}

function encodeSession(messages, label) {
  if (!Array.isArray(messages)) throw new TypeError(`${label} must be an array`);
  const encoded = messages.map((message, index) => {
    const entry = assertClosedObject(message, ["role", "content"], `${label}[${index}]`);
    return `${requireString(entry.role, `${label}[${index}].role`).toLowerCase()}: ${
      requireContent(entry.content, `${label}[${index}].content`)
    }\n`;
  }).join("").normalize("NFKC").toLowerCase();
  return encoded;
}

function countTokens(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function projectDocuments(input) {
  const entry = assertClosedObject(input, CLOSED_INPUT_FIELDS, "LongMemEval treatment input");
  const questionId = requireString(entry.question_id, "question_id");
  const question = requireString(entry.question, "question");
  if (!Array.isArray(entry.sessions) || entry.sessions.length === 0) {
    throw new TypeError("LongMemEval treatment input must contain sessions");
  }
  const seen = new Set();
  const documents = entry.sessions.map((rawSession, index) => {
    const session = assertClosedObject(rawSession, ["session_id", "messages"], `sessions[${index}]`);
    const sessionId = requireString(session.session_id, `sessions[${index}].session_id`);
    if (seen.has(sessionId)) throw new TypeError(`Duplicate session identifier ${sessionId}`);
    seen.add(sessionId);
    const messages = session.messages;
    const text = encodeSession(messages, `sessions[${index}].messages`);
    const tokens = tokenize(text);
    return Object.freeze({
      sessionId,
      text,
      tokens: Object.freeze(tokens),
      uniqueTokens: new Set(tokens),
      tokenCounts: countTokens(tokens),
      messages: Object.freeze(messages.map((message) => Object.freeze({
        role: message.role,
        content: message.content,
        // Role labels are structural and recur in nearly every session. They
        // remain in the BM25 document encoding but cannot become association
        // edges that connect otherwise unrelated content.
        tokens: Object.freeze(tokenize(message.content)),
      }))),
      contentTokens: new Set(messages.flatMap((message) => tokenize(message.content))),
    });
  });
  return Object.freeze({
    questionId,
    queryTokens: Object.freeze([...new Set(tokenize(question))]),
    documents: Object.freeze(documents),
    rawSessionBytes: documents.reduce(
      (sum, document) => sum + Buffer.byteLength(document.text, "utf8"),
      0,
    ),
  });
}

function bm25(documents, queryTokens) {
  const documentCount = documents.length;
  const averageLength = documents.reduce((sum, document) => sum + document.tokens.length, 0) /
    documentCount;
  const documentFrequency = new Map();
  for (const token of queryTokens) {
    let frequency = 0;
    for (const document of documents) {
      if (document.tokenCounts.has(token)) frequency += 1;
    }
    documentFrequency.set(token, frequency);
  }
  return new Map(documents.map((document) => {
    let score = 0;
    for (const token of queryTokens) {
      const frequency = document.tokenCounts.get(token) ?? 0;
      if (frequency === 0) continue;
      const df = documentFrequency.get(token) ?? 0;
      const idf = Math.log(1 + ((documentCount - df + 0.5) / (df + 0.5)));
      if (averageLength === 0) continue;
      const denominator = frequency + 1.2 * (
        1 - 0.75 + 0.75 * (document.tokens.length / averageLength)
      );
      score += idf * ((frequency * 2.2) / denominator);
    }
    return [document.sessionId, score];
  }));
}

function unorderedPair(left, right) {
  return codeUnitCompare(left, right) < 0 ? `${left}\0${right}` : `${right}\0${left}`;
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

function shuffledMessages(questionId, sessionId, messages) {
  const digest = createHash("sha256")
    .update(questionId, "utf8")
    .update("\0")
    .update(sessionId, "utf8")
    .update("\0position-shuffle", "utf8")
    .digest();
  const random = xorshift32(digest.readUInt32BE(0));
  const result = [...messages];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const selected = Math.floor((random() * (index + 1)) / 0x1_0000_0000);
    [result[index], result[selected]] = [result[selected], result[index]];
  }
  return result;
}

function messagePairs(messages, conditionId) {
  const result = [];
  if (conditionId === "recurrence-no-position") {
    for (let left = 0; left < messages.length; left += 1) {
      for (let right = left + 1; right < messages.length; right += 1) {
        result.push([messages[left], messages[right]]);
      }
    }
    return result;
  }
  for (let index = 0; index + 1 < messages.length; index += 1) {
    result.push([messages[index], messages[index + 1]]);
  }
  return result;
}

function associationGraph(questionId, documents, conditionId) {
  const support = new Map();
  for (const document of documents) {
    const messages = conditionId === "shuffled-position"
      ? shuffledMessages(questionId, document.sessionId, document.messages)
      : document.messages;
    const perSession = new Set();
    for (const [left, right] of messagePairs(messages, conditionId)) {
      const leftTokens = new Set(left.tokens);
      const rightTokens = new Set(right.tokens);
      for (const leftToken of leftTokens) {
        for (const rightToken of rightTokens) {
          if (leftToken !== rightToken) perSession.add(unorderedPair(leftToken, rightToken));
        }
      }
    }
    for (const pair of perSession) support.set(pair, (support.get(pair) ?? 0) + 1);
  }
  const edges = new Map();
  let canonicalBytes = 0;
  for (const [pair, distinctSessions] of [...support].sort(([left], [right]) =>
    codeUnitCompare(left, right)
  )) {
    if (distinctSessions < 2) continue;
    edges.set(pair, distinctSessions);
    const separator = pair.indexOf("\0");
    canonicalBytes += Buffer.byteLength(JSON.stringify({
      left: pair.slice(0, separator),
      right: pair.slice(separator + 1),
      distinctSessions,
    }) + "\n", "utf8");
  }
  return Object.freeze({ edges, canonicalBytes });
}

function associationScore(queryTokens, candidateTokens, edges) {
  const query = new Set(queryTokens);
  for (const queryToken of query) {
    for (const candidateToken of candidateTokens) {
      if (
        queryToken !== candidateToken &&
        !query.has(candidateToken) &&
        edges.has(unorderedPair(queryToken, candidateToken))
      ) {
        return 1;
      }
    }
  }
  return 0;
}

function fixedNumber(value) {
  if (!Number.isFinite(value)) throw new TypeError("Treatment produced a non-finite score");
  return Number(value.toFixed(12));
}

function rank(documents, contentScores, associationScores, weight) {
  return documents.map((document) => {
    const contentScore = contentScores.get(document.sessionId) ?? 0;
    const association = associationScores.get(document.sessionId) ?? 0;
    return {
      sessionId: document.sessionId,
      contentScore,
      associationScore: association,
      score: contentScore + weight * association,
    };
  }).sort((left, right) =>
    right.score - left.score ||
    right.associationScore - left.associationScore ||
    right.contentScore - left.contentScore ||
    codeUnitCompare(left.sessionId, right.sessionId)
  ).slice(0, 10).map((row, index) => Object.freeze({
    rank: index + 1,
    sessionId: row.sessionId,
    score: fixedNumber(row.score),
    contentScore: fixedNumber(row.contentScore),
    associationScore: fixedNumber(row.associationScore),
  }));
}

function elapsedMilliseconds(startedAt) {
  return fixedNumber(Math.max(0, performance.now() - startedAt));
}

export function evaluateTreatmentQuestion(input, selectedWeights = undefined) {
  const totalStartedAt = performance.now();
  const contentStartedAt = performance.now();
  const projection = projectDocuments(input);
  const contentScores = bm25(projection.documents, projection.queryTokens);
  const contentBuildMs = elapsedMilliseconds(contentStartedAt);
  const contentQueryStartedAt = performance.now();
  const contentRanking = rank(
    projection.documents,
    contentScores,
    new Map(projection.documents.map((document) => [document.sessionId, 0])),
    0,
  );
  const contentQueryMs = elapsedMilliseconds(contentQueryStartedAt);
  const conditions = [{
    conditionId: "content",
    variants: [{ weight: 0, ranking: contentRanking }],
    cost: {
      buildMilliseconds: contentBuildMs,
      queryMilliseconds: contentQueryMs,
      edgeCount: 0,
      edgeBytes: 0,
      rawSessionBytes: projection.rawSessionBytes,
    },
  }];

  for (const conditionId of CONDITION_ORDER.slice(1)) {
    const buildStartedAt = performance.now();
    const graph = associationGraph(projection.questionId, projection.documents, conditionId);
    const buildMilliseconds = elapsedMilliseconds(buildStartedAt);
    const queryStartedAt = performance.now();
    const associationScores = new Map(projection.documents.map((document) => [
      document.sessionId,
      associationScore(projection.queryTokens, document.contentTokens, graph.edges),
    ]));
    const weights = selectedWeights === undefined
      ? ASSOCIATION_WEIGHTS
      : [selectedWeights[conditionId]];
    if (weights.some((weight) => !ASSOCIATION_WEIGHTS.includes(weight))) {
      throw new TypeError(`Selected weight for ${conditionId} is outside the frozen grid`);
    }
    const variants = weights.map((weight) => ({
      weight,
      ranking: rank(projection.documents, contentScores, associationScores, weight),
    }));
    const queryMilliseconds = elapsedMilliseconds(queryStartedAt);
    conditions.push({
      conditionId,
      variants,
      cost: {
        buildMilliseconds,
        queryMilliseconds,
        edgeCount: graph.edges.size,
        edgeBytes: graph.canonicalBytes,
        rawSessionBytes: projection.rawSessionBytes,
      },
    });
  }

  return Object.freeze({
    schemaVersion: "memory-longmemeval-retrieval/treatment-result-v2",
    questionId: projection.questionId,
    conditions: Object.freeze(conditions),
    totalMilliseconds: elapsedMilliseconds(totalStartedAt),
  });
}
