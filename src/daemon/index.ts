import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "fs";
import { resolve } from "path";
import { spawn } from "child_process";

const PID_DIR = resolve(import.meta.dirname!, "..", "..", ".dolly", "daemons");

function ensureDir() { if (!existsSync(PID_DIR)) mkdirSync(PID_DIR, { recursive: true }); }

function pidFile(name: string) { return resolve(PID_DIR, `${name}.pid`); }

export function start(name = "default", foreground = false): void {
  ensureDir();
  const pf = pidFile(name);
  if (existsSync(pf)) {
    const pid = parseInt(readFileSync(pf, "utf-8"));
    try { process.kill(pid, 0); console.log(`Already running: ${name} (PID ${pid})`); return; } catch {}
    unlinkSync(pf);
  }
  if (foreground) {
    console.log(`Starting ${name} in foreground...`);
    return; // handled by run()
  }
  const child = spawn("node", ["--import", "tsx", "src/main.ts", "run", `--name=${name}`], {
    cwd: resolve(import.meta.dirname!, "..", ".."),
    detached: true, stdio: "ignore",
  });
  writeFileSync(pf, String(child.pid));
  console.log(`Started ${name} (PID ${child.pid})`);
  child.unref();
}

export function stop(name = "default", force = false): void {
  ensureDir();
  const pf = pidFile(name);
  if (!existsSync(pf)) { console.log(`Not running: ${name}`); return; }
  const pid = parseInt(readFileSync(pf, "utf-8"));
  try { process.kill(pid, force ? "SIGKILL" : "SIGTERM"); unlinkSync(pf); console.log(`Stopped ${name} (PID ${pid})`); }
  catch { unlinkSync(pf); console.log(`Cleaned stale PID for ${name}`); }
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
