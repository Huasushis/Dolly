import { createHash } from "node:crypto";

export const EXPERIMENT_ID = "memory-factorial-v0";
export const EXPERIMENT_VERSION = 2;

export const CUE_TYPES = [
  "positive",
  "do-not-resume",
  "cancelled",
  "superseded",
];

export const CELL_IDS = [
  "content-raw",
  "association-raw",
  "deterministic-checkpoint",
  "checkpoint-association-raw",
];

export const ACTION_ARGUMENT_KEYS = Object.freeze({
  add_idempotency_guard: ["idempotencyKey"],
  reconcile_duplicate_deliveries: ["batchId"],
  restart_service: ["serviceName"],
  revert_release: ["releaseId", "serviceName"],
});

export const REQUIRED_IMPLEMENTATION_FILES = [
  "scripts/experiments/probes/memory-factorial-v0/common.mjs",
  "scripts/experiments/probes/memory-factorial-v0/dataset.mjs",
  "scripts/experiments/probes/memory-factorial-v0/scorer.mjs",
  "scripts/experiments/probes/memory-factorial-v0/run.mjs",
  "scripts/experiments/probes/memory-factorial-v0/verify.mjs",
  "scripts/experiments/probes/memory-factorial-v0/run-mutation-tests.mjs",
  "scripts/experiments/probes/memory-factorial-v0/validate-preregistration.mjs",
];

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

export function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const TOKEN_ALIASES = Object.freeze({
  billing: "import",
  importer: "import",
  imports: "import",
  intake: "import",
  invoices: "invoice",
  failed: "rejected",
  errors: "rejected",
  kept: "retain",
  retention: "retain",
  retained: "retain",
  incident: "service",
  incidents: "service",
  outage: "service",
  outages: "service",
  diagnostics: "diagnostic",
  crashes: "diagnostic",
  logs: "diagnostic",
  preserved: "retain",
});

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "before", "by", "continue", "continuing", "do", "for",
  "from", "has", "in", "is", "it", "must", "no", "not", "of", "on", "operation", "or",
  "so", "that", "the", "their", "this", "to", "was", "were", "with",
]);

export function tokenize(text) {
  const normalized = text.normalize("NFKC").toLowerCase();
  const matches = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return [...new Set(matches
    .map((token) => TOKEN_ALIASES[token] ?? token)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token)))];
}

export function actionEquals(left, right) {
  if (left === null || right === null) return left === right;
  return stableJson(left) === stableJson(right);
}

export function validateClosedAction(action) {
  if (action === null) return { valid: true };
  if (!exactKeys(action, ["operation", "arguments"])) {
    return { valid: false, reason: "action keys mismatch" };
  }
  if (typeof action.operation !== "string" || !(action.operation in ACTION_ARGUMENT_KEYS)) {
    return { valid: false, reason: "unknown action operation" };
  }
  const requiredKeys = ACTION_ARGUMENT_KEYS[action.operation];
  if (!exactKeys(action.arguments, requiredKeys)) {
    return { valid: false, reason: "action argument keys mismatch" };
  }
  if (requiredKeys.some((key) => typeof action.arguments[key] !== "string" || action.arguments[key].length === 0)) {
    return { valid: false, reason: "action argument value mismatch" };
  }
  return { valid: true };
}

export function parseJsonLines(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split("\n").map((line) => JSON.parse(line));
}

export function serializeJsonLines(rows) {
  return `${rows.map((row) => stableJson(row)).join("\n")}\n`;
}

export function deepClone(value) {
  return structuredClone(value);
}
