/**
 * Dolly Core v1 schema bundle — loads every `*.schema.json` from a spec
 * schema directory and validates payloads against them.
 *
 * Design:
 * - All schemas are registered into a single {@link Ajv2020} instance by
 *   their `$id`, so cross-schema `$ref`s like
 *   `common.schema.json#/$defs/Sha256` resolve against the registered
 *   bundle rather than the filesystem. This mirrors how the Core spec
 *   treats the `schemas/` directory as one self-contained corpus.
 * - `strict` is disabled at the AJV level because the shipped spec schemas
 *   are the authority; strict-mode warnings about them are not actionable
 *   here. Schema *values* are still fully validated (`allErrors`, formats on).
 * - Before AJV validation, every payload is passed through the Core
 *   canonical-JSON profile assertion (`assertCanonicalJsonValue`) so that
 *   non-representable values (`-0`, `NaN`, lone surrogates, non-plain
 *   objects) are rejected with `CORE_INVALID_JSON` rather than reaching AJV,
 *   which would give a less precise error.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, basename, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020, { type AnySchemaObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { assertCanonicalJsonValue, type JsonValue } from "./canonical-json.js";

export const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";

export type SchemaBundleErrorCode =
  | "SCHEMA_NOT_FOUND"
  | "SCHEMA_INVALID"
  | "SCHEMA_VALUE_INVALID"
  | "CORE_INVALID_JSON";

export class SchemaBundleError extends TypeError {
  constructor(
    readonly code: SchemaBundleErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SchemaBundleError";
  }
}

export interface CreateSchemaBundleOptions {
  /** Directory containing `*.schema.json` files (the spec `schemas/` dir). */
  schemasDir: string;
  /** Whether to apply AJV `strict` mode to the *schemas themselves*. Default false. */
  strict?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: SchemaBundleError[];
}

const SCHEMA_EXT = ".schema.json";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Resolve a user-facing schema name to its canonical `$id`. Accepts:
 * - the full `$id` (e.g. `https://dolly.example/spec/0.1/schemas/error.schema.json`),
 * - the filename (e.g. `error.schema.json`),
 * - the short name (e.g. `error` or `block-draft`), or
 * - any of the above followed by a fragment, e.g.
 *   `extension-lifecycle-rpc.schema.json#/$defs/ExtensionPingParams` (the
 *   fragment names the selected sub-schema; resolution returns the base
 *   document's `$id`).
 */
function resolveSchemaId(known: Map<string, string>, name: string): string {
  const base = splitSchemaFragment(name).base;
  const direct = known.get(base);
  if (direct !== undefined) return direct;
  const filename = base.endsWith(SCHEMA_EXT) ? base : `${base}${SCHEMA_EXT}`;
  const byFilename = known.get(filename);
  if (byFilename !== undefined) return byFilename;
  for (const [id, canonical] of known) {
    if (basename(id) === filename) return canonical;
  }
  throw new SchemaBundleError("SCHEMA_NOT_FOUND", `Schema not found: ${name}`);
}

/**
 * Split a schema reference at its fragment. RFC 6901 JSON Pointers follow
 * the `#`, so `error.schema.json#/$defs/foo` names both the base document
 * and the exact sub-schema inside it. Returns `{ base, fragment }` where
 * `fragment` is the raw text after `#` (empty string when there is none).
 */
function splitSchemaFragment(name: string): { base: string; fragment: string } {
  const split = name.indexOf("#");
  if (split === -1) return { base: name, fragment: "" };
  return { base: name.slice(0, split), fragment: name.slice(split + 1) };
}

/**
 * Resolve a JSON Pointer (RFC 6901) fragment against a schema document.
 * Returns null when the fragment is not a well-formed pointer or addresses
 * a member that does not exist. An empty or "/" fragment addresses the
 * document root itself.
 */
function resolveSchemaPointer(schema: unknown, fragment: string): unknown | null {
  if (fragment === "") return schema;
  if (!fragment.startsWith("/")) return null;
  let node = schema;
  for (const rawToken of fragment.slice(1).split("/")) {
    if (node === null || typeof node !== "object") return null;
    if (/~(?![01])/.test(rawToken)) return null; // bare ~ is not valid RFC 6901
    const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return null;
      const index = Number(token);
      if (index >= node.length) return null;
      node = node[index];
    } else if (Object.prototype.hasOwnProperty.call(node, token)) {
      node = (node as Record<string, unknown>)[token];
    } else {
      return null;
    }
  }
  return node;
}

export interface SchemaBundle {
  /** Validate `value` against the named schema. Never throws; returns errors. */
  validate(name: string, value: unknown): ValidationResult;
  /** Assert that `value` is valid; throw on failure. */
  assertValid(name: string, value: unknown): asserts value is JsonValue;
  /** Resolve a schema name to its canonical `$id`. */
  resolveId(name: string): string;
  /** List of canonical `$id`s loaded into the bundle, sorted. */
  readonly schemaIds: readonly string[];
  /** The underlying AJV instance (for advanced use / introspection). */
  readonly ajv: Ajv2020;
}

/**
 * Build a schema bundle by loading every `*.schema.json` from `schemasDir`.
 * Cross-schema `$ref`s resolve within the bundle because every schema is
 * registered by its `$id` into one AJV instance.
 */
export function createSchemaBundle(options: CreateSchemaBundleOptions): SchemaBundle {
  const schemasDir = resolve(options.schemasDir);
  const idByFilename = new Map<string, string>();
  const idByFilenameToPath = new Map<string, string>();
  const schemas: AnySchemaObject[] = [];

  let names: string[];
  try {
    names = readdirSync(schemasDir);
  } catch (error) {
    throw new SchemaBundleError("SCHEMA_INVALID", `Cannot read schemas directory: ${schemasDir}`, {
      cause: error,
    });
  }

  for (const name of names) {
    if (extname(name) !== ".json" || !name.endsWith(SCHEMA_EXT)) continue;
    const path = join(schemasDir, name);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      throw new SchemaBundleError("SCHEMA_INVALID", `Cannot read schema file: ${path}`, {
        cause: error,
      });
    }
    let schema: unknown;
    try {
      schema = JSON.parse(text);
    } catch (error) {
      throw new SchemaBundleError("SCHEMA_INVALID", `Schema file is not valid JSON: ${path}`, {
        cause: error,
      });
    }
    if (!isPlainObject(schema) || schema.$schema !== JSON_SCHEMA_2020_12) {
      throw new SchemaBundleError(
        "SCHEMA_INVALID",
        `Schema ${path} must declare $schema ${JSON_SCHEMA_2020_12}`,
      );
    }
    const $id = schema.$id;
    if (typeof $id !== "string" || $id.length === 0) {
      throw new SchemaBundleError("SCHEMA_INVALID", `Schema ${path} is missing a $id`);
    }
    // Deterministic duplicate-$id rejection: without this AJV silently
    // shadows the earlier registration, so $refs and filename lookups resolve
    // to whichever file was registered last. Surface the collision with both
    // paths so the failure is explicit rather than silently validating against
    // the wrong file.
    const priorPath = idByFilenameToPath.get($id);
    if (priorPath !== undefined) {
      throw new SchemaBundleError(
        "SCHEMA_INVALID",
        `Duplicate $id ${$id} in ${path} (already declared in ${priorPath})`,
      );
    }
    idByFilenameToPath.set($id, path);
    idByFilename.set(name, $id);
    schemas.push(schema as AnySchemaObject);
  }

  if (schemas.length === 0) {
    throw new SchemaBundleError("SCHEMA_INVALID", `No *.schema.json files found in ${schemasDir}`);
  }

  let ajv: Ajv2020;
  try {
    ajv = new Ajv2020({
      allErrors: true,
      strict: options.strict ?? false,
      validateFormats: true,
    });
    addFormats(ajv);
    for (const schema of schemas) {
      ajv.addSchema(schema);
    }
  } catch (error) {
    throw new SchemaBundleError("SCHEMA_INVALID", "Failed to compile schema bundle", {
      cause: error,
    });
  }

  const known = new Map<string, string>();
  for (const $id of idByFilename.values()) known.set($id, $id);
  for (const [filename, $id] of idByFilename) known.set(filename, $id);

  // Keep the parsed document per $id so a fragment can navigate RFC 6901
  // pointers into the exact loaded schema resource. Every schema was already
  // verified to declare a string `$id` above.
  const schemasById = new Map<string, unknown>();
  for (const schema of schemas) {
    schemasById.set(schema.$id as string, schema);
  }

  const validators = new Map<string, ValidateFunction>();
  const fragmentValidators = new Map<string, ValidateFunction>();
  let fragmentCounter = 0;
  function getValidator(name: string): ValidateFunction {
    const { base, fragment } = splitSchemaFragment(name);
    const $id = resolveSchemaId(known, base);
    if (fragment === "") {
      let fn = validators.get($id);
      if (fn !== undefined) return fn;
      try {
        fn = ajv.getSchema($id) as ValidateFunction | undefined;
      } catch {
        fn = undefined;
      }
      if (fn === undefined) {
        throw new SchemaBundleError("SCHEMA_NOT_FOUND", `Schema not compiled: ${name} (id=${$id})`);
      }
      validators.set($id, fn);
      return fn;
    }
    const key = `${$id}#${fragment}`;
    let fragmentFn = fragmentValidators.get(key);
    if (fragmentFn !== undefined) return fragmentFn;
    const document = schemasById.get($id);
    const target = resolveSchemaPointer(document ?? null, fragment);
    if (target === null || typeof target !== "object") {
      throw new SchemaBundleError(
        "SCHEMA_NOT_FOUND",
        `Schema fragment not found: ${name} (id=${key})`,
      );
    }
    // Draft 2020-12 uses `$defs`; compile the selected sub-schema against the
    // same Ajv instance so `$ref`s that name sibling `$defs` or other files
    // still resolve. The wrapper carries a stable internal URI so the same
    // fragment is compiled once, and the enumerated keywords of the fragment
    // are preserved unchanged.
    const wrapperId = `urn:dolly:internal-fragment:${++fragmentCounter}`;
    const wrapper = { $id: wrapperId, $ref: `${$id}#${fragment}` };
    try {
      ajv.addSchema(wrapper as AnySchemaObject);
      fragmentFn = ajv.getSchema(wrapperId) as ValidateFunction | undefined;
    } catch {
      fragmentFn = undefined;
    }
    if (fragmentFn === undefined) {
      throw new SchemaBundleError(
        "SCHEMA_NOT_FOUND",
        `Schema fragment not compiled: ${name} (id=${key})`,
      );
    }
    fragmentValidators.set(key, fragmentFn);
    return fragmentFn;
  }

  return {
    ajv,
    get schemaIds() {
      return [...idByFilename.values()].sort();
    },
    resolveId(name: string): string {
      return resolveSchemaId(known, name);
    },
    validate(name: string, value: unknown): ValidationResult {
      const errors: SchemaBundleError[] = [];
      try {
        assertCanonicalJsonValue(value);
      } catch (error) {
        errors.push(
          new SchemaBundleError(
            "CORE_INVALID_JSON",
            error instanceof Error ? error.message : "Value is not canonical-JSON representable",
            { cause: error },
          ),
        );
        return { valid: false, errors };
      }
      let fn: ValidateFunction;
      try {
        fn = getValidator(name);
      } catch (error) {
        // Honor the documented "Never throws; returns errors" contract:
        // unknown schema names surface as SCHEMA_NOT_FOUND in the result
        // rather than escaping as an uncaught throw.
        if (error instanceof SchemaBundleError) {
          errors.push(error);
        } else {
          errors.push(
            new SchemaBundleError("SCHEMA_NOT_FOUND", error instanceof Error ? error.message : String(error), {
              cause: error,
            }),
          );
        }
        return { valid: false, errors };
      }
      if (fn(value)) return { valid: true, errors: [] };
      for (const err of fn.errors ?? []) {
        const instancePath = err.instancePath || "/";
        const detail = err.message ? ` ${err.message}` : "";
        const schemaPath = err.schemaPath || "";
        errors.push(
          new SchemaBundleError(
            "SCHEMA_VALUE_INVALID",
            `at ${instancePath}:${detail} (${schemaPath})`.trimEnd(),
          ),
        );
      }
      return { valid: false, errors };
    },
    assertValid(name: string, value: unknown): asserts value is JsonValue {
      const result = this.validate(name, value);
      if (!result.valid) {
        const detail = result.errors.map((e) => `${e.code}: ${e.message}`).join("; ");
        throw new SchemaBundleError(result.errors[0]?.code ?? "SCHEMA_VALUE_INVALID", detail);
      }
    },
  };
}

/**
 * Locate a directory by walking upward from a starting URL/path until a
 * directory containing `marker` is found. Used by tests to find the spec's
 * `schemas/` and `test-vectors/` directories without hardcoding a depth.
 */
export function findDirUp(start: string, marker: string): string {
  let dir = resolve(start);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = join(dir, marker);
    try {
      const stat = readdirSync(candidate);
      if (stat.length > 0) return candidate;
    } catch {
      /* keep walking */
    }
    const parent = resolve(dir, "..");
    if (parent === dir) {
      throw new SchemaBundleError(
        "SCHEMA_INVALID",
        `Could not find ${marker} upward from ${start}`,
      );
    }
    dir = parent;
  }
}

/**
 * Locate the spec root — the directory containing a non-empty `dolly-spec`
 * directory — starting from a module URL such as `import.meta.url`.
 * Convenience wrapper over {@link findDirUp} for callers that only have the
 * module URL of the invoking file.
 */
export function specRootFromModuleUrl(moduleUrl: string): string {
  return findDirUp(dirname(fileURLToPath(moduleUrl)), "dolly-spec");
}

