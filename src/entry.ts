import { readdirSync, existsSync, readFileSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadConfig } from "./config.js";
import { createLogger } from "./core/logger.js";
import { Orchestrator } from "./core/orchestrator.js";
import type { DollyExtension } from "./sdk/types.js";

// ── CLI 参数解析 ────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0] ?? "run";
const configFlag = args.find((a) => a.startsWith("--config="));
const configPath = configFlag
  ? configFlag.split("=").slice(1).join("=")
  : resolve("dolly.json");

// ── Daemon API 通信 ─────────────────────────────────────────────

function getDaemonUrl(): string {
  const cfgDir = resolve(".dolly", "daemon", "config.json");
  if (!existsSync(cfgDir)) {
    console.error("Daemon not configured. Run 'dolly daemon start' first.");
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(cfgDir, "utf-8")) as { port: number };
  return `http://localhost:${cfg.port}`;
}

function getDaemonAuth(): string {
  const cfgDir = resolve(".dolly", "daemon", "config.json");
  const cfg = JSON.parse(readFileSync(cfgDir, "utf-8")) as { auth: { user: string; password: string } };
  return Buffer.from(`${cfg.auth.user}:${cfg.auth.password}`).toString("base64");
}

async function daemonApi(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = getDaemonUrl();
  const auth = getDaemonAuth();
  const opts: RequestInit = {
    method,
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${url}${path}`, opts);
  return res.json();
}

// ── 命令分发 ────────────────────────────────────────────────────

switch (command) {
  case "run":
    await run(configPath);
    break;
  case "start": {
    const result = await daemonApi("POST", "/api/instances/start", { configPath });
    console.log("Instance started:", JSON.stringify(result, null, 2));
    break;
  }
  case "stop": {
    const result = await daemonApi("POST", "/api/instances/stop", { configPath });
    console.log("Instance stopped:", JSON.stringify(result, null, 2));
    break;
  }
  case "status": {
    const result = await daemonApi("GET", "/api/instances");
    const instances = result as Array<{ configPath: string; status: string; pid: number; port: number }>;
    if (instances.length === 0) {
      console.log("No instances registered.");
    } else {
      console.log("Instances:");
      for (const i of instances) {
        console.log(`  [${i.status}] ${i.configPath} (pid=${i.pid}, port=${i.port})`);
      }
    }
    break;
  }
  case "daemon":
    console.log("Daemon is a separate process. Run: node --import tsx/esm daemon/index.ts");
    break;
  default:
    console.log("Usage: dolly [run|start|stop|status|daemon] [--config=<path>]");
}

// ── run 命令实现 ────────────────────────────────────────────────

async function run(cfgPath: string): Promise<void> {
  const config = loadConfig(cfgPath);
  const logger = createLogger({ level: config.logging.level });

  logger.info({ name: config.name, configPath: cfgPath }, "Starting Dolly instance");

  const orchestrator = new Orchestrator(config);

  // 加载 extensions
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const extensionsDir = join(projectRoot, "extensions");
  const extensions = await loadExtensions(extensionsDir);

  for (const ext of extensions) {
    orchestrator.loadExtension(ext);
    logger.info({ extension: ext.name }, "Loaded extension");
  }

  // 初始化并启动
  await orchestrator.init();
  orchestrator.start();
  logger.info("Dolly instance running");

  // 优雅关闭
  const shutdown = async () => {
    logger.info("Shutting down...");
    await orchestrator.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 保持进程运行
  await new Promise(() => {});
}

// ── Extension 动态加载 ──────────────────────────────────────────

async function loadExtensions(extensionsDir: string): Promise<DollyExtension[]> {
  const exts: DollyExtension[] = [];
  if (!existsSync(extensionsDir)) return exts;

  const dirs = readdirSync(extensionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const dir of dirs) {
    const entryPath = resolve(extensionsDir, dir, "index.js");
    try {
      const mod = await import(entryPath);
      if (mod.default) {
        exts.push(mod.default as DollyExtension);
      }
    } catch (err) {
      console.error(`Failed to load extension ${dir}:`, err);
    }
  }

  return exts;
}
