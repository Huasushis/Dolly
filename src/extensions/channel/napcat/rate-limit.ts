/**
 * Deterministic fixed-window rate limiting with an injected, bounded clock.
 *
 * Two independent windows apply to outbound sends: a per-target window keyed
 * by the exact recipient id, and a daemon-wide global window. A send is
 * admitted only when both current windows still have headroom; the counters
 * are bumped only together on admission, so a rejected send never consumes
 * quota and the same clock inputs always yield the same decisions.
 */

export interface RateLimitLimits {
  readonly per_target_window_ms: number;
  readonly max_per_target_window: number;
  readonly global_window_ms: number;
  readonly max_global_window: number;
}

export type RateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly scope: "per_target" | "global" };

interface TargetBucket {
  readonly window: number;
  readonly count: number;
}

export class FixedWindowRateLimiter {
  readonly #limits: RateLimitLimits;
  readonly #clock: () => number;
  #global: { readonly window: number; readonly count: number } | null = null;
  #perTarget = new Map<string, TargetBucket>();

  constructor(limits: RateLimitLimits, clock: () => number) {
    this.#limits = limits;
    this.#clock = clock;
  }

  /** Admit one send for `targetKey` if both windows have headroom; else deny. */
  tryConsume(targetKey: string): RateDecision {
    const now = this.#clock();
    const targetWindow = Math.floor(now / this.#limits.per_target_window_ms);
    const existing = this.#perTarget.get(targetKey);
    const targetCount = existing !== undefined && existing.window === targetWindow ? existing.count : 0;
    if (targetCount + 1 > this.#limits.max_per_target_window) {
      return { allowed: false, scope: "per_target" };
    }

    const globalWindow = Math.floor(now / this.#limits.global_window_ms);
    const globalCount = this.#global !== null && this.#global.window === globalWindow ? this.#global.count : 0;
    if (globalCount + 1 > this.#limits.max_global_window) {
      return { allowed: false, scope: "global" };
    }

    this.#perTarget.set(targetKey, { window: targetWindow, count: targetCount + 1 });
    this.#global = { window: globalWindow, count: globalCount + 1 };
    return { allowed: true };
  }
}
