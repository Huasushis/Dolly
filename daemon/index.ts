import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { handleRequest, handleUpgrade, broadcaster } from "./api.js";
import { IpcServer, IpcClient, getIpcPath } from "../src/core/ipc.js";

// ── Types ─────────────────────────────────────────────────────────

export interface InstanceRecord {
  configPath: string;
  pid: number;
  port: number;
  status: "running" | "stopped" | "failed";
  startedAt: number;
}

export interface DaemonConfig {
  port: number;
  auth: { user: string; password: string };
}

// ── Constants ─────────────────────────────────────────────────────

const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 3000;
const COOLDOWN_MS = 60_000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const MAX_HEALTH_FAILURES = 3;
const PORT_BASE = 10_000;
const PORT_SCAN_RANGE = 50_000;

// ── Helpers ───────────────────────────────────────────────────────

function writePidFile(configDir: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(resolve(configDir, "pid"), String(process.pid));
}

function removePidFile(configDir: string): void {
  try {
    unlinkSync(resolve(configDir, "pid"));
  } catch {
    /* ignore */
  }
}

/** F7: TCP port probe — try to bind, on failure try next port */
async function findAvailablePort(start: number): Promise<number> {
  for (let port = start; port < start + PORT_SCAN_RANGE; port++) {
    const free = await new Promise<boolean>((res) => {
      const srv = net.createServer();
      srv.once("error", () => res(false));
      srv.once("listening", () => {
        srv.close(() => res(true));
      });
      srv.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new Error("No available port found");
}

// ── Daemon ────────────────────────────────────────────────────────

export class Daemon {
  private config: DaemonConfig;
  private instances: Map<string, InstanceRecord> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private configDir: string;
  private registryPath: string;
  private server: Server | null = null;
  private ipcServer: IpcServer | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  // F6: auto-restart tracking
  private restartCounts: Map<string, number> = new Map();
  private firstCrashAt: Map<string, number> = new Map();
  private restartTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private intentionalStop: Set<string> = new Set();

  // F2: health check failure tracking
  private healthFailures: Map<string, number> = new Map();

  constructor() {
    this.configDir = resolve(".dolly", "daemon");
    this.registryPath = resolve(this.configDir, "registry.json");
    this.config = this.loadOrCreateConfig();
    this.loadRegistry();
  }

  get auth(): DaemonConfig["auth"] {
    return this.config.auth;
  }

  get port(): number {
    return this.config.port;
  }

  /** Broadcast a log line to all WebSocket clients */
  broadcastLog(configPath: string, level: string, line: string): void {
    broadcaster.send({
      type: "log",
      data: { configPath, level, line, ts: Date.now() },
    });
  }

  // ── Config & Registry ─────────────────────────────────────────

  private loadOrCreateConfig(): DaemonConfig {
    const configPath = resolve(this.configDir, "config.json");
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, "utf-8")) as DaemonConfig;
    }

    mkdirSync(this.configDir, { recursive: true });
    const config: DaemonConfig = {
      port: 9800,
      auth: {
        user: "admin",
        password: randomBytes(12).toString("base64url"),
      },
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`[daemon] Config created at ${configPath}`);
    console.log(`[daemon] Credentials: ${config.auth.user} / ${config.auth.password}`);
    return config;
  }

  private loadRegistry(): void {
    if (!existsSync(this.registryPath)) return;
    try {
      const data = JSON.parse(readFileSync(this.registryPath, "utf-8")) as InstanceRecord[];
      for (const rec of data) {
        rec.status = "stopped";
        this.instances.set(rec.configPath, rec);
      }
    } catch {
      /* corrupted registry — start fresh */
    }
  }

  private saveRegistry(): void {
    writeFileSync(this.registryPath, JSON.stringify([...this.instances.values()], null, 2));
  }

  // ── IPC Server (F1) ────────────────────────────────────────────

  private async setupIpc(): Promise<void> {
    const ipcPath = getIpcPath("daemon");
    this.ipcServer = new IpcServer(ipcPath, (command, params) => {
      switch (command) {
        case "ping":
          return { pong: true, ts: Date.now() };
        case "status":
          return this.getStatus();
        case "config.reload": {
          const cfgPath = params?.configPath as string | undefined;
          if (cfgPath) void this.restartInstance(cfgPath);
          return { ok: true };
        }
        default:
          throw new Error(`Unknown IPC command: ${command}`);
      }
    });
    await this.ipcServer.listen();
    console.log(`[daemon] IPC listening on ${ipcPath}`);
  }

  // ── Instance Management ───────────────────────────────────────

  async startInstance(configPath: string): Promise<InstanceRecord> {
    const absPath = resolve(configPath);

    // 如果已在运行，先停止
    if (this.processes.has(absPath)) {
      this.stopInstance(absPath);
    }

    this.intentionalStop.delete(absPath);

    // F7: use TCP port probe to find a truly available port
    const port = await findAvailablePort(PORT_BASE);

    const child = spawn(
      "node",
      ["--import", "tsx/esm", "src/entry.ts", "run", `--config=${absPath}`, `--port=${port}`],
      {
        cwd: process.cwd(),
        stdio: "pipe",
        detached: false,
        env: { ...process.env, DOLLY_DAEMON_PORT: String(this.config.port) },
      },
    );

    const record: InstanceRecord = {
      configPath: absPath,
      pid: child.pid ?? 0,
      port,
      status: "running",
      startedAt: Date.now(),
    };

    this.instances.set(absPath, record);
    this.processes.set(absPath, child);
    this.restartCounts.set(absPath, 0);
    this.firstCrashAt.delete(absPath);
    this.healthFailures.set(absPath, 0);
    this.saveRegistry();

    child.on("exit", (code) => {
      console.log(`[daemon] Instance ${absPath} exited with code ${code}`);
      const rec = this.instances.get(absPath);
      if (rec) {
        rec.status = "stopped";
        this.saveRegistry();
        broadcaster.send({ type: "instances", data: this.getStatus() });
      }
      this.processes.delete(absPath);
      // F6: auto-restart on abnormal exit
      this.handleAutoRestart(absPath, code);
    });

    // F5: capture instance output for log streaming
    child.stdout?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        if (line.trim()) this.broadcastLog(absPath, "info", line.trimEnd());
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        if (line.trim()) this.broadcastLog(absPath, "error", line.trimEnd());
      }
    });

    console.log(`[daemon] Started instance: ${absPath} (pid=${record.pid}, port=${port})`);
    return record;
  }

  /** F6: Auto-restart logic */
  private handleAutoRestart(absPath: string, exitCode: number | null): void {
    if (this.intentionalStop.has(absPath)) {
      this.intentionalStop.delete(absPath);
      return;
    }

    // exitCode === 0 is a normal exit, don't restart
    if (exitCode === 0) return;

    const count = this.restartCounts.get(absPath) ?? 0;

    if (count >= MAX_RESTARTS) {
      console.log(`[daemon] Instance ${absPath} exceeded max restarts (${MAX_RESTARTS}), giving up`);
      const rec = this.instances.get(absPath);
      if (rec) {
        rec.status = "failed";
        this.saveRegistry();
        broadcaster.send({ type: "instances", data: this.getStatus() });
      }
      return;
    }

    // Cooldown: if first crash was > COOLDOWN_MS ago, reset counter
    const firstCrash = this.firstCrashAt.get(absPath);
    const now = Date.now();
    if (!firstCrash || now - firstCrash > COOLDOWN_MS) {
      this.firstCrashAt.set(absPath, now);
      this.restartCounts.set(absPath, 0);
    }

    const attempt = (this.restartCounts.get(absPath) ?? 0) + 1;
    this.restartCounts.set(absPath, attempt);

    console.log(
      `[daemon] Restarting ${absPath} in ${RESTART_DELAY_MS}ms (attempt ${attempt}/${MAX_RESTARTS})`,
    );

    const timer = setTimeout(() => {
      this.restartTimers.delete(absPath);
      this.startInstance(absPath).catch((err) => {
        console.error(`[daemon] Failed to restart ${absPath}:`, err);
      });
    }, RESTART_DELAY_MS);

    this.restartTimers.set(absPath, timer);
  }

  stopInstance(configPath: string): void {
    const absPath = resolve(configPath);
    const child = this.processes.get(absPath);

    this.intentionalStop.add(absPath);

    // Clear any pending restart timer
    const timer = this.restartTimers.get(absPath);
    if (timer) {
      clearTimeout(timer);
      this.restartTimers.delete(absPath);
    }

    if (child) {
      child.kill("SIGTERM");
      this.processes.delete(absPath);
    } else {
      // F7: PID fallback — if process handle is lost, kill by recorded PID
      const rec = this.instances.get(absPath);
      if (rec && rec.pid > 0) {
        try {
          process.kill(rec.pid, "SIGTERM");
        } catch {
          /* process already gone */
        }
      }
    }

    const rec = this.instances.get(absPath);
    if (rec) {
      rec.status = "stopped";
      this.saveRegistry();
      broadcaster.send({ type: "instances", data: this.getStatus() });
    }

    console.log(`[daemon] Stopped instance: ${absPath}`);
  }

  async restartInstance(configPath: string): Promise<InstanceRecord> {
    const absPath = resolve(configPath);
    this.stopInstance(absPath);
    this.intentionalStop.delete(absPath);
    return this.startInstance(absPath);
  }

  getStatus(): InstanceRecord[] {
    return [...this.instances.values()];
  }

  // ── Health Check (F2) ─────────────────────────────────────────

  private startHealthCheck(): void {
    this.healthTimer = setInterval(() => {
      void this.runHealthChecks();
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private async runHealthChecks(): Promise<void> {
    for (const [absPath, child] of this.processes) {
      if (child.exitCode !== null) continue; // already exited

      const ipcPath = getIpcPath(absPath);
      const client = new IpcClient(ipcPath);

      let healthy = false;
      try {
        await client.connect(2000);
        await client.request("ping", undefined, HEALTH_CHECK_TIMEOUT_MS);
        healthy = true;
      } catch {
        healthy = false;
      } finally {
        client.close();
      }

      if (healthy) {
        this.healthFailures.set(absPath, 0);
      } else {
        const failures = (this.healthFailures.get(absPath) ?? 0) + 1;
        this.healthFailures.set(absPath, failures);
        console.warn(`[daemon] Health check failed for ${absPath} (${failures}/${MAX_HEALTH_FAILURES})`);

        if (failures >= MAX_HEALTH_FAILURES) {
          console.log(`[daemon] Instance ${absPath} unhealthy ${MAX_HEALTH_FAILURES}x, restarting`);
          this.healthFailures.set(absPath, 0);
          const rec = this.instances.get(absPath);
          if (rec) {
            rec.status = "stopped";
            this.saveRegistry();
          }
          child.kill("SIGTERM");
          this.processes.delete(absPath);
          // F6 restart logic will be triggered by the exit event
        }
      }
    }
  }

  // ── Server ────────────────────────────────────────────────────

  start(): void {
    // F1: start IPC server
    void this.setupIpc().catch((err) => {
      console.error("[daemon] IPC setup failed:", err);
    });

    // F2: start health check loop
    this.startHealthCheck();

    this.server = createServer((req, res) => {
      handleRequest(req, res, this);
    });

    // F5: WebSocket upgrade handling
    this.server.on("upgrade", (req, socket, head) => {
      handleUpgrade(req, socket as any, head, this);
    });

    // F7: probe for available port
    void findAvailablePort(this.config.port).then((port) => {
      this.config.port = port;
      this.server!.listen(port, () => {
        writePidFile(this.configDir);
        console.log(`[daemon] Listening on http://localhost:${port}`);
        console.log(`[daemon] Auth: ${this.config.auth.user} / ${this.config.auth.password}`);
      });
    });

    const shutdown = () => {
      console.log("[daemon] Shutting down...");
      this.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  stop(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }

    this.ipcServer?.close();

    for (const configPath of [...this.processes.keys()]) {
      this.stopInstance(configPath);
    }

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    removePidFile(this.configDir);
  }
}

// ── Entry ─────────────────────────────────────────────────────────

const daemon = new Daemon();
daemon.start();
