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

/** An identity probe that counts observations so zero-activity is provable. */
class CountingIdentityProbe implements ProcessIdentityProbe {
  observeCount = 0;

  constructor(private readonly answer: ProcessIdentityObservation) {}

  observe(pid: number): Promise<ProcessIdentityObservation> {
    this.observeCount += 1;
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

  it("parses the safe-integer counter boundary exactly", () => {
    // The largest safe integer is a legal counter; one more is not a token.
    const max = Number.MAX_SAFE_INTEGER;
    expect(max).toBe(9007199254740991);
    const boundaryToken = `generation:${EPOCH}:${max}`;
    expect(boundaryToken).toMatch(GENERATION_ID_RULE);
    expect(parseProcessGenerationToken(boundaryToken)).toEqual({ epoch: EPOCH, counter: max });
    expect(parseProcessGenerationToken(`generation:${EPOCH}:${max + 1}`)).toBeUndefined();

    // The boundary value is a genuine counter for the guard, not a malformed
    // string: an unissued boundary generation is refused as unissued.
    const sequence = new ProcessGenerationSequence({ epoch: EPOCH });
    sequence.bump();
    expect(() => sequence.guard(boundaryToken)).toThrowError(
      expect.objectContaining<Partial<ProcessGenerationError>>({
        code: "PROCESS_GENERATION_ID_INVALID",
      }),
    );
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

  it("leaves a foreign-epoch token to the identity evidence at the manager level", async () => {
    root = mkdtempSync(join(tmpdir(), "dolly-process-generation-"));
    registry = createTestInstanceRegistry(root);
    records = new InstanceProcessRecordStore({ directory: join(root, "process-records") });
    const instance = registry.register("foreign-token");
    seedRecord(instance.instanceId, {
      processGenerationId: "generation:22222222-2222-4222-8222-222222222222:3",
    });

    const launcher = new TrackingNeverLauncher();
    const manager = createManager(
      launcher,
      new StubIdentityProbe({ kind: "identity", identityToken: "identity-of-a-different-process" }),
    );

    // A token from another epoch is never this session's business: the guard
    // skips it, the identity evidence decides, and a replacement spawn is
    // attempted. The rejection is the launcher failure, not a token error.
    const error = await manager
      .startInstance(instance.instanceId, "op-start-foreign-token")
      .then(
        () => null,
        (failure) => failure as Error,
      );
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).not.toMatch(/^PROCESS_GENERATION_/);
    expect(launcher.launchCount).toBe(1);
    expect(records.read(instance.instanceId)).toBeNull();
  });

  it("passes the same-epoch generation this manager currently holds", async () => {
    root = mkdtempSync(join(tmpdir(), "dolly-process-generation-"));
    registry = createTestInstanceRegistry(root);
    records = new InstanceProcessRecordStore({ directory: join(root, "process-records") });
    const launcher = new TrackingNeverLauncher();
    const manager = createManager(
      launcher,
      // Matches the recorded operating-system identity, proving the child live.
      new StubIdentityProbe({ kind: "identity", identityToken: "recorded-identity-token" }),
    );

    // This session's first start mints generation EPOCH:1 even though the
    // launcher then fails, so the manager's current generation is EPOCH:1.
    const minted = registry.register("minted");
    await expect(manager.startInstance(minted.instanceId, "op-start-minted")).rejects.toBeInstanceOf(
      Error,
    );
    expect(launcher.launchCount).toBe(1);

    const sameCurrent = registry.register("same-current");
    seedRecord(sameCurrent.instanceId, { processGenerationId: `generation:${EPOCH}:1` });
    // The record names the current generation, so the guard passes and the
    // identity evidence decides: the recorded child is still running, so no
    // replacement spawn is started. This is an ownership refusal, not a token
    // error.
    await expect(
      manager.startInstance(sameCurrent.instanceId, "op-start-same-current"),
    ).rejects.toMatchObject({ code: "DAEMON_INSTANCE_ORPHAN_UNRESOLVED" });
    expect(launcher.launchCount).toBe(1);
  });

  it("fails closed on a same-epoch generation one step older than the current one", async () => {
    root = mkdtempSync(join(tmpdir(), "dolly-process-generation-"));
    registry = createTestInstanceRegistry(root);
    records = new InstanceProcessRecordStore({ directory: join(root, "process-records") });
    const launcher = new TrackingNeverLauncher();
    const manager = createManager(
      launcher,
      // Even a matching identity must never be reached for a stale token.
      new StubIdentityProbe({ kind: "identity", identityToken: "recorded-identity-token" }),
    );

    // Two failed starts mint EPOCH:1 then EPOCH:2, so EPOCH:1 is now stale.
    const first = registry.register("gen-one");
    await expect(manager.startInstance(first.instanceId, "op-gen-one")).rejects.toBeInstanceOf(Error);
    const second = registry.register("gen-two");
    await expect(manager.startInstance(second.instanceId, "op-gen-two")).rejects.toBeInstanceOf(Error);
    expect(launcher.launchCount).toBe(2);

    const stale = registry.register("stale-generation");
    seedRecord(stale.instanceId, { processGenerationId: `generation:${EPOCH}:1` });
    await expect(
      manager.startInstance(stale.instanceId, "op-start-stale"),
    ).rejects.toMatchObject({ code: "PROCESS_GENERATION_STALE" });
    expect(launcher.launchCount).toBe(2);
  });

  it("refuses a stop of a persisted record naming a stale same-epoch generation", async () => {
    root = mkdtempSync(join(tmpdir(), "dolly-process-generation-"));
    registry = createTestInstanceRegistry(root);
    records = new InstanceProcessRecordStore({ directory: join(root, "process-records") });
    const launcher = new TrackingNeverLauncher();
    const probe = new CountingIdentityProbe({ kind: "identity", identityToken: "recorded-identity-token" });
    const manager = createManager(launcher, probe);

    // Two failed starts mint EPOCH:1 then EPOCH:2, so EPOCH:1 is now stale.
    const first = registry.register("gen-one");
    await expect(manager.startInstance(first.instanceId, "op-gen-one")).rejects.toBeInstanceOf(Error);
    const second = registry.register("gen-two");
    await expect(manager.startInstance(second.instanceId, "op-gen-two")).rejects.toBeInstanceOf(Error);
    expect(launcher.launchCount).toBe(2);

    // The persisted record names EPOCH:1 while the manager's current
    // authenticated generation is EPOCH:2. The stop is refused by the token
    // guard before any launcher, spawn, signal, or identity probe, even though
    // the recorded identity would have matched.
    const stopped = registry.register("stale-stop");
    seedRecord(stopped.instanceId, { processGenerationId: `generation:${EPOCH}:1` });
    await expect(
      manager.stopInstance(stopped.instanceId, "op-stop-stale"),
    ).rejects.toMatchObject({ code: "PROCESS_GENERATION_STALE" });
    expect(launcher.launchCount).toBe(2);
    expect(probe.observeCount).toBe(0);
    // The refusal left the durable record untouched; no clear or stale-mark
    // followed the refusal.
    expect(records.read(stopped.instanceId)?.processGenerationId).toBe(`generation:${EPOCH}:1`);
  });

  it("makes two managers sharing one controllerId refuse same-epoch ownership each did not issue", async () => {
    root = mkdtempSync(join(tmpdir(), "dolly-process-generation-"));
    registry = createTestInstanceRegistry(root);
    records = new InstanceProcessRecordStore({ directory: join(root, "process-records") });

    // Manager A's session issues EPOCH:1 for this controllerId.
    const launcherA = new TrackingNeverLauncher();
    const managerA = createManager(
      launcherA,
      new StubIdentityProbe({ kind: "identity", identityToken: "never-reached" }),
    );
    const mintedByA = registry.register("issued-by-a");
    await expect(managerA.startInstance(mintedByA.instanceId, "op-a-mints")).rejects.toBeInstanceOf(
      Error,
    );
    expect(launcherA.launchCount).toBe(1);

    // Manager B declares the same controllerId but has issued nothing yet.
    const launcherB = new TrackingNeverLauncher();
    const managerB = createManager(
      launcherB,
      new StubIdentityProbe({ kind: "identity", identityToken: "never-reached" }),
    );

    // B refuses the generation A issued: the counter is neither stale nor
    // current for B's session, so it counts as never issued by B.
    const fromA = registry.register("from-a");
    seedRecord(fromA.instanceId, { processGenerationId: `generation:${EPOCH}:1` });
    await expect(managerB.startInstance(fromA.instanceId, "op-b-refuses-a")).rejects.toMatchObject({
      code: "PROCESS_GENERATION_ID_INVALID",
    });
    expect(launcherB.launchCount).toBe(0);

    // Both sessions refuse a same-epoch counter neither of them issued.
    const unissued = registry.register("unissued-by-both");
    seedRecord(unissued.instanceId, { processGenerationId: `generation:${EPOCH}:9` });
    await expect(managerA.startInstance(unissued.instanceId, "op-a-refuses-unissued")).rejects.toMatchObject(
      { code: "PROCESS_GENERATION_ID_INVALID" },
    );
    await expect(managerB.startInstance(unissued.instanceId, "op-b-refuses-unissued")).rejects.toMatchObject(
      { code: "PROCESS_GENERATION_ID_INVALID" },
    );
    expect(launcherA.launchCount).toBe(1);
    expect(launcherB.launchCount).toBe(0);
  });
});