/**
 * Process-generation tokens for daemon supervision.
 *
 * A supervised child belongs to exactly one process generation of exactly one
 * supervision epoch. A token names that generation with an epoch marker and a
 * monotonic counter:
 *
 *   generation_<epoch>_<counter>
 *
 * The epoch marker is one per daemon supervision session (the controller
 * identity), so the counter never collides with a generation minted by a
 * previous session, and within an epoch the counter never repeats. Supervision
 * must not act on a stale generation, so the guarding sequence below refuses
 * any action that carries a token which is not the current generation of its
 * epoch: an older counter in the same epoch is stale, and a token from another
 * epoch is foreign. A string that is not a generation token — for example a
 * durable record written before tokens existed — is left to the
 * operating-system identity evidence that already decides ownership.
 *
 * The wire form must satisfy the authoritative Core
 * `isProcessGenerationId` grammar, so a supervision token can cross the
 * durable Module process-record boundary. The epoch marker is therefore
 * restricted to Core-safe identifier characters and the `_` separator is
 * reserved from the epoch marker, keeping the epoch/counter split lossless.
 */

import { isProcessGenerationId } from "../core/linux-identifier-formats.js";

const EPOCH_SOURCE = "[A-Za-z0-9][A-Za-z0-9-]{0,63}";
const COUNTER_SOURCE = "[0-9]{1,20}";
const EPOCH_PATTERN = new RegExp(`^${EPOCH_SOURCE}$`, "u");
const FULL_TOKEN_PATTERN = new RegExp(
  `^generation_(${EPOCH_SOURCE})_(${COUNTER_SOURCE})$`,
  "u",
);

export interface ProcessGenerationToken {
  /** One marker per supervision epoch; scopes every counter of the epoch. */
  readonly epoch: string;
  /** Strictly increasing within the epoch; never names two generations. */
  readonly counter: number;
}

export type ProcessGenerationErrorCode =
  | "PROCESS_GENERATION_ID_INVALID"
  | "PROCESS_GENERATION_EPOCH_MISMATCH"
  | "PROCESS_GENERATION_STALE";

export class ProcessGenerationError extends Error {
  constructor(
    readonly code: ProcessGenerationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProcessGenerationError";
  }
}

function isEpochMarker(value: unknown): value is string {
  return typeof value === "string" && EPOCH_PATTERN.test(value);
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isTokenShape(value: unknown): value is ProcessGenerationToken {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const token = value as Record<string, unknown>;
  return isEpochMarker(token.epoch) && isCounter(token.counter);
}

/**
 * Recognizes a generation-token string. Returns `undefined` for anything that
 * is not one, including identifiers written before tokens existed, so callers
 * can fall back to the pre-existing ownership evidence without an exception.
 */
export function parseProcessGenerationToken(
  value: unknown,
): ProcessGenerationToken | undefined {
  if (typeof value !== "string") return undefined;
  const match = FULL_TOKEN_PATTERN.exec(value);
  if (match === null) return undefined;
  const epoch = match[1]!;
  const counter = Number(match[2]!);
  if (!isCounter(counter)) return undefined;
  return { epoch, counter };
}

/** Serializes a token to its wire identifier. */
export function formatProcessGenerationToken(token: ProcessGenerationToken): string {
  if (!isTokenShape(token)) {
    throw new ProcessGenerationError(
      "PROCESS_GENERATION_ID_INVALID",
      "A process-generation token must carry a valid epoch and a positive counter",
    );
  }
  const id = `generation_${token.epoch}_${token.counter}`;
  // Fail closed if the encoding ever drifts outside the authoritative Core
  // grammar, so every token the daemon mints can cross the durable-record
  // boundary that Module process and submission records validate against.
  if (!isProcessGenerationId(id)) {
    throw new ProcessGenerationError(
      "PROCESS_GENERATION_ID_INVALID",
      "A process-generation token serialization must satisfy the Core process-generation identifier grammar",
    );
  }
  return id;
}

export interface ProcessGenerationSequenceOptions {
  /** Epoch marker of this supervision session; scopes the counter. */
  readonly epoch: string;
}

/**
 * Mints, orders, and guards the process generations of one supervision epoch.
 * Counters never repeat and never decrease, so the sequence can both name the
 * current generation and refuse tokens that no longer name it.
 */
export class ProcessGenerationSequence {
  readonly #epoch: string;
  #counter = 0;

  constructor(options: ProcessGenerationSequenceOptions) {
    if (!isEpochMarker(options.epoch)) {
      throw new ProcessGenerationError(
        "PROCESS_GENERATION_ID_INVALID",
        "A process-generation epoch marker is invalid",
      );
    }
    this.#epoch = options.epoch;
  }

  get epoch(): string {
    return this.#epoch;
  }

  /** Mints the next generation of this epoch. The counter strictly increases. */
  bump(): ProcessGenerationToken {
    this.#counter += 1;
    return { epoch: this.#epoch, counter: this.#counter };
  }

  /** The most recently minted generation, or `undefined` before the first `bump`. */
  current(): ProcessGenerationToken | undefined {
    return this.#counter === 0 ? undefined : { epoch: this.#epoch, counter: this.#counter };
  }

  /**
   * Refuses an action that carries a token which is not the current generation
   * of this epoch. An older counter in this epoch is stale; a token from
   * another epoch is foreign; a same-epoch token this sequence never issued is
   * invalid. A string that is not a generation token passes without refusal and
   * is left to the other ownership evidence.
   */
  guard(presented: string | ProcessGenerationToken): void {
    const token =
      typeof presented === "string" ? parseProcessGenerationToken(presented) : presented;
    if (token === undefined) return;
    if (!isTokenShape(token)) {
      throw new ProcessGenerationError(
        "PROCESS_GENERATION_ID_INVALID",
        "A submitted process-generation token is malformed",
      );
    }
    if (token.epoch !== this.#epoch) {
      throw new ProcessGenerationError(
        "PROCESS_GENERATION_EPOCH_MISMATCH",
        `Refusing a process-generation token from epoch ${JSON.stringify(token.epoch)} while epoch ${JSON.stringify(this.#epoch)} is current`,
      );
    }
    if (token.counter < this.#counter) {
      throw new ProcessGenerationError(
        "PROCESS_GENERATION_STALE",
        `Refusing a stale process-generation token generation_${token.epoch}_${token.counter}; the current generation is ${this.#counter}`,
      );
    }
    if (token.counter > this.#counter) {
      throw new ProcessGenerationError(
        "PROCESS_GENERATION_ID_INVALID",
        `Refusing a process-generation token generation_${token.epoch}_${token.counter} that this epoch has not issued`,
      );
    }
  }
}