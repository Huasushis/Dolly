import { InstanceControllerLock } from "../../../../src/core/instance-controller-lock.js";

const [directory, instanceId, controllerId, now] = process.argv.slice(2);
if (!directory || !instanceId || !controllerId || !now) {
  throw new Error("controller lock fixture arguments are missing");
}

const lock = await InstanceControllerLock.acquire({
  directory,
  instanceId,
  controllerId,
  now: () => now,
});

process.stdout.write("READY\n");

const stop = async () => {
  await lock.release();
  process.exit(0);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
setInterval(() => lock.assertHeld(), 1_000);
