import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Test speak parsing logic directly (extracted from console module)
function parseSpeak(text: string): string[] {
  const results: string[] = [];
  const re = /```json\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && typeof obj.speak === "string") results.push(obj.speak);
    } catch {}
  }
  if (results.length === 0) {
    const jsonRe = /\{"speak"\s*:\s*"((?:[^"\\]|\\.)*)"\}/g;
    let jm;
    while ((jm = jsonRe.exec(text))) {
      try { results.push(JSON.parse(`{"speak":"${jm[1]}"}`).speak); } catch {}
    }
  }
  if (results.length === 0) {
    const cleaned = text.replace(/```json[\s\S]*?```/g, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim();
    if (cleaned) results.push(cleaned);
  }
  return results;
}

describe("Console speak parsing", () => {
  describe("parseSpeak", () => {
    it("extracts single speak from fenced JSON", () => {
      const text = '```json\n{"speak":"你好，世界"}\n```';
      const result = parseSpeak(text);
      assert.deepEqual(result, ["你好，世界"]);
    });

    it("extracts multiple speaks from multiple fenced JSON blocks", () => {
      const text = '```json\n{"speak":"第一句"}\n```\n```json\n{"speak":"第二句"}\n```';
      const result = parseSpeak(text);
      assert.deepEqual(result, ["第一句", "第二句"]);
    });

    it("ignores non-speak fenced JSON", () => {
      const text = '```json\n{"tool":"read_file","params":{}}\n```';
      const result = parseSpeak(text);
      assert.equal(result.length, 0); // fallback strips json blocks, leaving empty
    });

    it("handles escaped quotes in speak text", () => {
      const text = '```json\n{"speak":"他说\\"你好\\""}\n```';
      const result = parseSpeak(text);
      assert.deepEqual(result, ['他说"你好"']);
    });

    it("fallback: shows non-codeblock text", () => {
      const text = "这是普通回复文本，没有 JSON 块";
      const result = parseSpeak(text);
      assert.deepEqual(result, ["这是普通回复文本，没有 JSON 块"]);
    });

    it("strips control characters in fallback", () => {
      const text = "hello\x00world```json\n{}\n```rest";
      const result = parseSpeak(text);
      assert.deepEqual(result, ["helloworldrest"]);
    });

    it("extracts raw JSON speak without fenced code block", () => {
      const text = '{"speak":"你好"}';
      const result = parseSpeak(text);
      assert.deepEqual(result, ["你好"]);
    });

    it("extracts multiple raw JSON speaks from text", () => {
      const text = '{"speak":"第一句"} some text {"speak":"第二句"}';
      const result = parseSpeak(text);
      assert.deepEqual(result, ["第一句", "第二句"]);
    });
  });
});
