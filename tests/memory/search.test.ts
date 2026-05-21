import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { resolve } from "path";
import { tokenize, tfVector, cosineSimilarity } from "../../src/memory/nlp.js";

interface Scenario {
  day: string; weight: number; summary: string; keywords: string[];
}

const scenarios: Scenario[] = JSON.parse(readFileSync(resolve(import.meta.dirname!, "scenarios.json"), "utf-8"));

// Current scoring algorithm
function scoreEntry(query: string, entry: Scenario, now: Date): number {
  const qVec = tfVector(tokenize(query));
  const eVec = tfVector(tokenize(entry.summary + " " + entry.keywords.join(" ")));
  const sim = cosineSimilarity(qVec, eVec);
  if (sim < 0.02) return 0;
  const importance = 0.5 + entry.weight;
  let s = sim * importance;
  const daysOld = (now.getTime() - new Date(entry.day).getTime()) / 86400000;
  s += 0.08 * Math.exp(-daysOld / 30);
  return s;
}

function topResults(query: string, k = 5): string[] {
  const now = new Date();
  return scenarios
    .map(e => ({ day: e.day, score: scoreEntry(query, e, now), summary: e.summary }))
    .filter(e => e.score > 0.03)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(e => `${e.day} (${e.score.toFixed(4)}): ${e.summary.slice(0,60)}`);
}

describe("Memory search scoring", () => {
  const testCases: Array<{ query: string; expectedDay: string; desc: string }> = [
    { query: "密钥", expectedDay: "2026-05-21", desc: "exact key word" },
    { query: "密码是什么", expectedDay: "2026-05-10", desc: "password query" },
    { query: "吉他", expectedDay: "2026-05-14", desc: "hobby recall" },
    { query: "cx的猫叫什么", expectedDay: "2026-04-20", desc: "pet name" },
    { query: "暗恋谁", expectedDay: "2026-04-15", desc: "crush secret" },
    { query: "喜欢什么音乐", expectedDay: "2026-05-15", desc: "music preference" },
    { query: "父亲怎么了", expectedDay: "2026-03-20", desc: "family emergency (old)" },
    { query: "火锅喜欢什么口味", expectedDay: "2026-03-10", desc: "food preference (old)" },
    { query: "情人节", expectedDay: "2026-02-14", desc: "valentine (very old)" },
  ];

  for (const tc of testCases) {
    it(`${tc.desc}: "${tc.query}" → ${tc.expectedDay}`, () => {
      const now = new Date();
      const ranked = scenarios
        .map(e => ({ day: e.day, score: scoreEntry(tc.query, e, now) }))
        .filter(e => e.score > 0.03)
        .sort((a, b) => b.score - a.score);

      const top = ranked[0];
      assert.ok(top, `No results for "${tc.query}"`);
      assert.equal(top.day, tc.expectedDay,
        `Expected ${tc.expectedDay} but got ${top.day} (score=${top.score.toFixed(4)}). Top 3: ${ranked.slice(0,3).map(r => r.day+'('+r.score.toFixed(4)+')').join(', ')}`);
    });
  }

  it("all queries return at least 1 result", () => {
    for (const tc of testCases) {
      const now = new Date();
      const results = scenarios.filter(e => scoreEntry(tc.query, e, now) > 0.03);
      assert.ok(results.length > 0, `No results for "${tc.query}"`);
    }
  });

  it("very old relevant memories still surface", () => {
    const s = scoreEntry("情人节一个人", scenarios.find(e => e.day === "2026-02-14")!, new Date());
    assert.ok(s > 0.03, `Valentine entry score=${s.toFixed(4)} should be above threshold`);
  });

  it("unrelated queries may return noise but correct result ranks first", () => {
    // Lenient filter allows some noise — LLM handles false positives.
    // But the correct result must always be in top 3.
    const checks: Array<{ query: string; mustInclude: string }> = [
      { query: "量子力学怎么学", mustInclude: "" },  // may return noise or nothing
      { query: "世界杯决赛比分", mustInclude: "" },
      { query: "密钥是什么", mustInclude: "2026-05-21" },
      { query: "cx父亲", mustInclude: "2026-03-20" },
    ];
    const now = new Date();
    for (const c of checks) {
      const results = scenarios
        .map(e => ({ day: e.day, score: scoreEntry(c.query, e, now) }))
        .filter(e => e.score > 0.03)
        .sort((a, b) => b.score - a.score);
      if (c.mustInclude) {
        const top3 = results.slice(0, 3).map(r => r.day);
        assert.ok(top3.includes(c.mustInclude),
          `"${c.query}" must include ${c.mustInclude} in top 3, got: ${top3.join(',')}`);
      }
    }
  });

  it("no false negatives for important queries", () => {
    const now = new Date();
    // Every query that SHOULD match must return at least the correct entry
    const mustMatch = [
      { query: "密码", day: "2026-05-10" },
      { query: "吉他", day: "2026-05-14" },
      { query: "猫", day: "2026-04-20" },
      { query: "暗恋", day: "2026-04-15" },
      { query: "面试", day: "2026-04-10" },
      { query: "火锅", day: "2026-03-10" },
    ];
    for (const m of mustMatch) {
      const s = scoreEntry(m.query, scenarios.find(e => e.day === m.day)!, now);
      assert.ok(s > 0.03, `"${m.query}" should match ${m.day}, got score=${s.toFixed(4)}`);
    }
  });
});
