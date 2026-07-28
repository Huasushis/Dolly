import type { JsonValue } from "../../core/canonical-json.js";

/**
 * Typed failures of the Memory baseline.
 *
 * Every code names one contract in `docs/spec/memory-extension.md`. Callers and
 * conformance tests assert the code, never a message, so a reworded message can
 * never turn a security failure into a passing test.
 */
export type MemoryErrorCode =
  /** §4.1 A namespace component was absent. There is no shared default. */
  | "MEMORY_IDENTITY_MISSING"
  /** §4.1 A namespace component was present but not a host identifier. */
  | "MEMORY_IDENTITY_INVALID"
  /** §4.1/§4.3 A record, job, or result was addressed under another namespace. */
  | "MEMORY_NAMESPACE_MISMATCH"
  /** §4.3 Runtime policy does not grant the caller that namespace or operation. */
  | "MEMORY_SCOPE_DENIED"
  /** §4.1 `owner-long-term` was selected without an authorized memory space. */
  | "MEMORY_RETENTION_SCOPE_INVALID"
  /** §5.1 A persisted record failed its closed schema or version check. */
  | "MEMORY_RECORD_INVALID"
  /** §8.1 No allowlisted extractor accepts that payload schema. */
  | "MEMORY_EXTRACTOR_UNKNOWN"
  /** §8.1 The extractor rejected the payload it declared it accepts. */
  | "MEMORY_EXTRACTION_INVALID"
  /** §8.3/§9.2 The configured descriptor does not accept that modality. */
  | "MEMORY_MODALITY_UNSUPPORTED"
  /** §9.4 Two vector spaces were used as if they were one. */
  | "MEMORY_VECTOR_SPACE_INCOMPATIBLE"
  /** §9.4 Two index generations were mixed or their raw scores compared. */
  | "MEMORY_GENERATION_INCOMPATIBLE"
  /** §10.3 A threshold named a score channel the result does not carry. */
  | "MEMORY_THRESHOLD_CHANNEL_INVALID"
  /** §10.1 The query payload was not the closed `dolly.memory.query/1` value. */
  | "MEMORY_QUERY_INVALID"
  /** §6.3/§10.1 A finite limit was reached. */
  | "MEMORY_LIMIT_EXCEEDED"
  /** §5.5/§6.2 A job or admission transition is not legal from its state. */
  | "MEMORY_JOB_STATE_INVALID"
  /** §6.2 A result arrived from a fenced (superseded) Module generation. */
  | "MEMORY_GENERATION_FENCED"
  /** §15 Configuration is not the closed baseline schema. */
  | "MEMORY_CONFIG_INVALID"
  /** §14 A research mechanism was requested; the baseline does not implement it. */
  | "MEMORY_RESEARCH_NOT_IMPLEMENTED"
  /** §12.1 Durable state could not be replayed. */
  | "MEMORY_STORE_CORRUPT"
  /** §12.2 The lineage is tombstoned under an equal or newer deletion epoch. */
  | "MEMORY_TOMBSTONED"
  /** §10.2 Vector retrieval was requested with no compatible active generation. */
  | "MEMORY_VECTOR_UNAVAILABLE";

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  readonly details: Readonly<Record<string, JsonValue>>;

  constructor(
    code: MemoryErrorCode,
    message: string,
    details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
    this.details = details;
  }
}

export function memoryError(
  code: MemoryErrorCode,
  message: string,
  details: Readonly<Record<string, JsonValue>> = {},
): MemoryError {
  return new MemoryError(code, message, details);
}
