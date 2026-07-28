import Ajv2020, { type AnySchemaObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { type JsonValue } from "./canonical-json.js";

export const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";

export type JsonSchemaErrorCode = "JSON_SCHEMA_INVALID" | "JSON_SCHEMA_VALUE_INVALID";

export class JsonSchemaError extends TypeError {
  constructor(
    readonly code: JsonSchemaErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "JsonSchemaError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function compileJsonSchema(schema: JsonValue): ValidateFunction {
  if (!isPlainObject(schema) || schema.$schema !== JSON_SCHEMA_2020_12) {
    throw new JsonSchemaError(
      "JSON_SCHEMA_INVALID",
      `JSON Schema must declare ${JSON_SCHEMA_2020_12}`,
    );
  }
  try {
    const ajv = new Ajv2020({
      allErrors: false,
      strict: true,
      validateFormats: true,
    });
    addFormats(ajv);
    return ajv.compile(schema as AnySchemaObject);
  } catch (error) {
    throw new JsonSchemaError(
      "JSON_SCHEMA_INVALID",
      "JSON Schema is invalid or unsupported",
      { cause: error },
    );
  }
}

export function validateJsonSchema(schema: JsonValue, value: JsonValue): void {
  if (!compileJsonSchema(schema)(value)) {
    throw new JsonSchemaError(
      "JSON_SCHEMA_VALUE_INVALID",
      "JSON value does not satisfy its declared schema",
    );
  }
}
