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
    try { process.kill(pid, 0); return; } catch {} // already running
    unlinkSync(pf); // stale PID
  }
  const child = spawn("node", ["--import", "tsx/esm", "src/main.ts", "--daemon", `--name=${name}`], {
    cwd: resolve(import.meta.dirname!, "..", ".."),
    detached: true, stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (d) => process.stderr.write(`[daemon] ${d}`));
  writeFileSync(pf, String(child.pid!));
  child.unref();
}

export function stop(name = "default", force = false): void {
  ensureDir();
  const pf = pidFile(name);
  if (!existsSync(pf)) return;
  const pid = parseInt(readFileSync(pf, "utf-8"));
  try { process.kill(pid, force ? "SIGKILL" : "SIGTERM"); unlinkSync(pf); }
  catch { unlinkSync(pf); }
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
