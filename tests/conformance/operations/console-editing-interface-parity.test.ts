/**
 * `instance-topology.md` Section 13 conformance: the two editing interfaces are
 * equivalent.
 *
 * Every assertion here compares a real loopback Hypertext Transfer Protocol
 * (HTTP) round trip against the command-line interface (CLI) module. Nothing is
 * asserted about a status string alone: the equivalence checks compare stored
 * configuration revisions and canonical bytes, and the refusal checks compare
 * stable error codes and prove no revision was created.
 */

import { afterEach, describe, expect, it } from "vitest";
import { canonicalizeJson, type JsonValue } from "../../../src/core/canonical-json.js";
import { AdminHttpServer } from "../../../src/daemon/console/admin-http-server.js";
import {
  consoleCliExposedOperations,
  runConsoleCliCommand,
} from "../../../src/daemon/console/console-cli.js";
import { CONSOLE_OPERATION_CATALOG } from "../../../src/daemon/console/operation-catalog.js";
import {
  createConsoleHarness,
  rawHttpRequest,
  type ConsoleHarness,
} from "./fixtures/console-operations-harness.js";

const MODULE_CONFIG_REVISION = `sha256:${"a".repeat(64)}`;

const started: { server: AdminHttpServer }[] = [];
const harnesses: ConsoleHarness[] = [];

afterEach(async () => {
  for (const entry of started.splice(0)) await entry.server.stop();
  for (const harness of harnesses.splice(0)) harness.dispose();
});

function trackHarness(harness: ConsoleHarness): ConsoleHarness {
  harnesses.push(harness);
  return harness;
}

interface AdminClient {
  readonly origin: string;
  readonly cookie: string;
  readonly csrfToken: string;
  post(path: string, body: unknown): Promise<{ status: number; body: any }>;
  get(path: string): Promise<{ status: number; body: any }>;
}

async function startConsole(harness: ConsoleHarness): Promise<AdminClient> {
  const server = new AdminHttpServer({ operations: harness.operations });
  const address = await server.start();
  started.push({ server });
  const origin = server.origin!;
  const host = address.host;
  const port = address.port;
  const authority = new URL(origin).host;
  const pairing = server.issuePairingCode("operator");
  const paired = await rawHttpRequest({
    host,
    port,
    path: "/v1/admin/session",
    method: "POST",
    headers: { "content-type": "application/json", origin, host: authority },
    body: JSON.stringify({ code: pairing.code }),
  });
  expect(paired.status).toBe(201);
  const grant = JSON.parse(paired.text) as { csrfToken: string };
  const setCookie = paired.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";", 1)[0]!;
  return {
    origin,
    cookie,
    csrfToken: grant.csrfToken,
    async post(path, body) {
      const response = await rawHttpRequest({
        host,
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          host: authority,
          cookie,
          "x-dolly-csrf": grant.csrfToken,
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: JSON.parse(response.text) };
    },
    async get(path) {
      const response = await rawHttpRequest({
        host,
        port,
        path,
        headers: { host: authority, cookie },
      });
      return { status: response.status, body: JSON.parse(response.text) };
    },
  };
}

function moduleProposal(overrides: Record<string, JsonValue> = {}): JsonValue {
  return {
    moduleId: "summarizer",
    extensionId: "acme.summary",
    packageVersion: "1.0.0",
    moduleKind: "reactive-summary",
    isolation: "process",
    configurationReference: {
      configId: "summary-config",
      revision: MODULE_CONFIG_REVISION,
      configVersion: 1,
    },
    permissionPolicyIds: [],
    inputPageIds: ["main"],
    outputPageIds: ["notes"],
    activation: { kind: "reactive" },
    limits: {
      claim: { maxCount: 8, maxBytes: 65_536 },
      maxInputBytes: 1_048_576,
      maxResultBytes: 1_048_576,
      maxFrameBytes: 2_097_152,
      maxRunsPerGeneration: 100,
      maxGenerations: 10,
    },
    timeouts: {
      initializationTimeoutMs: 30_000,
      executionTimeoutMs: 60_000,
      cancellationGraceMs: 5_000,
      terminationTimeoutMs: 5_000,
    },
    ...overrides,
  } as JsonValue;
}

describe("TOPO-001 capability parity between the two editing interfaces", () => {
  it("exposes exactly the same declared operation set through HTTP and the CLI", () => {
    const harness = trackHarness(createConsoleHarness());
    const server = new AdminHttpServer({ operations: harness.operations });
    const httpExposure = server.exposedOperations();
    const cliExposure = consoleCliExposedOperations();

    expect(httpExposure.map((entry) => entry.name)).toEqual(
      cliExposure.map((entry) => entry.name),
    );
    expect(httpExposure).toEqual(cliExposure);
    expect(httpExposure).toEqual(CONSOLE_OPERATION_CATALOG);
    // A real set, not an empty one that would make the comparison vacuous.
    expect(httpExposure.length).toBe(9);
    expect(httpExposure.map((entry) => entry.name)).toContain("topology.commit");
    const commit = httpExposure.find((entry) => entry.name === "topology.commit")!;
    expect(commit.confirmation).toBe("confirmedPlanDigest");
    expect(commit.errorCodes).toContain("CONFIG_REVISION_CONFLICT");
  });

  it("exempts only liveness, session lifecycle, and the static catalog listing from parity", () => {
    const harness = trackHarness(createConsoleHarness());
    const server = new AdminHttpServer({ operations: harness.operations });

    // Pinning the exempt set is the guard: a route that lets an operator *do*
    // something cannot be added without a CLI command unless this list is
    // edited, which forces the author to justify the exemption.
    expect(server.surfaceRoutes()).toEqual([
      "DELETE /v1/admin/session",
      "GET /v1/admin/health",
      "GET /v1/admin/operations",
      "POST /v1/admin/session",
    ]);

    // The catalog listing dispatches nothing: every operation it names is
    // independently reachable from both exposures, so excluding it hides no
    // capability from a headless operator.
    const cliNames = consoleCliExposedOperations().map((entry) => entry.name);
    for (const declared of CONSOLE_OPERATION_CATALOG) {
      expect(cliNames).toContain(declared.name);
    }
  });
});

describe("TOPO-002 identical logical change through both interfaces", () => {
  it("produces byte-identical canonical documents and the same revision", async () => {
    const viaHttp = trackHarness(createConsoleHarness());
    const viaCli = trackHarness(createConsoleHarness());
    const startingRevision = viaHttp.currentRevision();
    expect(viaCli.currentRevision()).toBe(startingRevision);

    const client = await startConsole(viaHttp);
    const httpResult = await client.post(
      `/v1/admin/instances/${viaHttp.instanceId}/topology/commit`,
      {
        expectedRevision: startingRevision,
        // The editor emits the Pages in the order the operator drew them.
        proposal: { pages: [{ pageId: "notes" }, { pageId: "main" }], modules: [] },
        operationId: "op-http-1",
      },
    );
    expect(httpResult.status).toBe(200);

    const cliResult = await runConsoleCliCommand(
      [
        "topology",
        "commit",
        viaCli.instanceId,
        "--expected-revision",
        startingRevision,
        "--proposal-json",
        // The CLI operator types the Pages in a different order.
        JSON.stringify({ pages: [{ pageId: "main" }, { pageId: "notes" }], modules: [] }),
        "--operation-id",
        "op-cli-1",
      ],
      { operations: viaCli.operations },
    );
    expect(cliResult.stderr).toBe("");
    expect(cliResult.exitCode).toBe(0);

    expect(viaHttp.currentRevision()).not.toBe(startingRevision);
    expect(viaHttp.currentRevision()).toBe(viaCli.currentRevision());
    expect(canonicalizeJson(viaHttp.currentDocument())).toBe(
      canonicalizeJson(viaCli.currentDocument()),
    );
    expect(viaHttp.currentDocument().pages.map((page) => page.pageId)).toEqual([
      "main",
      "notes",
    ]);
    expect(httpResult.body.newRevision).toBe(viaHttp.currentRevision());
    expect(JSON.parse(cliResult.stdout).newRevision).toBe(viaCli.currentRevision());
  });

  it("emits the same audit event type and fields, differing only in actor", async () => {
    const viaHttp = trackHarness(createConsoleHarness());
    const viaCli = trackHarness(createConsoleHarness());
    const startingRevision = viaHttp.currentRevision();

    const client = await startConsole(viaHttp);
    await client.post(`/v1/admin/instances/${viaHttp.instanceId}/topology/commit`, {
      expectedRevision: startingRevision,
      proposal: { pages: [{ pageId: "main" }, { pageId: "notes" }], modules: [] },
      operationId: "shared-op",
    });
    await runConsoleCliCommand(
      [
        "topology",
        "commit",
        viaCli.instanceId,
        "--expected-revision",
        startingRevision,
        "--proposal-json",
        JSON.stringify({ pages: [{ pageId: "main" }, { pageId: "notes" }], modules: [] }),
        "--operation-id",
        "shared-op",
      ],
      { operations: viaCli.operations },
    );

    const httpEvent = viaHttp.auditLog.find(
      (event) => event.eventType === "console.topology.commit",
    )!;
    const cliEvent = viaCli.auditLog.find(
      (event) => event.eventType === "console.topology.commit",
    )!;
    expect(httpEvent).toBeDefined();
    expect(cliEvent).toBeDefined();
    expect(httpEvent.actor.interface).toBe("graphical");
    expect(cliEvent.actor.interface).toBe("cli");
    expect(httpEvent.newConfigRevision).toBe(cliEvent.newConfigRevision);

    const withoutActor = (event: typeof httpEvent): unknown => {
      const { actor, observedAt, ...rest } = event;
      return rest;
    };
    expect(withoutActor(httpEvent)).toEqual(withoutActor(cliEvent));
  });
});

describe("TOPO-003 one validator, one set of error codes", () => {
  it("rejects a connection naming an undeclared Page through both interfaces and creates no revision", async () => {
    const viaHttp = trackHarness(createConsoleHarness());
    const viaCli = trackHarness(createConsoleHarness());
    const revision = viaHttp.currentRevision();
    const proposal = {
      pages: [{ pageId: "main" }],
      modules: [moduleProposal({ outputPageIds: ["nowhere"] })],
    };

    const client = await startConsole(viaHttp);
    const httpResult = await client.post(
      `/v1/admin/instances/${viaHttp.instanceId}/topology/commit`,
      {
        expectedRevision: revision,
        proposal,
        startPositions: [{ moduleId: "summarizer", pageId: "main", start: "from-now" }],
        operationId: "op-http-2",
      },
    );
    expect(httpResult.status).toBe(400);
    expect(httpResult.body.error.code).toBe("RUNTIME_CONFIG_TOPOLOGY_INVALID");
    expect(httpResult.body.error.message).toContain("nowhere");

    const cliResult = await runConsoleCliCommand(
      [
        "topology",
        "commit",
        viaCli.instanceId,
        "--expected-revision",
        revision,
        "--proposal-json",
        JSON.stringify(proposal),
        "--start-positions",
        JSON.stringify([{ moduleId: "summarizer", pageId: "main", start: "from-now" }]),
        "--operation-id",
        "op-cli-2",
      ],
      { operations: viaCli.operations },
    );
    expect(cliResult.exitCode).toBe(1);
    expect(JSON.parse(cliResult.stdout).error.code).toBe("RUNTIME_CONFIG_TOPOLOGY_INVALID");

    expect(viaHttp.currentRevision()).toBe(revision);
    expect(viaCli.currentRevision()).toBe(revision);
  });

  it("rejects a repeated Page in one input list rather than deduplicating it", async () => {
    const harness = trackHarness(createConsoleHarness());
    const revision = harness.currentRevision();
    const client = await startConsole(harness);
    const result = await client.post(
      `/v1/admin/instances/${harness.instanceId}/topology/commit`,
      {
        expectedRevision: revision,
        proposal: {
          pages: [{ pageId: "main" }, { pageId: "notes" }],
          modules: [moduleProposal({ inputPageIds: ["main", "main"] })],
        },
        startPositions: [{ moduleId: "summarizer", pageId: "main", start: "from-now" }],
        operationId: "op-dup",
      },
    );
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("RUNTIME_CONFIG_INVALID");
    expect(result.body.error.message).toContain("duplicates");
    expect(harness.currentRevision()).toBe(revision);
  });

  it("requires an explicit start position for every new subscription through both interfaces", async () => {
    const viaHttp = trackHarness(createConsoleHarness());
    const viaCli = trackHarness(createConsoleHarness());
    const revision = viaHttp.currentRevision();
    const proposal = {
      pages: [{ pageId: "main" }, { pageId: "notes" }],
      modules: [moduleProposal()],
    };

    const client = await startConsole(viaHttp);
    const httpResult = await client.post(
      `/v1/admin/instances/${viaHttp.instanceId}/topology/plan`,
      { expectedRevision: revision, proposal },
    );
    expect(httpResult.status).toBe(400);
    expect(httpResult.body.error.code).toBe("TOPOLOGY_START_POSITION_REQUIRED");
    expect(httpResult.body.error.details.pageIds).toEqual(["main"]);

    const cliResult = await runConsoleCliCommand(
      [
        "topology",
        "plan",
        viaCli.instanceId,
        "--expected-revision",
        revision,
        "--proposal-json",
        JSON.stringify(proposal),
      ],
      { operations: viaCli.operations },
    );
    expect(cliResult.exitCode).toBe(1);
    expect(JSON.parse(cliResult.stdout).error.code).toBe("TOPOLOGY_START_POSITION_REQUIRED");
  });
});

describe("TOPO-004 concurrent editing", () => {
  it("fails the second writer with CONFIG_REVISION_CONFLICT and keeps the first writer's document", async () => {
    const harness = trackHarness(createConsoleHarness());
    const sharedRevision = harness.currentRevision();
    const client = await startConsole(harness);

    const first = await client.post(
      `/v1/admin/instances/${harness.instanceId}/topology/commit`,
      {
        expectedRevision: sharedRevision,
        proposal: { pages: [{ pageId: "main" }, { pageId: "first-writer" }], modules: [] },
        operationId: "op-first",
      },
    );
    expect(first.status).toBe(200);
    const committedRevision = harness.currentRevision();
    expect(committedRevision).not.toBe(sharedRevision);

    const second = await runConsoleCliCommand(
      [
        "topology",
        "commit",
        harness.instanceId,
        "--expected-revision",
        sharedRevision,
        "--proposal-json",
        JSON.stringify({
          pages: [{ pageId: "main" }, { pageId: "second-writer" }],
          modules: [],
        }),
        "--operation-id",
        "op-second",
      ],
      { operations: harness.operations },
    );
    expect(second.exitCode).toBe(1);
    const failure = JSON.parse(second.stdout).error;
    expect(failure.code).toBe("CONFIG_REVISION_CONFLICT");
    expect(failure.details.expectedRevision).toBe(sharedRevision);
    expect(failure.details.currentRevision).toBe(committedRevision);

    expect(harness.currentRevision()).toBe(committedRevision);
    expect(harness.currentDocument().pages.map((page) => page.pageId)).toEqual([
      "first-writer",
      "main",
    ]);
    // No path re-based the refused edit onto the new revision.
    expect(
      harness.auditLog.filter(
        (event) => event.eventType === "console.topology.commit" && event.result === "succeeded",
      ),
    ).toHaveLength(1);
  });
});

describe("TOPO-005 expected, desired, and effective revisions stay distinguishable", () => {
  it("reports a desired revision the runtime has not applied", async () => {
    const harness = trackHarness(createConsoleHarness());
    const startingRevision = harness.currentRevision();
    harness.setEffectiveRevision(startingRevision);
    const client = await startConsole(harness);

    const commit = await client.post(
      `/v1/admin/instances/${harness.instanceId}/topology/commit`,
      {
        expectedRevision: startingRevision,
        proposal: { pages: [{ pageId: "main" }, { pageId: "pending" }], modules: [] },
        operationId: "op-divergence",
      },
    );
    expect(commit.status).toBe(200);
    expect(commit.body.expectedRevision).toBe(startingRevision);
    expect(commit.body.desiredRevision).toBe(harness.currentRevision());
    expect(commit.body.effectiveRevision).toBe(startingRevision);
    expect(commit.body.revisionsDiverged).toBe(true);

    const view = await client.get(`/v1/admin/instances/${harness.instanceId}/config`);
    expect(view.status).toBe(200);
    expect(view.body.desiredRevision).toBe(harness.currentRevision());
    expect(view.body.effectiveRevision).toBe(startingRevision);
    expect(view.body.revisionsDiverged).toBe(true);
  });
});
