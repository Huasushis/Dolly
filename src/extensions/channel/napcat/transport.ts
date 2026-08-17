/**
 * Injected outbound transport seam for the NapCatQQ Channel slice.
 *
 * The transport is a host seam: a real socket adapter is a later gate, so this
 * slice only defines the contract and terminates every outcome. Dispatch is
 * fail-closed: only an explicit `accepted` from the injected transport counts
 * as sent; a rejection, a lost response, or an exception is `unknown`, never a
 * fabricated success. Cancellation is signalled before dispatch; the seam never
 * touches a socket, authenticates, or reads a chat.
 */

import type { OutboundRecipient } from "./policy.js";

export interface CancellationSignal {
  readonly aborted: boolean;
}

export interface OutboundRequest {
  readonly action_id: string;
  readonly recipient: OutboundRecipient;
  readonly parts: readonly OutboundPart[];
}

export interface OutboundPart {
  readonly kind: "text";
  readonly text: string;
  readonly format: "plain";
}

export type TransportOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "unknown"; readonly reason: "transport_rejected" | "response_lost" | "exception" };

export interface OutboundTransport {
  dispatch(request: OutboundRequest, signal: CancellationSignal): TransportOutcome;
}

export class NoopTransport implements OutboundTransport {
  dispatch(_request: OutboundRequest, _signal: CancellationSignal): TransportOutcome {
    return { kind: "unknown", reason: "response_lost" };
  }
}

/** The host default transport is offline: it always yields an unknown outcome. */
export const OFFLINE_TRANSPORT: OutboundTransport = Object.freeze(new NoopTransport());
