/**
 * Public surface of the Dolly Core v1 schema bundle.
 *
 * Canonical JSON (RFC 8785 + Core profile) and schema validation against the
 * spec's bundled `schemas/` corpus.
 */

export {
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
  type CanonicalJsonErrorCode,
  type JsonValue,
  type JsonPrimitive,
} from "./canonical-json.js";

export {
  JSON_SCHEMA_2020_12,
  SchemaBundleError,
  createSchemaBundle,
  findDirUp,
  specRootFromModuleUrl,
  type CreateSchemaBundleOptions,
  type SchemaBundle,
  type SchemaBundleErrorCode,
  type ValidationResult,
} from "./schema-validator.js";
