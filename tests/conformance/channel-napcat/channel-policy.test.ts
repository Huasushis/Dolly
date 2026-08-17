/**
 * Offline channel policy/transport matrix, injected fake transport.
 *
 * Covers: exact allowed group/private sends (transport count 1); denied other
 * group/private and malformed/ambiguous/leading-sign/overflow ids (transport
 * count 0); inbound event read path NOT restricted by the outbound policy;
 * deterministic per-target/global rate limiting with an injected clock;
 * duplicate `action_id` idempotency and reconnect/inbound dedup.
 */
import { describe, expect, it } from "vitest";
import {
  NapcatChannel,
  DEFAULT_RATE_LIMITS,
  type InboundEvent,
  type RateLimitLimits,
  type SendRequest,
} from "../../../src/extensions/channel/napcat/index.js";
import { FakeTransport } from "./fixtures/fake-transport.js";

const ALLOWED_GROUP = "739571751";
const ALLOWED_USERS = ["3227435534", "1074313761"] as const;
const OTHER_GROUP = "88888888";
const OTHER_USER = "999999999";
const ACTION_ID = "019535d4-6f00-7a2c-9b31-8e11d2345000";
const ACTION_ID_2 = "019535d4-6f00-7a2c-9b31-8e11d2345001";
const ACTION_ID_3 = "019535d4-6f00-7a2c-9b31-8e11d2345002";

function longWindowLimits(): RateLimitLimits {
  return { ...DEFAULT_RATE_LIMITS, per_target_window_ms: 60_000, global_window_ms: 60_000 };
}

function send(targetId: string, kind: "group" | "private", actionId = ACTION_ID): SendRequest {
  return { action_id: actionId, target: { kind, id: targetId }, parts: [{ kind: "text", text: "hello", format: "plain" }] };
}

function baseInbound(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    account: "host-account-a",
    external_message_id: "ext-msg-1",
    conversation: { kind: "group", group_id: ALLOWED_GROUP },
    parts: [{ kind: "text", text: "inbound", format: "plain" }],
    ...overrides,
  };
}

describe("host-owned outbound policy with injected transport", () => {
  it("accepts the exact allowed group and records exactly one dispatch", () => {
    const transport = new FakeTransport({ outcome: { kind: "accepted" } });
    const channel = new NapcatChannel({ transport, rateLimits: longWindowLimits() });
    const outcome = channel.send(send(ALLOWED_GROUP, "group"));
    expect(outcome).toEqual({ kind: "accepted" });
    expect(transport.dispatchCalls).toBe(1);
  });

  it("accepts both exact allowed private users and records one dispatch each", () => {
    for (const userId of ALLOWED_USERS) {
      const transport = new FakeTransport({ outcome: { kind: "accepted" } });
      const channel = new NapcatChannel({ transport, rateLimits: longWindowLimits() });
      const outcome = channel.send(send(userId, "private"));
      expect(outcome).toEqual({ kind: "accepted" });
      expect(transport.dispatchCalls).toBe(1);
      expect(transport.dispatched[0]?.recipient).toEqual({ kind: "private", user_id: userId });
    }
  });

  it("denies any other group with transport count 0", () => {
    const transport = new FakeTransport({ outcome: { kind: "accepted" } });
    const channel = new NapcatChannel({ transport, rateLimits: longWindowLimits() });
    const outcome = channel.send(send(OTHER_GROUP, "group"));
    expect(outcome).toEqual({ kind: "denied", reason: "group_not_allowed" });
    expect(transport.dispatchCalls).toBe(0);
  });

  it("denies any other private user with transport count 0", () => {
    const transport = new FakeTransport({ outcome: { kind: "accepted" } });
    const channel = new NapcatChannel({ transport, rateLimits: longWindowLimits() });
    const outcome = channel.send(send(OTHER_USER, "private"));
    expect(outcome).toEqual({ kind: "denied", reason: "user_not_allowed" });
    expect(transport.dispatchCalls).toBe(0);
  });

  it("denies malformed, ambiguous, leading-sign, and overflow ids without dispatch", () => {
    const cases: ReadonlyArray<{ id: string; kind: "group" | "private"; reason: string }> = [
      { id: "+739571751", kind: "group", reason: "sign" },
      { id: "00739571751", kind: "group", reason: "ambiguous" },
      { id: "0x1f", kind: "group", reason: "not_decimal" },
      { id: "1e9", kind: "private", reason: "not_decimal" },
      { id: "", kind: "private", reason: "empty" },
      { id: "9007199254740992", kind: "group", reason: "overflow" },
      { id: "12345678901234567890", kind: "group", reason: "too_long" },
      { id: "739571751 ", kind: "group", reason: "not_decimal" },
    ];
    for (const c of cases) {
      const transport = new FakeTransport({ outcome: { kind: "accepted" } });
      const channel = new NapcatChannel({ transport, rateLimits: longWindowLimits() });
      const outcome = channel.send(send(c.id, c.kind));
      expect(outcome).toEqual({ kind: "denied", reason: c.reason });
      expect(transport.dispatchCalls).toBe(0);
    }
  });

  it("denies a non-uuidv7 action id without dispatch", () => {
    const transport = new FakeTransport({ outcome: { kind: "accepted" } });
    const channel = new NapcatChannel({ transport, rateLimits: longWindowLimits() });
    const outcome = channel.send(send(ALLOWED_GROUP, "group", "not-a-uuid"));
    expect(outcome).toEqual({ kind: "denied", reason: "action_id_invalid" });
    expect(transport.dispatchCalls).toBe(0);
  });
});

describe("inbound read path is independent of the outbound allowlist", () => {
  it("accepts an inbound event from a group outside the outbound allowlist", () => {
    const channel = new NapcatChannel({ transport: new FakeTransport({ outcome: { kind: "accepted" } }), rateLimits: longWindowLimits() });
    const outcome = channel.receive(baseInbound({ conversation: { kind: "group", group_id: OTHER_GROUP } }));
    expect(outcome).toEqual({ kind: "new" });
  });

  it("accepts an inbound private event regardless of outbound allowlist", () => {
    const channel = new NapcatChannel({ transport: new FakeTransport({ outcome: { kind: "accepted" } }), rateLimits: longWindowLimits() });
    const outcome = channel.receive(
      baseInbound({ conversation: { kind: "private", user_id: OTHER_USER, sender_id: OTHER_USER } }),
    );
    expect(outcome).toEqual({ kind: "new" });
  });

  it("rejects a malformed inbound event id without routing", () => {
    const channel = new NapcatChannel({ transport: new FakeTransport({ outcome: { kind: "accepted" } }), rateLimits: longWindowLimits() });
    const outcome = channel.receive(baseInbound({ conversation: { kind: "group", group_id: "00x" } }));
    expect(outcome).toEqual({ kind: "malformed", reason: "not_decimal" });
  });
});

describe("deterministic rate limiting with injected clock", () => {
  it("denies per-target above the window quota without dispatch", () => {
    let now = 0;
    const limits: RateLimitLimits = { ...longWindowLimits(), max_per_target_window: 2, max_global_window: 100 };
    const transport = new FakeTransport({ outcome: { kind: "accepted" } });
    const channel = new NapcatChannel({ transport, rateLimits: limits, clock: () => now });

    expect(channel.send(send(ALLOWED_GROUP, "group"))).toEqual({ kind: "accepted" });
    expect(channel.send(send(ALLOWED_GROUP, "group", ACTION_ID_2))).toEqual({ kind: "accepted" });
    expect(channel.send(send(ALLOWED_GROUP, "group", ACTION_ID_3))).toEqual({ kind: "rate_limited", scope: "per_target" });
    expect(transport.dispatchCalls).toBe(2);
  });

  it("denies at the global quota even for distinct allowed targets", () => {
    let now = 0;
    const limits: RateLimitLimits = { ...longWindowLimits(), max_per_target_window: 100, max_global_window: 1 };
    const transport = new FakeTransport({ outcome: { kind: "accepted" } });
    const channel = new NapcatChannel({ transport, rateLimits: limits, clock: () => now });

    expect(channel.send(send(ALLOWED_GROUP, "group"))).toEqual({ kind: "accepted" });
    expect(channel.send(send(ALLOWED_USERS[0], "private", ACTION_ID_2))).toEqual({ kind: "rate_limited", scope: "global" });
    expect(transport.dispatchCalls).toBe(1);
  });

  it("resets windows on clock rollover deterministically", () => {
    let now = 0;
    const limits: RateLimitLimits = { ...longWindowLimits(), max_per_target_window: 1, max_global_window: 1 };
    const transport = new FakeTransport({ outcome: { kind: "accepted" } });
    const channel = new NapcatChannel({ transport, rateLimits: limits, clock: () => now });

    expect(channel.send(send(ALLOWED_GROUP, "group"))).toEqual({ kind: "accepted" });
    expect(channel.send(send(ALLOWED_GROUP, "group", ACTION_ID_2))).toEqual({ kind: "rate_limited", scope: "per_target" });
    now = limits.per_target_window_ms;
    expect(channel.send(send(ALLOWED_GROUP, "group", ACTION_ID_3))).toEqual({ kind: "accepted" });
    expect(transport.dispatchCalls).toBe(2);
  });
});

describe("outbound idempotency and inbound dedup", () => {
  it("replays a duplicate action id without a second dispatch", () => {
    const transport = new FakeTransport({ outcome: { kind: "accepted" } });
    const channel = new NapcatChannel({ transport, rateLimits: longWindowLimits() });

    expect(channel.send(send(ALLOWED_GROUP, "group"))).toEqual({ kind: "accepted" });
    expect(channel.send(send(ALLOWED_GROUP, "group"))).toEqual({ kind: "duplicate", prior: "accepted" });
    expect(transport.dispatchCalls).toBe(1);
  });

  it("does not re-dispatch a duplicate after an unknown outcome", () => {
    const transport = new FakeTransport({ outcome: { kind: "unknown", reason: "response_lost" } });
    const channel = new NapcatChannel({ transport, rateLimits: longWindowLimits() });

    expect(channel.send(send(ALLOWED_GROUP, "group"))).toEqual({ kind: "unknown", reason: "response_lost" });
    expect(channel.send(send(ALLOWED_GROUP, "group"))).toEqual({ kind: "duplicate", prior: "unknown" });
    expect(transport.dispatchCalls).toBe(1);
  });

  it("converts a transport exception into a fail-closed unknown outcome", () => {
    const transport = new FakeTransport({ outcome: { kind: "accepted" }, throw: new Error("transport boom") });
    const channel = new NapcatChannel({ transport, rateLimits: longWindowLimits() });

    const outcome = channel.send(send(ALLOWED_GROUP, "group"));
    expect(outcome).toEqual({ kind: "unknown", reason: "exception" });
    expect(transport.dispatchCalls).toBe(1);
  });

  it("cancels before dispatch with transport count 0", () => {
    const transport = new FakeTransport();
    const channel = new NapcatChannel({ transport, rateLimits: longWindowLimits() });
    const outcome = channel.send(send(ALLOWED_GROUP, "group"), { aborted: true });
    expect(outcome).toEqual({ kind: "cancelled" });
    expect(transport.dispatchCalls).toBe(0);
  });

  it("deduplicates a reconnect redelivery but allows a distinct event", () => {
    const channel = new NapcatChannel({ transport: new FakeTransport({ outcome: { kind: "accepted" } }), rateLimits: longWindowLimits() });

    const first = channel.receive(baseInbound());
    const redelivered = channel.receive(baseInbound());
    const distinct = channel.receive(baseInbound({ external_message_id: "ext-msg-2" }));
    expect(first).toEqual({ kind: "new" });
    expect(redelivered).toEqual({ kind: "duplicate" });
    expect(distinct).toEqual({ kind: "new" });
  });
});
