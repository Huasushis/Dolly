import { describe, expect, it, vi } from "vitest";
import {
  ExtensionCapabilityAuthority,
  type ExtensionCapabilityGrant,
  type ExtensionSessionIdentity,
} from "../../../src/core/extension-capability.js";

const NOW = "2026-07-24T00:00:00.000Z";

function identity(sessionId: string, generation = "process-generation-1"): ExtensionSessionIdentity {
  return {
    extensionId: "com.example.extension",
    instanceId: "instance-a",
    processGenerationId: generation,
    sessionId,
    moduleId: "module-a",
    moduleGenerationId: `module-${generation}`,
  };
}

function grant(overrides: Partial<ExtensionCapabilityGrant> = {}): ExtensionCapabilityGrant {
  return {
    capabilityType: "private-storage",
    capabilityVersion: "v1",
    operations: ["read"],
    resourceScope: { namespace: "module-a" },
    expiresAt: "2026-07-24T01:00:00.000Z",
    maxInvocations: 4,
    maxConcurrentInvocations: 1,
    maxArgumentBytes: 256,
    maxResultBytes: 256,
    ...overrides,
  };
}

function authority(now: () => string = () => NOW) {
  let token = 0;
  return new ExtensionCapabilityAuthority({
    now,
    nextHandle: () => Buffer.alloc(32, ++token).toString("base64url"),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("extension capability session authority", () => {
  it("passes only an immutable declared scope to an explicitly granted operation", async () => {
    const broker = authority();
    const session = broker.openSession(identity("session-a"));
    const handler = vi.fn(async (argumentsValue, context) => {
      expect(Object.isFrozen(argumentsValue)).toBe(true);
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.resourceScope)).toBe(true);
      expect(context.signal).toBeInstanceOf(AbortSignal);
      expect(context.signal.aborted).toBe(false);
      expect(context).toMatchObject({
        capabilityType: "private-storage",
        operation: "read",
        resourceScope: { namespace: "module-a" },
        identity: { sessionId: "session-a", moduleId: "module-a" },
      });
      return { value: "bounded-result" };
    });
    const handle = session.issue(grant(), handler);

    await expect(
      session.invoke({ handle, operation: "read", arguments: { key: "one" } }),
    ).resolves.toEqual({ value: "bounded-result" });
    await expect(
      session.invoke({ handle, operation: "delete", arguments: { key: "one" } }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("denies forged, cross-session, closed-session, and reused session identities", async () => {
    const broker = authority();
    const first = broker.openSession(identity("session-a"));
    const second = broker.openSession(identity("session-b", "process-generation-2"));
    const handle = first.issue(grant(), async () => ({ ok: true }));

    await expect(
      second.invoke({ handle, operation: "read", arguments: {} }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    await expect(
      first.invoke({
        handle: {
          schemaVersion: "dolly.capability-handle/1",
          handle: Buffer.alloc(32, 99).toString("base64url"),
        },
        operation: "read",
        arguments: {},
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });

    await first.close();
    await expect(
      first.invoke({ handle, operation: "read", arguments: {} }),
    ).rejects.toMatchObject({ code: "CAPABILITY_SESSION_CLOSED" });
    expect(() => broker.openSession(identity("session-a", "process-generation-3"))).toThrowError(
      expect.objectContaining({ code: "CAPABILITY_SESSION_CONFLICT" }),
    );
  });

  it("binds execution-scoped handles to the exact Module job and Run", async () => {
    const broker = authority();
    const session = broker.openSession(identity("session-a"));
    const handle = session.issue(
      grant({
        executionScope: { moduleJobId: "module-job-a", runId: "run-a" },
      }),
      async () => ({ ok: true }),
    );

    await expect(
      session.invoke({
        handle,
        operation: "read",
        arguments: {},
        moduleJobId: "module-job-a",
        runId: "run-b",
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_SCOPE_MISMATCH" });
    await expect(
      session.invoke({
        handle,
        operation: "read",
        arguments: {},
        moduleJobId: "module-job-a",
        runId: "run-a",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("aborts every in-flight handler and drains them before idempotent close completes", async () => {
    const broker = authority();
    const session = broker.openSession(identity("session-a"));
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const finishFirst = deferred<{ value: string }>();
    const finishSecond = deferred<{ value: string }>();
    const signals: AbortSignal[] = [];
    const firstHandle = session.issue(grant(), async (_argumentsValue, context) => {
      signals.push(context.signal);
      firstStarted.resolve();
      return finishFirst.promise;
    });
    const secondHandle = session.issue(grant(), async (_argumentsValue, context) => {
      signals.push(context.signal);
      secondStarted.resolve();
      return finishSecond.promise;
    });
    const firstInvocation = session.invoke({
      handle: firstHandle,
      operation: "read",
      arguments: {},
    });
    const secondInvocation = session.invoke({
      handle: secondHandle,
      operation: "read",
      arguments: {},
    });
    await Promise.all([firstStarted.promise, secondStarted.promise]);

    const close = session.close();
    expect(session.close()).toBe(close);
    expect(broker.close(session)).toBe(close);
    expect(session.closed).toBe(true);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    let closeCompleted = false;
    void close.then(() => {
      closeCompleted = true;
    });
    await Promise.resolve();
    expect(closeCompleted).toBe(false);
    await expect(
      session.invoke({ handle: firstHandle, operation: "read", arguments: {} }),
    ).rejects.toMatchObject({ code: "CAPABILITY_SESSION_CLOSED" });

    finishFirst.resolve({ value: "first" });
    await expect(firstInvocation).rejects.toMatchObject({ code: "CAPABILITY_REVOKED" });
    await Promise.resolve();
    expect(closeCompleted).toBe(false);

    finishSecond.resolve({ value: "second" });
    await expect(secondInvocation).rejects.toMatchObject({ code: "CAPABILITY_REVOKED" });
    await expect(close).resolves.toBeUndefined();
    expect(closeCompleted).toBe(true);
    expect(session.close()).toBe(close);
  });

  it("does not start a handler after close has revoked its queued invocation", async () => {
    const broker = authority();
    const session = broker.openSession(identity("session-a"));
    const handler = vi.fn(async () => ({ ok: true }));
    const handle = session.issue(grant(), handler);

    const invocation = session.invoke({ handle, operation: "read", arguments: {} });
    const close = session.close();

    await expect(invocation).rejects.toMatchObject({ code: "CAPABILITY_REVOKED" });
    await expect(close).resolves.toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it("enforces expiry, argument, result, concurrency, and invocation limits", async () => {
    let current = NOW;
    const broker = authority(() => current);
    const session = broker.openSession(identity("session-a"));
    const pending = deferred<{ ok: boolean }>();
    const handle = session.issue(
      grant({ maxInvocations: 2, maxArgumentBytes: 24, maxResultBytes: 24 }),
      async ({ key }) => {
        if (key === "pending") return pending.promise;
        return { ok: true };
      },
    );

    const first = session.invoke({ handle, operation: "read", arguments: { key: "pending" } });
    await expect(
      session.invoke({ handle, operation: "read", arguments: { key: "second" } }),
    ).rejects.toMatchObject({ code: "CAPABILITY_QUOTA_EXCEEDED" });
    pending.resolve({ ok: true });
    await expect(first).resolves.toEqual({ ok: true });
    await expect(
      session.invoke({ handle, operation: "read", arguments: { key: "x".repeat(64) } }),
    ).rejects.toMatchObject({ code: "CAPABILITY_QUOTA_EXCEEDED" });
    await expect(
      session.invoke({ handle, operation: "read", arguments: { key: "final" } }),
    ).resolves.toEqual({ ok: true });
    await expect(
      session.invoke({ handle, operation: "read", arguments: {} }),
    ).rejects.toMatchObject({ code: "CAPABILITY_QUOTA_EXCEEDED" });

    const oversized = session.issue(
      grant({ maxResultBytes: 8 }),
      async () => ({ value: "too large" }),
    );
    await expect(
      session.invoke({ handle: oversized, operation: "read", arguments: {} }),
    ).rejects.toMatchObject({ code: "CAPABILITY_QUOTA_EXCEEDED" });

    const expiring = session.issue(
      grant({ expiresAt: "2026-07-24T00:01:00.000Z" }),
      async () => ({ ok: true }),
    );
    current = "2026-07-24T00:01:00.000Z";
    await expect(
      session.invoke({ handle: expiring, operation: "read", arguments: {} }),
    ).rejects.toMatchObject({ code: "CAPABILITY_EXPIRED" });
  });

  it("deduplicates stable effect keys and rejects conflicting reuse", async () => {
    const broker = authority();
    const session = broker.openSession(identity("session-a"));
    const handler = vi.fn(async (argumentsValue) => ({ echoed: argumentsValue }));
    const handle = session.issue(
      grant({ requireIdempotencyKey: true }),
      handler,
    );
    const invocation = {
      handle,
      operation: "read",
      arguments: { key: "one" },
      idempotencyKey: "effect-one",
    } as const;

    const [first, repeated] = await Promise.all([
      session.invoke(invocation),
      session.invoke(invocation),
    ]);
    expect(first).toEqual(repeated);
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(
      session.invoke({ ...invocation, arguments: { key: "different" } }),
    ).rejects.toMatchObject({ code: "CAPABILITY_SCOPE_MISMATCH" });
  });

  it("revokes in-flight observability and sanitizes dependency failures", async () => {
    const broker = authority();
    const session = broker.openSession(identity("session-a"));
    const pending = deferred<{ secret: string }>();
    const handle = session.issue(grant(), async () => pending.promise);
    const invocation = session.invoke({ handle, operation: "read", arguments: {} });
    const close = session.close();
    pending.resolve({ secret: "must-not-cross-session" });
    await expect(invocation).rejects.toMatchObject({ code: "CAPABILITY_REVOKED" });
    await expect(close).resolves.toBeUndefined();

    const other = broker.openSession(identity("session-b", "process-generation-2"));
    const failing = other.issue(grant(), async () => {
      throw new Error("provider leaked bearer super-secret");
    });
    const failure = await other
      .invoke({ handle: failing, operation: "read", arguments: {} })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "CAPABILITY_DEPENDENCY_FAILED",
      message: "Capability broker dependency failed",
    });
    expect(JSON.stringify(failure)).not.toContain("super-secret");
  });
});
