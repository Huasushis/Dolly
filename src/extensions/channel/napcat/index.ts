/**
 * Public seam of the closed NapCatQQ Channel policy/transport slice.
 *
 * This is the offline, deterministic first slice of the host-owned Channel
 * policy: exact decimal QQ ID normalization, the fixed host-owned outbound
 * allowlist and default-deny policy, deterministic per-target/global rate
 * limiting with an injected clock, outbound `action_id` idempotency, inbound
 * reconnect dedup, a redaction + structured projection layer, and the
 * injected transport seam. Nothing here opens a socket, authenticates, reads a
 * chat, or sends a real message.
 */
export { normalizeQQId } from "./ids.js";
export type { QQCanonicalId, QQIdNormalization, QQIdRejectReason } from "./ids.js";
export { NAPCAT_OUTBOUND_ALLOWLIST, HOST_OUTBOUND_POLICY, OutboundPolicy } from "./policy.js";
export type {
  OutboundRecipient,
  OutboundTargetSpec,
  OutboundDenialReason,
  OutboundDecision,
} from "./policy.js";
export { FixedWindowRateLimiter } from "./rate-limit.js";
export type { RateLimitLimits, RateDecision } from "./rate-limit.js";
export { OutboundIdempotency } from "./idempotency.js";
export type { PriorDispatch } from "./idempotency.js";
export { InboundDedupRegistry } from "./dedup.js";
export type { InboundEventKey, InboundRegistration } from "./dedup.js";
export { redactDiagnosticString } from "./redact.js";
export { NoopTransport, OFFLINE_TRANSPORT } from "./transport.js";
export type {
  CancellationSignal,
  OutboundRequest,
  OutboundPart,
  OutboundTransport,
  TransportOutcome,
} from "./transport.js";
export { NapcatChannel, DEFAULT_RATE_LIMITS } from "./dispatch.js";
export type {
  DispatchDenialReason,
  DispatchOutcome,
  SendRequest,
  InboundResolution,
  InboundEvent,
  NapcatChannelOptions,
} from "./dispatch.js";
export { projectSend, projectInbound } from "./projection.js";
export type { OutboundProjection, InboundProjection } from "./projection.js";
