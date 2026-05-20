import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LockManager } from "../../src/core/lock.js";

describe("LockManager", () => {
  describe("acquire/release", () => {
    it("acquires when free", async () => {
      const lock = new LockManager();
      const unlock = await lock.acquire("test", 0);
      assert.equal(typeof unlock, "function");
      unlock();
    });

    it("second acquire waits for first to release", async () => {
      const lock = new LockManager();
      const order: string[] = [];
      const unlock = await lock.acquire("a", 0);
      const p = lock.acquire("b", 1).then((u) => {
        order.push("b-acquired");
        u();
      });
      order.push("a-holding");
      unlock();
      await p;
      assert.deepEqual(order, ["a-holding", "b-acquired"]);
    });
  });

  describe("priority ordering", () => {
    it("lower priority number wins (0 before 10)", async () => {
      const lock = new LockManager();
      const order: string[] = [];
      const unlock = await lock.acquire("holder", Infinity);
      const lowP = lock.acquire("low", 10).then((u) => { order.push("low"); u(); });
      const highP = lock.acquire("high", 0).then((u) => { order.push("high"); u(); });
      unlock();
      await Promise.all([lowP, highP]);
      assert.deepEqual(order, ["high", "low"]);
    });
  });
});
