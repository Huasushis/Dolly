/**
 * `security-operations.md` Section 13.1 conformance: the audited operator flow
 * for a Module Claim preserved as an unknown outcome.
 *
 * The four obligations are asserted directly: the exact Claim and the evidence
 * Core considered are shown, only the three stated dispositions are offered, a
 * forced release is refused until an explicit warning about repeating an
 * external effect is acknowledged, and the Section 11 audit event is written
 * **before** the disposition is applied. The last one is checked by recording
 * the audit log as it stood at the moment the store was called.
 */

import { afterEach, describe, expect, it } from "vitest";
import { BlockStore } from "../../../src/core/block-store.js";
import { DeliveryStore } from "../../../src/core/delivery-store.js";
import { AdminHttpServer } from "../../../src/daemon/console/admin-http-server.js";
import { runConsoleCliCommand } from "../../../src/daemon/console/console-cli.js";
import {
  buildForcedReleaseWarning,
  buildPreservedClaim,
  deliveryStoreDispositionApplier,
  type PreservedUnknownOutcomeClaim,
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
      declaredExternalEffects: "core-capabilities",
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
    expect(warning.disposition).toBe("release");
    expect(warning.identity).toEqual(IDENTITY);
    expect(warning.consequence).toContain("repeat an external effect");
    expect(warning.unprovenExternalEffects).toEqual([
      "effect-1: posted the summary to the outbound webhook",
    ]);
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

  it("writes the audit event before the disposition reaches the Claim store", async () => {
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

    // The audit log as it stood when the store was called already carries the
    // disposition event, so the record cannot be written only on success.
    const auditAtCall = applied.auditEventsAtCall.filter(
      (event) => event.eventType === "console.claim.unknown-outcome.disposition",
    );
    expect(auditAtCall).toHaveLength(1);
    const event = auditAtCall[0]!;
    expect(event.result).toBe("succeeded");
    expect(event.moduleGenerationId).toBe(IDENTITY.moduleGenerationId);
    expect(event.actor.principalId).toBe("operator");
    expect(event.details?.disposition).toBe("release");
    expect(event.details?.forced).toBe(true);
    expect(event.details?.claimToken).toBe(IDENTITY.claimToken);
    expect(event.details?.evidenceDigest).toBe(claim.evidenceDigest);
    expect(JSON.stringify(event.details?.evidence)).toContain("posted the summary");
    expect(String(event.details?.warning)).toContain("repeat an external effect");
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
      (event) => event.eventType === "console.claim.unknown-outcome.disposition",
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

describe("SEC-CLAIM-004 dispositions applied to a real Delivery store", () => {
  function realStore() {
    let blockId = 0;
    let runtimeId = 0;
    const blocks = new BlockStore({
      nextBlockId: () => `block-${++blockId}`,
      now: () => "2026-07-26T00:00:00.000Z",
    });
    const deliveries = new DeliveryStore({
      blocks,
      maxFailedAttempts: 3,
      nextId: (kind) => `${kind}-${++runtimeId}`,
      now: () => "2026-07-26T00:00:00.000Z",
    });
    deliveries.createPage("input");
    deliveries.registerConsumer("input", "worker", "from-now");
    const block = blocks.commit(
      { payload: { schema: "test.content/1", value: { text: "hello" } } },
      { kind: "module", id: "worker" },
    );
    deliveries.append("input", block.id);
    const claim = deliveries.claim({
      consumerId: "worker",
      pageIds: ["input"],
      moduleGenerationId: "generation-3",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    return { deliveries, claim };
  }

  it("dead-letters every remaining Delivery instead of discarding it", async () => {
    const { deliveries, claim } = realStore();
    const apply = deliveryStoreDispositionApplier(deliveries);
    expect(deliveries.listActiveClaims()).toHaveLength(1);

    const outcome = await apply({
      identity: {
        moduleJobId: claim.moduleJobId,
        claimToken: claim.claimToken,
        runId: claim.runId,
        attempt: claim.attempt,
        moduleGenerationId: claim.moduleGenerationId,
      },
      disposition: "dead-letter",
      reasonCode: "operator-dead-letter",
    });

    expect(outcome).toBe("dead-lettered");
    const deadLetters = deliveries.listDeadLetters();
    expect(deadLetters).toHaveLength(claim.deliveryIds.length);
    expect(deadLetters.map((record) => record.deliveryId).sort()).toEqual(
      [...claim.deliveryIds].sort(),
    );
    expect(deadLetters[0]!.failureCode).toBe("operator-dead-letter");
    expect(deliveries.listActiveClaims()).toHaveLength(0);
  });

  it("releases the exact Claim and leaves an unresolved one untouched", async () => {
    const released = realStore();
    const releaseOutcome = await deliveryStoreDispositionApplier(released.deliveries)({
      identity: {
        moduleJobId: released.claim.moduleJobId,
        claimToken: released.claim.claimToken,
        runId: released.claim.runId,
        attempt: released.claim.attempt,
        moduleGenerationId: released.claim.moduleGenerationId,
      },
      disposition: "release",
      reasonCode: "operator-forced-release",
    });
    expect(releaseOutcome).toBe("released");
    expect(released.deliveries.listActiveClaims()).toHaveLength(0);
    expect(released.deliveries.listDeadLetters()).toHaveLength(0);
    expect(
      released.deliveries.inspectPending("worker", ["input"]).pendingCount,
    ).toBe(released.claim.deliveryIds.length);

    const untouched = realStore();
    const leftOutcome = await deliveryStoreDispositionApplier(untouched.deliveries)({
      identity: {
        moduleJobId: untouched.claim.moduleJobId,
        claimToken: untouched.claim.claimToken,
        runId: untouched.claim.runId,
        attempt: untouched.claim.attempt,
        moduleGenerationId: untouched.claim.moduleGenerationId,
      },
      disposition: "leave-unresolved",
      reasonCode: "operator-left-unresolved",
    });
    expect(leftOutcome).toBe("left-unresolved");
    expect(untouched.deliveries.listActiveClaims()).toHaveLength(1);
    expect(untouched.deliveries.listDeadLetters()).toHaveLength(0);
  });
});
