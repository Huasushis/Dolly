import { describe, expect, it } from "vitest";
import {
  CanonicalJsonError,
  canonicalizeJson,
} from "../../../src/core/canonical-json.js";
import {
  parseStrictJsonText,
  StrictJsonError,
} from "../../../src/core/strict-json.js";

describe("canonical JSON Unicode scalar validation", () => {
  it.each([
    ["trailing high surrogate", String.fromCharCode(0xd800)],
    ["standalone low surrogate", String.fromCharCode(0xdc00)],
    ["high surrogate followed by ASCII", `${String.fromCharCode(0xd800)}x`],
  ])("rejects %s in direct canonicalization", (_label, value) => {
    expect(() => canonicalizeJson({ value })).toThrowError(
      expect.objectContaining<Partial<CanonicalJsonError>>({ code: "INVALID_UNICODE" }),
    );
  });

  it.each(["d800", "dc00"])('rejects JSON escape \\u%s after parsing', (codeUnit) => {
    expect(() => parseStrictJsonText(`{"value":"\\u${codeUnit}"}`, {
      maxBytes: 128,
    })).toThrowError(
      expect.objectContaining<Partial<StrictJsonError>>({ code: "STRICT_JSON_VALUE_INVALID" }),
    );
  });

  it("accepts a valid surrogate pair", () => {
    const value = String.fromCodePoint(0x1f642);
    expect(canonicalizeJson({ value })).toBe(JSON.stringify({ value }));
    expect(parseStrictJsonText('{"value":"\\ud83d\\ude42"}', { maxBytes: 128 }))
      .toEqual({ value });
  });
});
