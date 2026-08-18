/**
 * Conformance test for the restore-identity modes planner.
 *
 * The authoritative input is the imported vector `TST-REC-001` in
 * `dolly-spec/test-vectors/core/` (kind `crash_recovery`, covers
 * `REQ-REC-004` and `INV-XCAP-005`). The vector command
 * `evaluate_restore_identity_modes` runs the planner over the three
 * identity-mode cases and asserts the resulting scope and external-authority
 * plan. This test executes the imported vector byte-for-byte and pins the
 * full language-neutral output document so a later Rust planner can compare
 * against it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RestoreIdentityPlannerError,
  evaluateRestoreIdentityModes,
  type RestoreIdentityBackupEntry,
  type RestoreIdentityMode,
  type RestoreIdentityModesPlan,
} from "../../../src/core/restore-identity-planner.js";

const VECTOR_PATH = resolve(
  import.meta.dirname,
  "../../../dolly-spec/test-vectors/core/TST-REC-001-restore-clone-scope.json",
);

interface RestoreIdentityVector {
  initial: { backup: RestoreIdentityBackupEntry };
  stimulus: { command: "evaluate_restore_identity_modes"; cases: RestoreIdentityMode[] };
  expected: {
    outcome: string;
    assertions: ReadonlyArray<{ path: string; op: "equals" | "not_equals" | "contains" | "count" | "absent" | "unchanged"; value: unknown }>;
    emitted: ReadonlyArray<{ kind: "audit"; event: string }>;
    crash_label: null;
  };
}

function readVector(): RestoreIdentityVector {
  return JSON.parse(readFileSync(VECTOR_PATH, "utf8")) as RestoreIdentityVector;
}

/**
 * Full language-neutral output document of the planner for the imported
 * `TST-REC-001` vector. A future Rust planner must produce the exact same
 * document for the same input.
 */
const VECTOR_OUTPUT: RestoreIdentityModesPlan = {
  outcome: "identity_mode_controls_scope_and_external_authority",
  replace: {
    storage_scope_id: "0198ab31-6c44-7e8a-b2bb-000000000462",
    writer_generation: 5,
    external_write_before_fence: false,
  },
  isolated_clone: {
    external_effects_enabled: false,
    mutable_store_shared_with_source: false,
  },
  portable_fork: {
    reused_source_scope: { error: "STATE_CLONE_REMAP_REQUIRED" },
    remapped_scope: "0198ab31-6c44-7e8a-b2bb-000000000463",
    unsupported_opaque_module: { state: "disabled" },
  },
  emitted: [
    { kind: "audit", event: "restore_identity_plan_verified" },
    { kind: "audit", event: "portable_scope_remap_recorded" },
  ],
};

function validBackup(): RestoreIdentityBackupEntry {
  return {
    source_daemon_installation_id: "0198ab31-6c44-7e8a-b2bb-000000000461",
    source_instance_id: "main",
    module_id: "memory-main",
    storage_scope_id: "0198ab31-6c44-7e8a-b2bb-000000000462",
    last_writer_generation: 4,
    external_state: "remote-database",
  };
}

describe("TST-REC-001 restore-identity modes planner", () => {
  it("reproduces the imported vector output as the language-neutral document", () => {
    const vector = readVector();
    expect(vector.expected.crash_label).toBeNull();
    const observed = evaluateRestoreIdentityModes(vector.initial.backup, vector.stimulus.cases);
    expect(observed).toEqual(VECTOR_OUTPUT);
    expect(observed.outcome).toBe(vector.expected.outcome);
    // Every asserted path from the vector holds verbatim on the produced document.
    for (const assertion of vector.expected.assertions) {
      const segments = assertion.path.split("/").filter(Boolean);
      let cursor: unknown = observed;
      for (const segment of segments) {
        if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
          throw new Error(`path ${assertion.path} disappeared at ${segment}`);
        }
        cursor = (cursor as Record<string, unknown>)[segment];
      }
      expect(cursor, assertion.path).toEqual(assertion.value);
    }
    // The planner plans the two audit emissions named by the vector.
    expect(vector.expected.emitted).toHaveLength(observed.emitted.length);
    expect(observed.emitted).toEqual(vector.expected.emitted);
  });

  it("evaluates a requested subset and keeps the result deterministic", () => {
    const backup = validBackup();
    expect(evaluateRestoreIdentityModes(backup, ["replace_same_identity"])).toEqual({
      outcome: "identity_mode_controls_scope_and_external_authority",
      replace: {
        storage_scope_id: "0198ab31-6c44-7e8a-b2bb-000000000462",
        writer_generation: 5,
        external_write_before_fence: false,
      },
      emitted: [{ kind: "audit", event: "restore_identity_plan_verified" }],
    } as Partial<RestoreIdentityModesPlan>);
  });

  it("fails closed on an unknown identity mode", () => {
    expect(() =>
      evaluateRestoreIdentityModes(validBackup(), ["replace_same_identity", "time_travel_fork"] as unknown as RestoreIdentityMode[]),
    ).toThrowError(RestoreIdentityPlannerError);
    try {
      evaluateRestoreIdentityModes(validBackup(), ["time_travel_fork"] as unknown as RestoreIdentityMode[]);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(RestoreIdentityPlannerError);
      expect((error as RestoreIdentityPlannerError).code).toBe("RESTORE_IDENTITY_MODES_INVALID");
    }
  });

  it("fails closed on an empty or duplicated mode list", () => {
    expect(() => evaluateRestoreIdentityModes(validBackup(), [])).toThrowError(RestoreIdentityPlannerError);
    expect(() =>
      evaluateRestoreIdentityModes(validBackup(), ["portable_fork", "portable_fork"]),
    ).toThrowError(RestoreIdentityPlannerError);
  });

  it("fails closed on malformed backup entries", () => {
    const cases: RestoreIdentityMode[] = ["replace_same_identity", "isolated_snapshot_clone", "portable_fork"];
    for (const [key, value, label] of [
      ["source_daemon_installation_id", "", "empty daemon installation id"],
      ["source_instance_id", "", "empty instance id"],
      ["module_id", "", "empty module id"],
      ["storage_scope_id", "0198ab31-6c44-7e8a-b2bb-00000000046Z", "non-hex storage scope"],
      ["storage_scope_id", "not-a-scope", "malformed storage scope"],
      ["storage_scope_id", "0198ab31-6c44-6e8a-b2bb-000000000462", "wrong UuidV7 version digit"],
      ["last_writer_generation", 0, "zero writer generation"],
      ["last_writer_generation", 1.5, "non-integer writer generation"],
      ["last_writer_generation", Number.MAX_SAFE_INTEGER, "writer generation at exhaustion"],
      ["external_state", "", "empty external state"],
    ] as const) {
      const backup = { ...validBackup(), [key]: value } as unknown as RestoreIdentityBackupEntry;
      expect(() => evaluateRestoreIdentityModes(backup, cases), label).toThrowError(RestoreIdentityPlannerError);
    }
  });

  it("fails closed when the source scope cannot yield a fresh remapped scope", () => {
    const backup = { ...validBackup(), storage_scope_id: "0198ab31-6c44-7e8a-b2bb-ffffffffffff" };
    expect(() => evaluateRestoreIdentityModes(backup, ["portable_fork"])).toThrowError(RestoreIdentityPlannerError);
  });

  it("fails closed when a fresh writer generation exceeds the safe integer range", () => {
    const backup = { ...validBackup(), last_writer_generation: Number.MAX_SAFE_INTEGER };
    expect(() => evaluateRestoreIdentityModes(backup, ["replace_same_identity"])).toThrowError(RestoreIdentityPlannerError);
  });
});
