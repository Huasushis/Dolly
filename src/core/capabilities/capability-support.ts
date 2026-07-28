import { isJsonObject, type JsonValue } from "../canonical-json.js";
import {
  ExtensionCapabilityError,
  type ExtensionCapabilityGrant,
  type ExtensionCapabilityHandler,
  type ExtensionCapabilityInvocationContext,
} from "../extension-capability.js";

/**
 * One host-implemented capability: the host-owned grant policy plus the
 * handler that the capability authority calls after it has validated the
 * handle, session, operation, execution scope, and argument size.
 *
 * A definition is inert until a host issues it into one capability session.
 * Nothing in a definition is derived from extension-controlled configuration.
 */
export interface ExtensionCapabilityDefinition {
  readonly grant: ExtensionCapabilityGrant;
  readonly handler: ExtensionCapabilityHandler;
}

export function capabilityArgumentError(
  message: string,
  details: Readonly<Record<string, JsonValue>> = {},
): ExtensionCapabilityError {
  return new ExtensionCapabilityError("CAPABILITY_ARGUMENT_INVALID", message, details);
}

export function capabilityQuotaError(
  limit: string,
  allowed: number,
): ExtensionCapabilityError {
  return new ExtensionCapabilityError(
    "CAPABILITY_QUOTA_EXCEEDED",
    `Capability limit ${limit} exceeded`,
    { limit, allowed },
  );
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Accepts only a plain JSON object whose keys are all in `allowed`. Unknown
 * fields are rejected rather than ignored so a future argument name can never
 * be silently absorbed by an older host.
 */
export function assertClosedArguments(
  value: JsonValue,
  allowed: readonly string[],
  label: string,
): Readonly<Record<string, JsonValue>> {
  if (!isJsonObject(value)) {
    throw capabilityArgumentError(`${label} must be a JSON object`);
  }
  const permitted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) {
      throw capabilityArgumentError(`${label} contains the unknown field ${key}`);
    }
  }
  return value;
}

/** Reads one field without letting an absent key masquerade as a JSON value. */
export function readField(
  argumentsValue: Readonly<Record<string, JsonValue>>,
  field: string,
): JsonValue | undefined {
  if (!Object.prototype.hasOwnProperty.call(argumentsValue, field)) return undefined;
  return argumentsValue[field] as JsonValue;
}

export function requireString(
  argumentsValue: Readonly<Record<string, JsonValue>>,
  field: string,
  label: string,
): string {
  const value = readField(argumentsValue, field);
  if (typeof value !== "string") {
    throw capabilityArgumentError(`${label}.${field} must be a string`);
  }
  return value;
}

export function optionalString(
  argumentsValue: Readonly<Record<string, JsonValue>>,
  field: string,
  label: string,
): string | undefined {
  const value = readField(argumentsValue, field);
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw capabilityArgumentError(`${label}.${field} must be a string when present`);
  }
  return value;
}

export function optionalBoundedInteger(
  argumentsValue: Readonly<Record<string, JsonValue>>,
  field: string,
  label: string,
  maximum: number,
): number | undefined {
  const value = readField(argumentsValue, field);
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw capabilityArgumentError(
      `${label}.${field} must be a positive safe integer when present`,
    );
  }
  if (value > maximum) throw capabilityQuotaError(field, maximum);
  return value;
}

export function assertPositiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ExtensionCapabilityError(
      "CAPABILITY_CONFIG_INVALID",
      `${label} must be a positive safe integer`,
    );
  }
  return value;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function assertHostIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new ExtensionCapabilityError(
      "CAPABILITY_CONFIG_INVALID",
      `${label} is not a valid host identifier`,
    );
  }
  return value;
}

export interface ResolvedExecutionScope {
  readonly moduleJobId: string;
  readonly runId: string;
}

/**
 * Resolves the Module job and Run that a capability effect belongs to.
 *
 * The grant's own execution scope wins whenever the host pinned one, because
 * that value was chosen by the host before the extension process started. The
 * fallback is the invocation context, whose identifiers the Extension process
 * host copies from its own active Run after an exact comparison; the values a
 * request carried are never forwarded as authority. An invocation with neither
 * has no Run identity and cannot produce a Run-attributed effect.
 */
export function resolveExecutionScope(
  grantScope: ResolvedExecutionScope | undefined,
  context: ExtensionCapabilityInvocationContext,
): ResolvedExecutionScope {
  if (grantScope) return grantScope;
  if (context.moduleJobId === undefined || context.runId === undefined) {
    throw new ExtensionCapabilityError(
      "CAPABILITY_SCOPE_MISMATCH",
      "Capability effect requires an active Module job and Run",
    );
  }
  return { moduleJobId: context.moduleJobId, runId: context.runId };
}
