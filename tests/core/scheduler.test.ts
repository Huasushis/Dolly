import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Scheduler } from "../../src/core/scheduler.js";

describe("Scheduler", () => {
  let scheduler: Scheduler;
  let onTick: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    onTick = vi.fn();
    scheduler = new Scheduler(onTick);
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  describe("basic scheduling", () => {
    it("should fire onTick after interval", () => {
      scheduler.register({
        id: "m1",
        config: { initialIntervalMs: 1000, minIntervalMs: 500, maxIntervalMs: 5000 },
      });
      scheduler.start();

      vi.advanceTimersByTime(1200);
      expect(onTick).toHaveBeenCalledWith("m1");
    });

    it("should not fire before interval", () => {
      scheduler.register({
        id: "m1",
        config: { initialIntervalMs: 1000, minIntervalMs: 500, maxIntervalMs: 5000 },
      });
      scheduler.start();

      vi.advanceTimersByTime(500);
      expect(onTick).not.toHaveBeenCalled();
    });
  });

  describe("AIMD behavior", () => {
    it("should increase upstream interval on overload (slow execution)", () => {
      scheduler.register({
        id: "upstream",
        config: { initialIntervalMs: 1000, minIntervalMs: 500, maxIntervalMs: 60000 },
      });
      scheduler.register({
        id: "downstream",
        config: { initialIntervalMs: 2000, minIntervalMs: 500, maxIntervalMs: 60000 },
      });
      scheduler.setTopology("downstream", ["upstream"]);

      const upstreamIntervalBefore = scheduler.getInterval("upstream")!;

      // Report overload: execution time > downstream interval, buffer not empty
      scheduler.report({
        moduleId: "downstream",
        executionTimeMs: 3000, // > downstream interval
        bufferEmpty: false,
      });

      const upstreamIntervalAfter = scheduler.getInterval("upstream")!;
      // BACKOFF_FACTOR = 2.0, so interval should increase
      expect(upstreamIntervalAfter).toBeGreaterThan(upstreamIntervalBefore);
    });

    it("should decrease upstream interval on underload (fast execution + empty buffer)", () => {
      scheduler.register({
        id: "upstream",
        config: { initialIntervalMs: 2000, minIntervalMs: 500, maxIntervalMs: 60000 },
      });
      scheduler.register({
        id: "downstream",
        config: { initialIntervalMs: 2000, minIntervalMs: 500, maxIntervalMs: 60000 },
      });
      scheduler.setTopology("downstream", ["upstream"]);

      const upstreamIntervalBefore = scheduler.getInterval("upstream")!;

      // Report underload: execution time < interval * 0.5, buffer empty
      scheduler.report({
        moduleId: "downstream",
        executionTimeMs: 100, // < downstream interval * 0.5
        bufferEmpty: true,
      });

      const upstreamIntervalAfter = scheduler.getInterval("upstream")!;
      // UPSTREAM_SPEEDUP_FACTOR = 0.8, so interval should decrease
      expect(upstreamIntervalAfter).toBeLessThan(upstreamIntervalBefore);
    });
  });

  describe("setTopology", () => {
    it("should register and retrieve topology", () => {
      scheduler.setTopology("B", ["A"]);
      expect(scheduler.getTopology("B")).toEqual(["A"]);
    });

    it("should return empty array for unregistered topology", () => {
      expect(scheduler.getTopology("unknown")).toEqual([]);
    });

    it("should report affect correct upstream based on topology", () => {
      scheduler.register({
        id: "A",
        config: { initialIntervalMs: 1000, minIntervalMs: 500, maxIntervalMs: 60000 },
      });
      scheduler.register({
        id: "B",
        config: { initialIntervalMs: 1000, minIntervalMs: 500, maxIntervalMs: 60000 },
      });
      scheduler.register({
        id: "C",
        config: { initialIntervalMs: 2000, minIntervalMs: 500, maxIntervalMs: 60000 },
      });

      scheduler.setTopology("C", ["A"]); // Only A is upstream of C

      const bBefore = scheduler.getInterval("B")!;

      scheduler.report({
        moduleId: "C",
        executionTimeMs: 5000,
        bufferEmpty: false,
      });

      // B should NOT be affected (not upstream of C)
      const bAfter = scheduler.getInterval("B")!;
      expect(bAfter).toBe(bBefore);

      // A should be affected
      const aAfter = scheduler.getInterval("A")!;
      expect(aAfter).toBeGreaterThan(1000);
    });
  });

  describe("stop", () => {
    it("should return pending modules that had awaiting reports", () => {
      scheduler.register({
        id: "m1",
        config: { initialIntervalMs: 100, minIntervalMs: 50, maxIntervalMs: 5000 },
      });
      scheduler.start();

      // Fire the tick
      vi.advanceTimersByTime(200);
      // Now m1 is awaitingReport = true

      const pending = scheduler.stop();
      expect(pending).toContain("m1");
    });

    it("should return empty array when no pending modules", () => {
      scheduler.register({
        id: "m1",
        config: { initialIntervalMs: 1000, minIntervalMs: 500, maxIntervalMs: 5000 },
      });
      // Don't start, so no timers fired
      const pending = scheduler.stop();
      expect(pending).toEqual([]);
    });
  });

  describe("reload", () => {
    it("should hot-reload module config", () => {
      scheduler.register({
        id: "m1",
        config: { initialIntervalMs: 2000, minIntervalMs: 500, maxIntervalMs: 60000 },
      });

      scheduler.reload("m1", { initialIntervalMs: 500, minIntervalMs: 100, maxIntervalMs: 30000 });

      const interval = scheduler.getInterval("m1")!;
      // Should be around 500ms (with ±10% jitter)
      expect(interval).toBeGreaterThanOrEqual(450);
      expect(interval).toBeLessThanOrEqual(550);
    });

    it("should be no-op for unregistered module", () => {
      expect(() => {
        scheduler.reload("unknown", { initialIntervalMs: 1000, minIntervalMs: 500, maxIntervalMs: 5000 });
      }).not.toThrow();
    });
  });

  describe("utility methods", () => {
    it("getRegisteredModuleIds returns all registered IDs", () => {
      scheduler.register({ id: "a", config: { initialIntervalMs: 1000, minIntervalMs: 500, maxIntervalMs: 5000 } });
      scheduler.register({ id: "b", config: { initialIntervalMs: 1000, minIntervalMs: 500, maxIntervalMs: 5000 } });
      expect(scheduler.getRegisteredModuleIds()).toEqual(["a", "b"]);
    });

    it("hasModule checks registration", () => {
      scheduler.register({ id: "a", config: { initialIntervalMs: 1000, minIntervalMs: 500, maxIntervalMs: 5000 } });
      expect(scheduler.hasModule("a")).toBe(true);
      expect(scheduler.hasModule("b")).toBe(false);
    });

    it("unregister removes module and topology", () => {
      scheduler.register({ id: "a", config: { initialIntervalMs: 1000, minIntervalMs: 500, maxIntervalMs: 5000 } });
      scheduler.setTopology("a", ["b"]);
      scheduler.unregister("a");
      expect(scheduler.hasModule("a")).toBe(false);
      expect(scheduler.getTopology("a")).toEqual([]);
    });

    it("isRunning reflects state", () => {
      expect(scheduler.isRunning()).toBe(false);
      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);
      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
    });
  });
});
