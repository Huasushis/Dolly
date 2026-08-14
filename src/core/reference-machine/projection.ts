import { canonicalJsonDigest, type JsonValue } from "../../schema-bundle/index.js";
import type { CoreSnapshot, JsonObject } from "./types.js";

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) result[key] = jsonValue(member);
    }
    return result;
  }
  throw new TypeError(`Core state projection cannot contain ${typeof value}`);
}

/** Durable state only. In-memory lossy queue entries intentionally do not survive recovery. */
export function projectCoreState(state: CoreSnapshot): JsonObject {
  const { volatile_lossy_entries: _volatile, ...durable } = state;
  return jsonValue(durable) as JsonObject;
}

export function hashCoreState(state: CoreSnapshot): string {
  return canonicalJsonDigest(projectCoreState(state));
}
