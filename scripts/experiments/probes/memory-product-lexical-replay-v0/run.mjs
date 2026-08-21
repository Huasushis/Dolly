#!/usr/bin/env node
// Gold-blind formal runner for memory-product-lexical-replay-v0.
//
// Reads only a gold-blind `cases.jsonl` projection (closed rows with
// `question_id`, `question`, `sessions`, `caseSha256`), binds every case by
// `questionId` plus `caseSha256`, verifies the frozen reference run checksum
// inventory, and runs each case through the product treatment with a durable
// per-case cache that supports resume and exact progress accounting.
// It never reads `split.jsonl`, gold session identifiers, answers, or the
// reference rankings; nothing here imports them.
//
// The run directory is created with O_EXCL semantics: a second non-resume
// invocation on the same run id is refused. Cache entries are written with
// O_EXCL plus fsync; a resume treats a missing or non-canonical entry as
// not-started and reprocesses it. `cases.jsonl`, `treatment.jsonl`,
// `product-rankings.jsonl`, `run-manifest.json`, and `command.txt` are
// written only after every case is durable, so the analyzer never observes a
// partial treatment.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateProductLexicalCase } from "./product-lexical.mjs";
import {
  EXPERIMENT_ID,
  EXPERIMENT_VERSION,
  QUERY_LIMIT,
  caseDigest,
  canonicalJson,
  projectionRow,
  sha256hex,
  writeExclusive,
} from "./run-synthetic.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(HERE, "../../../..");

export const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/u;

/**
 * Source files frozen into `run-manifest.json` `sourceHash`, in exact list
 * order. Every result-affecting script — the treatment, runner, analyzer,
 * verifier, and finalizer — plus their shared helper and the preregistration
 * documents enter the fingerprint, so editing any of them after a run starts
 * invalidates the run's source freeze.
 */
export const SOURCE_FINGERPRINT_PATHS = Object.freeze([
  "docs/experiments/preregistrations/memory-product-lexical-replay-v0.json",
  "docs/experiments/preregistrations/memory-product-lexical-replay-v0-protocol.md",
  "docs/experiments/preregistrations/memory-product-lexical-replay-v0-schema.json",
  "docs/experiments/preregistrations/memory-product-lexical-replay-v0-artifacts.md",
  "scripts/experiments/probes/memory-product-lexical-replay-v0/product-lexical.mts",
  "scripts/experiments/probes/memory-product-lexical-replay-v0/run-synthetic.mjs",
  "scripts/experiments/probes/memory-product-lexical-replay-v0/run.mjs",
  "scripts/experiments/probes/memory-product-lexical-replay-v0/analyze.mjs",
  "scripts/experiments/probes/memory-product-lexical-replay-v0/verify.mjs",
  "scripts/experiments/probes/memory-product-lexical-replay-v0/finalize.mjs",
]);

/** Exact artifact files covered by the formal checksum inventory. */
export const CHECKSUM_FILES = Object.freeze([
  "cases.jsonl",
  "split.jsonl",
  "treatment.jsonl",
  "product-rankings.jsonl",
  "analyse.json",
  "run-manifest.json",
  "mutation-summary.json",
  "command.txt",
]);

const PROJECTION_FIELDS = ["question_id", "question", "sessions", "caseSha256"];

/** Final outputs written only after every case cache entry is durable. */
const OUTPUT_FILES = Object.freeze([
  "cases.jsonl",
  "treatment.jsonl",
  "product-rankings.jsonl",
  "run-manifest.json",
  "command.txt",
]);

function serializeJsonLines(rows) {
  return rows.map((row) => `${canonicalJson(row)}\n`).join("");
}

/** Canonical JSONL reader shared by the formal analyzer entry point. */
export function parseCanonicalJsonLines(bytes) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n") || text.includes("\r") || text.endsWith("\n\n")) {
    throw new TypeError("non-canonical JSONL line endings");
  }
  if (text.length === 0) return [];
  const rows = text
    .slice(0, -1)
    .split("\n")
    .map((l) => JSON.parse(l));
  const roundTrip = rows.map((row) => `${canonicalJson(row)}\n`).join("");
  if (roundTrip !== text) throw new TypeError("non-canonical JSONL encoding");
  return rows;
}

/** Fails unless the frozen reference run inventory matches its own checksums. */
export function verifyReferenceInventory(referenceRun) {
  const directory = resolve(referenceRun);
  const inventoryPath = join(directory, "sha256sums.txt");
  if (!existsSync(inventoryPath)) {
    throw new TypeError(`reference run inventory missing: ${inventoryPath}`);
  }
  const inventory = readFileSync(inventoryPath, "utf8");
  const lines = inventory.split("\n").filter((line) => line.length > 0);
  const seen = new Set();
  for (const line of lines) {
    const match = /^(?<hash>[0-9a-f]{64})  (?<name>.*)$/.exec(line);
    if (match === null) throw new TypeError(`malformed inventory line: ${line}`);
    const { hash, name } = match.groups;
    if (seen.has(name)) throw new TypeError(`duplicate inventory entry: ${name}`);
    seen.add(name);
    const path = join(directory, name);
    if (!existsSync(path)) throw new TypeError(`inventory file missing: ${name}`);
    if (sha256hex(readFileSync(path, "utf8")) !== hash) {
      throw new TypeError(`inventory hash mismatch: ${name}`);
    }
  }
  if (seen.size === 0) throw new TypeError("reference run inventory is empty");
  return seen;
}

function querySnapshot(result) {
  const generation = result.lexicalGeneration;
  return {
    mode: result.effectiveMode,
    limit: QUERY_LIMIT,
    contextExpansion: 0,
    generation: {
      generationId: generation.generationId,
      algorithmId: generation.algorithmId,
      algorithmVersion: generation.algorithmVersion,
    },
    channelSent: result.channelIds,
  };
}

/**
 * Classifies a caught treatment error into one of the four typed failure
 * kinds. Limit errors are every `MEMORY_LIMIT_EXCEEDED`; job-state and
 * fenced-generation errors are job failures; anything else is a permanent
 * error. Untyped errors are never passed through as `ok`.
 */
function typedFailureKind(caught) {
  const code = typeof caught?.code === "string" ? caught.code : undefined;
  if (code === "MEMORY_LIMIT_EXCEEDED") return "limit-failure";
  if (code === "MEMORY_JOB_STATE_INVALID" || code === "MEMORY_GENERATION_FENCED") {
    return "job-failure";
  }
  return "permanent-error";
}

function failedRow(input, digest, kind, reason) {
  return {
    row: {
      questionId: input.question_id,
      caseSha256: digest,
      state: "failed",
      failure: { kind, reason },
    },
    rankings: [],
  };
}

/**
 * Gold-blind single-case worker. Returns a typed closed treatment row plus
 * the ranking rows for that case; never reads split, gold, or reference.
 * Typed failures are stable and distinct: a `limit-failure` for a configured
 * budget, a `coverage-failure` for uncovered/truncated/typed-skipped source
 * bytes, a `job-failure` for pending/running/retryable/permanently-failed
 * jobs or outstanding leases, and `permanent-error` for any other
 * unrecoverable treatment error. Any typed failure persists a closed failed
 * row with `state: "failed"`.
 */
export async function processCase(input, limit = QUERY_LIMIT) {
  const digest = caseDigest(input);
  try {
    const result = await evaluateProductLexicalCase(input, limit);
    const coverage = result.extractionCoverage;
    const jobsNonTerminal =
      result.terminalJobAccounting.pending > 0 ||
      result.terminalJobAccounting.running > 0 ||
      result.terminalJobAccounting.retryable > 0 ||
      result.terminalJobAccounting.permanentFailure > 0 ||
      result.terminalJobAccounting.cancelled > 0 ||
      result.terminalJobAccounting.outstandingLeases > 0;
    if (jobsNonTerminal) {
      return failedRow(input, digest, "job-failure",
        `terminal job accounting is not clean after indexing ${input.question_id}`);
    }
    if (!coverage.complete) {
      return failedRow(input, digest, "coverage-failure",
        `coverage is not complete for ${input.question_id}`);
    }
    const row = {
      questionId: input.question_id,
      caseSha256: digest,
      state: "ok",
      coverage: {
        normalizedInputBytes: coverage.normalizedInputBytes,
        coveredNormalizedBytes: coverage.coveredNormalizedBytes,
        uncoveredNormalizedBytes: coverage.uncoveredNormalizedBytes,
        truncatedItems: coverage.truncatedItems,
        skippedItemsByReason: { ...coverage.skippedItemsByReason },
        complete: coverage.complete,
      },
      terminalJobs: { ...result.terminalJobAccounting },
      limit,
      queries: [querySnapshot(result)],
      recordCount: result.recordCount,
      featureCount: result.featureCount,
      canonicalRecordBytes: result.canonicalRecordBytes,
      canonicalFeatureBytes: result.canonicalFeatureBytes,
    };
    const rankings = result.ranking.map((rank) => ({
      questionId: input.question_id,
      rank: rank.rank,
      recordId: rank.recordId,
      sourceBlockId: rank.sourceBlockId,
      sessionId: rank.sessionId,
      rawBm25: rank.rawBm25,
      caseSha256: digest,
    }));
    return { row, rankings };
  } catch (error) {
    return failedRow(input, digest, typedFailureKind(error), String(error?.message ?? error));
  }
}

function readCacheEntry(cachePath) {
  try {
    const bytes = readFileSync(cachePath, "utf8");
    const value = JSON.parse(bytes);
    if (`${canonicalJson(value)}\n` !== bytes) return undefined;
    if (value === null || typeof value !== "object" || value.row === undefined ||
        !Array.isArray(value.rankings)) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function sourceFingerprint() {
  return SOURCE_FINGERPRINT_PATHS
    .map((path) => `${path}\u0000${sha256hex(readFileSync(resolve(REPOSITORY_ROOT, path), "utf8"))}`)
    .join("\n");
}

function commandText(casesPath, runId, options) {
  const parts = [
    `npx tsx ${join(HERE, "run.mjs")} --cases ${resolve(casesPath)} --run ${runId}`,
    `--max-workers ${options.maxWorkers}`,
    ...(options.resume ? ["--resume"] : []),
  ];
  return `${parts.join(" ")}\n`;
}

/**
 * Treat every gold-blind case with a durable per-case cache. `resume` reopens
 * an existing run id, replays its completed cache, and reprocesses only
 * missing or non-canonical entries; without `resume`, an existing run id is
 * refused. Progress reports carry the exact `complete`, `failed`, and
 * `notStarted` accounting after every processed case.
 */
export async function runFormal(
  casesPath,
  runDir,
  { maxWorkers = 1, resume = false, onProgress = undefined } = {},
) {
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1) {
    throw new TypeError("maxWorkers must be a positive integer");
  }
  const absolute = resolve(runDir);
  const runId = basename(absolute);
  if (!RUN_ID_PATTERN.test(runId)) throw new TypeError(`invalid run id ${runId}`);

  const cases = parseCanonicalJsonLines(readFileSync(resolve(casesPath), "utf8"));
  const sortedProjectionFields = [...PROJECTION_FIELDS].sort(compareCodeUnits);
  const seen = new Set();
  for (const [index, row] of cases.entries()) {
    const keys = Object.keys(row).sort(compareCodeUnits);
    if (keys.length !== sortedProjectionFields.length ||
        keys.some((key, i) => key !== sortedProjectionFields[i])) {
      throw new TypeError(`projection row ${index} has unexpected fields`);
    }
    if (seen.has(row.question_id)) throw new TypeError(`duplicate question_id ${row.question_id}`);
    seen.add(row.question_id);
    if (row.caseSha256 !== caseDigest(row)) {
      throw new TypeError(`case binding failed for ${row.question_id}`);
    }
  }

  mkdirSync(dirname(absolute), { recursive: true });
  let created = false;
  try {
    mkdirSync(absolute);
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!resume) {
      const refusal = new TypeError(
        `duplicate run id refused: ${runId} already exists at ${absolute} (pass --resume to continue)`,
      );
      refusal.code = "DUPLICATE_RUN_ID";
      throw refusal;
    }
  }
  const cacheDir = join(absolute, "cache");
  mkdirSync(cacheDir, { recursive: true });

  const ledger = [];
  let complete = 0;
  let failed = 0;
  const total = cases.length;
  const report = () => onProgress?.({ complete, failed, notStarted: total - complete - failed });

  for (const input of cases) {
    const cachePath = join(cacheDir, `${input.question_id}.json`);
    let entry = undefined;
    if (created === false && resume) entry = readCacheEntry(cachePath);
    if (entry === undefined) {
      if (existsSync(cachePath)) rmSync(cachePath);
      entry = await processCase(input, QUERY_LIMIT);
      writeExclusive(cachePath, `${canonicalJson(entry)}\n`);
    }
    ledger.push(entry);
    if (entry.row.state === "ok") complete += 1;
    else failed += 1;
    report();
  }
  const notStarted = total - complete - failed;

  if (!created) {
    // Resume re-opens an existing id; its final outputs are rebuilt from the
    // durable cache, so any previously written outputs are unlocked first.
    for (const name of OUTPUT_FILES) rmSync(join(absolute, name), { force: true });
  }

  const projection = cases.map(projectionRow);
  const rows = ledger.map((entry) => entry.row);
  const rankings = ledger.flatMap((entry) => entry.rankings);
  writeExclusive(join(absolute, "cases.jsonl"), serializeJsonLines(projection));
  writeExclusive(join(absolute, "treatment.jsonl"), serializeJsonLines(rows));
  writeExclusive(join(absolute, "product-rankings.jsonl"), serializeJsonLines(rankings));

  const frozenAt = new Date().toISOString();
  const manifest = {
    experimentId: EXPERIMENT_ID,
    experimentVersion: EXPERIMENT_VERSION,
    runId,
    frozenAt,
    casesSha256: sha256hex(serializeJsonLines(projection)),
    splitSha256: null,
    legacyReferenceRows: 0,
    productRows: rows.length,
    rankingRows: rankings.length,
    treatmentHash: sha256hex(serializeJsonLines(rows)),
    sourceHash: sha256hex(sourceFingerprint()),
    checksumInventoryVerified: false,
    workerCount: maxWorkers,
    startedAtUs: Date.now() * 1000,
    totalJobs: total,
    status: rows.every((row) => row.state === "ok") ? "ok" : "failed",
  };
  writeExclusive(join(absolute, "run-manifest.json"), `${canonicalJson(manifest)}\n`);
  writeExclusive(join(absolute, "command.txt"),
    commandText(casesPath, runId, { maxWorkers, resume }));

  return {
    directory: absolute,
    runId,
    accounting: { complete, failed, notStarted },
  };
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseArguments(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    if (index < 0 || index + 1 >= argv.length) return undefined;
    return argv[index + 1];
  };
  const cases = value("--cases");
  const run = value("--run");
  const maxWorkers = Number(value("--max-workers") ?? "1");
  if (cases === undefined || run === undefined) {
    throw new TypeError(
      "usage: run.mjs --cases <cases.jsonl> --run <run-id> [--max-workers N] [--resume]",
    );
  }
  return {
    cases,
    run,
    maxWorkers: Number.isSafeInteger(maxWorkers) && maxWorkers >= 1 ? maxWorkers : 1,
    resume: argv.includes("--resume"),
  };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2));
  const runDir = join(
    REPOSITORY_ROOT,
    "artifacts",
    "experiments",
    "probes",
    EXPERIMENT_ID,
    "runs",
    args.run,
  );
  const result = await runFormal(args.cases, runDir, {
    maxWorkers: args.maxWorkers,
    resume: args.resume,
  });
  process.stdout.write(`${canonicalJson(result)}\n`);
}
