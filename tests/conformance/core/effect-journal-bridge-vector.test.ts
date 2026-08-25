import { createHash } from "node:crypto";
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
        "claim.operation_id == ledger.operation_binding.operation_id",
        "claim.instance_id == ledger.operation_binding.instance_id",
        "claim.module_id == ledger.operation_binding.module_id",
        "claim.operation_digest == ledger.operation_digest",
        "record.intent_digest == ledger.outbound_digest",
        "record.package_digest == ledger.operation_binding.server_contract.transport.package_digest",
        "record.evidence_digest == ledger.terminal_result_digest",
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

const PARSE_LIMITS = { maxBytes: 262144, maxDepth: 96 };
const ZERO_DIGEST =
  "sha256:0000000000000000000000000000000000000000000000000000000000000000";
const LEDGER_STATES: Record<string, true> = {
  AUTHORIZED: true,
  DISPATCHED: true,
  SUCCEEDED: true,
  FAILED: true,
  UNKNOWN: true,
};

function digestOf(value: JsonValue): string {
  const canonicalBytes = canonicalizeJson(value);
  return `sha256:${createHash("sha256").update(canonicalBytes, "utf8").digest("hex")}`;
}

/**
 * Rebuilds a ledger record's stored digests from its embedded bytes, the way
 * the Rust producer writes them: operation_digest is the binding digest and
 * terminal_result_digest is the terminal-result digest. Used by the generation
 * mutation so the mutated premise stays an internally valid ledger row.
 */
function rebuildLedger(record: RecordValue): RecordValue {
  const rebuilt = structuredClone(record) as RecordValue;
  rebuilt.operation_digest = digestOf(rebuilt.operation_binding as JsonValue);
  rebuilt.terminal_result_digest = rebuilt.terminal_result
    ? digestOf(rebuilt.terminal_result as JsonValue)
    : null;
  rebuilt.outbound_digest = outboundDigest(rebuilt.operation_binding as RecordValue);
  return rebuilt;
}

/** The exact outbound application payload for the built-in v1 MCP adapter. */
function outboundPayload(binding: RecordValue): RecordValue {
  const contract = binding.server_contract as RecordValue;
  const tool = (contract.tools as RecordValue)[binding.tool_name as string] as RecordValue;
  if (!tool || typeof tool.upstream_name !== "string") {
    throw new Error("retained contract does not contain the selected tool");
  }
  return {
    jsonrpc: "2.0",
    id: binding.server_request_id,
    method: "tools/call",
    params: { name: tool.upstream_name, arguments: binding.arguments },
  };
}

function outboundDigest(binding: RecordValue): string | null {
  try {
    return digestOf(outboundPayload(binding));
  } catch {
    return null;
  }
}

/** Closed-world shape check mirroring the serde deny_unknown_fields behavior. */
function ledgerRecordShapeInvalid(record: RecordValue): boolean {
  const allowed = [
    "schema",
    "ledger_revision",
    "state",
    "operation_binding",
    "operation_digest",
    "outbound_digest",
    "terminal_result",
    "terminal_result_digest",
  ];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      return true;
    }
  }
  return (
    typeof record.schema !== "string" ||
    !(record.state as string in LEDGER_STATES) ||
    typeof record.ledger_revision !== "number"
  );
}

/**
 * The INTENDED journal row that the vector's premise settles, derived from the
 * premise's own binding identity exactly as the Rust test derives it.
 */
function journalRow(premiseWrapper: RecordValue): RecordValue {
  const ledger = premiseWrapper.record as RecordValue;
  const binding = ledger.operation_binding as RecordValue;
  const authority = loadVector().initial.authority as RecordValue;
  const process_ = authority.process as RecordValue;
  const claimTokenContext = {
    schema: "dolly.claim/v2",
    instance_id: binding.instance_id,
    module_id: binding.module_id,
    operation_id: binding.operation_id,
    operation_digest: ledger.operation_digest,
    controller_generation: authority.controller_generation,
    extension_generation: process_.extension_generation,
    worker_epoch: process_.worker_epoch,
    package_digest: binding.server_contract.transport.package_digest,
    policy_premise_digest: authority.policy_premise_digest,
    effect_class: "MCP_TOOLS_CALL",
  };
  return {
    schema: "dolly.external-effect-journal/v2",
    journal_revision: 1,
    state: "INTENDED",
    claim: {
      schema: "dolly.claim/v2",
      instance_id: binding.instance_id,
      module_id: binding.module_id,
      operation_id: binding.operation_id,
      operation_digest: ledger.operation_digest,
      claim_token: canonicalJsonDigest(claimTokenContext),
    },
    controller_generation: authority.controller_generation,
    extension_generation: process_.extension_generation,
    worker_epoch: process_.worker_epoch,
    package_digest: binding.server_contract.transport.package_digest,
    policy_premise_digest: authority.policy_premise_digest,
    operation_digest: ledger.operation_digest,
    effect_class: "MCP_TOOLS_CALL",
    intent_digest: ledger.outbound_digest,
    evidence_digest: null,
  };
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

    // Premise direction: production-equivalent recovery over the exact shared
    // vector. A terminal source outcome alone never mints APPLIED; only an
    // identity-matching, internally verified SUCCEEDED Tool-call ledger premise
    // does. Every mutation must fail closed to UNKNOWN_OUTCOME.
    const ledgerPremise = cases.find(
      (entry) => (entry.ledger_premise as RecordValue | undefined)?.record?.schema === "dolly.tool-call-ledger/v1",
    ) as RecordValue;
    const premiseWrapper = ledgerPremise.ledger_premise as RecordValue;
    expect((premiseWrapper.record as RecordValue).state).toBe("SUCCEEDED");
    expect((premiseWrapper.record as RecordValue).ledger_revision).toBe(3);

    // Mirrors recover_effect_journal: the journal row is INTENDED, the premise
    // must be a SUCCEEDED ledger record whose binding identity equals the
    // Claim's, whose recomputed operation/outbound digests match the frozen
    // journal digests, and whose terminal result supplies the evidence.
    const recoverEffectJournal = (
      journal: RecordValue,
      premise: RecordValue | null,
    ): { settlement: "applied"; evidence_digest: string } | "unknown_outcome" => {
      if (journal.state !== "INTENDED" || journal.effect_class !== "MCP_TOOLS_CALL") {
        return "unknown_outcome";
      }
      if (!premise || premise.schema !== "dolly.tool-call-ledger/v1") {
        return "unknown_outcome";
      }
      if (
        ledgerRecordShapeInvalid(premise) ||
        digestOf(premise.operation_binding as JsonValue) !== premise.operation_digest
      ) {
        return "unknown_outcome";
      }
      const binding = premise.operation_binding as RecordValue;
      if (
        binding.instance_id !== journal.claim.instance_id ||
        binding.module_id !== journal.claim.module_id ||
        binding.operation_id !== journal.claim.operation_id ||
        premise.operation_digest !== journal.operation_digest ||
        binding.server_contract.transport.package_digest !== journal.package_digest ||
        outboundDigest(binding) !== journal.intent_digest
      ) {
        return "unknown_outcome";
      }
      if (premise.state !== "SUCCEEDED") {
        return "unknown_outcome";
      }
      if (!premise.terminal_result || !premise.terminal_result_digest) {
        return "unknown_outcome";
      }
      if (digestOf(premise.terminal_result as JsonValue) !== premise.terminal_result_digest) {
        return "unknown_outcome";
      }
      if ((premise.outbound_digest as string) !== journal.intent_digest) {
        return "unknown_outcome";
      }
      return { settlement: "applied", evidence_digest: premise.terminal_result_digest };
    };

    const MUTATION_NAMES: readonly string[] = [
      "missing_premise",
      "extra_forbidden_field",
      "claim_identity_mismatch",
      "dispatch_generation_mismatch",
      "operation_binding_digest_mismatch",
      "outbound_bytes_digest_mismatch",
      "terminal_result_bytes_digest_mismatch",
      "response_ack_cache_readiness_candidate",
      "effect_class_settlement_mismatch",
    ];

    let appliedCount = 0;
    let unknownCount = 0;
    for (const name of MUTATION_NAMES) {
      switch (name) {
        case "missing_premise": {
          expect(recoverEffectJournal(journalRow(premiseWrapper), null)).toBe("unknown_outcome");
          unknownCount += 1;
          break;
        }
        case "extra_forbidden_field": {
          const extra = structuredClone(premiseWrapper) as RecordValue;
          (extra.record as RecordValue).mutable_queue_state = "ready";
          // The production deserializer rejects closed-world records with
          // unknown members (serde deny_unknown_fields equivalent).
          expect(ledgerRecordShapeInvalid(extra.record as RecordValue)).toBe(true);
          expect(recoverEffectJournal(journalRow(premiseWrapper), extra.record)).toBe(
            "unknown_outcome",
          );
          unknownCount += 1;
          break;
        }
        case "claim_identity_mismatch": {
          const bad = structuredClone(journalRow(premiseWrapper)) as RecordValue;
          (bad.claim as RecordValue).operation_id =
            "0198ab31-6c44-7e8a-b2bb-000000000999";
          expect(recoverEffectJournal(bad, premiseWrapper.record as RecordValue)).toBe(
            "unknown_outcome",
          );
          unknownCount += 1;
          break;
        }
        case "dispatch_generation_mismatch": {
          const prem = structuredClone(premiseWrapper) as RecordValue;
          const premBinding = (prem.record as RecordValue).operation_binding as RecordValue;
          premBinding.activation_lease_generation = (premBinding.activation_lease_generation as number) + 1;
          premBinding.tool_server_generation = (premBinding.tool_server_generation as number) + 1;
          const otherGen = rebuildLedger(prem.record as RecordValue);
          expect(otherGen.operation_digest).not.toBe(journalRow(premiseWrapper).operation_digest);
          expect(recoverEffectJournal(journalRow(premiseWrapper), otherGen)).toBe("unknown_outcome");
          unknownCount += 1;
          break;
        }
        case "operation_binding_digest_mismatch": {
          const bad = structuredClone(journalRow(premiseWrapper)) as RecordValue;
          bad.operation_digest = ZERO_DIGEST;
          (bad.claim as RecordValue).operation_digest = ZERO_DIGEST;
          expect(recoverEffectJournal(bad, premiseWrapper.record as RecordValue)).toBe(
            "unknown_outcome",
          );
          unknownCount += 1;
          break;
        }
        case "outbound_bytes_digest_mismatch": {
          const bad = structuredClone(journalRow(premiseWrapper)) as RecordValue;
          bad.intent_digest = ZERO_DIGEST;
          expect(recoverEffectJournal(bad, premiseWrapper.record as RecordValue)).toBe(
            "unknown_outcome",
          );
          unknownCount += 1;
          break;
        }
        case "terminal_result_bytes_digest_mismatch": {
          const prem = structuredClone(premiseWrapper) as RecordValue;
          const rec = prem.record as RecordValue;
          (rec.terminal_result as RecordValue).output = "tampered";
          expect(digestOf(rec.terminal_result as JsonValue)).not.toBe(rec.terminal_result_digest);
          expect(recoverEffectJournal(journalRow(prem), rec)).toBe("unknown_outcome");
          unknownCount += 1;
          break;
        }
        case "response_ack_cache_readiness_candidate": {
          const prem = structuredClone(premiseWrapper) as RecordValue;
          const rec = prem.record as RecordValue;
          rec.state = "DISPATCHED";
          rec.ledger_revision = 2;
          rec.terminal_result = null;
          rec.terminal_result_digest = null;
          expect(recoverEffectJournal(journalRow(prem), rec)).toBe("unknown_outcome");
          unknownCount += 1;
          break;
        }
        case "effect_class_settlement_mismatch": {
          const wrongClass = structuredClone(journalRow(premiseWrapper)) as RecordValue;
          wrongClass.effect_class = "MCP_INITIALIZE_HANDSHAKE_V1";
          expect(recoverEffectJournal(wrongClass, premiseWrapper.record as RecordValue)).toBe(
            "unknown_outcome",
          );
          const settled = structuredClone(journalRow(premiseWrapper)) as RecordValue;
          settled.state = "APPLIED";
          settled.journal_revision = 2;
          settled.evidence_digest = (premiseWrapper.record as RecordValue).terminal_result_digest;
          expect(recoverEffectJournal(settled, premiseWrapper.record as RecordValue)).toBe(
            "unknown_outcome",
          );
          unknownCount += 1;
          break;
        }
        default:
          throw new Error(`unhandled mutation ${name}`);
      }
    }
    expect(MUTATION_NAMES).toHaveLength(9);
    expect(unknownCount).toBe(9);

    // The exact premise still settles APPLIED with the ledger evidence.
    const exact = recoverEffectJournal(journalRow(premiseWrapper), premiseWrapper.record as RecordValue);
    expect(exact).toEqual({
      settlement: "applied",
      evidence_digest: (premiseWrapper.record as RecordValue).terminal_result_digest,
    });
    appliedCount += 1;
    expect(appliedCount).toBe(1);
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
