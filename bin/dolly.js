#!/usr/bin/env -S node --import tsx/esm
import { start, stop, status } from "../src/daemon/index.js";

const cmd = process.argv[2];
const args = process.argv.slice(3);
const nameArg = args.find((a) => a.startsWith("--name="));
const instanceName = nameArg ? nameArg.split("=")[1] : "default";
const force = args.includes("-f") || args.includes("--force");

const help = () => {
  console.log(`Dolly — 通用 AI Agent 框架\n`);
  console.log(`用法: dolly <命令> [选项]\n`);
  console.log(`命令:`);
  console.log(`  run [--name=<n>]   前台运行（终端直接交互）。有 name 时保存/恢复上下文`);
  console.log(`  start [--name=<n>] 后台启动守护进程（无终端输出）`);
  console.log(`  attach [--name=<n>] 连接到后台实例的终端`);
  console.log(`  stop [--name=<n>]  停止守护进程`);
  console.log(`  status [--all]     查看实例状态\n`);
  console.log(`选项:`);
  console.log(`  --name=<name>       实例名称（默认 default）。用于多开和独立 profile`);
  console.log(`  -f, --force         强制停止\n`);
  process.exit(1);
};

if (!cmd || cmd === "help" || cmd === "--help") help();

switch (cmd) {
  case "start": start(instanceName); break;
  case "stop": stop(instanceName, force); break;
  case "status": status(args.includes("--all") ? undefined : instanceName); break;
  case "attach": console.log("TODO: attach not yet implemented"); break;
  case "run": {
    // Dynamically import and run main with the instance name
    process.env.DOLLY_INSTANCE = instanceName;
    await import("../src/main.ts");
    break;
  }
  default: help();
}
