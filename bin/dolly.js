#!/usr/bin/env -S node --import tsx/esm
import { start, stop, status, isRunning } from "../src/daemon/index.js";
import { waitForPort } from "../src/daemon/attach.js";
import { connect } from "net";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cmd = process.argv[2];
const args = process.argv.slice(3);
const nameArg = args.find((a) => a.startsWith("--name="));
const instanceName = nameArg ? nameArg.split("=")[1] : "default";
const force = args.includes("-f") || args.includes("--force");
const configArg = args.find((a) => a.startsWith("--config="));
const configPath = configArg ? configArg.split("=")[1] : "./dolly.json";

// ── Framework-native commands ──
const isDaemon = args.includes("--daemon");
process.env.DOLLY_CONFIG = configPath;

if (cmd === "serve") {
  if (isDaemon) {
    start(instanceName);
    await waitForPort(instanceName);
    process.exit(0);
  }
  // Foreground: run main.ts in daemon mode, keep alive until Ctrl-C
  process.argv.push("--daemon");
  process.argv.push("--foreground");
  await import("../src/main.ts");
  // main.ts in foreground mode keeps process alive
}
if (cmd === "start") {
  start(instanceName);
  await waitForPort(instanceName);
  process.exit(0);
}
if (cmd === "stop") { await stop(instanceName, force); process.exit(0); }
if (cmd === "status") { status(args.includes("--all") ? undefined : instanceName); process.exit(0); }
if (cmd === "enable" || cmd === "disable" || cmd === "reload") {
  await sendCommand("__daemon__", [cmd, ...args.filter(a => !a.startsWith("--"))]);
  process.exit(0);
}

// ── Help: show framework commands, plus extension commands if daemon is ready ──
if (!cmd || cmd === "help" || cmd === "--help") {
  console.log(`Dolly — 通用 AI Agent 框架
\n框架命令:
  dolly serve [--config=<p>]           前台运行（日志可见）
  dolly serve --daemon [--config=<p>]  后台启动 daemon
  dolly start [--config=<p>]           后台启动 daemon（= serve --daemon）
  dolly stop [--name=<n>] [-f]         停止 daemon
  dolly status [--name=<n>]            查看状态
\n选项:
  --name=<n>     实例名称（默认 default）
  --config=<p>   指定配置文件（默认 ./dolly.json）
  -f, --force    强制停止\n`);
  if (isRunning(instanceName)) {
    try {
      const socketPath = resolve(__dirname, "..", ".dolly", "sockets", `${instanceName}.port`);
      const port = parseInt(readFileSync(socketPath, "utf-8"));
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(JSON.stringify({ cmd: "__daemon__", args: ["help"] }) + "\n");
        let buf = "";
        socket.on("data", (d) => { buf += d; });
        socket.on("close", () => { console.log(buf.trim()); process.exit(0); });
        setTimeout(() => { if (buf.trim()) console.log(buf.trim()); process.exit(0); }, 5000);
      });
      socket.on("error", () => { console.log("(daemon busy)"); process.exit(0); });
    } catch { console.log("(daemon not ready)"); process.exit(0); }
  } else {
    console.log("Extension 命令（启动 daemon 后可见: dolly start）\n");
    process.exit(0);
  }
}

// ── Extension commands: connect to daemon ──
async function sendCommand(extName, extArgs) {
  if (!isRunning(instanceName)) {
    process.stderr.write(`Starting daemon for "${instanceName}"...\n`);
    start(instanceName);
    await waitForPort(instanceName);
  }
  const socketPath = resolve(__dirname, "..", ".dolly", "sockets", `${instanceName}.port`);
  const port = parseInt(readFileSync(socketPath, "utf-8"));
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      if (extName === "console") {
        process.stdin.on("data", (d) => socket.write(d));
        let idle;
        socket.on("data", (d) => { process.stdout.write(d); clearTimeout(idle); idle = setTimeout(() => resolve(null), 2000); });
        socket.on("close", () => resolve(null));
      } else {
        socket.write(JSON.stringify({ cmd: extName, args: extArgs }) + "\n");
        let buf = "";
        socket.on("data", (d) => { buf += d; });
        socket.on("close", () => { if (buf.trim()) process.stdout.write(buf); resolve(null); });
        setTimeout(() => { if (buf.trim()) process.stdout.write(buf); resolve(null); }, 30000);
      }
    });
    socket.on("error", reject);
  });
}

await sendCommand(cmd, args.filter((a) => !a.startsWith("--")));
