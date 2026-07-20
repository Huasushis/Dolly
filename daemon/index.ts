import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { handleRequest } from "./api.js";

// ── Types ─────────────────────────────────────────────────────────

export interface InstanceRecord {
  configPath: string;
  pid: number;
  port: number;
  status: "running" | "stopped";
  startedAt: number;
}

export interface DaemonConfig {
  port: number;
  auth: { user: string; password: string };
}

// ── Daemon ────────────────────────────────────────────────────────

export class Daemon {
  private config: DaemonConfig;
  private instances: Map<string, InstanceRecord> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private configDir: string;
  private registryPath: string;
  private server: Server | null = null;

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
        // 所有记录的实例在 daemon 启动时标记为 stopped
        rec.status = "stopped";
        this.instances.set(rec.configPath, rec);
      }
    } catch {
      // corrupted registry, start fresh
    }
  }

  private saveRegistry(): void {
    const data = [...this.instances.values()];
    writeFileSync(this.registryPath, JSON.stringify(data, null, 2));
  }

  // ── Instance Management ───────────────────────────────────────

  startInstance(configPath: string): InstanceRecord {
    const absPath = resolve(configPath);

    // 如果已在运行，先停止
    if (this.processes.has(absPath)) {
      this.stopInstance(absPath);
    }

    const port = 10000 + Math.floor(Math.random() * 50000);

    const child = spawn(
      "node",
      ["--import", "tsx/esm", "src/entry.ts", "run", `--config=${absPath}`, `--port=${port}`],
      {
        cwd: process.cwd(),
        stdio: "pipe",
        detached: false,
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
    this.saveRegistry();

    child.on("exit", (code) => {
      console.log(`[daemon] Instance ${absPath} exited with code ${code}`);
      const rec = this.instances.get(absPath);
      if (rec) {
        rec.status = "stopped";
        this.saveRegistry();
      }
      this.processes.delete(absPath);
    });

    console.log(`[daemon] Started instance: ${absPath} (pid=${record.pid}, port=${port})`);
    return record;
  }

  stopInstance(configPath: string): void {
    const absPath = resolve(configPath);
    const child = this.processes.get(absPath);
    if (!child) {
      console.log(`[daemon] Instance ${absPath} is not running`);
      return;
    }

    child.kill("SIGTERM");
    this.processes.delete(absPath);

    const rec = this.instances.get(absPath);
    if (rec) {
      rec.status = "stopped";
      this.saveRegistry();
    }

    console.log(`[daemon] Stopped instance: ${absPath}`);
  }

  getStatus(): InstanceRecord[] {
    return [...this.instances.values()];
  }

  // ── Server ────────────────────────────────────────────────────

  start(): void {
    this.server = createServer((req, res) => {
      handleRequest(req, res, this);
    });

    this.server.listen(this.config.port, () => {
      console.log(`[daemon] Listening on http://localhost:${this.config.port}`);
      console.log(`[daemon] Auth: ${this.config.auth.user} / ${this.config.auth.password}`);
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
    // 停止所有实例
    for (const configPath of this.processes.keys()) {
      this.stopInstance(configPath);
    }

    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

// ── Entry ─────────────────────────────────────────────────────────

const daemon = new Daemon();
daemon.start();
