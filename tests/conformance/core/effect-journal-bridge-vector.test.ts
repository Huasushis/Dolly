import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalJsonDigest,
  canonicalizeJson,
  type JsonValue,
} from "../../../src/core/canonical-json.js";
import {
  assertEffectIntentRecord,
  assertEffectRunRecord,
} from "../../../src/core/capabilities/effect-intent-journal.js";
import { FramedJsonChannel } from "../../../src/core/framed-json-channel.js";
import { parseStrictJsonText } from "../../../src/core/strict-json.js";

const VECTOR_PATH = join(
  process.cwd(),
  "dolly-spec",
  "test-vectors",
  "services",
  "TST-TOOL-014-cross-language-effect-journal.json",
);

type RecordValue = Record<string, any>;

function loadVector(): RecordValue {
  const value = JSON.parse(readFileSync(VECTOR_PATH, "utf8")) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TST-TOOL-014 must be an object");
  }
  return value as RecordValue;
}

function claimTokenContext(claim: RecordValue, authority: RecordValue): JsonValue {
  const process = authority.process as RecordValue;
  return {
    schema: "dolly.claim/v2",
    instance_id: claim.instance_id,
    module_id: claim.module_id,
    operation_id: claim.operation_id,
    operation_digest: claim.operation_digest,
    controller_generation: authority.controller_generation,
    extension_generation: process.extension_generation,
    worker_epoch: process.worker_epoch,
    package_digest: authority.package_digest,
    policy_premise_digest: authority.policy_premise_digest,
    effect_class: "MCP_TOOLS_CALL",
  } as JsonValue;
}

function assertContract(contract: RecordValue): void {
  expect(contract.schema).toBe("dolly.effect-journal-bridge/v1");
  expect(contract.source).toEqual({
    dialect: "typescript",
    intent_schema: "dolly.effect-intent/2",
    run_schema: "dolly.effect-run/1",
  });
  expect(contract.target).toEqual({
    dialect: "rust",
    claim_schema: "dolly.claim/v2",
    journal_schema: "dolly.external-effect-journal/v2",
  });
  expect(contract.identity_mapping.source_fields).toEqual([
    "moduleJobId",
    "runId",
    "attempt",
    "claimToken",
    "moduleGenerationId",
  ]);
  expect(contract.identity_mapping.target_fields).toEqual([
    "instance_id",
    "module_id",
    "operation_id",
    "operation_digest",
    "claim_token",
  ]);
  expect(contract.authority_mapping.missing_disposition).toBe(
    "refuse-before-child-io",
  );
  expect(contract.canonicalization).toEqual({
    scheme: "RFC8785-JCS",
    encoding: "UTF-8",
    digest: "sha256:<lowercase-hex>",
    semantic_depth: 64,
    wire_depth: 96,
    unknown_fields: "reject",
  });
  expect(contract.transport.extension_rpc).toEqual({
    dialect: "dolly-extension-rpc/3.0",
    framing: "four-byte-length-prefix",
    length_endian: "big",
    max_payload_bytes: 262144,
    wire_depth: 96,
    semantic_depth: 64,
  });
  expect(contract.transport.mcp_stdio).toEqual({
    dialect: "mcp/2025-06-18",
    framing: "newline-delimited-json",
    delimiter: "LF",
    max_line_bytes: 262144,
    wire_depth: 96,
    semantic_depth: 64,
  });
  expect(
    (contract.transport.semantic_errors as RecordValue[]).find(
      (entry) => entry.code === "EXTENSION_INVALID_RESPONSE",
    ),
  ).toMatchObject({
    source_codes: [
      "FRAME_JSON_INVALID",
      "FRAME_LENGTH_INVALID",
      "FRAME_UTF8_INVALID",
      "FRAME_TOO_DEEP",
      "FRAME_TRANSPORT_FAILED",
    ],
    phase: "post-write",
    outcome: "unknown",
    connection: "closed",
    redispatch: "forbidden",
  });
  expect(
    (contract.transport.semantic_errors as RecordValue[]).find(
      (entry) => entry.code === "MCP_REQUEST_INVALID",
    ),
  ).toMatchObject({
    source_codes: ["InvalidFrame", "RequestMismatch", "NotInitialized"],
    phase: "pre-effect",
    outcome: "not_applied",
    connection: "closed",
    redispatch: "forbidden",
  });
  for (const error of contract.transport.semantic_errors as RecordValue[]) {
    expect(error.source_codes).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(error.redispatch).toBe("forbidden");
  }
  expect(contract.ordering).toEqual({
    before_child_io: [
      "platform_gate",
      "authority_gate",
      "package_and_provenance_gate",
      "claim_intent_commit",
      "identity_pair_check",
    ],
    first_external_write: "after-claim-intent-commit",
    replay: "refuse-without-new-claim",
  });
  for (const check of contract.identity_checks as RecordValue[]) {
    expect(check.mismatch).toBe("refuse");
  }
  expect(contract.aggregate_evidence).toBe(
    "never-map-evidenceForRun-directly-to-one-Rust-record; require-each-intent-outcome; terminal-outcome-without-authoritative-ledger-premise-settles-UNKNOWN_OUTCOME",
  );
  const outcomes = contract.outcome_mapping as RecordValue[];
  expect(outcomes.find((entry) => entry.source_kind === "intended")).toMatchObject({
    source_evidence_rule: "source.outcome.kind=intended",
    target_state: "INTENDED",
    journal_revision: 1,
    evidence_rule: "null",
    per_intent_evidence: "required",
    redispatch: "forbidden",
  });
  expect(outcomes.find((entry) => entry.source_kind === "no-effect")).toMatchObject({
    source_evidence_rule: "source.outcome.kind=no-effect",
    target_state: "NOT_APPLIED",
    journal_revision: 2,
    evidence_rule: "sha256(JCS(no-effect-proof))",
    per_intent_evidence: "required",
    redispatch: "forbidden",
  });
  expect(outcomes.find((entry) => entry.source_kind === "terminal")).toMatchObject({
    source_evidence_rule: "source.outcome.kind=terminal;require-resultDigest",
    target_state: "UNKNOWN_OUTCOME",
    journal_revision: 2,
    evidence_rule: "null",
    per_intent_evidence: "required",
    redispatch: "forbidden",
    applied_premise: {
      premise: "exact-authoritative-tool-call-ledger",
      ledger_schema: "dolly.tool-call-ledger/v1",
      ledger_record_validator: "tool-call-ledger-record.schema.json",
      identity_match: [
        "claim.operation_id == ledger.operation_binding.idempotency_key",
        "claim.instance_id == ledger.operation_binding.instance_id",
        "claim.module_id == ledger.operation_binding.module_id",
        "claim.operation_digest == ledger.operation_digest",
        "claim.intent_digest == ledger.outbound_digest",
        "ledger.state == SUCCEEDED",
      ],
      terminal_state: "SUCCEEDED",
      evidence_rule: "ledger.terminal_result_digest",
    },
  });
  expect(outcomes.find((entry) => entry.source_kind === "unknown")).toMatchObject({
    source_evidence_rule: "source.outcome.kind=unknown;retain-reason",
    target_state: "UNKNOWN_OUTCOME",
    journal_revision: 2,
    evidence_rule: "null",
    per_intent_evidence: "required",
    redispatch: "forbidden",
  });
}

describe("TST-TOOL-014 TypeScript side of the cross-language corpus", () => {
  it("validates source records, target JCS bytes, and fail-closed mappings", () => {
    const vector = loadVector();
    const initial = vector.initial as RecordValue;
    const contract = initial.contract as RecordValue;
    const sourceRun = initial.source_run as RecordValue;
    const authority = initial.authority as RecordValue;
    assertContract(contract);
    expect(initial.public_bridge).toEqual({
      daemon_to_worker_transport: "absent",
      ffi: "absent",
      disposition: "blocked-no-go",
    });

    assertEffectRunRecord(sourceRun);
    if (sourceRun.state !== "closed") {
      throw new Error("TST-TOOL-014 source Run must be closed");
    }
    const cases = initial.cases as RecordValue[];
    expect(cases).toHaveLength(5);
    const setMembers = cases.map((entry) => {
      const source = entry.source as RecordValue;
      assertEffectIntentRecord(source);
      return {
        idempotencyKey: source.idempotencyKey,
        capabilityType: source.capabilityType,
        operation: source.operation,
        intentDigest: source.intentDigest,
      };
    });
    expect(contract.identity_mapping.field_rules).toEqual([
      {
        source: "moduleJobId",
        target: "module_id",
        rule: "exact-utf8-identifier",
      },
      {
        source: "idempotencyKey",
        target: "operation_id",
        rule: "exact-utf8-identifier",
      },
      {
        source: "intentDigest",
        target: "operation_digest",
        rule: "exact-sha256-digest",
      },
      {
        source: "claimToken",
        target: "claim_token",
        rule: "do-not-copy; retain-source-provenance-and-derive-target",
      },
      {
        source: "runId,attempt,moduleGenerationId",
        target: "authority",
        rule: "bind-by-explicit-generation-pair; no-type-coercion",
      },
    ]);
    expect(canonicalJsonDigest([...setMembers].sort((left, right) =>
      left.idempotencyKey < right.idempotencyKey
        ? -1
        : left.idempotencyKey > right.idempotencyKey
          ? 1
          : 0,
    ))).toBe(sourceRun.intentSetDigest);

    for (const entry of cases) {
      const target = entry.target as RecordValue;
      const claim = target.claim as RecordValue;
      const record = target.record as RecordValue;
      const canonical = entry.canonical as RecordValue;
      expect(claim.schema).toBe("dolly.claim/v2");
      expect(record.schema).toBe("dolly.external-effect-journal/v2");
      expect(record.claim).toEqual(claim);
      expect(canonicalizeJson(claim)).toBe(canonical.claim_utf8);
      expect(canonicalJsonDigest(claim)).toBe(canonical.claim_digest);
      expect(canonicalizeJson(record)).toBe(canonical.record_utf8);
      expect(canonicalJsonDigest(record)).toBe(canonical.record_digest);
      expect(claim.claim_token).toBe(
        canonicalJsonDigest(claimTokenContext(claim, authority)),
      );
      // The journal binds the Claim operation identity (operation_digest) and
      // the dispatched payload (intent_digest) as separate digests; only the
      // Claim's operation_digest must equal the record's operation_digest.
      expect(claim.operation_digest).toBe(record.operation_digest);
      expect(record.evidence_digest).toBe(canonical.evidence_digest ?? null);
      expect(entry.expected_state).toBe(record.state);
      const parsed = parseStrictJsonText(canonical.record_utf8, {
        maxBytes: 262144,
        maxDepth: 96,
      });
      expect(parsed).toEqual(record);
    }

    // Premise direction: a terminal source outcome alone never mints APPLIED.
    // It settles APPLIED only via an exact, durable, versioned Tool-call ledger
    // premise (identity tuple match + SUCCEEDED terminal); otherwise fail-closed
    // UNKNOWN_OUTCOME.
    const noPremise = cases.find((entry) => entry.ledger_premise === "absent");
    expect(noPremise).toBeDefined();
    expect(noPremise!.expected_state).toBe("UNKNOWN_OUTCOME");
    expect(noPremise!.target.record.state).toBe("UNKNOWN_OUTCOME");
    expect(noPremise!.target.record.evidence_digest).toBeNull();

    const withPremise = cases.find(
      (entry) => (entry.ledger_premise as RecordValue | undefined)?.record?.schema === "dolly.tool-call-ledger/v1",
    );
    expect(withPremise).toBeDefined();
    const ledgerRecord = withPremise!.ledger_premise.record as RecordValue;
    expect(ledgerRecord.state).toBe("SUCCEEDED");
    expect(ledgerRecord.ledger_revision).toBe(3);
    expect(withPremise!.expected_state).toBe("APPLIED");
    expect(withPremise!.target.record.state).toBe("APPLIED");
    // Concrete Claim/generation/outbound/terminal-result equality with the
    // exact authoritative ledger record. No response/ACK evidence is copied.
    const binding = ledgerRecord.operation_binding as RecordValue;
    const claim = withPremise!.target.claim as RecordValue;
    const rec = withPremise!.target.record as RecordValue;
    expect(claim.operation_id).toBe(binding.idempotency_key);
    expect(claim.instance_id).toBe(binding.instance_id);
    expect(claim.module_id).toBe(binding.module_id);
    expect(claim.operation_digest).toBe(ledgerRecord.operation_digest);
    expect(rec.intent_digest).toBe(ledgerRecord.outbound_digest);
    expect(rec.evidence_digest).toBe(ledgerRecord.terminal_result_digest);
  });

  it("keeps Extension framing and MCP framing as separate dialects", async () => {
    const vector = loadVector();
    const transport = vector.initial.canonical_transport as RecordValue;
    const payload = JSON.parse(transport.extension_payload_utf8) as JsonValue;
    const readable = new PassThrough();
    const writable = new PassThrough();
    const received: JsonValue[] = [];
    const errors: Error[] = [];
    const channel = new FramedJsonChannel(readable, writable, {
      maxFrameBytes: 262144,
      onMessage: (message) => received.push(message),
      onError: (error) => errors.push(error),
    });
    const output = new Promise<Buffer>((resolve, reject) => {
      writable.once("data", (chunk: Buffer) => resolve(Buffer.from(chunk)));
      writable.once("error", reject);
    });
    await channel.send(payload);
    const frame = await output;
    const payloadBytes = Buffer.from(transport.extension_payload_utf8, "utf8");
    expect(frame.readUInt32BE(0)).toBe(payloadBytes.byteLength);
    expect(frame.subarray(4).equals(payloadBytes)).toBe(true);
    expect(transport.extension_length_be).toBe(payloadBytes.byteLength);

    readable.end(frame);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(received).toEqual([payload]);
    expect(errors).toEqual([]);
    channel.close();
    expect(transport.mcp_line_utf8).toBe(`${transport.mcp_payload_utf8}\n`);
    expect(transport.mcp_line_bytes).toBe(
      Buffer.byteLength(transport.mcp_line_utf8, "utf8"),
    );
  });
});
