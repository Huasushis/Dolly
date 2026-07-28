import { withSynchronousCrossProcessLock } from "../../../../src/core/synchronous-cross-process-lock.js";

const [resourceId] = process.argv.slice(2);
if (!resourceId) throw new Error("synchronous lock fixture resourceId is missing");

const blocker = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
withSynchronousCrossProcessLock({ resourceId }, () => {
  process.stdout.write("READY\n");
  Atomics.wait(blocker, 0, 0);
});
