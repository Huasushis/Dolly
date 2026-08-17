/**
 * Structured log projection for the NapCatQQ Channel slice.
 *
 * Every observed outbound/inbound outcome is projected into a fixed,
 * content-free record before it may enter errors, events, or logs. The
 * projection carries only outcome class, target class, and a redacted error
 * string — never chat content, credentials, URL query strings, headers,
 * base64, or paths. Tests and callers assert on the projection objects, so
 * no secret is recorded anywhere.
 */

import type { DispatchOutcome, InboundResolution, SendRequest } from "./dispatch.js";
import { redactDiagnosticString } from "./redact.js";

export interface OutboundProjection {
  readonly event_class: "outbound_send";
  readonly outcome: DispatchOutcome["kind"];
  readonly target_class: "group" | "private" | "none";
  readonly reason: string | null;
  readonly error_message: string | null;
}

export interface InboundProjection {
  readonly event_class: "inbound_event";
  readonly outcome: InboundResolution["kind"];
  readonly reason: string | null;
}

export function projectSend(request: SendRequest, outcome: DispatchOutcome, caught?: unknown): OutboundProjection {
  return {
    event_class: "outbound_send",
    outcome: outcome.kind,
    target_class: request.target.kind,
    reason:
      outcome.kind === "denied"
        ? outcome.reason
        : outcome.kind === "rate_limited"
          ? outcome.scope
          : outcome.kind === "duplicate"
            ? outcome.prior
            : null,
    error_message:
      outcome.kind === "unknown" && outcome.reason === "exception" && caught !== undefined
        ? redactDiagnosticString(String(caught))
        : null,
  };
}

export function projectInbound(resolution: InboundResolution): InboundProjection {
  return {
    event_class: "inbound_event",
    outcome: resolution.kind,
    reason: resolution.kind === "malformed" ? resolution.reason : null,
  };
}
