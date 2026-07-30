/**
 * `security-operations.md` Section 13.1 conformance: the audited operator flow
 * for a Module Claim preserved as an unknown outcome.
 *
 * The four obligations are asserted directly: the exact Claim and the evidence
 * Core considered are shown, only the three stated dispositions are offered, a
 * forced release is refused until an explicit warning about repeating an
 * external effect is acknowledged, a request audit event is written before the
 * disposition is applied, and a separate event records actual success or
 * failure. The ordering is checked by recording the audit log as it stood at
 * the moment the store was called.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import type {
  ClaimDescriptor,
  DeliveryClaimIdentity,
} from "../../../src/core/delivery-store.js";
import type { ModuleSubmissionRecord } from "../../../src/core/module-process-records.js";
import { AdminHttpServer } from "../../../src/daemon/console/admin-http-server.js";
import { runConsoleCliCommand } from "../../../src/daemon/console/console-cli.js";
import { ConsoleOperationError } from "../../../src/daemon/console/operation-catalog.js";
import {
  buildForcedReleaseWarning,
  buildPreservedClaim,
  deliveryClaimDispositionApplier,
  unprovenExternalEffects,
  type DeliveryClaimDispositionOperations,
  type PreservedUnknownOutcomeClaim,
  type UnknownOutcomeDispositionRequest,
  type UnknownOutcomeEvidence,
} from "../../../src/daemon/console/unknown-outcome.js";
import {
  createConsoleHarness,
  rawHttpRequest,
  type ConsoleHarness,
} from "./fixtures/console-operations-harness.js";

const IDENTITY = {
  moduleJobId: "module-job-7",
  claimToken: "claim-7",
  runId: "run-7",
  attempt: 2,
  moduleGenerationId: "generation-3",
};

const servers: AdminHttpServer[] = [];
const harnesses: ConsoleHarness[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const harness of harnesses.splice(0)) harness.dispose();
});

function evidence(overrides: Partial<UnknownOutcomeEvidence> = {}): UnknownOutcomeEvidence {
  return {
    preservedReason: "the Run was submitted and no external-effect evidence source is available",
    moduleProcessRecord: {
      processGenerationId: "process-generation-3",
      state: "stopped",
      declaredExternalEffects: "core-capabilities-only",
    },
    moduleProcessStopProof: { proven: true, evidence: "populated-zero" },
    submissionRecord: { runId: "run-7", processGenerationId: "process-generation-3" },
    resultJournalEntry: null,
    externalEffectIntents: [
      {
        intentId: "effect-1",
        description: "posted the summary to the outbound webhook",
        recordedOutcome: "unknown",
      },
    ],
    ...overrides,
  };
}

function preservedClaim(
  overrides: Partial<UnknownOutcomeEvidence> = {},
): PreservedUnknownOutcomeClaim {
  return buildPreservedClaim({
    identity: IDENTITY,
    moduleId: "summarizer",
    evidence: evidence(overrides),
  });
}

interface Client {
  readonly harness: ConsoleHarness;
  post(path: string, body: unknown): Promise<{ status: number; body: any }>;
  get(path: string): Promise<{ status: number; body: any }>;
}

async function startConsole(harness: ConsoleHarness): Promise<Client> {
  const server = new AdminHttpServer({ operations: harness.operations });
  const address = await server.start();
  servers.push(server);
  const origin = server.origin!;
  const authority = new URL(origin).host;
  const pairing = server.issuePairingCode("operator");
  const paired = await rawHttpRequest({
    host: address.host,
    port: address.port,
    path: "/v1/admin/session",
    method: "POST",
    headers: { "content-type": "application/json", host: authority, origin },
    body: JSON.stringify({ code: pairing.code }),
  });
  const grant = JSON.parse(paired.text) as { csrfToken: string };
  const setCookie = paired.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";", 1)[0]!;
  return {
    harness,
    async post(path, body) {
      const response = await rawHttpRequest({
        host: address.host,
        port: address.port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: authority,
          origin,
          cookie,
          "x-dolly-csrf": grant.csrfToken,
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: JSON.parse(response.text) };
    },
    async get(path) {
      const response = await rawHttpRequest({
        host: address.host,
        port: address.port,
        path,
        headers: { host: authority, cookie },
      });
      return { status: response.status, body: JSON.parse(response.text) };
    },
  };
}

function trackHarness(): ConsoleHarness {
  const harness = createConsoleHarness();
  harnesses.push(harness);
  return harness;
}

describe("SEC-CLAIM-001 the operator sees the exact Claim and the evidence Core considered", () => {
  it("lists identity, every evidence field, and only the three stated dispositions", async () => {
    const harness = trackHarness();
    harness.claimStore.setClaims([preservedClaim()]);
    const client = await startConsole(harness);

    const listed = await client.get(
      `/v1/admin/instances/${harness.instanceId}/claims/unknown-outcome`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.claims).toHaveLength(1);
    const claim = listed.body.claims[0];

    expect(claim.identity).toEqual(IDENTITY);
    expect(claim.evidence.moduleProcessRecord.state).toBe("stopped");
    expect(claim.evidence.moduleProcessStopProof).toEqual({
      proven: true,
      evidence: "populated-zero",
    });
    expect(claim.evidence.submissionRecord.runId).toBe("run-7");
    // The absence of a result journal entry is shown, not omitted.
    expect(claim.evidence).toHaveProperty("resultJournalEntry", null);
    expect(claim.evidence.externalEffectIntents).toEqual([
      {
        intentId: "effect-1",
        description: "posted the summary to the outbound webhook",
        recordedOutcome: "unknown",
      },
    ]);

    expect(claim.offeredDispositions.map((offer: { disposition: string }) => offer.disposition))
      .toEqual(["release", "dead-letter", "leave-unresolved"]);
    for (const offer of claim.offeredDispositions) {
      expect(offer.consequence.length).toBeGreaterThan(40);
    }
    expect(
      claim.offeredDispositions.find(
        (offer: { disposition: string }) => offer.disposition === "release",
      ).requiresAcknowledgedWarning,
    ).toBe(true);
    // Removing the Module is never one of this flow's dispositions.
    expect(
      claim.offeredDispositions.some((offer: { disposition: string }) =>
        offer.disposition.includes("remove"),
      ),
    ).toBe(false);
  });

  it("refuses a disposition value that is not one of the three", async () => {
    const harness = trackHarness();
    harness.claimStore.setClaims([preservedClaim()]);
    const client = await startConsole(harness);
    const response = await client.post(
      `/v1/admin/instances/${harness.instanceId}/claims/unknown-outcome/disposition`,
      { claimToken: IDENTITY.claimToken, disposition: "delete", operationId: "op-bad" },
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("UNKNOWN_OUTCOME_DISPOSITION_INVALID");
    expect(harness.claimStore.applied).toHaveLength(0);
  });

  it("reports an unknown claim token instead of guessing a Claim", async () => {
    const harness = trackHarness();
    harness.claimStore.setClaims([preservedClaim()]);
    const client = await startConsole(harness);
    const response = await client.post(
      `/v1/admin/instances/${harness.instanceId}/claims/unknown-outcome/disposition`,
      { claimToken: "claim-does-not-exist", disposition: "dead-letter", operationId: "op-404" },
    );
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("UNKNOWN_OUTCOME_CLAIM_NOT_FOUND");
    expect(harness.claimStore.applied).toHaveLength(0);
  });

  it("rejects evidence that could make the audit record unbounded", () => {
    const tooManyIntents = Array.from({ length: 1025 }, (_, index) => ({
      intentId: `effect-${index}`,
      description: "bounded description",
      recordedOutcome: "unknown" as const,
    }));
    expect(() =>
      buildPreservedClaim({
        identity: IDENTITY,
        moduleId: "summarizer",
        evidence: evidence({ externalEffectIntents: tooManyIntents }),
      }),
    ).toThrow("at most 1024 entries");

    expect(() =>
      buildPreservedClaim({
        identity: IDENTITY,
        moduleId: "summarizer",
        evidence: evidence({
          externalEffectIntents: [
            {
              intentId: "effect-1",
              description: "x".repeat(8193),
              recordedOutcome: "unknown",
            },
          ],
        }),
      }),
    ).toThrow("1 to 8192 UTF-8 bytes");

    expect(() =>
      buildPreservedClaim({
        identity: IDENTITY,
        moduleId: "summarizer",
        evidence: evidence({
          resultJournalEntry: { text: "x".repeat(1024 * 1024) },
        }),
      }),
    ).toThrow("1048576-byte limit");
  });
});

describe("SEC-CLAIM-002 a forced release warns before anything is applied", () => {
  it("returns the warning payload and applies nothing when it is not acknowledged", async () => {
    const harness = trackHarness();
    harness.claimStore.setClaims([preservedClaim()]);
    const client = await startConsole(harness);

    const refused = await client.post(
      `/v1/admin/instances/${harness.instanceId}/claims/unknown-outcome/disposition`,
      { claimToken: IDENTITY.claimToken, disposition: "release", operationId: "op-force" },
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("UNKNOWN_OUTCOME_WARNING_REQUIRED");
    const warning = refused.body.error.details.warning;
    expect(warning.schemaVersion).toBe("dolly.unknown-outcome-warning/2");
    expect(warning.disposition).toBe("release");
    expect(warning.identity).toEqual(IDENTITY);
    expect(warning.consequence).toContain("repeat an external effect");
    expect(warning.externalEffectsThatMayRepeat).toEqual([
      {
        intentId: "effect-1",
        description: "posted the summary to the outbound webhook",
        recordedOutcome: "unknown",
      },
    ]);
    expect(warning).not.toHaveProperty("unprovenExternalEffects");
    expect(typeof warning.acknowledgementDigest).toBe("string");

    // Nothing was released, dead-lettered, or otherwise touched.
    expect(harness.claimStore.applied).toHaveLength(0);
    expect(
      harness.auditLog.filter(
        (event) => event.eventType === "console.claim.unknown-outcome.disposition",
      ),
    ).toHaveLength(0);
    const issued = harness.auditLog.filter(
      (event) => event.eventType === "console.claim.unknown-outcome.warning-issued",
    );
    expect(issued).toHaveLength(1);
    expect(issued[0]!.result).toBe("refused");
  });

  it("warns about both completed effects and effects whose completion is unknown", async () => {
    const harness = trackHarness();
    const externalEffectIntents = [
      {
        intentId: "effect-unknown",
        description: "may have sent the notification",
        recordedOutcome: "unknown",
      },
      {
        intentId: "effect-no-effect",
        description: "was proven not to have started",
        recordedOutcome: "no-effect",
      },
      {
        intentId: "effect-terminal",
        description: "sent the billing request",
        recordedOutcome: "terminal",
      },
      {
        intentId: "effect-retry-safe",
        description: "uses an idempotency key",
        recordedOutcome: "retry-safe",
      },
    ] satisfies UnknownOutcomeEvidence["externalEffectIntents"];
    expect(
      unprovenExternalEffects(evidence({ externalEffectIntents })),
    ).toEqual(["effect-unknown: may have sent the notification"]);
    harness.claimStore.setClaims([
      preservedClaim({
        externalEffectIntents,
      }),
    ]);
    const client = await startConsole(harness);

    const refused = await client.post(
      `/v1/admin/instances/${harness.instanceId}/claims/unknown-outcome/disposition`,
      {
        claimToken: IDENTITY.claimToken,
        disposition: "release",
        operationId: "op-terminal-effect",
      },
    );

    expect(refused.status).toBe(400);
    const warning = refused.body.error.details.warning;
    expect(warning.schemaVersion).toBe("dolly.unknown-outcome-warning/2");
    expect(warning.externalEffectsThatMayRepeat).toEqual([
      {
        intentId: "effect-terminal",
        description: "sent the billing request",
        recordedOutcome: "terminal",
      },
      {
        intentId: "effect-unknown",
        description: "may have sent the notification",
        recordedOutcome: "unknown",
      },
    ]);
    const { acknowledgementDigest, ...warningBody } = warning;
    expect(acknowledgementDigest).toBe(canonicalJsonDigest(warningBody));
    expect(harness.claimStore.applied).toHaveLength(0);
  });

  it("refuses an acknowledgement that names different evidence", async () => {
    const harness = trackHarness();
    harness.claimStore.setClaims([preservedClaim()]);
    const staleWarning = buildForcedReleaseWarning(preservedClaim());
    // Core's evidence changes while the operator reads the screen.
    harness.claimStore.setClaims([
      preservedClaim({
        externalEffectIntents: [
          {
            intentId: "effect-1",
            description: "posted the summary to the outbound webhook",
            recordedOutcome: "terminal",
          },
        ],
      }),
    ]);
    const client = await startConsole(harness);

    const response = await client.post(
      `/v1/admin/instances/${harness.instanceId}/claims/unknown-outcome/disposition`,
      {
        claimToken: IDENTITY.claimToken,
        disposition: "release",
        operationId: "op-stale",
        acknowledgedWarningDigest: staleWarning.acknowledgementDigest,
      },
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("UNKNOWN_OUTCOME_EVIDENCE_STALE");
    expect(response.body.error.details.acknowledgedWarningDigest).toBe(
      staleWarning.acknowledgementDigest,
    );
    expect(response.body.error.details.currentAcknowledgementDigest).not.toBe(
      staleWarning.acknowledgementDigest,
    );
    expect(harness.claimStore.applied).toHaveLength(0);
  });

  it("records the request before the store call and actual success afterwards", async () => {
    const harness = trackHarness();
    const claim = preservedClaim();
    harness.claimStore.setClaims([claim]);
    const warning = buildForcedReleaseWarning(claim);
    const client = await startConsole(harness);

    const response = await client.post(
      `/v1/admin/instances/${harness.instanceId}/claims/unknown-outcome/disposition`,
      {
        claimToken: IDENTITY.claimToken,
        disposition: "release",
        operationId: "op-confirmed",
        acknowledgedWarningDigest: warning.acknowledgementDigest,
      },
    );
    expect(response.status).toBe(200);
    expect(response.body.outcome).toBe("released");

    expect(harness.claimStore.applied).toHaveLength(1);
    const applied = harness.claimStore.applied[0]!;
    expect(applied.request.identity).toEqual(IDENTITY);
    expect(applied.request.disposition).toBe("release");
    expect(applied.request.expectedEvidenceDigest).toBe(claim.evidenceDigest);

    const requestedAtCall = applied.auditEventsAtCall.filter(
      (event) =>
        event.eventType ===
        "console.claim.unknown-outcome.disposition-requested",
    );
    expect(requestedAtCall).toHaveLength(1);
    expect(
      applied.auditEventsAtCall.filter(
        (event) =>
          event.eventType === "console.claim.unknown-outcome.disposition",
      ),
    ).toHaveLength(0);

    const requested = requestedAtCall[0]!;
    expect(requested.moduleGenerationId).toBe(IDENTITY.moduleGenerationId);
    expect(requested.actor.principalId).toBe("operator");
    expect(requested.details).toMatchObject({
      disposition: "release",
      dispositionStatus: "requested",
      forced: true,
      claimToken: IDENTITY.claimToken,
      evidenceDigest: claim.evidenceDigest,
      evidenceComponentDigests: {
        moduleProcessRecordDigest: canonicalJsonDigest(
          claim.evidence.moduleProcessRecord!,
        ),
        moduleProcessStopProofDigest: canonicalJsonDigest(
          claim.evidence.moduleProcessStopProof!,
        ),
        submissionRecordDigest: canonicalJsonDigest(
          claim.evidence.submissionRecord!,
        ),
        resultJournalEntryDigest: null,
      },
      externalEffectIntentCounts: {
        total: 1,
        "no-effect": 0,
        "retry-safe": 0,
        terminal: 0,
        unknown: 1,
      },
      externalEffectIntents: [
        {
          intentId: "effect-1",
          recordedOutcome: "unknown",
          descriptionDigest: canonicalJsonDigest(
            "posted the summary to the outbound webhook",
          ),
        },
      ],
    });
    const requestedText = JSON.stringify(requested.details);
    expect(requestedText).not.toContain("posted the summary");
    expect(requestedText).not.toContain("preservedReason");
    expect(requestedText).not.toContain("warning");

    const actual = harness.auditLog.filter(
      (event) =>
        event.eventType === "console.claim.unknown-outcome.disposition" &&
        event.operationId === "op-confirmed",
    );
    expect(actual).toHaveLength(1);
    expect(actual[0]).toMatchObject({
      result: "succeeded",
      details: {
        dispositionStatus: "succeeded",
        outcome: "released",
        evidenceDigest: claim.evidenceDigest,
      },
    });
    expect(JSON.stringify(actual[0]!.details)).not.toContain(
      "posted the summary",
    );
  });

  it("fails safely when evidence changes at the store boundary", async () => {
    const harness = trackHarness();
    const claim = preservedClaim();
    harness.claimStore.setClaims([claim]);
    harness.claimStore.beforeNextApply(() => {
      harness.claimStore.setClaims([
        preservedClaim({
          externalEffectIntents: [
            {
              intentId: "effect-1",
              description: "posted the summary to the outbound webhook",
              recordedOutcome: "terminal",
            },
          ],
        }),
      ]);
    });
    const client = await startConsole(harness);

    const response = await client.post(
      `/v1/admin/instances/${harness.instanceId}/claims/unknown-outcome/disposition`,
      {
        claimToken: IDENTITY.claimToken,
        disposition: "dead-letter",
        operationId: "op-store-race",
      },
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "UNKNOWN_OUTCOME_EVIDENCE_STALE",
    });
    expect(harness.claimStore.applied).toHaveLength(0);
    expect(
      harness.auditLog.filter(
        (event) =>
          event.operationId === "op-store-race" &&
          event.eventType ===
            "console.claim.unknown-outcome.disposition-requested",
      ),
    ).toHaveLength(1);
    const actual = harness.auditLog.filter(
      (event) =>
        event.operationId === "op-store-race" &&
        event.eventType === "console.claim.unknown-outcome.disposition",
    );
    expect(actual).toHaveLength(1);
    expect(actual[0]).toMatchObject({
      result: "failed",
      details: {
        dispositionStatus: "failed",
        cause: "UNKNOWN_OUTCOME_EVIDENCE_STALE",
      },
    });
  });

  it("standardizes a store failure while preserving its stable cause", async () => {
    const harness = trackHarness();
    harness.claimStore.setClaims([preservedClaim()]);
    harness.claimStore.beforeNextApply(() => {
      throw Object.assign(new Error("simulated state write failure"), {
        code: "CORE_STATE_IO_FAILED",
      });
    });
    const client = await startConsole(harness);

    const response = await client.post(
      `/v1/admin/instances/${harness.instanceId}/claims/unknown-outcome/disposition`,
      {
        claimToken: IDENTITY.claimToken,
        disposition: "dead-letter",
        operationId: "op-store-error",
      },
    );

    expect(response.status).toBe(500);
    expect(response.body.error).toMatchObject({
      code: "ADMIN_OPERATION_FAILED",
      details: { cause: "CORE_STATE_IO_FAILED" },
    });
    expect(harness.claimStore.applied).toHaveLength(0);
    const actual = harness.auditLog.find(
      (event) =>
        event.operationId === "op-store-error" &&
        event.eventType === "console.claim.unknown-outcome.disposition",
    );
    expect(actual).toMatchObject({
      result: "failed",
      details: {
        dispositionStatus: "failed",
        cause: "CORE_STATE_IO_FAILED",
      },
    });
  });

  it("needs no warning for a dead letter or for leaving the Claim unresolved", async () => {
    const harness = trackHarness();
    harness.claimStore.setClaims([preservedClaim()]);
    const client = await startConsole(harness);

    const deadLettered = await client.post(
      `/v1/admin/instances/${harness.instanceId}/claims/unknown-outcome/disposition`,
      { claimToken: IDENTITY.claimToken, disposition: "dead-letter", operationId: "op-dl" },
    );
    expect(deadLettered.status).toBe(200);
    expect(deadLettered.body.outcome).toBe("dead-lettered");

    const left = await client.post(
      `/v1/admin/instances/${harness.instanceId}/claims/unknown-outcome/disposition`,
      {
        claimToken: IDENTITY.claimToken,
        disposition: "leave-unresolved",
        operationId: "op-leave",
      },
    );
    expect(left.status).toBe(200);
    expect(left.body.outcome).toBe("left-unresolved");
    expect(harness.claimStore.applied.map((entry) => entry.request.disposition)).toEqual([
      "dead-letter",
      "leave-unresolved",
    ]);
    expect(harness.claimStore.applied[1]!.request.reasonCode).toBe(
      "operator-left-unresolved",
    );
    const leaveAudit = harness.auditLog.find(
      (event) =>
        event.eventType === "console.claim.unknown-outcome.disposition" &&
        event.operationId === "op-leave",
    );
    expect(leaveAudit?.details?.reasonCode).toBe("operator-left-unresolved");
  });
});

describe("SEC-CLAIM-003 the CLI drives the same flow with the same codes", () => {
  it("refuses an unacknowledged forced release and succeeds once acknowledged", async () => {
    const harness = trackHarness();
    const claim = preservedClaim();
    harness.claimStore.setClaims([claim]);

    const refused = await runConsoleCliCommand(
      [
        "claim",
        "dispose-unknown-outcome",
        harness.instanceId,
        "--claim-token",
        IDENTITY.claimToken,
        "--disposition",
        "release",
        "--operation-id",
        "cli-force",
      ],
      { operations: harness.operations },
    );
    expect(refused.exitCode).toBe(1);
    const failure = JSON.parse(refused.stdout).error;
    expect(failure.code).toBe("UNKNOWN_OUTCOME_WARNING_REQUIRED");
    expect(failure.details.warning).toMatchObject({
      schemaVersion: "dolly.unknown-outcome-warning/2",
      externalEffectsThatMayRepeat: [
        {
          intentId: "effect-1",
          recordedOutcome: "unknown",
        },
      ],
    });
    expect(failure.details.warning).not.toHaveProperty(
      "unprovenExternalEffects",
    );
    expect(harness.claimStore.applied).toHaveLength(0);

    const accepted = await runConsoleCliCommand(
      [
        "claim",
        "dispose-unknown-outcome",
        harness.instanceId,
        "--claim-token",
        IDENTITY.claimToken,
        "--disposition",
        "release",
        "--operation-id",
        "cli-confirmed",
        "--acknowledge-warning",
        failure.details.warning.acknowledgementDigest,
      ],
      { operations: harness.operations },
    );
    expect(accepted.exitCode).toBe(0);
    expect(JSON.parse(accepted.stdout).outcome).toBe("released");
    expect(harness.claimStore.applied).toHaveLength(1);
    const auditAtCall = harness.claimStore.applied[0]!.auditEventsAtCall.filter(
      (event) =>
        event.eventType ===
        "console.claim.unknown-outcome.disposition-requested",
    );
    expect(auditAtCall).toHaveLength(1);
    expect(auditAtCall[0]!.actor.interface).toBe("cli");
  });

  it("lists the same evidence the HTTP surface returns", async () => {
    const harness = trackHarness();
    harness.claimStore.setClaims([preservedClaim()]);
    const client = await startConsole(harness);
    const overHttp = await client.get(
      `/v1/admin/instances/${harness.instanceId}/claims/unknown-outcome`,
    );
    const overCli = await runConsoleCliCommand(
      ["claim", "list-unknown-outcomes", harness.instanceId],
      { operations: harness.operations },
    );
    expect(overCli.exitCode).toBe(0);
    expect(JSON.parse(overCli.stdout)).toEqual(overHttp.body);
  });
});

describe("SEC-CLAIM-004 the adapter requires one atomic store operation", () => {
  const CURRENT_EVIDENCE_DIGEST = preservedClaim().evidenceDigest;

  function sameIdentity(
    actual: DeliveryClaimIdentity,
    expected: DeliveryClaimIdentity,
  ): boolean {
    return (
      actual.moduleJobId === expected.moduleJobId &&
      actual.claimToken === expected.claimToken &&
      actual.runId === expected.runId &&
      actual.attempt === expected.attempt &&
      actual.moduleGenerationId === expected.moduleGenerationId
    );
  }

  function activeClaim(): ClaimDescriptor {
    return {
      ...IDENTITY,
      consumerId: "summarizer",
      status: "active",
    };
  }

  function submissionRecord(): ModuleSubmissionRecord {
    return {
      schemaVersion: "dolly.module-submission-record/1",
      ...IDENTITY,
      processGenerationId: "process-generation-3",
      inputDigest: `sha256:${"a".repeat(64)}`,
      createdAt: "2026-07-26T00:00:00.000Z",
    };
  }

  function createDispositionOperations() {
    const state: {
      claim: ClaimDescriptor;
      submissionRecord: ModuleSubmissionRecord | undefined;
      evidenceDigest: string | undefined;
    } = {
      claim: activeClaim(),
      submissionRecord: submissionRecord(),
      evidenceDigest: CURRENT_EVIDENCE_DIGEST,
    };
    let beforeApply: (() => void) | undefined;
    const operations: DeliveryClaimDispositionOperations = {
      inspectUnknownOutcomeClaim: vi.fn((identity) => {
        if (!sameIdentity(state.claim, identity)) {
          throw new Error("The requested Claim is not in this store");
        }
        return {
          claim: { ...state.claim },
          submissionRecord:
            state.submissionRecord === undefined
              ? undefined
              : { ...state.submissionRecord },
          evidenceDigest: state.evidenceDigest,
        };
      }),
      applyUnknownOutcomeDisposition: vi.fn((request) => {
        const operation = beforeApply;
        beforeApply = undefined;
        operation?.();
        if (
          !sameIdentity(state.claim, request.identity) ||
          state.claim.status !== "active" ||
          state.evidenceDigest !== request.expectedEvidenceDigest
        ) {
          throw new ConsoleOperationError(
            "UNKNOWN_OUTCOME_EVIDENCE_STALE",
            "The Claim evidence changed before the atomic update",
          );
        }
        if (request.disposition === "leave-unresolved") {
          return "left-unresolved";
        }
        state.claim = {
          ...state.claim,
          status:
            request.disposition === "release" ? "released" : "dead-lettered",
        };
        state.submissionRecord = undefined;
        state.evidenceDigest = undefined;
        return request.disposition === "release" ? "released" : "dead-lettered";
      }),
    };
    return {
      operations,
      state,
      beforeNextApply(operation: () => void): void {
        beforeApply = operation;
      },
    };
  }

  function request(
    disposition: UnknownOutcomeDispositionRequest["disposition"],
  ): UnknownOutcomeDispositionRequest {
    return {
      identity: IDENTITY,
      disposition,
      reasonCode:
        disposition === "release"
          ? "operator-forced-release"
          : disposition === "dead-letter"
            ? "operator-dead-letter"
            : "operator-left-unresolved",
      expectedEvidenceDigest: CURRENT_EVIDENCE_DIGEST,
    };
  }

  it("uses the single compare-and-apply operation for all three dispositions", async () => {
    for (const expected of [
      ["release", "released", "released"],
      ["dead-letter", "dead-lettered", "dead-lettered"],
      ["leave-unresolved", "left-unresolved", "active"],
    ] as const) {
      const current = createDispositionOperations();
      expect(Object.keys(current.operations).sort()).toEqual([
        "applyUnknownOutcomeDisposition",
        "inspectUnknownOutcomeClaim",
      ]);
      const outcome = await deliveryClaimDispositionApplier(current.operations)(
        request(expected[0]),
      );
      expect(outcome).toBe(expected[1]);
      expect(current.state.claim.status).toBe(expected[2]);
      expect(
        current.operations.applyUnknownOutcomeDisposition,
      ).toHaveBeenCalledOnce();
      if (expected[0] === "leave-unresolved") {
        expect(current.state.submissionRecord).toBeDefined();
        expect(current.state.evidenceDigest).toBe(CURRENT_EVIDENCE_DIGEST);
      } else {
        expect(current.state.submissionRecord).toBeUndefined();
        expect(current.state.evidenceDigest).toBeUndefined();
      }
    }
  });

  it("reports stale evidence when the first inspection sees a changed digest", async () => {
    const current = createDispositionOperations();
    const changedDigest = canonicalJsonDigest({ changedBeforeInspection: true });
    current.state.evidenceDigest = changedDigest;

    await expect(
      deliveryClaimDispositionApplier(current.operations)(request("release")),
    ).rejects.toMatchObject({
      code: "UNKNOWN_OUTCOME_EVIDENCE_STALE",
      details: {
        expectedEvidenceDigest: CURRENT_EVIDENCE_DIGEST,
        currentEvidenceDigest: changedDigest,
      },
    });
    expect(
      current.operations.applyUnknownOutcomeDisposition,
    ).not.toHaveBeenCalled();
    expect(current.state.claim.status).toBe("active");
    expect(current.state.submissionRecord).toBeDefined();
  });

  it("reports stale evidence when the first inspection returns another Claim identity", async () => {
    const applyUnknownOutcomeDisposition = vi.fn(() => "released" as const);
    const operations: DeliveryClaimDispositionOperations = {
      inspectUnknownOutcomeClaim: vi.fn(() => ({
        claim: {
          ...activeClaim(),
          claimToken: "claim-other",
        },
        submissionRecord: undefined,
        evidenceDigest: CURRENT_EVIDENCE_DIGEST,
      })),
      applyUnknownOutcomeDisposition,
    };

    await expect(
      deliveryClaimDispositionApplier(operations)(request("release")),
    ).rejects.toMatchObject({
      code: "UNKNOWN_OUTCOME_EVIDENCE_STALE",
      details: { claimToken: IDENTITY.claimToken },
    });
    expect(applyUnknownOutcomeDisposition).not.toHaveBeenCalled();
  });

  it("detects evidence changed after inspection before any terminal change", async () => {
    const current = createDispositionOperations();
    const changedDigest = canonicalJsonDigest({ changed: true });
    current.beforeNextApply(() => {
      current.state.evidenceDigest = changedDigest;
    });

    await expect(
      deliveryClaimDispositionApplier(current.operations)(
        request("dead-letter"),
      ),
    ).rejects.toMatchObject({
      code: "UNKNOWN_OUTCOME_EVIDENCE_STALE",
    });
    expect(current.state.claim.status).toBe("active");
    expect(current.state.submissionRecord).toBeDefined();
    expect(current.state.evidenceDigest).toBe(changedDigest);
  });

  it("rejects a terminal outcome from a no-op operation", async () => {
    const current = createDispositionOperations();
    const operations: DeliveryClaimDispositionOperations = {
      inspectUnknownOutcomeClaim:
        current.operations.inspectUnknownOutcomeClaim,
      applyUnknownOutcomeDisposition: vi.fn(() => "released" as const),
    };

    await expect(
      deliveryClaimDispositionApplier(operations)(request("release")),
    ).rejects.toMatchObject({ code: "ADMIN_OPERATION_FAILED" });
    expect(current.state.claim.status).toBe("active");
    expect(current.state.submissionRecord).toBeDefined();
  });

  it("rejects an operation wired to another store", async () => {
    const local = createDispositionOperations();
    const foreign = createDispositionOperations();
    const operations: DeliveryClaimDispositionOperations = {
      inspectUnknownOutcomeClaim:
        local.operations.inspectUnknownOutcomeClaim,
      applyUnknownOutcomeDisposition:
        foreign.operations.applyUnknownOutcomeDisposition,
    };

    await expect(
      deliveryClaimDispositionApplier(operations)(request("release")),
    ).rejects.toMatchObject({ code: "ADMIN_OPERATION_FAILED" });
    expect(local.state.claim.status).toBe("active");
    expect(local.state.submissionRecord).toBeDefined();
    expect(foreign.state.claim.status).toBe("released");
  });

  it("rejects a Promise even when it changes the inspected store synchronously", async () => {
    const current = createDispositionOperations();
    const asynchronousApply = ((
      dispositionRequest: UnknownOutcomeDispositionRequest,
    ) =>
      Promise.resolve(
        current.operations.applyUnknownOutcomeDisposition(dispositionRequest),
      )) as unknown as DeliveryClaimDispositionOperations["applyUnknownOutcomeDisposition"];
    const operations: DeliveryClaimDispositionOperations = {
      inspectUnknownOutcomeClaim:
        current.operations.inspectUnknownOutcomeClaim,
      applyUnknownOutcomeDisposition: asynchronousApply,
    };

    await expect(
      deliveryClaimDispositionApplier(operations)(request("release")),
    ).rejects.toMatchObject({ code: "ADMIN_OPERATION_FAILED" });
    expect(current.state.claim.status).toBe("released");
  });

  it("rejects a terminal Claim that still has its submission record", async () => {
    const current = createDispositionOperations();
    const operations: DeliveryClaimDispositionOperations = {
      inspectUnknownOutcomeClaim:
        current.operations.inspectUnknownOutcomeClaim,
      applyUnknownOutcomeDisposition: vi.fn(() => {
        current.state.claim = {
          ...current.state.claim,
          status: "released",
        };
        current.state.evidenceDigest = undefined;
        return "released" as const;
      }),
    };

    await expect(
      deliveryClaimDispositionApplier(operations)(request("release")),
    ).rejects.toMatchObject({ code: "ADMIN_OPERATION_FAILED" });
    expect(current.state.submissionRecord).toBeDefined();
  });

  it("rejects leave-unresolved when the submission record changes", async () => {
    const current = createDispositionOperations();
    const operations: DeliveryClaimDispositionOperations = {
      inspectUnknownOutcomeClaim:
        current.operations.inspectUnknownOutcomeClaim,
      applyUnknownOutcomeDisposition: vi.fn(() => {
        current.state.submissionRecord = {
          ...current.state.submissionRecord!,
          createdAt: "2026-07-26T00:00:01.000Z",
        };
        return "left-unresolved" as const;
      }),
    };

    await expect(
      deliveryClaimDispositionApplier(operations)(
        request("leave-unresolved"),
      ),
    ).rejects.toMatchObject({ code: "ADMIN_OPERATION_FAILED" });
    expect(current.state.claim.status).toBe("active");
  });
});
