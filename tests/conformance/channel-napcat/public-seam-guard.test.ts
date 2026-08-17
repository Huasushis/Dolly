/**
 * Public seam guard for the closed NapCatQQ policy/transport slice.
 *
 * Asserts the closed surface stays closed: the index exports exactly the
 * intended symbols, the host policy and allowlists are frozen immutable
 * objects with no widening mutator, verdicts are returned as discriminated
 * unions (never substitutable booleans), and no file outside the slice wires
 * it into the public runtime yet (the runtime guard remains in place).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as napcat from "../../../src/extensions/channel/napcat/index.js";
import { HOST_OUTBOUND_POLICY, NAPCAT_OUTBOUND_ALLOWLIST } from "../../../src/extensions/channel/napcat/index.js";

const testsDir = resolve(dirname(fileURLToPath(import.meta.url)), ".");
const repoRoot = resolve(testsDir, "../../..");
const sliceRoot = resolve(repoRoot, "src/extensions/channel/napcat");

const EXPECTED_EXPORTS = [
  "normalizeQQId",
  "NAPCAT_OUTBOUND_ALLOWLIST",
  "HOST_OUTBOUND_POLICY",
  "OutboundPolicy",
  "FixedWindowRateLimiter",
  "DEFAULT_RATE_LIMITS",
  "OutboundIdempotency",
  "InboundDedupRegistry",
  "redactDiagnosticString",
  "NoopTransport",
  "OFFLINE_TRANSPORT",
  "NapcatChannel",
  "projectSend",
  "projectInbound",
].sort();

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listTsFiles(full, acc);
    else if (entry.name.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

describe("public module guard", () => {
  it("exports exactly the closed seam surface with no extra symbols", () => {
    const symbols = Object.keys(napcat)
      .filter((k) => k !== "__esModule" && k !== "default")
      .sort();
    expect(symbols).toEqual(EXPECTED_EXPORTS);
  });

  it("freezes the host policy and its allowlist view with no mutator", () => {
    expect(Object.isFrozen(HOST_OUTBOUND_POLICY)).toBe(true);
    expect(Object.isFrozen(NAPCAT_OUTBOUND_ALLOWLIST)).toBe(true);
    expect(Object.isFrozen(NAPCAT_OUTBOUND_ALLOWLIST.groups)).toBe(true);
    expect(Object.isFrozen(NAPCAT_OUTBOUND_ALLOWLIST.users)).toBe(true);

    const gains = NAPCAT_OUTBOUND_ALLOWLIST.groups as readonly string[];
    const gains2 = NAPCAT_OUTBOUND_ALLOWLIST.users as readonly string[];
    expect([...gains].sort()).toEqual(["739571751"]);
    expect([...gains2].sort()).toEqual(["1074313761", "3227435534"]);

    const mutators = Object.getOwnPropertyNames(Object.getPrototypeOf(HOST_OUTBOUND_POLICY));
    expect(mutators).toEqual(["constructor", "evaluate"]);
  });

  it("returns discriminated verdicts, never a bare boolean", () => {
    const allowed = HOST_OUTBOUND_POLICY.evaluate({ kind: "group", id: "739571751" });
    const denied = HOST_OUTBOUND_POLICY.evaluate({ kind: "group", id: "88888" });
    expect(allowed.allowed).toBe(true);
    expect(allowed).toHaveProperty("recipient");
    expect(denied.allowed).toBe(false);
    expect(denied).toHaveProperty("reason");
    // A denied verdict is immutable: it cannot be flipped to an allow verdict.
    expect(() => {
      (denied as { allowed: boolean }).allowed = true;
    }).toThrow();
  });

  it("keeps the napcat channel unreferenced outside its slice (runtime guard holds)", () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(resolve(repoRoot, "src"))) {
      if (file.startsWith(sliceRoot)) continue;
      const relative = file.slice(repoRoot.length + 1);
      if (relative.startsWith("src/extensions/channel")) continue;
      const body = readFileSync(file, "utf8");
      if (/extensions\/channel\/napcat/.test(body)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });
});
