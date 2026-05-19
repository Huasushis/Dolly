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

const help = () => {
  console.log(`Dolly — 通用 AI Agent 框架\n`);
  console.log(`框架命令:`);
  console.log(`  dolly start [--name=<n>]    后台启动 daemon`);
  console.log(`  dolly stop [--name=<n>]     停止 daemon`);
  console.log(`  dolly status [--name=<n>]   查看状态`);
  console.log(`\nExtension 命令（连 daemon，自动启动）:`);
  console.log(`  dolly console              交互式终端`);
  console.log(`  dolly memory midnight      强制执行午夜总结`);
  console.log(`  dolly memory recall <q>    搜索记忆`);
  console.log(`  dolly skill reload         重载 skills`);
  console.log(`  dolly skill list           列出 skills`);
  console.log(`  dolly mcp reload           重载 MCP 连接`);
  console.log(`  dolly mcp list             列出 MCP 工具`);
  console.log(`\n选项:`);
  console.log(`  --name=<n>  实例名称（默认 default）`);
  console.log(`  -f, --force 强制停止\n`);
  process.exit(1);
};

if (!cmd || cmd === "help" || cmd === "--help") help();

// ── Framework-native commands ──
if (cmd === "start") { start(instanceName); process.exit(0); }
if (cmd === "stop") { stop(instanceName, force); process.exit(0); }
if (cmd === "status") { status(args.includes("--all") ? undefined : instanceName); process.exit(0); }

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
        socket.on("data", (d) => { process.stdout.write(d); clearTimeout(idle); idle = setTimeout(() => resolve(undefined), 2000); });
        socket.on("close", () => resolve(undefined));
      } else {
        socket.write(JSON.stringify({ cmd: extName, args: extArgs }) + "\n");
        let buf = "";
        socket.on("data", (d) => { buf += d; });
        socket.on("close", () => { if (buf.trim()) process.stdout.write(buf); resolve(undefined); });
        setTimeout(() => { if (buf.trim()) process.stdout.write(buf); resolve(undefined); }, 30000);
      }
    });
    socket.on("error", reject);
  });
}

await sendCommand(cmd, args.filter((a) => !a.startsWith("--")));
