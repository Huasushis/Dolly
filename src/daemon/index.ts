import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "fs";
import { resolve } from "path";

import { spawn } from "child_process";

const PID_DIR = resolve(import.meta.dirname!, "..", "..", ".dolly", "daemons");

function ensureDir() { if (!existsSync(PID_DIR)) mkdirSync(PID_DIR, { recursive: true }); }

export function pidFile(name: string) { return resolve(PID_DIR, `${name}.pid`); }

export function isRunning(name = "default"): boolean {
  ensureDir();
  const pf = pidFile(name);
  if (!existsSync(pf)) return false;
  try { process.kill(parseInt(readFileSync(pf, "utf-8")), 0); return true; } catch { return false; }
}

export function start(name = "default"): void {
  ensureDir();
  const pf = pidFile(name);
  if (existsSync(pf)) {
    const pid = parseInt(readFileSync(pf, "utf-8"));
    try { process.kill(pid, 0); return; } catch {}
    unlinkSync(pf);
  }
  const child = spawn(process.execPath, ["--import", "tsx/esm", "src/main.ts", "--daemon", `--name=${name}`], {
    cwd: resolve(import.meta.dirname!, "..", ".."),
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  writeFileSync(pf, String(child.pid!));
  child.unref();
}

export async function stop(name = "default", force = false): Promise<void> {
  ensureDir();
  const pf = pidFile(name);
  if (!existsSync(pf)) return;
  const pid = parseInt(readFileSync(pf, "utf-8"));
  if (force) {
    try { process.kill(pid, "SIGKILL"); } catch {}
    unlinkSync(pf);
    return;
  }
  // Graceful: send shutdown via TCP relay (cross-platform, no SIGTERM issues)
  try {
    const portPath = resolve(PID_DIR, "..", "sockets", `${name}.port`);
    if (existsSync(portPath)) {
      const port = parseInt(readFileSync(portPath, "utf-8"));
      const { connect } = await import("net");
      await new Promise<void>((resolve) => {
        const s = connect(port, "127.0.0.1", () => {
          s.write(JSON.stringify({ cmd: "__daemon__", args: ["shutdown"] }) + "\n");
          setTimeout(() => { s.destroy(); resolve(); }, 3000);
        });
        s.on("error", () => { try { process.kill(pid, "SIGKILL"); } catch {}; try { unlinkSync(pf); } catch {}; resolve(); });
      });
    }
  } catch {}
  try { unlinkSync(pf); } catch {}
}

export function status(name?: string): void {
  ensureDir();
  if (!existsSync(PID_DIR)) { console.log("No daemons running."); return; }
  const files = name ? [pidFile(name)] : readdirSync(PID_DIR).map((f) => resolve(PID_DIR, f));
  for (const pf of files) {
    if (!existsSync(pf)) { if (name) console.log(`Not running: ${name}`); continue; }
    const n = pf.replace(/\.pid$/, "").split(/[\\/]/).pop();
    const pid = parseInt(readFileSync(pf, "utf-8"));
    try { process.kill(pid, 0); console.log(`${n}: running (PID ${pid})`); }
    catch { unlinkSync(pf); console.log(`${n}: stale PID cleaned`); }
  }
}
