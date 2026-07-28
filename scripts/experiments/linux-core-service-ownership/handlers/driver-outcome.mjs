/**
 * Turns a case driver's single JSON result line into the two things the runner
 * needs: the `process-and-cgroup-observations` artifact, and one
 * `status<TAB>reason` line on standard output.
 *
 * A driver that produced no readable result is reported inconclusive. The
 * protocol never lets a missing result look like a pass, so this helper has no
 * way to report one.
 */
import { appendFileSync, readFileSync } from "node:fs";

const [resultFile, observationsFile] = process.argv.slice(2);

function lastJsonObjectLine(text) {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {
      // Keep looking further back.
    }
  }
  return undefined;
}

let result;
try {
  result = lastJsonObjectLine(readFileSync(resultFile, "utf8"));
} catch {
  result = undefined;
}

if (result === undefined || typeof result.status !== "string") {
  appendFileSync(observationsFile, "the case driver produced no readable result line\n");
  process.stdout.write("inconclusive\tdriver-produced-no-result\n");
  process.exit(0);
}

const observations = Array.isArray(result.observations) ? result.observations : [];
appendFileSync(observationsFile, `${observations.join("\n")}\n`);
process.stdout.write(`${result.status}\t${result.reason ?? "no-reason"}\n`);
