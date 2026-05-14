#!/usr/bin/env -S node --import tsx/esm
import { start, stop, status } from "../src/daemon/index.js";
import { resolve } from "path";

const cmd = process.argv[2] || "run";
const args = process.argv.slice(3);
const nameArg = args.find((a) => a.startsWith("--name="));
const instanceName = nameArg ? nameArg.split("=")[1] : "default";
const force = args.includes("-f") || args.includes("--force");

const valid = ["run", "start", "stop", "status", "list"];
if (!valid.includes(cmd)) {
  console.log(`Dolly — 通用 AI Agent 框架\n`);
  console.log(`用法: dolly <命令> [选项]\n`);
  console.log(`命令:`);
  console.log(`  run              前台运行（交互式）`);
  console.log(`  start            后台启动守护进程`);
  console.log(`  stop             停止守护进程`);
  console.log(`  status           查看守护进程状态`);
  console.log(`  list             列出已安装扩展\n`);
  console.log(`选项:`);
  console.log(`  --name=<name>     实例名称（多开用，默认 default）`);
  console.log(`  -f, --force       强制停止\n`);
  process.exit(1);
}

switch (cmd) {
  case "start": start(instanceName); break;
  case "stop": stop(instanceName, force); break;
  case "status": status(args.includes("--all") ? undefined : instanceName); break;
  case "list": console.log("Extensions: builtin/llm, builtin/skill, builtin/mcp"); break;
  case "run": {
    // Import and run the main module
    const { default: main } = await import("../src/main.js");
  }
}
