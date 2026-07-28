/**
 * Reads the kernel `cgroup.procs` file of a prepared Module cgroup.
 *
 * Architecture Decision Record (ADR) 0009 requires Core to verify launcher
 * membership from kernel cgroup files rather than from the launcher's own
 * report, so this reader is the evidence source for that check.
 */
import { readFile } from "node:fs/promises";
import { assertModuleCgroupPath } from "./launcher-control-protocol.js";

export async function readModuleCgroupProcessIds(
  moduleCgroupPath: string,
): Promise<readonly number[]> {
  assertModuleCgroupPath(moduleCgroupPath);
  const contents = await readFile(`${moduleCgroupPath}/cgroup.procs`, "utf8");
  const processIds: number[] = [];
  for (const line of contents.split("\n")) {
    const text = line.trim();
    if (text.length === 0) continue;
    if (!/^[0-9]{1,10}$/.test(text)) {
      throw new Error("cgroup.procs contains a line that is not a process identifier");
    }
    const processId = Number.parseInt(text, 10);
    if (!Number.isSafeInteger(processId) || processId < 1) {
      throw new Error("cgroup.procs contains an out-of-range process identifier");
    }
    processIds.push(processId);
  }
  return processIds;
}
