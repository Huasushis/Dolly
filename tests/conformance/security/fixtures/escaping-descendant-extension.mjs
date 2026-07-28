// An Extension that creates a descendant which leaves the process group.
//
// `detached: true` makes Node call `setsid(2)` in the child, so the descendant
// gets a new session and a new process group. Control-group membership is
// inherited across that call, so the descendant stays inside the Module control
// group while leaving the process group its parent belongs to. That is the case
// that makes whole-group termination necessary: a signal addressed to the
// launcher's process group cannot reach this descendant, and `cgroup.kill` can.
//
// The descendant ignores SIGTERM and SIGINT so that a signal which does reach it
// is not mistaken for a signal that could not.
//
// Argument 1 is a file this process writes the descendant's process identifier
// to, because standard output carries the Extension protocol.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const descendantPidPath = process.argv[2];
if (!descendantPidPath) {
  process.stderr.write("missing descendant process identifier path\n");
  process.exit(2);
}

const descendant = spawn(
  process.execPath,
  [
    "-e",
    "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); setInterval(() => {}, 1000);",
  ],
  { detached: true, stdio: "ignore" },
);
descendant.unref();

writeFileSync(descendantPidPath, String(descendant.pid), "utf8");

// Stay alive so the control group keeps a member of its own as well. Standard
// input is left untouched: this fixture speaks no protocol, and the scenario
// that needs one uses `extension-process-fixture.mjs` instead.
setInterval(() => {}, 1000);
