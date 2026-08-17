/**
 * Host-owned NapCatQQ Channel policy + injected transport stage.
 *
 * This is the closed, deterministic domain seam for the policy/transport
 * slice. `NapcatChannel.send` runs: action/recipient normalization and the
 * host-owned outbound policy, per-target and global rate limiting, outbound
 * idempotency, then the injected transport — and terminates every earlier step
 * with transport call count 0. `NapcatChannel.receive` is the inbound read
 * path and is NOT restricted by the outbound allowlist. No real socket,
 * authentication, chat read, or send happens anywhere in this slice.
 */

import { HOST_OUTBOUND_POLICY, type OutboundDenialReason, type OutboundRecipient, type OutboundTargetSpec } from "./policy.js";
import { FixedWindowRateLimiter, type RateLimitLimits } from "./rate-limit.js";
import { OutboundIdempotency, type PriorDispatch } from "./idempotency.js";
import { InboundDedupRegistry } from "./dedup.js";
import type { CancellationSignal, OutboundPart, OutboundRequest, OutboundTransport, TransportOutcome } from "./transport.js";
import { normalizeQQId } from "./ids.js";

const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const DEFAULT_RATE_LIMITS: Readonly<RateLimitLimits> = Object.freeze({
  per_target_window_ms: 60_000,
  max_per_target_window: 20,
  global_window_ms: 60_000,
  max_global_window: 60,
});

export type DispatchDenialReason = "action_id_invalid" | OutboundDenialReason;

export type DispatchOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "denied"; readonly reason: DispatchDenialReason }
  | { readonly kind: "rate_limited"; readonly scope: "per_target" | "global" }
  | { readonly kind: "duplicate"; readonly prior: PriorDispatch }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unknown"; readonly reason: "transport_rejected" | "response_lost" | "exception" };

export interface SendRequest {
  readonly action_id: string;
  readonly target: OutboundTargetSpec;
  readonly parts: readonly OutboundPart[];
}

export type InboundResolution =
  | { readonly kind: "new" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "malformed"; readonly reason: DispatchDenialReason };

export interface InboundEvent {
  readonly account: string;
  readonly external_message_id: string;
  readonly conversation:
    | { readonly kind: "group"; readonly group_id: string }
    | { readonly kind: "private"; readonly user_id: string; readonly sender_id: string };
  readonly parts: readonly OutboundPart[];
}

export interface NapcatChannelOptions {
  readonly transport: OutboundTransport;
  readonly rateLimits?: Readonly<RateLimitLimits>;
  readonly clock?: () => number;
  readonly idempotencyCapacity?: number;
  readonly dedupCapacity?: number;
}

const NOT_ABORTED: CancellationSignal = Object.freeze({ aborted: false });

function recipientKey(recipient: OutboundRecipient): string {
  return recipient.kind === "group"
    ? `group:${recipient.group_id}`
    : `user:${recipient.user_id}`;
}

export class NapcatChannel {
  readonly #transport: OutboundTransport;
  readonly #rate: FixedWindowRateLimiter;
  readonly #idempotency: OutboundIdempotency;
  readonly #dedup: InboundDedupRegistry;

  constructor(options: NapcatChannelOptions) {
    this.#transport = options.transport;
    const limits = options.rateLimits ?? DEFAULT_RATE_LIMITS;
    const clock = options.clock ?? (() => Date.now());
    this.#rate = new FixedWindowRateLimiter(limits, clock);
    this.#idempotency = new OutboundIdempotency(options.idempotencyCapacity);
    this.#dedup = new InboundDedupRegistry(options.dedupCapacity);
  }

  send(request: SendRequest, signal: CancellationSignal = NOT_ABORTED): DispatchOutcome {
    if (signal.aborted) return { kind: "cancelled" };
    if (!request.action_id) return { kind: "denied", reason: "action_id_invalid" };
    if (UUIDV7_PATTERN.test(request.action_id) === false) {
      return { kind: "denied", reason: "action_id_invalid" };
    }

    const decision = HOST_OUTBOUND_POLICY.evaluate(request.target);
    if (decision.allowed === false) {
      return { kind: "denied", reason: decision.reason };
    }

    const previous = this.#idempotency.prior(request.action_id);
    if (previous !== null) {
      return { kind: "duplicate", prior: previous };
    }

    const targetKey = recipientKey(decision.recipient);
    const rate = this.#rate.tryConsume(targetKey);
    if (rate.allowed === false) {
      return { kind: "rate_limited", scope: rate.scope };
    }

    const outbound: OutboundRequest = {
      action_id: request.action_id,
      recipient: decision.recipient,
      parts: request.parts,
    };
    let outcome: TransportOutcome;
    try {
      outcome = this.#transport.dispatch(outbound, signal);
    } catch {
      outcome = { kind: "unknown", reason: "exception" };
    }
    const terminal: PriorDispatch = outcome.kind === "accepted" ? "accepted" : "unknown";
    this.#idempotency.record(request.action_id, terminal);
    if (outcome.kind === "accepted") return { kind: "accepted" };
    return { kind: "unknown", reason: outcome.reason };
  }

  receive(event: InboundEvent): InboundResolution {
    const malformed = normalizeConversationIds(event.conversation);
    if (malformed.reason !== null) {
      return { kind: "malformed", reason: malformed.reason };
    }
    const registration = this.#dedup.register({
      account: event.account,
      external_message_id: event.external_message_id,
    });
    return registration.kind === "duplicate" ? { kind: "duplicate" } : { kind: "new" };
  }
}

function normalizeConversationIds(
  conversation: InboundEvent["conversation"],
): { readonly reason: null } | { readonly reason: DispatchDenialReason } {
  if (conversation.kind === "group") {
    const id = normalizeQQId(conversation.group_id);
    return id.kind === "invalid" ? { reason: id.reason } : { reason: null };
  }
  const userId = normalizeQQId(conversation.user_id);
  if (userId.kind === "invalid") return { reason: userId.reason };
  const senderId = normalizeQQId(conversation.sender_id);
  if (senderId.kind === "invalid") return { reason: senderId.reason };
  return { reason: null };
}
