import type { ScheduleConfig } from "./types.js";

export interface SchedulerModuleEntry {
  id: string;
  config: ScheduleConfig;
}

export interface SchedulerReport {
  moduleId: string;
  executionTimeMs: number;
  bufferEmpty: boolean;
}

interface SchedulerEntryState {
  config: ScheduleConfig;
  currentInterval: number;
  timer?: NodeJS.Timeout;
  /** Safety timeout: forces re-tick if report() never arrives */
  safetyTimer?: NodeJS.Timeout;
  /** true while waiting for report after a tick fired */
  awaitingReport: boolean;
  /** Latest known buffer count for this module (updated via adjustRates) */
  bufferCount: number;
}

const DEFAULT_SCHEDULE: ScheduleConfig = {
  initialIntervalMs: 2000,
  minIntervalMs: 500,
  maxIntervalMs: 60_000,
};

/** Backoff factor: when downstream is slow or buffer has backlog, double upstream interval */
const BACKOFF_FACTOR = 2.0;

/** Speedup factor: when downstream is fast and buffer empty, reduce upstream interval by 20% */
const UPSTREAM_SPEEDUP_FACTOR = 0.8;

/** Threshold: execution considered "fast" if < interval * this ratio */
const FAST_RATIO = 0.5;

/** Multiplier for soft rate-limiting when buffers are full */
const RATE_LIMIT_FACTOR = 1.5;

/** Per-module buffer count above which the module is considered "busy" */
const MODULE_BUFFER_BUSY_THRESHOLD = 5;

/** Safety timeout multiplier: if report() doesn't arrive within interval × this, force re-tick */
const SAFETY_TIMEOUT_MULTIPLIER = 3;

export interface AdjustRatesOptions {
  /** Total buffer item count across all modules that triggers rate limiting */
  totalBufferThreshold?: number;
}

export class Scheduler {
  private entries: Map<string, SchedulerEntryState> = new Map();
  private topology: Map<string, Set<string>> = new Map(); // moduleId → upstream module IDs
  private running = false;
  private onTick: (moduleId: string) => void;

  constructor(onTick: (moduleId: string) => void) {
    this.onTick = onTick;
  }

  /**
   * Register topology: which modules feed data into the given module (via Pages).
   * Supports many-to-many: a module can appear in multiple downstream modules' upstream sets.
   * e.g. setTopology("B", ["A"]) and setTopology("C", ["A"]) — A feeds both B and C.
   */
  setTopology(moduleId: string, upstreamModuleIds: string[]): void {
    this.topology.set(moduleId, new Set(upstreamModuleIds));
  }

  /**
   * Get upstream module IDs for a given module.
   * Returns empty array if no topology registered.
   */
  getTopology(moduleId: string): string[] {
    const upstream = this.topology.get(moduleId);
    return upstream ? [...upstream] : [];
  }

  /**
   * Remove topology entry for a module (e.g. when module is unregistered).
   */
  removeTopology(moduleId: string): void {
    this.topology.delete(moduleId);
  }

  /**
   * Force a module's pending timer to restart with its current interval immediately.
   * Use this after report() adjusts upstream intervals and you want the change
   * to take effect now rather than waiting for the existing setTimeout to fire.
   * No-op if module not registered or scheduler not running.
   */
  forceApplyInterval(moduleId: string): void {
    if (!this.running) return;
    const state = this.entries.get(moduleId);
    if (!state) return;
    this.scheduleNext(moduleId);
  }

  /** Register a module for scheduling. */
  register(entry: SchedulerModuleEntry): void {
    const config = { ...DEFAULT_SCHEDULE, ...entry.config };
    const jitter = 1 + (Math.random() - 0.5) * 0.2; // ±10%
    const currentInterval = clamp(
      config.initialIntervalMs * jitter,
      config.minIntervalMs,
      config.maxIntervalMs,
    );

    // If already running and this module is new, start its chain immediately
    if (this.running && !this.entries.has(entry.id)) {
      const state: SchedulerEntryState = {
        config,
        currentInterval,
        awaitingReport: false,
        bufferCount: 0,
      };
      this.entries.set(entry.id, state);
      this.scheduleNext(entry.id);
    } else {
      this.entries.set(entry.id, {
        config,
        currentInterval,
        awaitingReport: false,
        bufferCount: 0,
      });
    }
  }

  /** Remove a module from scheduling and clean up all related topology references. */
  unregister(moduleId: string): void {
    const state = this.entries.get(moduleId);
    if (!state) return;
    // Only clear timers if scheduler is still running (stop() handles bulk cleanup)
    if (this.running) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      if (state.safetyTimer) {
        clearTimeout(state.safetyTimer);
        state.safetyTimer = undefined;
      }
    }
    this.entries.delete(moduleId);
    // Remove this module's own upstream set
    this.topology.delete(moduleId);
    // Remove this module from all other modules' upstream sets
    for (const upstreamSet of this.topology.values()) {
      upstreamSet.delete(moduleId);
    }
  }

  /**
   * Hot-reload a module's schedule config at runtime.
   * Clears the pending timer, recalculates interval from new config,
   * and restarts the timer chain if the scheduler is running.
   * No-op if the module is not registered.
   */
  reload(moduleId: string, newConfig: ScheduleConfig): void {
    const state = this.entries.get(moduleId);
    if (!state) return;

    // Clear pending timer to avoid stale interval firing
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }

    // Merge with defaults and apply jitter
    const config = { ...DEFAULT_SCHEDULE, ...newConfig };
    const jitter = 1 + (Math.random() - 0.5) * 0.2;
    state.config = config;
    state.currentInterval = clamp(
      config.initialIntervalMs * jitter,
      config.minIntervalMs,
      config.maxIntervalMs,
    );

    // Restart chain if running
    if (this.running) {
      this.scheduleNext(moduleId);
    }
  }

  /** Start all registered module scheduling chains. */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (const moduleId of this.entries.keys()) {
      this.scheduleNext(moduleId);
    }
  }

  /**
   * Stop all scheduling chains, clear timers, and reset pending state.
   * @returns Array of moduleIds that had pending (unreported) ticks —
   *          orchestrator should discard their in-flight results.
   */
  stop(): string[] {
    this.running = false;
    const pendingModules: string[] = [];
    for (const [moduleId, state] of this.entries) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      if (state.safetyTimer) {
        clearTimeout(state.safetyTimer);
        state.safetyTimer = undefined;
      }
      if (state.awaitingReport) {
        pendingModules.push(moduleId);
        state.awaitingReport = false;
      }
    }
    return pendingModules;
  }

  /**
   * Report execution result for a module.
   * - If module has upstream registered: adjusts their intervals via AIMD.
   * - If module has NO upstream (source module): adjusts its OWN interval as fallback.
   * Modules whose interval changed are immediately rescheduled.
   */
  report(report: SchedulerReport): void {
    const state = this.entries.get(report.moduleId);
    if (!state) return;

    state.awaitingReport = false;
    // Clear safety timer — report arrived in time
    if (state.safetyTimer) {
      clearTimeout(state.safetyTimer);
      state.safetyTimer = undefined;
    }

    const upstreamIds = this.topology.get(report.moduleId);
    const { executionTimeMs, bufferEmpty } = report;
    const { currentInterval } = state;

    if (upstreamIds && upstreamIds.size > 0) {
      // Adjust UPSTREAM modules' intervals based on this module's feedback
      for (const upId of upstreamIds) {
        const upState = this.entries.get(upId);
        if (!upState) continue;

        const nextInterval = this.computeAimdInterval(
          upState.currentInterval, executionTimeMs, currentInterval, bufferEmpty,
        );
        const clamped = clamp(nextInterval, upState.config.minIntervalMs, upState.config.maxIntervalMs);

        if (clamped !== upState.currentInterval) {
          upState.currentInterval = clamped;
          if (this.running) {
            this.scheduleNext(upId);
          }
        }
      }
    } else {
      // No upstream: adjust SELF (source module fallback)
      const nextInterval = this.computeAimdInterval(
        currentInterval, executionTimeMs, currentInterval, bufferEmpty,
      );
      const clamped = clamp(nextInterval, state.config.minIntervalMs, state.config.maxIntervalMs);

      if (clamped !== currentInterval) {
        state.currentInterval = clamped;
      }
    }

    // Schedule next tick for THIS module
    if (this.running) {
      this.scheduleNext(report.moduleId);
    }
  }

  /** Get current interval for a module. */
  getInterval(moduleId: string): number | undefined {
    return this.entries.get(moduleId)?.currentInterval;
  }

  /** Check whether the scheduler is currently running. */
  isRunning(): boolean {
    return this.running;
  }

  /** Get IDs of all currently registered modules. */
  getRegisteredModuleIds(): string[] {
    return [...this.entries.keys()];
  }

  /** Check whether a module is registered. */
  hasModule(moduleId: string): boolean {
    return this.entries.has(moduleId);
  }

  /**
   * Get the latest known buffer count for a module.
   * Updated via adjustRates calls from the orchestrator.
   */
  getBufferCount(moduleId: string): number {
    return this.entries.get(moduleId)?.bufferCount ?? 0;
  }

  /**
   * Query whether a module's buffer is empty.
   * @param moduleId - If provided, checks that specific module;
   *                   if omitted, checks whether ALL registered modules have empty buffers.
   */
  isBufferEmpty(moduleId?: string): boolean {
    if (moduleId !== undefined) {
      return this.getBufferCount(moduleId) === 0;
    }
    // Check all modules
    for (const state of this.entries.values()) {
      if (state.bufferCount > 0) return false;
    }
    return true;
  }

  /**
   * Soft rate-limiting (external pressure mechanism):
   * When total buffered items exceed a threshold, slow down "busy" modules
   * (buffer > MODULE_BUFFER_BUSY_THRESHOLD) by multiplying their interval.
   *
   * Difference from report() fallback:
   * - adjustRates: triggered by EXTERNAL buffer pressure (orchestrator calls periodically),
   *   uses gentler RATE_LIMIT_FACTOR (1.5), only slows down (never speeds up).
   * - report() fallback: triggered by SELF execution feedback (every tick),
   *   uses BACKOFF_FACTOR (2.0) / UPSTREAM_SPEEDUP_FACTOR (0.8), can both slow and speed up.
   *
   * Call this from the orchestrator after each Block processing cycle.
   *
   * @param moduleBuffers - Map of moduleId → current buffer item count
   * @param options       - Optional thresholds
   * @returns true if any module was rate-limited this call
   */
  adjustRates(
    moduleBuffers: Map<string, number>,
    options?: AdjustRatesOptions,
  ): boolean {
    const totalThreshold = options?.totalBufferThreshold ?? 50;

    // Update buffer counts and compute total
    let totalBuffer = 0;
    for (const [moduleId, count] of moduleBuffers) {
      const state = this.entries.get(moduleId);
      if (state) {
        state.bufferCount = count;
        totalBuffer += count;
      }
    }

    // Below threshold — nothing to do
    if (totalBuffer <= totalThreshold) return false;

    // Find busy modules: buffer count exceeds per-module threshold
    // Skip modules already at or near maxInterval (>= 80%) — further adjustment is wasteful
    let limited = false;
    for (const [moduleId, count] of moduleBuffers) {
      if (count <= MODULE_BUFFER_BUSY_THRESHOLD) continue;

      const state = this.entries.get(moduleId);
      if (!state) continue;
      if (state.currentInterval >= state.config.maxIntervalMs * 0.8) continue;

      const nextInterval = clamp(
        state.currentInterval * RATE_LIMIT_FACTOR,
        state.config.minIntervalMs,
        state.config.maxIntervalMs,
      );

      if (nextInterval > state.currentInterval) {
        state.currentInterval = nextInterval;
        limited = true;
      }
    }

    return limited;
  }

  // ── Internal ──────────────────────────────────────────────

  /**
   * Compute next interval via AIMD logic (shared by upstream and self-adjustment).
   * @param targetInterval  - The interval of the module being adjusted
   * @param executionTimeMs - How long the reporting module took
   * @param reportInterval  - The reporting module's current interval (for comparison)
   * @param bufferEmpty     - Whether the reporting module's buffer is empty
   */
  private computeAimdInterval(
    targetInterval: number,
    executionTimeMs: number,
    reportInterval: number,
    bufferEmpty: boolean,
  ): number {
    if (executionTimeMs > reportInterval || !bufferEmpty) {
      // Slow or backlog → backoff
      return targetInterval * BACKOFF_FACTOR;
    }
    if (executionTimeMs < reportInterval * FAST_RATIO && bufferEmpty) {
      // Fast and empty → speed up
      return targetInterval * UPSTREAM_SPEEDUP_FACTOR;
    }
    return targetInterval;
  }

  private scheduleNext(moduleId: string): void {
    const state = this.entries.get(moduleId);
    if (!state || !this.running) return;

    // Clear any existing timer
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }

    state.timer = setTimeout(() => {
      state.timer = undefined;

      // If previous tick hasn't reported back, skip this round
      if (state.awaitingReport) {
        // Re-schedule to check again later
        if (this.running) {
          this.scheduleNext(moduleId);
        }
        return;
      }

      state.awaitingReport = true;
      this.onTick(moduleId);

      // Safety timeout: if report() never arrives (e.g. module deadlocked
      // waiting for another module's output), force re-tick to prevent stall.
      if (state.safetyTimer) {
        clearTimeout(state.safetyTimer);
      }
      state.safetyTimer = setTimeout(() => {
        state.safetyTimer = undefined;
        if (state.awaitingReport) {
          // report() never came — force recovery
          state.awaitingReport = false;
          if (this.running) {
            this.scheduleNext(moduleId);
          }
        }
      }, state.currentInterval * SAFETY_TIMEOUT_MULTIPLIER);
    }, state.currentInterval);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
