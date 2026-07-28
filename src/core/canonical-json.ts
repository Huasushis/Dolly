import { createHash } from "node:crypto";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export class CanonicalJsonError extends TypeError {
  constructor(
    readonly code: "INVALID_JSON_VALUE" | "INVALID_UNICODE",
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path}`);
    this.name = "CanonicalJsonError";
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertString(value: string, path: string): void {
  if (hasUnpairedSurrogate(value)) {
    throw new CanonicalJsonError(
      "INVALID_UNICODE",
      "JSON strings must not contain unpaired UTF-16 surrogates",
      path,
    );
  }
}

function assertPlainObject(
  value: object,
  path: string,
): asserts value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalJsonError(
      "INVALID_JSON_VALUE",
      "JSON objects must be plain objects",
      path,
    );
  }
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function isJsonObject(
  value: JsonValue,
): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertJsonValue(value: unknown, path = "$", seen = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === "boolean") return;

  if (typeof value === "string") {
    assertString(value, path);
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new CanonicalJsonError(
        "INVALID_JSON_VALUE",
        "JSON numbers must be finite and must not be negative zero",
        path,
      );
    }
    return;
  }

  if (typeof value !== "object") {
    throw new CanonicalJsonError(
      "INVALID_JSON_VALUE",
      `Unsupported JSON value type ${typeof value}`,
      path,
    );
  }

  if (seen.has(value)) {
    throw new CanonicalJsonError("INVALID_JSON_VALUE", "Cyclic JSON value", path);
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertJsonValue(value[index], `${path}[${index}]`, seen);
    }
  } else {
    assertPlainObject(value, path);
    for (const key of Object.keys(value)) {
      assertString(key, `${path}.[key]`);
      assertJsonValue(value[key], `${path}.${key}`, seen);
    }
  }

  seen.delete(value);
}

function canonicalizeValidated(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (isJsonArray(value)) {
    return `[${value.map((item) => canonicalizeValidated(item)).join(",")}]`;
  }

  const members = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeValidated(value[key]!)}`);
  return `{${members.join(",")}}`;
}

export function canonicalizeJson(value: unknown): string {
  assertJsonValue(value);
  return canonicalizeValidated(value);
}

export function canonicalJsonByteLength(value: unknown): number {
  return Buffer.byteLength(canonicalizeJson(value), "utf8");
}

export function canonicalJsonDigest(value: unknown): string {
  const digest = createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
  return `sha256:${digest}`;
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (isJsonArray(value)) {
    return value.map((item) => cloneJsonValue(item));
  }

  const clone: Record<string, JsonValue> = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      value: cloneJsonValue(value[key]!),
      writable: true,
    });
  }
  return clone;
}

export function cloneJson<T extends JsonValue>(value: T): T {
  return cloneJsonValue(value) as T;
}

export function deepFreeze<T>(value: T, seen = new Set<object>()): Readonly<T> {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value as Readonly<T>;
  }
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
