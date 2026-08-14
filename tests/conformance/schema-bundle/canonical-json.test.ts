import { describe, expect, it } from "vitest";
import {
  CanonicalJsonError,
  assertCanonicalJsonValue,
  canonicalBytes,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  canonicalizeJson,
  parseCanonicalJsonBytes,
  parseCanonicalJsonText,
  verifyCanonicalDigest,
  DEFAULT_MAX_JSON_BYTES,
  DEFAULT_MAX_JSON_NESTING_DEPTH,
} from "../../../src/schema-bundle/index.js";

/**
 * Canonical-JSON conformance for Dolly Core v1.
 *
 * These tests pin RFC 8785 (JCS) byte-for-byte and the Dolly Core JSON
 * profile (duplicate-key rejection, lone-surrogate rejection, `-0`/NaN/Inf
 * rejection, nesting limit) as defined in
 * `docs/spec/core/01-identifiers-and-canonical-json.md`.
 */

describe("RFC 8785 canonical serialization", () => {
  it("produces the exact RFC 8785 §3.2.4 reference bytes for the Appendix A sample", () => {
    // RFC 8785 §3.2.2 example object. The string value contains, in order:
    // € $ <SI> <LF> A ' B " \ \ " /  (two backslashes before the quote).
    const value = {
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: ["\u20ac", "$", "\u000f", "\u000a", "A", "'", "B", '"', "\\", "\\", '"', "/"].join(""),
      literals: [null, true, false],
    };
    // Exact reference bytes from RFC 8785 §3.2.4 (the canonical UTF-8 output).
    const expectedHex =
      "7b226c69746572616c73223a5b6e756c6c2c747275652c66616c73655d2c226e756d" +
      "62657273223a5b3333333333333333332e333333333333332c31652b33302c342e35" +
      "2c302e3030322c31652d32375d2c22737472696e67223a22e282ac245c7530303066" +
      "5c6e4127425c225c5c5c5c5c222f227d";
    expect(Buffer.from(canonicalBytes(value)).toString("hex")).toBe(expectedHex);
    expect(canonicalizeJson(value)).toBe(
      `{"literals":[null,true,false],` +
        `"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],` +
        `"string":"€$\\u000f\\nA'B\\"\\\\\\\\\\"/"}`,
    );
  });

  it("sorts object keys by UTF-16 code-unit order (RFC 8785 §3.2.3)", () => {
    // RFC 8785 §3.2.3 ordering example:
    //   CR (U+000D), "1" (U+0031), control (U+0080), ö (U+00F6),
    //   € (U+20AC), 😀 (U+1F600, surrogates D83D DE00), דּ (U+FB33)
    const value: Record<string, string> = {
      "\u00f6": "o",
      "\u20ac": "euro",
      "\r": "cr",
      "\ufb33": "dalet",
      "1": "one",
      "\ud83d\ude00": "emoji",
      "\u0080": "ctrl",
    };
    // Verify order from the canonical string itself. JSON.parse would reorder
    // integer-index keys ("1") per V8's own property ordering, masking the
    // JCS sort. The canonical string preserves the sorted member order.
    const canonical = canonicalizeJson(value);
    const keyOrder = [...canonical.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"\s*:/g)].map(
      (m) => m[1],
    );
    expect(keyOrder).toEqual([
      "\\r",
      "1",
      "\u0080",
      "\u00f6",
      "\u20ac",
      "\ud83d\ude00",
      "\ufb33",
    ]);
  });

  it("serializes numbers via shortest-round-trip with lowercase exponent", () => {
    const value = { a: 1e30, b: 1e-27, c: 4.5, d: 0.002, e: 333333333.33333329 };
    expect(canonicalizeJson(value)).toBe(
      '{"a":1e+30,"b":1e-27,"c":4.5,"d":0.002,"e":333333333.3333333}',
    );
  });

  it("emits no insignificant whitespace", () => {
    expect(canonicalizeJson({ b: 1, a: [2, 3] })).toBe('{"a":[2,3],"b":1}');
  });
});

describe("Dolly Core profile rejection rules", () => {
  it("rejects duplicate object keys at parse time", () => {
    expect(() => parseCanonicalJsonText('{"a":1,"a":2}')).toThrow(CanonicalJsonError);
    expect(() => parseCanonicalJsonText('{"a":1,"a":2}')).toThrow(
      expect.objectContaining({ code: "CANONICAL_JSON_SYNTAX" }),
    );
  });

  it("rejects duplicate keys nested inside objects", () => {
    expect(() =>
      parseCanonicalJsonText('{"outer":{"x":1,"x":2}}'),
    ).toThrow(CanonicalJsonError);
  });

  it("rejects negative zero", () => {
    expect(() => parseCanonicalJsonText('{"a":-0}')).toThrow(CanonicalJsonError);
    expect(() => assertCanonicalJsonValue({ a: -0 })).toThrow(CanonicalJsonError);
  });

  it("rejects NaN and Infinity (not valid JSON text, and not canonical values)", () => {
    expect(() => parseCanonicalJsonText('{"a":NaN}')).toThrow(CanonicalJsonError);
    expect(() => parseCanonicalJsonText('{"a":Infinity}')).toThrow(CanonicalJsonError);
    expect(() => assertCanonicalJsonValue({ a: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => assertCanonicalJsonValue({ a: Number.POSITIVE_INFINITY })).toThrow(
      CanonicalJsonError,
    );
  });

  it("rejects lone UTF-16 surrogates in strings", () => {
    expect(() => assertCanonicalJsonValue({ a: "\ud800" })).toThrow(CanonicalJsonError);
    expect(() => assertCanonicalJsonValue({ "\ud800": 1 })).toThrow(CanonicalJsonError);
  });

  it("rejects non-plain object prototypes", () => {
    expect(() => assertCanonicalJsonValue(new Map())).toThrow(CanonicalJsonError);
    expect(() => assertCanonicalJsonValue(new Date())).toThrow(CanonicalJsonError);
  });

  it("rejects invalid UTF-8 bytes", () => {
    // 0xFF is not a valid UTF-8 leading byte.
    expect(() => parseCanonicalJsonBytes(Uint8Array.of(0xff))).toThrow(CanonicalJsonError);
  });

  it("enforces the nesting-depth limit (depth 64 ok, 65 rejected)", () => {
    // Each object nesting level adds one depth unit. A chain of 64 nested
    // single-key objects is depth 64 (at the default ceiling); 65 exceeds it.
    function nest(n: number): string {
      let s = "0";
      for (let i = 0; i < n; i += 1) s = `{"k":${s}}`;
      return s;
    }
    expect(() => parseCanonicalJsonText(nest(DEFAULT_MAX_JSON_NESTING_DEPTH))).not.toThrow();
    expect(() =>
      parseCanonicalJsonText(nest(DEFAULT_MAX_JSON_NESTING_DEPTH + 1)),
    ).toThrow(CanonicalJsonError);
  });

  it.each([
    ["empty object", "{}"],
    ["empty array", "[]"],
  ])("counts an %s terminal container at the text and byte boundaries", (_name, terminal) => {
    function nestContainers(depth: number): string {
      let text = terminal;
      for (let i = 1; i < depth; i += 1) text = `{"k":${text}}`;
      return text;
    }

    const depth64 = nestContainers(DEFAULT_MAX_JSON_NESTING_DEPTH);
    const depth65 = nestContainers(DEFAULT_MAX_JSON_NESTING_DEPTH + 1);
    expect(() => parseCanonicalJsonText(depth64)).not.toThrow();
    expect(() => parseCanonicalJsonText(depth65)).toThrow(CanonicalJsonError);
    expect(() => parseCanonicalJsonBytes(Buffer.from(depth64))).not.toThrow();
    expect(() => parseCanonicalJsonBytes(Buffer.from(depth65))).toThrow(CanonicalJsonError);
  });

  it("honors a custom nesting-depth limit", () => {
    function nest(n: number): string {
      let s = "0";
      for (let i = 0; i < n; i += 1) s = `{"k":${s}}`;
      return s;
    }
    expect(() => parseCanonicalJsonText(nest(3), { maxDepth: 3 })).not.toThrow();
    expect(() => parseCanonicalJsonText(nest(4), { maxDepth: 3 })).toThrow(CanonicalJsonError);
  });
});

describe("byte input boundary", () => {
  it("parses valid UTF-8 bytes and round-trips through canonicalization", () => {
    const value = { name: "dolly", count: 3, items: [1, 2, 3] };
    const bytes = Buffer.from('{"name":"dolly","count":3,"items":[1,2,3]}', "utf8");
    const parsed = parseCanonicalJsonBytes(new Uint8Array(bytes));
    expect(parsed).toEqual(value);
    expect(canonicalizeJson(parsed)).toBe('{"count":3,"items":[1,2,3],"name":"dolly"}');
  });

  it("rejects a UTF-8 byte-order mark (EF BB BF)", () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const payload = Buffer.concat([bom, Buffer.from('{"a":1}', "utf8")]);
    expect(() => parseCanonicalJsonBytes(new Uint8Array(payload))).toThrow(CanonicalJsonError);
    expect(() => parseCanonicalJsonBytes(new Uint8Array(payload))).toThrow(
      expect.objectContaining({ code: "CANONICAL_JSON_UTF8" }),
    );
  });

  it("enforces the byte budget with CANONICAL_JSON_LIMIT", () => {
    // A payload larger than a tiny maxBytes budget must surface the limit code.
    const big = Buffer.from(" ".repeat(64) + "0", "utf8");
    expect(() => parseCanonicalJsonBytes(new Uint8Array(big), { maxBytes: 32 })).toThrow(
      CanonicalJsonError,
    );
    expect(() => parseCanonicalJsonBytes(new Uint8Array(big), { maxBytes: 32 })).toThrow(
      expect.objectContaining({ code: "CANONICAL_JSON_LIMIT" }),
    );
  });
});

describe("RFC 8785 §3.2.3 official Unicode ordering and structural preservation", () => {
  // The official RFC 8785 §3.2.3 test vector: keys sorted by UTF-16 code-unit
  // lexicographic order, NOT length-first. The expected canonical string and
  // SHA-256 are pinned as a cross-language digest oracle.
  it("sorts the official §3.2.3 keys in exact UTF-16 code-unit order", () => {
    // The official RFC 8785 §3.2.3 vector. Keys are sorted by UTF-16 code-unit
    // lexicographic order (Array.prototype.sort on Object.keys), NOT
    // length-first. JSON.stringify emits non-ASCII keys verbatim (it does not
    // \u00XX-escape them), so a regex that captures raw key bytes cannot be
    // compared against escaped literals. Instead we pin the exact canonical
    // string and parse it back to assert the decoded key order by code unit.
    const value: Record<string, string> = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis",
    };
    // Exact JCS bytes: only the structural/short-escape characters (\r) are
    // escaped; every non-ASCII key is emitted as its literal UTF-8 bytes.
    const expectedCanonical =
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}';
    const canonical = canonicalizeJson(value);
    expect(canonical).toBe(expectedCanonical);
    // JSON.parse followed by Object.keys cannot recover source member order for
    // integer-index names: ECMAScript enumerates "1" before other keys. The
    // exact canonical string above is the ordering assertion. Independently
    // verify that the canonicalizer's input-key sort follows the same UTF-16
    // code-unit order: U+000D, U+0031, U+0080, U+00F6, U+20AC,
    // U+D83D U+DE00, U+FB33.
    const keyOrder = Object.keys(value).sort();
    expect(keyOrder).toEqual([
      "\r",
      "1",
      "\u0080",
      "\u00f6",
      "\u20ac",
      "\ud83d\ude00",
      "\ufb33",
    ]);
    const codeUnits = keyOrder.map((key) =>
      Array.from({ length: key.length }, (_, index) => key.charCodeAt(index)),
    );
    expect(codeUnits).toEqual([
      [0x000d],
      [0x0031],
      [0x0080],
      [0x00f6],
      [0x20ac],
      [0xd83d, 0xde00],
      [0xfb33],
    ]);
  });

  it("pins the SHA-256 of the official §3.2.3 vector as a cross-language oracle", () => {
    const value: Record<string, string> = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis",
    };
    const digest =
      "sha256:5e321556d22018a9656991a9e94f77ec175fa193e52a2429d312f8419ec8b08c";
    expect(canonicalJsonDigest(value)).toBe(digest);
    expect(verifyCanonicalDigest(value, digest)).toBe(true);
  });

  it("preserves array element order and sorts nested object keys recursively", () => {
    // Array order MUST be preserved; nested objects MUST be sorted recursively.
    // This kills the "shorter key first" length myth: "b" < "aa" by code-unit
    // order? No — U+0061 ('a') < U+0062 ('b'), so "aa" precedes "b".
    expect(canonicalizeJson({ b: 1, aa: 2 })).toBe('{"aa":2,"b":1}');
    expect(canonicalizeJson([{ z: 1 }, { a: { y: 2, x: 1 } }])).toBe(
      '[{"z":1},{"a":{"x":1,"y":2}}]',
    );
  });
});

describe("value-level nesting-depth budget", () => {
  // Programmatic values (not text-parsed) must also honor the 64-level budget
  // so a deeply nested value fails with CanonicalJsonError rather than
  // overflowing the call stack.
  function nestValue(depth: number): unknown {
    let v: unknown = 0;
    for (let i = 0; i < depth; i += 1) v = { k: v };
    return v;
  }

  function nestContainers(depth: number, terminal: object): unknown {
    let value: unknown = terminal;
    for (let i = 1; i < depth; i += 1) value = { k: value };
    return value;
  }

  it("admits a 64-level nested programmatic value", () => {
    expect(() => assertCanonicalJsonValue(nestValue(DEFAULT_MAX_JSON_NESTING_DEPTH))).not.toThrow();
  });

  it("rejects a 65-level nested programmatic value with CANONICAL_JSON_LIMIT", () => {
    expect(() => assertCanonicalJsonValue(nestValue(DEFAULT_MAX_JSON_NESTING_DEPTH + 1))).toThrow(
      CanonicalJsonError,
    );
    expect(() => assertCanonicalJsonValue(nestValue(DEFAULT_MAX_JSON_NESTING_DEPTH + 1))).toThrow(
      expect.objectContaining({ code: "CANONICAL_JSON_LIMIT" }),
    );
  });

  it.each([
    ["empty object", {}],
    ["empty array", []],
  ])("counts an %s terminal container at the 64/65 boundary", (_name, terminal) => {
    expect(() =>
      assertCanonicalJsonValue(nestContainers(DEFAULT_MAX_JSON_NESTING_DEPTH, terminal)),
    ).not.toThrow();
    expect(() =>
      assertCanonicalJsonValue(nestContainers(DEFAULT_MAX_JSON_NESTING_DEPTH + 1, terminal)),
    ).toThrow(expect.objectContaining({ code: "CANONICAL_JSON_LIMIT" }));
  });
});

describe("exported error contract — all entry points throw the bundle CanonicalJsonError", () => {
  // Every exported entry point must throw the *bundle* CanonicalJsonError, not
  // the unexported core class, so `instanceof CanonicalJsonError` matches.

  it("canonicalizeJson throws the bundle CanonicalJsonError on invalid values", () => {
    expect(() => canonicalizeJson({ a: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJson({ a: "\ud800" })).toThrow(CanonicalJsonError);
  });

  it("canonicalJsonDigest throws the bundle CanonicalJsonError on invalid values", () => {
    expect(() => canonicalJsonDigest({ a: Number.POSITIVE_INFINITY })).toThrow(CanonicalJsonError);
  });

  it("canonicalJsonByteLength throws the bundle CanonicalJsonError on invalid values", () => {
    expect(() => canonicalJsonByteLength({ a: -0 })).toThrow(CanonicalJsonError);
  });

  it("canonicalBytes throws the bundle CanonicalJsonError on invalid values", () => {
    expect(() => canonicalBytes({ a: "\ud800" })).toThrow(CanonicalJsonError);
  });

  it("verifyCanonicalDigest throws the bundle CanonicalJsonError for an invalid value", () => {
    expect(() =>
      verifyCanonicalDigest({ a: Number.NaN }, "sha256:" + "0".repeat(64)),
    ).toThrow(CanonicalJsonError);
  });

  it("canonicalJsonByteLength returns the correct UTF-8 byte count", () => {
    // {"a":1} = 7 ASCII bytes; "€" is 3 UTF-8 bytes → {"€":1} = 9 bytes.
    expect(canonicalJsonByteLength({ a: 1 })).toBe(7);
    expect(canonicalJsonByteLength({ "\u20ac": 1 })).toBe(9);
  });
});

describe("golden digests from Dolly test vectors", () => {
  // These digests are the self-asserted canonical digests embedded in the
  // spec's own test vectors. Verifying them proves the schema-bundle
  // canonicalizer agrees with the spec's reference machine.

  it("TST-CONFIG-003 effective_config → sha256:75d72a95…", () => {
    const effectiveConfig = {
      cache: { module: true },
      inherited: 1,
      nullable: null,
      tags: ["module"],
    };
    const digest = "sha256:75d72a950e3a0e5a7ad5150b6a52bfc4f2bc83c001c23dd7d44045b13149d223";
    expect(canonicalJsonDigest(effectiveConfig)).toBe(digest);
    expect(verifyCanonicalDigest(effectiveConfig, digest)).toBe(true);
  });

  it("TST-CORE-016 manifest effective_config (legacy) → sha256:0406c7d6…", () => {
    const legacy = { mode: "legacy", threshold: 7 };
    const digest = "sha256:0406c7d60dad47428a106f950b07195c98317e0e3c3c3325b2ff2a77b44b7613";
    expect(canonicalJsonDigest(legacy)).toBe(digest);
    expect(verifyCanonicalDigest(legacy, digest)).toBe(true);
  });

  it("TST-CORE-016 current_module_config effective_config (current) → sha256:f26d094f…", () => {
    const current = { mode: "current", threshold: 9 };
    const digest = "sha256:f26d094f9ee954e3a5cc96e73cdac37fbd401b08a8efe888659b33cc53090778";
    expect(canonicalJsonDigest(current)).toBe(digest);
    expect(verifyCanonicalDigest(current, digest)).toBe(true);
  });

  it("verifyCanonicalDigest rejects a tampered digest", () => {
    const value = { mode: "legacy", threshold: 7 };
    const tampered =
      "sha256:0406c7d60dad47428a106f950b07195c98317e0e3c3c3325b2ff2a77b44b7614";
    expect(verifyCanonicalDigest(value, tampered)).toBe(false);
  });

  it("verifyCanonicalDigest rejects a malformed digest string", () => {
    expect(() => verifyCanonicalDigest({ a: 1 }, "not-a-digest")).toThrow(CanonicalJsonError);
  });
});
