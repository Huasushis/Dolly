/**
 * Shared conformance helpers for Core-state identity-domain cutover.
 *
 * A legacy Core-state document can no longer accept new caller-supplied
 * process records through the store's write API; the only sanctioned way for
 * a test to obtain a legacy document that already contains process records is
 * to write those records into the persisted JSON document directly (exactly
 * as the explicit migration conformance does for version 15-17 seeds). These
 * helpers rewrite the already-created version 18 document in place with the
 * exact records a test needs, recomputing the canonical state digest so the
 * reopened store accepts them.
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  canonicalJsonDigest,
  type JsonValue,
} from "../../../../src/core/canonical-json.js";
import type {
  ModuleProcessRecord,
  ModuleSubmissionRecord,
} from "../../../../src/core/module-process-records.js";

export interface LegacyProcessDocumentSeed {
  readonly processRecords: readonly ModuleProcessRecord[];
  readonly submissionRecords?: readonly ModuleSubmissionRecord[];
}

/**
 * Rewrites a freshly created version 18 Core-state document in place so that
 * it already contains the supplied process (and optionally submission)
 * records. Must be called after the store that created the empty document is
 * opened; the test then reopens the store to load the seeded records.
 */
export function seedLegacyProcessRecords(
  coreStatePath: string,
  seed: LegacyProcessDocumentSeed,
): void {
  const document = JSON.parse(readFileSync(coreStatePath, "utf8")) as unknown as
    Record<string, JsonValue>;
  const { stateDigest: _stateDigest, ...payload } = document;
  const rewritten: Record<string, JsonValue> = {
    ...payload,
    moduleProcessRecords: seed.processRecords
      .slice()
      .sort((left, right) =>
        left.processGenerationId < right.processGenerationId ? -1 : 1,
      ) as unknown as JsonValue,
    moduleSubmissionRecords: (seed.submissionRecords === undefined
      ? []
      : seed.submissionRecords
          .slice()
          .sort((left, right) =>
            left.runId < right.runId ? -1 : 1,
          )) as unknown as JsonValue,
  };
  const seeded: Record<string, JsonValue> = {
    schemaVersion: "dolly.core-state/18" as JsonValue,
    stateDigest: canonicalJsonDigest(rewritten),
    ...rewritten,
  };
  writeFileSync(coreStatePath, `${JSON.stringify(seeded)}\n`, "utf8");
}
