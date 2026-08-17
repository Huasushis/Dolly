/**
 * Redaction and structured projection tests.
 *
 * A fixed fake sentinel set (token, WebSocket URL query string, authorization
 * header, base64 payload, absolute path) is injected via a throwing fake
 * transport, then asserted to be absent from the structured projection. The
 * projection object shape is asserted directly, so no secret is recorded in the
 * test process output.
 */
import { describe, expect, it } from "vitest";
import {
  NapcatChannel,
  projectSend,
  projectInbound,
  redactDiagnosticString,
  type SendRequest,
} from "../../../src/extensions/channel/napcat/index.js";
import { FakeTransport } from "./fixtures/fake-transport.js";

const ALLOWED_GROUP = "739571751";
const ACTION_ID = "019535d4-6f00-7a2c-9b31-8e11d2345000";

const SENTINEL = {
  token: "secretToken284730183492801234",
  query: "SECRETQUERYTOKEN284910",
  header: "authSecretToken918273",
  base64: "c2VjcmV0LXNlbnRpbmVsLWJhc2U2NC1wYXlsb2FkLXZhbHVlMTIzNDU2Nzg5MA==",
  path: "/home/ubuntu/.dolly/napcat/session.db",
};

function send(text: string): SendRequest {
  return { action_id: ACTION_ID, target: { kind: "group", id: ALLOWED_GROUP }, parts: [{ kind: "text", text, format: "plain" }] };
}

describe("redaction and log projection", () => {
  it("never lets a transport exception leak tokens, query strings, headers, base64, or paths", () => {
    const message = [
      `token=${SENTINEL.token}`,
      `ws://127.0.0.1:3001/ws?access_token=${SENTINEL.query}`,
      `Authorization: Bearer ${SENTINEL.header}`,
      `data:${SENTINEL.base64}`,
      `at ${SENTINEL.path}`,
    ].join(" ");
    const transport = new FakeTransport({
      outcome: { kind: "accepted" },
      throw: new Error(message),
    });
    const channel = new NapcatChannel({ transport, rateLimits: { per_target_window_ms: 60_000, max_per_target_window: 20, global_window_ms: 60_000, max_global_window: 60 } });

    const outcome = channel.send(send("chat content that must never appear"));
    const projection = projectSend(send("chat content that must never appear"), outcome, new Error(message));

    expect(outcome.kind).toBe("unknown");
    if (outcome.kind !== "unknown") throw new Error("unreachable");
    expect(outcome.reason).toBe("exception");

    for (const secret of Object.values(SENTINEL)) {
      expect(projection.error_message).not.toContain(secret);
    }
    expect(projection.error_message).toContain("<query-redacted>");
    expect(projection.error_message).toContain("<token-redacted>");
    expect(projection.error_message).toContain("<base64-redacted>");
    expect(projection.error_message).toContain("<path-redacted>");

    const serialized = JSON.stringify(projection);
    for (const secret of Object.values(SENTINEL)) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain("chat content that must never appear");
  });

  it("projects outbound outcomes structurally without any chat content", () => {
    const transport = new FakeTransport({ outcome: { kind: "accepted" } });
    const channel = new NapcatChannel({ transport, rateLimits: { per_target_window_ms: 60_000, max_per_target_window: 20, global_window_ms: 60_000, max_global_window: 60 } });

    const request = send("TOP-SECRET-CONTENT");
    const outcome = channel.send(request);
    const projection = projectSend(request, outcome);
    expect(projection).toEqual({
      event_class: "outbound_send",
      outcome: "accepted",
      target_class: "group",
      reason: null,
      error_message: null,
    });
    expect(JSON.stringify(projection)).not.toContain("TOP-SECRET-CONTENT");
  });

  it("projects inbound resolutions structurally void of event content", () => {
    const channel = new NapcatChannel({ transport: new FakeTransport({ outcome: { kind: "accepted" } }), rateLimits: { per_target_window_ms: 60_000, max_per_target_window: 20, global_window_ms: 60_000, max_global_window: 60 } });
    const resolution = channel.receive({
      account: "host-account-a",
      external_message_id: "ext-1",
      conversation: { kind: "group", group_id: ALLOWED_GROUP },
      parts: [{ kind: "text", text: "INBOUND-SECRET", format: "plain" }],
    });
    const projection = projectInbound(resolution);
    expect(JSON.stringify(projection)).not.toContain("INBOUND-SECRET");
    expect(JSON.stringify(projection)).not.toContain("ext-1");
  });

  it("redacts query strings and auth headers from a raw diagnostic string", () => {
    const input = `ws://127.0.0.1:9999/ws?access_token=boom Authorization: Bearer abc`;
    const out = redactDiagnosticString(input);
    expect(out).not.toContain("access_token=boom");
    expect(out).not.toContain("Bearer abc");
    expect(out).toContain("ws://127.0.0.1:9999");
  });
});
