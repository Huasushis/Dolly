/**
 * 手动运行: node --import tsx/esm tests/integration/live-recall-test.ts
 * 需要 daemon 已启动: node --import tsx/esm src/main.ts --daemon
 */
import { connect } from "net";
import { readFileSync } from "fs";

const PORT = parseInt(readFileSync(".dolly/sockets/default.port", "utf-8"));

function send(text: string, timeout = 15000): Promise<string> {
  return new Promise((resolve) => {
    const s = connect(PORT, "127.0.0.1", () => {
      let buf = "";
      s.on("data", (d) => { buf += d.toString(); });
      let timer = setTimeout(() => { s.destroy(); resolve(buf); }, timeout);
      s.on("data", () => {
        clearTimeout(timer);
        timer = setTimeout(() => { s.destroy(); resolve(buf); }, 3000);
      });
      s.write(text + "\n");
    });
  });
}

async function main() {
  console.log("=== TEST 1: Basic conversation ===");
  const r1 = await send("你好！我叫cx");
  console.log("Response:", r1.slice(0, 200));
  await sleep(3000);

  console.log("\n=== TEST 2: Build memory ===");
  const r2 = await send("我喜欢弹吉他和编程，今天修了一个Python的bug");
  console.log("Response:", r2.slice(0, 200));
  await sleep(3000);

  console.log("\n=== TEST 3: Ask recall ===");
  const r3 = await send("你还记得我的爱好是什么吗？");
  console.log("Response:", r3.slice(0, 400));

  console.log("\n=== CHECK DAILY LOG ===");
  const log = readFileSync(".dolly/profiles/default/exts/builtin/memory/memory-store/daily/2026-05-21.jsonl", "utf-8");
  const lines = log.split("\n").filter(Boolean);
  console.log(`Log entries: ${lines.length}`);
  const recallLines = lines.filter(l => l.includes("recall") || l.includes("memory"));
  console.log(`Recall/memory entries: ${recallLines.length}`);
  recallLines.forEach(l => console.log(l.slice(0, 200)));

  console.log("\n=== TEST 4: Thinking mode ===");
  // Complex analysis should trigger thinking
  const r4 = await send("请详细分析以下代码的时间复杂度并给出优化方案：for(let i=0;i<n;i++){for(let j=i;j<n;j++){for(let k=0;k<j;k++){console.log(i+j+k)}}}", 30000);
  console.log("Response:", r4.slice(0, 300));
  await sleep(5000);

  console.log("\n=== CHECK THINKING IN LOG ===");
  const log2 = readFileSync(".dolly/profiles/default/exts/builtin/memory/memory-store/daily/2026-05-21.jsonl", "utf-8");
  const thinkingLines = log2.split("\n").filter(l => l.includes("thinking") || l.includes("reasoning"));
  console.log(`Thinking/reasoning entries: ${thinkingLines.length}`);
  thinkingLines.forEach(l => console.log(l.slice(0, 200)));

  console.log("\n=== DONE ===");
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
main().catch(console.error);
