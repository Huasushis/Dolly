#!/usr/bin/env node

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
import { loadBundle, validateBundle } from "./verify-v2.mjs";

const DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DIRECTORY, "../../../..");
const RUN_ID = "live-v1-20260812a";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function clone(files) {
  return new Map([...files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
}

function replaceCanonical(files, name, mutate, patchManifest = true) {
  const value = JSON.parse(files.get(name).toString("utf8"));
  mutate(value);
  const bytes = Buffer.from(`${canonical(value)}\n`, "utf8");
  files.set(name, bytes);
  if (!patchManifest || name === "manifest.json") return;
  const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  const artifact = manifest.artifacts.find((entry) => entry.path === name);
  artifact.byteLength = bytes.byteLength;
  artifact.sha256 = sha256(bytes);
  files.set("manifest.json", Buffer.from(`${canonical(manifest)}\n`, "utf8"));
}

const environment = dotenv.parse(readFileSync(join(ROOT, ".env")));
const original = loadBundle(join(
  ROOT,
  "artifacts/experiments/probes/dynamic-config-agent-live-v0",
  RUN_ID,
));
original.delete("validation-v2.json");
const cases = [
  ["run-identity-drift", (files) => replaceCanonical(files, "result.json", (value) => { value.runId = "live-v1-forged"; })],
  ["unhashed-response", (files) => replaceCanonical(files, "manifest.json", (value) => {
    value.artifacts = value.artifacts.filter((entry) => entry.path !== "round-0.response.sse");
  }, false)],
  ["message-drift", (files) => replaceCanonical(files, "round-0.request.json", (value) => {
    value.messages = [{ role: "system", content: "forged" }, { role: "user", content: "forged" }];
  })],
  ["raw-sse-byte", (files) => {
    const bytes = Buffer.from(files.get("round-0.response.sse"));
    bytes[0] ^= 1;
    files.set("round-0.response.sse", bytes);
  }],
  ["result-tool-order", (files) => replaceCanonical(files, "result.json", (value) => {
    value.toolEvents.reverse();
  })],
];
const outcomes = [];
for (const [name, mutate] of cases) {
  const files = clone(original);
  mutate(files);
  const validation = await validateBundle({
    files,
    runId: RUN_ID,
    privateValues: [environment.AETHER_BASE_URL, environment.AETHER_API_KEY],
  });
  outcomes.push({ name, rejected: !validation.valid, failureCount: validation.failures.length });
}
const accepted = outcomes.filter((outcome) => !outcome.rejected);
process.stdout.write(`${canonical({ mutationCount: outcomes.length, rejected: outcomes.length - accepted.length, outcomes })}\n`);
if (accepted.length > 0) process.exitCode = 1;
