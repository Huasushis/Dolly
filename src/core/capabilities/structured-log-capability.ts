import {
  canonicalJsonByteLength,
  deepFreeze,
  isJsonObject,
  type JsonValue,
} from "../canonical-json.js";
import {
  ExtensionCapabilityError,
  type ExtensionCapabilityGrant,
  type ExtensionCapabilityInvocationContext,
} from "../extension-capability.js";
import {
  assertClosedArguments,
  assertHostIdentifier,
  assertPositiveLimit,
  capabilityArgumentError,
  capabilityQuotaError,
  optionalString,
  requireString,
  resolveExecutionScope,
  utf8ByteLength,
  type ExtensionCapabilityDefinition,
  type ResolvedExecutionScope,
} from "./capability-support.js";
import {
  escapeLogText,
  StructuralRedactor,
  type StructuralRedactionOptions,
} from "./structural-redaction.js";

export const STRUCTURED_LOG_CAPABILITY_TYPE = "structured-log";
export const STRUCTURED_LOG_CAPABILITY_VERSION = "v1";

export type ExtensionLogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: readonly ExtensionLogLevel[] = ["debug", "info", "warn", "error"];
const EVENT_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const ATTRIBUTE_NAME_PATTERN = /^[a-z][A-Za-z0-9_]{0,63}$/;

/**
 * The host-owned part of a log record. Every field here is copied from the
 * authenticated capability session or from the grant, never from the request
 * body, and it is nested under its own key so no extension attribute can ever
 * occupy the same position as an origin field.
 */
export interface ExtensionLogOrigin {
  readonly extensionId: string;
  readonly instanceId: string;
  readonly processGenerationId: string;
  readonly sessionId: string;
  readonly moduleId: string;
  readonly moduleGenerationId: string;
  readonly moduleJobId: string;
  readonly runId: string;
}

export interface ExtensionStructuredLogRecord {
  readonly schemaVersion: "dolly.extension-log/1";
  readonly recordedAt: string;
  readonly sequence: number;
  readonly level: ExtensionLogLevel;
  readonly event: string;
  readonly message: string;
  readonly origin: ExtensionLogOrigin;
  readonly attributes: Readonly<Record<string, JsonValue>>;
  readonly redactions: number;
}

export interface ExtensionStructuredLogSink {
  append(record: ExtensionStructuredLogRecord): void;
}

export interface StructuredLogCapabilityLimits {
  readonly maxEventBytes: number;
  readonly maxMessageBytes: number;
  readonly maxAttributes: number;
  readonly maxAttributeNameBytes: number;
  readonly maxAttributeValueBytes: number;
  /** Ceiling on one finished record, measured as canonical JSON. */
  readonly maxRecordBytes: number;
  readonly maxRecordsPerWindow: number;
  readonly maxRecordBytesPerWindow: number;
  readonly windowMs: number;
  /** Ceiling on records for the whole grant, enforced by the authority. */
  readonly maxRecords: number;
  readonly maxArgumentBytes: number;
}

export const DEFAULT_STRUCTURED_LOG_LIMITS: StructuredLogCapabilityLimits = deepFreeze({
  maxEventBytes: 96,
  maxMessageBytes: 2_048,
  maxAttributes: 24,
  maxAttributeNameBytes: 64,
  maxAttributeValueBytes: 512,
  maxRecordBytes: 8_192,
  maxRecordsPerWindow: 120,
  maxRecordBytesPerWindow: 256 * 1_024,
  windowMs: 1_000,
  maxRecords: 4_096,
  maxArgumentBytes: 8_192,
});

export interface StructuredLogCapabilityOptions {
  readonly sink: ExtensionStructuredLogSink;
  /** Host wall clock, used for the record timestamp. */
  readonly now: () => string;
  /** Host monotonic clock in milliseconds, used only for the rate window. */
  readonly monotonicNow?: () => number;
  readonly expiresAt: string;
  /**
   * Pins the record's Module job and Run when the host already knows them.
   * When it is absent the handler falls back to the identifiers the Extension
   * process host copied from its own active Run.
   */
  readonly executionScope?: ResolvedExecutionScope;
  readonly limits?: Partial<StructuredLogCapabilityLimits>;
  readonly redaction?: StructuralRedactionOptions;
  readonly maxConcurrentInvocations?: number;
  readonly requireIdempotencyKey?: boolean;
}

function resolveLimits(
  overrides: Partial<StructuredLogCapabilityLimits> | undefined,
): StructuredLogCapabilityLimits {
  const limits = { ...DEFAULT_STRUCTURED_LOG_LIMITS, ...(overrides ?? {}) };
  for (const [label, value] of Object.entries(limits)) {
    assertPositiveLimit(value, `structured log ${label}`);
  }
  return deepFreeze(limits);
}

function assertLogLevel(value: string): ExtensionLogLevel {
  if (!(LOG_LEVELS as readonly string[]).includes(value)) {
    throw capabilityArgumentError("log.level is not a supported level");
  }
  return value as ExtensionLogLevel;
}

/**
 * Builds the structured logging capability.
 *
 * Everything the extension supplies is treated as untrusted data: the request
 * carries only a level, an event name, a message, and flat scalar attributes.
 * Control characters are escaped, credential-shaped values are redacted by
 * shape, and the result is handed to the sink as an object, so an extension
 * cannot forge a second record or overwrite a host field by embedding a
 * newline, a field separator, or a reserved field name.
 */
export function createStructuredLogCapability(
  options: StructuredLogCapabilityOptions,
): ExtensionCapabilityDefinition {
  const limits = resolveLimits(options.limits);
  const redactor = new StructuralRedactor(options.redaction ?? {});
  const monotonicNow = options.monotonicNow ?? (() => Date.now());
  const grantScope = options.executionScope
    ? {
        moduleJobId: assertHostIdentifier(options.executionScope.moduleJobId, "moduleJobId"),
        runId: assertHostIdentifier(options.executionScope.runId, "runId"),
      }
    : undefined;

  let sequence = 0;
  let windowStartedAt = monotonicNow();
  let recordsInWindow = 0;
  let bytesInWindow = 0;

  const admitToWindow = (recordBytes: number): void => {
    const current = monotonicNow();
    if (
      !Number.isFinite(current) ||
      current < windowStartedAt ||
      current - windowStartedAt >= limits.windowMs
    ) {
      windowStartedAt = current;
      recordsInWindow = 0;
      bytesInWindow = 0;
    }
    if (recordsInWindow + 1 > limits.maxRecordsPerWindow) {
      throw capabilityQuotaError("maxRecordsPerWindow", limits.maxRecordsPerWindow);
    }
    if (bytesInWindow + recordBytes > limits.maxRecordBytesPerWindow) {
      throw capabilityQuotaError(
        "maxRecordBytesPerWindow",
        limits.maxRecordBytesPerWindow,
      );
    }
    recordsInWindow += 1;
    bytesInWindow += recordBytes;
  };

  const readAttributes = (
    value: JsonValue | undefined,
  ): { readonly attributes: Record<string, JsonValue>; readonly redactions: number } => {
    if (value === undefined) return { attributes: {}, redactions: 0 };
    if (!isJsonObject(value)) {
      throw capabilityArgumentError("log.attributes must be a JSON object");
    }
    const names = Object.keys(value);
    if (names.length > limits.maxAttributes) {
      throw capabilityQuotaError("maxAttributes", limits.maxAttributes);
    }
    const attributes: Record<string, JsonValue> = {};
    let redactions = 0;
    for (const name of names) {
      if (!ATTRIBUTE_NAME_PATTERN.test(name)) {
        throw capabilityArgumentError(
          "log.attributes contains a name outside the permitted attribute name shape",
        );
      }
      if (utf8ByteLength(name) > limits.maxAttributeNameBytes) {
        throw capabilityQuotaError("maxAttributeNameBytes", limits.maxAttributeNameBytes);
      }
      const attribute = value[name]!;
      if (attribute !== null && typeof attribute === "object") {
        throw capabilityArgumentError(
          "log.attributes values must be strings, numbers, booleans, or null",
        );
      }
      if (typeof attribute !== "string") {
        Object.defineProperty(attributes, name, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: attribute,
        });
        continue;
      }
      if (utf8ByteLength(attribute) > limits.maxAttributeValueBytes) {
        throw capabilityQuotaError(
          "maxAttributeValueBytes",
          limits.maxAttributeValueBytes,
        );
      }
      const redacted = redactor.redactText(escapeLogText(attribute));
      redactions += redacted.redactions;
      Object.defineProperty(attributes, name, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: redacted.text,
      });
    }
    return { attributes, redactions };
  };

  const grant: ExtensionCapabilityGrant = {
    capabilityType: STRUCTURED_LOG_CAPABILITY_TYPE,
    capabilityVersion: STRUCTURED_LOG_CAPABILITY_VERSION,
    operations: ["append"],
    resourceScope: {
      schemaVersion: "dolly.capability-scope.structured-log/1",
      sink: "host-structured-log",
      limits: { ...limits },
    },
    expiresAt: options.expiresAt,
    maxInvocations: limits.maxRecords,
    maxConcurrentInvocations: options.maxConcurrentInvocations ?? 4,
    maxArgumentBytes: limits.maxArgumentBytes,
    maxResultBytes: 256,
    ...(grantScope === undefined ? {} : { executionScope: grantScope }),
    ...(options.requireIdempotencyKey === true ? { requireIdempotencyKey: true } : {}),
  };

  const handler = (
    argumentsValue: JsonValue,
    context: ExtensionCapabilityInvocationContext,
  ): JsonValue => {
    if (context.operation !== "append") {
      throw new ExtensionCapabilityError(
        "CAPABILITY_DENIED",
        "Structured logging does not support this operation",
      );
    }
    const scope = resolveExecutionScope(grantScope, context);
    const parsed = assertClosedArguments(
      argumentsValue,
      ["level", "event", "message", "attributes"],
      "log",
    );
    const level = assertLogLevel(requireString(parsed, "level", "log"));
    const rawEvent = requireString(parsed, "event", "log");
    if (utf8ByteLength(rawEvent) > limits.maxEventBytes) {
      throw capabilityQuotaError("maxEventBytes", limits.maxEventBytes);
    }
    if (!EVENT_PATTERN.test(rawEvent)) {
      throw capabilityArgumentError("log.event is not a permitted event name");
    }
    // The event name shape already excludes control characters, but it can
    // still hold a lowercase credential, so it is redacted like any other
    // extension-supplied text.
    const event = redactor.redactText(rawEvent);
    const rawMessage = optionalString(parsed, "message", "log") ?? "";
    if (utf8ByteLength(rawMessage) > limits.maxMessageBytes) {
      throw capabilityQuotaError("maxMessageBytes", limits.maxMessageBytes);
    }
    const message = redactor.redactText(escapeLogText(rawMessage));
    const attributes = readAttributes(parsed.attributes);

    // The origin block is assembled only from the authenticated session
    // identity and the resolved Run. No request field reaches it, so an
    // extension cannot attribute its record to another Module or Run.
    const origin: ExtensionLogOrigin = {
      extensionId: context.identity.extensionId,
      instanceId: context.identity.instanceId,
      processGenerationId: context.identity.processGenerationId,
      sessionId: context.identity.sessionId,
      moduleId: context.identity.moduleId,
      moduleGenerationId: context.identity.moduleGenerationId,
      moduleJobId: scope.moduleJobId,
      runId: scope.runId,
    };

    const record: ExtensionStructuredLogRecord = {
      schemaVersion: "dolly.extension-log/1",
      recordedAt: options.now(),
      sequence: sequence + 1,
      level,
      event: event.text,
      message: message.text,
      origin,
      attributes: attributes.attributes,
      redactions: event.redactions + message.redactions + attributes.redactions,
    };
    const recordBytes = canonicalJsonByteLength(record);
    if (recordBytes > limits.maxRecordBytes) {
      throw capabilityQuotaError("maxRecordBytes", limits.maxRecordBytes);
    }
    admitToWindow(recordBytes);
    sequence += 1;
    options.sink.append(deepFreeze(record));
    return {
      schemaVersion: "dolly.extension-log-ack/1",
      accepted: true,
      sequence: record.sequence,
    };
  };

  return { grant, handler };
}
