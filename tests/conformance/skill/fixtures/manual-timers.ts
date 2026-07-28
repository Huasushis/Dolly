/**
 * Deterministic monotonic clock plus timer port. Tests drive time with
 * `advance()`; nothing here ever waits on a real timer.
 */
export class ManualTimerHost {
  #now = 0;
  #nextId = 0;
  #timers: Array<{
    readonly id: number;
    readonly dueAt: number;
    readonly callback: () => void;
  }> = [];

  readonly monotonicNow = (): number => this.#now;

  readonly setTimer = (delayMs: number, callback: () => void): (() => void) => {
    const id = this.#nextId++;
    this.#timers.push({ id, dueAt: this.#now + delayMs, callback });
    return () => {
      this.#timers = this.#timers.filter((timer) => timer.id !== id);
    };
  };

  get pendingTimerCount(): number {
    return this.#timers.length;
  }

  /** Advances the clock, firing every timer that becomes due, in due order. */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const due = this.#timers
        .filter((timer) => timer.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (due === undefined) break;
      this.#timers = this.#timers.filter((timer) => timer.id !== due.id);
      this.#now = Math.max(this.#now, due.dueAt);
      due.callback();
    }
    this.#now = target;
  }
}
