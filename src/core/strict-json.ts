import { TextDecoder } from "node:util";
import { assertJsonValue, type JsonValue } from "./canonical-json.js";

export type StrictJsonErrorCode =
  | "STRICT_JSON_LIMIT_EXCEEDED"
  | "STRICT_JSON_UTF8_INVALID"
  | "STRICT_JSON_SYNTAX_INVALID"
  | "STRICT_JSON_VALUE_INVALID";

export class StrictJsonError extends SyntaxError {
  constructor(readonly code: StrictJsonErrorCode, message: string) {
    super(message);
    this.name = "StrictJsonError";
  }
}

export interface StrictJsonOptions {
  readonly maxBytes: number;
  readonly maxDepth?: number;
}

class JsonStructureScanner {
  #offset = 0;

  constructor(
    private readonly text: string,
    private readonly maxDepth: number,
  ) {}

  scan(): void {
    this.#whitespace();
    this.#value(1);
    this.#whitespace();
    if (this.#offset !== this.text.length) throw new SyntaxError("Trailing JSON data");
  }

  #value(depth: number): void {
    this.#whitespace();
    const token = this.text[this.#offset];
    if ((token === "{" || token === "[") && depth > this.maxDepth) {
      throw new SyntaxError("JSON nesting limit exceeded");
    }
    if (token === "{") this.#object(depth + 1);
    else if (token === "[") this.#array(depth + 1);
    else if (token === '"') void this.#string();
    else if (token === "t") this.#literal("true");
    else if (token === "f") this.#literal("false");
    else if (token === "n") this.#literal("null");
    else this.#number();
  }

  #object(depth: number): void {
    this.#offset += 1;
    this.#whitespace();
    if (this.text[this.#offset] === "}") {
      this.#offset += 1;
      return;
    }
    const keys = new Set<string>();
    while (true) {
      this.#whitespace();
      if (this.text[this.#offset] !== '"') throw new SyntaxError("Object key expected");
      const key = this.#string();
      if (keys.has(key)) throw new SyntaxError("Duplicate object key");
      keys.add(key);
      this.#whitespace();
      if (this.text[this.#offset] !== ":") throw new SyntaxError("Object colon expected");
      this.#offset += 1;
      this.#value(depth);
      this.#whitespace();
      const separator = this.text[this.#offset];
      if (separator === "}") {
        this.#offset += 1;
        return;
      }
      if (separator !== ",") throw new SyntaxError("Object separator expected");
      this.#offset += 1;
    }
  }

  #array(depth: number): void {
    this.#offset += 1;
    this.#whitespace();
    if (this.text[this.#offset] === "]") {
      this.#offset += 1;
      return;
    }
    while (true) {
      this.#value(depth);
      this.#whitespace();
      const separator = this.text[this.#offset];
      if (separator === "]") {
        this.#offset += 1;
        return;
      }
      if (separator !== ",") throw new SyntaxError("Array separator expected");
      this.#offset += 1;
    }
  }

  #string(): string {
    const start = this.#offset;
    this.#offset += 1;
    while (this.#offset < this.text.length) {
      const character = this.text[this.#offset]!;
      const code = character.charCodeAt(0);
      if (character === '"') {
        this.#offset += 1;
        return JSON.parse(this.text.slice(start, this.#offset)) as string;
      }
      if (code <= 0x1f) throw new SyntaxError("Control character in JSON string");
      if (character === "\\") {
        this.#offset += 1;
        const escape = this.text[this.#offset];
        if (escape === "u") {
          const digits = this.text.slice(this.#offset + 1, this.#offset + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(digits)) throw new SyntaxError("Invalid Unicode escape");
          this.#offset += 5;
          continue;
        }
        if (!escape || !'"\\/bfnrt'.includes(escape)) {
          throw new SyntaxError("Invalid JSON escape");
        }
      }
      this.#offset += 1;
    }
    throw new SyntaxError("Unterminated JSON string");
  }

  #literal(expected: "true" | "false" | "null"): void {
    if (this.text.slice(this.#offset, this.#offset + expected.length) !== expected) {
      throw new SyntaxError("Invalid JSON literal");
    }
    this.#offset += expected.length;
  }

  #number(): void {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      this.text.slice(this.#offset),
    );
    if (!match) throw new SyntaxError("Invalid JSON number");
    this.#offset += match[0].length;
  }

  #whitespace(): void {
    while (
      this.text[this.#offset] === " " ||
      this.text[this.#offset] === "\n" ||
      this.text[this.#offset] === "\r" ||
      this.text[this.#offset] === "\t"
    ) {
      this.#offset += 1;
    }
  }
}

function validateOptions(options: StrictJsonOptions): Required<StrictJsonOptions> {
  const maxDepth = options.maxDepth ?? 128;
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new TypeError("maxDepth must be a positive safe integer");
  }
  return { maxBytes: options.maxBytes, maxDepth };
}

export function parseStrictJsonText(text: string, options: StrictJsonOptions): JsonValue {
  const limits = validateOptions(options);
  if (Buffer.byteLength(text, "utf8") > limits.maxBytes) {
    throw new StrictJsonError("STRICT_JSON_LIMIT_EXCEEDED", "JSON exceeds its byte limit");
  }
  try {
    new JsonStructureScanner(text, limits.maxDepth).scan();
  } catch {
    throw new StrictJsonError("STRICT_JSON_SYNTAX_INVALID", "JSON syntax is invalid or ambiguous");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new StrictJsonError("STRICT_JSON_SYNTAX_INVALID", "JSON syntax is invalid or ambiguous");
  }
  try {
    assertJsonValue(value);
  } catch {
    throw new StrictJsonError("STRICT_JSON_VALUE_INVALID", "JSON value is not canonical-safe");
  }
  return value;
}

export function parseStrictJsonBytes(bytes: Uint8Array, options: StrictJsonOptions): JsonValue {
  const limits = validateOptions(options);
  if (bytes.byteLength > limits.maxBytes) {
    throw new StrictJsonError("STRICT_JSON_LIMIT_EXCEEDED", "JSON exceeds its byte limit");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StrictJsonError("STRICT_JSON_UTF8_INVALID", "JSON is not valid UTF-8");
  }
  return parseStrictJsonText(text, limits);
}
