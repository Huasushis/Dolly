import { describe, expect, it } from "vitest";
import {
  ExtensionCapabilityAuthority,
  type ExtensionCapabilityHandle,
  type ExtensionSessionIdentity,
} from "../../../src/core/extension-capability.js";
import {
  createStructuredLogCapability,
  type ExtensionStructuredLogRecord,
  type StructuredLogCapabilityLimits,
  type StructuredLogCapabilityOptions,
} from "../../../src/core/capabilities/structured-log-capability.js";

const IDENTITY: ExtensionSessionIdentity = {
  extensionId: "com.example.fixture",
  instanceId: "instance-a",
  processGenerationId: "process-generation-a",
  sessionId: "session-a",
  moduleId: "module-a",
  moduleGenerationId: "module-generation-a",
};
const EXECUTION_SCOPE = { moduleJobId: "module-job-a", runId: "run-a" } as const;
const CORRELATION_KEY = Buffer.from("dolly-structured-log-test-key-000", "utf8");

function createSink() {
  const records: ExtensionStructuredLogRecord[] = [];
  return {
    records,
    append(record: ExtensionStructuredLogRecord) {
      records.push(record);
    },
  };
}

interface Harness {
  readonly authority: ExtensionCapabilityAuthority;
  readonly session: ReturnType<ExtensionCapabilityAuthority["openSession"]>;
  readonly handle: ExtensionCapabilityHandle;
  readonly sink: ReturnType<typeof createSink>;
  readonly clock: { wall: string; monotonic: number };
  append(argumentsValue: unknown, overrides?: Record<string, unknown>): Promise<unknown>;
}

function createHarness(
  options: {
    readonly limits?: Partial<StructuredLogCapabilityLimits>;
    readonly identity?: ExtensionSessionIdentity;
    readonly capabilityOverrides?: Partial<StructuredLogCapabilityOptions>;
  } = {},
): Harness {
  const clock = { wall: "2026-07-26T00:00:00.000Z", monotonic: 1_000 };
  let handleSeed = 0;
  const authority = new ExtensionCapabilityAuthority({
    now: () => clock.wall,
    nextHandle: () => Buffer.alloc(32, ++handleSeed).toString("base64url"),
  });
  const session = authority.openSession(options.identity ?? IDENTITY);
  const sink = createSink();
  const definition = createStructuredLogCapability({
    sink,
    now: () => clock.wall,
    monotonicNow: () => clock.monotonic,
    expiresAt: "2026-07-27T00:00:00.000Z",
    executionScope: EXECUTION_SCOPE,
    redaction: { correlationKey: CORRELATION_KEY },
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.capabilityOverrides ?? {}),
  } as StructuredLogCapabilityOptions);
  const handle = session.issue(definition.grant, definition.handler);
  return {
    authority,
    session,
    handle,
    sink,
    clock,
    append(argumentsValue, overrides = {}) {
      return session.invoke({
        handle,
        operation: "append",
        arguments: argumentsValue as never,
        moduleJobId: EXECUTION_SCOPE.moduleJobId,
        runId: EXECUTION_SCOPE.runId,
        ...overrides,
      });
    },
  };
}

describe("Extension structured logging capability", () => {
  it("stamps origin from the authenticated session, never from the request", async () => {
    const harness = createHarness();

    await harness.append({
      level: "info",
      event: "module.progress",
      message: "halfway",
      attributes: {
        moduleId: "module-b",
        runId: "run-forged",
        instanceId: "instance-z",
      },
    });

    expect(harness.sink.records).toHaveLength(1);
    const record = harness.sink.records[0]!;
    expect(record.origin).toEqual({
      extensionId: "com.example.fixture",
      instanceId: "instance-a",
      processGenerationId: "process-generation-a",
      sessionId: "session-a",
      moduleId: "module-a",
      moduleGenerationId: "module-generation-a",
      moduleJobId: "module-job-a",
      runId: "run-a",
    });
    // The extension's own values survive only as nested, clearly separated
    // attributes; they never reach the origin block.
    expect(record.attributes).toEqual({
      moduleId: "module-b",
      runId: "run-forged",
      instanceId: "instance-z",
    });
    expect(record.recordedAt).toBe("2026-07-26T00:00:00.000Z");
    expect(record.sequence).toBe(1);
  });

  it("rejects a Module job identifier that does not match the grant", async () => {
    const harness = createHarness();

    await expect(
      harness.append(
        { level: "info", event: "module.progress" },
        { moduleJobId: "module-job-b" },
      ),
    ).rejects.toMatchObject({
      name: "ExtensionCapabilityError",
      code: "CAPABILITY_SCOPE_MISMATCH",
    });
    await expect(
      harness.append({ level: "info", event: "module.progress" }, { runId: "run-b" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_SCOPE_MISMATCH" });
    expect(harness.sink.records).toHaveLength(0);
  });

  it("refuses a log record with no Run identity at all", async () => {
    const clock = { wall: "2026-07-26T00:00:00.000Z" };
    let handleSeed = 0;
    const authority = new ExtensionCapabilityAuthority({
      now: () => clock.wall,
      nextHandle: () => Buffer.alloc(32, ++handleSeed).toString("base64url"),
    });
    const session = authority.openSession(IDENTITY);
    const sink = createSink();
    const definition = createStructuredLogCapability({
      sink,
      now: () => clock.wall,
      expiresAt: "2026-07-27T00:00:00.000Z",
    });
    const handle = session.issue(definition.grant, definition.handler);

    await expect(
      session.invoke({
        handle,
        operation: "append",
        arguments: { level: "info", event: "module.progress" },
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_SCOPE_MISMATCH" });
    expect(sink.records).toHaveLength(0);
  });

  it("cannot forge a second record or a host field through injected text", async () => {
    const harness = createHarness();

    await harness.append({
      level: "info",
      event: "module.progress",
      message:
        'done\nlevel=error event=host.compromised moduleId=module-b\r{"origin":{"moduleId":"module-b"}}',
      attributes: { detail: "tail head\tsplit" },
    });

    expect(harness.sink.records).toHaveLength(1);
    const record = harness.sink.records[0]!;
    expect(record.level).toBe("info");
    expect(record.event).toBe("module.progress");
    expect(record.origin.moduleId).toBe("module-a");
    expect(record.message).not.toContain("\n");
    expect(record.message).not.toContain("\r");
    expect(record.message).toContain("\\n");
    expect(record.message).toContain("\\r");
    expect(record.attributes.detail).toBe("tail\\u2028head\\tsplit");
  });

  it("rejects unknown fields, unsafe attribute names, and nested attribute values", async () => {
    const harness = createHarness();

    await expect(
      harness.append({
        level: "info",
        event: "module.progress",
        moduleJobId: "module-job-b",
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
    await expect(
      harness.append({ level: "critical", event: "module.progress" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
    await expect(
      harness.append({ level: "info", event: "Module Progress" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
    await expect(
      harness.append({
        level: "info",
        event: "module.progress",
        attributes: { "detail\nlevel": "x" },
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
    // Arguments arrive as parsed JSON, where `__proto__` is an ordinary own
    // key rather than a prototype assignment.
    await expect(
      harness.append({
        level: "info",
        event: "module.progress",
        attributes: JSON.parse('{"__proto__":"x"}'),
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
    await expect(
      harness.append({
        level: "info",
        event: "module.progress",
        attributes: { detail: { nested: true } },
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
    expect(harness.sink.records).toHaveLength(0);
  });

  it("redacts credential shapes that no literal field-name list would catch", async () => {
    const harness = createHarness({ limits: { maxMessageBytes: 4_096 } });
    const accessKey = "AKIAIOSFODNN7EXAMPLE";
    const signature =
      "1f2e3d4c5b6a79880f1e2d3c4b5a69780f1e2d3c4b5a69788f1e2d3c4b5a6978";
    const jsonWebToken =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXkw";
    const capabilityHandle = Buffer.alloc(32, 9).toString("base64url");

    await harness.append({
      level: "warn",
      event: "upload.finished",
      message: `stored at https://media.example.com/object.png?X-Amz-Signature=${signature}&X-Amz-Expires=900`,
      attributes: {
        // Innocuous names on purpose: nothing here is on a credential name list.
        note: accessKey,
        friendlyRemark: `Bearer ${jsonWebToken}`,
        breadcrumb: capabilityHandle,
        password: "hi",
        digest:
          "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        moduleName: "com.example.fixture",
      },
    });

    const record = harness.sink.records[0]!;
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(accessKey);
    expect(serialized).not.toContain(signature);
    expect(serialized).not.toContain(jsonWebToken);
    expect(serialized).not.toContain(capabilityHandle);
    expect(record.attributes.note).toMatch(/^\[redacted:token:[0-9a-f]{12}]$/);
    expect(record.attributes.friendlyRemark).toMatch(/^Bearer \[redacted:auth:[0-9a-f]{12}]$/);
    expect(record.attributes.breadcrumb).toMatch(/^\[redacted:handle:[0-9a-f]{12}]$/);
    expect(record.redactions).toBe(4);

    // Redaction follows shape, so a credential-sounding name with a harmless
    // value survives while an innocuous name with credential shape does not.
    expect(record.attributes.password).toBe("hi");
    expect(record.attributes.moduleName).toBe("com.example.fixture");
    expect(record.attributes.digest).toBe(
      "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    );
    // The surrounding message stays readable: only the signature value went.
    expect(record.message).toContain("https://media.example.com/object.png");
    expect(record.message).toContain("X-Amz-Signature=[redacted:token:");
    expect(record.message).toContain("X-Amz-Expires=900");
  });

  it("redacts a credential smuggled into the event name", async () => {
    const harness = createHarness();
    const smuggled = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4";

    await harness.append({ level: "info", event: `upload.${smuggled}` });
    await harness.append({ level: "info", event: "upload.finished" });

    expect(harness.sink.records[0]!.event).toMatch(/^\[redacted:token:[0-9a-f]{12}]$/);
    expect(harness.sink.records[0]!.redactions).toBe(1);
    expect(harness.sink.records[1]!.event).toBe("upload.finished");
    expect(harness.sink.records[1]!.redactions).toBe(0);
  });

  it("gives the same redaction marker to the same secret and different markers to different secrets", async () => {
    const harness = createHarness();
    const first = "AKIAIOSFODNN7EXAMPLE";
    const second = "AKIAJ7PWWMSQ4EXAMPLE";

    await harness.append({
      level: "info",
      event: "credential.seen",
      attributes: { a: first, b: first, c: second },
    });

    const record = harness.sink.records[0]!;
    expect(record.attributes.a).toBe(record.attributes.b);
    expect(record.attributes.a).not.toBe(record.attributes.c);
    expect(record.attributes.c).toMatch(/^\[redacted:token:[0-9a-f]{12}]$/);
  });

  it("bounds entry size host-side", async () => {
    const harness = createHarness({
      limits: { maxMessageBytes: 32, maxAttributes: 2, maxAttributeValueBytes: 16 },
    });

    await expect(
      harness.append({ level: "info", event: "module.progress", message: "x".repeat(33) }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_QUOTA_EXCEEDED",
      details: { limit: "maxMessageBytes", allowed: 32 },
    });
    await expect(
      harness.append({
        level: "info",
        event: "module.progress",
        attributes: { a: "1", b: "2", c: "3" },
      }),
    ).rejects.toMatchObject({ details: { limit: "maxAttributes", allowed: 2 } });
    await expect(
      harness.append({
        level: "info",
        event: "module.progress",
        attributes: { a: "y".repeat(17) },
      }),
    ).rejects.toMatchObject({ details: { limit: "maxAttributeValueBytes", allowed: 16 } });
    expect(harness.sink.records).toHaveLength(0);

    await harness.append({ level: "info", event: "module.progress", message: "short" });
    expect(harness.sink.records).toHaveLength(1);
  });

  it("bounds the record rate inside one window and recovers in the next", async () => {
    const harness = createHarness({
      limits: { maxRecordsPerWindow: 2, windowMs: 1_000 },
    });

    await harness.append({ level: "info", event: "a.one" });
    await harness.append({ level: "info", event: "a.two" });
    await expect(harness.append({ level: "info", event: "a.three" })).rejects.toMatchObject({
      code: "CAPABILITY_QUOTA_EXCEEDED",
      details: { limit: "maxRecordsPerWindow", allowed: 2 },
    });
    expect(harness.sink.records).toHaveLength(2);

    harness.clock.monotonic += 1_000;
    await harness.append({ level: "info", event: "a.four" });
    expect(harness.sink.records.map((record) => record.event)).toEqual([
      "a.one",
      "a.two",
      "a.four",
    ]);
    expect(harness.sink.records[2]!.sequence).toBe(3);
  });

  it("bounds the byte rate inside one window", async () => {
    const harness = createHarness({
      limits: { maxRecordBytesPerWindow: 900, maxMessageBytes: 512 },
    });

    await harness.append({ level: "info", event: "a.one", message: "z".repeat(300) });
    await expect(
      harness.append({ level: "info", event: "a.two", message: "z".repeat(500) }),
    ).rejects.toMatchObject({ details: { limit: "maxRecordBytesPerWindow", allowed: 900 } });
    expect(harness.sink.records).toHaveLength(1);
  });

  it("denies a revoked capability, a closed session, and a cross-session handle", async () => {
    const harness = createHarness();
    await harness.append({ level: "info", event: "a.one" });

    const foreign = harness.authority.openSession({
      ...IDENTITY,
      sessionId: "session-b",
      processGenerationId: "process-generation-b",
    });
    await expect(
      foreign.invoke({
        handle: harness.handle,
        operation: "append",
        arguments: { level: "info", event: "a.two" },
        moduleJobId: EXECUTION_SCOPE.moduleJobId,
        runId: EXECUTION_SCOPE.runId,
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });

    expect(harness.session.revoke(harness.handle)).toBe("revoked");
    await expect(harness.append({ level: "info", event: "a.three" })).rejects.toMatchObject({
      code: "CAPABILITY_REVOKED",
    });

    await harness.session.close();
    await expect(harness.append({ level: "info", event: "a.four" })).rejects.toMatchObject({
      code: "CAPABILITY_SESSION_CLOSED",
    });
    expect(harness.sink.records.map((record) => record.event)).toEqual(["a.one"]);
  });

  it("refuses an expired grant", async () => {
    const harness = createHarness();
    await harness.append({ level: "info", event: "a.one" });

    harness.clock.wall = "2026-07-28T00:00:00.000Z";
    await expect(harness.append({ level: "info", event: "a.two" })).rejects.toMatchObject({
      code: "CAPABILITY_EXPIRED",
    });
    expect(harness.sink.records).toHaveLength(1);
  });

  it("does not append a duplicate record when an idempotency key repeats", async () => {
    const harness = createHarness({
      capabilityOverrides: { requireIdempotencyKey: true },
    });
    const entry = { level: "info", event: "a.one", message: "once" };

    const first = await harness.append(entry, { idempotencyKey: "effect-1" });
    const second = await harness.append(entry, { idempotencyKey: "effect-1" });
    expect(second).toEqual(first);
    expect(harness.sink.records).toHaveLength(1);

    await expect(
      harness.append({ ...entry, message: "twice" }, { idempotencyKey: "effect-1" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_SCOPE_MISMATCH" });
    await expect(harness.append(entry)).rejects.toMatchObject({
      code: "CAPABILITY_CONFIG_INVALID",
    });
    expect(harness.sink.records).toHaveLength(1);
  });
});
