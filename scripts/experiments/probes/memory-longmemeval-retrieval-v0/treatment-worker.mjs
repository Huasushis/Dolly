import { parentPort } from "node:worker_threads";

import { evaluateTreatmentQuestion } from "./treatment.mjs";

if (parentPort === null) throw new Error("treatment worker requires a parent port");

parentPort.on("message", ({ index, input, selectedWeights }) => {
  try {
    parentPort.postMessage({
      index,
      result: evaluateTreatmentQuestion(input, selectedWeights),
    });
  } catch (error) {
    parentPort.postMessage({ index, error: String(error instanceof Error ? error.stack : error) });
  }
});
