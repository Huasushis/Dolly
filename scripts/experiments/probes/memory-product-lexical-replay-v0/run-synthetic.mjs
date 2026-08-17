#!/usr/bin/env node
// Gold-blind synthetic foundation runner for memory-product-lexical-replay-v0.
//
// Reads only gold-blind case data (`question_id`, `question`, `sessions`),
// runs the existing product treatment, and persists closed ranking/treatment
// rows plus a checksum inventory with exclusive (O_EXCL) writes and fsync.
// It never reads `split.jsonl`, gold session identifiers, answers, or the
// frozen reference rankings. Nothing in this file imports them.

import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateProductLexicalCase } from "./product-lexical.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(HERE, "../../../..");

export const EXPERIMENT_ID = "memory-product-lexical-replay-v0";
export const EXPERIMENT_VERSION = 1;
export const QUERY_LIMIT = 10;
export const SYNTHETIC_RUN_ID = "synthetic-foundation";
export const COMMAND_TEXT =
  "npx tsx scripts/experiments/probes/memory-product-lexical-replay-v0/run-synthetic.mjs <run-directory>\n";

// A tiny synthetic bundle. Every gold label lives only in the test-owned
// split writer, never here; these rows are gold-blind by construction.
export const SYNTHETIC_CASES = Object.freeze([
  {
    question_id: "synthetic-basic",
    question: "which session describes domestic cats?",
    sessions: [
      { session_id: "exact", messages: [{ role: "user", content: "domestic cats live in gardens" }] },
      { session_id: "other", messages: [{ role: "user", content: "a dog enjoys the park and fetches" }] },
      { session_id: "unrelated", messages: [{ role: "user", content: "quantum finance algebra textbook" }] },
    ],
  },
  {
    question_id: "synthetic-duplicates",
    question: "which session plans a city trip?",
    sessions: [
      {
        session_id: "trip",
        messages: [
          { role: "user", content: "plan a city trip to prague" },
          { role: "assistant", content: "book the prague train and hotel" },
          { role: "user", content: "add prague museums to the trip plan" },
        ],
      },
      { session_id: "decoy", messages: [{ role: "user", content: "garden vegetables ripen in autumn" }] },
    ],
  },
  {
    question_id: "synthetic-empty",
    question: "which session is empty?",
    sessions: [
      { session_id: "empty", messages: [] },
      { session_id: "noise", messages: [{ role: "user", content: "random unrelated prose about rail travel" }] },
    ],
  },
]);

export function sha256hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Canonical (deterministic, key-sorted) JSON, matching RFC 8785 byte layout. */
export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function caseDigest(row) {
  const body = row.sessions
    .map((session) =>
      `${session.session_id}\u0000${session.messages.map((m) => `${m.role}\u0000${m.content}`).join("\u0001")}`,
    )
    .join("\u0002");
  return sha256hex(`${row.question_id}\u0000${row.question}\u0000${body}`);
}

/** Gold-blind projection row written to cases.jsonl. */
export function projectionRow(row) {
  return {
    question_id: row.question_id,
    question: row.question,
    sessions: row.sessions,
    caseSha256: caseDigest(row),
  };
}

/** Writes one artifact exclusively (O_EXCL) and fsyncs it before returning. */
export function writeExclusive(entryPath, bytes) {
  mkdirSync(dirname(entryPath), { recursive: true });
  const fd = openSync(entryPath, "wx", 0o644);
  try {
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(fd, bytes, written, bytes.length - written, null);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function serializeJsonLines(rows) {
  return rows.map((row) => `${canonicalJson(row)}\n`).join("");
}

function querySnapshot(result) {
  const generation = result.lexicalGeneration;
  return {
    mode: result.effectiveMode,
    limit: QUERY_LIMIT,
    contextExpansion: 0,
    generation: { generationId: generation.generationId, algorithmId: generation.algorithmId, algorithmVersion: generation.algorithmVersion },
    channelSent: result.channelIds,
  };
}

/** Gold-blind treatment pass. The only exception path emits a typed failed row. */
export async function productRows(cases, limit = QUERY_LIMIT) {
  const rows = [];
  const rawResults = [];
  for (const row of cases) {
    try {
      const result = await evaluateProductLexicalCase(row, limit);
      rawResults.push(result);
      const coverage = result.extractionCoverage;
      rows.push({
        questionId: row.question_id,
        caseSha256: caseDigest(row),
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
      });
    } catch (error) {
      rawResults.push(null);
      rows.push({
        questionId: row.question_id,
        caseSha256: caseDigest(row),
        state: "failed",
        failure: { kind: "permanent-error", reason: String(error?.message ?? error) },
      });
    }
  }
  return { rows, rawResults };
}

export function rankingRowsFrom(rows, rawResults) {
  return rows.flatMap((row, index) => {
    const ranking = rawResults[index]?.ranking ?? [];
    return ranking.map((rank) => ({
      questionId: row.questionId,
      rank: rank.rank,
      recordId: rank.recordId,
      sourceBlockId: rank.sourceBlockId,
      sessionId: rank.sessionId,
      rawBm25: rank.rawBm25,
      caseSha256: row.caseSha256,
    }));
  });
}


function sha256sums(entries) {
  const sorted = [...entries].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  return sorted.map((entry) => `${entry.sha256}  ${entry.name}\n`).join("");
}

/** Writes the complete synthetic bundle; returns its absolute directory. */
export async function writeSyntheticBundle(
  outputDirectory,
  { cases = SYNTHETIC_CASES, limit = QUERY_LIMIT, runId = SYNTHETIC_RUN_ID } = {},
) {
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });

  const projection = cases.map(projectionRow);
  writeExclusive(join(outputDirectory, "cases.jsonl"), serializeJsonLines(projection));

  // Run the treatment once. productRows returns both the closed treatment
  // rows and the raw results (rankings) so no second pass is needed.
  const { rows, rawResults } = await productRows(cases, limit);
  writeExclusive(join(outputDirectory, "treatment.jsonl"), serializeJsonLines(rows));

  const rankings = rankingRowsFrom(rows, rawResults);
  writeExclusive(join(outputDirectory, "product-rankings.jsonl"), serializeJsonLines(rankings));

  const startedAtUs = Date.now() * 1000;
  const manifest = {
    experimentId: EXPERIMENT_ID,
    experimentVersion: EXPERIMENT_VERSION,
    runId,
    frozenAt: new Date().toISOString(),
    casesSha256: sha256hex(serializeJsonLines(projection)),
    splitSha256: null,
    legacyReferenceRows: 0,
    productRows: rows.length,
    rankingRows: rankings.length,
    treatmentHash: sha256hex(serializeJsonLines(rows)),
    sourceHash: sha256hex(moduleSourceFingerprint()),
    checksumInventoryVerified: false,
    workerCount: 1,
    startedAtUs,
    totalJobs: rows.length,
    status: rows.every((row) => row.state === "ok") ? "ok" : "failed",
  };
  writeExclusive(join(outputDirectory, "run-manifest.json"), `${canonicalJson(manifest)}\n`);
  writeExclusive(join(outputDirectory, "command.txt"), COMMAND_TEXT);

  // Checksum inventory: every produced artifact except this file.
  const produced = [
    { name: "cases.jsonl", bytes: serializeJsonLines(projection) },
    { name: "treatment.jsonl", bytes: serializeJsonLines(rows) },
    { name: "product-rankings.jsonl", bytes: serializeJsonLines(rankings) },
    { name: "run-manifest.json", bytes: `${canonicalJson(manifest)}\n` },
    { name: "command.txt", bytes: COMMAND_TEXT },
  ];
  const sums = produced.map((entry) => ({
    name: entry.name,
    sha256: sha256hex(entry.bytes),
  }));
  writeExclusive(join(outputDirectory, "sha256sums.txt"), sha256sums(sums));

  return outputDirectory;
}

function moduleSourceFingerprint() {
  // The sealed runner fingerprints the preregistered source files; for the
  // synthetic foundation the source-freeze surface is the preregistration
  // and the treatment entry path declared in the frozen prereg.
  return [
    "docs/experiments/preregistrations/memory-product-lexical-replay-v0.json",
    "docs/experiments/preregistrations/memory-product-lexical-replay-v0-protocol.md",
    "docs/experiments/preregistrations/memory-product-lexical-replay-v0-schema.json",
    "docs/experiments/preregistrations/memory-product-lexical-replay-v0-artifacts.md",
    "scripts/experiments/probes/memory-product-lexical-replay-v0/product-lexical.mts",
    "scripts/experiments/probes/memory-product-lexical-replay-v0/run-synthetic.mjs",
    "scripts/experiments/probes/memory-product-lexical-replay-v0/analyze-synthetic.mjs",
    "scripts/experiments/probes/memory-product-lexical-replay-v0/verify-synthetic.mjs",
  ].join("\n");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const target = resolve(
    process.argv[2] ??
      join(REPOSITORY_ROOT, "artifacts", "experiments", "probes", EXPERIMENT_ID, "runs", SYNTHETIC_RUN_ID),
  );
  writeSyntheticBundle(target)
    .then((directory) => console.log(`wrote ${directory}`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
