/**
 * Case driver for `restart-limit` (SC-04-01).
 *
 * Architecture Decision Record 0009 requires the Core service's restart limit
 * to be finite, and requires exhausting it to leave a *visibly* failed service
 * with Modules disabled rather than an endless restart loop. The handler owns
 * the service side of that; this driver owns the second half, which is the part
 * about Dolly rather than about systemd: once the unit is failed, the
 * production activation decision must refuse to start Modules.
 *
 * It is given the unit name whose restart limit the handler exhausted.
 */
import { decideLinuxModuleActivation } from "../../../../src/core/linux-module-activation.ts";
import {
  Assertions,
  LAUNCHER_SCRIPT_PATH,
  pythonInterpreterPath,
  runDriver,
} from "./module-cgroup-harness.mjs";

const CASE_ID = process.argv[2];
const UNIT_NAME = process.argv[3];
const ACTIVE_STATE = process.argv[4];
const SUB_STATE = process.argv[5];
const RESULT = process.argv[6];
const RESTART_COUNT = Number.parseInt(process.argv[7] ?? "", 10);

await runDriver(async () => {
  const observations = [
    `case ${CASE_ID}`,
    `unit ${UNIT_NAME}`,
    `ActiveState=${ACTIVE_STATE} SubState=${SUB_STATE} Result=${RESULT} NRestarts=${RESTART_COUNT}`,
  ];
  const assertions = new Assertions();

  // The service must be visibly failed rather than still restarting. "failed"
  // is the state an operator and a monitor can both see.
  assertions.equal("the service is visibly failed", "failed", ACTIVE_STATE);
  assertions.equal("the service sub-state is failed", "failed", SUB_STATE);
  assertions.equal(
    "the restart count stayed finite",
    true,
    Number.isSafeInteger(RESTART_COUNT) && RESTART_COUNT >= 0 && RESTART_COUNT < 100,
  );

  // The half that is about Dolly: a failed Core service cannot be used to start
  // Modules. The activation decision must refuse, and must hand out no stop
  // prover, because nothing about this unit has been proven.
  const activation = await decideLinuxModuleActivation({
    unitName: UNIT_NAME,
    mode: "user",
    launcherInterpreterPath: pythonInterpreterPath(),
    launcherScriptPath: LAUNCHER_SCRIPT_PATH,
  });
  observations.push(`activation decision: ${JSON.stringify(activation)}`);
  assertions.equal("Modules are disabled", false, activation.permitted);
  assertions.equal(
    "the refusal names the unverified service binding",
    true,
    (activation.refusals ?? []).some(
      (refusal) => refusal.code === "MODULE_ACTIVATION_SERVICE_UNVERIFIED",
    ),
  );
  assertions.equal("no stop prover is handed out", true, activation.stopProver === undefined);

  if (!assertions.allHold) {
    return {
      status: "failed",
      reason: "expected-visibly-failed-service-with-modules-disabled",
      observations: [...observations, ...assertions.lines()],
    };
  }
  return {
    status: "passed",
    reason: "restart-limit-exhausted-service-failed-modules-disabled",
    observations: [...observations, ...assertions.lines()],
  };
});
