/**
 * In-service probe for the Linux Core service binding integration test.
 *
 * It runs as the main process of one transient systemd service, inspects its
 * own Core service binding, and writes one line of JavaScript Object Notation
 * (JSON) to standard output holding both the raw observation and the
 * verification result. The test asserts on that line; the probe itself asserts
 * nothing and always exits successfully so the transient unit stops normally.
 */

import {
  collectCoreServiceObservation,
  verifyCoreServiceBinding,
} from "../../../../src/core/linux-core-service-binding.js";

const unitName = process.argv[2] ?? "";
const mode = process.argv[3] === "system" ? "system" : "user";

const collected = await collectCoreServiceObservation({
  unitName,
  mode,
  queryTimeoutMs: 5_000,
  overallTimeoutMs: 15_000,
});

const payload = collected.observed
  ? {
      pid: process.pid,
      observed: true,
      observation: collected.observation,
      result: verifyCoreServiceBinding(collected.observation),
    }
  : { pid: process.pid, observed: false, failures: collected.failures };

process.stdout.write(`${JSON.stringify(payload)}\n`);
