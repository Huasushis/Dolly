import { writeFileSync } from "node:fs";
import { workerData } from "node:worker_threads";

import { recomputeTreatmentForTest } from "./verify.mjs";

const signal = new Int32Array(workerData.signal);
try {
  const results = workerData.jobs.map((job) => ({
    key: job.key,
    result: recomputeTreatmentForTest(job.input, job.selectedWeights),
  }));
  writeFileSync(workerData.outputPath, JSON.stringify({ results }));
} catch (error) {
  writeFileSync(workerData.outputPath, JSON.stringify({
    error: String(error instanceof Error ? error.stack : error),
  }));
} finally {
  Atomics.add(signal, 0, 1);
  Atomics.notify(signal, 0);
}
