import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../../src/core/bus.js";

describe("EventBus", () => {
  describe("emit/on", () => {
    it("listener receives emitted payload", () => {
      const bus = new EventBus();
      let received: unknown = null;
      bus.on("test", (p) => { received = p; });
      bus.emit("test", { value: 42 });
      assert.deepEqual(received, { value: 42 });
    });

    it("multiple listeners all receive the event", () => {
      const bus = new EventBus();
      let count = 0;
      bus.on("test", () => { count++; });
      bus.on("test", () => { count++; });
      bus.emit("test", {});
      assert.equal(count, 2);
    });

    it("listeners on different events don't interfere", () => {
      const bus = new EventBus();
      let a = 0, b = 0;
      bus.on("a", () => { a++; });
      bus.on("b", () => { b++; });
      bus.emit("a", {});
      assert.equal(a, 1);
      assert.equal(b, 0);
    });
  });

  describe("off", () => {
    it("removed listener does not receive events", () => {
      const bus = new EventBus();
      let count = 0;
      const handler = () => { count++; };
      bus.on("test", handler);
      bus.off("test", handler);
      bus.emit("test", {});
      assert.equal(count, 0);
    });

    it("other listeners still work after one is removed", () => {
      const bus = new EventBus();
      let a = 0, b = 0;
      const handlerA = () => { a++; };
      bus.on("test", handlerA);
      bus.on("test", () => { b++; });
      bus.off("test", handlerA);
      bus.emit("test", {});
      assert.equal(a, 0);
      assert.equal(b, 1);
    });

    it("removing non-existent handler does not crash", () => {
      const bus = new EventBus();
      assert.doesNotThrow(() => bus.off("test", () => {}));
    });
  });
});
