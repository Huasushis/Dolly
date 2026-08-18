#!/usr/bin/env node
// Deterministic finalizer and mutation harness for memory-product-lexical-replay-v0.
//
// Runs only after the gold-blind runner has made every treatment row durable.
// It writes gold (`split.jsonl`) into the run bundle itself, spawns the
// analyzer in a separate process, then proves the frozen verifier contract by
// attempting every registered mutation on disposable copies: each mutation
// must be rejected with its fixed expected code. It then records the verdict
// in analyse.json, refreshes the manifest split binding, writes the mutation
// summary, and finalizes the exact checksum inventory last. This module never
// executes the treatment or reads sealed reference data beyond bytes passed
// in; it imports only the verifier and shared canonical helpers.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256hex, writeExclusive } from "./run-synthetic.mjs";
import { CHECKSUM_FILES, EXPECTED_MUTATIONS, verifyCore } from "./verify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const DURABLE_GATE_FILES = Object.freeze([
  "cases.jsonl",
  "treatment.jsonl",
  "product-rankings.jsonl",
  "run-manifest.json",
  "command.txt",
]);

const PRE_FINALIZE_FILES = Object.freeze(CHECKSUM_FILES.filter((name) => name !== "mutation-summary.json"));

function parseCanonicalJsonLines(bytes) {
  const text = bytes.toString("utf8");
  if (text.length === 0) return [];
  if (!text.endsWith("\n")) throw new TypeError("non-canonical JSONL line endings");
  const rows = text.slice(0, -1).split("\n").map((line) => JSON.parse(line));
  const roundTrip = rows.map((row) => `${canonicalJson(row)}\n`).join("");
  if (roundTrip !== text) throw new TypeError("non-canonical JSONL encoding");
  return rows;
}

function writeJsonLines(path, rows) {
  writeFileSync(path, rows.map((row) => `${canonicalJson(row)}\n`).join(""));
}

function readJsonLines(path) {
  return parseCanonicalJsonLines(readFileSync(path, "utf8"));
}

function mutateJsonLines(copyDir, name, mutate) {
  const rows = readJsonLines(join(copyDir, name));
  mutate(rows);
  writeJsonLines(join(copyDir, name), rows);
}

function writeInventory(directory, names) {
  const entries = names
    .map((name) => ({ name, hash: sha256hex(readFileSync(join(directory, name), "utf8")) }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  writeFileSync(join(directory, "sha256sums.txt"),
    entries.map((entry) => `${entry.hash}  ${entry.name}\n`).join(""));
}

function copyForMutation(runDir, mutationId, inventory = true) {
  const copy = mkdtempSync(join(tmpdir(), `dolly-lexical-mutation-${mutationId}-`));
  for (const name of PRE_FINALIZE_FILES) {
    writeFileSync(join(copy, name), readFileSync(join(runDir, name)));
  }
  if (inventory) writeInventory(copy, [...PRE_FINALIZE_FILES]);
  return copy;
}

/** One registered mutation operator per frozen mutation id. */
const MUTATION_OPERATORS = Object.freeze({
  "projection-forbidden-field": (copy) =>
    mutateJsonLines(copy, "cases.jsonl", (rows) => {
      rows[0].extra = "not-in-projection";
    }),
  "projection-gold-leak": (copy) =>
    mutateJsonLines(copy, "cases.jsonl", (rows) => {
      rows[0].answer_session_ids = [];
    }),
  "split-gold-session-forged": (copy) =>
    mutateJsonLines(copy, "split.jsonl", (rows) => {
      rows[0].goldSessionIds = ["forged-session-not-in-case"];
    }),
  "ranking-row-removed": (copy) =>
    mutateJsonLines(copy, "product-rankings.jsonl", (rows) => {
      const grouped = new Map();
      for (const row of rows) {
        if (!grouped.has(row.questionId)) grouped.set(row.questionId, []);
        grouped.get(row.questionId).push(row);
      }
      const target = [...grouped.values()].find((list) => list.length >= 2);
      if (target === undefined) throw new TypeError("no ranking with at least two rows");
      const removed = target[0];
      rows.splice(rows.indexOf(removed), 1);
    }),
  "treatment-coverage-forged": (copy) =>
    mutateJsonLines(copy, "treatment.jsonl", (rows) => {
      const row = rows.find((entry) => entry.state === "ok");
      if (row === undefined) throw new TypeError("no ok treatment row to forge");
      row.coverage.uncoveredNormalizedBytes = 1;
    }),
  "analysis-metrics-forged": (copy) => {
    const analysis = JSON.parse(readFileSync(join(copy, "analyse.json"), "utf8"));
    analysis.primaryMetrics.ndcg10.product += 0.25;
    writeFileSync(join(copy, "analyse.json"), `${canonicalJson(analysis)}\n`);
  },
  "checksum-entry-removed": (copy) => {
    const inventory = readFileSync(join(copy, "sha256sums.txt"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    writeFileSync(join(copy, "sha256sums.txt"),
      inventory.slice(1).map((line) => `${line}\n`).join(""));
  },
  "secret-marker-injected": (copy) => {
    writeFileSync(join(copy, "run-manifest.json"),
      `${readFileSync(join(copy, "run-manifest.json"), "utf8")}say-this-is-secret\n`);
  },
});

/**
 * Finalizes a completed gold-blind run. Writes `split.jsonl` from `splitPath`
 * (the only gold handoff, performed after every treatment row is durable),
 * spawns the analyzer subprocess, proves all registered mutations are
 * rejected on copies, then seals the bundle with the exact checksum
 * inventory. `onMutation` observes each mutation outcome (mutationId, code,
 * rejected) as it is recorded.
 */
export async function finalizeFormal(
  runDir,
  { splitPath, referencePath, onMutation = undefined } = {},
) {
  const directory = resolve(runDir);
  for (const name of DURABLE_GATE_FILES) {
    if (!existsSync(join(directory, name))) {
      const missing = new TypeError(`finalize requires durable ${name} in ${directory}`);
      missing.code = "FINALIZE_INCOMPLETE_RUN";
      throw missing;
    }
  }
  if (existsSync(join(directory, "sha256sums.txt"))) {
    const sealed = new TypeError(`run ${directory} is already finalized`);
    sealed.code = "FINALIZE_ALREADY_FINALIZED";
    throw sealed;
  }
  if (splitPath === undefined || referencePath === undefined) {
    throw new TypeError("finalize requires splitPath and referencePath");
  }

  // Gold enters the bundle only here; the treatment is already durable.
  const splitBytes = readFileSync(resolve(splitPath), "utf8");
  parseCanonicalJsonLines(splitBytes);
  writeExclusive(join(directory, "split.jsonl"), splitBytes);

  const analysisText = execFileSync(
    process.execPath,
    [join(HERE, "analyze.mjs"), directory, "--reference", resolve(referencePath)],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  writeExclusive(join(directory, "analyse.json"),
    analysisText.endsWith("\n") ? analysisText : `${analysisText}\n`);
  const analysis = JSON.parse(analysisText);

  const entries = [];
  for (const expected of EXPECTED_MUTATIONS) {
    const copy = copyForMutation(directory, expected.mutationId);
    try {
      MUTATION_OPERATORS[expected.mutationId](copy);
      if (expected.mutationId !== "checksum-entry-removed") {
        writeInventory(copy, [...PRE_FINALIZE_FILES]);
      }
      const outcome = verifyCore(copy, {
        validateAttestations: false,
        referencePath: resolve(referencePath),
      });
      const rejected = outcome.valid !== true && outcome.code === expected.expectedCode;
      entries.push({
        mutationId: expected.mutationId,
        expectedCode: expected.expectedCode,
        code: outcome.code ?? null,
        rejected,
      });
      onMutation?.({ mutationId: expected.mutationId, code: outcome.code ?? null, rejected });
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
  const allRejected = entries.every((entry) => entry.rejected);
  if (!allRejected) {
    const accepted = new TypeError(
      `mutation harness failed: ${entries.filter((entry) => !entry.rejected)
        .map((entry) => `${entry.mutationId}:${String(entry.code)}`)
        .join(",")}`,
    );
    accepted.code = "FINALIZE_MUTATION_ACCEPTED";
    throw accepted;
  }

  const attested = {
    ...analysis,
    decisionGates: analysis.decisionGates.map((gate) =>
      gate.gate === "structural-validation" ? { ...gate, passed: true } : gate),
    mutationRejected: true,
    verifier: { module: "verify.mjs", mutationsRejected: entries.length },
    verdict: {
      valid: true,
      classification: analysis.classification,
      mutationCount: entries.length,
      allRejected: true,
    },
  };
  rmSync(join(directory, "analyse.json"));
  writeExclusive(join(directory, "analyse.json"), `${canonicalJson(attested)}\n`);

  const manifest = JSON.parse(readFileSync(join(directory, "run-manifest.json"), "utf8"));
  const sealed = {
    ...manifest,
    splitSha256: sha256hex(splitBytes),
    checksumInventoryVerified: true,
  };
  rmSync(join(directory, "run-manifest.json"));
  writeExclusive(join(directory, "run-manifest.json"), `${canonicalJson(sealed)}\n`);

  writeExclusive(join(directory, "mutation-summary.json"), `${canonicalJson({
    mutationCount: entries.length,
    allRejected: true,
    entries,
  })}\n`);

  const inventoryEntries = CHECKSUM_FILES
    .map((name) => ({ name, hash: sha256hex(readFileSync(join(directory, name), "utf8")) }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  writeExclusive(join(directory, "sha256sums.txt"),
    inventoryEntries.map((entry) => `${entry.hash}  ${entry.name}\n`).join(""));

  const final = verifyCore(directory, {
    validateAttestations: true,
    referencePath: resolve(referencePath),
  });
  if (!final.valid) {
    const failed = new TypeError(
      `final bundle verification failed: ${String(final.code)} ${String(final.message)}`,
    );
    failed.code = final.code;
    throw failed;
  }
  return {
    directory,
    classification: attested.classification,
    mutationSummary: { mutationCount: entries.length, allRejected: true, entries },
  };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const runDirectory = args[0];
  const flag = (name) => {
    const index = args.indexOf(name);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
  };
  if (runDirectory === undefined || flag("--split") === undefined || flag("--reference") === undefined) {
    console.error("usage: finalize.mjs <run-directory> --split <split.jsonl> --reference <rankings>");
    process.exitCode = 1;
  } else {
    finalizeFormal(runDirectory, {
      splitPath: flag("--split"),
      referencePath: flag("--reference"),
      onMutation: (entry) =>
        console.error(`mutation ${entry.mutationId}: rejected=${entry.rejected} code=${entry.code}`),
    })
      .then((result) => process.stdout.write(`${canonicalJson(result)}\n`))
      .catch((error) => {
        console.error(String(error?.message ?? error));
        process.exitCode = 1;
      });
  }
}

