/**
 * Process-generation tokens and their refusal guard (WS4 first slice).
 *
 * A generation token pairs an epoch marker with a monotonic counter and names
 * exactly one supervised child. The acceptance properties are exercised here:
 * counters bump monotonically and never repeat, the guard refuses actions that
 * carry a stale token, and epochs stay isolated so a token from another
 * supervision session is never taken for this one. The last describe block
 * wires the guard into `DaemonInstanceManager`'s ownership checks to prove the
 * daemon refuses a same-epoch generation its session never issued while
 * leaving pre-token and foreign records to the identity evidence unchanged.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ProcessLaunchObserver,
  ProcessLauncher,
  SupervisedProcess,
  SupervisorSpawnRequest,
} from "../../../src/core/process-supervisor.js";
import {
  DaemonInstanceManager,
  type DaemonInstanceManagerOptions,
} from "../../../src/daemon/daemon-instance-manager.js";
import {
  InstanceProcessRecordStore,
  deriveIpcSessionId,
  type InstanceProcessRecord,
} from "../../../src/daemon/instance-process-record-store.js";
import {
  ProcessGenerationError,
  ProcessGenerationSequence,
  formatProcessGenerationToken,
  parseProcessGenerationToken,
} from "../../../src/daemon/process-generation.js";
import type { ProcessIdentityObservation, ProcessIdentityProbe } from "../../../src/daemon/process-identity.js";
import {
  createTestInstanceRegistry,
  type TestInstanceRegistry,
} from "./fixtures/daemon-test-registry.js";

const EPOCH = "11111111-1111-4111-8111-111111111111";
/** The durable record store's rule for a processGenerationId string. */
const GENERATION_ID_RULE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

class StubIdentityProbe implements ProcessIdentityProbe {
  constructor(private readonly answer: ProcessIdentityObservation) {}

  observe(pid: number): Promise<ProcessIdentityObservation> {
    return Promise.resolve(this.answer);
  }
}

/** A launcher that records every attempted spawn and always fails. */
class TrackingNeverLauncher implements ProcessLauncher {
  launchCount = 0;

  launch(
    _request: SupervisorSpawnRequest,
    _observer: ProcessLaunchObserver,
  ): Promise<SupervisedProcess> {
    this.launchCount += 1;
    return Promise.reject(new Error("The launcher refuses in this test"));
  }
}

describe("process-generation tokens", () => {
  it("mints generations with strictly increasing counters that never repeat", () => {
    const sequence = new ProcessGenerationSequence({ epoch: EPOCH });
    expect(sequence.current()).toBeUndefined();

    const first = sequence.bump();
    const second = sequence.bump();
    const third = sequence.bump();

    expect(first).toEqual({ epoch: EPOCH, counter: 1 });
    expect(second.counter).toBe(2);
    expect(third.counter).toBe(3);
    expect(sequence.current()).toEqual(third);
    expect(new Set([first.counter, second.counter, third.counter]).size).toBe(3);
  });

  it("serializes tokens to wire identifiers the durable record store accepts", () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-process-generation-"));
    try {
      const sequence = new ProcessGenerationSequence({ epoch: EPOCH });
      const id = formatProcessGenerationToken(sequence.bump());
      expect(id).toBe(`generation:${EPOCH}:1`);
      expect(id).toMatch(GENERATION_ID_RULE);
      expect(parseProcessGenerationToken(id)).toEqual({ epoch: EPOCH, counter: 1 });

      const records = new InstanceProcessRecordStore({ directory: join(root, "records") });
      const instanceId = "8f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
      records.write({
        schemaVersion: "dolly.instance-process-record/1",
        instanceId,
        processGenerationId: id,
        pid: 42,
        controllerId: EPOCH,
        configRevision: `sha256:${"c".repeat(64)}`,
        ipcSessionId: deriveIpcSessionId("session-material"),
        state: "running",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      } as InstanceProcessRecord);
      expect(records.read(instanceId)?.processGenerationId).toBe(id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats malformed tokens and identifiers written before tokens as non-tokens", () => {
    expect(parseProcessGenerationToken(undefined)).toBeUndefined();
    expect(parseProcessGenerationToken(42)).toBeUndefined();
    expect(parseProcessGenerationToken("")).toBeUndefined();
    expect(parseProcessGenerationToken("process-recovered-generation")).toBeUndefined();
    expect(parseProcessGenerationToken(`process-${"a".repeat(32)}`)).toBeUndefined();
    expect(parseProcessGenerationToken(`generation:${EPOCH}:0`)).toBeUndefined();
    expect(parseProcessGenerationToken(`generation:${EPOCH}`)).toBeUndefined();
    expect(parseProcessGenerationToken(`generation:${EPOCH}:a`)).toBeUndefined();
    expect(parseProcessGenerationToken(`generation::1`)).toBeUndefined();
    expect(parseProcessGenerationToken(`generation:${EPOCH}:1:2`)).toBeUndefined();
    // A counter beyond a safe integer is not a generation token.
    expect(parseProcessGenerationToken(`generation:${EPOCH}:99999999999999999999`)).toBeUndefined();
  });

  it("rejects an invalid epoch marker at construction and a malformed token at serialization", () => {
    expect(() => new ProcessGenerationSequence({ epoch: "epoch:with-colon" })).toThrowError(
      expect.objectContaining<Partial<ProcessGenerationError>>({
        code: "PROCESS_GENERATION_ID_INVALID",
      }),
    );
    expect(() => formatProcessGenerationToken({ epoch: EPOCH, counter: 0 })).toThrowError(
      expect.objectContaining<Partial<ProcessGenerationError>>({
        code: "PROCESS_GENERATION_ID_INVALID",
      }),
    );
  });

  it("refuses an action carrying a stale token", () => {
    const sequence = new ProcessGenerationSequence({ epoch: EPOCH });
    const first = sequence.bump();
    // The generation just minted is current, so an action carrying it passes.
    expect(() => sequence.guard(first)).not.toThrow();

    const second = sequence.bump();
    expect(() => sequence.guard(second)).not.toThrow();

    const third = sequence.bump();
    for (const stale of [first, second]) {
      expect(() => sequence.guard(stale)).toThrowError(
        expect.objectContaining<Partial<ProcessGenerationError>>({
          code: "PROCESS_GENERATION_STALE",
        }),
      );
      expect(() => sequence.guard(formatProcessGenerationToken(stale))).toThrowError(
        expect.objectContaining<Partial<ProcessGenerationError>>({
          code: "PROCESS_GENERATION_STALE",
        }),
      );
    }
    expect(() => sequence.guard(third)).not.toThrow();
  });

  it("keeps epochs isolated", () => {
    const sequence = new ProcessGenerationSequence({ epoch: EPOCH });
    sequence.bump();
    const other = new ProcessGenerationSequence({ epoch: "22222222-2222-4222-8222-222222222222" });
    const foreign = other.bump();

    expect(() => sequence.guard(foreign)).toThrowError(
      expect.objectContaining<Partial<ProcessGenerationError>>({
        code: "PROCESS_GENERATION_EPOCH_MISMATCH",
      }),
    );
    expect(() => sequence.guard(formatProcessGenerationToken(foreign))).toThrowError(
      expect.objectContaining<Partial<ProcessGenerationError>>({
        code: "PROCESS_GENERATION_EPOCH_MISMATCH",
      }),
    );
  });

  it("passes tokens that are not recognizable generation tokens", () => {
    const sequence = new ProcessGenerationSequence({ epoch: EPOCH });
    sequence.bump();
    sequence.bump();
    // Pre-token identifiers and malformed strings are not tokens; identity
    // evidence decides those instead of the token guard.
    expect(() => sequence.guard("process-recovered-generation")).not.toThrow();
    expect(() => sequence.guard(`generation:${EPOCH}:0`)).not.toThrow();
    // A same-epoch token this session never issued is refused, not guessed at.
    expect(() => sequence.guard(`generation:${EPOCH}:7`)).toThrowError(
      expect.objectContaining<Partial<ProcessGenerationError>>({
        code: "PROCESS_GENERATION_ID_INVALID",
      }),
    );
  });
});

describe("process-generation guard inside daemon ownership checks", () => {
  let root: string;
  let registry: TestInstanceRegistry;
  let records: InstanceProcessRecordStore;
  let managers: DaemonInstanceManager[] = [];

  afterEach(async () => {
    for (const manager of managers) await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
  });

  function createManager(
    launcher: ProcessLauncher,
    probe: ProcessIdentityProbe,
    overrides: Partial<DaemonInstanceManagerOptions> = {},
  ): DaemonInstanceManager {
    const manager = new DaemonInstanceManager({
      registryDirectory: registry.registryDirectory,
      processRecordDirectory: join(root, "process-records"),
      createLauncher: () => launcher,
      daemonProtocolVersion: "daemon-v1",
      ipcProtocolVersion: "ipc-v1",
      readinessEndpointPolicy: { mode: "none" },
      controllerId: EPOCH,
      identityProbe: probe,
      ...overrides,
    });
    managers.push(manager);
    return manager;
  }

  function seedRecord(
    instanceId: string,
    overrides: Partial<InstanceProcessRecord> = {},
  ): void {
    records.write({
      schemaVersion: "dolly.instance-process-record/1",
      instanceId,
      processGenerationId: `generation:${EPOCH}:5`,
      pid: 1234,
      controllerId: EPOCH,
      configRevision: `sha256:${"c".repeat(64)}`,
      ipcSessionId: deriveIpcSessionId("session-material"),
      state: "running",
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
      osIdentityToken: "recorded-identity-token",
      ...overrides,
    } as InstanceProcessRecord);
  }

  it("refuses a spawn and a stop when the record names a generation this epoch never issued", async () => {
    root = mkdtempSync(join(tmpdir(), "dolly-process-generation-"));
    registry = createTestInstanceRegistry(root);
    records = new InstanceProcessRecordStore({ directory: join(root, "process-records") });
    const instance = registry.register("unissued");
    seedRecord(instance.instanceId);
    const launcher = new TrackingNeverLauncher();
    const manager = createManager(
      launcher,
      new StubIdentityProbe({ kind: "identity", identityToken: "matching-identity-token" }),
    );

    // The guard runs before any identity probe or spawn, so the refusal is the
    // token error, not an identity verdict.
    await expect(
      manager.startInstance(instance.instanceId, "op-start-unissued"),
    ).rejects.toMatchObject({ code: "PROCESS_GENERATION_ID_INVALID" });
    expect(launcher.launchCount).toBe(0);
    await expect(
      manager.stopInstance(instance.instanceId, "op-stop-unissued"),
    ).rejects.toMatchObject({ code: "PROCESS_GENERATION_ID_INVALID" });
  });

  it("leaves pre-token and foreign records to the identity evidence unchanged", async () => {
    root = mkdtempSync(join(tmpdir(), "dolly-process-generation-"));
    registry = createTestInstanceRegistry(root);
    records = new InstanceProcessRecordStore({ directory: join(root, "process-records") });
    const instance = registry.register("legacy");
    seedRecord(instance.instanceId, {
      // Written before tokens existed: not a token, so nothing is refused here.
      processGenerationId: "process-recovered-generation",
    });

    const launcher = new TrackingNeverLauncher();
    const manager = createManager(
      launcher,
      new StubIdentityProbe({ kind: "identity", identityToken: "identity-of-a-different-process" }),
    );

    // The mismatch with the recorded identity proves the old child exited, so
    // the daemon clears the record and spawns a replacement. The token guard
    // must not have intercepted a non-token identifier.
    await expect(
      manager.startInstance(instance.instanceId, "op-start-legacy"),
    ).rejects.toBeInstanceOf(Error);
    expect(launcher.launchCount).toBe(1);
    expect(records.read(instance.instanceId)).toBeNull();
  });
});