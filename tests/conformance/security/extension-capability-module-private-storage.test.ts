import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExtensionCapabilityAuthority,
  type ExtensionCapabilityHandle,
  type ExtensionCapabilitySession,
  type ExtensionSessionIdentity,
} from "../../../src/core/extension-capability.js";
import {
  createModulePrivateStorageCapability,
  ModulePrivateStorageBackend,
  type ModulePrivateStorageLimits,
  type ModulePrivateStorageOperation,
} from "../../../src/core/capabilities/module-private-storage-capability.js";

const MODULE_A_IDENTITY: ExtensionSessionIdentity = {
  extensionId: "com.example.fixture",
  instanceId: "instance-a",
  processGenerationId: "process-generation-a",
  sessionId: "session-a",
  moduleId: "module-a",
  moduleGenerationId: "module-generation-a",
};
const MODULE_B_IDENTITY: ExtensionSessionIdentity = {
  ...MODULE_A_IDENTITY,
  sessionId: "session-b",
  processGenerationId: "process-generation-b",
  moduleId: "module-b",
  moduleGenerationId: "module-generation-b",
};
const ALL_OPERATIONS: readonly ModulePrivateStorageOperation[] = [
  "get",
  "set",
  "delete",
  "list",
];

const scratchRoots: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dolly-module-private-storage-"));
  scratchRoots.push(root);
  return root;
}

afterEach(() => {
  while (scratchRoots.length > 0) {
    rmSync(scratchRoots.pop()!, { recursive: true, force: true });
  }
});

function createBackend(root: string): ModulePrivateStorageBackend {
  let tick = 0;
  return new ModulePrivateStorageBackend({
    root,
    now: () => new Date(Date.UTC(2026, 6, 26, 0, 0, ++tick)).toISOString(),
  });
}

interface StorageHarness {
  readonly authority: ExtensionCapabilityAuthority;
  readonly session: ExtensionCapabilitySession;
  readonly handle: ExtensionCapabilityHandle;
  readonly clock: { wall: string };
  invoke(operation: string, argumentsValue: unknown): Promise<unknown>;
}

function createAuthority(clock: { wall: string }): ExtensionCapabilityAuthority {
  let handleSeed = 0;
  return new ExtensionCapabilityAuthority({
    now: () => clock.wall,
    nextHandle: () => Buffer.alloc(32, ++handleSeed).toString("base64url"),
  });
}

function issueStorage(
  authority: ExtensionCapabilityAuthority,
  session: ExtensionCapabilitySession,
  backend: ModulePrivateStorageBackend,
  options: {
    readonly moduleId: string;
    readonly instanceId?: string;
    readonly operations?: readonly ModulePrivateStorageOperation[];
    readonly limits?: Partial<ModulePrivateStorageLimits>;
  },
): ExtensionCapabilityHandle {
  const definition = createModulePrivateStorageCapability({
    backend,
    instanceId: options.instanceId ?? "instance-a",
    moduleId: options.moduleId,
    operations: options.operations ?? ALL_OPERATIONS,
    expiresAt: "2026-07-27T00:00:00.000Z",
    executionScope: { moduleJobId: "module-job-a", runId: "run-a" },
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  return session.issue(definition.grant, definition.handler);
}

function createHarness(
  backend: ModulePrivateStorageBackend,
  options: {
    readonly identity?: ExtensionSessionIdentity;
    readonly moduleId?: string;
    readonly operations?: readonly ModulePrivateStorageOperation[];
    readonly limits?: Partial<ModulePrivateStorageLimits>;
  } = {},
): StorageHarness {
  const clock = { wall: "2026-07-26T00:00:00.000Z" };
  const authority = createAuthority(clock);
  const identity = options.identity ?? MODULE_A_IDENTITY;
  const session = authority.openSession(identity);
  const handle = issueStorage(authority, session, backend, {
    moduleId: options.moduleId ?? identity.moduleId,
    ...(options.operations === undefined ? {} : { operations: options.operations }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  return {
    authority,
    session,
    handle,
    clock,
    invoke(operation, argumentsValue) {
      return session.invoke({
        handle,
        operation,
        arguments: argumentsValue as never,
        moduleJobId: "module-job-a",
        runId: "run-a",
      });
    },
  };
}

describe("Extension Module-private storage capability", () => {
  it("derives the namespace from the authenticated Module and isolates Modules", async () => {
    const root = createRoot();
    const backend = createBackend(root);
    const moduleA = createHarness(backend);
    const moduleB = createHarness(backend, {
      identity: MODULE_B_IDENTITY,
      moduleId: "module-b",
    });

    await moduleA.invoke("set", { key: "shared-key", value: { owner: "a" } });
    await moduleB.invoke("set", { key: "shared-key", value: { owner: "b" } });

    await expect(moduleA.invoke("get", { key: "shared-key" })).resolves.toMatchObject({
      found: true,
      value: { owner: "a" },
    });
    await expect(moduleB.invoke("get", { key: "shared-key" })).resolves.toMatchObject({
      found: true,
      value: { owner: "b" },
    });
    await expect(moduleA.invoke("list", {})).resolves.toMatchObject({
      keys: ["shared-key"],
      truncated: false,
    });

    expect(backend.namespaceFor("instance-a", "module-a")).not.toBe(
      backend.namespaceFor("instance-a", "module-b"),
    );
    expect(backend.namespaceFor("instance-a", "module-a")).not.toBe(
      backend.namespaceFor("instance-b", "module-a"),
    );
    // One document per namespace, named by the host, not by any caller text.
    expect(readdirSync(root).sort()).toEqual(
      [
        `${backend.namespaceFor("instance-a", "module-a")}.json`,
        `${backend.namespaceFor("instance-a", "module-b")}.json`,
      ].sort(),
    );
  });

  it("refuses a storage handle used inside another Module's session", async () => {
    const root = createRoot();
    const backend = createBackend(root);
    const clock = { wall: "2026-07-26T00:00:00.000Z" };
    const authority = createAuthority(clock);
    const foreignSession = authority.openSession(MODULE_B_IDENTITY);
    // A capability built for module-a, presented inside module-b's session.
    const handle = issueStorage(authority, foreignSession, backend, {
      moduleId: "module-a",
    });

    await expect(
      foreignSession.invoke({
        handle,
        operation: "get",
        arguments: { key: "shared-key" },
        moduleJobId: "module-job-a",
        runId: "run-a",
      }),
    ).rejects.toMatchObject({
      name: "ExtensionCapabilityError",
      code: "CAPABILITY_SCOPE_MISMATCH",
    });
    expect(readdirSync(root)).toEqual([]);
  });

  it("gives the extension no way to name or influence a namespace", async () => {
    const root = createRoot();
    const backend = createBackend(root);
    const harness = createHarness(backend);

    await expect(
      harness.invoke("set", {
        key: "k",
        value: 1,
        namespace: backend.namespaceFor("instance-a", "module-b"),
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
    for (const key of [
      "../../escape",
      "a/b",
      "a\\b",
      ".hidden",
      "",
      "key with space",
    ]) {
      await expect(harness.invoke("get", { key })).rejects.toMatchObject({
        code: "CAPABILITY_ARGUMENT_INVALID",
      });
    }
    await expect(harness.invoke("get", { key: 7 })).rejects.toMatchObject({
      code: "CAPABILITY_ARGUMENT_INVALID",
    });
    expect(readdirSync(root)).toEqual([]);
  });

  it("enforces key, value, entry-count, and total-byte limits", async () => {
    const root = createRoot();
    const backend = createBackend(root);
    const harness = createHarness(backend, {
      limits: {
        maxKeyBytes: 8,
        maxValueBytes: 64,
        maxEntries: 2,
        maxTotalBytes: 64,
      },
    });

    await expect(
      harness.invoke("set", { key: "k".repeat(9), value: 1 }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_QUOTA_EXCEEDED",
      details: { limit: "maxKeyBytes", allowed: 8 },
    });
    await expect(
      harness.invoke("set", { key: "k1", value: "v".repeat(70) }),
    ).rejects.toMatchObject({ details: { limit: "maxValueBytes", allowed: 64 } });

    await harness.invoke("set", { key: "k1", value: "a" });
    await harness.invoke("set", { key: "k2", value: "b" });
    await expect(harness.invoke("set", { key: "k3", value: "c" })).rejects.toMatchObject({
      details: { limit: "maxEntries", allowed: 2 },
    });
    // Replacing an existing key stays inside the entry limit but must still
    // respect the namespace byte ceiling.
    await expect(
      harness.invoke("set", { key: "k2", value: "b".repeat(60) }),
    ).rejects.toMatchObject({ details: { limit: "maxTotalBytes", allowed: 64 } });

    await expect(harness.invoke("list", {})).resolves.toMatchObject({
      keys: ["k1", "k2"],
    });
    await expect(harness.invoke("get", { key: "k2" })).resolves.toMatchObject({
      found: true,
      value: "b",
    });
  });

  it("commits every write atomically and stays readable from a new backend", async () => {
    const root = createRoot();
    const backend = createBackend(root);
    const harness = createHarness(backend);

    await harness.invoke("set", { key: "alpha", value: { n: 1 } });
    await harness.invoke("set", { key: "beta", value: [1, 2, 3] });
    await expect(harness.invoke("delete", { key: "alpha" })).resolves.toMatchObject({
      deleted: true,
      revision: 3,
    });
    await expect(harness.invoke("delete", { key: "alpha" })).resolves.toMatchObject({
      deleted: false,
      revision: 3,
    });

    const reopened = createHarness(createBackend(root));
    await expect(reopened.invoke("list", {})).resolves.toMatchObject({
      keys: ["beta"],
      truncated: false,
    });
    await expect(reopened.invoke("get", { key: "beta" })).resolves.toMatchObject({
      found: true,
      value: [1, 2, 3],
    });
  });

  it("recovers from an interrupted atomic replacement", async () => {
    const root = createRoot();
    const backend = createBackend(root);
    const harness = createHarness(backend);
    await harness.invoke("set", { key: "alpha", value: "committed" });

    const namespace = backend.namespaceFor("instance-a", "module-a");
    const committed = readFileSync(join(root, `${namespace}.json`), "utf8");
    // A crash can only ever leave a temporary file beside the document: one
    // half-written, and one that was complete but never renamed.
    const halfWritten = join(
      root,
      `.${namespace}.json.11111111-1111-4111-8111-111111111111.tmp`,
    );
    const completeButUncommitted = join(
      root,
      `.${namespace}.json.22222222-2222-4222-8222-222222222222.tmp`,
    );
    writeFileSync(halfWritten, committed.slice(0, Math.floor(committed.length / 2)), "utf8");
    writeFileSync(
      completeButUncommitted,
      committed.replace('"committed"', '"never-renamed"'),
      "utf8",
    );

    const reopened = createHarness(createBackend(root));
    await expect(reopened.invoke("get", { key: "alpha" })).resolves.toMatchObject({
      found: true,
      value: "committed",
    });
    expect(readdirSync(root)).toEqual([`${namespace}.json`]);

    await reopened.invoke("set", { key: "beta", value: "after-recovery" });
    await expect(reopened.invoke("list", {})).resolves.toMatchObject({
      keys: ["alpha", "beta"],
    });
  });

  it("fails closed on a tampered document instead of serving altered state", async () => {
    const root = createRoot();
    const backend = createBackend(root);
    const harness = createHarness(backend);
    await harness.invoke("set", { key: "alpha", value: "original" });

    const namespace = backend.namespaceFor("instance-a", "module-a");
    const path = join(root, `${namespace}.json`);
    writeFileSync(path, readFileSync(path, "utf8").replace('"original"', '"tampered"'), "utf8");

    const reopened = createHarness(createBackend(root));
    await expect(reopened.invoke("get", { key: "alpha" })).rejects.toMatchObject({
      code: "CAPABILITY_DEPENDENCY_FAILED",
    });
  });

  it("refuses a document that was moved into another Module's namespace", async () => {
    const root = createRoot();
    const backend = createBackend(root);
    const moduleA = createHarness(backend);
    await moduleA.invoke("set", { key: "alpha", value: "module-a-secret" });

    const namespaceA = backend.namespaceFor("instance-a", "module-a");
    const namespaceB = backend.namespaceFor("instance-a", "module-b");
    writeFileSync(
      join(root, `${namespaceB}.json`),
      readFileSync(join(root, `${namespaceA}.json`), "utf8"),
      "utf8",
    );

    const moduleB = createHarness(createBackend(root), {
      identity: MODULE_B_IDENTITY,
      moduleId: "module-b",
    });
    await expect(moduleB.invoke("get", { key: "alpha" })).rejects.toMatchObject({
      code: "CAPABILITY_DEPENDENCY_FAILED",
    });
  });

  it("fails closed when another writer replaced the document", async () => {
    const root = createRoot();
    const first = createHarness(createBackend(root));
    await first.invoke("set", { key: "alpha", value: 1 });

    const second = createHarness(createBackend(root));
    await second.invoke("set", { key: "beta", value: 2 });

    await expect(first.invoke("set", { key: "gamma", value: 3 })).rejects.toMatchObject({
      code: "CAPABILITY_DEPENDENCY_FAILED",
    });
    const reopened = createHarness(createBackend(root));
    await expect(reopened.invoke("list", {})).resolves.toMatchObject({
      keys: ["alpha", "beta"],
    });
  });

  it("keeps read, write, and delete as separate grants", async () => {
    const root = createRoot();
    const backend = createBackend(root);
    const readOnly = createHarness(backend, { operations: ["get", "list"] });

    await expect(readOnly.invoke("set", { key: "alpha", value: 1 })).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
    });
    await expect(readOnly.invoke("delete", { key: "alpha" })).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
    });
    await expect(readOnly.invoke("get", { key: "alpha" })).resolves.toMatchObject({
      found: false,
    });
    expect(readdirSync(root)).toEqual([]);
  });

  it("denies a revoked capability, an expired grant, and a cross-session handle", async () => {
    const root = createRoot();
    const backend = createBackend(root);
    const harness = createHarness(backend);
    await harness.invoke("set", { key: "alpha", value: 1 });

    const foreign = harness.authority.openSession({
      ...MODULE_A_IDENTITY,
      sessionId: "session-foreign",
      processGenerationId: "process-generation-foreign",
    });
    await expect(
      foreign.invoke({
        handle: harness.handle,
        operation: "get",
        arguments: { key: "alpha" },
        moduleJobId: "module-job-a",
        runId: "run-a",
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });

    harness.clock.wall = "2026-07-28T00:00:00.000Z";
    await expect(harness.invoke("get", { key: "alpha" })).rejects.toMatchObject({
      code: "CAPABILITY_EXPIRED",
    });

    harness.clock.wall = "2026-07-26T00:00:00.000Z";
    expect(harness.session.revoke(harness.handle)).toBe("revoked");
    await expect(harness.invoke("get", { key: "alpha" })).rejects.toMatchObject({
      code: "CAPABILITY_REVOKED",
    });

    await harness.session.close();
    await expect(harness.invoke("get", { key: "alpha" })).rejects.toMatchObject({
      code: "CAPABILITY_SESSION_CLOSED",
    });
  });

  it("rejects a Module job identifier that does not match the grant", async () => {
    const root = createRoot();
    const backend = createBackend(root);
    const harness = createHarness(backend);

    await expect(
      harness.session.invoke({
        handle: harness.handle,
        operation: "set",
        arguments: { key: "alpha", value: 1 },
        moduleJobId: "module-job-b",
        runId: "run-a",
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_SCOPE_MISMATCH" });
    expect(readdirSync(root)).toEqual([]);
  });

  it("paginates a list explicitly rather than truncating silently", async () => {
    const root = createRoot();
    const backend = createBackend(root);
    const harness = createHarness(backend, { limits: { maxListResults: 2 } });
    for (const key of ["k1", "k2", "k3"]) {
      await harness.invoke("set", { key, value: key });
    }

    const first = (await harness.invoke("list", { limit: 2 })) as {
      keys: string[];
      truncated: boolean;
      nextAfter?: string;
    };
    expect(first).toMatchObject({ keys: ["k1", "k2"], truncated: true, nextAfter: "k2" });
    await expect(harness.invoke("list", { after: first.nextAfter })).resolves.toMatchObject({
      keys: ["k3"],
      truncated: false,
    });
    await expect(harness.invoke("list", { limit: 3 })).rejects.toMatchObject({
      code: "CAPABILITY_QUOTA_EXCEEDED",
      details: { limit: "limit", allowed: 2 },
    });
  });
});
