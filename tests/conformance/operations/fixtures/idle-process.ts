/**
 * A plain long-lived process used by process-identity tests.
 *
 * Tests record its real process identifier in a durable process record and
 * then assert that unverifiable identity never produces a signal: the process
 * must still be alive after reconciliation refuses to act on it.
 */

process.stdout.write(`READY ${process.pid}\n`);
const keepAlive = setInterval(() => undefined, 1_000);
const stop = (): void => {
  clearInterval(keepAlive);
  process.exit(0);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
