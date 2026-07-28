/**
 * Shared fixture for the management-console conformance tests.
 *
 * It builds one real registered instance on disk — a real configuration file,
 * a real instance registry record, and a real state manifest — plus the ports
 * the console operation layer depends on. Nothing here is mocked that the
 * tests are meant to prove: the configuration store, its cross-process lock,
 * its atomic write, and its compare-and-swap are the production ones.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "../../../../src/core/canonical-json.js";
import { InstanceConfigStore } from "../../../../src/core/instance-config-store.js";
import {
  createDefaultDollyInstanceConfig,
  dollyInstanceConfigSchema,
  type DollyInstanceConfig,
} from "../../../../src/core/runtime-config.js";
import type { DaemonInstanceReport } from "../../../../src/daemon/daemon-instance-manager.js";
import type { RegisteredInstance } from "../../../../src/daemon/instance-registry.js";
import type { ConsoleAuditEvent } from "../../../../src/daemon/console/console-audit.js";
import {
  ConsoleOperations,
  type InstanceLifecycleControl,
} from "../../../../src/daemon/console/console-operations.js";
import {
  noRecordedObligations,
  type InstanceObligations,
} from "../../../../src/daemon/console/instance-obligations.js";
import type {
  PreservedUnknownOutcomeClaim,
  UnknownOutcomeClaimStore,
  UnknownOutcomeDispositionOutcome,
  UnknownOutcomeDispositionRequest,
} from "../../../../src/daemon/console/unknown-outcome.js";

const INSTANCE_ID = "8f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";

export interface RecordedDisposition {
  readonly request: UnknownOutcomeDispositionRequest;
  /** The audit events already written when `applyDisposition` was called. */
  readonly auditEventsAtCall: readonly ConsoleAuditEvent[];
}

export class RecordingClaimStore implements UnknownOutcomeClaimStore {
  readonly applied: RecordedDisposition[] = [];
  #claims: readonly PreservedUnknownOutcomeClaim[];
  readonly #auditLog: readonly ConsoleAuditEvent[];
  #outcome: UnknownOutcomeDispositionOutcome = "released";

  constructor(claims: readonly PreservedUnknownOutcomeClaim[], auditLog: readonly ConsoleAuditEvent[]) {
    this.#claims = claims;
    this.#auditLog = auditLog;
  }

  setClaims(claims: readonly PreservedUnknownOutcomeClaim[]): void {
    this.#claims = claims;
  }

  setOutcome(outcome: UnknownOutcomeDispositionOutcome): void {
    this.#outcome = outcome;
  }

  listPreservedClaims(): Promise<readonly PreservedUnknownOutcomeClaim[]> {
    return Promise.resolve(this.#claims);
  }

  applyDisposition(request: UnknownOutcomeDispositionRequest): Promise<UnknownOutcomeDispositionOutcome> {
    this.applied.push({ request, auditEventsAtCall: [...this.#auditLog] });
    return Promise.resolve(
      request.disposition === "dead-letter"
        ? "dead-lettered"
        : request.disposition === "leave-unresolved"
          ? "left-unresolved"
          : this.#outcome,
    );
  }
}

class StubLifecycle implements InstanceLifecycleControl {
  readonly starts: string[] = [];
  readonly stops: string[] = [];

  constructor(private readonly store: InstanceConfigStore<DollyInstanceConfig>, private readonly configPath: string) {}

  listRegisteredInstances(): readonly RegisteredInstance[] {
    const loaded = this.store.inspect(this.configPath);
    return [
      {
        instanceId: loaded.instanceId,
        configPath: loaded.configPath,
        stateDirectory: loaded.stateDirectory,
        desiredConfigRevision: loaded.configRevision,
        updatedAt: "2026-07-25T00:00:00.000Z",
      },
    ];
  }

  listInstances(): Promise<readonly DaemonInstanceReport[]> {
    return Promise.resolve(this.listRegisteredInstances().map((instance) => this.#report(instance)));
  }

  describeInstance(instanceId: string): Promise<DaemonInstanceReport> {
    const instance = this.listRegisteredInstances().find(
      (candidate) => candidate.instanceId === instanceId,
    );
    if (!instance) return Promise.reject(new Error("not registered"));
    return Promise.resolve(this.#report(instance));
  }

  startInstance(instanceId: string, operationId: string): Promise<DaemonInstanceReport> {
    this.starts.push(`${instanceId}/${operationId}`);
    return this.describeInstance(instanceId);
  }

  stopInstance(instanceId: string, operationId: string): Promise<DaemonInstanceReport> {
    this.stops.push(`${instanceId}/${operationId}`);
    return this.describeInstance(instanceId);
  }

  #report(instance: RegisteredInstance): DaemonInstanceReport {
    return {
      instanceId: instance.instanceId,
      configPath: instance.configPath,
      stateDirectory: instance.stateDirectory,
      desiredConfigRevision: instance.desiredConfigRevision,
      status: "stopped",
      managedByThisDaemon: false,
      evidence: {
        controllerLock: "unheld",
        readinessHandshake: "absent",
        processRecord: "none",
      },
      endpoints: [],
      unexpectedExitCount: 0,
      restartStreak: 0,
    };
  }
}

export interface ConsoleHarness {
  readonly instanceId: string;
  readonly configPath: string;
  readonly registryDirectory: string;
  readonly configStore: InstanceConfigStore<DollyInstanceConfig>;
  readonly operations: ConsoleOperations;
  readonly auditLog: readonly ConsoleAuditEvent[];
  readonly claimStore: RecordingClaimStore;
  readonly lifecycle: StubLifecycle;
  currentRevision(): string;
  currentDocument(): Readonly<DollyInstanceConfig>;
  setObligations(obligations: InstanceObligations): void;
  setEffectiveRevision(revision: string | null): void;
  dispose(): void;
}

export function createConsoleHarness(
  options: { readonly obligations?: InstanceObligations } = {},
): ConsoleHarness {
  const root = mkdtempSync(join(tmpdir(), "dolly-console-"));
  const registryDirectory = join(root, "registry");
  const configStore = new InstanceConfigStore<DollyInstanceConfig>({
    schema: dollyInstanceConfigSchema,
    registryDirectory,
    defaultStateRoot: join(root, "state"),
    nextInstanceId: () => INSTANCE_ID,
    now: () => "2026-07-25T00:00:00.000Z",
  });
  const configPath = join(root, "dolly.json");
  configStore.initialize(configPath, (instanceId) =>
    createDefaultDollyInstanceConfig(instanceId, "Console Harness"),
  );

  const auditLog: ConsoleAuditEvent[] = [];
  const claimStore = new RecordingClaimStore([], auditLog);
  const lifecycle = new StubLifecycle(configStore, configPath);
  let obligations = options.obligations ?? noRecordedObligations();
  let effectiveRevision: string | null = null;
  let clock = 0;

  const operations = new ConsoleOperations({
    lifecycle,
    configStore,
    obligations: { readObligations: () => Promise.resolve(obligations) },
    unknownOutcomeClaims: () => claimStore,
    effectiveRevision: () => Promise.resolve(effectiveRevision),
    audit: (event) => auditLog.push(event),
    now: () => {
      clock += 1;
      return new Date(Date.UTC(2026, 6, 25, 0, 0, clock)).toISOString();
    },
  });

  return {
    instanceId: INSTANCE_ID,
    configPath: configStore.inspect(configPath).configPath,
    registryDirectory,
    configStore,
    operations,
    auditLog,
    claimStore,
    lifecycle,
    currentRevision: () => configStore.inspect(configPath).configRevision,
    currentDocument: () => configStore.inspect(configPath).document,
    setObligations: (next) => {
      obligations = next;
    },
    setEffectiveRevision: (revision) => {
      effectiveRevision = revision;
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

export interface RawHttpResponse {
  readonly status: number;
  readonly headers: NodeJS.Dict<string | string[]>;
  readonly text: string;
}

/**
 * One real loopback HTTP round trip over `node:http`, so a test can send a
 * malformed header, an oversized body, or a hostile `Origin` that a higher
 * level client would normalize away.
 */
export function rawHttpRequest(input: {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Buffer;
}): Promise<RawHttpResponse> {
  return new Promise((resolvePromise, rejectPromise) => {
    const clientRequest = httpRequest(
      {
        host: input.host,
        port: input.port,
        path: input.path,
        method: input.method ?? "GET",
        headers: input.headers,
        // The default agent keeps sockets alive, which leaves a stopped
        // server's connections open at the end of a test.
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    clientRequest.on("error", rejectPromise);
    if (input.body !== undefined) clientRequest.write(input.body);
    clientRequest.end();
  });
}

/** A proposal that adds one Page and connects nothing to it. */
export function pagesProposal(pageIds: readonly string[]): {
  pages: JsonValue[];
  modules: JsonValue[];
} {
  return {
    pages: pageIds.map((pageId) => ({ pageId })),
    modules: [],
  };
}
