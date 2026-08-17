import type {
  CancellationSignal,
  OutboundRequest,
  OutboundTransport,
  TransportOutcome,
} from "../../../../src/extensions/channel/napcat/index.js";

export interface FakeTransportScript {
  readonly outcome: TransportOutcome;
  readonly throw?: Error;
  readonly abortable?: boolean;
}

/**
 * Offline fake transport twin for channel policy tests. Records every dispatch
 * attempt; the script either yields a fixed outcome, honors cancellation, or
 * throws the prebuilt error (which exercises the redaction path). The default
 * script is an always-fail outcome so a transport that must never be reached
 * can be constructed without choosing a misleading success.
 */
export class FakeTransport implements OutboundTransport {
  readonly #script: FakeTransportScript;
  dispatchCalls = 0;
  readonly dispatched: OutboundRequest[] = [];

  constructor(script: FakeTransportScript = { outcome: { kind: "unknown", reason: "response_lost" } }) {
    this.#script = script;
  }

  dispatch(request: OutboundRequest, signal: CancellationSignal): TransportOutcome {
    this.dispatchCalls += 1;
    this.dispatched.push(request);
    if (this.#script.throw !== undefined) throw this.#script.throw;
    if (this.#script.abortable === true && signal.aborted) {
      return { kind: "unknown", reason: "response_lost" };
    }
    return this.#script.outcome;
  }
}
